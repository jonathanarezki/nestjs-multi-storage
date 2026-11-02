import { selectedBackends } from './support/selection';

/**
 * The behaviour suites, re-run with every context's `service` replaced by `storage.disk('named')` of a multi-disk
 * module (see `useNamedDisk`): proves that StorageDisk delegates the whole file API with the same behaviour.
 *
 * Only the memory and fileSystem backends are run: the point is the delegation of StorageDisk (which does not depend
 * on the driver behind it), not a second pass over the remote backends, which the suites run directly against the
 * service already. That delegation is asserted for every file-API method in disks.e2e-spec.ts ('every method is
 * delegated to the driver'). The restriction must be in place before the harness is loaded, which reads it.
 */
const backends = selectedBackends().filter((backend) => backend === 'memory' || backend === 'fileSystem');

describe('through a named disk', () => {
  if (backends.length === 0) {
    it.skip('memory and fileSystem are not among the E2E_BACKENDS', () => undefined);
    return;
  }
  const previous = process.env.E2E_BACKENDS;
  process.env.E2E_BACKENDS = backends.join(',');
  process.env.E2E_OMIT_UNSELECTED = '1';
  /* eslint-disable @typescript-eslint/no-require-imports */
  require('./support/harness').useNamedDisk(true);
  require('./crud.e2e-spec');
  require('./readdir.e2e-spec');
  require('./stat.e2e-spec');
  require('./copy-rename.e2e-spec');
  require('./streams.e2e-spec');
  require('./storage-error.e2e-spec');
  require('./fs-parity.e2e-spec');
  /* eslint-enable @typescript-eslint/no-require-imports */
  if (previous === undefined) delete process.env.E2E_BACKENDS;
  else process.env.E2E_BACKENDS = previous;
  delete process.env.E2E_OMIT_UNSELECTED;
});
