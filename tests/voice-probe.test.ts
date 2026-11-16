import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { WINDOWS_VOICE_PROBE_SCRIPT } from '../src/integrations/voice/windows-probe.ts';

test('Windows voice helper passes PowerShell syntax validation without opening audio devices', { skip: process.platform !== 'win32' }, async () => {
  const parser = '$tokens=$null; $parseErrors=$null; [System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$tokens, [ref]$parseErrors) | Out-Null; if ($parseErrors.Count -gt 0) { exit 1 } else { exit 0 }';
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', parser],
    { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  const timer = setTimeout(() => child.kill(), 10_000);
  try {
    await new Promise<void>((resolve, reject) => {
      child.on('error', reject); child.stdin.on('error', reject);
      child.on('close', code => { try { assert.equal(code, 0); resolve(); } catch (error) { reject(error); } });
      child.stdin.end(WINDOWS_VOICE_PROBE_SCRIPT);
    });
  } finally { clearTimeout(timer); }
});
