#!/usr/bin/env bash
# بکاپ روزانه‌ی PostgreSQL + storage با نگهداری N روز.
# crontab -e :   0 2 * * *  /opt/pos/deploy/linux/backup.sh >> /var/log/pos-backup.log 2>&1
# رمز: ~/.pgpass (chmod 600) یا PGPASSWORD
set -euo pipefail
DB="${DB:-pos_support}"; DB_USER="${DB_USER:-pos_app}"; DB_HOST="${DB_HOST:-localhost}"
STORAGE_DIR="${STORAGE_DIR:-/opt/pos/storage}"; BACKUP_DIR="${BACKUP_DIR:-/var/backups/pos}"; KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M)"
mkdir -p "$BACKUP_DIR"

pg_dump -h "$DB_HOST" -U "$DB_USER" --format=custom --compress=6 --file="$BACKUP_DIR/pos-$STAMP.dump" "$DB"
[ -s "$BACKUP_DIR/pos-$STAMP.dump" ] || { echo "pg_dump produced an empty file" >&2; exit 1; }
[ -d "$STORAGE_DIR" ] && tar -czf "$BACKUP_DIR/storage-$STAMP.tar.gz" -C "$STORAGE_DIR" .
find "$BACKUP_DIR" -type f -mtime "+$KEEP_DAYS" -delete
echo "backup ok: $BACKUP_DIR/pos-$STAMP.dump"
