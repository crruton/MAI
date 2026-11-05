import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { slugify } from './workspace.js';

/**
 * Docker-песочница проекта.
 *
 * Отличия от песочницы-папки:
 * - процессы изолированы контейнером;
 * - сеть ограничена, порты публикуются только явно;
 * - корневая ФС read-only, запись — только в /workspace и /tmp;
 * - сброшены capabilities и включён no-new-privileges.
 *
 * Ограничение: папка проекта монтируется, поэтому файлы проекта доступны
 * контейнеру. Для полной изоляции файлов нужно копировать проект внутрь,
 * а не монтировать; это отдельный режим и здесь не реализован.
 */

const LABEL = 'mai-code.sandbox=1';
const PROJECT_LABEL = 'mai-code.project';

function docker(args, { timeout = 30_000, input } = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout,
    input,
    windowsHide: true,
  });
  if (result.error) throw new Error(result.error.message);
  return result;
}

export function dockerStatus() {
  try {
    const result = docker(['--version'], { timeout: 10_000 });
    if (result.status !== 0) {
      return { available: false, version: '', error: (result.stderr || '').trim() };
    }
    const info = docker(['info', '--format', '{{.ServerVersion}}'], { timeout: 15_000 });
    return {
      available: info.status === 0,
      version: (result.stdout || '').trim().replace(/^Docker version /, ''),
      server: (info.stdout || '').trim(),
      error: info.status === 0 ? '' : (info.stderr || '').trim(),
    };
  } catch (err) {
    return { available: false, version: '', error: err.message };
  }
}

function inspect(ids) {
  if (!ids.length) return [];
  const result = docker(['inspect', ...ids], { timeout: 30_000 });
  if (result.status !== 0) return [];
  let data = [];
  try {
    data = JSON.parse(result.stdout || '[]');
  } catch {
    return [];
  }
  return data.map((item) => {
    const labels = item.Config?.Labels || {};
    const ports = item.NetworkSettings?.Ports || {};
    const published = [];
    for (const [containerPort, bindings] of Object.entries(ports)) {
      for (const binding of bindings || []) {
        published.push(`${binding.HostIp || '0.0.0.0'}:${binding.HostPort}→${containerPort}`);
      }
    }
    return {
      id: item.Id,
      shortId: String(item.Id || '').slice(0, 12),
      name: String(item.Name || '').replace(/^\//, ''),
      image: item.Config?.Image || '',
      project: labels[PROJECT_LABEL] || '',
      state: item.State?.Status || 'unknown',
      running: Boolean(item.State?.Running),
      startedAt: item.State?.StartedAt || '',
      ports: published,
    };
  });
}

export function listContainers() {
  try {
    const result = docker(['ps', '-aq', '--filter', `label=${LABEL}`], { timeout: 20_000 });
    if (result.status !== 0) {
      return { ok: false, error: (result.stderr || '').trim(), containers: [] };
    }
    const ids = (result.stdout || '').split(/\s+/).filter(Boolean);
    return { ok: true, containers: inspect(ids) };
  } catch (err) {
    return { ok: false, error: err.message, containers: [] };
  }
}

function parsePorts(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  const ports = [];
  for (const part of text.split(/[,\s]+/).filter(Boolean)) {
    const match = /^(?:(?<host>[0-9.]+):)?(?<hostPort>\d{1,5}):(?<containerPort>\d{1,5})(?:\/(?<proto>tcp|udp))?$/.exec(part);
    if (!match?.groups) {
      throw new Error(`Порт «${part}»: ожидается hostPort:containerPort или 127.0.0.1:hostPort:containerPort`);
    }
    const host = match.groups.host || '127.0.0.1';
    const proto = match.groups.proto || 'tcp';
    ports.push(`${host}:${match.groups.hostPort}:${match.groups.containerPort}/${proto}`);
  }
  return ports;
}

function containerName(projectDir, explicit) {
  if (explicit) return slugify(explicit).slice(0, 48);
  const base = path.basename(path.resolve(projectDir)) || 'project';
  return `mai-code-${slugify(base)}`.slice(0, 60);
}

export function startContainer({
  projectDir,
  image = 'node:22-alpine',
  ports = '',
  network = 'bridge',
  memory = '2g',
  cpus = '2',
  command = '',
  name = '',
  user = '',
} = {}) {
  const dir = path.resolve(String(projectDir || ''));
  if (!projectDir || !fs.existsSync(dir)) throw new Error('Папка проекта не найдена');
  if (!fs.statSync(dir).isDirectory()) throw new Error('Путь проекта не является папкой');
  if (!/^[\w./:@-]+$/.test(String(image))) throw new Error('Недопустимое имя образа');

  const existing = listContainers();
  const targetName = containerName(dir, name);
  if (existing.ok) {
    const same = existing.containers.find((c) => c.name === targetName);
    if (same?.running) throw new Error(`Контейнер ${targetName} уже запущен`);
    if (same) docker(['rm', '-f', targetName], { timeout: 30_000 });
  }

  const published = parsePorts(ports);
  const args = [
    'run',
    '-d',
    '--name',
    targetName,
    '--label',
    LABEL,
    '--label',
    `${PROJECT_LABEL}=${dir}`,
    '--workdir',
    '/workspace',
    '--volume',
    `${dir}:/workspace`,
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=128m',
    '--security-opt',
    'no-new-privileges',
    '--cap-drop',
    'ALL',
    '--pids-limit',
    '256',
    '--memory',
    memory,
    '--cpus',
    cpus,
    '--network',
    network === 'none' ? 'none' : 'bridge',
  ];
  if (user) args.push('--user', String(user));
  for (const port of published) args.push('--publish', port);
  args.push(image);
  if (command) args.push('sh', '-lc', command);
  else args.push('sh', '-lc', 'while true; do sleep 3600; done');

  const result = docker(args, { timeout: 120_000 });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || '').trim() || 'docker run завершился с ошибкой');
  }
  const id = (result.stdout || '').trim();
  return {
    ok: true,
    id,
    name: targetName,
    image,
    ports: published,
    network,
    note: 'Папка проекта смонтирована в /workspace. Порты опубликованы на 127.0.0.1 по умолчанию.',
  };
}

