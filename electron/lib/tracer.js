/**
 * Трассировка прогона агента (бэклог F22, ADR 0063): одно дерево спанов на
 * прогон — agent.run → agent.step (запрос к модели) → agent.tool (вызов).
 * `emit(name, { traceId, spanId, parentSpanId, startMs, endMs, attributes, error })`
 * — экспортёр (OTLP в telemetry.js); без экспортёра трассировщик ничего не делает.
 *
 * Модуль не зависит от Electron.
 */
import crypto from 'node:crypto';

const hex = (n) => crypto.randomBytes(n).toString('hex');

export function createTracer(emit, { traceId = hex(16) } = {}) {
  const start = (name, attributes = {}, parent = null) => {
    const spanId = hex(8);
    const startMs = Date.now();
    let ended = false;
    return {
      id: spanId,
      traceId,
      end(extra = {}, error = '') {
        if (ended) return;
        ended = true;
        try {
          emit?.(name, { traceId, spanId, parentSpanId: parent?.id || undefined, startMs, endMs: Date.now(), attributes: { ...attributes, ...extra }, error: error ? String(error).slice(0, 500) : '' });
        } catch {
          /* телеметрия не должна ломать прогон */
        }
      },
    };
  };
  return { traceId, start };
}

/** Пустой трассировщик: тот же интерфейс, ничего не отправляет. */
export const NO_TRACER = { traceId: '', start: () => ({ id: '', traceId: '', end() {} }) };
