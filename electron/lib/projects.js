/**
 * Проекты (бэклог CW1.5, ADR 0065): набор, который выбирается одним кликом —
 * основная папка, дополнительные папки, свои инструкции, разрешённые
 * коннекторы (MCP-серверы), вид чата по умолчанию. Память — `memory.md`
 * основной папки (как раньше), история — чаты с `projectId`.
 *
 * Хранится в `<данные>/projects.json`. Модуль не зависит от Electron.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_INSTRUCTIONS = 20_000;

function isRootOrHome(dir) {
  const full = path.resolve(dir);
  return full === path.parse(full).root || full === path.resolve(os.homedir());
}

/** Ошибка, если папка не подходит проекту. */
export function checkDir(dir) {
  const value = String(dir || '').trim();
  if (!value) return 'Не указана папка';
  if (!path.isAbsolute(value)) return `Нужен полный путь: ${value}`;
  if (isRootOrHome(value)) return `Нельзя весь диск или домашнюю папку целиком: ${value}`;
  try {
    if (!fs.statSync(value).isDirectory()) return `Это не папка: ${value}`;
  } catch {
    return `Папки нет: ${value}`;
  }
  return null;
}

export function createProjectStore(dataDir) {
  const file = path.join(dataDir, 'projects.json');
  const read = () => {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(data.projects) ? data.projects : [];
    } catch {
      return [];
    }
  };
  const write = (projects) => {
    fs.mkdirSync(dataDir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ projects }, null, 2), 'utf8');
    fs.renameSync(temp, file);
  };
  return {
    list: read,
    get: (id) => read().find((p) => p.id === id) || null,
    /** Создать или изменить. Папки проверяются; дубли и вложенные в основную отбрасываются. */
    save(raw = {}) {
      const projects = read();
      const index = projects.findIndex((p) => p.id === raw.id);
      const prev = index >= 0 ? projects[index] : {};
      const name = String(raw.name ?? prev.name ?? '').trim().slice(0, 80);
      if (!name) throw new Error('Нужно название проекта');
      const primaryDir = path.resolve(String(raw.primaryDir ?? prev.primaryDir ?? ''));
      const bad = checkDir(raw.primaryDir ?? prev.primaryDir);
      if (bad) throw new Error(bad);
      const extra = [];
      for (const dir of Array.isArray(raw.extraDirs) ? raw.extraDirs : prev.extraDirs || []) {
        const full = path.resolve(String(dir));
        const err = checkDir(full);
        if (err) throw new Error(err);
        if (full === primaryDir || extra.includes(full)) continue;
        extra.push(full);
      }
      const project = {
        id: prev.id || crypto.randomUUID(),
        name,
        primaryDir,
        extraDirs: extra.slice(0, 20),
        instructions: String(raw.instructions ?? prev.instructions ?? '').slice(0, MAX_INSTRUCTIONS),
        // Пусто — все подключённые коннекторы; список — только эти.
        connectors: [...new Set((raw.connectors ?? prev.connectors ?? []).map(String).filter(Boolean))].slice(0, 50),
        kind: (raw.kind ?? prev.kind) === 'code' ? 'code' : 'task',
        // Песочница команд проекта (CW1.3): inherit — как в настройках, docker, off.
        sandbox: ['docker', 'off'].includes(raw.sandbox ?? prev.sandbox) ? raw.sandbox ?? prev.sandbox : 'inherit',
        createdAt: prev.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      if (index >= 0) projects[index] = project;
      else projects.push(project);
      write(projects);
      return project;
    },
    remove(id) {
      write(read().filter((p) => p.id !== id));
    },
  };
}

/** Раздел системного промпта с инструкциями проекта. */
export function projectPrompt(project) {
  if (!project) return '';
  const parts = [`\n# Проект «${project.name}»`];
  if (project.instructions?.trim()) parts.push(project.instructions.trim());
  if (project.connectors?.length) parts.push(`Коннекторы проекта: ${project.connectors.join(', ')} — другие MCP-серверы в этом проекте недоступны.`);
  return parts.join('\n');
}

/** MCP-инструмент разрешён проекту? Пустой список — все. */
export function connectorAllowed(project, toolName) {
  if (!project?.connectors?.length) return true;
  const server = /^mcp__(.+?)__/.exec(String(toolName))?.[1];
  if (!server) return true;
  return project.connectors.some((c) => c.replace(/[^a-zA-Z0-9_-]/g, '_') === server);
}
