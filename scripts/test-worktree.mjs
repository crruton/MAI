/**
 * Изоляция субагента в git worktree (CC8.5, ADR 0075): настоящий git.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repoRoot, createWorktree, worktreeChanges, applyChanges, removeWorktree, listWorktrees, worktreeId } from '../electron/lib/worktree.js';

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
const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mai-wt-')));
const repo = path.join(tmp, 'repo');
const base = path.join(tmp, 'worktrees');
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
git(repo, 'init', '-q', '-b', 'main');
fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'один\nдва\n');
fs.writeFileSync(path.join(repo, 'old.txt'), 'удалить\n');
git(repo, 'add', '-A');
git(repo, 'commit', '-q', '-m', 'init');

console.log('[1] репозиторий');
check('корень из подпапки', repoRoot(path.join(repo, 'src')) === repo, repoRoot(path.join(repo, 'src')));
const empty = path.join(tmp, 'empty');
fs.mkdirSync(empty);
git(empty, 'init', '-q');
check('не репозиторий и репозиторий без коммитов — пусто', repoRoot(tmp) === '' && repoRoot(empty) === '');

console.log('[2] копия, изменения, слияние');
let wt = createWorktree({ repo, baseDir: base, id: 'one' });
check('копия на своей ветке от HEAD', fs.existsSync(path.join(wt.dir, 'src', 'a.txt')) && wt.branch === 'mai/agent-one' && git(repo, 'branch', '--list', 'mai/agent-one').stdout.includes('mai/agent-one'));
fs.writeFileSync(path.join(wt.dir, 'src', 'a.txt'), 'один\nдва\nтри\n');
fs.writeFileSync(path.join(wt.dir, 'new.md'), '# новый\n');
fs.rmSync(path.join(wt.dir, 'old.txt'));
check('проект не тронут, пока не слито', fs.readFileSync(path.join(repo, 'src', 'a.txt'), 'utf8') === 'один\nдва\n' && !fs.existsSync(path.join(repo, 'new.md')));
let changes = worktreeChanges(wt);
const st = changes.files.map((f) => `${f.status} ${f.path}`).sort().join(',');
check('изменения: правка, новый, удалённый', st === 'A new.md,D old.txt,M src/a.txt' && /3 files changed/.test(changes.stat), `${st} | ${changes.stat}`);
// Пользователь тем временем правит другую строку проекта — слияние должно её сохранить.
fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'ОДИН\nдва\n');
applyChanges(wt, changes);
check('слито с правкой пользователя (3-way)', fs.readFileSync(path.join(repo, 'src', 'a.txt'), 'utf8') === 'ОДИН\nдва\nтри\n', fs.readFileSync(path.join(repo, 'src', 'a.txt'), 'utf8'));
check('новый файл появился, удалённый удалён', fs.readFileSync(path.join(repo, 'new.md'), 'utf8') === '# новый\n' && !fs.existsSync(path.join(repo, 'old.txt')));
check('индекс проекта чистый — правки как обычные', git(repo, 'diff', '--cached', '--name-only').stdout.trim() === '', git(repo, 'diff', '--cached', '--name-only').stdout);
removeWorktree(wt);
check('копия и ветка убраны', !fs.existsSync(wt.dir) && !git(repo, 'branch', '--list', 'mai/agent-one').stdout.trim());

console.log('[3] отказ и конфликт');
git(repo, 'add', '-A');
git(repo, 'commit', '-q', '-m', 'merged');
wt = createWorktree({ repo, baseDir: base, id: 'two' });
fs.writeFileSync(path.join(wt.dir, 'src', 'a.txt'), 'X\nдва\nтри\n');
removeWorktree(wt, { keepBranch: true });
const kept = git(repo, 'show', 'mai/agent-two:src/a.txt').stdout;
check('отказ: копия убрана, правки сохранены в ветке', !fs.existsSync(wt.dir) && kept === 'X\nдва\nтри\n', kept);
wt = createWorktree({ repo, baseDir: base, id: 'three' });
fs.writeFileSync(path.join(wt.dir, 'src', 'a.txt'), 'Y\nдва\nтри\n');
fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'Z\nдва\nтри\n');
changes = worktreeChanges(wt);
let err = '';
try {
  applyChanges(wt, changes);
} catch (e) {
  err = e.message;
}
check('конфликт: понятная ошибка, проект не изменён', /не накладываются/.test(err) && fs.readFileSync(path.join(repo, 'src', 'a.txt'), 'utf8') === 'Z\nдва\nтри\n', err);
removeWorktree(wt, { keepBranch: true });
let bad = '';
try {
  createWorktree({ repo, baseDir: base, id: '../x' });
} catch (e) {
  bad = e.message;
}
check('id с путём — отказ', /Неверный id/.test(bad));

console.log('[4] копии для чатов (/worktree)');
check('имя копии из ввода', worktreeId('Fix Login!') === 'fix-login' && worktreeId('  ') === '' && worktreeId('Почини') === '');
const user = createWorktree({ repo, baseDir: path.join(tmp, 'chats'), id: 'fix-login', branchPrefix: 'mai/wt-' });
const list = listWorktrees(repo);
check('список: основная папка первой, копия со своей веткой', list[0].main && list[0].dir === repo && list.some((w) => !w.main && w.branch === 'mai/wt-fix-login' && w.dir === user.dir), JSON.stringify(list));
let dup = '';
try {
  createWorktree({ repo, baseDir: path.join(tmp, 'chats'), id: 'fix-login', branchPrefix: 'mai/wt-' });
} catch (e) {
  dup = e.message;
}
check('та же копия второй раз — понятный отказ', /уже есть/.test(dup), dup);
removeWorktree(user, { keepBranch: true });
check('убрана, ветка осталась', !listWorktrees(repo).some((w) => w.dir === user.dir) && git(repo, 'branch', '--list', 'mai/wt-fix-login').stdout.includes('mai/wt-fix-login'));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
