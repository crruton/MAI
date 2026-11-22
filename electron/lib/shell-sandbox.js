/**
 * Песочница для команд агента (бэклог CC2.8, ADR 0040).
 *
 * В режиме `docker` инструмент run_shell выполняет команду в одноразовом
 * контейнере: проект смонтирован в /workspace, корневая ФС только на чтение,
 * сброшены capabilities, без сети (по умолчанию), с лимитами памяти, CPU и
 * числа процессов. На хосте выполняются только команды из `hostCommands`
 * (маски как в правилах, например `git *`).
 *
 * Если Docker недоступен, команда не выполняется на хосте молча — агент
 * получает ошибку с объяснением.
 *
 * Модуль не зависит от Electron.
 */
import path from 'node:path';
import { splitCommand } from './policy.js';

export const DEFAULT_SHELL_SANDBOX = {
  mode: 'off', // off | docker | tasks (Docker только в чатах «Задача», CW1.3)
  image: 'node:22-bookworm-slim',
  network: 'none', // none | bridge
  memory: '2g',
  cpus: '2',
  hostCommands: [],
};

const IMAGE_RE = /^[a-z0-9][a-z0-9._/:@-]{0,199}$/i;
const SIZE_RE = /^\d{1,6}[kmg]?$/i;
const CPUS_RE = /^\d{1,3}(?:\.\d{1,2})?$/;

/** Нормализует настройки: неизвестное и опасное отбрасывается к значениям по умолчанию. */
export function normalizeShellSandbox(raw = {}) {
  const value = raw && typeof raw === 'object' ? raw : {};
  return {
    mode: ['docker', 'tasks'].includes(value.mode) ? value.mode : 'off',
    image: IMAGE_RE.test(String(value.image || '')) ? String(value.image) : DEFAULT_SHELL_SANDBOX.image,
    network: value.network === 'bridge' ? 'bridge' : 'none',
    memory: SIZE_RE.test(String(value.memory || '')) ? String(value.memory) : DEFAULT_SHELL_SANDBOX.memory,
    cpus: CPUS_RE.test(String(value.cpus || '')) ? String(value.cpus) : DEFAULT_SHELL_SANDBOX.cpus,
    hostCommands: Array.isArray(value.hostCommands)
      ? value.hostCommands.map((m) => String(m).trim()).filter((m) => m && m.length <= 200).slice(0, 50)
      : [],
  };
}

function maskToRegex(mask) {
  const escaped = mask.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/** Команда разрешена на хосте, если каждая её часть совпала с маской `hostCommands`. */
export function hostAllowed(command, masks = []) {
  if (!masks.length) return false;
  const { parts, opaque } = splitCommand(String(command || ''));
  if (opaque || !parts.length) return false;
  const regexes = masks.map(maskToRegex);
  return parts.every((part) => regexes.some((re) => re.test(part.trim())));
}

/**
 * Где выполнится команда.
 * @returns {{ where: 'host'|'docker'|'blocked', why: string }}
 */
/**
 * Действующий режим для чата (CW1.3, ADR 0066): `tasks` — Docker в чатах
 * «Задача», хост в «Коде»; у проекта своя настройка сильнее общей.
 */
export function effectiveSandbox(config, { kind = 'code', project = null } = {}) {
  const cfg = normalizeShellSandbox(config);
  const override = project?.sandbox;
  const mode = override === 'docker' || override === 'off' ? override : cfg.mode === 'tasks' ? (kind === 'task' ? 'docker' : 'off') : cfg.mode;
  return { ...cfg, mode };
}

export function sandboxPlan(command, config, { dockerAvailable = false } = {}) {
  const cfg = normalizeShellSandbox(config);
  if (cfg.mode !== 'docker') return { where: 'host', why: cfg.mode === 'tasks' ? 'песочница только для чатов «Задача»' : 'песочница выключена' };
  if (hostAllowed(command, cfg.hostCommands)) return { where: 'host', why: 'команда из списка «на хосте»' };
  if (!dockerAvailable) {
    return {
      where: 'blocked',
      why:
        'Команды агента настроены на Docker-песочницу, но Docker недоступен. Запустите Docker Desktop ' +
        'или выключите песочницу в настройках («Команды агента»).',
    };
  }
  return { where: 'docker', why: `Docker ${cfg.image}, сеть ${cfg.network === 'none' ? 'выключена' : 'включена'}` };
}

/** Путь папки для `-v`: на Windows Docker Desktop понимает `C:\\…` как есть. */
function mountSource(projectDir) {
  return path.resolve(projectDir);
}

/**
 * Аргументы `docker run` для одной команды. Без оболочки на хосте: команда
 * уходит в `sh -lc` внутри контейнера отдельным аргументом.
 */
export function dockerRunArgs({ command, projectDir, cwd, config, name, uid, gid, roots = [] }) {
  const cfg = normalizeShellSandbox(config);
  // Дополнительные папки чата (ADR 0045) — в /mnt/<имя>.
  const mounts = [{ dir: path.resolve(projectDir), at: '/workspace' }, ...roots.filter((r) => !r.primary).map((r) => ({ dir: path.resolve(r.dir), at: `/mnt/${r.name}` }))];
  const target = path.resolve(cwd || projectDir);
  const mount = [...mounts].sort((a, b) => b.dir.length - a.dir.length).find((m) => {
    const rel = path.relative(m.dir, target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
  const relative = mount ? path.relative(mount.dir, target) : '';
  const workdir = mount ? (relative ? `${mount.at}/${relative.split(path.sep).join('/')}` : mount.at) : '/workspace';
  const args = [
    'run', '--rm', '-i',
    '--name', name,
    '--label', 'mai-code.shell=1',
    '--network', cfg.network,
    '--read-only',
    '--tmpfs', '/tmp:rw,size=512m',
    '--tmpfs', '/root:rw,size=256m',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '512',
    '--memory', cfg.memory,
    '--cpus', cfg.cpus,
    '-e', 'HOME=/tmp',
    '-e', 'FORCE_COLOR=0',
    ...mounts.flatMap((m) => ['-v', `${m.at === '/workspace' ? mountSource(m.dir) : m.dir}:${m.at}`]),
    '-w', workdir,
  ];
  // На Linux файлы, созданные в контейнере, остаются вашими, а не root.
  if (Number.isInteger(uid) && Number.isInteger(gid)) args.push('--user', `${uid}:${gid}`);
  args.push(cfg.image, 'sh', '-lc', String(command));
  return args;
}
