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
