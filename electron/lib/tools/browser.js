import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPaymentAction } from '../browser-agent.js';

/**
 * Инструменты браузера агента (CW4.1, CW4.2, ADR 0069). Сам браузер —
 * `ctx.browser` (createAgentBrowser из main); без него — понятный отказ.
 * Разрешения — по домену текущей страницы: правило `browser_*(example.com)`.
 */
const NO_BROWSER = 'Браузер агента доступен только в приложении MAI.';

function need(ctx) {
  if (!ctx.browser) throw new Error(NO_BROWSER);
  return ctx.browser;
}

const tool = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});

export const browserTools = [
  {
    schema: tool(
      'browser_open',
      'Открыть страницу во встроенном браузере агента (пользователь видит окно). Возвращает текст страницы и пронумерованные элементы [N] — по номеру нажимай browser_click и вводи browser_type. ' +
        'Для простого чтения статьи быстрее web_fetch; браузер — когда нужно действовать на сайте (поиск, фильтры, формы, страницы после входа).',
      { url: { type: 'string', description: 'Адрес http(s)' } },
      ['url'],
    ),
    async run(ctx, args) {
      return need(ctx).open(args.url);
    },
  },
  {
    schema: tool('browser_read', 'Текущая страница браузера агента заново: текст и элементы [N] (после прокрутки, ожидания, действий пользователя).'),
    async run(ctx) {
      return need(ctx).read();
    },
  },
  {
    schema: tool('browser_click', 'Нажать элемент [N] текущей страницы (ссылку, кнопку, флажок). Возвращает новый снимок. Оплату и покупки подтверждает пользователь.', { ref: { type: 'number' } }, ['ref']),
    async assess(ctx, args) {
      if (!ctx.browser) return null;
      try {
        return isPaymentAction(await ctx.browser.element(args.ref));
      } catch {
        return null;
      }
    },
    async run(ctx, args) {
      return need(ctx).click(args.ref);
    },
  },
  {
    schema: tool(
      'browser_type',
      'Ввести текст в поле [N] (или выбрать вариант списка). submit: true — отправить форму после ввода. Пароли, коды и данные карт агент не вводит — их вводит пользователь в окне браузера.',
      { ref: { type: 'number' }, text: { type: 'string' }, submit: { type: 'boolean' } },
      ['ref', 'text'],
    ),
    async assess(ctx, args) {
      if (!ctx.browser || !args.submit) return null;
      try {
        const info = await ctx.browser.element(args.ref);
        return info.formHasSensitive ? 'отправка формы с паролем или данными карты' : null;
      } catch {
        return null;
      }
    },
    async run(ctx, args) {
      const out = await need(ctx).type(args.ref, args.text ?? '', { submit: args.submit === true });
      if (out.refused) {
        return `Поле [${args.ref}] — ${out.refused}. Такие данные агент не вводит. Окно браузера показано пользователю: попроси его ввести самому (ask_user) и после ответа продолжи — browser_read.`;
      }
      return out.snapshot;
    },
  },
  {
    schema: tool('browser_screenshot', 'Снимок видимой части страницы браузера агента — картинкой (нужна модель со зрением). Для проверки вёрстки и того, что видит пользователь.'),
    precheck(ctx) {
      if (typeof ctx.vision === 'function' && !ctx.vision()) return 'Текущая модель не принимает изображения — читай страницу browser_read.';
      return null;
    },
    async run(ctx) {
      const png = await need(ctx).screenshot();
      const dir = ctx.previewDir || path.join(os.tmpdir(), 'mai-previews');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `browser-${Date.now()}.png`);
      fs.writeFileSync(file, png);
      return { content: `Снимок ${ctx.browser.url()} — показан тебе следующим сообщением.`, images: [file] };
    },
  },
];
