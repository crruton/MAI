/**
 * Разбор Markdown в блоки для экспорта.
 *
 * Это не полноценный парсер: нужны только те конструкции, которые реально
 * встречаются в ответах агента. Один проход по строкам, без рекурсии.
 * См. ADR 0025.
 *
 * Блоки:
 *   { type: 'heading', level, text }
 *   { type: 'paragraph', text }
 *   { type: 'list', ordered, items: [{ text, level }] }
 *   { type: 'code', lang, text }
 *   { type: 'table', header: string[], rows: string[][] }
 *   { type: 'quote', text }
 *   { type: 'rule' }
 */

/** Убирает инлайн-разметку, оставляя читаемый текст. */
function stripInline(text) {
  return String(text)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // картинка → её подпись
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // ссылка → её текст
    .replace(/`([^`]+)`/g, '$1') // код в строке
    .replace(/(\*\*|__)(.+?)\1/g, '$2') // жирный
    .replace(/(\*|_)(.+?)\1/g, '$2') // курсив
    .replace(/~~(.+?)~~/g, '$1') // зачёркнутый
    .trim();
}

/** Делит строку таблицы на ячейки, уважая экранированную черту. */
function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let current = '';
  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (char === '\\' && trimmed[i + 1] === '|') {
      current += '|';
      i += 1;
      continue;
    }
    if (char === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

/** Строка-разделитель таблицы: |---|:--:|---| */
function isTableDivider(line) {
  return /^\s*\|?[\s:-]*-[\s|:-]*\|?\s*$/.test(line) && line.includes('-');
}

/**
 * Разбирает Markdown в массив блоков.
 * @param {string} markdown
 * @returns {Array<object>}
 */
function parseMarkdown(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    // Пустая строка — граница блоков.
    if (!line.trim()) {
      index += 1;
      continue;
    }

    // Блок кода: ``` или ~~~
    const fence = line.match(/^\s*(```|~~~)\s*([\w+-]*)\s*$/);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2] || '';
      const body = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(marker)) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1; // закрывающая черта
      blocks.push({ type: 'code', lang, text: body.join('\n') });
      continue;
    }

    // Заголовок: # … ######
    const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: stripInline(heading[2]) });
      index += 1;
      continue;
    }

    // Горизонтальная линия.
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      blocks.push({ type: 'rule' });
      index += 1;
      continue;
    }

    // Таблица: строка с чертами, затем разделитель.
    if (line.includes('|') && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      const header = splitRow(line).map(stripInline);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(splitRow(lines[index]).map(stripInline));
        index += 1;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }

    // Цитата: > текст
    if (/^\s*>/.test(line)) {
      const body = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        body.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push({ type: 'quote', text: stripInline(body.join(' ')) });
      continue;
    }

    // Список: -, *, + или 1.
    const listMatch = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[2]);
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (!item) break;
        // Уровень вложенности: два пробела или табуляция на шаг.
        const indent = item[1].replace(/\t/g, '  ').length;
        items.push({ text: stripInline(item[3]), level: Math.min(3, Math.floor(indent / 2)) });
        index += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    // Абзац: подряд идущие строки до пустой или до начала другого блока.
    const paragraph = [];
    while (index < lines.length) {
      const current = lines[index];
      if (!current.trim()) break;
      if (/^\s*(#{1,6})\s+/.test(current)) break;
      if (/^\s*(```|~~~)/.test(current)) break;
      if (/^\s*>/.test(current)) break;
      if (/^(\s*)([-*+]|\d+[.)])\s+/.test(current)) break;
      if (current.includes('|') && index + 1 < lines.length && isTableDivider(lines[index + 1])) break;
      paragraph.push(current.trim());
      index += 1;
    }
    if (paragraph.length) {
      blocks.push({ type: 'paragraph', text: stripInline(paragraph.join(' ')) });
    }
  }

  return blocks;
}

/**
 * Markdown → простой текст. Заголовки без решёток, таблицы через табуляцию.
 * @param {string} markdown
 * @returns {string}
 */
function markdownToText(markdown) {
  const blocks = parseMarkdown(markdown);
  const out = [];
  for (const block of blocks) {
    if (block.type === 'heading') {
      out.push(block.text.toUpperCase());
      out.push('');
    } else if (block.type === 'paragraph') {
      out.push(block.text);
      out.push('');
    } else if (block.type === 'code') {
      out.push(block.text);
      out.push('');
    } else if (block.type === 'quote') {
      out.push(`  ${block.text}`);
      out.push('');
    } else if (block.type === 'rule') {
      out.push('-'.repeat(40));
      out.push('');
    } else if (block.type === 'list') {
      block.items.forEach((item, i) => {
        const marker = block.ordered ? `${i + 1}.` : '-';
        out.push(`${'  '.repeat(item.level)}${marker} ${item.text}`);
      });
      out.push('');
    } else if (block.type === 'table') {
      out.push(block.header.join('\t'));
      for (const row of block.rows) out.push(row.join('\t'));
      out.push('');
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export { parseMarkdown, markdownToText, stripInline };
