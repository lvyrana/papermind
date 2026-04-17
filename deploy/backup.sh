#!/bin/bash
# PaperMind SQLite 备份脚本
set -euo pipefail

DB_PATH="/opt/papermind/papermind/data/paperdiary.db"
BACKUP_DIR="/opt/papermind/backups"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

if ! command -v sqlite3 >/dev/null 2>&1; then
    echo "未安装 sqlite3，无法执行数据库备份。"
    exit 1
fi

if [ ! -f "$DB_PATH" ]; then
    echo "数据库不存在，跳过备份：$DB_PATH"
    exit 0
fi

install -d -m 0755 "$BACKUP_DIR"

timestamp=$(date +"%Y%m%d-%H%M%S")
backup_file="$BACKUP_DIR/paperdiary-$timestamp.db"

sqlite3 "$DB_PATH" ".backup $backup_file"
gzip -f "$backup_file"

find "$BACKUP_DIR" -type f -name 'paperdiary-*.db.gz' -mtime +"$RETENTION_DAYS" -delete

echo "备份完成：$backup_file.gz"
