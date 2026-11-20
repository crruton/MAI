/**
 * Пакеты плагинов (ADR 0037).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { readPackage, listPackages, packageDirs, packageHooks, packageMcpServers, installPackage, uninstallPackage } from '../electron/lib/packages.js';
import { listCustomCommands } from '../electron/lib/commands.js';
import { listAgentDefs } from '../electron/lib/agent-defs.js';
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
const err = (fn) => {
  try {
    fn();
    return '';
  } catch (e) {
    return e.message;
  }
};
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-pkg-'));
const data = path.join(root, 'data');
const project = path.join(root, 'project');
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
};
// Исходник пакета.
const src = path.join(root, 'src-pkg');
write(path.join(src, 'mai-package.json'), JSON.stringify({ name: 'review-kit', version: '1.2.0', description: 'Ревью кода' }));
write(path.join(src, 'commands', 'review.md'), '---\ndescription: Ревью из пакета\n---\nРевью $ARGUMENTS');
write(path.join(src, 'commands', 'lint.md'), 'Запусти линтер');
write(path.join(src, 'agents', 'reviewer.md'), '---\ndescription: Ревьюер из пакета\ntools: read_file\n---\nИщи ошибки.');
write(path.join(src, 'skills', 'review', 'SKILL.md'), '---\nname: review\n---\nНавык');
write(path.join(src, 'plugins', 'p.js'), 'export default {}');
write(path.join(src, 'hooks.json'), JSON.stringify({ Stop: [{ hooks: [{ command: 'npm test' }] }] }));
write(path.join(src, 'mcp.json'), JSON.stringify({ mcpServers: { lint: { command: 'node', args: ['server.js'] } } }));
write(path.join(src, '.git', 'HEAD'), 'ref');
write(path.join(src, 'node_modules', 'x', 'index.js'), '');

console.log('\n[1] Манифест и содержимое');
const pkg = readPackage(src, 'global');
check('имя, версия, описание', pkg?.name === 'review-kit' && pkg.version === '1.2.0' && pkg.description === 'Ревью кода');
check('части посчитаны', JSON.stringify(pkg.parts) === JSON.stringify({ commands: 2, agents: 1, skills: 1, plugins: 1, hooks: true, mcp: 1 }), JSON.stringify(pkg.parts));
check('исполняемый код помечен', pkg.executable === true);
write(path.join(root, 'bad', 'mai-package.json'), JSON.stringify({ name: '../evil' }));
check('имя с ../ — не пакет', readPackage(path.join(root, 'bad'), 'global') === null);
check('без манифеста — не пакет', readPackage(path.join(root, 'project'), 'global') === null);

console.log('\n[2] Установка из папки');
const installed = installPackage({ from: src, dataDir: data });
const target = path.join(data, 'packages', 'review-kit');
check('скопирован в packages/<имя>', installed.name === 'review-kit' && fs.existsSync(path.join(target, 'commands', 'review.md')));
check('.git и node_modules не копируются', !fs.existsSync(path.join(target, '.git')) && !fs.existsSync(path.join(target, 'node_modules')));
check('повторная установка без replace — ошибка', /уже установлен/.test(err(() => installPackage({ from: src, dataDir: data }))));
check('с replace — заменяется', installPackage({ from: src, dataDir: data, replace: true }).name === 'review-kit');
check('нет манифеста — понятная ошибка', /mai-package\.json/.test(err(() => installPackage({ from: path.join(root, 'project'), dataDir: data }))));

console.log('\n[3] Установка из git');
let gitOk = true;
try {
  execSync('git --version', { stdio: 'ignore' });
} catch {
  gitOk = false;
}
if (gitOk) {
  const repo = path.join(root, 'remote-pkg');
  write(path.join(repo, 'mai-package.json'), JSON.stringify({ name: 'git-kit', version: '0.1.0' }));
  write(path.join(repo, 'commands', 'deploy.md'), 'Задеплой');
  const g = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  g('git init -q', repo);
  g('git add -A', repo);
  g('git commit -qm init', repo);
  g(`git clone -q --bare "${repo}" "${repo}.git"`, root);
  const fromGit = installPackage({ from: `${repo}.git`, dataDir: data });
  check('пакет из git установлен', fromGit?.name === 'git-kit' && fs.existsSync(path.join(data, 'packages', 'git-kit', 'commands', 'deploy.md')));
  check('из git не копируется .git', !fs.existsSync(path.join(data, 'packages', 'git-kit', '.git')));
  check('неверный git-URL — ошибка, не падение', /git clone/.test(err(() => installPackage({ from: path.join(root, 'nope.git'), dataDir: data }))));
} else {
  console.log('  (git не найден — раздел пропущен)');
}

console.log('\n[4] Список: приоритет, доверие, выключение');
const projPkg = path.join(project, '.mai-code', 'packages', 'review-kit');
write(path.join(projPkg, 'mai-package.json'), JSON.stringify({ name: 'review-kit', version: '9.9.9' }));
let list = listPackages(project, data);
check('пакет проекта сильнее глобального с тем же именем', list.find((p) => p.name === 'review-kit')?.version === '9.9.9');
list = listPackages(project, data, { includeProject: false });
check('без доверия — только глобальные', list.find((p) => p.name === 'review-kit')?.source === 'global');
list = listPackages(project, data, { includeProject: false, settings: { 'review-kit': { enabled: false } } });
check('выключенный пакет помечен', list.find((p) => p.name === 'review-kit')?.enabled === false);
check('выключенный пакет не даёт папок', packageDirs(list, 'commands').every((d) => d.source !== 'package:review-kit'));

console.log('\n[5] Связка с командами, агентами, хуками, MCP');
const pkgs = listPackages(project, data, { includeProject: false });
const commands = listCustomCommands(project, data, { includeProject: true, extraDirs: packageDirs(pkgs, 'commands') });
check('команды пакета видны с источником', commands.find((c) => c.name === 'review')?.source === 'package:review-kit');
write(path.join(project, '.mai-code', 'commands', 'review.md'), 'команда проекта');
const commands2 = listCustomCommands(project, data, { includeProject: true, extraDirs: packageDirs(pkgs, 'commands') });
check('команда проекта сильнее команды пакета', commands2.find((c) => c.name === 'review')?.source === 'project');
write(path.join(data, 'commands', 'lint.md'), 'глобальная');
check('команда пакета сильнее глобальной', listCustomCommands(project, data, { extraDirs: packageDirs(pkgs, 'commands') }).find((c) => c.name === 'lint')?.source === 'package:review-kit');
const agents = listAgentDefs(project, data, { extraDirs: packageDirs(pkgs, 'agents') });
check('тип агента из пакета', agents.find((a) => a.name === 'reviewer')?.source === 'package:review-kit');
const hooks = collectHooks({ projectDir: project, trusted: false, packageHooks: packageHooks(pkgs) });
check('хуки пакета с источником', hooks.Stop?.[0].hooks[0].source === 'package:review-kit');
const servers = packageMcpServers(pkgs);
check('MCP пакета: рабочая папка — папка пакета', servers.lint?.cwd === path.join(data, 'packages', 'review-kit') && servers.lint.package === 'review-kit');

console.log('\n[6] Удаление');
uninstallPackage({ name: 'review-kit', dataDir: data });
check('удалён с диска', !fs.existsSync(target));
check('неверное имя — ошибка', /Неверное имя/.test(err(() => uninstallPackage({ name: '../x', dataDir: data }))));
check('не установленный — ошибка', /не установлен/.test(err(() => uninstallPackage({ name: 'nope', dataDir: data }))));

fs.rmSync(root, { recursive: true, force: true });
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
