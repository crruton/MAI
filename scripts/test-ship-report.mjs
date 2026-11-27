/**
 * MAI Ship: журнал решений и согласие approver ↔ человек (E3.F6, E3.G2, ADR 0121).
 */
import { decisionRecord, decisionMarker, parseDecision, humanOutcome, agrees, agreementReport, formatReport, collectDecisions, flowMetrics, formatFlow, ENFORCE_MIN_DECIDED } from '../electron/lib/ship/report.js';

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
const dec = (decision, rule, sha = 'S1') => ({ v: 1, decision, rule, sha, mode: 'observe', at: '2026-11-26T10:00:00Z' });
const mr = (iid, state, sha = 'S1') => ({ iid, state, sha });

console.log('[1] запись в комментарии');
const rec = decisionRecord({ result: { decision: 'approve', action: 'comment', rule: 'docs' }, sha: 'abc', mode: 'observe', project: 'g/app', iid: 7, at: '2026-11-26T00:00:00Z' });
const body = `**MAI Ship · approver** — approve\n\n${decisionMarker(rec)}\n\n<!-- mai-ship:approve -->`;
check('запись разбирается из комментария', JSON.stringify(parseDecision(body)) === JSON.stringify(rec));
const tricky = decisionRecord({ result: { decision: 'block', action: 'block', rule: 'a--b' }, sha: 'x', mode: 'enforce', project: 1, iid: 1 });
check('«--» не ломает HTML-комментарий', !decisionMarker(tricky).slice(4, -3).includes('--') && parseDecision(decisionMarker(tricky)).rule === 'a--b');
check('нет записи или мусор — null', parseDecision('просто текст') === null && parseDecision('<!-- mai-ship:decision {битый} -->') === null);

console.log('[2] исход и согласие');
check('влит тот же SHA → approve', humanOutcome(mr(1, 'merged'), dec('approve', 'docs')) === 'approve');
check('влит после новых коммитов → reject', humanOutcome(mr(1, 'merged', 'S2'), dec('approve', 'docs')) === 'reject');
check('закрыт без слияния → reject', humanOutcome(mr(1, 'closed'), dec('approve', 'docs')) === 'reject');
check('открыт, SHA тот же → pending; новый коммит → reject', humanOutcome(mr(1, 'opened'), dec('approve', 'docs')) === 'pending' && humanOutcome(mr(1, 'opened', 'S2'), dec('approve', 'docs')) === 'reject');
check('согласие', agrees(dec('approve', 'docs'), 'approve') === true && agrees(dec('require_human', 'x'), 'reject') === true && agrees(dec('approve', 'docs'), 'reject') === false && agrees(dec('approve', 'docs'), 'pending') === null);

console.log('[3] отчёт и кандидаты в enforce');
const entries = [];
for (let i = 0; i < ENFORCE_MIN_DECIDED; i += 1) entries.push({ mr: mr(i, 'merged'), decision: dec('approve', 'docs') });
for (let i = 0; i < 25; i += 1) entries.push({ mr: mr(100 + i, i === 0 ? 'closed' : 'merged'), decision: dec('approve', 'small-fix') });
for (let i = 0; i < 30; i += 1) entries.push({ mr: mr(200 + i, 'merged', 'S2'), decision: dec('require_human', 'migrations') });
entries.push({ mr: mr(300, 'opened'), decision: dec('approve', 'docs') });
entries.push({ mr: mr(301, 'merged'), decision: null });
let rep = agreementReport(entries);
check('pending и MR без решения не считаются', rep.decided === ENFORCE_MIN_DECIDED + 25 + 30 && rep.total === ENFORCE_MIN_DECIDED + 25 + 30 + 1, JSON.stringify({ d: rep.decided, t: rep.total }));
check('docs: 100% согласия', rep.byRule.docs.rate === 1 && rep.byRule.docs.falseApprove === 0);
check('small-fix: один approve без слияния — опасная ошибка', rep.byRule['small-fix'].falseApprove === 1 && rep.byRule['small-fix'].rate === 24 / 25);
check('кандидат в enforce — только docs (small-fix: approve без слияния; migrations: approver не говорил approve)', rep.enforceCandidates.join() === 'docs', rep.enforceCandidates.join());
rep = agreementReport(entries.slice(0, ENFORCE_MIN_DECIDED - 1));
check('меньше 20 решений — не кандидат', rep.enforceCandidates.length === 0);
const text = formatReport(agreementReport(entries), { days: 30 });
check('текст: таблица по правилам и рекомендация', /\| docs \| 20 \| 100% \| 0 \| 0 \|/.test(text) && /Можно включить в enforce_classes: docs/.test(text), text);
check('пустой отчёт — понятный текст', /Кандидатов в enforce пока нет/.test(formatReport(agreementReport([]))));
check('лишний вызов человека считается отдельно', agreementReport([{ mr: mr(1, 'merged'), decision: dec('require_human', 'default') }]).byRule.default.missedApprove === 1);

