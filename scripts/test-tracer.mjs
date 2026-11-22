/**
 * Трассировщик прогона (F22, ADR 0063).
 */
import { createTracer, NO_TRACER } from '../electron/lib/tracer.js';

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
const spans = [];
const tracer = createTracer((name, s) => spans.push({ name, ...s }));
const run = tracer.start('agent.run', { a: 1 });
const step = tracer.start('agent.step', { b: 2 }, run);
step.end({ c: 3 });
step.end({ c: 4 });
run.end({}, 'ошибка');
check('один trace на прогон', spans.length === 2 && spans.every((s) => s.traceId === tracer.traceId && /^[0-9a-f]{32}$/.test(s.traceId)));
check('родитель шага — прогон', spans[0].parentSpanId === run.id && spans[1].parentSpanId === undefined);
check('атрибуты складываются, end — один раз', spans[0].attributes.b === 2 && spans[0].attributes.c === 3);
check('ошибка — в спане', spans[1].error === 'ошибка' && spans[1].endMs >= spans[1].startMs);
const broken = createTracer(() => {
  throw new Error('экспорт упал');
});
let ok = true;
try {
  broken.start('x').end();
} catch {
  ok = false;
}
check('сбой экспорта не ломает прогон', ok);
check('пустой трассировщик', NO_TRACER.start('x', {}, null).end() === undefined);
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
