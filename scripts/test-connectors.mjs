/**
 * Каталог коннекторов и токены MCP (CW3.1, ADR 0052).
 */
import { listConnectors, connectorServerConfig, BUILTIN_CONNECTORS } from '../electron/lib/connectors.js';
import { createSecretBox, sealSettings, openSettings, plaintextSecrets } from '../electron/lib/secrets.js';

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

console.log('[1] каталог');
const all = listConnectors();
check('встроенные — только HTTPS и с документацией', all.length === BUILTIN_CONNECTORS.length && all.every((c) => c.url.startsWith('https://') && c.docs.startsWith('https://')));
check('Linear — OAuth, GitHub — токен', all.find((c) => c.id === 'linear').auth === 'oauth' && all.find((c) => c.id === 'github').auth === 'token');
const org = listConnectors({
  managed: [
    { id: 'linear', name: 'Linear (наш прокси)', url: 'https://mcp.corp.example/linear', auth: 'oauth' },
    { id: '1c', name: '1С', url: 'https://1c.corp.example/mcp', auth: 'token', tokenHeader: 'X-Api-Key', tokenPrefix: '' },
    { id: 'bad', url: 'http://insecure.example/mcp' },
    { id: 'Плохой id', url: 'https://x' },
  ],
});
check('организация переопределяет встроенный', org.find((c) => c.id === 'linear').url === 'https://mcp.corp.example/linear' && org.find((c) => c.id === 'linear').source === 'managed');
check('свой коннектор организации', org.find((c) => c.id === '1c')?.tokenHeader === 'X-Api-Key');
check('http и неверный id отброшены', !org.some((c) => c.id === 'bad') && org.every((c) => /^[a-z0-9]/.test(c.id)));
check('только коннекторы организации', listConnectors({ managed: [{ id: '1c', url: 'https://1c.corp.example/mcp' }], onlyManaged: true }).map((c) => c.id).join() === '1c');

console.log('[2] запись в mcpServers');
check('OAuth — только url', JSON.stringify(connectorServerConfig(all.find((c) => c.id === 'linear'))) === JSON.stringify({ url: 'https://mcp.linear.app/mcp', connector: 'linear' }));
const gh = connectorServerConfig(all.find((c) => c.id === 'github'), { token: '  ghp_abc  ' });
check('токен — заголовок Bearer, OAuth выключен', gh.headers.Authorization === 'Bearer ghp_abc' && gh.oauth === false);
check('свой заголовок без префикса', connectorServerConfig(org.find((c) => c.id === '1c'), { token: 'k1' }).headers['X-Api-Key'] === 'k1');
let error = '';
try {
  connectorServerConfig(all.find((c) => c.id === 'github'), { token: '' });
} catch (e) {
  error = e.message;
}
check('без токена — ошибка', /нужен токен/.test(error));
error = '';
try {
  connectorServerConfig(all.find((c) => c.id === 'github'), { token: 'a\r\nX-Evil: 1' });
} catch (e) {
  error = e.message;
}
check('перевод строки в токене — ошибка (подмена заголовков)', /перевод строки/.test(error));

console.log('[3] токены MCP шифруются в settings.json');
const box = createSecretBox({ available: () => true, encrypt: (t) => Buffer.from(`X${t}`), decrypt: (b) => b.toString().slice(1) });
const settings = { mcpServers: { github: { url: 'https://x', headers: { Authorization: 'Bearer ghp_secret' } }, local: { command: 'node', env: { API_TOKEN: 'tok', MODE: 'prod' } } } };
check('незашифрованные токены MCP видны как открытые', plaintextSecrets(settings).length === 3, JSON.stringify(plaintextSecrets(settings)));
const sealed = sealSettings(settings, box);
check('на диске — зашифровано', !JSON.stringify(sealed).includes('ghp_secret') && !JSON.stringify(sealed).includes('"tok"') && sealed.mcpServers.github.headers.Authorization.startsWith('enc:v1:'));
check('url и command не тронуты', sealed.mcpServers.github.url === 'https://x' && sealed.mcpServers.local.command === 'node');
const opened = openSettings(sealed, box);
check('при чтении — расшифровано', (opened.settings || opened).mcpServers.github.headers.Authorization === 'Bearer ghp_secret');

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
