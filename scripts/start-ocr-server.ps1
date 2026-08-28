# Start llama-server with DeepSeek-OCR Q4_K_M for dsh-ocr1-memory (CPU/iGPU runtime).
# Usage: powershell -File scripts/start-ocr-server.ps1 -ModelDir <models>\deepseek-ocr-gguf [-Server <llama.cpp-cpu>\llama-server.exe] [-Port 18080]
param(
  [string]$ModelDir = $env:OCR1_MODEL_DIR,
  [string]$Server = $env:OCR1_LLAMA_SERVER,
  [int]$Port = 18080,
  [int]$ContextSize = 8192
)

# Runtime uses CPU/iGPU only: prefer the CPU-only llama.cpp build so the OCR
# runtime never touches the discrete GPU. Falls back to the Vulkan build only
# when the CPU build is absent. Set OCR1_LLAMA_SERVER/Server to override.
$defaultModelDir = 'D:\AI_Projects\models\deepseek-ocr-gguf'
$cpuServer = 'D:\AI_Projects\models\llama.cpp-cpu\llama-server.exe'
$gpuServer = 'D:\AI_Projects\models\llama.cpp\llama-server.exe'
$modelDir = if ([string]::IsNullOrWhiteSpace($ModelDir)) { $defaultModelDir } else { $ModelDir }
$server = if ([string]::IsNullOrWhiteSpace($Server)) { if (Test-Path $cpuServer) { $cpuServer } else { $gpuServer } } else { $Server }

$model = Join-Path $modelDir 'deepseek-ocr-Q4_K_M.gguf'
$mmproj = Join-Path $modelDir 'mmproj-deepseek-ocr-q8_0.gguf'

if (-not (Test-Path $server)) { throw "llama-server not found: $server" }
if (-not (Test-Path $model)) { throw "model not found: $model" }
if (-not (Test-Path $mmproj)) { throw "mmproj not found: $mmproj" }

# One combined server serves both OCR (/v1/chat/completions) and embeddings
# (/v1/embeddings); --embeddings --pooling mean is always enabled.
$args = @('--host', '127.0.0.1', '--port', [string]$Port, '-m', $model, '--mmproj', $mmproj, '--alias', 'deepseek-ocr', '-c', [string]$ContextSize, '-np', '1', '-n', '1024', '--embeddings', '--pooling', 'mean', '-b', '2048', '-ub', '2048')
Write-Host "Starting DeepSeek-OCR llama-server (runtime CPU/iGPU) on port $Port using $server"
& $server @args