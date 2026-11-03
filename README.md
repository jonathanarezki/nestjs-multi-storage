# node-multi-storage

[![license](https://img.shields.io/npm/l/@webbar/node-multi-storage.svg)](LICENSE)

A multi-storage filesystem manager for Node whose API mirrors `fs.promises`. Code written against `fs` can switch to `storage.` and run against the local filesystem, an S3-compatible object store, an FTP or SFTP server or an in-memory store, with Node-style errors (`ENOENT`, `EEXIST`, ...) on every backend. Several named disks can be configured side by side.

This repository is an npm workspaces monorepo with two packages:

| Package                                                         | Version                                                                                                                         | What it is                                                                                                                                                                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@webbar/node-multi-storage`](packages/core) (`packages/core`) | [![npm](https://img.shields.io/npm/v/@webbar/node-multi-storage.svg)](https://www.npmjs.com/package/@webbar/node-multi-storage) | The framework-agnostic core: `createStorage`, the five built-in backends plus custom drivers (experimental), a driver test kit, errors and types. Works in plain Node, Express, Next.js (Node runtime) and more. |
| [`nestjs-multi-storage`](packages/nestjs) (`packages/nestjs`)   | [![npm](https://img.shields.io/npm/v/nestjs-multi-storage.svg)](https://www.npmjs.com/package/nestjs-multi-storage)             | A thin NestJS wrapper around the core: `StorageModule`, `StorageService`, `@InjectStorage`, with the same disks and file API as the core.                                                                        |

## Which one to install

- Using NestJS: install `nestjs-multi-storage` (it depends on the core). Read its [README](packages/nestjs/README.md).
- Anything else (plain Node, Express, Next.js, scripts, other frameworks): install `@webbar/node-multi-storage`. Read its [README](packages/core/README.md), which documents the whole file API, all backends and their options.

Backend libraries are optional peer dependencies, installed only for the backends you use (the AWS SDK packages for S3, `basic-ftp`, `ssh2`, `memfs`).

## Contributing

The repository uses npm workspaces (`packages/*`); run `npm install` once at the root. The e2e tests live in `tests/` and run against the packages' TypeScript sources.

```bash
npm run build           # builds the core, then the NestJS package
npm run check:api       # the NestJS package's public API vs. the 0.8.0 baseline in scripts/api-compat (run after npm run build)
```

### Testing

```bash
npm run test:e2e        # all five backends
npm run test:e2e:fast   # memory and fileSystem only, no Docker
E2E_BACKENDS=sftp,memory npm run test:e2e   # selected backends
```

The e2e suite runs the same behaviour tests against every backend; `memory` and `fileSystem` always run. For S3, FTP and SFTP, Docker starts the servers automatically (adobe/s3mock, delfer/alpine-ftp-server and atmoz/sftp, on free ports, removed after the run). `E2E_BACKENDS` is a comma-separated list of `fileSystem`, `memory`, `s3`, `ftp` and `sftp` (case-insensitive; default: all), and only the containers of the selected backends are started.

To use servers you already have instead of containers, set the variables of that service:

| Service | Variables                                                                                                                                                                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S3      | `S3_TEST_ENDPOINT`. The bucket `test` must exist.                                                                                                                                                                                                                  |
| FTP     | `FTP_TEST_HOST`, and optionally `FTP_TEST_PORT` (21), `FTP_TEST_USERNAME` (`anonymous`), `FTP_TEST_PASSWORD`, `FTP_TEST_DIR` (a writable base directory, relative to the login directory; default: the login directory).                                           |
| SFTP    | `SFTP_TEST_HOST` and `SFTP_TEST_HOST_KEY` (the `SHA256:<base64>` fingerprint, mandatory), and optionally `SFTP_TEST_PORT` (22), `SFTP_TEST_USERNAME` and `SFTP_TEST_PASSWORD` (`test`), `SFTP_TEST_DIR` (a writable directory, default `/upload`).                 |
| SFTP    | For the key authentication suites: `SFTP_TEST_KEY_PATH`, `SFTP_TEST_ENCRYPTED_KEY_PATH` (private key files the test user can log in with) and `SFTP_TEST_KEY_PASSPHRASE` (the passphrase of the second one). Those suites are skipped for keys that are not given. |

Without Docker (and without the matching variables) the suites of a service are skipped with a console message, unless `REQUIRE_S3_TESTS=1` (or `true`) is set, in which case the run fails instead. The flag covers S3, FTP and SFTP; the release workflow sets it.

## Releasing

The two packages are versioned independently: `@webbar/node-multi-storage` (`packages/core`) and `nestjs-multi-storage` (`packages/nestjs`). To release one, bump `version` in its `package.json`, add a `## [<version>]` entry to its own `CHANGELOG.md` and push to `main`. When the core is bumped and the nestjs package should use it, also raise the `@webbar/node-multi-storage` range in `packages/nestjs/package.json`.

The `auto-release.yml` workflow runs when a `packages/*/package.json` changes. For each package it checks whether `<name>@<version>` is already on npm and whether the GitHub tag `<name>@<version>` exists, and only does what is missing. If anything needs publishing, it lints, builds and tests on Node 22 and 24, and only if both pass it publishes to npm via [trusted publishing](https://docs.npmjs.com/trusted-publishers) (no token, with provenance): the core first, then nestjs. It then creates a GitHub release per package from that package's changelog section. A package whose version did not change is neither published nor released. Prerelease versions such as `0.8.0-beta.1` are published under the `next` tag and marked as prereleases. After a failure, re-running the workflow (Actions → "Run workflow") completes only the missing steps.

Tags have the form `@webbar/node-multi-storage@0.7.0` and `nestjs-multi-storage@0.7.0`; the older `v0.x` tags belong to the history of `nestjs-multi-storage`.

One-time setup per package on npmjs.com (Settings → Trusted Publisher → GitHub Actions): organization or user `jonathanarezki`, repository `node-multi-storage`, workflow filename `auto-release.yml`. A package must exist before this can be configured, so the first version of `@webbar/node-multi-storage` (0.7.0) was published by hand: build, `npm publish -w @webbar/node-multi-storage --access public`, then configure the trusted publisher and push. The workflow notices that the version is already on npm and skips it.

## License

[MIT](LICENSE)
