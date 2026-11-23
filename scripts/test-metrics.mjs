/**
 * Метрики агента (F23, ADR 0094): счётчики из спанов, цены, OTLP-пакет и
 * согласованность с дашбордом Grafana.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMetrics, priceOf, METRIC_NAMES } from '../electron/lib/metrics.js';

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
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

console.log('[1] цены');
const pricing = { 'gpt-5': { input: 1.25, output: 10 }, 'mai/glm-4.6': { input: 0.6, output: 2.2 }, bad: { input: 'x' } };
check('точное имя и «провайдер/модель» → модель', priceOf(pricing, 'gpt-5')?.output === 10 && priceOf(pricing, 'openai/gpt-5')?.input === 1.25 && priceOf(pricing, 'mai/glm-4.6')?.input === 0.6);
check('нет цены или неверная — null', priceOf(pricing, 'other') === null && priceOf(pricing, 'bad') === null && priceOf(undefined, 'x') === null);

console.log('[2] спаны → счётчики');
let t = 1_700_000_000_000;
const m = createMetrics({ pricing: () => pricing, now: () => t });
m.fromSpan('agent.step', { attributes: { 'agent.model': 'openai/gpt-5', 'gen_ai.usage.input_tokens': 2000, 'gen_ai.usage.output_tokens': 300 } });
m.fromSpan('agent.step', { attributes: { 'agent.model': 'openai/gpt-5', 'gen_ai.usage.input_tokens': 1000 } });
m.fromSpan('agent.step', { attributes: { 'agent.model': 'local/qwen' , 'gen_ai.usage.input_tokens': 50, 'gen_ai.usage.output_tokens': 5 } });
m.fromSpan('agent.step', { attributes: { 'agent.model': 'openai/gpt-5' }, error: 'HTTP 500' });
m.fromSpan('agent.step', { attributes: { 'agent.model': 'openai/gpt-5' }, error: 'остановлено' });
m.fromSpan('agent.tool', { attributes: { 'agent.tool': 'read_file', 'agent.tool.class': 'read', 'agent.decision': 'allow', 'agent.tool.ok': true } });
m.fromSpan('agent.tool', { attributes: { 'agent.tool': 'run_shell', 'agent.tool.class': 'exec', 'agent.decision': 'ask', 'agent.approved': false, 'agent.tool.ok': false } });
m.fromSpan('agent.tool', { attributes: { 'agent.tool': 'write_file', 'agent.tool.class': 'write', 'agent.decision': 'deny' } , error: 'запрещено' });
m.fromSpan('agent.tool', { attributes: { 'agent.tool': 'glob' } });
m.fromSpan('agent.run', { attributes: {} });
m.fromSpan('agent.run', { attributes: { 'agent.stopped': true } });
m.fromSpan('agent.run', { attributes: {}, error: 'Модель не отвечала' });
m.fromSpan('runtime.run', { attributes: {} });
const get = (name, labels) => m.series().filter((s) => s.name === name && Object.entries(labels).every(([k, v]) => s.labels[k] === v)).reduce((a, s) => a + s.value, 0);
check('токены суммируются по модели и виду', get('mai_tokens', { model: 'openai/gpt-5', kind: 'input' }) === 3000 && get('mai_tokens', { model: 'openai/gpt-5', kind: 'output' }) === 300);
check('стоимость: (3000×1,25 + 300×10) / 1e6', Math.abs(get('mai_cost_usd', { model: 'openai/gpt-5' }) - 0.00675) < 1e-12, get('mai_cost_usd', { model: 'openai/gpt-5' }));
check('модель без цены — токены есть, стоимости нет', get('mai_tokens', { model: 'local/qwen' }) === 55 && get('mai_cost_usd', { model: 'local/qwen' }) === 0);
check('ошибка модели считается, остановка — нет', get('mai_model_errors', { model: 'openai/gpt-5' }) === 1);
check('инструменты: ok и ошибки (по флагу и по error)', get('mai_tool_calls', { ok: 'true' }) === 2 && get('mai_tool_calls', { tool: 'run_shell', ok: 'false' }) === 1 && get('mai_tool_calls', { tool: 'write_file', ok: 'false' }) === 1);
check('решения: allow, ask+отклонено, deny; без решения — нет записи', get('mai_permission_decisions', { decision: 'allow', approved: 'true' }) === 1 && get('mai_permission_decisions', { decision: 'ask', approved: 'false', cls: 'exec' }) === 1 && get('mai_permission_decisions', { decision: 'deny' }) === 1 && get('mai_permission_decisions', {}) === 3);
check('прогоны: ok, stopped, error', get('mai_agent_runs', { outcome: 'ok' }) === 1 && get('mai_agent_runs', { outcome: 'stopped' }) === 1 && get('mai_agent_runs', { outcome: 'error' }) === 1);
check('чужие спаны не считаются', !m.series().some((s) => /runtime/.test(s.name)));

console.log('[3] OTLP');
t += 15_000;
const res = { attributes: [{ key: 'service.name', value: { stringValue: 'mai-code' } }] };
const otlp = m.toOtlp(res);
const ms = otlp.resourceMetrics[0].scopeMetrics[0].metrics;
check('все шесть метрик, монотонные кумулятивные', ms.length === 6 && ms.every((x) => x.sum.isMonotonic && x.sum.aggregationTemporality === 2) && ms.every((x) => METRIC_NAMES.includes(x.name)), ms.map((x) => x.name).join());
const cost = ms.find((x) => x.name === 'mai_cost_usd').sum.dataPoints[0];
const tokens = ms.find((x) => x.name === 'mai_tokens').sum.dataPoints[0];
check('стоимость — asDouble, счётчики — asInt строкой', typeof cost.asDouble === 'number' && typeof tokens.asInt === 'string');
check('начало ряда — старт процесса, время — сейчас', tokens.startTimeUnixNano === String(1_700_000_000_000n * 1_000_000n) && tokens.timeUnixNano === String(BigInt(t) * 1_000_000n));
check('повтор без изменений — null; force — пакет', m.toOtlp(res) === null && m.toOtlp(res, { force: true }) !== null);
check('пустые метрики — null даже с force', createMetrics().toOtlp(res, { force: true }) === null);

console.log('[4] дашборд Grafana');
const dash = JSON.parse(fs.readFileSync(path.join(root, 'infra/observability/grafana/dashboards/mai-code-overview.json'), 'utf8'));
const exprs = dash.panels.flatMap((p) => (p.targets || []).map((x) => x.expr));
const used = new Set(exprs.flatMap((e) => [...e.matchAll(/\b(mai_[a-z_]+?)_total\b/g)].map((x) => x[1])));
check('дашборд ссылается только на метрики из metrics.js', [...used].every((n) => METRIC_NAMES.includes(n)), [...used].join());
check('каждая метрика агента — хотя бы на одной панели', METRIC_NAMES.every((n) => used.has(n)), METRIC_NAMES.filter((n) => !used.has(n)).join());
const titles = dash.panels.map((p) => p.title);
check('панели: токены, стоимость, ошибки инструментов, отказы разрешений', ['Токены по моделям', 'Стоимость по моделям', 'Ошибки инструментов', 'Отказы разрешений, час'].every((x) => titles.includes(x)));
check('панели не перекрываются', (() => {
  const boxes = dash.panels.map((p) => p.gridPos);
  return boxes.every((a, i) => boxes.every((b, j) => i === j || a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y));
})());
check('id панелей уникальны', new Set(dash.panels.map((p) => p.id)).size === dash.panels.length);

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
