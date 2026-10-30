import { execFileSync } from 'child_process';
import { createServer } from 'net';

/**
 * Resolves the S3 backend used by the e2e suites and publishes it as S3_TEST_RESOLVED_ENDPOINT
 * (an empty string means: skip the S3 suites).
 *
 * 1. S3_TEST_ENDPOINT, when set, is used as is (nothing is started or stopped).
 * 2. Otherwise an adobe/s3mock container is started on a free port and removed again in global-teardown.
 * 3. Without Docker the S3 suites are skipped with a console message, unless REQUIRE_S3_TESTS is '1' or 'true':
 *    then global setup throws instead (used by the release workflow so it never publishes untested).
 */

const STARTUP_TIMEOUT_MS = 120_000;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function waitUntilResponding(url: string): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      return;
    } catch (e) {
      lastError = e;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`s3mock did not respond at ${url} within ${STARTUP_TIMEOUT_MS}ms: ${lastError}`);
}

function s3TestsRequired(): boolean {
  return ['1', 'true'].includes(process.env.REQUIRE_S3_TESTS ?? '');
}

function skipOrThrow(reason: string) {
  if (s3TestsRequired()) {
    throw new Error(`S3 tests are required (REQUIRE_S3_TESTS) but s3mock could not be started: ${reason}`);
  }
  console.warn(`[e2e] SKIPPING the S3 suites: ${reason}`);
}

function removeContainer(id: string) {
  try {
    execFileSync('docker', ['rm', '-f', id], { stdio: 'ignore' });
  } catch {
    // already gone
  }
}

export default async function globalSetup() {
  process.env.S3_TEST_RESOLVED_ENDPOINT = '';
  delete process.env.S3_TEST_CONTAINER_ID;

  const external = process.env.S3_TEST_ENDPOINT;
  if (external) {
    process.env.S3_TEST_RESOLVED_ENDPOINT = external;
    console.log(`[e2e] Using S3 endpoint from S3_TEST_ENDPOINT: ${external}`);
    return;
  }

  let id: string;
  let port: number;
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 20_000 });
    port = await freePort();
    id = execFileSync(
      'docker',
      [
        'run',
        '-d',
        '--rm',
        '-p',
        `${port}:9090`,
        '-e',
        'COM_ADOBE_TESTING_S3MOCK_STORE_INITIAL_BUCKETS=test',
        'adobe/s3mock:latest',
      ],
      { encoding: 'utf8', timeout: 300_000 },
    ).trim();
  } catch (e) {
    skipOrThrow(
      `Docker is unavailable (or the container failed to start) and S3_TEST_ENDPOINT is not set.\n${
        (e as Error).message.split('\n')[0]
      }`,
    );
    return;
  }

  process.env.S3_TEST_CONTAINER_ID = id;
  // Safety net in case Jest is killed before global-teardown runs
  process.on('exit', () => removeContainer(id));

  try {
    await waitUntilResponding(`http://127.0.0.1:${port}/`);
  } catch (e) {
    removeContainer(id);
    delete process.env.S3_TEST_CONTAINER_ID;
    skipOrThrow((e as Error).message);
    return;
  }

  process.env.S3_TEST_RESOLVED_ENDPOINT = `http://localhost:${port}`;
  console.log(`[e2e] Started adobe/s3mock (${id.slice(0, 12)}) at ${process.env.S3_TEST_RESOLVED_ENDPOINT}`);
}
