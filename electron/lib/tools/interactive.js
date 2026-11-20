/**
 * Диалоговые инструменты (бэклог CC1.7, CC1.8, ADR 0031).
 *
 * - ask_user — вопрос пользователю с вариантами; рекомендованный вариант
 *   подсвечивается в интерфейсе и выбирается по Enter.
 * - exit_plan — в режиме «План» агент сдаёт план карточкой с альтернативами;
 *   пользователь выбирает режим выполнения и альтернативу или просит доработать.
 *
 * Оба инструмента ничего не меняют сами (класс `read` в PolicyEngine). Ответ
 * пользователя приходит через ctx.ask и возвращается агенту результатом.
 */

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 4;

function clean(value, limit = 400) {
  return String(value ?? '').trim().slice(0, limit);
}

/** Приводит аргументы ask_user к проверенному виду или бросает понятную ошибку. */
export function normalizeQuestions(args) {
  const list = Array.isArray(args?.questions) ? args.questions : [];
  if (!list.length) throw new Error('Нужен хотя бы один вопрос в questions');
  if (list.length > MAX_QUESTIONS) throw new Error(`Не больше ${MAX_QUESTIONS} вопросов за раз`);
  return list.map((q, index) => {
    const options = (Array.isArray(q?.options) ? q.options : [])
      .map((o) => ({ label: clean(o?.label, 80), description: clean(o?.description, 300), recommended: o?.recommended === true }))
      .filter((o) => o.label);
    if (options.length < 2 || options.length > MAX_OPTIONS) {
      throw new Error(`Вопрос ${index + 1}: нужно от 2 до ${MAX_OPTIONS} вариантов`);
    }
    // Рекомендованный — не больше одного и всегда первым: так его видно и выбирают по Enter.
    const recommendedIndex = options.findIndex((o) => o.recommended);
    options.forEach((o, i) => {
      o.recommended = i === recommendedIndex;
    });
    if (recommendedIndex > 0) options.unshift(...options.splice(recommendedIndex, 1));
    return {
      question: clean(q?.question, 500) || `Вопрос ${index + 1}`,
      header: clean(q?.header, 24),
      multiSelect: q?.multiSelect === true,
      options,
    };
  });
}

export function normalizePlan(args) {
  const plan = clean(args?.plan, 20_000);
  if (!plan) throw new Error('Нужен текст плана в plan');
  const alternatives = (Array.isArray(args?.alternatives) ? args.alternatives : [])
    .slice(0, 4)
    .map((a) => ({
      title: clean(a?.title, 120),
      summary: clean(a?.summary, 600),
      pros: clean(a?.pros, 400),
      cons: clean(a?.cons, 400),
      risk: ['low', 'medium', 'high'].includes(a?.risk) ? a.risk : 'medium',
    }))
    .filter((a) => a.title);
  let recommended = Number.isInteger(args?.recommended) ? args.recommended : alternatives.findIndex((a) => a.title === args?.recommended);
  if (!(recommended >= 0 && recommended < alternatives.length)) recommended = alternatives.length ? 0 : -1;
  return { plan, alternatives, recommended };
}

function formatAnswers(questions, answer) {
  const lines = questions.map((q, i) => {
    const picked = answer?.answers?.[i];
    const text = Array.isArray(picked) ? picked.join(', ') : picked;
    return `- ${q.question} → ${text || 'без ответа'}`;
  });
  return `Пользователь ответил:\n${lines.join('\n')}`;
}

export const interactiveTools = [
  {
    schema: {
      type: 'function',
      function: {
        name: 'ask_user',
        description:
          'Задать пользователю 1–4 вопроса с вариантами, когда решение за ним и его нельзя вывести из кода или контекста. ' +
          'Отметь один вариант recommended: true — он будет показан первым и подсвечен. Вариант «Другое» добавляется сам.',
        parameters: {
          type: 'object',
          properties: {
            questions: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_QUESTIONS,
              items: {
                type: 'object',
                properties: {
                  question: { type: 'string', description: 'Полный вопрос, понятный без контекста' },
                  header: { type: 'string', description: 'Короткая метка до 24 символов' },
                  multiSelect: { type: 'boolean' },
                  options: {
                    type: 'array',
                    minItems: 2,
                    maxItems: MAX_OPTIONS,
                    items: {
                      type: 'object',
                      properties: {
                        label: { type: 'string' },
                        description: { type: 'string', description: 'Последствия выбора' },
                        recommended: { type: 'boolean' },
                      },
                      required: ['label'],
                    },
                  },
                },
                required: ['question', 'options'],
              },
            },
          },
          required: ['questions'],
        },
      },
    },
    precheck(_ctx, args) {
      try {
        normalizeQuestions(args);
        return null;
      } catch (err) {
        return `Ошибка: ${err.message}`;
      }
    },
    async run(ctx, args) {
      const questions = normalizeQuestions(args);
      if (typeof ctx.ask !== 'function') return 'Пользователь недоступен: продолжай по рекомендованным вариантам и отметь это в ответе.';
      const answer = await ctx.ask({ kind: 'questions', questions });
      if (!answer || answer.cancelled) return 'Пользователь не ответил. Не повторяй вопрос: продолжай по рекомендованным вариантам и отметь это в ответе.';
      return formatAnswers(questions, answer);
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'exit_plan',
        description:
          'Только в режиме «План»: сдать готовый план пользователю. Пользователь выберет альтернативу и режим выполнения ' +
          'или попросит доработать. Не проси переключить режим текстом — вызывай этот инструмент.',
        parameters: {
          type: 'object',
          properties: {
            plan: { type: 'string', description: 'План в Markdown: цель, шаги, файлы, проверка' },
            alternatives: {
              type: 'array',
              maxItems: 4,
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  summary: { type: 'string' },
                  pros: { type: 'string' },
                  cons: { type: 'string' },
                  risk: { type: 'string', enum: ['low', 'medium', 'high'] },
                },
                required: ['title'],
              },
            },
            recommended: { type: 'integer', description: 'Номер рекомендованной альтернативы с нуля' },
          },
          required: ['plan'],
        },
      },
    },
    precheck(_ctx, args) {
      try {
        normalizePlan(args);
        return null;
      } catch (err) {
        return `Ошибка: ${err.message}`;
      }
    },
    async run(ctx, args) {
      const plan = normalizePlan(args);
      if (typeof ctx.ask !== 'function') return 'Пользователь недоступен: план не одобрен, изменения не выполняй.';
      const answer = await ctx.ask({ kind: 'plan', ...plan });
      if (!answer || answer.cancelled) return 'Пользователь не ответил: план не одобрен, изменения не выполняй.';
      if (answer.action === 'revise') {
        return `Пользователь просит доработать план, режим остаётся «План». Замечания: ${clean(answer.feedback, 2000) || 'не указаны'}`;
      }
      const chosen = plan.alternatives[answer.alternative] || plan.alternatives[plan.recommended];
      const modeText = { manual: 'Вручную', acceptEdits: 'Принимать правки', bypass: 'Без вопросов' }[answer.mode] || answer.mode;
      return [
        `План одобрен. Режим переключён на «${modeText}».`,
        chosen ? `Выбранная альтернатива: ${chosen.title}.` : '',
        answer.feedback ? `Замечания пользователя: ${clean(answer.feedback, 2000)}` : '',
        'Выполняй план по шагам, проверяй результат после изменений.',
      ]
        .filter(Boolean)
        .join('\n');
    },
  },
];
