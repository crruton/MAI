import path from 'node:path';

/**
 * Guardrails — предсказуемые запреты до запуска команды.
 *
 * Это не антивирус и не песочница: внешний агент (opencode, claude, …) может
 * делать что угодно от имени пользователя. Guardrails закрывают типовые
 * разрушительные команды встроенного агента, защищают секретные файлы и
 * ограничивают размер/время выполнения. Docker-песочница остаётся основным
 * способом реальной изоляции.
 */

export const DEFAULT_GUARDRAILS = {
  enabled: true,
  blockDangerous: true,
  protectSecrets: true,
  allowSecrets: false,
  maxCommandLength: 4000,
  extraDeny: [],
};

const DANGEROUS = [
  {
    re: /\brm\s+(?:-[a-zA-Z]*[rRfF][a-zA-Z]*\s+)+(?:\/|~|\$HOME|\/\*)(?:\s|$)/,
    reason: 'Удаление корня, домашней папки или всей файловой системы',
  },
  {
    re: /\b(?:rd|rmdir)\s+(?:\/[a-zA-Z]+\s+)*[a-zA-Z]:\\(?:\s|$)/i,
    reason: 'Рекурсивное удаление корня диска на Windows',
  },
  {
    re: /\bdel\s+(?:\/[a-zA-Z]+\s+)*[a-zA-Z]:\\(?:\s|$)/i,
    reason: 'Рекурсивное удаление диска на Windows',
  },
  {
    re: /\b(?:remove-item|ri|del)\b[^\n]*-recurse[^\n]*[a-zA-Z]:\\(?:\s|$)/i,
    reason: 'Рекурсивное удаление корня диска через PowerShell',
  },
  {
    re: /\b(?:format-volume|clear-disk|initialize-disk)\b/i,
    reason: 'Форматирование или очистка диска через PowerShell',
  },
  {
    re: /\bformat\s+[a-zA-Z]:/i,
    reason: 'Форматирование диска',
  },
  {
    re: /\b(?:diskpart|mkfs(?:\.\w+)?|fdisk)\b/i,
    reason: 'Работа с разделами и файловыми системами',
  },
  {
    re: /\bdd\b[^\n]*\bof=\/dev\/(?:sd|nvme|hd)/i,
    reason: 'Запись напрямую в блочное устройство',
  },
  {
    re: /\b(?:shutdown|reboot|poweroff|halt)\b/i,
    reason: 'Выключение или перезагрузка машины',
  },
  {
    re: /:\s*\(\s*\)\s*\{.*\|.*&.*\}\s*;\s*:/,
    reason: 'Fork-бомба',
  },
  {
    re: /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|powershell|pwsh|iex|invoke-expression)\b/i,
    reason: 'Запуск скачанного скрипта без проверки (pipe-to-shell)',
  },
  {
    re: /\bchmod\s+-R\s+777\s+\/(?:\s|$)/i,
    reason: 'chmod 777 на корень файловой системы',
  },
  {
    re: /\b(?:cipher)\s+\/w\s*:\s*[a-zA-Z]:/i,
    reason: 'Затирание свободного места на диске',
  },
];

const SECRET_BASENAMES = new Set([
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'credentials',
]);

const SECRET_EXTENSIONS = /\.(?:pem|key|pfx|p12|jks|keystore)$/i;
const SAFE_ENV_TEMPLATES = /\.env\.(?:example|sample|template|dist)$/i;

export function normalizeGuardrails(value) {
  return { ...DEFAULT_GUARDRAILS, ...(value || {}) };
}

/** Секретный ли файл. Шаблоны .env.example секретами не считаются. */
export function isSecretPath(target) {
  const text = String(target || '');
  if (!text) return false;
  const base = path.basename(text).toLowerCase();
  if (SAFE_ENV_TEMPLATES.test(base)) return false;
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (SECRET_BASENAMES.has(base)) return true;
  if (SECRET_EXTENSIONS.test(base)) return true;
  if (/(^|[\\/])\.ssh([\\/]|$)/i.test(text)) return true;
  if (/(^|[\\/])\.aws[\\/]credentials$/i.test(text)) return true;
  if (/(^|[\\/])\.docker[\\/]config\.json$/i.test(text)) return true;
  return false;
}

function secretReference(command) {
  // Ищем только явные пути, чтобы не блокировать слова вроде «environment».
  const re = /(?:^|[\s"'=<>|;&])((?:[A-Za-z]:)?[^\s"'<>|;&]*?(?:\.env(?:\.[\w.-]+)?|\.npmrc|\.pypirc|id_rsa|id_ed25519|\.pem|\.key|\.pfx|\.p12))(?:$|[\s"'<>|;&])/i;
  const match = re.exec(command);
  if (!match) return '';
  return isSecretPath(match[1]) ? match[1] : '';
}

/**
 * Проверяет команду перед подтверждением/запуском.
 * @returns {{allowed: boolean, reason: string, rule: string}}
 */
export function checkCommand(command, { guardrails } = {}) {
  const config = normalizeGuardrails(guardrails);
  const text = String(command ?? '').trim();
  if (!text) return { allowed: false, reason: 'Пустая команда', rule: 'empty' };
  if (!config.enabled) return { allowed: true, reason: '', rule: '' };

  if (text.length > Number(config.maxCommandLength || DEFAULT_GUARDRAILS.maxCommandLength)) {
    return {
      allowed: false,
      reason: `Команда длиннее ${config.maxCommandLength} символов`,
      rule: 'length',
    };
  }

  if (config.blockDangerous) {
    for (const rule of DANGEROUS) {
      if (rule.re.test(text)) {
        return { allowed: false, reason: rule.reason, rule: 'dangerous' };
      }
    }
    for (const custom of config.extraDeny || []) {
      const pattern = String(custom || '').trim();
      if (!pattern) continue;
      try {
        if (new RegExp(pattern, 'i').test(text)) {
          return { allowed: false, reason: `Совпало с пользовательским запретом: ${pattern}`, rule: 'custom' };
        }
      } catch {
        /* некорректное регулярное выражение пропускаем */
      }
    }
  }

  if (config.protectSecrets && !config.allowSecrets) {
    const secret = secretReference(text);
    if (secret) {
      return {
        allowed: false,
        reason: `Команда обращается к секретному файлу «${secret}». Включите «Разрешить доступ к секретам» в настройках, если это осознанно.`,
        rule: 'secret',
      };
    }
  }

  return { allowed: true, reason: '', rule: '' };
}

/** Маскирует типовые токены перед записью в журнал ошибок/телеметрию. */
export function redactSecrets(value) {
  let text = String(value ?? '');
  text = text.replace(/\b(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]{8,}/g, '$1***');
  text = text.replace(/\b(gh[pousr]_[A-Za-z0-9]{4})[A-Za-z0-9]{12,}/g, '$1***');
  text = text.replace(/\b(AKIA[0-9A-Z]{4})[0-9A-Z]{12,}/g, '$1***');
  text = text.replace(/\b(Bearer\s+[A-Za-z0-9._-]{6})[A-Za-z0-9._-]{10,}/gi, '$1***');
  text = text.replace(/("(?:api[_-]?key|token|password|secret)"\s*:\s*")([^"]{4})[^"]*(")/gi, '$1$2***$3');
  return text;
}
