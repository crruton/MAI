import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { withFileLock, renameWithRetry } from './file-lock.js';
import { listSkills, readAgents } from './skills.js';
import { pluginDirs } from './plugins.js';

/**
 * Локальное версионируемое хранилище артефактов проекта.
 *
 * Раскладка:
 *   <проект>/.mai-code/artifacts/index.json      — метаданные и история версий
 *   <проект>/.mai-code/artifacts/blobs/<sha256>  — содержимое версий (content-addressed)
 *   <проект>/.mai-code/artifacts/files/<kind>/…  — актуальная версия для git
 *
 * Хранилище не зависит от Postgres и работает офлайн. Postgres/SeaweedFS —
 * опциональная синхронизация (см. infra.js).
 */

const KINDS = ['skill', 'agents', 'memory', 'openspec', 'adr', 'diagram', 'openapi', 'note', 'plugin'];

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
};

export function slugify(value) {
  const text = String(value || '').trim().toLowerCase();
  const latin = [...text].map((ch) => TRANSLIT[ch] ?? ch).join('');
  return (
    latin
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || `artifact-${crypto.randomBytes(3).toString('hex')}`
  );
}

export function artifactsRoot(projectDir) {
  return path.join(projectDir || '', '.mai-code', 'artifacts');
}

function indexPath(projectDir) {
  return path.join(artifactsRoot(projectDir), 'index.json');
}

function blobPath(projectDir, hash) {
  return path.join(artifactsRoot(projectDir), 'blobs', hash);
}

function mirrorExt(kind) {
  if (kind === 'openapi') return '.json';
  if (kind === 'diagram') return '.puml';
  if (kind === 'plugin') return '.js';
  return '.md';
}

function mirrorPath(projectDir, artifact) {
  return path.join(artifactsRoot(projectDir), 'files', artifact.kind, `${artifact.slug}${mirrorExt(artifact.kind)}`);
}

function ensureRoot(projectDir) {
  fs.mkdirSync(path.join(artifactsRoot(projectDir), 'blobs'), { recursive: true });
  fs.mkdirSync(path.join(artifactsRoot(projectDir), 'files'), { recursive: true });
}

function readIndex(projectDir) {
  ensureRoot(projectDir);
  try {
    const data = JSON.parse(fs.readFileSync(indexPath(projectDir), 'utf8'));
    if (!data || typeof data !== 'object') throw new Error('bad index');
    data.artifacts ??= {};
    data.version ??= 1;
    return data;
  } catch {
    return { version: 1, artifacts: {} };
  }
}

function writeIndex(projectDir, index) {
  ensureRoot(projectDir);
  index.updatedAt = new Date().toISOString();
  // Атомарно (F11, ADR 0062): читающий не увидит половину файла.
  const file = indexPath(projectDir);
  const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(index, null, 2), 'utf8');
  renameWithRetry(temp, file);
}

/* ---------- блокировка индекса (F11, ADR 0062) ---------- */

/** Изменение индекса под файловой блокировкой: два окна или процесса не перезапишут правки друг друга. */
export function withIndexLock(projectDir, fn) {
  ensureRoot(projectDir);
  return withFileLock(path.join(artifactsRoot(projectDir), 'index.lock'), fn, { busyMessage: 'Хранилище артефактов занято другим процессом — повторите позже' });
}

/** Удаляет блобы, на которые не ссылается ни одна версия ни одного артефакта. */
export function gcBlobs(projectDir) {
  return withIndexLock(projectDir, () => {
    const index = readIndex(projectDir);
    const used = new Set(Object.values(index.artifacts).flatMap((a) => (a.versions || []).map((v) => v.hash)));
    const dir = path.join(artifactsRoot(projectDir), 'blobs');
    let removed = 0;
    let bytes = 0;
    for (const name of fs.readdirSync(dir)) {
      const hash = name.replace(/\.[^.]*$/, '');
      if (used.has(hash)) continue;
      const full = path.join(dir, name);
      try {
        bytes += fs.statSync(full).size;
        fs.rmSync(full, { force: true });
        removed += 1;
      } catch {
        /* файл занят — в следующий раз */
      }
    }
    return { removed, bytes };
  });
}

