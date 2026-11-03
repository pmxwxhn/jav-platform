// 网络连通性检测模块(主动检测, 非任务前强制校验)
// 检测项: 关键本地端口 TCP 可达性 + 外部依赖 HTTPS 可达性
// 失败时给出针对性原因与修复建议; 支持单项重试
const net = require('net');
const http = require('http');
const https = require('https');

// ===== 检测项定义(可扩展: 新增项只需加一条) =====
// kind: 'tcp' 用 host+port; 'https' 用 url; 'mcp115' 走 MCP 协议探测
const CHECK_DEFS = [
  { id: 'platform',    name: '平台服务 (8730)',       kind: 'tcp',   host: '127.0.0.1', port: 8730,
    hint: '平台服务未启动 → 运行 start.bat 或 node app.js' },
  { id: 'mcp115',      name: '115-Desktop MCP (11502)', kind: 'mcp115', host: '127.0.0.1', port: 11502,
    hint: '115 MCP 服务未启动 → 打开 115-Desktop 客户端: 设置/百宝箱→AI整理服务(MCP)→开启; 判重/演员目录/离线均依赖此服务' },
  { id: 'browser-115', name: '115浏览器调试 (9222)',   kind: 'tcp',   host: '127.0.0.1', port: 9222,
    hint: '115 浏览器未以调试模式启动 → 运行 start-all.cmd 一键拉起(浏览器+代理+平台); 色花堂抓取/javdb/磁力仍需浏览器' },
  { id: 'browser-115-v6', name: '115浏览器调试 IPv6', kind: 'tcp',   host: '::1', port: 9222,
    hint: 'IPv6 调试端口不可达(115 本次可能绑定 IPv4, 属正常)' },
  { id: 'cdp-proxy',   name: 'CDP 代理 (3457)',       kind: 'tcp',   host: '127.0.0.1', port: 3457,
    hint: 'cdp-proxy 未运行 → 运行 start-all.cmd 一键拉起(含浏览器+代理+平台)' },
  { id: 'sehuatang',   name: '色花堂 (抓取源)',       kind: 'https', url: 'https://www.sehuatang.net',
    hint: '色花堂不可达 → 检查网络/代理, 或站点维护中' },
  { id: 'javdb',       name: 'javdb (查询/详情)',     kind: 'https', url: 'https://javdb.com',
    hint: 'javdb 不可达 → 可能需要代理或切换镜像站' },
  { id: 'jdbstatic',   name: 'javdb 图片 CDN',        kind: 'https', url: 'https://c0.jdbstatic.com',
    hint: '图片 CDN 不可达 → 海报/缩略图将无法加载' },
  { id: 'pan115',      name: '115 网盘',              kind: 'https', url: 'https://115.com',
    hint: '115 网盘不可达 → 检查网络/登录态' },
];

// 错误码 → 针对性原因
function reasonFor(e) {
  const code = (e && e.code) || '';
  switch (code) {
    case 'ECONNREFUSED':  return '连接被拒绝: 服务未启动或端口未监听';
    case 'ETIMEDOUT':     return '连接超时: 防火墙拦截或网络不可达';
    case 'ENOTFOUND':     return '域名解析失败: 地址错误或 DNS 异常';
    case 'ECONNRESET':    return '连接被重置: 服务异常或网络中断';
    case 'EHOSTUNREACH':  return '主机不可达: 网络路由问题';
    case 'EADDRNOTAVAIL': return '地址不可用: 本地网络配置问题';
    default: return (e && e.message) || '未知错误';
  }
}

// TCP 端口检测
function tcpCheck(def, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.connect({ host: def.host, port: def.port, timeout: timeoutMs });
    sock.once('connect', () => { sock.destroy(); resolve({ ok: true, status: 'success', ms: Date.now() - t0 }); });
    sock.once('timeout', () => { sock.destroy(); resolve({ ok: false, status: 'timeout', ms: Date.now() - t0, err: 'ETIMEDOUT', reason: '连接超时(防火墙拦截/服务未启动/地址不可达)' }); });
    sock.once('error', (e) => { sock.destroy(); resolve({ ok: false, status: 'failed', ms: Date.now() - t0, err: e.code || e.message, reason: reasonFor(e) }); });
  });
}

// 读取系统代理(环境变量, 与浏览器/系统一致); 无则 null
function systemProxy() {
  const p = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!p) return null;
  try {
    const u = new URL(p);
    return { host: u.hostname, port: parseInt(u.port) || (u.protocol === 'https:' ? 443 : 80) };
  } catch { return null; }
}

