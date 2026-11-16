import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { JarvisError } from '../shared/errors.ts';

// Fixed .NET interop command. No execution-policy change and no secret in arguments.
const DPAPI_COMMAND = `& {
  param([string]$Operation)
  $ErrorActionPreference = 'Stop'
  try {
    Add-Type -AssemblyName System.Security
    $incomingBytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
    $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    $entropy = [Text.Encoding]::UTF8.GetBytes('HuvAI.JARVIS.Phase0.v1')
    if ($Operation -eq 'protect') {
      $resultBytes = [System.Security.Cryptography.ProtectedData]::Protect($incomingBytes, $entropy, $scope)
    } else {
      $resultBytes = [System.Security.Cryptography.ProtectedData]::Unprotect($incomingBytes, $entropy, $scope)
    }
    [Console]::Out.Write([Convert]::ToBase64String($resultBytes))
    exit 0
  } catch { [Console]::Error.Write('Credential protection failed.'); exit 1 }
}`;

export async function protect(value: string, operation: 'protect' | 'unprotect'): Promise<string> {
  if (process.platform !== 'win32') throw new JarvisError('WINDOWS_REQUIRED', 'This prototype requires Windows credential protection.');
  if (!['protect', 'unprotect'].includes(operation)) throw new JarvisError('INVALID_OPERATION', 'Unsupported vault operation.');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${DPAPI_COMMAND} ${operation}`],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let tooLarge = false;
    const timer = setTimeout(() => { child.kill(); }, 15_000);
    const fail = () => reject(new JarvisError('SECURE_STORAGE_FAILED', 'Windows credential protection failed; no plaintext was saved.'));
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stdout.on('data', data => {
      output += data.toString();
      if (output.length > 2_000_000) { tooLarge = true; child.kill(); }
    });
    child.stderr.resume();
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || tooLarge || !output.trim()) { fail(); return; }
      resolve(output.trim());
    });
    child.stdin.end(value);
  });
}

async function atomicWrite(path: string, value: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

export class WindowsVault {
  directory: string;
  constructor(directory: string) { this.directory = directory; }

  async withLock<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    const lock = join(this.directory, 'session.lock');
    try { await writeFile(lock, String(process.pid), { flag: 'wx' }); }
    catch { throw new JarvisError('SESSION_LOCKED', 'Another feasibility process may be using this session.'); }
    try { return await action(); }
    finally { await unlink(lock); }
  }

  async hostId(): Promise<string> {
    const path = join(this.directory, 'host-id');
    let value: string;
    try { value = await readFile(path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      value = `urn:uuid:${randomUUID()}`;
      await writeFile(path, value, { flag: 'wx' });
    }
    if (!/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw new JarvisError('INVALID_HOST', 'The saved host identifier is invalid.');
    }
    return value;
  }

  async load<T>(): Promise<T | undefined> {
    let value;
    try { value = await readFile(join(this.directory, 'credentials.dpapi'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    try {
      return JSON.parse(Buffer.from(await protect(value, 'unprotect'), 'base64').toString('utf8'));
    } catch { throw new JarvisError('SECURE_STORAGE_FAILED', 'The saved session could not be decrypted.'); }
  }

  async save(value: unknown) {
    const encoded = Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
    const encrypted = await protect(encoded, 'protect');
    await atomicWrite(join(this.directory, 'credentials.dpapi'), encrypted);
  }
}
