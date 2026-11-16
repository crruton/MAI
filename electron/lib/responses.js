/**
 * Транспорт OpenAI Responses API (/v1/responses).
 *
 * Нужен потому, что часть моделей (например gpt-5.6-sol и gpt-6.1-sol на
 * AgentRouter) не принимает /v1/chat/completions и отвечает 400 с указанием
 * использовать /v1/responses. Формат отличается от chat:
 *   - tools плоские: { type: 'function', name, parameters } без обёртки function;
 *   - история идёт в input, системный промпт — в instructions;
 *   - вызовы инструментов — это items типа function_call, а не delta.tool_calls.
 *
 * Модуль приводит внутреннюю chat-форму сообщений к input и обратно, чтобы
 * цикл агента в agent.js оставился единым для обоих транспортов.
 */

/**
 * GPT-5+ и аналоги принимают только дефолтную температуру: явная value
 * даёт 400 «Unsupported parameter: 'temperature'». Список расширяется
 * по имени модели, чтобы не гонять повторные запросы.
 */
export function supportsTemperature(model) {
  return !/^gpt-[5-9]/i.test(String(model || '').trim());
}

/** Системный текст в Responses API уходит отдельным полем, а не сообщением. */
export function splitSystem(messages) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n\n');
  const rest = messages.filter((m) => m.role !== 'system');
  return { system, rest };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part?.type === 'text' || part?.type === 'input_text' || part?.type === 'output_text') {
        return part.text || '';
      }
      if (part?.type === 'image_url') return `[изображение: ${part.image_url?.url || ''}]`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Chat-история → input[] для /v1/responses.
 * Вызовы инструмента и их результаты становятся items function_call /
 * function_call_output — без них модель не увидит продолжение цикла.
 */
export function toInput(messages) {
  const input = [];
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const text = textOf(message.content);
      if (text) input.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
      for (const call of message.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function?.name,
          arguments: call.function?.arguments || '{}',
        });
      }
      continue;
    }
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: textOf(message.content),
      });
      continue;
    }
    const text = textOf(message.content);
    if (!text) continue;
    input.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text }],
    });
  }
  return input;
}

/** Chat-схема инструмента { type:'function', function:{...} } → плоская схема Responses. */
export function toResponseTools(tools) {
  return tools
    .map((tool) => {
      const schema = tool?.schema || tool;
      const fn = schema?.function || schema;
      if (!fn?.name) return null;
      return {
        type: 'function',
        name: fn.name,
        description: fn.description || '',
        parameters: fn.parameters || { type: 'object', properties: {} },
        strict: false,
      };
    })
    .filter(Boolean);
}

/**
 * Один ход модели через /v1/responses со стримингом.
 * Возвращает { content, reasoning, toolCalls } в chat-форме, чтобы
 * вызывающий код не зависел от транспорта.
 */
export async function streamResponseTurn({
  client,
  model,
  instructions,
  input,
  tools,
  temperature,
  signal,
  emit = () => {},
}) {
  const body = {
    model,
    instructions: instructions || undefined,
    input,
    stream: true,
    ...(tools?.length ? { tools } : {}),
    ...(temperature != null && supportsTemperature(model) ? { temperature } : {}),
  };
  const stream = await client.responses.create(body, { signal });

  let content = '';
  let reasoning = '';
  const calls = new Map(); // call_id -> { id, name, arguments }
  const order = [];

  for await (const event of stream) {
    if (signal?.aborted) break;
    const type = event?.type || '';
    const item = event.item || event.item || null;

    if (type === 'response.output_text.delta' && event.delta) {
      content += event.delta;
      emit({ type: 'delta', text: event.delta });
      continue;
    }
    if (type === 'response.reasoning_summary_text.delta' && event.delta) {
      reasoning += event.delta;
      emit({ type: 'reasoning', text: event.delta });
      continue;
    }
    if (type === 'response.output_item.added' && item?.type === 'function_call') {
      const key = item.call_id || item.id || `call_${order.length}`;
      if (!calls.has(key)) {
        calls.set(key, { id: key, name: item.name || '', arguments: '' });
        order.push(key);
      }
      continue;
    }
    if (type === 'response.function_call_arguments.delta') {
      const key = event.call_id || event.item_id;
      const slot = calls.get(key);
      if (slot && event.delta) slot.arguments += event.delta;
      continue;
    }
    if (type === 'response.output_item.done' && item?.type === 'function_call') {
      const key = item.call_id || item.id;
      const slot = calls.get(key) || { id: key, name: '', arguments: '' };
      if (item.name) slot.name = item.name;
      if (item.arguments) slot.arguments = item.arguments;
      if (!calls.has(key)) {
        calls.set(key, slot);
        order.push(key);
      }
      continue;
    }
    // Некоторые шлюзы не отдают дельты, а присылают готовый объект ответа.
    if ((type === 'response.completed' || type === 'response.incomplete') && event.response) {
      const built = collectFromResponse(event.response);
      if (built.content && !content) {
        emit({ type: 'delta', text: built.content });
        content = built.content;
      }
      if (built.reasoning && !reasoning) reasoning = built.reasoning;
      for (const call of built.toolCalls) {
        if (!calls.has(call.id)) {
          calls.set(call.id, call);
          order.push(call.id);
        }
      }
    }
  }

  const toolCalls = order
    .map((key) => calls.get(key))
    .filter((c) => c && c.name)
    .map((c) => ({ id: c.id, name: c.name, arguments: c.arguments || '{}' }));

  return { content, reasoning, toolCalls };
}

/** Разобрать готовый объект ответа (fallback, если дельт не было). */
export function collectFromResponse(response) {
  let content = '';
  let reasoning = '';
  const toolCalls = [];
  for (const item of response?.output || []) {
    if (item.type === 'message') {
      for (const part of item.content || []) {
        if (part.type === 'output_text' && part.text) content += part.text;
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id || item.id || `call_${toolCalls.length}`,
        name: item.name || '',
        arguments: item.arguments || '{}',
      });
    } else if (item.type === 'reasoning') {
      for (const summary of item.summary || []) {
        if (summary?.text) reasoning += summary.text;
      }
    }
  }
  return { content, reasoning, toolCalls };
}

/** Признак того, что модель требует /v1/responses вместо chat/completions. */
export function isResponsesRequired(err) {
  const text = `${err?.message || ''} ${err?.error?.message || ''}`;
  return /\/v1\/responses/i.test(text) && /chat\/completions/i.test(text);
}
