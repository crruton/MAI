/**
 * Текстовый протокол вызова инструментов (CC13.4, ADR 0078) — для моделей и
 * шлюзов без tool calling. Инструменты описываются в системном промпте, модель
 * пишет вызов блоком `<tool_call>{"name": …, "arguments": {…}}</tool_call>`,
 * результаты возвращаются ей сообщением пользователя в `<tool_result>`.
 * В истории сессии всё хранится как обычно (assistant.tool_calls → tool), так
 * что лента, откат и смена модели работают одинаково. Модуль не зависит от Electron.
 */

const CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

/** Отказ шлюза: модель не поддерживает инструменты. */
export function isToolsUnsupported(err) {
  const text = `${err?.status || ''} ${err?.message || ''} ${err?.error?.message || ''}`;
  return /does not support (tools|tool use|function)|tools? (use |calling )?(is |are )?not supported|not support(ed)? (tools|tool calls|function calling)|unsupported (parameter|field)[^\n]{0,40}tools|tool_choice[^\n]{0,40}not supported|function calling is not (available|enabled)/i.test(text);
}

/** Описание инструментов и протокола для системного промпта. */
export function textToolsPrompt(schemas = []) {
  const list = schemas
    .map((s) => {
      const f = s.function || s;
      return `### ${f.name}\n${String(f.description || '').trim()}\nПараметры (JSON Schema): ${JSON.stringify(f.parameters || { type: 'object', properties: {} })}`;
    })
    .join('\n\n');
  return [
    '# Инструменты (текстовый протокол)',
    'Эта модель вызывает инструменты текстом. Чтобы вызвать инструмент, напиши блок ровно в таком виде — JSON с полями name и arguments:',
    '<tool_call>{"name": "read_file", "arguments": {"path": "README.md"}}</tool_call>',
    'Можно несколько блоков подряд. После блоков ничего не пиши и жди: результаты придут следующим сообщением в <tool_result>. Не выдумывай результаты сам.',
    'Когда инструменты больше не нужны — ответь обычным текстом без блоков.',
    '',
    list,
  ].join('\n');
}

/** Достаёт вызовы из текста модели. Неразобранный JSON — в `errors`, текст вне блоков — в `text`. */
export function parseTextToolCalls(content, { idPrefix = 'txt' } = {}) {
  const calls = [];
  const errors = [];
  let n = 0;
  const text = String(content || '').replace(CALL_RE, (_m, body) => {
    const raw = body.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    try {
      const parsed = JSON.parse(raw);
      const name = String(parsed?.name || parsed?.tool || '').trim();
      if (!name) throw new Error('нет name');
      const args = parsed.arguments ?? parsed.args ?? parsed.parameters ?? {};
      n += 1;
      calls.push({ id: `${idPrefix}_${Date.now().toString(36)}_${n}`, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });
    } catch (err) {
      errors.push(`${raw.slice(0, 120)} — ${err.message}`);
    }
    return '';
  });
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), calls, errors };
}

/**
 * Сообщения API → вид для модели без инструментов: вызовы ассистента — блоками
 * в тексте, результаты — сообщением пользователя (подряд идущие — одним).
 */
export function toTextProtocol(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const blocks = m.tool_calls.map((c) => {
        let args = {};
        try {
          args = JSON.parse(c.function?.arguments || '{}');
        } catch {
          args = c.function?.arguments || {};
        }
        return `<tool_call>${JSON.stringify({ name: c.function?.name, arguments: args })}</tool_call>`;
      });
      out.push({ role: 'assistant', content: [m.content || '', ...blocks].filter(Boolean).join('\n') });
    } else if (m.role === 'tool') {
      const block = `<tool_result name="${String(m.name || '').replace(/"/g, '')}" id="${String(m.tool_call_id || '').replace(/"/g, '')}">\n${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}\n</tool_result>`;
      const prev = out[out.length - 1];
      if (prev?.role === 'user' && prev.toolResults) prev.content += `\n${block}`;
      else out.push({ role: 'user', content: block, toolResults: true });
    } else {
      out.push(m);
    }
  }
  return out.map(({ toolResults: _t, ...m }) => m);
}
