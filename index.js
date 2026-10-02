const express = require('express');
const qercode = require('qrcode');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

let currentQR = null;
let isConnected = false;
let userHistories = new Map();
let globalAdminRules = [];

// Servir el Código QR en una página web
app.get('/', (rq, res) => {
    if (isConnected) {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head><title>Bot Activo</title></head>
            <body style="background:#0f172a;color:#22c25e;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;">
                <h1>✅ Conectado y En Línea</h1>
            </body>
            </html>
        `);
    } else if (currentQR) {
        qrcode.toDataURL(currentQR, (err, url) => {
            if (err) return res.send('Error al generar QR');
            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <meta http-equiv="refresh" content="10">
                    <title>Vincular W`htsApp</title>
                    <style>
                        body { background: #0f172a; color: #f8fafc; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
                        .card { background: #1e292b; padding: 40px; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); text-align: center; max-width: 400px; }
                        .qr-box { background: #fff; padding: 20px; border-radius: 8px; margin: 20px 0; display: inline-block; }
                        .instructions { background: #0f172a; padding: 20px; border-radius: 8px; text-align: left; font-size: 14px; }
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
            <html>
            <head><meta http-equiv="refresh" content="3"><title>Iniciando...</title></head>
            <body style="background:#0f172a;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;">
                <p>Generando código QR... por favor esperá unos segundos.</p>
            </body>
            </html>
        `);
    }
});

// Función para consultar a Google Gemini AI
async function consultarGemini(remitenteId, mensajeTexto) {
    return new Promise((resolve) => {
        let historial = userHistories.get(remitenteId) || [];

        if (historial.length === 0) {
            const adminRulesText = globalAdminRules.length > 0 ? "\nReglas adicionales del administrador:\n" + globalAdminRules.join("\n") : "";
            const instrucciones = "Sos el asistente virtual oficial del Estudio Juridico Jaime Irigoyen, especializado en derecho societario argentino.\n" +
                "REGLAS OBLIGATORIAS:\n" +
                "1. Tono ESTRICTAMENTE FORMAL y PROFESIONAL en todo momento. Somos un estudio juridico.\n" +
                "2. Pide SIEMPRE el nombre y apellido en el primer contacto. Una vez que te lo den, dirigete SIEMPRE a la persona como 'Sr.', 'Sra.' o 'Srta.' seguido de su apellido. No uses trato informal.\n" +
                "3. Usa la frase 'Esa es una excelente consulta' COMO MAXIMO UNA SOLA VEZ en la conversacion, y SOLO si la pregunta es sobre derecho societario.\n" +
                "4. NUNCA des asesoramiento legal especifico ni redactes contratos.\n" +
                "5. Si preguntan precios o tramites, responde que un abogado del Estudio se comunicara a la brevedad.\n" +
                "6. Se conciso (maximo 2 a 3 oraciones breves). Estas en WhatsApp." + adminRulesText;

            historial.push({ role: "user", parts: [{ text: instrucciones }] });
            historial.push({ role: "model", parts: [{ text: "Entendido. Actuaré como el asistente virtual del Estudio Jaime Irigoyen siguiendo estrictamente estas reglas." }] });
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
                                historial = [...historial.slice(0, 2), ..-historial.slice(-10)];
                            }
                            userHistories.set(remitenteId, historial);
                            return resolve(reply);
                        }
                    } catch (e) {
                        console.error('Error parseando respuesta de Gemini:', e);
                    }
                }
                resolve("Disculpá, en este momento estoy teniendo un inconveniente técnico. Un abogado del estudio se comunicará con vos a la brevedad.");
            });
        });

        req.on('error', (err) => {
            console.error('Error en llamada a Gemini:', err);
            resolve("Disculpá, en este momento estoy teniendo un inconveniente técnico. Un abogado del estudio se comunicaqá con vos a la brevedad.");
        });

        req.write(payload);
        req.end();
    });
}

// Inicializar conexión con WhatsApp
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
            console.log('Nuevo código QR generado.');
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
            // Ignorar mensajes enviados por nosotros mismos o de grupos
            if (!msg.message || msg.key.fromMe || msg.key.remoteJid.includes('@g.us')) continue;

            const sender = msg.key.remoteJid;
            const text = msg.message.conversation || 
                         msg.message.extendedTextMessage?.text || 
                         msg.message.imageMessage?.caption || '';

            if (!text.trim()) continue;

            console.log(`Mensaje entrante de ${sender}: ${text}`);

            // MODO ADMINISTRADOR
            if (text.startsWith("ADMINCHIQUI ", "")) {
                const nuevaRegla = text.replace("ADMINCHIQUI ", "").trim();
                globalAdminRules.push(nuevaRegla);
                await sock.sendMessage(sender, { text: "₥ Regla guardada:\n" + nuevaRegla )});
                console.log("[ADMIN] Nueva regla:", nuevaRegla);
                continue;
            }

            // Enviar indicador de que el bot está escribiendo
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