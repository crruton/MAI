import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
/**
 * Выполнение одного вызова инструмента через PolicyEngine (ADR 0027).
 *
 * Инструменты сами разрешение не спрашивают: цикл агента вызывает
 * `runToolCall`, который решает allow / ask / deny для любого источника —
 * встроенного инструмента, MCP или плагина. Новый инструмент нельзя
 * «забыть» защитить.
 *
 * Модуль не зависит от Electron.
 */
import { classifyTool, evaluate, subjectOf, summarize, suggestRules } from './policy.js';
import { effectiveCommand } from './tools/shell.js';
import { pushViolation, currentBranch, DEFAULT_PROTECTED } from './git-guard.js';
import { unifiedDiff } from './diff.js';

const ARGS_PREVIEW = 2000;

/**
 * Описание инструмента для цикла агента.
 * @param {object} schema OpenAI tool schema `{type:'function', function:{name,...}}`
 * @param {object} meta { source: 'builtin'|'plugin'|'mcp', kind?, annotations?, run, precheck? }
 */
export function toolEntry(schema, meta = {}) {
  const name = schema?.function?.name || '';
  return {
    name,
    schema: { type: 'function', function: schema.function },
    source: meta.source || 'builtin',
    cls: classifyTool(name, meta),
    run: meta.run,
    precheck: meta.precheck,
    preview: meta.preview,
  };
}

/** Ответ пользователя в едином виде. Старый approve возвращал true / false / строку. */
export function normalizeAnswer(answer) {
  if (answer === true) return { allow: true };
  if (answer === false || answer == null) return { allow: false };
  if (typeof answer === 'string') return { allow: false, message: answer };
  return {
    allow: answer.allow === true,
    remember: answer.remember || null,
    rules: Array.isArray(answer.rules) ? answer.rules : [],
    feedback: String(answer.feedback || '').trim(),
    message: answer.message || '',
  };
}

/* ---------- единый лимит вывода (CC1.13, ADR 0054) ---------- */

export const MAX_TOOL_OUTPUT = 30_000;
const KEEP_DAYS = 7;

/**
 * Длинный результат любого инструмента (встроенного, MCP, плагина) — целиком в
 * файл `<данные>/tool-output/…`, модели — начало, конец и путь `@вывод/…`.
 * Без папки вывода — просто обрезка.
 */
export function spillOutput(ctx, tool, content) {
  if (content.length <= MAX_TOOL_OUTPUT) return content;
  const head = content.slice(0, Math.floor(MAX_TOOL_OUTPUT * 0.7));
  const tail = content.slice(-Math.floor(MAX_TOOL_OUTPUT * 0.2));
  if (!ctx?.outputDir) return `${head}\n\n… обрезано ${content.length - head.length - tail.length} символов …\n\n${tail}`;
  try {
    fs.mkdirSync(ctx.outputDir, { recursive: true });
    const now = Date.now();
    for (const name of fs.readdirSync(ctx.outputDir)) {
      const full = path.join(ctx.outputDir, name);
      try {
        if (now - fs.statSync(full).mtimeMs > KEEP_DAYS * 86_400_000) fs.rmSync(full, { force: true });
      } catch {
        /* файл занят — удалится в следующий раз */
      }
    }
    const name = `${new Date(now).toISOString().replace(/[:.]/g, '-')}-${String(tool).replace(/[^\w-]/g, '_').slice(0, 40)}-${crypto.randomBytes(3).toString('hex')}.txt`;
    fs.writeFileSync(path.join(ctx.outputDir, name), content, 'utf8');
    const lines = content.split('\n').length;
    return `${head}\n\n… вывод длиннее ${MAX_TOOL_OUTPUT} символов (${content.length} символов, ${lines} строк). Полностью — @вывод/${name}: read_file с offset/limit или grep по этому пути …\n\n${tail}`;
  } catch {
    return `${head}\n\n… обрезано …\n\n${tail}`;
  }
}

function preview(args) {
  const json = JSON.stringify(args ?? {}, null, 2);
  return json.length > ARGS_PREVIEW ? `${json.slice(0, ARGS_PREVIEW)}\n…` : json;
}

