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
 *   GOOGLE_CLIENT_ID        (opcional)    Credencial OAuth de Google Cloud, para usar Google Calendar.
 *   GOOGLE_CLIENT_SECRET    (opcional)    Secreto OAuth de Google Cloud.
 *   GOOGLE_CUENTA           (opcional)    Única cuenta de Google que se acepta conectar (por defecto estudiojaimeirigoyen@gmail.com).
 *   PUBLIC_URL              (opcional)    URL pública del bot (por defecto https://irigoyen-whatsapp-bot-production.up.railway.app).
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

const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
const GOOGLE_CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
const GOOGLE_CUENTA = (process.env.GOOGLE_CUENTA || 'estudiojaimeirigoyen@gmail.com').trim().toLowerCase();
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://irigoyen-whatsapp-bot-production.up.railway.app').replace(/\/$/, '');
const GOOGLE_REDIRECT = `${PUBLIC_URL}/google/callback`;
const ZONA_HORARIA = 'America/Argentina/Buenos_Aires';

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
        await db.query(`
            CREATE TABLE IF NOT EXISTS configuracion (
                clave TEXT PRIMARY KEY,
                valor TEXT NOT NULL,
                actualizado_en TIMESTAMPTZ DEFAULT NOW()
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

async function leerConfig(clave) {
    try {
        const { rows } = await db.query('SELECT valor FROM configuracion WHERE clave = $1', [clave]);
        return rows[0]?.valor ?? null;
    } catch (e) {
        return null;
    }
}

async function guardarConfig(clave, valor) {
    await db.query(`
        INSERT INTO configuracion (clave, valor, actualizado_en) VALUES ($1, $2, NOW())
        ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = NOW()
    `, [clave, valor]);
}

async function borrarConfig(clave) {
    await db.query('DELETE FROM configuracion WHERE clave = $1', [clave]);
}

// ---------- Google Calendar ----------
// El permiso se da una sola vez: el administrador pide un link con "ADMIN CONECTAR GOOGLE",
// inicia sesión con la cuenta del estudio, y el bot guarda el permiso (refresh token) en la base.

const GOOGLE_SCOPES = [
    'openid',
    'email',
    'https://www.googleapis.com/auth/calendar'
].join(' ');

const enlacesGoogle = new Map(); // estado de un solo uso -> vence (ms)
let tokenGoogle = null;           // { access_token, vence }

function solicitudHttps(metodo, url, { headers = {}, cuerpo = null, timeout = 20000 } = {}) {
    return new Promise((resolve) => {
        const datos = cuerpo == null ? null : (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo));
        const req = https.request(url, {
            method: metodo,
            headers: {
                ...(datos != null ? { 'Content-Length': Buffer.byteLength(datos) } : {}),
                ...headers
            },
            timeout
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                let json = null;
                try { json = data ? JSON.parse(data) : null; } catch (e) { /* no es JSON */ }
                resolve({ status: res.statusCode, json, texto: data });
            });
        });
        req.on('timeout', () => req.destroy(new Error('Timeout')));
        req.on('error', (err) => resolve({ status: 0, json: null, texto: err.message }));
        if (datos != null) req.write(datos);
        req.end();
    });
}

function googleConfigurado() {
    return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

function crearEnlaceConexionGoogle() {
    const estado = require('crypto').randomBytes(24).toString('hex');
    enlacesGoogle.set(estado, Date.now() + 15 * 60 * 1000);
    return `${PUBLIC_URL}/google/conectar?estado=${estado}`;
}

function estadoGoogleValido(estado) {
    const vence = enlacesGoogle.get(estado);
    if (!vence) return false;
    if (Date.now() > vence) { enlacesGoogle.delete(estado); return false; }
    return true;
}

function formulario(params) {
    return Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

function emailDesdeIdToken(idToken) {
    try {
        const payload = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        return (JSON.parse(Buffer.from(payload, 'base64').toString('utf8')).email || '').toLowerCase();
    } catch (e) {
        return '';
    }
}

async function obtenerTokenGoogle() {
    if (tokenGoogle && Date.now() < tokenGoogle.vence - 60000) return tokenGoogle.access_token;
    const refresh = await leerConfig('google_refresh_token');
    if (!refresh || !googleConfigurado()) return null;

    const r = await solicitudHttps('POST', 'https://oauth2.googleapis.com/token', {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        cuerpo: formulario({
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            refresh_token: refresh,
            grant_type: 'refresh_token'
        })
    });
    if (r.status === 200 && r.json?.access_token) {
        tokenGoogle = { access_token: r.json.access_token, vence: Date.now() + (r.json.expires_in || 3600) * 1000 };
        return tokenGoogle.access_token;
    }
    console.error('No se pudo renovar el permiso de Google:', r.status, r.json?.error || r.texto.slice(0, 200));
    if (r.json?.error === 'invalid_grant') {
        // El permiso fue revocado o venció: hay que volver a conectar.
        await borrarConfig('google_refresh_token').catch(() => {});
        tokenGoogle = null;
    }
    return null;
}

async function apiCalendar(metodo, ruta, cuerpo = null) {
    const token = await obtenerTokenGoogle();
    if (!token) return { status: 401, json: null, texto: 'Google Calendar no está conectado.' };
    return solicitudHttps(metodo, `https://www.googleapis.com/calendar/v3${ruta}`, {
        headers: { Authorization: `Bearer ${token}`, ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
        cuerpo
    });
}

