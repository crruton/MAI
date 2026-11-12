/**
 * HTTP-сервер MAV: REST API и веб-интерфейс.
 *
 * Без внешних зависимостей: node:http, node:fs. Причина — сервис должен
 * запускаться одной командой `node src/server.js` без npm install.
 *
 * Безопасность:
 * - по умолчанию слушает 127.0.0.1, не 0.0.0.0;
 * - если задан MAV_API_KEY, все /api/* требуют заголовок Authorization;
 * - размер тела запроса ограничен;
 * - статика отдаётся только из папки public.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngines } from './engines.js';
import { synthesize, narrateBook, dub, pickVoice, splitChapters } from './service.js';
import { createStorage } from './storage.js';
import { SILERO_VOICES, VOICE_INFO, TTS_MODELS, STT_MODELS } from './mai.js';
import { analyzeVoice } from './audio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const MAX_BODY_BYTES = 32 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`Тело запроса больше ${MAX_BODY_BYTES} байт`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('Тело запроса не является корректным JSON');
  }
}

/** Разбирает multipart/form-data: нужен для загрузки референса и дубляжа. */
function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!boundaryMatch) throw new Error('Нет boundary в multipart/form-data');
  const boundary = `--${boundaryMatch[1] || boundaryMatch[2]}`;
  const parts = [];
  const delimiter = Buffer.from(boundary);
  let start = buffer.indexOf(delimiter);

  while (start !== -1) {
    const next = buffer.indexOf(delimiter, start + delimiter.length);
    if (next === -1) break;
    const section = buffer.subarray(start + delimiter.length + 2, next - 2);
    const headerEnd = section.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headers = section.subarray(0, headerEnd).toString('utf8');
      const data = section.subarray(headerEnd + 4);
      const nameMatch = /name="([^"]+)"/i.exec(headers);
      const fileMatch = /filename="([^"]*)"/i.exec(headers);
      if (nameMatch) {
        parts.push({ name: nameMatch[1], filename: fileMatch ? fileMatch[1] : null, data });
      }
    }
    start = next;
  }
  return parts;
}

