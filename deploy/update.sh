#!/bin/bash
# PaperMind 更新脚本：拉最新代码，重新构建前端，重启后端
# 用法：sudo bash update.sh
set -e

PROJECT_DIR="/opt/papermind"

if [ "$EUID" -ne 0 ]; then
    echo "请使用 sudo 运行此脚本：sudo bash update.sh"
    exit 1
fi

echo "=== 拉取最新代码 ==="
cd "$PROJECT_DIR"
git pull

echo "=== 确保备份依赖存在 ==="
apt-get update -qq
apt-get install -y sqlite3

echo "=== 安装/更新 Python 依赖 ==="
cd "$PROJECT_DIR/papermind"
.venv/bin/pip install --upgrade pip -q
.venv/bin/pip install -r requirements.txt -q

echo "=== 构建前端 ==="
cd "$PROJECT_DIR/web"
npm ci --silent
npm run build

echo "=== 同步服务配置 ==="
cp "$PROJECT_DIR/deploy/papermind.service" /etc/systemd/system/papermind.service
cp "$PROJECT_DIR/deploy/papermind-backup.service" /etc/systemd/system/papermind-backup.service
cp "$PROJECT_DIR/deploy/papermind-backup.timer" /etc/systemd/system/papermind-backup.timer
cp "$PROJECT_DIR/deploy/nginx-papermind.conf" /etc/nginx/sites-available/papermind
ln -sf /etc/nginx/sites-available/papermind /etc/nginx/sites-enabled/papermind
chmod +x "$PROJECT_DIR/deploy/backup.sh"
systemctl daemon-reload
systemctl enable papermind-backup.timer >/dev/null 2>&1 || true
systemctl restart papermind-backup.timer
nginx -t
systemctl reload nginx

echo "=== 重启后端 ==="
systemctl restart papermind
sleep 2
systemctl status papermind --no-pager | head -10
echo "=== 备份定时器 ==="
systemctl status papermind-backup.timer --no-pager | head -10

echo "✅ 更新完成"
