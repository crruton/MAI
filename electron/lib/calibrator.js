import crypto from 'node:crypto';
import OpenAI from 'openai';

/**
 * Калибратор архитектуры и PRD (F15, ADR 0090) — «второй взгляд» на PRD,
 * модель C1–C3, ADR и требования OpenSpec. Советник, а не гейт: отчёт
 * сохраняется артефактом `note` с версиями, повторный запуск сравнивается с
 * прошлым. Встроенный субагент `calibrator` (agent-defs) использует тот же промпт.
 *
 * Модуль не зависит от Electron: контекст собирает вызывающий.
 */

export const CALIBRATOR_PROMPT =
  'Ты — калибратор архитектуры и PRD: независимый ревьюер, не автор. Сопоставь PRD, модель архитектуры (C1–C3), ADR и требования ' +
  'и найди: противоречия (документы говорят разное), пробелы (требование без компонента, компонент без требования, нет решения), ' +
  'риски (масштаб, безопасность, данные, внешние зависимости) и вопросы к продукту. Опирайся только на присланное; ' +
  'каждую находку привязывай к источнику (PRD, C2, ADR-…, openspec/…). Не выдумывай факты и не переписывай документы.';

const FORMAT =
  'Ответь только JSON без пояснений:\n' +
  '{"summary": "2–4 предложения: общее состояние", "findings": [{"type": "contradiction|gap|risk|question", ' +
  '"severity": "high|medium|low", "title": "коротко, до 120 символов", "detail": "что не так и почему важно", ' +
  '"refs": ["PRD", "C2", "ADR-0003"], "suggestion": "что сделать"}]}\n' +
  'Не больше 25 находок, самые важные первыми. Если всё согласовано — пустой findings.';

export const TYPES = {
  contradiction: 'Противоречие',
  gap: 'Пробел',
  risk: 'Риск',
  question: 'Вопрос',
};
const SEVERITIES = ['high', 'medium', 'low'];
export const MAX_CONTEXT = 60_000;

/** Контекст калибровки из частей; каждая часть обрезается, чтобы влезли все. */
export function buildContext({ prd = '', model = {}, views = {}, adrs = [], openspec = [] } = {}) {
  const cut = (text, n) => {
    const s = String(text || '');
    return s.length > n ? `${s.slice(0, n)}\n…[обрезано ${s.length - n} симв.]` : s;
  };
  const parts = [
    `## PRD\n${cut(prd, 16_000) || '(нет docs/PRD.md)'}`,
    `## Модель архитектуры (JSON)\n${cut(JSON.stringify(model || {}, null, 1), 16_000)}`,
    ...['c1', 'c2', 'c3'].filter((k) => views[k]?.mermaid).map((k) => `## ${views[k].title || k.toUpperCase()}\n${cut(views[k].mermaid, 4_000)}`),
    `## ADR (${adrs.length})\n${
      adrs.length
        ? adrs
            .slice(0, 40)
            .map((a) => `### ${a.title} [${a.status || 'proposed'}]\n${cut(a.content, 1_200)}`)
            .join('\n\n')
        : '(нет)'
    }`,
    `## Требования OpenSpec (${openspec.length})\n${
      openspec.length
        ? openspec
            .slice(0, 30)
            .map((c) => `### ${c.name}: ${c.title}\n${cut(c.summary, 600)}\nОткрытые задачи: ${c.open.slice(0, 15).join('; ') || 'нет'}`)
            .join('\n\n')
        : '(нет)'
    }`,
  ];
  return cut(parts.join('\n\n'), MAX_CONTEXT);
}

/** Отпечаток входа: тот же baseline — тот же контекст. */
export const contextHash = (text) =>
  crypto
    .createHash('sha256')
    .update(String(text || ''))
    .digest('hex')
    .slice(0, 16);

/** Ответ модели → нормализованный отчёт; бросает понятную ошибку. */
export function parseReport(text) {
  const raw = String(text || '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Калибратор ответил без JSON');
  let data;
  try {
    data = JSON.parse(body.slice(start, end + 1));
  } catch (err) {
    throw new Error(`Не удалось разобрать JSON калибратора: ${err.message}`);
  }
  if (!data || !Array.isArray(data.findings)) throw new Error('В ответе калибратора нет findings');
  const findings = data.findings
    .filter((f) => f && typeof f === 'object' && String(f.title || '').trim())
    .slice(0, 25)
    .map((f) => ({
      type: TYPES[f.type] ? f.type : 'question',
      severity: SEVERITIES.includes(f.severity) ? f.severity : 'medium',
      title: String(f.title).trim().slice(0, 160),
      detail: String(f.detail || '')
        .trim()
        .slice(0, 1500),
      refs: Array.isArray(f.refs) ? f.refs.map((r) => String(r).slice(0, 60)).slice(0, 8) : [],
      suggestion: String(f.suggestion || '')
        .trim()
        .slice(0, 800),
    }));
  return {
    summary: String(data.summary || '')
      .trim()
      .slice(0, 1500),
    findings,
  };
}

const keyOf = (f) =>
  `${f.type}:${String(f.title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()}`;

/** Сравнение с прошлым отчётом: новые, ушедшие, оставшиеся (по типу и заголовку). */
export function diffReports(prev, next) {
  const before = new Map((prev?.findings || []).map((f) => [keyOf(f), f]));
  const after = new Map((next?.findings || []).map((f) => [keyOf(f), f]));
  return {
    added: [...after].filter(([k]) => !before.has(k)).map(([, f]) => f),
    resolved: [...before].filter(([k]) => !after.has(k)).map(([, f]) => f),
    kept: [...after].filter(([k]) => before.has(k)).map(([, f]) => f),
  };
}

/** Markdown для артефакта: читается и без приложения, diff версий — построчный. */
export function renderMarkdown(report, { at = new Date().toISOString(), model = '', baseline = '' } = {}) {
  const lines = [
    `# Калибровка архитектуры и PRD`,
    '',
    `- Дата: ${at}`,
    `- Модель: ${model || '—'}`,
    `- Отпечаток входа: ${baseline || '—'}`,
    '',
    '## Итог',
    '',
    report.summary || '—',
    '',
  ];
  for (const type of Object.keys(TYPES)) {
    const list = report.findings.filter((f) => f.type === type);
    if (!list.length) continue;
    lines.push(`## ${TYPES[type]} (${list.length})`, '');
    for (const f of list) {
      lines.push(`### [${f.severity}] ${f.title}`, '', f.detail || '—');
      if (f.refs.length) lines.push('', `Источники: ${f.refs.join(', ')}`);
      if (f.suggestion) lines.push('', `Что сделать: ${f.suggestion}`);
      lines.push('');
    }
  }
  if (!report.findings.length) lines.push('Находок нет: документы согласованы.', '');
  return lines.join('\n');
}