// Próximos eventos del calendario principal (por defecto, 7 días).
async function eventosProximos(dias = 7) {
    const desde = new Date();
    const hasta = new Date(desde.getTime() + dias * 24 * 60 * 60 * 1000);
    const q = formulario({
        timeMin: desde.toISOString(),
        timeMax: hasta.toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '50',
        timeZone: ZONA_HORARIA
    });
    const r = await apiCalendar('GET', `/calendars/primary/events?${q}`);
    if (r.status !== 200) return null;
    return (r.json.items || []).filter(e => e.status !== 'cancelled');
}

// Crea un evento con link de Meet. inicio y fin son fechas ISO con zona horaria.
async function crearEventoConMeet({ titulo, descripcion = '', inicio, fin, invitados = [] }) {
    const cuerpo = {
        summary: titulo,
        description: descripcion,
        start: { dateTime: inicio, timeZone: ZONA_HORARIA },
        end: { dateTime: fin, timeZone: ZONA_HORARIA },
        attendees: invitados.map(email => ({ email })),
        reminders: { useDefault: false, overrides: [] }, // los recordatorios los manda el bot por WhatsApp
        conferenceData: {
            createRequest: {
                requestId: require('crypto').randomBytes(12).toString('hex'),
                conferenceSolutionKey: { type: 'hangoutsMeet' }
            }
        }
    };
    const r = await apiCalendar('POST', '/calendars/primary/events?conferenceDataVersion=1&sendUpdates=none', cuerpo);
    if (r.status !== 200) {
        console.error('Error creando evento:', r.status, r.json?.error?.message || r.texto.slice(0, 200));
        return null;
    }
    const meet = r.json.hangoutLink ||
        r.json.conferenceData?.entryPoints?.find(p => p.entryPointType === 'video')?.uri || null;
    return { id: r.json.id, link: r.json.htmlLink, meet };
}

// Fecha/hora en Buenos Aires (UTC-3, sin horario de verano) como texto ISO con zona.
function fechaBA(dias, hora, minuto = 0) {
    const ahoraBA = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const d = new Date(Date.UTC(ahoraBA.getUTCFullYear(), ahoraBA.getUTCMonth(), ahoraBA.getUTCDate() + dias, hora, minuto));
    return d.toISOString().replace('Z', '').slice(0, 19) + '-03:00';
}

function horaCorta(fechaIso) {
    return new Date(fechaIso).toLocaleString('es-AR', {
        timeZone: ZONA_HORARIA, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    });
}

