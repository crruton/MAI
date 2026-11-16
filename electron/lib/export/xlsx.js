import { createZip } from './zip.js';
import { parseMarkdown } from './markdown.js';

/**
 * Markdown → XLSX (SpreadsheetML) без внешних библиотек.
 *
 * Каждая таблица Markdown становится отдельным листом. Если таблиц нет,
 * лист один: текст ответа построчно. См. ADR 0025.
 */

/** Экранирование текста для XML. */
function esc(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Имя листа: Excel запрещает : \ / ? * [ ] и длину больше 31. */
function sheetName(raw, index) {
  const cleaned = String(raw || '')
    .replace(/[:\\/?*[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 31);
  return cleaned || `Лист${index + 1}`;
}

/** Номер колонки → буква: 1 → A, 27 → AA. */
function columnLetter(index) {
  let n = index;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Строка листа из массива значений. */
function rowXml(values, rowIndex, bold) {
  const cells = values
    .map((value, i) => {
      const ref = `${columnLetter(i + 1)}${rowIndex}`;
      const style = bold ? ' s="1"' : '';
      return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
    })
    .join('');
  return `<row r="${rowIndex}">${cells}</row>`;
}

/** Лист из таблицы. */
function tableSheet(header, rows) {
  const all = [header, ...rows];
  const body = all.map((row, i) => rowXml(row, i + 1, i === 0)).join('');
  const width = Math.max(header.length, 1);
  const cols = Array.from({ length: width }, (_, i) => `<col min="${i + 1}" max="${i + 1}" width="24" customWidth="1"/>`).join('');
  return `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${cols}</cols><sheetData>${body}</sheetData></worksheet>`;
}

/** Лист из строк текста: одна колонка. */
function textSheet(lines) {
  const body = lines.map((line, i) => rowXml([line], i + 1, false)).join('');
  return `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="100" customWidth="1"/></cols><sheetData>${body}</sheetData></worksheet>`;
}

/**
 * Собирает XLSX из Markdown.
 * @param {string} markdown
 * @param {{ title?: string }} [options]
 * @returns {Buffer}
 */
function markdownToXlsx(markdown, options = {}) {
  const blocks = parseMarkdown(markdown);
  const tables = blocks.filter((block) => block.type === 'table');

  /** @type {Array<{ name: string, xml: string }>} */
  const sheets = [];

  if (tables.length) {
    tables.forEach((table, i) => {
      // Имя листа — первый заголовок перед таблицей, иначе «Таблица N».
      const heading = blocks
        .slice(0, blocks.indexOf(table))
        .reverse()
        .find((block) => block.type === 'heading');
      const name = sheetName(heading?.text || `Таблица ${i + 1}`, i);
      sheets.push({ name, xml: tableSheet(table.header, table.rows) });
    });
  } else {
    // Таблиц нет: выгружаем текст построчно, чтобы файл не был пустым.
    const lines = [];
    if (options.title) lines.push(options.title, '');
    for (const block of blocks) {
      if (block.type === 'heading') lines.push(block.text);
      else if (block.type === 'paragraph') lines.push(block.text);
      else if (block.type === 'code') lines.push(...block.text.split('\n'));
      else if (block.type === 'quote') lines.push(`> ${block.text}`);
      else if (block.type === 'list') block.items.forEach((item) => lines.push(`${'  '.repeat(item.level)}- ${item.text}`));
      else if (block.type === 'rule') lines.push('');
    }
    sheets.push({ name: sheetName(options.title || 'Ответ', 0), xml: textSheet(lines.length ? lines : ['']) });
  }

  // Имена листов должны быть уникальны, иначе Excel ругается.
  const seen = new Map();
  for (const sheet of sheets) {
    const count = seen.get(sheet.name) || 0;
    seen.set(sheet.name, count + 1);
    if (count) sheet.name = sheetName(`${sheet.name} ${count + 1}`, count);
  }

  const workbookSheets = sheets
    .map((sheet, i) => `<sheet name="${esc(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('');

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${workbookSheets}</sheets>
</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets
  .map(
    (_sheet, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
  )
  .join('')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheets
  .map(
    (_sheet, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  )
  .join('')}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  // Стиль 1 — жирный, для строки заголовка.
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="1"><fill><patternFill patternType="none"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
</styleSheet>`;

  const entries = [
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/styles.xml', data: styles },
  ];
  sheets.forEach((sheet, i) => {
    entries.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheet.xml, compress: true });
  });

  return createZip(entries);
}

export { markdownToXlsx };
