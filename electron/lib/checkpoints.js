/**
 * Чекпоинты правок и откат (бэклог CC6.1, ADR 0033).
 *
 * Перед первой правкой файла в ходе пользователя сохраняется его исходное
 * содержимое (или отметка «файла не было»). Ход — индекс сообщения
 * пользователя в истории сессии. Откат к ходу N возвращает файлы к состоянию
 * до хода N, отменяя все правки ходов N, N+1, …
 *
 * Хранилище: <данные>/checkpoints/blobs/<sha256> и
 * <данные>/checkpoints/<sessionId>.json. Правки через run_shell не
 * отслеживаются: что меняет команда, заранее неизвестно.
 *
 * Модуль не зависит от Electron.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

function root(dataDir) {
  return path.join(dataDir, 'checkpoints');
}

function indexFile(dataDir, sessionId) {
  return path.join(root(dataDir), `${String(sessionId).replace(/[^\w.-]/g, '_')}.json`);
}

function readIndex(dataDir, sessionId) {
  try {
    const data = JSON.parse(fs.readFileSync(indexFile(dataDir, sessionId), 'utf8'));
    return Array.isArray(data.turns) ? data : { turns: [] };
  } catch {
    return { turns: [] };
  }
}

function writeIndex(dataDir, sessionId, data) {
  const file = indexFile(dataDir, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

function putBlob(dataDir, buffer) {
  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  const file = path.join(root(dataDir), 'blobs', sha);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buffer);
  }
  return sha;
}

function getBlob(dataDir, sha) {
  return fs.readFileSync(path.join(root(dataDir), 'blobs', sha));
}

/**
 * Регистратор для одного хода. `record(file)` вызывается перед записью;
 * повторные вызовы для того же файла в этом ходе ничего не делают.
 */
export function createRecorder({ dataDir, sessionId, projectDir }) {
  const seen = new Set();
  return {
    /** @param absPath файл перед записью @param turn индекс сообщения пользователя, к которому относится правка */
    record(absPath, turn) {
      const full = path.resolve(absPath);
      if (!Number.isInteger(turn) || turn < 0) return;
      if (seen.has(`${turn}|${full}`)) return;
      seen.add(`${turn}|${full}`);
      const data = readIndex(dataDir, sessionId);
      let entry = data.turns.find((t) => t.turn === turn);
      if (!entry) {
        entry = { turn, at: new Date().toISOString(), projectDir, files: {} };
        data.turns.push(entry);
        data.turns.sort((a, b) => a.turn - b.turn);
      }
      if (Object.hasOwn(entry.files, full)) return;
      let state;
      try {
        const stat = fs.statSync(full);
        state = stat.size > MAX_SNAPSHOT_BYTES ? { skipped: 'больше 5 МБ' } : { sha: putBlob(dataDir, fs.readFileSync(full)), size: stat.size };
      } catch {
        state = { absent: true }; // файла не было — откат его удалит
      }
      entry.files[full] = state;
      writeIndex(dataDir, sessionId, data);
    },
  };
}

/**
 * Что вернёт откат к ходу `turn`: для каждого файла — самое раннее состояние
 * среди ходов >= turn.
 */
export function rewindPlan(dataDir, sessionId, turn) {
  const plan = new Map();
  for (const entry of readIndex(dataDir, sessionId).turns) {
    if (entry.turn < turn) continue;
    for (const [file, state] of Object.entries(entry.files)) {
      if (!plan.has(file)) plan.set(file, { file, ...state, fromTurn: entry.turn });
    }
  }
  return [...plan.values()].map((item) => {
    let action = 'restore';
    if (item.absent) action = 'delete';
    if (item.skipped) action = 'skip';
    let changedSince = true;
    try {
      if (item.sha) changedSince = crypto.createHash('sha256').update(fs.readFileSync(item.file)).digest('hex') !== item.sha;
      else if (item.absent) changedSince = fs.existsSync(item.file);
    } catch {
      changedSince = !item.absent;
    }
    return { file: item.file, action, changed: changedSince, reason: item.skipped || '' };
  });
}

/** Возвращает файлы к состоянию до хода `turn` и забывает чекпоинты этих ходов. */
export function rewindFiles(dataDir, sessionId, turn) {
  const plan = rewindPlan(dataDir, sessionId, turn);
  const data = readIndex(dataDir, sessionId);
  const states = new Map();
  for (const entry of data.turns) {
    if (entry.turn < turn) continue;
    for (const [file, state] of Object.entries(entry.files)) if (!states.has(file)) states.set(file, state);
  }
  const done = [];
  const failed = [];
  for (const item of plan) {
    const state = states.get(item.file);
    try {
      if (state.skipped) {
        failed.push({ file: item.file, error: state.skipped });
        continue;
      }
      if (state.absent) {
        fs.rmSync(item.file, { force: true });
      } else {
        fs.mkdirSync(path.dirname(item.file), { recursive: true });
        fs.writeFileSync(item.file, getBlob(dataDir, state.sha));
      }
      done.push(item.file);
    } catch (err) {
      failed.push({ file: item.file, error: err?.message || String(err) });
    }
  }
  data.turns = data.turns.filter((entry) => entry.turn < turn);
  writeIndex(dataDir, sessionId, data);
  return { restored: done, failed };
}

/** Ходы с правками — для отметки в ленте. */
export function checkpointTurns(dataDir, sessionId) {
  return readIndex(dataDir, sessionId).turns.map((t) => ({ turn: t.turn, files: Object.keys(t.files).length, at: t.at }));
}

export function removeCheckpoints(dataDir, sessionId) {
  fs.rmSync(indexFile(dataDir, sessionId), { force: true });
}
