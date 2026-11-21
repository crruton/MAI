/**
 * Защита веток (бэклог CC11.6, ADR 0059): `git push` в защищённую ветку
 * запрещён самим приложением во всех режимах, как guardrails.
 * Ветки — `settings.protectedBranches` (по умолчанию main и master; [] — выключить).
 *
 * Модуль не зависит от Electron.
 */
import { execFileSync } from 'node:child_process';
import { splitCommand } from './policy.js';

export const DEFAULT_PROTECTED = ['main', 'master'];

export function currentBranch(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true }).trim();
  } catch {
    return '';
  }
}

/**
 * Причина запрета или null. `branchOf()` — текущая ветка (лениво: git
 * вызывается, только если в команде есть push без ветки).
 */
export function pushViolation(command, { protectedBranches = DEFAULT_PROTECTED, branchOf = () => '' } = {}) {
  const list = (protectedBranches || []).map(String).filter(Boolean);
  if (!list.length) return null;
  const { parts } = splitCommand(String(command || ''));
  for (const part of parts) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    const at = tokens.findIndex((t, i) => t === 'push' && /(^|[\\/])git(\.exe)?$/i.test(tokens[i - 1] || ''));
    if (at < 0) continue;
    const rest = tokens.slice(at + 1);
    const deleting = rest.includes('--delete') || rest.includes('-d');
    const args = rest.filter((t) => !t.startsWith('-'));
    const refspecs = args.slice(1);
    if (!refspecs.length) {
      if (rest.includes('--all') || rest.includes('--mirror')) return `git push ${rest.includes('--all') ? '--all' : '--mirror'} затрагивает защищённые ветки (${list.join(', ')})`;
      const branch = branchOf();
      if (list.includes(branch)) return `пуш из защищённой ветки ${branch}: работайте в другой ветке и выкатывайте через pull request`;
      continue;
    }
    for (const spec of refspecs) {
      const target = spec.replace(/^\+/, '').split(':').pop().replace(/^refs\/heads\//, '');
      const source = spec.includes(':') ? '' : spec.replace(/^\+/, '');
      if (list.includes(target) || (deleting && list.includes(source))) return `пуш в защищённую ветку ${target}: выкатывайте через pull request`;
    }
  }
  return null;
}
