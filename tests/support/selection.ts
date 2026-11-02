/**
 * Which backends an e2e run covers: the comma list in E2E_BACKENDS (e.g. `memory,fileSystem` for a fast run without
 * Docker), or all of them when the variable is unset or empty. Shared by global setup (which starts only the
 * containers the selection needs) and the harness (which restricts the suites to it).
 */
export const ALL_BACKENDS = ['fileSystem', 'memory', 's3', 'ftp', 'sftp'] as const;
export type SelectableBackend = (typeof ALL_BACKENDS)[number];

export function selectedBackends(env: NodeJS.ProcessEnv = process.env): SelectableBackend[] {
  const raw = (env.E2E_BACKENDS ?? '').trim();
  if (!raw) return [...ALL_BACKENDS];
  const selected: SelectableBackend[] = [];
  for (const word of raw.split(',').map((w) => w.trim())) {
    if (!word) continue;
    const backend = ALL_BACKENDS.find((b) => b.toLowerCase() === word.toLowerCase());
    if (!backend) throw new Error(`E2E_BACKENDS: unknown backend "${word}" (known: ${ALL_BACKENDS.join(', ')})`);
    if (!selected.includes(backend)) selected.push(backend);
  }
  return selected;
}

export function isSelected(backend: SelectableBackend, env: NodeJS.ProcessEnv = process.env): boolean {
  return selectedBackends(env).includes(backend);
}
