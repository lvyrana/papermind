#!/usr/bin/env bash
# Toggle PaperMind's temporary HTTP Basic Auth without replacing Certbot config.
set -euo pipefail

MODE="${1:-}"
SITES=(
    "/etc/nginx/sites-available/papermind"
    "/etc/nginx/sites-available/papermind-domain"
)

if [ "$EUID" -ne 0 ]; then
    echo "请使用 sudo 运行：sudo bash toggle-preview-auth.sh off|on"
    exit 1
fi

if [ "$MODE" != "off" ] && [ "$MODE" != "on" ]; then
    echo "用法：sudo bash toggle-preview-auth.sh off|on"
    exit 1
fi

for site in "${SITES[@]}"; do
    if [ ! -f "$site" ]; then
        echo "未找到 Nginx 配置：$site"
        exit 1
    fi
done

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="/etc/nginx/papermind-auth-backups/$STAMP"
mkdir -p "$BACKUP_DIR"

restore_configs() {
    for site in "${SITES[@]}"; do
        cp -p "$BACKUP_DIR/$(basename "$site")" "$site"
    done
}

for site in "${SITES[@]}"; do
    cp -p "$site" "$BACKUP_DIR/$(basename "$site")"
    if [ "$MODE" = "off" ]; then
        sed -i -E 's/^([[:space:]]*)auth_basic([[:space:]])/\1# auth_basic\2/' "$site"
        sed -i -E 's/^([[:space:]]*)auth_basic_user_file([[:space:]])/\1# auth_basic_user_file\2/' "$site"
    else
        sed -i -E 's/^([[:space:]]*)#[[:space:]]*auth_basic([[:space:]])/\1auth_basic\2/' "$site"
        sed -i -E 's/^([[:space:]]*)#[[:space:]]*auth_basic_user_file([[:space:]])/\1auth_basic_user_file\2/' "$site"
    fi
done

for site in "${SITES[@]}"; do
    if [ "$MODE" = "off" ] && grep -Eq '^[[:space:]]*auth_basic(_user_file)?[[:space:]]' "$site"; then
        echo "关闭失败，仍检测到启用中的 Basic Auth：$site"
        restore_configs
        exit 1
    fi
    if [ "$MODE" = "on" ]; then
        if ! grep -Eq '^[[:space:]]*auth_basic[[:space:]]' "$site" || \
           ! grep -Eq '^[[:space:]]*auth_basic_user_file[[:space:]]' "$site"; then
            echo "恢复失败，未找到完整的 Basic Auth 配置：$site"
            restore_configs
            exit 1
        fi
    fi
done

if ! nginx -t; then
    echo "Nginx 校验失败，正在恢复修改前配置。"
    restore_configs
    nginx -t
    exit 1
fi

if ! systemctl reload nginx; then
    echo "Nginx reload 失败，正在恢复修改前配置。"
    restore_configs
    nginx -t
    systemctl reload nginx
    exit 1
fi
if [ "$MODE" = "on" ]; then
    echo "PaperMind HTTP Basic Auth 已恢复。"
else
    echo "PaperMind HTTP Basic Auth 已关闭。"
fi
echo "配置备份：$BACKUP_DIR"
