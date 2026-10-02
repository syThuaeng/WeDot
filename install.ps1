$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'dist\cli.js'))) { throw 'Missing dist/cli.js. Run npm ci and npm run build first.' }
$codexCommand = Get-Command codex.exe -ErrorAction SilentlyContinue
if ($codexCommand) {
    $codexExe = $codexCommand.Source
} else {
    $codexBin = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    $codexExe = Get-ChildItem -LiteralPath $codexBin -Directory |
        ForEach-Object { Join-Path $_.FullName 'codex.exe' } |
        Where-Object { Test-Path -LiteralPath $_ } |
        Sort-Object { (Get-Item -LiteralPath $_).LastWriteTime } -Descending |
        Select-Object -First 1
}
if (-not $codexExe) { throw 'Codex executable was not found. Install and sign into Codex first.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 22.12 or newer is required.' }
$marketRoot = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\plugin-sources\wedot-local'
$pluginTarget = Join-Path $marketRoot 'plugins\wedot'
$catalogDir = Join-Path $marketRoot '.agents\plugins'
New-Item -ItemType Directory -Force -Path $pluginTarget, $catalogDir | Out-Null
if ([IO.Path]::GetFullPath($PSScriptRoot) -ne [IO.Path]::GetFullPath($pluginTarget)) {
    Get-ChildItem -LiteralPath $PSScriptRoot -Force |
        Where-Object { $_.Name -in @('plugin.json', '.codex-plugin', 'skills', 'assets', 'dist', 'README.md', 'THIRD-PARTY-NOTICES.md', 'package.json', 'install.ps1') } |
        Copy-Item -Destination $pluginTarget -Recurse -Force
}
$catalog = @{
    name = 'wedot-local'
    interface = @{ displayName = 'WeDot Local' }
    plugins = @(@{
        name = 'wedot'
        source = @{ source = 'local'; path = './plugins/wedot' }
        policy = @{ installation = 'AVAILABLE'; authentication = 'ON_INSTALL' }
        category = 'Productivity'
    })
}
$catalog | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $catalogDir 'marketplace.json') -Encoding utf8
& $codexExe plugin marketplace add $marketRoot
if ($LASTEXITCODE -ne 0) { throw 'Marketplace registration failed.' }
& $codexExe plugin add 'wedot@wedot-local'
if ($LASTEXITCODE -ne 0) { throw 'Plugin installation failed.' }
Write-Output 'Installed. Open a new Codex chat and ask to connect WeDot.'
