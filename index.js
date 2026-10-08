/**
 * WhatsApp Bridge con Baileys + Google Gemini AI + PostgreSQL
 * Estudio Jurídico Jaime Irigoyen
 *
 * Variables de entorno:
 *   GEMINI_API_KEY          (obligatoria) Clave de la API de Gemini.
 *   DATABASE_URL            (obligatoria) URL de conexión a PostgreSQL de Railway.
 *   ADMIN_NUMBER            (opcional)    Número del administrador, solo dígitos y con código de país.
 *   GEMINI_MODEL            (opcional)    Modelo principal (por defecto gemini-3.5-flash-lite).
 *   GEMINI_MODELO_RESPALDO  (opcional)    Modelo(s) de respaldo separados por coma, si el principal está saturado.
 *   AUTH_DIR                (opcional)    Carpeta de la sesión de WhatsApp. Con un volumen de Railway en /data, usar /data/auth.
 *   PANEL_PASSWORD          (opcional)    Si se configura, la página del QR pide ?clave=... en la URL.
 *   PORT                    (opcional)    Puerto del servidor web (por defecto 3000).
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const https = require('https');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = (process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite').trim();
const GEMINI_MODELOS_RESPALDO = (process.env.GEMINI_MODELO_RESPALDO || '')
    .split(',').map(m => m.trim()).filter(Boolean);
const ADMIN_NUMBER = (process.env.ADMIN_NUMBER || '').replace(/\D/g, '');
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || '';

const AUTH_FOLDER = process.env.AUTH_DIR || 'auth_info_baileys';
const RULES_FILE_LEGACY = 'reglas_admin.json'; // solo para migrar reglas viejas a la base
const MAX_TURNOS_HISTORIAL = 10;

const MENSAJE_ERROR = 'Disculpe la demora. En unos minutos un asesor del Estudio le responderá personalmente.';

let currentQR = null;
let isConnected = false;
let socketActual = null;
const userHistories = new Map();
const iniciadoEn = new Date();

// ---------- Utilidades ----------

function soloDigitos(jid) {
    return (jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

// Devuelve el número de teléfono real del cliente, o null si WhatsApp solo informa un identificador @lid.
function numeroCliente(msg) {
    const candidatos = [msg.key.senderPn, msg.key.remoteJidAlt, msg.key.participantPn, msg.key.remoteJid]
        .filter(j => typeof j === 'string' && j.endsWith('@s.whatsapp.net'));
    return candidatos.length > 0 ? soloDigitos(candidatos[0]) : null;
}

function esperar(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// Limpia la respuesta del modelo al pedirle un nombre. Devuelve null si no es un nombre plausible.
function limpiarNombre(respuesta) {
    if (!respuesta) return null;
    const limpio = respuesta.replace(/["'*.\n\r]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!limpio || limpio.length < 2 || limpio.length > 60) return null;
    if (/^(no|ninguno|n\/a|no indicado|no hay nombre|desconocido)$/i.test(limpio)) return null;
    if (!/^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ' -]+$/.test(limpio)) return null;
    return limpio.split(' ').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

// Convierte filas de la base en historial para Gemini, uniendo turnos seguidos del mismo rol.
function filasAHistorial(filas) {
    const historial = [];
    for (const f of filas) {
        const role = f.rol === 'cliente' ? 'user' : (f.rol === 'bot' ? 'model' : null);
        if (!role || !f.texto) continue;
        const ultimo = historial[historial.length - 1];
        if (ultimo && ultimo.role === role) {
            ultimo.parts[0].text += '\n' + f.texto;
        } else {
            historial.push({ role, parts: [{ text: f.texto }] });
        }
    }
    while (historial.length && historial[0].role !== 'user') historial.shift();
    return historial.slice(-MAX_TURNOS_HISTORIAL);
}

// ---------- Base de datos PostgreSQL ----------

const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway.internal')
        ? false
        : { rejectUnauthorized: false }
});

let dbOk = false;

async function inicializarDB() {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS contactos (
                id SERIAL PRIMARY KEY,
                telefono TEXT UNIQUE NOT NULL,
                nombre TEXT DEFAULT 'No indicado',
                email TEXT DEFAULT '',
                primera_consulta TIMESTAMPTZ DEFAULT NOW(),
                ultima_actividad TIMESTAMPTZ DEFAULT NOW(),
                total_mensajes INTEGER DEFAULT 0
            );
        `);
        // "telefono" es el identificador del chat de WhatsApp; "numero" es el teléfono real cuando se conoce.
        await db.query(`ALTER TABLE contactos ADD COLUMN IF NOT EXISTS numero TEXT`);
        await db.query(`
            CREATE TABLE IF NOT EXISTS mensajes (
                id SERIAL PRIMARY KEY,
                telefono TEXT NOT NULL,
                rol TEXT NOT NULL,
                texto TEXT NOT NULL,
                timestamp TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        await db.query(`CREATE INDEX IF NOT EXISTS idx_mensajes_telefono ON mensajes (telefono, id)`);
        await db.query(`
            CREATE TABLE IF NOT EXISTS reglas_admin (
                id SERIAL PRIMARY KEY,
                regla TEXT NOT NULL,
                creada_en TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        dbOk = true;
        console.log('✅ Base de datos inicializada correctamente.');
    } catch (e) {
        dbOk = false;
        console.error('❌ Error inicializando la base de datos:', e.message);
    }
}

async function guardarMensaje(telefono, rol, texto, numero = null) {
    try {
        await db.query(
            'INSERT INTO mensajes (telefono, rol, texto) VALUES ($1, $2, $3)',
            [telefono, rol, texto]
        );
        await db.query(`
            INSERT INTO contactos (telefono, numero, ultima_actividad, total_mensajes)
            VALUES ($1, $2, NOW(), 1)
            ON CONFLICT (telefono) DO UPDATE
            SET ultima_actividad = NOW(),
                total_mensajes = contactos.total_mensajes + 1,
                numero = COALESCE(EXCLUDED.numero, contactos.numero)
        `, [telefono, numero]);
    } catch (e) {
        console.error('Error guardando mensaje en DB:', e.message);
    }
}

const CAMPOS_CONTACTO = new Set(['nombre', 'email', 'numero']);

async function actualizarContacto(telefono, campo, valor) {
    if (!CAMPOS_CONTACTO.has(campo)) return;
    try {
        await db.query(`UPDATE contactos SET ${campo} = $1 WHERE telefono = $2`, [valor, telefono]);
    } catch (e) {
        console.error(`Error actualizando ${campo} en contacto:`, e.message);
    }
}

async function obtenerContacto(telefono) {
    try {
        const { rows } = await db.query('SELECT nombre, email, numero FROM contactos WHERE telefono = $1', [telefono]);
        return rows[0] || null;
    } catch (e) {
        return null;
    }
}

async function cargarHistorial(telefono) {
    try {
        const { rows } = await db.query(
            `SELECT rol, texto FROM (
                SELECT id, rol, texto FROM mensajes
                WHERE telefono = $1 AND rol IN ('cliente', 'bot')
                ORDER BY id DESC LIMIT $2
            ) t ORDER BY id ASC`,
            [telefono, MAX_TURNOS_HISTORIAL * 2]
        );
        return filasAHistorial(rows);
    } catch (e) {
        console.error('Error cargando historial:', e.message);
        return [];
    }
}

// ---------- Reglas del administrador (guardadas en la base) ----------

let globalAdminRules = []; // [{ id, regla }]

async function cargarReglas() {
    try {
        const { rows } = await db.query('SELECT id, regla FROM reglas_admin ORDER BY id ASC');
        // Migrar reglas viejas del archivo, si existían y la tabla está vacía.
        if (rows.length === 0 && fs.existsSync(RULES_FILE_LEGACY)) {
            const viejas = JSON.parse(fs.readFileSync(RULES_FILE_LEGACY, 'utf8'));
            if (Array.isArray(viejas)) {
                for (const r of viejas) if (r) await db.query('INSERT INTO reglas_admin (regla) VALUES ($1)', [String(r)]);
                return cargarReglas();
            }
        }
        globalAdminRules = rows;
        console.log(`Reglas de administrador cargadas: ${rows.length}`);
    } catch (e) {
        console.error('No se pudieron cargar las reglas:', e.message);
    }
}

// ---------- Instrucciones del bot ----------

function construirInstrucciones() {
    const reglasAdmin = globalAdminRules.length > 0
        ? '\n\nREGLAS ADICIONALES DEL ADMINISTRADOR (tienen prioridad):\n- ' + globalAdminRules.map(r => r.regla).join('\n- ')
        : '';

    return 'Sos el asistente virtual oficial del Estudio Jurídico Jaime Irigoyen, especializado en derecho societario argentino (SAS, SRL, SA, Asociaciones Civiles y ONGs).\n' +
        'REGLAS OBLIGATORIAS:\n' +
        '1. Tono ESTRICTAMENTE FORMAL y PROFESIONAL en todo momento. Tratá siempre de "usted", nunca de "vos" ni de "tú".\n' +
        '2. En el PRIMER mensaje pedí siempre el nombre y apellido de la persona. Una vez que lo indique, dirigite a ella como "Sr.", "Sra." o "Srta." seguido de su apellido.\n' +
        '3. Usá la frase "Esa es una excelente consulta" COMO MÁXIMO UNA SOLA VEZ en toda la conversación, y solo si la pregunta es específicamente sobre derecho societario.\n' +
        '4. NUNCA des asesoramiento legal específico ni redactes contratos.\n' +
        '5. Nunca prometas que lo va a atender un abogado: decí siempre "un asesor del Estudio".\n' +
        '6. Si preguntan precios exactos o trámites complejos, respondé formalmente que un asesor del Estudio se comunicará a la brevedad para asesorarlo en detalle, y solicitá su correo electrónico si aún no lo indicó.\n' +
        '7. Sé conciso: máximo 2 a 3 oraciones breves. Estás respondiendo por WhatsApp.\n' +
        '8. Servicios del Estudio: constitución de sociedades, mantenimiento societario (balances, asambleas ordinarias y extraordinarias, cambio de autoridades y gerencias), transferencias y procesos de disolución y cierre para SAS, SRL, SA, Asociaciones Civiles y ONGs.' +
        reglasAdmin;
}

// ---------- Servidor web ----------

app.get('/', (req, res) => {
    if (PANEL_PASSWORD && req.query.clave !== PANEL_PASSWORD) {
        return res.status(401).send('Acceso no autorizado.');
    }

    if (isConnected) {
        return res.send(`
            <!DOCTYPE html><html lang="es">
            <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>WhatsApp Bot Activo · Estudio Jaime Irigoyen</title>
            <style>
                body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0f172a;color:#fff;margin:0;}
                .card{background:#1e293b;padding:40px;border-radius:20px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,0.5);max-width:450px;width:90%;}
                .status{display:inline-flex;align-items:center;gap:8px;background:#064e3b;color:#34d399;padding:8px 16px;border-radius:50px;font-weight:600;font-size:0.9rem;margin-bottom:20px;}
                .dot{width:10px;height:10px;background:#34d399;border-radius:50%;box-shadow:0 0 10px #34d399;}
                h1{font-size:1.5rem;margin:0 0 10px;color:#f8fafc;}
                p{color:#94a3b8;font-size:0.95rem;line-height:1.5;margin:0;}
            </style></head>
            <body><div class="card">
                <div class="status"><span class="dot"></span> EN LÍNEA Y CONECTADO</div>
                <h1>WhatsApp Bot Activo</h1>
                <p>El bot del <strong>Estudio Jurídico Jaime Irigoyen</strong> está conectado y respondiendo consultas con Inteligencia Artificial.</p>
            </div></body></html>
        `);
    }

    if (currentQR) {
        QRCode.toDataURL(currentQR, (err, url) => {
            if (err) return res.send('Error generando QR.');
            res.send(`
                <!DOCTYPE html><html lang="es">
                <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Vincular WhatsApp · Estudio Jaime Irigoyen</title>
                <meta http-equiv="refresh" content="5">
                <style>
                    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0f172a;color:#fff;margin:0;}
                    .card{background:#1e293b;padding:35px 25px;border-radius:20px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,0.5);max-width:440px;width:90%;}
                    h1{font-size:1.4rem;margin:0 0 10px;color:#f8fafc;}
                    p{color:#94a3b8;font-size:0.9rem;line-height:1.5;margin:0 0 20px;}
                    .qr-box{background:#fff;padding:15px;border-radius:14px;display:inline-block;margin-bottom:20px;box-shadow:0 4px 20px rgba(0,0,0,0.2);}
                    .qr-box img{display:block;max-width:250px;width:100%;height:auto;}
                    .instructions{background:#0f172a;padding:15px;border-radius:12px;text-align:left;font-size:0.85rem;color:#cbd5e1;}
                    .instructions ol{margin:0;padding-left:20px;}
                    .instructions li{margin-bottom:6px;}
                </style></head>
                <body><div class="card">
                    <h1>Vincular WhatsApp</h1>
                    <p>Escaneá este código desde tu celular con el número <strong>+54 9 11 3236-4365</strong>.</p>
                    <div class="qr-box"><img src="${url}" alt="Código QR de WhatsApp" /></div>
                    <div class="instructions"><ol>
                        <li>Abrí <strong>WhatsApp Business</strong> en tu celular.</li>
                        <li>Tocá los <strong>tres puntos (⋮)</strong> o Configuración.</li>
                        <li>Seleccioná <strong>Dispositivos vinculados</strong>.</li>
                        <li>Tocá <strong>Vincular un dispositivo</strong> y apuntá al código QR.</li>
                    </ol></div>
                </div></body></html>
            `);
        });
    } else {
        res.send(`
            <!DOCTYPE html><html lang="es">
            <head><meta charset="UTF-8"><meta http-equiv="refresh" content="3"><title>Iniciando...</title></head>
            <body style="background:#0f172a;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;">
                <p>Generando código QR... por favor esperá unos segundos.</p>
            </body></html>
        `);
    }
});

// ---------- Consulta a Google Gemini (con reintentos y modelo de respaldo) ----------

const CODIGOS_REINTENTABLES = new Set([429, 500, 502, 503, 504]);
let ultimoErrorGemini = null;

function llamarModelo(modelo, contents, generationConfig) {
    return new Promise((resolve) => {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${GEMINI_API_KEY}`;
        const payload = JSON.stringify({ contents, generationConfig });

        const req = https.request(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            },
            timeout: 20000
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const parsed = JSON.parse(data);
                        const texto = parsed.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                        if (texto) return resolve({ texto });
                    } catch (e) {
                        console.error('Error parseando respuesta de Gemini:', e.message);
                    }
                    return resolve({ status: 200, reintentar: false });
                }
                let mensaje = '';
                try { mensaje = JSON.parse(data)?.error?.message || ''; } catch (e) { mensaje = data.slice(0, 200); }
                console.error(`Gemini ${modelo} respondió ${res.statusCode}: ${mensaje}`);
                resolve({ status: res.statusCode, mensaje, reintentar: CODIGOS_REINTENTABLES.has(res.statusCode) });
            });
        });

        req.on('timeout', () => req.destroy(new Error('Timeout')));
        req.on('error', (err) => {
            console.error(`Gemini ${modelo} error de red:`, err.message);
            resolve({ status: 0, mensaje: err.message, reintentar: true });
        });
        req.write(payload);
        req.end();
    });
}

// Prueba el modelo principal hasta 3 veces (esperando 2 s y 5 s) y luego cada modelo de respaldo.
async function llamarGemini(contents, generationConfig, { intentos = 3 } = {}) {
    const modelos = [GEMINI_MODEL, ...GEMINI_MODELOS_RESPALDO];
    const esperas = [2000, 5000];
    for (const modelo of modelos) {
        for (let i = 0; i < intentos; i++) {
            const r = await llamarModelo(modelo, contents, generationConfig);
            if (r.texto) {
                ultimoErrorGemini = null;
                return r.texto;
            }
            ultimoErrorGemini = { modelo, status: r.status, mensaje: r.mensaje, en: new Date() };
            if (!r.reintentar) break;
            if (i < intentos - 1) await esperar(esperas[i] || 5000);
        }
    }
    return null;
}

async function consultarGemini(remitenteId, mensajeTexto) {
    let historial = userHistories.get(remitenteId);
    if (!historial) {
        // Recupera la conversación desde la base (por ejemplo, después de un reinicio). Excluye el mensaje actual, que ya se guardó.
        historial = await cargarHistorial(remitenteId);
        const ultimo = historial[historial.length - 1];
        if (ultimo && ultimo.role === 'user' && ultimo.parts[0].text.endsWith(mensajeTexto)) {
            const resto = ultimo.parts[0].text.slice(0, -mensajeTexto.length).replace(/\n$/, '');
            if (resto) ultimo.parts[0].text = resto; else historial.pop();
        }
    }

    // Si el historial termina en un mensaje del cliente sin respuesta, se une con el actual para respetar la alternancia.
    const previo = historial.length && historial[historial.length - 1].role === 'user' ? historial[historial.length - 1] : null;
    const base = previo ? historial.slice(0, -1) : historial;
    const textoUsuario = previo ? previo.parts[0].text + '\n' + mensajeTexto : mensajeTexto;
    const mensajeUsuario = { role: 'user', parts: [{ text: textoUsuario }] };

    const contents = [
        { role: 'user', parts: [{ text: construirInstrucciones() }] },
        { role: 'model', parts: [{ text: 'Entendido. Actuaré como el asistente virtual formal del Estudio Jaime Irigoyen siguiendo estrictamente estas reglas.' }] },
        ...base,
        mensajeUsuario
    ];

    const reply = await llamarGemini(contents, { maxOutputTokens: 250, temperature: 0.5 });
    if (!reply) {
        userHistories.set(remitenteId, [...base, mensajeUsuario].slice(-MAX_TURNOS_HISTORIAL));
        return null;
    }

    const nuevoHistorial = [...base, mensajeUsuario, { role: 'model', parts: [{ text: reply }] }];
    userHistories.set(remitenteId, nuevoHistorial.slice(-MAX_TURNOS_HISTORIAL));
    return reply;
}

// ---------- Detección de nombre via IA (solo mientras no lo tengamos) ----------

async function detectarNombre(texto) {
    const prompt = `Del siguiente mensaje de WhatsApp, extraé SOLO el nombre y apellido de la persona si se presenta. Respondé ÚNICAMENTE con el nombre, sin puntos ni explicaciones. Si no hay nombre, respondé NO.\n\nMensaje: "${texto}"`;
    const respuesta = await llamarGemini(
        [{ role: 'user', parts: [{ text: prompt }] }],
        { maxOutputTokens: 30, temperature: 0.1 },
        { intentos: 1 }
    );
    return limpiarNombre(respuesta);
}

// ---------- Avisos al administrador ----------

const REGEX_EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const MAX_MENSAJES_CLIENTE = 20;
const mensajesCliente = new Map();
const contactosAvisados = new Set();
const avisosFalla = new Map(); // remitente -> fecha del último aviso de falla

function registrarMensajeCliente(sender, text) {
    const lista = mensajesCliente.get(sender) || [];
    lista.push(text);
    mensajesCliente.set(sender, lista.slice(-MAX_MENSAJES_CLIENTE));
}

async function extraerDatosContacto(sender) {
    const conversacion = (mensajesCliente.get(sender) || []).map(t => `- ${t}`).join('\n');
    const prompt =
        'A partir de los siguientes mensajes de un cliente al Estudio Jurídico Jaime Irigoyen por WhatsApp, ' +
        'extraé su nombre y apellido, y escribí un resumen breve (máximo 3 oraciones) de lo que consulta.\n' +
        'Respondé ÚNICAMENTE con un JSON: {"nombre": "...", "resumen": "..."}\n' +
        'Si el nombre no aparece, poné "No indicado".\n\nMensajes:\n' + conversacion;

    const respuesta = await llamarGemini(
        [{ role: 'user', parts: [{ text: prompt }] }],
        { maxOutputTokens: 300, temperature: 0.2 }
    );

    if (respuesta) {
        try {
            const limpio = respuesta.replace(/```json|```/g, '').trim();
            const datos = JSON.parse(limpio);
            return { nombre: datos.nombre || 'No indicado', resumen: datos.resumen || 'No disponible' };
        } catch (e) { /* sigue */ }
    }
    return {
        nombre: 'No detectado',
        resumen: (mensajesCliente.get(sender) || []).slice(-5).map(t => `• ${t}`).join('\n')
    };
}

