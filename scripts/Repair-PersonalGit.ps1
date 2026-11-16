[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-RepoGit {
    param([Parameter(Mandatory = $true)][string[]]$GitArguments)
    $result = @(& git -C $repoRoot @GitArguments)
    if ($LASTEXITCODE -ne 0) {
        throw "Git command failed: $($GitArguments[0]). Stopped; no later steps were run."
    }
    return $result
}

function Invoke-RefTransaction {
    param(
        [Parameter(Mandatory = $true)][string]$Directory,
        [Parameter(Mandatory = $true)][string]$Transaction
    )
    # Windows PowerShell adds CRLF when piping strings to native processes.
    # Git's update-ref protocol requires LF-delimited commands, including the final line.
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $gitExecutable = @(Get-Command git -CommandType Application)[0].Source
    $startInfo.FileName = $gitExecutable
    $startInfo.Arguments = 'update-ref --stdin'
    $startInfo.WorkingDirectory = $Directory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $gitProcess = New-Object System.Diagnostics.Process
    $gitProcess.StartInfo = $startInfo
    try {
        if (-not $gitProcess.Start()) { throw 'Could not start the Git transaction.' }
        $payload = $Transaction.Replace("`r", '').TrimEnd([char]10) + "`n"
        $gitProcess.StandardInput.Write($payload)
        $gitProcess.StandardInput.Close()
        $standardOutput = $gitProcess.StandardOutput.ReadToEnd()
        $standardError = $gitProcess.StandardError.ReadToEnd()
        $gitProcess.WaitForExit()
        if ($gitProcess.ExitCode -ne 0) {
            throw "Atomic local branch update failed. No push was attempted. $($standardError.Trim())"
        }
        Write-Host $standardOutput.TrimEnd()
    } finally {
        $gitProcess.Dispose()
    }
}

# This repair is intentionally restricted to the observed HuvAI repository and graph.
$origin = (Invoke-RepoGit -GitArguments @('remote', 'get-url', 'origin')) -join ''
if ($origin -notmatch '^https://(?:Huvashen@)?github\.com/Huvashen/HuvAI(?:\.git)?/?$') {
    throw 'Origin is not Huvashen/HuvAI. Refusing to change another repository.'
}
$trackedChanges = Invoke-RepoGit -GitArguments @('status', '--porcelain', '--untracked-files=no')
if ($trackedChanges.Count -gt 0) {
    throw 'Commit or preserve tracked changes first. This repair requires a clean tracked working tree.'
}
$activeBranch = (Invoke-RepoGit -GitArguments @('branch', '--show-current')) -join ''
if ($activeBranch -ne 'feature/desktop-shell') {
    throw 'Expected feature/desktop-shell. Switch to that branch before running this repair.'
}
$mainBefore = (Invoke-RepoGit -GitArguments @('rev-parse', 'refs/heads/main')) -join ''
$oldFeature = (Invoke-RepoGit -GitArguments @('rev-parse', 'refs/heads/feature/chatgpt-feasibility')) -join ''
$oldDev = (Invoke-RepoGit -GitArguments @('rev-parse', 'refs/heads/dev')) -join ''
$desktop = (Invoke-RepoGit -GitArguments @('rev-parse', 'refs/heads/feature/desktop-shell')) -join ''
$featureParents = (Invoke-RepoGit -GitArguments @('show', '-s', '--format=%P', $oldFeature)) -join ''
$devParents = (Invoke-RepoGit -GitArguments @('show', '-s', '--format=%P', $oldDev)) -join ''
if ($desktop -ne $oldDev -or $featureParents -ne $mainBefore -or $devParents -ne "$mainBefore $oldFeature") {
    throw 'Branch history has changed since inspection. Refusing to rewrite unexpected commits.'
}

# Use the existing personal email from this repo's original GitHub-authored commit.
$personalEmail = (Invoke-RepoGit -GitArguments @('show', '-s', '--format=%ae', $mainBefore)) -join ''
if ($personalEmail -ne 'gramanihuvashen@icloud.com') {
    throw 'The original personal email differs from the inspected value. Review before changing identity.'
}
Invoke-RepoGit -GitArguments @('config', '--local', 'user.name', 'Huvashen') | Out-Null
Invoke-RepoGit -GitArguments @('config', '--local', 'user.email', $personalEmail) | Out-Null
Invoke-RepoGit -GitArguments @('config', '--local', 'credential.https://github.com.username', 'Huvashen') | Out-Null
Invoke-RepoGit -GitArguments @('config', '--local', 'credential.https://github.com.useHttpPath', 'true') | Out-Null
Invoke-RepoGit -GitArguments @('config', '--local', 'credential.gitHubAccountFiltering', 'true') | Out-Null
Write-Host "Repository author set to Huvashen <$personalEmail>. Global Git settings were not changed."
Write-Host 'Using the Huvashen sign-in. If prompted, choose Huvashen in the browser. Keep the work account connected for work repositories.'
Invoke-RepoGit -GitArguments @('credential-manager', 'github', 'login', '--username', 'Huvashen', '--browser') | Out-Host

$remoteBranches = Invoke-RepoGit -GitArguments @('ls-remote', '--heads', 'origin',
    'refs/heads/feature/chatgpt-feasibility', 'refs/heads/dev', 'refs/heads/feature/desktop-shell')
if ($remoteBranches.Count -gt 0) {
    throw 'An affected branch already exists on GitHub. Stopped before rewriting history; review the remote branches first.'
}

# Recreate the exact same trees/messages with the corrected author AND committer.
# This preserves the merge topology, working files, and all main history.
$featureTree = (Invoke-RepoGit -GitArguments @('rev-parse', "$oldFeature`^{tree}")) -join ''
$devTree = (Invoke-RepoGit -GitArguments @('rev-parse', "$oldDev`^{tree}")) -join ''
$featureMessage = (Invoke-RepoGit -GitArguments @('show', '-s', '--format=%B', $oldFeature)) -join "`n"
$devMessage = (Invoke-RepoGit -GitArguments @('show', '-s', '--format=%B', $oldDev)) -join "`n"
$newFeature = (Invoke-RepoGit -GitArguments @('commit-tree', $featureTree, '-p', $mainBefore, '-m', $featureMessage)) -join ''
$newDev = (Invoke-RepoGit -GitArguments @('commit-tree', $devTree, '-p', $mainBefore, '-p', $newFeature, '-m', $devMessage)) -join ''
foreach ($newCommit in @($newFeature, $newDev)) {
    $identity = (Invoke-RepoGit -GitArguments @('show', '-s', '--format=%an <%ae>|%cn <%ce>', $newCommit)) -join ''
    if ($identity -ne "Huvashen <$personalEmail>|Huvashen <$personalEmail>") {
        throw 'An environment override prevented the personal author/committer identity. Stopped before changing branches.'
    }
}
$backupRoot = 'refs/huvai-identity-backup/' + [Guid]::NewGuid().ToString('N')
$transaction = @(
    'start'
    "create $backupRoot/feasibility $oldFeature"
    "create $backupRoot/integration $oldDev"
    "update refs/heads/feature/chatgpt-feasibility $newFeature $oldFeature"
    "update refs/heads/dev $newDev $oldDev"
    "update refs/heads/feature/desktop-shell $newDev $desktop"
    'prepare'
    'commit'
) -join "`n"
Invoke-RefTransaction -Directory $repoRoot -Transaction $transaction
$mainAfter = (Invoke-RepoGit -GitArguments @('rev-parse', 'refs/heads/main')) -join ''
if ($mainAfter -ne $mainBefore) { throw 'Main changed unexpectedly. Stopped before push.' }
Invoke-RepoGit -GitArguments @('log', '-2', '--format=%h | author=%an <%ae> | committer=%cn <%ce>') | Out-Host

# Publish only these three branches. No force-push, no main refspec, all-or-nothing remote update.
Invoke-RepoGit -GitArguments @('push', '--atomic', 'origin',
    'refs/heads/feature/chatgpt-feasibility:refs/heads/feature/chatgpt-feasibility',
    'refs/heads/dev:refs/heads/dev',
    'refs/heads/feature/desktop-shell:refs/heads/feature/desktop-shell') | Out-Host
foreach ($branch in @('feature/chatgpt-feasibility', 'dev', 'feature/desktop-shell')) {
    Invoke-RepoGit -GitArguments @('branch', "--set-upstream-to=origin/$branch", $branch) | Out-Null
}
Write-Host 'Personal author and GitHub access repaired; feature branches and dev published. Main was unchanged.'
Write-Host "Original local commits remain recoverable under $backupRoot."
