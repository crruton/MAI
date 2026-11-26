/**
 * Шаблоны политик MAI Ship в каталоге (E3.B6): каждый разбирается и проходит проверку политики.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { validatePolicy, evaluate } from '../electron/lib/ship/policy.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  OK   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${String(extra).slice(0, 300)}`);
  }
}
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'catalog', 'ship-setup', 'skills', 'ship-setup', 'templates');
const names = fs.readdirSync(dir).filter((f) => f.endsWith('.approval-policy.yaml')).sort();
check('четыре шаблона политики', names.join() === 'docs.approval-policy.yaml,infra.approval-policy.yaml,library.approval-policy.yaml,service.approval-policy.yaml', names.join());
const base = { changedLines: 10, labels: [], authorIsAgent: false, draft: false, pipeline: 'success', blockingFindings: 0, models: { approver: 'openai/gpt-5.1', reviewer: 'x/claude-a', executors: [] } };
for (const name of names) {
  const policy = parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  const errors = validatePolicy(policy);
  check(`${name}: проходит проверку политики`, errors.length === 0, errors.join('; '));
  check(`${name}: старт в observe, default — не approve`, policy.mode === 'observe' && policy.default !== 'approve');
  check(`${name}: enforce_classes — существующие правила`, (policy.enforce_classes || []).every((c) => policy.rules.some((r) => r.name === c)));
  const no = Object.fromEntries((policy.classifiers || []).map((c) => [c.name, false]));
  const r = evaluate(policy, { ...base, files: ['docs/guide.md'], classifiers: no });
  check(`${name}: правка документации — approve (в observe — комментарий)`, r.decision === 'approve' && r.action === 'comment', JSON.stringify(r));
  check(`${name}: правка политики — человек (самозащита)`, evaluate(policy, { ...base, files: ['.mai-code/approval-policy.yaml'], classifiers: no }).rule === 'self-protection');
}
const svc = parse(fs.readFileSync(path.join(dir, 'service.approval-policy.yaml'), 'utf8'));
const no = Object.fromEntries(svc.classifiers.map((c) => [c.name, false]));
check('service: миграция — человек, .env — блок', evaluate(svc, { ...base, files: ['db/migrations/1.sql'], classifiers: no }).decision === 'require_human' && evaluate(svc, { ...base, files: ['config/.env.prod'], classifiers: no }).decision === 'block');
check('service: классификатор оплаты ужесточает до block', evaluate(svc, { ...base, files: ['docs/a.md'], classifiers: { ...no, payments: true } }).decision === 'block');
const ship = parse(fs.readFileSync(path.join(dir, 'ship.yaml'), 'utf8'));
check('ship.yaml: approver и ревьюер разных семейств', ship.providers.approver.includes('gpt') && ship.providers.reviewer.includes('claude'));
console.log(`\nship-templates: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
