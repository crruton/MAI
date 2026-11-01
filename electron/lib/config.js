import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

const DEFAULTS = {
  baseURL: 'https://api-ai.mai.ru/v1',
  apiKey: '',
  model: 'deepseek-v4.1-flash',
  temperature: 0.3,
  maxIterations: 30,
  autoApproveShell: false,
  allowOutsideProject: false,
  projectDir: '',
  theme: 'dark',
};

function dataDir() {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function settingsPath() {
  return path.join(dataDir(), 'settings.json');
}

function readKeyFromDevFile() {
  const candidates = [
    'C:/Users/User/Desktop/dev/mai-api-key.txt',
    path.join(process.env.USERPROFILE || '', 'Desktop', 'dev', 'mai-api-key.txt'),
  ];
  for (const file of candidates) {
    try {
      const value = fs.readFileSync(file, 'utf8').trim();
      if (value) return value;
    } catch {
      /* нет файла — не страшно */
    }
  }
  return '';
}

export function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    saved = {};
  }
  const settings = { ...DEFAULTS, ...saved };
  if (!settings.apiKey) settings.apiKey = readKeyFromDevFile();
  if (!settings.projectDir) {
    const desktop = path.join(process.env.USERPROFILE || '', 'Desktop');
    settings.projectDir = fs.existsSync(desktop) ? desktop : process.env.USERPROFILE || '';
  }
  return settings;
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export function publicSettings() {
  const s = loadSettings();
  return { ...s, apiKeySet: Boolean(s.apiKey), apiKey: s.apiKey ? '***' : '' };
}

export { dataDir };
