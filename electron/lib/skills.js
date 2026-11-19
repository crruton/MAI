import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.js';

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

export function skillDirs(projectDir) {
  return [
    { scope: 'project', dir: path.join(projectDir || '', '.mai-code', 'skills') },
    { scope: 'project', dir: path.join(projectDir || '', '.opencode', 'skills') },
    { scope: 'global', dir: path.join(dataDir(), 'skills') },
  ];
}

/** Навыки. Без доверия к папке навыки проекта не попадают к агенту (ADR 0028). */
export function listSkills(projectDir, { includeProject = true } = {}) {
  const skills = [];
  for (const { scope, dir } of skillDirs(projectDir)) {
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
        body,
        file,
        scope,
        dir,
      });
    }
  }
  return skills;
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

export function installBundledSkills(sourceDir) {
  if (!sourceDir || !fs.existsSync(sourceDir)) return 0;
  const target = path.join(dataDir(), 'skills');
  fs.mkdirSync(target, { recursive: true });
  let installed = 0;
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const to = path.join(target, entry.name);
    if (fs.existsSync(to)) continue;
    copyTree(path.join(sourceDir, entry.name), to);
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
  fs.rmSync(dir, { recursive: true, force: true });
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
