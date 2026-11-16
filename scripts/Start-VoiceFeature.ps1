[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-ProjectGit {
    param([Parameter(Mandatory = $true)][string[]]$GitArguments)
    $result = @(& git -C $repoRoot @GitArguments)
    if ($LASTEXITCODE -ne 0) { throw "Git $($GitArguments[0]) failed. Stopped before subsequent steps." }
    return $result
}

$origin = (Invoke-ProjectGit -GitArguments @('remote','get-url','origin')) -join ''
if ($origin -notmatch '^https://(?:Huvashen@)?github\.com/Huvashen/HuvAI(?:\.git)?/?$') {
    throw 'Expected the Huvashen/HuvAI repository. No changes were made.'
}
$branch = (Invoke-ProjectGit -GitArguments @('branch','--show-current')) -join ''
if ($branch -eq 'feature/local-voice') { Write-Host 'Already on feature/local-voice. Ready for voice implementation.'; return }
if ($branch -ne 'feature/desktop-shell') { throw 'Expected feature/desktop-shell. Refusing to commit from another branch.' }
$author = (Invoke-ProjectGit -GitArguments @('config','user.name')) -join ''
$email = (Invoke-ProjectGit -GitArguments @('config','user.email')) -join ''
if ($author -ne 'Huvashen' -or $email -ne 'gramanihuvashen@icloud.com') {
    throw 'The repository personal author identity is not configured. Review it before committing.'
}
$staged = Invoke-ProjectGit -GitArguments @('diff','--cached','--name-only')
if ($staged.Count -gt 0) { throw 'There are already staged changes. Review those before running this checkpoint.' }
& git -C $repoRoot show-ref --verify --quiet refs/heads/feature/local-voice
if ($LASTEXITCODE -eq 0) { throw 'feature/local-voice already exists. Review it before creating a new branch.' }
if ($LASTEXITCODE -ne 1) { throw 'Could not inspect local voice branch state.' }
$mainBefore = (Invoke-ProjectGit -GitArguments @('rev-parse','refs/heads/main')) -join ''

Push-Location $repoRoot
try {
    & npm.cmd test
    if ($LASTEXITCODE -ne 0) { throw 'Tests failed. No commit or branch creation was attempted.' }
    & npm.cmd run typecheck
    if ($LASTEXITCODE -ne 0) { throw 'Type checking failed. No commit or branch creation was attempted.' }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed. No commit or branch creation was attempted.' }
} finally { Pop-Location }

# Explicit owned files only. Local app data and local editor/agent configuration are never staged.
$paths = @('.gitignore','AGENTS.md','README.md','angular.json','package.json','package-lock.json',
    'tsconfig.json','tsconfig.main.json','apps','docs/desktop-shell-status.md',
    'scripts/build-desktop.mjs','scripts/Repair-PersonalGit.ps1','scripts/Start-VoiceFeature.ps1',
    'src/integrations/openai/identity.ts','src/integrations/openai/responses.ts',
    'src/security/desktop-requests.ts','src/shared/desktop-contracts.ts','src/storage/desktop-store.ts',
    'tests/desktop.test.ts','tests/git-repair.test.ts')
Invoke-ProjectGit -GitArguments (@('add','--') + $paths) | Out-Host
& git -C $repoRoot diff --cached --quiet
if ($LASTEXITCODE -eq 1) {
    Invoke-ProjectGit -GitArguments @('commit','-m','feat: add verified desktop runtime and temporary testing console') | Out-Host
} elseif ($LASTEXITCODE -ne 0) { throw 'Could not inspect the staged checkpoint.' }
Invoke-ProjectGit -GitArguments @('push','-u','origin','feature/desktop-shell') | Out-Host
Invoke-ProjectGit -GitArguments @('switch','dev') | Out-Host
Invoke-ProjectGit -GitArguments @('merge','--no-ff','feature/desktop-shell','-m','Merge tested desktop runtime foundation') | Out-Host
Invoke-ProjectGit -GitArguments @('push','-u','origin','dev') | Out-Host
Invoke-ProjectGit -GitArguments @('switch','-c','feature/local-voice') | Out-Host
Invoke-ProjectGit -GitArguments @('push','-u','origin','feature/local-voice') | Out-Host
$mainAfter = (Invoke-ProjectGit -GitArguments @('rev-parse','refs/heads/main')) -join ''
if ($mainBefore -ne $mainAfter) { throw 'Main changed unexpectedly; inspect before continuing.' }
Write-Host 'Desktop runtime checkpointed and integrated into dev. feature/local-voice is active and published. Main was unchanged.'
