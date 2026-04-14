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
cp "$PROJECT_DIR/deploy/nginx-papermind.conf" /etc/nginx/sites-available/papermind
ln -sf /etc/nginx/sites-available/papermind /etc/nginx/sites-enabled/papermind
systemctl daemon-reload
nginx -t
systemctl reload nginx

echo "=== 重启后端 ==="
systemctl restart papermind
sleep 2
systemctl status papermind --no-pager | head -10

echo "✅ 更新完成"
