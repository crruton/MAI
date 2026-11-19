/**
 * Список задач агента todo_write (CC1.5).
 */
import { todoTools, normalizeTodos, lastTodos } from '../electron/lib/tools/todo.js';
import { classifyTool } from '../electron/lib/policy.js';

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
const err = (fn) => {
  try {
    fn();
    return '';
  } catch (e) {
    return e.message;
  }
};
const tool = todoTools[0];

console.log('\n[1] Проверка списка');
const todos = normalizeTodos({ todos: [{ content: 'Прочитать код', status: 'completed' }, { content: 'Добавить тест', activeForm: 'Добавляю тест', status: 'in_progress' }, { content: 'Обновить docs', status: 'x' }] });
check('неизвестный статус → pending', todos[2].status === 'pending');
check('activeForm сохранён', todos[1].activeForm === 'Добавляю тест');
check('две задачи в работе — ошибка', /только одна/.test(err(() => normalizeTodos({ todos: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' }] }))));
check('пустой текст — ошибка', /пустой/.test(err(() => normalizeTodos({ todos: [{ content: ' ', status: 'pending' }] }))));
check('предпроверка до выполнения', /Нужен массив/.test(tool.precheck({}, {})));
check('класс read', classifyTool('todo_write') === 'read');

console.log('\n[2] Выполнение');
const sent = [];
const out = await tool.run({ todos: (list) => sent.push(list) }, { todos: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }] });
check('список ушёл в окно', sent[0]?.length === 2);
check('сводка для агента', /1 из 2/.test(out) && /в работе: B/.test(out), out);

console.log('\n[3] Восстановление из истории');
const history = [
  { role: 'assistant', tool_calls: [{ function: { name: 'todo_write', arguments: JSON.stringify({ todos: [{ content: 'старое', status: 'pending' }] }) } }] },
  { role: 'tool', content: 'ok' },
  { role: 'assistant', tool_calls: [{ function: { name: 'todo_write', arguments: JSON.stringify({ todos: [{ content: 'новое', status: 'completed' }] }) } }] },
];
check('берётся последний список', lastTodos(history)[0]?.content === 'новое');
check('без вызовов — пусто', lastTodos([{ role: 'user', content: 'x' }]).length === 0);

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
