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

// ---------- Agenda y turnos ----------
// Horario base: lunes a viernes de 12 a 18 hs. Cada turno bloquea 45 minutos (30 de reunión + 15 de margen);
// las reuniones de dudas bloquean 30 (15 + 15). El administrador ajusta días puntuales con excepciones.

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const HORARIO_BASE = { 1: [['12:00', '18:00']], 2: [['12:00', '18:00']], 3: [['12:00', '18:00']], 4: [['12:00', '18:00']], 5: [['12:00', '18:00']] };
const BLOQUE_MIN = { consulta: 45, dudas: 30 };
const ESPECIALIDADES = ['SAS', 'SRL', 'SA', 'Mantenimiento societario', 'Transferencia', 'Disolución y cierre', 'Asociación Civil / ONG', 'Otra consulta'];
const PASO_MIN = 45;
const ANTICIPACION_MIN = 180;       // no se ofrecen turnos con menos de 3 horas
const DIAS_A_OFRECER = 10;
const TOLERANCIA_PEGADO_MIN = 15;   // un turno a menos de 15 min de otra reunión cuenta como "pegado"
const ESTADOS_OCUPAN = ['pendiente_admin', 'propuesto', 'confirmado'];
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
            `SELECT * FROM turnos WHERE estado = ANY($1) AND inicio > NOW() ORDER BY inicio`, [ESTADOS_OCUPAN]);
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

// Saca de la lista de ocupados de Google el evento del propio turno (si lo tiene), para poder moverlo.
// Google devuelve los ocupados recortados a la ventana consultada y unidos entre sí, así que la reunión propia se
// descuenta por superposición (no por coincidencia exacta).
async function sinEventoPropio(google, excluirId) {
    for (const id of [].concat(excluirId || []).filter(Boolean)) {
        const t = await obtenerTurno(id).catch(() => null);
        if (!t || !t.evento_id || t.estado !== 'confirmado') continue;
        google = restarIntervalo(google, [new Date(t.inicio).getTime(), new Date(t.fin).getTime()]).filter(([x, y]) => y > x);
    }
    return google;
}

// Describe con qué choca un horario ocupado (otra reunión del bot o un evento del calendario).
async function describirChoque(google, desde, hasta, excluirIds = []) {
    const excluir = [].concat(excluirIds || []);
    try {
        const { rows } = await db.query(
            `SELECT * FROM turnos WHERE estado = ANY($1) AND inicio < $3 AND fin > $2 ORDER BY inicio`, [ESTADOS_OCUPAN, desde, hasta]);
        const otro = rows.find(r => !excluir.includes(r.id));
        if (otro) return `choca con ${otro.estado === 'confirmado' ? 'la reunión' : 'el pedido'} de ${otro.nombre || 'otro cliente'} (${etiquetaTurno(otro.inicio)}, #${otro.id})`;
    } catch (e) { /* sin detalle */ }
    if (google?.length) return `choca con un evento de tu calendario de ${partesBA(google[0][0]).hora} a ${partesBA(google[0][1]).hora}`;
    return 'ya está ocupado';
}

async function ocupadoTurnos(desde, hasta, excluirId = null) {
    try {
        const { rows } = await db.query(
            `SELECT id, inicio, fin FROM turnos WHERE estado = ANY($1) AND fin > $2 AND inicio < $3`,
            [ESTADOS_OCUPAN, desde, hasta]);
        const excluir = [].concat(excluirId || []);
        return rows.filter(t => !excluir.includes(t.id)).map(t => [new Date(t.inicio).getTime(), new Date(t.fin).getTime()]);
    } catch (e) {
        return [];
    }
}

// Devuelve los horarios libres de los próximos días, o null si no se pudo leer la agenda.
// paso: cada cuántos minutos se generan horarios (45 para ofrecer; 15 para validar un horario pedido a mano).
// excluirId: turno del propio cliente que no debe contar como ocupado (para cambios de horario).
async function horariosLibres({ tipo = 'consulta', dias = DIAS_A_OFRECER, excluirId = null, paso = PASO_MIN } = {}) {
    const ahora = Date.now();
    const hoy = partesBA(ahora).fecha;
    const ultimo = sumarDiasFecha(hoy, dias);
    const desde = new Date(ahora);
    const hasta = desdeBA(ultimo, '23:59');

    let google = await ocupadoGoogle(desde, hasta);
    if (!google) return null;
    google = await sinEventoPropio(google, excluirId);
    const ocupado = [...google, ...(await ocupadoTurnos(desde, hasta, excluirId))];
    const excepciones = await cargarExcepciones(hoy, ultimo);
    const duracion = BLOQUE_MIN[tipo] || 45;
    const libres = [];

    for (let i = 0; i <= dias; i++) {
        const fecha = sumarDiasFecha(hoy, i);
        for (const [a, b] of franjasDelDia(fecha, excepciones)) {
            for (let m = a; m + duracion <= b; m += paso) {
                const inicio = desdeBA(fecha, horaTexto(m)).getTime();
                const fin = inicio + duracion * 60000;
                if (inicio < ahora + ANTICIPACION_MIN * 60000) continue;
                if (ocupado.some(([x, y]) => inicio < y && fin > x)) continue;
                const tol = TOLERANCIA_PEGADO_MIN * 60000;
                const pegado = ocupado.some(([x, y]) => inicio < y + tol && fin + tol > x);
                libres.push({ inicio: new Date(inicio), fin: new Date(fin), fecha, pegado });
            }
        }
    }
    return libres;
}

// Elige qué horarios ofrecer: para consultas, primero los que no quedan pegados a otra reunión y repartidos en
// distintos días; para dudas, los más cercanos.
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

async function obtenerTurno(id) {
    const { rows } = await db.query('SELECT * FROM turnos WHERE id = $1', [id]);
    return rows[0] || null;
}

// Si el cliente tiene una reunión confirmada y además un pedido de cambio en trámite, devuelve la confirmada.
async function turnoActivoCliente(telefono) {
    return (await turnosActivosCliente(telefono))[0] || null;
}

async function turnosActivosCliente(telefono) {
    const { rows } = await db.query(
        `SELECT * FROM turnos WHERE telefono = $1 AND estado = ANY($2) AND fin > NOW() ORDER BY (estado = 'confirmado') DESC, inicio`,
        [telefono, ESTADOS_OCUPAN]);
    return rows;
}

async function turnosPendientesAdmin() {
    const { rows } = await db.query(`SELECT * FROM turnos WHERE estado = 'pendiente_admin' AND inicio > NOW() ORDER BY creado_en`);
    return rows;
}

async function actualizarTurno(id, campos) {
    const claves = Object.keys(campos);
    const sets = claves.map((k, i) => `${k} = $${i + 2}`).join(', ');
    await db.query(`UPDATE turnos SET ${sets}, actualizado_en = NOW() WHERE id = $1`, [id, ...claves.map(k => campos[k])]);
}

function descripcionTurno(t) {
    return `#${t.id} · ${t.nombre || 'Sin nombre'} · ${t.producto || 'Consulta'} · ${etiquetaTurno(t.inicio)}${t.tipo === 'dudas' ? ' (dudas de presupuesto)' : ''}`;
}

// Mensajes que el sistema manda por su cuenta: quedan guardados en el historial del cliente.
async function enviarACliente(telefono, texto) {
    if (!socketActual) throw new Error('WhatsApp no está conectado');
    await socketActual.sendMessage(telefono, { text: texto });
    await guardarMensaje(telefono, 'bot', texto);
    userHistories.delete(telefono); // se recarga desde la base en el próximo mensaje
}

async function enviarAAdmin(texto) {
    if (!socketActual || !ADMIN_NUMBER) return;
    try {
        await socketActual.sendMessage(await obtenerJidAdmin(socketActual), { text: texto });
    } catch (e) {
        console.error('Error enviando mensaje al administrador:', e.message);
    }
}

function textoAvisoTurno(t, segundo = false) {
    const cambio = t.cambio_de ? `🔄 *Cambio de horario* (antes: ${t.cambio_de})\n` : '';
    return `${segundo ? '🔔 *Segundo aviso* — sigue pendiente\n\n' : ''}📅 *Pedido de turno #${t.id}*\n${cambio}\n` +
        `👤 ${t.nombre || 'Sin nombre'}${t.numero ? ` (+${t.numero})` : ''}${t.es_cliente ? ' · ⭐ Cliente' : ''}${t.email ? ` · ✉️ ${t.email}` : ''}\n` +
        `📂 Especialidad: ${t.producto || 'Sin definir'}\n` +
        `📝 Motivo: ${t.motivo || 'sin detalle'}\n` +
        (t.interes ? `${{ alto: '🔥', medio: '🙂', bajo: '🤔' }[t.interes] || '•'} Interés: ${t.interes}\n` : '') +
        `🕒 ${etiquetaTurno(t.inicio)}${t.tipo === 'dudas' ? ' · reunión de dudas (15 min)' : ''}\n\n` +
        '¿Lo confirmo? Respondé *sí* o *no*, o pedime otro horario.';
}

// reemplazaId: reunión confirmada que se libera recién cuando el asesor confirme este nuevo horario.
// cambioDe: texto del horario anterior, para el aviso al administrador.
async function crearPedidoTurno({ telefono, inicio, tipo, producto, motivo, interes = null, reemplazaId = null, cambioDe = null }) {
    const contacto = await obtenerContacto(telefono);
    const duracion = BLOQUE_MIN[tipo] || 45;
    const fin = new Date(inicio.getTime() + duracion * 60000);
    const { rows } = await db.query(
        `INSERT INTO turnos (telefono, nombre, numero, producto, motivo, tipo, inicio, fin, estado, avisado_admin_en, reemplaza_id, interes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pendiente_admin', NOW(), $9, $10) RETURNING *`,
        [telefono, contacto?.nombre || null, contacto?.numero || null, producto || null, motivo || null, tipo, inicio, fin, reemplazaId, interes]);
    const t = rows[0];
    await enviarAAdmin(textoAvisoTurno({ ...t, cambio_de: cambioDe, email: contacto?.email || null, es_cliente: contacto?.es_cliente }));
    return t;
}

