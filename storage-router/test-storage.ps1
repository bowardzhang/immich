$ErrorActionPreference = 'Stop'

$RouterUrl = if ($env:STORAGE_ROUTER_URL) { $env:STORAGE_ROUTER_URL.TrimEnd('/') } else { 'https://storage-router-production.up.railway.app' }
$Token = $env:REMOTE_STORAGE_TOKEN

if ([string]::IsNullOrWhiteSpace($Token)) {
    throw 'REMOTE_STORAGE_TOKEN environment variable is required. The token is never stored in this repository.'
}

$TestPath = "router-integration-test/$([guid]::NewGuid().ToString()).txt"
$Body = "Immich Storage Router integration test - $([guid]::NewGuid())"
$Headers = @{ Authorization = "Bearer $Token" }
$Uri = "$RouterUrl/api/file?path=$([uri]::EscapeDataString($TestPath))"

function Assert-Status($Actual, $Expected, $Step) {
    if ($Actual -ne $Expected) {
        throw "$Step failed: expected HTTP $Expected, got HTTP $Actual"
    }
}

try {
    Write-Host "Storage Router: $RouterUrl"
    Write-Host "Test path: $TestPath"

    # PUT
    $put = Invoke-WebRequest -Uri $Uri -Method Put -Headers $Headers -ContentType 'text/plain' -Body $Body -UseBasicParsing
    Assert-Status $put.StatusCode 200 'PUT'
    Write-Host '[PASS] PUT'

    # HEAD
    $head = Invoke-WebRequest -Uri $Uri -Method Head -Headers $Headers -UseBasicParsing
    Assert-Status $head.StatusCode 200 'HEAD'
    $expectedLength = [Text.Encoding]::UTF8.GetByteCount($Body)
    if ([int64]$head.Headers['Content-Length'] -ne $expectedLength) {
        throw "HEAD failed: expected Content-Length $expectedLength, got $($head.Headers['Content-Length'])"
    }
    Write-Host "[PASS] HEAD (Content-Length=$expectedLength)"

    # GET
    $get = Invoke-WebRequest -Uri $Uri -Method Get -Headers $Headers -UseBasicParsing
    Assert-Status $get.StatusCode 200 'GET'
    if ($get.Content -ne $Body) {
        throw "GET failed: response body does not match PUT body"
    }
    Write-Host '[PASS] GET (content matches)'

    # DELETE
    $delete = Invoke-WebRequest -Uri $Uri -Method Delete -Headers $Headers -UseBasicParsing
    Assert-Status $delete.StatusCode 200 'DELETE'
    Write-Host '[PASS] DELETE'

    # Verify deletion with HEAD. PowerShell may throw on 404, so capture it explicitly.
    try {
        Invoke-WebRequest -Uri $Uri -Method Head -Headers $Headers -UseBasicParsing | Out-Null
        throw 'HEAD-after-DELETE unexpectedly returned success'
    }
    catch {
        if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) {
            Write-Host '[PASS] HEAD after DELETE (404)'
        }
        else {
            throw
        }
    }

    Write-Host ''
    Write-Host 'ALL STORAGE ROUTER TESTS PASSED' -ForegroundColor Green
}
finally {
    # Best-effort cleanup in case a test failed after PUT.
    try {
        Invoke-WebRequest -Uri $Uri -Method Delete -Headers $Headers -UseBasicParsing -ErrorAction SilentlyContinue | Out-Null
    }
    catch {
        # Ignore cleanup errors; preserve the original test failure.
    }
}
