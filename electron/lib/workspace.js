import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { dataDir } from './config.js';

/**
 * Проекты в отдельной папке (F16: раньше «песочницы»; изоляция — только Docker).
 * Папка по-прежнему `sandboxes/` в данных приложения — ради совместимости.
 *
 * Каждый внешний проект получает отдельную папку со своим .mai-code,
 * загрузками и настройками. Общий harness (глобальные навыки, AGENTS.md,
 * профили моделей) остаётся в %APPDATA%/mai-code и не копируется в песочницу.
 */

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
};

export function sandboxRoot() {
  return path.join(dataDir(), 'sandboxes');
}

export function slugify(value) {
  const text = String(value || '')
    .toLowerCase()
    .split('')
    .map((ch) => TRANSLIT[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return text || `project-${Date.now()}`;
}

function commandExists(command) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(probe, [command], { stdio: 'ignore' }).status === 0;
}

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120_000 });
}

function templateFiles({ name, template, description }) {
  const title = name || 'Новый проект';
  const common = {
    'README.md': `# ${title}\n\n${description || 'Проект создан в MAI Code.'}\n\n## Запуск\n\nОпишите команды запуска и проверки.\n`,
    'AGENTS.md': `# Инструкции проекта\n\n- Работай только внутри этой папки.\n- Не читай и не меняй другие проекты.\n- Секреты храни в .env, не коммить.\n- Перед изменениями читай docs/PRD.md и docs/ARCHITECTURE.md.\n- После изменений запускай проверки из package.json (если есть).\n`,
    '.mai-code/memory.md': `# Память проекта\n\nСюда записываются подтверждённые уроки: решения, ограничения, грабли.\n\n## Уроки\n\n`,
    '.gitignore': `node_modules/\ndist/\nout/\n.env\n.env.*\n!.env.example\n*.log\n.mai-code/uploads/\n`,
    'docs/PRD.md': `# PRD: ${title}\n\n## Проблема\n\n## Пользователи\n\n## Сценарии\n\n## Критерии успеха\n\n## Вне scope\n`,
    'docs/ARCHITECTURE.md': `# Архитектура: ${title}\n\n## Контекст (C1)\n\n## Контейнеры (C2)\n\n## Компоненты (C3)\n\n## Решения (ADR)\n`,
    '.mai-code/uploads/.gitkeep': '',
  };

  if (template === 'service') {
    return {
      ...common,
      'package.json': JSON.stringify(
        {
          name: slugify(name),
          version: '0.1.0',
          private: true,
          type: 'module',
          scripts: { start: 'node src/index.js', test: 'node --test' },
        },
        null,
        2,
      ),
      'src/index.js': `import http from 'node:http';\n\nconst port = Number(process.env.PORT || 3000);\n\nhttp\n  .createServer((req, res) => {\n    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });\n    res.end(JSON.stringify({ ok: true, path: req.url }));\n  })\n  .listen(port, () => console.log(\`listening on :\${port}\`));\n`,
      'test/index.test.js': `import test from 'node:test';\nimport assert from 'node:assert/strict';\n\ntest('окружение работает', () => {\n  assert.equal(1 + 1, 2);\n});\n`,
      Dockerfile: `FROM node:22-alpine\nWORKDIR /app\nCOPY package.json ./\nRUN npm install --omit=dev\nCOPY . .\nEXPOSE 3000\nCMD ["npm", "start"]\n`,
      '.github/workflows/ci.yml': `name: ci\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n      - run: npm install\n      - run: npm test\n`,
    };
  }

  if (template === 'agent-app') {
    return {
      ...common,
      'package.json': JSON.stringify(
        {
          name: slugify(name),
          version: '0.1.0',
          private: true,
          type: 'module',
          scripts: { start: 'node src/main.js', test: 'node --test' },
        },
        null,
        2,
      ),
      'src/main.js': `import { runAgent } from './agent.js';\n\nconst answer = await runAgent(process.argv.slice(2).join(' ') || 'Привет');\nconsole.log(answer);\n`,
      'src/agent.js': `export async function runAgent(prompt) {\n  // Замените на вызов вашего провайдера. Здесь только каркас.\n  return \`Агент получил: \${prompt}\`;\n}\n`,
      'test/agent.test.js': `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { runAgent } from '../src/agent.js';\n\ntest('агент отвечает', async () => {\n  const answer = await runAgent('ping');\n  assert.match(answer, /ping/);\n});\n`,
    };
  }

  return common;
}

function writeFiles(dir, files) {
  const written = [];
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    written.push(relative);
  }
  return written;
}

