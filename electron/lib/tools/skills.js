import { listSkills, skillFiles, readSkillFile } from '../skills.js';
import { parseRule } from '../policy.js';

/**
 * Правила из `allowed-tools` навыка, которые можно выдать на прогон (CC10.4).
 * Команды и запись — только с маской: голый `run_shell` или маска `*` не выдаются.
 */
export function grantableRules(list = []) {
  const ok = [];
  const rejected = [];
  for (const text of list) {
    const rule = parseRule(text);
    const broad = !rule || ((/^(run_shell|write_file|edit_file|memory_append)$/.test(rule.tool) || rule.tool.includes('*')) && (!rule.spec || /^\*+$/.test(rule.spec.trim())));
    (broad ? rejected : ok).push(text);
  }
  return { ok, rejected };
}

export const skillTools = [
  {
    schema: {
      type: 'function',
      function: {
        name: 'load_skill',
        description:
          'Загрузить навык по имени: текст SKILL.md и список его файлов. С параметром file — прочитать файл навыка ' +
          '(справка, шаблон, скрипт). Список навыков и их описания есть в системном промпте.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            file: { type: 'string', description: 'Файл внутри навыка, путь из списка файлов' },
          },
          required: ['name'],
        },
      },
    },
    async run(ctx, args) {
      const skills = listSkills(ctx.projectDir, { includeProject: ctx.trusted !== false, extraDirs: ctx.skillDirs || [] });
      const found =
        skills.find((s) => s.name.toLowerCase() === String(args.name).toLowerCase()) ||
        skills.find((s) => s.name.toLowerCase().includes(String(args.name).toLowerCase()));
      if (!found) return `Навык «${args.name}» не найден. Доступны: ${skills.map((s) => s.name).join(', ') || 'нет'}`;
      if (args.file) {
        try {
          return `# Навык ${found.name}: ${args.file}\n\n${readSkillFile(found, args.file)}`;
        } catch (err) {
          return `Ошибка: ${err.message}`;
        }
      }
      const files = skillFiles(found);
      const parts = [`# Навык: ${found.name}`, '', found.body.trim()];
      if (files.length) {
        parts.push(
          '',
          `## Файлы навыка (папка ${found.dir ? `${found.dir}/${found.name}` : ''})`,
          'Прочитать — load_skill с параметром file. Скрипт запускай через run_shell по полному пути.',
          ...files.map((f) => `- ${f}`),
        );
      }
      if (found.allowedTools?.length && typeof ctx.grantRules === 'function') {
        const { ok, rejected } = grantableRules(found.allowedTools);
        if (ok.length) ctx.grantRules(ok, found.name);
        if (ok.length) parts.push('', `Разрешено навыком на этот прогон: ${ok.join(', ')}`);
        if (rejected.length) parts.push(`Не выданы (слишком широкие): ${rejected.join(', ')}`);
      }
      return parts.join('\n');
    },
  },
];