// Rutas web para conectar la cuenta (solo con link de un solo uso pedido por el administrador).
app.get('/google/conectar', (req, res) => {
    if (!googleConfigurado()) return res.status(500).send('Faltan GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en Railway.');
    const estado = String(req.query.estado || '');
    if (!estadoGoogleValido(estado)) {
        return res.status(403).send('Este link venció o ya se usó. Pedí uno nuevo por WhatsApp con "ADMIN CONECTAR GOOGLE".');
    }
    const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + formulario({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: GOOGLE_REDIRECT,
        response_type: 'code',
        scope: GOOGLE_SCOPES,
        access_type: 'offline',
        prompt: 'consent',
        login_hint: GOOGLE_CUENTA,
        state: estado
    });
    res.redirect(url);
});

function paginaSimple(titulo, mensaje, ok) {
    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${titulo}</title>
        <style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0f172a;color:#f8fafc;margin:0;padding:16px;box-sizing:border-box}
        .card{background:#1e293b;padding:32px;border-radius:16px;max-width:440px;width:100%;text-align:center}
        h1{font-size:1.3rem;margin:0 0 12px;color:${ok ? '#34d399' : '#f87171'}}p{color:#cbd5e1;line-height:1.5;margin:0}</style></head>
        <body><div class="card"><h1>${titulo}</h1><p>${mensaje}</p></div></body></html>`;
}

app.get('/google/callback', async (req, res) => {
    const estado = String(req.query.estado || req.query.state || '');
    if (!estadoGoogleValido(estado)) {
        return res.status(403).send(paginaSimple('Link vencido', 'Pedí uno nuevo por WhatsApp con "ADMIN CONECTAR GOOGLE".', false));
    }
    enlacesGoogle.delete(estado);

    if (req.query.error) {
        return res.send(paginaSimple('No se conectó', `Google respondió: ${String(req.query.error)}. Podés intentar de nuevo pidiendo otro link.`, false));
    }

    const r = await solicitudHttps('POST', 'https://oauth2.googleapis.com/token', {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        cuerpo: formulario({
            code: String(req.query.code || ''),
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            redirect_uri: GOOGLE_REDIRECT,
            grant_type: 'authorization_code'
        })
    });

    if (r.status !== 200 || !r.json?.refresh_token) {
        console.error('Error obteniendo permiso de Google:', r.status, r.json?.error || r.texto.slice(0, 200));
        return res.send(paginaSimple('No se conectó', 'Google no devolvió el permiso permanente. Pedí otro link e intentá de nuevo.', false));
    }

    const email = emailDesdeIdToken(r.json.id_token || '');
    if (email !== GOOGLE_CUENTA) {
        return res.send(paginaSimple('Cuenta incorrecta',
            `Iniciaste sesión con ${email || 'otra cuenta'}. Solo se acepta ${GOOGLE_CUENTA}. Pedí otro link e iniciá sesión con esa cuenta.`, false));
    }

    try {
        await guardarConfig('google_refresh_token', r.json.refresh_token);
        await guardarConfig('google_cuenta', email);
        tokenGoogle = { access_token: r.json.access_token, vence: Date.now() + (r.json.expires_in || 3600) * 1000 };
    } catch (e) {
        return res.send(paginaSimple('No se guardó', `No se pudo guardar el permiso en la base de datos: ${e.message}`, false));
    }

    console.log(`✅ Google Calendar conectado con ${email}`);
    if (socketActual && ADMIN_NUMBER) {
        socketActual.sendMessage(await obtenerJidAdmin(socketActual), {
            text: `✅ Google Calendar conectado con ${email}.\n\nProbá con "ADMIN AGENDA" o "ADMIN PRUEBA REUNION".`
        }).catch(() => {});
    }
    res.send(paginaSimple('Google Calendar conectado', `El bot ya puede usar la agenda de ${email}. Podés cerrar esta página.`, true));
});

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

const REGEX_COMANDO_ADMIN = /^ADMIN(:|\s+LISTAR$|\s+BORRAR(\s+\d+)?$|\s+ESTADO$|\s+MODELOS$|\s+CONECTAR\s+GOOGLE$|\s+AGENDA$|\s+PRUEBA\s+REUNION$|\s+AYUDA$)/i;

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

    if (!googleConfigurado()) {
        lineas.push('📅 Google Calendar: ❌ faltan GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET en Railway');
    } else if (!(await leerConfig('google_refresh_token'))) {
        lineas.push('📅 Google Calendar: ⚠️ sin conectar (mandá "ADMIN CONECTAR GOOGLE")');
    } else {
        const ok = await obtenerTokenGoogle();
        lineas.push(`📅 Google Calendar: ${ok ? `✅ conectado (${await leerConfig('google_cuenta')})` : '❌ el permiso falló, volvé a conectar'}`);
    }
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

    if (/^ADMIN\s+AYUDA$/i.test(comando)) {
        await sock.sendMessage(sender, { text:
            '🛠️ *Comandos de administrador*\n\n' +
            '• ADMIN ESTADO: estado de WhatsApp, base, Gemini y agenda\n' +
            '• ADMIN MODELOS: modelos de Gemini disponibles\n' +
            '• ADMIN CONECTAR GOOGLE: link para conectar Google Calendar\n' +
            '• ADMIN AGENDA: reuniones de los próximos 7 días\n' +
            '• ADMIN PRUEBA REUNION: crea una reunión de prueba con Meet\n' +
            '• ADMIN: [regla]: agrega una regla al bot\n' +
            '• ADMIN LISTAR / ADMIN BORRAR [n]: ver o borrar reglas'
        });
        return;
    }

    if (/^ADMIN\s+CONECTAR\s+GOOGLE$/i.test(comando)) {
        if (!googleConfigurado()) {
            await sock.sendMessage(sender, { text: '⚠️ Faltan GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en las variables de Railway.' });
            return;
        }
        const enlace = crearEnlaceConexionGoogle();
        await sock.sendMessage(sender, { text:
            '📅 *Conectar Google Calendar*\n\n' +
            `1. Abrí este link (vale 15 minutos y una sola vez):\n${enlace}\n\n` +
            `2. Iniciá sesión con *${GOOGLE_CUENTA}*.\n` +
            '3. Si aparece "Google no verificó esta app", tocá *Configuración avanzada* → *Ir a Bot Estudio Jaime Irigoyen*.\n' +
            '4. Aceptá los permisos.\n\nCuando termine te aviso por acá.'
        });
        return;
    }

    if (/^ADMIN\s+AGENDA$/i.test(comando)) {
        const eventos = await eventosProximos(7);
        if (!eventos) {
            await sock.sendMessage(sender, { text: '⚠️ No pude leer la agenda. Revisá con "ADMIN ESTADO" que Google Calendar esté conectado.' });
            return;
        }
        const texto = eventos.length
            ? '📅 *Próximos 7 días*\n\n' + eventos.map(e => `• ${horaCorta(e.start.dateTime || e.start.date)}: ${e.summary || '(sin título)'}`).join('\n')
            : '📅 No hay eventos en los próximos 7 días.';
        await sock.sendMessage(sender, { text: texto });
        return;
    }

    if (/^ADMIN\s+PRUEBA\s+REUNION$/i.test(comando)) {
        const evento = await crearEventoConMeet({
            titulo: 'Prueba del bot (se puede borrar)',
            descripcion: 'Reunión de prueba creada por el bot de WhatsApp del Estudio.',
            inicio: fechaBA(1, 12, 0),
            fin: fechaBA(1, 12, 45)
        });
        const texto = evento
            ? `✅ Reunión de prueba creada para mañana a las 12:00.\n\n🎥 Meet: ${evento.meet || 'no se generó link'}\n📅 Evento: ${evento.link}\n\nPodés borrarla del calendario.`
            : '⚠️ No se pudo crear la reunión. Revisá con "ADMIN ESTADO" que Google Calendar esté conectado.';
        await sock.sendMessage(sender, { text: texto });
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

module.exports = { limpiarNombre, filasAHistorial, numeroCliente, soloDigitos, fechaBA, emailDesdeIdToken, horaCorta };
