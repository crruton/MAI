/**
 * Изоляция субагента в `git worktree` (CC8.5, ADR 0075).
 *
 * Субагент с правом записи работает в отдельной рабочей копии на ветке
 * `mai/agent-<id>` от HEAD проекта. После его работы родитель получает diff;
 * слияние — по подтверждению пользователя: изменения накладываются на рабочую
 * папку проекта трёхсторонне по каждому файлу (`git merge-file`). Отказ — изменения коммитятся в ветку, папка
 * worktree удаляется, ветка остаётся для ручного разбора.
 *
 * Важно: worktree стартует от HEAD — незакоммиченных правок проекта в нём нет.
 * Модуль не зависит от Electron.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const MAX_PATCH = 2 * 1024 * 1024;

function git(cwd, args, { input, allowFail = false } = {}) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 120_000 });
  if (res.error) throw new Error(`git ${args[0]}: ${res.error.message}`);
  if (res.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')}: ${(res.stderr || res.stdout || '').trim().slice(0, 400)}`);
  return res;
}

/** Корень git-репозитория папки или '' (не репозиторий, нет git, нет коммитов). */
export function repoRoot(dir) {
  try {
    const top = git(dir, ['rev-parse', '--show-toplevel'], { allowFail: true });
    if (top.status !== 0) return '';
    const head = git(dir, ['rev-parse', '--verify', 'HEAD'], { allowFail: true });
    return head.status === 0 ? path.resolve(top.stdout.trim()) : '';
  } catch {
    return '';
  }
}

/**
 * Новая рабочая копия: `<baseDir>/<id>` на ветке `mai/agent-<id>` от HEAD.
 * @returns {{ id, dir, branch, repo, base }}
 */
export function createWorktree({ repo, baseDir, id = crypto.randomBytes(4).toString('hex') }) {
  if (!/^[a-z0-9-]{1,40}$/.test(id)) throw new Error('Неверный id рабочей копии');
  const dir = path.join(baseDir, id);
  const branch = `mai/agent-${id}`;
  fs.mkdirSync(baseDir, { recursive: true });
  const base = git(repo, ['rev-parse', 'HEAD']).stdout.trim();
  git(repo, ['worktree', 'add', '-b', branch, dir, base]);
  return { id, dir, branch, repo, base };
}

/** Что изменил субагент относительно базы: файлы, статистика и патч (с новыми файлами). */
export function worktreeChanges(wt) {
  git(wt.dir, ['add', '-A']);
  const names = git(wt.dir, ['diff', '--cached', '--no-renames', '--name-status', wt.base]).stdout.trim();
  const files = names
    ? names.split('\n').map((line) => {
        const [status, ...rest] = line.split('\t');
        return { status: status[0], path: rest[rest.length - 1] };
      })
    : [];
  const stat = files.length ? git(wt.dir, ['diff', '--cached', '--no-renames', '--stat', wt.base]).stdout.trim() : '';
  const patch = files.length ? git(wt.dir, ['diff', '--cached', '--binary', wt.base]).stdout : '';
  if (patch.length > MAX_PATCH) throw new Error(`Изменения субагента слишком большие (${patch.length} байт) — разберите ветку ${wt.branch} вручную`);
  return { files, stat, patch };
}

/** Содержимое файла в коммите или null, если его там нет. */
function showAt(repo, rev, file) {
  const res = spawnSync('git', ['show', `${rev}:${file}`], { cwd: repo, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return res.status === 0 ? res.stdout : null;
}

function readOrNull(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

/** Трёхстороннее слияние текста через `git merge-file`; null — конфликт. */
function mergeText(base, ours, theirs) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-merge-'));
  try {
    const [o, b, t] = ['ours', 'base', 'theirs'].map((n) => path.join(tmp, n));
    fs.writeFileSync(o, ours);
    fs.writeFileSync(b, base);
    fs.writeFileSync(t, theirs);
    const res = spawnSync('git', ['merge-file', '-p', o, b, t], { maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    return res.status === 0 ? res.stdout : null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const isBinary = (buf) => buf && buf.subarray(0, 8000).includes(0);

/**
 * Наложить изменения на рабочую папку проекта — по файлу, трёхсторонне
 * относительно базы копии: незакоммиченные правки пользователя сохраняются.
 * Сначала проверяются все файлы; конфликт хоть в одном — ошибка, проект не меняется.
 */
export function applyChanges(wt, changes) {
  const plan = [];
  const conflicts = [];
  for (const f of changes.files) {
    const target = path.join(wt.repo, f.path);
    const base = showAt(wt.repo, wt.base, f.path);
    const ours = readOrNull(target);
    const theirs = f.status === 'D' ? null : readOrNull(path.join(wt.dir, f.path));
    if (f.status === 'D') {
      if (ours === null) continue;
      if (base && ours.equals(base)) plan.push({ target, remove: true });
      else conflicts.push(`${f.path}: вы изменили файл, а субагент его удалил`);
    } else if (base === null || ours === null || ours.equals(base)) {
      // Новый у субагента или нетронутый у пользователя — просто взять версию субагента.
      if (base === null && ours !== null && !ours.equals(theirs)) conflicts.push(`${f.path}: файл есть и у вас, и у субагента`);
      else plan.push({ target, data: theirs });
    } else if (isBinary(ours) || isBinary(theirs) || isBinary(base)) {
      conflicts.push(`${f.path}: двоичный файл изменён и вами, и субагентом`);
    } else {
      const merged = mergeText(base, ours, theirs);
      if (merged === null) conflicts.push(`${f.path}: правки пересекаются с вашими`);
      else plan.push({ target, data: merged });
    }
  }
  if (conflicts.length) throw new Error(`Изменения не накладываются на текущие файлы: ${conflicts.join('; ')}`);
  for (const step of plan) {
    if (step.remove) fs.rmSync(step.target, { force: true });
    else {
      fs.mkdirSync(path.dirname(step.target), { recursive: true });
      fs.writeFileSync(step.target, step.data);
    }
  }
  return { applied: plan.length };
}

/**
 * Убрать рабочую копию. `keepBranch` — сначала закоммитить изменения в ветку,
 * чтобы их можно было разобрать вручную; иначе ветка удаляется.
 */
export function removeWorktree(wt, { keepBranch = false } = {}) {
  if (keepBranch) {
    git(wt.dir, ['add', '-A'], { allowFail: true });
    git(wt.dir, ['-c', 'user.name=MAI Code', '-c', 'user.email=mai@localhost', 'commit', '-q', '--no-verify', '-m', 'Изменения субагента (не слиты)'], { allowFail: true });
  }
  git(wt.repo, ['worktree', 'remove', '--force', wt.dir], { allowFail: true });
  if (fs.existsSync(wt.dir)) fs.rmSync(wt.dir, { recursive: true, force: true });
  git(wt.repo, ['worktree', 'prune'], { allowFail: true });
  if (!keepBranch) git(wt.repo, ['branch', '-D', wt.branch], { allowFail: true });
}
