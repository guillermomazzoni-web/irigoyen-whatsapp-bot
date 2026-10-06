/**
 * WhatsApp Bridge con Baileys + Google Gemini AI
 * Estudio Jurídico Jaime Irigoyen
 *
 * Variables de entorno:
 *   GEMINI_API_KEY   (obligatoria) Clave de la API de Gemini.
 *   ADMIN_NUMBER     (opcional)    Número del administrador, solo dígitos y con código de país.
 *                                  Ej: 5491112345678. Si no se configura, los comandos ADMIN quedan desactivados.
 *   PANEL_PASSWORD   (opcional)    Si se configura, la página del QR pide ?clave=... en la URL.
 *   PORT             (opcional)    Puerto del servidor web (por defecto 3000).
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const https = require('https');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-3.5-flash-lite'; // Modelo que ya funciona en producción
const ADMIN_NUMBER = (process.env.ADMIN_NUMBER || '').replace(/\D/g, '');
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || '';

const AUTH_FOLDER = 'auth_info_baileys';
const RULES_FILE = 'reglas_admin.json';
const MAX_TURNOS_HISTORIAL = 10; // Mensajes de la conversación que se recuerdan por cliente

const MENSAJE_ERROR = 'Disculpe, en este momento estamos teniendo un inconveniente técnico. Un abogado del Estudio se comunicará con usted a la brevedad.';

let currentQR = null;
let isConnected = false;
const userHistories = new Map();

// ---------- Reglas del administrador (se guardan en un archivo para no perderlas al reiniciar) ----------

function cargarReglas() {
    try {
        if (fs.existsSync(RULES_FILE)) {
            const reglas = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
            if (Array.isArray(reglas)) return reglas;
        }
    } catch (e) {
        console.error('No se pudieron leer las reglas del administrador:', e.message);
    }
    return [];
}

function guardarReglas() {
    try {
        fs.writeFileSync(RULES_FILE, JSON.stringify(globalAdminRules, null, 2), 'utf8');
    } catch (e) {
        console.error('No se pudieron guardar las reglas del administrador:', e.message);
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

// ---------- Servidor web para ver el código QR ----------

app.get('/', (req, res) => {
    if (PANEL_PASSWORD && req.query.clave !== PANEL_PASSWORD) {
        return res.status(401).send('Acceso no autorizado.');
    }

    if (isConnected) {
        return res.send(`
            <!DOCTYPE html>
            <html lang="es">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>WhatsApp Bot Activo · Estudio Jaime Irigoyen</title>
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #0f172a; color: #fff; margin: 0; }
                    .card { background: #1e293b; padding: 40px; border-radius: 20px; text-align: center; box-shadow: 0 10px 40px rgba(0,0,0,0.5); max-width: 450px; width: 90%; }
                    .status { display: inline-flex; align-items: center; gap: 8px; background: #064e3b; color: #34d399; padding: 8px 16px; border-radius: 50px; font-weight: 600; font-size: 0.9rem; margin-bottom: 20px; }
                    .dot { width: 10px; height: 10px; background: #34d399; border-radius: 50%; box-shadow: 0 0 10px #34d399; }
                    h1 { font-size: 1.5rem; margin: 0 0 10px; color: #f8fafc; }
                    p { color: #94a3b8; font-size: 0.95rem; line-height: 1.5; margin: 0; }
                </style>
            </head>
            <body>
                <div class="card">
                    <div class="status"><span class="dot"></span> EN LÍNEA Y CONECTADO</div>
                    <h1>WhatsApp Bot Activo</h1>
                    <p>El bot del <strong>Estudio Jurídico Jaime Irigoyen</strong> está conectado a tu WhatsApp Business y respondiendo consultas con Inteligencia Artificial.</p>
                </div>
            </body>
            </html>
        `);
    }

    if (currentQR) {
        QRCode.toDataURL(currentQR, (err, url) => {
            if (err) return res.send('Error generando QR.');
            res.send(`
                <!DOCTYPE html>
                <html lang="es">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Vincular WhatsApp · Estudio Jaime Irigoyen</title>
                    <meta http-equiv="refresh" content="5">
                    <style>
                        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #0f172a; color: #fff; margin: 0; }
                        .card { background: #1e293b; padding: 35px 25px; border-radius: 20px; text-align: center; box-shadow: 0 10px 40px rgba(0,0,0,0.5); max-width: 440px; width: 90%; }
                        h1 { font-size: 1.4rem; margin: 0 0 10px; color: #f8fafc; }
                        p { color: #94a3b8; font-size: 0.9rem; line-height: 1.5; margin: 0 0 20px; }
                        .qr-box { background: #fff; padding: 15px; border-radius: 14px; display: inline-block; margin-bottom: 20px; box-shadow: 0 4px 20px rgba(0,0,0,0.2); }
                        .qr-box img { display: block; max-width: 250px; width: 100%; height: auto; }
                        .instructions { background: #0f172a; padding: 15px; border-radius: 12px; text-align: left; font-size: 0.85rem; color: #cbd5e1; }
                        .instructions ol { margin: 0; padding-left: 20px; }
                        .instructions li { margin-bottom: 6px; }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <h1>Vincular WhatsApp</h1>
                        <p>Escaneá este código desde tu celular con el número <strong>+54 9 11 3236-4365</strong>.</p>
                        <div class="qr-box">
                            <img src="${url}" alt="Código QR de WhatsApp" />
                        </div>
                        <div class="instructions">
                            <ol>
                                <li>Abrí <strong>WhatsApp Business</strong> en tu celular.</li>
                                <li>Tocá los <strong>tres puntos (⋮)</strong> o Configuración.</li>
                                <li>Seleccioná <strong>Dispositivos vinculados</strong>.</li>
                                <li>Tocá <strong>Vincular un dispositivo</strong> y apuntá al código QR.</li>
                            </ol>
                        </div>
                    </div>
                </body>
                </html>
            `);
        });
    } else {
        res.send(`
            <!DOCTYPE html>
            <html lang="es">
            <head><meta charset="UTF-8"><meta http-equiv="refresh" content="3"><title>Iniciando...</title></head>
            <body style="background:#0f172a;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;">
                <p>Generando código QR... por favor esperá unos segundos.</p>
            </body>
            </html>
        `);
    }
});

// ---------- Consulta a Google Gemini ----------

function consultarGemini(remitenteId, mensajeTexto) {
    return new Promise((resolve) => {
        const historial = userHistories.get(remitenteId) || [];
        const mensajeUsuario = { role: 'user', parts: [{ text: mensajeTexto }] };

        // Las instrucciones se arman en cada consulta, así las reglas nuevas del administrador
        // se aplican también a las conversaciones que ya estaban en curso.
        const contents = [
            { role: 'user', parts: [{ text: construirInstrucciones() }] },
            { role: 'model', parts: [{ text: 'Entendido. Actuaré como el asistente virtual formal del Estudio Jaime Irigoyen siguiendo estrictamente estas reglas.' }] },
            ...historial,
            mensajeUsuario
        ];

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
        const payload = JSON.stringify({
            contents,
            generationConfig: {
                maxOutputTokens: 250,
                temperature: 0.5
            }
        });

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
                        const reply = parsed.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                        if (reply) {
                            // El historial solo se actualiza si hubo respuesta, para no dejar mensajes sin contestar
                            const nuevoHistorial = [...historial, mensajeUsuario, { role: 'model', parts: [{ text: reply }] }];
                            userHistories.set(remitenteId, nuevoHistorial.slice(-MAX_TURNOS_HISTORIAL));
                            return resolve(reply);
                        }
                        console.error('Gemini respondió sin texto:', data);
                    } catch (e) {
                        console.error('Error parseando respuesta de Gemini:', e);
                    }
                } else {
                    console.error('\n=== ERROR DE GEMINI ===');
                    console.error('Status Code:', res.statusCode);
                    console.error('Detalle:', data);
                    console.error('=======================\n');
                }
                resolve(MENSAJE_ERROR);
            });
        });

        // Si Gemini no responde en 15 segundos, se corta la conexión (antes quedaba colgada)
        req.on('timeout', () => {
            req.destroy(new Error('Tiempo de espera agotado (15 s)'));
        });

        req.on('error', (err) => {
            console.error('Error en llamada a Gemini:', err.message);
            resolve(MENSAJE_ERROR);
        });

        req.write(payload);
        req.end();
    });
}

// ---------- Comandos del administrador ----------

function soloDigitos(jid) {
    return (jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

function esAdmin(msg) {
    if (!ADMIN_NUMBER) return false;
    // Según la versión de Baileys, el número real puede venir en distintos campos
    const candidatos = [msg.key.remoteJid, msg.key.senderPn, msg.key.remoteJidAlt, msg.key.participant]
        .filter(Boolean)
        .map(soloDigitos);
    return candidatos.includes(ADMIN_NUMBER);
}

async function procesarComandoAdmin(sock, sender, text) {
    const comando = text.trim();

    if (/^ADMIN LISTAR$/i.test(comando)) {
        const lista = globalAdminRules.length > 0
            ? globalAdminRules.map((r, i) => `${i + 1}. ${r}`).join('\n')
            : 'No hay reglas guardadas.';
        await sock.sendMessage(sender, { text: `📋 Reglas actuales:\n${lista}` });
        return;
    }

    if (/^ADMIN BORRAR$/i.test(comando)) {
        globalAdminRules = [];
        guardarReglas();
        await sock.sendMessage(sender, { text: '🗑️ Se borraron todas las reglas del administrador.' });
        console.log('[ADMIN] Reglas borradas.');
        return;
    }

    const nuevaRegla = comando.replace(/^ADMIN:\s*/i, '').trim();
    if (!nuevaRegla) {
        await sock.sendMessage(sender, { text: 'Escriba la regla después de "ADMIN:". Ejemplo:\nADMIN: Los sábados el Estudio permanece cerrado.' });
        return;
    }

    globalAdminRules.push(nuevaRegla);
    guardarReglas();
    await sock.sendMessage(sender, { text: `✅ Regla guardada:\n"${nuevaRegla}"\n\nSe aplica desde ahora a todas las conversaciones.` });
    console.log(`[ADMIN] Nueva regla guardada: ${nuevaRegla}`);
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

        if (qr) {
            currentQR = qr;
            isConnected = false;
            console.log('Nuevo código QR generado.');
        }

        if (connection === 'close') {
            const loggedOut = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
            console.log('Conexión cerrada. Error:', lastDisconnect?.error?.message || lastDisconnect?.error);
            isConnected = false;
            currentQR = null;

            if (loggedOut) {
                // La sesión se cerró desde el celular: se borra la sesión vieja para generar un QR nuevo
                console.log('Sesión cerrada desde el celular. Se generará un nuevo código QR.');
                fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
            } else {
                console.log('Reconectando...');
            }
            setTimeout(connectToWhatsApp, 5000);
        } else if (connection === 'open') {
            console.log('¡Conexión establecida con WhatsApp exitosamente!');
            isConnected = true;
            currentQR = null;
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Escuchar mensajes entrantes
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            try {
                const sender = msg.key.remoteJid || '';

                // Ignorar mensajes propios, grupos, estados, listas de difusión y canales
                if (!msg.message || msg.key.fromMe) continue;
                if (sender.endsWith('@g.us') || sender.endsWith('@broadcast') || sender.endsWith('@newsletter')) continue;

                const text = msg.message.conversation ||
                             msg.message.extendedTextMessage?.text ||
                             msg.message.imageMessage?.caption || '';

                if (!text.trim()) continue;

                console.log(`Mensaje entrante de ${sender}: ${text}`);

                // Comandos del administrador (solo desde el número configurado en ADMIN_NUMBER)
                if (/^ADMIN(:|\s+LISTAR$|\s+BORRAR$)/i.test(text.trim()) && esAdmin(msg)) {
                    await procesarComandoAdmin(sock, sender, text);
                    continue;
                }

                // Indicador de "escribiendo..."
                await sock.sendPresenceUpdate('composing', sender);

                const respuestaAI = await consultarGemini(sender, text);

                // Pausa de 1,5 segundos para que se sienta más natural
                await new Promise(r => setTimeout(r, 1500));

                await sock.sendMessage(sender, { text: respuestaAI });
                console.log(`Respuesta enviada a ${sender}: ${respuestaAI}`);
            } catch (e) {
                console.error('Error procesando un mensaje:', e);
            }
        }
    });
}

app.listen(PORT, () => {
    console.log(`Servidor web activo en el puerto ${PORT}`);
    if (!GEMINI_API_KEY) console.warn('⚠️ Falta la variable GEMINI_API_KEY.');
    if (!ADMIN_NUMBER) console.warn('ℹ️ ADMIN_NUMBER no configurado: los comandos ADMIN están desactivados.');
    setTimeout(connectToWhatsApp, 5000);
});
