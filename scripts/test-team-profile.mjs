/**
 * Профиль команды (E2.2, ADR 0118): источник, проверка, чтение, git-обновление, слияние каталогов.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { profileSource, profileDir, refreshProfile, readProfile, validateProfile, mergeMarketplaces, profileCacheDir, PROFILE_FILE } from '../electron/lib/team-profile.js';

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
const GOOD = {
  name: 'acme-team',
  marketplaces: [{ name: 'mai-team', url: 'https://github.com/acme/catalog.git' }],
  mcpServers: { docs: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: '${DOCS_TOKEN}' } }, fs: { command: 'npx', args: ['-y', 'server-fs'] } },
  agents: 'AGENTS.md',
  multica: { workspaceId: 'ws-team' },
};
const clone = (v) => JSON.parse(JSON.stringify(v));

console.log('[1] источник профиля');
check('не настроен — null', profileSource({}) === null);
let s = profileSource({ managed: { teamProfile: { url: 'https://github.com/acme/profile.git', ref: 'main' } }, settings: { teamProfile: 'C:/other' } });
check('организация сильнее пользователя; git и ref', s.from === 'managed' && s.git && s.ref === 'main' && s.url.endsWith('profile.git'));
s = profileSource({ settings: { teamProfile: 'C:/team/profile' } });
check('строка-путь из настроек — локальная папка', s.from === 'settings' && !s.git && s.ref === '');
let err = '';
try {
  profileSource({ settings: { teamProfile: { url: 'https://x/y.git', ref: '--upload-pack=evil' } } });
} catch (e) {
  err = e.message;
}
check('ref с опцией git — ошибка', /ref: недопустимое/.test(err));

console.log('[2] проверка профиля');
check('хороший профиль', validateProfile(GOOD).length === 0, validateProfile(GOOD).join('; '));
const bad = (mutate, re, label) => {
  const p = clone(GOOD);
  mutate(p);
  const errors = validateProfile(p);
  check(label, errors.some((e) => re.test(e)), errors.join('; '));
};
bad((p) => { p.mcpServers.docs.headers.Authorization = 'Bearer abc123'; }, /только \$\{ПЕРЕМЕННАЯ\}/, 'токен в заголовке MCP');
bad((p) => { p.mcpServers.fs.env = { GITHUB_TOKEN: 'ghp_' + 'a1'.repeat(18) }; }, /только \$\{ПЕРЕМЕННАЯ\}|секрет/, 'секрет в env MCP');
bad((p) => { p.description = 'ключ sk-' + 'x'.repeat(40); }, /похоже на секрет/, 'ключ API где угодно в профиле');
bad((p) => { p.mcpServers.empty = {}; }, /нужен command или url/, 'MCP без command и url');
bad((p) => { p.marketplaces[0].url = 'file:///etc'; }, /git-адрес/, 'каталог не по git-адресу');
bad((p) => { p.multica.url = 'http://x'; }, /только workspaceId/, 'в multica лишние поля');
bad((p) => { p.multica.workspaceId = '--x'; }, /workspaceId/, 'workspaceId-флаг');
bad((p) => { p.agents = '../secret.md'; }, /agents/, 'agents вне .md-пути');
bad((p) => { p.name = 'Команда!'; }, /name/, 'неверное имя');

console.log('[3] чтение из папки');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-team-'));
check('нет файла — ошибка, профиль пуст', !readProfile(dir).ok && /нет файла/.test(readProfile(dir).errors[0]) && Object.keys(readProfile(dir).mcpServers).length === 0);
fs.writeFileSync(path.join(dir, PROFILE_FILE), JSON.stringify(GOOD));
fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Команда\nПиши тесты первым.');
let prof = readProfile(dir);
check('профиль прочитан с AGENTS.md', prof.ok && prof.agents.includes('Пиши тесты') && prof.multica.workspaceId === 'ws-team' && prof.marketplaces.length === 1);
fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'token: glpat-AbCdEfGhIjKlMnOpQrSt12');
prof = readProfile(dir);
check('секрет в AGENTS.md — профиль не применяется целиком', !prof.ok && Object.keys(prof.mcpServers).length === 0 && /секрет/.test(prof.errors.join()));
fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# ok');
fs.writeFileSync(path.join(dir, PROFILE_FILE), '{ битый json');
check('битый JSON — ошибка', !readProfile(dir).ok && /не JSON/.test(readProfile(dir).errors[0]));
fs.writeFileSync(path.join(dir, PROFILE_FILE), JSON.stringify(GOOD));
check('пустой адрес — «не настроен»', readProfile('').errors[0] === 'профиль не настроен');

console.log('[4] обновление из git');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-team-data-'));
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
git(dir, ['init', '-q']);
git(dir, ['config', 'user.name', 'T']);
git(dir, ['config', 'user.email', 't@example.com']);
git(dir, ['add', '.']);
git(dir, ['commit', '-q', '-m', 'profile']);
const src = { url: dir, ref: '', git: true, from: 'managed' };
let r = refreshProfile(src, data);
check('клон в кэш', r.ok && fs.existsSync(path.join(profileCacheDir(data), PROFILE_FILE)), r.error);
check('кэш читается как профиль', readProfile(profileDir(src, data)).ok);
r = refreshProfile({ ...src, url: path.join(dir, 'нет-такого') }, data);
check('ошибка клона не стирает прежний кэш', !r.ok && /git clone/.test(r.error) && readProfile(profileDir(src, data)).ok);
check('нет временных папок', !fs.readdirSync(data).some((n) => n.includes('.tmp')));
check('локальная папка — без клона', refreshProfile({ url: dir, git: false }, data).ok && profileDir({ url: dir, git: false }, data) === path.resolve(dir));
check('не настроен — понятная ошибка', refreshProfile(null, data).ok === false);

console.log('[5] слияние каталогов');
const merged = mergeMarketplaces([{ name: 'mai-team', url: 'https://mine/x.git' }], [{ name: 'mai-team', url: 'https://team/x.git' }, { name: 'devops', url: 'https://team/d.git' }]);
check('личный каталог сильнее профиля, остальные добавлены с source=team', merged.length === 2 && merged[0].url === 'https://mine/x.git' && merged[1].name === 'devops' && merged[1].source === 'team');

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(data, { recursive: true, force: true });
console.log(`\nteam-profile: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
