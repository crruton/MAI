/**
 * Доверие к папке проекта (ADR 0028): хранение, наследование, осмотр папки.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trustState, setTrust, removeTrust, listTrust, inspectProject, folderKey } from '../electron/lib/trust.js';

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

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-trust-data-'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-trust-work-'));
const repo = path.join(work, 'repo');
const nested = path.join(repo, 'packages', 'app');
fs.mkdirSync(nested, { recursive: true });

console.log('\n[1] Без решения');
check('новая папка — unknown', trustState(data, repo).state === 'unknown');
check('пустой путь — unknown', trustState(data, '').state === 'unknown');
check('список пуст', listTrust(data).length === 0);

console.log('\n[2] Решение и наследование');
setTrust(data, work, 'trusted');
check('папка доверена', trustState(data, work).state === 'trusted');
check('вложенная наследует', trustState(data, nested).state === 'trusted' && trustState(data, nested).inherited === true);
setTrust(data, repo, 'restricted');
check('ближайшее решение важнее', trustState(data, nested).state === 'restricted');
check('родитель не изменился', trustState(data, work).state === 'trusted');
check('соседняя папка с общим префиксом не наследует', trustState(data, `${work}-other`).state === 'unknown');
check('хвостовой разделитель не важен', folderKey(`${repo}${path.sep}`) === folderKey(repo));
check('в списке два решения', listTrust(data).length === 2);

console.log('\n[3] Отмена решения');
removeTrust(data, repo);
check('после удаления снова наследует от родителя', trustState(data, nested).state === 'trusted');
removeTrust(data, work);
check('после удаления родителя — unknown', trustState(data, nested).state === 'unknown');

console.log('\n[4] Неверные значения');
let error = '';
try {
  setTrust(data, repo, 'everything');
} catch (err) {
  error = err.message;
}
check('неизвестное состояние отклонено', /Неизвестное состояние/.test(error), error);
fs.writeFileSync(path.join(data, 'trust.json'), '{не json', 'utf8');
check('битый trust.json — unknown, без исключения', trustState(data, repo).state === 'unknown');

console.log('\n[5] Песочницы приложения доверены автоматически');
const sandboxes = path.join(data, 'sandboxes');
check('папка песочницы — trusted', trustState(data, path.join(sandboxes, 'demo'), { autoTrusted: [sandboxes] }).state === 'trusted');
check('чужая папка — нет', trustState(data, repo, { autoTrusted: [sandboxes] }).state === 'unknown');

console.log('\n[6] Осмотр папки: что исполняется или влияет на агента');
check('пустая папка — ничего', inspectProject(repo).executable === false && inspectProject(repo).plugins === 0);
fs.mkdirSync(path.join(repo, '.mai-code', 'plugins'), { recursive: true });
fs.writeFileSync(path.join(repo, '.mai-code', 'plugins', 'evil.js'), 'export default {}', 'utf8');
fs.writeFileSync(path.join(repo, '.mai-code', 'mcp.json'), JSON.stringify({ mcpServers: { fs: { command: 'x' } } }), 'utf8');
fs.mkdirSync(path.join(repo, '.mai-code', 'skills', 'deploy'), { recursive: true });
fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# правила', 'utf8');
const found = inspectProject(repo);
check('плагин найден', found.plugins === 1, JSON.stringify(found));
check('MCP найден по имени', found.mcpServers.join() === 'fs', JSON.stringify(found));
check('навык найден', found.skills === 1, JSON.stringify(found));
check('AGENTS.md найден', found.agents === true);
check('есть исполняемое', found.executable === true);

fs.rmSync(data, { recursive: true, force: true });
fs.rmSync(work, { recursive: true, force: true });
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
