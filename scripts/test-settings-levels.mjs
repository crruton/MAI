/**
 * Уровни настроек и управляемые настройки организации (CC2.4, ADR 0038).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LEVELS,
  managedSettingsPath,
  readManaged,
  projectSettingsFiles,
  readProjectLevels,
  mergeLevels,
  updateLocalRules,
} from '../electron/lib/settings-levels.js';
import { evaluate, classifyTool } from '../electron/lib/policy.js';
import { collectHooks } from '../electron/lib/hooks.js';

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-levels-'));
const project = path.join(tmp, 'proj');
fs.mkdirSync(path.join(project, '.mai-code'), { recursive: true });

console.log('[1] путь управляемых настроек');
check('уровни по порядку', LEVELS.join(',') === 'managed,user,project,local,session');
check('переменная окружения', managedSettingsPath({ env: { MAI_MANAGED_SETTINGS: '/x/m.json' } }) === '/x/m.json');
check('Windows — ProgramData', managedSettingsPath({ platform: 'win32', env: { ProgramData: 'D:\\PD' } }).endsWith(path.join('mai-code', 'managed-settings.json')));
check('macOS', managedSettingsPath({ platform: 'darwin', env: {} }) === '/Library/Application Support/mai-code/managed-settings.json');
check('Linux', managedSettingsPath({ platform: 'linux', env: {} }) === '/etc/mai-code/managed-settings.json');

console.log('[2] чтение файла организации');
const managedFile = path.join(tmp, 'managed.json');
check('файла нет — пусто', readManaged(managedFile).present === false && readManaged(managedFile).permissions.deny.length === 0);
fs.writeFileSync(managedFile, '{ битый');
check('битый файл — пусто, без исключения', readManaged(managedFile).present === false);
fs.writeFileSync(
  managedFile,
  JSON.stringify({
    disableBypassMode: true,
    permissions: { deny: ['run_shell(curl *)', 'run_shell(curl *)', 42, ' '], allow: ['run_shell(npm test)'] },
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo org' }] }] },
  }),
);
const org = readManaged(managedFile);
check('файл есть', org.present);
check('запрет «Без вопросов»', org.disableBypassMode === true);
check('мусор и дубли отброшены', org.permissions.deny.length === 1 && org.permissions.deny[0] === 'run_shell(curl *)');
check('хуки прочитаны', Boolean(org.hooks?.PreToolUse));
fs.writeFileSync(managedFile, JSON.stringify({ permissions: { disableBypassMode: true } }));
check('запрет и внутри permissions', readManaged(managedFile).disableBypassMode === true);

console.log('[3] правила проекта и локальные');
const files = projectSettingsFiles(project);
fs.writeFileSync(files.project, JSON.stringify({ permissions: { allow: ['run_shell(npm run lint)'], ask: ['write_file(package.json)'] } }));
fs.writeFileSync(files.local, JSON.stringify({ permissions: { allow: ['run_shell(make)'] }, other: 1 }));
check('без доверия — пусто', readProjectLevels(project, { trusted: false }).project.allow.length === 0);
const levels = readProjectLevels(project, { trusted: true });
check('проект прочитан', levels.project.allow[0] === 'run_shell(npm run lint)' && levels.project.ask[0] === 'write_file(package.json)');
check('локальные прочитаны', levels.local.allow[0] === 'run_shell(make)');
check('нет папки — пусто', readProjectLevels('', { trusted: true }).local.allow.length === 0);

console.log('[4] объединение уровней и происхождение');
const merged = mergeLevels([
  { level: 'managed', rules: { deny: ['run_shell(curl *)'] } },
  { level: 'user', rules: { allow: ['run_shell(curl *)', 'run_shell(make)'] } },
  { level: 'project', rules: levels.project },
  { level: 'local', rules: levels.local },
  { level: 'session', rules: { allow: ['run_shell(git status)'] } },
]);
check('allow без дублей', merged.rules.allow.filter((r) => r === 'run_shell(make)').length === 1);
check('происхождение make — user и local', merged.origin['allow:run_shell(make)'].join(',') === 'user,local');
check('происхождение deny — managed', merged.origin['deny:run_shell(curl *)'][0] === 'managed');
const decide = (command) => evaluate({ tool: 'run_shell', cls: classifyTool('run_shell'), subject: command, mode: 'manual', rules: merged.rules, role: 'admin' });
check('deny организации сильнее allow пользователя', decide('curl https://x').action === 'deny');
check('allow проекта работает', decide('npm run lint').action === 'allow');
check('allow чата работает', decide('git status').action === 'allow');
check('прочее — спросить', decide('rm -rf build').action === 'ask');
const bypass = evaluate({ tool: 'run_shell', cls: 'exec', subject: 'curl x', mode: 'bypass', rules: merged.rules, role: 'admin' });
check('deny организации действует и в «Без вопросов»', bypass.action === 'deny');

console.log('[5] запись локальных правил');
const after = updateLocalRules(project, { kind: 'allow', add: ['run_shell(npm test)', 'run_shell(make)'] });
check('добавлено без дублей', after.allow.join(',') === 'run_shell(make),run_shell(npm test)');
const saved = JSON.parse(fs.readFileSync(files.local, 'utf8'));
check('другие поля файла сохранены', saved.other === 1);
updateLocalRules(project, { remove: ['run_shell(make)'] });
check('удалено', readProjectLevels(project, { trusted: true }).local.allow.join(',') === 'run_shell(npm test)');
check('проектный файл не тронут', JSON.parse(fs.readFileSync(files.project, 'utf8')).permissions.allow[0] === 'run_shell(npm run lint)');
let error = '';
try {
  updateLocalRules(project, { kind: 'bogus', add: ['x'] });
} catch (e) {
  error = e.message;
}
check('неизвестный вид — ошибка', /Неизвестный/.test(error));
const fresh = path.join(tmp, 'fresh');
updateLocalRules(fresh, { kind: 'deny', add: ['run_shell(rm *)'] });
check('создаёт .mai-code при необходимости', fs.existsSync(projectSettingsFiles(fresh).local));
check('временных файлов не осталось', fs.readdirSync(path.join(fresh, '.mai-code')).filter((f) => f.endsWith('.tmp')).length === 0);
check('settings.local.json в .gitignore', fs.readFileSync(path.join(fresh, '.mai-code', '.gitignore'), 'utf8') === 'settings.local.json\n');
updateLocalRules(fresh, { kind: 'deny', add: ['run_shell(rm -rf *)'] });
check('строка в .gitignore не дублируется', fs.readFileSync(path.join(fresh, '.mai-code', '.gitignore'), 'utf8') === 'settings.local.json\n');

console.log('[6] хуки организации');
const hooks = collectHooks({ settingsHooks: {}, projectDir: project, trusted: false, packageHooks: [{ source: 'managed', config: org.hooks }] });
const pre = (hooks.PreToolUse || hooks.preToolUse || []).flat ? JSON.stringify(hooks) : '';
check('хук организации собран', pre.includes('echo org') && pre.includes('managed'), pre.slice(0, 200));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
