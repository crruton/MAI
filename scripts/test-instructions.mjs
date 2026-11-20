/**
 * AGENTS.local.md, @импорты и вложенные AGENTS.md (CC4.1, CC4.2).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandImports, projectInstructions, nestedInstructions } from '../electron/lib/instructions.js';

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
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-instr-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-instr-out-'));
const write = (rel, text, base = root) => {
  const file = path.join(base, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return file;
};
write('AGENTS.md', '# Правила\n@docs/style.md\n@../' + path.basename(outside) + '/secret.md\n@docs/loop-a.md\nконец');
write('docs/style.md', 'Пиши коротко.\n@nested.md');
write('docs/nested.md', 'Вложенный импорт.');
write('docs/loop-a.md', 'A\n@loop-b.md');
write('docs/loop-b.md', 'B\n@loop-a.md');
write('secret.md', 'ЧУЖОЕ', outside);
write('AGENTS.local.md', 'Мои личные правила');

console.log('\n[1] Импорты');
const [main, local] = projectInstructions(root);
check('импорт подставлен', /Пиши коротко/.test(main.text));
check('импорт в импорте', /Вложенный импорт/.test(main.text));
check('файл вне проекта не подставлен', !/ЧУЖОЕ/.test(main.text));
check('цикл не зацикливается', /A/.test(main.text) && /B/.test(main.text) && main.text.length < 2000, String(main.text.length));
check('остальной текст на месте', /конец/.test(main.text));
check('AGENTS.local.md прочитан', local?.name === 'AGENTS.local.md' && /личные/.test(local.text));
write('docs/big.md', 'x'.repeat(30 * 1024));
check('большой файл не подставлен', /больше 20 КБ/.test(expandImports('@docs/big.md', { baseDir: root, projectDir: root })));

console.log('\n[2] Вложенные AGENTS.md');
write('packages/api/AGENTS.md', 'В api — только TypeScript.');
write('packages/AGENTS.md', 'Монорепо: пакеты независимы.');
write('packages/api/src/index.ts', '');
const loaded = new Set();
const first = nestedInstructions(root, path.join(root, 'packages/api/src/index.ts'), loaded);
check('найдены оба уровня, ближний к корню первым', first.map((n) => n.rel).join() === 'packages/AGENTS.md,packages/api/AGENTS.md', JSON.stringify(first.map((n) => n.rel)));
check('корневой AGENTS.md не повторяется', !first.some((n) => n.rel === 'AGENTS.md'));
check('второй раз не выдаются', nestedInstructions(root, path.join(root, 'packages/api/src/index.ts'), loaded).length === 0);
check('папка тоже считается', nestedInstructions(root, path.join(root, 'packages/api'), new Set()).length === 2);
check('файл вне проекта — ничего', nestedInstructions(root, path.join(outside, 'secret.md'), new Set()).length === 0);

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(outside, { recursive: true, force: true });
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
