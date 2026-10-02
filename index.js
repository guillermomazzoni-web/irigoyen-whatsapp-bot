const express = require('express');
const qrcode = require('qrcode');
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

// Servir el Codigo QR en una pagina web
app.get('/', (rq, res) => {
    if (isConnected) {
        res.send(
            '<!DOCTYPE html><html><head><title>Bot Activo</title></head>' +
            '<body style="background:#0f172a;color:#22c25e;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;">' +
            '<h1>&#x2705; Conectado y En Linea</h1>' +
            '</body></html>'
        );
    } else if (currentQR) {
        qrcode.toDataURL(currentQR, (err, url) => {
            if (err) return res.send('Error al generar QR');
            res.send(
                '<!DOCTYPE html><html>' +
                '<head><meta http-equiv="refresh" content="10"><title>Vincular WhatsApp</title>' +
                '<style>' +
                'body{background:#0f172a;color:#f8fafc;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}' +
                '.card{background:#1e292b;padding:40px;border-radius:12px;box-shadow:0 10px 25px rgba(0,0,0,0.5);text-align:center;max-width:400px;}' +
                '.qr-box{background:#fff;padding:20px;border-radius:8px;margin:20px 0;display:inline-block;}' +
                '.instrucciones{background:#0f172a;padding:20px;border-radius:8px;text-align:left;font-size:14px;}' +
                '.instrucciones ol{margin:0;padding-left:20px;}' +
                '.instrucciones li{margin-bottom:6px;}' +
                '</style></head>' +
                '<body><div class="card">' +
                '<h1>Vincular WhatsApp</h1>' +
                '<p>Escanea este codigo desde tu celular con el numero <strong>+54 9 11 3236-4365</strong>.</p>' +
                '<div class="qr-box"><img src="' + url + '" alt="Codigo QR de WhatsApp" /></div>' +
                '<div class="instrucciones"><ol>' +
                '<li>Abri <strong>WhatsApp Business</strong> en tu celular.</li>' +
                '<li>Toca los <strong>tres puntos</strong> o Configuracion.</li>' +
                '<li>Selecciona <strong>Dispositivos vinculados</strong>.</li>' +
                '<li>Toca <strong>Vincular un dispositivo</strong> y apunta al codigo QR.</li>' +
                '</ol></div>' +
                '</div></body></html>'
            );
        });
    } else {
        res.send(
            '<!DOCTYPE html><html>' +
            '<head><meta http-equiv="refresh" content="3"><title>Iniciando...</title></head>' +
            '<body style="background:#0f172a;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;">' +
            '<p>Generando codigo QR... por favor espera unos segundos.</p>' +
            '</body></html>'
        );
    }
});

