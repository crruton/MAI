/**
 * Атрибуция коммитов агента (E2.7, ADR 0116).
 *
 * Простой `git commit`, который агент запускает через `run_shell`, получает трейлеры
 * `Agent-Model: <провайдер>/<модель>` и, если вошёл пользователь Keycloak,
 * `Agent-User: <имя> <email>`. Строку меняет MAI, а не модель: подтверждение показывает
 * итоговую команду (ADR 0027). MAI Ship по `Agent-Model` проверяет независимость
 * approver'а (ADR 0110). Без Electron.
 */
import { spawnSync } from 'node:child_process';
import { splitCommand } from './policy.js';

const GIT_COMMIT_RE = /^git(?:\s+-c\s+\S+)*\s+commit(?:\s|$)/;
/** `git commit --trailer` появился в Git 2.32. */
export const MIN_GIT = [2, 32];

let gitVersionCache;

export function parseGitVersion(text) {
  const m = /git version (\d+)\.(\d+)/.exec(String(text || ''));
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export function gitSupportsTrailer(version) {
  if (!version) return false;
  return version[0] > MIN_GIT[0] || (version[0] === MIN_GIT[0] && version[1] >= MIN_GIT[1]);
}

/** Версия git на машине, один раз за процесс. */
export function localGitVersion() {
  if (gitVersionCache === undefined) {
    const r = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    gitVersionCache = r.status === 0 ? parseGitVersion(r.stdout) : null;
  }
  return gitVersionCache;
}

/** Значение трейлера без символов, которые оболочка разворачивает или режет: " ` $ % ! \ и переводы строк. */
export function cleanTrailerValue(value) {
  return String(value || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/["`$%!\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** Строка пользователя Keycloak: «Имя <email>», или имя, или пусто. */
export function userLine(user) {
  if (!user) return '';
  const name = cleanTrailerValue(user.name || user.preferred_username || '');
  const email = cleanTrailerValue(user.email || '').replace(/[<>\s]/g, '');
  if (name && email) return `${name} <${email}>`;
  return name || (email ? `<${email}>` : '');
}

/**
 * Добавляет трейлеры к простому `git commit`. Составные команды, подстановки `$(…)`,
 * коммиты, где трейлер уже есть, и старый git не меняются.
 * @param {string} command
 * @param {{ model?: string, user?: string, enabled?: boolean }} attribution
 * @param {{ gitVersion?: number[]|null }} options
 */
export function attributeCommit(command, attribution, { gitVersion = localGitVersion() } = {}) {
  const text = String(command || '');
  if (!attribution || attribution.enabled === false) return text;
  const model = cleanTrailerValue(attribution.model);
  const user = cleanTrailerValue(attribution.user);
  if (!model && !user) return text;
  const { parts, opaque } = splitCommand(text);
  if (opaque || parts.length !== 1 || !GIT_COMMIT_RE.test(parts[0])) return text;
  if (/Agent-(Model|User)\s*:/i.test(text)) return text;
  if (!gitSupportsTrailer(gitVersion)) return text;
  const trailers = [];
  if (model) trailers.push(`--trailer "Agent-Model: ${model}"`);
  if (user) trailers.push(`--trailer "Agent-User: ${user}"`);
  return `${text.trimEnd()} ${trailers.join(' ')}`;
}
