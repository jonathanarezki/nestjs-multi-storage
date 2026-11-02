import { execFileSync } from 'child_process';
import * as fs from 'fs';

export default async function globalTeardown() {
  for (const key of ['S3_TEST_CONTAINER_ID', 'FTP_TEST_CONTAINER_ID', 'SFTP_TEST_CONTAINER_ID']) {
    const id = process.env[key];
    if (!id) continue;
    try {
      execFileSync('docker', ['rm', '-f', id], { stdio: 'ignore' });
    } catch {
      // already gone
    }
    delete process.env[key];
  }
  const keysDir = process.env.SFTP_TEST_KEYS_DIR;
  if (keysDir) {
    fs.rmSync(keysDir, { recursive: true, force: true });
    delete process.env.SFTP_TEST_KEYS_DIR;
  }
}
