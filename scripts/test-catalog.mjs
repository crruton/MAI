/**
 * Каталог навыков команды (ADR 0111): проверка `mai-marketplace.json` и `catalog/`,
 * установка пакета из каталога настоящим кодом MAI (ADR 0042).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCatalog, scanText, frontmatter, skillRefs, loadPolicy } from '../electron/lib/catalog-check.js';
import { readCatalog, installFromMarketplace } from '../electron/lib/marketplace.js';
import { listPackages } from '../electron/lib/packages.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  OK   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${String(extra).slice(0, 400)}`);
  }
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

console.log('[1] каталог репозитория');
const real = checkCatalog(repo);
check('нет ошибок', real.errors.length === 0, real.errors.join('\n'));
check('пакетов столько же, сколько в индексе, по навыку в каждом', real.packages === JSON.parse(fs.readFileSync(path.join(repo, 'mai-marketplace.json'), 'utf8')).packages.length && real.skills === real.packages, `${real.packages}/${real.skills}`);
for (const w of real.warnings) console.log(`  WARN ${w}`);

console.log('[2] сканер');
const policy = { denyHosts: ['corp.example.net'], allowEmails: ['*@example.com'] };
check('настоящий GitLab-токен', scanText('token: glpat-AbCdEfGhIjKlMnOpQrSt12', policy).includes('GitLab-токен'));
check('плейсхолдер glpat-xxxx пропускается', scanText('GITLAB_TOKEN=glpat-xxxxxxxxxxxx', policy).length === 0);
check('GitHub-токен', scanText(`ghp_${'a1'.repeat(18)}`, policy).includes('GitHub-токен'));
check('слово task-owned не ключ API', scanText('plus task-owned uncommitted changes and sk-...', policy).length === 0);
check('приватный ключ', scanText('-----BEGIN OPENSSH PRIVATE KEY-----', policy).includes('приватный ключ'));
check('запрещённый хост и поддомен', scanText('https://gitlab.corp.example.net/x', policy).some((p) => p.includes('corp.example.net')));
check('похожий хост не запрещён', scanText('https://notcorp.example.network', policy).length === 0);
check('чужой email', scanText('пишите ivan.petrov@corp.ru', policy).some((p) => p.startsWith('email')));
check('email из списка разрешённых', scanText('dev@example.com', policy).length === 0);
check('внутреннее название без учёта регистра', scanText('Файл в Acme-CRM-docs', { denyTerms: ['acme-crm'] }).some((p) => p.includes('acme-crm')));
check('без denyTerms названия не ищутся', scanText('Файл в Acme-CRM-docs', {}).length === 0);

check('skillRefs: падежи и регистр', skillRefs('по скиллу `pbc`, навыка `to-mr`, Навык `tdd`, слово `x`').join() === 'pbc,to-mr,tdd');
console.log('[3] frontmatter');
const fm = frontmatter('---\nname: x\ndescription: >-\n  Первая строка\n  вторая.\nversion: 1.0.0\n---\n# X');
check('многострочное description', fm.description === 'Первая строка вторая.' && fm.version === '1.0.0', JSON.stringify(fm));
check('без frontmatter — null', frontmatter('# X') === null);

console.log('[4] нарушения во временном каталоге');
function fixture(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-catalog-'));
  const pkg = path.join(dir, 'catalog', 'demo');
  fs.mkdirSync(path.join(pkg, 'skills', 'demo'), { recursive: true });
  const files = {
    'mai-marketplace.json': { name: 't', packages: [{ name: 'demo', version: '1.0.0', description: 'Демо', source: 'catalog/demo' }] },
    'catalog/catalog-policy.json': { denyHosts: ['corp.example.net'], allowEmails: [] },
    'catalog/demo/mai-package.json': { name: 'demo', version: '1.0.0', description: 'Демо', owner: 'me', license: 'MIT' },
    'catalog/demo/skills/demo/SKILL.md': '---\nname: demo\ndescription: Демо-навык.\nversion: 1.0.0\nowner: me\n---\n# Demo\n',
  };
  mutate(files);
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) continue;
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content));
  }
  const result = checkCatalog(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}
const has = (r, re) => r.errors.some((e) => re.test(e));
check('исходный пример чистый', fixture(() => {}).errors.length === 0, fixture(() => {}).errors.join('; '));
check('версия не semver', has(fixture((f) => { f['mai-marketplace.json'].packages[0].version = '1.0'; }), /не semver/));
check('версия каталога ≠ манифеста', has(fixture((f) => { f['catalog/demo/mai-package.json'].version = '1.1.0'; }), /в каталоге 1\.0\.0/));
check('нет owner в манифесте', has(fixture((f) => { delete f['catalog/demo/mai-package.json'].owner; }), /нет owner/));
check('нет license', has(fixture((f) => { delete f['catalog/demo/mai-package.json'].license; }), /нет license/));
check('навык без version', has(fixture((f) => { f['catalog/demo/skills/demo/SKILL.md'] = '---\nname: demo\ndescription: Д.\nowner: me\n---\n'; }), /version «»/));
check('version навыка ≠ пакета', has(fixture((f) => { f['catalog/demo/skills/demo/SKILL.md'] = f['catalog/demo/skills/demo/SKILL.md'].replace('version: 1.0.0', 'version: 2.0.0'); }), /≠ версии пакета/));
check('name ≠ папке', has(fixture((f) => { f['catalog/demo/skills/demo/SKILL.md'] = f['catalog/demo/skills/demo/SKILL.md'].replace('name: demo', 'name: other'); }), /name во frontmatter/));
check('UPSTREAM.md без LICENSE', has(fixture((f) => { f['catalog/demo/skills/demo/UPSTREAM.md'] = '# Upstream'; }), /нет LICENSE/));
check('source вне catalog/', has(fixture((f) => { f['mai-marketplace.json'].packages[0].source = '../x'; }), /внутри catalog/));
check('повтор пакета', has(fixture((f) => { f['mai-marketplace.json'].packages.push(f['mai-marketplace.json'].packages[0]); }), /повторяется/));
check('внутренний хост в справочнике', has(fixture((f) => { f['catalog/demo/skills/demo/references/mirrors.md'] = 'mirror: https://nexus.corp.example.net/repo'; }), /references\/mirrors\.md: внутренний хост/));
check('секрет в скрипте', has(fixture((f) => { f['catalog/demo/skills/demo/scripts/run.py'] = 'TOKEN = "glpat-AbCdEfGhIjKlMnOpQrSt12"'; }), /run\.py: GitLab-токен/));
check('ссылка на навык вне каталога — ошибка', has(fixture((f) => { f['catalog/demo/skills/demo/SKILL.md'] += 'Дальше — по навыку `mr-publish`.'; }), /ссылка на навык «mr-publish»/));
check('ссылка на себя и встроенный навык — без ошибки', fixture((f) => { f['catalog/demo/skills/demo/SKILL.md'] += 'См. скилл `demo` и навык `handoff`.'; f['skills/handoff/SKILL.md'] = '---' + String.fromCharCode(10) + 'name: handoff' + String.fromCharCode(10) + '---'; }).errors.length === 0);
const longSkill = fixture((f) => { f['catalog/demo/skills/demo/SKILL.md'] += 'x\n'.repeat(600); });
check('длинный SKILL.md — предупреждение, не ошибка', longSkill.errors.length === 0 && longSkill.warnings.some((w) => /строк/.test(w)));

console.log('[5] установка из каталога кодом MAI');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-catalog-data-'));
const market = { name: 'mai-team', url: repo };
const catalog = readCatalog(market, dataDir);
check('readCatalog видит все пакеты индекса', catalog.packages.length === real.packages && !catalog.error, catalog.error || catalog.packages.length);
let installed = null;
try {
  installed = installFromMarketplace({ market, name: 'grilling', dataDir });
} catch (e) {
  check('установка grilling', false, e.message);
}
if (installed) {
  check('установлен grilling версии из каталога', installed.package.version === catalog.packages.find((p) => p.name === 'grilling').version && installed.origin.marketplace === 'mai-team');
  const list = listPackages(null, dataDir, { includeProject: false });
  const pkg = list.find((p) => p.name === 'grilling');
  check('пакет виден в списке: 1 навык, не исполняемый', pkg && pkg.parts?.skills === 1 && pkg.executable === false, JSON.stringify(pkg));
  check('файлы навыка на месте', fs.existsSync(path.join(dataDir, 'packages', 'grilling', 'skills', 'grilling', 'LICENSE')));
}
fs.rmSync(dataDir, { recursive: true, force: true });

console.log('[9] закрытые списки — вне публичного репозитория');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = JSON.parse(fs.readFileSync(path.join(repoRoot, 'catalog', 'catalog-policy.json'), 'utf8'));
check('в публичной политике нет хостов и названий команды', pub.denyHosts.length === 0 && pub.denyTerms.length === 0);
const pdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-policy-'));
fs.mkdirSync(path.join(pdir, 'catalog'));
fs.writeFileSync(path.join(pdir, 'catalog', 'catalog-policy.json'), JSON.stringify({ denyHosts: [], allowEmails: ['*@example.com'], denyTerms: [] }));
fs.writeFileSync(path.join(pdir, 'catalog', 'catalog-policy.local.json'), JSON.stringify({ denyHosts: ['corp.example.net'], denyTerms: ['secret-project'] }));
const merged = loadPolicy(pdir, { MAI_CATALOG_DENY_HOSTS: 'intra.example.org, corp.example.net', MAI_CATALOG_DENY_TERMS: 'codename' });
check('локальный файл и переменные окружения складываются, без повторов', merged.denyHosts.join() === 'corp.example.net,intra.example.org' && merged.denyTerms.join() === 'secret-project,codename' && merged.allowEmails.join() === '*@example.com', JSON.stringify(merged));
check('без локального файла и переменных — только общие правила', loadPolicy(path.join(pdir, 'нет'), {}).denyHosts.length === 0);
fs.rmSync(pdir, { recursive: true, force: true });
const prevHosts = process.env.MAI_CATALOG_DENY_HOSTS;
process.env.MAI_CATALOG_DENY_HOSTS = 'intra.example.org';
const leak = fixture((files) => { files['catalog/demo/skills/demo/SKILL.md'] += 'Сервер: build.intra.example.org\n'; });
if (prevHosts === undefined) delete process.env.MAI_CATALOG_DENY_HOSTS; else process.env.MAI_CATALOG_DENY_HOSTS = prevHosts;
check('хост из переменной окружения ловится проверкой каталога', leak.errors.some((e) => /intra\.example\.org/.test(e)), leak.errors.join('; '));

console.log(`\ncatalog: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
