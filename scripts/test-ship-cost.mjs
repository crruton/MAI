/**
 * MAI Ship: учёт затрат на модели (E3.B4, ADR 0124) — счётчик, записи в комментариях, бюджет.
 */
import { createMeter, costMarker, parseCosts, mergeCosts, mrCost, monthCost, budgetState, costLine, monthStart } from '../electron/lib/ship/cost.js';
import { upsertNote } from '../electron/lib/ship/gitlab.js';
import { runReview } from '../electron/lib/ship/review.js';
import { costSummary, formatFlow, flowMetrics } from '../electron/lib/ship/report.js';

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

const PRICING = { 'gpt-5.1': { input: 2, output: 8 } };

console.log('[1] счётчик');
let m = createMeter({ role: 'review', pricing: PRICING, now: () => '2026-11-10T00:00:00Z' });
const client = { chat: { completions: { create: async (body) => ({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 } }) } } };
const wrapped = m.wrap(client, 'gpt-5.1');
const res = await wrapped.chat.completions.create({ model: 'gpt-5.1', messages: [] });
check('обёртка возвращает ответ модели', res.choices[0].message.content === 'ok');
let rec = m.record();
check('стоимость по цене за миллион: 1M↑×2 + 0.5M↓×8 = $6', rec.usd === 6 && rec.input === 1_000_000 && rec.output === 500_000 && rec.calls === 1, JSON.stringify(rec));
m.add('unknown-model', { input_tokens: 10, output_tokens: 5 });
rec = m.record();
check('модель без цены — токены считаются, флаг unpriced', rec.usd === 6 && rec.input === 1_000_010 && rec.unpriced === true && rec.models.join() === 'gpt-5.1,unknown-model');
m = createMeter({ role: 'steward', pricing: PRICING });
m.addHistory('gpt-5.1', [{ role: 'user', content: 'x' }, { role: 'assistant', usage: { input: 1000, output: 100, total: 1100, cached: 0 } }, { role: 'assistant', usage: { input: 2000, output: 200, total: 2200, cached: 0 } }]);
check('история цикла агента: usage ассистента', m.record().input === 3000 && m.record().calls === 2 && m.record().usd === 0.0084, JSON.stringify(m.record()));
check('без вызовов — записи нет', createMeter({ role: 'x' }).record() === null);

console.log('[2] записи в комментариях');
const r1 = { v: 1, role: 'review', input: 10, output: 5, usd: 0.5, calls: 1, models: ['a'], at: '2026-11-02T00:00:00Z', note: 'a--b' };
const body = `текст\n\n${costMarker(r1)}\n\n<!-- mai-ship:review -->`;
check('в маркере нет «--» (HTML-комментарий не ломается)', !costMarker(r1).slice(4, -3).includes('--'));
check('разбор записи', parseCosts(body).length === 1 && parseCosts(body)[0].note === 'a--b');
check('битая запись пропускается', parseCosts('<!-- mai-ship:cost {oops} -->').length === 0);
const merged = mergeCosts([r1, { ...r1, usd: 0.25, at: '2026-11-03T00:00:00Z', models: ['b'] }], 'review');
check('слияние: суммы, последняя дата, модели', merged.usd === 0.75 && merged.calls === 2 && merged.at === '2026-11-03T00:00:00Z' && merged.models.join() === 'a,b');
check('строка расхода', /\$0\.75/.test(costLine(merged)) && /pricing/.test(costLine({ ...merged, usd: 0, unpriced: true })));

console.log('[3] upsertNote копит расход роли');
function memGitlab(notes = []) {
  let id = 100;
  return {
    notes,
    getNotes: async () => notes,
    createNote: async (p, i, b) => { const n = { id: id++, body: b }; notes.push(n); return n; },
    updateNote: async (p, i, nid, b) => { notes.find((n) => n.id === nid).body = b; },
    setLabels: async () => {},
  };
}
let g = memGitlab();
await upsertNote(g, 'g/app', 7, 'review', 'первый', { cost: { ...r1, usd: 1 } });
await upsertNote(g, 'g/app', 7, 'review', 'второй', { cost: { ...r1, usd: 2 } });
check('перезапись комментария суммирует расход', g.notes.length === 1 && parseCosts(g.notes[0].body)[0].usd === 3 && /второй/.test(g.notes[0].body), g.notes[0].body);
await upsertNote(g, 'g/app', 7, 'review', 'третий без модели');
check('прогон без модели расход не теряет', parseCosts(g.notes[0].body)[0].usd === 3);
await upsertNote(g, 'g/app', 7, 'approve', 'approver');
check('у роли без расхода маркера нет', parseCosts(g.notes[1].body).length === 0);

