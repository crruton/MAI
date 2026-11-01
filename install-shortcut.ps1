# Создаёт ярлык «MAI Code» на рабочем столе.
# Запуск: powershell -ExecutionPolicy Bypass -File .\install-shortcut.ps1

$ErrorActionPreference = 'Stop'

$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $appDir 'node_modules\electron\dist\electron.exe'
$icon = Join-Path $appDir 'assets\icon.ico'

if (-not (Test-Path $exe)) {
  throw "Не найден electron.exe. Сначала выполните: npm.cmd install"
}

$desktop = [Environment]::GetFolderPath('Desktop')
$linkPath = Join-Path $desktop 'MAI Code.lnk'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($linkPath)
$shortcut.TargetPath = $exe
$shortcut.Arguments = '.'
$shortcut.WorkingDirectory = $appDir
$shortcut.Description = 'MAI Code — агент для вайбкодинга на моделях MAI'
$shortcut.WindowStyle = 1
if (Test-Path $icon) { $shortcut.IconLocation = $icon }
$shortcut.Save()

Write-Host "Ярлык создан: $linkPath"
Write-Host "Приложение:    $appDir"