function deniedText(entry, decision, answer) {
  if (decision.action === 'deny') return decision.reason || 'Действие запрещено политикой.';
  if (answer?.message) return answer.message;
  const base = `Пользователь отклонил вызов ${entry.name}.`;
  return answer?.feedback ? `${base} Пользователь пишет: ${answer.feedback}` : base;
}

/**
 * @param {object} p
 * @param {object} p.entry   элемент из toolEntry
 * @param {object} p.args    разобранные аргументы
 * @param {object} p.ctx     контекст инструмента (projectDir, guardrails, …)
 * @param {object} p.policy  { getMode(), getRules(), role }
 * @param {Function} p.approve async (request) → answer
 * @param {Function} [p.audit] (record) → void
 * @returns {Promise<{ok:boolean, content:string, decision:object, approved:boolean}>}
 */
export async function runToolCall({ entry, args, ctx, policy = {}, approve, audit, hooks = null }) {
  const started = Date.now();
  const mode = policy.getMode ? policy.getMode() : 'manual';
  const rules = policy.getRules ? policy.getRules() : {};
  const command = entry.cls === 'exec' ? effectiveCommand(ctx, args) : undefined;
  const subject = subjectOf({ tool: entry.name, cls: entry.cls, args, projectDir: ctx.projectDir, command, roots: ctx.roots });

  const record = (extra) => {
    try {
      audit?.({
        at: new Date().toISOString(),
        tool: entry.name,
        source: entry.source,
        cls: entry.cls,
        subject: subject == null ? null : String(subject).slice(0, 500),
        mode,
        ms: Date.now() - started,
        ...extra,
      });
    } catch {
      /* журнал не должен ломать прогон */
    }
  };

  // Ошибку аргументов показываем до вопроса пользователю.
  if (typeof entry.precheck === 'function') {
    let problem = null;
    try {
      problem = entry.precheck(ctx, args);
    } catch (err) {
      problem = `Ошибка: ${err?.message || String(err)}`;
    }
    if (problem) {
      record({ decision: 'precheck', reason: problem });
      return { ok: false, content: problem, decision: { action: 'precheck' }, approved: false };
    }
  }

  // Diff правки — в запрос разрешения и в карточку результата (CC7.3).
  let diff = null;
  if (typeof entry.preview === 'function') {
    try {
      const { before, after } = entry.preview(ctx, args) || {};
      if (before !== undefined && after !== undefined) diff = unifiedDiff(before, after);
    } catch {
      diff = null;
    }
  }

  let decision = evaluate({
    tool: entry.name,
    cls: entry.cls,
    subject,
    mode,
    rules,
    guardrails: ctx.guardrails,
    role: policy.role || 'admin',
  });
  // Защита веток (CC11.6): пуш в main/master запрещён в любом режиме, как guardrails.
  if (entry.cls === 'exec' && decision.action !== 'deny') {
    const why = pushViolation(command ?? subject, { protectedBranches: ctx.protectedBranches ?? DEFAULT_PROTECTED, branchOf: () => currentBranch(ctx.projectDir) });
    if (why) decision = { ...decision, action: 'deny', source: 'protected-branch', reason: `Запрещено: ${why}. Защищённые ветки — «Настройки» → «Защищённые ветки».` };
  }
  // В прочитанном нашлись внушённые указания (CC2.10): «Авто» больше не решает молча.
  const taint = policy.getTaint ? policy.getTaint() : null;
  if (taint && decision.action === 'allow' && decision.source === 'classifier' && entry.cls !== 'read') {
    decision = {
      ...decision,
      action: 'ask',
      source: 'injection',
      risk: 'high',
      recommended: 'deny',
      why: `в прочитанном (${taint.source}${taint.path ? ` ${taint.path}` : ''}) найдено похожее на внушённые указания — ${taint.why}: «${taint.snippet}». Проверьте, что действие нужно вам`,
    };
  }

  // PreToolUse (ADR 0035): хук не может разрешить то, что запретили guardrails,
  // правило deny или «План», но может запретить, потребовать вопрос или снять его.
  let hookNote = '';
  if (decision.action !== 'deny' && hooks?.has('PreToolUse', entry.name)) {
    const hook = await hooks.run('PreToolUse', { tool_name: entry.name, tool_input: args, tool_class: entry.cls, permission_mode: mode });
    if (hook.decision === 'deny') {
      decision = { ...decision, action: 'deny', source: 'hook', reason: `Хук PreToolUse отклонил вызов: ${hook.reason || 'без причины'}` };
    } else if (hook.decision === 'ask' && decision.action === 'allow') {
      decision = { ...decision, action: 'ask', source: 'hook', why: hook.reason || 'так требует хук PreToolUse' };
    } else if (hook.decision === 'allow' && decision.action === 'ask') {
      decision = { ...decision, action: 'allow', source: 'hook' };
    }
    if (hook.context.length) hookNote = hook.context.join('\n');
  }

  let answer = null;
  if (decision.action === 'ask') {
    if (typeof approve !== 'function') {
      answer = { allow: false, message: 'Подтверждение недоступно — действие отклонено.' };
    } else {
      answer = normalizeAnswer(
        await approve({
          tool: entry.name,
          source: entry.source,
          cls: entry.cls,
          summary: summarize({ tool: entry.name, cls: entry.cls, args, subject }),
          subject,
          args: preview(args),
          risk: decision.risk,
          why: decision.why,
          decisionSource: decision.source,
          recommended: decision.recommended,
          rule: decision.rule || null,
          suggestions: suggestRules({ tool: entry.name, cls: entry.cls, subject }),
          mode: decision.mode,
          diff,
        }),
      );
    }
  }

  const allowed = decision.action === 'allow' || (decision.action === 'ask' && answer?.allow === true);
  record({
    decision: decision.action,
    source_of_decision: decision.source,
    rule: decision.rule || null,
    risk: decision.risk,
    answer: answer ? { allow: answer.allow, remember: answer.remember || null, rules: answer.rules || [] } : null,
  });

  if (!allowed) {
    return { ok: false, content: deniedText(entry, decision, answer), decision, approved: false };
  }
  // В историю — укороченный diff: полный размер сессии не нужен.
  const shortDiff = diff ? { added: diff.added, removed: diff.removed, created: diff.created, lines: diff.lines.slice(0, 120), truncated: diff.truncated || diff.lines.length > 120 } : null;

  try {
    // Плагины старого формата сами зовут ctx.approve — вызов уже разрешён.
    // ask, progress и signal — только встроенным инструментам; плагину уходят данные (ADR 0030).
    const builtin = entry.source === 'builtin';
    const result = await entry.run(
      {
        ...ctx,
        approve: async () => true,
        ask: builtin ? ctx.ask : undefined,
        progress: builtin ? ctx.progress : undefined,
        signal: builtin ? ctx.signal : undefined,
        todos: builtin ? ctx.todos : undefined,
        beforeWrite: builtin ? ctx.beforeWrite : undefined,
        grantRules: builtin ? ctx.grantRules : undefined,
      },
      args,
    );
    // Встроенный инструмент может вернуть { content, images } — картинки для модели (CW2.5).
    const images = builtin && result && typeof result === 'object' && Array.isArray(result.images) ? result.images : null;
    let content = spillOutput(ctx, entry.name, String(images ? result.content : result));
    if (hookNote) content = `${content}\n\n[Хук PreToolUse]\n${hookNote}`;
    // PostToolUse: контекст от хука дописывается к результату; block — замечание агенту.
    if (hooks?.has('PostToolUse', entry.name)) {
      const post = await hooks.run('PostToolUse', { tool_name: entry.name, tool_input: args, tool_response: content.slice(0, 20000) });
      if (post.context.length) content = `${content}\n\n[Хук PostToolUse]\n${post.context.join('\n')}`;
      if (post.decision === 'block') content = `${content}\n\n[Хук PostToolUse: ${post.reason || 'результат не принят'}. Исправь и проверь снова.]`;
    }
    return { ok: true, content, decision, approved: true, diff: shortDiff, ...(images ? { images } : {}) };
  } catch (err) {
    return { ok: false, content: `Ошибка: ${err?.message || String(err)}`, decision, approved: true };
  }
}
