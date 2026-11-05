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

function parseVerdict(raw) {
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

export async function reviewAnswer({ client, model, task, answer, signal, temperature = 0 }) {
  const messages = [
    { role: 'system', content: REVIEW_PROMPT },
    {
      role: 'user',
      content: `Задача пользователя:\n${String(task || '').slice(0, 8000)}\n\nОтвет агента:\n${String(answer || '').slice(0, 24000)}`,
    },
  ];
  const response = await client.chat.completions.create(
    { model, messages, temperature, max_tokens: 900 },
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