// Reunión confirmada que este pedido reemplaza (si sigue vigente).
async function turnoReemplazado(t) {
    if (!t?.reemplaza_id) return null;
    const v = await obtenerTurno(t.reemplaza_id);
    return v && v.estado === 'confirmado' ? v : null;
}

// Confirma un turno: verifica que el horario siga libre, crea la reunión con Meet y avisa al cliente.
async function confirmarTurno(id) {
    const t = await obtenerTurno(id);
    if (!t) return { ok: false, mensaje: `No existe el turno #${id}.` };
    if (!['pendiente_admin', 'propuesto'].includes(t.estado)) return { ok: false, mensaje: `El turno #${id} está ${t.estado}, no se puede confirmar.` };
    if (new Date(t.inicio) <= new Date()) return { ok: false, mensaje: `El horario del turno #${id} ya pasó.` };

    const anterior = await turnoReemplazado(t);
    let google = await ocupadoGoogle(new Date(t.inicio), new Date(t.fin));
    if (google === null) return { ok: false, mensaje: 'No pude leer la agenda de Google. Revisá que esté conectada.' };
    if (anterior) google = await sinEventoPropio(google, anterior.id);
    if (google.length) {
        const choque = await describirChoque(google, new Date(t.inicio), new Date(t.fin), [t.id, anterior?.id]);
        return { ok: false, mensaje: `No pude confirmar el turno #${id} (${etiquetaTurno(t.inicio)}): ${choque}. Pedime proponerle otro horario.` };
    }

    const evento = await crearEventoConMeet({
        titulo: `${t.tipo === 'dudas' ? 'Dudas de presupuesto' : 'Consulta'} ${t.producto || ''} – ${t.nombre || 'Cliente'}`.replace(/\s+/g, ' '),
        descripcion: `WhatsApp: ${t.numero ? '+' + t.numero : t.telefono}\nProducto: ${t.producto || '-'}\nMotivo: ${t.motivo || '-'}\nTurno #${t.id} (agendado por el bot)`,
        inicio: new Date(t.inicio).toISOString(),
        fin: new Date(t.fin).toISOString()
    });
    if (!evento) return { ok: false, mensaje: 'No se pudo crear la reunión en Google Calendar.' };

    const token = require('crypto').randomBytes(16).toString('hex');
    await actualizarTurno(t.id, { estado: 'confirmado', evento_id: evento.id, meet: evento.meet, token });
    if (anterior) {
        await cancelarTurno(anterior.id, { porCliente: true, silencioso: true });
        await actualizarTurno(anterior.id, { estado: 'reprogramado' });
    }
    const duracionTxt = t.tipo === 'dudas' ? '15 minutos' : '30 minutos';
    await enviarACliente(t.telefono,
        (anterior ? `Listo, cambiamos su reunión del ${etiquetaTurno(anterior.inicio)}. ` : '') +
        `Su reunión quedó confirmada para el ${etiquetaTurno(t.inicio)} (${duracionTxt}), por Google Meet, con un asesor del Estudio.\n\n` +
        `📅 Para agregarla a su agenda: ${PUBLIC_URL}/agenda/${token}\n\n` +
        'El día anterior le preguntaremos si va a asistir, y 15 minutos antes de la reunión le enviaremos por aquí el link de Google Meet.' +
        (AVISO_GRABACION ? `\n\n${AVISO_GRABACION}` : ''));
    const feriado = nombreFeriado(partesBA(t.inicio).fecha);
    return { ok: true, mensaje: `Listo, confirmé el turno #${t.id} (${t.nombre || 'cliente'}, ${etiquetaTurno(t.inicio)}). Meet: ${evento.meet}` +
        (anterior ? `\nLiberé su reunión anterior del ${etiquetaTurno(anterior.inicio)} (#${anterior.id}).` : '') +
        (feriado ? `\n\n⚠️ Ojo: ese día es feriado (${feriado}).` : '') };
}

function textoOpciones(opciones) {
    return opciones.map((o, i) => `${i + 1}. ${etiquetaTurno(o.inicio)}`).join('\n');
}

// Rechaza un turno pendiente y le ofrece al cliente otros horarios.
async function rechazarTurno(id) {
    const t = await obtenerTurno(id);
    if (!t) return { ok: false, mensaje: `No existe el turno #${id}.` };
    if (!['pendiente_admin', 'propuesto'].includes(t.estado)) return { ok: false, mensaje: `El turno #${id} está ${t.estado}.` };
    await actualizarTurno(t.id, { estado: 'rechazado' });
    await recordarConsultaDeTurno(t);
    const anterior = await turnoReemplazado(t);
    const libres = await horariosLibres({ tipo: t.tipo, excluirId: anterior?.id });
    const opciones = libres ? elegirOpciones(libres, t.tipo).filter(o => o.inicio.getTime() !== new Date(t.inicio).getTime()) : [];
    if (opciones.length) await guardarOpcionesOfrecidas(t.telefono, opciones, t.tipo);
    const mantiene = anterior ? ` Su reunión del ${etiquetaTurno(anterior.inicio)} se mantiene.` : '';
    const texto = opciones.length
        ? `Disculpe, el asesor no tiene disponibilidad el ${etiquetaTurno(t.inicio)}.${mantiene} ${anterior ? 'Si prefiere cambiarla, le' : 'Le'} puedo ofrecer:\n\n${textoOpciones(opciones)}\n\nIndíquenos el número de su preferencia.`
        : `Disculpe, el asesor no tiene disponibilidad el ${etiquetaTurno(t.inicio)}.${mantiene}${anterior ? '' : ' En breve le propondremos un nuevo horario.'}`;
    await enviarACliente(t.telefono, texto);
    return { ok: true, mensaje: `Listo, rechacé el turno #${t.id} y le ${opciones.length ? 'ofrecí otros horarios' : 'avisé que le proponemos otro horario'} a ${t.nombre || 'el cliente'}.` };
}

// El administrador propone otro horario: queda pre aprobado y se confirma solo si el cliente acepta.
async function proponerHorario(id, fecha, hora) {
    const t = await obtenerTurno(id);
    if (!t) return { ok: false, mensaje: `No existe el turno #${id}.` };
    const h = normalizarHora(hora);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '') || !h) return { ok: false, mensaje: 'No entendí la fecha u hora propuesta.' };
    const inicio = desdeBA(fecha, h);
    if (inicio <= new Date()) return { ok: false, mensaje: 'Ese horario ya pasó.' };
    const fin = new Date(inicio.getTime() + (BLOQUE_MIN[t.tipo] || 45) * 60000);
    // Si se propone mover una reunión confirmada (o un pedido de cambio), la reunión vigente no cuenta como ocupada.
    const vigente = t.estado === 'confirmado' ? t : await turnoReemplazado(t);
    let google = await ocupadoGoogle(inicio, fin);
    if (google === null) return { ok: false, mensaje: 'No pude leer la agenda de Google.' };
    google = await sinEventoPropio(google, vigente?.id);
    const otros = (await ocupadoTurnos(inicio, fin, t.id)).filter(([x, y]) => !(vigente && x === new Date(vigente.inicio).getTime() && y === new Date(vigente.fin).getTime()));
    if (google.length || otros.length) {
        const choque = await describirChoque(google, inicio, fin, [t.id, vigente?.id]);
        return { ok: false, mensaje: `El ${etiquetaTurno(inicio)} no está libre: ${choque}.` };
    }

    if (['pendiente_admin', 'propuesto'].includes(t.estado)) await actualizarTurno(t.id, { estado: 'rechazado' });
    const { rows } = await db.query(
        `INSERT INTO turnos (telefono, nombre, numero, producto, motivo, tipo, inicio, fin, estado, reemplaza_id, interes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'propuesto', $9, $10) RETURNING *`,
        [t.telefono, t.nombre, t.numero, t.producto, t.motivo, t.tipo, inicio, fin, vigente?.id || null, t.interes || null]);
    await enviarACliente(t.telefono, `El asesor le propone reunirse el ${etiquetaTurno(inicio)} por Google Meet. ¿Le queda bien ese horario?`);
    const feriado = nombreFeriado(fecha);
    return { ok: true, mensaje: `Le propuse a ${t.nombre || 'el cliente'} el ${etiquetaTurno(inicio)} (turno #${rows[0].id}). Si acepta, se confirma solo.` +
        (feriado ? `\n\n⚠️ Ojo: ese día es feriado (${feriado}).` : '') };
}

async function cancelarTurno(id, { porCliente = false, silencioso = false } = {}) {
    const t = await obtenerTurno(id);
    if (!t) return { ok: false, mensaje: `No existe el turno #${id}.` };
    if (!ESTADOS_OCUPAN.includes(t.estado)) return { ok: false, mensaje: `El turno #${id} ya estaba ${t.estado}.` };
    if (t.evento_id) {
        const r = await apiCalendar('DELETE', `/calendars/primary/events/${encodeURIComponent(t.evento_id)}?sendUpdates=none`);
        if (![200, 204, 404, 410].includes(r.status)) console.error('No se pudo borrar el evento:', r.status, r.texto.slice(0, 200));
    }
    await actualizarTurno(t.id, { estado: porCliente ? 'cancelado_cliente' : 'cancelado' });
    await recordarConsultaDeTurno(t);
    if (silencioso) {
        // quien llama se encarga de los avisos
    } else if (porCliente) {
        await enviarAAdmin(`❌ ${t.nombre || 'Un cliente'} canceló su turno del ${etiquetaTurno(t.inicio)} (#${t.id}).`);
    } else {
        await enviarACliente(t.telefono, `Le informamos que la reunión del ${etiquetaTurno(t.inicio)} fue cancelada. Si lo desea, coordinamos un nuevo horario.`);
    }
    return { ok: true, mensaje: `Cancelé el turno #${t.id} (${t.nombre || 'cliente'}, ${etiquetaTurno(t.inicio)})${porCliente ? '' : ' y le avisé al cliente'}.` };
}