// Funcion para consultar a Google Gemini AI
async function consultarGemini(remitenteId, mensajeTexto) {
    return new Promise((resolve) => {
        let historial = userHistories.get(remitenteId) || [];

        if (historial.length === 0) {
            const adminRulesText = globalAdminRules.length > 0
                ? '\nReglas adicionales del administrador:\n' + globalAdminRules.join('\n')
                : '';

            const instrucciones =
                'Sos el asistente virtual oficial del Estudio Juridico Jaime Irigoyen, especializado en derecho societario argentino (SAS, SRL, SA, Asociaciones Civiles, ONGs).\n' +
                'REGLAS OBLIGATORIAS:\n' +
                '1. Tono ESTRICTAMENTE FORMAL y PROFESIONAL en todo momento. Somos un estudio juridico serio.\n' +
                '2. En el PRIMER mensaje SIEMPRE pedi el nombre y apellido de la persona. Una vez que te lo den, dirigite SIEMPRE a ella como "Sr.", "Sra." o "Srta." seguido de su apellido. NUNCA uses trato informal.\n' +
                '3. Usa la frase "Esa es una excelente consulta" COMO MAXIMO UNA SOLA VEZ en toda la conversacion, y SOLO si la pregunta es especificamente sobre derecho societario.\n' +
                '4. NUNCA des asesoramiento legal especifico ni redactes contratos.\n' +
                '5. Si preguntan precios exactos o tramites complejos, respondeles formalmente que un abogado del Estudio se comunicara a la brevedad para asesorarlo en detalle.\n' +
                '6. Se conciso (maximo 2 a 3 oraciones breves). Estas respondiendo por WhatsApp.\n' +
                '7. Servicios: Constitucion, mantenimiento societario (balances, asambleas, cambio de autoridades) y disolucion/cierre para SAS, SRL, SA, Asociaciones Civiles y ONGs.\n' +
                adminRulesText;

            historial.push({ role: 'user', parts: [{ text: instrucciones }] });
            historial.push({ role: 'model', parts: [{ text: 'Entendido. Actuare como el asistente virtual formal del Estudio Jaime Irigoyen siguiendo estrictamente estas reglas.' }] });
        }

        historial.push({ role: 'user', parts: [{ text: mensajeTexto }] });

        const apiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=' + GEMINI_API_KEY;
        const payload = JSON.stringify({
            contents: historial,
            generationConfig: {
                maxOutputTokens: 250,
                temperature: 0.5
            }
        });

        const req = https.request(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            },
            timeout: 15000
        }, (response) => {
            let data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', () => {
                if (response.statusCode === 200) {
                    try {
                        const parsed = JSON.parse(data);
                        const reply = parsed.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                        if (reply) {
                            historial.push({ role: 'model', parts: [{ text: reply }] });
                            if (historial.length > 14) {
                                historial = [...historial.slice(0, 2), ...historial.slice(-12)];
                            }
                            userHistories.set(remitenteId, historial);
                            return resolve(reply);
                        }
                    } catch (e) {
                        console.error('Error parseando respuesta de Gemini:', e);
                    }
                }
                resolve('Disculpe, en este momento estoy teniendo un inconveniente tecnico. Un abogado del estudio se comunicara con usted a la brevedad.');
            });
        });

        req.on('error', (err) => {
            console.error('Error en llamada a Gemini:', err);
            resolve('Disculpe, en este momento estoy teniendo un inconveniente tecnico. Un abogado del estudio se comunicara con usted a la brevedad.');
        });

        req.write(payload);
        req.end();
    });
}

// Inicializar conexion con WhatsApp
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
            console.log('Nuevo codigo QR generado.');
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexion cerrada. Error:', lastDisconnect?.error?.message || lastDisconnect?.error);
            console.log('Reconectando:', shouldReconnect);
            isConnected = false;
            currentQR = null;
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 5000);
            }
        } else if (connection === 'open') {
            console.log('Conexion establecida con WhatsApp exitosamente!');
            isConnected = true;
            currentQR = null;
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Escuchar mensajes entrantes
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe || msg.key.remoteJid.includes('@g.us')) continue;

            const sender = msg.key.remoteJid;
            const text = msg.message.conversation ||
                         msg.message.extendedTextMessage?.text ||
                         msg.message.imageMessage?.caption || '';

            if (!text.trim()) continue;

            console.log('Mensaje entrante de ' + sender + ': ' + text);

            // MODO ADMINISTRADOR OCULTO
            if (text.startsWith('ADMINCHIQUI ')) {
                const nuevaRegla = text.replace('ADMINCHIQUI ', '').trim();
                globalAdminRules.push(nuevaRegla);
                await sock.sendMessage(sender, { text: 'Regla guardada exitosamente:\n"' + nuevaRegla + '"\n\nEl bot la tendra en cuenta a partir de ahora.' });
                console.log('[ADMIN] Nueva regla guardada:', nuevaRegla);
                continue;
            }

            // Enviar indicador de escritura
            await sock.sendPresenceUpdate('composing', sender);

            // Obtener respuesta de Gemini
            const respuestaAI = await consultarGemini(sender, text);

            // Pausa humana de 1.5 segundos
            await new Promise(r => setTimeout(r, 1500));

            // Enviar respuesta por WhatsApp
            await sock.sendMessage(sender, { text: respuestaAI });
            console.log('Respuesta enviada a ' + sender + ': ' + respuestaAI);
        }
    });
}

app.listen(PORT, () => {
    console.log('Servidor web activo en el puerto ' + PORT);
    setTimeout(connectToWhatsApp, 5000);
});