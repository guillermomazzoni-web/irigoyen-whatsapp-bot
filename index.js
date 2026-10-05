/**
 * WhatsApp Bridge con Baileys + Google Gemini AI
 * Estudio JurÃ­dico Jaime Irigoyen
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

let currentQR = null;
let isConnected = false;
let userHistories = new Map();

// Servidor Web para ver el CÃ³digo QR
app.get('/', (req, res) => {
    if (isConnected) {
        return res.send(`
            <!DOCTYPE html>
            <html lang="es">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>WhatsApp Bot Activo Â· Estudio Jaime Irigoyen</title>
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
                    <div class="status"><span class="dot"></span> EN LÃNEA Y CONECTADO</div>
                    <h1>WhatsApp Bot Activo</h1>
                    <p>El bot del <strong>Estudio JurÃ­dico Jaime Irigoyen</strong> estÃ¡ conectado a tu WhatsApp Business y respondiendo consultas con Inteligencia Artificial.</p>
                </div>
            </body>
            </html>
        `);
    }

    if (currentQR) {
        QRCode.toDataURL(currentQR, (err, url) => {
            if (err) return res.send("Error generando QR.");
            res.send(`
                <!DOCTYPE html>
                <html lang="es">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Vincular WhatsApp Â· Estudio Jaime Irigoyen</title>
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
                        <p>EscaneÃ¡ este cÃ³digo desde tu celular con el nÃºmero <strong>+54 9 11 3236-4365</strong>.</p>
                        <div class="qr-box">
                            <img src="${url}" alt="CÃ³digo QR de WhatsApp" />
                        </div>
                        <div class="instructions">
                            <ol>
                                <li>AbrÃ­ <strong>WhatsApp Business</strong> en tu celular.</li>
                                <li>TocÃ¡ los <strong>tres puntos (â‹®)</strong> o ConfiguraciÃ³n.</li>
                                <li>SeleccionÃ¡ <strong>Dispositivos vinculados</strong>.</li>
                                <li>TocÃ¡ <strong>Vincular un dispositivo</strong> y apuntÃ¡ al cÃ³digo QR.</li>
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
            <html>
            <head><meta http-equiv="refresh" content="3"><title>Iniciando...</title></head>
            <body style="background:#0f172a;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;">
                <p>Generando cÃ³digo QR... por favor esperÃ¡ unos segundos.</p>
            </body>
            </html>
        `);
    }
});

// FunciÃ³n para consultar a Google Gemini AI
async function consultarGemini(remitenteId, mensajeTexto) {
    return new Promise((resolve) => {
        let historial = userHistories.get(remitenteId) || [];

        if (historial.length === 0) {
            const instrucciones = "Hola. Sos el asistente virtual oficial del Estudio JurÃ­dico Jaime Irigoyen, especializado en derecho societario argentino (SAS, SRL, SA, Asociaciones Civiles, ONGs).\n" +
                "REGLAS OBLIGATORIAS:\n" +
                "1. NUNCA des asesoramiento legal especÃ­fico ni redactes contratos.\n" +
                "2. Si preguntan precios exactos o trÃ¡mites complejos, decÃ­ amablemente: 'Esa es una excelente consulta. Un abogado del Estudio se comunicarÃ¡ a la brevedad con vos para asesorarte en detalle. Â¿Me podrÃ­as confirmar tu nombre y correo electrÃ³nico?'\n" +
                "3. SÃ© conciso, profesional y cÃ¡lido (mÃ¡ximo 2 a 3 oraciones breves). EstÃ¡s respondiendo por WhatsApp.\n" +
                "4. Servicios: ConstituciÃ³n, mantenimiento societario (balances, asambleas ordinarias/extraordinarias, cambio de autoridades/gerencias) y procesos de disoluciÃ³n/cierre para SAS, SRL, SA, Asociaciones Civiles y ONGs.\n" +
                "A partir de ahora, respondÃ© respetando estas reglas.";

            historial.push({ role: "user", parts: [{ text: instrucciones }] });
            historial.push({ role: "model", parts: [{ text: "Entendido. ActuarÃ© como el asistente virtual del Estudio Jaime Irigoyen siguiendo estrictamente estas reglas." }] });
        }

        historial.push({ role: "user", parts: [{ text: mensajeTexto }] });

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`;
        const payload = JSON.stringify({
            contents: historial,
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
                            historial.push({ role: "model", parts: [{ text: reply }] });
                            if (historial.length > 12) {
                                historial = [...historial.slice(0, 2), ...historial.slice(-10)];
                            }
                            userHistories.set(remitenteId, historial);
                            return resolve(reply);
                        }
                    } catch (e) {
                        console.error('Error parseando respuesta de Gemini:', e);
                    }
                }
                resolve("DisculpÃ¡, en este momento estoy teniendo un inconveniente tÃ©cnico. Un abogado del estudio se comunicarÃ¡ con vos a la brevedad.");
            });
        });

        req.on('error', (err) => {
            console.error('Error en llamada a Gemini:', err);
            resolve("DisculpÃ¡, en este momento estoy teniendo un inconveniente tÃ©cnico. Un abogado del estudio se comunicarÃ¡ con vos a la brevedad.");
        });

        req.write(payload);
        req.end();
    });
}

// Inicializar conexiÃ³n con WhatsApp
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

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
            console.log('Nuevo cÃ³digo QR generado.');
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexión cerrada. Error:', lastDisconnect?.error); console.log('Reconectando:', shouldReconnect);
            isConnected = false;
            currentQR = null;
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 5000);
            }
        } else if (connection === 'open') {
            console.log('Â¡ConexiÃ³n establecida con WhatsApp exitosamente!');
            isConnected = true;
            currentQR = null;
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Escuchar mensajes entrantes
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            // Ignorar mensajes enviados por nosotros mismos o de grupos
            if (!msg.message || msg.key.fromMe || msg.key.remoteJid.includes('@g.us')) continue;

            const sender = msg.key.remoteJid;
            const text = msg.message.conversation || 
                         msg.message.extendedTextMessage?.text || 
                         msg.message.imageMessage?.caption || '';

            if (!text.trim()) continue;

            console.log(`Mensaje entrante de ${sender}: ${text}`);

            // Enviar indicador de que el bot estÃ¡ escribiendo
            await sock.sendPresenceUpdate('composing', sender);

            // Obtener respuesta de Gemini
            const respuestaAI = await consultarGemini(sender, text);

            // Pausa humana de 1.5 segundos para naturalidad
            await new Promise(r => setTimeout(r, 1500));

            // Enviar respuesta por WhatsApp
            await sock.sendMessage(sender, { text: respuestaAI });
            console.log(`Respuesta enviada a ${sender}: ${respuestaAI}`);
        }
    });
}

app.listen(PORT, () => {
    console.log(`Servidor web activo en el puerto ${PORT}`);
    setTimeout(connectToWhatsApp, 5000);
});
