import OpenAI from 'openai';
import crypto from 'node:crypto';
import { loadBoards, saveBoards, generateViews } from './boards.js';
import { unifiedDiff } from './diff.js';
import { withTextSafety } from './safe-client.js';
import { safeSlice } from './text-safe.js';

/** Отпечаток модели: применение отказывает, если модель изменилась после предложения (F10). */
export const modelHash = (model) => crypto.createHash('sha256').update(JSON.stringify(model || {})).digest('hex').slice(0, 16);

/**
 * Отдельный агент для архитектурных схем.
 *
 * Он не ходит по файлам и не запускает команды: на вход получает текущую модель
 * архитектуры и выбранное представление, на выходе — только изменённые разделы.
 * Модель сохраняется в boards.json, после чего представления перегенерируются.
 *
 * Почему не полная модель: провайдеры часто ограничивают длину ответа, и полный
 * JSON обрезается. Патч из изменённых секций короче и не теряет остальные данные.
 */

const SECTIONS = ['system', 'containers', 'components', 'relations', 'sequence', 'er', 'deployment', 'openapi'];

const SYSTEM = `Ты — редактор архитектурных диаграмм в MAI Code.

Тебе дают JSON-модель архитектуры и одно представление (C1, C2, C3, C4, sequence,
ER, deployment или OpenAPI). Пользователь пишет, что поправить на схеме.

Правила:
- Меняй только то, о чём просит пользователь, и то, что необходимо для связности.
- Не выдумывай сущности, которых нет в модели, если пользователь не просил их добавить.
- Верни ТОЛЬКО изменённые разделы в changes. Не возвращай всю модель и неизменённые разделы.
- Каждый раздел в changes должен быть полным: например, если меняешь контейнер,
  верни весь массив containers, а не один элемент.
- Сохраняй существующие id и связи. Новые id — короткая латиница.
- Если просьба неоднозначна, задай один короткий уточняющий вопрос в reply и верни
  changes: {}.
- Ответ — строго JSON без markdown:
  {"reply": "что сделано или уточнение", "changes": {"system": {...}, "containers": [...]}}

Допустимые ключи changes: ${SECTIONS.join(', ')}.

Схема модели:
- system: {name, description, actors: string[], externals: string[]}
- containers: [{id, name, tech, description}]
- components: [{id, container, name, description}]
- relations: [{from, to, label, tech}]
- sequence: {title, participants: string[], messages: [{from, to, text, kind}]}
- er: {entities: [{name, attributes: [{name, type, pk?, fk?}]}], relations: [{from, to, label, cardinality}]}
- deployment: {nodes: [{id, name, kind, vm, cpu, ram, gpu, region}], links: [{from, to}]}
- openapi: {info: {title, version}, paths: {"/path": {get|post|put|delete: {summary, tags: string[]}}}}`;

function extractJson(text) {
  const raw = String(text || '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Агент вернул ответ без JSON');
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch (err) {
    throw new Error(`Не удалось разобрать JSON агента: ${err.message}`);
  }
}

function validateModel(model) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) {
    throw new Error('Агент вернул модель не в виде объекта');
  }
  const hasContent = SECTIONS.some((key) => model[key] && typeof model[key] === 'object');
  if (!hasContent) throw new Error('В модели агента нет ни одного раздела архитектуры');
  if (JSON.stringify(model).length > 300_000) throw new Error('Модель получилась слишком большой');
  return model;
}

function mergeChanges(current, changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new Error('Агент не вернул changes');
  }
  const next = JSON.parse(JSON.stringify(current || {}));
  let touched = 0;
  for (const [key, value] of Object.entries(changes)) {
    if (!SECTIONS.includes(key)) continue;
    if (value === null || value === undefined) continue;
    if (typeof value !== 'object') throw new Error(`Раздел ${key} должен быть объектом или массивом`);
    next[key] = value;
    touched += 1;
  }
  if (!touched) throw new Error('Агент не предложил ни одного изменения');
  return validateModel(next);
}

