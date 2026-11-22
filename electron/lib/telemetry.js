import crypto from 'node:crypto';
import { loadSettings } from './config.js';
import { redactSecrets } from './guardrails.js';

/**
 * Минимальный OTLP/HTTP-экспортёр без внешних зависимостей.
 *
 * Включается настройкой telemetry.enabled или переменной
 * OTEL_EXPORTER_OTLP_ENDPOINT. Отправка не блокирует UI: ошибки сети
 * игнорируются. Секреты маскируются перед отправкой.
 */

function config() {
  let settings = {};
  try {
    settings = loadSettings();
  } catch {
    settings = {};
  }
  const telemetry = settings.telemetry || {};
  const endpoint = String(
    telemetry.endpoint || process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '',
  ).replace(/\/$/, '');
  return {
    enabled: Boolean(telemetry.enabled || process.env.OTEL_EXPORTER_OTLP_ENDPOINT),
    endpoint,
    serviceName: telemetry.serviceName || process.env.OTEL_SERVICE_NAME || 'mai-code',
  };
}

export function telemetryStatus() {
  const cfg = config();
  return { enabled: cfg.enabled, endpoint: cfg.endpoint, serviceName: cfg.serviceName };
}

function hex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function attrs(attributes = {}) {
  return Object.entries(attributes)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => {
      if (typeof value === 'boolean') return { key, value: { boolValue: value } };
      if (typeof value === 'number') return { key, value: { intValue: String(value) } };
      return { key, value: { stringValue: redactSecrets(String(value)).slice(0, 2000) } };
    });
}

function resource(cfg) {
  return {
    attributes: [
      { key: 'service.name', value: { stringValue: cfg.serviceName } },
      { key: 'service.version', value: { stringValue: '0.1.0' } },
      { key: 'deployment.environment', value: { stringValue: process.env.NODE_ENV || 'local' } },
    ],
  };
}

async function post(cfg, path, body) {
  if (!cfg.enabled || !cfg.endpoint) return false;
  try {
    const response = await fetch(`${cfg.endpoint}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function emitLog(message, { severity = 'INFO', attributes = {} } = {}) {
  const cfg = config();
  if (!cfg.enabled) return;
  const now = String(BigInt(Date.now()) * 1_000_000n);
  const payload = {
    resourceLogs: [
      {
        resource: resource(cfg),
        scopeLogs: [
          {
            scope: { name: 'mai-code.app' },
            logRecords: [
              {
                timeUnixNano: now,
                severityNumber: severity === 'ERROR' ? 17 : severity === 'WARN' ? 13 : 9,
                severityText: severity,
                body: { stringValue: redactSecrets(String(message)).slice(0, 8000) },
                attributes: attrs(attributes),
              },
            ],
          },
        ],
      },
    ],
  };
  void post(cfg, '/v1/logs', payload);
}

export function emitSpan(name, { startMs, endMs, attributes = {}, error = '', traceId = hex(16), spanId = hex(8), parentSpanId } = {}) {
  const cfg = config();
  if (!cfg.enabled) return;
  const start = BigInt(Math.round(startMs || Date.now())) * 1_000_000n;
  const end = BigInt(Math.round(endMs || Date.now())) * 1_000_000n;
  const payload = {
    resourceSpans: [
      {
        resource: resource(cfg),
        scopeSpans: [
          {
            scope: { name: 'mai-code.app' },
            spans: [
              {
                traceId,
                spanId,
                ...(parentSpanId ? { parentSpanId } : {}),
                name,
                kind: 1,
                startTimeUnixNano: String(start),
                endTimeUnixNano: String(end > start ? end : start + 1_000_000n),
                attributes: attrs(attributes),
                status: { code: error ? 2 : 1, message: error || undefined },
              },
            ],
          },
        ],
      },
    ],
  };
  void post(cfg, '/v1/traces', payload);
}
