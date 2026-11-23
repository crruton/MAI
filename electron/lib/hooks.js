/**
 * Хуки (бэклог CC3, ADR 0035) — команды пользователя на события агента.
 *
 * Конфигурация (как в Claude Code):
 *   {
 *     "PreToolUse": [
 *       { "matcher": "run_shell|write_file", "hooks": [{ "type": "command", "command": "node check.js", "timeout": 30 }] }
 *     ]
 *   }
 * Источники: settings.hooks (глобально) и `.mai-code/hooks.json` проекта —
 * только для доверенной папки: хук проекта — код из репозитория.
 *
 * Протокол: команда получает JSON на stdin и переменную MAI_PROJECT_DIR.
 *   код 0 — успех; stdout может содержать JSON { decision, reason, additionalContext };
 *   код 2 — блокировка, причина — stderr;
 *   другой код или таймаут — ошибка хука, действие не блокируется.
 *
 * Модуль не зависит от Electron.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { killTree as killProcessTree } from './proc.js';
import { createOutputDecoder } from './encoding.js';

export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'PreCompact', 'SessionStart'];
const DEFAULT_TIMEOUT_S = 60;
const MAX_OUTPUT = 64 * 1024;

/** Приводит конфигурацию к виду { событие: [{ matcher, hooks: [{ command, timeout }] }] }. */
export function normalizeHooks(raw, source = 'global') {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(raw[event]) ? raw[event] : [];
    for (const group of groups) {
      const hooks = (Array.isArray(group?.hooks) ? group.hooks : [])
        .filter((h) => (h?.type || 'command') === 'command' && typeof h.command === 'string' && h.command.trim())
        .map((h) => ({
          command: h.command.trim(),
          timeout: Math.max(1, Math.min(600, Number(h.timeout) || DEFAULT_TIMEOUT_S)),
          source,
        }));
      if (!hooks.length) continue;
      (out[event] ||= []).push({ matcher: typeof group.matcher === 'string' ? group.matcher : '', hooks });
    }
  }
  return out;
}

export function readProjectHooks(projectDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectDir, '.mai-code', 'hooks.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Глобальные хуки и хуки проекта (только для доверенной папки). */
export function collectHooks({ settingsHooks, projectDir, trusted, packageHooks = [] }) {
  const merged = {};
  const sources = [normalizeHooks(settingsHooks, 'global')];
  // Хуки пакетов (ADR 0037): [{ source: 'package:<имя>', config }].
  for (const pkg of packageHooks) sources.push(normalizeHooks(pkg.config, pkg.source));
  if (trusted && projectDir) sources.push(normalizeHooks(readProjectHooks(projectDir), 'project'));
  for (const config of sources) {
    for (const [event, groups] of Object.entries(config)) (merged[event] ||= []).push(...groups);
  }
  return merged;
}

/** matcher: пусто или `*` — всё; иначе регулярное выражение по имени инструмента целиком. */
export function matches(matcher, toolName) {
  if (!matcher || matcher === '*') return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(String(toolName || ''));
  } catch {
    return matcher === toolName;
  }
}

function runCommand(command, { input, cwd, timeout, env }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      // Своя группа процессов: по таймауту останавливаем хук вместе с дочерними.
      child = spawn(command, { cwd, shell: true, windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: err.message, ms: 0 });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        killProcessTree(child, { signal: 'SIGKILL' });
      } catch {
        /* уже завершён */
      }
    }, timeout * 1000);
    const decodeOut = createOutputDecoder();
    const decodeErr = createOutputDecoder();
    child.stdout.on('data', (d) => (stdout = `${stdout}${decodeOut(d)}`.slice(0, MAX_OUTPUT)));
    child.stderr.on('data', (d) => (stderr = `${stderr}${decodeErr(d)}`.slice(0, MAX_OUTPUT)));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: err.message, ms: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? -1 : code, stdout, stderr: timedOut ? `таймаут ${timeout} с` : stderr, ms: Date.now() - started, timedOut });
    });
  });
}

function parseOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text.startsWith('{')) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/**
 * Исполнитель хуков для прогона.
 * `run(event, payload)` → { decision: 'allow'|'deny'|'ask'|'block'|null, reason, context, results }
 * Самое строгое решение побеждает: deny/block > ask > allow.
 */
export function createHookRunner({ hooks = {}, projectDir, sessionId = '', env = process.env, onRun } = {}) {
  const rank = { block: 3, deny: 3, ask: 2, allow: 1 };
  return {
    has(event, toolName = '') {
      return (hooks[event] || []).some((g) => matches(g.matcher, toolName));
    },
    async run(event, payload = {}) {
      const groups = (hooks[event] || []).filter((g) => matches(g.matcher, payload.tool_name));
      const out = { decision: null, reason: '', context: [], results: [] };
      for (const group of groups) {
        for (const hook of group.hooks) {
          const input = { hook_event_name: event, session_id: sessionId, project_dir: projectDir, ...payload };
          const result = await runCommand(hook.command, {
            input,
            cwd: projectDir || process.cwd(),
            timeout: hook.timeout,
            env: { ...env, MAI_PROJECT_DIR: projectDir || '', MAI_HOOK_EVENT: event },
          });
          const json = parseOutput(result.stdout);
          let decision = null;
          let reason = '';
          if (result.code === 2) {
            decision = event === 'PreToolUse' ? 'deny' : 'block';
            reason = result.stderr.trim() || json.reason || 'заблокировано хуком';
          } else if (result.code === 0) {
            const d = String(json.decision || '').toLowerCase();
            if (['allow', 'deny', 'ask', 'block'].includes(d)) decision = d === 'block' && event === 'PreToolUse' ? 'deny' : d;
            reason = String(json.reason || '');
            if (json.additionalContext) out.context.push(String(json.additionalContext).slice(0, 8000));
          }
          const record = { event, command: hook.command, source: hook.source, code: result.code, ms: result.ms, decision, error: result.code !== 0 && result.code !== 2 ? result.stderr.trim().slice(0, 500) : '' };
          out.results.push(record);
          try {
            onRun?.(record);
          } catch {
            /* журнал не должен ломать хук */
          }
          if (decision && (rank[decision] || 0) > (rank[out.decision] || 0)) {
            out.decision = decision;
            out.reason = reason;
          }
        }
      }
      return out;
    },
  };
}