export function stopContainer(nameOrId, { remove = true } = {}) {
  const target = String(nameOrId || '').trim();
  if (!target) throw new Error('Нужно имя или id контейнера');
  const stop = docker(['stop', target], { timeout: 60_000 });
  if (stop.status !== 0) {
    throw new Error((stop.stderr || stop.stdout || '').trim() || 'docker stop завершился с ошибкой');
  }
  if (remove) {
    const rm = docker(['rm', target], { timeout: 30_000 });
    if (rm.status !== 0) {
      throw new Error((rm.stderr || rm.stdout || '').trim() || 'docker rm завершился с ошибкой');
    }
  }
  return { ok: true };
}

export function containerLogs(nameOrId, lines = 200) {
  const target = String(nameOrId || '').trim();
  if (!target) throw new Error('Нужно имя или id контейнера');
  const result = docker(['logs', '--tail', String(Math.max(1, Math.min(2000, lines))), target], {
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || '').trim() || 'docker logs завершился с ошибкой');
  }
  return { ok: true, output: `${result.stdout || ''}${result.stderr || ''}` };
}

export function execInContainer(nameOrId, command) {
  const target = String(nameOrId || '').trim();
  const cmd = String(command || '').trim();
  if (!target) throw new Error('Нужно имя или id контейнера');
  if (!cmd) throw new Error('Нужна команда');
  const result = docker(['exec', target, 'sh', '-lc', cmd], { timeout: 120_000 });
  return {
    ok: result.status === 0,
    code: result.status,
    output: `${result.stdout || ''}${result.stderr || ''}`.slice(-40_000),
  };
}