function hashOf(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function summary(entry, index) {
  const current = entry.versions.find((v) => v.version === entry.current);
  return {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    slug: entry.slug,
    title: entry.title || entry.name,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    current: entry.current,
    versions: entry.versions.length,
    size: current?.size || 0,
    hash: current?.hash || '',
    meta: entry.meta || {},
    hasNote: Boolean(current?.note),
  };
}

export function listArtifacts(projectDir, { kind = '', query = '' } = {}) {
  const index = readIndex(projectDir);
  let items = Object.values(index.artifacts).map((entry) => summary(entry, index));
  if (kind) items = items.filter((a) => a.kind === kind);
  if (query) {
    const scored = searchArtifacts(projectDir, query);
    const allowed = new Set(scored.map((s) => s.id));
    items = items.filter((a) => allowed.has(a.id));
    items.sort((a, b) => scored.find((s) => s.id === b.id).score - scored.find((s) => s.id === a.id).score);
  } else {
    items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
  return items;
}

export function readArtifact(projectDir, id) {
  const index = readIndex(projectDir);
  const entry = index.artifacts[id];
  if (!entry) throw new Error(`Артефакт «${id}» не найден`);
  const version = entry.versions.find((v) => v.version === entry.current);
  let content = '';
  if (version) {
    try {
      content = fs.readFileSync(blobPath(projectDir, version.hash), 'utf8');
    } catch {
      content = '';
    }
  }
  if (!content) {
    try {
      content = fs.readFileSync(mirrorPath(projectDir, entry), 'utf8');
    } catch {
      content = '';
    }
  }
  return { ...summary(entry, index), content, meta: entry.meta || {} };
}

const writeListeners = new Set();

/** Подписка на запись артефактов (F12: автосинхронизация). Возвращает отписку. */
export function onArtifactWrite(fn) {
  writeListeners.add(fn);
  return () => writeListeners.delete(fn);
}

export function writeArtifact(projectDir, options) {
  const result = withIndexLock(projectDir, () => writeArtifactUnlocked(projectDir, options));
  if (result?.changed !== false) {
    for (const fn of writeListeners) {
      try {
        fn(projectDir, result);
      } catch {
        /* слушатель не должен ломать запись */
      }
    }
  }
  return result;
}

function writeArtifactUnlocked(projectDir, { id, kind = 'note', name, title, content = '', meta = {}, note = '' }) {
  if (!KINDS.includes(kind)) throw new Error(`Неизвестный тип артефакта: ${kind}`);
  const index = readIndex(projectDir);
  const now = new Date().toISOString();
  const text = String(content ?? '');
  const hash = hashOf(text);
  const cleanName = String(name || title || 'Без названия').trim();
  const slug = slugify(cleanName);

  let key = id || `${kind}:${slug}`;
  let entry = index.artifacts[key];

  if (!entry) {
    let suffix = 2;
    while (index.artifacts[key]) key = `${kind}:${slug}-${suffix++}`;
    entry = {
      id: key,
      kind,
      name: cleanName,
      slug: slug || key.split(':')[1],
      title: String(title || cleanName),
      createdAt: now,
      updatedAt: now,
      current: 1,
      versions: [],
      meta: {},
    };
  }

  const current = entry.versions.find((v) => v.version === entry.current);
  const changed = !current || current.hash !== hash;
  const version = changed ? entry.versions.length + 1 : entry.current;

  if (changed) {
    fs.writeFileSync(blobPath(projectDir, hash), text, 'utf8');
    entry.versions.push({
      version,
      hash,
      at: now,
      note: String(note || '').slice(0, 300),
      size: Buffer.byteLength(text, 'utf8'),
    });
    entry.current = version;
  }

  entry.name = cleanName;
  entry.title = String(title || cleanName);
  entry.meta = { ...(entry.meta || {}), ...(meta || {}) };
  entry.updatedAt = now;
  index.artifacts[key] = entry;
  writeIndex(projectDir, index);

  const mirror = mirrorPath(projectDir, entry);
  fs.mkdirSync(path.dirname(mirror), { recursive: true });
  fs.writeFileSync(mirror, text, 'utf8');

  return { ...summary(entry, index), created: !current, changed };
}

export function artifactHistory(projectDir, id) {
  const index = readIndex(projectDir);
  const entry = index.artifacts[id];
  if (!entry) throw new Error(`Артефакт «${id}» не найден`);
  return entry.versions.map((v) => ({ ...v, current: v.version === entry.current }));
}

export function readVersion(projectDir, id, version) {
  const index = readIndex(projectDir);
  const entry = index.artifacts[id];
  if (!entry) throw new Error(`Артефакт «${id}» не найден`);
  const item = entry.versions.find((v) => v.version === Number(version));
  if (!item) throw new Error(`Версия ${version} не найдена`);
  try {
    return fs.readFileSync(blobPath(projectDir, item.hash), 'utf8');
  } catch {
    return '';
  }
}

export function restoreArtifact(projectDir, id, version) {
  const content = readVersion(projectDir, id, version);
  const index = readIndex(projectDir);
  const entry = index.artifacts[id];
  return writeArtifact(projectDir, {
    id,
    kind: entry.kind,
    name: entry.name,
    title: entry.title,
    content,
    meta: entry.meta,
    note: `восстановлена версия ${version}`,
  });
}

export function deleteArtifact(projectDir, id) {
  const removed = withIndexLock(projectDir, () => {
    const index = readIndex(projectDir);
    const entry = index.artifacts[id];
    if (!entry) return false;
    delete index.artifacts[id];
    writeIndex(projectDir, index);
    try {
      fs.rmSync(mirrorPath(projectDir, entry), { force: true });
    } catch {
      /* зеркала может не быть */
    }
    return true;
  });
  // Блобы удалённого артефакта больше никому не нужны (F11).
  if (removed) gcBlobs(projectDir);
  return removed;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

export function searchArtifacts(projectDir, query) {
  const terms = tokenize(query);
  if (!terms.length) return [];
  const index = readIndex(projectDir);
  const results = [];
  for (const entry of Object.values(index.artifacts)) {
    let content = '';
    try {
      content = readArtifact(projectDir, entry.id).content;
    } catch {
      content = '';
    }
    const haystack = `${entry.name} ${entry.title} ${content}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (entry.name.toLowerCase().includes(term)) score += 8;
      let at = haystack.indexOf(term);
      let hits = 0;
      while (at !== -1 && hits < 30) {
        hits += 1;
        at = haystack.indexOf(term, at + term.length);
      }
      score += hits;
    }
    if (score > 0) results.push({ ...summary(entry, index), score });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, 50);
}

/** Простой построчный diff (LCS), достаточно для истории артефактов. */
export function diffText(oldText, newText) {
  const a = String(oldText ?? '').split(/\r?\n/);
  const b = String(newText ?? '').split(/\r?\n/);
  if (a.length * b.length > 2_000_000) {
    return [
      ...a.map((text) => ({ type: 'del', text })),
      ...b.map((text) => ({ type: 'add', text })),
    ];
  }
  const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ type: 'del', text: a[i] });
      i += 1;
    } else {
      out.push({ type: 'add', text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) out.push({ type: 'del', text: a[i++] });
  while (j < b.length) out.push({ type: 'add', text: b[j++] });
  return out;
}

export function diffArtifact(projectDir, id, fromVersion, toVersion) {
  const from = readVersion(projectDir, id, fromVersion);
  const to = toVersion ? readVersion(projectDir, id, toVersion) : readArtifact(projectDir, id).content;
  return diffText(from, to);
}

function walkFiles(dir, predicate, limit = 300) {
  const out = [];
  if (!dir || !fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length && out.length < limit) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        stack.push(full);
      } else if (predicate(full)) {
        out.push(full);
      }
    }
  }
  return out;
}

/** Импортирует существующие файлы проекта в хранилище (идемпотентно). */
export function importExisting(projectDir) {
  const imported = { skill: 0, agents: 0, plugin: 0, openspec: 0, adr: 0, skipped: 0 };
  const index = readIndex(projectDir);
  const exists = (id) => Boolean(index.artifacts[id]);

  for (const skill of listSkills(projectDir)) {
    const id = `skill:${slugify(skill.name)}`;
    const content = `---\nname: ${skill.name}\ndescription: ${skill.description || ''}\n---\n\n${skill.body || ''}\n`;
    const result = writeArtifact(projectDir, {
      id,
      kind: 'skill',
      name: skill.name,
      content,
      meta: { scope: skill.scope, file: skill.file },
      note: 'импорт из файловой системы',
    });
    if (result.changed || result.created) imported.skill += 1;
  }

  const agents = readAgents(projectDir);
  if (agents.project.trim()) {
    const r = writeArtifact(projectDir, {
      id: 'agents:project',
      kind: 'agents',
      name: 'AGENTS.md проекта',
      content: agents.project.replace(/^\uFEFF/, ''),
      meta: { file: agents.projectFile, scope: 'project' },
      note: 'импорт из файловой системы',
    });
    if (r.changed || r.created) imported.agents += 1;
  }
  if (agents.global.trim()) {
    const r = writeArtifact(projectDir, {
      id: 'agents:global',
      kind: 'agents',
      name: 'AGENTS.md глобальный',
      content: agents.global.replace(/^\uFEFF/, ''),
      meta: { file: agents.globalFile, scope: 'global' },
      note: 'импорт из файловой системы',
    });
    if (r.changed || r.created) imported.agents += 1;
  }

  for (const dir of pluginDirs(projectDir)) {
    for (const file of walkFiles(dir, (f) => f.endsWith('.js'))) {
      const name = path.basename(file, '.js');
      const id = `plugin:${slugify(name)}`;
      const r = writeArtifact(projectDir, {
        id,
        kind: 'plugin',
        name,
        content: fs.readFileSync(file, 'utf8'),
        meta: { file },
        note: 'импорт из файловой системы',
      });
      if (r.changed || r.created) imported.plugin += 1;
    }
  }

  for (const file of walkFiles(path.join(projectDir, 'openspec'), (f) => f.endsWith('.md'))) {
    const rel = path.relative(projectDir, file).replace(/\\/g, '/');
    const r = writeArtifact(projectDir, {
      id: `openspec:${slugify(rel)}`,
      kind: 'openspec',
      name: rel,
      content: fs.readFileSync(file, 'utf8'),
      meta: { file },
      note: 'импорт из файловой системы',
    });
    if (r.changed || r.created) imported.openspec += 1;
  }

  for (const base of ['docs/adr', 'docs/decisions']) {
    for (const file of walkFiles(path.join(projectDir, base), (f) => f.endsWith('.md'))) {
      const rel = path.relative(projectDir, file).replace(/\\/g, '/');
      const r = writeArtifact(projectDir, {
        id: `adr:${slugify(rel)}`,
        kind: 'adr',
        name: rel,
        content: fs.readFileSync(file, 'utf8'),
        meta: { file },
        note: 'импорт из файловой системы',
      });
      if (r.changed || r.created) imported.adr += 1;
    }
  }

  return { imported, stats: stats(projectDir) };
}

export function stats(projectDir) {
  const index = readIndex(projectDir);
  const byKind = {};
  let versions = 0;
  let bytes = 0;
  for (const entry of Object.values(index.artifacts)) {
    byKind[entry.kind] = (byKind[entry.kind] || 0) + 1;
    versions += entry.versions.length;
    const current = entry.versions.find((v) => v.version === entry.current);
    bytes += current?.size || 0;
  }
  return {
    total: Object.keys(index.artifacts).length,
    versions,
    bytes,
    byKind,
    root: artifactsRoot(projectDir),
    updatedAt: index.updatedAt || '',
  };
}

export function exportArtifact(projectDir, id, targetFile) {
  const artifact = readArtifact(projectDir, id);
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, artifact.content, 'utf8');
  return targetFile;
}
