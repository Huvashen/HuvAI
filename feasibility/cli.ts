import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { readFile, writeFile } from 'node:fs/promises';
import { discover, request, RESOURCE } from '../src/integrations/openai/http.ts';
import { signIn, type Session } from '../src/integrations/openai/oauth.ts';
import { proveInference } from '../src/integrations/openai/responses.ts';
import { WindowsVault } from '../src/storage/windows-vault.ts';
import { JarvisError, safeFailure } from '../src/shared/errors.ts';
import { PLAN_SCOPES } from '../src/security/cost-guard.ts';
import { proveCodex } from '../src/integrations/codex/probe.ts';
import { proveWindowsVoice } from '../src/integrations/voice/windows-probe.ts';

const args = process.argv.slice(2);
const command = args[0] ?? 'help';
const vault = new WindowsVault(resolve('.jarvis'));
const proofPath = resolve(vault.directory, 'last-inference-proof.json');
const codexProofPath = resolve(vault.directory, 'last-codex-proof.json');
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());

async function openBrowser(url: string): Promise<void> {
  // URL goes over stdin, never through shell interpolation or diagnostic output.
  const script = '$ErrorActionPreference="Stop"; $target=[Console]::In.ReadToEnd(); Start-Process -FilePath $target';
  await new Promise<void>((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    const failure = () => reject(new JarvisError('BROWSER_FAILED', 'Could not open the system browser.'));
    child.on('error', failure); child.stdin.on('error', failure);
    child.on('close', code => code === 0 ? resolve() : failure());
    child.stdin.end(url);
  });
}

async function preflight() {
  console.log('Phase 0: connectivity only; no credentials or inference requests.');
  let failed = false;
  if (process.platform !== 'win32') { console.log('BLOCKED: Windows 11 target environment required.'); failed = true; }
  for (const [label, check] of [
    ['OpenAI identity discovery', () => discover()],
    ['OpenAI API connectivity', () => request(`${RESOURCE}/models`)
      .catch(error => { if (error instanceof JarvisError && error.code === 'AUTH_REQUIRED') return; throw error; })],
    ['GitHub DNS', () => lookup('github.com')],
  ] as const) {
    try { await check(); console.log(`PASS: ${label}`); }
    catch (error) { console.log(`BLOCKED: ${label} — ${safeFailure(error)}`); failed = true; }
  }
  console.log('Live OAuth, plan entitlement, Codex turn, and microphone quality remain unverified.');
  if (failed) process.exitCode = 1;
}