/**
 * Один прогон калибровки: модель → отчёт (один повтор при невалидном JSON).
 * `prev` — прошлый отчёт из артефакта; возвращает { report, diff, baseline, sameBaseline }.
 */
export async function calibrate({
  provider,
  model,
  context,
  prev = null,
  prevBaseline = '',
  signal,
  timeoutMs = 180_000,
  clientFactory = null,
  onLog = () => {},
}) {
  if (!provider?.baseURL) throw new Error('У выбранного провайдера не задан Base URL');
  if (!provider?.apiKey) throw new Error(`Не задан API-ключ провайдера «${provider.name || 'unknown'}»`);
  const client = (clientFactory || ((o) => new OpenAI(o)))({
    apiKey: provider.apiKey,
    baseURL: provider.baseURL,
    maxRetries: 1,
  });
  const baseline = contextHash(context);
  // Свой таймер, а не AbortSignal.timeout: тот не держит процесс и не виден в тестах.
  const controller = new AbortController();
  const timeout = controller.signal;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    return await runCalibration();
  } finally {
    clearTimeout(timer);
  }

  async function runCalibration() {
    const ask = (messages) => client.chat.completions.create({ model, messages, temperature: 0.2, max_tokens: 6000 }, { signal: combined });
    const messages = [
      { role: 'system', content: `${CALIBRATOR_PROMPT}\n\n${FORMAT}` },
      { role: 'user', content: context },
    ];
    onLog(`Запрос к модели ${model}: ${context.length} симв. контекста`);
    let response;
    try {
      response = await ask(messages);
    } catch (err) {
      if (timeout.aborted) throw new Error(`Калибратор не ответил за ${Math.round(timeoutMs / 1000)} с`);
      throw err;
    }
    let text = response.choices?.[0]?.message?.content || '';
    let report;
    try {
      if (response.choices?.[0]?.finish_reason === 'length') throw new Error('ответ обрезан по лимиту токенов');
      report = parseReport(text);
    } catch (err) {
      onLog(`Ответ не разобран (${err.message}) — повтор`);
      response = await ask([
        ...messages,
        { role: 'assistant', content: text.slice(0, 4000) },
        {
          role: 'user',
          content: `Ответ не принят: ${err.message}. Верни только JSON в заданном формате, короче.`,
        },
      ]);
      text = response.choices?.[0]?.message?.content || '';
      report = parseReport(text);
    }
    onLog(`Находок: ${report.findings.length}`);
    return {
      report,
      diff: prev ? diffReports(prev, report) : null,
      baseline,
      sameBaseline: Boolean(prevBaseline && prevBaseline === baseline),
    };
  }
}
