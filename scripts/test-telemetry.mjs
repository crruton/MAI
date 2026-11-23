/**
 * OTLP-экспорт спанов агента (F22, ADR 0063): дерево через parentSpanId.
 * Под Electron: telemetry.js читает настройки через config.js.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  OK   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${extra}`);
  }
}
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-otel-'));
app.setPath('userData', sandbox);
app.whenReady().then(async () => {
const received = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({ url: req.url, body: JSON.parse(body) });
    res.writeHead(200).end('{}');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { saveSettings } = await import('../electron/lib/config.js');
saveSettings({ telemetry: { enabled: true, endpoint: `http://127.0.0.1:${server.address().port}`, serviceName: 'mai-code-test', pricing: { m: { input: 2, output: 10 } } } });
const { emitSpan, flushMetrics } = await import('../electron/lib/telemetry.js');
const { createTracer } = await import('../electron/lib/tracer.js');
const tracer = createTracer(emitSpan);
const run = tracer.start('agent.run', { 'agent.model': 'm' });
tracer.start('agent.tool', { 'agent.tool': 'read_file', 'agent.approved': true, 'gen_ai.usage.input_tokens': 120, secret: 'sk-abcdefghijklmnopqrstuvwx' }, run).end({ 'agent.decision': 'allow' });
run.end();
await new Promise((r) => setTimeout(r, 800));
const spans = received.filter((r) => r.url === '/v1/traces').map((r) => r.body.resourceSpans[0].scopeSpans[0].spans[0]);
const tool = spans.find((s) => s.name === 'agent.tool');
const root = spans.find((s) => s.name === 'agent.run');
check('два спана ушли в /v1/traces', spans.length === 2, JSON.stringify(received.map((r) => r.url)));
check('один traceId, parentSpanId у инструмента', tool?.traceId === root?.traceId && tool?.parentSpanId === root?.spanId && !root?.parentSpanId);
const attr = (s, k) => s?.attributes.find((a) => a.key === k)?.value;
check('типы атрибутов: строка, булево, число', attr(tool, 'agent.tool')?.stringValue === 'read_file' && attr(tool, 'agent.approved')?.boolValue === true && attr(tool, 'gen_ai.usage.input_tokens')?.intValue === '120' && attr(tool, 'agent.decision')?.stringValue === 'allow');
check('секрет в атрибуте замаскирован', Boolean(tool) && !JSON.stringify(tool).includes('sk-abcdefghijklmnopqrstuvwx'));

console.log('[метрики агента — F23, ADR 0094]');
const run2 = tracer.start('agent.run', {});
tracer.start('agent.step', { 'agent.model': 'm' }, run2).end({ 'gen_ai.usage.input_tokens': 1000, 'gen_ai.usage.output_tokens': 500 });
tracer.start('agent.tool', { 'agent.tool': 'run_shell', 'agent.tool.class': 'exec' }, run2).end({ 'agent.decision': 'ask', 'agent.approved': false, 'agent.tool.ok': false });
run2.end();
check('flush — POST /v1/metrics', (await flushMetrics()) === true);
await new Promise((r) => setTimeout(r, 300));
const mbody = received.filter((r) => r.url === '/v1/metrics').at(-1)?.body;
const metricsByName = Object.fromEntries((mbody?.resourceMetrics[0].scopeMetrics[0].metrics || []).map((m) => [m.name, m.sum]));
const point = (name, labels) => metricsByName[name]?.dataPoints.find((p) => Object.entries(labels).every(([k, v]) => p.attributes.find((a) => a.key === k)?.value.stringValue === v));
check('ресурс с service.name', mbody?.resourceMetrics[0].resource.attributes.some((a) => a.key === 'service.name' && a.value.stringValue === 'mai-code-test'));
check('кумулятивные монотонные суммы', Object.values(metricsByName).every((s) => s.aggregationTemporality === 2 && s.isMonotonic));
check('токены по модели и виду', point('mai_tokens', { model: 'm', kind: 'input' })?.asInt === '1000' && point('mai_tokens', { model: 'm', kind: 'output' })?.asInt === '500');
check('стоимость по цене за 1 млн: 0,007 $', Math.abs((point('mai_cost_usd', { model: 'm' })?.asDouble || 0) - 0.007) < 1e-9, JSON.stringify(point('mai_cost_usd', { model: 'm' })));
check('ошибка инструмента и отказ в разрешении', point('mai_tool_calls', { tool: 'run_shell', ok: 'false' })?.asInt === '1' && point('mai_permission_decisions', { cls: 'exec', decision: 'ask', approved: 'false' })?.asInt === '1');
check('прогоны: 2 успешных', point('mai_agent_runs', { outcome: 'ok' })?.asInt === '2');
check('без новых спанов — нечего слать', (await flushMetrics()) === false);
server.close();
try {
  fs.rmSync(sandbox, { recursive: true, force: true });
} catch {
  /* кеш Electron */
}
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
app.exit(fail ? 1 : 0);
});
