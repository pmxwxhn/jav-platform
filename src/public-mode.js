// ============================================================
// 公网只读访问网关 (public-mode)
// ------------------------------------------------------------
// 目标: 通过 Cloudflare 隧道把平台分享给别人时, 只开放「查看 + 导出」,
//       所有管理动作(运行/抓取/删除/配置/清理)在公网侧一律不可见、不可调。
//
// 设计要点:
//   1. 自动识别来源 —— Cloudflare 隧道转发的请求必带 cf-ray / cf-connecting-ip,
//      本机直连不会带。因此本地使用体验完全不受影响, 无需开关切换。
//   2. 默认拒绝 —— 公网侧 GET 走白名单, 不在白名单里的接口一律 403 (白名单外
//      的任何接口都不会因为"忘了加限制"而泄露)。
//   3. 先鉴权后放行 —— 未通过口令校验的请求拿不到任何数据。
// ============================================================
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
const CFG_PATH = path.join(DATA_DIR, 'public-access.json');
const CODE_HINT_PATH = path.join(DATA_DIR, 'public-access-CODE.txt');
const COOKIE_NAME = 'jw_pub';
const LOGIN_PAGE = '/access.html';
const LOGIN_API = '/api/access/login';
const LOGOUT_API = '/api/access/logout';

// ---------- 公网侧允许的 GET 路径(白名单, 其余一律拒绝) ----------
const ALLOW_GET = [
  /^\/$/,                              // 首页
  /^\/index\.html$/,
  /^\/access\.html$/,                  // 登录页(鉴权前就要能访问)
  /^\/favicon\.svg$/,
  /^\/assets\//,                       // 前端静态资源
  /^\/previews\//,                     // 预告片(报告内播放)
  /^\/reports\//,                      // 生成的 HTML 报告
  /^\/api\/pub-mode$/,                 // 前端只读探测
  /^\/api\/stats$/,                    // 仪表盘统计
  /^\/api\/videos$/,                   // 影片记录列表
  /^\/api\/videos\/dates$/,
  /^\/api\/runs$/,                     // 运行历史
  /^\/api\/runs\/\d+$/,                // 单次运行日志
  /^\/api\/reports$/,
  /^\/api\/reports\/dates$/,
  /^\/api\/reports\/latest$/,
  /^\/api\/netcheck\/history(\/[\w-]+)?$/,  // 历史检测记录(只读)
  /^\/api\/ai-zone$/,                  // AI 专区列表
  /^\/api\/ai-zone\/logs(\/[^/]+)?$/,  // 抓取日志浏览
  /^\/api\/tg-jasna$/,                 // Jasna-LTX 列表
  /^\/api\/tg-jasna\/export$/,         // ★ 导出 Excel(核心放行项)
  /^\/api\/tg-jasna\/logs(\/[^/]+)?$/,
  /^\/api\/tg-jasna\/link-status$/,    // 链接有效性(只读探测)
  /^\/api\/tg-jasna\/actors$/,         // 女演员目录树(只读统计)
  /^\/api\/actress-map$/,              // 演员映射(只读浏览)
  /^\/api\/actress-map\/dirs$/,
  /^\/api\/actress-names$/,
];

// 明确拉黑的接口(即便将来白名单写宽了也不会放出去) —— 含 115 cookie / 账号 / 调度配置
const DENY_ALWAYS = [
  /^\/api\/config/,                    // 含 115 cookie、javdb 账号等
  /^\/api\/schedule/,
  /^\/api\/cleanup/,
  /^\/api\/access\/(?!login|logout)/,
];

// ---------- 配置读写 ----------
function genCode(len = 8) {
  // 去掉容易混淆的 0/O/1/I/l
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += abc[buf[i] % abc.length];
  return out;
}

function hashPass(pass, salt) {
  return crypto.createHash('sha256').update(salt + '|' + String(pass)).digest('hex');
}

function loadCfg() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')) || {}; } catch { c = {}; }
  let dirty = false;
  if (!c.secret) { c.secret = crypto.randomBytes(32).toString('hex'); dirty = true; }
  if (!c.salt) { c.salt = crypto.randomBytes(16).toString('hex'); dirty = true; }
  if (!c.passHash) {
    // 首次启用: 自动生成访问码, 打到控制台 + 写提示文件
    const code = genCode(8);
    c.passHash = hashPass(code, c.salt);
    dirty = true;
    try {
      fs.writeFileSync(CODE_HINT_PATH,
        `公网只读访问码: ${code}\n` +
        `生成时间: ${new Date().toLocaleString('zh-CN')}\n` +
        `改密码: node _set-public-password.js 新密码\n`, 'utf8');
    } catch {}
    console.log('');
    console.log('  ┌─────────────────────────────────────────┐');
    console.log(`  │  公网访客访问码: ${code}                  │`);
    console.log('  │  (已写入 data/public-access-CODE.txt)   │');
    console.log('  └─────────────────────────────────────────┘');
    console.log('');
  }
  if (typeof c.sessionDays !== 'number') { c.sessionDays = 30; dirty = true; }
  if (typeof c.enabled !== 'boolean') { c.enabled = true; dirty = true; }
  // requirePass=false 时公网免口令, 但仍然只读(白名单+非GET拦截照旧)。
  // 默认 true(有口令); 要免口令改这个值即可, 或跑 node _set-public-auth.js off
  if (typeof c.requirePass !== 'boolean') { c.requirePass = true; dirty = true; }
  if (dirty) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(CFG_PATH, JSON.stringify(c, null, 2), 'utf8');
    } catch (e) { console.error('[public-mode] 写配置失败', e.message); }
  }
  return c;
}

