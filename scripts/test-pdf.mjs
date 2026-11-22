/**
 * PDF из Markdown через Chromium (CW2.4, ADR 0067). Под Electron.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { app, BrowserWindow } from 'electron';

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
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-pdf-'));
app.setPath('userData', path.join(sandbox, 'data'));

app.on('window-all-closed', () => {}); // окна PDF закрываются — приложение не должно выходить
app.whenReady().then(async () => {
  try {
    const { markdownToHtml } = await import('../electron/lib/export/html.js');
    const { renderPdf } = await import('../electron/lib/pdf-render.js');
    const { documentTools } = await import('../electron/lib/tools/documents.js');
    const { toolEntry, runToolCall } = await import('../electron/lib/tool-runner.js');

    console.log('[1] HTML');
    const html = markdownToHtml('## Итоги\n\nВыручка <выросла> & "кавычки".\n\n- пункт\n  - вложенный\n\n| Месяц | Сумма |\n|---|---|\n| Январь | 100 |', { title: 'Отчёт' });
    check('заголовок, экранирование, таблица, список', /<h1>Отчёт<\/h1>/.test(html) && /&lt;выросла&gt; &amp; &quot;кавычки&quot;/.test(html) && /<th>Месяц<\/th>/.test(html) && /<li style="margin-left:14pt">вложенный/.test(html));
    check('без скриптов, CSP default-src none', !/<script/i.test(html) && /default-src 'none'/.test(html));

    console.log('[2] PDF');
    const pdf = await renderPdf(BrowserWindow, html);
    check('PDF получен', Buffer.isBuffer(pdf) && pdf.subarray(0, 5).toString() === '%PDF-' && pdf.length > 2000, String(pdf?.length));
    const file = path.join(sandbox, 'out.pdf');
    fs.writeFileSync(file, pdf);
    const txt = spawnSync('pdftotext', [file, '-'], { encoding: 'utf8' });
    if (txt.status === 0) check('текст в PDF: кириллица и таблица', /Отчёт/.test(txt.stdout) && /Выручка <выросла> & "кавычки"/.test(txt.stdout) && /Январь/.test(txt.stdout), txt.stdout.slice(0, 300));
    else console.log('  —    pdftotext нет — текст не проверяется');

    console.log('[3] без сети');
    let hits = 0;
    const server = http.createServer((_req, res) => {
      hits += 1;
      res.end('x');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const leaky = `<!doctype html><html><body><p>тест</p><img src="http://127.0.0.1:${server.address().port}/track.png"><link rel="stylesheet" href="http://127.0.0.1:${server.address().port}/x.css"></body></html>`;
    await renderPdf(BrowserWindow, leaky);
    await new Promise((r) => setTimeout(r, 300));
    server.close();
    check('внешние ресурсы не загружаются', hits === 0, String(hits));

    console.log('[4] create_document .pdf');
    const def = documentTools.find((t) => t.schema.function.name === 'create_document');
    const entry = toolEntry(def.schema, { source: 'builtin', run: def.run, precheck: def.precheck, preview: def.preview });
    const policy = { getMode: () => 'bypass', getRules: () => ({}) };
    let out = await runToolCall({ entry, args: { path: 'Итог.pdf', title: 'Итог', markdown: 'Готово.' }, ctx: { projectDir: sandbox, renderPdf: (h) => renderPdf(BrowserWindow, h) }, policy });
    check('создан PDF в проекте', /Создан документ/.test(out.content) && fs.readFileSync(path.join(sandbox, 'Итог.pdf')).subarray(0, 5).toString() === '%PDF-', out.content);
    out = await runToolCall({ entry, args: { path: 'x.pdf', markdown: 'x' }, ctx: { projectDir: sandbox }, policy });
    check('без Chromium — понятный отказ', /только в приложении/.test(out.content));
  } catch (err) {
    fail += 1;
    console.log(`  FAIL исключение: ${err?.stack || err}`);
  }
  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* кеш */
  }
  console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
  app.exit(fail ? 1 : 0);
});
