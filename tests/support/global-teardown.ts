import { execFileSync } from 'child_process';

export default async function globalTeardown() {
  const id = process.env.S3_TEST_CONTAINER_ID;
  if (!id) return;
  try {
    execFileSync('docker', ['rm', '-f', id], { stdio: 'ignore' });
  } catch {
    // already gone
  }
  delete process.env.S3_TEST_CONTAINER_ID;
}
