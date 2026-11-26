/**
 * Навыки каталога MAI → Multica MAI (E1.8, ADR 0113).
 *
 * Без Electron: вызов CLI передаётся параметром `run(args, { cwd })` и возвращает stdout.
 * Свои навыки помечаются `config.managed_by = "mai-code"` с версией и хэшем содержимого.
 * Навык с тем же именем, созданный вручную, не трогается. Удаление — только своих и
 * только с `prune`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CATALOG } from './marketplace.js';
import { frontmatter } from './catalog-check.js';
import { targetArgs, pickList } from './multica-target.js';

export const MANAGED_BY = 'mai-code';
const MAX_FILE = 512 * 1024;

/** Концы строк зависят от ОС и настроек git: хэш и загрузка — всегда с LF. */
const lf = (text) => String(text).replace(/\r\n/g, '\n');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return out;
}

/** Хэш навыка: SKILL.md и файлы с путями. Меняется при любой правке содержимого. */
export function skillHash(skill) {
  const h = crypto.createHash('sha256');
  h.update(skill.content);
  for (const f of skill.files) h.update(`\0${f.path}\0${f.content}`);
  return h.digest('hex').slice(0, 16);
}

/**
 * Навыки каталога. `names` — только эти (пусто — все).
 * @returns {Array<{ name, version, description, dir, content, files: Array<{ path, content }>, hash }>}
 */
export function collectCatalogSkills(root, names = []) {
  const index = readJson(path.join(root, CATALOG));
  if (!index || !Array.isArray(index.packages)) throw new Error(`${CATALOG}: нет списка packages`);
  const wanted = new Set(names);
  const skills = [];
  for (const entry of index.packages) {
    if (wanted.size && !wanted.has(entry.name)) continue;
    const pkgDir = path.resolve(root, String(entry.source || ''));
    const skillsDir = path.join(pkgDir, 'skills');
    if (!fs.existsSync(skillsDir)) continue;
    for (const d of fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory())) {
      const dir = path.join(skillsDir, d.name);
      const skillFile = path.join(dir, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      const content = lf(fs.readFileSync(skillFile, 'utf8'));
      const fm = frontmatter(content) || {};
      const files = [];
      for (const rel of walk(dir)) {
        if (rel === 'SKILL.md') continue;
        const buf = fs.readFileSync(path.join(dir, rel));
        if (buf.length > MAX_FILE || buf.includes(0)) continue; // двоичные и большие файлы Multica не отдаём
        files.push({ path: rel, content: lf(buf.toString('utf8')) });
      }
      const skill = { name: fm.name || d.name, version: fm.version || entry.version || '', description: fm.description || entry.description || '', dir, content, files };
      skill.hash = skillHash(skill);
      skills.push(skill);
    }
  }
  if (wanted.size) {
    const missing = [...wanted].filter((n) => !skills.some((s) => s.name === n));
    if (missing.length) throw new Error(`Нет в каталоге: ${missing.join(', ')}`);
  }
  return skills;
}

/** stdout CLI → JSON: текст до первой скобки отбрасывается. */
export function parseCliJson(raw, fallback) {
  const text = String(raw || '').trim();
  if (!text) return fallback;
  const starts = [text.indexOf('{'), text.indexOf('[')].filter((i) => i >= 0);
  return JSON.parse(starts.length ? text.slice(Math.min(...starts)) : text);
}

function parseConfig(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw || '{}'));
  } catch {
    return {};
  }
}

export function normalizeRemoteSkills(data) {
  return pickList(data, ['skills', 'items', 'data'])
    .map((s) => ({ id: String(s.id || ''), name: String(s.name || ''), config: parseConfig(s.config) }))
    .filter((s) => s.id && s.name);
}

/**
 * План: create — нет в Multica; update — свой навык, другой хэш; unchanged — совпадает;
 * conflict — навык с этим именем не наш; delete — свой, пропал из каталога (только prune).
 */
