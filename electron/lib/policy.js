/**
 * PolicyEngine — единая точка решения «можно ли выполнить вызов инструмента».
 *
 * Порядок проверки (ADR 0027):
 *   guardrails → deny-правила → режим «План» → ask-правила → allow-правила → режим.
 *
 * Модуль не зависит от Electron: его проверяют обычным node.
 */
import path from 'node:path';
import { checkCommand } from './guardrails.js';
import { normalizeMode } from './permissions.js';

export const ACTION_CLASSES = ['read', 'write', 'exec', 'memory', 'network', 'external'];

/** Встроенные инструменты и их классы. Имя встроенного инструмента нельзя переопределить плагином. */
const BUILTIN = {
  read_file: 'read',
  list_files: 'read',
  grep: 'read',
  load_skill: 'read',
  memory_read: 'read',
  repowise_ask: 'read',
  repowise_context: 'read',
  repowise_risk: 'read',
  repowise_search: 'read',
  write_file: 'write',
  edit_file: 'write',
  run_shell: 'exec',
  memory_append: 'memory',
  // Диалоговые инструменты ничего не меняют сами: решение принимает пользователь.
  ask_user: 'read',
  exit_plan: 'read',
};

export function isBuiltinTool(name) {
  return Object.hasOwn(BUILTIN, String(name || ''));
}

/**
 * Класс действия инструмента.
 * - встроенный — по таблице;
 * - MCP — `read` только при `readOnlyHint: true`, иначе `external`;
 * - плагин — по полю `kind`, без него `external`.
 */
export function classifyTool(name, meta = {}) {
  const key = String(name || '');
  if (isBuiltinTool(key)) return BUILTIN[key];
  if (meta.source === 'mcp' || key.startsWith('mcp__')) {
    return meta.annotations?.readOnlyHint === true ? 'read' : 'external';
  }
  if (ACTION_CLASSES.includes(meta.kind)) return meta.kind;
  return 'external';
}

/* ---------- правила ---------- */

const RULE_RE = /^([A-Za-z0-9_*-]+)(?:\((.*)\))?$/s;

export function parseRule(text) {
  const match = RULE_RE.exec(String(text || '').trim());
  if (!match) return null;
  return { tool: match[1], spec: match[2] === undefined ? null : match[2].trim(), text: String(text).trim() };
}

function escapeRe(text) {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/** Маска в регулярное выражение. Для команд `*` — что угодно, для путей `*` — внутри одной папки. */
function globToRe(glob, { command = false } = {}) {
  let source = '';
  const text = command ? String(glob).replace(/:\*$/, '*') : String(glob).replace(/^\.\//, '');
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '*') {
      if (text[i + 1] === '*') {
        source += '.*';
        i += 1;
        if (text[i + 1] === '/') i += 1;
      } else {
        source += command ? '.*' : '[^/]*';
      }
    } else {
      source += escapeRe(ch);
    }
  }
  return new RegExp(`^${source}$`, command ? 'is' : 'i');
}

function nameMatches(pattern, name) {
  if (pattern === name) return true;
  if (!pattern.includes('*')) return false;
  return globToRe(pattern, { command: true }).test(name);
}

