/**
 * Журнал решений PolicyEngine (ADR 0027).
 *
 * Одна строка JSON на решение: инструмент, класс, предмет, режим, правило,
 * ответ пользователя. Файл ротируется по размеру. Секреты маскируются
 * redactSecrets до записи. Модуль не зависит от Electron: папку передают явно.
 */
import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets } from './guardrails.js';

const MAX_BYTES = 5 * 1024 * 1024;

export function auditFile(dir) {
  return path.join(dir, 'audit.jsonl');
}

export function createAuditLog(dir, { maxBytes = MAX_BYTES } = {}) {
  const file = auditFile(dir);
  return (record) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size > maxBytes) {
        fs.renameSync(file, `${file}.1`);
      }
      const line = redactSecrets(JSON.stringify(record));
      fs.appendFileSync(file, `${line}\n`, 'utf8');
    } catch {
      /* журнал не должен ломать прогон */
    }
  };
}

export function readAudit(dir, { limit = 200 } = {}) {
  try {
    const lines = fs.readFileSync(auditFile(dir), 'utf8').trim().split('\n').filter(Boolean);
    return lines
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}
