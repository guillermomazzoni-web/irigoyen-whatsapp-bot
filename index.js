/**
 * Bot de WhatsApp del Estudio Jurídico Jaime Irigoyen
 * Baileys (WhatsApp) + Google Gemini (IA) + PostgreSQL + Google Calendar
 *
 * ÍNDICE
 *   1. Configuración y utilidades
 *   2. Base de datos
 *   3. Google Calendar (conexión y eventos)
 *   4. Fechas, horario de atención y feriados
 *   5. Disponibilidad (qué horarios están libres)
 *   6. Turnos: una reunión = un número; los cambios de horario quedan dentro de la misma reunión
 *   6b. Cotizador: presupuestos (SAS) con 3 confirmaciones del administrador
 *   7. Bot de clientes: instrucciones, herramientas y respuestas directas
 *   8. Páginas web (QR y "agregar a mi agenda")
 *   9. Gemini (llamadas, reintentos y herramientas)
 *  10. Avisos al administrador
 *  11. Asistente del administrador
 *  12. Tareas programadas (recordatorios y vencimientos)
 *  12b. HubSpot (contactos y negocios; si falla, el bot sigue igual)
 *  13. Comandos de respaldo (ADMIN ESTADO, ADMIN AGENDA, ...)
 *  14. WhatsApp y arranque
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
 *   HUBSPOT_TOKEN           (opcional)    Clave de servicio de HubSpot (pat-...). Sin ella, los negocios se guardan igual y se envían cuando se cargue.
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

// ==================== 1. Configuración y utilidades ====================

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

// ==================== 2. Base de datos ====================

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
        await db.query(`
            CREATE TABLE IF NOT EXISTS excepciones_horario (
                id SERIAL PRIMARY KEY,
                fecha DATE NOT NULL,
                desde TEXT,
                hasta TEXT,
                tipo TEXT NOT NULL,
                creada_en TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS turnos (
                id SERIAL PRIMARY KEY,
                telefono TEXT NOT NULL,
                nombre TEXT,
                numero TEXT,
                producto TEXT,
                motivo TEXT,
                tipo TEXT NOT NULL DEFAULT 'consulta',
                inicio TIMESTAMPTZ NOT NULL,
                fin TIMESTAMPTZ NOT NULL,
                estado TEXT NOT NULL,
                evento_id TEXT,
                meet TEXT,
                asistencia_confirmada BOOLEAN DEFAULT FALSE,
                avisado_admin_en TIMESTAMPTZ,
                segundo_aviso BOOLEAN DEFAULT FALSE,
                recordatorios JSONB DEFAULT '{}'::jsonb,
                creado_en TIMESTAMPTZ DEFAULT NOW(),
                actualizado_en TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        await db.query(`CREATE INDEX IF NOT EXISTS idx_turnos_estado ON turnos (estado, inicio)`);
        await db.query(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS token TEXT`);
        await db.query(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS negativas INTEGER DEFAULT 0`);
        await db.query(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS flujo TEXT`);
        await db.query(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS reemplaza_id INTEGER`);
        await db.query(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS interes TEXT`);
        await db.query(`ALTER TABLE contactos ADD COLUMN IF NOT EXISTS es_cliente BOOLEAN DEFAULT FALSE`);
        // Cambio de horario en trámite dentro de la misma reunión: { inicio, fin, origen: 'cliente' | 'asesor', creado }.
        await db.query(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS cambio JSONB`);
        // Negocios (una consulta = un negocio) que se envían a HubSpot.
        await db.query(`
            CREATE TABLE IF NOT EXISTS negocios (
                id SERIAL PRIMARY KEY,
                telefono TEXT NOT NULL,
                titulo TEXT,
                especialidad TEXT,
                motivo TEXT,
                interes TEXT,
                etapa TEXT NOT NULL DEFAULT 'Consulta',
                cerrado BOOLEAN DEFAULT FALSE,
                historial TEXT,
                hubspot_id TEXT,
                sincronizado BOOLEAN DEFAULT FALSE,
                error TEXT,
                creado_en TIMESTAMPTZ DEFAULT NOW(),
                actualizado_en TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        await db.query(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS negocio_id INTEGER`);
        await db.query(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS resultado TEXT`);
        await db.query(`ALTER TABLE contactos ADD COLUMN IF NOT EXISTS hubspot_id TEXT`);
        await db.query(`ALTER TABLE contactos ADD COLUMN IF NOT EXISTS hubspot_sincronizado BOOLEAN DEFAULT FALSE`);
        await db.query(`ALTER TABLE contactos ADD COLUMN IF NOT EXISTS hubspot_borrado BOOLEAN DEFAULT FALSE`);
        await db.query(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS borrado_hubspot BOOLEAN DEFAULT FALSE`);
        await db.query(`
            CREATE TABLE IF NOT EXISTS presupuestos (
                id SERIAL PRIMARY KEY,
                telefono TEXT NOT NULL,
                negocio_id INTEGER,
                tramite TEXT NOT NULL,
                concepto TEXT,
                socios INTEGER,
                total_usd NUMERIC,
                a_cotizar BOOLEAN DEFAULT FALSE,
                motivos JSONB,
                sin_sede BOOLEAN DEFAULT FALSE,
                tipo_cambio NUMERIC,
                fuente_cambio TEXT,
                total_ars_manual NUMERIC,
                total_ars NUMERIC,
                estado TEXT NOT NULL DEFAULT 'borrador',
                confirmaciones INTEGER DEFAULT 0,
                enviado_en TIMESTAMPTZ,
                creado TIMESTAMPTZ DEFAULT NOW(),
                actualizado TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        await db.query(`ALTER TABLE negocios ADD COLUMN IF NOT EXISTS monto_usd NUMERIC`);
        await db.query(`ALTER TABLE presupuestos ADD COLUMN IF NOT EXISTS token_formulario TEXT`);
        await db.query(`ALTER TABLE presupuestos ADD COLUMN IF NOT EXISTS formulario_completado_en TIMESTAMPTZ`);
        await db.query(`ALTER TABLE contactos ADD COLUMN IF NOT EXISTS inscripta_en TIMESTAMPTZ`);
        await db.query(`ALTER TABLE presupuestos ADD COLUMN IF NOT EXISTS jurisdiccion TEXT`);
        await db.query(`ALTER TABLE presupuestos ADD COLUMN IF NOT EXISTS referencia_usd NUMERIC`);
        await db.query(`ALTER TABLE contactos ADD COLUMN IF NOT EXISTS resena_pedida_en TIMESTAMPTZ`);
        await db.query(`CREATE TABLE IF NOT EXISTS eventos_negocio (id SERIAL PRIMARY KEY, negocio_id INTEGER, telefono TEXT, etapa TEXT, creado TIMESTAMPTZ DEFAULT NOW())`);
        await db.query(`
            CREATE TABLE IF NOT EXISTS seguimientos (
                id SERIAL PRIMARY KEY,
                telefono TEXT NOT NULL,
                turno_id INTEGER,
                negocio_id INTEGER,
                motivo TEXT NOT NULL,
                paso INTEGER NOT NULL DEFAULT 0,
                proximo TIMESTAMPTZ NOT NULL,
                ultimo_envio TIMESTAMPTZ,
                estado TEXT NOT NULL DEFAULT 'activo',
                creado TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        await migrarTurnosV12();
        dbOk = true;
        console.log('✅ Base de datos inicializada correctamente.');
    } catch (e) {
        dbOk = false;
        console.error('❌ Error inicializando la base de datos:', e.message);
    }
}

// Versión 12: antes un cambio de horario creaba otro turno ("propuesto" o un pedido que reemplazaba a otro).
// Ahora el cambio queda dentro de la misma reunión. Los pedidos y propuestas viejos de ese tipo se descartan.
async function migrarTurnosV12() {
    const { rows } = await db.query(`SELECT valor FROM configuracion WHERE clave = 'migracion_v12'`);
    if (rows.length) return;
    const r = await db.query(`UPDATE turnos SET estado = 'descartado', actualizado_en = NOW()
        WHERE estado = 'propuesto' OR (estado = 'pendiente_admin' AND reemplaza_id IS NOT NULL)`);
    await db.query(`INSERT INTO configuracion (clave, valor) VALUES ('migracion_v12', $1) ON CONFLICT (clave) DO NOTHING`, [new Date().toISOString()]);
    if (r.rowCount) console.log(`Migración v12: ${r.rowCount} pedidos/propuestas de cambio viejos descartados.`);
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
        const { rows } = await db.query('SELECT nombre, email, numero, es_cliente FROM contactos WHERE telefono = $1', [telefono]);
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

// ==================== 3. Google Calendar ====================
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

// Lee un evento puntual (para verificar que una reunión esté realmente en el calendario).
async function obtenerEvento(id) {
    if (!id) return null;
    const r = await apiCalendar('GET', `/calendars/primary/events/${encodeURIComponent(id)}`);
    if (r.status !== 200 || !r.json || r.json.status === 'cancelled') return null;
    return r.json;
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

    const permisos = String(r.json.scope || '');
    if (!permisos.includes('https://www.googleapis.com/auth/calendar')) {
        return res.send(paginaSimple('Falta el permiso de la agenda',
            'Google conectó la cuenta pero sin acceso al calendario. Pedí otro link y, en la pantalla de permisos, marcá la casilla del calendario (o "Seleccionar todo").', false));
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

// ==================== 4. Fechas, horario de atención y feriados ====================
// Horario base: lunes a viernes de 12 a 18 hs. Cada turno bloquea 45 minutos (30 de reunión + 15 de margen);
// las reuniones de dudas bloquean 30 (15 + 15). El administrador ajusta días puntuales con excepciones.

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const HORARIO_BASE = { 1: [['12:00', '18:00']], 2: [['12:00', '18:00']], 3: [['12:00', '18:00']], 4: [['12:00', '18:00']], 5: [['12:00', '18:00']] };
const BLOQUE_MIN = { consulta: 45, dudas: 30 };
const ESPECIALIDADES = ['SAS', 'SRL', 'SA', 'Mantenimiento societario', 'Transferencia', 'Disolución y cierre', 'Asociación Civil / ONG', 'Otra consulta'];
// Temas legales que no son de sociedades: penal, accidentes y familia no se atienden; el resto lo evalúa el asesor
// (ver derivar_consulta en la sección 7).
const PASO_MIN = 45;
const ANTICIPACION_MIN = 180;       // no se ofrecen turnos con menos de 3 horas
const DIAS_A_OFRECER = 10;
const TOLERANCIA_PEGADO_MIN = 15;   // un turno a menos de 15 min de otra reunión cuenta como "pegado"
const ESTADOS_VIGENTES = ['pendiente_admin', 'confirmado']; // estados de un turno que ocupa la agenda
const AVISO_GRABACION = (process.env.AVISO_GRABACION || '').trim();

// Convierte una fecha a sus partes en hora de Buenos Aires (UTC-3, sin horario de verano).
function partesBA(fecha) {
    const d = new Date(new Date(fecha).getTime() - 3 * 60 * 60 * 1000);
    const pad = n => String(n).padStart(2, '0');
    return {
        fecha: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
        hora: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
        dow: d.getUTCDay(),
        dia: d.getUTCDate(),
        mes: d.getUTCMonth() + 1
    };
}

function desdeBA(fecha, hora) {
    return new Date(`${fecha}T${hora}:00-03:00`);
}

function sumarDiasFecha(fecha, dias) {
    const d = new Date(`${fecha}T12:00:00-03:00`);
    return partesBA(new Date(d.getTime() + dias * 86400000)).fecha;
}

function minutos(hora) {
    const [h, m] = hora.split(':').map(Number);
    return h * 60 + m;
}

function horaTexto(min) {
    return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

function normalizarHora(valor) {
    const m = String(valor || '').trim().match(/^(\d{1,2})(?::?(\d{2}))?/);
    if (!m) return null;
    const h = Number(m[1]), mi = Number(m[2] || 0);
    if (h > 23 || mi > 59) return null;
    return horaTexto(h * 60 + mi);
}

function etiquetaFecha(fecha) {
    const p = partesBA(fecha);
    return `${DIAS[p.dow]} ${String(p.dia).padStart(2, '0')}/${String(p.mes).padStart(2, '0')}`;
}

function etiquetaTurno(fecha) {
    return `${etiquetaFecha(fecha)} a las ${partesBA(fecha).hora} hs`;
}

// Une intervalos [desde, hasta] en minutos.
function unirIntervalos(lista) {
    const ord = lista.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
    const res = [];
    for (const [a, b] of ord) {
        const u = res[res.length - 1];
        if (u && a <= u[1]) u[1] = Math.max(u[1], b); else res.push([a, b]);
    }
    return res;
}

function restarIntervalo(lista, [a, b]) {
    const res = [];
    for (const [x, y] of lista) {
        if (b <= x || a >= y) { res.push([x, y]); continue; }
        if (a > x) res.push([x, a]);
        if (b < y) res.push([b, y]);
    }
    return res;
}

// ---------- Feriados (el Estudio cierra en feriados nacionales, días puente y Jueves Santo) ----------
// Fuente: API pública ArgentinaDatos (se guarda en la base para no depender de ella). Jueves y Viernes Santo se
// calculan. No se cierran los días no laborables de otras religiones.

const FERIADOS = new Map(); // 'AAAA-MM-DD' -> nombre
const URL_FERIADOS = 'https://api.argentinadatos.com/v1/feriados/';
const REGEX_OTRAS_RELIGIONES = /jud|isl[aá]m|armeni|yom|kipur|rosh|pesaj|ramad|eid|sacrificio|hegira|musulm/i;
let feriadosRevisadosEn = 0;
let feriadosAvisadosEn = 0;

function fechaPascua(anio) {
    const a = anio % 19, b = Math.floor(anio / 100), c = anio % 100, d = Math.floor(b / 4), e = b % 4;
    const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
    return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

// Feriados que siempre se pueden calcular (respaldo si la API no responde): fijos, Carnaval y Semana Santa.
function feriadosCalculados(anio) {
    const pascua = fechaPascua(anio);
    const fijos = [['01-01', 'Año Nuevo'], ['03-24', 'Día Nacional de la Memoria por la Verdad y la Justicia'],
        ['04-02', 'Día del Veterano y de los Caídos en la Guerra de Malvinas'], ['05-01', 'Día del Trabajador'],
        ['05-25', 'Día de la Revolución de Mayo'], ['06-20', 'Paso a la Inmortalidad del General Manuel Belgrano'],
        ['07-09', 'Día de la Independencia'], ['12-08', 'Inmaculada Concepción de María'], ['12-25', 'Navidad']];
    return [
        ...fijos.map(([md, nombre]) => ({ fecha: `${anio}-${md}`, nombre })),
        { fecha: sumarDiasFecha(pascua, -48), nombre: 'Carnaval' },
        { fecha: sumarDiasFecha(pascua, -47), nombre: 'Carnaval' },
        { fecha: sumarDiasFecha(pascua, -3), nombre: 'Jueves Santo' },
        { fecha: sumarDiasFecha(pascua, -2), nombre: 'Viernes Santo' }
    ];
}

async function feriadosDelAnio(anio) {
    const clave = `feriados:${anio}`;
    let guardado = null;
    try { guardado = JSON.parse(await leerConfig(clave) || 'null'); } catch (e) { guardado = null; }
    if (guardado && guardado.fuente === 'api' && Date.now() - guardado.descargado < 7 * 24 * 3600000) return guardado.lista;

    const r = await solicitudHttps('GET', URL_FERIADOS + anio, { timeout: 15000 });
    if (r.status === 200 && Array.isArray(r.json) && r.json.length) {
        const lista = r.json
            .filter(f => /^\d{4}-\d{2}-\d{2}$/.test(f.fecha) && !REGEX_OTRAS_RELIGIONES.test(f.nombre || ''))
            .map(f => ({ fecha: f.fecha, nombre: f.nombre || 'Feriado', tipo: f.tipo || null }));
        const js = sumarDiasFecha(fechaPascua(anio), -3);
        if (!lista.some(f => f.fecha === js)) lista.push({ fecha: js, nombre: 'Jueves Santo', tipo: 'religioso' });
        await guardarConfig(clave, JSON.stringify({ fuente: 'api', descargado: Date.now(), lista })).catch(() => {});
        return lista;
    }
    console.error(`No se pudieron descargar los feriados ${anio} (${r.status}). Uso ${guardado ? 'los guardados' : 'los calculados'}.`);
    return guardado?.lista || feriadosCalculados(anio);
}

async function cargarFeriados() {
    const anio = Number(partesBA(Date.now()).fecha.slice(0, 4));
    const nuevos = new Map();
    for (const a of [anio, anio + 1]) {
        let lista;
        try { lista = await feriadosDelAnio(a); } catch (e) { lista = feriadosCalculados(a); }
        for (const f of lista) if (!nuevos.has(f.fecha)) nuevos.set(f.fecha, f.nombre);
    }
    FERIADOS.clear();
    for (const [k, v] of nuevos) FERIADOS.set(k, v);
    feriadosRevisadosEn = Date.now();
    console.log(`📅 Feriados cargados: ${FERIADOS.size}`);
}

function nombreFeriado(fecha) {
    return FERIADOS.get(fecha) || null;
}

// Avisa al administrador (una sola vez por turno) si hay reuniones confirmadas o pendientes en un feriado cerrado.
async function avisarTurnosEnFeriados() {
    try {
        const { rows } = await db.query(
            `SELECT * FROM turnos WHERE estado = ANY($1) AND inicio > NOW() ORDER BY inicio`, [ESTADOS_VIGENTES]);
        for (const t of rows) {
            const fecha = partesBA(t.inicio).fecha;
            const feriado = nombreFeriado(fecha);
            if (!feriado) continue;
            const abierto = (await cargarExcepciones(fecha, fecha)).some(e => e.tipo === 'abrir');
            if (abierto) continue;
            const clave = `aviso_feriado:${t.id}`;
            if (await leerConfig(clave)) continue;
            await guardarConfig(clave, '1');
            await enviarAAdmin(`⚠️ La reunión ${descripcionTurno(t)} cae en feriado (${feriado}) y ese día el Estudio está cerrado. ` +
                '¿Querés que la mantenga, que le proponga otro horario al cliente o que la cancele?');
        }
    } catch (e) {
        console.error('Error revisando turnos en feriados:', e.message);
    }
}

// Franjas de atención de un día (en minutos), aplicando las excepciones cargadas por el administrador.
// Los feriados quedan cerrados salvo que el administrador abra un horario ese día.
function franjasDelDia(fecha, excepciones) {
    const dow = partesBA(desdeBA(fecha, '12:00')).dow;
    let franjas = nombreFeriado(fecha) ? [] : (HORARIO_BASE[dow] || []).map(([a, b]) => [minutos(a), minutos(b)]);
    for (const e of excepciones.filter(x => x.fecha === fecha && x.tipo === 'abrir')) {
        franjas.push([minutos(e.desde), minutos(e.hasta)]);
    }
    franjas = unirIntervalos(franjas);
    for (const e of excepciones.filter(x => x.fecha === fecha && x.tipo === 'bloquear')) {
        const rango = e.desde && e.hasta ? [minutos(e.desde), minutos(e.hasta)] : [0, 24 * 60];
        franjas = restarIntervalo(franjas, rango);
    }
    return franjas;
}

async function cargarExcepciones(desdeFecha, hastaFecha) {
    try {
        const { rows } = await db.query(
            `SELECT id, to_char(fecha, 'YYYY-MM-DD') AS fecha, desde, hasta, tipo FROM excepciones_horario
             WHERE fecha BETWEEN $1 AND $2 ORDER BY fecha, id`, [desdeFecha, hastaFecha]);
        return rows;
    } catch (e) {
        console.error('Error leyendo excepciones:', e.message);
        return [];
    }
}


// Fecha que puede venir con el año mal puesto ("2020-10-14", "14/10", "14/10/25"): se usa el día y el mes, y el año
// es el de la próxima vez que cae esa fecha.
function interpretarFecha(texto) {
    const m = String(texto || '').match(/(\d{4})-(\d{1,2})-(\d{1,2})|(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?/);
    if (!m) return null;
    const dia = Number(m[3] || m[4]), mes = Number(m[2] || m[5]);
    if (!(dia >= 1 && dia <= 31 && mes >= 1 && mes <= 12)) return null;
    const hoy = partesBA(Date.now()).fecha;
    let anio = Number(hoy.slice(0, 4));
    const armar = a => `${a}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
    if (armar(anio) < hoy) anio += 1;
    return armar(anio);
}

// Tabla de los próximos días con el año, para que el modelo no se equivoque de fecha.
function calendarioReferencia(dias = 14) {
    const hoy = partesBA(Date.now()).fecha;
    const lineas = [];
    for (let i = 0; i < dias; i++) {
        const f = sumarDiasFecha(hoy, i);
        lineas.push(`${f} = ${etiquetaFecha(desdeBA(f, '12:00'))}/${f.slice(0, 4)}${i === 0 ? ' (hoy)' : i === 1 ? ' (mañana)' : ''}`);
    }
    return lineas.join('\n');
}

function fechaHoyCompleta() {
    const p = partesBA(Date.now());
    return `${etiquetaFecha(new Date())}/${p.fecha.slice(0, 4)}, ${p.hora} hs`;
}

function normalizarTexto(t) {
    return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ==================== 5. Disponibilidad ====================

// Ocupado en Google Calendar entre dos fechas: lista de [inicio, fin] en ms, o null si no se pudo leer.
// Ojo: Google devuelve los ocupados recortados a la ventana consultada y unidos entre sí.
async function ocupadoGoogle(desde, hasta) {
    const r = await apiCalendar('POST', '/freeBusy', {
        timeMin: desde.toISOString(),
        timeMax: hasta.toISOString(),
        timeZone: ZONA_HORARIA,
        items: [{ id: 'primary' }]
    });
    if (r.status !== 200) return null;
    return (r.json.calendars?.primary?.busy || []).map(b => [new Date(b.start).getTime(), new Date(b.end).getTime()]);
}

// Intervalos que ocupa un turno: su horario y, si tiene un cambio en trámite, también el horario nuevo.
function intervalosTurno(t) {
    const lista = [[new Date(t.inicio).getTime(), new Date(t.fin).getTime()]];
    const c = leerCambio(t);
    if (c) lista.push([c.inicio.getTime(), c.fin.getTime()]);
    return lista;
}

// Saca de los ocupados de Google el evento de las reuniones indicadas (para poder moverlas sin chocar consigo mismas).
async function sinEventosPropios(google, ids) {
    for (const id of [].concat(ids || []).filter(Boolean)) {
        const t = await obtenerTurno(id).catch(() => null);
        if (!t || !t.evento_id || t.estado !== 'confirmado') continue;
        google = restarIntervalo(google, [new Date(t.inicio).getTime(), new Date(t.fin).getTime()]).filter(([x, y]) => y > x);
    }
    return google;
}

// Ocupado por turnos del bot (incluye los horarios de cambios en trámite), salvo los turnos excluidos.
async function ocupadoTurnos(desde, hasta, excluir = []) {
    try {
        const { rows } = await db.query(`SELECT * FROM turnos WHERE estado = ANY($1) AND fin > NOW() - INTERVAL '1 day'`, [ESTADOS_VIGENTES]);
        const a = new Date(desde).getTime(), b = new Date(hasta).getTime();
        const ex = [].concat(excluir || []);
        return rows.filter(t => !ex.includes(t.id)).flatMap(intervalosTurno).filter(([x, y]) => x < b && y > a);
    } catch (e) {
        return [];
    }
}

// ¿Está libre ese horario? Ignora los turnos indicados (por ejemplo, la propia reunión que se quiere mover).
async function horarioLibre(inicio, fin, excluir = []) {
    let google = await ocupadoGoogle(inicio, fin);
    if (google === null) return { ok: false, mensaje: 'No pude leer la agenda de Google. Revisá que esté conectada.' };
    google = await sinEventosPropios(google, excluir);
    const otros = await ocupadoTurnos(inicio, fin, excluir);
    if (!google.length && !otros.length) return { ok: true };
    return { ok: false, mensaje: await describirChoque(google, inicio, fin, excluir) };
}

// Describe con qué choca un horario ocupado.
async function describirChoque(google, desde, hasta, excluir = []) {
    const ex = [].concat(excluir || []);
    try {
        const { rows } = await db.query(`SELECT * FROM turnos WHERE estado = ANY($1) AND fin > NOW()`, [ESTADOS_VIGENTES]);
        const a = new Date(desde).getTime(), b = new Date(hasta).getTime();
        const otro = rows.find(r => !ex.includes(r.id) && intervalosTurno(r).some(([x, y]) => x < b && y > a));
        if (otro) return `choca con ${otro.estado === 'confirmado' ? 'la reunión' : 'el pedido'} de ${otro.nombre || 'otro cliente'} (${etiquetaTurno(otro.inicio)}, #${otro.id})`;
    } catch (e) { /* sin detalle */ }
    if (google?.length) return `choca con un evento de tu calendario de ${partesBA(google[0][0]).hora} a ${partesBA(google[0][1]).hora}`;
    return 'ya está ocupado';
}

// Horarios libres de los próximos días, o null si no se pudo leer la agenda.
// paso: cada cuántos minutos se generan (45 para ofrecer; 15 para validar un horario pedido por el cliente).
async function horariosLibres({ tipo = 'consulta', dias = DIAS_A_OFRECER, excluir = [], paso = PASO_MIN } = {}) {
    const ahora = Date.now();
    const hoy = partesBA(ahora).fecha;
    const ultimo = sumarDiasFecha(hoy, dias);
    const desde = new Date(ahora);
    const hasta = desdeBA(ultimo, '23:59');

    let google = await ocupadoGoogle(desde, hasta);
    if (!google) return null;
    google = await sinEventosPropios(google, excluir);
    const ocupado = [...google, ...(await ocupadoTurnos(desde, hasta, excluir))];
    const excepciones = await cargarExcepciones(hoy, ultimo);
    const duracion = BLOQUE_MIN[tipo] || 45;
    const tol = TOLERANCIA_PEGADO_MIN * 60000;
    const libres = [];

    for (let i = 0; i <= dias; i++) {
        const fecha = sumarDiasFecha(hoy, i);
        for (const [a, b] of franjasDelDia(fecha, excepciones)) {
            for (let m = a; m + duracion <= b; m += paso) {
                const inicio = desdeBA(fecha, horaTexto(m)).getTime();
                const fin = inicio + duracion * 60000;
                if (inicio < ahora + ANTICIPACION_MIN * 60000) continue;
                if (ocupado.some(([x, y]) => inicio < y && fin > x)) continue;
                const pegado = ocupado.some(([x, y]) => inicio < y + tol && fin + tol > x);
                libres.push({ inicio: new Date(inicio), fin: new Date(fin), fecha, pegado });
            }
        }
    }
    return libres;
}

// Qué horarios ofrecer: para consultas, sin quedar pegados a otra reunión y en días distintos; para dudas, los más cercanos.
function elegirOpciones(libres, tipo = 'consulta', cantidad = 3) {
    if (tipo === 'dudas') return libres.slice(0, cantidad);
    const sueltos = libres.filter(l => !l.pegado);
    const base = sueltos.length ? sueltos : libres;
    const elegidos = [];
    const diasUsados = new Set();
    for (const l of base) {
        if (elegidos.length >= cantidad) break;
        if (!diasUsados.has(l.fecha)) { elegidos.push(l); diasUsados.add(l.fecha); }
    }
    for (const l of base) {
        if (elegidos.length >= cantidad) break;
        if (!elegidos.includes(l)) elegidos.push(l);
    }
    return elegidos.sort((x, y) => x.inicio - y.inicio);
}

// Opciones cercanas a lo que pidió el cliente: ese día (lo más cerca posible de la hora) o esa hora en otros días.
function opcionesCercanas(libres, { fecha, hora }, cantidad = 3) {
    let base = libres;
    if (fecha) base = base.filter(l => l.fecha === fecha);
    if (!base.length) return [];
    if (hora) {
        const objetivo = minutos(hora);
        const dist = l => Math.abs(minutos(partesBA(l.inicio).hora) - objetivo);
        if (!fecha) base = base.filter(l => dist(l) === 0);
        base = [...base].sort((x, y) => dist(x) - dist(y) || x.inicio - y.inicio);
    }
    const elegidos = [];
    for (const l of base) {
        if (elegidos.length >= cantidad) break;
        if (elegidos.some(e => e.fecha === l.fecha && Math.abs(e.inicio - l.inicio) < 30 * 60000)) continue;
        elegidos.push(l);
    }
    return elegidos.sort((x, y) => x.inicio - y.inicio);
}

function textoOpciones(opciones) {
    return opciones.map((o, i) => `${i + 1}. ${etiquetaTurno(o.inicio)}`).join('\n');
}

function listaOpciones(opciones) {
    return opciones.map((o, i) => ({ opcion: i + 1, texto: etiquetaTurno(o.inicio) }));
}

async function resumenDisponibilidad(dias = 7) {
    const hoy = partesBA(Date.now()).fecha;
    const excepciones = await cargarExcepciones(hoy, sumarDiasFecha(hoy, dias));
    const lineas = [];
    for (let i = 0; i < dias; i++) {
        const fecha = sumarDiasFecha(hoy, i);
        const franjas = franjasDelDia(fecha, excepciones);
        const tieneCambios = excepciones.some(e => e.fecha === fecha);
        const feriado = nombreFeriado(fecha);
        const txt = franjas.length ? franjas.map(([a, b]) => `${horaTexto(a)} a ${horaTexto(b)}`).join(' y ') : 'cerrado';
        const nota = feriado ? ` (feriado: ${feriado}${franjas.length ? ', abierto por vos' : ''})` : (tieneCambios ? ' (modificado)' : '');
        lineas.push(`• ${etiquetaFecha(desdeBA(fecha, '12:00'))}: ${txt}${nota}`);
    }
    return lineas.join('\n');
}

async function agregarExcepcion(tipo, fecha, desde, hasta) {
    fecha = fecha ? interpretarFecha(fecha) : null;
    if (!fecha) return { ok: false, mensaje: 'No entendí la fecha.' };
    const d = desde ? normalizarHora(desde) : null;
    const h = hasta ? normalizarHora(hasta) : null;
    if (tipo === 'abrir' && (!d || !h)) return { ok: false, mensaje: 'Para abrir un horario necesito desde qué hora y hasta qué hora.' };
    if (d && h && minutos(h) <= minutos(d)) return { ok: false, mensaje: 'La hora de fin tiene que ser posterior a la de inicio.' };
    await db.query('INSERT INTO excepciones_horario (fecha, desde, hasta, tipo) VALUES ($1, $2, $3, $4)', [fecha, d, h, tipo]);
    const fechaTxt = etiquetaFecha(desdeBA(fecha, '12:00'));
    const rango = d && h ? ` de ${d} a ${h}` : '';
    let aviso = '';
    if (tipo === 'bloquear') {
        const inicioRango = desdeBA(fecha, d || '00:00');
        const finRango = desdeBA(fecha, h || '23:59');
        const { rows } = await db.query(
            `SELECT * FROM turnos WHERE estado = 'confirmado' AND inicio < $2 AND fin > $1`, [inicioRango, finRango]);
        if (rows.length) aviso = `\n\n⚠️ Ojo: en ese rango ya hay ${rows.length === 1 ? 'una reunión confirmada' : `${rows.length} reuniones confirmadas`}: ${rows.map(descripcionTurno).join('; ')}. No las cancelé.`;
    }
    const feriado = nombreFeriado(fecha);
    if (feriado && tipo === 'abrir') aviso += `\n\nℹ️ Ese día es feriado (${feriado}); queda abierto solo en el horario que me indicaste.`;
    return { ok: true, mensaje: `Listo, ${tipo === 'bloquear' ? 'bloqueé' : 'abrí'} el ${fechaTxt}${rango}.${aviso}` };
}

async function restablecerDia(fecha) {
    fecha = fecha ? interpretarFecha(fecha) : null;
    if (!fecha) return { ok: false, mensaje: 'No entendí la fecha.' };
    const r = await db.query('DELETE FROM excepciones_horario WHERE fecha = $1', [fecha]);
    return { ok: true, mensaje: `El ${etiquetaFecha(desdeBA(fecha, '12:00'))} volvió al horario normal${r.rowCount ? '' : ' (no tenía cambios)'}.` };
}

// ==================== 6. Turnos ====================
// Un turno es UNA reunión con un único número (#). Estados:
//   pendiente_admin   pedido del cliente esperando la confirmación del administrador
//   confirmado        reunión creada en Google Calendar con Meet
//   rechazado, cancelado, cancelado_cliente, vencido, descartado   (ya no ocupan la agenda)
// Un cambio de horario en trámite queda dentro del mismo turno, en la columna "cambio":
//   origen "cliente": el cliente pidió otro horario y espera la confirmación del administrador.
//   origen "asesor":  el administrador propuso otro horario y se espera la respuesta del cliente.

const TIPO_DURACION_TXT = { consulta: '30 minutos', dudas: '15 minutos' };

function leerCambio(t) {
    let c = t?.cambio;
    if (!c) return null;
    if (typeof c === 'string') { try { c = JSON.parse(c); } catch (e) { return null; } }
    if (!c.inicio || !c.fin) return null;
    return { ...c, inicio: new Date(c.inicio), fin: new Date(c.fin) };
}

function nuevoCambio(inicio, fin, origen) {
    return JSON.stringify({ inicio: new Date(inicio).toISOString(), fin: new Date(fin).toISOString(), origen, creado: new Date().toISOString() });
}

async function obtenerTurno(id) {
    const { rows } = await db.query('SELECT * FROM turnos WHERE id = $1', [id]);
    return rows[0] || null;
}

// Turnos vigentes del cliente: primero las reuniones confirmadas.
async function turnosActivosCliente(telefono) {
    const { rows } = await db.query(
        `SELECT * FROM turnos WHERE telefono = $1 AND estado = ANY($2) AND fin > NOW() ORDER BY (estado = 'confirmado') DESC, inicio`,
        [telefono, ESTADOS_VIGENTES]);
    return rows;
}

// Lo que espera una decisión del administrador: pedidos nuevos y cambios de horario pedidos por clientes.
async function turnosPendientesAdmin() {
    const { rows } = await db.query(
        `SELECT * FROM turnos WHERE (estado = 'pendiente_admin' AND inicio > NOW() AND (cambio IS NULL OR cambio->>'origen' <> 'asesor'))
            OR (estado = 'confirmado' AND cambio->>'origen' = 'cliente' AND inicio > NOW() - INTERVAL '1 hour')
         ORDER BY actualizado_en`);
    return rows;
}

async function actualizarTurno(id, campos) {
    const claves = Object.keys(campos);
    const sets = claves.map((k, i) => `${k} = $${i + 2}`).join(', ');
    await db.query(`UPDATE turnos SET ${sets}, actualizado_en = NOW() WHERE id = $1`, [id, ...claves.map(k => campos[k])]);
}

function descripcionTurno(t) {
    const c = leerCambio(t);
    const cambio = c ? (c.origen === 'cliente' ? ` (pide pasarla al ${etiquetaTurno(c.inicio)})` : ` (le propusiste el ${etiquetaTurno(c.inicio)}, esperando respuesta)`) : '';
    return `#${t.id} · ${t.nombre || 'Sin nombre'} · ${t.producto || 'Consulta'} · ${etiquetaTurno(t.inicio)}${t.tipo === 'dudas' ? ' (dudas de presupuesto)' : ''}${cambio}`;
}

// Corrige tratamientos repetidos ("Sr. Sr. Mazzo").
function limpiarTratamiento(texto) {
    return String(texto || '').replace(/\b(Sr|Sra|Srta)\.?\s+(?:(?:Sr|Sra|Srta)\.?\s+)+/g, '$1. ');
}

// Ningún envío por WhatsApp puede dejar al bot esperando para siempre (pasa cuando la conexión se corta a mitad de camino).
const LIMITE_WHATSAPP_MS = Number(process.env.WHATSAPP_TIMEOUT_MS) || 15000;
function conLimite(promesa, ms, que) {
    let timer;
    return Promise.race([
        promesa,
        new Promise((_, rechazar) => { timer = setTimeout(() => rechazar(new Error(`${que}: sin respuesta en ${Math.round(ms / 1000)} s`)), ms); })
    ]).finally(() => clearTimeout(timer));
}
function enviarWhatsApp(sock, jid, contenido) {
    return conLimite(Promise.resolve().then(() => sock.sendMessage(jid, contenido)), LIMITE_WHATSAPP_MS, 'WhatsApp');
}

// Mensajes que el sistema manda por su cuenta: quedan guardados en el historial del cliente.
async function enviarACliente(telefono, texto) {
    if (!socketActual) throw new Error('WhatsApp no está conectado');
    texto = limpiarTratamiento(texto);
    await enviarWhatsApp(socketActual, telefono, { text: texto });
    await guardarMensaje(telefono, 'bot', texto);
    userHistories.delete(telefono); // se recarga desde la base en el próximo mensaje
}

// anotar: el aviso queda también en la conversación del asistente admin (para que sepa de quién se habla).
async function enviarAAdmin(texto, { anotar = false } = {}) {
    if (!socketActual || !ADMIN_NUMBER) return;
    try {
        await enviarWhatsApp(socketActual, await obtenerJidAdmin(socketActual), { text: texto });
        if (anotar) anotarAvisoEnHistorialAdmin(texto);
    } catch (e) {
        console.error('Error enviando mensaje al administrador:', e.message);
    }
}

// Cómo se nombra a un contacto en los avisos: nombre y teléfono (para poder referirse a él sin confusiones).
function etiquetaContacto(c, fallback = 'Un cliente') {
    const nombre = c?.nombre && c.nombre !== 'No indicado' ? c.nombre : fallback;
    return `${nombre}${c?.numero ? ` (+${c.numero})` : ''}`;
}

