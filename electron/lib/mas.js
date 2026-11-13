import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { loadSettings } from './config.js';

/**
 * Клиент MAS: локальный сервер распознавания речи.
 *
 * Правила:
 * - токен не показываем в интерфейсе и не пишем в логи;
 * - если MAS не запущен, возвращаем понятную ошибку, а не падаем;
 * - таймаут ограничен, чтобы кнопка микрофона не «висела» вечно.
 *
 * Проверено: MAS 0.2.0, эндпоинты /api/v1/health и /v1/audio/transcriptions.
 */

const DEFAULT_URL = 'http://127.0.0.1:8765';
const DEFAULT_MODEL = 'gigaam-v3-e2e-ctc';
const STATUS_TIMEOUT_MS = 4000;
const TRANSCRIBE_TIMEOUT_MS = 180000;

/** Токен MAS лежит в каталоге данных приложения MAS. */
function readSharedToken() {
  const appData = app.getPath('appData');
  const candidates = [
    // Установленное приложение: DATA_DIR = %APPDATA%\MAS\data.
    path.join(appData, 'MAS', 'data', 'api-token'),
    // Старое расположение из документации.
    path.join(appData, 'MAS', 'api-token'),
    // Sidecar, запущенный из репозитория: ~/.mas/api-token.
    path.join(app.getPath('home'), '.mas', 'api-token'),
  ];
  for (const file of candidates) {
    try {
      const value = fs.readFileSync(file, 'utf8').trim();
      if (value) return value;
    } catch {
      // Файла нет: MAS ещё не запускали.
    }
  }
  return '';
}

export function masConfig() {
  const settings = loadSettings();
  const mas = settings.mas || {};
  return {
    enabled: mas.enabled !== false,
    // Переменные окружения нужны для тестов и CI: они важнее настроек.
    url: String(process.env.MAS_API_URL || mas.url || DEFAULT_URL).replace(/\/+$/, ''),
    token:
      String(process.env.MAS_API_TOKEN || '').trim() ||
      String(mas.token || '').trim() ||
      readSharedToken(),
    model: String(process.env.MAS_API_MODEL || mas.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
  };
}

function friendlyError(error) {
  const message = String(error?.message || error);
  if (/ECONNREFUSED|fetch failed|Failed to fetch/i.test(message)) {
    return 'MAS не запущен. Откройте приложение MAS или проверьте адрес в настройках.';
  }
  if (/401/.test(message)) {
    return 'MAS отклонил токен. Скопируйте api-token из %APPDATA%\\MAS\\data в настройки.';
  }
  return message;
}

export async function masStatus() {
  const config = masConfig();
  if (!config.enabled) {
    return { ok: false, configured: false, url: config.url, error: 'Интеграция с MAS выключена в настройках.' };
  }
  if (!config.token) {
    return {
      ok: false,
      configured: false,
      url: config.url,
      error: 'Нет токена MAS. Запустите MAS один раз или укажите токен в настройках.',
    };
  }
  try {
    const response = await fetch(`${config.url}/api/v1/health`, {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { ok: false, configured: true, url: config.url, error: friendlyError(`HTTP ${response.status}`) };
    }
    const body = await response.json();
    return {
      ok: true,
      configured: true,
      url: config.url,
      version: body.version,
      modelLoaded: body.model_loaded,
      audiosocket: Boolean(body.capabilities?.audiosocket),
      model: config.model,
    };
  } catch (error) {
    return { ok: false, configured: true, url: config.url, error: friendlyError(error) };
  }
}

export async function masTranscribe(payload = {}) {
  const config = masConfig();
  if (!config.enabled) throw new Error('Интеграция с MAS выключена в настройках.');
  if (!config.token) throw new Error('Нет токена MAS. Запустите MAS один раз.');

  const bytes = payload.wav;
  if (!bytes || !bytes.byteLength) throw new Error('Пустая запись: нечего распознавать.');
  const model = String(payload.model || config.model);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'voice.wav');
  form.append('model', model);
  form.append('response_format', 'json');
  form.append('channel', 'mic');

  const started = Date.now();
  let response;
  try {
    response = await fetch(`${config.url}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}` },
      body: form,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(friendlyError(error));
  }
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body.detail) detail = body.detail;
    } catch {
      // Тело не JSON: оставляем код.
    }
    throw new Error(`MAS: ${detail}`);
  }
  const body = await response.json();
  return {
    text: String(body.text || '').trim(),
    model,
    elapsedMs: Date.now() - started,
  };
}
