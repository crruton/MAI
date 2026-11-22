import { parseMarkdown } from './markdown.js';

/**
 * Markdown → самостоятельная HTML-страница для печати в PDF (CW2.4, ADR 0067).
 * Только разметка и встроенные стили: без скриптов, внешних ресурсов и ссылок
 * на файлы — страница рендерится в окне без JavaScript и без сети.
 */
const esc = (text) =>
  String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const CSS = `
@page { size: A4; margin: 18mm 16mm; }
body { font-family: "Segoe UI", "Noto Sans", "DejaVu Sans", Arial, sans-serif; font-size: 11pt; line-height: 1.45; color: #111827; }
h1 { font-size: 20pt; margin: 0 0 10pt; }
h2 { font-size: 15pt; margin: 16pt 0 6pt; border-bottom: 1px solid #e5e7eb; padding-bottom: 3pt; }
h3, h4, h5, h6 { font-size: 12pt; margin: 12pt 0 4pt; }
p { margin: 0 0 7pt; }
ul, ol { margin: 0 0 7pt 18pt; padding: 0; }
li { margin: 2pt 0; }
pre { background: #f3f4f6; padding: 8pt; border-radius: 4pt; font-family: Consolas, "DejaVu Sans Mono", monospace; font-size: 9pt; white-space: pre-wrap; }
blockquote { margin: 0 0 7pt; padding-left: 10pt; border-left: 3pt solid #c7d2fe; color: #374151; }
table { border-collapse: collapse; width: 100%; margin: 4pt 0 10pt; font-size: 10pt; }
th, td { border: 1px solid #d1d5db; padding: 4pt 6pt; text-align: left; vertical-align: top; }
th { background: #eef2ff; }
tr { page-break-inside: avoid; }
hr { border: 0; border-top: 1px solid #d1d5db; margin: 10pt 0; }
`;

function listHtml(block) {
  // Уровни вложенности — через отступ: плоский список с margin по уровню.
  const tag = block.ordered ? 'ol' : 'ul';
  return `<${tag}>${block.items.map((item) => `<li style="margin-left:${(item.level || 0) * 14}pt">${esc(item.text)}</li>`).join('')}</${tag}>`;
}

export function markdownToHtml(markdown, { title = '' } = {}) {
  const body = parseMarkdown(markdown)
    .map((block) => {
      switch (block.type) {
        case 'heading':
          return `<h${block.level}>${esc(block.text)}</h${block.level}>`;
        case 'paragraph':
          return `<p>${esc(block.text)}</p>`;
        case 'list':
          return listHtml(block);
        case 'code':
          return `<pre>${esc(block.text)}</pre>`;
        case 'quote':
          return `<blockquote>${esc(block.text)}</blockquote>`;
        case 'rule':
          return '<hr>';
        case 'table':
          return `<table><thead><tr>${block.header.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${block.rows
            .map((row) => `<tr>${block.header.map((_h, i) => `<td>${esc(row[i] ?? '')}</td>`).join('')}</tr>`)
            .join('')}</tbody></table>`;
        default:
          return '';
      }
    })
    .join('\n');
  const heading = title ? `<h1>${esc(title)}</h1>\n` : '';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${esc(title)}</title><style>${CSS}</style></head><body>${heading}${body}</body></html>`;
}
