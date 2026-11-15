import path from 'node:path';
import { memoryFiles, readMemory, writeMemory } from './skills.js';
import { writeArtifact, artifactHistory, readVersion } from './artifacts.js';

/**
 * Версионируемая память проекта (бэклог №4).
 *
 * Файл памяти остаётся обычным Markdown-файлом: его читает агент и правит
 * пользователь. Рядом, в хранилище артефактов, лежит история версий с типом
 * `memory`. Запись одинакового текста не создаёт новую версию — это делает
 * `writeArtifact` по хешу содержимого.
 *
 * Уровни: `project` — `<проект>/.mai-code/memory.md`, `global` —
 * `%APPDATA%/mai-code/memory.md`.
 */

export const MEMORY_SCOPES = ['project', 'global'];

const TITLES = {
  project: 'Память проекта',
  global: 'Глобальная память',
};

export function memoryArtifactId(scope) {
  return `memory:${scope}`;
}

/** Определяет уровень памяти по пути файла. Пустая строка — путь чужой. */
export function memoryScopeOfFile(projectDir, file) {
  const files = memoryFiles(projectDir);
  const target = path.resolve(String(file || ''));
  if (target === path.resolve(files.projectFile)) return 'project';
  if (target === path.resolve(files.globalFile)) return 'global';
  return '';
}

function historyOf(projectDir, scope) {
  try {
    return artifactHistory(projectDir, memoryArtifactId(scope));
  } catch {
    // Артефакта ещё нет: память правили до появления версий.
    return [];
  }
}

/** Читает оба файла памяти и историю версий каждого уровня. */
export function readMemoryState(projectDir) {
  const data = readMemory(projectDir);
  const versions = {};
  for (const scope of MEMORY_SCOPES) versions[scope] = historyOf(projectDir, scope);
  return { ...data, versions };
}

/**
 * Сохраняет память одного уровня: пишет файл и версию артефакта.
 * Возвращает `changed: false`, если текст не изменился.
 */
export function saveMemory(projectDir, { scope, content, note = '' }) {
  if (!MEMORY_SCOPES.includes(scope)) throw new Error(`Неизвестный уровень памяти: ${scope}`);
  const files = memoryFiles(projectDir);
  const file = scope === 'project' ? files.projectFile : files.globalFile;
  const text = String(content ?? '');

  writeMemory(file, text);
  const result = writeArtifact(projectDir, {
    id: memoryArtifactId(scope),
    kind: 'memory',
    name: TITLES[scope],
    title: TITLES[scope],
    content: text,
    meta: { file, scope },
    note: note || 'сохранение из панели «Память»',
  });

  return {
    scope,
    file,
    changed: Boolean(result.changed),
    version: result.current,
    versions: historyOf(projectDir, scope),
  };
}

/**
 * Совместимость со старым каналом `memory:write(file, content)`.
 * Если путь совпал с файлом памяти, запись версионируется; иначе пишется как есть.
 */
export function saveMemoryFile(projectDir, file, content) {
  const scope = memoryScopeOfFile(projectDir, file);
  if (scope) return saveMemory(projectDir, { scope, content });
  writeMemory(file, content);
  return { scope: '', file, changed: true, version: 0, versions: [] };
}

/** Возвращает текст версии памяти, не меняя файл. */
export function memoryVersion(projectDir, scope, version) {
  if (!MEMORY_SCOPES.includes(scope)) throw new Error(`Неизвестный уровень памяти: ${scope}`);
  return readVersion(projectDir, memoryArtifactId(scope), version);
}

/** Откатывает память к версии: пишет файл и создаёт новую версию с пометкой. */
export function restoreMemory(projectDir, scope, version) {
  const content = memoryVersion(projectDir, scope, version);
  return saveMemory(projectDir, { scope, content, note: `восстановлена версия ${version}` });
}
