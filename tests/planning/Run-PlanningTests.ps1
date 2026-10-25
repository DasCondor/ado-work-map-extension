<#
.SYNOPSIS
    Run the Sprint planning save tests in headless Edge against a fake Azure DevOps (no real connection).

.DESCRIPTION
    Builds azure-devops-extension\dist (no .vsix), copies it to a temp folder with the fake SDK and fake
    REST layer swapped in, serves it on localhost and runs test.html. Prints each check; exits 1 on a failure.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tests\planning\Run-PlanningTests.ps1
#>
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent (Split-Path -Parent $here)
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'azure-devops-extension\build.ps1') -NoPackage | Out-Null
$site = Join-Path ([IO.Path]::GetTempPath()) ('adomap_plantest_' + [guid]::NewGuid().ToString('N'))
Copy-Item (Join-Path $repo 'azure-devops-extension\dist') $site -Recurse
Copy-Item (Join-Path $here 'fake-sdk.js') (Join-Path $site 'sdk\SDK.min.js') -Force
Copy-Item (Join-Path $here 'fake-ado.js'), (Join-Path $here 'test.html') $site
$page = Join-Path $site 'planning.html'
$html = [IO.File]::ReadAllText($page)
$at = $html.IndexOf('<script src="planning-app.js">'); if ($at -lt 0) { throw 'planning.html changed: planning-app.js script tag not found' }
[IO.File]::WriteAllText($page, $html.Insert($at, '<script src="fake-ado.js"></script>'), (New-Object Text.UTF8Encoding $false))

$port = 8798
$server = Start-Job -ArgumentList $site, $port -ScriptBlock {
    param($root, $port)
    $l = New-Object Net.HttpListener; $l.Prefixes.Add("http://localhost:$port/"); $l.Start()
    $types = @{ '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript'; '.css' = 'text/css'; '.png' = 'image/png' }
    while ($true) {
        $ctx = $l.GetContext(); $f = Join-Path $root ([uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/'))
        if (Test-Path $f -PathType Leaf) { $b = [IO.File]::ReadAllBytes($f); $ctx.Response.ContentType = $types[[IO.Path]::GetExtension($f)] }
        else { $ctx.Response.StatusCode = 404; $b = [byte[]]@() }
        $ctx.Response.OutputStream.Write($b, 0, $b.Length); $ctx.Response.Close()
    }
}
try {
    Start-Sleep -Milliseconds 800
    $edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $edge) { throw 'Microsoft Edge not found' }
    $profile = Join-Path $site 'edge-profile'
    $ErrorActionPreference = 'Continue'   # Edge writes harmless noise to stderr
    $dom =& $edge --headless=new --disable-gpu --no-first-run "--user-data-dir=$profile" --virtual-time-budget=60000 --dump-dom "http://localhost:$port/test.html" 2>$null | Out-String
    $m = [regex]::Match($dom, '<pre id="out">([\s\S]*?)</pre>')
    $text = [Net.WebUtility]::HtmlDecode($m.Groups[1].Value)
    Write-Host $text
    if (-not $m.Success -or $text -notmatch 'All passed') { exit 1 }
}
finally {
    Stop-Job $server -ErrorAction SilentlyContinue; Remove-Job $server -Force -ErrorAction SilentlyContinue
    Remove-Item $site -Recurse -Force -ErrorAction SilentlyContinue
}
