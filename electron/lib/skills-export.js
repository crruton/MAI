/**
 * Экспорт навыков каталога в другие агенты: Claude Code, OpenCode, Codex (E1.9, ADR 0114).
 *
 * Каждый экспортированный навык — папка `<каталог агента>/<имя>/` с SKILL.md, файлами
 * навыка и меткой `.mai-catalog.json` (версия, хэш). Папка без метки — чужая и не
 * трогается. Удаление — только своих и только с `prune`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectCatalogSkills, MANAGED_BY } from './multica-skills.js';

export const MARKER = '.mai-catalog.json';

/** Папки навыков агентов: для пользователя (home) и для проекта. */
export const TARGETS = {
  claude: { label: 'Claude Code', user: ['.claude', 'skills'], project: ['.claude', 'skills'] },
  opencode: { label: 'OpenCode', user: ['.config', 'opencode', 'skills'], project: ['.opencode', 'skills'] },
  codex: { label: 'Codex', user: ['.codex', 'skills'], project: ['.codex', 'skills'] },
};

export function targetDir(target, { projectDir = '', home = os.homedir() } = {}) {
  const spec = TARGETS[target];
  if (!spec) throw new Error(`Неизвестный агент «${target}»: ${Object.keys(TARGETS).join(', ')}`);
  return projectDir ? path.join(projectDir, ...spec.project) : path.join(home, ...spec.user);
}

function readMarker(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8'));
  } catch {
    return null;
  }
}

/** План: create / update / unchanged / conflict / delete — как у Multica (ADR 0113). */
export function planExport(skills, dir, { prune = false } = {}) {
  const actions = [];
  for (const skill of skills) {
    const dest = path.join(dir, skill.name);
    if (!fs.existsSync(dest)) {
      actions.push({ action: 'create', name: skill.name, dest, skill });
      continue;
    }
    const marker = readMarker(dest);
    if (marker?.managed_by !== MANAGED_BY) actions.push({ action: 'conflict', name: skill.name, dest, reason: 'папка создана не из каталога — не трогаю' });
    else if (marker.hash === skill.hash && marker.version === skill.version) actions.push({ action: 'unchanged', name: skill.name, dest });
    else actions.push({ action: 'update', name: skill.name, dest, skill, from: marker.version || '' });
  }
  if (prune && fs.existsSync(dir)) {
    const names = new Set(skills.map((s) => s.name));
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || names.has(entry.name)) continue;
      const dest = path.join(dir, entry.name);
      if (readMarker(dest)?.managed_by === MANAGED_BY) actions.push({ action: 'delete', name: entry.name, dest });
    }
  }
  return actions;
}

/** Пишет навык в новую папку рядом и подменяет старую: прерванный экспорт не оставляет половину. */
function writeSkill(skill, dest, source) {
  const temp = `${dest}.mai-tmp-${process.pid}`;
  fs.rmSync(temp, { recursive: true, force: true });
  fs.mkdirSync(temp, { recursive: true });
  fs.writeFileSync(path.join(temp, 'SKILL.md'), skill.content);
  for (const f of skill.files) {
    const target = path.join(temp, ...f.path.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.content);
  }
  fs.writeFileSync(path.join(temp, MARKER), `${JSON.stringify({ managed_by: MANAGED_BY, version: skill.version, hash: skill.hash, source }, null, 2)}\n`);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(temp, dest);
}

/**
 * @param {{ root: string, targets: string[], projectDir?: string, home?: string, names?: string[],
 *           prune?: boolean, dryRun?: boolean, source?: string }} options
 */
export function exportSkills({ root, targets, projectDir = '', home = os.homedir(), names = [], prune = false, dryRun = false, source = 'mai-team' }) {
  if (!targets?.length) throw new Error(`Укажите агентов: ${Object.keys(TARGETS).join(', ')}`);
  const skills = collectCatalogSkills(root, names);
  const results = [];
  for (const target of targets) {
    const dir = targetDir(target, { projectDir, home });
    const actions = planExport(skills, dir, { prune: prune && names.length === 0 });
    if (!dryRun) {
      fs.mkdirSync(dir, { recursive: true });
      for (const a of actions) {
        if (a.action === 'create' || a.action === 'update') writeSkill(a.skill, a.dest, source);
        else if (a.action === 'delete') fs.rmSync(a.dest, { recursive: true, force: true });
      }
    }
    const count = (kind) => actions.filter((a) => a.action === kind).length;
    results.push({
      target,
      label: TARGETS[target].label,
      dir,
      created: count('create'),
      updated: count('update'),
      unchanged: count('unchanged'),
      conflicts: count('conflict'),
      deleted: count('delete'),
      actions: actions.map(({ skill, ...rest }) => rest),
    });
  }
  return { ok: true, dryRun, results };
}
