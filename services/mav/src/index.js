#!/usr/bin/env node
/**
 * Точка входа MAV.
 *
 * Конфигурация — переменные окружения (см. .env.example):
 *   MAI_BASE_URL, MAI_API_KEY   — шлюз MAI
 *   MAV_HOST, MAV_PORT          — адрес сервера (по умолчанию 127.0.0.1:3901)
 *   MAV_API_KEY                 — если задан, /api/* требует Bearer-токен
 *   MAV_DATA_DIR                — куда писать аудио
 *   PIPER_BIN, PIPER_VOICES_DIR — локальный движок (необязательно)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.join(__dirname, '..');

/** Читает .env без зависимостей: ищем рядом с сервисом и в корне проекта. */
function loadEnv() {
  const candidates = [
    path.join(serviceRoot, '.env'),
    path.join(serviceRoot, '..', '..', '.env'),
    path.join(process.env.USERPROFILE || '', 'Desktop', 'dev', '.env'),
  ];
  for (const file of candidates) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
        if (!match) continue;
        const value = match[2].replace(/^["']|["']$/g, '');
        if (value && !process.env[match[1]]) process.env[match[1]] = value;
      }
      return file;
    } catch {
      /* файла нет — идём дальше */
    }
  }
  return null;
}

const envFile = loadEnv();

const config = {
  version: '0.1.0',
  host: process.env.MAV_HOST || '127.0.0.1',
  port: Number(process.env.MAV_PORT || 3901),
  apiKey: process.env.MAV_API_KEY || '',
  dataDir: process.env.MAV_DATA_DIR || path.join(serviceRoot, 'data'),
  mai: {
    baseURL: process.env.MAI_BASE_URL || 'https://api-ai.mai.ru/v1',
    apiKey: process.env.MAI_API_KEY || '',
    model: process.env.MAI_TTS_MODEL || 'silero-tts',
  },
  piper: {
    enabled: Boolean(process.env.PIPER_BIN),
    piperBin: process.env.PIPER_BIN || '',
    voicesDir: process.env.PIPER_VOICES_DIR || path.join(serviceRoot, 'voices'),
  },
};

if (!config.mai.apiKey) {
  console.error('MAV: не найден MAI_API_KEY.');
  console.error(`Проверены файлы: ${envFile || 'ни один .env не найден'}`);
  console.error('Задайте MAI_API_KEY в окружении или в .env рядом с сервисом.');
  process.exit(1);
}

const { server } = createServer(config);

server.listen(config.port, config.host, () => {
  console.log(`MAV ${config.version} — http://${config.host}:${config.port}`);
  console.log(`Шлюз MAI: ${config.mai.baseURL} (модель ${config.mai.model})`);
  console.log(`Данные: ${config.dataDir}`);
  console.log(`Ключ API: ${config.apiKey ? 'включён' : 'выключен (только localhost)'}`);
  console.log('Клонирование голоса: недоступно на моделях MAI (только подбор из 5 голосов).');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
