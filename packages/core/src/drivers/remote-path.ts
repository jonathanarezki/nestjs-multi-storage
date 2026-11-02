import * as path from 'path';

/**
 * The POSIX path of `p` below `prefix` (absolute, or relative to the login directory of the server); throws when it
 * escapes the prefix. A relative prefix, including '.', is resolved correctly: both are compared against the same base.
 */
export function remotePath(prefix: string, p: string): string {
  const joined = path.posix.join(prefix, p);
  if (prefix) {
    const relative = path.posix.relative(prefix, joined);
    if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
      throw new Error(`Path "${p}" escapes the storage prefix "${prefix}"`);
    }
  }
  return joined;
}
