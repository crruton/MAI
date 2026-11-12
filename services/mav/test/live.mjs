#!/usr/bin/env node
/**
 * Живые тесты MAV: настоящий шлюз MAI.
 *
 * Запуск: node services/mav/test/live.mjs
 * Требует MAI_API_KEY. Тратит токены/квоту, поэтому не входит в npm test.
 *
 * Проверяет то, что нельзя проверить моками: реальные голоса, лимит длины,
 * склейку длинного текста, распознавание и дубляж.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMaiClient, SILERO_VOICES } from '../src/mai.js';
import { maiEngine } from '../src/engines.js';
import { synthesize, narrateBook, dub, pickVoice } from '../src/service.js';
import { wavDuration } from '../src/wav.js';
import { analyzeVoice } from '../src/audio.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}

function loadKey() {
  if (process.env.MAI_API_KEY) return process.env.MAI_API_KEY;
  const candidates = [
    path.join(process.env.USERPROFILE || '', 'Desktop', 'dev', 'mai-api-key.txt'),
    path.join(process.env.USERPROFILE || '', 'Desktop', 'dev', '.env'),
  ];
  for (const file of candidates) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      const direct = text.trim();
      if (direct && !direct.includes('=')) return direct;
      const match = /MAI_API_KEY\s*=\s*(.+)/.exec(text);
      if (match) return match[1].trim().replace(/^["']|["']$/g, '');
    } catch {
      /* нет файла */
    }
  }
  return '';
}

const apiKey = loadKey();
if (!apiKey) {
  console.error('Нет MAI_API_KEY — живые тесты пропущены.');
  process.exit(0);
}

const baseURL = process.env.MAI_BASE_URL || 'https://api-ai.mai.ru/v1';
const client = createMaiClient({ baseURL, apiKey });
const engine = maiEngine({ baseURL, apiKey });

console.log(`\nЖивые тесты MAV → ${baseURL}\n`);

console.log('Шлюз');

await test('ключ работает, /models отвечает', async () => {
  const models = await client.models();
  if (!models.length) throw new Error('список моделей пуст');
  const audio = models.filter((m) => m.mode === 'audio_speech').map((m) => m.id);
  console.log(`       аудио-модели: ${audio.join(', ')}`);
});

await test('движок MAI доступен', async () => {
  const ok = await engine.available();
  if (!ok) throw new Error('silero-tts не найден в /models');
});

console.log('\nСинтез');

await test('все пять голосов дают аудио', async () => {
  for (const voice of SILERO_VOICES) {
    const result = await client.speech({ text: 'Проверка голоса.', voice, format: 'wav' });
    if (result.audio.length < 1000) throw new Error(`${voice}: слишком короткое аудио`);
  }
});

await test('синтез возвращает WAV 48 кГц', async () => {
  const result = await client.speech({ text: 'Проверка формата.', voice: 'baya', format: 'wav' });
  const info = analyzeVoice(result.audio);
  if (info.sampleRate !== 48000) throw new Error(`частота ${info.sampleRate}`);
  if (info.duration < 0.5) throw new Error(`длительность ${info.duration}`);
});

await test('mp3 тоже работает', async () => {
  const result = await client.speech({ text: 'Проверка mp3.', voice: 'baya', format: 'mp3' });
  if (!result.contentType.includes('mpeg')) throw new Error(`тип ${result.contentType}`);
});

await test('латиница отвергается с понятной ошибкой', async () => {
  try {
    await client.speech({ text: 'Hello world', voice: 'baya' });
    throw new Error('ожидалась ошибка, но запрос прошёл');
  } catch (err) {
    if (!/HTTP 400/.test(err.message)) throw new Error(`неожиданная ошибка: ${err.message}`);
  }
});

await test('неизвестный голос отвергается до запроса', async () => {
  try {
    await client.speech({ text: 'Тест', voice: 'alloy' });
    throw new Error('ожидалась ошибка');
  } catch (err) {
    if (!/не поддерживается/.test(err.message)) throw new Error(err.message);
  }
});

console.log('\nДлинный текст');

await test('текст 3000 символов режется и склеивается', async () => {
  const text = 'Это предложение для проверки длинного синтеза речи. '.repeat(60);
  const result = await synthesize(engine, { text, voice: 'baya', format: 'wav' });
  if (result.chunks < 2) throw new Error(`кусков ${result.chunks}, ожидалось больше`);
  if (result.duration < 30) throw new Error(`длительность ${result.duration} с — подозрительно мало`);
  console.log(`       ${result.characters} символов → ${result.chunks} кусков → ${result.duration} с`);
});

await test('склейка не теряет звук на стыках', async () => {
  const text = 'Первое предложение. Второе предложение. Третье предложение.';
  const result = await synthesize(engine, { text, voice: 'baya', format: 'wav' });
  const info = analyzeVoice(result.audio);
  if (info.voicedRatio < 0.2) throw new Error(`доля речи ${info.voicedRatio} — похоже, склейка сломана`);
});

console.log('\nПодбор голоса');

await test('мужской синтез подбирается к мужскому голосу', async () => {
  const reference = await client.speech({ text: 'Это референсная запись мужского голоса для проверки.', voice: 'aidar', format: 'wav' });
  const match = pickVoice(reference.audio);
  if (match.voice !== 'aidar') throw new Error(`выбран ${match.voice}, ожидался aidar`);
  console.log(`       F0 ${match.measured.f0Median} Гц → ${match.voice} (уверенность ${match.confidence})`);
});

await test('женский синтез подбирается к женскому голосу', async () => {
  const reference = await client.speech({ text: 'Это референсная запись женского голоса для проверки.', voice: 'baya', format: 'wav' });
  const match = pickVoice(reference.audio);
  if (!['baya', 'kseniya', 'xenia'].includes(match.voice)) throw new Error(`выбран ${match.voice}`);
  console.log(`       F0 ${match.measured.f0Median} Гц → ${match.voice} (уверенность ${match.confidence})`);
});

console.log('\nРаспознавание и дубляж');

await test('распознавание возвращает текст', async () => {
  const speech = await client.speech({ text: 'Проверка распознавания речи.', voice: 'baya', format: 'wav' });
  const result = await client.transcribe({ audio: speech.audio, model: 'whisper-large-v3' });
  if (!result.text) throw new Error('текст пуст');
  console.log(`       «${result.text}»`);
});

await test('дубляж проходит полный цикл', async () => {
  const speech = await client.speech({ text: 'Привет. Это проверка дубляжа.', voice: 'baya', format: 'wav' });
  const stt = {
    transcribe: ({ audio, filename, model }) => client.transcribe({ audio, filename, model }),
    synthesize: (params) => engine.synthesize(params),
  };
  const result = await dub(stt, { audio: speech.audio, filename: 'test.wav', voice: 'baya' });
  if (!result.translatedText) throw new Error('перевод пуст');
  if (!result.audio.length) throw new Error('аудио пусто');
  console.log(`       «${result.sourceText}» → ${result.duration} с`);
});

console.log('\nКнига');

await test('озвучка книги делит на главы', async () => {
  const md = '# Глава 1\n\nПервая глава текста.\n\n# Глава 2\n\nВторая глава текста.';
  const result = await narrateBook(engine, { text: md, voice: 'baya' });
  if (result.chapters.length !== 2) throw new Error(`глав ${result.chapters.length}`);
  if (result.totalDuration < 2) throw new Error(`длительность ${result.totalDuration}`);
  console.log(`       ${result.chapters.length} главы, ${result.totalDuration} с`);
});

console.log(`\nИтого: ${passed} ok, ${failed} fail\n`);
process.exit(failed ? 1 : 0);
