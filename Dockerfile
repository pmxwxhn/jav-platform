# syntax=docker/dockerfile:1
# ---------------------------------------------------------------
# jav-auto-platform —— 飞牛 NAS 容器版
#   平台本体（Node 22 + Express + better-sqlite3）
#   + cdp-proxy（浏览器 CDP 桥，3457）
#   + socat（把 127.0.0.1:9222 转发到浏览器容器）
#   + Python 3（Telegram 监控 telethon 链路）
#   + ffmpeg（javdb 预览片合成）
# ---------------------------------------------------------------
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Shanghai \
    LANG=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv \
        socat ffmpeg curl ca-certificates tzdata tini \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

# Python 依赖（telethon 走 socks 代理需要 python-socks）
RUN pip3 install --break-system-packages --no-cache-dir \
        -i https://pypi.tuna.tsinghua.edu.cn/simple \
        telethon python-socks PyYAML openpyxl qrcode opencc-python-reimplemented

WORKDIR /app

# 先装依赖，利用层缓存
# 用 npm install 而不是 npm ci：上游 package.json 少声明了依赖（pinyin-pro），
# package-lock 与 package.json 不同步，npm ci 会直接失败。
COPY src/package.json /app/
RUN npm install --omit=dev --registry=https://registry.npmmirror.com \
    && npm cache clean --force

COPY src/ /app/
COPY cdp-proxy/ /opt/cdp-proxy/
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /app/data /app/reports /opt/tgmon

EXPOSE 8730
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/entrypoint.sh"]