try {
  if (command === 'preflight') await preflight();
  else if (command === 'login') {
    await vault.withLock(async () => {
      const previous = await vault.load<Session>();
      console.log('Continue with ChatGPT in your system browser. This starts a temporary loopback callback.');
      const session = await signIn(await vault.hostId(), openBrowser, previous, controller.signal);
      await vault.save(session);
      console.log('Identity verified and protected with Windows DPAPI. Inference has NOT been verified.');
      console.log('Before running prove, disable JARVIS credit usage in https://chatgpt.com/settings/usage');
    });
  } else if (command === 'prove' || command === 'codex') {
    await vault.withLock(async () => {
      const session = await vault.load<Session>();
      if (!session) throw new JarvisError('AUTH_REQUIRED', 'Run npm run feasibility -- login first.');
      let model: string;
      if (command === 'codex') {
        const previous = await readFile(proofPath, 'utf8').then(text => JSON.parse(text)).catch(() => undefined);
        if (previous?.outcome !== 'completed' || typeof previous.model !== 'string') {
          throw new JarvisError('DIRECT_PROOF_REQUIRED', 'Complete the direct inference probe before testing Codex.');
        }
        model = previous.model;
        await proveCodex(process.cwd(), session, model, args.includes('--plan-only-confirmed'),
          text => process.stdout.write(text), controller.signal);
        console.log(`\nPASS: completed plan-backed Codex app-server turn using ${model}.`);
      } else {
        model = await proveInference(session, args.includes('--plan-only-confirmed'),
          text => process.stdout.write(text), controller.signal);
        console.log(`\nPASS: completed plan-backed text response using ${model}.`);
      }
      // Only historical, non-secret evidence. This never enables subsequent spending.
      await writeFile(command === 'codex' ? codexProofPath : proofPath, JSON.stringify({ schemaVersion: 1, model,
        completedAt: new Date().toISOString(), outcome: 'completed',
        creditSpending: 'owner-confirmed-disabled', route: command === 'codex' ? 'codex-app-server/stdio' : `${RESOURCE}/responses`,
      }, null, 2) + '\n', { mode: 0o600 }).catch(() => {
        throw new JarvisError('EVIDENCE_SAVE_FAILED', 'Inference completed, but its local result could not be saved.');
      });
      console.log(command === 'codex' ? 'Codex inference verified. Local voice feasibility remains a separate check.'
        : 'Gate remains pending until Codex app-server and voice feasibility are also verified.');
    });
  } else if (command === 'voice') {
    console.log('Local voice probe: speakers will play prompts; the default microphone listens briefly for Hey Jarvis, then a test sentence.');
    console.log('No audio or transcript is saved or uploaded. Press Ctrl+C to stop.');
    await vault.withLock(async () => {
      const result = await proveWindowsVoice(controller.signal);
      await writeFile(resolve(vault.directory, 'last-voice-proof.json'), JSON.stringify({
        schemaVersion: 1, completedAt: new Date().toISOString(), ...result,
      }, null, 2) + '\n');
      console.log('PASS: local wake phrase, dictation and speech-output API calls completed.');
      console.log('Confirm that you heard the spoken prompts. Continuous-listening accuracy and resource benchmarks remain pending.');
    });
  } else if (command === 'status') {
    await vault.withLock(async () => {
      const session = await vault.load<Session>();
      console.log(session ? `Saved identity: yes. Session ${session.expiresAt > Date.now() ? 'unexpired' : 'expired; sign in again'}.`
        : 'No saved session.');
      console.log(`Plan permissions: ${session && PLAN_SCOPES.every(scope => session.scopes.includes(scope)) ? 'granted' : 'not granted'}.`);
      for (const [label, path] of [['Direct response', proofPath], ['Codex', codexProofPath]]) {
        const proof = await readFile(path, 'utf8').then(text => JSON.parse(text)).catch(() => undefined);
        const validProof = proof?.schemaVersion === 1 && proof?.outcome === 'completed'
          && typeof proof.model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,100}$/.test(proof.model)
          && typeof proof.completedAt === 'string' && !Number.isNaN(Date.parse(proof.completedAt));
        console.log(validProof ? `${label}: ${proof.model} completed at ${new Date(proof.completedAt).toISOString()} (historical evidence).`
          : `${label}: no saved completed proof.`);
      }
      const voice = await readFile(resolve(vault.directory, 'last-voice-proof.json'), 'utf8')
        .then(text => JSON.parse(text)).catch(() => undefined);
      console.log(voice?.success === true && voice?.wakeDetected === true && voice?.dictationDetected === true
        && voice?.speechOutputCompleted === true
        ? 'Voice: local API checks completed; audible output and sustained accuracy still need human verification.'
        : 'Voice: no saved completed probe.');
      console.log('Phase 0 is not automatically passed by sign-in or model catalog availability.');
    });
  } else {
    console.log('JARVIS Phase 0 (Node 24+, Windows)\n'
      + 'npm run preflight\n'
      + 'npm run feasibility -- login\n'
      + 'npm run feasibility -- status\n'
      + 'npm run feasibility -- prove --plan-only-confirmed\n'
      + 'npm run feasibility -- codex --plan-only-confirmed\n'
      + 'npm run feasibility -- voice\n'
      + 'Only use the confirmation flag after disabling credit spending in ChatGPT usage settings.\n'
      + 'No API-key fallback, auto top-up, repository access or shell tools are provided.');
    if (command !== 'help') process.exitCode = 1;
  }
} catch (error) { console.error(safeFailure(error)); process.exitCode = 1; }
