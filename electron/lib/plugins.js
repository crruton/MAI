import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.js';
import { hostFor } from './plugin-host.js';

export function pluginDirs(projectDir) {
  return [path.join(projectDir || '', '.mai-code', 'plugins'), path.join(dataDir(), 'plugins')];
}

function pluginFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => path.join(dir, entry.name));
}

/** Сигнатура набора файлов: изменился файл — нужен новый процесс плагинов. */
function signatureOf(files) {
  return files
    .map((file) => {
      try {
        const stat = fs.statSync(file);
        return `${file}:${stat.mtimeMs}:${stat.size}`;
      } catch {
        return `${file}:missing`;
      }
    })
    .join('|');
}

/** Через границу процесса уходят только данные контекста, без функций. */
function pluginCtx(ctx = {}) {
  return {
    projectDir: ctx.projectDir || '',
    allowOutsideProject: Boolean(ctx.allowOutsideProject),
    trusted: ctx.trusted !== false,
  };
}

/**
 * Загружает плагины в отдельный процесс (ADR 0030) и возвращает обёртки:
 * `tools[].run` и `transforms[]` вызывают плагин через сообщения с таймаутом.
 *
 * Плагины проекта — код из чужого репозитория, поэтому без доверия к папке
 * они пропускаются (ADR 0028). Глобальные плагины пользователь положил сам.
 */
export async function loadPlugins(projectDir, { includeProject = true, timeouts, extraDirs = [] } = {}) {
  const loaded = [];
  const tools = [];
  const transforms = [];
  const [projectDirPlugins, globalDir] = pluginDirs(projectDir);
  if (!includeProject && pluginFiles(projectDirPlugins).length) {
    loaded.push({ name: 'плагины проекта', file: projectDirPlugins, tools: 0, skipped: true, error: 'папка проекта не доверена' });
  }
  // Плагины пакетов (ADR 0037) — между проектом и глобальными.
  const files = [
    ...(includeProject ? pluginFiles(projectDirPlugins) : []),
    ...extraDirs.flatMap((d) => pluginFiles(d.dir)),
    ...pluginFiles(globalDir),
  ];
  if (!files.length) return { loaded, tools, transforms };

  const key = `${path.resolve(projectDir || '.')}|${includeProject ? 'project' : 'global'}|${extraDirs.map((d) => d.dir).join(',')}`;
  let host;
  try {
    host = await hostFor(key, files, signatureOf(files), { cwd: projectDir || undefined, timeouts });
  } catch (err) {
    loaded.push({ name: 'плагины', file: files.join(', '), tools: 0, error: `процесс плагинов не запустился: ${err?.message || String(err)}` });
    return { loaded, tools, transforms };
  }

  for (const plugin of host.manifest || []) {
    for (const tool of plugin.tools || []) {
      const name = tool.schema.function.name;
      tools.push({
        schema: tool.schema,
        kind: tool.kind,
        run: (ctx, args) => host.call(plugin.file, name, pluginCtx(ctx), args),
      });
    }
    if (plugin.transform) {
      transforms.push((messages) => host.transform(plugin.file, messages));
    }
    loaded.push({
      name: plugin.name,
      file: plugin.file,
      tools: (plugin.tools || []).length,
      toolNames: (plugin.tools || []).map((t) => t.schema.function.name),
      ...(plugin.error ? { error: plugin.error } : {}),
      isolated: true,
    });
  }
  return { loaded, tools, transforms };
}
