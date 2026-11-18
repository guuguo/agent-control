param(
  [string]$Port = $(if ($env:PORT) { $env:PORT } else { "43310" }),
  [string]$AppVersion = $(if ($env:AGENT_CONTROL_APP_VERSION) { $env:AGENT_CONTROL_APP_VERSION } else { "0.1.0" }),
  [string]$BuildHash = $(if ($env:AGENT_CONTROL_BUILD_HASH) { $env:AGENT_CONTROL_BUILD_HASH } else { "" }),
  [string]$InstallDir = $(if ($env:AGENT_CONTROL_APP_INSTALL_DIR) { $env:AGENT_CONTROL_APP_INSTALL_DIR } else { "" })
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = (Resolve-Path (Join-Path $ScriptDir "..\..")).Path
$LocalBase = if ($InstallDir) { $InstallDir } elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "AgentControl" } else { Join-Path $HOME "AppData\Local\AgentControl" }

New-Item -ItemType Directory -Force -Path $LocalBase | Out-Null

$Url = "http://127.0.0.1:$Port"
$CmdPath = Join-Path $LocalBase "agent-control-desktop.cmd"
$VbsPath = Join-Path $LocalBase "agent-control-desktop.vbs"
$MetaPath = Join-Path $LocalBase "desktop-meta.json"

$CmdLines = @(
  "@echo off",
  "setlocal",
  "set ""URL=$Url""",
  "for %%P in (",
  "  ""%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe""",
  "  ""%ProgramFiles%\Microsoft\Edge\Application\msedge.exe""",
  "  ""%LocalAppData%\Microsoft\Edge\Application\msedge.exe""",
  ") do (",
  "  if exist %%P (",
  "    start """" %%P --app=""%URL%""",
  "    exit /b 0",
  "  )",
  ")",
  "for %%P in (",
  "  ""%ProgramFiles%\Google\Chrome\Application\chrome.exe""",
  "  ""%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe""",
  "  ""%LocalAppData%\Google\Chrome\Application\chrome.exe""",
  ") do (",
  "  if exist %%P (",
  "    start """" %%P --app=""%URL%""",
  "    exit /b 0",
  "  )",
  ")",
  "start """" ""%URL%"""
)
Set-Content -Path $CmdPath -Value ($CmdLines -join "`r`n") -Encoding ASCII

$VbsContent = "Set WshShell = CreateObject(""WScript.Shell"")`r`nWshShell.Run """"""$CmdPath"""""", 0, False"
Set-Content -Path $VbsPath -Value $VbsContent -Encoding ASCII

$StartMenuDir = if ($env:APPDATA) { Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs" } else { Join-Path $HOME "AppData\Roaming\Microsoft\Windows\Start Menu\Programs" }
$DesktopDir = [Environment]::GetFolderPath("Desktop")

$EdgeIcon = $null
foreach ($candidate in @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles}\Microsoft\Edge\Application\msedge.exe"
)) {
  if ($candidate -and (Test-Path $candidate)) {
    $EdgeIcon = "$candidate,0"
    break
  }
}

$WshShell = New-Object -ComObject WScript.Shell
foreach ($dir in @($StartMenuDir, $DesktopDir)) {
  if (-not $dir) { continue }
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $LnkPath = Join-Path $dir "Agent Control.lnk"
  $Shortcut = $WshShell.CreateShortcut($LnkPath)
  $Shortcut.TargetPath = "$env:SystemRoot\System32\wscript.exe"
  $Shortcut.Arguments = """$VbsPath"""
  $Shortcut.WorkingDirectory = $RootDir
  $Shortcut.Description = "Agent Control Desktop Console"
  if ($EdgeIcon) { $Shortcut.IconLocation = $EdgeIcon }
  $Shortcut.Save()
}

$MetaObj = [ordered]@{
  version = $AppVersion
  buildHash = $BuildHash
  repoRoot = $RootDir
  appPath = (Join-Path $StartMenuDir "Agent Control.lnk")
  launcherPath = $CmdPath
  platform = "win32"
  updatedAt = (Get-Date).ToString("o")
}
$MetaObj | ConvertTo-Json -Depth 4 | Set-Content -Path $MetaPath -Encoding UTF8

Write-Host "已安装 Windows 桌面 App 入口: $(Join-Path $StartMenuDir 'Agent Control.lnk')"
