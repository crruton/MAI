import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Распознавание текста на изображениях (OCR).
 *
 * Четыре движка за одним интерфейсом. Выбор по платформе и доступности:
 *
 * | Движок      | Платформа      | Сеть | Зависимость                  |
 * |-------------|----------------|------|------------------------------|
 * | `winrt`     | Windows        | нет  | языковой пакет ОС            |
 * | `vision`    | macOS          | нет  | Xcode Command Line Tools     |
 * | `tesseract` | любая          | нет  | бинарник `tesseract`         |
 * | `mai`       | любая          | да   | ключ шлюза MAI, `hunyuan-ocr`|
 *
 * Правила:
 * - движок не найден — понятная ошибка, вложение остаётся доступным;
 * - таймаут у каждого движка, чтобы прикрепление файла не «висело»;
 * - сетевой движок отправляет изображение на сервер, поэтому он последний
 *   в порядке приоритета и включается только явно или как запасной путь.
 *
 * Проверено: `winrt` на Windows 11 26200 (языки en-US, ru). `vision`,
 * `tesseract` и `mai` в этой среде не проверялись — см. docs/OCR.md.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  enabled: true,
  // auto | winrt | vision | tesseract | mai | off
  engine: 'auto',
  language: 'ru',
  provider: 'mai',
  model: 'hunyuan-ocr',
  maxDimension: 4000,
  scale: 1,
  timeoutMs: 60000,
};

// Windows.Media.Ocr не читает webp, avif, ico и svg.
const WINRT_EXT = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.tif', '.tiff']);

const MAX_TEXT_CHARS = 200000;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const STATUS_TTL = 5 * 60 * 1000;

const MAI_PROMPT =
  'Распознай весь текст на изображении. Сохрани порядок строк и переносы. ' +
  'Верни только распознанный текст, без пояснений и без markdown.';

let statusCache = null;

/* ---------- настройки ---------- */

export function ocrConfig(settings) {
  const raw = settings?.ocr || {};
  const merged = { ...DEFAULTS, ...raw };
  merged.enabled = merged.enabled !== false;
  merged.language = String(merged.language || DEFAULTS.language).trim() || DEFAULTS.language;
  merged.engine = String(merged.engine || DEFAULTS.engine).trim() || DEFAULTS.engine;
  merged.timeoutMs = Number(merged.timeoutMs) > 0 ? Number(merged.timeoutMs) : DEFAULTS.timeoutMs;
  return merged;
}

/**
 * Настройки читаются лениво: `config.js` импортирует electron, а тесты
 * запускаются обычным Node. Если electron нет — работают значения по умолчанию.
 */
async function loadOcrConfig(settings) {
  if (settings) return ocrConfig(settings);
  try {
    const { loadSettings } = await import('./config.js');
    return ocrConfig(loadSettings());
  } catch {
    return ocrConfig(null);
  }
}

/* ---------- вспомогательное ---------- */

function mimeFor(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.tif' || ext === '.tiff') return 'image/tiff';
  return 'image/png';
}

function clip(text) {
  const value = String(text || '');
  return value.length > MAX_TEXT_CHARS ? value.slice(0, MAX_TEXT_CHARS) : value;
}

/** Скрипты копируются во временную папку: из asar их нельзя запустить. */
function materialize(name, content) {
  const dir = path.join(os.tmpdir(), 'mai-code-ocr');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, name);
  const bytes = Buffer.byteLength(content, 'utf8');
  try {
    if (fs.statSync(target).size === bytes) return target;
  } catch {
    // Файла ещё нет — запишем ниже.
  }
  fs.writeFileSync(target, content, 'utf8');
  return target;
}

function winrtScript() {
  const source = path.join(HERE, 'ocr-winrt.ps1');
  return materialize('ocr-winrt.ps1', fs.readFileSync(source, 'utf8'));
}

