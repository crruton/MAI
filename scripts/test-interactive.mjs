/**
 * Диалоговые инструменты ask_user и exit_plan (CC1.7, CC1.8).
 */
import { interactiveTools, normalizeQuestions, normalizePlan } from '../electron/lib/tools/interactive.js';
import { classifyTool, evaluate } from '../electron/lib/policy.js';

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
const tool = (name) => interactiveTools.find((t) => t.schema.function.name === name);
const throws = (fn) => {
  try {
    fn();
    return '';
  } catch (err) {
    return err.message;
  }
};

console.log('\n[1] Вопросы: рекомендованный первым');
const qs = normalizeQuestions({
  questions: [
    {
      question: 'Какую базу взять?',
      options: [{ label: 'SQLite' }, { label: 'Postgres', recommended: true, description: 'уже есть в infra' }, { label: 'Mongo', recommended: true }],
    },
  ],
});
check('рекомендованный перенесён на первое место', qs[0].options[0].label === 'Postgres', JSON.stringify(qs[0].options));
check('рекомендованный только один', qs[0].options.filter((o) => o.recommended).length === 1);
check('описание сохранено', qs[0].options[0].description === 'уже есть в infra');
check('один вариант — ошибка', /от 2 до 4/.test(throws(() => normalizeQuestions({ questions: [{ question: 'x', options: [{ label: 'a' }] }] }))));
check('пять вопросов — ошибка', /Не больше 4/.test(throws(() => normalizeQuestions({ questions: Array(5).fill({ question: 'x', options: [{ label: 'a' }, { label: 'b' }] }) }))));
check('предпроверка возвращает ошибку до вопроса', /Нужен хотя бы один/.test(tool('ask_user').precheck({}, {})));

console.log('\n[2] Ответы на вопросы');
const asked = [];
const out = await tool('ask_user').run(
  { ask: async (request) => (asked.push(request), { answers: ['Postgres'] }) },
  { questions: [{ question: 'Какую базу взять?', options: [{ label: 'SQLite' }, { label: 'Postgres', recommended: true }] }] },
);
check('вопрос ушёл в интерфейс', asked[0]?.kind === 'questions' && asked[0].questions[0].options[0].recommended === true);
check('ответ вернулся агенту', /Какую базу взять\? → Postgres/.test(out), out);
const skipped = await tool('ask_user').run({ ask: async () => ({ cancelled: true }) }, { questions: qs });
check('пропуск — продолжать по рекомендации', /по рекомендованным/.test(skipped), skipped);
const offline = await tool('ask_user').run({}, { questions: qs });
check('без интерфейса — не зависает', /недоступен/.test(offline));

console.log('\n[3] План');
const plan = normalizePlan({ plan: '# План', alternatives: [{ title: 'A' }, { title: 'B', risk: 'high' }], recommended: 1 });
check('рекомендованная альтернатива', plan.recommended === 1 && plan.alternatives[1].risk === 'high');
check('номер вне диапазона → первая', normalizePlan({ plan: 'x', alternatives: [{ title: 'A' }], recommended: 7 }).recommended === 0);
check('пустой план — ошибка', /Нужен текст плана/.test(throws(() => normalizePlan({}))));
const approved = await tool('exit_plan').run(
  { ask: async () => ({ action: 'approve', mode: 'acceptEdits', alternative: 0 }) },
  { plan: '# План', alternatives: [{ title: 'Через кэш' }] },
);
check('одобрение: режим и альтернатива в ответе', /Принимать правки/.test(approved) && /Через кэш/.test(approved), approved);
const revise = await tool('exit_plan').run({ ask: async () => ({ action: 'revise', feedback: 'добавь тесты' }) }, { plan: 'x' });
check('доработка: замечания и режим «План»', /добавь тесты/.test(revise) && /остаётся «План»/.test(revise), revise);

console.log('\n[4] PolicyEngine');
check('ask_user — класс read', classifyTool('ask_user') === 'read');
check('exit_plan разрешён в «Плане»', evaluate({ tool: 'exit_plan', mode: 'plan' }).action === 'allow');
check('плагин не может назваться ask_user и получить другой класс', classifyTool('ask_user', { source: 'plugin', kind: 'write' }) === 'read');

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
