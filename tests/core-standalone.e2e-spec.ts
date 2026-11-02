import { selectedBackends } from './support/selection';

/**
 * Behaviour suites re-run through the framework-agnostic core (see `useStandalone`): `createStorage(config)` without
 * a Nest testing module and without `init()`, `destroy()` on close. This proves that the core works on its own.
 *
 * This file runs the whole subset (crud, readdir, stat, copy-rename, streams, error shapes) on memory and fileSystem;
 * core-standalone-remote.e2e-spec.ts runs a focused one on S3, FTP and SFTP (and proves their lazy initialization),
 * in a file of its own to keep the total run time short. The restriction of the backends must be in place before the
 * harness is loaded, which reads it.
 */
const backends = selectedBackends().filter((backend) => backend === 'memory' || backend === 'fileSystem');

describe('through the standalone core (memory, fileSystem)', () => {
  if (backends.length === 0) {
    it.skip('memory and fileSystem are not among the E2E_BACKENDS', () => undefined);
    return;
  }
  const previous = process.env.E2E_BACKENDS;
  process.env.E2E_BACKENDS = backends.join(',');
  process.env.E2E_OMIT_UNSELECTED = '1';
  /* eslint-disable @typescript-eslint/no-require-imports */
  require('./support/harness').useStandalone(true);
  require('./crud.e2e-spec');
  require('./readdir.e2e-spec');
  require('./stat.e2e-spec');
  require('./copy-rename.e2e-spec');
  require('./streams.e2e-spec');
  require('./storage-error.e2e-spec');
  /* eslint-enable @typescript-eslint/no-require-imports */
  if (previous === undefined) delete process.env.E2E_BACKENDS;
  else process.env.E2E_BACKENDS = previous;
  delete process.env.E2E_OMIT_UNSELECTED;
});
