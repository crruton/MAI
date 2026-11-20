/**
 * Слэш-команды и упоминания файлов (CC7.7–CC7.9).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listCustomCommands, expandTemplate, splitArgs, searchFiles, resolveMentions, clearFileCache, BUILTIN_COMMANDS } from '../electron/lib/commands.js';

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

const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-cmd-project-'));
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-cmd-data-'));
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
};
write(path.join(project, '.mai-code', 'commands', 'review.md'), '---\ndescription: Ревью изменений\nargument-hint: <путь>\n---\nПроведи ревью $1 с фокусом на $2. Всё: $ARGUMENTS');
write(path.join(data, 'commands', 'review.md'), 'глобальная версия');
write(path.join(data, 'commands', 'standup.md'), 'Собери сводку за день');
write(path.join(data, 'commands', 'clear.md'), 'попытка переопределить встроенную');
write(path.join(data, 'commands', 'bad name.md'), 'плохое имя');

console.log('\n[1] Свои команды');
const all = listCustomCommands(project, data);
const review = all.find((c) => c.name === 'review');
check('команда проекта сильнее глобальной', review?.source === 'project' && /ревью/.test(review.body));
check('описание и подсказка из frontmatter', review?.description === 'Ревью изменений' && review?.argumentHint === '<путь>');
check('глобальная команда видна', all.some((c) => c.name === 'standup' && c.source === 'global'));
check('описание по первой строке, если нет frontmatter', all.find((c) => c.name === 'standup')?.description === 'Собери сводку за день');
check('встроенную /clear переопределить нельзя', !all.some((c) => c.name === 'clear'));
check('имя с пробелом пропущено', !all.some((c) => c.name.includes(' ')));
const untrusted = listCustomCommands(project, data, { includeProject: false });
check('без доверия — только глобальные', untrusted.find((c) => c.name === 'review')?.source === 'global');
check('встроенные описаны', BUILTIN_COMMANDS.some((c) => c.name === 'init') && BUILTIN_COMMANDS.some((c) => c.name === 'help'));

console.log('\n[2] Подстановка аргументов');
check('$1, $2 и $ARGUMENTS', expandTemplate(review.body, 'src/app.js "безопасность и тесты"') === 'Проведи ревью src/app.js с фокусом на безопасность и тесты. Всё: src/app.js "безопасность и тесты"', expandTemplate(review.body, 'src/app.js "безопасность и тесты"'));
check('без $ARGUMENTS аргументы дописываются', expandTemplate('Собери сводку', 'за неделю') === 'Собери сводку\n\nза неделю');
check('нет аргумента — пусто', expandTemplate('Ревью $1.', '') === 'Ревью .');
check('кавычки в splitArgs', JSON.stringify(splitArgs(`a "b c" 'd e' f`)) === '["a","b c","d e","f"]');

console.log('\n[3] Поиск файлов для @');
write(path.join(project, 'src', 'app.js'), '');
write(path.join(project, 'src', 'lib', 'apply.js'), '');
write(path.join(project, 'docs', 'app-guide.md'), '');
write(path.join(project, 'node_modules', 'app', 'index.js'), '');
write(path.join(project, '.git', 'app'), '');
clearFileCache();
const found = searchFiles(project, 'app');
check('имя с начала — первым', found[0] === 'src/app.js', JSON.stringify(found));
check('node_modules и .git не ищутся', !found.some((f) => f.includes('node_modules') || f.startsWith('.git')));
check('вхождение в имя тоже найдено', found.includes('src/lib/apply.js') && found.includes('docs/app-guide.md'));
check('папки с косой чертой', searchFiles(project, 'lib').includes('src/lib/'));
check('пустой запрос — верхний уровень', searchFiles(project, '').every((f) => !f.replace(/\/$/, '').includes('/')));

console.log('\n[4] Упоминания в тексте');
const mentions = resolveMentions(project, 'посмотри @src/app.js и @docs/, а ещё @нет.js и @../../etc/passwd, почта a@b.ru');
check('существующий файл найден', mentions.some((m) => m.path === 'src/app.js' && !m.dir));
check('папка найдена', mentions.some((m) => m.path === 'docs/' && m.dir));
check('несуществующий и вне проекта — нет', !mentions.some((m) => /нет|passwd/.test(m.path)), JSON.stringify(mentions));
check('адрес почты — не упоминание', mentions.length === 2, JSON.stringify(mentions));

fs.rmSync(project, { recursive: true, force: true });
fs.rmSync(data, { recursive: true, force: true });
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
