import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { WindowsVault } from '../src/storage/windows-vault.ts';

// The app sandbox redirects OS temp outside the granted writable roots.
const fixtureRoot = resolve('.jarvis', 'test-fixtures');
async function fixture(prefix: string) {
  await mkdir(fixtureRoot, { recursive: true });
  return mkdtemp(join(fixtureRoot, prefix));
}

async function cleanup(directory: string) {
  const target = resolve(directory);
  assert.equal(dirname(target), fixtureRoot);
  assert.match(basename(target), /^jarvis-(vault|dpapi)-test-/);
  await rm(target, { recursive: true, force: true });
}

test('host ID persists; concurrent access is refused; locks release after failure', async () => {
  const directory = await fixture('jarvis-vault-test-');
  const vault = new WindowsVault(directory);
  try {
    await vault.withLock(async () => {
      const first = await vault.hostId();
      assert.equal(first, await vault.hostId());
      assert.match(first, /^urn:uuid:/);
      await assert.rejects(vault.withLock(async () => {}), { code: 'SESSION_LOCKED' });
    });
    await assert.rejects(vault.withLock(async () => { throw new Error('simulated failure'); }));
    await vault.withLock(async () => { assert.equal(await vault.load(), undefined); });
  } finally { await cleanup(directory); }
});

test('Windows DPAPI stores ciphertext and survives a fresh vault instance', { skip: process.platform !== 'win32' }, async () => {
  const directory = await fixture('jarvis-dpapi-test-');
  try {
    const vault = new WindowsVault(directory);
    await vault.withLock(async () => { await vault.save({ fakeToken: 'test-only-not-a-real-credential' }); });
    const ciphertext = await readFile(join(directory, 'credentials.dpapi'), 'utf8');
    assert.ok(!ciphertext.includes('test-only'));
    const restored = new WindowsVault(directory);
    await restored.withLock(async () => {
      assert.deepEqual(await restored.load(), { fakeToken: 'test-only-not-a-real-credential' });
      await restored.save({ fakeToken: 'rotated-test-credential' });
      assert.deepEqual(await restored.load(), { fakeToken: 'rotated-test-credential' });
    });
  } finally { await cleanup(directory); }
});