function textoAvisoTurno(t, { segundo = false, email = null, esCliente = false, otras = [] } = {}) {
    const c = leerCambio(t);
    const ademas = !(c && c.origen === 'cliente') && otras.length
        ? `➕ *Reunión aparte* (otro tema): además de ${otras.map(o => `la #${o.id} del ${etiquetaTurno(o.inicio)}`).join(' y ')}, que se mantiene${otras.length > 1 ? 'n' : ''}.\n`
        : '';
    const encabezado = c && c.origen === 'cliente'
        ? `🔄 *Cambio de horario · reunión #${t.id}*\n\nAhora: ${etiquetaTurno(t.inicio)}\nPide: *${etiquetaTurno(c.inicio)}*\n`
        : `📅 *Pedido de turno #${t.id}*\n🕒 ${etiquetaTurno(t.inicio)}${t.tipo === 'dudas' ? ' · reunión de dudas (15 min)' : ''}\n${ademas}`;
    return `${segundo ? '🔔 *Segundo aviso* — sigue pendiente\n\n' : ''}${encabezado}\n` +
        `👤 ${t.nombre || 'Sin nombre'}${t.numero ? ` (+${t.numero})` : ''}${esCliente ? ' · ⭐ Cliente' : ''}${email ? ` · ✉️ ${email}` : ''}\n` +
        `📂 Especialidad: ${t.producto || 'Sin definir'}\n` +
        `📝 Motivo: ${t.motivo || 'sin detalle'}\n` +
        (t.interes ? `${{ alto: '🔥', medio: '🙂', bajo: '🤔' }[t.interes] || '•'} Interés: ${t.interes}\n` : '') +
        '\n¿Lo confirmo? Respondé *sí* o *no*, o pedime otro horario.';
}

async function otrasReunionesVigentes(t) {
    const { rows } = await db.query(`SELECT id, inicio FROM turnos WHERE telefono = $1 AND id <> $2 AND estado = ANY($3) AND fin > NOW() ORDER BY inicio`, [t.telefono, t.id, ESTADOS_VIGENTES]);
    return rows;
}

async function avisarPedidoAlAdmin(t, segundo = false) {
    const contacto = await obtenerContacto(t.telefono);
    const otras = await otrasReunionesVigentes(t);
    await enviarAAdmin(textoAvisoTurno(t, { segundo, email: contacto?.email || null, esCliente: contacto?.es_cliente, otras }), { anotar: true });
}

function textoAgendaYLink(t) {
    return (t.token ? `📅 Para agregarla a su agenda: ${PUBLIC_URL}/agenda/${t.token}\n\n` : '') +
        'El día anterior le preguntaremos si va a asistir, y 15 minutos antes de la reunión le enviaremos por aquí el link de Google Meet.';
}

// --- Pedidos del cliente ---

async function crearPedido({ telefono, inicio, tipo, producto, motivo, interes, separada = false }) {
    const contacto = await obtenerContacto(telefono);
    const fin = new Date(inicio.getTime() + (BLOQUE_MIN[tipo] || 45) * 60000);
    const { rows } = await db.query(
        `INSERT INTO turnos (telefono, nombre, numero, producto, motivo, tipo, inicio, fin, estado, avisado_admin_en, interes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pendiente_admin', NOW(), $9) RETURNING *`,
        [telefono, contacto?.nombre || null, contacto?.numero || null, producto || null, motivo || null, tipo, inicio, fin, interes || null]);
    await hsPedido(rows[0], { separada });
    await avisarPedidoAlAdmin(rows[0]);
    return rows[0];
}

// El cliente cambia el horario de un pedido que todavía no confirmaste: se actualiza el mismo pedido.
async function modificarPedido(t, inicio) {
    const fin = new Date(inicio.getTime() + (new Date(t.fin) - new Date(t.inicio)));
    await actualizarTurno(t.id, { inicio, fin, cambio: null, avisado_admin_en: new Date(), segundo_aviso: false });
    const nuevo = await obtenerTurno(t.id);
    const contacto = await obtenerContacto(t.telefono);
    await enviarAAdmin(`✏️ ${t.nombre || 'El cliente'} cambió el horario de su pedido #${t.id}: antes ${etiquetaTurno(t.inicio)}, ahora ${etiquetaTurno(inicio)}.\n\n` +
        textoAvisoTurno(nuevo, { email: contacto?.email || null, esCliente: contacto?.es_cliente }), { anotar: true });
    return nuevo;
}

// El cliente pide cambiar una reunión confirmada: queda el pedido de cambio dentro de la misma reunión.
async function pedirCambio(t, inicio) {
    const fin = new Date(inicio.getTime() + (new Date(t.fin) - new Date(t.inicio)));
    await actualizarTurno(t.id, { cambio: nuevoCambio(inicio, fin, 'cliente'), avisado_admin_en: new Date(), segundo_aviso: false });
    const nuevo = await obtenerTurno(t.id);
    await avisarPedidoAlAdmin(nuevo);
    return nuevo;
}

// --- Decisiones del administrador ---

// Confirma: un pedido (crea la reunión con Meet) o un cambio de horario en trámite (mueve la reunión).
async function confirmarTurno(id) {
    const t = await obtenerTurno(id);
    if (!t) return { ok: false, mensaje: `No existe el turno #${id}.` };
    if (t.estado === 'confirmado') {
        if (!leerCambio(t)) return { ok: false, mensaje: `La reunión #${id} ya está confirmada y no tiene ningún cambio pendiente.` };
        return aplicarCambio(t, { clienteAcepto: leerCambio(t).origen === 'cliente' });
    }
    if (t.estado !== 'pendiente_admin') return { ok: false, mensaje: `El turno #${id} está ${t.estado}, no se puede confirmar.` };
    if (new Date(t.inicio) <= new Date()) return { ok: false, mensaje: `El horario del turno #${id} ya pasó.` };
    return crearReunion(t);
}

async function crearReunion(t, { aviso = '' } = {}) {
    const libre = await horarioLibre(new Date(t.inicio), new Date(t.fin), [t.id]);
    if (!libre.ok) return { ok: false, mensaje: `No pude confirmar el turno #${t.id} (${etiquetaTurno(t.inicio)}): ${libre.mensaje}. Pedime proponerle otro horario.` };
    const evento = await crearEventoConMeet({
        titulo: `${t.tipo === 'dudas' ? 'Dudas de presupuesto' : 'Consulta'} ${t.producto || ''} – ${t.nombre || 'Cliente'}`.replace(/\s+/g, ' '),
        descripcion: `WhatsApp: ${t.numero ? '+' + t.numero : t.telefono}\nEspecialidad: ${t.producto || '-'}\nMotivo: ${t.motivo || '-'}\nTurno #${t.id} (agendado por el bot)`,
        inicio: new Date(t.inicio).toISOString(),
        fin: new Date(t.fin).toISOString()
    });
    if (!evento) return { ok: false, mensaje: 'No se pudo crear la reunión en Google Calendar.' };
    const token = t.token || require('crypto').randomBytes(16).toString('hex');
    await actualizarTurno(t.id, { estado: 'confirmado', evento_id: evento.id, meet: evento.meet, token, cambio: null });
    const nuevo = await obtenerTurno(t.id);
    await hsConfirmada(nuevo);
    await enviarACliente(t.telefono,
        `${aviso}Su reunión quedó confirmada para el ${etiquetaTurno(t.inicio)} (${TIPO_DURACION_TXT[t.tipo] || '30 minutos'}), por Google Meet, con un asesor del Estudio.\n\n` +
        textoAgendaYLink(nuevo) + (AVISO_GRABACION ? `\n\n${AVISO_GRABACION}` : ''));
    const feriado = nombreFeriado(partesBA(t.inicio).fecha);
    return { ok: true, mensaje: `Listo, confirmé el turno #${t.id} (${t.nombre || 'cliente'}, ${etiquetaTurno(t.inicio)}). Meet: ${evento.meet}` +
        (feriado ? `\n\n⚠️ Ojo: ese día es feriado (${feriado}).` : '') };
}

// Aplica el cambio de horario de una reunión confirmada (el que está en trámite, o uno indicado) y avisa al cliente
// con un solo mensaje.
async function aplicarCambio(t, { inicio = null, clienteAcepto = false } = {}) {
    const c = leerCambio(t);
    const nuevoInicio = inicio || c?.inicio;
    if (!nuevoInicio) return { ok: false, mensaje: `La reunión #${t.id} no tiene un horario nuevo para aplicar.` };
    const fin = new Date(nuevoInicio.getTime() + (new Date(t.fin) - new Date(t.inicio)));
    if (nuevoInicio <= new Date()) return { ok: false, mensaje: 'Ese horario ya pasó.' };
    if (nuevoInicio.getTime() === new Date(t.inicio).getTime()) return { ok: false, mensaje: `La reunión ya está a esa hora (${etiquetaTurno(nuevoInicio)}).` };
    const libre = await horarioLibre(nuevoInicio, fin, [t.id]);
    if (!libre.ok) return { ok: false, mensaje: `No puedo pasarla al ${etiquetaTurno(nuevoInicio)}: ${libre.mensaje}.` };
    if (t.evento_id) {
        const r = await apiCalendar('PATCH', `/calendars/primary/events/${encodeURIComponent(t.evento_id)}?sendUpdates=none`, {
            start: { dateTime: nuevoInicio.toISOString(), timeZone: ZONA_HORARIA }, end: { dateTime: fin.toISOString(), timeZone: ZONA_HORARIA }
        });
        if (r.status !== 200) return { ok: false, mensaje: `Google Calendar no aceptó el cambio (${r.status}).` };
    }
    const antes = etiquetaTurno(t.inicio);
    await actualizarTurno(t.id, { inicio: nuevoInicio, fin, cambio: null, recordatorios: '{}', flujo: null, negativas: 0 });
    const nuevo = await obtenerTurno(t.id);
    await hsNota(nuevo, `Reunión #${t.id} reprogramada: del ${antes} al ${etiquetaTurno(nuevoInicio)}`);
    const acepto = clienteAcepto || c?.origen === 'cliente';
    await enviarACliente(t.telefono,
        (acepto
            ? `Listo, su reunión con el Estudio quedó reprogramada para el ${etiquetaTurno(nuevoInicio)}, por Google Meet.\n\n`
            : `Le informamos que su reunión con el Estudio pasó al ${etiquetaTurno(nuevoInicio)}, por Google Meet. Le pedimos disculpas por el cambio: si el nuevo horario no le queda cómodo, avísenos por aquí y buscamos otro.\n\n`) +
        textoAgendaYLink(nuevo));
    await borrarConfig(`esperando_respuesta:${t.telefono}`).catch(() => {});
    const feriado = nombreFeriado(partesBA(nuevoInicio).fecha);
    return { ok: true, mensaje: `Listo, la reunión #${t.id} de ${t.nombre || 'el cliente'} pasó del ${antes} al ${etiquetaTurno(nuevoInicio)}. Ya está en Google Calendar y le avisé al cliente con un solo mensaje.` +
        (feriado ? ` ⚠️ Ojo: ese día es feriado (${feriado}).` : '') };
}

// Rechaza un pedido (y le ofrece otros horarios al cliente) o un cambio de horario (la reunión se mantiene).
async function rechazarTurno(id) {
    const t = await obtenerTurno(id);
    if (!t) return { ok: false, mensaje: `No existe el turno #${id}.` };
    const c = leerCambio(t);
    if (t.estado === 'confirmado') {
        if (!c) return { ok: false, mensaje: `La reunión #${id} no tiene ningún cambio pendiente. Si querés cancelarla, decímelo.` };
        await actualizarTurno(t.id, { cambio: null });
        await enviarACliente(t.telefono, `Disculpe, el asesor no tiene disponibilidad el ${etiquetaTurno(c.inicio)}. Su reunión del ${etiquetaTurno(t.inicio)} se mantiene. Si prefiere otro horario, indíquenos qué día y hora le queda bien.`);
        return { ok: true, mensaje: `Listo, no hice el cambio. La reunión #${t.id} sigue el ${etiquetaTurno(t.inicio)} y se lo avisé a ${t.nombre || 'el cliente'}.` };
    }
    if (t.estado !== 'pendiente_admin') return { ok: false, mensaje: `El turno #${id} está ${t.estado}.` };
    await actualizarTurno(t.id, { estado: 'rechazado', cambio: null });
    await recordarConsultaDeTurno(t);
    await hsSinReunion(t, 'Sin disponibilidad del asesor; se le ofrecieron otros horarios');
    const libres = await horariosLibres({ tipo: t.tipo });
    const opciones = libres ? elegirOpciones(libres, t.tipo).filter(o => o.inicio.getTime() !== new Date(t.inicio).getTime()) : [];
    if (opciones.length) await guardarOpcionesOfrecidas(t.telefono, opciones, t.tipo);
    await enviarACliente(t.telefono, opciones.length
        ? `Disculpe, el asesor no tiene disponibilidad el ${etiquetaTurno(t.inicio)}. Le puedo ofrecer:\n\n${textoOpciones(opciones)}\n\nIndíquenos el número de su preferencia.`
        : `Disculpe, el asesor no tiene disponibilidad el ${etiquetaTurno(t.inicio)}. En breve le propondremos un nuevo horario.`);
    return { ok: true, mensaje: `Listo, rechacé el turno #${t.id} y le ${opciones.length ? 'ofrecí otros horarios' : 'avisé que le proponemos otro horario'} a ${t.nombre || 'el cliente'}.` };
}

// El administrador propone otro horario (para un pedido o para una reunión confirmada); se aplica si el cliente acepta.
async function proponerHorario(id, fecha, hora) {
    const t = await obtenerTurno(id);
    if (!t || !ESTADOS_VIGENTES.includes(t.estado)) return { ok: false, mensaje: `El turno #${id} no está vigente.` };
    const f = interpretarFecha(fecha) || partesBA(t.inicio).fecha;
    const h = normalizarHora(hora);
    if (!h) return { ok: false, mensaje: 'No entendí la hora propuesta.' };
    const inicio = desdeBA(f, h);
    if (inicio <= new Date()) return { ok: false, mensaje: 'Ese horario ya pasó.' };
    const fin = new Date(inicio.getTime() + (new Date(t.fin) - new Date(t.inicio)));
    const libre = await horarioLibre(inicio, fin, [t.id]);
    if (!libre.ok) return { ok: false, mensaje: `El ${etiquetaTurno(inicio)} no está libre: ${libre.mensaje}.` };
    await actualizarTurno(t.id, { cambio: nuevoCambio(inicio, fin, 'asesor') });
    await enviarACliente(t.telefono, t.estado === 'confirmado'
        ? `El asesor le propone pasar su reunión del ${etiquetaTurno(t.inicio)} al ${etiquetaTurno(inicio)}, por Google Meet. ¿Le queda bien ese horario?`
        : `El asesor le propone reunirse el ${etiquetaTurno(inicio)} por Google Meet. ¿Le queda bien ese horario?`);
    const feriado = nombreFeriado(f);
    return { ok: true, mensaje: `Le propuse a ${t.nombre || 'el cliente'} el ${etiquetaTurno(inicio)} (turno #${t.id}). Si acepta, queda hecho solo.` +
        (feriado ? `\n\n⚠️ Ojo: ese día es feriado (${feriado}).` : '') };
}

// Mueve una reunión confirmada sin volver a preguntarle al cliente (por ejemplo, cuando ya aceptó).
async function moverReunion(id, { fecha, hora, cliente_acepto } = {}) {
    const t = await obtenerTurno(id);
    if (!t || t.estado !== 'confirmado') return { ok: false, mensaje: `El turno #${id} no es una reunión confirmada. Para un pedido usá confirmar o proponer otro horario.` };
    const c = leerCambio(t);
    let inicio = null;
    if (fecha || hora) {
        const f = fecha ? interpretarFecha(fecha) : partesBA(c?.inicio || t.inicio).fecha;
        const h = hora ? normalizarHora(hora) : partesBA(c?.inicio || t.inicio).hora;
        if (!f || !h) return { ok: false, mensaje: 'No entendí la fecha o la hora.' };
        inicio = desdeBA(f, h);
    }
    return aplicarCambio(t, { inicio, clienteAcepto: Boolean(cliente_acepto) });
}

// Descarta, sin avisarle al cliente, un cambio de horario en trámite (la reunión sigue igual) o un pedido.
async function descartarCambio(id) {
    const t = await obtenerTurno(id);
    if (!t) return { ok: false, mensaje: `No existe el turno #${id}.` };
    if (leerCambio(t)) {
        await actualizarTurno(t.id, { cambio: null });
        return { ok: true, mensaje: `Listo, descarté el cambio de horario sin avisarle al cliente. La reunión #${t.id} sigue el ${etiquetaTurno(t.inicio)}.` };
    }
    if (t.estado === 'pendiente_admin') {
        await actualizarTurno(t.id, { estado: 'descartado' });
        await hsSinReunion(t, 'Pedido descartado por el asesor');
        return { ok: true, mensaje: `Listo, descarté el pedido #${t.id} (${etiquetaTurno(t.inicio)}) sin avisarle al cliente.` };
    }
    return { ok: false, mensaje: `El turno #${id} no tiene nada pendiente para descartar.` };
}

async function cancelarTurno(id, { porCliente = false, silencioso = false } = {}) {
    const t = await obtenerTurno(id);
    if (!t) return { ok: false, mensaje: `No existe el turno #${id}.` };
    if (!ESTADOS_VIGENTES.includes(t.estado)) return { ok: false, mensaje: `El turno #${id} ya estaba ${t.estado}.` };
    if (t.evento_id) {
        const r = await apiCalendar('DELETE', `/calendars/primary/events/${encodeURIComponent(t.evento_id)}?sendUpdates=none`);
        if (![200, 204, 404, 410].includes(r.status)) console.error('No se pudo borrar el evento:', r.status, r.texto.slice(0, 200));
    }
    await actualizarTurno(t.id, { estado: porCliente ? 'cancelado_cliente' : 'cancelado', cambio: null });
    await recordarConsultaDeTurno(t);
    await hsSinReunion(t, porCliente ? 'El cliente canceló la reunión' : 'Reunión cancelada');
    if (!silencioso) {
        if (porCliente) await enviarAAdmin(`❌ ${t.nombre || 'Un cliente'} canceló su ${t.estado === 'confirmado' ? 'reunión' : 'pedido'} del ${etiquetaTurno(t.inicio)} (#${t.id}).`);
        else await enviarACliente(t.telefono, `Le informamos que la reunión del ${etiquetaTurno(t.inicio)} fue cancelada. Si lo desea, coordinamos un nuevo horario.`);
    }
    return { ok: true, mensaje: `Cancelé el turno #${t.id} (${t.nombre || 'cliente'}, ${etiquetaTurno(t.inicio)})${porCliente || silencioso ? '' : ' y le avisé al cliente'}.` };
}

// Alarga o acorta una reunión confirmada (en Google Calendar y en la base).
async function cambiarDuracion(id, { hasta, minutos_extra } = {}) {
    const t = await obtenerTurno(id);
    if (!t || t.estado !== 'confirmado') return { ok: false, mensaje: `El turno #${id} no es una reunión confirmada.` };
    const inicio = new Date(t.inicio), finViejo = new Date(t.fin);
    let fin = null;
    if (hasta && normalizarHora(hasta)) fin = desdeBA(partesBA(inicio).fecha, normalizarHora(hasta));
    else if (minutos_extra) fin = new Date(finViejo.getTime() + Number(minutos_extra) * 60000);
    if (!fin) return { ok: false, mensaje: 'Decime hasta qué hora o cuántos minutos le sumo.' };
    if (fin <= new Date(inicio.getTime() + 15 * 60000)) return { ok: false, mensaje: 'La reunión tiene que durar al menos 15 minutos.' };
    if (fin > finViejo) {
        const libre = await horarioLibre(finViejo, fin, [t.id]);
        if (!libre.ok) return { ok: false, mensaje: `No puedo alargarla hasta las ${partesBA(fin).hora}: ${libre.mensaje}.` };
    }
    if (t.evento_id) {
        const r = await apiCalendar('PATCH', `/calendars/primary/events/${encodeURIComponent(t.evento_id)}?sendUpdates=none`,
            { end: { dateTime: fin.toISOString(), timeZone: ZONA_HORARIA } });
        if (r.status !== 200) return { ok: false, mensaje: `Google Calendar no aceptó el cambio (${r.status}).` };
    }
    await actualizarTurno(t.id, { fin });
    // Los bloqueos que quedaron dentro de la reunión ya no hacen falta.
    const fecha = partesBA(inicio).fecha;
    const quitados = [];
    for (const e of (await cargarExcepciones(fecha, fecha)).filter(x => x.tipo === 'bloquear' && x.desde && x.hasta)) {
        if (minutos(e.desde) >= minutos(partesBA(inicio).hora) && minutos(e.hasta) <= minutos(partesBA(fin).hora)) {
            await db.query('DELETE FROM excepciones_horario WHERE id = $1', [e.id]);
            quitados.push(`${e.desde} a ${e.hasta}`);
        }
    }
    return { ok: true, mensaje: `Listo, la reunión #${t.id} de ${t.nombre || 'el cliente'} (${etiquetaTurno(inicio)}) ahora termina a las ${partesBA(fin).hora} hs. Ya está actualizada en Google Calendar.` +
        (quitados.length ? ` Saqué el bloqueo de ${quitados.join(', ')} porque ya queda dentro de la reunión.` : '') +
        ' Si querés avisarle al cliente, decime y le escribo.' };
}

// --- Respuesta del cliente a una propuesta del asesor ---

async function responderPropuesta(t, acepta) {
    const c = leerCambio(t);
    if (!c || c.origen !== 'asesor') return { error: 'No hay ningún horario propuesto pendiente.' };
    const quien = t.nombre || 'El cliente';
    if (!acepta) {
        await actualizarTurno(t.id, { cambio: null });
        if (t.estado === 'confirmado') {
            await enviarAAdmin(`ℹ️ ${quien} no aceptó pasar su reunión al ${etiquetaTurno(c.inicio)}. Sigue el ${etiquetaTurno(t.inicio)} (#${t.id}).`);
            return { ok: true, siguiente: `Decile que su reunión del ${etiquetaTurno(t.inicio)} se mantiene.` };
        }
        await actualizarTurno(t.id, { estado: 'rechazado' });
        await recordarConsultaDeTurno(t);
        await enviarAAdmin(`ℹ️ ${quien} no aceptó el horario propuesto (${etiquetaTurno(c.inicio)}) para su pedido #${t.id}. Le voy a ofrecer otros.`);
        return { ok: true, siguiente: 'Ofrecele otros horarios con consultar_horarios.' };
    }
    if (t.estado === 'confirmado') {
        const r = await aplicarCambio(t, { clienteAcepto: true });
        if (r.ok) await enviarAAdmin(`✅ ${quien} aceptó pasar su reunión al ${etiquetaTurno(c.inicio)} (#${t.id}). Ya quedó hecho.`);
        return r.ok ? { ok: true, _silencio: true } : { error: r.mensaje };
    }
    await actualizarTurno(t.id, { inicio: c.inicio, fin: c.fin, cambio: null });
    const r = await crearReunion(await obtenerTurno(t.id));
    if (r.ok) await enviarAAdmin(`✅ ${quien} aceptó el ${etiquetaTurno(c.inicio)} (#${t.id}). Quedó confirmado.`);
    return r.ok ? { ok: true, _silencio: true } : { error: r.mensaje };
}

// --- Agenda para el administrador ---

async function resumenAgenda(dias = 7) {
    const eventos = await eventosProximos(dias);
    const { rows: turnos } = await db.query(
        `SELECT * FROM turnos WHERE estado = ANY($1) AND fin > NOW() AND inicio < NOW() + ($2 || ' days')::interval ORDER BY inicio`,
        [ESTADOS_VIGENTES, String(dias)]);
    const idsGoogle = eventos ? new Set(eventos.map(e => e.id)) : null;
    const lineas = [];
    if (eventos === null) lineas.push('⚠️ No pude leer Google Calendar; muestro solo los turnos del bot.');
    const items = [];
    for (const t of turnos.filter(x => x.estado === 'confirmado')) {
        let marca = '';
        if (idsGoogle) {
            // Si no aparece en la lista, se consulta el evento puntual antes de decir que no está.
            const enGoogle = (t.evento_id && idsGoogle.has(t.evento_id)) || Boolean(await obtenerEvento(t.evento_id));
            marca = enGoogle ? ' · 📅 en Google' : ' · ⚠️ no figura en Google Calendar';
        }
        items.push({ cuando: new Date(t.inicio).getTime(), texto: `• ${descripcionTurno(t)}${t.asistencia_confirmada ? ' · confirmó asistencia ✅' : ''}${marca}` });
    }
    const delBot = new Set(turnos.map(t => t.evento_id).filter(Boolean));
    for (const e of (eventos || []).filter(e => !delBot.has(e.id))) {
        const ini = e.start.dateTime || e.start.date;
        items.push({ cuando: new Date(ini).getTime(), texto: `• ${e.start.dateTime ? etiquetaTurno(ini) : etiquetaFecha(new Date(`${e.start.date}T12:00:00-03:00`)) + ' (todo el día)'} · ${e.summary || '(sin título)'} (evento del calendario, no es un turno del bot)` });
    }
    items.sort((a, b) => a.cuando - b.cuando);
    lineas.push(items.length ? `Reuniones:\n${items.map(i => i.texto).join('\n')}` : 'No hay reuniones en los próximos días.');
    const pendientes = turnos.filter(t => t.estado === 'pendiente_admin');
    if (pendientes.length) lineas.push(`Pedidos esperando tu confirmación:\n${pendientes.map(t => `• ${descripcionTurno(t)}`).join('\n')}`);
    return lineas.join('\n\n');
}

// Busca turnos vigentes por nombre del cliente, fecha u hora.
async function buscarTurnos({ texto, fecha, hora } = {}) {
    const { rows } = await db.query(`SELECT * FROM turnos WHERE estado = ANY($1) AND fin > NOW() ORDER BY inicio`, [ESTADOS_VIGENTES]);
    const f = fecha ? interpretarFecha(fecha) : null;
    const h = hora ? normalizarHora(hora) : null;
    const palabras = normalizarTexto(texto || '').split(' ').filter(p => p.length > 2);
    return rows.filter(t => {
        const p = partesBA(t.inicio);
        if (f && p.fecha !== f) return false;
        if (h && p.hora !== h) return false;
        if (palabras.length && !palabras.some(w => normalizarTexto(`${t.nombre || ''} ${t.producto || ''}`).includes(w))) return false;
        return true;
    });
}

async function buscarContacto(texto) {
    const digitos = soloDigitos(texto || '');
    let rows;
    if (digitos.length >= 8) {
        ({ rows } = await db.query(`SELECT telefono, nombre, numero FROM contactos WHERE numero LIKE $1`, ['%' + digitos.slice(-10)]));
    } else {
        const palabras = normalizarTexto(texto || '').split(' ').filter(p => p.length > 2);
        if (!palabras.length) return { error: 'Decime el nombre o el número de la persona.' };
        ({ rows } = await db.query(`SELECT telefono, nombre, numero FROM contactos WHERE nombre IS NOT NULL`));
        rows = rows.filter(r => { const n = normalizarTexto(r.nombre); return palabras.every(w => n.includes(w)); });
    }
    if (!rows.length) return { error: `No encontré a nadie con "${texto}" entre los contactos.` };
    if (rows.length > 1) return { error: `Encontré varias personas: ${rows.map(r => `${r.nombre || 'Sin nombre'}${r.numero ? ` (+${r.numero})` : ''}`).join(', ')}. ¿Cuál es?` };
    return rows[0];
}

async function marcarCliente(texto, esCliente = true) {
    const c = await buscarContacto(texto);
    if (c.error) return { ok: false, mensaje: c.error };
    await db.query('UPDATE contactos SET es_cliente = $1 WHERE telefono = $2', [esCliente, c.telefono]);
    await hsContactoCambio(c.telefono);
    return { ok: true, mensaje: `Listo, ${c.nombre || 'el contacto'}${c.numero ? ` (+${c.numero})` : ''} quedó como ${esCliente ? '⭐ cliente' : 'prospecto'}.` };
}

// Solo para pruebas: borra todo lo que el bot sabe de un contacto para que lo trate como nuevo.
async function reiniciarContacto({ cliente }) {
    const c = await buscarContacto(cliente);
    if (c.error) return { ok: false, mensaje: c.error };
    if (ADMIN_NUMBER && c.numero && soloDigitos(c.numero).endsWith(soloDigitos(ADMIN_NUMBER).slice(-10))) return { ok: false, mensaje: 'Ese es el número del administrador: no lo reinicio.' };
    const tel = c.telefono;
    const { rows: vigentes } = await db.query(`SELECT * FROM turnos WHERE telefono = $1 AND estado = ANY($2)`, [tel, ESTADOS_VIGENTES]);
    for (const t of vigentes) {
        if (!t.evento_id) continue;
        const r = await apiCalendar('DELETE', `/calendars/primary/events/${encodeURIComponent(t.evento_id)}?sendUpdates=none`).catch(e => ({ status: 0, texto: e.message }));
        if (![200, 204, 404, 410].includes(r.status)) console.error('Reinicio: no se pudo borrar el evento', t.evento_id, r.status);
    }
    const { rowCount: reuniones } = await db.query('DELETE FROM turnos WHERE telefono = $1', [tel]);
    await db.query('DELETE FROM mensajes WHERE telefono = $1', [tel]);
    await db.query('DELETE FROM negocios WHERE telefono = $1', [tel]);
    await db.query('DELETE FROM seguimientos WHERE telefono = $1', [tel]);
    await db.query('DELETE FROM eventos_negocio WHERE telefono = $1', [tel]);
    await db.query('DELETE FROM presupuestos WHERE telefono = $1', [tel]);
    await db.query(`DELETE FROM configuracion WHERE right(clave, length($1) + 1) = ':' || $1`, [tel]);
    await db.query('DELETE FROM contactos WHERE telefono = $1', [tel]);
    userHistories.delete(tel);
    mensajesCliente.delete(tel);
    avisosFalla.delete(tel);
    for (const k of [...contactosAvisados]) if (String(k).includes(tel)) contactosAvisados.delete(k);
    return { ok: true, mensaje: `Listo, ${etiquetaContacto(c)} quedó como contacto nuevo: borré ${reuniones} reunión(es)${vigentes.some(t => t.evento_id) ? ' (y sus eventos en Google Calendar)' : ''}, la conversación y su ficha. La próxima vez que escriba, el bot lo trata como si fuera la primera vez.${HUBSPOT_TOKEN ? ' En HubSpot no se borra nada: si querés, borrá ese contacto y sus negocios a mano allá.' : ''}` };
}

// El administrador agenda una reunión nueva para un cliente (aparte de las que ya tenga).
// consultar_cliente: en lugar de confirmarla, se la propone y se confirma sola si acepta.
async function agendarReunion({ cliente, turno_id, fecha, hora, tema, consultar_cliente }) {
    let telefono = null, nombre = null, numero = null;
    if (turno_id) {
        const t = await obtenerTurno(turno_id);
        if (t) { telefono = t.telefono; nombre = t.nombre; numero = t.numero; }
    }
    if (!telefono && cliente) {
        const c = await buscarContacto(cliente);
        if (c.error) return { ok: false, mensaje: c.error };
        telefono = c.telefono; nombre = c.nombre; numero = c.numero;
    }
    if (!telefono) return { ok: false, mensaje: 'Decime para qué cliente es la reunión.' };
    const f = interpretarFecha(fecha), h = normalizarHora(hora);
    if (!f || !h) return { ok: false, mensaje: 'Decime el día y la hora de la reunión.' };
    const inicio = desdeBA(f, h);
    if (inicio <= new Date()) return { ok: false, mensaje: 'Ese horario ya pasó.' };
    const fin = new Date(inicio.getTime() + BLOQUE_MIN.consulta * 60000);
    const libre = await horarioLibre(inicio, fin, []);
    if (!libre.ok) return { ok: false, mensaje: `El ${etiquetaTurno(inicio)} no está libre: ${libre.mensaje}. Decime otro horario.` };
    const evaluacion = await leerConfigJSON(`evaluacion:${telefono}`, 30);
    const motivo = String(tema || '').trim() || (evaluacion ? `${evaluacion.area}: ${evaluacion.resumen}` : 'Reunión agendada por el asesor');
    const producto = evaluacion?.area ? `Otro tema: ${evaluacion.area}` : (ESPECIALIDADES.includes(tema) ? tema : 'Otra consulta');
    const { rows: [t] } = await db.query(
        `INSERT INTO turnos (telefono, nombre, numero, producto, motivo, tipo, inicio, fin, estado, cambio)
         VALUES ($1, $2, $3, $4, $5, 'consulta', $6, $7, 'pendiente_admin', $8) RETURNING *`,
        [telefono, nombre, numero, producto, motivo, inicio, fin, consultar_cliente ? nuevoCambio(inicio, fin, 'asesor') : null]);
    await borrarConfig(`evaluacion:${telefono}`).catch(() => {});
    await hsPedido(t, { separada: true });
    if (consultar_cliente) {
        await enviarACliente(telefono, `El asesor le propone una reunión por Google Meet el ${etiquetaTurno(inicio)} para tratar su consulta${evaluacion ? ` sobre ${evaluacion.area}` : ''}. ¿Le queda bien ese horario?`);
        return { ok: true, mensaje: `Le propuse a ${nombre || 'el cliente'} una reunión el ${etiquetaTurno(inicio)} (turno #${t.id}). Si acepta, se confirma sola.` };
    }
    const r = await crearReunion(t);
    return r.ok ? { ok: true, mensaje: `Listo, agendé una reunión nueva para ${nombre || 'el cliente'} el ${etiquetaTurno(inicio)} (turno #${t.id}) y le avisé. Meet creado.` } : r;
}

// Consultas "para evaluar" que esperan la decisión del asesor.
async function consultasEnEvaluacion() {
    const { rows } = await db.query(`SELECT clave, valor FROM configuracion WHERE clave LIKE 'evaluacion:%'`);
    const lista = [];
    for (const r of rows) {
        try {
            const v = JSON.parse(r.valor);
            if (Date.now() - v.creada > 7 * 24 * 3600000) continue;
            const telefono = r.clave.slice('evaluacion:'.length);
            lista.push({ telefono, ...v, contacto: await obtenerContacto(telefono) });
        } catch (e) { /* ignorar */ }
    }
    return lista;
}

async function contactoDeConsulta({ cliente, telefono }) {
    if (telefono) return { telefono, ...(await obtenerContacto(telefono) || {}) };
    const c = await buscarContacto(cliente);
    return c;
}

// El asesor acepta una consulta que no es de sociedades: se le ofrecen horarios al cliente (y el pedido vuelve al asesor
// para que lo confirme, como siempre).
async function aceptarConsulta({ cliente, telefono }) {
    const c = await contactoDeConsulta({ cliente, telefono });
    if (c.error) return { ok: false, mensaje: c.error };
    const evaluacion = await leerConfigJSON(`evaluacion:${c.telefono}`, 30);
    if (!evaluacion) return { ok: false, mensaje: `${etiquetaContacto(c, 'Ese contacto')} no tiene ninguna consulta en evaluación.` };
    const libres = await horariosLibres({ tipo: 'consulta' });
    const opciones = libres ? elegirOpciones(libres, 'consulta') : [];
    if (!opciones.length) return { ok: false, mensaje: 'No encontré horarios libres en los próximos días. Decime un día y hora y se la agendo.' };
    await guardarDatosConsulta(c.telefono, { especialidad: 'Otra consulta', motivo: `${evaluacion.area}: ${evaluacion.resumen}`, completo: true, proposito: 'nueva' });
    await guardarOpcionesOfrecidas(c.telefono, opciones, 'consulta');
    await borrarConfig(`evaluacion:${c.telefono}`).catch(() => {});
    await enviarACliente(c.telefono, `Le comentamos que un asesor del Estudio puede ayudarle con su consulta sobre ${evaluacion.area}. Le propongo coordinar una reunión sin cargo por Google Meet:\n\n${textoOpciones(opciones)}\n\nIndíquenos el número de su preferencia.`);
    return { ok: true, mensaje: `Listo, le avisé a ${etiquetaContacto(c, 'el cliente')} que tomamos su consulta sobre ${evaluacion.area} y le ofrecí 3 horarios. Cuando elija, te llega el pedido para confirmar.` };
}

// El asesor decide no tomar una consulta que no es de sociedades.
async function rechazarConsulta({ cliente, telefono }) {
    const c = await contactoDeConsulta({ cliente, telefono });
    if (c.error) return { ok: false, mensaje: c.error };
    const evaluacion = await leerConfigJSON(`evaluacion:${c.telefono}`, 30);
    await borrarConfig(`evaluacion:${c.telefono}`).catch(() => {});
    try {
        const g = (await negociosAbiertos(c.telefono)).find(x => String(x.titulo || '').startsWith('Otro tema'));
        if (g) await actualizarNegocio(g.id, { etapa: 'Perdido' }, 'El Estudio no toma la consulta');
    } catch (e) { console.error('HubSpot (no atendida):', e.message); }
    await enviarACliente(c.telefono, `Le agradecemos mucho su consulta${evaluacion ? ` sobre ${evaluacion.area}` : ''}. Lamentablemente no es un tema que el Estudio pueda tomar en este momento; le recomendamos consultar con un profesional especializado. Quedamos a su disposición para cualquier consulta de sociedades.`);
    return { ok: true, mensaje: `Listo, le avisé a ${etiquetaContacto(c, 'el cliente')} con amabilidad que no tomamos su consulta.` };
}

