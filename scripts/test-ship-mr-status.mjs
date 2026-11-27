/**
 * MAI Ship: статус MR в MAI (E3.C2, ADR 0125) — карточка, fetch поверх glab, сбор по проекту.
 */
import { mrStatus, glabFetch, collectMrStatuses } from '../electron/lib/ship/mr-status.js';
import { decisionMarker } from '../electron/lib/ship/report.js';
import { costMarker } from '../electron/lib/ship/cost.js';

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

const decision = (sha, d = 'approve', at = '2026-11-27T10:00:00Z') => ({ body: decisionMarker({ v: 1, project: '1', iid: 7, sha, decision: d, action: d === 'approve' ? 'approve' : 'needs_human', rule: 'docs', mode: 'enforce', at }) });
const finding = (resolved) => ({ notes: [{ body: 'находка <!-- mai-ship:finding:0123456789abcdef -->', resolved, resolvable: true }] });
const base = { iid: 7, title: 'Docs', web_url: 'https://gitlab.example/g/app/-/merge_requests/7', source_branch: 'ship/docs', sha: 'S2', labels: [], head_pipeline: { status: 'success' }, author: { username: 'dev' } };

console.log('[1] карточка');
let s = mrStatus({ mr: { ...base, labels: ['ship::approved'] }, notes: [decision('S1', 'require_human', '2026-11-27T09:00:00Z'), decision('S2')], discussions: [finding(true), finding(false), { notes: [{ body: 'чужое' }] }] });
check('последнее решение approver\'а, на текущий SHA', s.approver.decision === 'approve' && s.approver.stale === false && s.status === 'approved', JSON.stringify(s));
check('находки — только свои, открытые отдельно', s.review.findings === 2 && s.review.open === 1);
check('pipeline из head_pipeline', s.pipeline === 'success');
s = mrStatus({ mr: { ...base, labels: ['ship::approved'] }, notes: [decision('S1')] });
check('approve на старый SHA — не «одобрен», stale', s.approver.stale === true && s.status === 'in-progress');
check('нужен человек важнее красного CI', mrStatus({ mr: { ...base, labels: ['ship::needs-human'], head_pipeline: { status: 'failed' } } }).status === 'needs-human');
check('заблокирован', mrStatus({ mr: { ...base, labels: ['ship::blocked', 'ship::needs-human'] } }).status === 'blocked');
check('красный CI', mrStatus({ mr: { ...base, head_pipeline: { status: 'failed' } } }).status === 'red-ci');
s = mrStatus({ mr: base, notes: [{ body: 'раунд <!-- mai-ship:steward-round -->', created_at: '2026-11-27T11:00:00Z' }, { body: costMarker({ v: 1, role: 'review', input: 10, output: 2, usd: 0.25, calls: 1, at: 'x' }) }] });
check('раунды steward и расход', s.steward.rounds === 1 && s.steward.lastAt === '2026-11-27T11:00:00Z' && s.cost.usd === 0.25);
check('без решения и расхода — null', mrStatus({ mr: base }).approver === null && mrStatus({ mr: base }).cost === null);

console.log('[2] fetch поверх glab');
const calls = [];
let f = glabFetch({ cwd: 'C:/p', exec: async (args, opts) => { calls.push({ args, opts }); return { stdout: '{"id":42}' }; } });
let res = await f('https://glab.local/api/v4/projects/%3Aid?x=1', { method: 'GET' });
check('«:id» уходит в glab как есть, cwd — папка проекта', calls[0].args.join(' ') === 'api --method GET projects/:id?x=1' && calls[0].opts.cwd === 'C:/p' && (await res.json()).id === 42, JSON.stringify(calls[0]));
f = glabFetch({ cwd: '.', exec: async () => { throw Object.assign(new Error('exit 1'), { stderr: 'glab: 404 Not Found' }); } });
res = await f('https://glab.local/api/v4/projects/1/repository/files/x/raw?ref=main');
check('ошибка glab → HTTP-статус из текста', res.ok === false && res.status === 404);
f = glabFetch({ cwd: '.', exec: async () => { throw Object.assign(new Error('spawn glab ENOENT'), { code: 'ENOENT' }); } });
let err = '';
try {
  await f('https://glab.local/api/v4/projects/1');
} catch (e) {
  err = e.message;
}
check('нет glab — понятная ошибка', /glab не установлен/.test(err));

console.log('[3] сбор по проекту');
const seen = [];
const exec = async (args) => {
  const p = args[3];
  seen.push(p);
  const json = (x) => ({ stdout: JSON.stringify(x) });
  if (p === 'projects/:id') return json({ id: 42 });
  if (p.startsWith('projects/42/merge_requests?state=opened')) return json([{ iid: 7 }, { iid: 8 }]);
  if (/merge_requests\/(\d+)$/.test(p)) return json({ ...base, iid: Number(/(\d+)$/.exec(p)[1]) });
  if (/notes\?/.test(p)) return json(/page=1/.test(p) ? [decision('S2')] : []);
  if (/discussions\?/.test(p)) return json([]);
  throw new Error(`нет ${p}`);
};
const items = await collectMrStatuses({ cwd: '.', exec, limit: 5 });
check('карточки по открытым MR', items.length === 2 && items.map((i) => i.iid).join() === '7,8' && items[0].approver.decision === 'approve', JSON.stringify(items));
check('лимит MR в запросе', seen.some((p) => /state=opened&order_by=updated_at&per_page=5$/.test(p)));

console.log(`\nship-mr-status: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
