<#
 نصب API و Worker به‌صورت سرویس ویندوز با NSSM (https://nssm.cc).
 اجرا با PowerShell «Run as Administrator» از ریشه‌ی پروژه:
   .\deploy\windows\install-services.ps1 -NssmPath "C:\tools\nssm\win64\nssm.exe"
 پیش‌نیاز: npm ci ، npm run db:migrate ، npm run db:seed-periods ، npm run build:web ، و فایل .env آماده.
#>
param(
  [string]$NssmPath = "nssm.exe",
  [string]$ProjectDir = (Resolve-Path "$PSScriptRoot\..\..").Path,
  [string]$NodeExe = (Get-Command node.exe).Source
)
$ErrorActionPreference = "Stop"
$tsx = Join-Path $ProjectDir "node_modules\tsx\dist\cli.mjs"
$logs = Join-Path $ProjectDir "logs"
New-Item -ItemType Directory -Force -Path $logs | Out-Null

function Install-PosService([string]$Name, [string]$Entry, [string]$Display) {
  & $NssmPath stop $Name 2>$null | Out-Null
  & $NssmPath remove $Name confirm 2>$null | Out-Null
  & $NssmPath install $Name $NodeExe "`"$tsx`" --env-file=.env $Entry"
  & $NssmPath set $Name AppDirectory $ProjectDir
  & $NssmPath set $Name DisplayName $Display
  & $NssmPath set $Name Start SERVICE_AUTO_START
  & $NssmPath set $Name AppEnvironmentExtra "NODE_ENV=production"
  & $NssmPath set $Name AppStdout (Join-Path $logs "$Name.out.log")
  & $NssmPath set $Name AppStderr (Join-Path $logs "$Name.err.log")
  & $NssmPath set $Name AppRotateFiles 1
  & $NssmPath set $Name AppRotateOnline 1
  & $NssmPath set $Name AppRotateBytes 20971520
  & $NssmPath set $Name AppExit Default Restart
  & $NssmPath set $Name AppRestartDelay 5000
  & $NssmPath set $Name AppStopMethodConsole 15000   # فرصت خاموش شدن مرتب
  & $NssmPath start $Name
}

Install-PosService "pos-api"    "apps/api/src/server.ts"      "POS Support - API"
Install-PosService "pos-worker" "apps/worker/src/main.ts"     "POS Support - Worker"
Write-Host "سرویس‌ها نصب و اجرا شدند. وضعیت:  nssm status pos-api ; nssm status pos-worker"
