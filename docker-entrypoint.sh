#!/bin/sh
# 按 PUID/PGID 降权运行（群晖 NAS 风格，Python 原生实现无需额外二进制）
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
PORT="${PORT:-8000}"

# 确保数据目录存在且属主正确（以 root 修复后降权）
if [ -n "$PIXIV_ROOT" ]; then
  mkdir -p "$PIXIV_ROOT"
  chown -R "$PUID:$PGID" "$PIXIV_ROOT" 2>/dev/null || true
fi

# 用 Python 降权后 exec uvicorn
exec python3 -c "
import os, sys, grp, pwd
uid = int(os.environ.get('PUID', 1000))
gid = int(os.environ.get('PGID', 1000))
os.setgid(gid)
os.setuid(uid)
os.chdir('/app')
os.execvp('uvicorn', ['uvicorn', 'app.main:app', '--host', '0.0.0.0', '--port', os.environ.get('PORT', '8000')])
"
