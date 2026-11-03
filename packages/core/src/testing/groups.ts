import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import { types } from 'node:util';
import { StorageDisk } from '../storage-disk';

/** Registers one test of a group; the test gets a disk on a fresh, empty store. */
export type DefineTest = (title: string, fn: (disk: StorageDisk) => Promise<void>) => void;

export interface ConformanceGroup {
  /** The name of the `describe` block and the value for `skip` */
  name: string;
  /** What the group checks (documented in the README) */
  description: string;
  define(test: DefineTest): void;
}

/** Asserts that `promise` rejects with a Node-style error (a native `Error`) with this `code`, and returns it. */
async function rejectsWith(promise: Promise<unknown>, code: string): Promise<any> {
  let error: any;
  let rejected = false;
  await promise.catch((e) => {
    rejected = true;
    error = e;
  });
  assert.ok(rejected, `expected a rejection with ${code}, but the promise resolved`);
  assert.ok(types.isNativeError(error), `expected an Error with code ${code}, got ${String(error)}`);
  const { code: actual, message } = error as { code?: unknown; message: string };
  assert.equal(actual, code, `expected code ${code}, got ${String(actual)} (${message})`);
  if (!code.startsWith('ERR_')) assert.ok(message.includes(code), `message should mention ${code}`);
  return error;
}

/**
 * Compares lists by value. The arrays are copied first: `assert.deepStrictEqual` also compares prototypes, and a test
 * runner that runs tests in a separate realm (Jest) would otherwise fail on arrays created by Node's own modules.
 */
function sameList(actual: readonly unknown[], expected: readonly unknown[]) {
  assert.deepEqual([...actual], [...expected]);
}

/** A listing through the disk is always sorted (plain code-unit order, whatever order the driver returns): `expected` is given in any order. */
function sameMembers(actual: readonly string[], expected: readonly string[]) {
  sameList(actual, [...expected].sort());
}

function sameBytes(actual: Buffer, expected: Buffer | number[]) {
  const wanted = Buffer.from(expected);
  assert.ok(Buffer.isBuffer(actual) && actual.equals(wanted), `expected ${wanted.length} bytes, got ${actual.length}`);
}

async function collect(readable: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of readable) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

/** `fs` needs the parent folder: creates it, then writes the file. */
async function put(disk: StorageDisk, p: string, data: string | Buffer | Uint8Array, options?: any) {
  const slash = p.lastIndexOf('/');
  if (slash > 0) await disk.mkdir(p.slice(0, slash));
  await disk.writeFile(p, data, options);
}

const text = async (disk: StorageDisk, p: string) => (await disk.readFile(p)).toString();

function writeThrough(disk: StorageDisk, p: string, chunks: Array<string | Buffer>, options?: any): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const stream = disk.createWriteStream(p, options);
    stream.on('error', reject).on('finish', () => resolve());
    for (const chunk of chunks.slice(0, -1)) stream.write(chunk);
    stream.end(chunks[chunks.length - 1]);
  });
}

