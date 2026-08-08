#!/bin/bash
# 启动 Pixiv Vault 本地开发服务器
# 用法: ./dev.sh [port] [host]
#   默认绑定局域网实际 IP（en0/en1 自动探测），仅暴露到局域网
#   如仅本机访问可传 127.0.0.1
set -e
cd "$(dirname "$0")"
PORT="${1:-8899}"

if [ ! -d .venv ]; then
  echo "创建虚拟环境..."
  uv venv .venv
  uv pip install --python .venv/bin/python -r requirements.txt
fi

# 探测局域网 IP（en0 优先，回退 en1）
LAN_IP=""
for IFACE in en0 en1; do
  LAN_IP=$(ipconfig getifaddr "$IFACE" 2>/dev/null || true)
  [ -n "$LAN_IP" ] && break
done

HOST="${2:-$LAN_IP}"
if [ -z "$HOST" ]; then
  echo "错误: 未探测到局域网 IP（en0/en1），无法绑定。请手动指定 host: ./dev.sh 8899 127.0.0.1"
  exit 1
fi

echo "启动 Pixiv Vault: http://${HOST}:${PORT}/"
echo "手机访问地址: http://${HOST}:${PORT}/  （需同一局域网）"
echo "数据目录: ${PIXIV_ROOT:-$(pwd)/data}（用 PIXIV_ROOT 环境变量覆盖）"
export PIXIV_ROOT="${PIXIV_ROOT:-$(pwd)/data}"
exec .venv/bin/python -m uvicorn app.main:app --host "$HOST" --port "$PORT"
