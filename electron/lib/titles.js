/** Заголовки чатов (CC6.8, ADR 0073). Модуль не зависит от Electron. */

/** Заголовок чата из ответа модели: одна строка, без кавычек и точки, до 60 символов. */
export function cleanTitle(raw) {
  const line = String(raw || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean) || '';
  return line
    .replace(/^(заголовок|title)\s*:\s*/i, '')
    .replace(/^[«"'`*#\s]+|[»"'`*.\s]+$/g, '')
    .slice(0, 60)
    .trim();
}
