/**
 * WhatsApp Bridge con Baileys + Google Gemini AI + PostgreSQL
 * Estudio Jurídico Jaime Irigoyen
 *
 * Variables de entorno:
 *   GEMINI_API_KEY   (obligatoria) Clave de la API de Gemini.
 *   DATABASE_URL     (obligatoria) URL de conexión a PostgreSQL de Railway.
 *   ADMIN_NUMBER     (opcional)    Número del administrador, solo dígitos y con código de país.
 *   PANEL_PASSWORD   (opcional)    Si se configura, la página del QR pide ?clave=... en la URL.
 *   PORT             (opcional)    Puerto del servidor web (por defecto 3000).
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
const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const ADMIN_NUMBER = (process.env.ADMIN_NUMBER || '').replace(/\D/g, '');
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || '';

const AUTH_FOLDER = 'auth_info_baileys';
const RULES_FILE = 'reglas_admin.json';
const MAX_TURNOS_HISTORIAL = 10;

const MENSAJE_ERROR = 'Disculpe, en este momento estamos teniendo un inconveniente técnico. Un abogado del Estudio se comunicará con usted a la brevedad.';

let currentQR = null;
let isConnected = false;
const userHistories = new Map();

// ---------- Base de datos PostgreSQL ----------

const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway.internal')
        ? false
        : { rejectUnauthorized: false }
});

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
        await db.query(`
            CREATE TABLE IF NOT EXISTS mensajes (
                id SERIAL PRIMARY KEY,
                telefono TEXT NOT NULL,
                rol TEXT NOT NULL,
                texto TEXT NOT NULL,
                timestamp TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS reglas_admin (
                id SERIAL PRIMARY KEY,
                regla TEXT NOT NULL,
                creada_en TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        console.log('✅ Base de datos inicializada correctamente.');
    } catch (e) {
        console.error('❌ Error inicializando la base de datos:', e.message);
    }
}

async function guardarMensaje(telefono, rol, texto) {
    try {
        await db.query(
            'INSERT INTO mensajes (telefono, rol, texto) VALUES ($1, $2, $3)',
            [telefono, rol, texto]
        );
        await db.query(`
            INSERT INTO contactos (telefono, ultima_actividad, total_mensajes)
            VALUES ($1, NOW(), 1)
            ON CONFLICT (telefono) DO UPDATE
            SET ultima_actividad = NOW(),
                total_mensajes = contactos.total_mensajes + 1
        `, [telefono]);
    } catch (e) {
        console.error('Error guardando mensaje en DB:', e.message);
    }
}

async function actualizarContacto(telefono, campo, valor) {
    try {
        await db.query(
            `UPDATE contactos SET ${campo} = $1 WHERE telefono = $2`,
            [valor, telefono]
        );
    } catch (e) {
        console.error(`Error actualizando ${campo} en contacto:`, e.message);
    }
}

// ---------- Reglas del administrador ----------

function cargarReglas() {
    try {
        if (fs.existsSync(RULES_FILE)) {
            const reglas = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
            if (Array.isArray(reglas)) return reglas;
        }
    } catch (e) {
        console.error('No se pudieron leer las reglas:', e.message);
    }
    return [];
}

function guardarReglas() {
    try {
        fs.writeFileSync(RULES_FILE, JSON.stringify(globalAdminRules, null, 2), 'utf8');
    } catch (e) {
        console.error('No se pudieron guardar las reglas:', e.message);
    }
}

let globalAdminRules = cargarReglas();

// ---------- Instrucciones del bot ----------

function construirInstrucciones() {
    const reglasAdmin = globalAdminRules.length > 0
        ? '\n\nREGLAS ADICIONALES DEL ADMINISTRADOR (tienen prioridad):\n- ' + globalAdminRules.join('\n- ')
        : '';

    return 'Sos el asistente virtual oficial del Estudio Jurídico Jaime Irigoyen, especializado en derecho societario argentino (SAS, SRL, SA, Asociaciones Civiles y ONGs).\n' +
        'REGLAS OBLIGATORIAS:\n' +
        '1. Tono ESTRICTAMENTE FORMAL y PROFESIONAL en todo momento. Tratá siempre de "usted", nunca de "vos" ni de "tú".\n' +
        '2. En el PRIMER mensaje pedí siempre el nombre y apellido de la persona. Una vez que lo indique, dirigite a ella como "Sr.", "Sra." o "Srta." seguido de su apellido.\n' +
        '3. Usá la frase "Esa es una excelente consulta" COMO MÁXIMO UNA SOLA VEZ en toda la conversación, y solo si la pregunta es específicamente sobre derecho societario.\n' +
        '4. NUNCA des asesoramiento legal específico ni redactes contratos.\n' +
        '5. Si preguntan precios exactos o trámites complejos, respondé formalmente que un abogado del Estudio se comunicará a la brevedad para asesorarlo en detalle, y solicitá su correo electrónico si aún no lo indicó.\n' +
        '6. Sé conciso: máximo 2 a 3 oraciones breves. Estás respondiendo por WhatsApp.\n' +
        '7. Servicios del Estudio: constitución de sociedades, mantenimiento societario (balances, asambleas ordinarias y extraordinarias, cambio de autoridades y gerencias) y procesos de disolución y cierre para SAS, SRL, SA, Asociaciones Civiles y ONGs.' +
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

// ---------- Consulta a Google Gemini ----------

function llamarGemini(contents, generationConfig) {
    return new Promise((resolve) => {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
        const payload = JSON.stringify({ contents, generationConfig });

        const req = https.request(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            },
            timeout: 15000
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const parsed = JSON.parse(data);
                        const texto = parsed.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                        if (texto) return resolve(texto);
                    } catch (e) {
                        console.error('Error parseando respuesta de Gemini:', e);
                    }
                } else {
                    console.error('=== ERROR DE GEMINI ===', res.statusCode, data);
                }
                resolve(null);
            });
        });

        req.on('timeout', () => req.destroy(new Error('Timeout Gemini')));
        req.on('error', (err) => { console.error('Error Gemini:', err.message); resolve(null); });
        req.write(payload);
        req.end();
    });
}

async function consultarGemini(remitenteId, mensajeTexto) {
    const historial = userHistories.get(remitenteId) || [];
    const mensajeUsuario = { role: 'user', parts: [{ text: mensajeTexto }] };

    const contents = [
        { role: 'user', parts: [{ text: construirInstrucciones() }] },
        { role: 'model', parts: [{ text: 'Entendido. Actuaré como el asistente virtual formal del Estudio Jaime Irigoyen siguiendo estrictamente estas reglas.' }] },
        ...historial,
        mensajeUsuario
    ];

    const reply = await llamarGemini(contents, { maxOutputTokens: 250, temperature: 0.5 });
    if (!reply) return MENSAJE_ERROR;

    const nuevoHistorial = [...historial, mensajeUsuario, { role: 'model', parts: [{ text: reply }] }];
    userHistories.set(remitenteId, nuevoHistorial.slice(-MAX_TURNOS_HISTORIAL));
    return reply;
}

// ---------- Detección de nombre via IA ----------

async function detectarNombre(texto) {
    const prompt = `Del siguiente mensaje de WhatsApp, extraé SOLO el nombre y apellido de la persona si los menciona. Respondé ÚNICAMENTE con el nombre completo, sin puntos ni explicaciones. Si no hay nombre, respondé "NO".\n\nMensaje: "${texto}"`;
    const respuesta = await llamarGemini(
        [{ role: 'user', parts: [{ text: prompt }] }],
        { maxOutputTokens: 30, temperature: 0.1 }
    );
    if (respuesta && respuesta !== 'NO' && respuesta.length < 60) return respuesta.trim();
    return null;
}

// ---------- Aviso de contacto nuevo al administrador ----------

const REGEX_EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const MAX_MENSAJES_CLIENTE = 20;
const mensajesCliente = new Map();
const contactosAvisados = new Set();

function registrarMensajeCliente(sender, text) {
    const lista = mensajesCliente.get(sender) || [];
    lista.push(text);
    mensajesCliente.set(sender, lista.slice(-MAX_MENSAJES_CLIENTE));
}

function soloDigitos(jid) {
    return (jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

function numeroCliente(msg) {
    const candidatos = [msg.key.senderPn, msg.key.remoteJidAlt, msg.key.remoteJid]
        .filter(j => j && j.endsWith('@s.whatsapp.net'));
    return candidatos.length > 0 ? soloDigitos(candidatos[0]) : null;
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

async function avisarContactoNuevo(sock, msg, sender, email) {
    if (!ADMIN_NUMBER) return;
    const clave = `${sender}|${email.toLowerCase()}`;
    if (contactosAvisados.has(clave)) return;
    contactosAvisados.add(clave);

    try {
        const { nombre, resumen } = await extraerDatosContacto(sender);
        const numero = numeroCliente(msg);
        const lineaNumero = numero ? `+${numero}\nwa.me/${numero}` : 'No disponible.';

        const aviso =
            '📩 *NUEVO CONTACTO*\n\n' +
            `👤 *Nombre:* ${nombre}\n` +
            `✉️ *Correo:* ${email}\n` +
            `📱 *WhatsApp:* ${lineaNumero}\n\n` +
            `📝 *Consulta:*\n${resumen}`;

        const jidAdmin = await obtenerJidAdmin(sock);
        await sock.sendMessage(jidAdmin, { text: aviso });

        // Guardar email y nombre en la base de datos
        await actualizarContacto(sender, 'email', email);
        if (nombre !== 'No indicado') await actualizarContacto(sender, 'nombre', nombre);

        console.log(`[AVISO] Contacto nuevo: ${nombre} - ${email}`);
    } catch (e) {
        contactosAvisados.delete(clave);
        console.error('Error enviando aviso:', e);
    }
}

// ---------- Comandos del administrador ----------

function esAdmin(msg) {
    if (!ADMIN_NUMBER) return false;
    const candidatos = [msg.key.remoteJid, msg.key.senderPn, msg.key.remoteJidAlt, msg.key.participant]
        .filter(Boolean).map(soloDigitos);
    return candidatos.includes(ADMIN_NUMBER);
}

async function procesarComandoAdmin(sock, sender, text) {
    const comando = text.trim();

    if (/^ADMIN\s+LISTAR$/i.test(comando)) {
        const lista = globalAdminRules.length > 0
            ? globalAdminRules.map((r, i) => `${i + 1}. ${r}`).join('\n') +
              '\n\nPara borrar: "ADMIN BORRAR [número]"'
            : 'No hay reglas guardadas.';
        await sock.sendMessage(sender, { text: `📋 Reglas actuales:\n${lista}` });
        return;
    }

    const borrarUna = comando.match(/^ADMIN\s+BORRAR\s+(\d+)$/i);
    if (borrarUna) {
        const numero = parseInt(borrarUna[1], 10);
        if (numero < 1 || numero > globalAdminRules.length) {
            await sock.sendMessage(sender, { text: `⚠️ No existe la regla ${numero}.` });
            return;
        }
        const [eliminada] = globalAdminRules.splice(numero - 1, 1);
        guardarReglas();
        await sock.sendMessage(sender, { text: `🗑️ Regla ${numero} eliminada:\n"${eliminada}"` });
        return;
    }

    if (/^ADMIN\s+BORRAR$/i.test(comando)) {
        globalAdminRules = [];
        guardarReglas();
        await sock.sendMessage(sender, { text: '🗑️ Se borraron todas las reglas.' });
        return;
    }

    const nuevaRegla = comando.replace(/^ADMIN:\s*/i, '').trim();
    if (!nuevaRegla) {
        await sock.sendMessage(sender, { text: 'Escriba la regla después de "ADMIN:"\nEjemplo: ADMIN: Los sábados el Estudio está cerrado.' });
        return;
    }

    globalAdminRules.push(nuevaRegla);
    guardarReglas();
    await sock.sendMessage(sender, { text: `✅ Regla guardada:\n"${nuevaRegla}"\n\nSe aplica a partir de ahora.` });
    console.log(`[ADMIN] Nueva regla: ${nuevaRegla}`);
}

