#!/usr/bin/env node
/**
 * Тесты MAV без сети: WAV, нарезка текста, анализ голоса, хранилище.
 *
 * Запуск: node services/mav/test/unit.mjs
 * Сетевые проверки — отдельно, в test/live.mjs.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildWav, parseWav, concatWav, wavDuration, silence } from '../src/wav.js';
import { chunkText, stripMarkdown, splitSentences } from '../src/text.js';
import { analyzeVoice, estimateTempo, toFloat32 } from '../src/audio.js';
import { matchVoice, suggestSpeed } from '../src/voice.js';
import { splitChapters } from '../src/service.js';
import { createStorage } from '../src/storage.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}

/** Генерирует синусоиду как PCM16 — эталон для проверки F0. */
function tone(frequency, seconds, sampleRate = 48000, amplitude = 0.5) {
  const frames = Math.round(sampleRate * seconds);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const value = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * amplitude;
    data.writeInt16LE(Math.round(value * 32767), i * 2);
  }
  return buildWav(data, { sampleRate });
}

console.log('\nWAV');

test('parseWav читает формат и данные', () => {
  const wav = tone(200, 0.5);
  const parsed = parseWav(wav);
  assert.equal(parsed.sampleRate, 48000);
  assert.equal(parsed.channels, 1);
  assert.equal(parsed.bitsPerSample, 16);
  assert.equal(parsed.data.length, 48000);
});

test('wavDuration считает длительность', () => {
  const wav = tone(200, 1.5);
  assert.ok(Math.abs(wavDuration(wav) - 1.5) < 0.01, `получено ${wavDuration(wav)}`);
});

test('concatWav склеивает с паузой', () => {
  const a = tone(200, 0.5);
  const b = tone(200, 0.5);
  const joined = concatWav([a, b], { gapMs: 200 });
  const expected = 0.5 + 0.2 + 0.5;
  assert.ok(Math.abs(wavDuration(joined) - expected) < 0.02, `получено ${wavDuration(joined)}`);
});

test('concatWav отвергает разные форматы', () => {
  const a = tone(200, 0.2, 48000);
  const b = tone(200, 0.2, 22050);
  assert.throws(() => concatWav([a, b]), /форматы не совпадают/);
});

test('parseWav отвергает не-WAV', () => {
  assert.throws(() => parseWav(Buffer.from('не аудио вообще, точно не RIFF-файл')), /RIFF|короче/);
});

test('silence даёт нужную длину', () => {
  const s = silence(500, { sampleRate: 48000 });
  assert.equal(s.length, 48000);
});

console.log('\nТекст');

test('splitSentences делит по знакам конца', () => {
  const parts = splitSentences('Первое. Второе! Третье?');
  assert.equal(parts.length, 3);
});

test('splitSentences не рвёт сокращения', () => {
  const parts = splitSentences('Это т.е. пример. И второе предложение.');
  assert.equal(parts.length, 2, `получено ${JSON.stringify(parts)}`);
});

test('chunkText не превышает лимит', () => {
  const text = 'Предложение номер один. '.repeat(200);
  const chunks = chunkText(text, 400);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 400, `кусок ${chunk.length} > 400`);
});

test('chunkText сохраняет весь текст', () => {
  const text = 'Первое предложение. Второе предложение. Третье предложение.';
  const chunks = chunkText(text, 30);
  const joined = chunks.join(' ').replace(/\s+/g, ' ');
  assert.equal(joined, text.replace(/\s+/g, ' '));
});

test('chunkText режет длинное предложение без пробелов', () => {
  const text = 'а'.repeat(1000);
  const chunks = chunkText(text, 100);
  assert.ok(chunks.every((c) => c.length <= 100));
  assert.equal(chunks.join('').length, 1000);
});

test('chunkText на пустом тексте даёт пусто', () => {
  assert.deepEqual(chunkText('   \n\n  '), []);
});

test('stripMarkdown убирает код и разметку', () => {
  const md = '# Заголовок\n\nТекст **жирный** и `код`.\n\n```js\nconst a = 1;\n```\n\n- пункт';
  const out = stripMarkdown(md);
  assert.ok(!out.includes('const a = 1'), 'код остался');
  assert.ok(!out.includes('**'), 'разметка осталась');
  assert.ok(out.includes('жирный'));
  assert.ok(out.includes('Заголовок'));
});

test('stripMarkdown убирает таблицы', () => {
  const md = '| a | b |\n|---|---|\n| 1 | 2 |\n\nПосле таблицы.';
  const out = stripMarkdown(md);
  assert.ok(!out.includes('|'), `таблица осталась: ${out}`);
  assert.ok(out.includes('После таблицы'));
});