const CFG = loadCfg();

// ---------- 会话签名 ----------
function signExp(exp) {
  return crypto.createHmac('sha256', CFG.secret).update('pub|' + exp).digest('base64url');
}
function makeToken() {
  const exp = Date.now() + (CFG.sessionDays || 30) * 86400000;
  return `${exp}.${signExp(exp)}`;
}
function verifyToken(tok) {
  if (!tok || typeof tok !== 'string') return false;
  const i = tok.indexOf('.');
  if (i <= 0) return false;
  const exp = tok.slice(0, i), sig = tok.slice(i + 1);
  const n = Number(exp);
  if (!Number.isFinite(n) || Date.now() > n) return false;
  const want = signExp(exp);
  if (sig.length !== want.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want)); } catch { return false; }
}

// ---------- 工具 ----------
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  raw.split(';').forEach((kv) => {
    const i = kv.indexOf('=');
    if (i < 0) return;
    out[kv.slice(0, i).trim()] = decodeURIComponent(kv.slice(i + 1).trim());
  });
  return out;
}

// ---------- 来源判定(2026-10-29 重写) ----------
// 旧逻辑: 有 cf-ray / cf-connecting-ip 头才算公网。
// 后果: 只有 Cloudflare 隧道能被识别, 换成 lucky 反代 / ngrok / loca.lt / frp,
//       或同 WiFi 手机访问, 全部漏判成"本机直连", 完整后台原样暴露在公网(无需口令)。
// 新逻辑反过来: 默认所有请求都是公网(口令 + 只读), 只有确证是本机直连才给全功能。
// 确证 = 三条同时满足:
//   1. 源地址是回环(127.0.0.1 / ::1 / ::ffff:127.0.0.1)
//   2. 没有任何转发头(x-forwarded-for / x-real-ip / cf-* / forwarded ...)
//   3. Host 是 127.0.0.1 / localhost / ::1 —— 反代会带上真实域名, 这条专门挡 lucky
// 需要在局域网内用全功能(如手机同 WiFi 调试)时, 用 PUBLIC_LOCAL_IPS 显式放行:
//   set PUBLIC_LOCAL_IPS=192.168.31.18,192.168.31.49  (多个用逗号分隔)
const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const FWD_HEADERS = [
  'x-forwarded-for', 'x-real-ip', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded',
  'cf-ray', 'cf-connecting-ip', 'cf-visitor',
];
const TRUST_IPS = new Set(String(process.env.PUBLIC_LOCAL_IPS || '')
  .split(',').map((s) => s.trim()).filter(Boolean));

function isLoopbackHost(hostHeader) {
  const raw = String(hostHeader || '').trim().toLowerCase();
  if (!raw) return false;                       // 没有 Host 头: 不放行, 按公网处理
  const name = raw.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}

function isLocalDirect(req) {
  const ip = String((req.socket && req.socket.remoteAddress) || '');
  const bare = ip.replace(/^::ffff:/, '');
  const isLoop = LOOPBACK_IPS.has(ip);
  const isTrust = TRUST_IPS.has(ip) || TRUST_IPS.has(bare);
  if (!isLoop && !isTrust) return false;
  // 只要出现任一转发头, 就说明前面站了反代/隧道 → 一律按公网处理
  for (const h of FWD_HEADERS) if (req.headers[h]) return false;
  if (isTrust && !isLoop) return true;           // 显式放行的局域网地址: 只看转发头
  return isLoopbackHost(req.headers.host);       // 回环: 还要求 Host 也是回环
}

function isPublicRequest(req) {
  if (process.env.PUBLIC_FORCE === '1') return true;
  return !isLocalDirect(req);
}

function clientIp(req) {
  return (req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] ||
    (req.socket && req.socket.remoteAddress) || '').toString();
}

// 登录爆破防护: 同 IP 5 分钟内失败 8 次锁定
const fails = new Map();
function isLocked(ip) {
  const rec = fails.get(ip);
  if (!rec) return 0;
  if (Date.now() - rec.t0 > 5 * 60 * 1000) { fails.delete(ip); return 0; }
  return rec.n >= 8 ? Math.ceil((5 * 60 * 1000 - (Date.now() - rec.t0)) / 1000) : 0;
}
function noteFail(ip) {
  const rec = fails.get(ip);
  if (!rec || Date.now() - rec.t0 > 5 * 60 * 1000) fails.set(ip, { n: 1, t0: Date.now() });
  else rec.n++;
}

function wantsHtml(req) {
  const a = String(req.headers.accept || '');
  return a.includes('text/html');
}

