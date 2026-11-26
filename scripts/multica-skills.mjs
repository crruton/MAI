#!/usr/bin/env node
/**
 * Навыки каталога → Multica MAI (E1.8, ADR 0113) без окна приложения.
 *
 *   npm.cmd run multica:skills -- --dry-run
 *   npm.cmd run multica:skills -- grilling tdd
 *   npm.cmd run multica:skills -- --workspace <id> --prune
 *
 * Каталог — корень этого репозитория (`mai-marketplace.json`) или `--root <папка>`.
 * Workspace — `--workspace`, иначе `MULTICA_WORKSPACE_ID`, иначе по умолчанию профиля CLI.
 * CLI — `MULTICA_COMMAND` (по умолчанию multica).
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pushSkills } from '../electron/lib/multica-skills.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};
const option = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return '';
  const value = args[i + 1] || '';
  args.splice(i, 2);
  return value;
};

const dryRun = flag('--dry-run');
const prune = flag('--prune');
const workspaceId = option('--workspace') || process.env.MULTICA_WORKSPACE_ID || '';
const root = path.resolve(option('--root') || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const names = args.filter((a) => !a.startsWith('-'));
const command = process.env.MULTICA_COMMAND || 'multica';

function run(cliArgs, { cwd } = {}) {
  const result = spawnSync(command, cliArgs, { cwd, encoding: 'utf8', timeout: 60_000, shell: false, windowsHide: true, env: { ...process.env, NO_COLOR: '1' } });
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `код ${result.status}`).trim());
  return result.stdout;
}

try {
  const report = pushSkills({ root, run, target: { workspaceId }, names, prune, dryRun });
  console.log(report.message);
  for (const a of report.actions) if (a.action !== 'unchanged') console.log(`  ${a.action.padEnd(9)} ${a.name}${a.reason ? ` — ${a.reason}` : ''}`);
} catch (err) {
  console.error(`multica:skills: ${err.message}`);
  console.error('Проверьте: multica auth status');
  process.exit(1);
}
