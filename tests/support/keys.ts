import { utils } from 'ssh2';

/**
 * A fresh ed25519 key pair (OpenSSH format), optionally protected by `passphrase`.
 * ssh2's generator occasionally (about 1 in 300) writes a private key that its own parser rejects as "Malformed
 * OpenSSH private key": every key is parsed back and a broken one is discarded, so that no test depends on luck.
 */
export function generateEd25519(passphrase?: string): { private: string; public: string } {
  for (let attempt = 0; attempt < 50; attempt++) {
    const pair = utils.generateKeyPairSync(
      'ed25519',
      passphrase === undefined ? undefined : { passphrase, cipher: 'aes256-ctr', rounds: 16 },
    );
    if (!(utils.parseKey(pair.private, passphrase) instanceof Error)) {
      return pair;
    }
  }
  throw new Error('ssh2 produced no parseable ed25519 key in 50 attempts');
}