// 走 HTTP CONNECT 隧道建立 HTTPS 连接(适配系统代理场景)
function httpsViaProxy(def, proxy, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const u = new URL(def.url);
    const connectReq = http.request({
      host: proxy.host, port: proxy.port, method: 'CONNECT',
      path: u.hostname + ':' + (u.port || 443),
      timeout: timeoutMs,
    });
    connectReq.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return resolve({ ok: false, status: 'failed', ms: Date.now() - t0, err: 'PROXY_' + res.statusCode, reason: '代理隧道建立失败(HTTP ' + res.statusCode + ')' });
      }
      const req = https.request({ host: u.hostname, port: u.port || 443, path: u.pathname || '/', method: 'GET', socket, timeout: timeoutMs, agent: false }, (r) => {
        r.resume();
        resolve({ ok: true, status: 'success', ms: Date.now() - t0, httpCode: r.statusCode, viaProxy: true });
      });
      req.once('timeout', () => { req.destroy(); resolve({ ok: false, status: 'timeout', ms: Date.now() - t0, err: 'ETIMEDOUT', reason: '连接超时(经代理访问目标响应慢)' }); });
      req.once('error', (e) => resolve({ ok: false, status: 'failed', ms: Date.now() - t0, err: e.code || e.message, reason: reasonFor(e) }));
      req.end();
    });
    connectReq.once('timeout', () => { connectReq.destroy(); resolve({ ok: false, status: 'timeout', ms: Date.now() - t0, err: 'ETIMEDOUT', reason: '代理连接超时(代理软件未运行?)' }); });
    connectReq.once('error', (e) => resolve({ ok: false, status: 'failed', ms: Date.now() - t0, err: e.code || e.message, reason: reasonFor(e) }));
    connectReq.end();
  });
}

// HTTPS 可达性检测(拿到响应头即算成功); 有系统代理时经代理检测(与浏览器一致)
function httpsCheck(def, timeoutMs) {
  const proxy = systemProxy();
  if (proxy && def.url.startsWith('https')) return httpsViaProxy(def, proxy, timeoutMs);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const lib = def.url.startsWith('https') ? https : http;
    const req = lib.get(def.url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve({ ok: true, status: 'success', ms: Date.now() - t0, httpCode: res.statusCode });
    });
    req.once('timeout', () => { req.destroy(); resolve({ ok: false, status: 'timeout', ms: Date.now() - t0, err: 'ETIMEDOUT', reason: '连接超时(网络不通或目标响应慢)' }); });
    req.once('error', (e) => resolve({ ok: false, status: 'failed', ms: Date.now() - t0, err: e.code || e.message, reason: reasonFor(e) }));
  });
}

// 115-Desktop MCP 检测: 复用 mcp115 模块的 ensure()(真实协议握手, 已验证可用)
function mcp115Check(def, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    (async () => {
      try {
        const mcp = require('./mcp115');
        const ok = await mcp.ensure();
        resolve(ok
          ? { ok: true, status: 'success', ms: Date.now() - t0, note: 'MCP 握手成功(协议可用)' }
          : { ok: false, status: 'failed', ms: Date.now() - t0, err: 'MCP_UNAVAILABLE', reason: 'MCP 服务不可用(端口通但会话握手失败, 可能服务未就绪)' });
      } catch (e) {
        resolve({ ok: false, status: 'failed', ms: Date.now() - t0, err: 'MCP_ERR', reason: e.message || 'MCP 检测异常' });
      }
    })();
  });
}

// 运行单个检测项(带重试)
async function runOne(id, opts = {}) {
  const def = CHECK_DEFS.find(d => d.id === id);
  if (!def) return { ok: false, error: '未知检测项: ' + id };
  const timeoutMs = opts.timeoutMs || 5000;
  const retries = Math.max(0, (opts.retries == null ? 1 : opts.retries));
  let last = null;
  const checker = def.kind === 'tcp' ? tcpCheck : (def.kind === 'mcp115' ? mcp115Check : httpsCheck);
  for (let i = 0; i <= retries; i++) {
    last = await checker(def, timeoutMs);
    if (last.ok) break;
  }
  return { id: def.id, name: def.name, kind: def.kind, addr: def.kind === 'tcp' || def.kind === 'mcp115' ? `${def.host}:${def.port}` : def.url, hint: def.hint, ...last, attempts: retries + 1 };
}

// 运行全部检测项
async function runAll(opts = {}) {
  const results = [];
  for (const def of CHECK_DEFS) {
    const r = await runOne(def.id, opts);
    results.push(r);
  }
  return results;
}

module.exports = { CHECK_DEFS, runOne, runAll };
