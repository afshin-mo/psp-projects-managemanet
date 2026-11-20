<#
 بکاپ روزانه‌ی PostgreSQL + پوشه‌ی storage (فایل‌های آپلود/خروجی) با نگهداری N روز.
 زمان‌بندی (Task Scheduler، هر شب ۰۲:۰۰):
   schtasks /Create /TN "POS Backup" /SC DAILY /ST 02:00 /RU SYSTEM /TR "powershell -ExecutionPolicy Bypass -File C:\pos\deploy\windows\backup.ps1"
 رمز دیتابیس: متغیر محیطی PGPASSWORD (سیستمی) یا فایل pgpass.conf.
#>
param(
  [string]$PgBin = "C:\Program Files\PostgreSQL\16\bin",
  [string]$Db = "pos_support",
  [string]$DbUser = "pos_app",
  [string]$DbHost = "localhost",
  [string]$StorageDir = "C:\pos\storage",
  [string]$BackupDir = "D:\backups\pos",
  [int]$KeepDays = 14
)
$ErrorActionPreference = "Stop"
$stamp = Get-Date -Format "yyyyMMdd-HHmm"
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

$dump = Join-Path $BackupDir "pos-$stamp.dump"
& (Join-Path $PgBin "pg_dump.exe") -h $DbHost -U $DbUser --format=custom --compress=6 --file=$dump $Db
if ($LASTEXITCODE -ne 0 -or (Get-Item $dump).Length -eq 0) { throw "pg_dump failed" }

if (Test-Path $StorageDir) {
  Compress-Archive -Path "$StorageDir\*" -DestinationPath (Join-Path $BackupDir "storage-$stamp.zip") -Force
}
Get-ChildItem $BackupDir -File | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) } | Remove-Item -Force
Write-Host "backup ok: $dump"