async function obtenerJidAdmin(sock) {
    try {
        const [resultado] = await sock.onWhatsApp(ADMIN_NUMBER);
        if (resultado?.exists && resultado.jid) return resultado.jid;
    } catch (e) { /* usa fallback */ }
    return `${ADMIN_NUMBER}@s.whatsapp.net`;
}

function lineaWhatsApp(numero) {
    return numero ? `+${numero}\nwa.me/${numero}` : 'No disponible (WhatsApp no informó el número).';
}

async function avisarContactoNuevo(sock, sender, numero, email) {
    if (!ADMIN_NUMBER) return;
    const clave = `${sender}|${email.toLowerCase()}`;
    if (contactosAvisados.has(clave)) return;
    contactosAvisados.add(clave);

    try {
        const { nombre, resumen } = await extraerDatosContacto(sender);

        const aviso =
            '📩 *NUEVO CONTACTO*\n\n' +
            `👤 *Nombre:* ${nombre}\n` +
            `✉️ *Correo:* ${email}\n` +
            `📱 *WhatsApp:* ${lineaWhatsApp(numero)}\n\n` +
            `📝 *Consulta:*\n${resumen}`;

        await sock.sendMessage(await obtenerJidAdmin(sock), { text: aviso });

        await actualizarContacto(sender, 'email', email);
        const nombreLimpio = limpiarNombre(nombre);
        if (nombreLimpio) await actualizarContacto(sender, 'nombre', nombreLimpio);

        console.log(`[AVISO] Contacto nuevo: ${nombre} - ${email}`);
    } catch (e) {
        contactosAvisados.delete(clave);
        console.error('Error enviando aviso:', e.message);
    }
}

