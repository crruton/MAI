import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { ocrStatus, ocrImage, ocrConfig, ocrPlatformSupported } from '../electron/lib/ocr.js';
import { recognizeAttachment } from '../electron/lib/attachments.js';

/**
 * Тесты OCR без сети и без внешних сервисов.
 *
 * Проверяется то, что можно проверить в любой среде: разбор настроек, порядок
 * движков, понятные ошибки, запись `.txt` рядом с вложением. Реальное
 * распознавание проверяется отдельно и только если движок есть в системе.
 */

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  OK   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-ocr-'));
const project = path.join(tmp, 'project');
fs.mkdirSync(project, { recursive: true });

/* --- минимальный PNG 1x1 без внешних библиотек --- */
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function makePng(width = 1, height = 1) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const raw = Buffer.alloc((width * 3 + 1) * height, 0xff);
  for (let y = 0; y < height; y += 1) raw[y * (width * 3 + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

console.log('\n[1] Настройки OCR');
const defaults = ocrConfig(null);
check('движок по умолчанию auto', defaults.engine === 'auto', defaults.engine);
check('язык по умолчанию ru', defaults.language === 'ru', defaults.language);
check('модель по умолчанию hunyuan-ocr', defaults.model === 'hunyuan-ocr', defaults.model);
check('OCR включён по умолчанию', defaults.enabled === true);
const custom = ocrConfig({ ocr: { engine: 'tesseract', language: 'en', timeoutMs: 5000 } });
check('настройки перекрывают умолчания', custom.engine === 'tesseract' && custom.language === 'en');
check('таймаут из настроек', custom.timeoutMs === 5000, String(custom.timeoutMs));
const broken = ocrConfig({ ocr: { timeoutMs: -1, language: '' } });
check('отрицательный таймаут → умолчание', broken.timeoutMs === 60000, String(broken.timeoutMs));
check('пустой язык → умолчание', broken.language === 'ru', broken.language);
check('платформа поддерживается', ocrPlatformSupported() === true);

console.log('\n[2] Состояние движков');
const status = await ocrStatus(null, { force: true });
check('статус вернул платформу', status.platform === process.platform, status.platform);
check('статус перечисляет 4 движка', Object.keys(status.engines).length === 4, JSON.stringify(Object.keys(status.engines)));
check('у каждого движка есть флаг available', Object.values(status.engines).every((e) => 'available' in e));
check('недоступный движок объясняет причину', Object.values(status.engines).every((e) => e.available || e.error));
if (process.platform === 'win32') {
  check('winrt доступен на Windows', status.engines.winrt.available === true, JSON.stringify(status.engines.winrt));
  check('winrt перечислил языки', Array.isArray(status.engines.winrt.languages), JSON.stringify(status.engines.winrt));
} else {
  check('winrt недоступен вне Windows', status.engines.winrt.available === false);
}
if (process.platform !== 'darwin') {
  check('vision недоступен вне macOS', status.engines.vision.available === false);
}

console.log('\n[3] Понятные ошибки');
let error = '';
try {
  await ocrImage({ filePath: path.join(tmp, 'нет-такого.png') });
} catch (err) {
  error = err.message;
}
check('нет файла → ошибка про файл', /не найден/.test(error), error);

const pngPath = path.join(tmp, 'shot.png');
fs.writeFileSync(pngPath, makePng(8, 8));
error = '';
try {
  await ocrImage({ filePath: pngPath, engine: 'tesseract', settings: { ocr: { engine: 'tesseract' } } });
} catch (err) {
  error = err.message;
}
check('недоступный движок → ошибка с причиной', /OCR недоступен/.test(error), error);

error = '';
try {
  await ocrImage({ filePath: pngPath, settings: { ocr: { enabled: false } } });
} catch (err) {
  error = err.message;
}
check('выключенный OCR → ошибка', /выключен/.test(error), error);

console.log('\n[4] Вложение: путь и защита');
error = '';
try {
  await recognizeAttachment({ projectDir: project, path: '../../etc/passwd' });
} catch (err) {
  error = err.message;
}
check('путь вне проекта отклонён', /вне проекта/.test(error), error);

error = '';
try {
  await recognizeAttachment({ projectDir: '', path: 'a.png' });
} catch (err) {
  error = err.message;
}
check('без папки проекта → ошибка', /папку проекта/.test(error), error);

console.log('\n[5] Реальное распознавание (если движок есть)');
const live = await ocrStatus(null, { force: true });
if (live.preferred && live.preferred !== 'mai') {
  const uploads = path.join(project, '.mai-code', 'uploads', 'ocr-test');
  fs.mkdirSync(uploads, { recursive: true });
  const target = path.join(uploads, 'blank.png');
  fs.writeFileSync(target, makePng(64, 64));
  const result = await recognizeAttachment({
    projectDir: project,
    path: '.mai-code/uploads/ocr-test/blank.png',
  });
  check('движок ответил без исключения', typeof result.ok === 'boolean', JSON.stringify(result));
  check('движок назван', Boolean(result.engine), JSON.stringify(result));
  if (result.ok) {
    check('textPath задан', Boolean(result.textPath), JSON.stringify(result));
    check('файл текста существует', fs.existsSync(path.join(project, result.textPath)));
  } else {
    check('пустое изображение → понятная причина', /не найден/.test(result.error || ''), result.error);
  }
} else {
  console.log('  SKIP локального движка нет: проверено только на уровне ошибок');
}

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
