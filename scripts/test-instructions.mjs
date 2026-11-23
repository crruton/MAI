/**
 * AGENTS.local.md, @импорты и вложенные AGENTS.md (CC4.1, CC4.2).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandImports, projectInstructions, nestedInstructions, cursorRules } from '../electron/lib/instructions.js';
import { memoryForPrompt, MEMORY_LIMITS } from '../electron/lib/memory-limits.js';

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

console.log('[4] инструкции других агентов (CC4.6)');
const compatRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-compat-'));
const put = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(compatRoot, rel)), { recursive: true });
  fs.writeFileSync(path.join(compatRoot, rel), text);
};
put('AGENTS.md', '# Правила\nПиши тесты.\n');
put('CLAUDE.md', '@AGENTS.md\n');
put('GEMINI.md', '# Правила\nПиши тесты.\n');
put('.github/copilot-instructions.md', 'Используй TypeScript strict.\n');
put('.cursor/rules/style.mdc', '---\ndescription: Стиль\nalwaysApply: true\n---\nОтступ 2 пробела.\n');
put('.cursor/rules/db.mdc', '---\ndescription: Работа с БД\nglobs: src/db/**\nalwaysApply: false\n---\nТолько через репозиторий.\n');
put('.cursorrules', 'Без console.log.\n');
let names = projectInstructions(compatRoot).map((p) => p.name);
check('CLAUDE.md-ссылка и GEMINI.md-копия AGENTS.md пропущены', !names.includes('CLAUDE.md') && !names.includes('GEMINI.md'), names.join());
check('Copilot, .cursorrules и правило alwaysApply — в инструкциях', names.includes('.github/copilot-instructions.md') && names.includes('.cursorrules') && names.includes('.cursor/rules/style.mdc'), names.join());
const lazy = projectInstructions(compatRoot).find((p) => p.name === 'правила Cursor по запросу');
check('правило без alwaysApply — списком с описанием и масками', lazy && /\.cursor\/rules\/db\.mdc — Работа с БД \(файлы: src\/db\/\*\*\)/.test(lazy.text) && !/Только через репозиторий/.test(lazy.text), lazy?.text);
put('CLAUDE.md', 'Отвечай кратко.\n');
names = projectInstructions(compatRoot).map((p) => p.name);
check('свой CLAUDE.md читается', names.includes('CLAUDE.md'));
check('compat: false — только AGENTS.md', projectInstructions(compatRoot, { compat: false }).map((p) => p.name).join() === 'AGENTS.md');
check('разбор .mdc: alwaysApply и тело без frontmatter', cursorRules(compatRoot).find((r) => r.name.endsWith('style.mdc'))?.text === 'Отступ 2 пробела.');
fs.rmSync(compatRoot, { recursive: true, force: true });

console.log('[5] предел памяти в промпте (CC4.5)');
const small = memoryForPrompt('коротко', 'global');
check('в пределе — как есть', small.text === 'коротко' && !small.truncated);
const big = memoryForPrompt('x'.repeat(MEMORY_LIMITS.project + 50), 'project');
check('больше предела — обрезано с пометкой и подсказкой memory_read', big.truncated && big.size === MEMORY_LIMITS.project + 50 && /Память обрезана: в промпте 12000 из 12050/.test(big.text) && /memory_read/.test(big.text));

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(outside, { recursive: true, force: true });
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
