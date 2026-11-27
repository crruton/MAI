/**
 * MAI Ship ↔ Multica MAI (E3.C4, ADR 0128): ключ задачи из MR, план смены статусов, команда CLI.
 */
import { issueKeyFromMr, statusForMr, planIssueSync } from '../electron/lib/ship/mr-issue.js';
import { issueStatusArgs } from '../electron/lib/multica-target.js';
import { collectRecentMrs } from '../electron/lib/ship/mr-status.js';

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

console.log('[1] ключ задачи');
check('[MAI-42] в заголовке (как пишет /ship)', issueKeyFromMr({ title: '[MAI-42] Добавить вход' }) === 'MAI-42');
check('MAI-7: в начале заголовка', issueKeyFromMr({ title: 'MAI-7: поправить тест' }) === 'MAI-7');
check('Draft MR от /ship: «Draft: [MAI-1] …», «[Draft] MAI-2: …»', issueKeyFromMr({ title: 'Draft: [MAI-1] x' }) === 'MAI-1' && issueKeyFromMr({ title: '[Draft] MAI-2: y' }) === 'MAI-2' && issueKeyFromMr({ title: 'Draft: [NO-KEY] z', source_branch: 'mai-3-z' }) === '');
check('ветка mai-42-кратко → MAI-42', issueKeyFromMr({ title: 'Добавить вход', source_branch: 'mai-42-login' }) === 'MAI-42');
check('ветка ship/mai-9 → MAI-9', issueKeyFromMr({ title: 'x', source_branch: 'ship/mai-9' }) === 'MAI-9');
check('[NO-KEY] — без задачи, даже если ветка похожа', issueKeyFromMr({ title: '[NO-KEY] Опечатка', source_branch: 'mai-1-typo' }) === '');
check('ключ в середине заголовка не берётся', issueKeyFromMr({ title: 'Исправить как в MAI-3', source_branch: 'fix-typo' }) === '');
check('ветка без ключа — пусто', issueKeyFromMr({ title: 'x', source_branch: 'feature/login' }) === '');

console.log('[2] статус по MR');
check('слит → done, открыт → in_review, закрыт → не трогаем', statusForMr({ state: 'merged' }) === 'done' && statusForMr({ state: 'opened' }) === 'in_review' && statusForMr({ state: 'closed' }) === null);

console.log('[3] план');
const issues = [
  { id: 'u1', key: 'MAI-1', status: 'in_progress' },
  { id: 'u2', key: 'MAI-2', status: 'todo' },
  { id: 'u3', key: 'MAI-3', status: 'cancelled' },
  { id: 'u4', key: 'MAI-4', status: 'done' },
  { id: 'u5', key: 'MAI-5', status: 'in_review' },
  { id: 'u6', key: 'MAI-6', status: 'blocked' },
];
const mrs = [
  { iid: 1, title: '[MAI-1] Слито', state: 'merged', web_url: 'u/1' },
  { iid: 2, title: '[MAI-2] Открыт', state: 'opened' },
  { iid: 3, title: '[MAI-3] Слит, но задачу отменили', state: 'merged' },
  { iid: 4, title: '[MAI-4] Новый MR к закрытой задаче', state: 'opened' },
  { iid: 5, title: '[MAI-5] Второй MR открыт', state: 'opened' },
  { iid: 51, title: '[MAI-5] Первый MR слит', state: 'merged' },
  { iid: 6, title: '[MAI-6] Слит, задача заблокирована', state: 'merged' },
  { iid: 7, title: '[MAI-99] Задачи нет', state: 'merged' },
  { iid: 8, title: '[MAI-2] Закрыт без слияния', state: 'closed' },
];
const { plan, skipped } = planIssueSync(mrs, issues);
const steps = Object.fromEntries(plan.map((s) => [s.key, `${s.from}→${s.to}`]));
check('слитый MR закрывает задачу', steps['MAI-1'] === 'in_progress→done' && plan.find((s) => s.key === 'MAI-1').id === 'u1');
check('открытый MR — задача «на ревью»', steps['MAI-2'] === 'todo→in_review');
check('из двух MR побеждает слитый', steps['MAI-5'] === 'in_review→done');
check('done не откатывается, cancelled и blocked не трогаются', !('MAI-4' in steps) && !('MAI-3' in steps) && !('MAI-6' in steps));
check('пропуски с причинами: нет задачи, статус человека', skipped.some((s) => s.key === 'MAI-99' && /нет в Multica/.test(s.reason)) && skipped.some((s) => s.key === 'MAI-3' && /cancelled/.test(s.reason)) && skipped.some((s) => s.key === 'MAI-6'));
check('повторный план после применения — пустой', planIssueSync(mrs, issues.map((i) => ({ ...i, status: steps[i.key] ? steps[i.key].split('→')[1] : i.status }))).plan.length === 0);

console.log('[4] команда Multica');
check('multica issue status <id> <status> с workspace', issueStatusArgs('u1', 'done', { workspaceId: 'ws1' }).join(' ') === '--workspace-id ws1 issue status u1 done');
let err = '';
try {
  issueStatusArgs('u1', 'closed');
} catch (e) {
  err = e.message;
}
check('неизвестный статус отклоняется', /неизвестный статус/.test(err));
err = '';
try {
  issueStatusArgs('u1; rm -rf /', 'done');
} catch (e) {
  err = e.message;
}
check('id с посторонними символами отклоняется', /ожидается id/.test(err));

console.log('[5] MR проекта через glab');
const seen = [];
const exec = async (args) => {
  const p = args[3];
  seen.push(p);
  if (p === 'projects/:id') return { stdout: '{"id":42}' };
  if (p.startsWith('projects/42/merge_requests?state=all')) return { stdout: /page=1(&|$)/.test(p) ? JSON.stringify([{ iid: 3, title: '[MAI-1] x', state: 'merged', source_branch: 'mai-1-x', web_url: 'w' }]) : '[]' };
  throw new Error(p);
};
const recent = await collectRecentMrs({ cwd: '.', exec, days: 14, now: Date.parse('2026-11-27T00:00:00Z') });
check('слитые и открытые MR за 14 дней', recent.length === 1 && recent[0].state === 'merged' && seen.some((p) => /updated_after=2026-11-13/.test(decodeURIComponent(p))), JSON.stringify(seen));

console.log(`\nship-mr-issue: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
