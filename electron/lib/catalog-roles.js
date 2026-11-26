/**
 * Наборы навыков каталога по ролям (E1.7, ADR 0115).
 *
 * Поле `roles` в `mai-marketplace.json`: `{ "<роль>": ["навык", …] }`. Его читают мастер
 * первого запуска (роль ставит свои навыки из каталога), отдача в Multica и экспорт в
 * другие агенты. Окно пакетов поле не использует и не ломается на нём. Без Electron.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CATALOG, catalogDir, installFromMarketplace, compareVersions } from './marketplace.js';
import { listPackages } from './packages.js';

export const ROLE_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

function readIndex(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, CATALOG), 'utf8'));
  } catch {
    return null;
  }
}

/** Роли каталога: `{ id: [навыки] }`. Нет поля — пустой объект. */
export function catalogRoles(root) {
  const roles = readIndex(root)?.roles;
  return roles && typeof roles === 'object' && !Array.isArray(roles) ? roles : {};
}

/** Навыки роли. Неизвестная роль — ошибка со списком ролей. */
export function roleSkillNames(root, role) {
  const roles = catalogRoles(root);
  if (!Object.hasOwn(roles, role)) {
    const known = Object.keys(roles);
    throw new Error(`В каталоге нет роли «${role}»${known.length ? `: ${known.join(', ')}` : ''}`);
  }
  return [...roles[role]];
}

/** Ошибки поля `roles` для проверки каталога. */
export function validateRoles(index) {
  const errors = [];
  if (index?.roles === undefined) return errors;
  const roles = index.roles;
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) return ['roles — объект { роль: [навыки] }'];
  const names = new Set((index.packages || []).map((p) => p?.name));
  for (const [id, list] of Object.entries(roles)) {
    if (!ROLE_ID_RE.test(id)) errors.push(`roles: неверное имя роли «${id}»`);
    if (!Array.isArray(list) || list.length === 0) {
      errors.push(`roles.${id}: непустой список навыков`);
      continue;
    }
    for (const name of list) if (!names.has(name)) errors.push(`roles.${id}: навыка «${name}» нет в каталоге`);
    if (new Set(list).size !== list.length) errors.push(`roles.${id}: навык повторяется`);
  }
  return errors;
}

/**
 * Ставит навыки роли из каталога в `<данные>/packages`. Уже стоящий навык той же или
 * более новой версии не трогается; более старый обновляется.
 * @param {{ market: { name, url }, role: string, dataDir: string, git?: string }} options
 * @returns {{ installed: string[], updated: string[], skipped: string[], errors: string[] }}
 */
export function installRoleSkills({ market, role, dataDir, git = 'git' }) {
  const root = catalogDir(market, dataDir);
  const report = { installed: [], updated: [], skipped: [], errors: [] };
  let names;
  try {
    names = roleSkillNames(root, role);
  } catch {
    return report; // в каталоге нет такой роли — ставить нечего
  }
  const index = readIndex(root);
  const current = new Map(listPackages(null, dataDir, { includeProject: false }).filter((p) => p.source === 'global').map((p) => [p.name, p.version]));
  for (const name of names) {
    const entry = index.packages.find((p) => p.name === name);
    const have = current.get(name);
    if (have && compareVersions(entry.version, have) <= 0) {
      report.skipped.push(name);
      continue;
    }
    try {
      installFromMarketplace({ market, name, dataDir, replace: Boolean(have), git });
      (have ? report.updated : report.installed).push(name);
    } catch (err) {
      report.errors.push(`${name}: ${err.message}`);
    }
  }
  return report;
}
