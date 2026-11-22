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
saveSettings({ telemetry: { enabled: true, endpoint: `http://127.0.0.1:${server.address().port}`, serviceName: 'mai-code-test' } });
const { emitSpan } = await import('../electron/lib/telemetry.js');
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
server.close();
try {
  fs.rmSync(sandbox, { recursive: true, force: true });
} catch {
  /* кеш Electron */
}
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
app.exit(fail ? 1 : 0);
});
