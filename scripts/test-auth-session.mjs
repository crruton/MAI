/**
 * Сессия Keycloak и корпоративный режим (F21, ADR 0093): сроки токенов,
 * refresh, роли из токена и матрица IPC с гейтом входа (Q2).
 */
import { corporatePolicy, tokenState, stampTokens, refreshTokens, identityFromToken, sessionGate, LOGIN_CHANNELS } from '../electron/lib/auth-session.js';
import { IPC_PERMISSIONS, guardIpc } from '../electron/lib/ipc-permissions.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  OK   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${String(extra).slice(0, 300)}`);
  }
}
const jwt = (payload) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;

console.log('[1] политика организации');
check('нет блока — локальный режим', corporatePolicy({}).required === false && corporatePolicy(null).required === false);
check('required: true — обязательный вход, issuer без «/»', JSON.stringify(corporatePolicy({ auth: { required: true, issuer: 'https://sso/realms/mai/' } })) === JSON.stringify({ required: true, issuer: 'https://sso/realms/mai', clientId: 'mai-code-desktop' }));
check('required не true — не включается', corporatePolicy({ auth: { required: 'yes', issuer: 'x' } }).required === false);

console.log('[2] сроки токенов');
const t0 = 1_000_000;
const tok = stampTokens({ access_token: 'a', refresh_token: 'r', expires_in: 300, refresh_expires_in: 1800 }, t0);
check('нет токенов — none', tokenState(null) === 'none' && tokenState({}) === 'none');
check('свежий — valid', tokenState(tok, t0 + 60_000) === 'valid');
check('за 30 с до конца access — уже refreshable', tokenState(tok, t0 + 275_000) === 'refreshable');
check('access истёк, refresh жив — refreshable', tokenState(tok, t0 + 600_000) === 'refreshable');
check('истёк и refresh — expired', tokenState(tok, t0 + 1_900_000) === 'expired');
check('без refresh_token после access — expired', tokenState(stampTokens({ access_token: 'a', expires_in: 60 }, t0), t0 + 120_000) === 'expired');
check('offline-токен (refresh_expires_in 0) — refreshable всегда', tokenState({ ...tok, refresh_expires_in: 0 }, t0 + 1e10) === 'refreshable');
check('старые токены без отметки — refreshable (проверить)', tokenState({ access_token: 'a', refresh_token: 'r' }) === 'refreshable');

console.log('[3] refresh');
const posts = [];
const post = async (url, params) => {
  posts.push({ url, params });
  return { access_token: 'a2', expires_in: 300, refresh_expires_in: 1800 };
};
const next = await refreshTokens({ issuer: 'https://sso/realms/mai', clientId: 'mai', tokens: tok, post, now: () => t0 + 500_000 });
check('grant refresh_token на /token с client_id', posts[0].url === 'https://sso/realms/mai/protocol/openid-connect/token' && posts[0].params.grant_type === 'refresh_token' && posts[0].params.refresh_token === 'r' && posts[0].params.client_id === 'mai');
check('новый access, прежний refresh сохранён, новая отметка', next.access_token === 'a2' && next.refresh_token === 'r' && next.obtained_at === t0 + 500_000 && tokenState(next, t0 + 560_000) === 'valid');
let err = null;
await refreshTokens({ issuer: 'x', clientId: 'c', tokens: { access_token: 'a' }, post }).catch((e) => (err = e));
check('без refresh_token — ошибка no_refresh', err?.code === 'no_refresh');

console.log('[4] роли из токена');
check('admin в realm', identityFromToken(jwt({ realm_access: { roles: ['admin'] }, preferred_username: 'ivan' }), 'mai').role === 'admin');
check('admin в клиенте', identityFromToken(jwt({ resource_access: { mai: { roles: ['admin'] } } }), 'mai').role === 'admin');
check('admin другого клиента — guest', identityFromToken(jwt({ resource_access: { other: { roles: ['admin'] } } }), 'mai').role === 'guest');
const who = identityFromToken(jwt({ name: 'Иван', email: 'i@x', sub: 's1' }), 'mai');
check('пользователь: имя, почта, sub', who.user.name === 'Иван' && who.user.email === 'i@x' && who.user.sub === 's1');
check('битый токен — guest', identityFromToken('nope', 'mai').role === 'guest');

console.log('[5] матрица IPC с гейтом входа (Q2)');
const handlers = new Map();
const fakeIpc = { handle: (ch, fn) => handlers.set(ch, fn) };
let session = { required: true, loggedIn: false, role: 'none' };
guardIpc(fakeIpc, () => {
  if (session.role !== 'admin') throw new Error('Недостаточно прав');
}, { sessionGate: (ch) => sessionGate(ch, session) });
for (const ch of Object.keys(IPC_PERMISSIONS)) fakeIpc.handle(ch, () => 'ran');
const call = (ch) => handlers.get(ch)({}, ...(ch === 'auth:setRole' ? ['admin'] : []));
// Прошёл гейт и роль: обработчик или проверка схемы данных (аргументов в тесте нет).
const passed = (v) => v === 'ran' || v?.invalid === true;
const results = () => Object.keys(IPC_PERMISSIONS).map((ch) => [ch, call(ch)]);
let r = results();
const openNoLogin = r.filter(([, v]) => passed(v)).map(([ch]) => ch).sort();
check('без входа открыты только каналы экрана входа', openNoLogin.join() === [...LOGIN_CHANNELS].filter((c) => IPC_PERMISSIONS[c]).sort().join(), openNoLogin.join());
check('отказ без входа — needsLogin', r.filter(([, v]) => !passed(v)).every(([, v]) => v?.needsLogin === true && /Нужен вход/.test(v.error)));
session = { required: true, loggedIn: true, role: 'guest' };
r = results();
const guestOpen = r.filter(([, v]) => passed(v)).map(([ch]) => ch);
check('guest: открыты ровно не-admin каналы', guestOpen.length === Object.values(IPC_PERMISSIONS).filter((p) => p !== 'admin').length && guestOpen.every((ch) => IPC_PERMISSIONS[ch] !== 'admin'), guestOpen.length);
check('guest: admin-каналы — forbidden без needsLogin', r.filter(([ch]) => IPC_PERMISSIONS[ch] === 'admin').every(([, v]) => v?.forbidden && !v.needsLogin));
session = { required: true, loggedIn: true, role: 'admin' };
check('admin: открыто всё', results().every(([, v]) => passed(v)));
session = { required: false, loggedIn: false, role: 'admin' };
check('без корпоративного режима гейта нет (локальный admin)', results().every(([, v]) => passed(v)));

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