function runPowerShell(args, timeout) {
  const command = process.platform === 'win32' ? 'powershell' : 'pwsh';
  return spawnSync(
    command,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args],
    { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
  );
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/* ---------- движок winrt ---------- */

function detectWinrt() {
  if (process.platform !== 'win32') {
    return { available: false, error: 'движок Windows доступен только на Windows' };
  }
  let script;
  try {
    script = winrtScript();
  } catch (err) {
    return { available: false, error: `нет скрипта ocr-winrt.ps1: ${err?.message || err}` };
  }
  const out = path.join(os.tmpdir(), 'mai-code-ocr', 'languages.json');
  fs.rmSync(out, { force: true });
  const res = runPowerShell(['-File', script, '-ListLanguages', '-OutFile', out], 20000);
  const body = readJson(out);
  if (!body?.ok) {
    const detail = body?.error || (res.error?.message || res.stderr || '').trim().slice(0, 200);
    return { available: false, error: detail || 'PowerShell не ответил' };
  }
  return {
    available: true,
    languages: Array.isArray(body.languages) ? body.languages : [],
    maxDimension: body.maxDimension || null,
  };
}

function recognizeWinrt({ filePath, config }) {
  const ext = path.extname(filePath).toLowerCase();
  if (!WINRT_EXT.has(ext)) {
    throw new Error(`движок Windows не читает ${ext || 'этот формат'}: нужен png, jpg, bmp, gif или tiff`);
  }
  const script = winrtScript();
  const out = path.join(os.tmpdir(), 'mai-code-ocr', `result-${process.pid}-${Date.now()}.json`);
  const res = runPowerShell(
    [
      '-File', script,
      '-Path', filePath,
      '-OutFile', out,
      '-Language', config.language,
      '-MaxDimension', String(config.maxDimension),
      '-Scale', String(config.scale),
    ],
    config.timeoutMs,
  );
  const body = readJson(out);
  fs.rmSync(out, { force: true });
  if (!body) {
    const detail = (res.error?.message || res.stderr || '').trim().slice(0, 300);
    throw new Error(`движок Windows не вернул результат${detail ? `: ${detail}` : ''}`);
  }
  if (!body.ok) {
    if (body.code === 'no-engine') {
      const list = (body.languages || []).join(', ') || 'нет';
      throw new Error(
        `нет OCR-движка для языка «${config.language}». Доступные языки: ${list}. ` +
          'Установите языковой пакет: Параметры → Время и язык → Язык и регион → Добавить язык ' +
          '(компонент «Оптическое распознавание символов»).',
      );
    }
    throw new Error(body.error || 'движок Windows вернул ошибку');
  }
  const note =
    body.language && !String(body.language).toLowerCase().startsWith(config.language.toLowerCase())
      ? `язык «${config.language}» не установлен, распознано как «${body.language}»`
      : '';
  return {
    engine: 'winrt',
    language: body.language || '',
    text: clip(body.text),
    lines: Array.isArray(body.lines) ? body.lines : [],
    width: body.width || null,
    height: body.height || null,
    note,
  };
}

/* ---------- движок vision (macOS) ---------- */

const VISION_SWIFT = [
  'import Foundation',
  'import Vision',
  'import AppKit',
  '',
  'let args = CommandLine.arguments',
  'guard args.count > 1 else { FileHandle.standardError.write("no path".data(using: .utf8)!); exit(2) }',
  'let url = URL(fileURLWithPath: args[1])',
  'let lang = args.count > 2 ? args[2] : "ru-RU"',
  'guard let image = NSImage(contentsOf: url),',
  '      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {',
  '  FileHandle.standardError.write("cannot read image".data(using: .utf8)!)',
  '  exit(3)',
  '}',
  'let request = VNRecognizeTextRequest()',
  'request.recognitionLevel = .accurate',
  'request.usesLanguageCorrection = true',
  'request.recognitionLanguages = [lang]',
  'let handler = VNImageRequestHandler(cgImage: cg, options: [:])',
  'do { try handler.perform([request]) } catch {',
  '  FileHandle.standardError.write("\\(error)".data(using: .utf8)!)',
  '  exit(4)',
  '}',
  'var lines: [[String: Any]] = []',
  'for case let obs as VNRecognizedTextObservation in request.results ?? [] {',
  '  guard let top = obs.topCandidates(1).first else { continue }',
  '  let bb = obs.boundingBox',
  '  lines.append([',
  '    "text": top.string,',
  '    "x": Double(bb.origin.x),',
  '    "y": Double(1.0 - bb.origin.y - bb.size.height),',
  '    "width": Double(bb.size.width),',
  '    "height": Double(bb.size.height),',
  '  ])',
  '}',
  'let text = lines.compactMap { $0["text"] as? String }.joined(separator: "\\n")',
  'let out: [String: Any] = ["ok": true, "engine": "vision", "language": lang, "lines": lines, "text": text]',
  'let data = try JSONSerialization.data(withJSONObject: out, options: [])',
  'FileHandle.standardOutput.write(data)',
].join('\n');

function detectVision() {
  if (process.platform !== 'darwin') {
    return { available: false, error: 'движок Vision доступен только на macOS' };
  }
  const res = spawnSync('swift', ['--version'], { encoding: 'utf8', timeout: 20000 });
  if (res.status !== 0) {
    return {
      available: false,
      error: 'нет интерпретатора swift. Установите Xcode Command Line Tools: xcode-select --install',
    };
  }
  return { available: true, languages: ['ru-RU', 'en-US'] };
}

function recognizeVision({ filePath, config }) {
  const script = materialize('ocr-vision.swift', VISION_SWIFT);
  const tag = config.language.includes('-') ? config.language : `${config.language}-RU`;
  const res = spawnSync('swift', [script, filePath, tag], {
    encoding: 'utf8',
    timeout: config.timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (res.status !== 0) {
    const detail = (res.stderr || res.error?.message || '').trim().slice(0, 300);
    throw new Error(`Vision не распознал изображение${detail ? `: ${detail}` : ''}`);
  }
  const body = readJsonFromString(res.stdout);
  if (!body?.ok) throw new Error('Vision вернул пустой ответ');
  return {
    engine: 'vision',
    language: body.language || tag,
    text: clip(body.text),
    lines: Array.isArray(body.lines) ? body.lines : [],
    width: null,
    height: null,
    note: '',
  };
}

function readJsonFromString(text) {
  try {
    return JSON.parse(String(text || ''));
  } catch {
    return null;
  }
}

/* ---------- движок tesseract ---------- */

function detectTesseract() {
  const res = spawnSync('tesseract', ['--version'], { encoding: 'utf8', timeout: 15000 });
  if (res.status !== 0) {
    return { available: false, error: 'бинарник tesseract не найден в PATH' };
  }
  const version = String(res.stdout || res.stderr || '').split('\n')[0].trim();
  const langs = spawnSync('tesseract', ['--list-langs'], { encoding: 'utf8', timeout: 15000 });
  const languages = String(langs.stdout || langs.stderr || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^List of available/i.test(line));
  return { available: true, version, languages };
}

function recognizeTesseract({ filePath, config }) {
  const res = spawnSync(
    'tesseract',
    [filePath, 'stdout', '-l', config.language, '--psm', '3'],
    { encoding: 'utf8', timeout: config.timeoutMs, maxBuffer: 16 * 1024 * 1024 },
  );
  if (res.status !== 0) {
    const detail = (res.stderr || res.error?.message || '').trim().slice(0, 300);
    throw new Error(`tesseract не распознал изображение${detail ? `: ${detail}` : ''}`);
  }
  return {
    engine: 'tesseract',
    language: config.language,
    text: clip(res.stdout),
    lines: [],
    width: null,
    height: null,
    note: '',
  };
}

/* ---------- движок mai (сеть) ---------- */

function detectMai(config, settings) {
  const provider = settings?.providers?.[config.provider];
  if (!provider?.baseURL) {
    return { available: false, error: `провайдер «${config.provider}» не настроен` };
  }
  if (!provider?.apiKey) {
    return { available: false, error: `у провайдера «${config.provider}» нет API-ключа` };
  }
  return { available: true, model: config.model, network: true };
}

async function recognizeMai({ filePath, config, settings }) {
  const provider = settings?.providers?.[config.provider];
  if (!provider?.baseURL || !provider?.apiKey) {
    throw new Error(`провайдер «${config.provider}» не настроен: нужен Base URL и ключ`);
  }
  const buffer = fs.readFileSync(filePath);
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new Error(
      `изображение больше ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} МБ: сетевой OCR его не отправит`,
    );
  }
  const dataUrl = `data:${mimeFor(filePath)};base64,${buffer.toString('base64')}`;

  let response;
  try {
    response = await fetch(`${provider.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: MAI_PROMPT },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (err) {
    const message = String(err?.message || err);
    if (/abort|timeout/i.test(message)) {
      throw new Error(`шлюз MAI не ответил за ${Math.round(config.timeoutMs / 1000)} с`);
    }
    throw new Error(`шлюз MAI недоступен: ${message}`);
  }

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      detail = body?.error?.message || body?.detail || detail;
    } catch {
      // Тело не JSON: оставляем код.
    }
    throw new Error(`шлюз MAI отклонил запрос: ${detail}`);
  }

  const body = await response.json();
  const content = body?.choices?.[0]?.message?.content;
  const text = Array.isArray(content)
    ? content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('')
    : String(content || '');
  if (!text.trim()) throw new Error('модель вернула пустой текст');

  return {
    engine: 'mai',
    language: config.language,
    text: clip(text),
    lines: [],
    width: null,
    height: null,
    note: 'изображение отправлено на сервер шлюза',
  };
}

/* ---------- публичный интерфейс ---------- */

/** Порядок движков для режима auto: сначала локальные, сеть последней. */
function autoOrder() {
  if (process.platform === 'win32') return ['winrt', 'tesseract', 'mai'];
  if (process.platform === 'darwin') return ['vision', 'tesseract', 'mai'];
  return ['tesseract', 'mai'];
}

function detect(engine, config, settings) {
  if (engine === 'winrt') return detectWinrt();
  if (engine === 'vision') return detectVision();
  if (engine === 'tesseract') return detectTesseract();
  if (engine === 'mai') return detectMai(config, settings);
  return { available: false, error: `неизвестный движок «${engine}»` };
}

/**
 * Состояние OCR: какие движки доступны, какие языки, что выбрано.
 * Результат кешируется на 5 минут: проверка winrt запускает PowerShell.
 */
export async function ocrStatus(settings, { force = false } = {}) {
  const config = await loadOcrConfig(settings);
  if (!force && statusCache && Date.now() - statusCache.at < STATUS_TTL) {
    return { ...statusCache.data, config };
  }

  const engines = {};
  for (const id of ['winrt', 'vision', 'tesseract', 'mai']) {
    engines[id] = detect(id, config, settings);
  }

  const order = config.engine === 'auto' ? autoOrder() : [config.engine];
  const preferred = order.find((id) => engines[id]?.available) || '';
  const data = {
    enabled: config.enabled,
    platform: process.platform,
    engine: config.engine,
    language: config.language,
    preferred,
    engines,
    available: config.enabled && Boolean(preferred),
  };
  statusCache = { at: Date.now(), data };
  return { ...data, config };
}

/**
 * Распознаёт текст на изображении. Бросает Error с понятным текстом,
 * если движок недоступен или не смог прочитать файл.
 */
export async function ocrImage({ filePath, language, engine, settings } = {}) {
  const config = await loadOcrConfig(settings);
  if (!config.enabled) throw new Error('OCR выключен в настройках');
  if (!filePath) throw new Error('не указан путь к изображению');
  if (!fs.existsSync(filePath)) throw new Error(`файл не найден: ${path.basename(filePath)}`);

  const effective = { ...config, language: String(language || config.language) };
  const order = engine && engine !== 'auto' ? [engine] : config.engine === 'auto' ? autoOrder() : [config.engine];

  const errors = [];
  for (const id of order) {
    const state = detect(id, effective, settings);
    if (!state.available) {
      errors.push(`${id}: ${state.error}`);
      continue;
    }
    try {
      const result =
        id === 'winrt' ? recognizeWinrt({ filePath, config: effective })
          : id === 'vision' ? recognizeVision({ filePath, config: effective })
            : id === 'tesseract' ? recognizeTesseract({ filePath, config: effective })
              : await recognizeMai({ filePath, config: effective, settings });
      return { ok: true, ...result };
    } catch (err) {
      errors.push(`${id}: ${err?.message || err}`);
    }
  }

  throw new Error(`OCR недоступен. ${errors.join('; ')}`);
}

/** Быстрая проверка без запуска движка: есть ли вообще шанс распознать. */
export function ocrPlatformSupported() {
  return ['win32', 'darwin', 'linux'].includes(process.platform);
}

export { DEFAULTS as OCR_DEFAULTS };
