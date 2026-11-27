/**
 * MAI Ship ↔ Multica MAI (E3.C4, ADR 0128): ключ задачи в заголовке MR, статус задачи по MR.
 *
 * Ключ — `[MAI-42] Заголовок` (так пишет /ship), `MAI-42: Заголовок` или ветка `mai-42-кратко`.
 * `[NO-KEY]` — без задачи. Слитый MR → задача «done», открытый → «in_review». Статус только
 * продвигается вперёд: задачу, которую человек отменил, заблокировал или уже закрыл, не трогаем.
 * Закрытый без слияния MR задачу не меняет — это не значит, что работа отменена.
 */

const KEY = '([A-Za-z][A-Za-z0-9]{1,9}-\\d{1,7})';
const TITLE_RES = [new RegExp(`^\\s*\\[${KEY}\\]`), new RegExp(`^\\s*${KEY}\\s*[:\\-—]\\s`)];
const BRANCH_RE = new RegExp(`^(?:[\\w.-]+/)?${KEY}(?:[-_/]|$)`);

/** Ключ задачи MR: из заголовка, иначе из ветки. `[NO-KEY]` — пусто. */
export function issueKeyFromMr({ title: rawTitle = '', source_branch: branch = '', branch: b2 = '' } = {}) {
  // GitLab ставит перед заголовком Draft MR «Draft:» (/ship создаёт именно Draft).
  const title = String(rawTitle).replace(/^\s*(?:(?:Draft|WIP)\s*:|\[(?:Draft|WIP)\]|\((?:Draft|WIP)\))\s*/i, '');
  if (/^\s*\[NO-KEY\]/i.test(title)) return '';
  for (const re of TITLE_RES) {
    const m = re.exec(String(title));
    if (m) return m[1].toUpperCase();
  }
  const m = BRANCH_RE.exec(String(branch || b2 || ''));
  return m ? m[1].toUpperCase() : '';
}

/** Порядок статусов Multica; задачи вне него (blocked, cancelled) не трогаем. */
const ORDER = ['backlog', 'todo', 'in_progress', 'in_review', 'done'];

/** Статус задачи по состоянию MR или null. */
export function statusForMr(mr = {}) {
  if (mr.state === 'merged') return 'done';
  if (mr.state === 'opened') return 'in_review';
  return null;
}

/**
 * План: [{ key, id, from, to, mr }] — только шаги вперёд. Несколько MR на одну задачу: побеждает
 * самый «дальний» статус (слитый MR закрывает задачу, даже если открыт ещё один).
 * @param {Array<{ iid, title, state, source_branch, web_url }>} mrs
 * @param {Array<{ id, key, status }>} issues
 */
export function planIssueSync(mrs = [], issues = []) {
  const byKey = new Map(issues.filter((i) => i.key).map((i) => [String(i.key).toUpperCase(), i]));
  const want = new Map();
  for (const mr of mrs) {
    const key = issueKeyFromMr(mr);
    const to = statusForMr(mr);
    if (!key || !to) continue;
    const prev = want.get(key);
    if (!prev || ORDER.indexOf(to) > ORDER.indexOf(prev.to)) want.set(key, { to, mr });
  }
  const plan = [];
  const skipped = [];
  for (const [key, { to, mr }] of want) {
    const issue = byKey.get(key);
    if (!issue) {
      skipped.push({ key, reason: 'задачи нет в Multica', mr: mr.iid });
      continue;
    }
    const from = String(issue.status || '');
    const at = ORDER.indexOf(from);
    if (at < 0) {
      skipped.push({ key, reason: `статус «${from}» меняет только человек`, mr: mr.iid });
      continue;
    }
    if (at >= ORDER.indexOf(to)) continue; // уже там или дальше
    plan.push({ key, id: issue.id, from, to, mr: { iid: mr.iid, url: mr.web_url || '', title: mr.title || '' } });
  }
  return { plan, skipped };
}
