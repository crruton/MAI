import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dataDir } from './config.js';

export function pluginDirs(projectDir) {
  return [path.join(projectDir || '', '.mai-code', 'plugins'), path.join(dataDir(), 'plugins')];
}

/**
 * Загружает плагины. Плагины проекта — код из чужого репозитория, который
 * исполняется в main-процессе, поэтому без доверия к папке они пропускаются
 * (ADR 0028). Глобальные плагины пользователь положил сам.
 */
export async function loadPlugins(projectDir, { includeProject = true } = {}) {
  const loaded = [];
  const tools = [];
  const transforms = [];
  const [projectDirPlugins, globalDir] = pluginDirs(projectDir);
  if (!includeProject && fs.existsSync(projectDirPlugins)) {
    loaded.push({ name: 'плагины проекта', file: projectDirPlugins, tools: 0, skipped: true, error: 'папка проекта не доверена' });
  }
  for (const dir of includeProject ? [projectDirPlugins, globalDir] : [globalDir]) {
    if (!dir || !fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
      const file = path.join(dir, entry.name);
      try {
        const mod = await import(`${pathToFileURL(file).href}?v=${fs.statSync(file).mtimeMs}`);
        const plugin = mod.default || mod.plugin || mod;
        if (!plugin) continue;
        for (const tool of plugin.tools || []) {
          if (tool?.schema?.function?.name && typeof tool.run === 'function') tools.push(tool);
        }
        if (typeof plugin.transformMessages === 'function') transforms.push(plugin.transformMessages);
        loaded.push({
          name: plugin.name || entry.name.replace(/\.js$/, ''),
          file,
          tools: (plugin.tools || []).length,
          toolNames: (plugin.tools || []).map((t) => t?.schema?.function?.name).filter(Boolean),
        });
      } catch (err) {
        loaded.push({ name: entry.name, file, error: err?.message || String(err), tools: 0 });
      }
    }
  }
  return { loaded, tools, transforms };
}
