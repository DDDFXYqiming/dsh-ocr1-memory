# Start a llama-server backend for dsh-ocr1-memory.
# Usage: powershell -File scripts/start-ocr-server.ps1 -ModelDir <model-dir> [-Server <llama-server>] [-Port 18080]
param(
  [string]$ModelDir = $env:OCR_MODEL_DIR,
  [string]$Server = $env:OCR_SERVER_PATH,
  [int]$Port = 18080,
  [int]$ContextSize = 8192
)

if ([string]::IsNullOrWhiteSpace($ModelDir)) {
  throw 'ModelDir is required (pass -ModelDir or set OCR_MODEL_DIR)'
}

$serverPath = $Server
if ([string]::IsNullOrWhiteSpace($serverPath)) {
  $command = Get-Command llama-server -ErrorAction SilentlyContinue
  if ($null -ne $command) { $serverPath = $command.Source }
}
if ([string]::IsNullOrWhiteSpace($serverPath) -or -not (Test-Path $serverPath)) {
  throw 'llama-server not found (pass -Server, set OCR_SERVER_PATH, or add it to PATH)'
}

$model = Join-Path $ModelDir 'deepseek-ocr-Q4_K_M.gguf'
$mmproj = Join-Path $ModelDir 'mmproj-deepseek-ocr-q8_0.gguf'
if (-not (Test-Path $model)) { throw "model not found: $model" }
if (-not (Test-Path $mmproj)) { throw "mmproj not found: $mmproj" }

# One combined server serves both OCR (/v1/chat/completions) and embeddings
# (/v1/embeddings); --embeddings --pooling mean is always enabled.
$args = @('--host', '127.0.0.1', '--port', [string]$Port, '-m', $model, '--mmproj', $mmproj, '--alias', 'deepseek-ocr', '-c', [string]$ContextSize, '-np', '1', '-n', '1024', '--embeddings', '--pooling', 'mean', '-b', '2048', '-ub', '2048')
Write-Host "Starting DeepSeek-OCR llama-server on port $Port using $serverPath"
& $serverPath @args
