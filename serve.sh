#!/usr/bin/env bash
# 在局域网里把「即兴一分钟」跑起来，手机连同一个 Wi-Fi 就能访问。
# 用法：./serve.sh          启动（默认 8080）
#       ./serve.sh 8888     换端口
#       ./serve.sh stop     停止

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${1:-8080}"
PIDFILE="/tmp/speak60-serve.pid"
LOGFILE="/tmp/speak60-serve.log"

# 取当前局域网 IP（优先 en0，其次 en1）
lan_ip() {
  ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo ""
}

stop_server() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    kill "$(cat "$PIDFILE")" && rm -f "$PIDFILE"
    echo "已停止（原端口见上一次输出）"
  else
    # 兜底：按端口找
    leftover="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
    if [ -n "$leftover" ]; then
      kill $leftover && echo "已停止端口 $PORT 上的服务"
    else
      echo "没有正在运行的服务"
    fi
  fi
}

if [ "$PORT" = "stop" ]; then
  stop_server
  exit 0
fi

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "服务已经在跑（PID $(cat "$PIDFILE")），先执行 ./serve.sh stop 再启动"
  exit 1
fi

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "端口 $PORT 已被占用，换个端口：./serve.sh 8888"
  exit 1
fi

# 只服务本目录，不暴露上级任何内容
cd "$DIR"
nohup python3 -m http.server "$PORT" --bind 0.0.0.0 >"$LOGFILE" 2>&1 &
echo $! >"$PIDFILE"
sleep 1

if ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "启动失败，看看 $LOGFILE"
  exit 1
fi

IP="$(lan_ip)"
echo
echo "  已启动（PID $(cat "$PIDFILE")，只服务 ${DIR}）"
echo
if [ -n "$IP" ]; then
  echo "  手机浏览器打开：  http://$IP:$PORT/"
  echo "  配色对比页：      http://$IP:$PORT/palette-preview.html"
else
  echo "  没取到局域网 IP，检查 Wi-Fi 是否连接"
fi
echo "  本机访问：        http://127.0.0.1:$PORT/"
echo
echo "  停止：./serve.sh stop"
echo "  前提：手机和电脑连同一个 Wi-Fi"
echo
