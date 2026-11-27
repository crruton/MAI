/**
 * MAI Ship: учёт затрат на модели (E3.B4, ADR 0124). Без Electron.
 *
 * Расход живёт в самих MR: в комментарии роли лежит запись `<!-- mai-ship:cost {...} -->`.
 * Комментарий роли перезаписывается (upsertNote) — запись в нём накопительная; новый комментарий
 * (раунд steward) несёт расход своего прогона. Расход MR — сумма всех записей в его комментариях,
 * за месяц — сумма записей текущего месяца по MR, обновлённым в этом месяце.
 * Цены — `pricing` в ship.yaml: доллары за миллион токенов, как `telemetry.pricing` в MAI.
 */
import { normalizeUsage } from '../usage.js';
import { priceOf } from '../metrics.js';

export const COST_MARKER_RE = /<!-- mai-ship:cost (\{.*?\}) -->/g;

const round = (x) => Math.round(Number(x || 0) * 1e6) / 1e6;

export function costMarker(rec) {
  return `<!-- mai-ship:cost ${JSON.stringify(rec).replace(/--/g, '-\\u002d')} -->`;
}

/** Все записи расхода в тексте комментария. */
export function parseCosts(body) {
  const out = [];
  for (const m of String(body || '').matchAll(COST_MARKER_RE)) {
    try {
      const rec = JSON.parse(m[1]);
      if (rec && rec.v === 1 && Number.isFinite(Number(rec.usd))) out.push(rec);
    } catch {
      /* битая запись — пропуск */
    }
  }
  return out;
}

/** Сложить записи одной роли в одну накопительную. */
export function mergeCosts(records, role = '') {
  const list = records.filter(Boolean);
  if (!list.length) return null;
  const models = new Set();
  let unpriced = false;
  const sum = { v: 1, role: role || list[0].role || '', input: 0, output: 0, usd: 0, calls: 0, at: '' };
  for (const r of list) {
    sum.input += Number(r.input || 0);
    sum.output += Number(r.output || 0);
    sum.usd += Number(r.usd || 0);
    sum.calls += Number(r.calls || 0);
    if (String(r.at || '') > sum.at) sum.at = String(r.at);
    for (const m of r.models || []) models.add(m);
    if (r.unpriced) unpriced = true;
  }
  sum.usd = round(sum.usd);
  sum.models = [...models];
  if (unpriced) sum.unpriced = true;
  return sum;
}

/**
 * Счётчик прогона роли.
 * @param {{ role: string, pricing?: object, now?: () => string }} o
 */
export function createMeter({ role, pricing = {}, now = () => new Date().toISOString() }) {
  const rec = { v: 1, role, input: 0, output: 0, usd: 0, calls: 0, models: [], at: '' };
  const meter = {
    /** usage провайдера (любой формат) → в счёт. */
    add(model, rawUsage) {
      const u = rawUsage && 'input' in rawUsage && 'output' in rawUsage ? rawUsage : normalizeUsage(rawUsage);
      rec.calls += 1;
      rec.at = now();
      if (model && !rec.models.includes(model)) rec.models.push(model);
      if (!u) return;
      rec.input += u.input;
      rec.output += u.output;
      const price = priceOf(pricing || {}, model);
      if (price) rec.usd = round(rec.usd + (u.input * price.input + u.output * price.output) / 1_000_000);
      else if (u.input || u.output) rec.unpriced = true;
    },
    /** История цикла агента MAI: usage на сообщениях ассистента. */
    addHistory(model, history = []) {
      for (const m of history) if (m?.role === 'assistant' && m.usage) meter.add(model, m.usage);
    },
    /** Клиент OpenAI, который считает каждый ответ chat.completions. */
    wrap(client, model) {
      return {
        ...client,
        chat: {
          completions: {
            create: async (body, opts) => {
              const res = await client.chat.completions.create(body, opts);
              meter.add(model || body?.model, res?.usage);
              return res;
            },
          },
        },
      };
    },
    record: () => (rec.calls ? { ...rec, usd: round(rec.usd), models: [...rec.models] } : null),
  };
  return meter;
}

/** Расход MR по его комментариям; с `since` — только записи не раньше этой даты. */
export function mrCost(notes = [], { since = '' } = {}) {
  let usd = 0;
  let tokens = 0;
  let unpriced = false;
  for (const n of notes) {
    for (const r of parseCosts(n.body)) {
      if (since && String(r.at || '') < since) continue;
      usd += Number(r.usd || 0);
      tokens += Number(r.input || 0) + Number(r.output || 0);
      if (r.unpriced) unpriced = true;
    }
  }
  return { usd: round(usd), tokens, unpriced };
}

export function monthStart(now = Date.now()) {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

/** Расход проекта за текущий месяц (UTC). */
export async function monthCost(gitlab, project, { now = Date.now(), skipIid = null, extra = 0 } = {}) {
  const since = monthStart(now);
  const mrs = await gitlab.listMrs(project, { updatedAfter: since });
  let usd = extra;
  for (const mr of mrs) {
    if (skipIid != null && Number(mr.iid) === Number(skipIid)) continue;
    usd += mrCost(await gitlab.getNotes(project, mr.iid), { since }).usd;
  }
  return round(usd);
}

/**
 * Бюджет: { mr, month, exceeded: причина | '' }. Месяц считается, только если задан `monthly_usd`.
 * `notes` — уже прочитанные комментарии этого MR.
 */
export async function budgetState({ gitlab, project, iid, budget = {}, notes, now = Date.now() }) {
  const perMr = Number(budget?.per_mr_usd || 0);
  const monthly = Number(budget?.monthly_usd || 0);
  const mrNotes = notes || (await gitlab.getNotes(project, iid));
  const mr = mrCost(mrNotes).usd;
  let month = null;
  if (monthly) {
    try {
      month = await monthCost(gitlab, project, { now, skipIid: iid, extra: mrCost(mrNotes, { since: monthStart(now) }).usd });
    } catch {
      month = null; // не посчитали — не блокируем: бюджет MR всё равно проверен
    }
  }
  let exceeded = '';
  if (perMr && mr > perMr) exceeded = `бюджет MR исчерпан: $${mr} из $${perMr}`;
  else if (monthly && month != null && month > monthly) exceeded = `месячный бюджет исчерпан: $${month} из $${monthly}`;
  return { mr, month, exceeded };
}

/** Строка расхода для комментария роли. */
export function costLine(rec) {
  if (!rec) return '';
  const usd = rec.unpriced && !rec.usd ? 'цена модели не задана (pricing в ship.yaml)' : `$${rec.usd}${rec.unpriced ? ' (не для всех моделей есть цена)' : ''}`;
  return `Расход моделей: ${usd}, токенов ↑${rec.input} ↓${rec.output}, вызовов ${rec.calls}.`;
}
