param(
  [Parameter(Mandatory = $true)][ValidateSet('install', 'remove', 'query')][string]$Mode,
  [string]$TaskName = 'MiniTicker_AutoOpen',
  [string]$StartTime = '09:25',
  [string]$ScriptPath = ''
)

# Keep this file ASCII-only: Windows PowerShell 5.1 decodes BOM-less files as ANSI.

$ErrorActionPreference = 'Stop'

try {
  switch ($Mode) {
    'query' {
      $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      if ($t) { Write-Output 'INSTALLED' } else { Write-Output 'MISSING' }
    }
    'install' {
      if ([string]::IsNullOrWhiteSpace($ScriptPath)) { throw 'ScriptPath is required' }
      $arg = '/c ""' + $ScriptPath + '""'
      $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $arg
      $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday -At $StartTime
      $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
      Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
        -Description 'Desktop ticker: start on trading day open' -Force | Out-Null
      Write-Output 'OK'
    }
    'remove' {
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
      Write-Output 'OK'
    }
  }
}
catch {
  Write-Output ('ERR: ' + $_.Exception.Message)
  exit 1
}
