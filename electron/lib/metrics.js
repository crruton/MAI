/**
 * Метрики агента для Grafana (F23, ADR 0094): счётчики из спанов прогона
 * (ADR 0063) → OTLP/HTTP `/v1/metrics` → otel-collector → Prometheus.
 *
 * Имена в Prometheus (экспортёр коллектора добавляет `_total` монотонным суммам):
 *   mai_agent_runs_total{outcome}                       прогоны: ok / error / stopped
 *   mai_tokens_total{model, kind}                       токены: input / output
 *   mai_cost_usd_total{model}                           стоимость по ценам из telemetry.pricing
 *   mai_model_errors_total{model}                       ошибки запроса к модели
 *   mai_tool_calls_total{tool, cls, ok}                 вызовы инструментов
 *   mai_permission_decisions_total{cls, decision, approved}  решения PolicyEngine
 *
 * Модуль не зависит от Electron.
 */

export const METRIC_NAMES = ['mai_agent_runs', 'mai_tokens', 'mai_cost_usd', 'mai_model_errors', 'mai_tool_calls', 'mai_permission_decisions'];

const DOUBLE = new Set(['mai_cost_usd']);

/** Цена модели за 1 млн токенов: точное имя или «провайдер/модель» → { input, output }. */
export function priceOf(pricing = {}, model = '') {
  const key = String(model || '');
  const p = pricing[key] || pricing[key.split('/').pop()];
  if (!p || typeof p !== 'object') return null;
  const input = Number(p.input);
  const output = Number(p.output);
  return Number.isFinite(input) && Number.isFinite(output) ? { input, output } : null;
}

export function createMetrics({ pricing = () => ({}), now = () => Date.now() } = {}) {
  const startNano = String(BigInt(now()) * 1_000_000n);
  const series = new Map(); // name|labels → { name, labels, value }
  let dirty = false;

  const add = (name, labels, value = 1) => {
    if (!value || !Number.isFinite(value)) return;
    const clean = Object.fromEntries(Object.entries(labels).map(([k, v]) => [k, String(v ?? '').slice(0, 120)]));
    const key = `${name}|${JSON.stringify(clean)}`;
    const item = series.get(key) || { name, labels: clean, value: 0 };
    item.value += value;
    series.set(key, item);
    dirty = true;
  };

  /** Спан закончился → счётчики. `attributes` — как у tracer.end. */
  const fromSpan = (name, { attributes = {}, error = '' } = {}) => {
    const a = attributes;
    if (name === 'agent.run') {
      add('mai_agent_runs', { outcome: a['agent.stopped'] || error === 'остановлено' ? 'stopped' : error ? 'error' : 'ok' });
    } else if (name === 'agent.step') {
      const model = a['agent.model'] || 'unknown';
      if (error) {
        if (error !== 'остановлено') add('mai_model_errors', { model });
        return;
      }
      const input = Number(a['gen_ai.usage.input_tokens']) || 0;
      const output = Number(a['gen_ai.usage.output_tokens']) || 0;
      add('mai_tokens', { model, kind: 'input' }, input);
      add('mai_tokens', { model, kind: 'output' }, output);
      const price = priceOf(pricing() || {}, model);
      if (price) add('mai_cost_usd', { model }, (input * price.input + output * price.output) / 1_000_000);
    } else if (name === 'agent.tool') {
      const tool = a['agent.tool'] || 'unknown';
      const cls = a['agent.tool.class'] || '';
      add('mai_tool_calls', { tool, cls, ok: error || a['agent.tool.ok'] === false ? 'false' : 'true' });
      if (a['agent.decision']) add('mai_permission_decisions', { cls, decision: a['agent.decision'], approved: a['agent.approved'] === false ? 'false' : 'true' });
    }
  };

  /** OTLP-пакет: кумулятивные монотонные суммы с начала процесса. null — нечего слать. */
  const toOtlp = (resource, { force = false } = {}) => {
    if (!dirty && !force) return null;
    dirty = false;
    const time = String(BigInt(now()) * 1_000_000n);
    const byName = new Map();
    for (const s of series.values()) {
      if (!byName.has(s.name)) byName.set(s.name, []);
      byName.get(s.name).push({
        attributes: Object.entries(s.labels).map(([key, value]) => ({ key, value: { stringValue: value } })),
        startTimeUnixNano: startNano,
        timeUnixNano: time,
        ...(DOUBLE.has(s.name) ? { asDouble: s.value } : { asInt: String(Math.round(s.value)) }),
      });
    }
    if (!byName.size) return null;
    return {
      resourceMetrics: [
        {
          resource,
          scopeMetrics: [
            {
              scope: { name: 'mai-code.agent' },
              // aggregationTemporality 2 — CUMULATIVE.
              metrics: [...byName].map(([name, dataPoints]) => ({ name, sum: { dataPoints, aggregationTemporality: 2, isMonotonic: true } })),
            },
          ],
        },
      ],
    };
  };

  return { add, fromSpan, toOtlp, series: () => [...series.values()].map((s) => ({ ...s })) };
}
