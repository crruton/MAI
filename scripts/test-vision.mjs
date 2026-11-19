/**
 * Изображения во вложениях → части запроса (бэклог F1).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { supportsVision, imagePart, attachImages, isImageRejected, isImageFile } from '../electron/lib/vision.js';

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

const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-vision-'));
const uploads = path.join(project, '.mai-code', 'uploads', 's1');
fs.mkdirSync(uploads, { recursive: true });
// Настоящий PNG 1×1.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
fs.writeFileSync(path.join(uploads, 'a.png'), png);
fs.writeFileSync(path.join(uploads, 'b.svg'), '<svg/>');
fs.writeFileSync(path.join(uploads, 'big.jpg'), Buffer.alloc(64));

console.log('\n[1] Какие модели принимают изображения');
check('gpt-4o — да', supportsVision('gpt-4o'));
check('claude-opus-5-5 — да', supportsVision('claude-opus-5-5'));
check('qwen2.5-vl — да', supportsVision('qwen2.5-vl-72b'));
check('deepseek-v4.1-flash — нет', !supportsVision('deepseek-v4.1-flash'));
check('явный флаг сильнее имени (нет)', !supportsVision('gpt-4o', { models: [{ id: 'gpt-4o', vision: false }] }));
check('явный флаг сильнее имени (да)', supportsVision('deepseek-v4', { models: [{ id: 'deepseek-v4', vision: true }] }));

console.log('\n[2] Картинка → data URL');
const part = imagePart(project, '.mai-code/uploads/s1/a.png');
check('PNG читается', part?.part?.image_url?.url.startsWith('data:image/png;base64,'));
check('размер посчитан', part?.bytes === png.length);
check('SVG не отправляется', imagePart(project, '.mai-code/uploads/s1/b.svg') === null);
check('файл вне проекта не читается', imagePart(project, '../../etc/passwd.png') === null);
check('нет файла — null', imagePart(project, 'нет.png') === null);
check('слишком большой — null', imagePart(project, '.mai-code/uploads/s1/big.jpg', { maxBytes: 10 }) === null);
check('isImageFile видит png и не видит svg', isImageFile('x.PNG') && !isImageFile('x.svg'));

console.log('\n[3] Прикрепление к сообщениям');
const source = [
  { role: 'user', content: 'старое', images: ['.mai-code/uploads/s1/a.png'] },
  { role: 'assistant', content: 'ок' },
  { role: 'user', content: 'смотри', images: ['.mai-code/uploads/s1/a.png', '.mai-code/uploads/s1/b.svg'] },
];
const api = source.map(({ role, content }) => ({ role, content }));
const result = attachImages(api, source, project);
check('последнее сообщение стало мультимодальным', Array.isArray(result.messages[2].content) && result.messages[2].content[1].type === 'image_url');
check('текст сохранён первой частью', result.messages[2].content[0].text === 'смотри');
check('SVG пропущен и посчитан', result.skipped === 1, String(result.skipped));
check('ответ ассистента не тронут', result.messages[1].content === 'ок');
check('исходный массив не изменён', typeof api[2].content === 'string');
const limited = attachImages(api, source, project, { perImageBytes: 1e6, totalBytes: 1e6, maxImages: 1 });
check('лимит количества: картинка только у последнего', limited.count === 1 && typeof limited.messages[0].content === 'string');

console.log('\n[4] Отказ шлюза');
check('400 про image_url — отказ изображения', isImageRejected({ status: 400, message: 'image_url is not supported for this model' }));
check('400 про другое — нет', !isImageRejected({ status: 400, message: 'max_tokens too large' }));
check('500 — нет', !isImageRejected({ status: 500, message: 'image' }));

fs.rmSync(project, { recursive: true, force: true });
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
