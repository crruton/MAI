import OpenAI from 'openai';
import { fsTools } from './tools/fs.js';
import { shellTools } from './tools/shell.js';
import { skillTools } from './tools/skills.js';
import { repowiseTools } from './tools/repowise.js';
import { listSkills, readAgents, readMemory } from './skills.js';

const BASE_PROMPT = `Ты — MAI Code, агент для программирования на рабочей машине пользователя.

Правила:
- Отвечай по-русски, кратко и по делу.
- Прежде чем менять код, посмотри файлы инструментами read_file / list_files / grep.
- Правки делай точечно через edit_file; whole-file write_file — только для новых файлов.
- Не выдумывай содержимое файлов: если не читал — прочитай.
- Команды оболочки запускай только когда это действительно нужно; пользователь подтверждает каждую.
- После изменений проверяй результат (тесты, сборка, линтер), если это возможно.
- Не коммить в git и не удалять данные без явной просьбы.`;

function systemPrompt({ projectDir, skills, mcpStatus }) {
  const agents = readAgents(projectDir);
  const memory = readMemory(projectDir);
  const parts = [BASE_PROMPT, `\nРабочая папка проекта: ${projectDir}`];
  if (agents.global.trim()) parts.push(`\n# Глобальные инструкции (AGENTS.md)\n${agents.global.trim()}`);
  if (agents.project.trim()) parts.push(`\n# Инструкции проекта (AGENTS.md)\n${agents.project.trim()}`);
  if (memory.global.trim()) {
    parts.push(`\n# Глобальная память (memory.md)\n${memory.global.trim().slice(0, 6000)}`);
  }
  if (memory.project.trim()) {
    parts.push(`\n# Память проекта (memory.md)\n${memory.project.trim().slice(0, 12000)}`);
  }
  if (skills.length) {
    parts.push(
      `\n# Навыки\nПолный текст навыка загружается инструментом load_skill.\n${skills
        .map((s) => `- ${s.name}: ${s.description || 'без описания'}`)
        .join('\n')}`,
    );
  }
  if (mcpStatus.length) {
    parts.push(
      `\n# MCP-серверы\n${mcpStatus
        .map((s) => `- ${s.name}: ${s.status}${s.tools.length ? ` (${s.tools.join(', ')})` : ''}`)
        .join('\n')}`,
    );
  }
  return parts.join('\n');
}

function trimMessages(messages, limit = 320_000) {
  let total = JSON.stringify(messages).length;
  const copy = [...messages];
  while (total > limit && copy.length > 6) {
    const nextUser = copy.findIndex((m, i) => i > 0 && m.role === 'user');
    const cut = nextUser > 0 ? nextUser : 2;
    copy.splice(0, cut);
    total = JSON.stringify(copy).length;
  }
  return copy;
}

function parseArgs(raw) {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return { _raw: raw };
  }
}

export async function runAgent({
  settings,
  provider,
  projectDir,
  model,
  messages,
  emit,
  approve,
  signal,
  mcp,
  pluginTools = [],
  transforms = [],
}) {
  if (!provider?.baseURL) throw new Error('У выбранного провайдера не задан Base URL');
  if (!provider.apiKey) throw new Error(`Не задан API-ключ провайдера «${provider.name || 'unknown'}»`);

  const client = new OpenAI({ apiKey: provider.apiKey, baseURL: provider.baseURL, maxRetries: 1 });
  const skills = listSkills(projectDir);
  const repoTools = settings.repowise?.enabled ? repowiseTools : [];
  const tools = [...fsTools, ...shellTools, ...skillTools, ...repoTools, ...pluginTools, ...mcp.toolSchemas()];

  const system = systemPrompt({ projectDir, skills, mcpStatus: mcp.status() });
  let history = trimMessages([...messages]);
  const maxIterations = settings.maxIterations || 30;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (signal.aborted) break;
    for (const transform of transforms) {
      try {
        history = transform(history) || history;
      } catch {
        /* плагин не должен ломать диалог */
      }
    }

    const requestMessages = [
      { role: 'system', content: system },
      ...history.map(({ reasoning, ...rest }) => rest),
    ];
    const stream = await client.chat.completions.create(
      {
        model,
        messages: requestMessages,
        tools: tools.map((t) => t.schema),
        temperature: settings.temperature ?? 0.3,
        stream: true,
      },
      { signal },
    );

    let content = '';
    let reasoning = '';
    const calls = [];
    for await (const chunk of stream) {
      if (signal.aborted) break;
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      const reasoningDelta = delta.reasoning_content || delta.reasoning;
      if (reasoningDelta) {
        reasoning += reasoningDelta;
        emit({ type: 'reasoning', text: reasoningDelta });
      }
      if (delta.content) {
        content += delta.content;
        emit({ type: 'delta', text: delta.content });
      }
      for (const call of delta.tool_calls || []) {
        const index = call.index ?? calls.length;
        calls[index] ??= { id: '', name: '', arguments: '' };
        if (call.id) calls[index].id = call.id;
        if (call.function?.name) calls[index].name = call.function.name;
        if (call.function?.arguments) calls[index].arguments += call.function.arguments;
      }
    }

    const validCalls = calls.filter((c) => c && c.name);
    const assistantMessage = { role: 'assistant', content: content || null };
    if (reasoning) assistantMessage.reasoning = reasoning;
    if (validCalls.length) {
      assistantMessage.tool_calls = validCalls.map((c) => ({
        id: c.id || `call_${Math.random().toString(36).slice(2)}`,
        type: 'function',
        function: { name: c.name, arguments: c.arguments || '{}' },
      }));
    }
    history.push(assistantMessage);
    emit({ type: 'assistant', message: assistantMessage });

    if (!validCalls.length) {
      emit({ type: 'done', messages: history });
      return history;
    }

    for (const call of assistantMessage.tool_calls) {
      if (signal.aborted) break;
      const args = parseArgs(call.function.arguments);
      emit({ type: 'tool_call', id: call.id, name: call.function.name, args });
      let result;
      let ok = true;
      try {
        if (call.function.name.startsWith('mcp__')) {
          result = await mcp.call(call.function.name, args);
        } else {
          const tool = tools.find((t) => t.schema.function.name === call.function.name);
          if (!tool) throw new Error(`Неизвестный инструмент: ${call.function.name}`);
          result = await tool.run({ projectDir, approve, allowOutsideProject: settings.allowOutsideProject, repowise: settings.repowise }, args);
        }
      } catch (err) {
        ok = false;
        result = `Ошибка: ${err?.message || String(err)}`;
      }
      emit({ type: 'tool_result', id: call.id, name: call.function.name, content: String(result), ok });
      history.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content: String(result),
      });
    }
  }

  emit({ type: 'done', messages: history });
  return history;
}
