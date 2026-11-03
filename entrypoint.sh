#!/bin/sh
# 容器入口：先准备好"浏览器通道"，再启动平台
set -u

BROWSER_HOST="${BROWSER_HOST:-jav-browser}"
BROWSER_PORT="${BROWSER_PORT:-19222}"
CDP_PROXY_PORT="${CDP_PROXY_PORT:-3457}"

echo "[entrypoint] 时间 $(date '+%F %T %Z')"
echo "[entrypoint] 浏览器通道转发 127.0.0.1:9222 -> ${BROWSER_HOST}:${BROWSER_PORT}"

# 平台里的 cdp.js / cdp-proxy 都写死了 127.0.0.1:9222，这里用 socat 把本机 9222
# 转发到浏览器容器的 CDP 端口，代码一行都不用改。
socat TCP-LISTEN:9222,fork,reuseaddr TCP:${BROWSER_HOST}:${BROWSER_PORT} &

# 等浏览器 CDP 就绪（最多 2 分钟），没起来也继续启动平台，平台会自己重试
i=0
until curl -fsS -m 2 "http://127.0.0.1:9222/json/version" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "[entrypoint] 警告：浏览器 CDP 未就绪，平台先启动，稍后自动重连"
    break
  fi
  [ $((i % 5)) -eq 0 ] && echo "[entrypoint] 等待浏览器… (${i}/60)"
  sleep 2
done

if curl -fsS -m 2 "http://127.0.0.1:9222/json/version" >/dev/null 2>&1; then
  echo "[entrypoint] 浏览器 CDP 已连通"
fi

echo "[entrypoint] 启动 cdp-proxy :${CDP_PROXY_PORT}"
CDP_PROXY_PORT="${CDP_PROXY_PORT}" node /opt/cdp-proxy/cdp-proxy.mjs &
sleep 2

echo "[entrypoint] 启动平台 :8730"
exec node /app/app.js
