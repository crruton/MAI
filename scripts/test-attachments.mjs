import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import os from 'node:os';
import {
  readZipIndex,
  readZipEntry,
  extractPdf,
  detectKind,
  saveFromPaths,
  saveImage,
  imageDataUrl,
  removeSessionUploads,
  adoptDraftUploads,
} from '../electron/lib/attachments.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-att-'));
const project = path.join(tmp, 'project');
fs.mkdirSync(project, { recursive: true });

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

/* --- сборка ZIP вручную (store + deflate) --- */
function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const deflated = zlib.deflateRawSync(data);
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const nameBuf = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(zlib.crc32 ? zlib.crc32(data) : 0, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

console.log('\n[1] ZIP: оглавление и распаковка');
const zipBuf = buildZip({
  'readme.txt': 'привет мир',
  'src/main.js': 'console.log("hello");'.repeat(50),
});
const index = readZipIndex(zipBuf);
check('найдено 2 записи', index.length === 2, `got ${index.length}`);
const readme = index.find((e) => e.name === 'readme.txt');
check('текст из store-записи', readZipEntry(zipBuf, readme).toString('utf8') === 'привет мир');
const mainJs = index.find((e) => e.name === 'src/main.js');
check('текст из deflate-записи', readZipEntry(zipBuf, mainJs).toString('utf8').startsWith('console.log'));

console.log('\n[2] DOCX: извлечение текста');
const docxBuf = buildZip({
  'word/document.xml':
    '<w:document><w:body>' +
    '<w:p><w:r><w:t>Раздел 1. Архитектура</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Требования &amp; ограничения</w:t></w:r></w:p>' +
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Ячейка A</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
    '</w:body></w:document>',
});
const docxPath = path.join(tmp, 'plan.docx');
fs.writeFileSync(docxPath, docxBuf);

console.log('\n[3] PDF: извлечение текста');
const pdfContent = 'BT /F1 12 Tf 72 720 Td (Hello PDF world) Tj ET';
const pdfStream = zlib.deflateSync(Buffer.from(pdfContent, 'latin1'));
const pdfBuf = Buffer.concat([
  Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length ' + pdfStream.length + ' >>\nstream\n', 'latin1'),
  pdfStream,
  Buffer.from('\nendstream\nendobj\ntrailer\n%%EOF', 'latin1'),
]);
const pdfPath = path.join(tmp, 'doc.pdf');
fs.writeFileSync(pdfPath, pdfBuf);
const pdfText = extractPdf(pdfBuf);
check('PDF текст найден', pdfText.includes('Hello PDF world'), JSON.stringify(pdfText));

console.log('\n[4] Определение типа');
check('docx → docx', detectKind('a.docx', docxBuf) === 'docx');
check('svg → text', detectKind('schema.svg', Buffer.from('<svg/>')) === 'text');
check('png → image', detectKind('a.png', Buffer.from([0x89, 0x50, 0x4e, 0x47])) === 'image');
check('zip → archive', detectKind('a.zip', zipBuf) === 'archive');
check('bin без расширения → binary', detectKind('blob', Buffer.from([0, 1, 2, 3])) === 'binary');

console.log('\n[5] saveFromPaths: копирование и извлечение');
const txtPath = path.join(tmp, 'notes.md');
fs.writeFileSync(txtPath, '# Заголовок\nстрока два\n');
const zipPath = path.join(tmp, 'bundle.zip');
fs.writeFileSync(zipPath, zipBuf);

const saved = saveFromPaths({
  projectDir: project,
  sessionId: 'test-session',
  paths: [docxPath, pdfPath, txtPath, zipPath],
});
check('ошибок нет', saved.errors.length === 0, JSON.stringify(saved.errors));
check('4 вложения', saved.entries.length === 4, `got ${saved.entries.length}`);

const docxEntry = saved.entries.find((e) => e.kind === 'docx');
check('docx: textPath задан', Boolean(docxEntry?.textPath), JSON.stringify(docxEntry));
check('docx: файл текста существует', fs.existsSync(path.join(project, docxEntry.textPath)));
const docxText = fs.readFileSync(path.join(project, docxEntry.textPath), 'utf8');
check('docx: текст содержит «Архитектура»', docxText.includes('Архитектура'), JSON.stringify(docxText));
check('docx: сущность &amp; раскодирована', docxText.includes('Требования & ограничения'), JSON.stringify(docxText));
check('docx: таблица извлечена', docxText.includes('Ячейка A'), JSON.stringify(docxText));

const pdfEntry = saved.entries.find((e) => e.kind === 'pdf');
check('pdf: textPath задан', Boolean(pdfEntry?.textPath), JSON.stringify(pdfEntry));

const txtEntry = saved.entries.find((e) => e.name === 'notes.md');
check('text: строки посчитаны', txtEntry?.meta?.lines === 3, JSON.stringify(txtEntry?.meta));

const zipEntry = saved.entries.find((e) => e.kind === 'archive');
check('archive: распакован', Boolean(zipEntry?.meta?.extracted), JSON.stringify(zipEntry));
check('archive: 3 записи в списке (папка + 2 файла)', zipEntry?.meta?.entries === 3, JSON.stringify(zipEntry?.meta));
const extractedMain = path.join(project, zipEntry.meta.extracted, 'src', 'main.js');
check('archive: файл на диске', fs.existsSync(extractedMain));

console.log('\n[6] Защита: секреты и размер');
const envPath = path.join(tmp, '.env');
fs.writeFileSync(envPath, 'SECRET=1');
const secret = saveFromPaths({ projectDir: project, sessionId: 'test-session', paths: [envPath] });
check('секрет отклонён', secret.entries.length === 0 && secret.errors.length === 1, JSON.stringify(secret.errors));

console.log('\n[7] Изображение из буфера');
const png1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const img = saveImage({
  projectDir: project,
  sessionId: 'test-session',
  name: 'clipboard.png',
  dataUrl: `data:image/png;base64,${png1x1}`,
});
check('image: kind=image', img.kind === 'image', JSON.stringify(img));
const dataUrl = imageDataUrl(project, img.path);
check('image: data URL собран', dataUrl.startsWith('data:image/png;base64,'));

console.log('\n[8] Уникальные имена');
const again = saveFromPaths({ projectDir: project, sessionId: 'test-session', paths: [txtPath] });
check('второй файл не перезаписал первый', again.entries[0].name === 'notes-1.md', again.entries[0].name);

console.log('\n[9] Перенос черновика в сессию');
const draftSaved = saveFromPaths({ projectDir: project, sessionId: null, paths: [txtPath] });
check('черновик сохранён в draft', draftSaved.entries[0].path.includes('/draft/'), draftSaved.entries[0].path);
const adopted = adoptDraftUploads(project, 'real-session');
check('перенос вернул пути', Boolean(adopted?.from && adopted?.to), JSON.stringify(adopted));
check('from указывает на draft', adopted.from.endsWith('/draft'), adopted.from);
check('to указывает на сессию', adopted.to.endsWith('/real-session'), adopted.to);
const movedPath = path.join(project, adopted.to, 'notes.md');
check('файл переехал', fs.existsSync(movedPath));
check('папка draft удалена', !fs.existsSync(path.join(project, adopted.from)));
const rewritten = draftSaved.entries[0].path.split(adopted.from).join(adopted.to);
check('путь в тексте исправлен', rewritten.includes('/real-session/'), rewritten);

console.log('\n[10] Удаление вложений сессии');
const beforeRemove = fs.existsSync(path.join(project, '.mai-code', 'uploads', 'test-session'));
check('папка сессии существует', beforeRemove);
const removed = removeSessionUploads(project, 'test-session');
check('removeSessionUploads вернул true', removed === true);
check('папка сессии удалена', !fs.existsSync(path.join(project, '.mai-code', 'uploads', 'test-session')));

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
