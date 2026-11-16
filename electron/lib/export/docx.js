import { createZip } from './zip.js';
import { parseMarkdown } from './markdown.js';

/**
 * Markdown → DOCX (WordprocessingML) без внешних библиотек.
 *
 * DOCX — это ZIP с XML. Собираем минимальный набор частей, который Word
 * и LibreOffice открывают без предупреждений. См. ADR 0025.
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

/** Абзац с текстом. */
function para(text, styleId) {
  const style = styleId ? `<w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>` : '';
  return `<w:p>${style}<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}

/** Абзац моношрифтом — для блоков кода. */
function codePara(text) {
  const lines = String(text).split('\n');
  return lines
    .map(
      (line) =>
        `<w:p><w:pPr><w:pStyle w:val="Code"/></w:pPr><w:r><w:t xml:space="preserve">${esc(line || ' ')}</w:t></w:r></w:p>`,
    )
    .join('');
}

/** Таблица WordprocessingML. */
function table(header, rows) {
  const columns = Math.max(header.length, ...rows.map((row) => row.length), 1);
  const width = Math.floor(9000 / columns);
  const cell = (text, bold) =>
    `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>` +
    `<w:p><w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p></w:tc>`;

  const headerRow = `<w:tr>${Array.from({ length: columns }, (_, i) => cell(header[i] || '', true)).join('')}</w:tr>`;
  const bodyRows = rows
    .map((row) => `<w:tr>${Array.from({ length: columns }, (_, i) => cell(row[i] || '', false)).join('')}</w:tr>`)
    .join('');

  return (
    '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/>' +
    '<w:tblBorders>' +
    '<w:top w:val="single" w:sz="4" w:color="999999"/>' +
    '<w:left w:val="single" w:sz="4" w:color="999999"/>' +
    '<w:bottom w:val="single" w:sz="4" w:color="999999"/>' +
    '<w:right w:val="single" w:sz="4" w:color="999999"/>' +
    '<w:insideH w:val="single" w:sz="4" w:color="999999"/>' +
    '<w:insideV w:val="single" w:sz="4" w:color="999999"/>' +
    '</w:tblBorders></w:tblPr>' +
    headerRow +
    bodyRows +
    '</w:tbl>' +
    '<w:p/>'
  );
}

/** Блоки Markdown → тело документа. */
function body(blocks) {
  const out = [];
  for (const block of blocks) {
    if (block.type === 'heading') {
      const level = Math.min(6, Math.max(1, block.level));
      out.push(para(block.text, `Heading${level}`));
    } else if (block.type === 'paragraph') {
      out.push(para(block.text));
    } else if (block.type === 'code') {
      out.push(codePara(block.text));
    } else if (block.type === 'quote') {
      out.push(para(block.text, 'Quote'));
    } else if (block.type === 'rule') {
      out.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:color="CCCCCC"/></w:pBdr></w:pPr></w:p>');
    } else if (block.type === 'list') {
      block.items.forEach((item, i) => {
        const marker = block.ordered ? `${i + 1}. ` : '• ';
        out.push(para(`${'    '.repeat(item.level)}${marker}${item.text}`, 'ListParagraph'));
      });
    } else if (block.type === 'table') {
      out.push(table(block.header, block.rows));
    }
  }
  return out.join('');
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

/** Стили: заголовки, код, цитата, список. */
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>
<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>
<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="ru-RU"/>
</w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
<w:pPr><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/>
<w:pPr><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/>
<w:pPr><w:spacing w:before="160" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/>
<w:pPr><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading5"><w:name w:val="heading 5"/><w:basedOn w:val="Normal"/>
<w:pPr><w:outlineLvl w:val="4"/></w:pPr><w:rPr><w:b/><w:i/><w:sz w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading6"><w:name w:val="heading 6"/><w:basedOn w:val="Normal"/>
<w:pPr><w:outlineLvl w:val="5"/></w:pPr><w:rPr><w:b/><w:i/><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/>
<w:pPr><w:spacing w:before="0" w:after="0"/><w:shd w:val="clear" w:fill="F4F4F4"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="18"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/>
<w:pPr><w:ind w:left="720"/><w:pBdr><w:left w:val="single" w:sz="12" w:color="CCCCCC"/></w:pBdr></w:pPr>
<w:rPr><w:i/><w:color w:val="555555"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/>
<w:pPr><w:ind w:left="360"/></w:pPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style>
</w:styles>`;

/**
 * Собирает DOCX из Markdown.
 * @param {string} markdown
 * @param {{ title?: string }} [options]
 * @returns {Buffer}
 */
function markdownToDocx(markdown, options = {}) {
  const blocks = parseMarkdown(markdown);
  const title = options.title ? para(options.title, 'Heading1') : '';
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${title}${body(blocks)}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body>
</w:document>`;

  return createZip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: RELS },
    { name: 'word/document.xml', data: document, compress: true },
    { name: 'word/_rels/document.xml.rels', data: DOC_RELS },
    { name: 'word/styles.xml', data: STYLES, compress: true },
  ]);
}

export { markdownToDocx };
