/**
 * MAI Ship: журнал решений approver'а и согласие с людьми (E3.F6, E3.G2, ADR 0121).
 *
 * Журнал — сами MR: в комментарии approver'а лежит машиночитаемая запись
 * `<!-- mai-ship:decision {...} -->`. Отчёт сравнивает решение с тем, что человек сделал с тем
 * же SHA: влил — «approve»; закрыл без слияния или потребовал новых коммитов — «не approve».
 * Открытый MR без новых коммитов — ещё не решён и в счёт не идёт. Без Electron.
 */

export const DECISION_MARKER_RE = /<!-- mai-ship:decision (\{.*?\}) -->/;
export const ENFORCE_MIN_DECIDED = 20;
export const ENFORCE_MIN_RATE = 0.95;

/** Запись решения для комментария и JSONL-журнала. */
export function decisionRecord({ result, sha, mode, project, iid, at = new Date().toISOString() }) {
  return { v: 1, project: String(project), iid: Number(iid), sha: String(sha), decision: result.decision, action: result.action, rule: result.rule, mode: mode || '', at };
}

export function decisionMarker(record) {
  // `--` внутри HTML-комментария недопустим: экранируем на всякий случай.
  return `<!-- mai-ship:decision ${JSON.stringify(record).replace(/--/g, '-\\u002d')} -->`;
}

export function parseDecision(body) {
  const m = DECISION_MARKER_RE.exec(String(body || ''));
  if (!m) return null;
  try {
    const data = JSON.parse(m[1]);
    return data && data.v === 1 && data.decision && data.sha ? data : null;
  } catch {
    return null;
  }
}

/**
 * Что сделал человек с оценённым SHA.
 * @returns {'approve'|'reject'|'pending'}
 */
export function humanOutcome(mr, decision) {
  const sameSha = String(mr.sha || '') === decision.sha;
  if (mr.state === 'merged') return sameSha ? 'approve' : 'reject';
  if (mr.state === 'closed') return 'reject';
  return sameSha ? 'pending' : 'reject';
}

/** approver согласен с человеком: approve ↔ влил тот же SHA; иначе ↔ не влил как есть. */
export function agrees(decision, outcome) {
  if (outcome === 'pending') return null;
  return (decision.decision === 'approve') === (outcome === 'approve');
}

/**
 * Отчёт по MR: [{ mr, decision }]. Решение — последнее по MR (комментарий обновляется).
 * @returns {{ total, decided, agree, rate, byRule: Record<string, {decided, agree, rate, approve, missedApprove, falseApprove}>, enforceCandidates: string[], items }}
 */
export function agreementReport(entries, { minDecided = ENFORCE_MIN_DECIDED, minRate = ENFORCE_MIN_RATE } = {}) {
  const items = [];
  const byRule = {};
  for (const { mr, decision } of entries) {
    if (!decision) continue;
    const outcome = humanOutcome(mr, decision);
    const agree = agrees(decision, outcome);
    items.push({ iid: mr.iid, rule: decision.rule, decision: decision.decision, outcome, agree, mode: decision.mode });
    if (agree === null) continue;
    const r = (byRule[decision.rule] ||= { decided: 0, agree: 0, rate: 0, approve: 0, missedApprove: 0, falseApprove: 0 });
    r.decided += 1;
    if (agree) r.agree += 1;
    if (decision.decision === 'approve') r.approve += 1;
    // approver сказал approve, а человек не влил как есть — опасная ошибка.
    if (decision.decision === 'approve' && outcome !== 'approve') r.falseApprove += 1;
    // approver позвал человека, а тот влил как есть — лишняя нагрузка, но безопасно.
    if (decision.decision !== 'approve' && outcome === 'approve') r.missedApprove += 1;
  }
  let decided = 0;
  let agree = 0;
  for (const r of Object.values(byRule)) {
    r.rate = r.decided ? r.agree / r.decided : 0;
    decided += r.decided;
    agree += r.agree;
  }
  // В enforce — только классы, где approver говорил approve, данных достаточно и согласие высокое.
  const enforceCandidates = Object.entries(byRule)
    .filter(([, r]) => r.approve > 0 && r.decided >= minDecided && r.rate >= minRate && r.falseApprove === 0)
    .map(([rule]) => rule)
    .sort();
  return { total: items.length, decided, agree, rate: decided ? agree / decided : 0, byRule, enforceCandidates, items };
}

/** Текст отчёта для консоли и комментария. */
export function formatReport(report, { days } = {}) {
  const pct = (x) => `${Math.round(x * 1000) / 10}%`;
  const lines = [
    `MAI Ship — согласие approver ↔ человек${days ? ` за ${days} дн.` : ''}`,
    `MR с решением: ${report.total}, решено человеком: ${report.decided}, согласие: ${report.decided ? pct(report.rate) : '—'}`,
    '',
    '| Правило | Решено | Согласие | approve без слияния | лишний вызов человека |',
    '|---|---|---|---|---|',
    ...Object.entries(report.byRule)
      .sort((a, b) => b[1].decided - a[1].decided)
      .map(([rule, r]) => `| ${rule} | ${r.decided} | ${pct(r.rate)} | ${r.falseApprove} | ${r.missedApprove} |`),
    '',
    report.enforceCandidates.length
      ? `Можно включить в enforce_classes: ${report.enforceCandidates.join(', ')} (≥ ${ENFORCE_MIN_DECIDED} решений, ≥ ${pct(ENFORCE_MIN_RATE)}, ни одного approve без слияния).`
      : `Кандидатов в enforce пока нет: нужно ≥ ${ENFORCE_MIN_DECIDED} решений по правилу и согласие ≥ ${pct(ENFORCE_MIN_RATE)} без approve без слияния.`,
  ];
  return lines.join('\n');
}

/** Собирает [{ mr, decision }] по MR проекта, обновлённым за `days` дней. */
export async function collectDecisions(gitlab, project, { days = 30, now = Date.now() } = {}) {
  const since = new Date(now - days * 86_400_000).toISOString();
  const mrs = await gitlab.listMrs(project, { updatedAfter: since });
  const out = [];
  for (const mr of mrs) {
    const notes = await gitlab.getNotes(project, mr.iid);
    let decision = null;
    for (const n of notes) {
      const d = parseDecision(n.body);
      if (d && (!decision || String(d.at) > String(decision.at))) decision = d;
    }
    if (decision) out.push({ mr, decision });
  }
  return out;
}