async function agregarExcepcion(tipo, fecha, desde, hasta) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '')) return { ok: false, mensaje: 'No entendí la fecha.' };
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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '')) return { ok: false, mensaje: 'No entendí la fecha.' };
    const r = await db.query('DELETE FROM excepciones_horario WHERE fecha = $1', [fecha]);
    return { ok: true, mensaje: `El ${etiquetaFecha(desdeBA(fecha, '12:00'))} volvió al horario normal${r.rowCount ? '' : ' (no tenía cambios)'}.` };
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

// Agenda para el administrador: cada reunión del bot con su número de turno, así se puede actuar sobre ella.
async function resumenAgenda(dias = 7) {
    const eventos = await eventosProximos(dias);
    const { rows: turnos } = await db.query(
        `SELECT * FROM turnos WHERE estado = ANY($1) AND fin > NOW() AND inicio < NOW() + ($2 || ' days')::interval ORDER BY inicio`,
        [ESTADOS_OCUPAN, String(dias)]);
    const porEvento = new Map(turnos.filter(t => t.evento_id).map(t => [t.evento_id, t]));
    const lineas = [];
    if (eventos === null) lineas.push('⚠️ No pude leer Google Calendar; muestro solo los turnos del bot.');
    const confirmados = turnos.filter(t => t.estado === 'confirmado');
    const otros = (eventos || []).filter(e => !porEvento.has(e.id));
    const items = [
        ...confirmados.map(t => ({ cuando: new Date(t.inicio).getTime(), texto: `• #${t.id} · ${t.nombre || 'Sin nombre'} · ${etiquetaTurno(t.inicio)} · ${t.producto || 'Consulta'}${t.asistencia_confirmada ? ' · confirmó asistencia ✅' : ''}` })),
        ...otros.map(e => {
            const ini = e.start.dateTime || e.start.date;
            return { cuando: new Date(ini).getTime(), texto: `• ${e.start.dateTime ? etiquetaTurno(ini) : etiquetaFecha(new Date(`${e.start.date}T12:00:00-03:00`)) + ' (todo el día)'} · ${e.summary || '(sin título)'} (evento del calendario, no es un turno del bot)` };
        })
    ].sort((a, b) => a.cuando - b.cuando);
    lineas.push(items.length ? `Reuniones:\n${items.map(i => i.texto).join('\n')}` : 'No hay reuniones en los próximos días.');
    const pendientes = turnos.filter(t => t.estado !== 'confirmado');
    if (pendientes.length) {
        lineas.push(`Pendientes:\n${pendientes.map(t => `• ${descripcionTurno(t)} (${t.estado === 'propuesto' ? 'esperando respuesta del cliente' : 'esperando tu confirmación'})`).join('\n')}`);
    }
    return lineas.join('\n\n');
}

async function marcarCliente(texto, esCliente = true) {
    const digitos = soloDigitos(texto || '');
    let rows;
    if (digitos.length >= 8) {
        ({ rows } = await db.query(`SELECT telefono, nombre, numero FROM contactos WHERE numero LIKE $1`, ['%' + digitos.slice(-10)]));
    } else {
        const palabras = normalizarTexto(texto || '').split(' ').filter(p => p.length > 2);
        if (!palabras.length) return { ok: false, mensaje: 'Decime el nombre o el número de la persona.' };
        ({ rows } = await db.query(`SELECT telefono, nombre, numero FROM contactos WHERE nombre IS NOT NULL`));
        rows = rows.filter(r => { const n = normalizarTexto(r.nombre); return palabras.every(w => n.includes(w)); });
    }
    if (!rows.length) return { ok: false, mensaje: `No encontré a nadie con "${texto}" entre los contactos.` };
    if (rows.length > 1) return { ok: false, mensaje: `Encontré varias personas: ${rows.map(r => `${r.nombre || 'Sin nombre'}${r.numero ? ` (+${r.numero})` : ''}`).join(', ')}. ¿Cuál es?` };
    await db.query('UPDATE contactos SET es_cliente = $1 WHERE telefono = $2', [esCliente, rows[0].telefono]);
    return { ok: true, mensaje: `Listo, ${rows[0].nombre || 'el contacto'}${rows[0].numero ? ` (+${rows[0].numero})` : ''} quedó como ${esCliente ? '⭐ cliente' : 'prospecto'}.` };
}

// Busca turnos vigentes por nombre del cliente, fecha u hora (para que el asistente encuentre el número).
async function buscarTurnos({ texto, fecha, hora } = {}) {
    const { rows } = await db.query(`SELECT * FROM turnos WHERE estado = ANY($1) AND fin > NOW() ORDER BY inicio`, [ESTADOS_OCUPAN]);
    const f = fecha ? interpretarFecha(fecha) : null;
    const h = hora ? normalizarHora(hora) : null;
    const palabras = normalizarTexto(texto || '').split(' ').filter(p => p.length > 2);
    return rows.filter(t => {
        const p = partesBA(t.inicio);
        if (f && p.fecha !== f) return false;
        if (h && p.hora !== h) return false;
        if (palabras.length) {
            const nombre = normalizarTexto(`${t.nombre || ''} ${t.producto || ''}`);
            if (!palabras.some(w => nombre.includes(w))) return false;
        }
        return true;
    });
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
        '6. PRECIOS: NUNCA des precios, montos, rangos ni estimaciones, aunque insistan. Explicá con amabilidad que el valor depende de cada caso (cantidad de socios, objeto, urgencia) y que en la reunión el asesor le arma una propuesta completa y a medida. Si aún no lo indicó, pedí su correo electrónico.\n' +
        '7. Sé conciso: máximo 2 a 4 oraciones breves. Estás respondiendo por WhatsApp. Hacé UNA pregunta por mensaje.\n' +
        '8. Servicios del Estudio: constitución de sociedades, mantenimiento societario (balances, asambleas ordinarias y extraordinarias, cambio de autoridades y gerencias), transferencias y procesos de disolución y cierre para SAS, SRL, SA, Asociaciones Civiles y ONGs.\n' +
        'PERFIL COMERCIAL (muy importante): tu objetivo es que el cliente quiera trabajar con el Estudio y llegue a la reunión interesado, sin presionarlo.\n' +
        '- Antes de ofrecer una reunión ENTENDÉ SU NECESIDAD: preguntá qué necesita (constituir una SAS, SRL o SA, mantenimiento, transferencia, cierre, Asociación Civil/ONG), y de a una pregunta por vez datos clave como cuántos socios son, a qué se va a dedicar la empresa y para cuándo lo necesita. Con 2 o 3 respuestas alcanza; no lo conviertas en un interrogatorio.\n' +
        '- Respondé las dudas GENERALES y básicas (por ejemplo, qué es una SAS, diferencias generales entre SAS y SRL, qué es el Formulario 185) con información general y correcta, para generar confianza. Aclarale que los detalles de su caso los define el asesor en la reunión. Nunca des asesoramiento específico de su caso.\n' +
        '- Destacá los BENEFICIOS del Estudio cuando vengan al caso (no todos juntos): presentación de la documentación en un máximo de 48 horas hábiles, Formulario 185 y alta en ARCA incluidos, todo el trámite online con reuniones por Google Meet, primera reunión sin cargo, y acompañamiento después de la constitución (mantenimiento, asambleas, cambios de autoridades). Si tiene apuro, resaltá la rapidez; si duda entre tipos de sociedad, decile que el asesor lo ayuda a elegir la mejor opción para su proyecto.\n' +
        '- Llevá la conversación hacia la reunión sin cargo como el paso natural para avanzar ("En la reunión el asesor le explica todo y le arma la propuesta a medida").\n' +
        '- Si dice que no, que lo va a pensar o que todavía no, respetalo: dejá la puerta abierta con amabilidad, ofrecé enviarle información por correo (pedí el correo) y no insistas más de una vez.\n' +
        '- Interés del cliente: "alto" si tiene apuro o fecha o ya decidió; "medio" si está averiguando; "bajo" si solo pregunta o duda; si no está claro, "medio".\n' +
        '- Si el cliente YA tiene una reunión y pide otra, preguntale si quiere cambiar ese horario o si es otro tema, y pasá la respuesta en "proposito" de consultar_horarios.\n' +
        '9. REUNIONES: solo cuando ya sepas el nombre, QUÉ NECESITA y, si es una constitución, al menos dos datos (cuántos socios, a qué se va a dedicar, para cuándo lo necesita), ofrecé una reunión sin cargo de 30 minutos por Google Meet con un asesor del Estudio. Si te pide una reunión de entrada, primero preguntale con amabilidad para qué es, así lo atiende el asesor indicado. ' +
        'Para ofrecer horarios usá SIEMPRE la herramienta consultar_horarios con "especialidad" y "motivo" (y "interes"): nunca inventes días ni horas. Presentá las opciones numeradas y pedí que responda solo con el número (1, 2 o 3). ' +
        'Cuando el cliente elija una opción de la lista, usá solicitar_turno con ese número en "opcion". ' +
        'Si el cliente pide un día y hora concretos (por ejemplo "¿puede ser el miércoles a las 16:30?"), usá directamente solicitar_turno con "fecha" y "hora"; si no está libre, la herramienta te devuelve las opciones más cercanas para ofrecer. ' +
        'Si pide solo un día ("¿tienen algo el jueves?") o solo una hora ("¿más tarde?", "¿a las 17?"), usá consultar_horarios con "fecha" y/o "hora". Si dice solo una hora y ya hay un turno o una propuesta para un día, se entiende que es ese mismo día. ' +
        'NUNCA digas que la reunión está confirmada: la confirmación la envía el sistema por separado.\n' +
        '10. Si el cliente tiene dudas sobre un presupuesto que ya recibió y no podés resolverlas, ofrecé una reunión de dudas de 15 minutos (tipo "dudas"), que tiene prioridad.\n' +
        '11. Si el cliente tiene un turno y quiere confirmar asistencia, cancelarlo o responder a un horario que le propuso el asesor, usá las herramientas correspondientes. ' +
        'Para CAMBIAR el horario NO lo canceles: usá solicitar_turno con el nuevo horario (se envía al asesor como pedido de cambio y la reunión actual se mantiene hasta que lo confirme). Si el asesor le propuso un horario y el cliente pide otro, también es solicitar_turno. Cancelá solo si el cliente pide cancelar sin querer otro horario.\n' +
        '12. HONESTIDAD: nunca digas que enviaste, pediste, reservaste, cancelaste o confirmaste algo si la herramienta no devolvió "ok". Si devolvió un error, explicale al cliente con amabilidad lo que pasó y ofrecé la alternativa que indique la herramienta. Nunca inventes horarios ni prometas una respuesta del asesor que no se pidió.' +
        reglasAdmin;
}