// El administrador le escribe a un cliente; su primera respuesta (y lo que mande en los 5 minutos siguientes) se le reenvía.
async function escribirAlCliente({ turno_id, cliente, mensaje, propuesta_fecha, propuesta_hora }) {
    if (!String(mensaje || '').trim()) return { ok: false, mensaje: 'Falta el texto del mensaje.' };
    let telefono = null, nombre = null;
    if (turno_id) {
        const t = await obtenerTurno(turno_id);
        if (t) { telefono = t.telefono; nombre = t.nombre; }
    }
    if (!telefono && cliente) {
        const c = await buscarContacto(cliente);
        if (c.error) return { ok: false, mensaje: c.error };
        telefono = c.telefono; nombre = c.nombre;
    }
    if (!telefono) return { ok: false, mensaje: 'No sé a qué cliente escribirle. Decime el nombre o el número de turno.' };
    if (propuesta_hora) {
        // Antes de ofrecerle un horario, se revisa que esté libre.
        const t = turno_id ? await obtenerTurno(turno_id) : null;
        const f = interpretarFecha(propuesta_fecha) || (t && partesBA(t.inicio).fecha);
        const h = normalizarHora(propuesta_hora);
        if (!f || !h) return { ok: false, mensaje: 'No entendí el día o la hora que le querés ofrecer.' };
        const ini = desdeBA(f, h);
        const dur = t ? new Date(t.fin) - new Date(t.inicio) : (BLOQUE_MIN.consulta * 60000);
        const libre = await horarioLibre(ini, new Date(ini.getTime() + dur), t ? [t.id] : []);
        if (!libre.ok) return { ok: false, mensaje: `No le mandé nada: el ${etiquetaTurno(ini)} no está libre (${libre.mensaje}). Decime otro horario.` };
    }
    await enviarACliente(telefono, String(mensaje).trim());
    await guardarConfig(`esperando_respuesta:${telefono}`, JSON.stringify({
        creada: Date.now(), mensaje: String(mensaje).trim(), turno_id: turno_id || null, respondidoEn: null,
        propuesta: propuesta_hora ? { fecha: propuesta_fecha || null, hora: propuesta_hora } : null
    }));
    return { ok: true, mensaje: `Listo, le escribí a ${nombre || 'el cliente'}. Cuando responda te paso lo que diga.` };
}

async function leerConfigJSON(clave, dias = 7) {
    try {
        const v = JSON.parse(await leerConfig(clave) || 'null');
        if (!v || Date.now() - v.creada > dias * 24 * 3600000) return null;
        return v;
    } catch (e) {
        return null;
    }
}

async function leerEsperandoRespuesta(telefono) {
    try {
        const v = JSON.parse(await leerConfig(`esperando_respuesta:${telefono}`) || 'null');
        if (!v || Date.now() - v.creada > 24 * 3600000) return null;
        return v;
    } catch (e) {
        return null;
    }
}

// ==================== 6b. Cotizador (presupuestos) ====================
// v27: primero la reunión. El bot junta los datos (tipo, jurisdicción, socios…) y prioriza agendar la reunión virtual.
// Después de la reunión ("asistió") te pregunta si se cotiza; el total lo ponés vos y se envía con 3 confirmaciones.

const TARIFAS = {
    SAS: { base_usd: 550, socios_incluidos: 2, socio_adicional_usd: 15 }
};
const CORREO_DATOS_SAS = 'sasdatos@jaimeirigoyen.com.ar';
const VIGENCIA_CONFIRMACION_MIN = 30;

const formatoPesos = n => '$ ' + Math.round(n).toLocaleString('es-AR');
const formatoUSD = n => 'USD ' + Number(n).toLocaleString('es-AR', { maximumFractionDigits: 2 });

// Dólar oficial (vendedor) del día. Se cachea por día; si no hay servicio, devuelve null y se le pide al administrador.
let dolarDelDia = null; // { fecha, venta, fuente }
async function obtenerDolarOficial() {
    const hoy = partesBA(new Date()).fecha;
    if (dolarDelDia?.fecha === hoy) return dolarDelDia;
    const fuentes = [
        ['dolarapi.com', 'https://dolarapi.com/v1/dolares/oficial', j => j?.venta],
        ['argentinadatos.com', 'https://api.argentinadatos.com/v1/cotizaciones/dolares/oficial', j => Array.isArray(j) ? j[j.length - 1]?.venta : j?.venta]
    ];
    for (const [fuente, url, leer] of fuentes) {
        const r = await solicitudHttps('GET', url, { timeout: 10000 }).catch(() => null);
        const venta = r?.status === 200 ? Number(leer(r.json)) : NaN;
        if (venta > 0) { dolarDelDia = { fecha: hoy, venta, fuente }; return dolarDelDia; }
    }
    return null;
}

// Datos de la cotización: tipo de trámite y jurisdicción.
const TIPOS_CONSTITUCION = { SAS: 'SAS', SRL: 'SRL', SA: 'SA', 'ASOCIACION CIVIL': 'Asociación Civil', 'ASOCIACION CIVIL / ONG': 'Asociación Civil', ONG: 'Asociación Civil', FUNDACION: 'Fundación' };
function normalizarTramite(t) {
    const n = normalizarTexto(t).toUpperCase();
    if (!n) return 'SAS';
    if (/^S\s?A\s?S$|ACCIONES SIMPLIFICADA/.test(n)) return 'SAS';
    if (/^S\s?R\s?L$|RESPONSABILIDAD LIMITADA/.test(n)) return 'SRL';
    if (/^S\s?A$|SOCIEDAD ANONIMA/.test(n)) return 'SA';
    if (/ASOCIACION|ONG/.test(n)) return 'Asociación Civil';
    if (/FUNDACION/.test(n)) return 'Fundación';
    return String(t).trim();
}
const esConstitucion = t => ['SAS', 'SRL', 'SA', 'Asociación Civil', 'Fundación'].includes(t);
function tipoJurisdiccion(j) {
    const n = normalizarTexto(j);
    if (!n) return null;
    if (/\b(caba|capital federal|capital|ciudad autonoma|ciudad de buenos aires)\b/.test(n)) return 'CABA';
    if (/\b(provincia de buenos aires|pba|prov de buenos aires|provincia de bs as|gran buenos aires|conurbano)\b/.test(n) || n === 'buenos aires' || n === 'provincia') return 'PBA';
    return 'OTRA';
}
function textoJurisdiccion(j) {
    const t = tipoJurisdiccion(j);
    if (t === 'CABA') return 'la Ciudad Autónoma de Buenos Aires';
    if (t === 'PBA') return 'la Provincia de Buenos Aires';
    return t ? String(j).trim() : null;
}
function conceptoPresupuesto({ tramite, jurisdiccion, socios }) {
    const tr = normalizarTramite(tramite);
    const tj = tipoJurisdiccion(jurisdiccion);
    const lugar = tj === 'CABA' ? ' en CABA' : tj === 'PBA' ? ' en Provincia de Buenos Aires' : tj ? ` en ${String(jurisdiccion).trim()}` : '';
    const n = Math.floor(Number(socios) || 0);
    const soc = n > 0 && ['SAS', 'SRL', 'SA'].includes(tr) ? ` · ${n} socio${n === 1 ? '' : 's'}` : '';
    return (esConstitucion(tr) ? `Constitución de ${tr}` : tr) + lugar + soc;
}

// Arma la base del presupuesto: el total SIEMPRE lo pone el asesor. Para una SAS estándar en CABA muestra la referencia de la tabla.
function calcularPresupuesto({ tramite = 'SAS', socios, jurisdiccion, caba, socio_empresa = false, extranjero_sin_cuit = false }) {
    const tr = normalizarTramite(tramite);
    const jur = jurisdiccion || (caba === true ? 'CABA' : caba === false ? 'fuera de CABA' : null);
    const enCABA = tipoJurisdiccion(jur) === 'CABA';
    const n = Math.floor(Number(socios) || 0) || null;
    const motivos = [];
    if (jur && !enCABA) motivos.push('la sociedad no es en CABA');
    if (socio_empresa) motivos.push('hay un socio que es una empresa');
    if (extranjero_sin_cuit) motivos.push('hay un socio extranjero sin CUIT/CUIL argentino');
    const t = TARIFAS[tr];
    const estandar = t && enCABA && n && !socio_empresa && !extranjero_sin_cuit;
    const referencia_usd = estandar ? t.base_usd + Math.max(0, n - t.socios_incluidos) * t.socio_adicional_usd : null;
    return { tramite: tr, jurisdiccion: jur, concepto: conceptoPresupuesto({ tramite: tr, jurisdiccion: jur, socios: n }), socios: n, total_usd: null, a_cotizar: true, motivos, referencia_usd };
}

// Datos que el bot va juntando en la conversación (para que el asesor cotice después de la reunión).
async function leerDatosCotizacion(telefono) { return leerConfigJSON(`datos_cotizacion:${telefono}`, 180); }
async function anotarDatosCotizacion(telefono, nuevos) {
    const prev = (await leerDatosCotizacion(telefono)) || {};
    const d = { ...prev };
    for (const k of ['tramite', 'jurisdiccion', 'socios', 'socio_empresa', 'extranjero_sin_cuit', 'sede', 'detalle']) {
        if (nuevos[k] !== undefined && nuevos[k] !== null && nuevos[k] !== '') d[k] = nuevos[k];
    }
    if (d.tramite) d.tramite = normalizarTramite(d.tramite);
    if (nuevos.sede_caba !== undefined && d.sede === undefined) d.sede = nuevos.sede_caba;
    if (nuevos.caba !== undefined && !d.jurisdiccion) d.jurisdiccion = nuevos.caba ? 'CABA' : null;
    d.creada = Date.now();
    await guardarConfig(`datos_cotizacion:${telefono}`, JSON.stringify(d));
    return d;
}
function resumenDatosCotizacion(d) {
    if (!d) return null;
    const sn = v => v === true ? 'sí' : v === false ? 'no' : null;
    const partes = [
        d.tramite && `Trámite: ${d.tramite}`,
        d.jurisdiccion && `Jurisdicción: ${textoJurisdiccion(d.jurisdiccion) ? textoJurisdiccion(d.jurisdiccion).replace(/^la /, '') : d.jurisdiccion}`,
        d.socios && `Socios: ${d.socios}`,
        sn(d.socio_empresa) && `Socio empresa: ${sn(d.socio_empresa)}`,
        sn(d.extranjero_sin_cuit) && `Extranjero sin CUIT/CUIL: ${sn(d.extranjero_sin_cuit)}`,
        sn(d.sede) && `Dirección para la sede: ${sn(d.sede)}`,
        d.detalle && `Detalle: ${d.detalle}`
    ].filter(Boolean);
    return partes.length ? partes.join(' · ') : null;
}

function totalPesos(p) {
    if (p.total_ars_manual) return Number(p.total_ars_manual);
    if (p.total_usd == null || !p.tipo_cambio) return null;
    return Math.round(Number(p.total_usd) * Number(p.tipo_cambio));
}

function textoPresupuestoCliente(p, c) {
    const nombre = c?.nombre && !/^no (indicado|detectado)$/i.test(c.nombre) ? c.nombre : null;
    const ars = totalPesos(p);
    const tr = normalizarTramite(p.tramite || 'SAS');
    const jurTxt = textoJurisdiccion(p.jurisdiccion);
    const constitucion = esConstitucion(tr);
    const sasCABA = tr === 'SAS' && tipoJurisdiccion(p.jurisdiccion || 'CABA') === 'CABA';
    const que = constitucion ? `la *constitución de su ${tr}${jurTxt ? ` en ${jurTxt}` : ''}*` : `*${p.concepto}*`;
    const incluye = sasCABA
        ? '*Incluye:* redacción del instrumento constitutivo, inscripción en IGJ con tasa y publicación en el Boletín Oficial, Formulario 185, alta de CUIT en ARCA y apertura de libros. Presentación en un máximo de 48 horas hábiles.'
        : constitucion
            ? '*Incluye:* honorarios del Estudio, redacción del instrumento constitutivo y gestión de la inscripción ante el organismo que corresponde, según lo conversado con el asesor. Presentación en un máximo de 48 horas hábiles desde que recibimos la documentación completa.'
            : '*Incluye:* honorarios del Estudio y la gestión del trámite, según lo conversado con el asesor.';
    return `📄 *Presupuesto · Estudio Jaime Irigoyen*\n\n${nombre ? `Estimado/a ${nombre}:` : 'Estimado/a:'}\n\n` +
        `Le enviamos el presupuesto para ${que}:\n\n` +
        `*${p.concepto}: ${ars != null ? formatoPesos(ars) : '(a cotizar)'}* (IVA incluido)\n_Válido por 15 días._\n\n` +
        incluye + '\n\n' +
        (constitucion ? '*No incluye:* certificación de firmas ante escribano (el asesor le puede recomendar uno) ni domicilio legal.\n\n' : '') +
        '*Forma de pago:* transferencia del total antes de la presentación.\n\n' +
        'Ante cualquier duda, con gusto coordinamos una breve reunión por Google Meet.';
}

const TEXTO_FORMULARIO_SAS =
    '📋 *Datos para la constitución de su SAS*\n\n' +
    `Para avanzar, complete estos datos y envíelos por correo a *${CORREO_DATOS_SAS}* (asunto: "Datos SAS" y su nombre):\n\n` +
    '*1. La sociedad*\n' +
    '• Denominación: 3 opciones en orden de preferencia (sin "SAS")\n' +
    '• Actividad principal: a qué se va a dedicar\n' +
    '• Sede social en CABA: calle, número, piso, depto. y código postal\n' +
    '• Capital: ¿capital mínimo legal o un monto mayor? (si es mayor, indique el monto)\n' +
    '• Fecha de cierre del ejercicio (por ejemplo, 31/12)\n' +
    '• Correo electrónico de la sociedad\n\n' +
    '*2. Cada socio*\n' +
    '• Nombre y apellido, DNI y CUIT/CUIL\n' +
    '• Nacionalidad, fecha de nacimiento, profesión y estado civil\n' +
    '• Domicilio real completo\n' +
    '• Porcentaje de participación\n\n' +
    '*3. Administradores*\n' +
    '• Titular o titulares (de 1 a 5) y un suplente (obligatorio); pueden ser socios o no, con los mismos datos que los socios\n' +
    '• Para cada uno: si es o no Persona Expuesta Políticamente\n' +
    '• Cuál de los titulares será el Administrador de Relaciones ante ARCA\n\n' +
    '*4. Beneficiario final*\n' +
    '• Quienes tengan el 10% o más del capital, con su porcentaje\n\n' +
    '*Importante*\n' +
    '• Verifique que sus datos personales estén correctos en ARCA: el sistema de IGJ los toma de ahí.\n' +
    '• La firma del instrumento se certifica ante escribano; el asesor le puede recomendar uno.\n\n' +
    'Ante cualquier duda, respóndanos por acá.';

async function presupuestoEnConfirmacion() {
    const { rows } = await db.query(`SELECT * FROM presupuestos WHERE estado = 'confirmando' AND actualizado > NOW() - ($1 || ' minutes')::interval ORDER BY actualizado DESC LIMIT 1`, [String(VIGENCIA_CONFIRMACION_MIN)]);
    return rows[0] || null;
}

async function actualizarPresupuesto(id, campos) {
    const claves = Object.keys(campos);
    await db.query(`UPDATE presupuestos SET ${claves.map((k, i) => `${k} = $${i + 2}`).join(', ')}, actualizado = NOW() WHERE id = $1`, [id, ...claves.map(k => campos[k])]);
    const { rows: [p] } = await db.query('SELECT * FROM presupuestos WHERE id = $1', [id]);
    return p;
}

// Mensaje de la confirmación 1/3 (con el presupuesto completo).
async function textoConfirmacion1(p) {
    const c = await obtenerContacto(p.telefono);
    const ars = totalPesos(p);
    const lineas = [`💰 *Presupuesto para ${etiquetaContacto(c || {}, 'el cliente')}* · ${normalizarTramite(p.tramite || 'SAS')}`, ''];
    if (p.a_cotizar) lineas.push(`⚠️ A cotizar por vos: ${(p.motivos || []).join('; ')}.`);
    if (p.sin_sede) lineas.push('⚠️ El cliente no tiene dirección en CABA para la sede (se lo avisé).');
    if (p.referencia_usd && p.total_usd == null && !p.total_ars_manual) lineas.push(`📊 Referencia de la tabla: ${formatoUSD(p.referencia_usd)}. Si te sirve, respondé *total ${Number(p.referencia_usd)} dólares*.`);
    if (p.a_cotizar || p.sin_sede || p.referencia_usd) lineas.push('');
    lineas.push('— Así le llegaría —', '', textoPresupuestoCliente(p, c), '');
    if (p.total_ars_manual) lineas.push(`Total fijado por vos: ${formatoPesos(p.total_ars_manual)}.`);
    else if (p.tipo_cambio && p.total_usd != null) lineas.push(`💵 ${p.total_usd != null ? `${formatoUSD(p.total_usd)} × ` : ''}dólar oficial BNA vendedor ${formatoPesos(p.tipo_cambio)}${p.fuente_cambio ? ` (fuente: ${p.fuente_cambio})` : ''}. Si no coincide con el del BNA, decime *dólar 1460* y lo recalculo.`);
    else if (!p.tipo_cambio) lineas.push('💵 No pude obtener el dólar oficial de hoy: si cotizás en dólares, decime el valor, por ejemplo *dólar 1460*.');
    if (ars == null) {
        lineas.push('', p.total_usd == null ? 'Falta el total (lo ponés vos): decime *total $1.200.000* o *total 900 dólares*.' : 'Falta el dólar del día para calcular el total en pesos.');
    } else {
        lineas.push('', '*(1/3)* ¿Lo envío? Respondé *sí* o *no*. También podés cambiarlo: *total 600 dólares*, *total $900.000* o *dólar 1460*.');
    }
    return lineas.join('\n');
}

async function iniciarConfirmacion(p) {
    await db.query(`UPDATE presupuestos SET estado = 'borrador' WHERE estado = 'confirmando' AND id <> $1`, [p.id]);
    p = await actualizarPresupuesto(p.id, { estado: 'confirmando', confirmaciones: 0 });
    return textoConfirmacion1(p);
}