console.log('[4] сбор по MR проекта');
const notesByMr = {
  1: [{ body: `старое ${decisionMarker({ ...dec('require_human', 'default'), at: '2026-11-20T00:00:00Z' })}` }, { body: `новое ${decisionMarker({ ...dec('approve', 'docs'), at: '2026-11-25T00:00:00Z' })}` }],
  2: [{ body: 'обычный комментарий' }],
};
let listed = null;
const gitlab = {
  listMrs: async (project, opts) => { listed = opts; return [mr(1, 'merged'), mr(2, 'merged')]; },
  getNotes: async (project, iid) => notesByMr[iid] || [],
};
const collected = await collectDecisions(gitlab, 'g/app', { days: 7, now: Date.parse('2026-11-26T00:00:00Z') });
check('берётся последнее решение по MR; MR без решения — в выборке для метрик потока', collected.length === 2 && collected[0].decision.rule === 'docs' && collected[1].decision === null, JSON.stringify(collected));
check('MR без решения не влияет на согласие', agreementReport(collected).total === 1);
check('период — updated_after', listed.updatedAfter === '2026-11-19T00:00:00.000Z', JSON.stringify(listed));

console.log('[5] метрики потока (E3.G1)');
const at = (d, h = 0) => new Date(Date.parse('2026-11-01T00:00:00Z') + d * 86_400_000 + h * 3_600_000).toISOString();
const flowEntries = [
  { mr: { iid: 1, state: 'merged', title: 'Добавить A', created_at: at(0), merged_at: at(0, 2) }, decision: { decision: 'approve', mode: 'enforce' }, humanApprovals: 0 },
  { mr: { iid: 2, state: 'merged', title: 'Добавить B', created_at: at(0), merged_at: at(1) }, decision: { decision: 'require_human', mode: 'enforce' }, humanApprovals: 1 },
  { mr: { iid: 3, state: 'merged', title: 'Добавить C', created_at: at(0), merged_at: at(3) }, decision: null, humanApprovals: 1 },
  { mr: { iid: 4, state: 'merged', title: 'Revert "Добавить A"', created_at: at(2), merged_at: at(2, 1) }, decision: null, humanApprovals: 1 },
  { mr: { iid: 5, state: 'merged', title: 'Revert "Добавить C"', created_at: at(20), merged_at: at(20) }, decision: null, humanApprovals: 1 },
  { mr: { iid: 6, state: 'opened', title: 'В работе', created_at: at(0) }, decision: null, humanApprovals: null },
  { mr: { iid: 7, state: 'merged', title: 'Добавить D', created_at: at(0), merged_at: at(0, 1) }, decision: { decision: 'approve', mode: 'observe' }, humanApprovals: 0 },
];
const flow = flowMetrics(flowEntries);
check('влито 6 (открытый не считается)', flow.merged === 6, JSON.stringify(flow));
check('без человека — только approve в enforce и 0 апрувов людей', flow.withoutHuman === 1);
check('revert за 14 дней: A — да (через 2 дня), C — нет (через 17 дней)', flow.reverted === 1 && Math.abs(flow.revertRate - 1 / 4) < 1e-9, JSON.stringify(flow));
check('lead time: медиана и 90%', flow.leadTimeHours.median === 2 && flow.leadTimeHours.p90 === 72, JSON.stringify(flow.leadTimeHours));
check('стоимость: без записей mai-ship:cost — расхода нет', flow.cost.mrs === 0 && /расхода нет/.test(formatFlow(flow)));
check('пусто — без деления на ноль', flowMetrics([]).merged === 0 && flowMetrics([]).revertRate === 0 && /—/.test(formatFlow(flowMetrics([]))));

console.log(`\nship-report: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
