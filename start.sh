#!/usr/bin/env bash
set -e

# Optional: show Python version
python --version

# If you stored your service account as base64 in env var SERVICE_ACCOUNT_JSON_B64,
# write it to disk before starting the app.
if [ -n "$SERVICE_ACCOUNT_JSON_B64" ]; then
  echo "$SERVICE_ACCOUNT_JSON_B64" | base64 -d > service_account.json
  export GDRIVE_SERVICE_ACCOUNT_FILE=./service_account.json
fi

# Start FastAPI (Render exposes $PORT)
exec uvicorn main:app --host 0.0.0.0 --port "${PORT:-8000}"
