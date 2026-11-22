/**
 * Наборы по ролям (CW6.1, ADR 0070): папка roles/ и установка набора.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listRoles, installRole } from '../electron/lib/roles.js';
import { listPackages, packageDirs } from '../electron/lib/packages.js';
import { listCustomCommands } from '../electron/lib/commands.js';

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
const here = path.dirname(fileURLToPath(import.meta.url));
const rolesDir = path.join(here, '..', 'roles');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-roles-'));

console.log('[1] наборы в приложении');
const roles = listRoles(rolesDir);
check('пять ролей по порядку', roles.map((r) => r.id).join() === 'developer,analyst,lawyer,sales,finance', roles.map((r) => r.id).join());
check('у каждой: название, значок, описание, примеры', roles.every((r) => r.title && r.icon && r.summary && r.examples.length >= 2 && r.package === `role-${r.id}`));
check('коннекторы — только из встроенного каталога', roles.every((r) => r.connectors.every((c) => ['linear', 'notion', 'github', 'sentry'].includes(c))));
for (const role of roles) {
  const skillsDir = path.join(role.dir, 'skills');
  const skills = fs.readdirSync(skillsDir).filter((n) => /^---\nname: [a-z-]+\ndescription: .{20,}\n---/.test(fs.readFileSync(path.join(skillsDir, n, 'SKILL.md'), 'utf8')));
  const cmds = fs.readdirSync(path.join(role.dir, 'commands')).filter((n) => /^---\ndescription: .+\n/.test(fs.readFileSync(path.join(role.dir, 'commands', n), 'utf8')) && fs.readFileSync(path.join(role.dir, 'commands', n), 'utf8').includes('$ARGUMENTS'));
  const executable = ['plugins', 'hooks.json', 'mcp.json'].some((p) => fs.existsSync(path.join(role.dir, p)));
  check(`${role.id}: навыки и команды с frontmatter, без исполняемого`, skills.length >= 1 && cmds.length >= 1 && !executable, `${skills} ${cmds}`);
}

console.log('[2] установка');
const dataDir = path.join(tmp, 'data');
const out = installRole({ id: 'finance', rolesDir, dataDir });
check('набор — глобальный пакет', out.package?.name === 'role-finance' && out.package.parts.skills === 1 && out.package.parts.commands === 1, JSON.stringify(out.package?.parts));
const pkgs = listPackages('', dataDir, { includeProject: false });
check('виден в списке пакетов и включён', pkgs.some((p) => p.name === 'role-finance' && p.enabled));
const cmds = listCustomCommands('', dataDir, { includeProject: false, extraDirs: packageDirs(pkgs, 'commands') });
check('команда набора доступна', cmds.some((c) => c.name === 'budget'), JSON.stringify(cmds.map((c) => c.name)));
fs.writeFileSync(path.join(dataDir, 'packages', 'role-finance', 'stale.txt'), 'x');
installRole({ id: 'finance', rolesDir, dataDir });
check('повторная установка заменяет набор целиком', !fs.existsSync(path.join(dataDir, 'packages', 'role-finance', 'stale.txt')) && !fs.readdirSync(path.join(dataDir, 'packages')).some((n) => n.includes('.new-')));
let threw = '';
try {
  installRole({ id: 'nope', rolesDir, dataDir });
} catch (err) {
  threw = err.message;
}
check('неизвестная роль — ошибка', /Нет набора роли/.test(threw));

console.log('[3] исполняемое не ставится');
const fake = path.join(tmp, 'roles', 'x');
fs.mkdirSync(path.join(fake, 'plugins'), { recursive: true });
fs.mkdirSync(path.join(fake, 'skills', 's'), { recursive: true });
fs.writeFileSync(path.join(fake, 'mai-package.json'), JSON.stringify({ name: 'role-x', role: { id: 'x', title: 'X', examples: [] } }));
fs.writeFileSync(path.join(fake, 'plugins', 'evil.js'), 'process.exit(1)');
fs.writeFileSync(path.join(fake, 'hooks.json'), '{}');
fs.writeFileSync(path.join(fake, 'mcp.json'), '{"mcpServers":{"a":{"command":"x"}}}');
fs.writeFileSync(path.join(fake, 'skills', 's', 'SKILL.md'), '---\nname: s\ndescription: d\n---\n');
const x = installRole({ id: 'x', rolesDir: path.join(tmp, 'roles'), dataDir });
check('plugins, hooks.json и mcp.json отброшены', !x.package.executable && x.package.parts.skills === 1, JSON.stringify(x.package.parts));
fs.writeFileSync(path.join(tmp, 'roles', 'x', 'mai-package.json'), JSON.stringify({ name: 'bad name!', role: { id: 'x' } }));
check('кривой манифест — не роль', listRoles(path.join(tmp, 'roles')).length === 0);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
