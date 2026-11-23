/**
 * Отложенная загрузка инструментов (CC1.12, ADR 0079). Когда MCP-серверов и
 * плагинов много, их схемы съедают контекст в каждом запросе. Тогда модель
 * видит встроенные инструменты полностью, а внешние — только именами в
 * системном промпте; схемы подгружаются инструментом `tool_search`.
 * Модуль не зависит от Electron.
 */

export const DEFAULT_DEFER_OVER = 25;
const MAX_PER_SEARCH = 10;

/** Внешний ли инструмент (откладывается): MCP и плагины. */
export const isDeferrable = (entry) => entry.source === 'mcp' || entry.source === 'plugin';

/**
 * Что показать модели в этом запросе.
 * @param {Array} tools все инструменты прогона (toolEntry)
 * @param {Set<string>} loaded имена уже подгруженных схем
 * @returns {{ exposed: Array, deferred: Array }}
 */
export function splitTools(tools, loaded, { over = DEFAULT_DEFER_OVER } = {}) {
  const external = tools.filter(isDeferrable);
  if (!(over > 0) || external.length <= over) return { exposed: tools, deferred: [] };
  return {
    exposed: tools.filter((t) => !isDeferrable(t) || loaded.has(t.name)),
    deferred: external.filter((t) => !loaded.has(t.name)),
  };
}

/** Строка для системного промпта: имена отложенных инструментов с коротким описанием. */
export function deferredPrompt(deferred) {
  if (!deferred.length) return '';
  const lines = deferred.map((t) => `- ${t.name} — ${String(t.schema?.function?.description || '').replace(/\s+/g, ' ').slice(0, 90)}`);
  return [
    '',
    '# Инструменты по запросу',
    `Ещё ${deferred.length} инструментов (MCP и плагины) доступны, но их параметры не загружены. Чтобы вызвать такой инструмент, сначала загрузи его схему: tool_search с запросом (слова из названия или описания) или "select:имя1,имя2".`,
    ...lines,
  ].join('\n');
}

/** Поиск: `select:a,b` — точные имена, иначе — слова в имени и описании (все слова должны встретиться). */
export function searchTools(deferred, query) {
  const q = String(query || '').trim();
  if (!q) return [];
  if (q.startsWith('select:')) {
    const names = q.slice(7).split(',').map((s) => s.trim()).filter(Boolean);
    return deferred.filter((t) => names.includes(t.name)).slice(0, MAX_PER_SEARCH);
  }
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return deferred
    .map((t) => {
      const hay = `${t.name} ${t.schema?.function?.description || ''}`.toLowerCase();
      const score = words.reduce((s, w) => s + (t.name.toLowerCase().includes(w) ? 3 : hay.includes(w) ? 1 : -100), 0);
      return { t, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_PER_SEARCH)
    .map((x) => x.t);
}

export const TOOL_SEARCH_SCHEMA = {
  type: 'function',
  function: {
    name: 'tool_search',
    description: 'Загрузить схемы инструментов «по запросу» (список — в системном промпте): запрос словами или "select:имя1,имя2". После загрузки инструменты можно вызывать.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
};
