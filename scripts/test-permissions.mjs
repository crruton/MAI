import {
  decide,
  normalizeMode,
  hiddenToolsForMode,
  modePrompt,
  isWriteTool,
  isShellTool,
  isReadTool,
  PERMISSION_MODES,
  DEFAULT_PERMISSION_MODE,
  MODE_INFO,
} from '../electron/lib/permissions.js';

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

console.log('\n[1] Нормализация режима');
check('manual проходит', normalizeMode('manual') === 'manual');
check('auto проходит', normalizeMode('auto') === 'auto');
check('acceptEdits проходит', normalizeMode('acceptEdits') === 'acceptEdits');
check('plan проходит', normalizeMode('plan') === 'plan');
check('мусор → manual', normalizeMode('hack') === DEFAULT_PERMISSION_MODE);
check('пусто → manual', normalizeMode('') === DEFAULT_PERMISSION_MODE);
check('null → manual', normalizeMode(null) === DEFAULT_PERMISSION_MODE);
check('все 4 режима описаны', PERMISSION_MODES.every((id) => MODE_INFO[id]?.label));

console.log('\n[2] Классификация инструментов');
check('write_file — запись', isWriteTool('write_file'));
check('edit_file — запись', isWriteTool('edit_file'));
check('run_shell — команда', isShellTool('run_shell'));
check('read_file — чтение', isReadTool('read_file'));
check('grep — чтение', isReadTool('grep'));
check('mcp__x__y — не запись', !isWriteTool('mcp__x__y'));

console.log('\n[3] Режим «Вручную»: спрашивает про всё опасное');
for (const tool of ['write_file', 'edit_file', 'run_shell', 'mcp__server__tool']) {
  const d = decide({ mode: 'manual', tool });
  check(`manual + ${tool} → ask`, d.action === 'ask', JSON.stringify(d));
}
for (const tool of ['read_file', 'list_files', 'grep', 'load_skill']) {
  const d = decide({ mode: 'manual', tool });
  check(`manual + ${tool} → allow (чтение)`, d.action === 'allow', JSON.stringify(d));
}

console.log('\n[4] Режим «Авто»: разрешает без вопроса');
for (const tool of ['write_file', 'edit_file', 'run_shell', 'mcp__server__tool']) {
  const d = decide({ mode: 'auto', tool });
  check(`auto + ${tool} → allow`, d.action === 'allow', JSON.stringify(d));
}

console.log('\n[5] Режим «Принимать правки»');
check('acceptEdits + write_file → allow', decide({ mode: 'acceptEdits', tool: 'write_file' }).action === 'allow');
check('acceptEdits + edit_file → allow', decide({ mode: 'acceptEdits', tool: 'edit_file' }).action === 'allow');
check('acceptEdits + run_shell → ask', decide({ mode: 'acceptEdits', tool: 'run_shell' }).action === 'ask');
check('acceptEdits + mcp → ask', decide({ mode: 'acceptEdits', tool: 'mcp__s__t' }).action === 'ask');
check('acceptEdits + read_file → allow', decide({ mode: 'acceptEdits', tool: 'read_file' }).action === 'allow');

console.log('\n[6] Режим «План»: запрещает изменения');
for (const tool of ['write_file', 'edit_file', 'run_shell', 'mcp__server__tool']) {
  const d = decide({ mode: 'plan', tool });
  check(`plan + ${tool} → deny`, d.action === 'deny', JSON.stringify(d));
  check(`plan + ${tool}: есть причина`, Boolean(d.reason), JSON.stringify(d));
}
check('plan + read_file → allow', decide({ mode: 'plan', tool: 'read_file' }).action === 'allow');
check('plan + grep → allow', decide({ mode: 'plan', tool: 'grep' }).action === 'allow');

console.log('\n[7] Скрытие инструментов в режиме «План»');
const hidden = hiddenToolsForMode('plan');
check('write_file скрыт', hidden.has('write_file'));
check('edit_file скрыт', hidden.has('edit_file'));
check('run_shell скрыт', hidden.has('run_shell'));
check('read_file не скрыт', !hidden.has('read_file'));
check('в manual ничего не скрыто', hiddenToolsForMode('manual').size === 0);
check('в auto ничего не скрыто', hiddenToolsForMode('auto').size === 0);
check('в acceptEdits ничего не скрыто', hiddenToolsForMode('acceptEdits').size === 0);

console.log('\n[8] Промпт режима');
check('plan упоминает альтернативы', /альтернатив/i.test(modePrompt('plan')));
check('plan запрещает изменения', /не меняешь файлы/i.test(modePrompt('plan')));
check('auto упоминает guardrails', /guardrails/i.test(modePrompt('auto')));
check('acceptEdits про команды', /команды/i.test(modePrompt('acceptEdits')));
check('manual про подтверждение', /подтвержда/i.test(modePrompt('manual')));
check('промпт не пустой для всех', PERMISSION_MODES.every((m) => modePrompt(m).length > 50));

console.log('\n[9] Неизвестный режим не открывает доступ');
const unknown = decide({ mode: 'superuser', tool: 'write_file' });
check('неизвестный режим → ask, не allow', unknown.action === 'ask', JSON.stringify(unknown));

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
