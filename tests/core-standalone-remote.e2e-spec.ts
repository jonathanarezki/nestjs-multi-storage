import { selectedBackends } from './support/selection';

/**
 * A focused subset of the behaviour suites (crud, readdir, stat, streams, error shapes) re-run through the
 * framework-agnostic core (see `useStandalone`) on S3, FTP and SFTP: `createStorage(config)`, no `init()`, so their
 * lazy initialization is exercised by every first operation. Without copy-rename: its S3 multipart cases are slow
 * and the regular suites cover it; memory and fileSystem run the whole subset in core-standalone.e2e-spec.ts.
 */
const backends = selectedBackends().filter((backend) => backend === 's3' || backend === 'ftp' || backend === 'sftp');

describe('through the standalone core (s3, ftp, sftp)', () => {
  if (backends.length === 0) {
    it.skip('s3, ftp and sftp are not among the E2E_BACKENDS', () => undefined);
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
  require('./streams.e2e-spec');
  require('./storage-error.e2e-spec');
  /* eslint-enable @typescript-eslint/no-require-imports */
  if (previous === undefined) delete process.env.E2E_BACKENDS;
  else process.env.E2E_BACKENDS = previous;
  delete process.env.E2E_OMIT_UNSELECTED;
});
