import fs from 'node:fs';
import path from 'node:path';

/**
 * Минимальный парсер OpenSpec-изменений.
 *
 * Полный CLI OpenSpec не требуется: приложению нужны название изменения,
 * краткое описание и список задач из tasks.md. Формат намеренно простой,
 * чтобы синхронизация работала и без установленного openspec.
 */

function firstHeading(text, fallback) {
  const match = /^#\s+(.+)$/m.exec(text || '');
  return match ? match[1].replace(/[`*_]/g, '').trim() : fallback;
}

function firstParagraph(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const value = line.trim();
    if (!value) {
      if (out.length) break;
      continue;
    }
    if (value.startsWith('#') || value.startsWith('- ') || value.startsWith('|')) {
      if (out.length) break;
      continue;
    }
    out.push(value);
  }
  return out.join(' ').slice(0, 600);
}

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export function openspecRoot(projectDir) {
  return path.join(projectDir || '', 'openspec');
}

export function listChanges(projectDir) {
  const root = openspecRoot(projectDir);
  const changesDir = path.join(root, 'changes');
  if (!fs.existsSync(changesDir)) return [];
  const changes = [];
  for (const entry of fs.readdirSync(changesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(changesDir, entry.name);
    const proposalFile = path.join(dir, 'proposal.md');
    const tasksFile = path.join(dir, 'tasks.md');
    const proposal = fs.existsSync(proposalFile) ? fs.readFileSync(proposalFile, 'utf8') : '';
    const tasksText = fs.existsSync(tasksFile) ? fs.readFileSync(tasksFile, 'utf8') : '';
    const tasks = [];
    const lines = tasksText.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const match = /^\s*[-*]\s+\[( |x|X)\]\s+(.+)$/.exec(lines[i]);
      if (!match) continue;
      const text = match[2].trim();
      tasks.push({
        id: slug(text) || `task-${i + 1}`,
        text,
        done: match[1].toLowerCase() === 'x',
        line: i + 1,
      });
    }
    changes.push({
      name: entry.name,
      dir,
      title: firstHeading(proposal, entry.name),
      summary: firstParagraph(proposal.replace(/^#.*$/m, '')),
      tasks,
    });
  }
  return changes.sort((a, b) => a.name.localeCompare(b.name));
}

export function taskMarker(changeName, taskId) {
  return `<!-- openspec:${changeName}:${taskId} -->`;
}

/** Маркер из описания задачи Multica → { change, taskId } или null. */
export function parseTaskMarker(text) {
  const match = /<!--\s*openspec:([^:\s]+):([^\s]+?)\s*-->/.exec(String(text || ''));
  return match ? { change: match[1], taskId: match[2] } : null;
}

const DONE = /^(done|completed|complete|closed|resolved)$/i;
const CANCELLED = /^(cancel+ed|canceled|wontfix|duplicate)$/i;

/**
 * Статусы задач Multica → обновления tasks.md (F14, ADR 0089).
 * Только задачи с маркером OpenSpec. «Готово» → [x]; отменённые и прочие
 * статусы галочку не ставят (о них — в отчёте).
 */
export function statusUpdatesFromIssues(issues = []) {
  const updates = [];
  const cancelled = [];
  for (const issue of issues || []) {
    const marker = parseTaskMarker(issue?.description);
    if (!marker) continue;
    const status = String(issue.status || '').trim();
    if (DONE.test(status)) updates.push({ ...marker, done: true, issue: issue.key || issue.id || '' });
    else if (CANCELLED.test(status)) cancelled.push({ ...marker, issue: issue.key || issue.id || '' });
  }
  return { updates, cancelled };
}

/**
 * Применить галочки к tasks.md: задача ищется по id (как в listChanges), а не
 * по номеру строки — строки могли сдвинуться. Запись — через временный файл,
 * переводы строк сохраняются. Возвращает { marked, already, missing }.
 */
export function applyTaskStatuses(projectDir, updates = [], { dryRun = false } = {}) {
  const report = { marked: [], already: [], missing: [] };
  const byChange = new Map();
  for (const u of updates) {
    if (!byChange.has(u.change)) byChange.set(u.change, []);
    byChange.get(u.change).push(u);
  }
  const changes = new Map(listChanges(projectDir).map((c) => [c.name, c]));
  for (const [name, list] of byChange) {
    const change = changes.get(name);
    if (!change) {
      for (const u of list) report.missing.push(`${name}:${u.taskId}`);
      continue;
    }
    const file = path.join(change.dir, 'tasks.md');
    const raw = fs.readFileSync(file, 'utf8');
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const lines = raw.split(/\r?\n/);
    let dirty = false;
    for (const u of list) {
      const task = change.tasks.find((t) => t.id === u.taskId);
      if (!task) {
        report.missing.push(`${name}:${u.taskId}`);
        continue;
      }
      const label = `${name}: ${task.text}${u.issue ? ` (${u.issue})` : ''}`;
      if (task.done === Boolean(u.done)) {
        report.already.push(label);
        continue;
      }
      const index = task.line - 1;
      lines[index] = lines[index].replace(/\[( |x|X)\]/, u.done ? '[x]' : '[ ]');
      report.marked.push(label);
      dirty = true;
    }
    if (dirty && !dryRun) {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, lines.join(eol), 'utf8');
      fs.renameSync(tmp, file);
    }
  }
  return report;
}