export const GROUPS: ConformanceGroup[] = [
  {
    name: 'root',
    description: "the root of the store ('') is an existing, empty folder",
    define(test) {
      test('exists, stat and readdir of the root', async (disk) => {
        assert.equal(await disk.exists(''), true);
        assert.equal((await disk.stat('')).isDirectory(), true);
        sameMembers(await disk.readdir(''), []);
        await disk.writeFile('x.txt', 'x');
        sameMembers(await disk.readdir(''), ['x.txt']);
      });
    },
  },
  {
    name: 'mkdir',
    description: 'mkdir (recursive by default), EEXIST, ENOENT and ENOTDIR',
    define(test) {
      test('creates a folder, recursively by default; an existing folder is fine', async (disk) => {
        await disk.mkdir('x/y/z');
        await disk.mkdir('x/y/z', { recursive: true });
        await disk.mkdir('x/y/z', { mode: 0o755 });
        assert.equal((await disk.stat('x/y/z')).isDirectory(), true);
        assert.equal((await disk.stat('x')).isDirectory(), true);
        assert.equal(await disk.exists('x/y'), true);
      });
      test('a file at that path: EEXIST, with and without recursive', async (disk) => {
        await put(disk, 'f.txt', 'x');
        await rejectsWith(disk.mkdir('f.txt'), 'EEXIST');
        await rejectsWith(disk.mkdir('f.txt', { recursive: false }), 'EEXIST');
        assert.equal(await text(disk, 'f.txt'), 'x');
      });
      test('recursive: false on an existing folder: EEXIST', async (disk) => {
        await disk.mkdir('d');
        await put(disk, 'implicit/f.txt', 'x');
        await rejectsWith(disk.mkdir('d', { recursive: false }), 'EEXIST');
        await rejectsWith(disk.mkdir('implicit', { recursive: false }), 'EEXIST');
      });
      test('recursive: false: ENOENT for a missing parent, fine for an existing one', async (disk) => {
        await rejectsWith(disk.mkdir('a/b', { recursive: false }), 'ENOENT');
        assert.equal(await disk.exists('a'), false);
        await disk.mkdir('a', { recursive: false });
        await disk.mkdir('a/b', { recursive: false });
        assert.equal(await disk.exists('a/b'), true);
      });
      test('recursive: false below a file: ENOTDIR', async (disk) => {
        await put(disk, 'f', 'x');
        await rejectsWith(disk.mkdir('f/child', { recursive: false }), 'ENOTDIR');
      });
    },
  },
  {
    name: 'readdir',
    description:
      'listing, recursive listing with the ancestors (the order is not checked), encodings, ENOENT and ENOTDIR',
    define(test) {
      async function seed(disk: StorageDisk) {
        await disk.mkdir('t/a/b');
        await disk.mkdir('t/c');
        await disk.writeFile('t/a/b/1.txt', '1');
        await disk.writeFile('t/a/2.txt', '2');
        await disk.writeFile('t/3.txt', '3');
      }
      test('lists files and folders (names only)', async (disk) => {
        await seed(disk);
        sameMembers(await disk.readdir('t'), ['3.txt', 'a', 'c']);
        sameMembers(await disk.readdir('t/a'), ['2.txt', 'b']);
      });
      test('recursive lists every descendant as a relative path, folders (the ancestors) included', async (disk) => {
        await seed(disk);
        sameMembers(await disk.readdir('t', { recursive: true }), ['3.txt', 'a', 'a/2.txt', 'a/b', 'a/b/1.txt', 'c']);
      });
      test('recursive lists the ancestors of a file in an implicit folder', async (disk) => {
        await put(disk, 'imp/deep/er/f.txt', 'x');
        sameMembers(await disk.readdir('imp', { recursive: true }), ['deep', 'deep/er', 'deep/er/f.txt']);
      });
      test('does not list siblings that share a name prefix', async (disk) => {
        await put(disk, 'dir/a.txt', 'a');
        await put(disk, 'dir2/b.txt', 'b');
        await put(disk, 'dir.txt', 'c');
        sameMembers(await disk.readdir('dir'), ['a.txt']);
        sameMembers(await disk.readdir('dir', { recursive: true }), ['a.txt']);
      });
      test('an empty folder gives []', async (disk) => {
        await disk.mkdir('empty');
        sameMembers(await disk.readdir('empty'), []);
        sameMembers(await disk.readdir('empty', { recursive: true }), []);
      });
      test('names with spaces and non-ASCII characters', async (disk) => {
        await put(disk, 'a b/ü.txt', 'x');
        await put(disk, 'a b/ö copy+1 (2).txt', 'y');
        sameMembers(await disk.readdir('a b'), ['ö copy+1 (2).txt', 'ü.txt']);
      });
      test('a string or the encoding option re-encodes the names (done by the disk)', async (disk) => {
        await put(disk, 'd/f.txt', 'x');
        sameMembers(await disk.readdir('d', 'utf8'), ['f.txt']);
        sameMembers(await disk.readdir('d', { encoding: 'utf8' }), ['f.txt']);
        sameMembers(await disk.readdir('d', 'hex'), [Buffer.from('f.txt').toString('hex')]);
        const buffers = await disk.readdir('d', { encoding: 'buffer' as any });
        assert.equal(buffers.length, 1);
        assert.equal(Buffer.isBuffer(buffers[0]), true);
        assert.equal(buffers[0].toString(), 'f.txt');
      });
      test('a missing folder: ENOENT, also recursive', async (disk) => {
        await rejectsWith(disk.readdir('nope'), 'ENOENT');
        await rejectsWith(disk.readdir('nope', { recursive: true }), 'ENOENT');
      });
      test('a file: ENOTDIR', async (disk) => {
        await put(disk, 'f.txt', 'x');
        await rejectsWith(disk.readdir('f.txt'), 'ENOTDIR');
      });
    },
  },
  {
    name: 'readFile',
    description: 'readFile / writeFile: strings, encodings, Buffers, Uint8Array, overwriting, ENOENT, EISDIR',
    define(test) {
      test('a string for an encoding (string or option), a Buffer otherwise', async (disk) => {
        await put(disk, 'a.txt', 'héllo');
        assert.equal(await disk.readFile('a.txt', 'utf8'), 'héllo');
        assert.equal(await disk.readFile('a.txt', { encoding: 'utf8' }), 'héllo');
        assert.equal(await disk.readFile('a.txt', { encoding: 'base64' }), Buffer.from('héllo').toString('base64'));
        assert.equal(await disk.readFile('a.txt', { encoding: 'hex' }), Buffer.from('héllo').toString('hex'));
        assert.equal(Buffer.isBuffer(await disk.readFile('a.txt')), true);
        assert.equal(Buffer.isBuffer(await disk.readFile('a.txt', { encoding: null })), true);
        assert.equal(Buffer.isBuffer(await disk.readFile('a.txt', {})), true);
      });
      test('writeFile honours the encoding of a string (string or option)', async (disk) => {
        await put(disk, 'b64.txt', 'aGk=', 'base64');
        assert.equal(await disk.readFile('b64.txt', 'utf8'), 'hi');
        await put(disk, 'hex.txt', '6869', { encoding: 'hex' });
        assert.equal(await disk.readFile('hex.txt', 'utf8'), 'hi');
      });
      test('Buffers keep every byte, a Uint8Array view is written as its own bytes', async (disk) => {
        const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
        await put(disk, 'all.bin', all);
        sameBytes(await disk.readFile('all.bin'), all);
        await put(disk, 'u8.bin', new Uint8Array([1, 2, 3]));
        sameBytes(await disk.readFile('u8.bin'), [1, 2, 3]);
        const view = new Uint8Array([9, 8, 7, 6, 5]).subarray(1, 4);
        await put(disk, 'view.bin', view);
        sameBytes(await disk.readFile('view.bin'), [8, 7, 6]);
      });
      test('an empty file, and overwriting a file with a shorter content', async (disk) => {
        await put(disk, 'e.txt', '');
        assert.equal((await disk.readFile('e.txt')).length, 0);
        assert.equal((await disk.stat('e.txt')).size, 0);
        await put(disk, 'o.txt', 'a long content');
        await disk.writeFile('o.txt', 'short');
        assert.equal(await text(disk, 'o.txt'), 'short');
      });
      test('multi-byte text and a few MiB survive a round trip', async (disk) => {
        const big = Buffer.alloc(3 * 1024 * 1024 + 17, 'xyz');
        await put(disk, 'big.bin', big);
        assert.equal((await disk.readFile('big.bin')).equals(big), true);
        await disk.writeFile('ü.txt', '日本語 ✓');
        assert.equal(await disk.readFile('ü.txt', 'utf8'), '日本語 ✓');
      });
      test('an unknown encoding is rejected (ERR_INVALID_ARG_VALUE)', async (disk) => {
        await put(disk, 'a.txt', 'x');
        await rejectsWith(disk.readFile('a.txt', 'nope' as any), 'ERR_INVALID_ARG_VALUE');
        await rejectsWith(disk.writeFile('b.txt', 'x', 'nope' as any), 'ERR_INVALID_ARG_VALUE');
      });
      test('a missing file: ENOENT', async (disk) => {
        await rejectsWith(disk.readFile('missing.txt'), 'ENOENT');
        await rejectsWith(disk.readFile('missing.txt', 'utf8'), 'ENOENT');
      });
      test('a folder: EISDIR', async (disk) => {
        await put(disk, 'd/f.txt', 'x');
        await disk.mkdir('empty');
        await rejectsWith(disk.readFile('d'), 'EISDIR');
        await rejectsWith(disk.readFile('empty'), 'EISDIR');
      });
    },
  },
  {
    name: 'stat',
    description: 'stat of files and folders, the fs.Stats shape, ENOENT',
    define(test) {
      test('stats a file', async (disk) => {
        await disk.writeFile('d.txt', 'hello');
        const st = await disk.stat('d.txt');
        assert.equal(st.isFile(), true);
        assert.equal(st.isDirectory(), false);
        assert.equal(st.isSymbolicLink(), false);
        assert.equal(st.size, 5);
        assert.equal(types.isDate(st.mtime), true);
        assert.equal(Number.isFinite(st.mtimeMs), true);
      });
      test('stats a folder (explicit, nested and implicit)', async (disk) => {
        await disk.mkdir('mk/sub');
        await put(disk, 'mk/sub/f.txt', 'x');
        await put(disk, 'imp/deep/f.txt', 'x');
        for (const p of ['mk', 'mk/sub', 'imp', 'imp/deep']) {
          const st = await disk.stat(p);
          assert.equal(st.isDirectory(), true, `${p} is a directory`);
          assert.equal(st.isFile(), false, `${p} is not a file`);
        }
      });
      test('exposes every fs.Stats key', async (disk) => {
        await disk.writeFile('d.txt', 'hello');
        const st = await disk.stat('d.txt');
        for (const key of [
          'dev',
          'ino',
          'mode',
          'nlink',
          'uid',
          'gid',
          'rdev',
          'size',
          'blksize',
          'blocks',
          'atimeMs',
          'mtimeMs',
          'ctimeMs',
          'birthtimeMs',
          'atime',
          'mtime',
          'ctime',
          'birthtime',
        ]) {
          assert.ok(key in st, `stat() has ${key}`);
        }
        for (const method of ['isBlockDevice', 'isCharacterDevice', 'isFIFO', 'isSocket']) {
          assert.equal(typeof (st as any)[method], 'function', `stat() has ${method}()`);
        }
      });
      test('a missing path: ENOENT', async (disk) => {
        await rejectsWith(disk.stat('nope/zzz'), 'ENOENT');
        await rejectsWith(disk.stat('nope'), 'ENOENT');
      });
    },
  },
  {
    name: 'exists',
    description: 'exists for files, folders (also implicit ones) and missing paths',
    define(test) {
      test('is true for files and folders, false for anything else', async (disk) => {
        await put(disk, 'imp/deep/f.txt', 'x');
        await disk.mkdir('explicit');
        assert.equal(await disk.exists('imp/deep/f.txt'), true);
        assert.equal(await disk.exists('imp/deep'), true);
        assert.equal(await disk.exists('imp'), true);
        assert.equal(await disk.exists('explicit'), true);
        assert.equal(await disk.exists('imp/de'), false);
        assert.equal(await disk.exists('im'), false);
        assert.equal(await disk.exists('missing.txt'), false);
        assert.equal(await disk.exists('imp/deep/f.txt/x'), false);
      });
    },
  },
  {
    name: 'rm',
    description: 'rm of files and folders: recursive, force, ERR_FS_EISDIR, ENOENT',
    define(test) {
      async function seed(disk: StorageDisk) {
        await disk.mkdir('fo/sub');
        await put(disk, 'fo/sub/x.txt', 'x');
        await put(disk, 'fo/y.txt', 'y');
        await put(disk, 'fo2/keep.txt', 'k');
        await put(disk, 'implicit/deep/z.txt', 'z');
      }
      test('removes a file', async (disk) => {
        await put(disk, 'a.txt', 'x');
        await put(disk, 'b.txt', 'y');
        await disk.rm('a.txt');
        assert.equal(await disk.exists('a.txt'), false);
        assert.equal(await disk.exists('b.txt'), true);
      });
      test('a folder without recursive: ERR_FS_EISDIR, nothing is deleted', async (disk) => {
        await seed(disk);
        for (const p of ['fo', 'implicit']) {
          const error = await rejectsWith(disk.rm(p), 'ERR_FS_EISDIR');
          assert.ok(String(error.message).includes('Path is a directory'));
        }
        assert.equal(await disk.exists('fo/y.txt'), true);
        assert.equal(await disk.exists('implicit/deep/z.txt'), true);
      });
      test('a folder with recursive deletes everything below it, but not siblings', async (disk) => {
        await seed(disk);
        await disk.rm('fo', { recursive: true });
        await disk.rm('implicit', { recursive: true });
        assert.equal(await disk.exists('fo'), false);
        assert.equal(await disk.exists('fo/sub/x.txt'), false);
        assert.equal(await disk.exists('implicit'), false);
        assert.equal(await disk.exists('fo2/keep.txt'), true);
      });
      test('a file with recursive; a missing path: ENOENT, or nothing with force', async (disk) => {
        await put(disk, 'a.txt', 'x');
        await disk.rm('a.txt', { recursive: true });
        assert.equal(await disk.exists('a.txt'), false);
        await rejectsWith(disk.rm('a.txt'), 'ENOENT');
        await rejectsWith(disk.rm('a.txt', { recursive: true }), 'ENOENT');
        await disk.rm('a.txt', { force: true });
        await disk.rm('a.txt', { force: true, recursive: true });
      });
    },
  },
  {
    name: 'rmdir',
    description: 'rmdir (recursive by default, like rm recursive), ENOTEMPTY, ENOTDIR, ENOENT',
    define(test) {
      test('is recursive by default and keeps the siblings', async (disk) => {
        await put(disk, 'd/sub/f.txt', 'x');
        await put(disk, 'd2/keep.txt', 'k');
        await disk.rmdir('d');
        assert.equal(await disk.exists('d'), false);
        assert.equal(await disk.exists('d/sub/f.txt'), false);
        assert.equal(await disk.exists('d2/keep.txt'), true);
      });
      test('removes a file by default, like fs.rm(path, { recursive: true })', async (disk) => {
        await put(disk, 'f.txt', 'x');
        await disk.rmdir('f.txt');
        assert.equal(await disk.exists('f.txt'), false);
      });
      test('a missing path: ENOENT, recursive or not', async (disk) => {
        await rejectsWith(disk.rmdir('nope'), 'ENOENT');
        await rejectsWith(disk.rmdir('nope', { recursive: false }), 'ENOENT');
      });
      test('recursive: false: ENOTEMPTY for a non-empty folder, ENOTDIR for a file, removes an empty folder', async (disk) => {
        await put(disk, 'd/f.txt', 'x');
        await disk.mkdir('e');
        await rejectsWith(disk.rmdir('d', { recursive: false }), 'ENOTEMPTY');
        await rejectsWith(disk.rmdir('d/f.txt', { recursive: false }), 'ENOTDIR');
        assert.equal(await disk.exists('d/f.txt'), true);
        await disk.rmdir('e', { recursive: false });
        assert.equal(await disk.exists('e'), false);
      });
      test('recursive: false on a folder whose content was removed', async (disk) => {
        await put(disk, 'd/f.txt', 'x');
        await disk.rm('d/f.txt');
        await disk.rmdir('d', { recursive: false });
        assert.equal(await disk.exists('d'), false);
      });
    },
  },
  {
    name: 'copyFile',
    description: 'copyFile: overwriting, COPYFILE_EXCL, ENOENT, EISDIR, copying onto itself',
    define(test) {
      test('copies a file and keeps the source', async (disk) => {
        await put(disk, 'c1.txt', 'one');
        await disk.copyFile('c1.txt', 'c2.txt');
        assert.equal(await text(disk, 'c2.txt'), 'one');
        assert.equal(await text(disk, 'c1.txt'), 'one');
      });
      test('copies the bytes unchanged, into another folder', async (disk) => {
        const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => 255 - i));
        await put(disk, 'src/a.bin', bytes);
        await disk.mkdir('dst');
        await disk.copyFile('src/a.bin', 'dst/b.bin');
        sameBytes(await disk.readFile('dst/b.bin'), bytes);
      });
      test('overwrites an existing destination', async (disk) => {
        await put(disk, 'c1.txt', 'one');
        await put(disk, 'c2.txt', 'two');
        await disk.copyFile('c1.txt', 'c2.txt');
        assert.equal(await text(disk, 'c2.txt'), 'one');
      });
      test('COPYFILE_EXCL: EEXIST onto an existing file, fine onto a new one', async (disk) => {
        await put(disk, 'c1.txt', 'one');
        await put(disk, 'c2.txt', 'two');
        await rejectsWith(disk.copyFile('c1.txt', 'c2.txt', fs.constants.COPYFILE_EXCL), 'EEXIST');
        assert.equal(await text(disk, 'c2.txt'), 'two');
        await disk.copyFile('c1.txt', 'c4.txt', fs.constants.COPYFILE_EXCL);
        assert.equal(await text(disk, 'c4.txt'), 'one');
      });
      test('onto itself: a no-op, or EEXIST with COPYFILE_EXCL', async (disk) => {
        await put(disk, 'a.txt', 'x');
        await disk.copyFile('a.txt', 'a.txt');
        assert.equal(await text(disk, 'a.txt'), 'x');
        await rejectsWith(disk.copyFile('a.txt', 'a.txt', fs.constants.COPYFILE_EXCL), 'EEXIST');
        assert.equal(await text(disk, 'a.txt'), 'x');
      });
      test('a missing source: ENOENT', async (disk) => {
        await rejectsWith(disk.copyFile('nope.txt', 'x.txt'), 'ENOENT');
        assert.equal(await disk.exists('x.txt'), false);
      });
      test('a folder as source: EISDIR', async (disk) => {
        await put(disk, 't/a.txt', 'a');
        await rejectsWith(disk.copyFile('t', 'x.txt'), 'EISDIR');
      });
      test('an existing folder as destination: EISDIR, and the folder is untouched', async (disk) => {
        await put(disk, 'c1.txt', 'one');
        await put(disk, 'dir/keep.txt', 'k');
        await rejectsWith(disk.copyFile('c1.txt', 'dir'), 'EISDIR');
        assert.equal(await text(disk, 'dir/keep.txt'), 'k');
        sameMembers(await disk.readdir('dir'), ['keep.txt']);
      });
      test('names with spaces and non-ASCII characters', async (disk) => {
        await put(disk, 'a b/ü.txt', 'üü');
        await disk.copyFile('a b/ü.txt', 'a b/ö copy+1 (2).txt');
        assert.equal(await text(disk, 'a b/ö copy+1 (2).txt'), 'üü');
        sameMembers(await disk.readdir('a b'), ['ö copy+1 (2).txt', 'ü.txt']);
      });
    },
  },
  {
    name: 'rename',
    description: 'rename of files: overwriting, onto itself, EISDIR, ENOENT',
    define(test) {
      test('renames a file', async (disk) => {
        await put(disk, 'r1.txt', 'r1');
        await disk.rename('r1.txt', 'r2.txt');
        assert.equal(await disk.exists('r1.txt'), false);
        assert.equal(await text(disk, 'r2.txt'), 'r1');
      });
      test('moves a file into a folder and overwrites an existing file', async (disk) => {
        await disk.mkdir('rd');
        await put(disk, 'r2.txt', 'r2');
        await disk.rename('r2.txt', 'rd/r2.txt');
        sameMembers(await disk.readdir('rd'), ['r2.txt']);
        await put(disk, 'r5.txt', 'new');
        await disk.rename('r5.txt', 'rd/r2.txt');
        assert.equal(await text(disk, 'rd/r2.txt'), 'new');
        assert.equal(await disk.exists('r5.txt'), false);
      });
      test('renaming onto itself is a no-op', async (disk) => {
        await put(disk, 'c1.txt', 'one');
        await disk.rename('c1.txt', 'c1.txt');
        assert.equal(await text(disk, 'c1.txt'), 'one');
      });
      test('a file onto a folder: EISDIR, nothing changes', async (disk) => {
        await put(disk, 'c1.txt', 'one');
        await disk.mkdir('rd');
        await rejectsWith(disk.rename('c1.txt', 'rd'), 'EISDIR');
        assert.equal(await text(disk, 'c1.txt'), 'one');
      });
      test('names with spaces and non-ASCII characters', async (disk) => {
        await put(disk, 'a b/ü.txt', 'üü');
        await disk.rename('a b/ü.txt', 'a b/ß ü.txt');
        sameMembers(await disk.readdir('a b'), ['ß ü.txt']);
        assert.equal(await text(disk, 'a b/ß ü.txt'), 'üü');
      });
      test('a missing source: ENOENT', async (disk) => {
        await rejectsWith(disk.rename('nope', 'nope2'), 'ENOENT');
      });
    },
  },
  {
    name: 'rename-folder',
    description: 'rename of folders: nested content, EINVAL, ENOTEMPTY, ENOTDIR, onto an empty folder',
    define(test) {
      async function seed(disk: StorageDisk) {
        await disk.mkdir('fo/sub');
        await disk.writeFile('fo/sub/x.txt', 'x');
        await disk.writeFile('fo/y.txt', 'y');
        await disk.mkdir('par');
      }
      test('moves a folder with its nested content', async (disk) => {
        await seed(disk);
        await disk.rename('fo', 'par/fo2');
        sameMembers(await disk.readdir('par', { recursive: true }), ['fo2', 'fo2/sub', 'fo2/sub/x.txt', 'fo2/y.txt']);
        assert.equal(await text(disk, 'par/fo2/sub/x.txt'), 'x');
        assert.equal(await disk.exists('fo'), false);
        await rejectsWith(disk.stat('fo'), 'ENOENT');
      });
      test('renames a folder next to its siblings', async (disk) => {
        await seed(disk);
        await put(disk, 'fo2/keep.txt', 'k');
        await disk.rename('fo', 'renamed');
        sameMembers(await disk.readdir(''), ['fo2', 'par', 'renamed']);
        assert.equal(await text(disk, 'fo2/keep.txt'), 'k');
      });
      test('into itself: EINVAL', async (disk) => {
        await seed(disk);
        await rejectsWith(disk.rename('fo', 'fo/sub/inner'), 'EINVAL');
        assert.equal(await text(disk, 'fo/y.txt'), 'y');
      });
      test('onto a non-empty folder: ENOTEMPTY', async (disk) => {
        await seed(disk);
        await put(disk, 'ne/k/z.txt', 'z');
        await rejectsWith(disk.rename('fo', 'ne'), 'ENOTEMPTY');
        assert.equal(await text(disk, 'fo/y.txt'), 'y');
      });
      test('onto a file: ENOTDIR', async (disk) => {
        await seed(disk);
        await put(disk, 'c1.txt', 'one');
        await rejectsWith(disk.rename('fo', 'c1.txt'), 'ENOTDIR');
        assert.equal(await text(disk, 'c1.txt'), 'one');
      });
      test('onto an empty folder', async (disk) => {
        await seed(disk);
        await disk.mkdir('emp');
        await disk.rename('fo', 'emp');
        sameMembers(await disk.readdir('emp', { recursive: true }), ['sub', 'sub/x.txt', 'y.txt']);
        assert.equal(await disk.exists('fo'), false);
      });
    },
  },
  {
    name: 'streams',
    description: 'createReadStream and createWriteStream (also through the disk fallbacks when the driver has none)',
    define(test) {
      test('createReadStream reads the whole file, also an empty one', async (disk) => {
        await put(disk, 's.txt', 'abcdefghij');
        await put(disk, 'e.txt', '');
        assert.equal((await collect(disk.createReadStream('s.txt'))).toString(), 'abcdefghij');
        assert.equal((await collect(disk.createReadStream('e.txt'))).length, 0);
      });
      test('createReadStream honours start and end (inclusive)', async (disk) => {
        await put(disk, 's.txt', 'abcdefghij');
        assert.equal((await collect(disk.createReadStream('s.txt', { start: 2, end: 5 }))).toString(), 'cdef');
        assert.equal((await collect(disk.createReadStream('s.txt', { start: 7 }))).toString(), 'hij');
        assert.equal((await collect(disk.createReadStream('s.txt', { end: 3 }))).toString(), 'abcd');
      });
      test('createReadStream honours the encoding and highWaterMark', async (disk) => {
        await put(disk, 's.txt', 'stream of text');
        const chunks: unknown[] = [];
        for await (const chunk of disk.createReadStream('s.txt', { encoding: 'utf8', highWaterMark: 4 })) {
          chunks.push(chunk);
        }
        assert.equal(
          chunks.every((chunk) => typeof chunk === 'string'),
          true,
        );
        assert.equal(chunks.join(''), 'stream of text');
      });
      test('createReadStream of a missing file emits ENOENT as an error event', async (disk) => {
        await rejectsWith(collect(disk.createReadStream('missing.txt')), 'ENOENT');
      });
      test('createReadStream rejects start > end synchronously (ERR_OUT_OF_RANGE)', async (disk) => {
        assert.throws(() => disk.createReadStream('a.txt', { start: 5, end: 1 }), { code: 'ERR_OUT_OF_RANGE' });
      });
      test('createWriteStream writes a file; finish is emitted once, after the file is complete', async (disk) => {
        const stream = disk.createWriteStream('w.txt');
        let finishes = 0;
        let seen: Promise<string> | undefined;
        await new Promise<void>((resolve, reject) => {
          stream.on('error', reject);
          stream.on('finish', () => {
            finishes++;
            seen = text(disk, 'w.txt');
          });
          stream.on('close', () => resolve());
          stream.write('hello ');
          stream.end('world');
        });
        assert.equal(finishes, 1);
        assert.equal(await seen, 'hello world');
        assert.equal(await text(disk, 'w.txt'), 'hello world');
      });
      test('createWriteStream: binary chunks, many of them, and an empty stream', async (disk) => {
        const chunk = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
        const chunks = Array.from({ length: 40 }, () => chunk);
        await writeThrough(disk, 'bin.dat', chunks);
        sameBytes(await disk.readFile('bin.dat'), Buffer.concat(chunks));
        await new Promise<void>((resolve, reject) => {
          const stream = disk.createWriteStream('empty.dat');
          stream.on('error', reject).on('finish', () => resolve());
          stream.end();
        });
        assert.equal((await disk.stat('empty.dat')).size, 0);
      });
      test('createWriteStream decodes string chunks with the encoding, and accepts fs options', async (disk) => {
        await writeThrough(disk, 'hex.txt', ['6865', '6c6c6f'], { encoding: 'hex', highWaterMark: 1024 });
        assert.equal(await text(disk, 'hex.txt'), 'hello');
      });
      test('createWriteStream replaces an existing file', async (disk) => {
        await put(disk, 'w.txt', 'a long previous content');
        await writeThrough(disk, 'w.txt', ['new']);
        assert.equal(await text(disk, 'w.txt'), 'new');
      });
      test('pipes a read stream into a write stream', async (disk) => {
        await put(disk, 'src.txt', 'piped content');
        await new Promise<void>((resolve, reject) => {
          const out = disk.createWriteStream('dst.txt');
          out.on('error', reject).on('finish', () => resolve());
          disk.createReadStream('src.txt').on('error', reject).pipe(out);
        });
        assert.equal(await text(disk, 'dst.txt'), 'piped content');
        assert.equal(await text(disk, 'src.txt'), 'piped content');
      });
    },
  },
];

export const GROUP_NAMES = GROUPS.map((group) => group.name);