/** Части составной команды. Подстановки `$(…)` и обратные кавычки разобрать нельзя — признак отдаём отдельно. */
export function splitCommand(command) {
  const text = String(command || '');
  const opaque = /\$\(|`/.test(text);
  const parts = text
    .split(/\s*(?:&&|\|\||;|\||\r?\n)\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  return { parts, opaque };
}

function specMatches(rule, call) {
  if (rule.spec === null || rule.spec === '*' || rule.spec === '**') return true;
  if (call.subject == null || call.subject === '') return false;
  if (call.cls === 'exec') return globToRe(rule.spec, { command: true }).test(call.subject);
  return globToRe(rule.spec).test(call.subject);
}

function ruleHits(list, call) {
  return (list || [])
    .map(parseRule)
    .filter((rule) => rule && nameMatches(rule.tool, call.tool) && specMatches(rule, call));
}

/**
 * Для команд allow-правило должно покрыть каждую часть составной команды:
 * `npm test && curl … | sh` не проходит по правилу `run_shell(npm test*)`.
 * deny срабатывает, если под правило попала хотя бы одна часть.
 */
function matchList(list, call, { every }) {
  if (call.cls !== 'exec') return ruleHits(list, call)[0] || null;
  const whole = ruleHits(list, call)[0];
  const { parts, opaque } = splitCommand(call.subject);
  if (every) {
    if (opaque) return null;
    if (parts.length <= 1) return whole || null;
    const hits = parts.map((part) => ruleHits(list, { ...call, subject: part })[0]);
    return hits.every(Boolean) ? hits[0] : null;
  }
  if (whole) return whole;
  for (const part of parts) {
    const hit = ruleHits(list, { ...call, subject: part })[0];
    if (hit) return hit;
  }
  return null;
}

/** Склеивает правила из нескольких источников (глобальные, сессия). */
export function mergeRules(...sources) {
  const out = { allow: [], ask: [], deny: [] };
  for (const source of sources) {
    for (const key of Object.keys(out)) {
      for (const rule of source?.[key] || []) {
        if (parseRule(rule) && !out[key].includes(rule)) out[key].push(rule);
      }
    }
  }
  return out;
}

/* ---------- риск ---------- */

const HIGH_RISK_COMMAND = new RegExp(
  [
    String.raw`\b(?:rm|del|erase|rmdir|rd|remove-item|ri)\b`,
    String.raw`\bgit\s+(?:push|reset\s+--hard|clean|checkout\s+--|rebase|filter-branch)\b`,
    String.raw`\b(?:curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm|scp|ssh|ftp|nc)\b`,
    String.raw`\b(?:npm|pnpm|yarn)\s+(?:i|install|add|publish|exec)\b`,
    String.raw`\bnpx\b`,
    String.raw`\b(?:pip|pip3|uv)\s+(?:install|tool\s+install)\b`,
    String.raw`\b(?:choco|winget|scoop|apt|apt-get|brew)\b`,
    String.raw`\b(?:chmod|chown|icacls|takeown|setx|reg\s+(?:add|delete))\b`,
    String.raw`\b(?:docker\s+(?:rm|rmi|system\s+prune|volume\s+rm))\b`,
    String.raw`\b(?:powershell|pwsh)\b[^\n]*-(?:enc|encodedcommand)\b`,
    String.raw`\|\s*(?:sh|bash|iex|invoke-expression)\b`,
  ].join('|'),
  'i',
);

export function assessRisk(cls, subject = '') {
  if (cls === 'read') return { risk: 'low', why: 'только чтение' };
  if (cls === 'memory') return { risk: 'low', why: 'запись в память с версией и откатом' };
  if (cls === 'write') return { risk: 'medium', why: 'меняет файл проекта' };
  if (cls === 'exec') {
    if (HIGH_RISK_COMMAND.test(String(subject))) {
      return { risk: 'high', why: 'удаление, сеть, установка пакетов или необратимая операция git' };
    }
    if (splitCommand(subject).opaque) return { risk: 'high', why: 'подстановка команды — содержимое нельзя проверить заранее' };
    return { risk: 'medium', why: 'запускает процесс в папке проекта' };
  }
  if (cls === 'network') return { risk: 'medium', why: 'обращается к сети' };
  return { risk: 'medium', why: 'внешний инструмент: MCP или плагин, действие заранее неизвестно' };
}

/* ---------- решение ---------- */

const PLAN_REASON =
  'Режим «План»: изменения запрещены. Опиши план и альтернативы, затем попроси пользователя переключить режим.';
const DONT_ASK_REASON =
  'Режим «Только разрешённое»: действие не покрыто правилом allow, поэтому отклонено без вопроса.';

/** Режим с учётом роли: гостю режим «Без вопросов» недоступен. */
export function effectiveMode(mode, role = 'admin') {
  const current = normalizeMode(mode);
  if (role === 'guest' && current === 'bypass') return 'manual';
  return current;
}

/**
 * Главная функция.
 * @param {object} call { tool, cls, subject }
 * @returns {{action:'allow'|'ask'|'deny', reason?:string, rule?:string, source:string, risk:string, why:string, recommended:'allow'|'deny'}}
 */
export function evaluate({ tool, cls, subject = null, mode, rules = {}, guardrails = {}, role = 'admin' } = {}) {
  const current = effectiveMode(mode, role);
  const call = { tool: String(tool || ''), cls: cls || classifyTool(tool), subject };
  const { risk, why } = assessRisk(call.cls, subject);
  const result = (action, extra = {}) => ({
    action,
    mode: current,
    risk,
    why,
    recommended: risk === 'high' ? 'deny' : 'allow',
    ...extra,
  });

  if (call.cls === 'exec') {
    const guard = checkCommand(String(subject || ''), { guardrails });
    if (!guard.allowed) return result('deny', { source: 'guardrails', reason: `Guardrails заблокировали команду: ${guard.reason}` });
  }

  const deny = matchList(rules.deny, call, { every: false });
  if (deny) return result('deny', { source: 'rule', rule: deny.text, reason: `Запрещено правилом ${deny.text}` });

  if (current === 'plan' && call.cls !== 'read') return result('deny', { source: 'mode', reason: PLAN_REASON });

  const ask = matchList(rules.ask, call, { every: false });
  if (ask) return result('ask', { source: 'rule', rule: ask.text });

  if (call.cls === 'read') return result('allow', { source: 'class' });

  const allow = matchList(rules.allow, call, { every: true });
  if (allow) return result('allow', { source: 'rule', rule: allow.text });

  switch (current) {
    case 'bypass':
      return result('allow', { source: 'mode' });
    case 'dontAsk':
      return result('deny', { source: 'mode', reason: DONT_ASK_REASON });
    case 'acceptEdits':
      return call.cls === 'write' ? result('allow', { source: 'mode' }) : result('ask', { source: 'mode' });
    default:
      return result('ask', { source: 'mode' });
  }
}

/* ---------- предмет вызова, сводка и подсказка правила ---------- */

/** Путь относительно проекта с прямыми слешами — по нему матчятся правила путей. */
export function relativeSubject(projectDir, target) {
  if (!target) return '';
  const base = projectDir || process.cwd();
  const full = path.resolve(base, String(target));
  const rel = path.relative(base, full);
  return (rel || '.').split(path.sep).join('/');
}

export function subjectOf({ tool, cls, args = {}, projectDir, command }) {
  if (cls === 'exec') return String(command ?? args.command ?? '');
  if (cls === 'write' || cls === 'read') return args.path ? relativeSubject(projectDir, args.path) : null;
  if (cls === 'memory') return String(args.scope || 'project');
  if (tool) return null;
  return null;
}

export function summarize({ tool, cls, args = {}, subject }) {
  switch (tool) {
    case 'write_file':
      return `Записать файл ${subject} (${String(args.content ?? '').length} символов)`;
    case 'edit_file':
      return `Изменить файл ${subject}`;
    case 'run_shell':
      return String(subject || '');
    case 'memory_append':
      return `Дописать в память (${subject}): ${String(args.text ?? '').slice(0, 160)}`;
    default: {
      const json = JSON.stringify(args ?? {});
      const label = cls === 'external' ? 'Внешний инструмент' : 'Инструмент';
      return `${label} ${tool}: ${json.length > 400 ? `${json.slice(0, 400)}…` : json}`;
    }
  }
}

/** Предлагает правило для кнопки «Да, и не спрашивать». null — правило небезопасно предлагать. */
export function suggestRules({ tool, cls, subject }) {
  if (cls === 'exec') {
    const { parts, opaque } = splitCommand(subject);
    if (opaque || parts.length !== 1) return [];
    const tokens = parts[0].split(/\s+/).filter(Boolean);
    if (!tokens.length) return [];
    const head = [tokens[0]];
    if (tokens[1] && /^[a-z][\w:-]*$/i.test(tokens[1])) head.push(tokens[1]);
    return [`run_shell(${head.join(' ')}*)`];
  }
  if (cls === 'write') {
    const dir = path.posix.dirname(String(subject || '.'));
    const spec = dir === '.' || dir === '' ? '**' : `${dir}/**`;
    return [`write_file(${spec})`, `edit_file(${spec})`];
  }
  if (cls === 'memory') return [`memory_append(${subject || 'project'})`];
  if (cls === 'external' || cls === 'network') return [tool];
  return [];
}
