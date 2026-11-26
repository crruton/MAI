/**
 * MAI Ship: журнал решений и согласие approver ↔ человек (E3.F6, E3.G2, ADR 0121).
 */
import { decisionRecord, decisionMarker, parseDecision, humanOutcome, agrees, agreementReport, formatReport, collectDecisions, ENFORCE_MIN_DECIDED } from '../electron/lib/ship/report.js';

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
check('берётся последнее решение по MR, MR без решения пропущен', collected.length === 1 && collected[0].decision.rule === 'docs', JSON.stringify(collected));
check('период — updated_after', listed.updatedAfter === '2026-11-19T00:00:00.000Z', JSON.stringify(listed));

console.log(`\nship-report: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
