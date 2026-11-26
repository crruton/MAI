#!/usr/bin/env node
/**
 * Экспорт навыков каталога в Claude Code, OpenCode, Codex (E1.9, ADR 0114).
 *
 *   npm.cmd run skills:export -- --target claude --dry-run
 *   npm.cmd run skills:export -- --target claude,opencode,codex
 *   npm.cmd run skills:export -- --target claude --project C:\work\app grilling tdd
 *   npm.cmd run skills:export -- --target codex --prune
 *
 * Без `--project` — в папку пользователя (`~/.claude/skills` и т. д.), с ним — в проект.
 * Каталог — корень этого репозитория или `--root <папка>`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportSkills, TARGETS } from '../electron/lib/skills-export.js';

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
const targets = option('--target').split(',').map((t) => t.trim()).filter(Boolean);
const projectDir = option('--project');
const root = path.resolve(option('--root') || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const names = args.filter((a) => !a.startsWith('-'));

try {
  if (!targets.length) throw new Error(`укажите --target: ${Object.keys(TARGETS).join(', ')} (через запятую)`);
  const report = exportSkills({ root, targets, projectDir: projectDir ? path.resolve(projectDir) : '', names, prune, dryRun });
  for (const r of report.results) {
    console.log(`${dryRun ? 'План' : 'Экспорт'} → ${r.label} (${r.dir}): ${dryRun ? 'создать' : 'создано'} ${r.created}, ${dryRun ? 'обновить' : 'обновлено'} ${r.updated}, без изменений ${r.unchanged}, конфликтов ${r.conflicts}${prune ? `, ${dryRun ? 'удалить' : 'удалено'} ${r.deleted}` : ''}`);
    for (const a of r.actions) if (a.action !== 'unchanged') console.log(`  ${a.action.padEnd(9)} ${a.name}${a.reason ? ` — ${a.reason}` : ''}`);
  }
} catch (err) {
  console.error(`skills:export: ${err.message}`);
  process.exit(1);
}
