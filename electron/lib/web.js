/**
 * Веб для агента (бэклог CC1.6, ADR 0056): web_fetch и web_search.
 *
 * - Только http/https; адреса локальной сети и loopback запрещены (SSRF),
 *   каждое перенаправление проверяется заново.
 * - HTML → текст: заголовки, абзацы, списки, ссылки; скрипты и стили выкинуты.
 * - Поиск: DuckDuckGo (HTML, без ключа), свой SearXNG или Brave Search (ключ).
 *
 * Модуль не зависит от Electron. `fetchImpl` и `lookup` подменяются в тестах.
 */
import dns from 'node:dns/promises';
import net from 'node:net';

export const MAX_BYTES = 5 * 1024 * 1024;
export const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const UA = 'Mozilla/5.0 (compatible; MAI-Code/1.0; +https://github.com/crruton/MAI)';

/** Частный, loopback, link-local и служебные диапазоны IPv4/IPv6. */
export function isPrivateAddress(ip) {
  const v = String(ip).toLowerCase();
  if (net.isIPv4(v)) {
    const [a, b] = v.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(v)) {
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true;
    const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    return mapped ? isPrivateAddress(mapped[1]) : false;
  }
  return true;
}

async function checkHost(url, { allowPrivate = false, lookup = dns.lookup } = {}) {
  if (!/^https?:$/.test(url.protocol)) throw new Error(`Только http и https: ${url.protocol}`);
  if (allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) throw new Error(`Адрес локальной сети запрещён: ${host}`);
  const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  const bad = addresses.find((a) => isPrivateAddress(a.address));
  if (bad) throw new Error(`Адрес локальной сети запрещён: ${host} → ${bad.address}`);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', laquo: '«', raquo: '»', hellip: '…', copy: '©' };
const decode = (t) =>
  String(t)
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);

/** HTML → читаемый текст с заголовками # и ссылками [текст](url). */
export function htmlToText(html, baseUrl = '') {
  let s = String(html);
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1] || '').trim();
  s = s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|iframe|template|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(nav|footer|aside)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n, t) => `\n\n${'#'.repeat(Number(n))} ${t.replace(/<[^>]+>/g, '').trim()}\n\n`);
  s = s.replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, t) => {
    const text = t.replace(/<[^>]+>/g, '').trim();
    if (!text) return '';
    let abs = href;
    try {
      abs = new URL(decode(href), baseUrl || undefined).href;
    } catch {
      /* относительная без базы */
    }
    return /^(https?:)/.test(abs) ? `[${text}](${abs})` : text;
  });
  s = s
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|tr|ul|ol|table|blockquote|pre|h\d)>/gi, '\n')
    .replace(/<(td|th)[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, '');
  s = decode(s)
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return title && !s.startsWith(`# ${title}`) ? `# ${title}\n\n${s}` : s;
}

/**
 * Загрузка страницы. Возвращает { url, status, type, text, bytes, truncated }.
 */
export async function fetchPage(rawUrl, { fetchImpl = fetch, lookup, allowPrivate = false, signal } = {}) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new Error(`Неверный адрес: ${rawUrl}`);
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await checkHost(url, { allowPrivate, lookup });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    signal?.addEventListener('abort', () => controller.abort(), { once: true });
    let res;
    try {
      res = await fetchImpl(url.href, { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': UA, Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' } });
    } catch (err) {
      clearTimeout(timer);
      throw new Error(controller.signal.aborted ? `Нет ответа за ${TIMEOUT_MS / 1000} с` : `Не загрузилось: ${err.message}`);
    }
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
      clearTimeout(timer);
      url = new URL(res.headers.get('location'), url);
      continue;
    }
    const type = res.headers.get('content-type') || '';
    const reader = res.body?.getReader?.();
    const chunks = [];
    let bytes = 0;
    let truncated = false;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > MAX_BYTES) {
          truncated = true;
          chunks.push(value.subarray(0, value.length - (bytes - MAX_BYTES)));
          await reader.cancel().catch(() => {});
          break;
        }
        chunks.push(value);
      }
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      bytes = buf.length;
      chunks.push(buf.subarray(0, MAX_BYTES));
      truncated = buf.length > MAX_BYTES;
    }
    clearTimeout(timer);
    const raw = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    if (/^(image|audio|video)\/|application\/(octet-stream|zip|pdf)/.test(type)) {
      return { url: url.href, status: res.status, type, text: `(${type}, ${bytes} байт — не текст)`, bytes, truncated };
    }
    const body = raw.toString('utf8');
    const text = /html/i.test(type) || /^\s*<(!doctype|html)/i.test(body) ? htmlToText(body, url.href) : body;
    return { url: url.href, status: res.status, type, text, bytes, truncated };
  }
  throw new Error(`Слишком много перенаправлений (больше ${MAX_REDIRECTS})`);
}

/** Результаты DuckDuckGo HTML → [{ title, url, snippet }]. */
export function parseDuckDuckGo(html) {
  const out = [];
  const blocks = String(html).split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/i).slice(1);
  for (const block of blocks) {
    const link = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!link) continue;
    let href = decode(link[1]);
    const uddg = /[?&]uddg=([^&]+)/.exec(href);
    if (uddg) href = decodeURIComponent(uddg[1]);
    if (href.startsWith('//')) href = `https:${href}`;
    if (!/^https?:\/\//.test(href) || /duckduckgo\.com\/y\.js/.test(href)) continue;
    const snippet = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(a|div|td)>/i.exec(block)?.[1] || '';
    out.push({ title: decode(link[2].replace(/<[^>]+>/g, '')).trim(), url: href, snippet: decode(snippet.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() });
  }
  return out;
}

/**
 * Поиск. config: { provider: 'duckduckgo' | 'searxng' | 'brave', url?, apiKey? }.
 */
export async function webSearch(query, config = {}, { fetchImpl = fetch, limit = 8 } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('Пустой запрос');
  const provider = config.provider || 'duckduckgo';
  const get = async (url, headers = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { signal: controller.signal, headers: { 'User-Agent': UA, ...headers } });
      if (!res.ok) throw new Error(`поиск ответил ${res.status}`);
      return res;
    } finally {
      clearTimeout(timer);
    }
  };
  let results;
  if (provider === 'searxng') {
    if (!/^https?:\/\//.test(String(config.url || ''))) throw new Error('Для SearXNG нужен адрес (webSearch.url)');
    const res = await get(`${config.url.replace(/\/$/, '')}/search?format=json&q=${encodeURIComponent(q)}`);
    results = ((await res.json()).results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.content || '' }));
  } else if (provider === 'brave') {
    if (!config.apiKey) throw new Error('Для Brave Search нужен ключ (webSearch.apiKey)');
    const res = await get(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${limit}`, { Accept: 'application/json', 'X-Subscription-Token': config.apiKey });
    results = ((await res.json()).web?.results || []).map((r) => ({ title: r.title, url: r.url, snippet: htmlToText(r.description || '') }));
  } else {
    const res = await get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`);
    results = parseDuckDuckGo(await res.text());
  }
  return results.filter((r) => r.url).slice(0, limit);
}
