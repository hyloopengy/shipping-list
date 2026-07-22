#!/bin/sh
set -eu

cd "$(dirname "$0")"
umask 077
mkdir -p backups
stamp=$(date +%Y%m%d-%H%M%S)
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > "backups/packing-$stamp.sql.gz"
find backups -type f -name 'packing-*.sql.gz' -mtime +14 -delete
echo "备份完成：backups/packing-$stamp.sql.gz"
