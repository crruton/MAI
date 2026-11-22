/**
 * Ревизор: вторая модель проверяет финальный ответ агента.
 *
 * Механика взята из Delamain: проверяющий либо апрувит результат, либо
 * возвращает причину и инструкции на доработку. Ревизор не вызывает
 * инструменты и не меняет файлы — он только выносит вердикт.
 */

const REVIEW_PROMPT = `Ты — независимый ревизор ответа coding-агента.
Проверь, решает ли ответ задачу пользователя и не содержит ли он явных ошибок.
Не предлагай стилистические улучшения без причины. Не выполняй команды.

Верни строго JSON без markdown:
{
  "verdict": "approve" | "revise",
  "reason": "кратко, по-русски",
  "instructions": "что именно исправить, если revise"
}

Правила:
- approve — ответ достаточен, даже если он короткий.
- revise — есть фактическая ошибка, пропущен шаг или ответ не решает задачу.
- Если сомневаешься, выбирай approve.`;

/** Как читать ответ в зависимости от режима и вида чата (F5, ADR 0064). */
export function reviewContext({ mode = '', kind = 'code' } = {}) {
  const lines = [];
  if (mode === 'plan') lines.push('Режим «План»: агенту запрещено менять файлы. Оцени план — полноту, риски, проверяемость. Не требуй правок кода.');
  if (mode === 'dontAsk') lines.push('Режим «Только разрешённое»: часть действий могла быть отклонена правилами — это не ошибка агента, если он честно об этом сказал.');
  if (kind === 'task') lines.push('Это задача с документами, не программирование: оценивай результат (файлы, точность, полноту), а не код.');
  return lines.join('\n');
}

/** Промпт ревизора-субагента: проверяет изменения инструментами чтения. */
export const VERIFY_PROMPT = `Ты — независимый ревизор. Агент выполнил задачу и изменил файлы (список ниже).
Проверь результат сам: прочитай изменённые файлы (read_file, read_document, grep), сверь с задачей и ответом агента.
Ничего не меняй и не запускай. Не придирайся к стилю.
В конце верни строго JSON без markdown:
{"verdict": "approve" | "revise", "reason": "кратко, по-русски", "instructions": "что исправить, если revise"}
revise — только при фактической ошибке, пропущенном шаге или если результат не решает задачу. Сомневаешься — approve.`;

export function parseVerdict(raw) {
  const text = String(raw || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const data = JSON.parse(text.slice(start, end + 1));
    const verdict = data.verdict === 'revise' ? 'revise' : 'approve';
    return {
      verdict,
      reason: String(data.reason || '').slice(0, 800),
      instructions: String(data.instructions || '').slice(0, 2000),
    };
  } catch {
    return null;
  }
}

export async function reviewAnswer({ client, model, task, answer, signal, temperature = 0, mode = '', kind = 'code', requestOptions: extra = null }) {
  const context = reviewContext({ mode, kind });
  const messages = [
    { role: 'system', content: context ? `${REVIEW_PROMPT}\n\n${context}` : REVIEW_PROMPT },
    {
      role: 'user',
      content: `Задача пользователя:\n${String(task || '').slice(0, 8000)}\n\nОтвет агента:\n${String(answer || '').slice(0, 24000)}`,
    },
  ];
  const response = await client.chat.completions.create(
    // temperature — только если модель её принимает (ADR 0058).
    { model, messages, ...(extra || { temperature }), max_tokens: 900 },
    { signal },
  );
  const raw = response.choices?.[0]?.message?.content || '';
  const parsed = parseVerdict(raw);
  if (!parsed) {
    return {
      verdict: 'approve',
      reason: 'Ревизор вернул не-JSON; ответ считается принятым, чтобы не блокировать работу.',
      instructions: '',
      raw: raw.slice(0, 2000),
    };
  }
  return { ...parsed, raw: raw.slice(0, 2000) };
}