// ---------- Conexión con WhatsApp ----------

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
    });

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

                console.log(`[MSG] ${sender}: ${text}`);

                // Comandos admin
                if (/^ADMIN(:|\s+LISTAR$|\s+BORRAR(\s+\d+)?$)/i.test(text.trim()) && esAdmin(msg)) {
                    await procesarComandoAdmin(sock, sender, text);
                    continue;
                }

                registrarMensajeCliente(sender, text);

                // Guardar mensaje del cliente en la DB
                await guardarMensaje(sender, 'cliente', text);

                // Intentar detectar nombre del cliente para guardarlo en DB
                const nombreDetectado = await detectarNombre(text);
                if (nombreDetectado) await actualizarContacto(sender, 'nombre', nombreDetectado);

                await sock.sendPresenceUpdate('composing', sender);
                const respuestaAI = await consultarGemini(sender, text);
                await new Promise(r => setTimeout(r, 1500));
                await sock.sendMessage(sender, { text: respuestaAI });

                // Guardar respuesta del bot en la DB
                await guardarMensaje(sender, 'bot', respuestaAI);

                console.log(`[BOT] ${sender}: ${respuestaAI}`);

                // Aviso si dejó email
                const email = text.match(REGEX_EMAIL)?.[0];
                if (email) avisarContactoNuevo(sock, msg, sender, email);

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
    await inicializarDB();
    setTimeout(connectToWhatsApp, 5000);
});
