/**
 * Хост плагинов в отдельном процессе (ADR 0030, бэклог A2.4).
 *
 * main-процесс больше не импортирует код плагинов. Плагины грузятся в
 * utilityProcess; инструменты и transformMessages вызываются через сообщения
 * с таймаутом. Зависший хост убивается, упавший — пересоздаётся при следующей
 * загрузке плагинов.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { utilityProcess } from './electron-shim.js';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin-host', 'worker.mjs');

export const PLUGIN_TIMEOUTS = { load: 15_000, call: 120_000, transform: 10_000 };

/** Переменные, которые плагину не нужны и опасны: ключи, токены, пароли. */
const SECRET_ENV = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE/i;

export function pluginEnv(source = process.env) {
  const env = {};
  for (const [name, value] of Object.entries(source)) {
    if (SECRET_ENV.test(name)) continue;
    if (name.startsWith('ELECTRON_') || name === 'NODE_OPTIONS') continue;
    env[name] = value;
  }
  env.MAI_PLUGIN_HOST = '1';
  return env;
}

export class PluginHost {
  constructor({ files, cwd, timeouts = PLUGIN_TIMEOUTS } = {}) {
    this.files = files || [];
    this.cwd = cwd;
    this.timeouts = { ...PLUGIN_TIMEOUTS, ...timeouts };
    this.pending = new Map();
    this.seq = 0;
    this.child = null;
    this.dead = false;
    this.stderr = '';
    this.manifest = null;
    this.onIdle = null;
  }

  start() {
    this.child = utilityProcess.fork(WORKER, [], {
      cwd: this.cwd || undefined,
      env: pluginEnv(),
      stdio: 'pipe',
      serviceName: 'MAI plugins',
    });
    this.child.stderr?.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4000);
    });
    this.child.on('message', (message) => this.receive(message));
    this.child.on('exit', (code) => this.fail(`процесс плагинов завершился (код ${code})${this.stderr ? `: ${this.stderr.trim().slice(-500)}` : ''}`));
  }

  receive(message) {
    if (message?.type === 'loaded') {
      this.pending.get('load')?.resolve(message.plugins);
      this.pending.delete('load');
      return;
    }
    if (message?.type === 'result') {
      const slot = this.pending.get(message.id);
      if (!slot) return;
      this.pending.delete(message.id);
      clearTimeout(slot.timer);
      if (message.ok) slot.resolve(message.result);
      else slot.reject(new Error(message.error || 'ошибка плагина'));
      this.checkIdle();
    }
  }

  fail(reason) {
    this.dead = true;
    for (const slot of this.pending.values()) {
      clearTimeout(slot.timer);
      slot.reject(new Error(reason));
    }
    this.pending.clear();
    this.checkIdle();
  }

  request(type, payload, timeout) {
    if (this.dead || !this.child) return Promise.reject(new Error('процесс плагинов не запущен'));
    const id = type === 'load' ? 'load' : `r${(this.seq += 1)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        // Зависший плагин держит весь хост: убиваем процесс, следующий запуск создаст новый.
        this.kill();
        this.fail(`плагин не ответил за ${Math.round(timeout / 1000)} с`);
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.postMessage({ type, id, ...payload });
    });
  }

  async load() {
    if (!this.child) this.start();
    this.manifest = await this.request('load', { files: this.files }, this.timeouts.load);
    return this.manifest;
  }

  call(file, tool, ctx, args) {
    return this.request('call', { file, tool, ctx, args }, this.timeouts.call);
  }

  transform(file, messages) {
    return this.request('transform', { file, messages }, this.timeouts.transform);
  }

  get busy() {
    return this.pending.size > 0;
  }

  checkIdle() {
    if (!this.busy && this.onIdle) {
      const callback = this.onIdle;
      this.onIdle = null;
      callback();
    }
  }

  kill() {
    try {
      this.child?.kill();
    } catch {
      /* процесс уже завершён */
    }
    this.dead = true;
  }

  /** Останавливает хост, когда закончатся текущие вызовы. */
  retire() {
    if (this.busy) this.onIdle = () => this.kill();
    else this.kill();
  }
}

/* ---------- кэш хостов ---------- */

const hosts = new Map(); // ключ набора папок → { signature, host }

/**
 * Хост для набора файлов. Файлы не изменились — используется тот же процесс;
 * изменились — запускается новый, старый останавливается после текущих вызовов.
 */
export async function hostFor(key, files, signature, options = {}) {
  const current = hosts.get(key);
  if (current && current.signature === signature && !current.host.dead) return current.host;
  if (current) current.host.retire();
  const host = new PluginHost({ files, ...options });
  hosts.set(key, { signature, host });
  try {
    await host.load();
  } catch (err) {
    host.kill();
    hosts.delete(key);
    throw err;
  }
  return host;
}

/**
 * Останавливает хосты и ждёт выхода процессов (до `timeoutMs`). Нужно на
 * Windows: процесс хоста держит рабочую папку проекта, и пока он не вышел,
 * папку нельзя удалить или переименовать.
 */
export async function disposePluginHostsAndWait(timeoutMs = 3000) {
  const children = [...hosts.values()].map(({ host }) => host.child).filter(Boolean);
  const exited = children.map(
    (child) =>
      new Promise((resolve) => {
        child.once('exit', resolve);
        setTimeout(resolve, timeoutMs);
      }),
  );
  disposePluginHosts();
  await Promise.all(exited);
}

/** Остановить хосты после текущих вызовов — при смене папки проекта (освобождает её на Windows). */
export function retirePluginHosts() {
  for (const { host } of hosts.values()) host.retire();
  hosts.clear();
}

export function disposePluginHosts() {
  for (const { host } of hosts.values()) host.kill();
  hosts.clear();
}

export function pluginHostCount() {
  return [...hosts.values()].filter(({ host }) => !host.dead).length;
}
