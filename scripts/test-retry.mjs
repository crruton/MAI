/**
 * Классификация сбоев и паузы (CC13.2, CC13.3, ADR 0057).
 */
import { isTransient, needsFallback, retryDelay, describeError, RETRY_DELAYS } from '../electron/lib/retry.js';

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
const e = (status, message = 'x', extra = {}) => Object.assign(new Error(message), status ? { status } : {}, extra);
check('429, 500, 502, 503, 529 — временные', [429, 500, 502, 503, 529].every((s) => isTransient(e(s))));
check('400, 401, 404 — нет', ![400, 401, 404].some((s) => isTransient(e(s))));
check('обрыв соединения — временный', isTransient(e(0, 'fetch failed', { cause: { code: 'ECONNRESET' } })) && isTransient(e(0, 'Connection error.')));
check('остановка пользователем — не повторять', !isTransient(Object.assign(new Error('aborted'), { name: 'AbortError' })));
check('запасная: временный, 401, 404, нет денег, контекст', [e(503), e(401), e(404), e(400, 'insufficient_quota'), e(400, 'context_length_exceeded')].every(needsFallback));
check('запасная: обычная ошибка запроса — нет', !needsFallback(e(400, 'invalid tool schema')));
check('пауза по таблице', retryDelay(e(503), 0) === RETRY_DELAYS[0] && retryDelay(e(503), 9) === RETRY_DELAYS.at(-1));
check('Retry-After из заголовка (до 30 с)', retryDelay(e(429, 'x', { headers: { 'retry-after': '7' } }), 0) === 7000 && retryDelay(e(429, 'x', { headers: { 'retry-after': '600' } }), 0) === 30_000);
check('Retry-After из Headers', retryDelay(e(429, 'x', { headers: new Headers({ 'retry-after': '3' }) }), 0) === 3000);
check('описание ошибки', describeError(e(503, 'Service   Unavailable')) === '503: Service Unavailable');
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
