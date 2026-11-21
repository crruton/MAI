/**
 * Маркетплейс пакетов (CC10.2, ADR 0042).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { compareVersions, readCatalog, listMarketplaces, refreshMarketplace, installFromMarketplace, normalizeMarketplace, isGitSource } from '../electron/lib/marketplace.js';
import { listPackages } from '../electron/lib/packages.js';

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
const err = (fn) => {
  try {
    fn();
    return '';
  } catch (e) {
    return e.message;
  }
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-market-'));
const data = path.join(tmp, 'data');
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const pkg = (dir, name, version, extra = {}) => {
  write(path.join(dir, 'mai-package.json'), JSON.stringify({ name, version, description: `пакет ${name}` }));
  write(path.join(dir, 'commands', 'hello.md'), `Привет из ${name} ${version}`);
  if (extra.hooks) write(path.join(dir, 'hooks.json'), '{}');
};

console.log('[1] версии');
check('1.10.0 > 1.9.2', compareVersions('1.10.0', '1.9.2') === 1);
check('v1.2 = 1.2.0', compareVersions('v1.2', '1.2.0') === 0);
check('релиз > beta', compareVersions('2.0.0', '2.0.0-beta') === 1 && compareVersions('2.0.0-alpha', '2.0.0-beta') === -1);
check('git-источник', isGitSource('https://x/y.git') && isGitSource('git@h:a/b') && !isGitSource('C:\\cat'));

console.log('[2] локальный каталог');
const local = path.join(tmp, 'catalog');
pkg(path.join(local, 'packages', 'review-kit'), 'review-kit', '1.2.0', { hooks: true });
pkg(path.join(local, 'packages', 'liar'), 'other-name', '1.0.0');
pkg(path.join(local, 'packages', 'old'), 'old-kit', '0.9.0');
write(path.join(tmp, 'outside', 'mai-package.json'), JSON.stringify({ name: 'outside', version: '1.0.0' }));
write(
  path.join(local, 'mai-marketplace.json'),
  JSON.stringify({
    name: 'team',
    description: 'Пакеты команды',
    packages: [
      { name: 'review-kit', version: '1.2.0', description: 'Ревью', source: 'packages/review-kit' },
      { name: 'review-kit', version: '9.9.9', source: 'packages/review-kit' },
      { name: 'liar', version: '1.0.0', source: 'packages/liar' },
      { name: 'old-kit', version: '1.0.0', source: 'packages/old' },
      { name: 'escape', version: '1.0.0', source: '../outside' },
      { name: 'bad name!', source: 'packages/review-kit' },
    ],
  }),
);
const team = normalizeMarketplace({ url: local, name: 'Team' });
check('имя каталога нормализовано', team.name === 'team');
check('пустой адрес — ошибка', /Не указан/.test(err(() => normalizeMarketplace({ url: ' ' }))));
const catalog = readCatalog(team, data);
const names = catalog.packages.map((p) => p.name);
check('каталог прочитан', catalog.description === 'Пакеты команды' && names.includes('review-kit'));
check('дубль имени отброшен', names.filter((n) => n === 'review-kit').length === 1 && catalog.packages[0].version === '1.2.0');
check('выход из каталога (..) отброшен', !names.includes('escape'));
check('неверное имя отброшено', !names.includes('bad name!'));

console.log('[3] установка и обновление');
const first = installFromMarketplace({ market: team, name: 'review-kit', dataDir: data });
check('пакет установлен из каталога', first.package.name === 'review-kit' && first.package.version === '1.2.0' && first.origin.marketplace === 'team');
check('файлы на месте', fs.existsSync(path.join(data, 'packages', 'review-kit', 'commands', 'hello.md')));
check('подмена имени — отказ', /обещал «liar»/.test(err(() => installFromMarketplace({ market: team, name: 'liar', dataDir: data }))));
check('несовпадение версии — отказ', /версия 0\.9\.0/.test(err(() => installFromMarketplace({ market: team, name: 'old-kit', dataDir: data }))));
check('нет в каталоге — ошибка', /нет пакета/.test(err(() => installFromMarketplace({ market: team, name: 'nope', dataDir: data }))));
check('повторная установка без replace — отказ', /уже установлен/.test(err(() => installFromMarketplace({ market: team, name: 'review-kit', dataDir: data }))));
// Новая версия в каталоге.
pkg(path.join(local, 'packages', 'review-kit'), 'review-kit', '1.3.0', { hooks: true });
const raw = JSON.parse(fs.readFileSync(path.join(local, 'mai-marketplace.json'), 'utf8'));
raw.packages[0].version = '1.3.0';
fs.writeFileSync(path.join(local, 'mai-marketplace.json'), JSON.stringify(raw));
let view = listMarketplaces([team], data, listPackages('', data, { includeProject: false }));
const entry = view[0].packages.find((p) => p.name === 'review-kit');
check('видно обновление', entry.installedVersion === '1.2.0' && entry.updateAvailable === true, JSON.stringify(entry));
check('неустановленный — без версии', view[0].packages.find((p) => p.name === 'liar').installedVersion === null);
installFromMarketplace({ market: team, name: 'review-kit', dataDir: data, replace: true });
view = listMarketplaces([team], data, listPackages('', data, { includeProject: false }));
check('после обновления — актуален', view[0].packages.find((p) => p.name === 'review-kit').updateAvailable === false);
check('файл новой версии', /1\.3\.0/.test(fs.readFileSync(path.join(data, 'packages', 'review-kit', 'commands', 'hello.md'), 'utf8')));

console.log('[4] каталог из git');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
const repo = path.join(tmp, 'repo');
pkg(path.join(repo, 'packages', 'git-kit'), 'git-kit', '0.3.0');
write(path.join(repo, 'mai-marketplace.json'), JSON.stringify({ packages: [{ name: 'git-kit', version: '0.3.0', source: 'packages/git-kit' }] }));
git(repo, 'init', '-q', '-b', 'main');
git(repo, 'add', '.');
git(repo, 'commit', '-qm', 'init');
const bare = path.join(tmp, 'remote.git');
git(tmp, 'clone', '-q', '--bare', repo, bare);
const gitMarket = normalizeMarketplace({ url: bare });
check('путь *.git — каталог из git, имя из адреса', isGitSource(gitMarket.url) && gitMarket.name === 'remote');
check('до обновления — нет каталога', /обновите каталог/.test(readCatalog(gitMarket, data).error));
refreshMarketplace(gitMarket, data);
check('каталог скачан в кеш', fs.existsSync(path.join(data, 'marketplaces', 'remote', 'mai-marketplace.json')));
const fromGit = installFromMarketplace({ market: gitMarket, name: 'git-kit', dataDir: data });
check('установка из git-каталога', fromGit.package.version === '0.3.0');
// Новая версия в репозитории — видна после «Обновить каталоги».
pkg(path.join(repo, 'packages', 'git-kit'), 'git-kit', '0.4.0');
write(path.join(repo, 'mai-marketplace.json'), JSON.stringify({ packages: [{ name: 'git-kit', version: '0.4.0', source: 'packages/git-kit' }] }));
git(repo, 'commit', '-qam', 'v0.4.0');
git(repo, 'push', '-q', bare, 'main');
check('до обновления каталога — старая версия', readCatalog(gitMarket, data).packages[0].version === '0.3.0');
refreshMarketplace(gitMarket, data);
const fresh = listMarketplaces([gitMarket], data, listPackages('', data, { includeProject: false }))[0].packages[0];
check('после обновления каталога — доступно 0.4.0', fresh.version === '0.4.0' && fresh.updateAvailable, JSON.stringify(fresh));
check('временных папок кеша нет', fs.readdirSync(path.join(data, 'marketplaces')).every((n) => !n.endsWith('.tmp')));
check('неверный git-адрес — понятная ошибка', /git clone не удался/.test(err(() => refreshMarketplace({ name: 'bad', url: path.join(tmp, 'nope.git') }, data))));
check('кеш не испорчен неудачным обновлением', fs.existsSync(path.join(data, 'marketplaces', 'remote', 'mai-marketplace.json')));

console.log('[5] пакет с git-источником и ref');
const pkgRepo = path.join(tmp, 'pkgrepo');
pkg(pkgRepo, 'tagged', '2.0.0');
git(pkgRepo, 'init', '-q', '-b', 'main');
git(pkgRepo, 'add', '.');
git(pkgRepo, 'commit', '-qm', 'v2');
git(pkgRepo, 'tag', 'v2.0.0');
pkg(pkgRepo, 'tagged', '3.0.0-dev');
git(pkgRepo, 'commit', '-qam', 'dev');
const pkgBare = path.join(tmp, 'tagged.git');
git(tmp, 'clone', '-q', '--bare', pkgRepo, pkgBare);
const refCat = path.join(tmp, 'refcat');
write(path.join(refCat, 'mai-marketplace.json'), JSON.stringify({ packages: [{ name: 'tagged', version: '2.0.0', source: pkgBare, ref: 'v2.0.0' }, { name: 'badref', source: pkgBare, ref: '--upload-pack=x' }] }));
const tagged = installFromMarketplace({ market: { name: 'refcat', url: refCat }, name: 'tagged', dataDir: data });
check('ставится тег, а не голова ветки', tagged.package.version === '2.0.0');
check('ref с опцией git — отказ', /Неверная ссылка/.test(err(() => installFromMarketplace({ market: { name: 'refcat', url: refCat }, name: 'badref', dataDir: data }))));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
