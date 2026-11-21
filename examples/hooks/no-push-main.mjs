#!/usr/bin/env node
/**
 * Хук PreToolUse для run_shell (ADR 0035, бэклог CC3.4): не даёт агенту пушить в
 * защищённые ветки. Ветки — аргументами (по умолчанию main и master):
 *
 *   { "PreToolUse": [{ "matcher": "run_shell",
 *       "hooks": [{ "type": "command", "command": "node examples/hooks/no-push-main.mjs main release" }] }] }
 *
 * Блокирует (код 2, причина — в stderr):
 *   git push origin main, git push origin HEAD:main, git push -f … main,
 *   git push без ветки, когда текущая ветка защищена.
 */
import { execFileSync } from 'node:child_process';

const protectedBranches = process.argv.slice(2).length ? process.argv.slice(2) : ['main', 'master'];

let input = '';
for await (const chunk of process.stdin) input += chunk;
let command = '';
try {
  command = String(JSON.parse(input || '{}').tool_input?.command || '');
} catch {
  process.exit(0);
}

function currentBranch() {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

// Части составной команды: a && b; c | d.
for (const part of command.split(/&&|\|\||;|\|/)) {
  const tokens = part.trim().split(/\s+/).filter(Boolean);
  const at = tokens.findIndex((t, i) => t === 'push' && /(^|[\\/])git(\.exe)?$/i.test(tokens[i - 1] || ''));
  if (at < 0) continue;
  const args = tokens.slice(at + 1).filter((t) => !t.startsWith('-'));
  const refspecs = args.slice(1); // первый — remote
  const targets = refspecs.map((r) => r.replace(/^\+/, '').split(':').pop().replace(/^refs\/heads\//, ''));
  if (!refspecs.length) {
    const branch = currentBranch();
    if (protectedBranches.includes(branch)) {
      process.stderr.write(`Пуш из ветки ${branch} запрещён правилом проекта: работайте в dev и выкатывайте через pull request.`);
      process.exit(2);
    }
    continue;
  }
  const hit = targets.find((t) => protectedBranches.includes(t));
  if (hit) {
    process.stderr.write(`Пуш в ${hit} запрещён правилом проекта: работайте в dev и выкатывайте через pull request.`);
    process.exit(2);
  }
}
process.exit(0);
