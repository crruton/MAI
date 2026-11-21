/**
 * Документы как результат работы агента (бэклог CW2.1, CW2.2, ADR 0049).
 *
 * Чтение: DOCX → Markdown (заголовки, абзацы, списки, таблицы), XLSX → листы
 * со строками (значения; формулы — `=…` с вычисленным значением, если оно
 * сохранено). Запись: DOCX из Markdown, XLSX из листов (числа, формулы).
 * Без внешних библиотек (ZIP — `export/zip.js`, `export/unzip.js`).
 *
 * Модуль не зависит от Electron.
 */
import { readZip } from './export/unzip.js';
import { markdownToDocx } from './export/docx.js';
import { sheetsToXlsx, markdownToXlsx } from './export/xlsx.js';

const decode = (text) =>
  String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

/** Текст абзаца Word: <w:t>, табуляции и переносы. */
function runText(xml) {
  let out = '';
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)) {
    if (m[0] === '<w:tab/>') out += '\t';
    else if (m[0] === '<w:br/>') out += '\n';
    else out += decode(m[1]);
  }
  return out;
}

function paragraphMarkdown(xml) {
  const text = runText(xml).trim();
  if (!text) return '';
  const style = /<w:pStyle w:val="([^"]+)"/.exec(xml)?.[1] || '';
  const heading = /^(?:Heading|Заголовок)\s*(\d)$/i.exec(style) || /^heading(\d)$/i.exec(style);
  if (heading) return `${'#'.repeat(Math.min(Number(heading[1]), 6))} ${text}`;
  if (/^Title$/i.test(style)) return `# ${text}`;
  if (/<w:numPr>/.test(xml) || /List/i.test(style) || /^[•·]\s/.test(text)) return `- ${text.replace(/^[•·]\s*/, '')}`;
  return text;
}

function tableMarkdown(xml) {
  const rows = [...xml.matchAll(/<w:tr[\s>][\s\S]*?<\/w:tr>/g)].map((row) =>
    [...row[0].matchAll(/<w:tc[\s>][\s\S]*?<\/w:tc>/g)].map((cell) =>
      [...cell[0].matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)].map((p) => runText(p[0]).trim()).filter(Boolean).join(' ').replace(/\|/g, '\\|'),
    ),
  );
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] || '').join(' | ')} |`;
  return [line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n');
}

/** DOCX → Markdown. */
export function docxToMarkdown(buffer) {
  const files = readZip(buffer);
  const doc = files.get('word/document.xml');
  if (!doc) throw new Error('В файле нет word/document.xml — это не DOCX');
  const xml = doc.toString('utf8');
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(xml)?.[1] || xml;
  const blocks = [];
  // Таблицы и абзацы верхнего уровня по порядку.
  const re = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[\s>][\s\S]*?<\/w:p>|<w:p\/>/g;
  for (const m of body.matchAll(re)) {
    const md = m[0].startsWith('<w:tbl') ? tableMarkdown(m[0]) : paragraphMarkdown(m[0]);
    if (md) blocks.push(md);
  }
  return blocks.join('\n\n');
}

function columnIndex(ref) {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] || 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** XLSX → [{ name, rows }]. Формулы — `=…` (значение — в `values`). */
export function readXlsx(buffer, { maxRows = 2000 } = {}) {
  const files = readZip(buffer);
  const workbook = files.get('xl/workbook.xml')?.toString('utf8');
  if (!workbook) throw new Error('В файле нет xl/workbook.xml — это не XLSX');
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') || '';
  const targets = new Map([...rels.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]));
  const shared = [...(files.get('xl/sharedStrings.xml')?.toString('utf8') || '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => decode(t[1])).join(''),
  );
  const sheets = [];
  for (const m of workbook.matchAll(/<sheet\s[^>]*name="([^"]*)"[^>]*r:id="([^"]+)"/g)) {
    const target = String(targets.get(m[2]) || '').replace(/^\/?xl\//, '');
    const xml = files.get(`xl/${target}`)?.toString('utf8') || '';
    const rows = [];
    const values = [];
    let truncated = false;
    for (const row of xml.matchAll(/<row[^>]*?(?:\sr="(\d+)")?[^>]*>([\s\S]*?)<\/row>/g)) {
      const r = Number(row[1] || rows.length + 1) - 1;
      if (r >= maxRows) {
        truncated = true;
        break;
      }
      for (const cell of row[2].matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cell[1];
        const inner = cell[2] || '';
        const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1] || 'A1';
        const type = /t="([^"]+)"/.exec(attrs)?.[1] || 'n';
        const formula = /<f[^>]*>([\s\S]*?)<\/f>/.exec(inner)?.[1];
        const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        let value = '';
        if (type === 's') value = shared[Number(raw)] ?? '';
        else if (type === 'inlineStr') value = [...inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => decode(t[1])).join('');
        else if (type === 'b') value = raw === '1';
        else if (type === 'str' || type === 'e') value = decode(raw ?? '');
        else value = raw === undefined ? '' : Number(raw);
        const c = columnIndex(ref);
        (rows[r] ||= [])[c] = formula ? `=${decode(formula)}` : value;
        if (formula) (values[r] ||= [])[c] = value;
      }
    }
    const dense = Array.from({ length: rows.length }, (_, i) => Array.from({ length: (rows[i] || []).length }, (_, j) => rows[i]?.[j] ?? ''));
    sheets.push({ name: decode(m[1]), rows: dense, values, truncated });
  }
  return sheets;
}

/** Листы → текст для агента: CSV-подобные строки с номерами. */
export function sheetsToText(sheets) {
  return sheets
    .map((sheet) => {
      const lines = sheet.rows.map((row, i) => `${i + 1}: ${row.map((v) => (typeof v === 'string' && /[;\n]/.test(v) ? JSON.stringify(v) : String(v))).join(' ; ')}`);
      return `## Лист «${sheet.name}» (строк: ${sheet.rows.length}${sheet.truncated ? ', показаны первые' : ''})\n${lines.join('\n')}`;
    })
    .join('\n\n');
}

export function buildDocx(markdown, { title } = {}) {
  return markdownToDocx(String(markdown || ''), { title });
}

export function buildXlsx({ sheets, markdown, title } = {}) {
  if (Array.isArray(sheets) && sheets.length) return sheetsToXlsx(sheets);
  return markdownToXlsx(String(markdown || ''), { title });
}
