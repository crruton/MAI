import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.js';
import { removeTree } from './remove-tree.js';

function parseFrontmatter(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (m) meta[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return { meta, body: text.slice(match[0].length) };
}

export function skillDirs(projectDir, extraDirs = []) {
  return [
    { scope: 'project', dir: path.join(projectDir || '', '.mai-code', 'skills') },
    { scope: 'project', dir: path.join(projectDir || '', '.opencode', 'skills') },
    // Навыки пакетов (ADR 0037): scope — «package:<имя>».
    ...extraDirs.map((d) => ({ scope: d.source, dir: d.dir })),
    { scope: 'global', dir: path.join(dataDir(), 'skills') },
  ];
}

/** Навыки. Без доверия к папке навыки проекта не попадают к агенту (ADR 0028). */
export function listSkills(projectDir, { includeProject = true, extraDirs = [] } = {}) {
  const skills = [];
  for (const { scope, dir } of skillDirs(projectDir, extraDirs)) {
    if (!includeProject && scope === 'project') continue;
    if (!dir || !fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(dir, entry.name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      skills.push({
        name: meta.name || entry.name,
        description: meta.description || '',
        // allowed-tools (CC10.4): правила allow на время прогона после загрузки навыка.
        allowedTools: String(meta['allowed-tools'] || meta.allowedTools || '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        body,
        file,
        scope,
        dir,
      });
    }
  }
  return skills;
}

export { uniqueSkills, skillConflicts } from './skill-conflicts.js';

/** Файлы навыка кроме SKILL.md — третий уровень загрузки (CC10.4). Пути относительно папки навыка. */
export function skillFiles(skill, { limit = 200 } = {}) {
  const root = path.dirname(skill.file);
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && full !== skill.file) out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

/** Читает файл навыка; путь не выходит из папки навыка. */
export function readSkillFile(skill, relative, { maxBytes = 100_000 } = {}) {
  const root = path.dirname(skill.file);
  const full = path.resolve(root, String(relative || ''));
  const rel = path.relative(root, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Файл вне папки навыка');
  const stat = fs.statSync(full);
  if (!stat.isFile()) throw new Error('Это не файл');
  const text = fs.readFileSync(full, 'utf8');
  return stat.size > maxBytes ? `${text.slice(0, maxBytes)}\n… обрезано (${stat.size} байт)` : text;
}

/**
 * Копирует навыки, вложенные в приложение, в глобальную папку пользователя.
 * Существующие навыки не перезаписываются: пользователь мог их отредактировать.
 */
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target);
    else fs.writeFileSync(target, fs.readFileSync(source));
  }
}

/** version из frontmatter SKILL.md или ''. */
export function skillVersion(dir) {
  try {
    return /^version:\s*["']?([\w.+-]+)/m.exec(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'))?.[1] || '';
  } catch {
    return '';
  }
}

/** -1, 0, 1 по числам версии; '' — меньше любой. */
export function compareSkillVersions(a, b) {
  const pa = String(a || '0').split(/[-+]/)[0].split('.').map(Number);
  const pb = String(b || '0').split(/[-+]/)[0].split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Встроенные навыки → папка данных. Новый — копируется. Уже установленный
 * обновляется, только если во встроенном version новее (N5, ADR 0101); прежняя
 * копия (возможно, с вашими правками) уходит в skills/.previous/<имя>-<версия>.
 * Возвращает число установленных и обновлённых.
 */
export function installBundledSkills(sourceDir, { target = path.join(dataDir(), 'skills') } = {}) {
  if (!sourceDir || !fs.existsSync(sourceDir)) return 0;
  fs.mkdirSync(target, { recursive: true });
  let installed = 0;
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const from = path.join(sourceDir, entry.name);
    const to = path.join(target, entry.name);
    if (fs.existsSync(to)) {
      const have = skillVersion(to);
      const bundled = skillVersion(from);
      if (!bundled || compareSkillVersions(bundled, have) <= 0) continue;
      const backup = path.join(target, '.previous', `${entry.name}-${have || 'без-версии'}`);
      removeTree(backup);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.renameSync(to, backup);
    }
    copyTree(from, to);
    installed += 1;
  }
  return installed;
}

export function createSkill(projectDir, { name, description, body, scope = 'project' }) {
  const slug = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u0400-\u04FF]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error('Нужно название навыка');
  const base =
    scope === 'global'
      ? path.join(dataDir(), 'skills')
      : path.join(projectDir, '.mai-code', 'skills');
  const dir = path.join(base, slug);
  fs.mkdirSync(dir, { recursive: true });
  const content = `---\nname: ${slug}\ndescription: ${description || ''}\n---\n\n${body || ''}\n`;
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8');
  return { name: slug, file: path.join(dir, 'SKILL.md') };
}

export function deleteSkill(file) {
  const dir = path.dirname(file);
  removeTree(dir);
  return true;
}

export function agentsFile(projectDir) {
  return path.join(projectDir || '', 'AGENTS.md');
}

export function globalAgentsFile() {
  return path.join(dataDir(), 'AGENTS.md');
}

export function readAgents(projectDir) {
  const result = { project: '', global: '', projectFile: agentsFile(projectDir), globalFile: globalAgentsFile() };
  try {
    result.project = fs.readFileSync(result.projectFile, 'utf8');
  } catch {
    result.project = '';
  }
  try {
    result.global = fs.readFileSync(result.globalFile, 'utf8');
  } catch {
    result.global = '';
  }
  return result;
}

export function writeAgents(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return true;
}

/* ---------- memory.md ---------- */

export function memoryFiles(projectDir) {
  return {
    projectFile: path.join(projectDir || '', '.mai-code', 'memory.md'),
    globalFile: path.join(dataDir(), 'memory.md'),
  };
}

export function readMemory(projectDir) {
  const files = memoryFiles(projectDir);
  const result = { project: '', global: '', ...files };
  try {
    result.project = fs.readFileSync(files.projectFile, 'utf8');
  } catch {
    result.project = '';
  }
  try {
    result.global = fs.readFileSync(files.globalFile, 'utf8');
  } catch {
    result.global = '';
  }
  return result;
}

export function writeMemory(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(content ?? ''), 'utf8');
  return true;
}
