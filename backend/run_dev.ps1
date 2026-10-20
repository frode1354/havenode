# Only watch app/ — never tmp/deploys/**/.venv (uv sync would thrash --reload and kill kickoffs)
Set-Location $PSScriptRoot
& python -m uvicorn app.main:app --host 127.0.0.1 --port 8777 --reload --reload-dir app
