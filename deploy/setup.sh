#!/bin/bash
# PaperMind 首次部署脚本（Ubuntu 24.04）
# 用法：sudo bash setup.sh
set -euo pipefail

PROJECT_DIR="/opt/papermind"
REPO_URL="https://github.com/lvyrana/papermind.git"   # 你的仓库地址
DEPLOY_REF="${DEPLOY_REF:-main}"
PREVIEW_HOST="${PREVIEW_HOST:-_}"
AUTH_USER="${PAPERMIND_BASIC_AUTH_USER:-}"
AUTH_PASSWORD="${PAPERMIND_BASIC_AUTH_PASSWORD:-}"

if [ "$EUID" -ne 0 ]; then
    echo "请使用 sudo 运行此脚本：sudo bash setup.sh"
    exit 1
fi

echo "=== [1/7] 安装系统依赖 ==="
apt-get update -qq
apt-get install -y nginx apache2-utils certbot python3-certbot-nginx \
    python3 python3-venv python3-pip git curl ca-certificates gnupg sqlite3

if ! command -v node >/dev/null 2>&1; then
    echo "=== 安装 Node.js 22 ==="
    install -d -m 0755 /etc/apt/keyrings
    if [ ! -f /etc/apt/keyrings/nodesource.gpg ]; then
        curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
            | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
    fi
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list
    apt-get update -qq
    apt-get install -y nodejs
fi

echo "=== [2/7] 克隆 / 更新代码 ==="
if [ -d "$PROJECT_DIR/.git" ]; then
    cd "$PROJECT_DIR"
    git fetch origin "$DEPLOY_REF"
    git checkout "$DEPLOY_REF"
    git pull --ff-only origin "$DEPLOY_REF"
else
    git clone --branch "$DEPLOY_REF" --single-branch "$REPO_URL" "$PROJECT_DIR"
fi
chown -R ubuntu:ubuntu "$PROJECT_DIR"
chmod +x "$PROJECT_DIR/deploy/backup.sh"

echo "=== [3/7] 创建 Python 虚拟环境并安装依赖 ==="
cd "$PROJECT_DIR/papermind"
python3 -m venv .venv
.venv/bin/pip install --upgrade pip -q
.venv/bin/pip install -r requirements.txt -q

echo "=== [4/7] 构建前端 ==="
cd "$PROJECT_DIR/web"
npm ci --silent
npm run build

echo "=== [5/7] 创建数据目录 ==="
mkdir -p "$PROJECT_DIR/papermind/data"
chown -R ubuntu:ubuntu "$PROJECT_DIR/papermind/data"

echo "=== [6/7] 配置 .env ==="
if [ ! -f "$PROJECT_DIR/papermind/.env" ]; then
    cp "$PROJECT_DIR/papermind/.env.example" "$PROJECT_DIR/papermind/.env"
    echo ""
    echo "⚠️  请先编辑 .env 填入 API Key，然后重新运行此脚本或手动启动服务："
    echo "    nano $PROJECT_DIR/papermind/.env"
    echo ""
fi

echo "=== [7/8] 配置 systemd 服务 ==="
cp "$PROJECT_DIR/deploy/papermind.service" /etc/systemd/system/papermind.service
cp "$PROJECT_DIR/deploy/papermind-backup.service" /etc/systemd/system/papermind-backup.service
cp "$PROJECT_DIR/deploy/papermind-backup.timer" /etc/systemd/system/papermind-backup.timer
systemctl daemon-reload
systemctl enable papermind
systemctl enable papermind-backup.timer
systemctl start papermind-backup.timer
systemctl restart papermind
echo "后端服务状态："
systemctl status papermind --no-pager -l | head -20
echo "备份定时器状态："
systemctl status papermind-backup.timer --no-pager -l | head -12

echo "=== [8/8] 配置 nginx ==="
if ! [[ "$PREVIEW_HOST" =~ ^[A-Za-z0-9.-]+$|^_$ ]]; then
    echo "PREVIEW_HOST 格式无效"
    exit 1
fi

if [ ! -f /etc/nginx/.htpasswd ]; then
    if [ -z "$AUTH_USER" ] || [ -z "$AUTH_PASSWORD" ]; then
        echo "首次部署必须提供 PAPERMIND_BASIC_AUTH_USER 和 PAPERMIND_BASIC_AUTH_PASSWORD"
        exit 1
    fi
    htpasswd -bc /etc/nginx/.htpasswd "$AUTH_USER" "$AUTH_PASSWORD"
    chown root:www-data /etc/nginx/.htpasswd
    chmod 640 /etc/nginx/.htpasswd
fi
unset AUTH_PASSWORD PAPERMIND_BASIC_AUTH_PASSWORD

sed "s/__PAPERMIND_HOST__/$PREVIEW_HOST/g" \
    "$PROJECT_DIR/deploy/nginx-papermind-ip.conf" \
    > /etc/nginx/sites-available/papermind
ln -sf /etc/nginx/sites-available/papermind /etc/nginx/sites-enabled/papermind
# 删除 nginx 默认站点，避免冲突
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl restart nginx

if [ "$PREVIEW_HOST" != "_" ]; then
    certbot --nginx --non-interactive --agree-tos \
        --register-unsafely-without-email --redirect -d "$PREVIEW_HOST"
    PUBLIC_URL="https://$PREVIEW_HOST"
else
    PUBLIC_IP=$(curl -s --max-time 3 ifconfig.me 2>/dev/null || echo "your-server-ip")
    PUBLIC_URL="http://$PUBLIC_IP"
fi

echo ""
echo "✅ 部署完成！"
echo "   访问地址：$PUBLIC_URL"
echo ""
echo "常用命令："
echo "   查看后端日志：journalctl -u papermind -f"
echo "   重启后端：    systemctl restart papermind"
echo "   手动备份：    systemctl start papermind-backup"
echo "   查看备份：    ls -lh /opt/papermind/backups"
echo "   有域名后升HTTPS：sudo certbot --nginx -d yourdomain.com"