// Crea el presupuesto (siempre lo pide el administrador) con los datos que juntó el bot. El total lo pone el administrador.
async function crearPresupuesto(telefono, args) {
    const calc = calcularPresupuesto(args);
    const dolar = await obtenerDolarOficial();
    const esp = ESPECIALIDADES.find(e => normalizarTexto(e) === normalizarTexto(calc.tramite)) || (calc.tramite === 'Asociación Civil' ? 'Asociación Civil / ONG' : null);
    let negocio = null;
    try {
        const abiertos = await negociosAbiertos(telefono);
        negocio = (esp && abiertos.find(g => g.especialidad === esp)) || abiertos[0] || await abrirNegocio(telefono, { especialidad: esp, motivo: calc.concepto });
        if (negocio && esp && !negocio.especialidad) negocio = await actualizarNegocio(negocio.id, { especialidad: esp, titulo: esp }, `Trámite: ${calc.concepto}`);
    } catch (e) { /* sigue */ }
    const { rows: [p] } = await db.query(
        `INSERT INTO presupuestos (telefono, negocio_id, tramite, concepto, socios, total_usd, a_cotizar, motivos, sin_sede, tipo_cambio, fuente_cambio, jurisdiccion, referencia_usd)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
        [telefono, negocio?.id || null, calc.tramite, calc.concepto, calc.socios, calc.total_usd, calc.a_cotizar, JSON.stringify(calc.motivos),
            calc.tramite === 'SAS' && tipoJurisdiccion(calc.jurisdiccion) === 'CABA' && (args.sede === false || args.sede_caba === false),
            dolar?.venta || null, dolar?.fuente || null, calc.jurisdiccion, calc.referencia_usd]);
    return p;
}

// Después de "asistió": te pregunta si hay que cotizar, con los datos que juntó el bot.
async function ofrecerCotizacion(telefono, negocio) {
    const { rows: [ya] } = await db.query(`SELECT 1 FROM presupuestos WHERE telefono = $1 AND estado IN ('confirmando', 'enviado', 'pagado') AND creado > NOW() - INTERVAL '30 days' LIMIT 1`, [telefono]);
    if (ya) return null;
    const c = await obtenerContacto(telefono);
    const datos = await leerDatosCotizacion(telefono);
    await guardarConfig('cotizar_pendiente', JSON.stringify({ telefono, negocio_id: negocio?.id || null, creada: Date.now(), turno: contadorAdmin }));
    return `💼 ¿Le cotizamos a ${etiquetaContacto(c || {}, 'esta persona')}?\n` +
        (resumenDatosCotizacion(datos) ? `Datos que juntó el bot: ${resumenDatosCotizacion(datos)}` : 'El bot no llegó a juntar datos: si los tenés, decímelos al armarlo (por ejemplo "cotizale a X una SRL en Provincia con 3 socios").') +
        `\nRespondé *sí* (te pido el total) o *no*. Si preferís verlo más tarde: *cotizale a ${c?.nombre || 'X'}*.`;
}

async function respuestaCotizar(texto) {
    const pend = await leerConfigJSON('cotizar_pendiente', 1);
    if (!pend || Date.now() - pend.creada > 24 * 3600000) return null;
    // Vale solo como respuesta inmediata a la pregunta: si escribiste otra cosa en el medio, se usa "cotizale a X".
    if (pend.turno != null && contadorAdmin !== pend.turno + 1) { await borrarConfig('cotizar_pendiente'); return null; }
    const t = normalizarTexto(texto);
    const c = await obtenerContacto(pend.telefono);
    if (/^(no|nop|no gracias|no cotizar|no le cotices|no hace falta|todavia no|por ahora no|no por ahora)$/.test(t)) {
        await borrarConfig('cotizar_pendiente');
        if (pend.negocio_id) await actualizarNegocio(pend.negocio_id, {}, 'Después de la reunión: el asesor decidió no cotizar por ahora').catch(() => {});
        return `Listo, no le cotizo. Si más adelante querés hacerlo, decime *cotizale a ${c?.nombre || 'X'}*.`;
    }
    if (!/^(si|sii|ok|dale|cotiza|cotizale|si cotiza|si cotizale|si cotizar|si hay que cotizar|si dale|si por favor|cotizamos|si cotizamos)$/.test(t)) return null;
    await borrarConfig('cotizar_pendiente');
    const datos = (await leerDatosCotizacion(pend.telefono)) || {};
    const p = await crearPresupuesto(pend.telefono, datos);
    return iniciarConfirmacion(p);
}

// El administrador responde mientras hay un presupuesto en confirmación. Devuelve el texto de respuesta o null.
async function respuestaPresupuesto(texto) {
    const p = await presupuestoEnConfirmacion();
    if (!p) return null;
    const t = normalizarTexto(texto);
    const mDolar = String(texto).match(/d[oó]lar(?:\s+(?:oficial|hoy|bna|a|en|de))*\s*\$?\s*([\d.]+(?:,\d+)?)/i);
    const mTotal = String(texto).match(/total\s*(?:en\s*)?(usd|u\$s|d[oó]lares)?\s*\$?\s*([\d.]+(?:,\d+)?)\s*(usd|u\$s|d[oó]lares)?/i);
    const numero = s => Number(String(s).replace(/\./g, '').replace(',', '.'));
    if (mDolar && !mTotal) {
        const nuevo = await actualizarPresupuesto(p.id, { tipo_cambio: numero(mDolar[1]), fuente_cambio: 'indicado por vos', total_ars_manual: null, confirmaciones: 0 });
        return textoConfirmacion1(nuevo);
    }
    if (mTotal) {
        const enUsd = Boolean(mTotal[1] || mTotal[3]);
        const valor = numero(mTotal[2]);
        const nuevo = await actualizarPresupuesto(p.id, enUsd ? { total_usd: valor, total_ars_manual: null, confirmaciones: 0 } : { total_ars_manual: valor, confirmaciones: 0 });
        return textoConfirmacion1(nuevo);
    }
    // Respuestas estrictas: un "no vino" o "sí, asistió" no se confunde con la confirmación del presupuesto.
    if (/^(no|nop|no gracias|no lo envies|no lo mandes|no enviar|cancela|cancelar|cancelalo)$/.test(t)) {
        await actualizarPresupuesto(p.id, { estado: 'cancelado' });
        return 'Listo, no envío el presupuesto. 👍';
    }
    if (!/^(si|sii|ok|okey|dale|confirmo|confirmado|enviar|envialo|mandalo|si enviar|si envialo|si confirmo|de acuerdo|correcto|si correcto)$/.test(t)) return null; // cambió de tema: queda en espera
    if (totalPesos(p) == null) return 'Antes de enviarlo necesito el total: decime *total 900 dólares* o *total $1.200.000*' + (p.tipo_cambio ? '.' : ', o el dólar del día (*dólar 1460*).');
    const c = await obtenerContacto(p.telefono);
    const quien = etiquetaContacto(c || {}, 'el cliente');
    const n = (p.confirmaciones || 0) + 1;
    if (n === 1) { await actualizarPresupuesto(p.id, { confirmaciones: 1 }); return '*(2/3)* ¿Revisaste los montos y el detalle? ¿Confirmo?'; }
    if (n === 2) { await actualizarPresupuesto(p.id, { confirmaciones: 2 }); return `*(3/3)* Última confirmación: se envía a ${quien} el presupuesto «${p.concepto}» por *${formatoPesos(totalPesos(p))}*. ¿Enviar ahora?`; }
    // Tercer "sí": se envía.
    try {
        await enviarACliente(p.telefono, textoPresupuestoCliente(p, c));
    } catch (e) {
        return `No pude enviarlo por WhatsApp (${e.message}). Sigue pendiente: probá de nuevo con "mandale el presupuesto a ${c?.nombre || 'la persona'}".`;
    }
    await actualizarPresupuesto(p.id, { estado: 'enviado', confirmaciones: 3, enviado_en: new Date(), total_ars: totalPesos(p) });
    if (p.negocio_id) {
        await actualizarNegocio(p.negocio_id, { etapa: 'Propuesta enviada', monto_usd: p.total_usd || null }, `Presupuesto enviado: ${p.concepto} · ${formatoPesos(totalPesos(p))}${p.total_usd ? ` (${formatoUSD(p.total_usd)})` : ''}`).catch(() => {});
    }
    await db.query(`UPDATE seguimientos SET estado = 'cerrado' WHERE telefono = $1 AND estado = 'activo'`, [p.telefono]).catch(() => {});
    return `✅ Presupuesto enviado a ${quien}. El negocio pasó a *Propuesta enviada*. Cuando pague, decime "${c?.nombre || 'X'} pagó" y le mando el formulario de datos.`;
}

// "Retomar" un presupuesto que quedó en espera.
async function retomarPresupuesto({ cliente }) {
    const c = await buscarContacto(cliente);
    if (c.error) return { ok: false, mensaje: c.error };
    const { rows: [p] } = await db.query(`SELECT * FROM presupuestos WHERE telefono = $1 AND estado IN ('borrador', 'confirmando') ORDER BY id DESC LIMIT 1`, [c.telefono]);
    if (!p) return { ok: false, mensaje: `${etiquetaContacto(c)} no tiene ningún presupuesto en espera.` };
    await enviarAAdmin(await iniciarConfirmacion(p), { anotar: true });
    return { ok: true, mensaje: 'Te mostré el presupuesto en el mensaje anterior. Para enviarlo hacen falta 3 confirmaciones: respondé "sí" (1/3).' };
}

async function armarPresupuestoAdmin(args) {
    const c = await buscarContacto(args.cliente);
    if (c.error) return { ok: false, mensaje: c.error };
    const guardados = (await leerDatosCotizacion(c.telefono)) || {};
    const datos = await anotarDatosCotizacion(c.telefono, args);
    const p = await crearPresupuesto(c.telefono, { ...guardados, ...datos });
    await borrarConfig('cotizar_pendiente');
    await enviarAAdmin(await iniciarConfirmacion(p), { anotar: true });
    return { ok: true, mensaje: 'Te mostré el presupuesto en el mensaje anterior. Para enviarlo hacen falta 3 confirmaciones: respondé "sí" (1/3).' };
}

// El cliente pagó: negocio Ganado, pasa a cliente y le llega el formulario de datos.
async function registrarPago({ cliente }) {
    const c = await buscarContacto(cliente);
    if (c.error) return { ok: false, mensaje: c.error };
    const { rows: [p] } = await db.query(`SELECT * FROM presupuestos WHERE telefono = $1 AND estado = 'enviado' ORDER BY id DESC LIMIT 1`, [c.telefono]);
    if (!p) return { ok: false, mensaje: `No encuentro ningún presupuesto enviado a ${etiquetaContacto(c)}. Si igual contrató, decime "${c.nombre || 'X'} contrató".` };
    const esSAS = normalizarTramite(p.tramite || 'SAS') === 'SAS';
    const link = esSAS ? await linkFormularioSAS(p, c) : null;
    if (!esSAS) {
        await enviarACliente(c.telefono, 'Muchas gracias por su confianza. Recibimos la confirmación del pago. 🙌\n\nEl asesor le indica por este medio los próximos pasos y la documentación necesaria para avanzar con ' + (esConstitucion(normalizarTramite(p.tramite)) ? `la constitución de su ${normalizarTramite(p.tramite)}.` : 'el trámite.'));
    } else await enviarACliente(c.telefono, link
        ? 'Muchas gracias por su confianza. Recibimos la confirmación del pago. 🙌\n\n' +
          `Para iniciar la constitución de su SAS, complete este formulario con los datos de la sociedad, los socios y los administradores:\n👉 ${link}\n\n` +
          'Le lleva unos 10 minutos. Al terminar le llega una copia por correo y el asesor recibe la información para comenzar.\n\n' +
          'Recuerde que la firma del instrumento se certifica ante escribano; el asesor le puede recomendar uno.'
        : 'Muchas gracias por su confianza. Recibimos la confirmación del pago. 🙌\n\n' + TEXTO_FORMULARIO_SAS);
    if (!esSAS) {
        await actualizarPresupuesto(p.id, { estado: 'pagado' });
        if (p.negocio_id) await actualizarNegocio(p.negocio_id, { etapa: 'Ganado' }, `Pagó el presupuesto (${formatoPesos(p.total_ars || totalPesos(p))})`).catch(() => {});
        await db.query('UPDATE contactos SET es_cliente = TRUE, hubspot_sincronizado = FALSE WHERE telefono = $1', [c.telefono]);
        return { ok: true, mensaje: `Listo: ${etiquetaContacto(c)} quedó como ⭐ cliente y el negocio pasó a *Ganado*. Como es ${p.concepto} (no SAS), no le mandé el formulario de SAS: le dije que el asesor le indica los próximos pasos.` };
    }
    await actualizarPresupuesto(p.id, { estado: 'pagado' });
    if (p.negocio_id) {
        await actualizarNegocio(p.negocio_id, { etapa: 'Ganado' }, `Pagó el presupuesto (${formatoPesos(p.total_ars || totalPesos(p))})`).catch(() => {});
    }
    await db.query('UPDATE contactos SET es_cliente = TRUE, hubspot_sincronizado = FALSE WHERE telefono = $1', [c.telefono]);
    return { ok: true, mensaje: `Listo: ${etiquetaContacto(c)} quedó como ⭐ cliente, el negocio pasó a *Ganado* y le mandé el formulario de datos${link ? ' (Google Forms). Cuando lo complete te aviso. Cuando salga la inscripción, decime "' + (c.nombre || 'X') + ' inscripta".' : ` para que lo envíe a ${CORREO_DATOS_SAS}. (Tip: cargá el formulario online con "formulario sas: …").`}` };
}


// Primero la reunión: lo que se le dice al cliente cuando pide (o el modelo promete) un presupuesto.
async function textoReunionPrimero(telefono) {
    const vig = await turnosActivosCliente(telefono).catch(() => []);
    if (vig.length) return `El presupuesto lo arma el asesor a medida, con lo que conversen en la reunión que ya tiene agendada (${etiquetaTurno(vig[0].inicio)}).`;
    return 'Cada presupuesto se arma a medida, después de una breve reunión virtual sin cargo con el asesor (30 minutos por Google Meet), donde vemos los detalles de su caso. ¿Le ofrezco algunos horarios?';
}
// ¿Ya hay una cotización en marcha para esta persona (después de la reunión)?
async function cotizacionEnCurso(telefono) {
    const { rows: [p] } = await db.query(`SELECT 1 FROM presupuestos WHERE telefono = $1 AND estado IN ('borrador', 'confirmando', 'enviado') AND creado > NOW() - INTERVAL '30 days' LIMIT 1`, [telefono]).catch(() => ({ rows: [] }));
    if (p) return true;
    const pend = await leerConfigJSON('cotizar_pendiente', 1).catch(() => null);
    return Boolean(pend && pend.telefono === telefono);
}

// Respuestas del modelo que no pueden salir así.
const REGEX_NO_HACEMOS = /\bno\s+(realizamos|hacemos|trabajamos|atendemos|gestionamos|tramitamos|ofrecemos|podemos\s+(realizar|hacer|tramitar|gestionar))\b[^.?!]{0,90}\b(provincia|jurisdicci|interior|tr[aá]mites?|constituci|sociedad|srl|sas|s\.?a\.?\b)/i;
const EXCEPCIONES_NO_HACEMOS = /ingresos brutos|agip|arba|domicilio|escriban|penal|familia|accidente|laboral|divorcio/i;
const REGEX_PROMETE_PRESUPUESTO = /(prepar(ar[áa]|a|amos)|envi(ar[áa]|a|amos)|mand(ar[áa]|a|amos)|arm(ar[áa]|a|amos)|har[áa] llegar)[^.?!]{0,50}presupuesto|presupuesto[^.?!]{0,60}(se lo (envi|mand)|le (llegar|envi|mand))/i;

// --- Sociedad inscripta y pedido de reseña en Google ---
const RESENAS_URL_INICIAL = 'https://g.page/r/CSAa5VOT97H3EBM/review';

function textoPedidoResena(link) {
    return '¡Felicitaciones, su sociedad ya está inscripta! 🎉 Fue un gusto acompañarlo en el trámite.\n\n' +
        `Si quedó conforme con nuestro trabajo, nos ayudaría mucho que nos deje su opinión en Google:\n👉 ${link}\n\n¡Muchas gracias!`;
}

async function registrarInscripcion({ cliente }) {
    const c = await buscarContacto(cliente);
    if (c.error) return { ok: false, mensaje: c.error };
    const quien = etiquetaContacto(c);
    await db.query('UPDATE contactos SET inscripta_en = COALESCE(inscripta_en, NOW()), es_cliente = TRUE, hubspot_sincronizado = FALSE WHERE telefono = $1', [c.telefono]);
    const { rows: [p] } = await db.query(`SELECT * FROM presupuestos WHERE telefono = $1 AND negocio_id IS NOT NULL ORDER BY id DESC LIMIT 1`, [c.telefono]);
    if (p?.negocio_id) await actualizarNegocio(p.negocio_id, { etapa: 'Ganado' }, 'Sociedad inscripta').catch(() => {});
    const { rows: [f] } = await db.query('SELECT resena_pedida_en FROM contactos WHERE telefono = $1', [c.telefono]);
    if (f?.resena_pedida_en) return { ok: true, mensaje: `✅ Anoté que la sociedad de ${quien} quedó inscripta. La reseña ya se la pedí el ${formatoFecha(new Date(f.resena_pedida_en))}, así que no se la vuelvo a pedir.` };
    // Un "no le escribas más" viejo (de los seguimientos) solo cuenta si después no contrató: igual te avisa y pregunta.
    const { rows: [det] } = await db.query(`SELECT s.creado FROM seguimientos s WHERE s.telefono = $1 AND s.estado = 'detenido'
        AND NOT EXISTS (SELECT 1 FROM presupuestos p WHERE p.telefono = s.telefono AND p.estado = 'pagado' AND p.actualizado > s.creado)
        ORDER BY s.creado DESC LIMIT 1`, [c.telefono]).catch(() => ({ rows: [] }));
    await guardarConfig('resena_pendiente', JSON.stringify({ telefono: c.telefono, creada: Date.now() }));
    return { ok: true, mensaje: `✅ Anoté que la sociedad de ${quien} quedó inscripta (negocio en *Ganado*).\n\n` +
        (det ? `⚠️ Ojo: a esta persona me habías dicho que no le escriba más (seguimientos). ¿Igual le pido una reseña en Google? Respondé *sí* o *no*.`
            : '⭐ ¿Le pido una reseña en Google? Respondé *sí* o *no*.') };
}

let resenasEnviadas = 0; // para detectar si el asistente dice que pidió una reseña sin haberlo hecho

async function enviarPedidoResena(telefono) {
    const link = (await leerConfig('resenas_url')) || RESENAS_URL_INICIAL;
    await enviarACliente(telefono, textoPedidoResena(link));
    resenasEnviadas++;
    await db.query('UPDATE contactos SET resena_pedida_en = NOW() WHERE telefono = $1', [telefono]);
    const { rows: [p] } = await db.query(`SELECT negocio_id FROM presupuestos WHERE telefono = $1 AND negocio_id IS NOT NULL ORDER BY id DESC LIMIT 1`, [telefono]);
    if (p?.negocio_id) await actualizarNegocio(p.negocio_id, {}, 'Se le pidió una reseña en Google').catch(() => {});
}

// "pedile la reseña a X": pedido explícito del administrador (se manda directo, una sola vez por cliente).
async function pedirResena({ cliente }) {
    const c = await buscarContacto(cliente);
    if (c.error) return { ok: false, mensaje: c.error };
    const { rows: [f] } = await db.query('SELECT resena_pedida_en FROM contactos WHERE telefono = $1', [c.telefono]);
    if (f?.resena_pedida_en) return { ok: true, mensaje: `A ${etiquetaContacto(c)} ya le pedí la reseña el ${formatoFecha(new Date(f.resena_pedida_en))}. No se la vuelvo a pedir.` };
    try { await enviarPedidoResena(c.telefono); } catch (e) { return { ok: false, mensaje: `No pude enviarle el mensaje por WhatsApp (${e.message}).` }; }
    await borrarConfig('resena_pendiente');
    return { ok: true, mensaje: `⭐ Listo, le pedí la reseña a ${etiquetaContacto(c)}. No se la vuelvo a pedir.` };
}

async function respuestaResena(texto) {
    const pend = await leerConfigJSON('resena_pendiente', 1);
    if (!pend || Date.now() - pend.creada > 2 * 3600000) return null;
    const t = normalizarTexto(texto);
    if (/^(no|no gracias|todavia no|despues|no le pidas|no se la pidas|cancelar)$/.test(t)) {
        await borrarConfig('resena_pendiente');
        return 'Listo, no le pido la reseña. 👍';
    }
    if (!/^(si|sii|ok|dale|pedisela|pedile|pediselo|si pedisela|si pedile|si pediselo|si dale|si igual|igual si|pedile igual|si pedile igual|enviar|mandale|mandasela|confirmo)$/.test(t)) return null;
    const c = await obtenerContacto(pend.telefono);
    try {
        await enviarPedidoResena(pend.telefono);
    } catch (e) {
        return `No pude enviarle el mensaje por WhatsApp (${e.message}). Probá de nuevo respondiendo *sí*.`;
    }
    await borrarConfig('resena_pendiente');
    return `⭐ Listo, le pedí la reseña a ${etiquetaContacto(c || {}, 'el cliente')}. No se la vuelvo a pedir.`;
}

// --- Formulario de datos (Google Forms) y datos bancarios ---

// El link del formulario lo carga el administrador: "formulario sas: https://docs.google.com/forms/...".
// El script de Google lo deja con REFERENCIA y NOMBRE de ejemplo, que acá se reemplazan por los del cliente.
async function linkFormularioSAS(p, c) {
    const base = await leerConfig('formulario_sas_url');
    if (!base) return null;
    let token = p.token_formulario;
    if (!token) {
        token = require('crypto').randomBytes(8).toString('hex');
        await db.query('UPDATE presupuestos SET token_formulario = $2 WHERE id = $1', [p.id, token]);
    }
    const nombre = c?.nombre && !/^no (indicado|detectado)$/i.test(c.nombre) ? c.nombre : '';
    return base.replace('REFERENCIA', encodeURIComponent(token)).replace('NOMBRE', encodeURIComponent(nombre));
}

// El script del formulario avisa acá cuando el cliente lo completó.
async function formularioCompletado(token) {
    const { rows: [p] } = await db.query('SELECT * FROM presupuestos WHERE token_formulario = $1', [String(token || '')]);
    if (!p) return false;
    if (p.formulario_completado_en) return true;
    await db.query('UPDATE presupuestos SET formulario_completado_en = NOW() WHERE id = $1', [p.id]);
    const c = await obtenerContacto(p.telefono);
    await enviarAAdmin(`📋 ${etiquetaContacto(c || {}, 'El cliente')} completó el formulario de datos de la SAS. Los datos llegaron a ${CORREO_DATOS_SAS}.`, { anotar: true });
    await enviarACliente(p.telefono, '¡Muchas gracias! Recibimos sus datos. El asesor los revisa y le avisa por este medio cómo seguimos con la constitución de su SAS.').catch(() => {});
    if (p.negocio_id) await actualizarNegocio(p.negocio_id, {}, 'Completó el formulario de datos de la SAS').catch(() => {});
    return true;
}

// Reconoce CBU / CVU / alias (también escritos "C.B.U.").
const REGEX_DATOS_BANCO = /(^|[^a-z])(c\.?\s?b\.?\s?u|c\.?\s?v\.?\s?u|alias)(\.|[^a-z]|$)/i;

// Datos bancarios: el cliente los pide y el administrador confirma cuáles se envían.
async function pedirDatosBancarios(telefono) {
    const c = await obtenerContacto(telefono);
    const datos = await leerConfig('datos_bancarios');
    const { rows: [p] } = await db.query(`SELECT * FROM presupuestos WHERE telefono = $1 AND estado = 'enviado' ORDER BY id DESC LIMIT 1`, [telefono]);
    await guardarConfig('banco_pendiente', JSON.stringify({ telefono, presupuesto_id: p?.id || null, creada: Date.now() }));
    await enviarAAdmin(`💳 ${etiquetaContacto(c || {}, 'Un cliente')} pide los datos para transferir${p ? ` (presupuesto ${p.concepto}: ${formatoPesos(p.total_ars || totalPesos(p))})` : ''}.\n\n` +
        (datos ? `¿Le envío estos?\n\n${datos}\n\nRespondé *sí*, *no*, o pasame otros datos (con CBU, CVU o alias) y le mando esos.`
            : 'Todavía no tengo datos bancarios cargados. Pasame los datos (con CBU, CVU o alias) y se los envío. Para guardarlos para la próxima: *datos bancarios: …*'), { anotar: true });
}

async function respuestaDatosBancarios(texto) {
    const pend = await leerConfigJSON('banco_pendiente', 1);
    if (!pend || Date.now() - pend.creada > 2 * 3600000) return null;
    const t = normalizarTexto(texto);
    let datos = null;
    if (/^(si|sii|ok|dale|enviar|envialos|mandalos|si enviar|si envialos|confirmo|correcto)$/.test(t)) {
        datos = await leerConfig('datos_bancarios');
        if (!datos) return 'No tengo datos bancarios cargados: pasame los datos (con CBU, CVU o alias) y se los envío.';
    } else if (/^(no|cancelar|cancela|no le envies|no le mandes)$/.test(t)) {
        await borrarConfig('banco_pendiente');
        return 'Listo, no le envío los datos bancarios. 👍';
    } else if (REGEX_DATOS_BANCO.test(texto)) {
        datos = String(texto).trim();
    } else return null;
    const c = await obtenerContacto(pend.telefono);
    let monto = '';
    if (pend.presupuesto_id) {
        const { rows: [p] } = await db.query('SELECT * FROM presupuestos WHERE id = $1', [pend.presupuesto_id]);
        if (p) monto = ` (total ${formatoPesos(p.total_ars || totalPesos(p))})`;
    }
    try {
        await enviarACliente(pend.telefono, `Le enviamos los datos para la transferencia${monto}:\n\n${datos}\n\nUna vez realizada, envíenos el comprobante por este medio. ¡Muchas gracias!`);
    } catch (e) {
        return `No pude enviarlos por WhatsApp (${e.message}). Probá de nuevo respondiendo *sí*.`;
    }
    await borrarConfig('banco_pendiente');
    return `✅ Le envié los datos bancarios a ${etiquetaContacto(c || {}, 'el cliente')}. Cuando mande el comprobante te lo reenvío.`;
}

// Comandos que el administrador escribe tal cual (se guardan sin pasar por la IA).
async function comandoConfiguracionAdmin(texto) {
    const mForm = String(texto).match(/^\s*formulario\s+sas\s*:\s*(https?:\/\/\S+)/i);
    if (mForm) {
        const url = mForm[1];
        if (!/docs\.google\.com\/forms|forms\.gle/.test(url)) return 'Ese link no parece de Google Forms. Pasame el que te dio el script ("formulario sas: https://docs.google.com/forms/...").';
        await guardarConfig('formulario_sas_url', url);
        return url.includes('REFERENCIA')
            ? '✅ Guardé el formulario de la SAS. Cuando un cliente pague, le mando el link con su nombre y su código ya cargados.'
            : '✅ Guardé el formulario. Ojo: ese link no tiene el código de referencia precargado, así que no voy a poder avisarte quién lo completó. Usá el link que muestra el script (el que tiene REFERENCIA).';
    }
    // "datos bancarios: …", también "cambiar/actualizar/nuevos datos bancarios", en negrita, sin dos puntos o con los datos abajo.
    const limpio = String(texto).replace(/[*_~]/g, '').trim();
    const mBanco = limpio.match(/^(?:(?:por favor\s+)?(?:cambi[aá]r?|actualiz[aá]r?|modific[aá]r?|carg[aá]r?|guard[aá]r?|reemplaz[aá]r?|nuevos?|estos son los)\s+(?:los\s+|mis\s+|nuestros\s+)?(?:nuevos\s+)?)?datos\s+(?:bancarios|de\s+la\s+cuenta|para\s+transferir)(?:\s+(?:nuevos|son|del estudio))?\s*(?:[:=\-–]|\s(?=\S))?\s*([\s\S]*)$/i);
    if (mBanco && !/^\s*(ver|mostrar|cuales son)\b/i.test(limpio)) {
        const datos = mBanco[1].trim();
        if (!datos || /^\??$/.test(datos)) {
            if (/^datos/i.test(limpio)) {
                const g = await leerConfig('datos_bancarios');
                return g ? `💳 Datos bancarios guardados:\n\n${g}` : 'Todavía no hay datos bancarios cargados. Mandá: *datos bancarios: Banco … · Titular … · CUIT … · CBU … · Alias …*';
            }
            return 'Pasame los datos nuevos en el mismo mensaje, por ejemplo:\n*datos bancarios: Banco … · Titular … · CUIT … · CBU … · Alias …*';
        }
        if (!REGEX_DATOS_BANCO.test(datos)) return 'Para guardarlos necesito al menos el CBU, el CVU o el alias.';
        await guardarConfig('datos_bancarios', datos);
        return `✅ Guardé estos datos bancarios:\n\n${datos}\n\nAntes de mandárselos a un cliente siempre te pregunto si son estos u otros.`;
    }
    if (/^\s*(ver|mostrar|cuales son|cu[aá]les son)\s+(los\s+)?datos\s+bancarios\s*\??\s*$/i.test(limpio)) {
        const datos = await leerConfig('datos_bancarios');
        return datos ? `💳 Datos bancarios guardados:\n\n${datos}` : 'Todavía no hay datos bancarios cargados. Mandá: *datos bancarios: Banco … · Titular … · CUIT … · CBU … · Alias …*';
    }
    // "reseñas: https://g.page/r/…/review"
    const mResena = limpio.match(/^\s*(?:link\s+de\s+)?rese[nñ]as?\s*:\s*(https?:\/\/\S+)/i);
    if (mResena) {
        if (!/g\.page|google\.[a-z.]+\/|goo\.gl|maps\.app/i.test(mResena[1])) return 'Ese link no parece de Google. Usá el de "Pedir opiniones" del Perfil de Empresa (https://g.page/r/…/review).';
        await guardarConfig('resenas_url', mResena[1]);
        return '✅ Guardé el link de reseñas. Cuando me digas que la sociedad de un cliente quedó inscripta, te pregunto si le pido la reseña.';
    }
    // "pedile la reseña a X"
    const mPedir = normalizarTexto(limpio).match(/^(?:si\s+)?(?:pedile|pedi|pedirle|mandale|enviale|solicitale)\s+(?:la\s+|una\s+)?(?:resena|opinion)(?:\s+en\s+google)?\s+a\s+(.+)$/);
    if (mPedir) return (await pedirResena({ cliente: mPedir[1] })).mensaje;
    // "Pablo inscripta", "la SAS de Pablo quedó inscripta"
    const nt = normalizarTexto(limpio);
    const mInsc = nt.match(/^(?:ya\s+)?(?:(?:la\s+)?(?:sas|srl|sa|sociedad)\s+de\s+)?(.+?)\s+(?:ya\s+)?(?:(?:esta|quedo|salio|se)\s+)?(?:inscript[ao]s?|inscribio)$/);
    if (mInsc && !limpio.includes('?')) {
        const nombre = mInsc[1].replace(/^(la|el)\s+de\s+/, '').trim();
        if (nombre && nombre.split(' ').length <= 4 && !/^(quedo|esta|salio|se|ya|la|el|sociedad|sas|srl|sa|ya esta)$/.test(nombre))
            return (await registrarInscripcion({ cliente: nombre })).mensaje;
    }
    return null;
}

// El cliente manda un archivo o foto (posible comprobante) con un presupuesto enviado: te lo reenvía.
async function procesarArchivoCliente(sock, msg, sender) {
    const m = msg.message || {};
    const archivo = m.imageMessage || m.documentMessage || m.documentWithCaptionMessage?.message?.documentMessage;
    if (!archivo) return false;
    const { rows: [p] } = await db.query(`SELECT * FROM presupuestos WHERE telefono = $1 AND estado = 'enviado' ORDER BY id DESC LIMIT 1`, [sender]);
    if (!p) return false;
    const c = await obtenerContacto(sender);
    const jid = await obtenerJidAdmin(sock);
    await enviarWhatsApp(sock, jid, { forward: msg }).catch(e => console.error('Reenvío de comprobante:', e.message));
    await enviarAAdmin(`📎 ${etiquetaContacto(c || {}, 'El cliente')} envió un archivo (posible comprobante de la transferencia, presupuesto ${formatoPesos(p.total_ars || totalPesos(p))}). Te lo reenvié arriba. Si está todo bien, decime "${c?.nombre || 'X'} pagó".`, { anotar: true });
    await enviarACliente(sender, 'Muchas gracias. Recibimos el archivo: el asesor verifica la transferencia y le confirma a la brevedad.').catch(() => {});
    await guardarMensaje(sender, 'cliente', '[Envió un archivo: posible comprobante de pago]', numeroCliente(msg));
    return true;
}

// ==================== 7. Bot de clientes ====================

// --- Reglas del administrador (instrucciones permanentes que se suman a las del bot) ---

let globalAdminRules = []; // [{ id, regla }]

async function cargarReglas() {
    try {
        const { rows } = await db.query('SELECT id, regla FROM reglas_admin ORDER BY id ASC');
        globalAdminRules = rows;
        console.log(`Reglas de administrador cargadas: ${rows.length}`);
    } catch (e) {
        console.error('Error cargando reglas:', e.message);
    }
}

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
        '6. PRECIOS: NUNCA escribas precios, montos, rangos ni estimaciones, aunque insistan. ' +
        'PRIMERO LA REUNIÓN: el Estudio arma cada presupuesto a medida DESPUÉS de una reunión virtual sin cargo (30 minutos por Google Meet) con el asesor. Si pide precio o presupuesto (SAS, SRL, SA, Asociación Civil u otro trámite), explicale eso con amabilidad y priorizá agendar la reunión (consultar_horarios). ' +
        'Mientras tanto, sin convertirlo en un interrogatorio, juntá de a una pregunta los datos para la cotización (salteá lo que ya dijo): tipo de trámite, jurisdicción (CABA, Provincia de Buenos Aires u otra provincia), cuántos socios, si alguno es una empresa, si alguno es extranjero sin CUIT/CUIL argentino y si tiene dirección para la sede; guardalos con anotar_datos_cotizacion. ' +
        'Si insiste en saber el precio sin reunión, explicale que sin conocer su caso no podemos cotizar con precisión y volvé a ofrecerle la reunión. NUNCA digas que le vamos a mandar un presupuesto: eso lo decide el asesor después de la reunión. ' +
        'Si pide los datos para transferir o pagar, usá pedir_datos_bancarios (nunca escribas un CBU o alias). Si dice que ya pagó, pedile que envíe el comprobante por acá. ' +
        'Si pregunta por el mantenimiento o las actas después de constituir, decile que el Estudio ofrece tarifas especiales para la confección de actas, que cotiza el asesor.\n' +
        '6b. JURISDICCIÓN: el Estudio trabaja en TODO el país: CABA (IGJ), Provincia de Buenos Aires (DPPJ) y las demás provincias, con gestión digital. NUNCA digas que el Estudio no hace trámites en alguna provincia o jurisdicción. Lo único que no hace son altas en Ingresos Brutos (AGIP/ARBA) y no ofrece domicilio legal.\n' +
        '7. Sé conciso: máximo 2 a 4 oraciones breves. Estás respondiendo por WhatsApp. Hacé UNA pregunta por mensaje.\n' +
        '8. Servicios del Estudio: constitución de sociedades, mantenimiento societario (balances, asambleas ordinarias y extraordinarias, cambio de autoridades y gerencias), transferencias y procesos de disolución y cierre para SAS, SRL, SA, Asociaciones Civiles y ONGs.\n' +
        'PERFIL COMERCIAL (muy importante): tu objetivo es que el cliente quiera trabajar con el Estudio y llegue a la reunión interesado, sin presionarlo.\n' +
        '- Antes de ofrecer una reunión ENTENDÉ SU NECESIDAD: preguntá qué necesita (constituir una SAS, SRL o SA, mantenimiento, transferencia, cierre, Asociación Civil/ONG), y de a una pregunta por vez datos clave como cuántos socios son, a qué se va a dedicar la empresa y para cuándo lo necesita. Con 2 o 3 respuestas alcanza; no lo conviertas en un interrogatorio.\n' +
        '- Respondé las dudas GENERALES y básicas (por ejemplo, qué es una SAS, diferencias generales entre SAS y SRL, qué es el Formulario 185) con información general y correcta, para generar confianza. Aclarale que los detalles de su caso los define el asesor en la reunión. Nunca des asesoramiento específico de su caso.\n' +
        '- Destacá los BENEFICIOS del Estudio cuando vengan al caso (no todos juntos): presentación de la documentación en un máximo de 48 horas hábiles, Formulario 185 y alta en ARCA incluidos, todo el trámite online con reuniones por Google Meet, primera reunión sin cargo, y acompañamiento después de la constitución (mantenimiento, asambleas, cambios de autoridades). Si tiene apuro, resaltá la rapidez; si duda entre tipos de sociedad, decile que el asesor lo ayuda a elegir la mejor opción para su proyecto.\n' +
        '- Llevá la conversación hacia la reunión sin cargo como el paso natural para avanzar ("En la reunión el asesor le explica todo y le arma la propuesta a medida").\n' +
        '- Si dice que no, que lo va a pensar o que todavía no, respetalo: dejá la puerta abierta con amabilidad, ofrecé enviarle información por correo (pedí el correo) y no insistas más de una vez.\n' +
        '- Interés del cliente: "alto" si tiene apuro o fecha o ya decidió; "medio" si está averiguando; "bajo" si solo pregunta o duda; si no está claro, "medio".\n' +
        '9. REUNIONES: solo cuando ya sepas el nombre, QUÉ NECESITA y, si es una constitución, al menos dos datos (cuántos socios, a qué se va a dedicar, para cuándo lo necesita), ofrecé una reunión sin cargo de 30 minutos por Google Meet con un asesor del Estudio. Si te pide una reunión de entrada, primero preguntale con amabilidad para qué es, así lo atiende el asesor indicado.\n' +
        '- Horarios: usá SIEMPRE consultar_horarios (con "especialidad" y "motivo"); nunca inventes días ni horas. Presentá las opciones numeradas tal como vienen y pedí que responda con el número. Cuando elija, usá solicitar_turno con ese número en "opcion".\n' +
        '- Si el cliente pide un día y hora concretos ("¿puede ser el miércoles a las 16:30?"), usá solicitar_turno con "fecha" y "hora"; si no está libre, la herramienta te da las opciones más cercanas. Si pide solo un día o solo una hora, usá consultar_horarios con "fecha" y/o "hora". Si dice solo una hora y ya tiene una reunión o propuesta, es ese mismo día.\n' +
        '- NUNCA elijas un horario por el cliente: si dice "no puedo a esa hora" sin decir otra, preguntale qué día y hora le queda bien u ofrecele opciones.\n' +
        '- Si el cliente YA tiene una reunión y pide otra (aunque diga un día y hora), ANTES preguntale si quiere cambiar ese horario o si es otro tema, y pasá la respuesta en "proposito". Nunca lo tomes como cambio si no lo dijo. Si es otro tema, preguntale de qué se trata.\n' +
        '- NUNCA digas que la reunión está confirmada: la confirmación la envía el sistema por separado.\n' +
        '10. Si el cliente tiene dudas sobre un presupuesto que ya recibió y no podés resolverlas, ofrecé una reunión de dudas de 15 minutos (tipo "dudas"), que tiene prioridad.\n' +
        '11. CAMBIOS: para cambiar el horario NO canceles: usá solicitar_turno con el horario nuevo (la reunión actual se mantiene hasta que el asesor confirme). Si el asesor le propuso un horario, usá responder_propuesta con su respuesta. Cancelá solo si el cliente pide cancelar sin querer otro horario.\n' +
        '12. HONESTIDAD: nunca digas que enviaste, pediste, reservaste, cancelaste o confirmaste algo si la herramienta no devolvió "ok". Si devolvió un error, explicalo con amabilidad y ofrecé la alternativa que indique la herramienta. Nunca prometas una respuesta del asesor que no se pidió.\n' +
        '13. NO CONTRADIGAS AL SISTEMA: los mensajes de confirmación, cancelación, reprogramación o propuesta que figuran en la conversación son reales. Explicá según el CONTEXTO ACTUAL qué reunión está vigente. Si hay algo que no sabés, decí que lo consultás con el asesor.\n' +
        '14. FECHAS: usá SOLO las fechas de la tabla del CONTEXTO ACTUAL (con su año). Nunca calcules ni inventes una fecha o un año.\n' +
        '15. Respondé siempre con texto normal para el cliente. Nunca escribas etiquetas, código ni nombres de herramientas.\n' +
        '16. TEMAS QUE NO SON DE SOCIEDADES: el Estudio también evalúa otros temas legales (por ejemplo sucesiones, contratos, laboral, civil). NO atiende penal, accidentes ni familia (divorcios, alimentos, tenencia, régimen de visitas). ' +
        'Si la consulta no es de sociedades: hacé como MÁXIMO 3 o 4 preguntas breves, de a una (de qué se trata, si ya hay algo iniciado, para cuándo lo necesita) y después usá derivar_consulta con un resumen. ' +
        'No ofrezcas horarios para estos temas: los evalúa y agenda el asesor. Las sucesiones NO son "familia": se evalúan.' +
        reglasAdmin;
}

const ESPECIALIDADES_ENUM = { type: 'STRING', enum: ESPECIALIDADES };
const INTERES_TXT = 'Interés según lo que dijo el cliente: "alto" si tiene apuro o una fecha, o ya decidió hacerlo; "medio" si está averiguando; "bajo" si solo pregunta o duda. Si no está claro, "medio".';

const HERRAMIENTAS_CLIENTE = [
    {
        name: 'consultar_horarios',
        description: 'Horarios libres para una reunión por Google Meet con un asesor del Estudio. Si el cliente menciona un día y/o una hora, pasalos para buscar ese horario o los más cercanos.',
        parameters: {
            type: 'OBJECT',
            properties: {
                tipo: { type: 'STRING', enum: ['consulta', 'dudas'], description: '"consulta" (30 min) o "dudas" sobre un presupuesto ya enviado (15 min, con prioridad).' },
                especialidad: { ...ESPECIALIDADES_ENUM, description: 'Tema de la reunión, para asignar al asesor indicado.' },
                motivo: { type: 'STRING', description: 'Resumen de lo que necesita el cliente con los datos que dio.' },
                interes: { type: 'STRING', enum: ['alto', 'medio', 'bajo'], description: INTERES_TXT },
                socios: { type: 'INTEGER', description: 'Cantidad de socios, si el cliente lo dijo.' },
                actividad: { type: 'STRING', description: 'A qué se va a dedicar la empresa, si el cliente lo dijo.' },
                plazo: { type: 'STRING', description: 'Para cuándo lo necesita, si el cliente lo dijo.' },
                proposito: { type: 'STRING', enum: ['cambio', 'otro_tema'], description: 'Solo si el cliente YA tiene una reunión y lo dijo claramente: "cambio" si quiere cambiar ese horario, "otro_tema" si es una consulta distinta. Si no lo dijo, NO lo adivines: preguntale.' },
                reunion_actual: { type: 'STRING', description: 'Si tiene más de una reunión y quiere cambiar una: fecha AAAA-MM-DD de la reunión a cambiar.' },
                fecha: { type: 'STRING', description: 'Día que pidió el cliente, AAAA-MM-DD, tomado de la tabla de fechas. Omitir si no pidió un día.' },
                hora: { type: 'STRING', description: 'Hora que pidió el cliente, HH:MM (24 hs). Omitir si no pidió una hora.' }
            },
            required: ['tipo', 'especialidad', 'motivo']
        }
    },
    {
        name: 'solicitar_turno',
        description: 'Pide al asesor un turno: una opción de la lista o un día y hora que pidió el cliente. Si el cliente ya tiene una reunión, hace falta "proposito": "cambio" (pedido de cambio de horario, sin cancelar) u "otro_tema". Queda pendiente hasta que el asesor confirme.',
        parameters: {
            type: 'OBJECT',
            properties: {
                opcion: { type: 'INTEGER', description: 'Número de la opción que eligió el cliente (1, 2, 3...) de la última lista. Es la forma preferida.' },
                fecha: { type: 'STRING', description: 'Si el cliente pidió un día y hora concretos: fecha AAAA-MM-DD.' },
                hora: { type: 'STRING', description: 'Si el cliente pidió un día y hora concretos: hora HH:MM (24 hs).' },
                tipo: { type: 'STRING', enum: ['consulta', 'dudas'] },
                producto: { ...ESPECIALIDADES_ENUM, description: 'Especialidad o tema principal.' },
                motivo: { type: 'STRING', description: 'Resumen de lo que necesita el cliente.' },
                interes: { type: 'STRING', enum: ['alto', 'medio', 'bajo'], description: INTERES_TXT },
                proposito: { type: 'STRING', enum: ['cambio', 'otro_tema'], description: 'OBLIGATORIO si ya tiene una reunión: "cambio" solo si el cliente dijo que quiere cambiar ese horario; "otro_tema" si es una consulta distinta. Si no lo sabés, preguntale antes.' },
                reunion_actual: { type: 'STRING', description: 'Si tiene más de una reunión y quiere cambiar una: fecha AAAA-MM-DD de la reunión a cambiar.' }
            },
            required: ['tipo']
        }
    },
    {
        name: 'responder_propuesta',
        description: 'Respuesta del cliente al horario que le propuso el asesor.',
        parameters: { type: 'OBJECT', properties: { acepta: { type: 'BOOLEAN', description: 'true si acepta el horario propuesto.' } }, required: ['acepta'] }
    },
    {
        name: 'responder_asistencia',
        description: 'Respuesta del cliente a la pregunta del sistema sobre su reunión (si va a asistir, si quiere reagendar o si prefiere que lo contactemos más adelante). El sistema le responde solo.',
        parameters: { type: 'OBJECT', properties: { respuesta: { type: 'STRING', enum: ['si', 'no'] } }, required: ['respuesta'] }
    },
    {
        name: 'derivar_consulta',
        description: 'Para temas legales que NO son de sociedades (por ejemplo sucesiones, contratos, laboral, civil). Si es penal, accidentes o familia, el Estudio no lo atiende. Si no, se le pasa un resumen al asesor para que evalúe si lo toma. Usala después de 3 o 4 preguntas como máximo.',
        parameters: {
            type: 'OBJECT',
            properties: {
                area: { type: 'STRING', description: 'Rama del derecho, por ejemplo "sucesiones", "laboral", "contratos", "civil", "penal", "accidentes", "familia".' },
                resumen: { type: 'STRING', description: 'Resumen claro de lo que necesita el cliente, con los datos que dio (situación, si ya hay algo iniciado, urgencia).' },
                urgencia: { type: 'STRING', description: 'Para cuándo lo necesita, si lo dijo.' },
                nombre_cliente: { type: 'STRING', description: 'Nombre y apellido del cliente, si todavía no lo tenemos guardado.' }
            },
            required: ['area', 'resumen']
        }
    },
    {
        name: 'anotar_datos_cotizacion',
        description: 'Guarda los datos que el cliente fue dando para que el asesor cotice DESPUÉS de la reunión (tipo de trámite, jurisdicción, socios, etc.). No arma ningún presupuesto ni avisa a nadie. Usalo cada vez que dé alguno de estos datos.',
        parameters: {
            type: 'OBJECT',
            properties: {
                tramite: { type: 'STRING', description: 'SAS, SRL, SA, Asociación Civil, Fundación u otro trámite (mantenimiento, transferencia, cierre…).' },
                jurisdiccion: { type: 'STRING', description: 'CABA, Provincia de Buenos Aires u otra provincia.' },
                socios: { type: 'INTEGER', description: 'Cantidad de socios.' },
                socio_empresa: { type: 'BOOLEAN', description: 'true si algún socio es una empresa (persona jurídica).' },
                extranjero_sin_cuit: { type: 'BOOLEAN', description: 'true si algún socio es extranjero y NO tiene CUIT ni CUIL argentino.' },
                sede: { type: 'BOOLEAN', description: 'true si tiene una dirección para la sede social en esa jurisdicción.' },
                detalle: { type: 'STRING', description: 'Otros datos útiles (actividad, plazos…).' }
            }
        }
    },
    {
        name: 'pedir_datos_bancarios',
        description: 'El cliente pide los datos (CBU, alias) para transferir el pago. El asesor confirma cuáles se envían; vos NUNCA escribas datos bancarios.',
        parameters: { type: 'OBJECT', properties: {} }
    },
    {
        name: 'cancelar_mi_turno',
        description: 'Cancela la reunión o el pedido del cliente, solo si lo pide expresamente y no quiere otro horario.',
        parameters: { type: 'OBJECT', properties: {} }
    }
];

// --- Para qué es la reunión (se guarda mientras se conversa y se usa al pedir el turno) ---

const ESPECIALIDADES_CONSTITUCION = ['SAS', 'SRL', 'SA', 'Asociación Civil / ONG'];

// Qué falta saber antes de ofrecer horarios. Devuelve una indicación para el modelo, o null si alcanza.
function faltanDatos(d, esCliente = false) {
    if (!d.especialidad || String(d.motivo || '').trim().length < 8) {
        return 'Todavía no sabés para qué es la reunión. NO ofrezcas horarios: preguntale con amabilidad qué necesita (por ejemplo, constituir una SAS, SRL o SA, mantenimiento, transferencia, cierre o una Asociación Civil), para que lo atienda el asesor indicado.';
    }
    if (d.completo || esCliente || !ESPECIALIDADES_CONSTITUCION.includes(d.especialidad)) return null;
    if (!d.socios) { const m = String(d.motivo).match(/(\d+)\s*soci/i); if (m) d.socios = Number(m[1]); }
    const faltan = [!d.socios && 'cuántos socios van a ser', !d.actividad && 'a qué se va a dedicar', !d.plazo && 'para cuándo lo necesita'].filter(Boolean);
    if (faltan.length >= 2) {
        return `Todavía faltan datos clave. NO ofrezcas horarios: hacele UNA sola pregunta, sobre ${faltan[0]}. Antes podés comentarle brevemente un beneficio del Estudio. Cuando responda, volvé a llamar a consultar_horarios con ese dato (socios, actividad o plazo).`;
    }
    return null;
}

function motivoCompleto(d) {
    const extra = [d.socios && `Socios: ${d.socios}`, d.actividad && `Actividad: ${d.actividad}`, d.plazo && `Plazo: ${d.plazo}`]
        .filter(x => x && !String(d.motivo || '').toLowerCase().includes(String(x.split(': ')[1]).toLowerCase()));
    return [String(d.motivo || '').trim(), ...extra].filter(Boolean).join(' · ') || null;
}

async function guardarDatosConsulta(telefono, datos) {
    await guardarConfig(`consulta:${telefono}`, JSON.stringify({ ...datos, creada: Date.now() })).catch(() => {});
}

async function leerDatosConsulta(telefono) {
    try {
        const v = JSON.parse(await leerConfig(`consulta:${telefono}`) || 'null');
        if (!v || Date.now() - v.creada > 7 * 24 * 3600000) return null;
        return v;
    } catch (e) {
        return null;
    }
}

// Si un turno se cae (cancelado, rechazado, vencido), se recuerda para qué era, para ofrecer otro sin volver a preguntar.
async function recordarConsultaDeTurno(t) {
    if (!t?.telefono) return;
    await guardarDatosConsulta(t.telefono, {
        especialidad: ESPECIALIDADES.includes(t.producto) ? t.producto : 'Otra consulta',
        motivo: t.motivo || `Reprogramación de la reunión del ${etiquetaTurno(t.inicio)}`,
        interes: t.interes || null,
        completo: true
    });
}

// --- Opciones ofrecidas (para que el cliente elija por número) ---

async function guardarOpcionesOfrecidas(telefono, opciones, tipo) {
    await guardarConfig(`opciones:${telefono}`, JSON.stringify({
        tipo, creadas: Date.now(),
        opciones: opciones.map(o => ({ inicio: o.inicio.toISOString(), texto: etiquetaTurno(o.inicio) }))
    })).catch(() => {});
}

async function leerOpcionesOfrecidas(telefono) {
    try {
        const v = JSON.parse(await leerConfig(`opciones:${telefono}`) || 'null');
        if (!v || Date.now() - v.creadas > 2 * 24 * 3600000) return null;
        return v;
    } catch (e) {
        return null;
    }
}

// ¿El cliente mencionó esa hora en sus últimos mensajes? ("16:30", "1630", "a las 4 y media"...). Sin mensajes, no se exige.
function horaMencionada(textos, hora) {
    if (!textos || !textos.length || !hora) return true;
    const [H, M] = hora.split(':').map(Number);
    const texto = textos.slice(-3).join(' ').toLowerCase();
    const re = /(\d{1,2})(?:\s*(?::|\.|h|hs)\s*(\d{2})|(\d{2}))?(?!\s*\/)(\s*y\s*(media|cuarto))?/g;
    let m;
    while ((m = re.exec(texto))) {
        if (/\/\s*$/.test(texto.slice(0, m.index))) continue; // parte de una fecha (09/10)
        const h = Number(m[1]);
        let min = m[2] != null ? Number(m[2]) : (m[3] != null ? Number(m[3]) : null);
        if (min == null && m[5]) min = m[5] === 'media' ? 30 : 15;
        if (h > 23 || (min != null && min > 59)) continue;
        if ((h === H || h + 12 === H) && (min == null ? M === 0 : min === M)) return true;
    }
    return false;
}

function resolverHorarioElegido(args, ofrecidas) {
    if (args.opcion && ofrecidas?.opciones?.[args.opcion - 1]) return new Date(ofrecidas.opciones[args.opcion - 1].inicio);
    const hora = normalizarHora(args.hora);
    const fecha = interpretarFecha(args.fecha);
    if (!hora || !fecha) return null;
    return desdeBA(fecha, hora);
}

// --- Herramientas del cliente ---

// Un prospecto con otro tema: se suma a la reunión que ya tiene. Devuelve null si el tema todavía es vago.
function temaConcreto(detalle) {
    detalle = String(detalle || '').trim();
    if (detalle.replace(/[^a-záéíóúñ]/gi, '').length < 5 || /^(otra|otro|nueva|una)?\s*(consulta|reunion|reunión|tema)( general| adicional| mas| más| nueva)?\.?$/i.test(detalle) || /reuni[oó]n adicional|otra consulta|otro tema|consulta general/i.test(detalle)) return null;
    return detalle;
}

async function sumarTemaAReunion(t, { especialidad, motivo }) {
    const detalle = temaConcreto(motivo);
    if (!detalle) {
        await guardarEstadoProposito(t.telefono, { estado: 'tema', proposito: 'otro_tema' });
        return { error: `Todavía no sabés cuál es el otro tema. NO sumes nada ni digas que lo agregaste. Preguntale SOLO sobre qué tema sería (NO vuelvas a preguntar si quiere cambiar el horario), y explicale que el asesor lo trata en la misma reunión del ${etiquetaTurno(t.inicio)}.` };
    }
    await borrarConfig(`proposito:${t.telefono}`).catch(() => {});
    const tema = [especialidad && especialidad !== t.producto ? especialidad : null, detalle].filter(Boolean).join(': ');
    await actualizarTurno(t.id, { motivo: `${t.motivo || ''}${t.motivo ? ' | ' : ''}Tema adicional: ${tema}`.slice(0, 1000) });
    await hsNota(t, `📌 Tema adicional para la reunión del ${etiquetaTurno(t.inicio)}: ${tema}`);
    const c = await obtenerContacto(t.telefono);
    await enviarAAdmin(`📌 ${etiquetaContacto(c || t)} agregó un tema a su reunión #${t.id} (${etiquetaTurno(t.inicio)}): ${tema}`, { anotar: true });
    return { ok: true, tema_agregado: true, indicacion: `Decile que sumamos ese tema a su reunión del ${etiquetaTurno(t.inicio)}, así el asesor lo ve todo en el mismo encuentro. Su horario NO cambia. No ofrezcas otros horarios.` };
}

// Si tiene más de una reunión y quiere cambiar una, hay que saber cuál.
function reunionACambiar(activos, args) {
    if (activos.length <= 1) return { t: activos[0] || null };
    const f = args.reunion_actual ? interpretarFecha(args.reunion_actual) : null;
    const t = f ? activos.find(x => partesBA(x.inicio).fecha === f) : null;
    if (t) return { t };
    return { pregunta: `Tiene ${activos.length} reuniones: ${activos.map(x => etiquetaTurno(x.inicio)).join(' y ')}. NO cambies nada todavía: preguntale cuál quiere cambiar y volvé a llamar con "reunion_actual" (la fecha AAAA-MM-DD de esa reunión).` };
}

// Con una sola reunión, se entiende que es un cambio solo si el cliente lo dice claro o si hay un horario en discusión.
// Lo que dice el cliente decide si es un cambio de horario u otro tema (no la interpretación del modelo).
// "otra reunión / otra consulta / otro tema" vale aunque venga con un "no" adelante ("No, otra reunión").
const REGEX_OTRO_TEMA = /otr[ao]s? (reuni|consulta|tema|cosa|asunto)|aparte|adem[aá]s|tambi[eé]n (quiero|necesito|tengo)|nueva reuni|segunda reuni|tema (distinto|diferente|nuevo)|(distinto|diferente) tema/i;
const REGEX_CAMBIO = /cambi|pasar|pasarla|mover|moverla|correr|reprogram|en vez|en lugar|mejor (a las|el|para)|otro horario|otra hora|otro d[ií]a|no puedo|no me queda|no llego/i;
function propositoDeTexto(texto) {
    const t = normalizarTexto(texto || '');
    if (REGEX_OTRO_TEMA.test(t)) return 'otro_tema';
    if (REGEX_CAMBIO.test(t)) return 'cambio';
    return null;
}
// Último mensaje del cliente con una intención clara, y si fue el último mensaje.
function resolverProposito({ args, textos, estado, datos, vigentes }) {
    const ultimo = propositoDeTexto((textos || []).slice(-1)[0]);
    if (ultimo) return ultimo;
    if (estado?.proposito) return estado.proposito;
    if (args.proposito) return args.proposito;
    const g = propositoGuardado(datos);
    if (g) return g;
    if (vigentes.length === 1 && leerCambio(vigentes[0])) return 'cambio';
    return null;
}

// Estado de la pregunta "¿cambiar o es otro tema?" (para no repetirla en círculo).
async function leerEstadoProposito(telefono) {
    const v = await leerConfigJSON(`proposito:${telefono}`, 1);
    return v && Date.now() - v.creada < 60 * 60000 ? v : null;
}
async function guardarEstadoProposito(telefono, datos) {
    const previo = await leerEstadoProposito(telefono);
    await guardarConfig(`proposito:${telefono}`, JSON.stringify({ ...(previo || {}), ...datos, creada: Date.now() }));
}

function propositoGuardado(datos) {
    if (datos?.proposito === 'separada') return 'otro_tema';
    if (datos?.proposito === 'cambio') return 'cambio';
    return null;
}

async function ejecutarHerramientaCliente(telefono, nombre, args) {
    try {
        const contacto = await obtenerContacto(telefono);
        const esCliente = Boolean(contacto?.es_cliente);

        if (nombre === 'consultar_horarios') {
            const tipo = args.tipo === 'dudas' ? 'dudas' : 'consulta';
            let activos = await turnosActivosCliente(telefono);
            const previa = await leerDatosConsulta(telefono);

            const evaluacion = await leerConfigJSON(`evaluacion:${telefono}`, 7);
            if (evaluacion && !activos.length) {
                return { error: `Su consulta sobre ${evaluacion.area} está en evaluación por el asesor. NO ofrezcas horarios: decile que el asesor lo va a contactar a la brevedad.` };
            }
            // Si ya tiene una reunión, primero hay que saber si quiere cambiarla o si es otro tema.
            const proposito = activos.length ? resolverProposito({ args, textos: mensajesCliente.get(telefono), estado: await leerEstadoProposito(telefono), datos: previa, vigentes: activos }) : null;
            if (activos.length && !proposito) {
                await guardarEstadoProposito(telefono, { estado: 'pregunta', veces: ((await leerEstadoProposito(telefono))?.veces || 0) + 1 });
                return { pregunta: `El cliente ya tiene ${activos[0].estado === 'confirmado' ? 'una reunión confirmada' : 'un pedido de reunión'} el ${etiquetaTurno(activos[0].inicio)}. NO ofrezcas horarios todavía: preguntale UNA vez, con claridad, si desea CAMBIAR ese horario o si es OTRO TEMA.` };
            }
            if (activos.length && proposito === 'otro_tema' && !esCliente) {
                // Prospecto: el tema nuevo se suma a la misma reunión.
                return await sumarTemaAReunion(activos[0], args);
            }
            const separada = activos.length > 0 && proposito === 'otro_tema' && esCliente;
            if (separada && !temaConcreto(args.motivo)) {
                await guardarEstadoProposito(telefono, { estado: 'tema', proposito: 'otro_tema' });
                return { error: 'Para armarle una reunión aparte necesitás saber el tema: preguntale SOLO sobre qué tema sería (no vuelvas a preguntar si quiere cambiar el horario). Su reunión actual se mantiene.' };
            }
            const esCambio = activos.length > 0 && !separada;
            if (separada) activos = [];
            if (esCambio) {
                const elegida = reunionACambiar(activos, args);
                if (elegida.pregunta) return { pregunta: elegida.pregunta };
                activos = [elegida.t];
            }

            const datos = {
                especialidad: ESPECIALIDADES.includes(args.especialidad) ? args.especialidad : (previa?.especialidad || (esCambio ? activos[0].producto : null) || null),
                motivo: String(args.motivo || '').trim() || previa?.motivo || (esCambio ? activos[0].motivo : '') || '',
                interes: args.interes || previa?.interes || null,
                socios: args.socios || previa?.socios || null, actividad: args.actividad || previa?.actividad || null, plazo: args.plazo || previa?.plazo || null,
                proposito: separada ? 'separada' : (esCambio ? 'cambio' : 'nueva'),
                completo: Boolean(previa?.completo && !args.motivo)
            };
            await guardarDatosConsulta(telefono, datos); // se guarda aunque falten datos, para ir sumándolos
            if (!esCambio && !separada && datos.especialidad && datos.motivo) {
                try {
                    if (!(await negociosAbiertos(telefono)).length) await abrirNegocio(telefono, { especialidad: datos.especialidad, motivo: datos.motivo, interes: datos.interes });
                } catch (e) { console.error('HubSpot (consulta):', e.message); }
            }
            if (!esCambio) {
                const falta = faltanDatos(datos, esCliente);
                if (falta) return { error: falta };
            }

            const fecha = args.fecha ? interpretarFecha(args.fecha) : null;
            const hora = args.hora ? normalizarHora(args.hora) : null;
            const especifico = Boolean(fecha || hora);
            const excluir = activos.map(t => t.id);
            const libres = await horariosLibres({ tipo, excluir, paso: especifico ? 15 : PASO_MIN });
            if (!libres) return { error: 'La agenda no está disponible en este momento. Decile que un asesor lo contactará para coordinar.' };
            let opciones = especifico ? opcionesCercanas(libres, { fecha, hora }) : elegirOpciones(libres, tipo);
            let nota = null;
            if (especifico && !opciones.length) {
                const feriado = fecha && nombreFeriado(fecha);
                nota = `No hay horarios libres ${fecha ? `el ${etiquetaFecha(desdeBA(fecha, '12:00'))}` : `a las ${hora}`}${feriado ? ` (es feriado: ${feriado})` : ''}. Ofrecé estas otras opciones.`;
                opciones = elegirOpciones(await horariosLibres({ tipo, excluir }) || [], tipo);
            } else if (especifico && hora && fecha) {
                const i = opciones.findIndex(o => o.fecha === fecha && partesBA(o.inicio).hora === hora);
                nota = i >= 0 ? `El horario pedido está disponible (es la opción ${i + 1}).` : `El ${etiquetaFecha(desdeBA(fecha, '12:00'))} a las ${hora} no está disponible; estas son las opciones más cercanas.`;
            }
            if (!opciones.length) return { error: 'No hay horarios libres en los próximos días. Decile que un asesor lo contactará para coordinar.' };
            await guardarOpcionesOfrecidas(telefono, opciones, tipo);
            if (activos.length || separada) await borrarConfig(`proposito:${telefono}`).catch(() => {});
            const r = { opciones: listaOpciones(opciones), indicacion: 'Mostralas numeradas con el mismo número y el mismo texto. Cuando el cliente elija, llamá a solicitar_turno con ese número en "opcion".' };
            if (nota) r.nota = nota;
            if (esCambio) r.cambio = `El cliente ya tiene un turno el ${etiquetaTurno(activos[0].inicio)}. Si elige una opción, se envía como pedido de cambio de horario (su reunión actual se mantiene hasta que el asesor confirme).`;
            if (separada) r.nota_cliente = 'Es cliente del Estudio: esta será una reunión APARTE, y la que ya tiene se mantiene sin cambios. Cuando elija, llamá a solicitar_turno con proposito "otro_tema".';
            return r;
        }

        if (nombre === 'solicitar_turno') {
            const ofrecidas = await leerOpcionesOfrecidas(telefono);
            const tipo = args.tipo === 'dudas' ? 'dudas' : (ofrecidas?.tipo || 'consulta');
            const datos = await leerDatosConsulta(telefono);
            const vigentes = await turnosActivosCliente(telefono);
            const proposito = vigentes.length ? resolverProposito({ args, textos: mensajesCliente.get(telefono), estado: await leerEstadoProposito(telefono), datos, vigentes }) : null;
            // Nunca se toca una reunión existente sin saber si el cliente quiere cambiarla o si es otro tema.
            if (vigentes.length && !proposito) {
                await guardarEstadoProposito(telefono, { estado: 'pregunta', veces: ((await leerEstadoProposito(telefono))?.veces || 0) + 1 });
                return { error: `NO se envió ningún pedido. El cliente ya tiene ${vigentes.length > 1 ? 'reuniones' : (vigentes[0].estado === 'confirmado' ? 'una reunión confirmada' : 'un pedido de reunión')} (${vigentes.map(x => etiquetaTurno(x.inicio)).join(' y ')}). Preguntale si desea CAMBIAR ese horario o si es OTRO TEMA, y volvé a llamar con "proposito".` };
            }
            if (vigentes.length && proposito === 'otro_tema' && !esCliente) {
                return await sumarTemaAReunion(vigentes[0], { especialidad: args.producto, motivo: args.motivo || datos?.motivo });
            }
            const separada = vigentes.length > 0 && proposito === 'otro_tema' && esCliente;
            if (separada && !temaConcreto(args.motivo || datos?.motivo)) {
                await guardarEstadoProposito(telefono, { estado: 'tema', proposito: 'otro_tema' });
                return { error: 'NO se envió ningún pedido. Para una reunión aparte necesitás saber el tema: preguntale de qué se trata. La reunión que ya tiene no se cambia.' };
            }
            let activos = [];
            if (vigentes.length && !separada) {
                const elegida = reunionACambiar(vigentes, args);
                if (elegida.pregunta) return { error: `NO se envió ningún pedido. ${elegida.pregunta}` };
                activos = [elegida.t];
            }
            const actual = activos[0] || null;

            const inicio = resolverHorarioElegido(args, ofrecidas);
            if (!inicio) return { error: 'No pude identificar el horario elegido. Pedile que indique el día y la hora, o el número de opción.' };
            if (!args.opcion && args.hora && !horaMencionada(mensajesCliente.get(telefono), normalizarHora(args.hora))) {
                return { error: `NO se envió ningún pedido: el cliente no pidió las ${normalizarHora(args.hora)}. Nunca elijas un horario por él: preguntale qué día y hora le queda bien, u ofrecele opciones con consultar_horarios.` };
            }
            if (actual && new Date(actual.inicio).getTime() === inicio.getTime()) return { error: `Ese es el horario que ya tiene (${etiquetaTurno(inicio)}).` };

            const libres = await horariosLibres({ tipo, excluir: activos.map(t => t.id), paso: 15 });
            if (!libres) return { error: 'La agenda no está disponible. Decile que un asesor lo contactará.' };
            if (!libres.some(l => l.inicio.getTime() === inicio.getTime())) {
                let opciones = opcionesCercanas(libres, { fecha: partesBA(inicio).fecha, hora: partesBA(inicio).hora });
                if (!opciones.length) opciones = elegirOpciones(libres, tipo);
                await guardarOpcionesOfrecidas(telefono, opciones, tipo);
                return { error: `El ${etiquetaTurno(inicio)} no está disponible. NO se envió ningún pedido.`, opciones: listaOpciones(opciones), indicacion: 'Decíselo con claridad y ofrecé estas opciones numeradas.' };
            }

            await borrarConfig(`opciones:${telefono}`).catch(() => {});
            if (actual) {
                await borrarConfig(`consulta:${telefono}`).catch(() => {});
                await borrarConfig(`proposito:${telefono}`).catch(() => {});
                if (actual.estado === 'pendiente_admin') {
                    await modificarPedido(actual, inicio);
                    return { ok: true, estado: 'pedido actualizado, pendiente de confirmación del asesor', horario: etiquetaTurno(inicio), indicacion: 'Decile que actualizaste su pedido y que el asesor le confirma a la brevedad.' };
                }
                await pedirCambio(actual, inicio);
                return {
                    ok: true, estado: 'pedido de cambio enviado al asesor', horario: etiquetaTurno(inicio), mantiene: etiquetaTurno(actual.inicio),
                    indicacion: `Decile que enviaste el pedido de cambio al asesor y que su reunión del ${etiquetaTurno(actual.inicio)} se mantiene hasta que se confirme el nuevo horario.`
                };
            }
            const base = { ...(datos || {}), especialidad: ESPECIALIDADES.includes(args.producto) ? args.producto : (datos?.especialidad || (separada ? 'Otra consulta' : null)), motivo: String(args.motivo || '').trim() || datos?.motivo || '' };
            const falta = faltanDatos(base, esCliente);
            if (falta) return { error: `NO se envió ningún pedido. ${falta}` };
            const t = await crearPedido({ telefono, inicio, tipo, producto: base.especialidad, motivo: motivoCompleto(base), interes: args.interes || datos?.interes || null, separada });
            await borrarConfig(`consulta:${telefono}`).catch(() => {});
            await borrarConfig(`proposito:${telefono}`).catch(() => {});
            if (separada) {
                return { ok: true, estado: 'pedido de reunión APARTE enviado al asesor, pendiente de confirmación', horario: etiquetaTurno(t.inicio), se_mantiene: vigentes.map(x => etiquetaTurno(x.inicio)).join(' y '),
                    indicacion: `Decile que su reunión del ${vigentes.map(x => etiquetaTurno(x.inicio)).join(' y ')} se mantiene, que pediste una reunión aparte para el ${etiquetaTurno(t.inicio)} sobre este tema y que el asesor le confirma a la brevedad.` };
            }
            return { ok: true, estado: 'pedido enviado al asesor, pendiente de confirmación', horario: etiquetaTurno(t.inicio), indicacion: 'Decile que estás verificando la disponibilidad del asesor y que en breve le confirmás.' };
        }

        if (nombre === 'responder_propuesta') {
            const t = (await turnosActivosCliente(telefono)).find(x => leerCambio(x)?.origen === 'asesor');
            if (!t) return { error: 'No hay ningún horario propuesto pendiente.' };
            return await responderPropuesta(t, Boolean(args.acepta));
        }

        if (nombre === 'responder_asistencia') {
            const t = (await turnosActivosCliente(telefono)).find(x => x.estado === 'confirmado');
            if (!t) return { error: 'El cliente no tiene una reunión confirmada.' };
            const si = args.respuesta === 'si';
            if (t.asistencia_confirmada && si && !t.flujo) return { ok: true, aviso: 'Ya tenía la asistencia confirmada. Recordale que 15 minutos antes le llega el link.' };
            if (!si && !preguntaAsistenciaAbierta(t)) return { error: 'No hay ninguna pregunta de asistencia pendiente. Si quiere cancelar, usá cancelar_mi_turno.' };
            await procesarRespuestaAsistencia(t, si);
            return { ok: true, _silencio: true };
        }

        if (nombre === 'pedir_datos_bancarios') {
            await pedirDatosBancarios(telefono);
            return { ok: true, indicacion: 'Decile que en un momento le enviamos los datos para la transferencia por este medio. NO escribas ningún dato bancario.' };
        }

        if (nombre === 'anotar_datos_cotizacion' || nombre === 'preparar_presupuesto' || nombre === 'pedir_cotizacion') {
            const d = await anotarDatosCotizacion(telefono, args);
            const vig = await turnosActivosCliente(telefono);
            const sinSede = d.tramite === 'SAS' && tipoJurisdiccion(d.jurisdiccion) === 'CABA' && d.sede === false;
            return { ok: true, datos_guardados: true, indicacion:
                (vig.length ? 'Datos guardados. Decile que el asesor le arma el presupuesto a medida con lo que conversen en la reunión que ya tiene agendada.'
                    : 'Datos guardados. Decile que el presupuesto lo arma el asesor a medida después de una reunión virtual sin cargo de 30 minutos por Google Meet, y ofrecele horarios (consultar_horarios).') +
                ' NO digas montos ni que le van a mandar un presupuesto ahora.' +
                (sinSede ? ' Avisale con amabilidad que para constituir la SAS en CABA hace falta una dirección en CABA para la sede, y que el Estudio no ofrece domicilio.' : '') };
        }

        if (nombre === 'derivar_consulta') {
            const area = normalizarTexto(args.area);
            // Antes de pasarle la consulta al asesor hace falta el nombre del cliente.
            let ficha = contacto;
            if (!(ficha?.nombre && ficha.nombre !== 'No indicado')) {
                const dado = limpiarNombre(args.nombre_cliente || '');
                if (!dado) return { error: 'Antes de pasarle la consulta al asesor, preguntale su nombre y apellido (y volvé a llamar con "nombre_cliente").' };
                await db.query(`INSERT INTO contactos (telefono, nombre) VALUES ($1, $2) ON CONFLICT (telefono) DO UPDATE SET nombre = EXCLUDED.nombre`, [telefono, dado]);
                ficha = await obtenerContacto(telefono);
            }
            const quien = etiquetaContacto(ficha);
            // Se decide por el área (no por el resumen: "mi familia" puede aparecer en una sucesión).
            const noAtendida = /penal|delito|imputad|detenid|carcel/.test(area) ? 'penal'
                : /accident|choque|siniestro/.test(area) ? 'accidentes'
                : /familia|divorc|alimento|tenencia|cuidado personal|regimen de (visita|comunicacion)|adopci|violencia/.test(area) ? 'familia' : null;
            if (noAtendida) {
                await enviarAAdmin(`ℹ️ ${quien} consultó por un tema de ${noAtendida} (no lo atendemos). Se lo dije con amabilidad.\n📝 ${args.resumen}`, { anotar: true });
                return { ok: true, no_atendida: noAtendida, indicacion: `Decile con amabilidad que el Estudio no trabaja temas de ${noAtendida} y que le recomendamos consultar con un profesional especializado. No ofrezcas horarios. Si tiene alguna consulta de sociedades, con gusto lo ayudamos.` };
            }
            await guardarConfig(`evaluacion:${telefono}`, JSON.stringify({ area: args.area, resumen: args.resumen, urgencia: args.urgencia || null, creada: Date.now() }));
            await abrirNegocio(telefono, { especialidad: `Otro tema: ${args.area}`, motivo: args.resumen, nuevo: true, nota: '⚖️ En evaluación por el asesor' }).catch(e => console.error('HubSpot (evaluación):', e.message));
            await enviarAAdmin(`⚖️ *Consulta para evaluar* · ${args.area}\n\n👤 ${quien}${esCliente ? ' · ⭐ Cliente' : ''}\n📝 ${args.resumen}${args.urgencia ? `\n⏱️ ${args.urgencia}` : ''}\n\n¿La atendemos? Respondé *sí* y le ofrezco horarios, o decime un día y hora para agendarla. Si no, decime *no*.`, { anotar: true });
            return { ok: true, en_evaluacion: true, indicacion: 'Decile que le pasamos su consulta al asesor para evaluarla y que nos comunicaremos a la brevedad. NO ofrezcas horarios ni prometas que se va a atender.' };
        }

        if (nombre === 'cancelar_mi_turno') {
            const activos = await turnosActivosCliente(telefono);
            if (!activos.length) return { error: 'El cliente no tiene turnos activos.' };
            for (const t of activos) await cancelarTurno(t.id, { porCliente: true });
            return { ok: true, cancelados: activos.map(t => etiquetaTurno(t.inicio)) };
        }
    } catch (e) {
        console.error(`Error en herramienta ${nombre}:`, e.message);
        return { error: 'Error interno. Decile que un asesor lo contactará.' };
    }
    return { error: 'Herramienta desconocida.' };
}

// --- "¿Va a asistir?" (sin presionar: 1.ª negativa → reagendar; 2.ª → contactarlo más adelante; 3.ª → se cancela) ---

function esAfirmativo(t) {
    const n = normalizarTexto(t);
    if (n.length > 30) return false;
    if (/^(si+|sip|sii|dale|ok|okey|okay|oka|confirmo|confirma|confirmalo|confirmar|de acuerdo|perfecto|listo|adelante|claro|obvio|va|hacelo|si dale|dale si|si confirmo|si confirmalo|si por favor|si gracias|dale gracias|ok dale|si si)( por favor| gracias)?$/.test(n)) return true;
    // "si puede fijate", "sí, hacelo": empieza con un sí y no trae condiciones, números ni negaciones.
    return /^(si+|dale|ok|okey|listo|perfecto|claro|de acuerdo|confirmo)( |$)/.test(n) && !/\d/.test(n) &&
        !/\b(no|pero|otro|otra|otros|otras|cambia|cambiale|mejor|aunque|salvo|excepto|despues|antes|tarde|temprano|manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo|cuando|cual|que)\b/.test(n);
}

function esNegativo(t) {
    const n = normalizarTexto(t);
    return n.length <= 20 && /^(no|nop|nope|negativo|mejor no|no gracias|no no|cancelalo|no lo confirmes)$/.test(n);
}

function esAfirmativoCliente(texto) {
    const n = normalizarTexto(texto);
    return esAfirmativo(texto) || (n.length <= 40 &&
        /^(si |dale )?(voy|ahi voy|asisto|asistire|ahi estare|ahi estoy|alli estare|estare|estaremos|cuenten conmigo|confirmo asistencia|si voy|si asisto|por supuesto|seguro|si claro|claro que si)( gracias| por favor)?$/.test(n));
}

function esNegativoCliente(texto) {
    const n = normalizarTexto(texto);
    return esNegativo(texto) || (n.length <= 50 &&
        /^(no )?(no puedo|no voy|no podre|no voy a poder|no asistire|no llego|imposible|no me es posible|no creo|lamentablemente no|no puedo ir|no puedo asistir|no por ahora|no por el momento|ahora no)( gracias| lo siento| perdon| disculpe)?$/.test(n));
}

// Acepta un horario propuesto, con cualquier palabra de aceptación.
function esAceptacionCliente(texto) {
    const n = normalizarTexto(texto);
    if (esNegativoCliente(texto) || /\bpero\b|\bno puedo\b|\bmejor\b|\botro\b|\botra\b/.test(n)) return false;
    return esAfirmativoCliente(texto) || (n.length <= 80 &&
        /(no hay problema|me queda bien|me sirve|me viene bien|perfecto|de acuerdo|acepto|consentimiento|ya (le|te) (dije|di|habia dicho|habia dado)|esta bien|si claro|si por supuesto|dale)/.test(n));
}

function preguntaAsistenciaAbierta(t) {
    if (!t || t.estado !== 'confirmado' || t.asistencia_confirmada) return false;
    const r = t.recordatorios || {};
    return Boolean(t.flujo) || ['c24', 'c12', 'c60'].some(c => r[c] === 'enviado');
}

async function registrarAsistencia(t) {
    await actualizarTurno(t.id, { asistencia_confirmada: true, flujo: null });
    await enviarACliente(t.telefono, `¡Muchas gracias por confirmar! Lo esperamos el ${etiquetaTurno(t.inicio)}.\n\n15 minutos antes de la reunión le enviaremos por aquí el link de Google Meet.`);
    await enviarAAdmin(`✅ ${t.nombre || 'El cliente'} confirmó asistencia a la reunión del ${etiquetaTurno(t.inicio)} (#${t.id}).`);
}

async function ofrecerReagenda(t) {
    const libres = await horariosLibres({ tipo: t.tipo });
    const opciones = libres ? elegirOpciones(libres, t.tipo) : [];
    if (!opciones.length) {
        await enviarACliente(t.telefono, 'Perfecto. En este momento no tengo horarios disponibles para ofrecerle; un asesor del Estudio se comunicará con usted para coordinar uno nuevo.');
        return;
    }
    await guardarOpcionesOfrecidas(t.telefono, opciones, t.tipo);
    await enviarACliente(t.telefono, `Perfecto, liberamos el horario anterior. Le puedo ofrecer:\n\n${textoOpciones(opciones)}\n\nIndíquenos el número de su preferencia.`);
}

async function procesarRespuestaAsistencia(t, asiste) {
    const quien = t.nombre || 'El cliente';
    if (asiste) {
        if (t.flujo === 'n1') {
            await cancelarTurno(t.id, { porCliente: true, silencioso: true });
            await enviarAAdmin(`🔄 ${quien} no puede asistir el ${etiquetaTurno(t.inicio)} (#${t.id}) y aceptó reagendar. Cancelé la reunión y le ofrecí nuevos horarios.`);
            await ofrecerReagenda(t);
            return;
        }
        if (t.flujo === 'n2') {
            await cancelarTurno(t.id, { porCliente: true, silencioso: true });
            await enviarACliente(t.telefono, 'Muy bien. Cancelamos la reunión y más adelante nos comunicaremos con usted. Quedamos a su disposición. ¡Que tenga un buen día!');
            await iniciarSeguimiento(await obtenerTurno(t.id) || t, 'mas_adelante');
            await enviarAAdmin(`📌 ${quien} no puede asistir el ${etiquetaTurno(t.inicio)} (#${t.id}) y pidió que lo contactemos más adelante. Cancelé la reunión; en 2 días hábiles le escribo para retomar (y a los 7 y 15 días si no responde).`);
            return;
        }
        await registrarAsistencia(t);
        return;
    }
    const negativas = (t.negativas || 0) + 1;
    if (!t.flujo) {
        await actualizarTurno(t.id, { negativas, flujo: 'n1' });
        await enviarACliente(t.telefono, 'Entendemos, no se preocupe. ¿Le gustaría que busquemos otro día y horario para la reunión?');
        await enviarAAdmin(`⚠️ ${quien} avisó que no podría asistir a la reunión del ${etiquetaTurno(t.inicio)} (#${t.id}). Le ofrecí reagendar.`);
        return;
    }
    if (t.flujo === 'n1') {
        await actualizarTurno(t.id, { negativas, flujo: 'n2' });
        await enviarACliente(t.telefono, 'De acuerdo. ¿Prefiere que lo contactemos más adelante para coordinar en otro momento?');
        return;
    }
    await actualizarTurno(t.id, { negativas, flujo: 'retirado' });
    await cancelarTurno(t.id, { porCliente: true, silencioso: true });
    await enviarACliente(t.telefono, `Entendido. Cancelamos la reunión del ${etiquetaTurno(t.inicio)}. Si más adelante necesita algo, puede escribirnos por aquí cuando quiera. ¡Muchas gracias y que tenga un buen día!`);
    await enviarAAdmin(`❌ ${quien} no podrá asistir a la reunión del ${etiquetaTurno(t.inicio)} (#${t.id}) y no quiso reagendar ni que lo contactemos. Cancelé la reunión y no le vamos a insistir.`);
}

// --- Respuestas directas (sin pasar por Gemini) ---

// "Sí" a un horario que propuso el asesor.
async function propuestaDirecta(telefono, texto) {
    if (!esAceptacionCliente(texto)) return false;
    const t = (await turnosActivosCliente(telefono)).find(x => {
        const c = leerCambio(x);
        return c?.origen === 'asesor' && Date.now() - new Date(c.creado).getTime() < 2 * 24 * 3600000;
    });
    if (!t) return false;
    const r = await responderPropuesta(t, true);
    return Boolean(r && r.ok);
}

// "Sí" o "no" a "¿Va a asistir?".
async function asistenciaDirecta(telefono, texto) {
    const si = esAfirmativoCliente(texto), no = !si && esNegativoCliente(texto);
    if (!si && !no) return false;
    const t = (await turnosActivosCliente(telefono)).find(preguntaAsistenciaAbierta);
    if (!t) return false;
    await procesarRespuestaAsistencia(t, si);
    return true;
}

// Responde solo con el número de una opción ofrecida.
const REGEX_ELECCION = /^\s*(?:(?:la|el)\s+)?(?:opci[oó]n\s*)?(?:n(?:[uú]mero|ro\.?|°|º)?\s*)?([1-9])\s*[.!)]?\s*(?:por favor|gracias)?\s*$/i;