function setCookie(res, name, value, days, secure) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor((days || 30) * 86400)}`,
  ];
  if (secure) parts.push('Secure');   // 隧道侧是 https, 加上防明文传输
  res.append('Set-Cookie', parts.join('; '));
}
function clearCookie(res, name) {
  res.append('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// ---------- 首页注入(内存缓存, 文件变动时重读) ----------
const INDEX_PATH = path.join(__dirname, 'public', 'index.html');
let _indexCache = { mtime: 0, html: '' };

function readonlyIndex() {
  let st;
  try { st = fs.statSync(INDEX_PATH); } catch { return null; }
  if (!_indexCache.html || st.mtimeMs !== _indexCache.mtime) {
    try {
      const raw = fs.readFileSync(INDEX_PATH, 'utf8');
      // 在 </head> 前注入标记: 前端脚本(含 SPA)在任何初始化前就能知道自己只读
      const tag = '<script>window.__PUBLIC_READONLY__=true;</script>\n</head>';
      _indexCache = {
        mtime: st.mtimeMs,
        html: raw.includes('</head>') ? raw.replace('</head>', tag) : raw,
      };
    } catch { return null; }
  }
  return _indexCache.html;
}

// ---------- 中间件 ----------
function middleware() {
  return function publicMode(req, res, next) {
    if (!CFG.enabled) return next();
    if (!isPublicRequest(req)) return next();   // 本机直连: 全功能

    const url = req.path || '/';
    const method = req.method.toUpperCase();

    // 登录/登出接口
    if (url === LOGIN_API && method === 'POST') return handleLogin(req, res);
    if (url === LOGOUT_API) {
      clearCookie(res, COOKIE_NAME);
      return res.status(200).json({ ok: true });
    }

    // 登录页本身免鉴权
    if (url === LOGIN_PAGE || url === '/access') {
      return res.sendFile(path.join(__dirname, 'public', 'access.html'));
    }

    // 登录页要用的静态资源必须免鉴权, 否则登录页自己会"裸奔"(没有 CSS)
    // 这些文件都是纯前端样式/脚本, 不含任何业务数据
    if (url === '/favicon.svg' || url.startsWith('/assets/')) {
      return next();
    }

    // 1) 鉴权(可通过 data/public-access.json 的 requirePass=false 关掉;
    //    关掉只是免口令, 后面的只读限制/白名单一条都不少)
    if (CFG.requirePass !== false) {
      const tok = parseCookies(req)[COOKIE_NAME];
      if (!verifyToken(tok)) {
        if (wantsHtml(req) || method === 'GET') {
          if (url.startsWith('/api/')) {
            return res.status(401).json({ ok: false, code: 'NEED_AUTH', error: '需要访问口令' });
          }
          const next_ = encodeURIComponent(req.originalUrl || '/');
          return res.redirect(302, `${LOGIN_PAGE}?next=${next_}`);
        }
        return res.status(401).json({ ok: false, code: 'NEED_AUTH', error: '需要访问口令' });
      }
    }

    // 2) 只读限制: 只放行 GET/HEAD
    if (method !== 'GET' && method !== 'HEAD') {
      return res.status(403).json({
        ok: false, code: 'READONLY',
        error: '只读分享模式: 该操作已禁用',
      });
    }

    // 3) 路径白名单
    if (DENY_ALWAYS.some((re) => re.test(url))) {
      return res.status(403).json({ ok: false, code: 'READONLY', error: '只读分享模式: 该接口不对外开放' });
    }
    if (!ALLOW_GET.some((re) => re.test(url))) {
      return res.status(403).json({ ok: false, code: 'READONLY', error: '只读分享模式: 该接口不对外开放' });
    }

    // 4) 首页: 注入只读标记后直接返回(不走 static)
    if (url === '/' || url === '/index.html') {
      const html = readonlyIndex();
      if (html) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        return res.send(html);
      }
    }

    return next();
  };
}

function handleLogin(req, res) {
  const ip = clientIp(req);
  const lock = isLocked(ip);
  if (lock > 0) {
    return res.status(429).json({ ok: false, error: `尝试过于频繁, 请 ${lock} 秒后再试` });
  }
  const pass = (req.body && (req.body.password || req.body.code)) || '';
  const h = hashPass(pass, CFG.salt);
  let ok = false;
  try { ok = crypto.timingSafeEqual(Buffer.from(h), Buffer.from(CFG.passHash)); } catch { ok = false; }
  if (!ok) {
    noteFail(ip);
    return res.status(401).json({ ok: false, error: '访问口令不正确' });
  }
  fails.delete(ip);
  const isHttps = req.headers['cf-visitor'] || req.headers['x-forwarded-proto'] === 'https';
  setCookie(res, COOKIE_NAME, makeToken(), CFG.sessionDays || 30, !!isHttps);
  return res.json({ ok: true });
}

// 供 app.js 查询当前请求是否为只读访客
function isReadonlyRequest(req) {
  if (process.env.PUBLIC_FORCE === '1') return true;
  return isPublicRequest(req) && CFG.enabled;
}

module.exports = { middleware, isReadonlyRequest, isPublicRequest, CFG, CFG_PATH, COOKIE_NAME, hashPass, loadCfg };
