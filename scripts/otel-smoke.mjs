#!/usr/bin/env node
/**
 * Проверяет, что OTLP-стек жив: отправляет тестовый trace и лог в
 * OTel Collector и ждёт, пока Tempo отдаст trace по ID.
 *
 *   npm run obs:smoke
 *   node scripts/otel-smoke.mjs --endpoint http://127.0.0.1:4318 --tempo http://127.0.0.1:3200
 */

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const endpoint = String(arg('--endpoint', process.env.OTLP_HTTP_ENDPOINT || 'http://127.0.0.1:4318')).replace(/\/$/, '');
const tempo = String(arg('--tempo', process.env.TEMPO_URL || 'http://127.0.0.1:3200')).replace(/\/$/, '');

const traceId = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
const spanId = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
const now = BigInt(Date.now()) * 1_000_000n;

const resource = {
  attributes: [
    { key: 'service.name', value: { stringValue: 'mai-code-smoke' } },
    { key: 'service.version', value: { stringValue: '0.1.0' } },
  ],
};

const tracePayload = {
  resourceSpans: [
    {
      resource,
      scopeSpans: [
        {
          scope: { name: 'mai-code.smoke', version: '1.0.0' },
          spans: [
            {
              traceId,
              spanId,
              name: 'smoke-test',
              kind: 1,
              startTimeUnixNano: String(now),
              endTimeUnixNano: String(now + 5_000_000n),
              attributes: [{ key: 'smoke', value: { boolValue: true } }],
              status: { code: 1 },
            },
          ],
        },
      ],
    },
  ],
};

const logPayload = {
  resourceLogs: [
    {
      resource,
      scopeLogs: [
        {
          scope: { name: 'mai-code.smoke' },
          logRecords: [
            {
              timeUnixNano: String(now),
              severityNumber: 9,
              severityText: 'INFO',
              body: { stringValue: `MAI Code OTel smoke trace=${traceId}` },
              traceId,
              spanId,
            },
          ],
        },
      ],
    },
  ],
};

async function post(path, body) {
  const response = await fetch(`${endpoint}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${text.slice(0, 300)}`);
  return { status: response.status, text };
}

async function waitForTrace(timeoutMs = 45_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${tempo}/api/traces/${traceId}`);
      if (response.ok) {
        const data = await response.json();
        const batches = data?.batches || data?.resourceSpans || [];
        if (batches.length) return true;
      }
    } catch {
      /* Tempo ещё не поднялся */
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}

try {
  const traces = await post('/v1/traces', tracePayload);
  const logs = await post('/v1/logs', logPayload);
  console.log(`OTLP принят: traces HTTP ${traces.status}, logs HTTP ${logs.status}`);
  console.log(`traceId: ${traceId}`);
  const found = await waitForTrace();
  if (!found) {
    console.error('Tempo не вернул trace за 45 секунд. Проверьте: docker compose -f infra/observability/docker-compose.yml logs tempo otel-collector');
    process.exitCode = 1;
  } else {
    console.log(`Tempo вернул trace: ${tempo}/trace/${traceId}`);
    console.log('Проверьте Grafana → Explore → Tempo/Loki, а также Phoenix http://localhost:6006.');
  }
} catch (err) {
  console.error(`Smoke-тест не прошёл: ${err.message}`);
  console.error('Стек запущен? npm run obs:up');
  process.exitCode = 1;
}
