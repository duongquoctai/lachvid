#!/bin/bash
set -e

echo "Starting Python FastAPI backend on port 3006..."
uvicorn backend.main:app --host 0.0.0.0 --port 3006 &

sleep 2

APP_PORT=${PORT:-3005}
echo "Starting Next.js frontend on port $APP_PORT..."
exec node_modules/.bin/next start -p "$APP_PORT" -H 0.0.0.0