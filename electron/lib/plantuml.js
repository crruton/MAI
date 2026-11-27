/**
 * Рендер PlantUML (ADR 0127): вместо Mermaid в окне досок. Подход — как в arcspace:
 * локальная Java + plantuml.jar (`-pipe`: текст в stdin, SVG/PNG из stdout, без временных файлов),
 * кэш последних схем и слияние одинаковых запросов (каждый вызов — запуск JVM).
 * Нет Java или jar — сервер PlantUML команды (`plantuml.server`), если он задан. Публичный сервер
 * по умолчанию не используется: схема архитектуры уходила бы наружу.
 *
 * Безопасность: профиль PLANTUML_SECURITY_PROFILE=SANDBOX — `!include` файлов и адресов запрещён,
 * встроенная библиотека (`<C4/...>`) доступна. Модель схемы может прийти из чужого репозитория.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';

const FORMATS = new Set(['svg', 'png']);
const MAX_TEXT = 200_000;

/** Где искать Java: настройка, JAVA_HOME, PATH, типичные папки Windows (JRE из Archi, Adoptium). */
export function findJava({ settings = {}, env = process.env, exists = fs.existsSync, platform = process.platform } = {}) {
  const exe = platform === 'win32' ? 'java.exe' : 'java';
  const candidates = [];
  if (settings.java) candidates.push(settings.java);
  if (env.JAVA_HOME) candidates.push(path.join(env.JAVA_HOME, 'bin', exe));
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) candidates.push(path.join(dir, exe));
  if (platform === 'win32') {
    candidates.push('C:\\Program Files\\Archi\\jre\\bin\\java.exe');
    for (const base of ['C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Java', 'C:\\Program Files\\Microsoft', 'C:\\Program Files\\OpenJDK']) {
      try {
        for (const d of fs.readdirSync(base)) candidates.push(path.join(base, d, 'bin', exe));
      } catch {
        /* нет папки */
      }
    }
  }
  return candidates.find((c) => exists(c)) || '';
}

/** Где искать plantuml.jar: настройка, PLANTUML_JAR, `<данные MAI>/plantuml/*.jar`. */
export function findJar({ settings = {}, env = process.env, dataDir = '', exists = fs.existsSync } = {}) {
  const candidates = [settings.jar, env.PLANTUML_JAR].filter(Boolean);
  if (dataDir) {
    const dir = path.join(dataDir, 'plantuml');
    try {
      for (const f of fs.readdirSync(dir).filter((x) => /\.jar$/i.test(x)).sort().reverse()) candidates.push(path.join(dir, f));
    } catch {
      /* нет папки */
    }
  }
  return candidates.find((c) => exists(c)) || '';
}

/** Кодирование текста для адреса сервера PlantUML: deflate + своя base64-азбука. */
export function encodePlantuml(text) {
  const data = zlib.deflateRawSync(Buffer.from(String(text), 'utf8'), { level: 9 });
  const map = (b) => '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_'[b & 0x3f];
  let out = '';
  for (let i = 0; i < data.length; i += 3) {
    const b1 = data[i];
    const b2 = i + 1 < data.length ? data[i + 1] : 0;
    const b3 = i + 2 < data.length ? data[i + 2] : 0;
    out += map(b1 >> 2) + map(((b1 & 0x3) << 4) | (b2 >> 4)) + map(((b2 & 0xf) << 2) | (b3 >> 6)) + map(b3);
  }
  return out;
}

