import { listSkills } from '../skills.js';

export const skillTools = [
  {
    schema: {
      type: 'function',
      function: {
        name: 'load_skill',
        description:
          'Загрузить полный текст навыка (SKILL.md) по имени. Список навыков и их описания есть в системном промпте.',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
      },
    },
    async run(ctx, args) {
      const skills = listSkills(ctx.projectDir, { includeProject: ctx.trusted !== false });
      const found =
        skills.find((s) => s.name.toLowerCase() === String(args.name).toLowerCase()) ||
        skills.find((s) => s.name.toLowerCase().includes(String(args.name).toLowerCase()));
      if (!found) return `Навык «${args.name}» не найден. Доступны: ${skills.map((s) => s.name).join(', ') || 'нет'}`;
      return `# Навык: ${found.name}\n\n${found.body}`;
    },
  },
];