export function planSkillPush(local, remote, { prune = false } = {}) {
  const byName = new Map(remote.map((r) => [r.name, r]));
  const actions = [];
  for (const skill of local) {
    const existing = byName.get(skill.name);
    if (!existing) actions.push({ action: 'create', name: skill.name, skill });
    else if (existing.config?.managed_by !== MANAGED_BY) actions.push({ action: 'conflict', name: skill.name, id: existing.id, reason: 'навык с этим именем создан не из каталога — не трогаю' });
    else if (existing.config.hash === skill.hash && existing.config.version === skill.version) actions.push({ action: 'unchanged', name: skill.name, id: existing.id });
    else actions.push({ action: 'update', name: skill.name, id: existing.id, skill, from: existing.config.version || '' });
  }
  if (prune) {
    const names = new Set(local.map((s) => s.name));
    for (const r of remote) if (r.config?.managed_by === MANAGED_BY && !names.has(r.name)) actions.push({ action: 'delete', name: r.name, id: r.id });
  }
  return actions;
}

function configFor(skill, source) {
  return JSON.stringify({ managed_by: MANAGED_BY, version: skill.version, hash: skill.hash, source });
}

function idFromOutput(raw) {
  try {
    const data = parseCliJson(raw, {});
    return String(data.id || data.skill?.id || '');
  } catch {
    return '';
  }
}

/** Читает навыки workspace; `config` берёт из `skill get`, если `list` его не отдал. */
export function remoteSkills(run, target = {}) {
  const ws = targetArgs(target);
  const list = normalizeRemoteSkills(parseCliJson(run([...ws, 'skill', 'list', '--output', 'json']), []));
  for (const skill of list) {
    if (Object.keys(skill.config).length) continue;
    try {
      const full = parseCliJson(run([...ws, 'skill', 'get', skill.id, '--output', 'json']), {});
      skill.config = parseConfig(full.config ?? full.skill?.config);
    } catch {
      /* без config навык считается чужим — безопасно */
    }
  }
  return list;
}

/** Копия навыка с LF во временной папке: CLI читает файлы относительно неё. */
function materialize(skill) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-skill-'));
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skill.content);
  for (const f of skill.files) {
    const target = path.join(dir, ...f.path.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.content);
  }
  return dir;
}

/**
 * Отдаёт навыки каталога в Multica.
 * @returns {{ ok: true, dryRun, created, updated, unchanged, conflicts, deleted, actions }}
 */
export function pushSkills({ root, run, target = {}, names = [], prune = false, dryRun = false, source = 'mai-team' }) {
  const local = collectCatalogSkills(root, names);
  const remote = remoteSkills(run, target);
  const actions = planSkillPush(local, remote, { prune: prune && names.length === 0 });
  const ws = targetArgs(target);
  if (!dryRun) {
    for (const a of actions) {
      if (a.action === 'create' || a.action === 'update') {
        const s = { ...a.skill, dir: materialize(a.skill) };
        try {
          const base = a.action === 'create'
            ? [...ws, 'skill', 'create', '--name', s.name]
            : [...ws, 'skill', 'update', a.id];
          const out = run([...base, '--description', s.description.slice(0, 1000), '--content-file', 'SKILL.md', '--config', configFor(s, source), '--output', 'json'], { cwd: s.dir });
          const id = a.id || idFromOutput(out);
          if (!id) throw new Error(`${s.name}: Multica не вернула id навыка`);
          a.id = id;
          for (const f of s.files) run([...ws, 'skill', 'files', 'upsert', id, '--path', f.path, '--content-file', f.path, '--output', 'json'], { cwd: s.dir });
        } finally {
          fs.rmSync(s.dir, { recursive: true, force: true });
        }
      } else if (a.action === 'delete') {
        run([...ws, 'skill', 'delete', a.id, '--yes']);
      }
    }
  }
  const count = (kind) => actions.filter((a) => a.action === kind).length;
  return {
    ok: true,
    dryRun,
    created: count('create'),
    updated: count('update'),
    unchanged: count('unchanged'),
    conflicts: count('conflict'),
    deleted: count('delete'),
    actions: actions.map(({ skill, ...rest }) => rest),
    message: dryRun
      ? `План: создать ${count('create')}, обновить ${count('update')}, без изменений ${count('unchanged')}, конфликтов ${count('conflict')}${prune ? `, удалить ${count('delete')}` : ''}`
      : `Каталог → Multica: создано ${count('create')}, обновлено ${count('update')}, без изменений ${count('unchanged')}, конфликтов ${count('conflict')}${prune ? `, удалено ${count('delete')}` : ''}`,
  };
}
