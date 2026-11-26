/**
 * Семейства моделей для MAI Ship (ADR 0110).
 *
 * Approver не должен быть из того же семейства, что исполнитель и ревьюер:
 * `openai/gpt-5.1` и `agentrouter/gpt-5.1` — одно семейство, хотя провайдеры разные.
 * Модель без семейства считается неизвестной: независимость не доказана.
 */

export const BUILTIN_FAMILIES = {
  claude: ['*/claude-*', '*/anthropic.claude-*'],
  gpt: ['*/gpt-*', '*/o1*', '*/o3*', '*/o4*', '*/chatgpt-*'],
  kimi: ['*/kimi-*', '*/moonshot-*', '*/moonshotai*'],
  deepseek: ['*/deepseek-*', '*/deepseek'],
  qwen: ['*/qwen*', '*/qwq-*'],
  gemini: ['*/gemini-*', '*/gemma-*'],
  glm: ['*/glm-*', '*/chatglm*'],
  llama: ['*/llama*', '*/meta-llama*'],
  mistral: ['*/mistral*', '*/mixtral*', '*/codestral*', '*/devstral*'],
};

function maskToRe(mask) {
  const source = String(mask).split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${source}$`, 'i');
}

/** Таблица семейств: встроенные + `families` из ship.yaml. Маски из ship.yaml идут первыми. */
export function familyTable(extra = {}) {
  const table = [];
  for (const [name, masks] of Object.entries(extra || {})) {
    for (const mask of masks || []) table.push({ name, re: maskToRe(mask) });
  }
  for (const [name, masks] of Object.entries(BUILTIN_FAMILIES)) {
    for (const mask of masks) table.push({ name, re: maskToRe(mask) });
  }
  return table;
}

/** `provider/model` → имя семейства или null. Без провайдера — null. */
export function familyOf(model, table = familyTable()) {
  const text = String(model || '').trim();
  if (!/^[^/\s]+\/\S+$/.test(text)) return null;
  for (const { name, re } of table) if (re.test(text)) return name;
  return null;
}

/** Модели исполнителя из трейлеров `Agent-Model: provider/model` в сообщениях коммитов. */
export function agentModelsFromCommits(messages = []) {
  const models = new Set();
  for (const message of messages) {
    for (const line of String(message || '').split(/\r?\n/)) {
      const match = /^Agent-Model:\s*(\S+)\s*$/i.exec(line.trim());
      if (match) models.add(match[1]);
    }
  }
  return [...models];
}

/**
 * Можно ли approver'у оценивать MR.
 * @returns {{ ok: boolean, reason: string }}
 */
export function checkIndependence({ approver, reviewer = '', executors = [], authorIsAgent = false, families = {} }) {
  const table = familyTable(families);
  const own = familyOf(approver, table);
  if (!own) return { ok: false, reason: `семейство модели approver'а неизвестно: ${approver || '(не задана)'}` };
  if (authorIsAgent && executors.length === 0) return { ok: false, reason: 'коммиты агента без трейлера Agent-Model: исполнитель неизвестен' };
  for (const model of executors) {
    const family = familyOf(model, table);
    if (!family) return { ok: false, reason: `семейство модели исполнителя неизвестно: ${model}` };
    if (family === own) return { ok: false, reason: `approver и исполнитель — одно семейство моделей (${own})` };
  }
  if (reviewer) {
    const family = familyOf(reviewer, table);
    if (family === own) return { ok: false, reason: `approver и ревьюер — одно семейство моделей (${own})` };
  }
  return { ok: true, reason: '' };
}
