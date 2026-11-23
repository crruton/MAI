/**
 * Калибратор архитектуры и PRD (F15, ADR 0090): контекст, разбор отчёта,
 * сравнение версий, Markdown, прогон с поддельной моделью.
 */
import { buildContext, contextHash, parseReport, diffReports, renderMarkdown, calibrate, MAX_CONTEXT } from '../electron/lib/calibrator.js';
import { BUILTIN_AGENTS } from '../electron/lib/agent-defs.js';

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

const parts = {
  prd: '# PRD\nПользователи входят через SSO.',
  model: { containers: [{ id: 'api', name: 'API' }] },
  views: { c1: { title: 'C1 · Контекст', mermaid: 'graph TD; U-->S' }, c2: { title: 'C2', mermaid: 'graph TD; A-->B' }, c4: { title: 'C4', mermaid: 'skip' } },
  adrs: [{ title: '0001 Хранилище', status: 'accepted', content: 'Postgres' }],
  openspec: [{ name: 'auth', title: 'Вход', summary: 'SSO', open: ['Keycloak', 'Роли'] }],
};

console.log('[1] контекст');
const ctx = buildContext(parts);
check('все части: PRD, модель, C1–C3 без C4, ADR, OpenSpec', /SSO/.test(ctx) && /"api"/.test(ctx) && /C1 · Контекст/.test(ctx) && !/skip/.test(ctx) && /0001 Хранилище \[accepted\]/.test(ctx) && /Открытые задачи: Keycloak; Роли/.test(ctx), ctx);
check('пустой вход — пометки «нет»', /нет docs\/PRD.md/.test(buildContext({})) && /## ADR \(0\)\n\(нет\)/.test(buildContext({})));
const huge = buildContext({ prd: 'x'.repeat(100_000), adrs: Array.from({ length: 60 }, (_, i) => ({ title: `ADR ${i}`, content: 'y'.repeat(5000) })) });
check('лимит контекста и обрезка частей', huge.length <= MAX_CONTEXT + 40 && /обрезано/.test(huge), huge.length);
check('отпечаток стабилен', contextHash(ctx) === contextHash(buildContext(parts)) && contextHash(ctx) !== contextHash(`${ctx} `));

console.log('[2] разбор отчёта');
const report = parseReport('```json\n{"summary":"Есть пробел","findings":[{"type":"gap","severity":"high","title":"Нет компонента SSO","detail":"PRD требует SSO","refs":["PRD","C2"],"suggestion":"Добавить Keycloak"},{"type":"weird","severity":"x","title":"Без типа"},{"title":""}]}\n```');
check('в блоке ```json, нормализация типа и важности, пустые выкинуты', report.findings.length === 2 && report.findings[1].type === 'question' && report.findings[1].severity === 'medium' && report.findings[0].refs.join() === 'PRD,C2', JSON.stringify(report));
let err = '';
try {
  parseReport('всё хорошо');
} catch (e) {
  err = e.message;
}
check('без JSON — понятная ошибка', /без JSON/.test(err), err);
err = '';
try {
  parseReport('{"summary":"x"}');
} catch (e) {
  err = e.message;
}
check('без findings — ошибка', /нет findings/.test(err), err);

console.log('[3] сравнение и Markdown');
const next = parseReport('{"summary":"…","findings":[{"type":"gap","severity":"medium","title":"Нет компонента  SSO!","detail":""},{"type":"risk","severity":"low","title":"Один экземпляр БД"}]}');
const d = diffReports(report, next);
check('новые, ушедшие, оставшиеся (заголовок без учёта регистра и знаков)', d.added.map((f) => f.title).join() === 'Один экземпляр БД' && d.resolved.map((f) => f.title).join() === 'Без типа' && d.kept.length === 1, JSON.stringify(d));
const md = renderMarkdown(report, { at: '2026-11-23T10:00:00Z', model: 'm', baseline: 'abc' });
check('Markdown: итог, разделы по типам, источники, что сделать', /## Итог\n\nЕсть пробел/.test(md) && /## Пробел \(1\)/.test(md) && /### \[high\] Нет компонента SSO/.test(md) && /Источники: PRD, C2/.test(md) && /Что сделать: Добавить Keycloak/.test(md) && /Отпечаток входа: abc/.test(md), md);
check('без находок — «согласованы»', /согласованы/.test(renderMarkdown({ summary: 'ок', findings: [] })));

console.log('[4] прогон с поддельной моделью');
const answers = [];
const fakeClient = (replies) => () => ({
  chat: {
    completions: {
      create: async (req) => {
        answers.push(req);
        return { choices: [{ message: { content: replies.shift() }, finish_reason: 'stop' }] };
      },
    },
  },
});
const provider = { name: 'p', baseURL: 'http://x', apiKey: 'k' };
const log = [];
const r1 = await calibrate({ provider, model: 'm', context: ctx, clientFactory: fakeClient(['не JSON', '{"summary":"ok","findings":[{"type":"risk","severity":"high","title":"Риск"}]}']), onLog: (l) => log.push(l) });
check('невалидный ответ — один повтор, отчёт разобран', r1.report.findings[0].title === 'Риск' && answers.length === 2 && /Ответ не принят/.test(answers[1].messages.at(-1).content), JSON.stringify(r1));
check('системный промпт с форматом, первый запуск без diff', /калибратор архитектуры/.test(answers[0].messages[0].content) && /"findings"/.test(answers[0].messages[0].content) && r1.diff === null && !r1.sameBaseline);
check('журнал шагов', log.some((l) => /Запрос к модели m/.test(l)) && log.some((l) => /повтор/.test(l)) && log.some((l) => /Находок: 1/.test(l)), log.join(' | '));
const r2 = await calibrate({ provider, model: 'm', context: ctx, prev: r1.report, prevBaseline: r1.baseline, clientFactory: fakeClient(['{"summary":"ok","findings":[]}']) });
check('тот же вход — sameBaseline и diff «ушло»', r2.sameBaseline && r2.diff.resolved.length === 1 && r2.diff.added.length === 0);
err = '';
await calibrate({ provider: { name: 'p', baseURL: 'http://x' }, model: 'm', context: ctx }).catch((e) => (err = e.message));
check('без ключа — ошибка до запроса', /API-ключ/.test(err), err);
err = '';
const hanging = () => ({ chat: { completions: { create: (_req, opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted')))) } } });
await calibrate({ provider, model: 'm', context: ctx, timeoutMs: 100, clientFactory: hanging }).catch((e) => (err = e.message));
check('таймаут — «не ответил за»', /не ответил за 0 с/.test(err), err);

console.log('[5] субагент calibrator');
const def = BUILTIN_AGENTS.find((a) => a.name === 'calibrator');
check('встроенный, только чтение, тот же промпт', def && def.source === 'builtin' && def.tools.includes('read_file') && !def.tools.some((t) => /write|edit|shell/.test(t)) && /калибратор архитектуры/.test(def.prompt));

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
