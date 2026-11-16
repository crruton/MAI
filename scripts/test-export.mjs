import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { createZip, crc32 } from '../electron/lib/export/zip.js';
import { parseMarkdown, markdownToText } from '../electron/lib/export/markdown.js';
import { markdownToDocx } from '../electron/lib/export/docx.js';
import { markdownToXlsx } from '../electron/lib/export/xlsx.js';
import { buildExport, fileNameFor, safeFileName, chatToMarkdown, FORMATS } from '../electron/lib/export/index.js';

/**
 * Проверки экспорта ответа в MD, TXT, DOCX и XLSX.
 *
 * Тест не требует Electron и сети: модули экспорта чистые.
 * Запуск: node scripts/test-export.mjs
 */

let pass = 0;
let fail = 0;

function check(name, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`  OK   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Читает ZIP-архив: возвращает карту имя → содержимое. */
function readZip(buffer) {
  const files = new Map();
  // Ищем сигнатуру конца центрального каталога с конца файла.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Нет конца центрального каталога');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Битый центральный каталог');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    files.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

const SAMPLE = `# Отчёт по задаче

Краткое описание с **жирным** и \`кодом\`.

## Таблица результатов

| Файл | Строк | Статус |
|---|---|---|
| main.js | 120 | готово |
| app.js | 340 | в работе |

## Список

- первый пункт
- второй пункт
  - вложенный пункт

1. шаг один
2. шаг два

## Код

\`\`\`js
const x = 1;
console.log(x);
\`\`\`

> Цитата с мыслью.

---

Конец.
`;

console.log('\n[1] ZIP-писатель');
{
  const zip = createZip([
    { name: 'a.txt', data: 'привет' },
    { name: 'b.txt', data: 'x'.repeat(5000), compress: true },
  ]);
  check('сигнатура PK в начале', zip.readUInt32LE(0) === 0x04034b50);
  const files = readZip(zip);
  check('два файла в архиве', files.size === 2, String(files.size));
  check('кириллица сохранилась', files.get('a.txt')?.toString('utf8') === 'привет');
  check('сжатый файл распаковался', files.get('b.txt')?.toString('utf8') === 'x'.repeat(5000));
  check('CRC-32 совпадает с эталоном', crc32(Buffer.from('123456789')) === 0xcbf43926, String(crc32(Buffer.from('123456789'))));
}

console.log('\n[2] Разбор Markdown');
{
  const blocks = parseMarkdown(SAMPLE);
  const types = blocks.map((b) => b.type);
  check('заголовок найден', types.includes('heading'));
  check('таблица найдена', types.includes('table'));
  check('список найден', types.includes('list'));
  check('код найден', types.includes('code'));
  check('цитата найдена', types.includes('quote'));
  check('линия найдена', types.includes('rule'));

  const table = blocks.find((b) => b.type === 'table');
  check('три колонки в таблице', table.header.length === 3, JSON.stringify(table.header));
  check('две строки данных', table.rows.length === 2, JSON.stringify(table.rows));
  check('ячейка прочитана', table.rows[0][0] === 'main.js', JSON.stringify(table.rows[0]));

  const code = blocks.find((b) => b.type === 'code');
  check('язык кода определён', code.lang === 'js', code.lang);
  check('тело кода сохранено', code.text.includes('console.log'), code.text);

  const lists = blocks.filter((b) => b.type === 'list');
  check('два списка', lists.length === 2, String(lists.length));
  check('первый список маркированный', lists[0].ordered === false);
  check('второй список нумерованный', lists[1].ordered === true);
  check('вложенность определена', lists[0].items.some((i) => i.level > 0), JSON.stringify(lists[0].items));

  const heading = blocks.find((b) => b.type === 'heading');
  check('уровень заголовка', heading.level === 1, String(heading.level));
  check('инлайн-разметка убрана', !heading.text.includes('#'));
}

console.log('\n[3] Markdown → текст');
{
  const text = markdownToText(SAMPLE);
  check('решётки убраны', !text.includes('# Отчёт'), text.slice(0, 60));
  check('жирный упрощён', text.includes('жирным') && !text.includes('**'));
  check('таблица через табуляцию', text.includes('Файл\tСтрок\tСтатус'), JSON.stringify(text.slice(0, 200)));
  check('код сохранён', text.includes('const x = 1;'));
  check('список с маркерами', text.includes('- первый пункт'));
  check('нумерация сохранена', text.includes('1. шаг один'));
  check('текст не пустой', text.trim().length > 100, String(text.length));
}

console.log('\n[4] DOCX');
{
  const docx = markdownToDocx(SAMPLE, { title: 'Отчёт' });
  check('это ZIP', docx.readUInt32LE(0) === 0x04034b50);
  const files = readZip(docx);
  check('часть [Content_Types].xml есть', files.has('[Content_Types].xml'));
  check('часть _rels/.rels есть', files.has('_rels/.rels'));
  check('часть word/document.xml есть', files.has('word/document.xml'));
  check('часть word/styles.xml есть', files.has('word/styles.xml'));
  check('связи документа есть', files.has('word/_rels/document.xml.rels'));

  const document = files.get('word/document.xml').toString('utf8');
  check('XML объявлен', document.startsWith('<?xml'));
  check('пространство имён Word', document.includes('wordprocessingml/2006/main'));
  check('текст ответа внутри', document.includes('Отчёт по задаче'));
  check('таблица как w:tbl', document.includes('<w:tbl>'));
  check('код моношрифтом', document.includes('w:val="Code"'));
  check('заголовки стилями', document.includes('w:val="Heading1"'));
  check('секция страницы есть', document.includes('<w:sectPr>'));

  const styles = files.get('word/styles.xml').toString('utf8');
  check('стиль кода объявлен', styles.includes('w:styleId="Code"'));
  check('Consolas в стилях', styles.includes('Consolas'));
  check('русский язык в стилях', styles.includes('ru-RU'));

  // Экранирование: спецсимволы не должны ломать XML.
  const risky = markdownToDocx('Текст с <тегом> и & амперсандом');
  const riskyDoc = readZip(risky).get('word/document.xml').toString('utf8');
  check('угловые скобки экранированы', riskyDoc.includes('&lt;тегом&gt;'), riskyDoc.slice(-300));
  check('амперсанд экранирован', riskyDoc.includes('&amp;'));
}

console.log('\n[5] XLSX');
{
  const xlsx = markdownToXlsx(SAMPLE, { title: 'Отчёт' });
  check('это ZIP', xlsx.readUInt32LE(0) === 0x04034b50);
  const files = readZip(xlsx);
  check('книга есть', files.has('xl/workbook.xml'));
  check('связи книги есть', files.has('xl/_rels/workbook.xml.rels'));
  check('стили есть', files.has('xl/styles.xml'));
  check('лист есть', files.has('xl/worksheets/sheet1.xml'));

  const workbook = files.get('xl/workbook.xml').toString('utf8');
  check('имя листа из заголовка', workbook.includes('Таблица результатов'), workbook);
  check('sheetId выставлен', workbook.includes('sheetId="1"'));

  const sheet = files.get('xl/worksheets/sheet1.xml').toString('utf8');
  check('заголовок таблицы в листе', sheet.includes('Файл'));
  check('данные в листе', sheet.includes('main.js'));
  check('жирный стиль у заголовка', sheet.includes('s="1"'));
  check('ссылки ячеек верные', sheet.includes('r="A1"') && sheet.includes('r="C2"'), sheet.slice(0, 400));

  // Ответ без таблиц: один лист с текстом.
  const plain = markdownToXlsx('Просто текст без таблиц.\n\nВторой абзац.');
  const plainFiles = readZip(plain);
  const plainSheet = plainFiles.get('xl/worksheets/sheet1.xml').toString('utf8');
  check('без таблиц лист создан', plainFiles.has('xl/worksheets/sheet1.xml'));
  check('текст попал в лист', plainSheet.includes('Просто текст'), plainSheet.slice(0, 300));

  // Две таблицы → два листа.
  const two = markdownToXlsx('## A\n\n| x |\n|---|\n| 1 |\n\n## B\n\n| y |\n|---|\n| 2 |');
  const twoFiles = readZip(two);
  check('две таблицы — два листа', twoFiles.has('xl/worksheets/sheet2.xml'), [...twoFiles.keys()].join(','));
}

console.log('\n[6] Имена файлов');
{
  check('дата и тема в имени', /^\d{4}-\d{2}-\d{2}-Отчёт по задаче\.md$/.test(fileNameFor(SAMPLE, 'md', new Date(2026, 10, 16))), fileNameFor(SAMPLE, 'md', new Date(2026, 10, 16)));
  check('запрещённые символы заменены', !/[<>:"/\\|?*]/.test(safeFileName('a<b>c:d"e/f\\g|h?i*j', 'md')), safeFileName('a<b>c:d"e/f\\g|h?i*j', 'md'));
  check('зарезервированное имя обойдено', safeFileName('CON', 'txt') === '_CON.txt', safeFileName('CON', 'txt'));
  check('пустое имя заменено', safeFileName('', 'md') === 'otvet.md', safeFileName('', 'md'));
  check('длина ограничена', safeFileName('я'.repeat(200), 'md').length <= 84, String(safeFileName('я'.repeat(200), 'md').length));
  check('расширение подставлено', safeFileName('тема', 'docx') === 'тема.docx');
}

console.log('\n[7] Сборка форматов');
{
  const md = buildExport(SAMPLE, 'md');
  check('MD — это буфер', Buffer.isBuffer(md.data));
  check('MD без BOM', md.data[0] !== 0xef, String(md.data[0]));
  check('MD сохраняет разметку', md.data.toString('utf8').includes('**жирным**'));

  const txt = buildExport(SAMPLE, 'txt');
  check('TXT с BOM', txt.data[0] === 0xef && txt.data[1] === 0xbb && txt.data[2] === 0xbf);
  check('TXT без разметки', !txt.data.toString('utf8').includes('**'));

  check('DOCX собирается', buildExport(SAMPLE, 'docx').data.length > 1000);
  check('XLSX собирается', buildExport(SAMPLE, 'xlsx').data.length > 1000);
  check('MIME для DOCX', buildExport(SAMPLE, 'docx').mime.includes('wordprocessingml'));
  check('MIME для XLSX', buildExport(SAMPLE, 'xlsx').mime.includes('spreadsheetml'));

  let threw = false;
  try {
    buildExport(SAMPLE, 'pdf');
  } catch (err) {
    threw = /Неизвестный формат/.test(err.message);
  }
  check('неизвестный формат отклонён', threw);

  check('четыре формата объявлены', Object.keys(FORMATS).length === 4, Object.keys(FORMATS).join(','));
}

console.log('\n[8] Экспорт чата');
{
  const messages = [
    { role: 'user', content: 'Как дела?', display: 'Как дела?' },
    { role: 'assistant', content: 'Всё хорошо.' },
    { role: 'runtime', content: 'отладка' },
    { role: 'assistant', content: '' },
  ];
  const md = chatToMarkdown(messages, { title: 'Тест', now: new Date(2026, 10, 16, 12, 0) });
  check('заголовок чата', md.startsWith('# Тест'), md.slice(0, 40));
  check('дата в шапке', md.includes('Дата:'));
  check('роль пользователя', md.includes('## Пользователь'));
  check('роль агента', md.includes('## MAI'));
  check('текст пользователя', md.includes('Как дела?'));
  check('текст агента', md.includes('Всё хорошо.'));
  check('рантайм не попал', !md.includes('отладка'));
  check('пустой ответ пропущен', (md.match(/## MAI/g) || []).length === 1, String((md.match(/## MAI/g) || []).length));
}

console.log('\n[9] Файлы на диске');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-export-'));
  try {
    for (const format of ['md', 'txt', 'docx', 'xlsx']) {
      const built = buildExport(SAMPLE, format);
      const file = path.join(dir, fileNameFor(SAMPLE, format, new Date(2026, 10, 16)));
      fs.writeFileSync(file, built.data);
      const size = fs.statSync(file).size;
      check(`${format}: файл записан (${size} Б)`, size > 0);
      // DOCX и XLSX должны читаться как ZIP.
      if (format === 'docx' || format === 'xlsx') {
        const files = readZip(fs.readFileSync(file));
        check(`${format}: архив читается`, files.size >= 4, String(files.size));
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
