#!/usr/bin/env python3
"""NAS 容器启动编排器。

飞牛上各应用是独立 compose 项目，Docker 开机时同时拉起，谁也不知道谁。
媒体类应用（auto_symlink / emby / mdcx）依赖 clouddrive2 先挂载好，
jav-platform 依赖 115lite 和它自己的浏览器。

这个脚本直接说 Docker API（/var/run/docker.sock），每 INTERVAL 秒巡检一次：
按顺序检查「前置条件是否满足」，满足且自身没在跑就 start 它。
既是开机编排，也是常驻自愈。

可通过环境变量 SKIP 排除不想被托管的应用，逗号分隔，例如 SKIP=mdcz,javboss
BOOT_GRACE：clouddrive2 起来后最多等多少秒就认为挂载可用（默认 90）
"""
import http.client
import json
import os
import socket
import time

SOCK = "/var/run/docker.sock"
CD2_DIR = "/check/cd2"
SKIP = {x.strip() for x in (os.environ.get("SKIP") or "").split(",") if x.strip()}
BOOT_GRACE = int(os.environ.get("BOOT_GRACE", "90"))
INTERVAL = int(os.environ.get("INTERVAL", "30"))


class UConn(http.client.HTTPConnection):
    def __init__(self, path, timeout=10):
        super().__init__("localhost", timeout=timeout)
        self.path = path

    def connect(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(self.timeout)
        s.connect(self.path)
        self.sock = s


def api(method, path):
    c = UConn(SOCK)
    try:
        c.request(method, "http://localhost" + path, headers={"Host": "localhost"})
        r = c.getresponse()
        return r.status, r.read()
    finally:
        c.close()


def info(name):
    code, data = api("GET", "/containers/%s/json" % name)
    if code != 200:
        return None
    try:
        return (json.loads(data) or {}).get("State") or {}
    except Exception:
        return None


def running(name):
    st = info(name)
    if st is None:
        return None
    return bool(st.get("Running"))


def start(name):
    code, _ = api("POST", "/containers/%s/start" % name)
    return code in (204, 304), code


_started_at = {}


def cd2_ready():
    """clouddrive2 的 115 挂载点能列出内容就算就绪；列不出来时用启动时长兜底。"""
    try:
        if os.listdir(CD2_DIR):
            return True
    except Exception:
        pass
    t = _started_at.get("clouddrive2")
    return bool(t and (time.time() - t) > BOOT_GRACE)


def satisfied(cond):
    if cond is None:
        return True
    if cond == "cd2":
        return running("clouddrive2") is True and cd2_ready()
    return running(cond) is True


# (容器名, 前置条件)  cond: None=无依赖 | 'cd2'=clouddrive2 且挂载就绪 | 其他=该容器在运行
STEPS = [
    ("clouddrive2", None),
    ("115lite", "cd2"),
    ("auto_symlink", "cd2"),
    ("embyserver", "auto_symlink"),
    ("mdcx", "cd2"),
    ("jav-browser", "115lite"),
    ("jav-cdp-fwd", "jav-browser"),
    ("jav-platform", "jav-cdp-fwd"),
]


def log(msg):
    print(time.strftime("[%Y-%m-%d %H:%M:%S] ") + msg, flush=True)


def tick():
    for name, cond in STEPS:
        if name in SKIP:
            continue
        st = info(name)
        if st is None:
            continue                      # 容器不存在，跳过（没装/改名了）
        state = st.get("Status")
        if state == "running":
            _started_at.setdefault(name, time.time())
            continue
        if state == "restarting":
            continue                      # 交给 Docker 的 restart 策略
        if not satisfied(cond):
            continue
        ok, code = start(name)
        if ok:
            _started_at[name] = time.time()
            log("start %-14s ← %s" % (name, cond or "-"))
        else:
            log("start %-14s 失败 code=%s" % (name, code))


log("boot-order 启动 | INTERVAL=%ss BOOT_GRACE=%ss SKIP=%s" % (INTERVAL, BOOT_GRACE, sorted(SKIP) or "-"))
time.sleep(15)                            # 等 Docker 自己先拉一轮
while True:
    try:
        tick()
    except Exception as e:
        log("tick 异常: %r" % (e,))
    time.sleep(INTERVAL)
