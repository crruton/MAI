import { execFile } from 'node:child_process';

function run(projectDir, args, timeout = 20_000) {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd: projectDir, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        resolve({ ok: !error, stdout: stdout || '', stderr: stderr || '', error: error?.message || '' });
      },
    );
  });
}

export async function gitStatus(projectDir) {
  const inside = await run(projectDir, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return { ok: false, error: 'Папка проекта не является git-репозиторием' };
  }

  const [branch, head, porcelain, log, aheadBehind, remote] = await Promise.all([
    run(projectDir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    run(projectDir, ['rev-parse', '--short', 'HEAD']),
    run(projectDir, ['status', '--porcelain=v1']),
    run(projectDir, ['log', '-8', '--pretty=format:%h\t%ad\t%s', '--date=short']),
    run(projectDir, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']),
    run(projectDir, ['remote', 'get-url', 'origin']),
  ]);

  const files = porcelain.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => ({ status: line.slice(0, 2).trim(), file: line.slice(3) }));

  let ahead = 0;
  let behind = 0;
  if (aheadBehind.ok) {
    const [a, b] = aheadBehind.stdout.trim().split(/\s+/).map(Number);
    behind = a || 0;
    ahead = b || 0;
  }

  return {
    ok: true,
    branch: branch.stdout.trim() || 'detached',
    head: head.stdout.trim(),
    files,
    dirty: files.length,
    commits: log.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [hash, date, ...rest] = line.split('\t');
        return { hash, date, subject: rest.join('\t') };
      }),
    ahead,
    behind,
    remote: remote.stdout.trim(),
  };
}

export async function gitDiff(projectDir, file = '') {
  const args = ['diff', '--no-color', '--stat'];
  if (file) args.push('--', file);
  const stat = await run(projectDir, args);
  const fullArgs = ['diff', '--no-color'];
  if (file) fullArgs.push('--', file);
  const full = await run(projectDir, fullArgs);
  const text = full.stdout || '';
  return {
    ok: stat.ok,
    stat: stat.stdout.trim(),
    diff: text.length > 120_000 ? `${text.slice(0, 120_000)}\n… обрезано` : text,
    truncated: text.length > 120_000,
  };
}

export async function gitHead(projectDir) {
  const result = await run(projectDir, ['rev-parse', '--short', 'HEAD']);
  return result.ok ? result.stdout.trim() : '';
}
