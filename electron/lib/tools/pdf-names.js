import path from 'node:path';

/** Итог заполнения формы по умолчанию (CW2.4): «<имя> (заполнено).pdf» рядом с исходником. */
export function defaultFilledName(args = {}) {
  if (args.output) return args.output;
  const rel = String(args.path || '');
  const dir = path.dirname(rel);
  return path.join(dir === '.' ? '' : dir, `${path.basename(rel, path.extname(rel))} (заполнено).pdf`);
}
