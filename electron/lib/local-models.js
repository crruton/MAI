/**
 * Локальные модели (N4, ADR 0100): найти запущенный сервер моделей на этой
 * машине и добавить его провайдером в один клик. Маршрутизации «локально/облако»
 * нет (решение гриллинга): локальная модель — обычный провайдер.
 *
 * Модуль не зависит от Electron: fetch передаёт вызывающий.
 */

/** Известные серверы: стандартные порты и OpenAI-совместимый /v1. */
export const LOCAL_SERVERS = [
  { id: 'ollama', name: 'Ollama', port: 11434, hint: 'ollama serve' },
  { id: 'lmstudio', name: 'LM Studio', port: 1234, hint: 'LM Studio → Developer → Start Server' },
  // colibri (JustVugg/colibri): `coli serve`, в примерах README — 127.0.0.1:8000/v1. Тот же порт у vLLM.
  { id: 'colibri', name: 'colibri или vLLM', port: 8000, hint: './coli serve --model <папка>' },
  { id: 'llamacpp', name: 'llama.cpp server', port: 8080, hint: 'llama-server -m model.gguf' },
  { id: 'jan', name: 'Jan', port: 1337, hint: 'Jan → Local API Server' },
];

/** Ответ /v1/models → список id. */
export function parseModels(body) {
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  return list.map((m) => String(m?.id || m?.name || m?.model || '')).filter(Boolean).slice(0, 200);
}

/** Модели для эмбеддингов и прочие не-чатовые — в конец списка. */
const notChat = (id) => /embed|bge-|e5-|rerank|whisper|tts/i.test(id);

/**
 * Проверить серверы параллельно. Каждый — `GET http://127.0.0.1:<порт>/v1/models`
 * с таймаутом. Возвращает найденные: { id, name, baseURL, models, added, hint }.
 */
export async function detectLocalModels({ fetchImpl = globalThis.fetch, providers = {}, timeoutMs = 1500, host = '127.0.0.1', servers = LOCAL_SERVERS } = {}) {
  const probe = async (srv) => {
    const baseURL = `http://${host}:${srv.port}/v1`;
    try {
      const res = await fetchImpl(`${baseURL}/models`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return null;
      const models = parseModels(await res.json());
      if (!models.length) return { ...srv, baseURL, models: [], empty: true };
      const sorted = [...models.filter((m) => !notChat(m)), ...models.filter(notChat)];
      return { ...srv, baseURL, models: sorted };
    } catch {
      return null;
    }
  };
  const found = (await Promise.all(servers.map(probe))).filter(Boolean);
  const known = Object.entries(providers || {});
  return found.map((f) => {
    const same = known.find(([, p]) => String(p?.baseURL || '').replace(/\/+$/, '') === f.baseURL);
    return { id: f.id, name: f.name, baseURL: f.baseURL, port: f.port, hint: f.hint, models: f.models, empty: Boolean(f.empty), added: Boolean(same), providerId: same?.[0] || '' };
  });
}

/**
 * Запись провайдера для найденного сервера. Ключ локальным серверам не нужен,
 * но SDK OpenAI требует непустой — пишем «local». Свободный id: ollama, ollama-2…
 */
export function providerFromLocal(found, providers = {}) {
  let id = found.id;
  for (let n = 2; providers[id] && String(providers[id].baseURL || '').replace(/\/+$/, '') !== found.baseURL; n += 1) id = `${found.id}-${n}`;
  return {
    id,
    provider: {
      name: found.name === 'colibri или vLLM' ? 'colibri (локально)' : `${found.name} (локально)`,
      baseURL: found.baseURL,
      apiKey: 'local',
      local: true,
      models: found.models.map((m) => ({ id: m, name: m, context: null })),
    },
  };
}
