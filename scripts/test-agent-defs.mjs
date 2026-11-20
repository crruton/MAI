/**
 * Типы субагентов (ADR 0036).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listAgentDefs, isReadOnlyDef, agentToolSchema, BUILTIN_AGENTS, NEVER_FOR_SUBAGENT } from '../electron/lib/agent-defs.js';
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
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-agents-p-'));
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-agents-d-'));
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
};
write(path.join(project, '.mai-code', 'agents', 'reviewer.md'), '---\ndescription: Ревьюер кода\ntools: read_file, grep\n---\nИщи ошибки и уязвимости.');
write(path.join(data, 'agents', 'reviewer.md'), 'глобальный ревьюер');
write(path.join(data, 'agents', 'tester.md'), '---\ndescription: Пишет тесты\n---\nПиши тесты.');
write(path.join(data, 'agents', 'explore.md'), 'попытка переопределить встроенный');

const defs = listAgentDefs(project, data);
const by = (n) => defs.find((d) => d.name === n);
check('встроенные explore, plan, general', ['explore', 'plan', 'general'].every((n) => by(n)?.source === 'builtin'));
check('встроенный не переопределяется', by('explore').prompt.includes('исследователь'));
check('тип проекта сильнее глобального', by('reviewer').source === 'project' && by('reviewer').prompt === 'Ищи ошибки и уязвимости.');
check('tools разобраны', JSON.stringify(by('reviewer').tools) === '["read_file","grep"]');
check('без tools — все инструменты', by('tester').tools === null);
check('без доверия — только глобальные', listAgentDefs(project, data, { includeProject: false }).find((d) => d.name === 'reviewer')?.source === 'global');
check('explore и reviewer — только чтение', isReadOnlyDef(by('explore')) && isReadOnlyDef(by('reviewer')));
check('general и tester — не только чтение', !isReadOnlyDef(by('general')) && !isReadOnlyDef(by('tester')));
const schema = agentToolSchema(defs);
check('в схеме enum типов', JSON.stringify(schema.function.parameters.properties.type.enum.sort()) === JSON.stringify(defs.map((d) => d.name).sort()));
check('описания типов в описании инструмента', /reviewer: Ревьюер кода/.test(schema.function.description));
check('субагенту нельзя agent и ask_user', NEVER_FOR_SUBAGENT.has('agent') && NEVER_FOR_SUBAGENT.has('ask_user'));
check('agent — класс read', classifyTool('agent') === 'read');
check('встроенных три', BUILTIN_AGENTS.length === 3);

fs.rmSync(project, { recursive: true, force: true });
fs.rmSync(data, { recursive: true, force: true });
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
