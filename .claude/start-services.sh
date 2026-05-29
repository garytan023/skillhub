#!/bin/bash
set -euo pipefail

# Start PostgreSQL if not running
if ! pg_isready -p 5432 -q 2>/dev/null; then
  pg_ctlcluster 16 main start
  sleep 2
fi

# Create DB user/database if missing
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='skillhub'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER skillhub WITH PASSWORD 'skillhub';"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='skillhub'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE skillhub OWNER skillhub;"

# Start skillhub server if not already running
if ! pgrep -f "node /home/user/skillhub/server.js" > /dev/null; then
  export DATABASE_URL=postgres://skillhub:skillhub@127.0.0.1:5432/skillhub
  export HOST=0.0.0.0
  export PORT=4777
  nohup node /home/user/skillhub/server.js > /tmp/skillhub.log 2>&1 &
  echo "SkillHub started (PID=$!)"
else
  echo "SkillHub already running"
fi
