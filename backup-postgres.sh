#!/bin/sh
set -eu

cd "$(dirname "$0")"
umask 077
mkdir -p backups
# The app container mounts this directory read-only and runs as an
# unprivileged user, so directory traversal and file reads must be allowed.
chmod 755 backups
stamp=$(date +%Y%m%d-%H%M%S)
target="backups/packing-$stamp.sql.gz"
temp="backups/packing-$stamp.sql.tmp"
trap 'rm -f "$temp"' EXIT
if [ -f .env ]; then
  docker compose --env-file .env exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$temp"
elif [ -f .env.local ]; then
  docker compose --env-file .env.local exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$temp"
else
  docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$temp"
fi
test -s "$temp"
gzip -c "$temp" > "$target"
chmod 644 "$target"
find backups -type f -name 'packing-*.sql.gz' -mtime +6 -delete
echo "备份完成：$target"
