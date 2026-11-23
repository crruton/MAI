# Проверка установщика на чистом Windows-раннере (F25, ADR 0095).
#
# 1. Тихая установка NSIS-установщика в отдельную папку.
# 2. Файлы и ярлыки на месте.
# 3. `MAI Code.exe --self-check` без Node.js в PATH: ресурсы asar, модули,
#    папка данных, cmd.exe, DPAPI, системные корневые сертификаты.
# 4. То же для portable-версии.
# 5. Тихое удаление: папка и ярлыки исчезают.
#
# Запуск: pwsh scripts/check-installer.ps1 [-Dist dist]
param([string]$Dist = 'dist')

$ErrorActionPreference = 'Stop'
$failed = @()
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { Write-Host "  OK   $name" } else { Write-Host "  FAIL $name $detail"; $script:failed += $name }
}

$setup = Get-ChildItem $Dist -Filter 'MAI Code-*-x64.exe' | Select-Object -First 1
$portable = Get-ChildItem $Dist -Filter 'MAI Code-*-portable.exe' | Select-Object -First 1
Check 'установщик NSIS собран' ($null -ne $setup) "в $Dist нет MAI Code-*-x64.exe"
Check 'portable собран' ($null -ne $portable) "в $Dist нет MAI Code-*-portable.exe"
if (-not $setup) { throw 'Нет установщика' }

# Чистая машина: Node.js из PATH убираем — приложение должно жить на встроенном.
$cleanPath = ($env:PATH -split ';' | Where-Object { $_ -and -not (Test-Path (Join-Path $_ 'node.exe')) }) -join ';'

function Invoke-SelfCheck([string]$exe, [string]$label) {
  $out = Join-Path $env:RUNNER_TEMP "self-check-$label.json"
  Remove-Item $out -ErrorAction SilentlyContinue
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.Arguments = "--self-check=`"$out`""
  $psi.UseShellExecute = $false
  $psi.EnvironmentVariables['PATH'] = $cleanPath
  $psi.EnvironmentVariables.Remove('NODE_OPTIONS')
  $p = [System.Diagnostics.Process]::Start($psi)
  if (-not $p.WaitForExit(180000)) { Stop-Process -Id $p.Id -Force; Check "${label}: самопроверка завершилась" $false 'зависла 3 минуты'; return }
  # portable распаковывается и запускает приложение отдельным процессом: ждём отчёт.
  for ($i = 0; $i -lt 60 -and -not (Test-Path $out); $i++) { Start-Sleep -Seconds 2 }
  if (-not (Test-Path $out)) { Check "${label}: отчёт самопроверки" $false "нет $out (код $($p.ExitCode))"; return }
  $report = Get-Content $out -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($c in $report.checks) { Check "${label}: $($c.name)" ([bool]$c.ok) $c.detail }
  Check "${label}: итог самопроверки" ([bool]$report.ok) ($report.error)
}

Write-Host "== Node.js в PATH для проверки: $([bool](($cleanPath -split ';') | Where-Object { Test-Path (Join-Path $_ 'node.exe') }))"

Write-Host "== Установка $($setup.Name)"
$dir = Join-Path $env:RUNNER_TEMP 'mai-install'
# /D= — последний аргумент и без кавычек (правило NSIS).
$inst = Start-Process -FilePath $setup.FullName -ArgumentList '/S', "/D=$dir" -Wait -PassThru
Check 'установщик завершился без ошибки' ($inst.ExitCode -eq 0) "код $($inst.ExitCode)"
$exe = Join-Path $dir 'MAI Code.exe'
$uninstaller = Join-Path $dir 'Uninstall MAI Code.exe'
Check 'MAI Code.exe установлен' (Test-Path $exe) $exe
Check 'деинсталлятор на месте' (Test-Path $uninstaller) $uninstaller
Check 'ресурсы приложения (app.asar)' (Test-Path (Join-Path $dir 'resources\app.asar'))
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\MAI Code.lnk'
$desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) 'MAI Code.lnk'
Check 'ярлык в меню «Пуск»' (Test-Path $startMenu) $startMenu
Check 'ярлык на рабочем столе' (Test-Path $desktop) $desktop

Write-Host '== Самопроверка установленного приложения'
if (Test-Path $exe) { Invoke-SelfCheck $exe 'установленное' }

if ($portable) {
  Write-Host "== Самопроверка $($portable.Name)"
  Invoke-SelfCheck $portable.FullName 'portable'
}

Write-Host '== Удаление'
if (Test-Path $uninstaller) {
  Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait | Out-Null
  # Деинсталлятор NSIS копирует себя во временную папку и работает дальше там.
  for ($i = 0; $i -lt 30 -and (Test-Path $exe); $i++) { Start-Sleep -Seconds 2 }
  Check 'после удаления MAI Code.exe нет' (-not (Test-Path $exe))
  Check 'ярлык в меню «Пуск» удалён' (-not (Test-Path $startMenu))
  Check 'ярлык на рабочем столе удалён' (-not (Test-Path $desktop))
}

if ($failed.Count) { throw "Не прошли: $($failed -join '; ')" }
Write-Host 'Установщик: все проверки прошли'
