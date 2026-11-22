/**
 * Проекты (CW1.5, ADR 0065).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjectStore, checkDir, projectPrompt, connectorAllowed } from '../electron/lib/projects.js';

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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-projects-'));
const main = path.join(tmp, 'Отчёты');
const extra = path.join(tmp, 'Выгрузки');
fs.mkdirSync(main);
fs.mkdirSync(extra);
const store = createProjectStore(path.join(tmp, 'data'));
const err = (fn) => {
  try {
    fn();
    return '';
  } catch (e) {
    return e.message;
  }
};
console.log('[1] проверки');
check('без названия', /название/.test(err(() => store.save({ primaryDir: main }))));
check('домашняя папка — нельзя', /домашнюю/.test(checkDir(os.homedir())));
check('корень диска — нельзя', /диск/.test(checkDir(path.parse(tmp).root)));
check('нет папки', /Папки нет/.test(checkDir(path.join(tmp, 'nope'))));
check('относительный путь', /полный путь/.test(checkDir('relative/dir')));
console.log('[2] сохранение');
const p = store.save({ name: ' Отчётность ', primaryDir: main, extraDirs: [extra, extra, main], instructions: 'Для финдиректора, в xlsx', connectors: ['gmail', 'gmail', 'notion'] });
check('создан: имя, дубли папок и основная среди доп. убраны', p.name === 'Отчётность' && p.extraDirs.length === 1 && p.extraDirs[0] === extra && p.kind === 'task' && p.connectors.join() === 'gmail,notion');
const edited = store.save({ id: p.id, kind: 'code' });
check('правка не теряет остальное', edited.kind === 'code' && edited.instructions === 'Для финдиректора, в xlsx' && edited.createdAt === p.createdAt && store.list().length === 1);
check('доп. папка, которой нет — ошибка', /Папки нет/.test(err(() => store.save({ id: p.id, extraDirs: [path.join(tmp, 'gone')] }))));
console.log('[3] промпт и коннекторы');
const prompt = projectPrompt(edited);
check('промпт: название, инструкции, коннекторы', /# Проект «Отчётность»/.test(prompt) && /финдиректора/.test(prompt) && /gmail, notion/.test(prompt));
check('свои коннекторы — да, чужие — нет, встроенные — да', connectorAllowed(edited, 'mcp__gmail__send_email') && !connectorAllowed(edited, 'mcp__slack__post') && connectorAllowed(edited, 'read_file'));
check('без списка — все', connectorAllowed({ connectors: [] }, 'mcp__slack__post') && connectorAllowed(null, 'mcp__x__y'));
store.remove(p.id);
check('удаление', store.list().length === 0 && fs.existsSync(main));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
