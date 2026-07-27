#!/bin/bash
# PaperMind 本地备份脚本（macOS / Linux 通用）
#
# 用法（在仓库根目录执行）：
#   bash scripts/backup_local.sh              # 只备份数据库
#   bash scripts/backup_local.sh --with-pdfs  # 同时打包上传的 PDF（兼容旧用法）
#   bash scripts/backup_local.sh --with-files # 同时打包 PDF 和图表截图
#   BACKUP_DIR=/Volumes/备份盘/PaperMind bash scripts/backup_local.sh --with-files
#
# 产物：backups/paperdiary-<时间戳>.db.gz（+ 可选文件包）
# 恢复：gunzip -k backups/paperdiary-xxx.db.gz
#       停止后端后，用解压出的 .db 覆盖 papermind/data/paperdiary.db
#
# 说明：使用 sqlite3 的 .backup 命令做在线备份，WAL 模式下也安全，
#       后端运行中也可以执行。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB_PATH="$REPO_ROOT/papermind/data/paperdiary.db"
DATA_DIR="$REPO_ROOT/papermind/data"
PDF_DIR="$DATA_DIR/pdfs"
FIGURE_DIR="$DATA_DIR/figures"
BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

mode="${1:-database}"
case "$mode" in
    database|--with-pdfs|--with-files) ;;
    *)
        echo "未知参数：$mode"
        echo "用法：bash scripts/backup_local.sh [--with-pdfs|--with-files]"
        exit 2
        ;;
esac

if ! command -v sqlite3 >/dev/null 2>&1; then
    echo "未安装 sqlite3，无法执行数据库备份。"
    exit 1
fi

if [ ! -f "$DB_PATH" ]; then
    echo "数据库不存在，无可备份内容：$DB_PATH"
    exit 1
fi

mkdir -p "$BACKUP_DIR"

timestamp=$(date +"%Y%m%d-%H%M%S")
backup_file="$BACKUP_DIR/paperdiary-$timestamp.db"

sqlite3 "$DB_PATH" ".backup $backup_file"
gzip -f "$backup_file"
echo "数据库备份完成：$backup_file.gz"

if [ "$mode" = "--with-pdfs" ]; then
    if [ -d "$PDF_DIR" ] && [ -n "$(ls -A "$PDF_DIR" 2>/dev/null)" ]; then
        pdf_archive="$BACKUP_DIR/pdfs-$timestamp.tar.gz"
        tar -czf "$pdf_archive" -C "$DATA_DIR" pdfs
        echo "PDF 打包完成：$pdf_archive"
    else
        echo "PDF 目录为空，跳过打包：$PDF_DIR"
    fi
fi

if [ "$mode" = "--with-files" ]; then
    paper_files_archive="$BACKUP_DIR/paper-files-$timestamp.tar.gz"
    file_dirs=()
    [ -d "$PDF_DIR" ] && file_dirs+=(pdfs)
    [ -d "$FIGURE_DIR" ] && file_dirs+=(figures)
    if [ "${#file_dirs[@]}" -gt 0 ]; then
        tar -czf "$paper_files_archive" -C "$DATA_DIR" "${file_dirs[@]}"
        echo "PDF 与图表截图打包完成：$paper_files_archive"
    else
        echo "PDF 与图表截图目录均不存在，跳过文件打包。"
    fi
fi

echo "提示：config.json 可能包含 API Key，不会进入未加密备份包。"

# 清理超过保留期的旧备份
find "$BACKUP_DIR" -type f \( -name 'paperdiary-*.db.gz' -o -name 'pdfs-*.tar.gz' -o -name 'paper-files-*.tar.gz' -o -name 'pre-delete-*.db' \) -mtime +"$RETENTION_DAYS" -delete

echo "当前备份列表："
ls -lh "$BACKUP_DIR" | tail -n +2
