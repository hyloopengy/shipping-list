#!/bin/zsh
set -e
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "请先安装并启动 Docker Desktop。"
  read "?按回车退出..."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  open -a Docker
  echo "正在等待 Docker Desktop 启动..."
  for _ in {1..60}; do
    docker info >/dev/null 2>&1 && break
    sleep 1
  done
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker Desktop 尚未启动，请启动后重试。"
  read "?按回车退出..."
  exit 1
fi

if [ ! -f .env.local ]; then
  db_password=$(openssl rand -hex 24)
  secret_key=$(openssl rand -hex 32)
  {
    echo "POSTGRES_DB=packing"
    echo "POSTGRES_USER=packing"
    echo "POSTGRES_PASSWORD=$db_password"
    echo "SECRET_KEY=$secret_key"
    echo "SERVER_ADDRESS=localhost"
    echo "ALLOWED_CIDRS=127.0.0.1/32 ::1/128"
    echo "APP_BIND=127.0.0.1"
    echo "APP_PORT=8080"
    echo "COOKIE_SECURE=0"
    echo "PYTHON_IMAGE=docker.m.daocloud.io/library/python@sha256:57cd7c3a7a273101a6485ba99423ee568157882804b1124b4dd04266317710de"
    echo "POSTGRES_IMAGE=docker.m.daocloud.io/library/postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777"
    echo "CADDY_IMAGE=docker.m.daocloud.io/library/caddy@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d"
  } > .env.local
  chmod 600 .env.local
fi

docker compose --env-file .env.local up -d --build db app

if [ -f data/packing.db ] && [ ! -f .local-migration-done ]; then
  echo "正在把旧版 SQLite 数据迁移到本机 PostgreSQL..."
  docker compose --env-file .env.local cp data/packing.db app:/tmp/legacy-packing.db
  docker compose --env-file .env.local exec -T app python migrate_sqlite_to_postgres.py /tmp/legacy-packing.db
  if [ -d data/uploads ]; then
    docker compose --env-file .env.local exec -T app mkdir -p /app/data/uploads
    docker compose --env-file .env.local cp data/uploads/. app:/app/data/uploads/
  fi
  touch .local-migration-done
fi

for _ in {1..40}; do
  if curl -fsS http://127.0.0.1:8080 >/dev/null 2>&1; then
    open http://127.0.0.1:8080
    echo "发货清单已启动：http://127.0.0.1:8080"
    exit 0
  fi
  sleep 0.5
done

docker compose --env-file .env.local logs --tail=80 app
echo "启动失败，请保留以上错误信息。"
read "?按回车退出..."
exit 1
