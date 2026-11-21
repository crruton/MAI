#!/usr/bin/env node
/**
 * Хук Stop (ADR 0035, бэклог CC3.4): не принимает работу, если изменён код, а
 * CHANGELOG.md и ADR — нет. Правило «каждое изменение — ADR и CHANGELOG».
 *
 *   { "Stop": [{ "hooks": [{ "type": "command", "command": "node examples/hooks/require-docs.mjs" }] }] }
 *
 * Аргументы (необязательно): папки кода, по умолчанию electron renderer scripts.
 * Смотрит незакоммиченные изменения и новые файлы (`git status --porcelain`).
 * Ответ — JSON { decision: "block", reason } на stdout; агент получит причину
 * и продолжит работу (не больше трёх раундов).
 */
import { execFileSync } from 'node:child_process';

const codeDirs = process.argv.slice(2).length ? process.argv.slice(2) : ['electron', 'renderer', 'scripts'];

let status = '';
try {
  status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
} catch {
  process.exit(0); // не git — проверять нечего
}
const files = status
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => line.slice(3).replace(/^"|"$/g, '').split(' -> ').pop().replace(/\\/g, '/'));
const code = files.filter((f) => codeDirs.some((d) => f === d || f.startsWith(`${d}/`)));
if (!code.length) process.exit(0);
const missing = [];
if (!files.includes('CHANGELOG.md')) missing.push('запись в CHANGELOG.md ([Unreleased])');
if (!files.some((f) => /^docs\/adr\/\d{4}-.+\.md$/.test(f))) missing.push('ADR в docs/adr/ (новый или обновлённый)');
if (!missing.length) process.exit(0);
process.stdout.write(
  JSON.stringify({
    decision: 'block',
    reason: `Изменён код (${code.slice(0, 5).join(', ')}${code.length > 5 ? ' …' : ''}), но нет: ${missing.join('; ')}. Добавь их по правилу проекта.`,
  }),
);
process.exit(0);