// Herramientas que puede usar el bot cuando habla con clientes.
const HERRAMIENTAS_CLIENTE = [
    {
        name: 'consultar_horarios',
        description: 'Devuelve horarios libres para una reunión por Google Meet con un asesor del Estudio. Si el cliente menciona un día y/o una hora, pasalos para buscar ese horario o los más cercanos ese día. Sirve también para cambiar el horario de un turno que ya tiene.',
        parameters: {
            type: 'OBJECT',
            properties: {
                tipo: { type: 'STRING', enum: ['consulta', 'dudas'], description: '"consulta" (30 min) o "dudas" sobre un presupuesto ya enviado (15 min, con prioridad).' },
                especialidad: { type: 'STRING', enum: ['SAS', 'SRL', 'SA', 'Mantenimiento societario', 'Transferencia', 'Disolución y cierre', 'Asociación Civil / ONG', 'Otra consulta'], description: 'Tema de la reunión, para asignar al asesor indicado.' },
                motivo: { type: 'STRING', description: 'Resumen de lo que necesita el cliente con los datos que dio (socios, actividad, urgencia, etc.).' },
                interes: { type: 'STRING', enum: ['alto', 'medio', 'bajo'], description: 'Interés según lo que dijo el cliente: "alto" si tiene apuro o una fecha, o ya decidió hacerlo; "medio" si está averiguando; "bajo" si solo pregunta o duda. Si no está claro, "medio".' },
                socios: { type: 'INTEGER', description: 'Cantidad de socios, si el cliente lo dijo.' },
                actividad: { type: 'STRING', description: 'A qué se va a dedicar la empresa, si el cliente lo dijo.' },
                plazo: { type: 'STRING', description: 'Para cuándo lo necesita, si el cliente lo dijo.' },
                proposito: { type: 'STRING', enum: ['cambio', 'otro_tema'], description: 'Solo si el cliente YA tiene una reunión: "cambio" si quiere cambiar ese horario, "otro_tema" si es una consulta distinta.' },
                fecha: { type: 'STRING', description: 'Día que pidió el cliente, AAAA-MM-DD (usá la fecha actual del contexto para calcularlo). Omitir si no pidió un día.' },
                hora: { type: 'STRING', description: 'Hora que pidió el cliente, HH:MM en 24 hs (ej. "16:30"). Omitir si no pidió una hora.' }
            },
            required: ['tipo', 'especialidad', 'motivo']
        }
    },
    {
        name: 'solicitar_turno',
        description: 'Pide al asesor un turno: una opción de la lista o un día y hora que pidió el cliente. Si el cliente ya tiene un turno, funciona como pedido de CAMBIO de horario (no hace falta cancelar antes; la reunión actual se mantiene hasta que el asesor confirme la nueva). Queda pendiente hasta que el asesor lo confirme.',
        parameters: {
            type: 'OBJECT',
            properties: {
                opcion: { type: 'INTEGER', description: 'Número de la opción que eligió el cliente (1, 2, 3...) de la última lista ofrecida. Es la forma preferida.' },
                fecha: { type: 'STRING', description: 'Si el cliente pidió un día y hora concretos: fecha AAAA-MM-DD.' },
                hora: { type: 'STRING', description: 'Si el cliente pidió un día y hora concretos: hora HH:MM (24 hs), por ejemplo "16:30".' },
                tipo: { type: 'STRING', enum: ['consulta', 'dudas'] },
                producto: { type: 'STRING', enum: ['SAS', 'SRL', 'SA', 'Mantenimiento societario', 'Transferencia', 'Disolución y cierre', 'Asociación Civil / ONG', 'Otra consulta'], description: 'Especialidad o tema principal de la consulta.' },
                motivo: { type: 'STRING', description: 'Resumen de lo que necesita el cliente con los datos que dio (socios, actividad, urgencia).' },
                interes: { type: 'STRING', enum: ['alto', 'medio', 'bajo'], description: 'Interés según lo que dijo el cliente: "alto" si tiene apuro o una fecha, o ya decidió hacerlo; "medio" si está averiguando; "bajo" si solo pregunta o duda. Si no está claro, "medio".' }
            },
            required: ['tipo']
        }
    },
    {
        name: 'confirmar_asistencia',
        description: 'Registra que el cliente confirmó que va a asistir a su reunión.',
        parameters: { type: 'OBJECT', properties: {} }
    },
    {
        name: 'responder_asistencia',
        description: 'Respuesta del cliente a la pregunta que le hizo el sistema sobre su reunión (si va a asistir, si quiere reagendar o si quiere que lo contactemos más adelante). El sistema le responde solo.',
        parameters: {
            type: 'OBJECT',
            properties: { respuesta: { type: 'STRING', enum: ['si', 'no'], description: '"si" o "no" a la última pregunta indicada en el contexto.' } },
            required: ['respuesta']
        }
    },
    {
        name: 'cancelar_mi_turno',
        description: 'Cancela el turno activo del cliente, cuando el cliente lo pide expresamente.',
        parameters: { type: 'OBJECT', properties: {} }
    },
    {
        name: 'responder_propuesta',
        description: 'Respuesta del cliente al horario alternativo que le propuso el asesor.',
        parameters: {
            type: 'OBJECT',
            properties: { acepta: { type: 'BOOLEAN', description: 'true si acepta el horario propuesto.' } },
            required: ['acepta']
        }
    }
];

// Últimas opciones ofrecidas a cada cliente, para que pueda elegir por número sin depender de que el modelo
// reconstruya la fecha (las opciones se muestran sin año).
// Qué falta saber antes de ofrecer horarios. Devuelve una indicación para el modelo, o null si ya alcanza.
const ESPECIALIDADES_CONSTITUCION = ['SAS', 'SRL', 'SA', 'Asociación Civil / ONG'];
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

// Para qué es la reunión (se guarda al ofrecer horarios y se usa al pedir el turno).
// Si un turno se cae (cancelado, rechazado, vencido), se recuerda para qué era, para ofrecer otro sin volver a preguntar.
async function recordarConsultaDeTurno(t) {
    if (!t?.telefono) return;
    await guardarDatosConsulta(t.telefono, {
        especialidad: ESPECIALIDADES.includes(t.producto) ? t.producto : 'Otra consulta',
        motivo: t.motivo || `Reprogramación de la reunión del ${etiquetaTurno(t.inicio)}`,
        interes: t.interes || null,
        completo: true // ya se indagó cuando se pidió el turno original
    });
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

// Interpreta una fecha que puede venir con el año mal puesto ("2020-10-14", "14/10", "14/10/25"): se usa el día y el mes,
// y el año es el de la próxima vez que cae esa fecha.
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

// Interpreta el horario elegido: por número de opción, o por fecha y hora (el año no importa).
function resolverHorarioElegido(args, ofrecidas) {
    if (args.opcion && ofrecidas?.opciones?.[args.opcion - 1]) return new Date(ofrecidas.opciones[args.opcion - 1].inicio);
    const hora = normalizarHora(args.hora);
    const fecha = interpretarFecha(args.fecha);
    if (!hora || !fecha) return null;
    return desdeBA(fecha, hora);
}

// Opciones cercanas a lo que pidió el cliente: ese día (lo más cerca posible de la hora pedida) o esa hora en otros días.
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
        // dentro de un mismo día, opciones separadas al menos 30 minutos
        if (elegidos.some(e => e.fecha === l.fecha && Math.abs(e.inicio - l.inicio) < 30 * 60000)) continue;
        elegidos.push(l);
    }
    return elegidos.sort((x, y) => x.inicio - y.inicio);
}

function listaOpciones(opciones) {
    return opciones.map((o, i) => ({ opcion: i + 1, texto: etiquetaTurno(o.inicio) }));
}