// Avisa al administrador cuando el bot no pudo responder a un cliente (máximo un aviso cada 30 minutos por cliente).
async function avisarFallaRespuesta(sock, sender, numero, text) {
    if (!ADMIN_NUMBER) return;
    const ultimo = avisosFalla.get(sender);
    if (ultimo && Date.now() - ultimo < 30 * 60 * 1000) return;
    avisosFalla.set(sender, Date.now());
    try {
        const contacto = await obtenerContacto(sender);
        const aviso =
            '⚠️ *EL BOT NO PUDO RESPONDER*\n\n' +
            'Gemini no respondió después de varios intentos. El cliente recibió un mensaje de espera.\n\n' +
            `👤 *Nombre:* ${contacto?.nombre || 'No indicado'}\n` +
            `📱 *WhatsApp:* ${lineaWhatsApp(numero || contacto?.numero)}\n\n` +
            `💬 *Último mensaje:* ${text}`;
        await sock.sendMessage(await obtenerJidAdmin(sock), { text: aviso });
    } catch (e) {
        console.error('Error avisando falla al administrador:', e.message);
    }
}

// ---------- Comandos del administrador ----------

const REGEX_COMANDO_ADMIN = /^ADMIN(:|\s+LISTAR$|\s+BORRAR(\s+\d+)?$|\s+ESTADO$|\s+MODELOS$)/i;