console.log('\nАнализ голоса');

test('analyzeVoice находит F0 синусоиды 120 Гц', () => {
  const wav = tone(120, 1.0);
  const result = analyzeVoice(wav);
  assert.ok(Math.abs(result.f0Median - 120) < 6, `получено ${result.f0Median}`);
});

test('analyzeVoice находит F0 синусоиды 220 Гц', () => {
  const wav = tone(220, 1.0);
  const result = analyzeVoice(wav);
  assert.ok(Math.abs(result.f0Median - 220) < 10, `получено ${result.f0Median}`);
});

test('analyzeVoice на тишине не находит тон', () => {
  const wav = buildWav(silence(500));
  const result = analyzeVoice(wav);
  assert.equal(result.f0Median, 0);
  assert.equal(result.voicedRatio, 0);
});

test('toFloat32 переводит диапазон', () => {
  const wav = tone(200, 0.1, 48000, 1.0);
  const samples = toFloat32(parseWav(wav).data);
  const max = Math.max(...samples);
  assert.ok(max > 0.9 && max <= 1.0, `максимум ${max}`);
});

test('estimateTempo возвращает длительность', () => {
  const wav = tone(200, 2.0);
  const result = estimateTempo(wav);
  assert.ok(Math.abs(result.duration - 2.0) < 0.05);
});

console.log('\nПодбор голоса');

test('matchVoice выбирает мужской голос для 110 Гц', () => {
  const wav = tone(110, 1.0);
  const match = matchVoice(wav);
  assert.equal(match.voice, 'aidar', `выбран ${match.voice}`);
  assert.ok(match.confidence > 0.8);
});

test('matchVoice выбирает женский голос для 210 Гц', () => {
  const wav = tone(210, 1.0);
  const match = matchVoice(wav);
  assert.ok(['kseniya', 'xenia', 'baya'].includes(match.voice), `выбран ${match.voice}`);
});

test('matchVoice учитывает gender', () => {
  const wav = tone(110, 1.0);
  const match = matchVoice(wav, { gender: 'female' });
  assert.ok(['baya', 'kseniya', 'xenia'].includes(match.voice), `выбран ${match.voice}`);
});

test('matchVoice отвергает тишину', () => {
  const wav = buildWav(silence(500));
  assert.throws(() => matchVoice(wav), /высоту тона/);
});

test('matchVoice возвращает кандидатов по возрастанию расстояния', () => {
  const match = matchVoice(tone(150, 1.0));
  assert.equal(match.candidates.length, 5);
  for (let i = 1; i < match.candidates.length; i += 1) {
    assert.ok(match.candidates[i].distance >= match.candidates[i - 1].distance);
  }
});

test('suggestSpeed ограничивает диапазон', () => {
  assert.equal(suggestSpeed(0), 1);
  assert.ok(suggestSpeed(100) <= 1.3);
  assert.ok(suggestSpeed(0.1) >= 0.7);
});

console.log('\nГлавы');

test('splitChapters делит по заголовкам', () => {
  const md = '# Глава 1\n\nТекст первой.\n\n# Глава 2\n\nТекст второй.';
  const chapters = splitChapters(md);
  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].title, 'Глава 1');
  assert.equal(chapters[1].title, 'Глава 2');
});

test('splitChapters без заголовков даёт одну главу', () => {
  const chapters = splitChapters('Просто текст без заголовков.');
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].title, 'Вступление');
});

test('splitChapters пропускает пустые главы', () => {
  const chapters = splitChapters('# Пустая\n\n# С текстом\n\nТекст.');
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].title, 'С текстом');
});

console.log('\nХранилище');

test('storage сохраняет и читает аудио', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mav-test-'));
  const storage = createStorage(dir);
  const wav = tone(200, 0.3);
  const item = storage.saveAudio(wav, { kind: 'speech', voice: 'baya' });
  assert.ok(item.id);
  assert.equal(item.bytes, wav.length);
  assert.deepEqual(storage.read(item.id), wav);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('storage не дублирует одинаковое аудио', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mav-test-'));
  const storage = createStorage(dir);
  const wav = tone(200, 0.3);
  const first = storage.saveAudio(wav, { kind: 'speech' });
  const second = storage.saveAudio(wav, { kind: 'speech' });
  assert.equal(first.id, second.id);
  assert.equal(storage.list().length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('storage удаляет запись', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mav-test-'));
  const storage = createStorage(dir);
  const item = storage.saveAudio(tone(200, 0.2), { kind: 'speech' });
  assert.equal(storage.remove(item.id), true);
  assert.equal(storage.get(item.id), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\nИтого: ${passed} ok, ${failed} fail\n`);
process.exit(failed ? 1 : 0);