console.log('[4] бюджет');
const NOW = Date.parse('2026-11-20T12:00:00Z');
check('начало месяца UTC', monthStart(NOW) === '2026-11-01T00:00:00.000Z');
const noteWith = (usd, at) => ({ body: costMarker({ v: 1, role: 'review', input: 1, output: 1, usd, calls: 1, at }) });
const notesBy = {
  7: [noteWith(0.4, '2026-11-05T00:00:00Z'), noteWith(0.3, '2026-10-30T00:00:00Z')],
  8: [noteWith(2, '2026-11-06T00:00:00Z')],
  9: [noteWith(5, '2026-10-20T00:00:00Z')],
};
const projGitlab = {
  listMrs: async (p, { updatedAfter }) => (updatedAfter === '2026-11-01T00:00:00.000Z' ? [{ iid: 7 }, { iid: 8 }, { iid: 9 }] : []),
  getNotes: async (p, iid) => notesBy[iid] || [],
};
check('расход MR — все записи', mrCost(notesBy[7]).usd === 0.7);
check('за месяц — только записи этого месяца', (await monthCost(projGitlab, 'g/app', { now: NOW })) === 2.4);
let st = await budgetState({ gitlab: projGitlab, project: 'g/app', iid: 7, budget: { per_mr_usd: 0.5 }, now: NOW });
check('бюджет MR превышен', st.mr === 0.7 && /бюджет MR исчерпан: \$0\.7 из \$0\.5/.test(st.exceeded) && st.month === null);
st = await budgetState({ gitlab: projGitlab, project: 'g/app', iid: 7, budget: { per_mr_usd: 1, monthly_usd: 2 }, now: NOW });
check('месячный бюджет превышен', st.month === 2.4 && /месячный/.test(st.exceeded), JSON.stringify(st));
st = await budgetState({ gitlab: projGitlab, project: 'g/app', iid: 7, budget: { per_mr_usd: 1, monthly_usd: 10 }, now: NOW });
check('в пределах — не превышен', st.exceeded === '');
st = await budgetState({ gitlab: { ...projGitlab, listMrs: async () => { throw new Error('сеть'); } }, project: 'g/app', iid: 7, budget: { monthly_usd: 1 }, now: NOW });
check('месяц не посчитан — не блокирует', st.month === null && st.exceeded === '');

console.log('[5] ревьюер');
function reviewGitlab({ ship, notes = [] }) {
  const g2 = memGitlab(notes);
  const labels = [];
  return {
    labels,
    gitlab: {
      ...g2,
      getMr: async () => ({ iid: 7, state: 'opened', sha: 'h1', target_branch: 'main', labels: [], diff_refs: { base_sha: 'b', start_sha: 's', head_sha: 'h1' } }),
      getFile: async (p, f) => (f === '.mai-code/ship.yaml' ? ship : null),
      getDiffs: async () => [{ old_path: 'a.js', new_path: 'a.js', diff: '@@ -1 +1 @@\n-x\n+y\n' }],
      getDiscussions: async () => [],
      createDiscussion: async () => ({}),
      setLabels: async (p, i, { add = [] }) => labels.push(...add),
    },
  };
}
let calls = 0;
const makeModel = (shipCfg, meter) => {
  const c = meter.wrap({ chat: { completions: { create: async () => { calls += 1; return { choices: [{ message: { content: '[]' } }], usage: { prompt_tokens: 100_000, completion_tokens: 10_000 } }; } } } }, 'gpt-5.1');
  return async (system, user) => (await c.chat.completions.create({ messages: [] })).choices[0].message.content;
};
const SHIP = 'version: 1\nreview:\n  level: quick\npricing:\n  gpt-5.1: { input: 2, output: 8 }\nbudget:\n  per_mr_usd: 1\n';
let rg = reviewGitlab({ ship: SHIP });
let out = await runReview({ gitlab: rg.gitlab, project: 'g/app', iid: 7, makeModel });
const reviewNote = rg.gitlab.notes.find((n) => n.body.includes('<!-- mai-ship:review -->'));
check('расход ревью записан в его комментарий', out.status === 'done' && out.cost?.usd > 0 && parseCosts(reviewNote?.body)[0]?.usd === out.cost.usd && /Расход моделей/.test(reviewNote.body), JSON.stringify(out.cost));
calls = 0;
rg = reviewGitlab({ ship: SHIP, notes: [{ id: 1, body: costMarker({ v: 1, role: 'steward', input: 1, output: 1, usd: 1.5, calls: 1, at: '2026-11-01T00:00:00Z' }) }] });
out = await runReview({ gitlab: rg.gitlab, project: 'g/app', iid: 7, makeModel });
check('бюджет MR исчерпан — модель не зовётся, нужен человек', out.status === 'skipped' && /бюджет MR/.test(out.reason) && calls === 0 && rg.labels.includes('ship::needs-human'), JSON.stringify(out));

console.log('[6] отчёт');
const summary = costSummary([{ cost: { usd: 1, tokens: 10 } }, { cost: { usd: 3, tokens: 5, unpriced: true } }, { cost: { usd: 0, tokens: 0 } }]);
check('сводка: всего, MR, медиана', summary.total === 4 && summary.mrs === 2 && summary.unpriced === true);
const flow = flowMetrics([{ mr: { state: 'merged', created_at: '2026-11-01T00:00:00Z', merged_at: '2026-11-01T02:00:00Z', title: 'x', iid: 1 }, cost: { usd: 0.5, tokens: 10 } }]);
check('метрики потока показывают стоимость', /\$0\.5 на 1 MR/.test(formatFlow(flow)), formatFlow(flow));

console.log(`\nship-cost: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