function serveStatic(req, res, urlPath) {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const target = path.resolve(publicDir, relative);
  // Защита от выхода за пределы public.
  if (!target.startsWith(path.resolve(publicDir))) {
    json(res, 403, { error: 'Запрещено' });
    return;
  }
  fs.readFile(target, (err, data) => {
    if (err) {
      json(res, 404, { error: 'Не найдено' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
    });
    res.end(data);
  });
}

/**
 * Создаёт сервер. Вынесено из запуска, чтобы тесты поднимали сервер на
 * случайном порту без побочных эффектов.
 */
export function createServer(config) {
  const engines = createEngines(config);
  const storage = createStorage(config.dataDir);
  const apiKey = config.apiKey || '';

  const engineFor = (id) => {
    const engine = engines.get(id || 'mai');
    if (!engine) throw new Error(`Движок «${id}» не настроен`);
    return engine;
  };

  /** Движок MAI умеет и синтез, и распознавание — для дубляжа нужен он. */
  const sttEngine = {
    transcribe: async ({ audio, filename, model }) => {
      const { createMaiClient } = await import('./mai.js');
      const client = createMaiClient(config.mai);
      return client.transcribe({ audio, filename, model });
    },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const route = url.pathname;

    try {
      if (!route.startsWith('/api/')) {
        if (req.method !== 'GET') {
          json(res, 405, { error: 'Метод не поддерживается' });
          return;
        }
        serveStatic(req, res, route);
        return;
      }

      // Проверка ключа: если ключ задан, он обязателен для всех /api/*.
      // Исключение — выдача аудио: тег <audio> не умеет отправлять заголовок
      // Authorization, поэтому для GET /api/audio/:id ключ принимается ещё и
      // в query (?key=). Файлы content-addressed и только для чтения.
      const audioRoute = /^\/api\/audio\/([\w-]+)$/.exec(route);
      if (apiKey) {
        const header = req.headers.authorization || '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : '';
        const queryToken = req.method === 'GET' && audioRoute ? url.searchParams.get('key') || '' : '';
        if (token !== apiKey && queryToken !== apiKey) {
          json(res, 401, { error: 'Нужен ключ: Authorization: Bearer <MAV_API_KEY>' });
          return;
        }
      }

      if (route === '/api/health' && req.method === 'GET') {
        const availability = {};
        for (const [id, engine] of engines) {
          availability[id] = await engine.available().catch(() => false);
        }
        json(res, 200, {
          ok: true,
          version: config.version,
          engines: availability,
          voices: SILERO_VOICES,
          cloning: false,
          note: 'Клонирование голоса недоступно: шлюз MAI принимает только фиксированные голоса.',
        });
        return;
      }

      if (route === '/api/voices' && req.method === 'GET') {
        json(res, 200, {
          voices: SILERO_VOICES.map((id) => ({ id, ...VOICE_INFO[id] })),
          models: TTS_MODELS,
          sttModels: STT_MODELS,
        });
        return;
      }

      if (route === '/api/synthesize' && req.method === 'POST') {
        const body = await readJson(req);
        const engine = engineFor(body.engine);
        const result = await synthesize(engine, {
          text: body.text,
          voice: body.voice,
          speed: body.speed,
          format: body.format,
          strip: body.strip !== false,
        });
        const saved = storage.saveAudio(result.audio, {
          kind: 'speech',
          voice: result.voice,
          speed: result.speed,
          format: result.format,
          characters: result.characters,
          duration: result.duration,
          engine: engine.id,
          title: String(body.title || body.text || '').slice(0, 80),
        });
        json(res, 200, {
          id: saved.id,
          url: `/api/audio/${saved.id}`,
          duration: result.duration,
          chunks: result.chunks,
          characters: result.characters,
          format: result.format,
          voice: result.voice,
        });
        return;
      }

      if (route === '/api/narrate' && req.method === 'POST') {
        const body = await readJson(req);
        const engine = engineFor(body.engine);
        const result = await narrateBook(engine, {
          text: body.text,
          voice: body.voice,
          speed: body.speed,
        });
        const chapters = result.chapters.map((chapter) => {
          const saved = storage.saveAudio(chapter.audio, {
            kind: 'chapter',
            voice: chapter.voice,
            format: 'wav',
            duration: chapter.duration,
            engine: engine.id,
            title: chapter.title,
          });
          return { title: chapter.title, id: saved.id, url: `/api/audio/${saved.id}`, duration: chapter.duration };
        });
        json(res, 200, { chapters, totalDuration: result.totalDuration, voice: result.voice });
        return;
      }

      if (route === '/api/chapters' && req.method === 'POST') {
        const body = await readJson(req);
        json(res, 200, { chapters: splitChapters(body.text).map((c) => ({ title: c.title, characters: c.body.length })) });
        return;
      }

      if (route === '/api/voice-match' && req.method === 'POST') {
        const parts = parseMultipart(await readBody(req), req.headers['content-type']);
        const file = parts.find((part) => part.filename);
        if (!file) {
          json(res, 400, { error: 'Нужен файл референса в поле file' });
          return;
        }
        const genderPart = parts.find((part) => part.name === 'gender');
        const gender = genderPart ? genderPart.data.toString('utf8') : 'any';
        const match = pickVoice(file.data, { gender });
        const reference = storage.saveReference(file.data, { name: file.filename, gender });
        json(res, 200, { ...match, referenceId: reference.id });
        return;
      }

      if (route === '/api/analyze' && req.method === 'POST') {
        const parts = parseMultipart(await readBody(req), req.headers['content-type']);
        const file = parts.find((part) => part.filename);
        if (!file) {
          json(res, 400, { error: 'Нужен файл в поле file' });
          return;
        }
        json(res, 200, analyzeVoice(file.data));
        return;
      }

      if (route === '/api/dub' && req.method === 'POST') {
        const parts = parseMultipart(await readBody(req), req.headers['content-type']);
        const file = parts.find((part) => part.filename);
        if (!file) {
          json(res, 400, { error: 'Нужен аудиофайл в поле file' });
          return;
        }
        const field = (name, fallback = '') => {
          const part = parts.find((entry) => entry.name === name);
          return part ? part.data.toString('utf8') : fallback;
        };
        const engine = engineFor(field('engine', 'mai'));
        const result = await dub({ ...sttEngine, synthesize: engine.synthesize.bind(engine) }, {
          audio: file.data,
          filename: file.filename,
          sttModel: field('sttModel', 'whisper-large-v3'),
          voice: field('voice', 'baya'),
          speed: Number(field('speed', '1')) || 1,
        });
        const saved = storage.saveAudio(result.audio, {
          kind: 'dub',
          voice: result.voice,
          format: 'wav',
          duration: result.duration,
          engine: engine.id,
          title: `Дубляж ${file.filename}`,
        });
        json(res, 200, {
          id: saved.id,
          url: `/api/audio/${saved.id}`,
          sourceText: result.sourceText,
          translatedText: result.translatedText,
          segments: result.segments,
          duration: result.duration,
        });
        return;
      }

      if (route === '/api/history' && req.method === 'GET') {
        json(res, 200, { items: storage.list(Number(url.searchParams.get('limit')) || 50) });
        return;
      }

      const audioMatch = /^\/api\/audio\/([\w-]+)$/.exec(route);
      if (audioMatch && req.method === 'GET') {
        const item = storage.get(audioMatch[1]);
        if (!item) {
          json(res, 404, { error: 'Запись не найдена' });
          return;
        }
        const data = fs.readFileSync(item.file);
        res.writeHead(200, {
          'Content-Type': item.format === 'mp3' ? 'audio/mpeg' : 'audio/wav',
          'Content-Length': data.length,
          'Cache-Control': 'public, max-age=31536000, immutable',
        });
        res.end(data);
        return;
      }

      if (audioMatch && req.method === 'DELETE') {
        const removed = storage.remove(audioMatch[1]);
        json(res, removed ? 200 : 404, { ok: removed });
        return;
      }

      json(res, 404, { error: `Неизвестный маршрут: ${route}` });
    } catch (err) {
      const status = err?.status && err.status >= 400 && err.status < 600 ? 502 : 400;
      json(res, status, { error: err?.message || String(err), detail: err?.body || undefined });
    }
  });

  return { server, engines, storage };
}
