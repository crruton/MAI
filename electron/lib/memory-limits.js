/** Пределы памяти в системном промпте (CC4.5, ADR 0080). Модуль не зависит от Electron. */
import { safeSlice } from './text-safe.js';

/** Сколько памяти уходит в системный промпт (CC4.5): остальное — через memory_read. */
export const MEMORY_LIMITS = { global: 6000, project: 12000 };

/** Память для промпта: текст в пределе и пометка, если обрезано. */
export function memoryForPrompt(text, scope) {
  const full = String(text || '').trim();
  const limit = MEMORY_LIMITS[scope] || 6000;
  if (full.length <= limit) return { text: full, truncated: false, size: full.length, limit };
  return {
    text: `${safeSlice(full, limit)}\n\n[Память обрезана: в промпте ${limit} из ${full.length} символов. Остальное — инструментом memory_read.]`,
    truncated: true,
    size: full.length,
    limit,
  };
}
