/**
 * Плагины в отдельном процессе (ADR 0030, бэклог A2.4).
 *
 * Запуск: npx electron scripts/test-plugin-host.mjs (нужен utilityProcess).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { loadPlugins } from '../electron/lib/plugins.js';
import { disposePluginHosts, pluginHostCount, pluginEnv } from '../electron/lib/plugin-host.js';

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

const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-plugins-'));
const dir = path.join(project, '.mai-code', 'plugins');
fs.mkdirSync(dir, { recursive: true });
const write = (name, code) => fs.writeFileSync(path.join(dir, name), code, 'utf8');

write(
  'probe.js',
  `globalThis.__maiPluginLoaded = true;
export default {
  name: 'probe',
  tools: [
    { kind: 'read', schema: { type: 'function', function: { name: 'probe', parameters: { type: 'object' } } },
      async run(ctx, args) {
        let electronApi = 'нет';
        try { const e = await import('electron'); electronApi = typeof e.ipcMain + '/' + typeof e.BrowserWindow; } catch { electronApi = 'недоступен'; }
        return JSON.stringify({
          pid: process.pid,
          secret: process.env.MAI_TEST_API_KEY ?? null,
          plain: process.env.MAI_TEST_PLAIN ?? null,
          project: ctx.projectDir,
          approved: await ctx.approve('x', 'y'),
          electronApi,
          args,
        });
      } },
    { schema: { type: 'function', function: { name: 'hang', parameters: { type: 'object' } } }, run: () => new Promise(() => {}) },
    { schema: { type: 'function', function: { name: 'crash', parameters: { type: 'object' } } }, run: () => process.exit(3) },
    { schema: { type: 'function', function: { name: 'boom', parameters: { type: 'object' } } }, run: () => { throw new Error('плагин сломался'); } },
  ],
  async transformMessages(messages) {
    return [...messages, { role: 'user', content: 'добавлено плагином' }];
  },
};`,
);
write('broken.js', 'export default { name: "broken", tools: [ ;');

const tool = (result, name) => result.tools.find((t) => t.schema.function.name === name);

app.whenReady().then(async () => {
  try {
    process.env.MAI_TEST_API_KEY = 'sk-секрет';
    process.env.MAI_TEST_PLAIN = 'обычная';

    console.log('\n[1] Плагин живёт в отдельном процессе');
    const first = await loadPlugins(project, { timeouts: { call: 1500 } });
    check('плагин probe загружен', Boolean(tool(first, 'probe')));
    check('класс действия передан из плагина', tool(first, 'probe').kind === 'read');
    const info = JSON.parse(await tool(first, 'probe').run({ projectDir: project, approve: () => false }, { a: 1 }));
    check('другой pid', info.pid !== process.pid, `${info.pid} vs ${process.pid}`);
    check('код плагина не выполнялся в main', globalThis.__maiPluginLoaded !== true);
    check('переменная с ключом не видна плагину', info.secret === null, String(info.secret));
    check('обычная переменная видна', info.plain === 'обычная');
    check('projectDir передан', info.project === project);
    check('аргументы переданы', info.args?.a === 1);
    check('старый ctx.approve получает true', info.approved === true);
    check("ipcMain и BrowserWindow недоступны", !/function/.test(info.electronApi), info.electronApi);
    console.log(`       electron в плагине: ${info.electronApi}`);
    check('pluginEnv вырезает *_TOKEN', !('GH_TOKEN' in pluginEnv({ GH_TOKEN: 'x', PATH: '/bin' })));

    console.log('\n[2] Хук transformMessages');
    const out = await first.transforms[0]([{ role: 'user', content: 'x' }]);
    check('хук асинхронный и вернул массив', Array.isArray(out) && out.at(-1).content === 'добавлено плагином');

    console.log('\n[3] Ошибки плагинов');
    const broken = first.loaded.find((p) => /broken/.test(p.file));
    check('плагин с синтаксической ошибкой отмечен', Boolean(broken?.error), JSON.stringify(broken));
    let message = '';
    try {
      await tool(first, 'boom').run({}, {});
    } catch (err) {
      message = err.message;
    }
    check('исключение плагина дошло до main', /плагин сломался/.test(message), message);
    check('хост жив после исключения', pluginHostCount() === 1);

    console.log('\n[4] Зависание и падение');
    const startedHang = Date.now();
    message = '';
    try {
      await tool(first, 'hang').run({}, {});
    } catch (err) {
      message = err.message;
    }
    check('зависший вызов прерван по таймауту', /не ответил/.test(message) && Date.now() - startedHang < 5000, message);
    check('зависший хост остановлен', pluginHostCount() === 0);
    const second = await loadPlugins(project, { timeouts: { call: 1500 } });
    check('после зависания поднят новый хост', pluginHostCount() === 1 && Boolean(tool(second, 'probe')));
    message = '';
    try {
      await tool(second, 'crash').run({}, {});
    } catch (err) {
      message = err.message;
    }
    check('падение процесса — ошибка, а не падение приложения', /завершился/.test(message), message);
    const third = await loadPlugins(project);
    const again = JSON.parse(await tool(third, 'probe').run({ projectDir: project }, {}));
    check('после падения плагины снова работают', typeof again.pid === 'number');

    console.log('\n[5] Перезапуск при изменении файла');
    const sameHost = await loadPlugins(project);
    const pidBefore = JSON.parse(await tool(sameHost, 'probe').run({}, {})).pid;
    const sameAgain = await loadPlugins(project);
    check('файлы не менялись — тот же процесс', JSON.parse(await tool(sameAgain, 'probe').run({}, {})).pid === pidBefore);
    await new Promise((r) => setTimeout(r, 20));
    write('extra.js', `export default { name: 'extra', tools: [{ kind: 'read', schema: { type: 'function', function: { name: 'extra', parameters: { type: 'object' } } }, run: () => 'новый' }] };`);
    const changed = await loadPlugins(project);
    check('новый файл подхвачен', (await tool(changed, 'extra')?.run({}, {})) === 'новый');
    check('новый процесс после изменения', JSON.parse(await tool(changed, 'probe').run({}, {})).pid !== pidBefore);

    console.log('\n[6] Недоверенная папка и пустой набор');
    const untrusted = await loadPlugins(project, { includeProject: false });
    check('без доверия плагины проекта не загружены', untrusted.tools.length === 0 && untrusted.loaded.some((p) => p.skipped));
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-plugins-empty-'));
    const before = pluginHostCount();
    const none = await loadPlugins(empty);
    check('нет плагинов — процесс не запускается', none.tools.length === 0 && pluginHostCount() === before);
    fs.rmSync(empty, { recursive: true, force: true });
  } catch (err) {
    fail += 1;
    console.log(`  FAIL исключение: ${err?.stack || err}`);
  }

  disposePluginHosts();
  fs.rmSync(project, { recursive: true, force: true });
  console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
  app.exit(fail ? 1 : 0);
});