async function eleccionDirecta(telefono, texto) {
    const m = String(texto || '').match(REGEX_ELECCION);
    if (!m) return null;
    const ofrecidas = await leerOpcionesOfrecidas(telefono);
    if (!ofrecidas) return null;
    const numero = Number(m[1]);
    if (!ofrecidas.opciones[numero - 1]) {
        return `Por favor, indíquenos un número entre 1 y ${ofrecidas.opciones.length}:\n\n${ofrecidas.opciones.map((o, i) => `${i + 1}. ${o.texto}`).join('\n')}`;
    }
    const r = await ejecutarHerramientaCliente(telefono, 'solicitar_turno', { opcion: numero, tipo: ofrecidas.tipo });
    if (r.ok && r.mantiene) return `Perfecto. Le envié al asesor el pedido de cambio para el ${r.horario}. Su reunión del ${r.mantiene} se mantiene hasta que le confirmemos el nuevo horario.`;
    if (r.ok) return `Perfecto. Estoy verificando la disponibilidad del asesor para el ${r.horario}. En breve le confirmo.`;
    if (r.opciones) return `${r.error.replace(' NO se envió ningún pedido.', '')} Le puedo ofrecer:\n\n${r.opciones.map(o => `${o.opcion}. ${o.texto}`).join('\n')}\n\nIndíquenos el número de su preferencia.`;
    return null; // que lo resuelva la conversación normal
}

// --- "¿Cambiar el horario o es otro tema?": la respuesta la interpreta el sistema, sin vueltas ---

