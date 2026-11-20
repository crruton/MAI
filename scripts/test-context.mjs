/**
 * Контекст и компакция (CC5.1–CC5.3).
 */
import { estimateTokens, activeHistory, lastKnownTokens, contextBreakdown, compactionCut, compactionPrompt, needsCompaction } from '../electron/lib/context.js';

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
const big = (n) => 'x'.repeat(n);
const turn = (i, size = 3000) => [
  { role: 'user', content: `задача ${i} ${big(size)}` },
  { role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: `c${i}`, content: big(size) },
  { role: 'assistant', content: `ответ ${i}` },
];

console.log('\n[1] Оценка и точное число');
check('оценка ~ символы/3', estimateTokens(big(300)) === 100);
const withUsage = [...turn(1, 30), { role: 'assistant', content: 'ok', usage: { input: 5000, output: 100 } }, { role: 'user', content: big(300) }];
check('точное число: usage.input + output + новое', lastKnownTokens(withUsage) === 5000 + 100 + 100, String(lastKnownTokens(withUsage)));
check('после компакции старый usage не используется', lastKnownTokens([...withUsage, { role: 'compaction', content: 's' }]) === null);
const view = contextBreakdown({ system: big(3000), tools: [{ a: big(300) }], history: withUsage, window: 10_000 });
check('разбор по частям: системный промпт ≈ 1000', view.parts.find((p) => p.key === 'system').tokens === 1000);
check('used берётся у провайдера', view.exact === true && view.used === 5200);

console.log('\n[2] Что видит модель после компакции');
const history = [...turn(1), { role: 'compaction', content: 'СВОДКА', messages: 4 }, ...turn(2)];
const active = activeHistory(history);
check('первой идёт сводка', /СВОДКА/.test(active[0].content) && active[0].role === 'user');
check('ранние сообщения скрыты', !active.some((m) => /задача 1/.test(String(m.content))));
check('сообщения после маркера на месте', active.length === 1 + 4);
check('без компакции — как есть', activeHistory(turn(1)).length === 4);

console.log('\n[3] Где резать');
const long = [...turn(1), ...turn(2), ...turn(3), ...turn(4)];
const cut = compactionCut(long, { keepTokens: 2500 });
check('режем по границе хода (перед user)', long[cut]?.role === 'user', String(cut));
check('последний ход всегда остаётся', cut <= 12);
check('с большим запасом оставляем больше ходов', compactionCut(long, { keepTokens: 1e9 }) === 4);
check('один ход — сжимать нечего', compactionCut(turn(1)) === -1);
const afterMarker = [...turn(1), { role: 'compaction', content: 's' }, ...turn(2)];
check('после маркера с одним ходом — нечего', compactionCut(afterMarker) === -1);

console.log('\n[4] Запрос к суммаризатору');
const prompt = compactionPrompt([...turn(1, 10), { role: 'compaction', content: 'ранее' }], 'сохрани решения по базе');
check('есть указание сохранить файлы и решения', /изменённые файлы/.test(prompt) && /решения/.test(prompt));
check('вызовы инструментов перечислены', /вызов read_file/.test(prompt));
check('ранняя сводка включена', /Ранняя сводка/.test(prompt));
check('пожелание пользователя учтено', /сохрани решения по базе/.test(prompt));

console.log('\n[5] Порог автокомпакции');
check('80% окна — пора', needsCompaction(long, { window: 4000 }));
check('мало — не пора', !needsCompaction(turn(1, 10), { window: 128_000 }));

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