async function ejecutarHerramientaCliente(telefono, nombre, args) {
    try {
        if (nombre === 'consultar_horarios') {
            const tipo = args.tipo === 'dudas' ? 'dudas' : 'consulta';
            let activos = await turnosActivosCliente(telefono);
            const contacto = await obtenerContacto(telefono);
            const esCliente = Boolean(contacto?.es_cliente);
            const previa = await leerDatosConsulta(telefono);

            // Si ya tiene una reunión, primero hay que saber si quiere cambiarla o si es otro tema.
            if (activos.length && !args.proposito) {
                return { pregunta: `El cliente ya tiene ${activos[0].estado === 'confirmado' ? 'una reunión confirmada' : 'un pedido de reunión'} el ${etiquetaTurno(activos[0].inicio)}. NO ofrezcas horarios todavía: preguntale si desea cambiar ese horario o si se trata de otro tema. Con su respuesta, volvé a llamar a consultar_horarios con "proposito".` };
            }
            if (activos.length && args.proposito === 'otro_tema' && !esCliente) {
                // Prospecto: el tema nuevo se suma a la misma reunión.
                const t = activos[0];
                const tema = [args.especialidad && args.especialidad !== t.producto ? args.especialidad : null, String(args.motivo || '').trim()].filter(Boolean).join(': ');
                if (!tema) return { error: 'Preguntale cuál es el otro tema que quiere tratar.' };
                await actualizarTurno(t.id, { motivo: `${t.motivo || ''}${t.motivo ? ' | ' : ''}Tema adicional: ${tema}`.slice(0, 1000) });
                await enviarAAdmin(`📌 ${t.nombre || 'Un cliente'} agregó un tema a su reunión #${t.id} (${etiquetaTurno(t.inicio)}): ${tema}`);
                return { ok: true, tema_agregado: true, indicacion: `Decile que sumamos ese tema a su reunión del ${etiquetaTurno(t.inicio)}, así el asesor lo ve todo en la misma reunión. No ofrezcas otros horarios.` };
            }
            const separada = activos.length > 0 && args.proposito === 'otro_tema' && esCliente;
            const esCambio = activos.length > 0 && !separada;
            if (separada) activos = []; // cliente: reunión aparte, sin tocar la que ya tiene

            const motivo = String(args.motivo || '').trim() || previa?.motivo || (esCambio ? activos[0]?.motivo : '') || '';
            const especialidad = ESPECIALIDADES.includes(args.especialidad) ? args.especialidad : (previa?.especialidad || (esCambio ? activos[0]?.producto : null) || null);
            const datos = {
                especialidad, motivo, interes: args.interes || previa?.interes || null,
                socios: args.socios || previa?.socios || null, actividad: args.actividad || previa?.actividad || null, plazo: args.plazo || previa?.plazo || null,
                proposito: separada ? 'separada' : (esCambio ? 'cambio' : 'nueva'),
                completo: Boolean(previa?.completo && !args.motivo)
            };
            await guardarDatosConsulta(telefono, datos); // se guarda aunque falten datos, para ir sumándolos
            if (!esCambio) {
                const falta = faltanDatos(datos, esCliente);
                if (falta) return { error: falta };
            }
            const vigente = activos.find(t => t.estado === 'confirmado') || null;
            const fecha = args.fecha ? interpretarFecha(args.fecha) : null;
            const hora = args.hora ? normalizarHora(args.hora) : null;
            const especifico = Boolean(fecha || hora);
            const libres = await horariosLibres({ tipo, excluirId: activos.map(t => t.id), paso: especifico ? 15 : PASO_MIN });
            if (!libres) return { error: 'La agenda no está disponible en este momento. Decile que un asesor lo contactará para coordinar.' };
            let opciones = especifico ? opcionesCercanas(libres, { fecha, hora }) : elegirOpciones(libres, tipo);
            let nota = null;
            if (especifico && !opciones.length) {
                const feriado = fecha && nombreFeriado(fecha);
                nota = `No hay horarios libres ${fecha ? `el ${etiquetaFecha(desdeBA(fecha, '12:00'))}` : `a las ${hora}`}${feriado ? ` (es feriado: ${feriado})` : ''}. Ofrecé estas otras opciones.`;
                opciones = elegirOpciones(especifico ? await horariosLibres({ tipo, excluirId: activos.map(t => t.id) }) || [] : libres, tipo);
            } else if (especifico && hora && fecha && !opciones.some(o => o.fecha === fecha && partesBA(o.inicio).hora === hora)) {
                nota = `El ${etiquetaFecha(desdeBA(fecha, '12:00'))} a las ${hora} no está disponible; estas son las opciones más cercanas.`;
            } else if (especifico && hora && fecha) {
                nota = `El horario pedido está disponible (es la opción ${opciones.findIndex(o => partesBA(o.inicio).hora === hora) + 1}).`;
            }
            if (!opciones.length) return { error: 'No hay horarios libres en los próximos días. Decile que un asesor lo contactará para coordinar.' };
            await guardarOpcionesOfrecidas(telefono, opciones, tipo);
            const r = { opciones: listaOpciones(opciones), indicacion: 'Mostralas numeradas con el mismo número. Cuando el cliente elija, llamá a solicitar_turno con ese número en "opcion".' };
            if (separada) r.nota_cliente = 'Es cliente del Estudio: esta será una reunión aparte de la que ya tiene.';
            if (nota) r.nota = nota;
            if (esCambio) r.cambio = `El cliente ya tiene un turno el ${etiquetaTurno(activos[0].inicio)}. Si elige una opción, solicitar_turno lo envía como pedido de cambio de horario${vigente ? ' (su reunión actual se mantiene hasta que el asesor confirme la nueva)' : ''}.`;
            return r;
        }

        if (nombre === 'solicitar_turno') {
            const ofrecidas = await leerOpcionesOfrecidas(telefono);
            const tipo = args.tipo === 'dudas' ? 'dudas' : (ofrecidas?.tipo || 'consulta');
            const datosPrevios = await leerDatosConsulta(telefono);
            const contactoS = await obtenerContacto(telefono);
            const separadaS = Boolean(contactoS?.es_cliente) && (args.proposito === 'otro_tema' || datosPrevios?.proposito === 'separada');
            const activos = separadaS ? [] : await turnosActivosCliente(telefono);
            const vigente = activos.find(t => t.estado === 'confirmado') || null;
            const enTramite = activos.filter(t => t.estado !== 'confirmado');
            const libres = await horariosLibres({ tipo, excluirId: activos.map(t => t.id), paso: 15 });
            if (!libres) return { error: 'La agenda no está disponible. Decile que un asesor lo contactará.' };
            const inicio = resolverHorarioElegido(args, ofrecidas);
            if (!inicio) return { error: 'No pude identificar el horario elegido. Pedile que indique el día y la hora, o el número de opción.' };
            if (vigente && new Date(vigente.inicio).getTime() === inicio.getTime()) return { error: `Ese es el horario que ya tiene confirmado (${etiquetaTurno(inicio)}).` };
            // Los turnos del propio cliente no le bloquean el nuevo pedido (se excluyeron al calcular los libres).
            if (!libres.some(l => l.inicio.getTime() === inicio.getTime())) {
                const fecha = partesBA(inicio).fecha;
                let opciones = opcionesCercanas(libres.filter(l => l.inicio.getTime() !== inicio.getTime()), { fecha, hora: partesBA(inicio).hora });
                if (!opciones.length) opciones = elegirOpciones(libres, tipo);
                await guardarOpcionesOfrecidas(telefono, opciones, tipo);
                return {
                    error: `El ${etiquetaTurno(inicio)} no está disponible. NO se envió ningún pedido.`,
                    opciones: listaOpciones(opciones),
                    indicacion: 'Decíselo con claridad y ofrecé estas opciones numeradas.'
                };
            }
            const anterior = enTramite[0] || vigente;
            const datos = await leerDatosConsulta(telefono);
            const producto = ESPECIALIDADES.includes(args.producto) ? args.producto : (datos?.especialidad || anterior?.producto || null);
            const baseDatos = { ...(datos || {}), especialidad: producto, motivo: String(args.motivo || '').trim() || datos?.motivo || anterior?.motivo || '' };
            if (!anterior) {
                const falta = faltanDatos(baseDatos, Boolean(contactoS?.es_cliente));
                if (falta) return { error: `NO se envió ningún pedido. ${falta}` };
            }
            const motivoPedido = anterior && !datos ? (anterior.motivo || null) : motivoCompleto(baseDatos);
            for (const t of enTramite) await actualizarTurno(t.id, { estado: t.estado === 'propuesto' ? 'rechazado_cliente' : 'reemplazado' });
            const t = await crearPedidoTurno({
                telefono, inicio, tipo,
                producto, motivo: motivoPedido, interes: args.interes || datos?.interes || anterior?.interes || null,
                reemplazaId: vigente?.id || null,
                cambioDe: anterior ? `${etiquetaTurno(anterior.inicio)}${anterior.estado === 'confirmado' ? ', confirmada' : anterior.estado === 'propuesto' ? ', propuesto por vos' : ', pendiente'}` : null
            });
            await borrarConfig(`opciones:${telefono}`).catch(() => {});
            await borrarConfig(`consulta:${telefono}`).catch(() => {});
            return {
                ok: true, estado: 'pedido enviado al asesor, pendiente de confirmación', horario: etiquetaTurno(t.inicio),
                mantiene: vigente ? etiquetaTurno(vigente.inicio) : null,
                indicacion: vigente
                    ? `Decile que enviaste el pedido de cambio al asesor y que su reunión del ${etiquetaTurno(vigente.inicio)} se mantiene hasta que se confirme la nueva.`
                    : 'Decile que estás verificando la disponibilidad del asesor y que en breve le confirmás.'
            };
        }

        if (nombre === 'confirmar_asistencia' || nombre === 'responder_asistencia') {
            const t = await turnoActivoCliente(telefono);
            if (!t || t.estado !== 'confirmado') return { error: 'El cliente no tiene una reunión confirmada.' };
            const si = nombre === 'confirmar_asistencia' || args.respuesta === 'si';
            if (t.asistencia_confirmada && si && !t.flujo) return { ok: true, aviso: 'Ya tenía la asistencia confirmada. Recordale que 15 minutos antes le llega el link.' };
            if (!si && !preguntaAsistenciaAbierta(t)) return { error: 'No hay ninguna pregunta de asistencia pendiente. Si quiere cancelar, usá cancelar_mi_turno.' };
            await procesarRespuestaAsistencia(t, si);
            return { ok: true, _silencio: true, aviso: 'El sistema ya le respondió al cliente.' };
        }

        if (nombre === 'cancelar_mi_turno') {
            const activos = await turnosActivosCliente(telefono);
            if (!activos.length) return { error: 'El cliente no tiene turnos activos.' };
            for (const t of activos) await cancelarTurno(t.id, { porCliente: true });
            return { ok: true, cancelados: activos.map(t => etiquetaTurno(t.inicio)) };
        }

        if (nombre === 'responder_propuesta') {
            const { rows } = await db.query(
                `SELECT * FROM turnos WHERE telefono = $1 AND estado = 'propuesto' AND inicio > NOW() ORDER BY creado_en DESC LIMIT 1`, [telefono]);
            const t = rows[0];
            if (!t) return { error: 'No hay ningún horario propuesto pendiente.' };
            if (!args.acepta) {
                await actualizarTurno(t.id, { estado: 'rechazado_cliente' });
                await recordarConsultaDeTurno(t);
                await enviarAAdmin(`ℹ️ ${t.nombre || 'El cliente'} no aceptó el horario propuesto (${etiquetaTurno(t.inicio)}). Le voy a ofrecer otros.`);
                return { ok: true, siguiente: 'Ofrecele otros horarios con consultar_horarios.' };
            }
            const r = await confirmarTurno(t.id);
            if (r.ok) await enviarAAdmin(`✅ ${t.nombre || 'El cliente'} aceptó el ${etiquetaTurno(t.inicio)}. Quedó confirmado.`);
            return r.ok ? { ok: true, confirmado: true, _silencio: true, aviso: 'El sistema ya le envió la confirmación.' } : { error: r.mensaje };
        }
    } catch (e) {
        console.error(`Error en herramienta ${nombre}:`, e.message);
        return { error: 'Error interno. Decile que un asesor lo contactará.' };
    }
    return { error: 'Herramienta desconocida.' };
}

