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

    # PUT: a new file may return 200 or 201.
    $put = Invoke-WebRequest -Uri $Uri -Method Put -Headers $Headers -ContentType 'text/plain' -Body $Body -UseBasicParsing
    if ($put.StatusCode -notin @(200, 201)) {
        throw "PUT failed: expected HTTP 200 or 201, got HTTP $($put.StatusCode)"
    }
    Write-Host "[PASS] PUT (HTTP $($put.StatusCode))"

    # HEAD
    $head = Invoke-WebRequest -Uri $Uri -Method Head -Headers $Headers -UseBasicParsing
    Assert-Status $head.StatusCode 200 'HEAD'
    $expectedLength = [Text.Encoding]::UTF8.GetByteCount($Body)
    $contentLengthHeader = @($head.Headers['Content-Length']) | Select-Object -First 1
    if ([int64]$contentLengthHeader -ne $expectedLength) {
        throw "HEAD failed: expected Content-Length $expectedLength, got $contentLengthHeader"
    }
    Write-Host "[PASS] HEAD (Content-Length=$expectedLength)"

    # GET
    $get = Invoke-WebRequest -Uri $Uri -Method Get -Headers $Headers -UseBasicParsing
    Assert-Status $get.StatusCode 200 'GET'
    if ($get.Content -ne $Body) {
        throw 'GET failed: response body does not match PUT body'
    }
    Write-Host '[PASS] GET (content matches)'

    # DELETE: both 200 and 204 are valid successful responses.
    $delete = Invoke-WebRequest -Uri $Uri -Method Delete -Headers $Headers -UseBasicParsing
    if ($delete.StatusCode -notin @(200, 204)) {
        throw "DELETE failed: expected HTTP 200 or 204, got HTTP $($delete.StatusCode)"
    }
    Write-Host "[PASS] DELETE (HTTP $($delete.StatusCode))"

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