// Lista los modelos de Gemini que acepta esta clave, para elegir el de respaldo.
function listarModelos() {
    return new Promise((resolve) => {
        const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=100&key=${GEMINI_API_KEY}`;
        https.get(url, { timeout: 15000 }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const modelos = (JSON.parse(data).models || [])
                        .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
                        .map(m => m.name.replace(/^models\//, ''))
                        .filter(n => /flash|pro/i.test(n) && !/(tts|image|audio|live|embedding|vision)/i.test(n));
                    resolve(modelos);
                } catch (e) { resolve(null); }
            });
        }).on('error', () => resolve(null)).on('timeout', function () { this.destroy(); });
    });
}

function esAdmin(msg) {
    if (!ADMIN_NUMBER) return false;
    const candidatos = [msg.key.remoteJid, msg.key.senderPn, msg.key.remoteJidAlt, msg.key.participant, msg.key.participantPn]
        .filter(Boolean).map(soloDigitos);
    return candidatos.includes(ADMIN_NUMBER);
}

function formatoFecha(fecha) {
    if (!fecha) return 'sin datos';
    return new Date(fecha).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
}

async function estadoSistema() {
    const lineas = ['🩺 *ESTADO DEL BOT*', ''];
    lineas.push(`📱 WhatsApp: ${isConnected ? '✅ conectado' : '❌ desconectado'}`);

    try {
        const { rows: [c] } = await db.query('SELECT COUNT(*)::int AS n FROM contactos');
        const { rows: [m] } = await db.query('SELECT COUNT(*)::int AS n, MAX(timestamp) AS ultimo FROM mensajes');
        const { rows: [h] } = await db.query(`SELECT COUNT(*)::int AS n FROM mensajes WHERE timestamp >= date_trunc('day', NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires') AT TIME ZONE 'America/Argentina/Buenos_Aires'`);
        lineas.push('🗄️ Base de datos: ✅ conectada');
        lineas.push(`   • Contactos guardados: ${c.n}`);
        lineas.push(`   • Mensajes guardados: ${m.n} (hoy: ${h.n})`);
        lineas.push(`   • Último mensaje: ${formatoFecha(m.ultimo)}`);
    } catch (e) {
        lineas.push(`🗄️ Base de datos: ❌ error (${e.message})`);
    }

    const prueba = await llamarModelo(GEMINI_MODEL, [{ role: 'user', parts: [{ text: 'Respondé solo: OK' }] }], { maxOutputTokens: 5, temperature: 0 });
    lineas.push(`🤖 Gemini (${GEMINI_MODEL}): ${prueba.texto ? '✅ responde' : `❌ ${prueba.status || ''} ${prueba.mensaje || 'sin respuesta'}`.trim()}`);
    if (GEMINI_MODELOS_RESPALDO.length) lineas.push(`   • Respaldo: ${GEMINI_MODELOS_RESPALDO.join(', ')}`);
    if (ultimoErrorGemini) lineas.push(`   • Último error: ${ultimoErrorGemini.status} a las ${formatoFecha(ultimoErrorGemini.en)}`);

    lineas.push(`📋 Reglas de administrador: ${globalAdminRules.length}`);
    lineas.push(`🔐 Sesión de WhatsApp en: ${AUTH_FOLDER}`);
    lineas.push(`⏱️ Encendido desde: ${formatoFecha(iniciadoEn)}`);
    return lineas.join('\n');
}

async function procesarComandoAdmin(sock, sender, text) {
    const comando = text.trim();

    if (/^ADMIN\s+ESTADO$/i.test(comando)) {
        await sock.sendMessage(sender, { text: await estadoSistema() });
        return;
    }

    if (/^ADMIN\s+MODELOS$/i.test(comando)) {
        const modelos = await listarModelos();
        const texto = modelos && modelos.length
            ? `🤖 Modelos disponibles con esta clave:\n${modelos.map(m => `• ${m}${m === GEMINI_MODEL ? ' (principal)' : ''}`).join('\n')}\n\nPara usar uno de respaldo, cargalo en Railway en la variable GEMINI_MODELO_RESPALDO.`
            : '⚠️ No se pudo obtener la lista de modelos.';
        await sock.sendMessage(sender, { text: texto });
        return;
    }

    if (/^ADMIN\s+LISTAR$/i.test(comando)) {
        const lista = globalAdminRules.length > 0
            ? globalAdminRules.map((r, i) => `${i + 1}. ${r.regla}`).join('\n') +
              '\n\nPara borrar: "ADMIN BORRAR [número]"'
            : 'No hay reglas guardadas.';
        await sock.sendMessage(sender, { text: `📋 Reglas actuales:\n${lista}` });
        return;
    }

    const borrarUna = comando.match(/^ADMIN\s+BORRAR\s+(\d+)$/i);
    if (borrarUna) {
        const numero = parseInt(borrarUna[1], 10);
        const regla = globalAdminRules[numero - 1];
        if (!regla) {
            await sock.sendMessage(sender, { text: `⚠️ No existe la regla ${numero}.` });
            return;
        }
        try {
            await db.query('DELETE FROM reglas_admin WHERE id = $1', [regla.id]);
            await cargarReglas();
            await sock.sendMessage(sender, { text: `🗑️ Regla ${numero} eliminada:\n"${regla.regla}"` });
        } catch (e) {
            await sock.sendMessage(sender, { text: `⚠️ No se pudo borrar la regla: ${e.message}` });
        }
        return;
    }

    if (/^ADMIN\s+BORRAR$/i.test(comando)) {
        try {
            await db.query('DELETE FROM reglas_admin');
            await cargarReglas();
            await sock.sendMessage(sender, { text: '🗑️ Se borraron todas las reglas.' });
        } catch (e) {
            await sock.sendMessage(sender, { text: `⚠️ No se pudieron borrar las reglas: ${e.message}` });
        }
        return;
    }

    const nuevaRegla = comando.replace(/^ADMIN:\s*/i, '').trim();
    if (!nuevaRegla) {
        await sock.sendMessage(sender, { text: 'Escriba la regla después de "ADMIN:"\nEjemplo: ADMIN: Los sábados el Estudio está cerrado.' });
        return;
    }

    try {
        await db.query('INSERT INTO reglas_admin (regla) VALUES ($1)', [nuevaRegla]);
        await cargarReglas();
        await sock.sendMessage(sender, { text: `✅ Regla guardada:\n"${nuevaRegla}"\n\nSe aplica a partir de ahora.` });
        console.log(`[ADMIN] Nueva regla: ${nuevaRegla}`);
    } catch (e) {
        await sock.sendMessage(sender, { text: `⚠️ No se pudo guardar la regla: ${e.message}` });
    }
}

// ---------- Conexión con WhatsApp ----------

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
    });
    socketActual = sock;

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) { currentQR = qr; isConnected = false; console.log('Nuevo código QR generado.'); }

        if (connection === 'close') {
            const loggedOut = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
            console.log('Conexión cerrada. Error:', lastDisconnect?.error?.message || lastDisconnect?.error);
            isConnected = false;
            currentQR = null;
            if (loggedOut) {
                console.log('Sesión cerrada. Generando nuevo QR...');
                fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
            }
            setTimeout(connectToWhatsApp, 5000);
        } else if (connection === 'open') {
            console.log('¡Conexión con WhatsApp establecida!');
            isConnected = true;
            currentQR = null;
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            try {
                const sender = msg.key.remoteJid || '';
                if (!msg.message || msg.key.fromMe) continue;
                if (sender.endsWith('@g.us') || sender.endsWith('@broadcast') || sender.endsWith('@newsletter')) continue;

                const text = msg.message.conversation ||
                             msg.message.extendedTextMessage?.text ||
                             msg.message.imageMessage?.caption || '';

                if (!text.trim()) continue;

                const numero = numeroCliente(msg);
                console.log(`[MSG] ${sender}${numero ? ` (+${numero})` : ''}: ${text}`);

                // Comandos del administrador
                if (REGEX_COMANDO_ADMIN.test(text.trim()) && esAdmin(msg)) {
                    await procesarComandoAdmin(sock, sender, text);
                    continue;
                }

                registrarMensajeCliente(sender, text);
                await guardarMensaje(sender, 'cliente', text, numero);

                // Buscar el nombre solo mientras el contacto no lo tenga guardado.
                const contacto = await obtenerContacto(sender);
                if (!contacto || !contacto.nombre || contacto.nombre === 'No indicado') {
                    const nombreDetectado = await detectarNombre(text);
                    if (nombreDetectado) await actualizarContacto(sender, 'nombre', nombreDetectado);
                }

                await sock.sendPresenceUpdate('composing', sender);
                const respuestaAI = await consultarGemini(sender, text);
                const textoFinal = respuestaAI || MENSAJE_ERROR;
                await esperar(1500);
                await sock.sendMessage(sender, { text: textoFinal });

                // Las respuestas de error se guardan con otro rol para no mezclarlas en el historial de la conversación.
                await guardarMensaje(sender, respuestaAI ? 'bot' : 'bot_error', textoFinal, numero);
                console.log(`[BOT] ${sender}: ${textoFinal}`);

                if (!respuestaAI) avisarFallaRespuesta(sock, sender, numero, text);

                const email = text.match(REGEX_EMAIL)?.[0];
                if (email) avisarContactoNuevo(sock, sender, numero, email);

            } catch (e) {
                console.error('Error procesando mensaje:', e);
            }
        }
    });
}

// ---------- Arranque ----------

app.listen(PORT, async () => {
    console.log(`Servidor web activo en el puerto ${PORT}`);
    if (!GEMINI_API_KEY) console.warn('⚠️ Falta GEMINI_API_KEY.');
    if (!ADMIN_NUMBER) console.warn('ℹ️ ADMIN_NUMBER no configurado.');
    console.log(`Modelo Gemini: ${GEMINI_MODEL}${GEMINI_MODELOS_RESPALDO.length ? ` (respaldo: ${GEMINI_MODELOS_RESPALDO.join(', ')})` : ''}`);
    console.log(`Sesión de WhatsApp en: ${AUTH_FOLDER}`);
    await inicializarDB();
    if (dbOk) await cargarReglas();
    setTimeout(connectToWhatsApp, 5000);
});

module.exports = { limpiarNombre, filasAHistorial, numeroCliente, soloDigitos };
