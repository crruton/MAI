/**
 * Экспорт навыков каталога в Claude Code, OpenCode, Codex (E1.9, ADR 0114).
 * Временный home и временный проект: план, идемпотентность, чужие папки, prune, dry-run.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { exportSkills, targetDir, MARKER } from '../electron/lib/skills-export.js';

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
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-export-home-'));
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-export-proj-'));
const CR = String.fromCharCode(13);

console.log('[1] папки агентов');
check('claude, opencode, codex для пользователя', targetDir('claude', { home }) === path.join(home, '.claude', 'skills') && targetDir('opencode', { home }) === path.join(home, '.config', 'opencode', 'skills') && targetDir('codex', { home }) === path.join(home, '.codex', 'skills'));
check('для проекта', targetDir('opencode', { projectDir: project }) === path.join(project, '.opencode', 'skills'));
let err = '';
try {
  targetDir('cursor', { home });
} catch (e) {
  err = e.message;
}
check('неизвестный агент — ошибка со списком', /claude, opencode, codex/.test(err));

console.log('[2] первый экспорт и повтор');
let r = exportSkills({ root: repo, targets: ['claude', 'opencode', 'codex'], home });
check('по 18 навыков в три агента', r.results.every((x) => x.created === 18), JSON.stringify(r.results.map((x) => x.created)));
const tdd = path.join(home, '.claude', 'skills', 'tdd');
check('SKILL.md, файлы и метка на месте', fs.existsSync(path.join(tdd, 'SKILL.md')) && fs.existsSync(path.join(tdd, 'mocking.md')) && JSON.parse(fs.readFileSync(path.join(tdd, MARKER), 'utf8')).managed_by === 'mai-code');
check('файлы с LF', !fs.readFileSync(path.join(tdd, 'SKILL.md'), 'utf8').includes(CR));
check('вложенные справки', fs.existsSync(path.join(home, '.codex', 'skills', 'stop-slop', 'references', 'phrases.md')));
check('нет временных папок', !fs.readdirSync(path.join(home, '.claude', 'skills')).some((n) => n.includes('.mai-tmp-')));
r = exportSkills({ root: repo, targets: ['claude'], home });
check('повтор: без изменений', r.results[0].unchanged === 18 && r.results[0].created === 0);

console.log('[3] обновление, чужие папки, prune');
fs.appendFileSync(path.join(tdd, 'SKILL.md'), 'локальная правка');
const marker = JSON.parse(fs.readFileSync(path.join(tdd, MARKER), 'utf8'));
marker.hash = 'old';
fs.writeFileSync(path.join(tdd, MARKER), JSON.stringify(marker));
r = exportSkills({ root: repo, targets: ['claude'], home });
check('другой хэш → update, правка заменена каталогом', r.results[0].updated === 1 && !fs.readFileSync(path.join(tdd, 'SKILL.md'), 'utf8').includes('локальная правка'));
const own = path.join(home, '.claude', 'skills', 'debug');
fs.rmSync(path.join(own, MARKER));
fs.writeFileSync(path.join(own, 'SKILL.md'), 'мой навык');
const mine = path.join(home, '.claude', 'skills', 'my-tool');
fs.mkdirSync(mine);
fs.writeFileSync(path.join(mine, 'SKILL.md'), 'личный');
r = exportSkills({ root: repo, targets: ['claude'], home, prune: true });
check('папка без метки — conflict, не перезаписана', r.results[0].conflicts === 1 && fs.readFileSync(path.join(own, 'SKILL.md'), 'utf8') === 'мой навык');
check('prune не трогает чужую папку', fs.existsSync(mine) && r.results[0].deleted === 0);
const gone = path.join(home, '.claude', 'skills', 'old-skill');
fs.mkdirSync(gone);
fs.writeFileSync(path.join(gone, MARKER), JSON.stringify({ managed_by: 'mai-code', version: '0.1.0', hash: 'x' }));
r = exportSkills({ root: repo, targets: ['claude'], home, names: ['tdd'], prune: true });
check('prune с выбором имён ничего не удаляет', fs.existsSync(gone) && r.results[0].deleted === 0);
r = exportSkills({ root: repo, targets: ['claude'], home, prune: true });
check('prune удаляет свой пропавший навык', !fs.existsSync(gone) && r.results[0].deleted === 1);

console.log('[4] проект, dry-run, скрипт');
r = exportSkills({ root: repo, targets: ['claude'], projectDir: project, names: ['grilling'], dryRun: true });
check('dry-run: план без записи', r.dryRun && r.results[0].created === 1 && !fs.existsSync(path.join(project, '.claude')));
r = exportSkills({ root: repo, targets: ['opencode'], projectDir: project, names: ['grilling'] });
check('в проект: .opencode/skills/grilling', fs.existsSync(path.join(project, '.opencode', 'skills', 'grilling', 'SKILL.md')));
const cli = spawnSync(process.execPath, [path.join(repo, 'scripts', 'skills-export.mjs'), '--target', 'codex', '--project', project, '--dry-run', 'tdd'], { encoding: 'utf8' });
check('скрипт: план для Codex', cli.status === 0 && /План → Codex/.test(cli.stdout) && /create\s+tdd/.test(cli.stdout), cli.stdout + cli.stderr);
const bad = spawnSync(process.execPath, [path.join(repo, 'scripts', 'skills-export.mjs')], { encoding: 'utf8' });
check('скрипт без --target — код 1 и подсказка', bad.status === 1 && /--target/.test(bad.stderr));

fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(project, { recursive: true, force: true });
console.log(`\nskills-export: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