function gitInit(dir, title) {
  if (!commandExists('git')) return { ok: false, error: 'git не найден в PATH' };
  const init = run('git', ['init', '-b', 'main'], dir);
  if (init.status !== 0) {
    // Старые версии git не знают -b.
    const fallback = run('git', ['init'], dir);
    if (fallback.status !== 0) return { ok: false, error: (fallback.stderr || '').trim() };
  }
  run('git', ['add', '-A'], dir);
  const commit = run(
    'git',
    ['-c', 'user.name=MAI Code', '-c', 'user.email=mai-code@local', 'commit', '-m', `Initial scaffold: ${title}`],
    dir,
  );
  return { ok: commit.status === 0, error: commit.status === 0 ? '' : (commit.stderr || '').trim() };
}

function createRemote({ dir, name, repoHost, visibility }) {
  const privateFlag = visibility === 'public' ? '--public' : '--private';
  if (repoHost === 'github') {
    if (!commandExists('gh')) {
      return {
        created: false,
        instructions: 'Установите GitHub CLI (gh) и выполните: gh repo create <имя> --source . --remote origin --push ' + privateFlag,
      };
    }
    const res = run('gh', ['repo', 'create', name, '--source', '.', '--remote', 'origin', '--push', privateFlag], dir);
    if (res.status === 0) return { created: true, url: (res.stdout || '').trim().split(/\s+/).pop() || '' };
    return { created: false, instructions: `gh repo create не сработал: ${(res.stderr || res.stdout || '').trim()}` };
  }

  if (repoHost === 'gitlab') {
    if (!commandExists('glab')) {
      return {
        created: false,
        instructions: 'Установите GitLab CLI (glab) и выполните: glab repo create <имя> ' + privateFlag + ', затем git push -u origin main.',
      };
    }
    const res = run('glab', ['repo', 'create', name, privateFlag, '--remote', 'origin'], dir);
    if (res.status === 0) {
      const push = run('git', ['push', '-u', 'origin', 'main'], dir);
      return { created: push.status === 0, url: '', instructions: push.status === 0 ? '' : (push.stderr || '').trim() };
    }
    return { created: false, instructions: `glab repo create не сработал: ${(res.stderr || res.stdout || '').trim()}` };
  }

  if (repoHost === 'openscion') {
    return {
      created: false,
      instructions:
        'OpenScion — это серверная SCM-система, а не git-хостинг. Локальный git-репозиторий создан. ' +
        'Разверните OpenScion-сервер и импортируйте репозиторий командой opnscn (см. docs/OPENSCION.md).',
    };
  }

  return { created: false, instructions: '' };
}

function openscionNote() {
  return `# OpenScion

OpenScion — серверная система контроля версий для больших монорепозиториев
(https://github.com/tinyhumansai/openscion, GPL-3.0). Это не замена GitHub/GitLab
для маленьких проектов и не git-хостинг.

## Когда имеет смысл

- Монорепозиторий, где большинство клиентов — агенты и CI.
- Нужны changeset'ы вместо полных снапшотов и серверный rebase/merge.
- Есть команда, которая готова держать сервер OpenScion.

## Как подключить

1. Разверните сервер OpenScion по инструкции проекта.
2. Создайте репозиторий на сервере.
3. Импортируйте текущий проект:

   \`\`\`powershell
   opnscn import . <url-сервера>
   \`\`\`

4. Проверьте, что клиенты и CI умеют работать с \`opnscn\`.

MAI Code продолжает работать с локальным git; OpenScion подключается как
внешний remote и не блокирует разработку.
`;
}

export function createWorkspace({
  name,
  parentDir,
  template = 'blank',
  repoHost = 'none',
  visibility = 'private',
  description = '',
} = {}) {
  const title = String(name || '').trim();
  if (!title) throw new Error('Нужно имя проекта');
  const slug = slugify(title);
  const root = parentDir ? path.resolve(parentDir) : sandboxRoot();
  fs.mkdirSync(root, { recursive: true });
  let dir = path.join(root, slug);
  if (fs.existsSync(dir)) dir = path.join(root, `${slug}-${Date.now().toString(36)}`);
  fs.mkdirSync(dir, { recursive: true });

  const files = templateFiles({ name: title, template, description });
  if (repoHost === 'openscion') files['docs/OPENSCION.md'] = openscionNote();
  const written = writeFiles(dir, files);

  const manifest = {
    name: title,
    slug,
    template,
    repoHost,
    visibility,
    description,
    sharedHarness: true,
    isolated: true,
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.join(dir, '.mai-code'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.mai-code', 'sandbox.json'), JSON.stringify(manifest, null, 2), 'utf8');
  written.push('.mai-code/sandbox.json');

  const git = gitInit(dir, title);
  const remote = createRemote({ dir, name: slug, repoHost, visibility });

  return {
    projectDir: dir,
    slug,
    manifest,
    files: written,
    git,
    remote,
  };
}

export function listWorkspaces() {
  const root = sandboxRoot();
  if (!fs.existsSync(root)) return [];
  const items = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(dir, '.mai-code', 'sandbox.json'), 'utf8'));
    } catch {
      manifest = { name: entry.name, slug: entry.name, template: 'unknown' };
    }
    items.push({ dir, ...manifest });
  }
  return items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}
