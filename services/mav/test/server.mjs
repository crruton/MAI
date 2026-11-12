#!/usr/bin/env node
/**
 * Тест HTTP-сервера MAV: маршруты, коды ответов, защита ключом.
 *
 * Запуск: node services/mav/test/server.mjs
 * Поднимает сервер на свободном порту и обращается к нему по HTTP.
 * Синтез идёт в настоящий шлюз MAI, поэтому нужен MAI_API_KEY.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';

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
  try {
    return fs.readFileSync(path.join(process.env.USERPROFILE || '', 'Desktop', 'dev', 'mai-api-key.txt'), 'utf8').trim();
  } catch {
    return '';
  }
}

const maiKey = loadKey();
if (!maiKey) {
  console.error('Нет MAI_API_KEY — тест сервера пропущен.');
  process.exit(0);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mav-server-'));
const config = {
  version: 'test',
  dataDir,
  apiKey: 'test-key',
  mai: { baseURL: process.env.MAI_BASE_URL || 'https://api-ai.mai.ru/v1', apiKey: maiKey, model: 'silero-tts' },
  piper: { enabled: false },
};

const { server } = createServer(config);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const auth = { Authorization: 'Bearer test-key' };

console.log(`\nТест сервера MAV → ${base}\n`);

console.log('Защита и статика');

await test('без ключа /api отвечает 401', async () => {
  const response = await fetch(`${base}/api/health`);
  if (response.status !== 401) throw new Error(`код ${response.status}`);
});

await test('с ключом /api/health отвечает 200', async () => {
  const response = await fetch(`${base}/api/health`, { headers: auth });
  if (response.status !== 200) throw new Error(`код ${response.status}`);
  const body = await response.json();
  if (!body.ok) throw new Error('ok=false');
  if (body.cloning !== false) throw new Error('cloning должен быть false');
});

await test('главная страница отдаётся', async () => {
  const response = await fetch(`${base}/`);
  if (response.status !== 200) throw new Error(`код ${response.status}`);
  const html = await response.text();
  if (!html.includes('MAV')) throw new Error('нет заголовка MAV');
});

await test('выход за пределы public запрещён', async () => {
  const response = await fetch(`${base}/../package.json`);
  if (response.status === 200) throw new Error('файл вне public отдан');
});

await test('неизвестный маршрут даёт 404', async () => {
  const response = await fetch(`${base}/api/nope`, { headers: auth });
  if (response.status !== 404) throw new Error(`код ${response.status}`);
});

console.log('\nГолоса');

await test('/api/voices отдаёт пять голосов', async () => {
  const response = await fetch(`${base}/api/voices`, { headers: auth });
  const body = await response.json();
  if (body.voices.length !== 5) throw new Error(`голосов ${body.voices.length}`);
  if (!body.voices.every((v) => v.f0 > 0)) throw new Error('у голоса нет F0');
});

console.log('\nСинтез');

await test('POST /api/synthesize возвращает id и url', async () => {
  const response = await fetch(`${base}/api/synthesize`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Проверка сервера.', voice: 'baya', format: 'wav' }),
  });
  if (response.status !== 200) throw new Error(`код ${response.status}: ${await response.text()}`);
  const body = await response.json();
  if (!body.id || !body.url) throw new Error('нет id или url');
  if (body.duration <= 0) throw new Error('длительность 0');
});

await test('аудио по url отдаётся как WAV', async () => {
  const created = await (await fetch(`${base}/api/synthesize`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Проверка выдачи файла.', voice: 'baya', format: 'wav' }),
  })).json();

  // Тег <audio> не умеет заголовок Authorization, поэтому ключ передаётся в query.
  const response = await fetch(`${base}${created.url}?key=test-key`);
  if (response.status !== 200) throw new Error(`код ${response.status}`);
  if (!response.headers.get('content-type').includes('wav')) throw new Error('не WAV');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') throw new Error('нет сигнатуры RIFF');
});

await test('аудио без ключа не отдаётся', async () => {
  const created = await (await fetch(`${base}/api/synthesize`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Закрытый файл.', voice: 'baya', format: 'wav' }),
  })).json();

  const response = await fetch(`${base}${created.url}`);
  if (response.status !== 401) throw new Error(`код ${response.status}`);
});

await test('пустой текст даёт 400', async () => {
  const response = await fetch(`${base}/api/synthesize`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '   ', voice: 'baya' }),
  });
  if (response.status !== 400) throw new Error(`код ${response.status}`);
});

await test('неизвестный голос даёт 400', async () => {
  const response = await fetch(`${base}/api/synthesize`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Тест', voice: 'alloy' }),
  });
  if (response.status !== 400) throw new Error(`код ${response.status}`);
});

await test('битый JSON даёт 400', async () => {
  const response = await fetch(`${base}/api/synthesize`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: '{не json',
  });
  if (response.status !== 400) throw new Error(`код ${response.status}`);
});

console.log('\nГлавы и книга');

await test('POST /api/chapters делит текст', async () => {
  const response = await fetch(`${base}/api/chapters`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '# Первая\n\nТекст.\n\n# Вторая\n\nЕщё текст.' }),
  });
  const body = await response.json();
  if (body.chapters.length !== 2) throw new Error(`глав ${body.chapters.length}`);
});

await test('POST /api/narrate озвучивает главы', async () => {
  const response = await fetch(`${base}/api/narrate`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '# Глава\n\nКороткий текст главы.', voice: 'baya' }),
  });
  if (response.status !== 200) throw new Error(`код ${response.status}: ${await response.text()}`);
  const body = await response.json();
  if (!body.chapters.length) throw new Error('глав нет');
  if (!body.chapters[0].url) throw new Error('нет url главы');
});

console.log('\nПодбор голоса');

await test('POST /api/voice-match принимает файл', async () => {
  const speech = await (await fetch(`${base}/api/synthesize`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Референс для подбора голоса.', voice: 'aidar', format: 'wav' }),
  })).json();

  const wav = Buffer.from(await (await fetch(`${base}${speech.url}?key=test-key`)).arrayBuffer());
  const form = new FormData();
  form.append('file', new Blob([wav]), 'ref.wav');
  form.append('gender', 'any');

  const response = await fetch(`${base}/api/voice-match`, { method: 'POST', headers: auth, body: form });
  if (response.status !== 200) throw new Error(`код ${response.status}: ${await response.text()}`);
  const body = await response.json();
  if (!body.voice) throw new Error('голос не выбран');
  if (body.candidates.length !== 5) throw new Error(`кандидатов ${body.candidates.length}`);
  console.log(`       F0 ${body.measured.f0Median} Гц → ${body.voice}`);
});

await test('voice-match без файла даёт 400', async () => {
  const form = new FormData();
  form.append('gender', 'any');
  const response = await fetch(`${base}/api/voice-match`, { method: 'POST', headers: auth, body: form });
  if (response.status !== 400) throw new Error(`код ${response.status}`);
});

console.log('\nИстория');

await test('GET /api/history отдаёт записи', async () => {
  const response = await fetch(`${base}/api/history`, { headers: auth });
  const body = await response.json();
  if (!body.items.length) throw new Error('история пуста');
});

await test('DELETE /api/audio/:id удаляет запись', async () => {
  const created = await (await fetch(`${base}/api/synthesize`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Запись на удаление.', voice: 'baya' }),
  })).json();

  const response = await fetch(`${base}/api/audio/${created.id}`, { method: 'DELETE', headers: auth });
  if (response.status !== 200) throw new Error(`код ${response.status}`);

  const after = await fetch(`${base}/api/audio/${created.id}?key=test-key`);
  if (after.status !== 404) throw new Error(`после удаления код ${after.status}`);
});

server.close();
fs.rmSync(dataDir, { recursive: true, force: true });

console.log(`\nИтого: ${passed} ok, ${failed} fail\n`);
process.exit(failed ? 1 : 0);
