import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';

test('Windows Git repair uses exact LF transactions and rolls back a failed comparison', { skip: process.platform !== 'win32' }, async () => {
  const fixtureRoot = resolve('.jarvis/test-fixtures');
  await mkdir(fixtureRoot, { recursive: true });
  const directory = await mkdtemp(resolve(fixtureRoot, 'git-ref-test-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  function git(args: string[], input?: string) {
    const result = spawnSync('git', ['-C', directory, ...args], { input, encoding: 'utf8', env, windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout.trim();
  }
  // Extract only the helper definition; authentication, source-repo writes and pushes never run.
  const command = `
    $ErrorActionPreference='Stop'
    $payload=ConvertFrom-Json ([Console]::In.ReadToEnd())
    $tokens=$null; $parseErrors=$null
    $ast=[System.Management.Automation.Language.Parser]::ParseFile($payload.script,[ref]$tokens,[ref]$parseErrors)
    if($parseErrors.Count -gt 0){throw 'Script syntax failed'}
    $helper=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-RefTransaction'},$true)
    if($null -eq $helper){throw 'Transaction helper not found'}
    . ([scriptblock]::Create($helper.Extent.Text))
    Invoke-RefTransaction -Directory $payload.directory -Transaction $payload.transaction
  `;
  function transaction(text: string) {
    return spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      input: JSON.stringify({ script: resolve('scripts/Repair-PersonalGit.ps1'), directory, transaction: text }),
      encoding: 'utf8', windowsHide: true, timeout: 15000,
    });
  }
  try {
    git(['init', '--bare', '--initial-branch=fixture-root']);
    const tree = git(['mktree'], '');
    const oldCommit = git(['commit-tree', tree, '-m', 'Original fixture']);
    const newCommit = git(['commit-tree', tree, '-p', oldCommit, '-m', 'Updated fixture']);
    git(['update-ref', 'refs/heads/fixture-a', oldCommit]);
    git(['update-ref', 'refs/heads/fixture-b', oldCommit]);
    const success = transaction([
      'start', `create refs/fixture-backup/original ${oldCommit}`,
      `update refs/heads/fixture-a ${newCommit} ${oldCommit}`,
      `update refs/heads/fixture-b ${newCommit} ${oldCommit}`, 'prepare', 'commit',
    ].join('\r\n'));
    assert.equal(success.status, 0, success.stderr || success.error?.message);
    assert.equal(git(['rev-parse', 'refs/heads/fixture-a']), newCommit);
    assert.equal(git(['rev-parse', 'refs/heads/fixture-b']), newCommit);
    assert.equal(git(['rev-parse', 'refs/fixture-backup/original']), oldCommit);
    const failed = transaction([
      'start', `update refs/heads/fixture-a ${oldCommit} ${newCommit}`,
      // This comparison intentionally fails; neither branch may change.
      `update refs/heads/fixture-b ${oldCommit} ${oldCommit}`, 'prepare', 'commit',
    ].join('\n'));
    assert.notEqual(failed.status, 0);
    assert.equal(git(['rev-parse', 'refs/heads/fixture-a']), newCommit);
    assert.equal(git(['rev-parse', 'refs/heads/fixture-b']), newCommit);
  } finally {
    const target = resolve(directory);
    assert.equal(dirname(target), fixtureRoot);
    assert.match(basename(target), /^git-ref-test-/);
    await rm(target, { recursive: true, force: true });
  }
});
