/**
 * web_fetch и web_search (CC1.6, ADR 0056).
 */
import http from 'node:http';
import { isPrivateAddress, htmlToText, fetchPage, parseDuckDuckGo, webSearch, MAX_BYTES } from '../electron/lib/web.js';
import { webTools } from '../electron/lib/tools/web.js';
import { evaluate, classifyTool, subjectOf, suggestRules } from '../electron/lib/policy.js';
import { isDataTool } from '../electron/lib/injection.js';

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
const err = async (p) => {
  try {
    await p;
    return '';
  } catch (e) {
    return e.message;
  }
};

console.log('[1] адреса');
check('частные IPv4', ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.5.5', '169.254.169.254', '0.0.0.0', '100.64.0.1'].every(isPrivateAddress));
check('публичные IPv4', !['8.8.8.8', '93.184.216.34', '172.32.0.1'].some(isPrivateAddress));
check('IPv6: ::1, fe80, fd, ::ffff:127.0.0.1', ['::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1'].every(isPrivateAddress) && !isPrivateAddress('2606:4700::1111'));
check('localhost по имени — отказ', /локальной сети/.test(await err(fetchPage('http://localhost:1/'))));
check('ftp — отказ', /Только http/.test(await err(fetchPage('ftp://example.com/'))));
check('имя, указывающее на частный адрес — отказ', /169\.254/.test(await err(fetchPage('http://meta.example/', { lookup: async () => [{ address: '169.254.169.254' }] }))));
const redirectFetch = async () => ({ status: 302, headers: new Headers({ location: 'http://10.0.0.5/admin' }) });
check('перенаправление на частный адрес — отказ', /10\.0\.0\.5/.test(await err(fetchPage('http://public.example/', { fetchImpl: redirectFetch, lookup: async (h) => [{ address: h === 'public.example' ? '93.184.216.34' : '10.0.0.5' }] }))));

console.log('[2] HTML → текст');
const html = `<!doctype html><html><head><title>Док &amp; API</title><style>.x{}</style><script>alert(1)</script></head>
<body><nav>меню</nav><h1>Док &amp; API</h1><p>Первый <b>абзац</b>&nbsp;текста.</p><ul><li>один</li><li>два</li></ul>
<p>Ссылка: <a href="/guide">руководство</a>, <a href="javascript:x()">плохая</a>.</p><table><tr><td>a</td><td>b</td></tr></table><footer>подвал</footer></body></html>`;
const text = htmlToText(html, 'https://docs.example/api/');
check('заголовок и абзац', text.startsWith('# Док & API') && /Первый абзац текста\./.test(text), text);
check('скрипты, стили, меню и подвал выкинуты', !/alert|\.x\{|меню|подвал/.test(text));
check('список', /- один\n- два/.test(text));
check('ссылки — абсолютные, javascript: — только текст', /\[руководство\]\(https:\/\/docs\.example\/guide\)/.test(text) && !/javascript/.test(text));

console.log('[3] загрузка');
const server = http.createServer((req, res) => {
  if (req.url === '/redir') return res.writeHead(301, { Location: '/page' }).end();
  if (req.url === '/big') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('x'.repeat(MAX_BYTES + 1000));
    return;
  }
  if (req.url === '/img') return res.writeHead(200, { 'Content-Type': 'image/png' }).end(Buffer.alloc(10));
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<h2>Страница</h2><p>Привет, мир</p>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
check('локальный сервер по умолчанию недоступен', /локальной сети/.test(await err(fetchPage(`${base}/page`))));
const page = await fetchPage(`${base}/redir`, { allowPrivate: true });
check('перенаправление и HTML → текст (allowPrivate)', page.url.endsWith('/page') && /## Страница/.test(page.text) && /Привет, мир/.test(page.text), JSON.stringify(page));
const big = await fetchPage(`${base}/big`, { allowPrivate: true });
check('больше 5 МБ — начало и пометка', big.truncated && big.text.length === MAX_BYTES);
check('картинка — не текст', /не текст/.test((await fetchPage(`${base}/img`, { allowPrivate: true })).text));
server.close();

console.log('[4] поиск');
const ddg = `<div class="result results_links"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2Ffs.html&rut=x">File system | <b>Node</b>.js</a><a class="result__snippet" href="#">The <b>fs</b> module enables…</a></div>
<div class="result"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Реклама</a></div>
<div class="result"><a class="result__a" href="https://example.org/a">Пример &amp; два</a><div class="result__snippet">фрагмент</div></div>`;
const parsed = parseDuckDuckGo(ddg);
check('DuckDuckGo: адрес из uddg, реклама отброшена', parsed.length === 2 && parsed[0].url === 'https://nodejs.org/api/fs.html' && parsed[0].title === 'File system | Node.js' && parsed[0].snippet === 'The fs module enables…' && parsed[1].title === 'Пример & два', JSON.stringify(parsed));
const fakeFetch = (body) => async (url, opts) => ({ ok: true, status: 200, url, opts, text: async () => body, json: async () => body });
let seen = null;
const sx = await webSearch('мой запрос', { provider: 'searxng', url: 'https://searx.example/' }, { fetchImpl: async (url) => ((seen = url), { ok: true, json: async () => ({ results: [{ title: 'T', url: 'https://r', content: 'c' }] }) }) });
check('SearXNG: адрес и результат', seen === 'https://searx.example/search?format=json&q=%D0%BC%D0%BE%D0%B9%20%D0%B7%D0%B0%D0%BF%D1%80%D0%BE%D1%81' && sx[0].url === 'https://r');
let braveHeaders = null;
await webSearch('x', { provider: 'brave', apiKey: 'K' }, { fetchImpl: async (_u, o) => ((braveHeaders = o.headers), { ok: true, json: async () => ({ web: { results: [] } }) }) });
check('Brave: ключ в заголовке', braveHeaders['X-Subscription-Token'] === 'K');
check('Brave без ключа — ошибка', /нужен ключ/.test(await err(webSearch('x', { provider: 'brave' }))));
check('пустой запрос — ошибка', /Пустой/.test(await err(webSearch(' '))));
check('ошибка поисковика', /ответил 503/.test(await err(webSearch('x', {}, { fetchImpl: async () => ({ ok: false, status: 503 }) }))));
void fakeFetch;

console.log('[5] политика и инструменты');
check('класс network, данные для детектора', classifyTool('web_fetch') === 'network' && classifyTool('web_search') === 'network' && isDataTool('web_fetch'));
const subj = subjectOf({ tool: 'web_fetch', cls: 'network', args: { url: 'https://docs.python.org/3/library/' } });
check('предмет — домен', subj === 'docs.python.org');
check('правило «не спрашивать» — по домену', suggestRules({ tool: 'web_fetch', cls: 'network', subject: subj })[0] === 'web_fetch(docs.python.org)');
const decide = (mode, rules = {}) => evaluate({ tool: 'web_fetch', cls: 'network', subject: subj, mode, rules }).action;
check('«Авто» и «Принимать правки» — спросить', decide('smart') === 'ask' && decide('acceptEdits') === 'ask');
check('правило по домену — без вопроса, другой домен — спросить', decide('manual', { allow: ['web_fetch(docs.python.org)'] }) === 'allow' && evaluate({ tool: 'web_fetch', cls: 'network', subject: 'evil.example', mode: 'manual', rules: { allow: ['web_fetch(docs.python.org)'] } }).action === 'ask');
check('маска поддоменов', decide('manual', { allow: ['web_fetch(*.python.org)'] }) === 'allow');
const fetchTool = webTools.find((t) => t.schema.function.name === 'web_fetch').run;
const searchTool = webTools.find((t) => t.schema.function.name === 'web_search').run;
const out = await fetchTool({ webFetch: async () => ({ url: 'https://a', status: 200, text: 'x'.repeat(30_000), truncated: false }) }, { url: 'https://a', max_chars: 1000 });
check('web_fetch: max_chars', /ещё 29000 символов/.test(out));
check('web_fetch: ошибка — текстом', /Ошибка web_fetch: Неверный адрес/.test(await fetchTool({}, { url: 'не адрес' })));
const sOut = await searchTool({ webSearchImpl: async () => [{ title: 'Заголовок', url: 'https://x', snippet: 'фрагмент' }] }, { query: 'q' });
check('web_search: нумерованный список', /^1\. Заголовок\n   https:\/\/x\n   фрагмент/.test(sOut), sOut);

if (process.env.MAI_LIVE_WEB === '1') {
  console.log('[6] настоящий интернет (CI)');
  const live = await fetchPage('https://example.com/');
  check('example.com загружается и переводится в текст', live.status === 200 && /Example Domain/.test(live.text), live.text.slice(0, 200));
  try {
    const found = await webSearch('Node.js fs module documentation');
    console.log(`  —    DuckDuckGo: результатов ${found.length}${found[0] ? `, первый ${found[0].url}` : ''} (не проверка: поисковик может отвечать капчей)`);
    if (!found.length) {
      const res = await fetch('https://html.duckduckgo.com/html/?q=nodejs', { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MAI-Code/1.0)' } });
      const body = await res.text();
      console.log(`  —    диагностика: ${res.status}, ${body.length} байт, классы: ${[...new Set(body.match(/class="[^"]{3,40}"/g) || [])].slice(0, 25).join(' ')}`);
    }
  } catch (e) {
    console.log(`  —    DuckDuckGo недоступен: ${e.message} (не проверка)`);
  }
}

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
