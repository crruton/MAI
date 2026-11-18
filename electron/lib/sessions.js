import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from './config.js';

function sessionsFile() {
  return path.join(dataDir(), 'sessions.json');
}

export function listSessions() {
  try {
    const all = JSON.parse(fs.readFileSync(sessionsFile(), 'utf8'));
    return all
      .map(({ id, title, model, projectDir, permissionMode, createdAt, updatedAt, messages }) => ({
        id,
        title,
        model,
        projectDir,
        permissionMode: permissionMode || '',
        createdAt,
        updatedAt,
        count: Array.isArray(messages) ? messages.filter((m) => m.role === 'user').length : 0,
      }))
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  } catch {
    return [];
  }
}

function readAll() {
  try {
    const all = JSON.parse(fs.readFileSync(sessionsFile(), 'utf8'));
    return Array.isArray(all) ? all : [];
  } catch {
    return [];
  }
}

/** Атомарная запись: временный файл + rename, чтобы сбой не оставил обрезанный JSON. */
function writeAll(all) {
  const file = sessionsFile();
  const temp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, JSON.stringify(all, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

/**
 * Поля, которые меняются только своими функциями (setSessionMode,
 * addSessionRules). Прогон агента держит копию сессии со старыми значениями,
 * и без этого финальный saveSession откатил бы режим, выбранный посреди прогона.
 */
const OWNED_FIELDS = ['permissionMode', 'permissionRules'];

export function getSession(id) {
  return readAll().find((s) => s.id === id) || null;
}

export function createSession({ title, model, projectDir, permissionMode }) {
  const now = new Date().toISOString();
  const session = {
    id: crypto.randomUUID(),
    title: title || 'Новый чат',
    model: model || '',
    projectDir: projectDir || '',
    // Режим разрешений живёт в сессии. Пустое значение означает «взять
    // значение по умолчанию из настроек» — так старые сессии продолжают работать.
    permissionMode: permissionMode || '',
    permissionRules: { allow: [], ask: [], deny: [] },
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  const all = readAll();
  all.push(session);
  writeAll(all);
  return session;
}

/** Меняет режим разрешений одной сессии. Возвращает обновлённую сессию. */
export function setSessionMode(id, mode) {
  const all = readAll();
  const session = all.find((s) => s.id === id);
  if (!session) return null;
  session.permissionMode = mode || '';
  session.updatedAt = new Date().toISOString();
  writeAll(all);
  return session;
}

export function saveSession(session) {
  const all = readAll();
  const index = all.findIndex((s) => s.id === session.id);
  session.updatedAt = new Date().toISOString();
  if (index === -1) {
    all.push(session);
  } else {
    for (const field of OWNED_FIELDS) {
      if (all[index][field] !== undefined) session[field] = all[index][field];
    }
    all[index] = session;
  }
  writeAll(all);
  return session;
}

/** Добавляет правила разрешений в сессию («да, и не спрашивать в этом чате»). */
export function addSessionRules(id, kind, rules) {
  const all = readAll();
  const session = all.find((s) => s.id === id);
  if (!session) return null;
  const key = ['allow', 'ask', 'deny'].includes(kind) ? kind : 'allow';
  session.permissionRules ||= { allow: [], ask: [], deny: [] };
  session.permissionRules[key] ||= [];
  for (const rule of rules || []) {
    if (rule && !session.permissionRules[key].includes(rule)) session.permissionRules[key].push(rule);
  }
  session.updatedAt = new Date().toISOString();
  writeAll(all);
  return session;
}

export function deleteSession(id) {
  writeAll(readAll().filter((s) => s.id !== id));
  return true;
}

/** Удаляет правила из всех списков сессии. */
export function removeSessionRules(id, rules) {
  const all = readAll();
  const session = all.find((s) => s.id === id);
  if (!session?.permissionRules) return session || null;
  const drop = new Set(rules || []);
  for (const key of ['allow', 'ask', 'deny']) {
    session.permissionRules[key] = (session.permissionRules[key] || []).filter((rule) => !drop.has(rule));
  }
  session.updatedAt = new Date().toISOString();
  writeAll(all);
  return session;
}
