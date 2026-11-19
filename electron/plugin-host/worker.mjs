/**
 * Процесс-хост плагинов (ADR 0030). Запускается через utilityProcess.fork.
 *
 * Плагин исполняется здесь, а не в main-процессе: у него нет доступа к памяти
 * main (расшифрованные ключи, настройки), к Electron API и к IPC окон, а в
 * окружении нет переменных с ключами. Файловая система и процессы остаются
 * доступны с правами пользователя — это не песочница ОС.
 *
 * Протокол (process.parentPort):
 *   → { type: 'load', files }                   ← { type: 'loaded', plugins }
 *   → { type: 'call', id, file, tool, ctx, args } ← { type: 'result', id, ok, result | error }
 *   → { type: 'transform', id, file, messages } ← { type: 'result', id, ok, result | error }
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const port = process.parentPort;
const modules = new Map(); // file → plugin

function clone(value) {
  // Через границу процесса уходят только данные: функции и циклы отбрасываются.
  return JSON.parse(JSON.stringify(value ?? null));
}

async function load(files) {
  const plugins = [];
  for (const file of files) {
    try {
      const mod = await import(`${pathToFileURL(file).href}?v=${fs.statSync(file).mtimeMs}`);
      const plugin = mod.default || mod.plugin || mod;
      if (!plugin) continue;
      modules.set(file, plugin);
      const tools = (plugin.tools || [])
        .filter((tool) => tool?.schema?.function?.name && typeof tool.run === 'function')
        .map((tool) => ({ schema: clone(tool.schema), kind: typeof tool.kind === 'string' ? tool.kind : undefined }));
      plugins.push({
        file,
        name: plugin.name || file.split(/[\\/]/).pop().replace(/\.js$/, ''),
        tools,
        transform: typeof plugin.transformMessages === 'function',
      });
    } catch (err) {
      plugins.push({ file, name: file.split(/[\\/]/).pop(), tools: [], error: err?.message || String(err) });
    }
  }
  return plugins;
}

async function call({ file, tool, ctx, args }) {
  const plugin = modules.get(file);
  const found = (plugin?.tools || []).find((t) => t?.schema?.function?.name === tool);
  if (!found) throw new Error(`Инструмент ${tool} не найден в плагине`);
  // Разрешение уже выдано PolicyEngine в main: старый вызов ctx.approve получает true.
  const result = await found.run({ ...ctx, approve: async () => true }, args);
  return typeof result === 'string' ? result : JSON.stringify(result ?? '');
}

async function transform({ file, messages }) {
  const plugin = modules.get(file);
  if (typeof plugin?.transformMessages !== 'function') return messages;
  const next = await plugin.transformMessages(messages);
  return Array.isArray(next) ? clone(next) : messages;
}

port.on('message', async (event) => {
  const message = event?.data ?? event;
  try {
    if (message.type === 'load') {
      port.postMessage({ type: 'loaded', plugins: await load(message.files || []) });
      return;
    }
    if (message.type === 'call' || message.type === 'transform') {
      const result = message.type === 'call' ? await call(message) : await transform(message);
      port.postMessage({ type: 'result', id: message.id, ok: true, result });
    }
  } catch (err) {
    port.postMessage({ type: 'result', id: message.id, ok: false, error: err?.message || String(err) });
  }
});