// Si el cliente responde solo con el número de una opción ofrecida, se pide el turno directamente.
const REGEX_ELECCION = /^\s*(?:(?:la|el)\s+)?(?:opci[oó]n\s*)?(?:n(?:[uú]mero|ro\.?|°|º)?\s*)?([1-9])\s*[.!)]?\s*(?:por favor|gracias)?\s*$/i;

function detectarProducto(textos) {
    const t = textos.join(' ').toUpperCase();
    if (/\bS\.?\s?A\.?\s?S\b/.test(t)) return 'SAS';
    if (/\bS\.?\s?R\.?\s?L\b/.test(t)) return 'SRL';
    if (/\bS\.?\s?A\b|SOCIEDAD AN[OÓ]NIMA/.test(t)) return 'SA';
    return 'Otra consulta';
}

async function registrarAsistencia(t) {
    await actualizarTurno(t.id, { asistencia_confirmada: true, flujo: null });
    await enviarACliente(t.telefono,
        `¡Muchas gracias por confirmar! Lo esperamos el ${etiquetaTurno(t.inicio)}.\n\n` +
        '15 minutos antes de la reunión le enviaremos por aquí el link de Google Meet.');
    await enviarAAdmin(`✅ ${t.nombre || 'El cliente'} confirmó asistencia a la reunión del ${etiquetaTurno(t.inicio)} (#${t.id}).`);
}

// ---------- Respuesta del cliente a "¿Va a asistir?" ----------
// Sin presionar: 1.ª negativa → ofrecer reagendar; 2.ª → ofrecer contactarlo más adelante; 3.ª → se cancela y nos retiramos.

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

// Hay una pregunta de asistencia abierta si se mandó algún recordatorio con pregunta o si estamos en el flujo de negativas.
function preguntaAsistenciaAbierta(t) {
    if (!t || t.estado !== 'confirmado' || t.asistencia_confirmada) return false;
    const r = t.recordatorios || {};
    return Boolean(t.flujo) || ['c24', 'c12', 'c60'].some(c => r[c] === 'enviado');
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
            // Aceptó reagendar.
            await cancelarTurno(t.id, { porCliente: true, silencioso: true });
            await enviarAAdmin(`🔄 ${quien} no puede asistir el ${etiquetaTurno(t.inicio)} (#${t.id}) y aceptó reagendar. Cancelé la reunión y le ofrecí nuevos horarios.`);
            await ofrecerReagenda(t);
            return;
        }
        if (t.flujo === 'n2') {
            // Aceptó que lo contactemos más adelante.
            await cancelarTurno(t.id, { porCliente: true, silencioso: true });
            await enviarACliente(t.telefono, 'Muy bien. Cancelamos la reunión y más adelante nos comunicaremos con usted. Quedamos a su disposición. ¡Que tenga un buen día!');
            await enviarAAdmin(`📌 ${quien} no puede asistir el ${etiquetaTurno(t.inicio)} (#${t.id}) y pidió que lo contactemos más adelante. Cancelé la reunión.`);
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
    // Tercera negativa: cancelamos con amabilidad y no insistimos más.
    await actualizarTurno(t.id, { negativas, flujo: 'retirado' });
    await cancelarTurno(t.id, { porCliente: true, silencioso: true });
    await enviarACliente(t.telefono, `Entendido. Cancelamos la reunión del ${etiquetaTurno(t.inicio)}. Si más adelante necesita algo, puede escribirnos por aquí cuando quiera. ¡Muchas gracias y que tenga un buen día!`);
    await enviarAAdmin(`❌ ${quien} no podrá asistir a la reunión del ${etiquetaTurno(t.inicio)} (#${t.id}) y no quiso reagendar ni que lo contactemos. Cancelé la reunión y no le vamos a insistir.`);
}

// Si el cliente responde "sí" o "no" a una pregunta de asistencia abierta, se procesa sin pasar por Gemini.
async function asistenciaDirecta(telefono, texto) {
    const si = esAfirmativoCliente(texto), no = !si && esNegativoCliente(texto);
    if (!si && !no) return false;
    const t = (await turnosActivosCliente(telefono)).find(preguntaAsistenciaAbierta);
    if (!t) return false;
    await procesarRespuestaAsistencia(t, si);
    return true;
}

async function eleccionDirecta(telefono, texto) {
    const m = String(texto || '').match(REGEX_ELECCION);
    if (!m) return null;
    const ofrecidas = await leerOpcionesOfrecidas(telefono);
    if (!ofrecidas) return null;
    const numero = Number(m[1]);
    if (!ofrecidas.opciones[numero - 1]) {
        return `Por favor, indíquenos un número entre 1 y ${ofrecidas.opciones.length}:\n\n${ofrecidas.opciones.map((o, i) => `${i + 1}. ${o.texto}`).join('\n')}`;
    }
    const previos = (mensajesCliente.get(telefono) || []).slice(-8, -1);
    const r = await ejecutarHerramientaCliente(telefono, 'solicitar_turno', {
        opcion: numero, tipo: ofrecidas.tipo,
        ...((await leerDatosConsulta(telefono)) ? {} : { producto: detectarProducto(previos), motivo: previos.filter(p => p.length > 15).slice(-2).join(' / ').slice(0, 300) || null })
    });
    if (r.ok && r.mantiene) return `Perfecto. Le envié al asesor el pedido de cambio para el ${r.horario}. Su reunión del ${r.mantiene} se mantiene hasta que le confirmemos el nuevo horario.`;
    if (r.ok) return `Perfecto. Estoy verificando la disponibilidad del asesor para el ${r.horario}. En breve le confirmo.`;
    if (r.opciones) return `${r.error} Le puedo ofrecer:\n\n${r.opciones.map(o => `${o.opcion}. ${o.texto}`).join('\n')}\n\nIndíquenos el número de su preferencia.`;
    return null; // que lo resuelva la conversación normal
}

async function contextoCliente(telefono) {
    const partes = [`Fecha y hora actual en Buenos Aires: ${etiquetaTurno(new Date())}.`];
    try {
        const contacto = await obtenerContacto(telefono);
        partes.push(contacto?.es_cliente
            ? 'Esta persona YA ES CLIENTE del Estudio (contrató antes): tratala como cliente, sin la indagación comercial completa; preguntá directo qué necesita. Si ya tiene una reunión y quiere tratar otro tema, puede agendar una reunión aparte.'
            : 'Esta persona es un PROSPECTO (todavía no contrató): aplicá el perfil comercial. Si ya tiene una reunión y quiere tratar otro tema, se suma a esa misma reunión.');
        const t = await turnoActivoCliente(telefono);
        if (t) {
            const estados = { pendiente_admin: 'pendiente de confirmación del asesor', propuesto: 'propuesto por el asesor, esperando respuesta del cliente', confirmado: 'confirmado' };
            const linkVisible = (t.recordatorios || {}).c15 === 'enviado' || Date.now() >= new Date(t.inicio).getTime() - 15 * 60000;
            const preguntas = {
                n1: 'El cliente dijo que no puede asistir; el sistema le preguntó si quiere reagendar. Si responde, usá responder_asistencia ("si" = reagendar).',
                n2: 'El cliente no quiso reagendar; el sistema le preguntó si prefiere que lo contactemos más adelante. Si responde, usá responder_asistencia.'
            };
            partes.push(`Este cliente tiene un turno ${estados[t.estado]}: ${etiquetaTurno(t.inicio)}` +
                (t.asistencia_confirmada ? ', asistencia confirmada' : ', todavía no confirmó asistencia') +
                (linkVisible && t.meet ? `. Link de la reunión: ${t.meet}` : '. El link de Meet se le envía automáticamente 15 minutos antes; no lo compartas ni lo inventes antes') + '.');
            if (t.estado === 'confirmado' && preguntas[t.flujo]) partes.push(preguntas[t.flujo]);
            else if (preguntaAsistenciaAbierta(t)) partes.push('El sistema le preguntó si va a asistir. Si responde sí o no (aunque sea con otras palabras), usá responder_asistencia. Nunca insistas ni presiones.');
            const otros = (await turnosActivosCliente(telefono)).filter(x => x.id !== t.id);
            for (const o of otros) partes.push(`Además tiene un pedido de cambio de horario al ${etiquetaTurno(o.inicio)}, ${estados[o.estado]}.`);
            if (t.estado === 'propuesto') partes.push('Si acepta el horario propuesto usá responder_propuesta; si pide otro día u hora, usá solicitar_turno con ese día y hora (NO canceles).');
        }
        const ofrecidas = await leerOpcionesOfrecidas(telefono);
        if (ofrecidas) {
            partes.push(`Opciones de horario ofrecidas a este cliente (si elige una, usá solicitar_turno con ese número en "opcion"):\n` +
                ofrecidas.opciones.map((o, i) => `${i + 1}. ${o.texto}`).join('\n'));
        }
    } catch (e) { /* sin contexto de turnos */ }
    return partes.join('\n');
}

// ---------- Servidor web ----------

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

