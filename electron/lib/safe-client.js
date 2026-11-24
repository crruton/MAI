/**
 * Санитайз на уровне клиента провайдера (ADR 0107, дополнение).
 *
 * `buildRequest` чистит только запросы цикла агента. Мимо него идут побочные
 * вызовы: компакция (`completeOnce`), ревизор, калибратор, диаграмма. Каждый из
 * них режет текст `.slice(0, N)` и может оставить одиночный суррогат — шлюз
 * отвечает `400 Invalid JSON payload: no low surrogate in string`.
 *
 * Обёртка ставит санитайз на самый нижний уровень: любое тело запроса, ушедшее
 * в `chat.completions.create` или `responses.create`, очищается. Это последний
 * рубеж, поэтому он не зависит от того, кто и как собрал текст.
 */
import { sanitizeText, sanitizeMessages } from './text-safe.js';

/** Тело запроса chat.completions: messages, tools, имена функций. */
function sanitizeChatBody(body) {
  if (!body || typeof body !== 'object') return body;
  const next = { ...body };
  if (Array.isArray(next.messages)) next.messages = sanitizeMessages(next.messages);
  if (Array.isArray(next.tools)) {
    next.tools = next.tools.map((tool) => {
      if (!tool || typeof tool !== 'object') return tool;
      const copy = { ...tool };
      if (typeof copy.function?.name === 'string') {
        copy.function = { ...copy.function, name: sanitizeText(copy.function.name) };
      }
      return copy;
    });
  }
  return next;
}

/** Элемент входа Responses API: строка или объект с content. */
function sanitizeInputItem(item) {
  if (typeof item === 'string') return sanitizeText(item);
  if (!item || typeof item !== 'object') return item;
  const next = { ...item };
  if (typeof next.content === 'string') next.content = sanitizeText(next.content);
  else if (Array.isArray(next.content)) {
    next.content = next.content.map((part) => (part && typeof part.text === 'string' ? { ...part, text: sanitizeText(part.text) } : part));
  }
  if (typeof next.arguments === 'string') next.arguments = sanitizeText(next.arguments);
  if (typeof next.name === 'string') next.name = sanitizeText(next.name);
  return next;
}

/** Тело запроса Responses API: instructions, input, tools. */
function sanitizeResponsesBody(body) {
  if (!body || typeof body !== 'object') return body;
  const next = { ...body };
  if (typeof next.instructions === 'string') next.instructions = sanitizeText(next.instructions);
  if (typeof next.input === 'string') next.input = sanitizeText(next.input);
  else if (Array.isArray(next.input)) next.input = next.input.map(sanitizeInputItem);
  if (Array.isArray(next.tools)) {
    next.tools = next.tools.map((tool) => {
      if (!tool || typeof tool !== 'object') return tool;
      const copy = { ...tool };
      if (typeof copy.name === 'string') copy.name = sanitizeText(copy.name);
      if (typeof copy.description === 'string') copy.description = sanitizeText(copy.description);
      return copy;
    });
  }
  return next;
}

/**
 * Обернуть клиент провайдера: тела запросов к модели проходят санитайз.
 * Остальные свойства и методы клиента остаются как есть.
 */
export function withTextSafety(client) {
  if (!client || typeof client !== 'object') return client;
  const wrapCreate = (resource, sanitize) => {
    if (!resource || typeof resource.create !== 'function') return resource;
    return new Proxy(resource, {
      get(target, prop, receiver) {
        if (prop === 'create') {
          return (body, options) => target.create(sanitize(body), options);
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  };
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'chat') {
        const chat = Reflect.get(target, prop, receiver);
        if (!chat || typeof chat !== 'object') return chat;
        return new Proxy(chat, {
          get(chatTarget, chatProp, chatReceiver) {
            if (chatProp === 'completions') {
              return wrapCreate(Reflect.get(chatTarget, chatProp, chatReceiver), sanitizeChatBody);
            }
            return Reflect.get(chatTarget, chatProp, chatReceiver);
          },
        });
      }
      if (prop === 'responses') {
        return wrapCreate(Reflect.get(target, prop, receiver), sanitizeResponsesBody);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
