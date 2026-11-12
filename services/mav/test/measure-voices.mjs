#!/usr/bin/env node
/**
 * Пересъёмка эталонных F0 голосов Silero.
 *
 * Зачем: VOICE_INFO в src/mai.js содержит измеренные значения, а не
 * документацию. Если шлюз обновит модель, эталоны надо переснять.
 *
 * Запуск: node services/mav/test/measure-voices.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { createMaiClient, SILERO_VOICES } from '../src/mai.js';
import { analyzeVoice } from '../src/audio.js';

function loadKey() {
  if (process.env.MAI_API_KEY) return process.env.MAI_API_KEY;
  const file = path.join(process.env.USERPROFILE || '', 'Desktop', 'dev', 'mai-api-key.txt');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

const apiKey = loadKey();
if (!apiKey) {
  console.error('Нет MAI_API_KEY');
  process.exit(1);
}

const client = createMaiClient({
  baseURL: process.env.MAI_BASE_URL || 'https://api-ai.mai.ru/v1',
  apiKey,
});

// Три разных текста: медиана по одному тексту смещается интонацией.
const TEXTS = [
  'Сегодня хорошая погода, и мы отправимся на прогулку в парк. Я расскажу вам интересную историю о нашем городе.',
  'Внимание: поезд отправляется через десять минут. Просьба занять свои места и проверить документы.',
  'Он открыл дверь и увидел длинный коридор. Свет падал из окна на старый деревянный пол.',
];

const rows = [];

for (const voice of SILERO_VOICES) {
  const medians = [];
  for (const text of TEXTS) {
    const result = await client.speech({ text, voice, format: 'wav' });
    const info = analyzeVoice(result.audio);
    medians.push(info.f0Median);
  }
  medians.sort((a, b) => a - b);
  const median = medians[Math.floor(medians.length / 2)];
  rows.push({ voice, median: Math.round(median), samples: medians.map((v) => Math.round(v)) });
}

console.log('\nИзмеренные F0 (медиана по трём текстам):\n');
for (const row of rows) {
  console.log(`  ${row.voice.padEnd(9)} ${String(row.median).padStart(4)} Гц   (замеры: ${row.samples.join(', ')})`);
}
console.log('\nВставьте значения в VOICE_INFO (src/mai.js).\n');
