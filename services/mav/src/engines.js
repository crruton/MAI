/**
 * Движки синтеза.
 *
 * Два типа:
 * - `mai` — шлюз MAI (silero-tts). Работает всегда, если есть ключ. Клонирования нет.
 * - `piper` — локальный офлайн-движок (rhasspy/piper, MIT). Работает без сети,
 *   но требует бинарник и ONNX-модель. На этой машине НЕ проверен.
 *
 * Интерфейс одинаковый: synthesize({text, voice, speed, format}) → {audio, contentType}.
 * Если движок недоступен, он честно сообщает об этом, а вызывающий код решает,
 * переключаться ли на MAI.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createMaiClient } from './mai.js';

/** Движок MAI: сетевой, без клонирования, пять голосов. */
export function maiEngine({ baseURL, apiKey, model = 'silero-tts' }) {
  const client = createMaiClient({ baseURL, apiKey });
  return {
    id: 'mai',
    title: 'MAI · Silero',
    kind: 'remote',
    cloning: false,
    voices: ['aidar', 'baya', 'kseniya', 'eugene', 'xenia'],
    async available() {
      try {
        const models = await client.models();
        return models.some((m) => m.id === model);
      } catch {
        return false;
      }
    },
    async synthesize({ text, voice = 'baya', speed = 1, format = 'wav' }) {
      return client.speech({ text, voice, model, format, speed });
    },
  };
}

/**
 * Движок Piper: локальный, офлайн.
 *
 * Требует:
 * - бинарник piper (piper.exe на Windows) в PATH или по пути piperBin;
 * - ONNX-модель голоса и рядом .onnx.json.
 *
 * Русские голоса: ru_RU-denis-medium, ru_RU-dmitri-medium,
 * ru_RU-irina-medium, ru_RU-ruslan-medium.
 *
 * ВАЖНО: на машине разработчика не проверено — бинарника нет.
 */
export function piperEngine({ piperBin = 'piper', voicesDir = '', voices = [] } = {}) {
  return {
    id: 'piper',
    title: 'Piper · локальный',
    kind: 'local',
    cloning: false,
    voices,
    async available() {
      if (!piperBin) return false;
      return new Promise((resolve) => {
        const child = spawn(piperBin, ['--help'], { windowsHide: true });
        const timer = setTimeout(() => {
          child.kill();
          resolve(false);
        }, 4000);
        child.on('error', () => {
          clearTimeout(timer);
          resolve(false);
        });
        child.on('exit', () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
    },
    async synthesize({ text, voice, speed = 1 }) {
      if (!voice) throw new Error('Piper: не выбран голос');
      const modelPath = path.isAbsolute(voice) ? voice : path.join(voicesDir, `${voice}.onnx`);
      if (!fs.existsSync(modelPath)) throw new Error(`Piper: модель не найдена — ${modelPath}`);

      const lengthScale = speed > 0 ? 1 / speed : 1;

      return new Promise((resolve, reject) => {
        const args = ['--model', modelPath, '--output_file', '-', '--length_scale', String(lengthScale)];
        const child = spawn(piperBin, args, { windowsHide: true });
        const chunks = [];
        const errors = [];

        child.stdout.on('data', (chunk) => chunks.push(chunk));
        child.stderr.on('data', (chunk) => errors.push(chunk));
        child.on('error', (err) => reject(new Error(`Piper: не запускается — ${err.message}`)));
        child.on('exit', (code) => {
          if (code !== 0) {
            reject(new Error(`Piper: код ${code} — ${Buffer.concat(errors).toString('utf8').slice(0, 300)}`));
            return;
          }
          resolve({ audio: Buffer.concat(chunks), contentType: 'audio/wav', format: 'wav' });
        });

        child.stdin.write(String(text));
        child.stdin.end();
      });
    },
  };
}

/** Реестр движков: собирается из конфигурации. */
export function createEngines(config) {
  const engines = new Map();
  engines.set('mai', maiEngine(config.mai || {}));
  if (config.piper?.enabled) engines.set('piper', piperEngine(config.piper));
  return engines;
}
