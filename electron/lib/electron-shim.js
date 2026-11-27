/**
 * Electron или заглушки для запуска без окна (E3.A5, ADR 0122).
 *
 * В процессе Electron — настоящий модуль. В Node (CI, MAI Ship steward) — заглушки: папка данных
 * из `MAI_DATA_DIR` или `~/.mai-code-headless`, шифрования ключей нет (ключи — из переменных
 * окружения), плагины в отдельном процессе недоступны.
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const IS_ELECTRON = Boolean(process.versions.electron);

let real = null;
if (IS_ELECTRON) {
  const mod = await import('electron');
  real = mod.app ? mod : mod.default;
}

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const headlessApp = {
  getPath: () => process.env.MAI_DATA_DIR || path.join(os.homedir(), '.mai-code-headless'),
  getAppPath: () => APP_ROOT,
  isPackaged: false,
};

const headlessSafeStorage = {
  isEncryptionAvailable: () => false,
  getSelectedStorageBackend: () => 'basic_text',
  encryptString: () => {
    throw new Error('Шифрование ключей без Electron недоступно: задайте ключ переменной окружения');
  },
  decryptString: () => {
    throw new Error('Расшифровка ключей без Electron недоступна');
  },
};

const headlessUtilityProcess = {
  fork: () => {
    throw new Error('Плагины в отдельном процессе без Electron недоступны');
  },
};

export const app = real?.app || headlessApp;
export const safeStorage = real?.safeStorage || headlessSafeStorage;
export const utilityProcess = real?.utilityProcess || headlessUtilityProcess;
