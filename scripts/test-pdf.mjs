/**
 * PDF из Markdown через Chromium (CW2.4, ADR 0067) и превью документов
 * картинками для самопроверки агента (CW2.5, ADR 0068). Под Electron.
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
    const { markdownToHtml, slidesToHtml } = await import('../electron/lib/export/html.js');
    const { renderPdf, renderPng } = await import('../electron/lib/pdf-render.js');
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
    // На Windows pdftotext из комплекта Git отдаёт пустой текст — сверяем только там, где он надёжен.
    const txt = process.platform === 'win32' ? { status: 1 } : spawnSync('pdftotext', ['-enc', 'UTF-8', file, '-'], { encoding: 'utf8' });
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

    console.log('[5] превью картинками');
    const long = markdownToHtml(`# Длинный\n\n${Array.from({ length: 120 }, (_x, i) => `- пункт ${i}`).join('\n')}`);
    const shot = await renderPng(BrowserWindow, long, { maxPages: 2 });
    const isPng = (b) => b.subarray(1, 4).toString() === 'PNG';
    check('длинный документ — несколько страниц, не больше maxPages', shot.total >= 3 && shot.pages.length === 2 && shot.pages.every(isPng), `${shot.total}/${shot.pages.length}`);
    const slidesHtml = slidesToHtml('## Слайд 1: Итоги\n\n- рост\n\n## Слайд 2: План\n\n- найм');
    check('слайды — карточки 16:9 без «Слайд N:»', (slidesHtml.match(/class="slide"/g) || []).length === 2 && /<h2>Итоги<\/h2>/.test(slidesHtml), slidesHtml.slice(0, 200));
    let hits2 = 0;
    const server2 = http.createServer((_req, res) => {
      hits2 += 1;
      res.end('x');
    });
    await new Promise((r) => server2.listen(0, '127.0.0.1', r));
    const port = server2.address().port;
    await renderPng(BrowserWindow, `<!doctype html><html><body><p>x</p><img src="http://127.0.0.1:${port}/a.png"><script>fetch('http://127.0.0.1:${port}/s')</script></body></html>`);
    await new Promise((r) => setTimeout(r, 300));
    server2.close();
    check('превью: ни сети, ни скриптов страницы', hits2 === 0, String(hits2));

    const preview = documentTools.find((t) => t.schema.function.name === 'preview_document');
    const pEntry = toolEntry(preview.schema, { source: 'builtin', run: preview.run, precheck: preview.precheck });
    const previewDir = path.join(sandbox, 'previews');
    const pctx = { projectDir: sandbox, previewDir, vision: () => true, renderPng: (h, o) => renderPng(BrowserWindow, h, o) };
    for (const [name, args] of [
      ['Отчёт.docx', { path: 'Отчёт.docx', markdown: '# Отчёт\n\n| a | b |\n|---|---|\n| 1 | 2 |' }],
      ['Слайды.pptx', { path: 'Слайды.pptx', slides: [{ title: 'Итоги', bullets: ['рост'] }, { title: 'План', bullets: ['найм'] }] }],
      ['Таблица.xlsx', { path: 'Таблица.xlsx', sheets: [{ name: 'Лист', rows: [['Месяц', 'Сумма'], ['Январь', 100]] }] }],
    ]) {
      await runToolCall({ entry, args, ctx: { projectDir: sandbox }, policy });
      const res = await runToolCall({ entry: pEntry, args: { path: name }, ctx: pctx, policy });
      check(`${name}: картинки страниц для модели`, res.ok !== false && Array.isArray(res.images) && res.images.length >= 1 && res.images.every((f) => f.startsWith(previewDir) && isPng(fs.readFileSync(f))) && /показаны тебе/.test(res.content), res.content);
    }
    let res = await runToolCall({ entry: pEntry, args: { path: 'Отчёт.docx' }, ctx: { ...pctx, vision: () => false }, policy });
    check('модель без зрения — отказ с подсказкой', !res.images && /read_document/.test(res.content), res.content);
    res = await runToolCall({ entry: pEntry, args: { path: 'a.exe' }, ctx: pctx, policy });
    check('неподдерживаемый формат — отказ', /Превью для \.exe нет/.test(res.content), res.content);
    res = await runToolCall({ entry: pEntry, args: { path: 'Отчёт.docx' }, ctx: { projectDir: sandbox, vision: () => true }, policy });
    check('без Chromium — отказ', /только в приложении/.test(res.content), res.content);
    const hasPoppler = process.platform !== 'win32' && !spawnSync('pdftoppm', ['-v']).error;
    res = await runToolCall({ entry: pEntry, args: { path: 'Итог.pdf' }, ctx: pctx, policy });
    if (hasPoppler) check('PDF через pdftoppm', Array.isArray(res.images) && res.images.length === 1, res.content);
    else check('PDF: картинки или понятный отказ про pdftoppm', (Array.isArray(res.images) && res.images.length === 1) || /pdftoppm/.test(res.content), res.content);
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