// ---------- Consulta a Google Gemini (con reintentos y modelo de respaldo) ----------

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
async function conversarConHerramientas({ instrucciones, contents, herramientas, ejecutar, maxPasos = 4, generationConfig, alAgotar = null }) {
    const conversacion = [...contents];
    let modeloFijo = null;
    for (let paso = 0; paso < maxPasos; paso++) {
        const cuerpo = {
            systemInstruction: { parts: [{ text: instrucciones }] },
            contents: conversacion,
            tools: [{ functionDeclarations: herramientas }],
            generationConfig: generationConfig || { maxOutputTokens: 800, temperature: 0.4 }
        };
        const r = await llamarConReintentos(cuerpo, modeloFijo ? { modelos: [modeloFijo] } : {});
        if (!r) return null;
        modeloFijo = r.modelo;
        if (!r.llamadas.length) return r.texto || null;

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

    const asistencia = await asistenciaDirecta(remitenteId, mensajeTexto).catch(e => { console.error('Asistencia directa:', e.message); return false; });
    if (asistencia) return ''; // el sistema ya le respondió

    const directa = await eleccionDirecta(remitenteId, mensajeTexto).catch(e => { console.error('Elección directa:', e.message); return null; });
    if (directa) return directa;

    const instrucciones = construirInstrucciones() + '\n\nCONTEXTO ACTUAL:\n' + await contextoCliente(remitenteId);
    let silencio = false; // una herramienta ya le respondió al cliente: no se agrega texto del modelo
    const reply = await conversarConHerramientas({
        instrucciones,
        contents: [...base, mensajeUsuario],
        herramientas: HERRAMIENTAS_CLIENTE,
        ejecutar: async (nombre, args) => {
            const r = await ejecutarHerramientaCliente(remitenteId, nombre, args);
            if (r && r._silencio) { silencio = true; const { _silencio, ...resto } = r; return resto; }
            return r;
        }
    });
    if (silencio) { userHistories.delete(remitenteId); return ''; }
    // El historial se vuelve a leer de la base en cada mensaje: así incluye también los avisos que manda el sistema
    // (confirmaciones, recordatorios) en el orden correcto.
    userHistories.delete(remitenteId);
    return reply || null;
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

// ---------- Asistente del administrador (conversación natural) ----------
// Desde el número del administrador se habla con el bot en lenguaje natural. Las acciones que afectan a un cliente
// o no tienen vuelta atrás quedan en espera hasta que el administrador responda "sí".

const HERRAMIENTAS_ADMIN = [
    { name: 'estado_bot', description: 'Estado técnico del bot: WhatsApp, base de datos, Gemini y Google Calendar.', parameters: { type: 'OBJECT', properties: {} } },
    {
        name: 'ver_agenda', description: 'Reuniones del calendario y turnos pendientes de los próximos días.',
        parameters: { type: 'OBJECT', properties: { dias: { type: 'INTEGER', description: 'Cantidad de días (por defecto 7).' } } }
    },
    {
        name: 'buscar_turnos', description: 'Busca reuniones y pedidos vigentes por nombre del cliente, fecha y/o hora. Devuelve el número (#) de cada turno, que necesitás para confirmar, rechazar, proponer o cancelar.',
        parameters: { type: 'OBJECT', properties: {
            texto: { type: 'STRING', description: 'Nombre o apellido del cliente, opcional.' },
            fecha: { type: 'STRING', description: 'AAAA-MM-DD, opcional.' },
            hora: { type: 'STRING', description: 'HH:MM, opcional.' } } }
    },
    {
        name: 'marcar_cliente', description: 'Marca a una persona como CLIENTE del Estudio (ya contrató alguna vez) o la vuelve a prospecto. Buscala por nombre o número de teléfono.',
        parameters: { type: 'OBJECT', properties: {
            texto: { type: 'STRING', description: 'Nombre, apellido o número de teléfono.' },
            es_cliente: { type: 'BOOLEAN', description: 'true = cliente; false = prospecto.' } }, required: ['texto'] }
    },
    {
        name: 'ver_disponibilidad', description: 'Franjas de atención de cada día (horario normal y cambios cargados).',
        parameters: { type: 'OBJECT', properties: { dias: { type: 'INTEGER', description: 'Cantidad de días (por defecto 7).' } } }
    },
    {
        name: 'bloquear_horario', description: 'Bloquea un día entero o una franja para que no se ofrezcan turnos.',
        parameters: {
            type: 'OBJECT',
            properties: {
                fecha: { type: 'STRING', description: 'AAAA-MM-DD' },
                desde: { type: 'STRING', description: 'HH:MM, opcional. Sin desde/hasta se bloquea el día entero.' },
                hasta: { type: 'STRING', description: 'HH:MM, opcional.' }
            },
            required: ['fecha']
        }
    },
    {
        name: 'abrir_horario', description: 'Habilita una franja extra de atención en un día (por ejemplo, fuera del horario normal).',
        parameters: {
            type: 'OBJECT',
            properties: { fecha: { type: 'STRING', description: 'AAAA-MM-DD' }, desde: { type: 'STRING', description: 'HH:MM' }, hasta: { type: 'STRING', description: 'HH:MM' } },
            required: ['fecha', 'desde', 'hasta']
        }
    },
    {
        name: 'restablecer_dia', description: 'Borra los cambios de un día y vuelve al horario normal. Para limitar un día a una franja, primero restablecé y después bloqueá lo que sobra.',
        parameters: { type: 'OBJECT', properties: { fecha: { type: 'STRING', description: 'AAAA-MM-DD' } }, required: ['fecha'] }
    },
    {
        name: 'confirmar_turno', description: 'Confirma un pedido de turno: crea la reunión con Meet y le avisa al cliente.',
        parameters: { type: 'OBJECT', properties: { turno_id: { type: 'INTEGER' } }, required: ['turno_id'] }
    },
    {
        name: 'rechazar_turno', description: 'Rechaza un pedido de turno y le ofrece al cliente otros horarios disponibles.',
        parameters: { type: 'OBJECT', properties: { turno_id: { type: 'INTEGER' } }, required: ['turno_id'] }
    },
    {
        name: 'proponer_horario', description: 'Le propone al cliente un horario distinto al que pidió. Si el cliente acepta, se confirma solo.',
        parameters: {
            type: 'OBJECT',
            properties: { turno_id: { type: 'INTEGER' }, fecha: { type: 'STRING', description: 'AAAA-MM-DD' }, hora: { type: 'STRING', description: 'HH:MM' } },
            required: ['turno_id', 'fecha', 'hora']
        }
    },
    {
        name: 'cancelar_turno', description: 'Cancela un turno o reunión ya confirmada, borra el evento del calendario y avisa al cliente.',
        parameters: { type: 'OBJECT', properties: { turno_id: { type: 'INTEGER' } }, required: ['turno_id'] }
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

const HERRAMIENTAS_SENSIBLES = new Set(['confirmar_turno', 'rechazar_turno', 'proponer_horario', 'cancelar_turno', 'borrar_regla']);
const VIGENCIA_ACCION_MIN = 30;
let historialAdmin = [];
let ultimoMensajeAdmin = 0;

function normalizarTexto(t) {
    return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function esAfirmativo(t) {
    const n = normalizarTexto(t);
    if (n.length > 30) return false;
    if (/^(si+|sip|sii|dale|ok|okey|okay|oka|confirmo|confirma|confirmalo|confirmar|de acuerdo|perfecto|listo|adelante|claro|obvio|va|hacelo|si dale|dale si|si confirmo|si confirmalo|si por favor|si gracias|dale gracias|ok dale|si si)( por favor| gracias)?$/.test(n)) return true;
    // "si puede fijate", "sí, hacelo", "dale mandale": empieza con un sí y no trae condiciones, números ni negaciones.
    return /^(si+|dale|ok|okey|listo|perfecto|claro|de acuerdo|confirmo)( |$)/.test(n) && !/\d/.test(n) &&
        !/\b(no|pero|otro|otra|otros|otras|cambia|cambiale|mejor|aunque|salvo|excepto|despues|antes|tarde|temprano|manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo|cuando|cual|que)\b/.test(n);
}

function esNegativo(t) {
    const n = normalizarTexto(t);
    return n.length <= 20 && /^(no|nop|nope|negativo|mejor no|no gracias|no no|cancelalo|no lo confirmes)$/.test(n);
}

async function describirAccion(nombre, args) {
    const turno = args.turno_id ? await obtenerTurno(args.turno_id) : null;
    const t = turno ? descripcionTurno(turno) : `turno #${args.turno_id}`;
    switch (nombre) {
        case 'confirmar_turno': return `confirmar el turno ${t} y avisarle al cliente`;
        case 'rechazar_turno': return `rechazar el turno ${t} y ofrecerle otros horarios al cliente`;
        case 'proponer_horario': return `proponerle a ${turno?.nombre || 'el cliente'} el ${etiquetaTurno(desdeBA(args.fecha, normalizarHora(args.hora) || '00:00'))} en lugar de su pedido`;
        case 'cancelar_turno': return `cancelar el turno ${t}, borrarlo del calendario y avisarle al cliente`;
        case 'borrar_regla': return `borrar la regla ${args.numero}: "${globalAdminRules[args.numero - 1]?.regla || '(no existe)'}"`;
        default: return nombre;
    }
}

async function ejecutarAccionAdmin(nombre, args) {
    switch (nombre) {
        case 'estado_bot': return { texto: await estadoSistema() };
        case 'ver_agenda': return { texto: await resumenAgenda(Math.min(Math.max(args.dias || 7, 1), 30)) };
        case 'buscar_turnos': {
            const encontrados = await buscarTurnos(args);
            return encontrados.length
                ? { encontrados: encontrados.map(t => `${descripcionTurno(t)} · ${t.estado}`), indicacion: encontrados.length > 1 ? 'Hay más de uno: preguntale al administrador cuál.' : 'Usá este número.' }
                : { encontrados: [], indicacion: 'No hay turnos vigentes con esos datos. Decíselo y pedile el nombre del cliente o el día y la hora.' };
        }
        case 'marcar_cliente': return marcarCliente(args.texto, args.es_cliente !== false);
        case 'ver_disponibilidad': return { texto: await resumenDisponibilidad(Math.min(Math.max(args.dias || 7, 1), 30)) };
        case 'bloquear_horario': return agregarExcepcion('bloquear', args.fecha, args.desde, args.hasta);
        case 'abrir_horario': return agregarExcepcion('abrir', args.fecha, args.desde, args.hasta);
        case 'restablecer_dia': return restablecerDia(args.fecha);
        case 'confirmar_turno': return confirmarTurno(args.turno_id);
        case 'rechazar_turno': return rechazarTurno(args.turno_id);
        case 'proponer_horario': return proponerHorario(args.turno_id, args.fecha, args.hora);
        case 'cancelar_turno': return cancelarTurno(args.turno_id);
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

function calendarioReferencia() {
    const hoy = partesBA(Date.now()).fecha;
    const lineas = [];
    for (let i = 0; i < 14; i++) {
        const f = sumarDiasFecha(hoy, i);
        lineas.push(`${f} = ${etiquetaFecha(desdeBA(f, '12:00'))}${i === 0 ? ' (hoy)' : i === 1 ? ' (mañana)' : ''}`);
    }
    return lineas.join('\n');
}

async function instruccionesAdmin() {
    const pendientes = await turnosPendientesAdmin().catch(() => []);
    return 'Sos el asistente personal del administrador del Estudio Jurídico Jaime Irigoyen, por WhatsApp. ' +
        'Hablás en español rioplatense, de "vos", con tono cercano, claro y breve (2 a 5 líneas salvo que muestres una lista).\n' +
        'Para cualquier dato o acción usá las herramientas: nunca inventes reuniones, horarios ni estados.\n' +
        'Horario normal de atención: lunes a viernes de 12 a 18 hs. Turnos de 30 min + 15 de margen.\n' +
        'Si una herramienta responde "requiere_confirmacion", preguntale al administrador si confirma, repitiendo la descripción tal cual, y terminá con "¿Confirmo?". No la des por hecha.\n' +
        'Si no queda claro qué día, qué turno o qué horario quiere, preguntá antes de actuar.\n' +
        'Para confirmar, rechazar, proponer o cancelar necesitás el número de turno (#). Sacalo de ver_agenda o de buscar_turnos (por nombre, fecha u hora). ' +
        'NUNCA inventes ni adivines un número. Si hay más de un turno posible, preguntá cuál. Los eventos que dicen "no es un turno del bot" no se pueden cancelar desde acá.\n' +
        'Cada pedido trae especialidad, motivo e interés del cliente: usalos si te preguntan quién debería atender o de qué se trata.\n\n' +
        `Hoy es ${etiquetaTurno(new Date())}. Referencia de fechas:\n${calendarioReferencia()}\n\n` +
        (pendientes.length ? `Pedidos de turno esperando tu confirmación:\n${pendientes.map(descripcionTurno).join('\n')}` : 'No hay pedidos de turno esperando confirmación.');
}

// Lo que se resuelve sin pasar por Gemini (un "sí" directo) también queda en la conversación del asistente,
// así después sabe qué se hizo.
function recordarEnHistorialAdmin(textoAdmin, respuesta) {
    if (Date.now() - ultimoMensajeAdmin > 2 * 60 * 60 * 1000) historialAdmin = [];
    ultimoMensajeAdmin = Date.now();
    historialAdmin = [...historialAdmin, { role: 'user', parts: [{ text: textoAdmin }] }, { role: 'model', parts: [{ text: respuesta }] }].slice(-12);
}

async function procesarMensajeAdmin(sock, sender, text) {

    const responder = async (t) => {
        await sock.sendMessage(sender, { text: t });
        recordarEnHistorialAdmin(text, t);
    };

    // 1) Respuesta a una acción que quedó esperando confirmación.
    const pendiente = await leerAccionPendiente();
    if (pendiente) {
        if (esAfirmativo(text)) {
            await borrarConfig('accion_pendiente');
            const r = await ejecutarAccionAdmin(pendiente.nombre, pendiente.args);
            return responder(r.mensaje || r.texto || 'Listo.');
        }
        if (esNegativo(text)) {
            await borrarConfig('accion_pendiente');
            return responder('Perfecto, no hago nada. 👍');
        }
        await borrarConfig('accion_pendiente'); // cambió de tema: se descarta la acción en espera
    }

    // 2) "Sí" o "no" directo a un único pedido de turno pendiente.
    if (esAfirmativo(text) || esNegativo(text)) {
        const pendientes = await turnosPendientesAdmin();
        if (pendientes.length === 1) {
            const r = esAfirmativo(text) ? await confirmarTurno(pendientes[0].id) : await rechazarTurno(pendientes[0].id);
            return responder(r.mensaje);
        }
    }

    // 3) Conversación con el asistente.
    if (Date.now() - ultimoMensajeAdmin > 2 * 60 * 60 * 1000) historialAdmin = [];
    ultimoMensajeAdmin = Date.now();
    const mensajeUsuario = { role: 'user', parts: [{ text }] };
    // Si el admin responde "sí" a una pregunta del asistente (por ejemplo "¿se lo propongo a las 16:30?"),
    // la acción se ejecuta directamente, sin volver a pedir confirmación.
    const ultimaDelAsistente = historialAdmin.length ? historialAdmin[historialAdmin.length - 1] : null;
    const yaConfirmo = esAfirmativo(text) && ultimaDelAsistente?.role === 'model' && /\?\s*$/.test(ultimaDelAsistente.parts?.[0]?.text || '');
    const respuesta = await conversarConHerramientas({
        instrucciones: await instruccionesAdmin(),
        contents: [...historialAdmin, mensajeUsuario],
        herramientas: HERRAMIENTAS_ADMIN,
        generationConfig: { maxOutputTokens: 1000, temperature: 0.3 },
        maxPasos: 6,
        alAgotar: 'No logré encontrar lo que me pedís. ¿Me decís el nombre del cliente o el día y la hora de la reunión? También podés escribir "ADMIN AGENDA" para ver la lista con los números de turno.',
        ejecutar: async (nombre, args) => {
            try {
                if (args.turno_id != null && ['confirmar_turno', 'rechazar_turno', 'proponer_horario', 'cancelar_turno'].includes(nombre)) {
                    const t = await obtenerTurno(args.turno_id);
                    if (!t || !ESTADOS_OCUPAN.includes(t.estado) || new Date(t.fin) <= new Date()) {
                        return { ok: false, error: `El turno #${args.turno_id} ${t ? `no está vigente (${t.estado})` : 'no existe'}. No le pidas confirmación al administrador: buscá el correcto con buscar_turnos o ver_agenda, o preguntale cuál es.` };
                    }
                }
                if (HERRAMIENTAS_SENSIBLES.has(nombre) && !yaConfirmo) {
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

    const texto = respuesta || 'Perdón, no pude procesar eso ahora (Gemini no respondió). Probá de nuevo en un minuto o usá un comando, por ejemplo "ADMIN AGENDA".';
    await sock.sendMessage(sender, { text: texto });
    if (respuesta) recordarEnHistorialAdmin(text, respuesta);
}

// ---------- Tareas programadas: avisos, vencimientos y recordatorios ----------

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

let revisandoTareas = false;

async function revisarTareas() {
    if (revisandoTareas || !dbOk || !isConnected) return;
    revisandoTareas = true;
    try {
        const ahora = Date.now();

        // Feriados: se actualizan una vez por día y se avisa si alguna reunión cae en uno.
        if (ahora - feriadosRevisadosEn > 24 * 3600000) await cargarFeriados().catch(e => console.error('Feriados:', e.message));
        if (ahora - feriadosAvisadosEn > 24 * 3600000) { feriadosAvisadosEn = ahora; await avisarTurnosEnFeriados(); }

        // Pedidos sin respuesta del administrador.
        const { rows: pendientes } = await db.query(`SELECT * FROM turnos WHERE estado = 'pendiente_admin'`);
        for (const t of pendientes) {
            const inicio = new Date(t.inicio).getTime();
            if (inicio - ahora < 60 * 60000) {
                await actualizarTurno(t.id, { estado: 'vencido' });
                await recordarConsultaDeTurno(t);
                const anterior = await turnoReemplazado(t);
                await enviarACliente(t.telefono, anterior
                    ? `Disculpe, no pudimos confirmar a tiempo el cambio al ${etiquetaTurno(t.inicio)}. Su reunión del ${etiquetaTurno(anterior.inicio)} se mantiene.`
                    : `Disculpe, no pudimos confirmar a tiempo la reunión del ${etiquetaTurno(t.inicio)}. Si lo desea, le ofrezco nuevos horarios.`).catch(() => {});
                await enviarAAdmin(`⌛ El pedido #${t.id} de ${t.nombre || 'un cliente'} (${etiquetaTurno(t.inicio)}) venció sin confirmación. Le avisé al cliente.`);
                continue;
            }
            if (!t.segundo_aviso && t.avisado_admin_en && ahora - new Date(t.avisado_admin_en).getTime() > 60 * 60000) {
                await actualizarTurno(t.id, { segundo_aviso: true });
                await enviarAAdmin(textoAvisoTurno(t, true));
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
    } catch (e) {
        console.error('Error en tareas programadas:', e.message);
    } finally {
        revisandoTareas = false;
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
            '💬 Podés hablarme normal, por ejemplo: "¿qué tengo esta semana?", "el jueves no puedo", "el viernes atiendo de 14 a 16", "confirmale a Juan".\n\n' +
            '🛠️ *Comandos exactos (respaldo)*\n\n' +
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
        await sock.sendMessage(sender, { text: '📅 *Próximos 7 días*\n\n' + await resumenAgenda(7) });
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

                // Buscar el nombre solo mientras el contacto no lo tenga guardado.
                const contacto = await obtenerContacto(sender);
                if (!contacto || !contacto.nombre || contacto.nombre === 'No indicado') {
                    const nombreDetectado = await detectarNombre(text);
                    if (nombreDetectado) await actualizarContacto(sender, 'nombre', nombreDetectado);
                }

                await sock.sendPresenceUpdate('composing', sender);
                const respuestaAI = await consultarGemini(sender, text);
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

// ---------- Arranque ----------

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
});

module.exports = {
    limpiarNombre, filasAHistorial, numeroCliente, soloDigitos, fechaBA, emailDesdeIdToken, horaCorta,
    partesBA, desdeBA, franjasDelDia, elegirOpciones, horariosLibres, esAfirmativo, esNegativo, etiquetaTurno,
    ejecutarHerramientaCliente, procesarMensajeAdmin, revisarTareas, conversarConHerramientas, confirmarTurno,
    inicializarDB, guardarConfig, consultarGemini, db, cargarFeriados, nombreFeriado, fechaPascua, feriadosCalculados,
    resumenDisponibilidad, resumenAgenda, avisarTurnosEnFeriados, rechazarTurno, proponerHorario, interpretarFecha, construirInstrucciones, textoRecordatorioCliente, esAfirmativoCliente, esNegativoCliente,
    _historialAdmin: () => historialAdmin,
    _set: (k, v) => { if (k === 'socket') socketActual = v; if (k === 'conectado') isConnected = v; if (k === 'dbOk') dbOk = v; }
};
