import { spawn } from 'node:child_process';
import { JarvisError } from '../../shared/errors.ts';

export const WINDOWS_VOICE_PROBE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$speaker = $null
$recognizer = $null
$stage = 'components'
try {
  Add-Type -AssemblyName System.Speech
  $speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $voices = @($speaker.GetInstalledVoices() | Where-Object { $_.Enabled })
  $recognizers = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Where-Object { $_.Culture.TwoLetterISOLanguageName -eq 'en' })
  if ($voices.Count -eq 0 -or $recognizers.Count -eq 0) { throw 'Components unavailable' }
  $speaker.SetOutputToDefaultAudioDevice()
  $info = $recognizers[0]
  $recognizer = New-Object System.Speech.Recognition.SpeechRecognitionEngine($info)
  $builder = New-Object System.Speech.Recognition.GrammarBuilder
  $builder.Culture = $info.Culture
  $builder.Append('Hey Jarvis')
  $grammar = New-Object System.Speech.Recognition.Grammar($builder)
  $recognizer.LoadGrammar($grammar)
  $recognizer.BabbleTimeout = [TimeSpan]::FromSeconds(10)
  $stage = 'output'
  $speaker.Speak('Ready. Say the wake phrase now.')
  $stage = 'microphone'
  $recognizer.SetInputToDefaultAudioDevice()
  $stage = 'wake'
  $wake = $recognizer.Recognize([TimeSpan]::FromSeconds(20))
  if ($null -eq $wake -or $wake.Text -ine 'Hey Jarvis' -or $wake.Confidence -lt 0.5) { throw 'Wake phrase not detected' }
  $recognizer.SetInputToNull()
  $recognizer.UnloadAllGrammars()
  $recognizer.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  $stage = 'output'
  $speaker.Speak('Wake phrase detected. Say: this is a local voice test.')
  $stage = 'dictation'
  $recognizer.SetInputToDefaultAudioDevice()
  $speech = $recognizer.Recognize([TimeSpan]::FromSeconds(20))
  if ($null -eq $speech -or [String]::IsNullOrWhiteSpace($speech.Text)) { throw 'Dictation not detected' }
  $recognizer.SetInputToNull()
  $stage = 'output'
  $speaker.Speak('Jarvis local voice check passed.')
  [Console]::Out.WriteLine(([pscustomobject]@{ success = $true; engine = 'Windows System.Speech'; culture = $info.Culture.Name; wakeDetected = $true; dictationDetected = $true; speechOutputCompleted = $true } | ConvertTo-Json -Compress))
} catch {
  [Console]::Out.WriteLine(([pscustomobject]@{ success = $false; stage = $stage } | ConvertTo-Json -Compress))
} finally {
  if ($null -ne $recognizer) { $recognizer.Dispose() }
  if ($null -ne $speaker) { $speaker.Dispose() }
}
`;

export interface VoiceProbeResult {
  success: true; engine: string; culture: string; wakeDetected: true;
  dictationDetected: true; speechOutputCompleted: true;
}

export async function proveWindowsVoice(signal?: AbortSignal): Promise<VoiceProbeResult> {
  if (process.platform !== 'win32') throw new JarvisError('WINDOWS_REQUIRED', 'Local voice probe requires Windows.');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_VOICE_PROBE_SCRIPT],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let cancelled = false;
    let timedOut = false;
    child.stderr.resume();
    const cancel = () => { cancelled = true; child.kill(); };
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 75_000);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.on('error', () => reject(new JarvisError('VOICE_START_FAILED', 'The Windows voice helper could not start.')));
    child.stdout.on('data', data => { output += data.toString(); if (output.length > 32000) child.kill(); });
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      if (cancelled || timedOut) {
        reject(new JarvisError(cancelled ? 'CANCELLED' : 'VOICE_TIMEOUT', 'Voice probe stopped and microphone capture ended.')); return;
      }
      let result;
      try { result = JSON.parse(output.trim()); } catch { /* Safe failure below; never expose raw system output. */ }
      if (code !== 0 || !result?.success || !result.wakeDetected || !result.dictationDetected || !result.speechOutputCompleted) {
        const stage = ['components', 'output', 'microphone', 'wake', 'dictation'].includes(result?.stage) ? result.stage : 'helper';
        reject(new JarvisError('VOICE_UNAVAILABLE', `Local voice check failed at ${stage}. No cloud audio or paid fallback was used.`)); return;
      }
      resolve(result);
    });
  });
}