export async function editDiagram({ provider, model, settings, projectDir, view, message, history = [] }) {
  if (!provider?.baseURL) throw new Error('У выбранного провайдера не задан Base URL');
  if (!provider?.apiKey) throw new Error(`Не задан API-ключ провайдера «${provider.name || 'unknown'}»`);

  const data = loadBoards(projectDir);
  const current = data.architecture?.model || {};
  const views = generateViews(projectDir, '');
  const selected = views.views[view];
  if (!selected) throw new Error('Представление не найдено');

  const context = [
    `Представление: ${view} — ${selected.title}`,
    `Текущая схема (PlantUML):\n${selected.puml || '(нет)'}`,
    `Текущая модель архитектуры:\n${JSON.stringify(current, null, 2)}`,
    `Задача пользователя: ${message}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const client = withTextSafety(new OpenAI({ apiKey: provider.apiKey, baseURL: provider.baseURL, maxRetries: 1 }));
  const messages = [
    { role: 'system', content: SYSTEM },
    ...history
      .filter((item) => item && (item.role === 'user' || item.role === 'assistant') && item.content)
      .slice(-10)
      .map((item) => ({ role: item.role, content: safeSlice(item.content, 8000) })),
    { role: 'user', content: context },
  ];

  const ask = (payload) =>
    client.chat.completions.create({
      model,
      messages: payload,
      temperature: 0.1,
      max_tokens: 8000,
    });

  const response = await ask(messages);
  const first = response.choices?.[0]?.message?.content || '';
  let parsed;
  try {
    if (response.choices?.[0]?.finish_reason === 'length') {
      throw new Error('ответ обрезан по лимиту токенов');
    }
    parsed = extractJson(first);
  } catch (err) {
    // Один повтор: модель видит свой невалидный ответ и обязана вернуть только JSON.
    const retry = await ask([
      ...messages,
      { role: 'assistant', content: String(first).slice(0, 30000) },
      {
        role: 'user',
        content:
          `Предыдущий ответ невалиден (${err.message}). Верни ТОЛЬКО валидный JSON ` +
          'в формате {"reply": "...", "changes": {...}} без markdown и пояснений. ' +
          'В changes — только изменённые разделы, каждый целиком.',
      },
    ]);
    const second = retry.choices?.[0]?.message?.content || '';
    if (retry.choices?.[0]?.finish_reason === 'length') {
      throw new Error('Агент не уложился в лимит токенов. Упростите запрос или уменьшите изменения.');
    }
    parsed = extractJson(second);
  }

  const reply = String(parsed.reply || 'Модель обновлена.').trim();
  const next = parsed.changes
    ? mergeChanges(current, parsed.changes)
    : validateModel(parsed.model || parsed);

  // F10 (ADR 0086): не пишем сразу — возвращаем предложение и diff; запись — applyDiagram.
  const diff = unifiedDiff(`${JSON.stringify(current, null, 2)}\n`, `${JSON.stringify(next, null, 2)}\n`, { maxLines: 400 });
  return {
    ok: true,
    reply,
    proposal: next,
    baseHash: modelHash(current),
    diff: { added: diff.added, removed: diff.removed, truncated: diff.truncated, lines: diff.lines },
    changed: diff.added + diff.removed > 0,
  };
}

/**
 * Применить предложение агента схем (F10): модель проверяется заново, а если
 * её успели поменять (другое окно, ручная правка) — отказ, нужно спросить снова.
 */
export function applyDiagram({ projectDir, proposal, baseHash }) {
  const data = loadBoards(projectDir);
  const current = data.architecture?.model || {};
  if (baseHash && modelHash(current) !== baseHash) throw new Error('Модель изменилась после предложения — попросите агента ещё раз');
  data.architecture.model = validateModel(proposal);
  saveBoards(projectDir, data);
  return { ok: true, model: data.architecture.model, views: generateViews(projectDir, '') };
}
