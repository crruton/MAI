// Плагин проекта MAI Code: быстрый обзор размера репозитория.
// Лежит в <проект>/.mai-code/plugins/, загружается при старте чата.
// Не читает файлы вне папки проекта.

import fs from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['node_modules', '.git', 'dist', 'out', 'release', '.repowise', '.claude']);

function walk(dir, root, stats, depth = 0) {
  if (depth > 8) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.mai-code') continue;
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, root, stats, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase() || '(без расширения)';
    const size = fs.statSync(full).size;
    stats.files += 1;
    stats.bytes += size;
    stats.byExt[ext] = stats.byExt[ext] || { files: 0, bytes: 0 };
    stats.byExt[ext].files += 1;
    stats.byExt[ext].bytes += size;
  }
}

export default {
  name: 'project-stats',

  tools: [
    {
      schema: {
        type: 'function',
        function: {
          name: 'project_stats',
          description: 'Показать число файлов и размер по расширениям в папке проекта',
          parameters: {
            type: 'object',
            properties: {
              top: { type: 'number', description: 'Сколько расширений показать (по умолчанию 10)' },
            },
          },
        },
      },
      async run({ projectDir }, args = {}) {
        const root = path.resolve(projectDir);
        if (!fs.existsSync(root)) return 'Папка проекта не найдена';
        const stats = { files: 0, bytes: 0, byExt: {} };
        walk(root, root, stats);
        const top = Math.max(1, Math.min(30, Number(args.top) || 10));
        const rows = Object.entries(stats.byExt)
          .sort((a, b) => b[1].bytes - a[1].bytes)
          .slice(0, top)
          .map(([ext, value]) => `${ext}: ${value.files} файлов, ${(value.bytes / 1024).toFixed(1)} КБ`);
        return [
          `Файлов: ${stats.files}`,
          `Размер: ${(stats.bytes / 1024 / 1024).toFixed(2)} МБ`,
          '',
          ...rows,
        ].join('\n');
      },
    },
  ],
};
