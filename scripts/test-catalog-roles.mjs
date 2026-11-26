/**
 * Наборы навыков каталога по ролям (E1.7, ADR 0115): поле `roles` в индексе, проверка,
 * установка навыков роли кодом MAI, `--role` у экспорта и отдачи в Multica.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogRoles, roleSkillNames, validateRoles, installRoleSkills } from '../electron/lib/catalog-roles.js';
import { exportSkills } from '../electron/lib/skills-export.js';
import { pushSkills } from '../electron/lib/multica-skills.js';
import { listPackages } from '../electron/lib/packages.js';

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
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const index = JSON.parse(fs.readFileSync(path.join(repo, 'mai-marketplace.json'), 'utf8'));

console.log('[1] роли каталога');
const roles = catalogRoles(repo);
check('пять ролей', Object.keys(roles).join() === 'developer,analyst,pm,qa,lead', Object.keys(roles).join());
check('роли каталога проходят проверку', validateRoles(index).length === 0, validateRoles(index).join('; '));
check('каждый навык каталога входит хотя бы в одну роль или он общий', index.packages.filter((p) => !Object.values(roles).flat().includes(p.name)).length <= 3, index.packages.filter((p) => !Object.values(roles).flat().includes(p.name)).map((p) => p.name).join());
check('навыки роли разработчика', roleSkillNames(repo, 'developer').includes('to-mr') && roleSkillNames(repo, 'developer').includes('tdd'));
let err = '';
try {
  roleSkillNames(repo, 'nobody');
} catch (e) {
  err = e.message;
}
check('неизвестная роль — ошибка со списком', /нет роли «nobody»: developer, analyst/.test(err), err);

console.log('[2] проверка поля roles');
const v = (roles) => validateRoles({ packages: [{ name: 'a' }, { name: 'b' }], roles });
check('без roles — без ошибок', validateRoles({ packages: [] }).length === 0);
check('навык вне каталога', v({ dev: ['a', 'zzz'] }).some((e) => /«zzz»/.test(e)));
check('пустой список', v({ dev: [] }).some((e) => /непустой/.test(e)));
check('неверное имя роли', v({ 'Dev Ops': ['a'] }).some((e) => /имя роли/.test(e)));
check('повтор навыка', v({ dev: ['a', 'a'] }).some((e) => /повторяется/.test(e)));
check('roles — массив вместо объекта', v(['a']).length === 1);

console.log('[3] установка навыков роли (мастер первого запуска)');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-roles-data-'));
const market = { name: 'mai-team', url: repo };
let r = installRoleSkills({ market, role: 'qa', dataDir });
check('qa: поставлены все навыки роли', r.installed.length === roles.qa.length && r.errors.length === 0, JSON.stringify(r));
const installed = listPackages(null, dataDir, { includeProject: false }).map((p) => p.name).sort();
check('пакеты видны в списке', roles.qa.every((n) => installed.includes(n)));
r = installRoleSkills({ market, role: 'qa', dataDir });
check('повтор: всё пропущено', r.skipped.length === roles.qa.length && r.installed.length === 0);
const man = path.join(dataDir, 'packages', 'use-cases', 'mai-package.json');
const old = JSON.parse(fs.readFileSync(man, 'utf8'));
old.version = '0.9.0';
fs.writeFileSync(man, JSON.stringify(old));
r = installRoleSkills({ market, role: 'qa', dataDir });
check('устаревшая версия обновляется', r.updated.join() === 'use-cases' && JSON.parse(fs.readFileSync(man, 'utf8')).version !== '0.9.0', JSON.stringify(r));
r = installRoleSkills({ market, role: 'lawyer', dataDir });
check('роли нет в каталоге — ничего не ставится, без ошибки', r.installed.length === 0 && r.errors.length === 0);
fs.rmSync(dataDir, { recursive: true, force: true });

console.log('[4] --role у экспорта и отдачи в Multica');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-roles-home-'));
const ex = exportSkills({ root: repo, targets: ['claude'], home, role: 'pm', dryRun: true });
check('экспорт роли pm: ровно её навыки', ex.results[0].created === roles.pm.length && ex.results[0].actions.every((a) => roles.pm.includes(a.name)));
const ex2 = exportSkills({ root: repo, targets: ['claude'], home, role: 'pm', names: ['tdd'], dryRun: true });
check('роль + имя: объединение без повторов', ex2.results[0].created === roles.pm.length + 1);
fs.rmSync(home, { recursive: true, force: true });
const run = (args) => (args.includes('list') ? '[]' : '{"id":"x"}');
const push = pushSkills({ root: repo, run, role: 'lead', dryRun: true });
check('отдача роли lead в Multica: план только её навыков', push.created === roles.lead.length && push.actions.every((a) => roles.lead.includes(a.name)));

console.log(`\ncatalog-roles: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
