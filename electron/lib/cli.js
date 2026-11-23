/**
 * Безголовый режим (CC12.1, CC12.2, ADR 0077): `mai -p "задача"` без окна —
 * для скриптов и CI. Здесь только разбор флагов и форматирование вывода;
 * сам прогон — в main (те же runAgent, политика, хуки, сессии).
 *
 *   mai -p "задача" [--mode dontAsk|acceptEdits|plan|bypass|manual]
 *       [--output text|json|stream-json] [--model провайдер/модель]
 *       [--kind code|task] [--cwd папка] [--max-turns N] [--allow "правило"]…
 *
 * Модуль не зависит от Electron.
 */

const MODES = ['manual', 'acceptEdits', 'plan', 'dontAsk', 'bypass'];
const OUTPUTS = ['text', 'json', 'stream-json'];

export const CLI_HELP = `MAI Code — запуск агента без окна.

  mai -p "задача" [флаги]
  echo "задача" | mai -p -

Флаги:
  -p, --print <текст>   задача (\`-\` — прочитать из stdin)
  --mode <режим>        dontAsk (по умолчанию: только по правилам allow),
                        acceptEdits, plan, bypass (только доверенная папка), manual
  --output <формат>     text (ответ), json (итог одним объектом),
                        stream-json (события по строке JSON + итог)
  --model <ключ>        провайдер/модель, по умолчанию — активная в приложении
  --kind code|task      вид чата: код или задача
  --cwd <папка>         папка проекта, по умолчанию — текущая
  --max-turns <N>       предел шагов агента
  --allow <правило>     разрешить на этот запуск, например "run_shell(npm test*)"
  -h, --help            эта справка

Спросить в CLI некого: всё, что не разрешено режимом и правилами, отклоняется.
Коды выхода: 0 — готово, 1 — ошибка прогона, 2 — неверные флаги.`;

/** Это запуск CLI? Флаг `--cli`, `-p`/`--print` или `--help` вместе с `--cli`. */
export function isCliInvocation(argv = []) {
  return argv.includes('--cli') || argv.includes('-p') || argv.includes('--print') || argv.some((a) => a.startsWith('--print='));
}

/**
 * Разбор флагов. Неизвестный флаг или неверное значение — `error`.
 * @returns {{ help?: boolean, error?: string, prompt?: string, fromStdin?: boolean, mode, output, model, kind, cwd, maxTurns, allow }}
 */
export function parseCliArgs(argv = [], { cwd = process.cwd() } = {}) {
  const opts = { mode: 'dontAsk', output: 'text', model: '', kind: 'code', cwd, maxTurns: 0, allow: [], prompt: '', fromStdin: false };
  const args = [...argv];
  const take = (i, name) => {
    const value = args[i + 1];
    if (value === undefined || (value.startsWith('--') && value !== '-')) throw new Error(`${name}: нужно значение`);
    return value;
  };
  try {
    for (let i = 0; i < args.length; i += 1) {
      let a = args[i];
      let inline = null;
      const eq = /^(--[a-z-]+)=(.*)$/s.exec(a);
      if (eq) {
        a = eq[1];
        inline = eq[2];
      }
      const value = (name) => {
        if (inline !== null) return inline;
        const v = take(i, name);
        i += 1;
        return v;
      };
      switch (a) {
        case '--cli':
          break;
        case '-h':
        case '--help':
          return { ...opts, help: true };
        case '-p':
        case '--print': {
          const v = value(a);
          if (v === '-') opts.fromStdin = true;
          else opts.prompt = v;
          break;
        }
        case '--mode': {
          const v = value(a);
          if (!MODES.includes(v)) throw new Error(`--mode: ${v} — нужно одно из ${MODES.join(', ')}`);
          opts.mode = v;
          break;
        }
        case '--output':
        case '--output-format': {
          const v = value(a);
          if (!OUTPUTS.includes(v)) throw new Error(`--output: ${v} — нужно text, json или stream-json`);
          opts.output = v;
          break;
        }
        case '--model':
          opts.model = value(a);
          break;
        case '--kind': {
          const v = value(a);
          if (!['code', 'task'].includes(v)) throw new Error('--kind: code или task');
          opts.kind = v;
          break;
        }
        case '--cwd':
          opts.cwd = value(a);
          break;
        case '--max-turns': {
          const n = Number(value(a));
          if (!Number.isInteger(n) || n < 1 || n > 200) throw new Error('--max-turns: целое от 1 до 200');
          opts.maxTurns = n;
          break;
        }
        case '--allow':
          opts.allow.push(value(a));
          break;
        default:
          // Флаги Chromium/Electron (--no-sandbox, --user-data-dir=…) и путь приложения пропускаем.
          if (/^--(no-sandbox|disable-gpu|user-data-dir|ozone-platform|headless|enable-logging|inspect)/.test(a) || !a.startsWith('-')) break;
          throw new Error(`неизвестный флаг ${a}`);
      }
    }
  } catch (err) {
    return { ...opts, error: err.message };
  }
  if (!opts.prompt && !opts.fromStdin) return { ...opts, error: 'нет задачи: -p "текст" или -p - и текст в stdin' };
  return opts;
}

/** Событие агента → строка stream-json (без больших полей, как видит UI). */
export function streamLine(event) {
  const { type, ...rest } = event || {};
  return JSON.stringify({ type, ...rest });
}

/** Итог прогона для --output json и последней строки stream-json. */
export function resultObject({ ok, answer = '', error = '', sessionId = '', model = '', mode = '', usage = null, durationMs = 0, denied = [] }) {
  return {
    type: 'result',
    ok,
    result: ok ? answer : '',
    ...(error ? { error } : {}),
    session_id: sessionId,
    model,
    mode,
    duration_ms: durationMs,
    ...(usage ? { usage } : {}),
    ...(denied.length ? { denied } : {}),
  };
}
