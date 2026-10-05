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

app.get('/', (rq, res) => {
    if (isConnected) {
        res.send('<!DOCTYPE html><html><head><title>Bot Activo</title></head><body style="background:#0f172a;color:#22c25e;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;"><h1>&#x2705; Conectado y En Linea</h1></body></html>');
    } else if (currentQR) {
        qrcode.toDataURL(currentQR, (err, url) => {
            if (err) return res.send('Error al generar QR');
            res.send('<!DOCTYPE html><html><head><meta http-equiv="refresh" content="10"><title>Vincular WhatsApp</title><style>body{background:#0f172a;color:#f8fafc;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}.card{background:#1e292b;padding:40px;border-radius:12px;box-shadow:0 10px 25px rgba(0,0,0,0.5);text-align:center;max-width:400px;}.qr-box{background:#fff;padding:20px;border-radius:8px;margin:20px 0;display:inline-block;}.instrucciones{background:#0f172a;padding:20px;border-radius:8px;text-align:left;font-size:14px;}.instrucciones ol{margin:0;padding-left:20px;}.instrucciones li{margin-bottom:6px;}</style></head><body><div class="card"><h1>Vincular WhatsApp</h1><p>Escanea este codigo desde tu celular con el numero <strong>+54 9 11 3236-4365</strong>.</p><div class="qr-box"><img src="' + url + '" alt="Codigo QR de WhatsApp" /></div><div class="instrucciones"><ol><li>Abri <strong>WhatsApp Business</strong> en tu celular.</li><li>Toca los <strong>tres puntos</strong> o Configuracion.</li><li>Selecciona <strong>Dispositivos vinculados</strong>.</li><li>Toca <strong>Vincular un dispositivo</strong> y apunta al codigo QR.</li></ol></div></div></body></html>');
        });
    } else {
        res.send('<!DOCTYPE html><html><head><meta http-equiv="refresh" content="3"><title>Iniciando...</title></head><body style="background:#0f172a;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;"><p>Generando codigo QR... por favor espera unos segundos.</p></body></html>');
    }
});

async function consultarGemini(remitenteId, mensajeTexto) {
    return new Promise((resolve) => {
        let historial = userHistories.get(remit
