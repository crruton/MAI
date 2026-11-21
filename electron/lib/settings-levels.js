/**
 * Уровни настроек (бэклог CC2.4, ADR 0038).
 *
 *   managed  — файл организации на машине: правила, хуки, запрет «Без вопросов».
 *              Пользователь и проект его не отменяют.
 *   user     — settings.json пользователя (как раньше).
 *   project  — `<проект>/.mai-code/settings.json`, хранится в git, общий для команды.
 *   local    — `<проект>/.mai-code/settings.local.json`, личный, не для git.
 *   session  — правила чата.
 *
 * Проектный и локальный уровни читаются только для доверенной папки (ADR 0028).
 * Правила уровней объединяются; `deny` с любого уровня сильнее любого `allow`.
 *
 * Модуль не зависит от Electron.
 */
import fs from 'node:fs';
import path from 'node:path';

export const LEVELS = ['managed', 'user', 'project', 'local', 'session'];
const KINDS = ['allow', 'ask', 'deny'];

/** Путь к управляемым настройкам: переменная MAI_MANAGED_SETTINGS или системная папка ОС. */
export function managedSettingsPath({ platform = process.platform, env = process.env } = {}) {
  if (env.MAI_MANAGED_SETTINGS) return env.MAI_MANAGED_SETTINGS;
  if (platform === 'win32') return path.join(env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData', 'mai-code', 'managed-settings.json');
  if (platform === 'darwin') return '/Library/Application Support/mai-code/managed-settings.json';
  return '/etc/mai-code/managed-settings.json';
}

function readJson(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

function cleanRules(raw) {
  const out = { allow: [], ask: [], deny: [] };
  for (const kind of KINDS) {
    const list = Array.isArray(raw?.[kind]) ? raw[kind] : [];
    for (const rule of list) if (typeof rule === 'string' && rule.trim() && !out[kind].includes(rule.trim())) out[kind].push(rule.trim());
  }
  return out;
}

export function readManaged(file = managedSettingsPath()) {
  const data = readJson(file);
  return {
    file,
    present: Boolean(data),
    permissions: cleanRules(data?.permissions),
    hooks: data?.hooks && typeof data.hooks === 'object' ? data.hooks : null,
    disableBypassMode: data?.disableBypassMode === true || data?.permissions?.disableBypassMode === true,
    // Каталог коннекторов организации (ADR 0052).
    connectors: Array.isArray(data?.connectors) ? data.connectors : [],
    onlyManagedConnectors: data?.onlyManagedConnectors === true,
  };
}

export function projectSettingsFiles(projectDir) {
  return {
    project: path.join(projectDir, '.mai-code', 'settings.json'),
    local: path.join(projectDir, '.mai-code', 'settings.local.json'),
  };
}

/** Правила проекта и локальные. Без доверия — пусто. */
export function readProjectLevels(projectDir, { trusted = false } = {}) {
  if (!projectDir || !trusted) return { project: cleanRules(null), local: cleanRules(null) };
  const files = projectSettingsFiles(projectDir);
  return {
    project: cleanRules(readJson(files.project)?.permissions),
    local: cleanRules(readJson(files.local)?.permissions),
  };
}

/**
 * Сводит правила уровней. Возвращает правила для PolicyEngine и откуда каждое
 * правило пришло (для панели «Разрешения» и журнала).
 * @param {Array<{ level: string, rules: object }>} sources
 */
export function mergeLevels(sources) {
  const rules = { allow: [], ask: [], deny: [] };
  const origin = {};
  for (const { level, rules: raw } of sources) {
    const clean = cleanRules(raw);
    for (const kind of KINDS) {
      for (const rule of clean[kind]) {
        if (!rules[kind].includes(rule)) rules[kind].push(rule);
        const key = `${kind}:${rule}`;
        (origin[key] ||= []).includes(level) || origin[key].push(level);
      }
    }
  }
  return { rules, origin };
}

/** Личный файл не должен попасть в git: строка в `.mai-code/.gitignore`. */
export function ignoreLocal(dir, name = 'settings.local.json') {
  const file = path.join(dir, '.gitignore');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    /* файла нет */
  }
  if (text.split(/\r?\n/).some((line) => line.trim() === name)) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${name}\n`, 'utf8');
}

/**
 * Личные MCP-серверы проекта (CC9.5): `.mai-code/mcp.local.json`, не для git.
 * `config: null` удаляет сервер.
 */
export function updateLocalMcp(projectDir, name, config) {
  const dir = path.join(projectDir, '.mai-code');
  const file = path.join(dir, 'mcp.local.json');
  const data = readJson(file) || {};
  const servers = { ...(data.mcpServers || {}) };
  if (config) servers[name] = config;
  else delete servers[name];
  fs.mkdirSync(dir, { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ ...data, mcpServers: servers }, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
  ignoreLocal(dir, 'mcp.local.json');
  return servers;
}

/** Добавляет или убирает правила в settings.local.json проекта (личные правила). */
export function updateLocalRules(projectDir, { kind = 'allow', add = [], remove = [] } = {}) {
  if (!KINDS.includes(kind)) throw new Error(`Неизвестный вид правила: ${kind}`);
  const file = projectSettingsFiles(projectDir).local;
  const data = readJson(file) || {};
  const permissions = cleanRules(data.permissions);
  const drop = new Set(remove);
  for (const k of KINDS) permissions[k] = permissions[k].filter((r) => !drop.has(r));
  for (const rule of add) if (rule && !permissions[kind].includes(rule)) permissions[kind].push(rule);
  const next = { ...data, permissions };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
  ignoreLocal(path.dirname(file));
  return permissions;
}