const RELLENO_TEMA = /\b(no|si|sí|es|era|seria|sería|quiero|necesito|quisiera|una|un|unas|otra|otro|otros|otras|reunion|reunión|reuniones|consulta|tema|asunto|cosa|aparte|ademas|además|tambien|también|nueva|nuevo|segunda|distinto|distinta|diferente|para|por|el|la|los|las|de|del|dia|día|a|al|hs|en|y|que|me|mi|sobre|hola|gracias|ok|dale|bueno)\b|\d+([\/:.]\d+)*/gi;
function extraerTema(texto) {
    const resto = normalizarTexto(texto || '').replace(RELLENO_TEMA, ' ').replace(/[^a-zñ ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (resto.replace(/ /g, '').length < 4) return null;
    return String(texto).trim().replace(/^(no|si|sí)[,.!\s]+/i, '').slice(0, 300);
}

function preguntaTema(t, esCliente) {
    return esCliente
        ? `Perfecto. ¿Sobre qué tema sería? Así le coordino una reunión aparte; su reunión del ${etiquetaTurno(t.inicio)} se mantiene.`
        : `Perfecto. ¿Sobre qué tema sería? Así el asesor lo trata en la misma reunión del ${etiquetaTurno(t.inicio)} y le da todo junto.`;
}

async function resolverOtroTema(telefono, vigentes, esCliente, tema) {
    if (!esCliente) {
        const r = await sumarTemaAReunion(vigentes[0], { motivo: tema });
        if (!r.ok) return null;
        return `Perfecto. Sumamos este tema a su reunión del ${etiquetaTurno(vigentes[0].inicio)}, así el asesor lo trata en el mismo encuentro. Su horario no cambia.`;
    }
    const r = await ejecutarHerramientaCliente(telefono, 'consultar_horarios', { tipo: 'consulta', especialidad: 'Otra consulta', motivo: tema, proposito: 'otro_tema' });
    if (!r.opciones) return null;
    return `Perfecto. Su reunión del ${vigentes.map(x => etiquetaTurno(x.inicio)).join(' y ')} se mantiene. Para este tema le ofrezco una reunión aparte:\n\n${r.opciones.map(o => `${o.opcion}. ${o.texto}`).join('\n')}\n\nIndíquenos el número de su preferencia.`;
}

async function propositoDirecto(telefono, texto) {
    const est = await leerEstadoProposito(telefono);
    if (!est || (est.estado !== 'pregunta' && est.estado !== 'tema')) return null;
    const vigentes = await turnosActivosCliente(telefono);
    if (!vigentes.length) { await borrarConfig(`proposito:${telefono}`); return null; }
    const esCliente = Boolean((await obtenerContacto(telefono))?.es_cliente);
    const p = propositoDeTexto(texto);
    if (p === 'cambio') { await guardarEstadoProposito(telefono, { estado: 'resuelto', proposito: 'cambio' }); return null; } // sigue la conversación normal
    if (p === 'otro_tema' || est.estado === 'tema') {
        const tema = /\?\s*$/.test(String(texto).trim()) ? null : extraerTema(texto);
        if (tema) {
            const r = await resolverOtroTema(telefono, vigentes, esCliente, tema);
            if (r) return r;
            return null;
        }
        if (est.estado === 'tema' && !p) return null; // no respondió el tema: que siga la conversación
        await guardarEstadoProposito(telefono, { estado: 'tema', proposito: 'otro_tema' });
        return preguntaTema(vigentes[0], esCliente);
    }
    // No se entendió la respuesta: una sola vez más, con opciones claras.
    if ((est.veces || 0) >= 1) {
        await guardarEstadoProposito(telefono, { veces: (est.veces || 0) + 1 });
        return `Disculpe, para no confundirnos, ¿qué desea hacer?\n\n• Responda *cambiar* si quiere cambiar el horario de su reunión del ${etiquetaTurno(vigentes[0].inicio)}.\n• Responda *otro tema* si es una consulta distinta.`;
    }
    return null;
}

// --- Contexto que recibe el modelo en cada mensaje ---

async function contextoCliente(telefono) {
    const partes = [`Hoy es ${fechaHoyCompleta()} (hora de Buenos Aires).`, `Tabla de fechas (usá solo estas):\n${calendarioReferencia()}`];
    try {
        const contacto = await obtenerContacto(telefono);
        partes.push(contacto?.es_cliente
            ? 'Esta persona YA ES CLIENTE del Estudio (contrató antes): tratala como cliente, sin la indagación comercial completa. Si ya tiene una reunión y quiere tratar otro tema, puede agendar una reunión aparte.'
            : 'Esta persona es un PROSPECTO (todavía no contrató): aplicá el perfil comercial. Si ya tiene una reunión y quiere tratar otro tema, se suma a esa misma reunión.');
        const activos = await turnosActivosCliente(telefono);
        if (!activos.length) partes.push('No tiene ninguna reunión ni pedido vigente.');
        const [seg] = await seguimientosActivos(telefono).catch(() => []);
        if (seg?.ultimo_envio) partes.push(seg.motivo === 'no_asistio'
            ? 'No pudo asistir a su última reunión y el Estudio le escribió para reprogramar: si quiere, ofrecele horarios con amabilidad, sin reprocharle nada.'
            : 'Había pedido que lo contactemos más adelante y el Estudio le escribió para retomar: si quiere avanzar, ofrecele horarios.');
        for (const t of activos) {
            const c = leerCambio(t);
            const linkVisible = (t.recordatorios || {}).c15 === 'enviado' || Date.now() >= new Date(t.inicio).getTime() - 15 * 60000;
            let linea = t.estado === 'confirmado'
                ? `Reunión CONFIRMADA: ${etiquetaTurno(t.inicio)}${t.asistencia_confirmada ? ', asistencia confirmada' : ''}.`
                : `Pedido de reunión para el ${etiquetaTurno(t.inicio)}, esperando la confirmación del asesor.`;
            if (c && c.origen === 'cliente') linea += ` Pidió pasarla al ${etiquetaTurno(c.inicio)}; espera la confirmación del asesor (mientras tanto se mantiene el horario actual).`;
            if (c && c.origen === 'asesor') linea += ` El asesor le PROPUSO el ${etiquetaTurno(c.inicio)}: si acepta usá responder_propuesta (acepta=true); si pide otro horario, solicitar_turno; si no le sirve, responder_propuesta (acepta=false).`;
            if (t.estado === 'confirmado') linea += linkVisible && t.meet ? ` Link de la reunión: ${t.meet}.` : ' El link de Meet se le envía automáticamente 15 minutos antes; no lo compartas ni lo inventes.';
            partes.push(linea);
            if (t.flujo === 'n1') partes.push('Dijo que no puede asistir; el sistema le preguntó si quiere reagendar. Si responde, usá responder_asistencia ("si" = reagendar).');
            else if (t.flujo === 'n2') partes.push('No quiso reagendar; el sistema le preguntó si prefiere que lo contactemos más adelante. Si responde, usá responder_asistencia.');
            else if (preguntaAsistenciaAbierta(t)) partes.push('El sistema le preguntó si va a asistir. Si responde sí o no (con cualquier palabra), usá responder_asistencia. Nunca insistas.');
        }
        const { rows: recientes } = await db.query(
            `SELECT * FROM turnos WHERE telefono = $1 AND estado IN ('cancelado', 'cancelado_cliente', 'rechazado', 'descartado', 'vencido')
             AND actualizado_en > NOW() - INTERVAL '2 days' ORDER BY actualizado_en DESC LIMIT 3`, [telefono]);
        const nombres = { cancelado: 'cancelada por el Estudio', cancelado_cliente: 'cancelada', rechazado: 'no aceptada', descartado: 'descartada', vencido: 'vencida sin confirmar' };
        if (recientes.length) partes.push(`Movimientos recientes: ${recientes.map(r => `reunión/pedido del ${etiquetaTurno(r.inicio)}: ${nombres[r.estado]}`).join('; ')}.`);
        const esperando = await leerEsperandoRespuesta(telefono);
        if (esperando) partes.push(`El asesor le escribió hace poco: «${esperando.mensaje}».`);
        const evaluacion = await leerConfigJSON(`evaluacion:${telefono}`, 7);
        if (evaluacion) partes.push(`Su consulta sobre ${evaluacion.area} está en evaluación por el asesor (${evaluacion.resumen}). No ofrezcas horarios para ese tema: el asesor lo contacta.`);
        const datosCot = resumenDatosCotizacion(await leerDatosCotizacion(telefono));
        if (datosCot) partes.push(`Datos para la cotización que ya dio (no los vuelvas a preguntar): ${datosCot}.`);
        if (await cotizacionEnCurso(telefono)) partes.push('Después de la reunión el asesor está preparando su presupuesto: si pregunta, decile que se lo envía a la brevedad por este medio.');
        const ofrecidas = await leerOpcionesOfrecidas(telefono);
        if (ofrecidas) partes.push(`Últimas opciones ofrecidas (si elige una, usá solicitar_turno con ese número en "opcion"):\n${ofrecidas.opciones.map((o, i) => `${i + 1}. ${o.texto}`).join('\n')}`);
    } catch (e) { /* sin contexto de turnos */ }
    return partes.join('\n');
}
// ==================== 8. Páginas web ====================

// ---------- Página para agregar la reunión a la agenda del cliente ----------
// No muestra el link de Meet: ese se envía por WhatsApp 15 minutos antes.

function fechaIcs(d) {
    return new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function escaparHtml(t) {
    return String(t || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function escaparIcs(t) {
    return String(t || '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

const TITULO_AGENDA = 'Reunión con Estudio Jaime Irigoyen';
const DETALLE_AGENDA = 'Reunión por Google Meet con un asesor del Estudio Jaime Irigoyen. El link de la reunión se lo enviaremos por WhatsApp 15 minutos antes de comenzar.';

async function turnoPorToken(token) {
    if (!/^[a-f0-9]{32}$/.test(token || '')) return null;
    const { rows } = await db.query('SELECT * FROM turnos WHERE token = $1 LIMIT 1', [token]);
    return rows[0] || null;
}

async function enviarIcs(req, res, token) {
    const t = await turnoPorToken(token).catch(() => null);
    if (!t || t.estado !== 'confirmado') return res.status(404).send('Reunión no disponible.');
    const ics = [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Estudio Jaime Irigoyen//Agenda//ES', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
        'BEGIN:VEVENT',
        `UID:turno-${t.id}-${t.token.slice(0, 8)}@estudiojaimeirigoyen`,
        `DTSTAMP:${fechaIcs(new Date())}`,
        `DTSTART:${fechaIcs(t.inicio)}`,
        `DTEND:${fechaIcs(new Date(new Date(t.inicio).getTime() + (t.tipo === 'dudas' ? 15 : 30) * 60000))}`,
        `SUMMARY:${escaparIcs(TITULO_AGENDA)}`,
        `DESCRIPTION:${escaparIcs(DETALLE_AGENDA)}`,
        'LOCATION:Google Meet (link por WhatsApp)',
        'BEGIN:VALARM', 'TRIGGER:-PT30M', 'ACTION:DISPLAY', `DESCRIPTION:${escaparIcs(TITULO_AGENDA)}`, 'END:VALARM',
        'END:VEVENT', 'END:VCALENDAR'
    ].join('\r\n');
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="reunion-estudio-irigoyen.ics"');
    res.send(ics);
}

// Aviso del formulario de Google: el cliente completó los datos de la SAS.
app.get('/formulario-sas/:token', async (req, res) => {
    try { await formularioCompletado(req.params.token); } catch (e) { console.error('Formulario SAS:', e.message); }
    res.send('ok');
});

app.get('/agenda/:token', async (req, res) => {
    if (req.params.token.endsWith('.ics')) return enviarIcs(req, res, req.params.token.slice(0, -4));
    const t = await turnoPorToken(req.params.token).catch(() => null);
    const estilo = `body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f4f1ea;color:#1f2a37;margin:0;padding:16px;box-sizing:border-box}
        .card{background:#fff;padding:32px 28px;border-radius:16px;max-width:440px;width:100%;box-shadow:0 8px 30px rgba(0,0,0,.08);text-align:center}
        h1{font-size:1.3rem;margin:0 0 6px} .cuando{font-size:1.1rem;font-weight:600;margin:16px 0 4px;color:#14365d}
        p{color:#4b5563;line-height:1.5;font-size:.95rem} .marca{font-size:.8rem;letter-spacing:.08em;text-transform:uppercase;color:#8a7350;margin-bottom:14px}
        a.btn{display:block;padding:14px;border-radius:10px;text-decoration:none;font-weight:600;margin-top:12px}
        .g{background:#14365d;color:#fff} .i{background:#eef2f7;color:#14365d}`;
    const pagina = (cuerpo) => `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Reunión · Estudio Jaime Irigoyen</title><style>${estilo}</style></head><body><div class="card"><div class="marca">Estudio Jaime Irigoyen</div>${cuerpo}</div></body></html>`;
    if (!t) return res.status(404).send(pagina('<h1>Reunión no encontrada</h1><p>Este enlace no es válido. Si necesita ayuda, escríbanos por WhatsApp.</p>'));
    if (t.estado !== 'confirmado') return res.send(pagina('<h1>Esta reunión ya no está vigente</h1><p>Si desea coordinar un nuevo horario, escríbanos por WhatsApp.</p>'));
    const fin = new Date(new Date(t.inicio).getTime() + (t.tipo === 'dudas' ? 15 : 30) * 60000);
    const google = 'https://calendar.google.com/calendar/render?' + new URLSearchParams({
        action: 'TEMPLATE', text: TITULO_AGENDA, dates: `${fechaIcs(t.inicio)}/${fechaIcs(fin)}`, details: DETALLE_AGENDA, ctz: ZONA_HORARIA
    }).toString();
    res.send(pagina(`<h1>Su reunión con el Estudio</h1>
        <div class="cuando">${escaparHtml(etiquetaTurno(t.inicio))}</div>
        <p>Por Google Meet, ${t.tipo === 'dudas' ? '15' : '30'} minutos. El link de la reunión se lo enviaremos por WhatsApp 15 minutos antes.</p>
        <a class="btn g" href="${escaparHtml(google)}" target="_blank" rel="noopener">Agregar a Google Calendar</a>
        <a class="btn i" href="/agenda/${t.token}.ics">Agregar a otro calendario (iPhone, Outlook)</a>`));
});

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

// ==================== 9. Gemini ====================

const CODIGOS_REINTENTABLES = new Set([429, 500, 502, 503, 504]);
let ultimoErrorGemini = null;

// Llama a un modelo con un cuerpo completo de Gemini. Devuelve { contenido, texto } o un error.
function llamarModeloCuerpo(modelo, cuerpo) {
    return new Promise((resolve) => {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${GEMINI_API_KEY}`;
        const payload = JSON.stringify(cuerpo);

        const req = https.request(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            },
            timeout: 25000
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const parsed = JSON.parse(data);
                        const contenido = parsed.candidates?.[0]?.content;
                        const partes = contenido?.parts || [];
                        const texto = partes.filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('').trim();
                        const llamadas = partes.filter(p => p.functionCall).map(p => p.functionCall);
                        if (texto || llamadas.length) return resolve({ contenido, texto, llamadas });
                    } catch (e) {
                        console.error('Error parseando respuesta de Gemini:', e.message);
                    }
                    return resolve({ status: 200, mensaje: 'respuesta vacía', reintentar: true });
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

function llamarModelo(modelo, contents, generationConfig) {
    return llamarModeloCuerpo(modelo, { contents, generationConfig });
}

// Prueba un cuerpo con el modelo indicado (o con el principal y los de respaldo) y reintenta si está saturado.
async function llamarConReintentos(cuerpo, { modelos = [GEMINI_MODEL, ...GEMINI_MODELOS_RESPALDO], intentos = 3 } = {}) {
    const esperas = [2000, 5000];
    for (const modelo of modelos) {
        for (let i = 0; i < intentos; i++) {
            const r = await llamarModeloCuerpo(modelo, cuerpo);
            if (r.contenido) {
                ultimoErrorGemini = null;
                return { ...r, modelo };
            }
            ultimoErrorGemini = { modelo, status: r.status, mensaje: r.mensaje, en: new Date() };
            if (!r.reintentar) break;
            if (i < intentos - 1) await esperar(esperas[i] || 5000);
        }
    }
    return null;
}

// Prueba el modelo principal hasta 3 veces (esperando 2 s y 5 s) y luego cada modelo de respaldo.
async function llamarGemini(contents, generationConfig, { intentos = 3 } = {}) {
    const r = await llamarConReintentos({ contents, generationConfig }, { intentos });
    return r?.texto || null;
}

// Conversación con herramientas: el modelo puede pedir ejecutar funciones; se ejecutan y se le devuelve el resultado.
// Una vez que un modelo respondió, el resto de la vuelta usa el mismo modelo (las firmas de razonamiento son por modelo).
// A veces el modelo "escribe" una herramienta como texto (<function=...>) en lugar de usarla: eso nunca se manda.
function esTextoInterno(t) {
    return /<\/?(function|thought|tool_call|the_tool_call|tool_code)\b|<function=|\bfunctionCall\b|```tool/i.test(String(t || ''));
}

async function conversarConHerramientas({ instrucciones, contents, herramientas, ejecutar, maxPasos = 4, generationConfig, alAgotar = null }) {
    const conversacion = [...contents];
    let modeloFijo = null;
    let reintentoTexto = false;
    for (let paso = 0; paso < maxPasos; paso++) {
        const cuerpo = {
            systemInstruction: { parts: [{ text: instrucciones }] },
            contents: conversacion,
            ...(herramientas && herramientas.length ? { tools: [{ functionDeclarations: herramientas }] } : {}),
            generationConfig: generationConfig || { maxOutputTokens: 800, temperature: 0.4 }
        };
        const r = await llamarConReintentos(cuerpo, modeloFijo ? { modelos: [modeloFijo] } : {});
        if (!r) return null;
        modeloFijo = r.modelo;
        if (!r.llamadas.length) {
            if (!esTextoInterno(r.texto)) return r.texto || null;
            console.error('El modelo devolvió texto interno; se reintenta:', String(r.texto).slice(0, 120));
            if (reintentoTexto) return null;
            reintentoTexto = true;
            instrucciones += '\n\nIMPORTANTE: respondé SOLO con texto normal para el cliente. Si necesitás una herramienta, usala como herramienta, nunca la escribas como texto.';
            paso--;
            continue;
        }

        conversacion.push(r.contenido);
        const respuestas = [];
        for (const llamada of r.llamadas) {
            console.log(`[HERRAMIENTA] ${llamada.name} ${JSON.stringify(llamada.args || {})}`);
            const resultado = await ejecutar(llamada.name, llamada.args || {});
            respuestas.push({ functionResponse: { name: llamada.name, response: { resultado } } });
        }
        conversacion.push({ role: 'user', parts: respuestas });
    }
    return alAgotar; // se usaron todos los pasos sin llegar a una respuesta
}

// respuestaAlAsesor: true si este mensaje es la primera respuesta del cliente a un mensaje que le escribió el asesor.
const REGEX_MONTO = /(\$|usd|u\$s|us\$)\s?\d|\d[\d.,]*\s?(usd|u\$s|d[oó]lares|pesos)\b/i;
const REGEX_DICE_AGREGADO = /\b(agregamos|agregaremos|agregu[ée]|sumamos|sumaremos|sum[ée]|qued[óo] (agregad|sumad|incluid)|incluimos|incluiremos)\b[^.?!]{0,80}\b(tema|consulta)/i;

async function consultarGemini(remitenteId, mensajeTexto, { respuestaAlAsesor = false } = {}) {
    let historial = userHistories.get(remitenteId);
    if (!historial) {
        // Recupera la conversación desde la base. Excluye el mensaje actual, que ya se guardó.
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
    const mensajeUsuario = { role: 'user', parts: [{ text: previo ? previo.parts[0].text + '\n' + mensajeTexto : mensajeTexto }] };
    userHistories.delete(remitenteId); // se vuelve a leer de la base en cada mensaje (incluye los avisos del sistema)

    // Primera respuesta a un mensaje del asesor: el bot solo agradece (la respuesta ya se le reenvió al asesor).
    if (respuestaAlAsesor) {
        const esperando = await leerEsperandoRespuesta(remitenteId);
        const instrucciones = construirInstrucciones() + '\n\nCONTEXTO ACTUAL:\n' + await contextoCliente(remitenteId) +
            `\n\nIMPORTANTE: el asesor le escribió al cliente «${esperando?.mensaje || ''}» y este mensaje es su respuesta, que ya se le reenvió al asesor. ` +
            'Respondé en UNA o DOS oraciones: agradecé (si se queja, pedí disculpas con sinceridad) y decile que ya se lo transmitimos al asesor, que le confirma a la brevedad. ' +
            'NO ofrezcas horarios, NO confirmes ni canceles nada, NO hagas preguntas.';
        const r = await conversarConHerramientas({ instrucciones, contents: [...base, mensajeUsuario], herramientas: [] });
        return r ? limpiarTratamiento(r) : 'Muchas gracias por su respuesta. Ya se la transmitimos al asesor, que le confirmará a la brevedad.';
    }

    const directas = [
        ['Propuesta directa', () => propuestaDirecta(remitenteId, mensajeTexto)],
        ['Asistencia directa', () => asistenciaDirecta(remitenteId, mensajeTexto)]
    ];
    for (const [nombre, fn] of directas) {
        const hecho = await fn().catch(e => { console.error(`${nombre}:`, e.message); return false; });
        if (hecho) return ''; // el sistema ya le respondió
    }
    const directa = await eleccionDirecta(remitenteId, mensajeTexto).catch(e => { console.error('Elección directa:', e.message); return null; });
    if (directa) return directa;
    const porProposito = await propositoDirecto(remitenteId, mensajeTexto).catch(e => { console.error('Propósito directo:', e.message); return null; });
    if (porProposito) return porProposito;

    const instrucciones = construirInstrucciones() + '\n\nCONTEXTO ACTUAL:\n' + await contextoCliente(remitenteId);
    let silencio = false; // una herramienta ya le respondió al cliente: no se agrega texto del modelo
    let temaAgregado = false;
    let presupuestoGestionado = false;
    const reply = await conversarConHerramientas({
        instrucciones,
        contents: [...base, mensajeUsuario],
        herramientas: HERRAMIENTAS_CLIENTE,
        ejecutar: async (nombre, args) => {
            const r = await ejecutarHerramientaCliente(remitenteId, nombre, args);
            if (r?.tema_agregado) temaAgregado = true;
            if (r?.presupuesto_gestionado) presupuestoGestionado = true;
            if (r && r._silencio) { silencio = true; const { _silencio, ...resto } = r; return resto; }
            return r;
        }
    });
    if (silencio) return '';
    if (reply && REGEX_MONTO.test(reply)) {
        console.warn('El modelo escribió un monto; se reemplaza.');
        return textoReunionPrimero(remitenteId);
    }
    if (reply && REGEX_NO_HACEMOS.test(reply) && !EXCEPCIONES_NO_HACEMOS.test(reply)) {
        // Dice que el Estudio no hace un trámite o no trabaja en una jurisdicción: es falso, se corrige y se ofrece la reunión.
        console.warn('El modelo dijo que el Estudio no hace un trámite; se corrige.');
        return 'Sí, el Estudio trabaja en todo el país, también en la Provincia de Buenos Aires y en el resto de las provincias. ' + await textoReunionPrimero(remitenteId);
    }
    if (reply && !presupuestoGestionado && REGEX_PROMETE_PRESUPUESTO.test(reply) && !/reuni[oó]n/i.test(reply) && !(await cotizacionEnCurso(remitenteId))) {
        // Prometió mandarle un presupuesto: primero va la reunión.
        console.warn('El modelo prometió un presupuesto antes de la reunión; se corrige.');
        return textoReunionPrimero(remitenteId);
    }
    if (reply && !temaAgregado && REGEX_DICE_AGREGADO.test(reply)) {
        // Dice que sumó un tema que nunca se sumó: se corrige con la pregunta que corresponde.
        const vig = await turnosActivosCliente(remitenteId);
        if (vig.length) {
            console.warn('El modelo dijo que agregó un tema sin hacerlo; se corrige.');
            await guardarEstadoProposito(remitenteId, { estado: 'tema', proposito: 'otro_tema' });
            return preguntaTema(vig[0], Boolean((await obtenerContacto(remitenteId))?.es_cliente));
        }
    }
    return reply ? limpiarTratamiento(reply) : null;
}

// Detección del nombre del cliente (solo mientras no lo tengamos).

async function detectarNombre(texto) {
    const prompt = `Del siguiente mensaje de WhatsApp, extraé SOLO el nombre y apellido de la persona si se presenta. Respondé ÚNICAMENTE con el nombre, sin puntos ni explicaciones. Si no hay nombre, respondé NO.\n\nMensaje: "${texto}"`;
    const respuesta = await llamarGemini(
        [{ role: 'user', parts: [{ text: prompt }] }],
        { maxOutputTokens: 30, temperature: 0.1 },
        { intentos: 1 }
    );
    return limpiarNombre(respuesta);
}

// ==================== 10. Avisos al administrador ====================

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

// Mensajes enviados recientemente (para reenviarlos si el destinatario no los pudo descifrar).
const mensajesEnviados = new Map();
const MAX_ENVIADOS = 500;
function recordarEnviado(id, mensaje) {
    mensajesEnviados.set(id, { mensaje, en: Date.now() });
    if (mensajesEnviados.size > MAX_ENVIADOS) mensajesEnviados.delete(mensajesEnviados.keys().next().value);
}

// Chat por el que escribe el administrador: los avisos se mandan ahí, que es el que su teléfono descifra bien.
let jidAdminConocido = null;
async function recordarJidAdmin(jid) {
    if (!jid || jid === jidAdminConocido) return;
    jidAdminConocido = jid;
    await guardarConfig('admin_jid', jid).catch(() => {});
}

async function obtenerJidAdmin(sock) {
    if (!jidAdminConocido) jidAdminConocido = await leerConfig('admin_jid');
    if (jidAdminConocido) return jidAdminConocido;
    try {
        const [resultado] = await conLimite(Promise.resolve().then(() => sock.onWhatsApp(ADMIN_NUMBER)), LIMITE_WHATSAPP_MS, 'WhatsApp');
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


// Si el administrador le escribió a este cliente, se le reenvía la primera respuesta y lo que mande en los 5 minutos
// siguientes. Devuelve 'primera', 'siguiente' o null.
async function reenviarRespuestaAlAdmin(telefono, texto) {
    try {
        const esperando = await leerEsperandoRespuesta(telefono);
        if (!esperando) return null;
        if (esperando.respondidoEn && Date.now() - esperando.respondidoEn > 5 * 60000) return null;
        const primera = !esperando.respondidoEn;
        if (primera) await guardarConfig(`esperando_respuesta:${telefono}`, JSON.stringify({ ...esperando, respondidoEn: Date.now() }));
        const contacto = await obtenerContacto(telefono);
        let aviso = `💬 ${contacto?.nombre && contacto.nombre !== 'No indicado' ? contacto.nombre : 'El cliente'}${contacto?.numero ? ` (+${contacto.numero})` : ''} respondió:\n\n«${texto}»`;
        // Si el mensaje le proponía un horario y el cliente acepta, se deja lista la acción para el administrador.
        if (esperando.propuesta && esperando.turno_id && esAceptacionCliente(texto)) {
            const t = await obtenerTurno(esperando.turno_id);
            const f = interpretarFecha(esperando.propuesta.fecha) || (t && partesBA(t.inicio).fecha);
            const h = normalizarHora(esperando.propuesta.hora);
            if (t && t.estado === 'confirmado' && f && h) {
                const inicio = desdeBA(f, h);
                if (inicio.getTime() !== new Date(t.inicio).getTime()) {
                    await guardarConfig('accion_pendiente', JSON.stringify({ nombre: 'mover_reunion', args: { turno_id: t.id, fecha: f, hora: h, cliente_acepto: true }, creada: Date.now() }));
                    aviso += `\n\n¿Paso la reunión #${t.id} del ${etiquetaTurno(t.inicio)} al ${etiquetaTurno(inicio)}? Respondé *sí* y queda hecho.`;
                } else if (leerCambio(t)) {
                    await guardarConfig('accion_pendiente', JSON.stringify({ nombre: 'descartar_cambio', args: { turno_id: t.id }, creada: Date.now() }));
                    aviso += `\n\nMantiene la reunión del ${etiquetaTurno(t.inicio)}. ¿Descarto el cambio de horario pendiente (${etiquetaTurno(leerCambio(t).inicio)})? No le aviso nada al cliente. Respondé *sí*.`;
                } else {
                    aviso += `\n\nMantiene la reunión del ${etiquetaTurno(t.inicio)}. No hace falta hacer nada.`;
                }
            }
        }
        await enviarAAdmin(aviso);
        anotarAvisoEnHistorialAdmin(aviso);
        return primera ? 'primera' : 'siguiente';
    } catch (e) {
        console.error('Reenvío al admin:', e.message);
        return null;
    }
}

// ==================== 11. Asistente del administrador ====================
// Desde el número del administrador se habla con el bot en lenguaje natural. Las acciones que afectan a un cliente
// o a la agenda se confirman antes de hacerlas ("¿Confirmo?").

const P_TURNO = { turno_id: { type: 'INTEGER', description: 'Número de turno (#), sacado de ver_agenda o buscar_turnos.' } };

const HERRAMIENTAS_ADMIN = [
    { name: 'estado_bot', description: 'Estado técnico del bot: WhatsApp, base de datos, Gemini y Google Calendar.', parameters: { type: 'OBJECT', properties: {} } },
    {
        name: 'ver_agenda', description: 'Reuniones (con su número, si están en Google Calendar y si tienen un cambio de horario en trámite) y pedidos pendientes de los próximos días.',
        parameters: { type: 'OBJECT', properties: { dias: { type: 'INTEGER', description: 'Cantidad de días (por defecto 7).' } } }
    },
    {
        name: 'buscar_turnos', description: 'Busca reuniones y pedidos vigentes por nombre del cliente, fecha y/o hora. Devuelve el número (#) de cada turno.',
        parameters: { type: 'OBJECT', properties: {
            texto: { type: 'STRING', description: 'Nombre o apellido del cliente, opcional.' },
            fecha: { type: 'STRING', description: 'AAAA-MM-DD, opcional.' },
            hora: { type: 'STRING', description: 'HH:MM, opcional.' } } }
    },
    {
        name: 'ver_disponibilidad', description: 'Franjas de atención de cada día (horario normal, feriados y cambios cargados).',
        parameters: { type: 'OBJECT', properties: { dias: { type: 'INTEGER', description: 'Cantidad de días (por defecto 7).' } } }
    },
    {
        name: 'confirmar', description: 'Confirma un pedido de turno (crea la reunión con Meet y avisa al cliente) o un cambio de horario en trámite (mueve la reunión y avisa al cliente).',
        parameters: { type: 'OBJECT', properties: P_TURNO, required: ['turno_id'] }
    },
    {
        name: 'rechazar', description: 'Rechaza un pedido de turno (le ofrece otros horarios al cliente) o un cambio de horario pedido por el cliente (su reunión se mantiene).',
        parameters: { type: 'OBJECT', properties: P_TURNO, required: ['turno_id'] }
    },
    {
        name: 'proponer_horario', description: 'Le propone al cliente otro horario (para su pedido o para su reunión confirmada). Si acepta, queda hecho solo. Usala cuando el cliente todavía no aceptó el horario nuevo.',
        parameters: { type: 'OBJECT', properties: { ...P_TURNO, fecha: { type: 'STRING', description: 'AAAA-MM-DD (si se omite, el mismo día).' }, hora: { type: 'STRING', description: 'HH:MM' } }, required: ['turno_id', 'hora'] }
    },
    {
        name: 'mover_reunion', description: 'Mueve una reunión confirmada a otro horario sin volver a preguntarle al cliente (si se omiten fecha y hora, aplica el cambio en trámite). Actualiza Google Calendar y avisa al cliente con un solo mensaje.',
        parameters: { type: 'OBJECT', properties: { ...P_TURNO,
            fecha: { type: 'STRING', description: 'AAAA-MM-DD (si se omite, el mismo día).' },
            hora: { type: 'STRING', description: 'HH:MM' },
            cliente_acepto: { type: 'BOOLEAN', description: 'true SOLO si el cliente ya aceptó ese horario o el administrador dijo que ya lo habló con él.' } }, required: ['turno_id'] }
    },
    {
        name: 'descartar_cambio', description: 'Descarta SIN avisarle al cliente un cambio de horario en trámite (la reunión sigue igual) o un pedido que ya no hace falta.',
        parameters: { type: 'OBJECT', properties: P_TURNO, required: ['turno_id'] }
    },
    {
        name: 'cancelar_turno', description: 'Cancela una reunión o pedido, borra el evento del calendario y avisa al cliente. NO la uses para cambiar el horario.',
        parameters: { type: 'OBJECT', properties: P_TURNO, required: ['turno_id'] }
    },
    {
        name: 'cambiar_duracion', description: 'Alarga o acorta una reunión confirmada ("agregale 30 minutos", "que termine a las 13:45").',
        parameters: { type: 'OBJECT', properties: { ...P_TURNO,
            hasta: { type: 'STRING', description: 'Nueva hora de fin, HH:MM.' },
            minutos_extra: { type: 'INTEGER', description: 'Minutos a sumar (o restar, en negativo). Usá esto o "hasta".' } }, required: ['turno_id'] }
    },
    {
        name: 'escribir_al_cliente', description: 'Le manda un mensaje de WhatsApp a un cliente de parte del Estudio. Su respuesta le llega al administrador.',
        parameters: { type: 'OBJECT', properties: {
            turno_id: { type: 'INTEGER', description: 'Turno del cliente, si se trata de una reunión.' },
            cliente: { type: 'STRING', description: 'Nombre o teléfono del cliente, si no hay turno.' },
            mensaje: { type: 'STRING', description: 'Texto final para el cliente: formal, de "usted", en nombre del Estudio, claro y breve. No copies literal la orden del administrador.' },
            propuesta_fecha: { type: 'STRING', description: 'Si el mensaje le propone un nuevo horario para su reunión: AAAA-MM-DD.' },
            propuesta_hora: { type: 'STRING', description: 'Si el mensaje le propone un nuevo horario para su reunión: HH:MM.' } }, required: ['mensaje'] }
    },
    {
        name: 'agendar_reunion', description: 'Agenda una reunión NUEVA para un cliente (aparte de las que ya tenga), por ejemplo para otro tema o una consulta evaluada. Revisa que el horario esté libre. Por defecto la confirma, crea el Meet y le avisa al cliente; con consultar_cliente=true se la propone y se confirma si acepta.',
        parameters: { type: 'OBJECT', properties: {
            cliente: { type: 'STRING', description: 'Nombre o teléfono del cliente.' },
            turno_id: { type: 'INTEGER', description: 'O el número de una reunión que ya tiene ese cliente (para identificarlo).' },
            fecha: { type: 'STRING', description: 'AAAA-MM-DD' },
            hora: { type: 'STRING', description: 'HH:MM — solo una hora que haya dicho el administrador o el cliente.' },
            tema: { type: 'STRING', description: 'Tema de la reunión.' },
            consultar_cliente: { type: 'BOOLEAN', description: 'true para proponérsela en lugar de confirmarla.' } }, required: ['fecha', 'hora'] }
    },
    {
        name: 'atender_consulta', description: 'Acepta una "⚖️ Consulta para evaluar": le avisa al cliente que el asesor puede ayudarlo y le ofrece horarios (después el pedido vuelve para que lo confirmes). Si el administrador da un día y hora, usá agendar_reunion en su lugar.',
        parameters: { type: 'OBJECT', properties: { cliente: { type: 'STRING', description: 'Nombre o teléfono del cliente, tal como figura en el aviso.' } }, required: ['cliente'] }
    },
    {
        name: 'no_atender_consulta', description: 'El Estudio decide no tomar una consulta que no es de sociedades: le avisa al cliente con amabilidad.',
        parameters: { type: 'OBJECT', properties: { cliente: { type: 'STRING', description: 'Nombre o teléfono del cliente.' } }, required: ['cliente'] }
    },
    {
        name: 'resultado_negocio', description: 'Registra cómo siguió una persona (se refleja en HubSpot): si asistió o no a la reunión, si se le envió la propuesta, si contrató (ganado: también la marca como cliente) o si no siguió (perdido).',
        parameters: { type: 'OBJECT', properties: {
            cliente: { type: 'STRING', description: 'Nombre o teléfono de la persona.' },
            turno_id: { type: 'INTEGER', description: 'Número de la reunión, si se sabe.' },
            resultado: { type: 'STRING', enum: ['asistio', 'no_asistio', 'propuesta_enviada', 'ganado', 'perdido'] },
            nota: { type: 'STRING', description: 'Detalle breve que haya dado el administrador (opcional).' } }, required: ['resultado'] }
    },
    {
        name: 'armar_presupuesto', description: 'Arma un presupuesto (cualquier trámite) para un cliente cuando el administrador lo pide ("cotizale a X"). Usa los datos que juntó el bot más los que diga el administrador; el total lo pone el administrador y se envía con 3 confirmaciones.',
        parameters: { type: 'OBJECT', properties: {
            cliente: { type: 'STRING', description: 'Nombre o teléfono.' },
            tramite: { type: 'STRING', description: 'SAS, SRL, SA, Asociación Civil u otro trámite.' },
            jurisdiccion: { type: 'STRING', description: 'CABA, Provincia de Buenos Aires u otra provincia.' },
            socios: { type: 'INTEGER' },
            socio_empresa: { type: 'BOOLEAN' },
            extranjero_sin_cuit: { type: 'BOOLEAN' },
            sede: { type: 'BOOLEAN' } }, required: ['cliente'] }
    },
    {
        name: 'retomar_presupuesto', description: 'Vuelve a mostrar un presupuesto que quedó en espera para confirmarlo y enviarlo ("mandale el presupuesto a X").',
        parameters: { type: 'OBJECT', properties: { cliente: { type: 'STRING' } }, required: ['cliente'] }
    },
    {
        name: 'registrar_pago', description: 'El cliente pagó el presupuesto: negocio Ganado, pasa a cliente y le llega el formulario de datos de la SAS.',
        parameters: { type: 'OBJECT', properties: { cliente: { type: 'STRING' } }, required: ['cliente'] }
    },
    {
        name: 'registrar_inscripcion', description: 'La sociedad del cliente ya quedó inscripta (trámite terminado): lo anota y pregunta si se le pide una reseña en Google.',
        parameters: { type: 'OBJECT', properties: { cliente: { type: 'STRING' } }, required: ['cliente'] }
    },
    {
        name: 'pedir_resena', description: 'Le pide al cliente una reseña en Google AHORA (solo si el administrador lo pide explícitamente para esa persona). Es la ÚNICA forma de pedir una reseña.',
        parameters: { type: 'OBJECT', properties: { cliente: { type: 'STRING' } }, required: ['cliente'] }
    },
    {
        name: 'detener_seguimiento', description: 'Deja de mandarle los mensajes de seguimiento (días 2, 7 y 15) a una persona que no vino o pidió que la contactemos más adelante.',
        parameters: { type: 'OBJECT', properties: { cliente: { type: 'STRING', description: 'Nombre o teléfono de la persona.' } }, required: ['cliente'] }
    },
    {
        name: 'reiniciar_contacto', description: 'SOLO PARA PRUEBAS: borra todo lo que el bot sabe de UNA persona (reuniones y sus eventos en Google Calendar, conversación, ficha) para que la trate como un contacto nuevo. No le avisa nada a la persona. Nunca para "todos".',
        parameters: { type: 'OBJECT', properties: { cliente: { type: 'STRING', description: 'Nombre o teléfono de la persona.' } }, required: ['cliente'] }
    },
    {
        name: 'marcar_cliente', description: 'Marca a una persona como CLIENTE del Estudio (ya contrató alguna vez) o la vuelve a prospecto.',
        parameters: { type: 'OBJECT', properties: {
            texto: { type: 'STRING', description: 'Nombre, apellido o número de teléfono.' },
            es_cliente: { type: 'BOOLEAN', description: 'true = cliente; false = prospecto.' } }, required: ['texto'] }
    },
    {
        name: 'bloquear_horario', description: 'Bloquea un día entero o una franja para que no se ofrezcan turnos.',
        parameters: { type: 'OBJECT', properties: {
            fecha: { type: 'STRING', description: 'AAAA-MM-DD' },
            desde: { type: 'STRING', description: 'HH:MM, opcional. Sin desde/hasta se bloquea el día entero.' },
            hasta: { type: 'STRING', description: 'HH:MM, opcional.' } }, required: ['fecha'] }
    },
    {
        name: 'abrir_horario', description: 'Habilita una franja extra de atención en un día (por ejemplo, fuera del horario normal o un feriado).',
        parameters: { type: 'OBJECT', properties: { fecha: { type: 'STRING', description: 'AAAA-MM-DD' }, desde: { type: 'STRING', description: 'HH:MM' }, hasta: { type: 'STRING', description: 'HH:MM' } }, required: ['fecha', 'desde', 'hasta'] }
    },
    {
        name: 'restablecer_dia', description: 'Borra los cambios de horario de atención de un día y vuelve al horario normal.',
        parameters: { type: 'OBJECT', properties: { fecha: { type: 'STRING', description: 'AAAA-MM-DD' } }, required: ['fecha'] }
    },
    {
        name: 'agregar_regla', description: 'Agrega una instrucción permanente para cómo el bot atiende a los clientes.',
        parameters: { type: 'OBJECT', properties: { texto: { type: 'STRING' } }, required: ['texto'] }
    },
    { name: 'listar_reglas', description: 'Lista las reglas cargadas para el bot.', parameters: { type: 'OBJECT', properties: {} } },
    {
        name: 'borrar_regla', description: 'Borra una regla por su número (según listar_reglas).',
        parameters: { type: 'OBJECT', properties: { numero: { type: 'INTEGER' } }, required: ['numero'] }
    }
];

const HERRAMIENTAS_SENSIBLES = new Set(['confirmar', 'rechazar', 'proponer_horario', 'mover_reunion', 'descartar_cambio', 'cancelar_turno', 'cambiar_duracion', 'escribir_al_cliente', 'borrar_regla', 'agendar_reunion', 'atender_consulta', 'no_atender_consulta', 'reiniciar_contacto']);
// Herramientas con una hora: la hora tiene que haberla dicho el administrador o el cliente.
const CON_HORA = { proponer_horario: 'hora', mover_reunion: 'hora', agendar_reunion: 'hora', escribir_al_cliente: 'propuesta_hora', cambiar_duracion: 'hasta' };
const CON_TURNO = new Set(['confirmar', 'rechazar', 'proponer_horario', 'mover_reunion', 'descartar_cambio', 'cancelar_turno', 'cambiar_duracion']);
const VIGENCIA_ACCION_MIN = 30;
let historialAdmin = [];
let ultimoMensajeAdmin = 0;

// Nombre y teléfono del cliente para mostrar en la confirmación (así se ve a quién va).
async function nombreParaConfirmar(args) {
    if (!args.cliente) return 'el cliente';
    const c = await buscarContacto(args.cliente).catch(() => null);
    return c && !c.error ? etiquetaContacto(c) : args.cliente;
}

async function describirAccion(nombre, args) {
    const turno = args.turno_id ? await obtenerTurno(args.turno_id) : null;
    const t = turno ? descripcionTurno(turno) : `turno #${args.turno_id}`;
    const c = turno ? leerCambio(turno) : null;
    switch (nombre) {
        case 'confirmar':
            return turno?.estado === 'confirmado' && c
                ? `pasar la reunión de ${turno.nombre || 'el cliente'} del ${etiquetaTurno(turno.inicio)} al ${etiquetaTurno(c.inicio)} y avisarle`
                : `confirmar el turno ${t} y avisarle al cliente`;
        case 'rechazar':
            return turno?.estado === 'confirmado' ? `no hacer el cambio de horario de la reunión ${t} (se mantiene) y avisarle al cliente` : `rechazar el turno ${t} y ofrecerle otros horarios al cliente`;
        case 'proponer_horario': {
            const f = interpretarFecha(args.fecha) || (turno && partesBA(turno.inicio).fecha);
            return `proponerle a ${turno?.nombre || 'el cliente'} el ${f && normalizarHora(args.hora) ? etiquetaTurno(desdeBA(f, normalizarHora(args.hora))) : args.hora}`;
        }
        case 'mover_reunion': {
            const f = args.fecha ? interpretarFecha(args.fecha) : (c ? partesBA(c.inicio).fecha : turno && partesBA(turno.inicio).fecha);
            const h = args.hora ? normalizarHora(args.hora) : (c ? partesBA(c.inicio).hora : null);
            const destino = f && h ? etiquetaTurno(desdeBA(f, h)) : '(horario sin definir)';
            return `pasar la reunión de ${turno?.nombre || 'el cliente'} del ${turno ? etiquetaTurno(turno.inicio) : '?'} al ${destino}, actualizar Google Calendar y avisarle` +
                (args.cliente_acepto ? '' : '\n\n⚠️ El cliente todavía no aceptó este horario. ¿Ya lo hablaste con él? Si no, decime "preguntale" y le consulto primero');
        }
        case 'descartar_cambio': return c ? `descartar el cambio de horario de la reunión ${t} sin avisarle al cliente` : `descartar el pedido ${t} sin avisarle al cliente`;
        case 'cancelar_turno': return `cancelar el turno ${t}, borrarlo del calendario y avisarle al cliente`;
        case 'cambiar_duracion': {
            let fin = null;
            if (turno && args.hasta && normalizarHora(args.hasta)) fin = normalizarHora(args.hasta);
            else if (turno && args.minutos_extra) fin = partesBA(new Date(new Date(turno.fin).getTime() + args.minutos_extra * 60000)).hora;
            return `cambiar la reunión ${t} para que termine a las ${fin || '?'} hs (actualizo Google Calendar)`;
        }
        case 'agendar_reunion': {
            const f = interpretarFecha(args.fecha), h = normalizarHora(args.hora);
            return `${args.consultar_cliente ? 'proponerle' : 'agendarle'} a ${turno?.nombre || args.cliente || 'el cliente'} una reunión NUEVA el ${f && h ? etiquetaTurno(desdeBA(f, h)) : '(horario sin definir)'}${args.tema ? ` (${args.tema})` : ''}${args.consultar_cliente ? '' : ', crear el Meet y avisarle'}`;
        }
        case 'no_atender_consulta': return `avisarle a ${await nombreParaConfirmar(args)} que el Estudio no toma su consulta`;
        case 'reiniciar_contacto': return `borrar TODO lo que el bot sabe de ${await nombreParaConfirmar(args)} (reuniones y sus eventos en Google Calendar, conversación y ficha) para que lo trate como contacto nuevo. No se le avisa nada y no se puede deshacer`;
        case 'atender_consulta': return `avisarle a ${await nombreParaConfirmar(args)} que tomamos su consulta y ofrecerle horarios`;
        case 'escribir_al_cliente': return `enviarle a ${turno ? etiquetaContacto(turno) : await nombreParaConfirmar(args)} este mensaje por WhatsApp:\n\n«${args.mensaje || ''}»\n\nSi responde, te paso su respuesta`;
        case 'borrar_regla': return `borrar la regla ${args.numero}: "${globalAdminRules[args.numero - 1]?.regla || '(no existe)'}"`;
        default: return nombre;
    }
}

async function ejecutarAccionAdmin(nombre, args) {
    const dias = Math.min(Math.max(args.dias || 7, 1), 30);
    switch (nombre) {
        case 'estado_bot': return { texto: await estadoSistema() };
        case 'ver_agenda': return { texto: await resumenAgenda(dias) };
        case 'ver_disponibilidad': return { texto: await resumenDisponibilidad(dias) };
        case 'buscar_turnos': {
            const encontrados = await buscarTurnos(args);
            return encontrados.length
                ? { encontrados: encontrados.map(t => `${descripcionTurno(t)} · ${t.estado}`), indicacion: encontrados.length > 1 ? 'Hay más de uno: preguntale al administrador cuál.' : 'Usá este número.' }
                : { encontrados: [], indicacion: 'No hay turnos vigentes con esos datos. Decíselo y pedile el nombre del cliente o el día y la hora.' };
        }
        case 'confirmar': return confirmarTurno(args.turno_id);
        case 'rechazar': return rechazarTurno(args.turno_id);
        case 'proponer_horario': return proponerHorario(args.turno_id, args.fecha, args.hora);
        case 'mover_reunion': return moverReunion(args.turno_id, args);
        case 'descartar_cambio': return descartarCambio(args.turno_id);
        case 'cancelar_turno': return cancelarTurno(args.turno_id);
        case 'cambiar_duracion': return cambiarDuracion(args.turno_id, args);
        case 'escribir_al_cliente': return escribirAlCliente(args);
        case 'marcar_cliente': return marcarCliente(args.texto, args.es_cliente !== false);
        case 'agendar_reunion': return agendarReunion(args);
        case 'no_atender_consulta': return rechazarConsulta(args);
        case 'atender_consulta': return aceptarConsulta(args);
        case 'reiniciar_contacto': return reiniciarContacto(args);
        case 'resultado_negocio': return registrarResultado(args);
        case 'detener_seguimiento': return detenerSeguimiento(args);
        case 'armar_presupuesto': return armarPresupuestoAdmin(args);
        case 'retomar_presupuesto': return retomarPresupuesto(args);
        case 'registrar_pago': return registrarPago(args);
        case 'registrar_inscripcion': return registrarInscripcion(args);
        case 'pedir_resena': return pedirResena(args);
        case 'bloquear_horario': return agregarExcepcion('bloquear', args.fecha, args.desde, args.hasta);
        case 'abrir_horario': return agregarExcepcion('abrir', args.fecha, args.desde, args.hasta);
        case 'restablecer_dia': return restablecerDia(args.fecha);
        case 'agregar_regla': {
            if (!args.texto) return { ok: false, mensaje: 'Falta el texto de la regla.' };
            await db.query('INSERT INTO reglas_admin (regla) VALUES ($1)', [args.texto]);
            await cargarReglas();
            return { ok: true, mensaje: `Regla guardada: "${args.texto}"` };
        }
        case 'listar_reglas':
            return { texto: globalAdminRules.length ? globalAdminRules.map((r, i) => `${i + 1}. ${r.regla}`).join('\n') : 'No hay reglas cargadas.' };
        case 'borrar_regla': {
            const regla = globalAdminRules[args.numero - 1];
            if (!regla) return { ok: false, mensaje: `No existe la regla ${args.numero}.` };
            await db.query('DELETE FROM reglas_admin WHERE id = $1', [regla.id]);
            await cargarReglas();
            return { ok: true, mensaje: `Borré la regla: "${regla.regla}"` };
        }
    }
    return { ok: false, mensaje: 'Acción desconocida.' };
}

async function leerAccionPendiente() {
    const valor = await leerConfig('accion_pendiente');
    if (!valor) return null;
    try {
        const a = JSON.parse(valor);
        if (Date.now() - a.creada > VIGENCIA_ACCION_MIN * 60000) { await borrarConfig('accion_pendiente'); return null; }
        return a;
    } catch (e) {
        return null;
    }
}

async function instruccionesAdmin() {
    const pendientes = await turnosPendientesAdmin().catch(() => []);
    const consultas = await consultasEnEvaluacion().catch(() => []);
    const sinResultado = await reunionesSinResultado().catch(() => []);
    return 'Sos el asistente personal del administrador del Estudio Jurídico Jaime Irigoyen, por WhatsApp. ' +
        'Hablás en español rioplatense, de "vos", con tono cercano pero prolijo, claro y breve (2 a 5 líneas salvo que muestres una lista). Nunca uses "che" ni muletillas o expresiones informales.\n' +
        'HONESTIDAD: nunca digas que hiciste, enviaste, avisaste, cambiaste o cancelaste algo si una herramienta no lo hizo y devolvió "ok". Si no tenés una herramienta para lo que te pide, decíselo y ofrecé lo que sí podés hacer. Nunca inventes respuestas de clientes ni afirmes si algo está en Google Calendar sin mirar ver_agenda.\n' +
        'Para cualquier dato o acción usá las herramientas: nunca inventes reuniones, horarios ni estados. Usá SOLO las fechas de la tabla de abajo.\n' +
        'Cada reunión tiene UN número (#). Un cambio de horario en trámite queda dentro de la misma reunión:\n' +
        '- Si el cliente pidió un cambio, "confirmar" lo aplica y "rechazar" lo descarta avisándole que se mantiene su horario.\n' +
        '- Para cambiar el horario de una reunión: si el cliente ya aceptó (respondió que sí, o el administrador dice que ya lo habló), usá mover_reunion con cliente_acepto=true; si todavía no lo sabe, usá proponer_horario o escribir_al_cliente. Nunca canceles una reunión para cambiarla de horario.\n' +
        '- Si el cliente mantiene su horario y hay un cambio que ya no hace falta, usá descartar_cambio (no le avisa nada).\n' +
        'Para una reunión NUEVA de un cliente (otro tema, o una consulta "⚖️ para evaluar" con día y hora) usá agendar_reunion: NUNCA muevas su reunión actual para eso. ' +
        'Para aceptar una consulta "⚖️ para evaluar" sin día ni hora ("decile que sí") usá atender_consulta; para no tomarla, no_atender_consulta. Identificá al cliente por el nombre o el teléfono que figura en el aviso: nunca lo confundas con otro cliente de la conversación.\n' +
        'SEGUIMIENTO (HubSpot): cuando te diga cómo siguió una persona usá resultado_negocio: "asistió" / "no vino" → asistio / no_asistio; "le mandé la propuesta" → propuesta_enviada; "contrató", "cerramos", "pagó" → ganado (además lo marca como cliente); "no siguió", "no le interesa", "lo perdimos" → perdido. Si la reunión tiene número, pasalo en turno_id.\n' +
        'Para cargar o cambiar datos el administrador escribe "datos bancarios: …", "formulario sas: …" o "reseñas: <link>" (eso lo guarda el sistema solo). Si te pide cambiar los datos bancarios sin pasarlos, explicale que mande "datos bancarios: Banco … · Titular … · CBU … · Alias …". Nunca digas que no se pueden cambiar.\n' +
        'Si te dice que la sociedad de un cliente quedó inscripta ("X inscripta", "salió la SAS de X"), usá registrar_inscripcion: el sistema pregunta si se le pide la reseña en Google. Para pedir una reseña usá SOLO pedir_resena; nunca digas que pediste o enviaste una reseña si la herramienta no lo confirmó.\n' +
        'PRESUPUESTOS: se cotiza DESPUÉS de la reunión (cuando el administrador dice que asistió, el sistema pregunta si se cotiza). "cotizale a X …" → armar_presupuesto (el total lo pone el administrador); "mandale el presupuesto a X" → retomar_presupuesto; "X pagó" → registrar_pago; "X inscripta" → registrar_inscripcion. El envío del presupuesto lo maneja el sistema con 3 confirmaciones: vos nunca digas que lo enviaste.\n' +
        'Si te dice "no le escribas más a X" (o que no le mandes más seguimientos), usá detener_seguimiento.\n' +
        'Si te pide reiniciar, resetear o borrar a una persona para probar ("que el bot crea que es nuevo"), usá reiniciar_contacto con ESA persona. Nunca reinicies a varias juntas ni a alguien que no nombró.\n' +
        'HORAS: usá solo una hora que haya dicho el administrador o el cliente (por ejemplo "a las 17:15"). Si dicen "después de la otra reunión" o algo sin hora, preguntá a qué hora, indicando a qué hora termina la reunión actual. Nunca elijas una hora por tu cuenta.\n' +
        'En los mensajes para clientes usá el mismo trato que el bot: "Estimado/a Sr./Sra. Apellido", de usted, en nombre del Estudio.\n' +
        'Para alargar o acortar una reunión usá cambiar_duracion. Para avisarle o preguntarle algo a un cliente usá escribir_al_cliente, redactando en tono formal (si le proponés un horario, completá propuesta_fecha y propuesta_hora).\n' +
        'Si una herramienta responde "requiere_confirmacion", preguntale al administrador si confirma, repitiendo la descripción tal cual, y terminá con "¿Confirmo?". No la des por hecha.\n' +
        'Necesitás el número de turno para actuar: sacalo de ver_agenda o buscar_turnos. NUNCA inventes ni adivines un número; si hay más de uno posible, preguntá cuál. Los eventos que dicen "no es un turno del bot" no se manejan desde acá.\n' +
        'Los mensajes que empiezan con "[Aviso automático del sistema" son avisos reales que ya le llegaron al administrador (por ejemplo, respuestas de clientes con 💬): tenelos en cuenta.\n' +
        'Si te equivocás, reconocelo en una frase y decí qué quedó hecho. No prometas "prestar más atención" ni mejorar: no aprendés solo.\n' +
        'Horario normal de atención: lunes a viernes de 12 a 18 hs. Turnos de 30 min + 15 de margen. Cada pedido trae especialidad, motivo e interés del cliente.\n\n' +
        `Hoy es ${fechaHoyCompleta()}. Tabla de fechas:\n${calendarioReferencia()}\n\n` +
        (pendientes.length ? `Esperando tu decisión:\n${pendientes.map(descripcionTurno).join('\n')}` : 'No hay pedidos esperando tu decisión.') +
        (consultas.length ? `\nConsultas para evaluar:\n${consultas.map(c => `• ${etiquetaContacto(c.contacto)}: ${c.area} — ${c.resumen}`).join('\n')}` : '') +
        (sinResultado.length ? `\nReuniones terminadas que esperan saber si la persona asistió:\n${sinResultado.map(descripcionTurno).join('\n')}` : '');
}

// Avisos del sistema y acciones hechas con un "sí" directo quedan en la conversación del asistente.
function anotarAvisoEnHistorialAdmin(aviso) {
    recordarEnHistorialAdmin('[Aviso automático del sistema, no lo escribió el administrador]', aviso);
}

function recordarEnHistorialAdmin(textoAdmin, respuesta) {
    if (Date.now() - ultimoMensajeAdmin > 2 * 60 * 60 * 1000) historialAdmin = [];
    ultimoMensajeAdmin = Date.now();
    historialAdmin = [...historialAdmin, { role: 'user', parts: [{ text: textoAdmin }] }, { role: 'model', parts: [{ text: respuesta }] }].slice(-12);
}

let contadorAdmin = 0; // cuenta los mensajes del administrador (para respuestas que valen solo en el mensaje siguiente)
async function procesarMensajeAdmin(sock, sender, text) {
    contadorAdmin++;
    const responder = async (t) => {
        await sock.sendMessage(sender, { text: t });
        recordarEnHistorialAdmin(text, t);
    };

    // 0a) Comandos de configuración: "formulario sas: …", "datos bancarios: …".
    const rConf = await comandoConfiguracionAdmin(text).catch(e => { console.error('Configuración:', e.message); return null; });
    if (rConf) return responder(rConf);

    // 0) Presupuesto esperando tus 3 confirmaciones (o un cambio: "dólar 1460", "total $900.000").
    const rPresu = await respuestaPresupuesto(text).catch(e => { console.error('Presupuesto:', e.message); return null; });
    if (rPresu) return responder(rPresu);

    // 0b) Un cliente pidió los datos bancarios: "sí" envía los guardados, o le pasás otros.
    const rBanco = await respuestaDatosBancarios(text).catch(e => { console.error('Datos bancarios:', e.message); return null; });
    if (rBanco) return responder(rBanco);

    // 0c) Pedido de reseña después de "X inscripta": sí / no.
    const rResena = await respuestaResena(text).catch(e => { console.error('Reseña:', e.message); return null; });
    if (rResena) return responder(rResena);

    // 0d) Después de "asistió": ¿le cotizamos? sí / no.
    const rCotizar = await respuestaCotizar(text).catch(e => { console.error('Cotizar:', e.message); return null; });
    if (rCotizar) return responder(rCotizar);

    // 1) Respuesta a una acción que quedó esperando confirmación.
    const pendiente = await leerAccionPendiente();
    if (pendiente) {
        await borrarConfig('accion_pendiente');
        if (esAfirmativo(text)) {
            const r = await ejecutarAccionAdmin(pendiente.nombre, pendiente.args);
            return responder(r.mensaje || r.texto || 'Listo.');
        }
        if (esNegativo(text)) return responder('Perfecto, no hago nada. 👍');
        // cambió de tema: se descarta la acción en espera y sigue la conversación
    }

    // 2) "Sí" o "no" directo cuando hay una sola decisión pendiente (un pedido o una consulta para evaluar).
    if (esAfirmativo(text) || esNegativo(text)) {
        const pendientes = await turnosPendientesAdmin();
        const consultas = await consultasEnEvaluacion();
        if (pendientes.length === 1 && !consultas.length) {
            const r = esAfirmativo(text) ? await confirmarTurno(pendientes[0].id) : await rechazarTurno(pendientes[0].id);
            return responder(r.mensaje);
        }
        if (consultas.length === 1 && !pendientes.length) {
            const r = esAfirmativo(text) ? await aceptarConsulta({ telefono: consultas[0].telefono }) : await rechazarConsulta({ telefono: consultas[0].telefono });
            return responder(r.mensaje);
        }
    }

    // 2b) "Asistió" / "no vino" cuando hay una sola reunión terminada esperando ese dato.
    const asistencia = asistenciaDelAdmin(text);
    if (asistencia) {
        const sin = await reunionesSinResultado();
        if (sin.length === 1) {
            const r = await registrarResultado({ turno_id: sin[0].id, resultado: asistencia });
            return responder(r.mensaje);
        }
    }

    // 3) Conversación con el asistente.
    const resenasAntes = resenasEnviadas;
    if (Date.now() - ultimoMensajeAdmin > 2 * 60 * 60 * 1000) historialAdmin = [];
    ultimoMensajeAdmin = Date.now();
    const mensajeUsuario = { role: 'user', parts: [{ text }] };
    // Un "sí" a una pregunta del asistente ("¿se lo propongo a las 16:30?") ejecuta directo, sin repreguntar.
    const ultima = historialAdmin.length ? historialAdmin[historialAdmin.length - 1] : null;
    const yaConfirmo = esAfirmativo(text) && ultima?.role === 'model' && /\?\s*$/.test(ultima.parts?.[0]?.text || '');
    // Lo que se dijo en los últimos mensajes (del administrador y respuestas de clientes): de ahí salen las horas válidas.
    const textosRecientes = [...historialAdmin.slice(-8).map(x => x.parts?.[0]?.text || '').filter(t => !/^(Listo|Entendí|Le propuse|Así quedó|Acá tenés)/.test(t)), text];
    const respuesta = await conversarConHerramientas({
        instrucciones: await instruccionesAdmin(),
        contents: [...historialAdmin, mensajeUsuario],
        herramientas: HERRAMIENTAS_ADMIN,
        generationConfig: { maxOutputTokens: 1000, temperature: 0.3 },
        maxPasos: 6,
        alAgotar: 'No logré encontrar lo que me pedís. ¿Me decís el nombre del cliente o el día y la hora de la reunión? También podés escribir "ADMIN AGENDA" para ver la lista con los números de turno.',
        ejecutar: async (nombre, args) => {
            try {
                if (CON_TURNO.has(nombre) && args.turno_id != null) {
                    const t = await obtenerTurno(args.turno_id);
                    if (!t || !ESTADOS_VIGENTES.includes(t.estado) || new Date(t.fin) <= new Date()) {
                        return { ok: false, error: `El turno #${args.turno_id} ${t ? `no está vigente (${t.estado})` : 'no existe'}. No le pidas confirmación al administrador: buscá el correcto con buscar_turnos o ver_agenda, o preguntale cuál es.` };
                    }
                }
                const campoHora = CON_HORA[nombre];
                if (campoHora && args[campoHora] && !horaMencionada(textosRecientes, normalizarHora(args[campoHora]))) {
                    return { ok: false, error: `Nadie dijo las ${normalizarHora(args[campoHora])}. No inventes horarios: preguntale al administrador a qué hora (si hace falta, decile a qué hora termina la reunión actual).` };
                }
                const avisarCliente = nombre === 'mover_reunion' && !args.cliente_acepto;
                if (HERRAMIENTAS_SENSIBLES.has(nombre) && (!yaConfirmo || avisarCliente)) {
                    const descripcion = await describirAccion(nombre, args);
                    await guardarConfig('accion_pendiente', JSON.stringify({ nombre, args, descripcion, creada: Date.now() }));
                    return { requiere_confirmacion: true, descripcion: `Entendí: ${descripcion}.` };
                }
                return await ejecutarAccionAdmin(nombre, args);
            } catch (e) {
                console.error(`Error en herramienta de admin ${nombre}:`, e.message);
                return { ok: false, mensaje: `Error: ${e.message}` };
            }
        }
    });

    let texto = respuesta || 'Perdón, no pude procesar eso ahora (Gemini no respondió). Probá de nuevo en un minuto o usá un comando, por ejemplo "ADMIN AGENDA".';
    // El asistente no puede decir que pidió una reseña si no se envió ninguna en este mensaje.
    if (respuesta && resenasEnviadas === resenasAntes && /rese[ñn]a/i.test(respuesta) && /\b(ped[ií]|le ped[ií]|envi[ée]|mand[ée]|solicit[ée]|qued[óo] (pedid|enviad))/i.test(respuesta) && !/\bno le (ped[ií]|envi[ée]|mand[ée])/i.test(respuesta)) {
        texto = '⚠️ No le pedí ninguna reseña todavía. Para pedírsela escribí: *pedile la reseña a <nombre>*.';
    }
    await sock.sendMessage(sender, { text: texto });
    if (respuesta) recordarEnHistorialAdmin(text, texto);
}
// ==================== 12. Tareas programadas ====================

const RECORDATORIOS_CLIENTE = [
    { clave: 'c24', min: 24 * 60 },
    { clave: 'c12', min: 12 * 60 },
    { clave: 'c60', min: 60 },
    { clave: 'c15', min: 15 }
];
const RECORDATORIOS_ADMIN = [
    { clave: 'a20', min: 20 },
    { clave: 'a10', min: 10 },
    { clave: 'a5', min: 5 }
];

// Devuelve el texto del recordatorio, o null si no corresponde mandarlo (por ejemplo, si el cliente está en el flujo
// de "no puedo asistir").
function textoRecordatorioCliente(clave, t) {
    const cuando = etiquetaTurno(t.inicio);
    const hora = partesBA(t.inicio).hora;
    const saludo = t.nombre ? `, ${t.nombre}` : '';
    const linkAntes = '15 minutos antes de comenzar le enviaremos por aquí el link de Google Meet.';
    if (t.flujo) return null; // ya dijo que no puede: no insistimos con recordatorios
    switch (clave) {
        case 'c24':
            if (t.asistencia_confirmada) return null;
            return `Hola${saludo}. Le recordamos su reunión con un asesor del Estudio el ${cuando} por Google Meet.\n\n¿Va a asistir? Por favor responda *sí* o *no*.\n\n${linkAntes}`;
        case 'c12':
            if (t.asistencia_confirmada) return `Le recordamos su reunión con el Estudio el ${cuando}. 15 minutos antes le enviaremos el link de Google Meet.`;
            return `Le recordamos su reunión con el Estudio el ${cuando}. ¿Va a asistir? Responda *sí* o *no*.\n\n${linkAntes}`;
        case 'c60':
            if (t.asistencia_confirmada) return `Su reunión con el Estudio comienza en 1 hora (${hora} hs). 15 minutos antes le enviaremos el link.`;
            return `Su reunión con el Estudio comienza en 1 hora (${hora} hs). ¿Va a asistir? Responda *sí* o *no*. 15 minutos antes le enviaremos el link.`;
        case 'c15':
            return `Su reunión con el Estudio comienza en 15 minutos (${hora} hs).\n\n🎥 Link de Google Meet: ${t.meet}`;
    }
    return null;
}

function textoRecordatorioAdmin(clave, t) {
    const min = { a20: 20, a10: 10, a5: 5 }[clave];
    const estado = t.asistencia_confirmada ? ' · confirmó asistencia ✅' : (t.flujo ? ' · avisó que no podría asistir ⚠️' : ' · no respondió si asiste');
    return `⏰ En ${min} minutos: reunión con ${t.nombre || 'cliente'} (${t.producto || 'consulta'}${t.tipo === 'dudas' ? ', dudas de presupuesto' : ''})` +
        `${estado}\n🎥 ${t.meet}`;
}

// --- Seguimiento de los que no se presentan (o pidieron que los contactemos más adelante) ---
// Días 2, 7 y 15. Sale solo, de lunes a viernes de 10 a 18 (sin feriados). Se corta si la persona responde,
// pide una reunión, o si el administrador dice "no le escribas más".

const DIAS_SEGUIMIENTO = [2, 7, 15];
let respetarHorarioSeguimiento = true; // (las pruebas lo apagan para no depender de la hora)

// Primer momento hábil (lunes a viernes, 10 a 18 hs, sin feriados) a partir de una fecha.
function proximoMomentoHabil(fecha) {
    let d = new Date(fecha);
    for (let i = 0; i < 15; i++) {
        const p = partesBA(d);
        const habil = p.dow >= 1 && p.dow <= 5 && !nombreFeriado(p.fecha);
        if (habil && p.hora >= '10:00' && p.hora < '18:00') return d;
        if (habil && p.hora < '10:00') return desdeBA(p.fecha, '10:00');
        d = desdeBA(partesBA(new Date(desdeBA(p.fecha, '12:00').getTime() + 24 * 3600000)).fecha, '10:00');
    }
    return d;
}

function temaDeTurno(t) {
    const p = t?.producto || '';
    if (['SAS', 'SRL', 'SA'].includes(p)) return `la constitución de su ${p}`;
    if (p === 'Asociación Civil / ONG') return 'la constitución de su Asociación Civil';
    if (p && p !== 'Otra consulta') return `su consulta de ${p.replace(/^Otro tema:\s*/i, '')}`;
    return 'su consulta';
}

async function iniciarSeguimiento(t, motivo) {
    try {
        await db.query(`UPDATE seguimientos SET estado = 'reemplazado' WHERE telefono = $1 AND estado = 'activo'`, [t.telefono]);
        const proximo = proximoMomentoHabil(new Date(Date.now() + DIAS_SEGUIMIENTO[0] * 24 * 3600000));
        await db.query(`INSERT INTO seguimientos (telefono, turno_id, negocio_id, motivo, proximo) VALUES ($1, $2, $3, $4, $5)`,
            [t.telefono, t.id, t.negocio_id || null, motivo, proximo]);
    } catch (e) { console.error('Seguimiento (inicio):', e.message); }
}

async function detenerSeguimiento({ cliente }) {
    const c = await buscarContacto(cliente);
    if (c.error) return { ok: false, mensaje: c.error };
    const { rowCount } = await db.query(`UPDATE seguimientos SET estado = 'detenido' WHERE telefono = $1 AND estado = 'activo'`, [c.telefono]);
    return { ok: true, mensaje: rowCount ? `Listo, no le escribo más a ${etiquetaContacto(c)}.` : `${etiquetaContacto(c)} no tenía ningún seguimiento en curso.` };
}

function textoSeguimiento(paso, s, t, c, opciones) {
    const ap = c?.nombre && !/^no (indicado|detectado)$/i.test(c.nombre) ? c.nombre.trim().split(/\s+/).slice(-1)[0] : null;
    const saludo = ap ? `Hola, ${c.nombre.split(/\s+/)[0]}` : 'Hola';
    const tema = temaDeTurno(t);
    if (paso === 0) {
        const inicio = s.motivo === 'no_asistio'
            ? `${saludo}. Lamentamos no habernos podido reunir el ${t ? etiquetaTurno(t.inicio) : 'día acordado'}. Si todavía le interesa avanzar con ${tema}, con gusto reprogramamos la reunión sin cargo por Google Meet.`
            : `${saludo}. Como nos pidió, le escribimos para retomar ${tema}. Si le parece, coordinamos una reunión sin cargo por Google Meet con un asesor del Estudio.`;
        return opciones?.length
            ? `${inicio} Le propongo:\n\n${textoOpciones(opciones)}\n\nIndíquenos el número de su preferencia, o díganos qué día y hora le queda mejor.`
            : `${inicio} Díganos qué día y hora le queda bien y lo coordinamos.`;
    }
    if (paso === 1) {
        const beneficio = ['SAS', 'SRL', 'SA', 'Asociación Civil / ONG'].includes(t?.producto)
            ? 'La primera reunión es sin cargo, por Google Meet, y una vez que avanzamos presentamos la documentación en un máximo de 48 horas hábiles, con el Formulario 185 y el alta en ARCA incluidos.'
            : 'La primera reunión es sin cargo, por Google Meet, y la atiende un asesor del Estudio especializado en su tema.';
        return `${saludo}. Le escribimos para recordarle que seguimos a su disposición para ${tema}. ${beneficio}\n\nSi quiere coordinar, respóndanos por acá y le ofrecemos horarios.`;
    }
    return `${saludo}. No queremos insistir, así que este es nuestro último mensaje sobre ${tema}. Quedamos a su disposición: cuando lo necesite, escríbanos por acá y lo ayudamos con gusto.`;
}

async function revisarSeguimientos() {
    const { rows } = await db.query(`SELECT * FROM seguimientos WHERE estado = 'activo' AND proximo <= NOW() ORDER BY proximo LIMIT 20`);
    for (const s of rows) {
        // ¿Respondió, pidió una reunión, o el negocio ya se cerró? Entonces se corta.
        const { rows: [msj] } = await db.query(`SELECT COUNT(*)::int AS n FROM mensajes WHERE telefono = $1 AND rol = 'cliente' AND timestamp > $2`, [s.telefono, s.ultimo_envio || s.creado]);
        const vigentes = await turnosActivosCliente(s.telefono);
        const negocio = s.negocio_id ? await obtenerNegocio(s.negocio_id) : null;
        if (msj.n || vigentes.length || negocio?.cerrado) {
            await db.query(`UPDATE seguimientos SET estado = $2 WHERE id = $1`, [s.id, msj.n ? 'respondio' : vigentes.length ? 'reagendo' : 'cerrado']);
            continue;
        }
        if (respetarHorarioSeguimiento && proximoMomentoHabil(new Date()) > new Date()) { // fuera de horario: se corre al próximo momento hábil
            await db.query(`UPDATE seguimientos SET proximo = $2 WHERE id = $1`, [s.id, proximoMomentoHabil(new Date())]);
            continue;
        }
        const t = s.turno_id ? await obtenerTurno(s.turno_id) : null;
        const c = await obtenerContacto(s.telefono);
        const paso = s.paso;
        let opciones = null;
        if (paso === 0) {
            const libres = await horariosLibres({ tipo: 'consulta' }).catch(() => null);
            opciones = libres ? elegirOpciones(libres, 'consulta') : null;
            if (opciones?.length) {
                await guardarOpcionesOfrecidas(s.telefono, opciones, 'consulta');
                if (t) await recordarConsultaDeTurno(t);
            }
        }
        try {
            await enviarACliente(s.telefono, textoSeguimiento(paso, s, t, c, opciones));
        } catch (e) {
            console.error('Seguimiento (envío):', e.message);
            continue; // se reintenta en la próxima vuelta
        }
        const quien = etiquetaContacto(c || t || {}, 'el cliente');
        const siguiente = paso + 1;
        if (siguiente < DIAS_SEGUIMIENTO.length) {
            const base = new Date(s.creado).getTime();
            const proximo = proximoMomentoHabil(new Date(Math.max(base + DIAS_SEGUIMIENTO[siguiente] * 24 * 3600000, Date.now() + 24 * 3600000)));
            await db.query(`UPDATE seguimientos SET paso = $2, ultimo_envio = NOW(), proximo = $3 WHERE id = $1`, [s.id, siguiente, proximo]);
            await enviarAAdmin(`📨 Seguimiento (día ${DIAS_SEGUIMIENTO[paso]}) enviado a ${quien}${paso === 0 ? ' · le ofrecí reprogramar' : ''}. Si querés que no le escriba más, decime "no le escribas más a ${c?.nombre || 'esa persona'}".`, { anotar: true });
        } else {
            await db.query(`UPDATE seguimientos SET paso = $2, ultimo_envio = NOW(), estado = 'terminado' WHERE id = $1`, [s.id, siguiente]);
            if (negocio && !negocio.cerrado) await actualizarNegocio(negocio.id, { etapa: 'Perdido' }, 'Sin respuesta al seguimiento de 15 días');
            await enviarAAdmin(`📨 Último seguimiento (día 15) enviado a ${quien}. No respondió en 15 días${negocio ? ', así que el negocio pasó a *Perdido*' : ''}. Si vuelve a escribir, se abre una consulta nueva.`, { anotar: true });
        }
    }
}

async function seguimientosActivos(telefono = null) {
    const { rows } = telefono
        ? await db.query(`SELECT * FROM seguimientos WHERE estado = 'activo' AND telefono = $1`, [telefono])
        : await db.query(`SELECT * FROM seguimientos WHERE estado = 'activo'`);
    return rows;
}

// --- Informe semanal (lunes a las 9:00, o cuando pidas "ADMIN INFORME") ---

function sumarDias(fecha, n) {
    return partesBA(new Date(desdeBA(fecha, '12:00').getTime() + n * 24 * 3600000)).fecha;
}
function lunesDe(fecha) {
    const dow = partesBA(desdeBA(fecha, '12:00')).dow;
    return sumarDias(fecha, -((dow + 6) % 7));
}
const fechaDM = f => `${f.slice(8, 10)}/${f.slice(5, 7)}`;
const pct = (a, b) => b ? `${Math.round(100 * a / b)}%` : '—';

async function informeSemanal(ahora = new Date()) {
    const hoy = partesBA(ahora).fecha;
    const lunesPasado = sumarDias(lunesDe(hoy), -7);
    const desde = desdeBA(lunesPasado, '00:00'), hasta = desdeBA(lunesDe(hoy), '00:00');
    const r = [desde, hasta];
    const q = async (sql, params = r) => (await db.query(sql, params)).rows;

    const consultas = await q(`SELECT * FROM negocios WHERE creado_en >= $1 AND creado_en < $2`);
    const porEsp = {};
    for (const g of consultas) {
        const e = String(g.especialidad || 'Sin definir').startsWith('Otro tema') ? 'Otros temas' : (g.especialidad || 'Sin definir');
        porEsp[e] = (porEsp[e] || 0) + 1;
    }
    const interes = { alto: 0, medio: 0, bajo: 0 };
    for (const g of consultas) if (interes[g.interes] !== undefined) interes[g.interes]++;
    const otros = consultas.filter(g => String(g.titulo || '').startsWith('Otro tema'));
    const otrosNo = otros.filter(g => g.etapa === 'Perdido').length;
    const conReunion = (await q(`SELECT COUNT(DISTINCT negocio_id)::int AS n FROM turnos WHERE negocio_id = ANY($1)`, [consultas.map(g => g.id)]))[0].n;

    const [t] = await q(`SELECT
        COUNT(*) FILTER (WHERE creado_en >= $1 AND creado_en < $2)::int AS pedidas,
        COUNT(*) FILTER (WHERE estado = 'confirmado' AND inicio >= $1 AND inicio < $2 AND inicio < NOW())::int AS realizadas,
        COUNT(*) FILTER (WHERE estado = 'confirmado' AND inicio >= $1 AND inicio < $2 AND resultado = 'asistio')::int AS asistieron,
        COUNT(*) FILTER (WHERE estado = 'confirmado' AND inicio >= $1 AND inicio < $2 AND resultado = 'no_asistio')::int AS no_vinieron,
        COUNT(*) FILTER (WHERE estado IN ('cancelado', 'cancelado_cliente') AND actualizado_en >= $1 AND actualizado_en < $2)::int AS canceladas
        FROM turnos`);
    const ev = {};
    for (const e of await q(`SELECT etapa, COUNT(*)::int AS n FROM eventos_negocio WHERE creado >= $1 AND creado < $2 GROUP BY etapa`)) ev[e.etapa] = e.n;

    const L = [`📊 *Informe semanal* · semana del ${fechaDM(lunesPasado)} al ${fechaDM(sumarDias(lunesPasado, 4))}`, ''];
    const sinMovimiento = !consultas.length && !t.pedidas && !t.realizadas && !t.canceladas && !Object.keys(ev).length;
    L.push('*La semana pasada*');
    if (sinMovimiento) L.push('Sin movimiento: no hubo consultas nuevas ni reuniones.');
    else {
        L.push(`💬 Consultas nuevas: ${consultas.length}${Object.keys(porEsp).length ? ` (${Object.entries(porEsp).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`);
        if (consultas.length) L.push(`🔥 Interés: alto ${interes.alto} · medio ${interes.medio} · bajo ${interes.bajo}`);
        L.push(`📅 Reuniones: ${t.pedidas} pedidas · ${t.realizadas} realizadas (✅ ${t.asistieron} asistieron, 🚫 ${t.no_vinieron} no vinieron) · ${t.canceladas} canceladas`);
        L.push(`📄 Propuestas enviadas: ${ev['Propuesta enviada'] || 0} · 🏆 Ganados: ${ev['Ganado'] || 0} · ❌ Perdidos: ${ev['Perdido'] || 0}`);
        if (otros.length) L.push(`⚖️ Otros temas: ${otros.length} (${otros.length - otrosNo} en curso o atendidas, ${otrosNo} no las tomamos)`);
        L.push(`📈 Conversión: consulta → reunión ${pct(conReunion, consultas.length)} · reunión → ganado ${pct(ev['Ganado'] || 0, t.asistieron)}`);
    }

    L.push('', '*Próximos 7 días*');
    const agenda = await q(`SELECT * FROM turnos WHERE estado = 'confirmado' AND inicio > NOW() AND inicio < NOW() + INTERVAL '7 days' ORDER BY inicio`, []);
    if (!agenda.length) L.push('🗓️ No hay reuniones confirmadas.');
    else {
        let dia = null;
        for (const x of agenda) {
            const f = partesBA(x.inicio).fecha;
            if (f !== dia) { dia = f; L.push(`🗓️ *${etiquetaFecha(desdeBA(f, '12:00'))}*`); }
            L.push(`   • ${partesBA(x.inicio).hora} ${x.nombre || 'Cliente'} · ${x.producto || 'Consulta'} (#${x.id})`);
        }
    }
    const pend = await turnosPendientesAdmin();
    if (pend.length) L.push(`⏳ Esperando tu aprobación: ${pend.length}`, ...pend.map(x => `   • ${descripcionTurno(x)}`));
    const segs = await q(`SELECT s.*, c.nombre FROM seguimientos s LEFT JOIN contactos c ON c.telefono = s.telefono WHERE s.estado = 'activo' AND s.proximo < NOW() + INTERVAL '7 days' ORDER BY s.proximo`, []);
    if (segs.length) L.push(`📨 Seguimientos que salen: ${segs.length}`, ...segs.map(s => `   • ${s.nombre || 'Contacto'} · día ${DIAS_SEGUIMIENTO[s.paso] || '?'} · ${etiquetaFecha(s.proximo)}`));

    const viejas = await q(`SELECT * FROM negocios WHERE etapa = 'Propuesta enviada' AND NOT cerrado AND actualizado_en < NOW() - INTERVAL '7 days' ORDER BY actualizado_en`, []);
    const sinDato = await q(`SELECT * FROM turnos WHERE estado = 'confirmado' AND resultado IS NULL AND fin < NOW() AND fin > NOW() - INTERVAL '30 days' ORDER BY inicio`, []);
    if (viejas.length || sinDato.length) {
        L.push('', '*Necesita tu atención*');
        for (const g of viejas) {
            const c = await obtenerContacto(g.telefono);
            L.push(`📄 ${etiquetaContacto(c || {}, 'Contacto')} · ${g.titulo}: propuesta enviada hace ${Math.floor((Date.now() - new Date(g.actualizado_en)) / 86400000)} días sin novedad`);
        }
        for (const x of sinDato) L.push(`❓ ¿${x.nombre || 'El cliente'} asistió a la reunión del ${etiquetaTurno(x.inicio)} (#${x.id})? Respondeme "asistió" o "no vino".`);
    }
    return L.join('\n');
}

async function revisarInformeSemanal(ahora = new Date()) {
    const p = partesBA(ahora);
    if (p.dow !== 1 || p.hora < '09:00') return;
    const clave = `informe_semanal:${p.fecha}`;
    if (await leerConfig(clave)) return;
    await guardarConfig(clave, 'enviado');
    await enviarAAdmin(await informeSemanal(ahora), { anotar: true });
    return true;
}

let revisandoTareas = false;
let revisandoDesde = 0;
let ultimaVueltaTareas = 0;

async function revisarTareas() {
    if (revisandoTareas && Date.now() - revisandoDesde > 5 * 60000) {
        console.error('⚠️ Tareas programadas: la vuelta anterior quedó trabada más de 5 minutos; se libera.');
        revisandoTareas = false;
    }
    if (revisandoTareas || !dbOk || !isConnected) return;
    revisandoTareas = true;
    revisandoDesde = Date.now();
    try {
        const ahora = Date.now();

        // Feriados: se actualizan una vez por día y se avisa si alguna reunión cae en uno.
        if (ahora - feriadosRevisadosEn > 24 * 3600000) await cargarFeriados().catch(e => console.error('Feriados:', e.message));
        if (ahora - feriadosAvisadosEn > 24 * 3600000) { feriadosAvisadosEn = ahora; await avisarTurnosEnFeriados(); }

        // Pedidos sin respuesta del administrador: vencen 1 hora antes; segundo aviso a la hora.
        const { rows: pendientes } = await db.query(`SELECT * FROM turnos WHERE estado = 'pendiente_admin'`);
        for (const t of pendientes) {
            if (new Date(t.inicio).getTime() - ahora < 60 * 60000) {
                await actualizarTurno(t.id, { estado: 'vencido', cambio: null });
                await recordarConsultaDeTurno(t);
                await hsSinReunion(t, 'El pedido venció sin confirmación');
                await enviarACliente(t.telefono, `Disculpe, no pudimos confirmar a tiempo la reunión del ${etiquetaTurno(t.inicio)}. Si lo desea, le ofrezco nuevos horarios.`).catch(() => {});
                await enviarAAdmin(`⌛ El pedido #${t.id} de ${t.nombre || 'un cliente'} (${etiquetaTurno(t.inicio)}) venció sin confirmación. Le avisé al cliente.`);
                continue;
            }
            if (!t.segundo_aviso && t.avisado_admin_en && ahora - new Date(t.avisado_admin_en).getTime() > 60 * 60000) {
                await actualizarTurno(t.id, { segundo_aviso: true });
                await avisarPedidoAlAdmin(t, true);
            }
        }

        // Cambios de horario en trámite dentro de reuniones confirmadas.
        const { rows: conCambio } = await db.query(`SELECT * FROM turnos WHERE estado = 'confirmado' AND cambio IS NOT NULL`);
        for (const t of conCambio) {
            const c = leerCambio(t);
            if (!c) continue;
            const limite = Math.min(c.inicio.getTime(), new Date(t.inicio).getTime()) - 60 * 60000;
            if (ahora > limite) {
                await actualizarTurno(t.id, { cambio: null });
                if (c.origen === 'cliente') {
                    await enviarACliente(t.telefono, `Disculpe, no pudimos confirmar a tiempo el cambio al ${etiquetaTurno(c.inicio)}. Su reunión del ${etiquetaTurno(t.inicio)} se mantiene.`).catch(() => {});
                    await enviarAAdmin(`⌛ El pedido de cambio de ${t.nombre || 'un cliente'} (reunión #${t.id}, al ${etiquetaTurno(c.inicio)}) venció sin respuesta. Se mantiene el ${etiquetaTurno(t.inicio)} y le avisé al cliente.`);
                } else {
                    await enviarAAdmin(`⌛ ${t.nombre || 'El cliente'} no respondió tu propuesta de pasar la reunión #${t.id} al ${etiquetaTurno(c.inicio)}. Se mantiene el ${etiquetaTurno(t.inicio)}.`);
                }
                continue;
            }
            if (c.origen === 'cliente' && !t.segundo_aviso && t.avisado_admin_en && ahora - new Date(t.avisado_admin_en).getTime() > 60 * 60000) {
                await actualizarTurno(t.id, { segundo_aviso: true });
                await avisarPedidoAlAdmin(t, true);
            }
        }

        // Recordatorios de reuniones confirmadas.
        const { rows: confirmados } = await db.query(
            `SELECT * FROM turnos WHERE estado = 'confirmado' AND inicio > NOW() AND inicio < NOW() + INTERVAL '25 hours'`);
        for (const t of confirmados) {
            const inicio = new Date(t.inicio).getTime();
            const hechos = t.recordatorios || {};
            const nuevos = { ...hechos };
            for (const r of [...RECORDATORIOS_CLIENTE, ...RECORDATORIOS_ADMIN]) {
                if (hechos[r.clave]) continue;
                const momento = inicio - r.min * 60000;
                if (ahora < momento) continue;
                const ventana = Math.min(30, r.min / 2) * 60000;
                nuevos[r.clave] = ahora < momento + ventana ? 'enviado' : 'omitido';
                if (nuevos[r.clave] === 'omitido') continue;
                if (r.clave.startsWith('c')) {
                    const texto = textoRecordatorioCliente(r.clave, t);
                    if (!texto) { nuevos[r.clave] = 'no_corresponde'; continue; }
                    await enviarACliente(t.telefono, texto).catch(e => console.error('Recordatorio:', e.message));
                } else await enviarAAdmin(textoRecordatorioAdmin(r.clave, t));
            }
            if (JSON.stringify(nuevos) !== JSON.stringify(hechos)) await actualizarTurno(t.id, { recordatorios: JSON.stringify(nuevos) });
        }

        // Al terminar una reunión: te pregunta si la persona asistió (para el seguimiento en HubSpot).
        const { rows: terminadas } = await db.query(
            `SELECT * FROM turnos WHERE estado = 'confirmado' AND resultado IS NULL AND fin < NOW() - INTERVAL '10 minutes' AND fin > NOW() - INTERVAL '6 hours'
             AND (recordatorios->>'post') IS NULL`);
        for (const t of terminadas) {
            await actualizarTurno(t.id, { recordatorios: JSON.stringify({ ...(t.recordatorios || {}), post: 'enviado' }) });
            const c = await obtenerContacto(t.telefono);
            await enviarAAdmin(`📋 Terminó la reunión #${t.id} con ${etiquetaContacto(c || t, t.nombre || 'el cliente')} (${t.producto || 'consulta'}, ${etiquetaTurno(t.inicio)}).\n\n¿Asistió? Respondé *asistió* o *no vino*. Después podés decirme "le mandé la propuesta", "contrató" o "no siguió".`, { anotar: true });
        }

        // Seguimiento de los que no se presentaron o pidieron que los contactemos más adelante.
        await revisarSeguimientos().catch(e => console.error('Seguimientos:', e.message));
        // Informe semanal: lunes a las 9.
        await revisarInformeSemanal().catch(e => console.error('Informe semanal:', e.message));

        ultimaVueltaTareas = Date.now();
    } catch (e) {
        console.error('Error en tareas programadas:', e.message);
    } finally {
        revisandoTareas = false;
    }
}

// HubSpot va aparte de las demás tareas: un problema en otra parte no lo frena.
async function revisarHubspot() {
    if (!HUBSPOT_TOKEN || !dbOk || Date.now() - ultimaSyncHubspot < 5 * 60000) return;
    await sincronizarHubspot().catch(e => console.error('HubSpot:', e.message));
}

// ==================== 12b. HubSpot (CRM) ====================
// El bot lleva sus propios "negocios" en la base (uno por consulta) y los envía a HubSpot. Si HubSpot no responde,
// el bot sigue igual y reintenta en la próxima revisión: nunca se traba una reunión por HubSpot.

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN || '';
const ETAPAS_NEGOCIO = ['Consulta', 'Reunión pedida', 'Reunión confirmada', 'Asistió', 'No asistió', 'Propuesta enviada', 'Ganado', 'Perdido'];
const RESULTADOS = { asistio: 'Asistió', no_asistio: 'No asistió', propuesta_enviada: 'Propuesta enviada', ganado: 'Ganado', perdido: 'Perdido' };
let etapasHubspot = null;      // { pipeline, ids, faltan, leidas }
let ultimoErrorHubspot = null; // { mensaje, en }
let ultimaSyncHubspot = 0;
let avisoEtapasEnviado = false;

function apiHubspot(metodo, ruta, cuerpo = null) {
    return solicitudHttps(metodo, `https://api.hubapi.com${ruta}`, {
        headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
        cuerpo
    });
}

function fechaCorta(d = new Date()) {
    const p = partesBA(d);
    return `${p.fecha.slice(8, 10)}/${p.fecha.slice(5, 7)} ${p.hora}`;
}

// --- Negocios locales ---

async function negociosAbiertos(telefono) {
    const { rows } = await db.query(`SELECT * FROM negocios WHERE telefono = $1 AND NOT cerrado ORDER BY id DESC`, [telefono]);
    return rows;
}

async function obtenerNegocio(id) {
    const { rows } = await db.query('SELECT * FROM negocios WHERE id = $1', [id]);
    return rows[0] || null;
}

function programarSyncHubspot() {
    if (!HUBSPOT_TOKEN || process.env.HUBSPOT_SYNC_MANUAL) return;
    clearTimeout(programarSyncHubspot.timer);
    programarSyncHubspot.timer = setTimeout(() => sincronizarHubspot().catch(e => console.error('HubSpot:', e.message)), 3000);
}

// Abre un negocio para la consulta (o usa el que ya está abierto). nuevo=true: uno aparte (otro tema), salvo que ya
// exista uno abierto con el mismo título.
async function abrirNegocio(telefono, { especialidad = null, motivo = null, interes = null, titulo = null, nuevo = false, nota = null } = {}) {
    if (!dbOk) return null;
    const tit = String(titulo || especialidad || 'Consulta').slice(0, 200); // el tema; el nombre se agrega al enviarlo
    const abiertos = await negociosAbiertos(telefono);
    let g = nuevo ? abiertos.find(x => x.titulo === tit) : abiertos[0];
    if (!g) {
        const { rows } = await db.query(
            `INSERT INTO negocios (telefono, titulo, especialidad, motivo, interes, historial) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [telefono, tit, especialidad, motivo, interes, `${fechaCorta()} · Consulta por WhatsApp${nota ? ` (${nota})` : ''}`]);
        g = rows[0];
    } else {
        const campos = {};
        if (especialidad && !g.especialidad) campos.especialidad = especialidad;
        if (motivo && motivo !== g.motivo) campos.motivo = motivo;
        if (interes && interes !== g.interes) campos.interes = interes;
        if (Object.keys(campos).length) await actualizarNegocio(g.id, campos, nota);
        else if (nota) await actualizarNegocio(g.id, {}, nota);
    }
    programarSyncHubspot();
    return g;
}

async function actualizarNegocio(id, campos = {}, nota = null) {
    const g = await obtenerNegocio(id);
    if (!g) return null;
    if (nota) campos.historial = `${g.historial ? g.historial + '\n' : ''}${fechaCorta()} · ${nota}`.slice(-5000);
    if (campos.etapa) campos.cerrado = ['Ganado', 'Perdido'].includes(campos.etapa);
    if (campos.etapa && campos.etapa !== g.etapa) {
        await db.query('INSERT INTO eventos_negocio (negocio_id, telefono, etapa) VALUES ($1, $2, $3)', [id, g.telefono, campos.etapa]).catch(() => {});
    }
    const claves = Object.keys(campos);
    const sets = claves.map((k, i) => `${k} = $${i + 2}`).join(', ');
    await db.query(`UPDATE negocios SET ${sets}${sets ? ', ' : ''}sincronizado = FALSE, actualizado_en = NOW() WHERE id = $1`, [id, ...claves.map(k => campos[k])]);
    programarSyncHubspot();
    return obtenerNegocio(id);
}

// El negocio de una reunión: el que tiene asignado, o el abierto del contacto (o uno nuevo).
async function negocioDeTurno(t, { nuevo = false } = {}) {
    if (t.negocio_id) { const g = await obtenerNegocio(t.negocio_id); if (g) return g; }
    const g = await abrirNegocio(t.telefono, { especialidad: t.producto, motivo: t.motivo, interes: t.interes, nuevo });
    if (g) await db.query('UPDATE turnos SET negocio_id = $2 WHERE id = $1', [t.id, g.id]);
    return g;
}

// Ganchos desde el resto del bot. Nunca cortan el flujo si algo falla.
async function hsPedido(t, { separada = false } = {}) {
    try {
        const g = await negocioDeTurno(t, { nuevo: separada });
        if (g) await actualizarNegocio(g.id, { etapa: 'Reunión pedida' }, `Pidió reunión para el ${etiquetaTurno(t.inicio)} (#${t.id})${separada ? ' · reunión aparte' : ''}`);
    } catch (e) { console.error('HubSpot (pedido):', e.message); }
}

async function hsConfirmada(t, nota = null) {
    try {
        const g = await negocioDeTurno(t);
        if (g) await actualizarNegocio(g.id, { etapa: 'Reunión confirmada' }, nota || `Reunión confirmada para el ${etiquetaTurno(t.inicio)} (#${t.id})`);
    } catch (e) { console.error('HubSpot (confirmada):', e.message); }
}

async function hsNota(t, nota) {
    try {
        const g = await negocioDeTurno(t);
        if (g) await actualizarNegocio(g.id, {}, nota);
    } catch (e) { console.error('HubSpot (nota):', e.message); }
}

// La reunión no se hace (cancelada, vencida, sin disponibilidad): si no le queda otra, el negocio vuelve a "Consulta".
async function hsSinReunion(t, nota) {
    try {
        if (!t.negocio_id) return;
        const g = await obtenerNegocio(t.negocio_id);
        if (!g || g.cerrado) return;
        const { rows: [o] } = await db.query(`SELECT COUNT(*)::int AS n FROM turnos WHERE negocio_id = $1 AND id <> $2 AND estado = ANY($3) AND fin > NOW()`, [g.id, t.id, ESTADOS_VIGENTES]);
        const campos = o.n === 0 && ['Reunión pedida', 'Reunión confirmada'].includes(g.etapa) ? { etapa: 'Consulta' } : {};
        await actualizarNegocio(g.id, campos, `${nota} (#${t.id}, ${etiquetaTurno(t.inicio)})`);
    } catch (e) { console.error('HubSpot (sin reunión):', e.message); }
}

async function hsContactoCambio(telefono) {
    try {
        await db.query('UPDATE contactos SET hubspot_sincronizado = FALSE WHERE telefono = $1', [telefono]);
        programarSyncHubspot();
    } catch (e) { /* sigue */ }
}

// --- El administrador registra cómo siguió: asistió, no asistió, propuesta enviada, ganado, perdido ---

async function registrarResultado({ cliente, turno_id, resultado, nota }) {
    const etapa = RESULTADOS[resultado];
    if (!etapa) return { ok: false, mensaje: 'Decime si asistió, no asistió, se le envió la propuesta, contrató o no siguió.' };
    let t = turno_id ? await obtenerTurno(turno_id) : null;
    let telefono = t?.telefono || null;
    if (!telefono && cliente) {
        const c = await buscarContacto(cliente);
        if (c.error) return { ok: false, mensaje: c.error };
        telefono = c.telefono;
    }
    if (!telefono) return { ok: false, mensaje: 'Decime de qué cliente se trata.' };
    let g = t ? await negocioDeTurno(t) : null;
    if (!g) {
        const abiertos = await negociosAbiertos(telefono);
        if (abiertos.length > 1) return { ok: false, mensaje: `Tiene ${abiertos.length} consultas abiertas: ${abiertos.map(x => `"${x.titulo}"`).join(' y ')}. ¿Cuál? (o decime el número de la reunión)` };
        g = abiertos[0] || null;
        if (!g) {
            const { rows: [ult] } = await db.query(`SELECT * FROM turnos WHERE telefono = $1 ORDER BY inicio DESC LIMIT 1`, [telefono]);
            if (ult) { t = ult; g = await negocioDeTurno(ult); } else g = await abrirNegocio(telefono, {});
        }
    }
    if (!t) { const { rows: [ult] } = await db.query(`SELECT * FROM turnos WHERE negocio_id = $1 ORDER BY inicio DESC LIMIT 1`, [g.id]); t = ult || null; }
    if (t && ['asistio', 'no_asistio'].includes(resultado)) await db.query('UPDATE turnos SET resultado = $2 WHERE id = $1', [t.id, resultado]);
    let extraSeg = '';
    if (t && resultado === 'no_asistio') {
        await iniciarSeguimiento({ ...t, negocio_id: g.id }, 'no_asistio');
        extraSeg = ' En 2 días hábiles le escribo para ofrecerle reprogramar (y a los 7 y 15 días si no responde).';
    }
    if (['asistio', 'propuesta_enviada', 'ganado', 'perdido'].includes(resultado)) await db.query(`UPDATE seguimientos SET estado = 'cerrado' WHERE telefono = $1 AND estado = 'activo'`, [telefono]);
    await actualizarNegocio(g.id, { etapa }, `${etapa}${nota ? `: ${nota}` : ''}`);
    let extra = '';
    if (resultado === 'ganado') {
        await db.query('UPDATE contactos SET es_cliente = TRUE, hubspot_sincronizado = FALSE WHERE telefono = $1', [telefono]);
        extra = ' Además quedó marcado como ⭐ cliente.';
    }
    const c = await obtenerContacto(telefono);
    const oferta = resultado === 'asistio' ? await ofrecerCotizacion(telefono, g).catch(e => { console.error('Ofrecer cotización:', e.message); return null; }) : null;
    return { ok: true, mensaje: `Listo, ${etiquetaContacto(c || {}, 'el cliente')}: "${g.titulo}" pasó a *${etapa}*.${extra}${extraSeg}${HUBSPOT_TOKEN ? '' : ' (HubSpot todavía no está conectado: queda guardado y se envía cuando cargues HUBSPOT_TOKEN.)'}${oferta ? `\n\n${oferta}` : ''}` };
}

// Reuniones que ya terminaron y esperan que digas si la persona asistió.
async function reunionesSinResultado() {
    const { rows } = await db.query(`SELECT * FROM turnos WHERE estado = 'confirmado' AND resultado IS NULL AND recordatorios->>'post' = 'enviado' AND fin > NOW() - INTERVAL '3 days' ORDER BY inicio`);
    return rows;
}

function asistenciaDelAdmin(texto) {
    const t = normalizarTexto(texto);
    if (/^(no )?(no asistio|no vino|no se conecto|no aparecio|falto|no show|no estuvo)\b/.test(t)) return 'no_asistio';
    if (/^(si )?(asistio|vino|se conecto|estuvo|participo)\b/.test(t)) return 'asistio';
    return null;
}

// --- Envío a HubSpot ---

async function cargarEtapasHubspot() {
    if (etapasHubspot && Date.now() - etapasHubspot.leidas < 6 * 3600000) return etapasHubspot;
    const r = await apiHubspot('GET', '/crm/v3/pipelines/deals');
    if (r.status !== 200) throw new Error(`no pude leer el pipeline (${r.status}${r.json?.category ? ' ' + r.json.category : ''})`);
    const lista = r.json?.results || [];
    const p = lista.find(x => x.id === 'default') || lista[0];
    if (!p) throw new Error('la cuenta no tiene ningún pipeline de negocios');
    const ids = {};
    for (const s of p.stages || []) ids[normalizarTexto(s.label)] = s.id;
    etapasHubspot = { pipeline: p.id, ids, faltan: ETAPAS_NEGOCIO.filter(e => !ids[normalizarTexto(e)]), leidas: Date.now() };
    if (etapasHubspot.faltan.length && !avisoEtapasEnviado) {
        avisoEtapasEnviado = true;
        await enviarAAdmin(`⚠️ En HubSpot faltan estas etapas del negocio: ${etapasHubspot.faltan.join(', ')}. Revisalas en Configuración → Objetos → Negocios → Pipelines (el nombre tiene que coincidir).`);
    }
    return etapasHubspot;
}

function separarNombre(nombre) {
    const partes = String(nombre || '').replace(/^(sr|sra|srta|dr|dra)\.?\s+/i, '').trim().split(/\s+/).filter(Boolean);
    if (!partes.length) return {};
    return { firstname: partes[0], ...(partes.length > 1 ? { lastname: partes.slice(1).join(' ') } : {}) };
}

function propiedadesContacto(c, { crear = false } = {}) {
    const p = {};
    if (c.nombre && !/^no (indicado|detectado)$/i.test(c.nombre)) Object.assign(p, separarNombre(c.nombre));
    if (c.numero) p.phone = `+${c.numero}`;
    if (c.email && REGEX_EMAIL.test(c.email)) p.email = c.email.trim().toLowerCase();
    if (c.es_cliente) p.lifecyclestage = 'customer';
    else if (crear) p.lifecyclestage = 'lead';
    return p;
}

// Devuelve el id del contacto en HubSpot (lo busca por teléfono o lo crea).
// crear=false: solo actualiza; si lo borraron en HubSpot, no lo vuelve a crear.
async function contactoHubspot(telefono, { crear = true } = {}) {
    const { rows: [c] } = await db.query('SELECT * FROM contactos WHERE telefono = $1', [telefono]);
    if (!c) return null;
    if (c.hubspot_borrado && !crear) {
        await db.query('UPDATE contactos SET hubspot_sincronizado = TRUE WHERE telefono = $1', [telefono]);
        return null;
    }
    let id = c.hubspot_borrado ? null : c.hubspot_id;
    if (!id && c.numero) {
        const r = await apiHubspot('POST', '/crm/v3/objects/contacts/search', { filterGroups: [{ filters: [{ propertyName: 'phone', operator: 'EQ', value: `+${c.numero}` }] }], limit: 1 });
        if (r.status === 200 && r.json?.results?.length) id = r.json.results[0].id;
    }
    if (!id) {
        const r = await apiHubspot('POST', '/crm/v3/objects/contacts', { properties: propiedadesContacto(c, { crear: true }) });
        if (r.status === 201 || r.status === 200) id = r.json.id;
        else if (r.status === 409) id = (String(r.json?.message || r.texto).match(/Existing ID:\s*(\d+)/) || [])[1];
        if (!id) throw new Error(`contacto (${r.status}${r.json?.message ? ': ' + r.json.message.slice(0, 120) : ''})`);
        await db.query('UPDATE contactos SET hubspot_id = $2, hubspot_sincronizado = TRUE, hubspot_borrado = FALSE WHERE telefono = $1', [telefono, id]);
        return id;
    }
    if (id !== c.hubspot_id || !c.hubspot_sincronizado) {
        const r = await apiHubspot('PATCH', `/crm/v3/objects/contacts/${id}`, { properties: propiedadesContacto(c) });
        if (r.status === 404) {
            // Lo borraron en HubSpot: se respeta. Solo se vuelve a crear si llega una consulta nueva de esa persona.
            await db.query('UPDATE contactos SET hubspot_borrado = TRUE, hubspot_sincronizado = TRUE WHERE telefono = $1', [telefono]);
            return crear ? contactoHubspot(telefono, { crear: true }) : null;
        }
        if (r.status !== 200) throw new Error(`contacto (${r.status})`);
        await db.query('UPDATE contactos SET hubspot_id = $2, hubspot_sincronizado = TRUE WHERE telefono = $1', [telefono, id]);
    }
    return id;
}

function descripcionNegocio(g, c) {
    return [
        'Origen: WhatsApp (bot del Estudio)',
        c?.numero ? `Teléfono: +${c.numero}` : null,
        g.especialidad ? `Especialidad: ${g.especialidad}` : null,
        g.interes ? `Interés: ${g.interes}` : null,
        g.motivo ? `Motivo: ${g.motivo}` : null,
        '',
        '— Historial —',
        g.historial || ''
    ].filter(x => x !== null).join('\n').slice(0, 6000);
}

async function enviarNegocio(g, et) {
    if (g.borrado_hubspot) { await db.query('UPDATE negocios SET sincronizado = TRUE WHERE id = $1', [g.id]); return 'borrado'; }
    const c = await obtenerContacto(g.telefono);
    const contactoId = c ? await contactoHubspot(g.telefono, { crear: !g.hubspot_id }) : null;
    const nombre = c?.nombre && !/^no (indicado|detectado)$/i.test(c.nombre) ? c.nombre : (c?.numero ? `+${c.numero}` : 'Contacto de WhatsApp');
    const properties = { dealname: `${nombre} · ${g.titulo || 'Consulta'}`.slice(0, 250), pipeline: et.pipeline, description: descripcionNegocio(g, c) };
    const etapa = et.ids[normalizarTexto(g.etapa)];
    if (etapa) properties.dealstage = etapa;
    if (g.monto_usd != null) properties.amount = String(g.monto_usd);
    if (g.cerrado) properties.closedate = new Date(g.actualizado_en || Date.now()).toISOString();
    let id = g.hubspot_id;
    if (id) {
        const r = await apiHubspot('PATCH', `/crm/v3/objects/deals/${id}`, { properties });
        if (r.status === 404) {
            // Lo borraron en HubSpot: no se vuelve a crear.
            await db.query('UPDATE negocios SET borrado_hubspot = TRUE, sincronizado = TRUE, error = NULL WHERE id = $1', [g.id]);
            return 'borrado';
        } else if (r.status !== 200) throw new Error(`negocio (${r.status}${r.json?.message ? ': ' + r.json.message.slice(0, 120) : ''})`);
    }
    if (!id) {
        const cuerpo = { properties };
        if (contactoId) cuerpo.associations = [{ to: { id: contactoId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }] }];
        const r = await apiHubspot('POST', '/crm/v3/objects/deals', cuerpo);
        if (r.status !== 201 && r.status !== 200) throw new Error(`negocio (${r.status}${r.json?.message ? ': ' + r.json.message.slice(0, 120) : ''})`);
        id = r.json.id;
    }
    // Queda como enviado, salvo que haya cambiado mientras se enviaba (la base guarda microsegundos; JavaScript, milisegundos).
    await db.query(`UPDATE negocios SET hubspot_id = $2, error = NULL,
        sincronizado = (actualizado_en < $3::timestamptz + INTERVAL '1 millisecond') WHERE id = $1`, [g.id, id, g.actualizado_en]);
    return 'enviado';
}

let sincronizandoHubspot = false;
let sincronizandoDesde = 0;
let ultimaSyncOkHubspot = null;
async function sincronizarHubspot() {
    if (sincronizandoHubspot && Date.now() - sincronizandoDesde > 5 * 60000) sincronizandoHubspot = false; // quedó trabado: se libera
    if (!HUBSPOT_TOKEN || !dbOk || sincronizandoHubspot) return { omitido: true };
    sincronizandoHubspot = true;
    sincronizandoDesde = Date.now();
    const r = { enviados: 0, contactos: 0, borrados: 0, errores: 0, detalle: [], pipeline: null };
    try {
        ultimaSyncHubspot = Date.now();
        const et = await cargarEtapasHubspot();
        r.pipeline = { faltan: et.faltan };
        const { rows: negocios } = await db.query('SELECT * FROM negocios WHERE NOT sincronizado ORDER BY id LIMIT 30');
        for (const g of negocios) {
            try {
                const res = await enviarNegocio(g, et);
                if (res === 'borrado') r.borrados++; else r.enviados++;
            } catch (e) {
                r.errores++;
                r.detalle.push(`Negocio "${g.titulo}": ${e.message}`);
                ultimoErrorHubspot = { mensaje: e.message, en: new Date() };
                await db.query('UPDATE negocios SET error = $2 WHERE id = $1', [g.id, e.message.slice(0, 300)]);
            }
        }
        const { rows: contactos } = await db.query('SELECT telefono FROM contactos WHERE hubspot_id IS NOT NULL AND NOT hubspot_sincronizado LIMIT 30');
        for (const c of contactos) {
            try { if (await contactoHubspot(c.telefono, { crear: false })) r.contactos++; } catch (e) {
                r.errores++; r.detalle.push(`Contacto: ${e.message}`); ultimoErrorHubspot = { mensaje: e.message, en: new Date() };
            }
        }
        if (!r.errores) { ultimoErrorHubspot = null; ultimaSyncOkHubspot = new Date(); }
    } catch (e) {
        ultimoErrorHubspot = { mensaje: e.message, en: new Date() };
        r.errores++;
        r.detalle.push(e.message);
    } finally {
        sincronizandoHubspot = false;
    }
    if (r.enviados || r.contactos || r.borrados || r.errores) {
        console.log(`🧲 HubSpot: ${r.enviados} negocio(s) y ${r.contactos} contacto(s) enviados, ${r.borrados} borrado(s) en HubSpot (no se recrean), ${r.errores} error(es)${r.detalle.length ? ' — ' + r.detalle.join(' | ') : ''}`);
    }
    return r;
}

// "ADMIN HUBSPOT": envía ya y cuenta qué pasó.
async function informeHubspot() {
    if (!HUBSPOT_TOKEN) return '🧲 HubSpot no está conectado: falta la variable HUBSPOT_TOKEN en Railway.';
    ultimaSyncHubspot = 0;
    etapasHubspot = null; // vuelve a leer el pipeline: así se prueba la conexión de verdad
    const r = await sincronizarHubspot();
    if (r.omitido) return '🧲 Ya hay un envío a HubSpot en curso. Probá de nuevo en un minuto.';
    const { rows: [p] } = await db.query('SELECT COUNT(*)::int AS n FROM negocios WHERE NOT sincronizado');
    const lineas = ['🧲 *HubSpot*', ''];
    lineas.push(r.pipeline ? `✅ Pipeline leído${r.pipeline.faltan.length ? ` · ⚠️ faltan etapas: ${r.pipeline.faltan.join(', ')}` : ' · las 8 etapas están'}` : '❌ No pude leer el pipeline');
    lineas.push(`📤 Negocios enviados: ${r.enviados}`);
    lineas.push(`👤 Contactos actualizados: ${r.contactos}`);
    if (r.borrados) lineas.push(`🗑️ Borrados en HubSpot (no se vuelven a crear): ${r.borrados}`);
    lineas.push(`⏳ Quedan pendientes: ${p.n}`);
    if (r.errores) lineas.push('', `❌ Errores (${r.errores}):`, ...r.detalle.slice(0, 5).map(d => `• ${d}`));
    else lineas.push('', 'Todo en orden.');
    return lineas.join('\n');
}

async function estadoHubspot() {
    if (!HUBSPOT_TOKEN) return '🧲 HubSpot: ⚠️ sin conectar (falta HUBSPOT_TOKEN en Railway)';
    const { rows: [p] } = await db.query('SELECT COUNT(*)::int AS n FROM negocios WHERE NOT sincronizado');
    const { rows: [t] } = await db.query('SELECT COUNT(*)::int AS n FROM negocios');
    const { rows: [b] } = await db.query('SELECT COUNT(*)::int AS n FROM negocios WHERE borrado_hubspot');
    const lineas = [`🧲 HubSpot: ${ultimoErrorHubspot ? `❌ ${ultimoErrorHubspot.mensaje}` : (ultimaSyncOkHubspot ? '✅ conectado' : '⏳ conectado, todavía sin envíos en esta sesión')}`,
        `   • Negocios: ${t.n} (pendientes de enviar: ${p.n})`,
        `   • Último envío correcto: ${ultimaSyncOkHubspot ? formatoFecha(ultimaSyncOkHubspot) : 'todavía ninguno desde que se encendió'}`];
    if (b.n) lineas.push(`   • Borrados en HubSpot (no se recrean): ${b.n}`);
    if (etapasHubspot?.faltan?.length) lineas.push(`   • Faltan etapas: ${etapasHubspot.faltan.join(', ')}`);
    return lineas.join('\n');
}

// ==================== 13. Comandos de respaldo ====================
// Funcionan aunque Gemini esté saturado.

const REGEX_COMANDO_ADMIN = /^ADMIN\s+(ESTADO|MODELOS|CONECTAR\s+GOOGLE|AGENDA|AYUDA|HUBSPOT|INFORME)$/i;

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
    return new Date(fecha).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hourCycle: 'h23' });
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
    lineas.push(await estadoHubspot().catch(e => `🧲 HubSpot: ❌ ${e.message}`));
    lineas.push(`💳 Datos bancarios: ${await leerConfig('datos_bancarios').catch(() => null) ? '✅ cargados' : '⚠️ sin cargar ("datos bancarios: …")'} · 📋 Formulario SAS: ${await leerConfig('formulario_sas_url').catch(() => null) ? '✅ cargado' : '⚠️ sin cargar'} · ⭐ Reseñas: ✅ ${await leerConfig('resenas_url').catch(() => null) ? 'link propio' : 'link del perfil'}`);
    const { rows: [sg] } = await db.query(`SELECT COUNT(*)::int AS n FROM seguimientos WHERE estado = 'activo'`).catch(() => ({ rows: [{ n: 0 }] }));
    lineas.push(`📨 Seguimientos en curso (no vinieron / contactar más adelante): ${sg.n}`);
    const haceMin = ultimaVueltaTareas ? Math.round((Date.now() - ultimaVueltaTareas) / 60000) : null;
    lineas.push(`⏰ Tareas programadas (recordatorios): ${haceMin === null ? '⏳ todavía no corrieron' : haceMin <= 3 ? `✅ última vuelta hace ${haceMin} min` : `❌ última vuelta hace ${haceMin} min (deberían correr cada minuto)`}`);
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

    if (/^ADMIN\s+INFORME$/i.test(comando)) {
        await sock.sendMessage(sender, { text: await informeSemanal() });
        return;
    }

    if (/^ADMIN\s+HUBSPOT$/i.test(comando)) {
        await sock.sendMessage(sender, { text: await informeHubspot() });
        return;
    }

    if (/^ADMIN\s+AYUDA$/i.test(comando)) {
        await sock.sendMessage(sender, { text:
            '💬 Podés hablarme normal, por ejemplo: "¿qué tengo esta semana?", "el jueves no puedo", "el viernes atiendo de 14 a 16", "confirmale a Juan", "agregá una regla: ...".\n\n' +
            '🛠️ *Comandos exactos (respaldo)*\n\n' +
            '• ADMIN ESTADO: estado de WhatsApp, base, Gemini y agenda\n' +
            '• ADMIN MODELOS: modelos de Gemini disponibles\n' +
            '• ADMIN CONECTAR GOOGLE: link para conectar Google Calendar\n' +
            '• ADMIN AGENDA: reuniones de los próximos 7 días, con su número\n' +
            '• ADMIN HUBSPOT: envía ya lo pendiente a HubSpot y te dice qué pasó\n' +
            '• ADMIN INFORME: el informe semanal (llega solo los lunes a las 9)'
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
        await sock.sendMessage(sender, { text: '📅 *Próximos 7 días*\n\n' + await resumenAgenda(7) });
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

}

// ==================== 14. WhatsApp y arranque ====================

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        // Si el teléfono de destino no puede descifrar un mensaje ("Esperando el mensaje"), WhatsApp pide reenviarlo:
        // getMessage le entrega a la librería el contenido guardado para que lo vuelva a mandar.
        getMessage: async (key) => mensajesEnviados.get(key.id)?.mensaje
    });
    const enviarOriginal = sock.sendMessage.bind(sock);
    sock.sendMessage = async (jid, contenido, opciones) => {
        const enviado = await enviarOriginal(jid, contenido, opciones);
        if (enviado?.key?.id && enviado.message) recordarEnviado(enviado.key.id, enviado.message);
        return enviado;
    };
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

                // Un archivo o foto de un cliente con presupuesto enviado (posible comprobante): se te reenvía.
                if (!esAdmin(msg) && await procesarArchivoCliente(sock, msg, sender).catch(e => { console.error('Archivo:', e.message); return false; })) continue;

                if (!text.trim()) continue;

                const numero = numeroCliente(msg);
                console.log(`[MSG] ${sender}${numero ? ` (+${numero})` : ''}: ${text}`);

                // El administrador: comandos exactos o conversación natural. Nunca se lo atiende como cliente.
                if (esAdmin(msg)) {
                    recordarJidAdmin(sender);
                    await sock.sendPresenceUpdate('composing', sender).catch(() => {});
                    if (REGEX_COMANDO_ADMIN.test(text.trim())) await procesarComandoAdmin(sock, sender, text);
                    else await procesarMensajeAdmin(sock, sender, text);
                    continue;
                }

                registrarMensajeCliente(sender, text);
                await guardarMensaje(sender, 'cliente', text, numero);
                const reenvio = await reenviarRespuestaAlAdmin(sender, text);

                // Buscar el nombre solo mientras el contacto no lo tenga guardado.
                const contacto = await obtenerContacto(sender);
                if (!contacto || !contacto.nombre || contacto.nombre === 'No indicado') {
                    const nombreDetectado = await detectarNombre(text);
                    if (nombreDetectado) await actualizarContacto(sender, 'nombre', nombreDetectado);
                }

                await sock.sendPresenceUpdate('composing', sender);
                const respuestaAI = await consultarGemini(sender, text, { respuestaAlAsesor: reenvio === 'primera' });
                if (respuestaAI === '') continue; // el sistema ya le respondió al cliente por su cuenta
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


app.listen(PORT, async () => {
    console.log(`Servidor web activo en el puerto ${PORT}`);
    if (!GEMINI_API_KEY) console.warn('⚠️ Falta GEMINI_API_KEY.');
    if (!ADMIN_NUMBER) console.warn('ℹ️ ADMIN_NUMBER no configurado.');
    console.log(`Modelo Gemini: ${GEMINI_MODEL}${GEMINI_MODELOS_RESPALDO.length ? ` (respaldo: ${GEMINI_MODELOS_RESPALDO.join(', ')})` : ''}`);
    console.log(`Sesión de WhatsApp en: ${AUTH_FOLDER}`);
    await inicializarDB();
    if (dbOk) await cargarReglas();
    if (dbOk) await cargarFeriados().catch(e => console.error('Feriados:', e.message));
    setTimeout(connectToWhatsApp, 5000);
    setInterval(revisarTareas, 60 * 1000);
    setInterval(revisarHubspot, 60 * 1000);
});

module.exports = {
    // utilidades y fechas
    limpiarNombre, filasAHistorial, numeroCliente, soloDigitos, emailDesdeIdToken, partesBA, desdeBA, etiquetaTurno,
    interpretarFecha, calendarioReferencia, horaMencionada, esAfirmativo, esNegativo, esAfirmativoCliente, esNegativoCliente, esAceptacionCliente,
    // agenda
    franjasDelDia, elegirOpciones, horariosLibres, cargarFeriados, nombreFeriado, fechaPascua, feriadosCalculados,
    resumenDisponibilidad, resumenAgenda, avisarTurnosEnFeriados,
    // turnos
    obtenerTurno, turnosActivosCliente, reiniciarContacto, propositoDirecto, propositoDeTexto, extraerTema, leerConfig, sincronizarHubspot, informeHubspot, formularioCompletado, procesarArchivoCliente, comandoConfiguracionAdmin, registrarInscripcion, respuestaResena, pedirResena, respuestaCotizar, ofrecerCotizacion, anotarDatosCotizacion, leerDatosCotizacion, normalizarTramite, tipoJurisdiccion, REGEX_DATOS_BANCO, calcularPresupuesto, respuestaPresupuesto, registrarPago, obtenerDolarOficial, textoPresupuestoCliente, informeSemanal, revisarInformeSemanal, lunesDe, abrirNegocio, actualizarNegocio, revisarSeguimientos, iniciarSeguimiento, procesarRespuestaAsistencia, guardarMensaje, proximoMomentoHabil, textoSeguimiento, formatoFecha, revisarHubspot, enviarACliente, enviarAAdmin, procesarComandoAdmin, estadoSistema, registrarResultado, reunionesSinResultado, estadoHubspot, asistenciaDelAdmin, leerCambio, confirmarTurno, rechazarTurno, proponerHorario, moverReunion, descartarCambio, cancelarTurno, cambiarDuracion,
    // bots
    ejecutarHerramientaCliente, consultarGemini, construirInstrucciones, textoRecordatorioCliente, registrarMensajeCliente,
    procesarMensajeAdmin, instruccionesAdmin, reenviarRespuestaAlAdmin, conversarConHerramientas, esTextoInterno, revisarTareas,
    // base
    inicializarDB, guardarConfig, db,
    _historialAdmin: () => historialAdmin,
    _set: (k, v) => { if (k === 'socket') socketActual = v; if (k === 'conectado') isConnected = v; if (k === 'dbOk') dbOk = v; if (k === 'horarioSeguimiento') respetarHorarioSeguimiento = v; if (k === 'dolar') dolarDelDia = v; }
};
