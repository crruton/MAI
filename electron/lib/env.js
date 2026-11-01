import fs from 'node:fs';
import path from 'node:path';

/**
 * Читает .env без зависимостей.
 * Поддерживает `KEY=value`, `KEY\t=value`, `KEY\tvalue`, кавычки и комментарии.
 */
export function parseEnv(text) {
  const result = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*[=\t ]\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value === '') continue;
    result[match[1]] = value;
  }
  return result;
}

export function readEnvFiles(files) {
  const merged = {};
  for (const file of files) {
    if (!file) continue;
    try {
      Object.assign(merged, parseEnv(fs.readFileSync(file, 'utf8')));
    } catch {
      /* файла нет — пропускаем */
    }
  }
  return merged;
}

export function envCandidates({ dataDir, appDir, userProfile }) {
  return [
    path.join(dataDir || '', '.env'),
    path.join(userProfile || '', 'Desktop', 'dev', '.env'),
    path.join(appDir || '', '.env'),
  ].filter(Boolean);
}
