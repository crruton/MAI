/**
 * Безопасная обрезка текста (ADR 0107): границы не рвут суррогатную пару,
 * санитайз убирает одиночные суррогаты из запроса к модели.
 */
import { safeSlice, safeTail, sanitizeText, hasLoneSurrogate, sanitizeMessages } from '../electron/lib/text-safe.js';
import { spillOutput, MAX_TOOL_OUTPUT } from '../electron/lib/tool-runner.js';

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

const EMOJI = '🍀'; // U+1F340: две кодовые единицы
const lone = (s) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

// safeSlice
check('safeSlice: обычный текст', safeSlice('abcdef', 3) === 'abc');
check('safeSlice: короче лимита — целиком', safeSlice('abc', 10) === 'abc');
check('safeSlice: граница внутри пары — отступает', safeSlice(`a${EMOJI}b`, 2) === 'a', JSON.stringify(safeSlice(`a${EMOJI}b`, 2)));
check('safeSlice: граница после пары — целиком', safeSlice(`a${EMOJI}b`, 3) === `a${EMOJI}`);
check('safeSlice: не оставляет одиночный суррогат', !lone(safeSlice(`${EMOJI.repeat(5)}`, 3)));
check('safeSlice: лимит 0 и отрицательный', safeSlice('abc', 0) === '' && safeSlice('abc', -5) === '');
check('safeSlice: null и undefined', safeSlice(null, 5) === '' && safeSlice(undefined, 5) === '');
check('safeSlice: все границы 1..8 без одиночных суррогатов', Array.from({ length: 8 }, (_, i) => safeSlice(`${EMOJI.repeat(4)}`, i + 1)).every((s) => !lone(s)));

// safeTail
check('safeTail: обычный хвост', safeTail('abcdef', 3) === 'def');
check('safeTail: граница внутри пары — сдвигается', safeTail(`a${EMOJI}b`, 2) === 'b', JSON.stringify(safeTail(`a${EMOJI}b`, 2)));
check('safeTail: не оставляет одиночный суррогат', !lone(safeTail(`${EMOJI.repeat(5)}`, 3)));

// sanitizeText / hasLoneSurrogate
check('hasLoneSurrogate: пара — не одиночный', hasLoneSurrogate(EMOJI) === false);
check('hasLoneSurrogate: половина пары — одиночный', hasLoneSurrogate(EMOJI[0]) === true);
check('sanitizeText: половина пары → U+FFFD', sanitizeText(`x${EMOJI[0]}y`) === 'x\uFFFDy');
check('sanitizeText: целая пара сохраняется', sanitizeText(`x${EMOJI}y`) === `x${EMOJI}y`);
check('sanitizeText: обычный текст не меняется', sanitizeText('привет') === 'привет');

// JSON: одиночный суррогат ломает шлюз, после санитайза — нет
const broken = JSON.stringify({ content: `текст ${EMOJI[0]}` });
check('JSON.stringify даёт escape одиночного суррогата', /\\u[dD][89abAB][0-9a-fA-F]{2}/.test(broken), broken);
const fixedJson = JSON.stringify({ content: sanitizeText(`текст ${EMOJI[0]}`) });
check('после санитайза escape одиночного суррогата нет', !/\\u[dD][89abAB][0-9a-fA-F]{2}/.test(fixedJson), fixedJson);

// sanitizeMessages
const messages = [
  { role: 'user', content: `привет ${EMOJI[0]}` },
  { role: 'assistant', content: [{ type: 'text', text: `часть ${EMOJI[0]}` }], tool_calls: [{ id: '1', function: { name: 'read_file', arguments: `{"path":"${EMOJI[0]}"}` } }] },
  { role: 'tool', content: 'ok', tool_call_id: '1' },
];
const cleaned = sanitizeMessages(messages);
check('sanitizeMessages: строка content', !hasLoneSurrogate(cleaned[0].content));
check('sanitizeMessages: части content', !hasLoneSurrogate(cleaned[1].content[0].text));
check('sanitizeMessages: аргументы вызова', !hasLoneSurrogate(cleaned[1].tool_calls[0].function.arguments));
check('sanitizeMessages: вход не изменён', hasLoneSurrogate(messages[0].content));
check('sanitizeMessages: роли и id сохранены', cleaned[2].role === 'tool' && cleaned[2].tool_call_id === '1');
check('sanitizeMessages: не массив — как есть', sanitizeMessages(null) === null);

// spillOutput: длинный вывод с эмодзи на границе обрезки
const long = `${'a'.repeat(MAX_TOOL_OUTPUT * 0.7 - 1)}${EMOJI}${'b'.repeat(MAX_TOOL_OUTPUT)}`;
const spilled = spillOutput(null, 'run_shell', long);
check('spillOutput: обрезка без одиночных суррогатов', !hasLoneSurrogate(spilled));
check('spillOutput: помечает обрезку', spilled.includes('обрезано'));

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
