/**
 * Наборы по ролям (CW6.1, ADR 0070): пакеты из папки `roles/` приложения с
 * полем `role` в манифесте. Онбординг (CW6.2) показывает их карточками и ставит
 * выбранный в глобальные пакеты.
 *
 * Копируем сами (readdir/readFile), а не `fs.cpSync`: в собранном приложении
 * папка лежит внутри asar, а `cpSync` его не читает. Набор — только Markdown
 * (навыки и команды): исполняемое (plugins, hooks, mcp) в наборе роли не ставится.
 *
 * Модуль не зависит от Electron.
 */
import fs from 'node:fs';
import path from 'node:path';
import { MANIFEST, NAME_RE, readJson, readPackage } from './packages.js';

const ROLE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const SAFE_PARTS = new Set(['commands', 'skills', 'agents', MANIFEST, 'README.md']);

function cleanRole(manifest, dir) {
  const role = manifest?.role;
  const name = String(manifest?.name || '');
  if (!role || !ROLE_ID.test(String(role.id || '')) || !NAME_RE.test(name)) return null;
  const list = (value, max) => (Array.isArray(value) ? value.map((v) => String(v).slice(0, 200)).filter(Boolean).slice(0, max) : []);
  return {
    id: role.id,
    title: String(role.title || role.id).slice(0, 40),
    icon: String(role.icon || '').slice(0, 4),
    summary: String(role.summary || manifest.description || '').slice(0, 300),
    connectors: list(role.connectors, 8),
    examples: list(role.examples, 5),
    package: name,
    version: String(manifest.version || ''),
    dir,
  };
}

/** Наборы ролей из папки приложения, по порядку в `order` (остальные — по имени). */
export function listRoles(rolesDir, { order = ['developer', 'analyst', 'lawyer', 'sales', 'finance'] } = {}) {
  let entries = [];
  try {
    entries = fs.readdirSync(rolesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const roles = entries
    .filter((e) => e.isDirectory())
    .map((e) => cleanRole(readJson(path.join(rolesDir, e.name, MANIFEST)), path.join(rolesDir, e.name)))
    .filter(Boolean);
  const rank = (r) => (order.includes(r.id) ? order.indexOf(r.id) : order.length);
  return roles.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else if (entry.isFile()) fs.writeFileSync(dst, fs.readFileSync(src));
  }
}

/**
 * Ставит набор роли в `<данные>/packages/<имя>` (заменяя прежнюю версию).
 * @returns {object} пакет (readPackage) и роль
 */
export function installRole({ id, rolesDir, dataDir }) {
  const role = listRoles(rolesDir).find((r) => r.id === id);
  if (!role) throw new Error(`Нет набора роли «${id}»`);
  const target = path.join(dataDir, 'packages', role.package);
  const temp = `${target}.new-${process.pid}`;
  fs.rmSync(temp, { recursive: true, force: true });
  fs.mkdirSync(temp, { recursive: true });
  for (const entry of fs.readdirSync(role.dir, { withFileTypes: true })) {
    if (!SAFE_PARTS.has(entry.name)) continue;
    const src = path.join(role.dir, entry.name);
    if (entry.isDirectory()) copyTree(src, path.join(temp, entry.name));
    else fs.writeFileSync(path.join(temp, entry.name), fs.readFileSync(src));
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(temp, target);
  return { role, package: readPackage(target, 'global') };
}