/** SVG из PlantUML — в DOM окна: без скриптов, обработчиков и внешних ссылок. */
export function sanitizeSvg(svg) {
  return String(svg || '')
    .replace(/<\?xml[^>]*\?>/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .replace(/(href\s*=\s*)("|')\s*javascript:[^"']*\2/gi, '$1$2#$2');
}

/** Ошибка PlantUML в SVG: PlantUML рисует её картинкой с кодом выхода 200 или 1. */
function errorFromSvg(svg) {
  const m = /Syntax Error\?|Cannot find|Error line (\d+)/i.exec(svg);
  return m ? `PlantUML: ошибка в схеме${m[1] ? ` (строка ${m[1]})` : ''}` : '';
}

/**
 * @param {{ getSettings?: () => object, dataDir?: string, env?: object, spawnImpl?: Function,
 *           fetchImpl?: Function, timeoutMs?: number, maxEntries?: number }} o
 */
export function createPlantuml({ getSettings = () => ({}), dataDir = '', env = process.env, spawnImpl = spawn, fetchImpl = globalThis.fetch, timeoutMs = 30_000, maxEntries = 128 } = {}) {
  const cache = new Map(); // ключ → { ok, svg | png, engine }
  const inFlight = new Map();

  function engines() {
    const s = getSettings()?.plantuml || {};
    const java = findJava({ settings: s, env });
    const jar = findJar({ settings: s, env, dataDir });
    const server = /^https?:\/\/[^\s]+$/.test(String(s.server || '')) ? String(s.server).replace(/\/+$/, '') : '';
    return { java, jar, server };
  }

  function runLocal({ java, jar }, text, format) {
    return new Promise((resolve) => {
      const args = ['-Djava.awt.headless=true', '-DPLANTUML_SECURITY_PROFILE=SANDBOX', '-Dfile.encoding=UTF-8', '-jar', jar, `-t${format}`, '-pipe', '-charset', 'UTF-8', '-nometadata'];
      let child;
      try {
        child = spawnImpl(java, args, { windowsHide: true, cwd: os.tmpdir() });
      } catch (err) {
        resolve({ ok: false, error: `PlantUML не запустился: ${err.message}` });
        return;
      }
      const out = [];
      const errOut = [];
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.stdout.on('data', (d) => out.push(d));
      child.stderr.on('data', (d) => errOut.push(d));
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, error: `PlantUML не запустился: ${err.message}` });
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        const buf = Buffer.concat(out);
        if (signal) return resolve({ ok: false, error: `PlantUML: прерван по таймауту ${Math.round(timeoutMs / 1000)} с` });
        if (!buf.length) return resolve({ ok: false, error: `PlantUML: пустой ответ (код ${code}) ${Buffer.concat(errOut).toString('utf8').slice(0, 300)}`.trim() });
        if (format === 'png') return resolve({ ok: code === 0, png: buf, error: code === 0 ? '' : 'PlantUML: ошибка в схеме', engine: 'local' });
        const svg = buf.toString('utf8');
        const error = code === 0 ? '' : errorFromSvg(svg) || `PlantUML: код ${code}`;
        resolve({ ok: !error, svg: sanitizeSvg(svg), error, engine: 'local' });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(text, 'utf8');
    });
  }

  async function runServer(server, text, format) {
    try {
      const res = await fetchImpl(`${server}/${format}/${encodePlantuml(text)}`, { signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined });
      if (format === 'png') {
        const png = Buffer.from(await res.arrayBuffer());
        return { ok: res.ok, png, error: res.ok ? '' : `сервер PlantUML: HTTP ${res.status}`, engine: 'server' };
      }
      const svg = await res.text();
      // Сервер отвечает 400 со схемой-ошибкой — показываем её и пишем причину.
      return { ok: res.ok, svg: sanitizeSvg(svg), error: res.ok ? '' : errorFromSvg(svg) || `сервер PlantUML: HTTP ${res.status}`, engine: 'server' };
    } catch (err) {
      return { ok: false, error: `сервер PlantUML недоступен: ${err.message}` };
    }
  }

  async function renderUncached(text, format) {
    const e = engines();
    if (e.java && e.jar) return runLocal(e, text, format);
    if (e.server) return runServer(e.server, text, format);
    return {
      ok: false,
      error: `PlantUML не настроен: ${!e.java ? 'нет Java (JAVA_HOME или PATH)' : 'нет plantuml.jar'}. Положите plantuml.jar в «${path.join(dataDir || '<данные MAI>', 'plantuml')}» или задайте plantuml.jar / plantuml.server в настройках.`,
      setup: true,
    };
  }

  return {
    status() {
      const e = engines();
      return { java: e.java, jar: e.jar, server: e.server, ready: Boolean((e.java && e.jar) || e.server), engine: e.java && e.jar ? 'local' : e.server ? 'server' : '' };
    },
    /** @returns {Promise<{ ok: boolean, svg?: string, png?: Buffer, error?: string, engine?: string, setup?: boolean }>} */
    async render(text, format = 'svg') {
      const fmt = FORMATS.has(format) ? format : 'svg';
      const src = String(text || '');
      if (!src.trim()) return { ok: false, error: 'пустая схема' };
      if (src.length > MAX_TEXT) return { ok: false, error: `схема больше ${MAX_TEXT} символов` };
      const key = crypto.createHash('sha256').update(`${fmt}\0${src}`).digest('hex');
      if (cache.has(key)) {
        const hit = cache.get(key);
        cache.delete(key);
        cache.set(key, hit);
        return hit;
      }
      if (inFlight.has(key)) return inFlight.get(key);
      const p = renderUncached(src, fmt).then((r) => {
        inFlight.delete(key);
        // Ошибки настройки не кэшируем: пользователь поставит Java — схема должна появиться.
        if (!r.setup && (r.ok || r.svg)) {
          cache.set(key, r);
          while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
        }
        return r;
      });
      inFlight.set(key, p);
      return p;
    },
  };
}
