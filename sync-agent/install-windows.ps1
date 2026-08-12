[CmdletBinding(DefaultParameterSetName = 'Installer')]
param(
    [Parameter(ParameterSetName = 'Register', Mandatory = $true)]
    [switch]$RegisterSchedule,

    [Parameter(ParameterSetName = 'Start', Mandatory = $true)]
    [switch]$StartSchedule,

    [Parameter(ParameterSetName = 'Unregister', Mandatory = $true)]
    [switch]$UnregisterSchedule,

    [Parameter(ParameterSetName = 'Register', Mandatory = $true)]
    [Parameter(ParameterSetName = 'Start', Mandatory = $true)]
    [Parameter(ParameterSetName = 'Unregister', Mandatory = $true)]
    [string]$InstallRoot,

    [Parameter(ParameterSetName = 'Register', Mandatory = $true)]
    [Parameter(ParameterSetName = 'Start', Mandatory = $true)]
    [Parameter(ParameterSetName = 'Unregister', Mandatory = $true)]
    [ValidatePattern('^LH2 Sync Agent -- [A-Za-z0-9_-]{1,64}$')]
    [string]$TaskName,

    [Parameter(ParameterSetName = 'Register', Mandatory = $true)]
    [ValidateRange(0, 29)]
    [int]$StartOffsetMinutes,

    [Parameter(ParameterSetName = 'Installer', ValueFromRemainingArguments = $true)]
    [string[]]$InstallerArgs
)

$ErrorActionPreference = 'Stop'
function Assert-InstallRoot {
    param([string]$Root)

    if (-not [System.IO.Path]::IsPathFullyQualified($Root)) {
        throw 'InstallRoot must be an absolute path.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Root 'agent.py') -PathType Leaf)) {
        throw 'agent.py is missing from InstallRoot.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Root 'run-sync.cmd') -PathType Leaf)) {
        throw 'run-sync.cmd is missing from InstallRoot.'
    }
}

try {
    if ($RegisterSchedule) {
        Assert-InstallRoot -Root $InstallRoot
        $runner = Join-Path $InstallRoot 'run-sync.cmd'
        $cmd = Join-Path $env:SystemRoot 'System32\cmd.exe'
        $taskArguments = '/d /s /c ""{0}""' -f $runner
        $action = New-ScheduledTaskAction `
            -Execute $cmd `
            -Argument $taskArguments `
            -WorkingDirectory $InstallRoot
        $trigger = New-ScheduledTaskTrigger `
            -Once `
            -At (Get-Date).AddMinutes(30 + $StartOffsetMinutes) `
            -RepetitionInterval (New-TimeSpan -Minutes 30)
        $settings = New-ScheduledTaskSettingsSet `
            -StartWhenAvailable `
            -MultipleInstances IgnoreNew `
            -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
            -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        $principal = New-ScheduledTaskPrincipal `
            -UserId $identity `
            -LogonType Interactive `
            -RunLevel Limited
        Register-ScheduledTask `
            -TaskName $TaskName `
            -Action $action `
            -Trigger $trigger `
            -Settings $settings `
            -Principal $principal `
            -Description 'Synchronizes Linked Helper data every 30 minutes' `
            -Force | Out-Null
        $registered = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        if ($registered.TaskName -ne $TaskName) {
            throw 'Task Scheduler did not return the registered task.'
        }
        exit 0
    }

    if ($StartSchedule) {
        Assert-InstallRoot -Root $InstallRoot
        Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        exit 0
    }

    if ($UnregisterSchedule) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
        exit 0
    }

    $installer = Join-Path $PSScriptRoot 'installer\install.py'
    if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
        throw 'The installer bundle is missing installer\install.py.'
    }

    $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($launcher) {
        & $launcher.Source -3 $installer @InstallerArgs
        exit $LASTEXITCODE
    }

    $python = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($python) {
        & $python.Source $installer @InstallerArgs
        exit $LASTEXITCODE
    }

    throw 'Python 3.10 or newer was not found. Install it from https://www.python.org/downloads/ and run this file again.'
}
catch {
    [Console]::Error.WriteLine("STOPPED: $($_.Exception.Message)")
    exit 2
}
