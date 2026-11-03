// 公共 CDP 工具模块
// 封装 115 浏览器自动化: 通道管理/窗口恢复/真实点击/键盘输入/弹窗处理
const fs = require('fs');
const path = require('path');

const CDP_HTTP = 'http://127.0.0.1:3457';           // cdp-proxy 端口
const WS_PORT = 9222;                                 // 115 浏览器调试端口
const CONFIG = require('../config');

let _cachedTab = null;

// ===== 基础 =====

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 检查 cdp-proxy 是否在线
async function checkProxy() {
  try {
    const r = await fetch('http://127.0.0.1:3457/health', { signal: AbortSignal.timeout(2000) });
    const d = await r.json();
    return !!d.connected;
  } catch { return false; }
}

// 获取 115 网盘标签(缓存,失败时刷新)
async function resolveTab(force = false) {
  if (_cachedTab && !force) return _cachedTab;
  try {
    const tabs = await (await fetch(`${CDP_HTTP}/targets`)).json();
    const wp = tabs.find(t => t.url.includes('115.com') && !t.url.includes('javdb') && !t.url.includes('transfer'));
    if (wp) { _cachedTab = wp.targetId; return _cachedTab; }
  } catch {}
  // 没有则新开
  const r = await fetch(`${CDP_HTTP}/new`, { method: 'POST', body: 'https://115.com/?cid=0&offset=0&mode=wangpan' });
  _cachedTab = (await r.json()).targetId;
  await sleep(6000);
  return _cachedTab;
}

// evalJS(带重试) - 注意参数顺序: (tabId, expr, retry, timeoutMs)
async function evalJS(tabId, expr, retry = 2, timeoutMs = null) {
  const tab = tabId || await resolveTab();
  for (let i = 0; i <= retry; i++) {
    try {
      const qs = timeoutMs ? `&timeout=${timeoutMs}` : '';
      const r = await fetch(`${CDP_HTTP}/eval?target=${tab}${qs}`, { method: 'POST', body: expr });
      const d = await r.json();
      if (d.value !== undefined) return d.value;
      if (i === retry) throw new Error('eval failed: ' + JSON.stringify(d).slice(0, 200));
    } catch (e) {
      if (i === retry) throw e;
    }
    await sleep(1500);
  }
}

// 导航
async function navigate(url, tabId = null) {
  const tab = tabId || await resolveTab();
  const r = await fetch(`${CDP_HTTP}/navigate?target=${tab}`, { method: 'POST', body: url });
  await r.text();
}

// 新开标签
async function newTab(url) {
  const r = await fetch(`${CDP_HTTP}/new`, { method: 'POST', body: url });
  return (await r.json()).targetId;
}

// 复用标签页: 同一个 key 只用同一个 tab 反复导航
// 原因: CDP /new 每次都新建标签, 会把已最小化的 115 浏览器窗口还原并顶到前台; navigate 到已有 tab 不会
// 跨进程: 补录是独立 node 进程, 内存池是空的 → 再按 URL 特征去 CDP 里找回已存在的同类 tab(平台启动时预热过就不会再新建)
const _tabPool = {};
async function reuseTab(url, key = 'default') {
  const pickByUrl = (list) => {
    const pages = list.filter(t => t.type === 'page' || !t.type);
    const u = String(url);
    if (u.includes('javdb.com')) {
      // 搜索页认 /search, 详情页认 /v/ —— 严格按各自特征找回, 避免两个 key 抢同一个 tab
      const want = key.includes('search') ? '/search' : '/v/';
      const hit = pages.find(t => String(t.url).includes('javdb.com') && String(t.url).includes(want));
      return hit ? hit.targetId : null;
    }
    return null;
  };

  let existing = _tabPool[key] || null;
  try {
    const list = await (await fetch(`${CDP_HTTP}/targets`)).json();
    if (Array.isArray(list)) {
      if (existing && !list.some(t => t.targetId === existing)) existing = null;   // 旧缓存已失效
      if (!existing) existing = pickByUrl(list);                                   // 跨进程找回
    }
  } catch {}

  if (existing) {
    _tabPool[key] = existing;
    try { await navigate(url, existing); return existing; } catch {}
  }
  const id = await newTab(url);
  _tabPool[key] = id;
  return id;
}

// 关闭标签
async function closeTab(tabId) {
  try { await fetch(`${CDP_HTTP}/close?target=${tabId}`); } catch {}
}

// 清理残留的抓取标签(sehuatang/javdb), 防止 tab 累积
// 返回真正关掉的个数; 同时把复用池里已失效的 targetId 摘掉, 避免下次 navigate 打在死标签上
async function cleanupTabs(keywords = ['sehuatang.net', 'javdb.com']) {
  let closed = 0;
  try {
    const r = await fetch(`${CDP_HTTP}/targets`);
    const targets = await r.json();
    for (const t of targets) {
      const u = t.url || '';
      if (keywords.some(k => u.includes(k))) {
        try { await fetch(`${CDP_HTTP}/close?target=${t.targetId}`); closed++; } catch {}
        if (_tabPool) {
          for (const k of Object.keys(_tabPool)) if (_tabPool[k] === t.targetId) delete _tabPool[k];
        }
        if (_cachedTab === t.targetId) _cachedTab = null;
      }
    }
  } catch {}
  return closed;
}

// ===== WebSocket CDP(真实输入/点击) =====

async function getCDP(tabId) {
  const { wsUrl } = await getBrowserDebugWs();
  const ws = new WebSocket(wsUrl);
  let msgId = 0;
  const pending = new Map();
  let sessionId = null;
  await new Promise((resolve, reject) => {
    ws.onopen = () => {
      const id = ++msgId;
      pending.set(id, (res) => { sessionId = res.sessionId; resolve(); });
      ws.send(JSON.stringify({ id, method: 'Target.attachToTarget', params: { targetId: tabId, flatten: true } }));
    };
    ws.onmessage = (evt) => {
      const m = JSON.parse(evt.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    };
    ws.onerror = () => reject(new Error('WS error'));
    setTimeout(() => reject(new Error('WS attach timeout')), 5000);
  });
  const send = (method, params) => new Promise((res) => {
    const id = ++msgId;
    pending.set(id, (m) => res(m));
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  return { ws, send };
}

// 真实鼠标点击(页面绝对坐标)
// 【绝不抢前台】不再调用 Page.bringToFront —— 那会让最小化的窗口还原并跳到最前。
// Input.dispatchMouseEvent 由 CDP 直接投进渲染进程的输入管线, 与窗口是否最小化/是否在前台无关。
// 只有"页面自己用 document.hasFocus() 做门控"的逻辑需要 focus emulation 兜一层。
// 返回值: true = 已发出点击; false = 坐标不可信未点击(调用方应改用 DOM click 兜底)
async function realClick(x, y, tabId = null) {
  const tab = tabId || await resolveTab();
  if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0) {
    console.log(`[cdp] realClick 坐标非法(${x},${y}), 跳过真实点击`);
    return false;
  }
  const { ws, send } = await getCDP(tab);
  try {
    // 让页面自认为处于焦点态(仅置 true, 不复位: 复位会触发 blur, 可能把刚点开的弹窗收回去)
    try { await send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch {}
    if (CONFIG.cdp.bringToFront === true) await send('Page.bringToFront', {}); // 紧急回滚开关
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await sleep(200);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await sleep(150);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    return true;
  } finally { try { ws.close(); } catch {} }
}

// 真实键盘输入(先清空再输入+回车)
async function realTypeAndEnter(text, tabId = null) {
  const tab = tabId || await resolveTab();
  const { ws, send } = await getCDP(tab);
  try {
    // 后台/最小化时也让页面处于"焦点态", 保证 Ctrl+A / insertText / Enter 走同一条输入路径
    try { await send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch {}
    // 清空(Ctrl+A + Backspace)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await sleep(100);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await sleep(150);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await sleep(100);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await sleep(400);
    // 输入
    await send('Input.insertText', { text });
    await sleep(800);
    // 回车
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await sleep(150);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  } finally { try { ws.close(); } catch {} }
}

// ===== 115 浏览器窗口 =====
// 【窗口操作铁律】本模块任何代码都不得让窗口从"最小化"变成"显示":
//   - 禁止 Page.bringToFront(会 Restore 最小化窗口并把窗口跳到最前)
//   - 禁止 Browser.setWindowBounds({windowState:'normal'})
// 窗口是否显示只由用户决定。程序侧只允许"纠正尺寸", 且仅在窗口本来就没最小化时。

const GUARD_DIR = path.join(__dirname, '..', 'data', 'guard');

// 给 Windows 窗口守护(tools/win-guard)打"程序意图"标记: 守护看到后会把随之而来的状态变化
// 认作程序行为而放行, 不当成"被顶起来"去压回
function guardIntent(reason) {
  try {
    fs.mkdirSync(GUARD_DIR, { recursive: true });
    fs.writeFileSync(path.join(GUARD_DIR, 'intent'), new Date().toISOString() + ' ' + reason, 'utf8');
  } catch {}
}

// 连浏览器级调试口并 attach 到指定 tab。send 返回完整消息体(含 error), 便于调用方看见 CDP 报错
async function openBrowserWs(tabId) {
  const { wsUrl } = await getBrowserDebugWs();
  const ws = new WebSocket(wsUrl);
  let msgId = 0;
  const pending = new Map();
  let sessionId = null;
  await new Promise((resolve, reject) => {
    ws.onopen = () => {
      const id = ++msgId;
      pending.set(id, (m) => { sessionId = m.result && m.result.sessionId; resolve(); });
      ws.send(JSON.stringify({ id, method: 'Target.attachToTarget', params: { targetId: tabId, flatten: true } }));
    };
    ws.onmessage = (evt) => {
      let m; try { m = JSON.parse(evt.data); } catch { return; }
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    ws.onerror = () => reject(new Error('WS error'));
    setTimeout(() => reject(new Error('attach timeout')), 5000);
  });
  const send = (method, params) => new Promise((res) => {
    const id = ++msgId;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  return { ws, send };
}

// 直连调试端口取一个已存在的页面目标(不新建标签, 不依赖 cdp-proxy)。
// 启动阶段 3457 还没起来时, 窗口操作只能用这个。
// 注意必须跳过 chrome-extension:// 的 offscreen 页和 devtools 页 —— 它们不属于任何
// 浏览器窗口, 拿去做 Browser.getWindowForTarget 会直接报 "Browser window not found"。
async function anyPageTab() {
  for (const host of ['127.0.0.1', '[::1]']) {
    try {
      const r = await fetch(`http://${host}:${WS_PORT}/json/list`, { signal: AbortSignal.timeout(2000) });
      if (!r.ok) continue;
      const list = await r.json();
      const pages = (list || []).filter(t => t.type === 'page' && t.id);
      const pick = pages.find(t => /^https?:/i.test(t.url || ''))
        || pages.find(t => !/^(chrome-extension|devtools|chrome):/i.test(t.url || ''));
      if (pick) return pick.id;
    } catch {}
  }
  return null;
}

// 窗口类操作用的目标: 已有的页面优先, 真的没有才让 resolveTab 去开一个
async function windowTab(tabId) {
  return tabId || await anyPageTab() || await resolveTab();
}

// 读视口与可见性(纯查询, 不改窗口状态)
async function viewportInfo(tabId = null) {
  const tab = tabId || await resolveTab();
  try {
    const s = await evalJS(tab, 'JSON.stringify({w:window.innerWidth,h:window.innerHeight,vis:document.visibilityState,focus:document.hasFocus()})', 0);
    const o = JSON.parse(s);
    o.ok = Number(o.w) > 0 && Number(o.h) > 0;   // 0/非数 = 坐标不可信
    return o;
  } catch { return { ok: false, w: 0, h: 0, vis: 'unknown', focus: false }; }
}

// 读窗口几何(纯查询)
async function windowStatus(tabId = null) {
  const tab = await windowTab(tabId);
  let ws;
  try {
    const c = await openBrowserWs(tab); ws = c.ws;
    const wr = await c.send('Browser.getWindowForTarget', { targetId: tab });
    if (wr.error) throw new Error(wr.error.message);
    const windowId = wr.result.windowId;
    const b = await c.send('Browser.getWindowBounds', { windowId });
    if (b.error) throw new Error(b.error.message);
    return { ok: true, windowId, bounds: b.result.bounds, viewport: await viewportInfo(tab) };
  } catch (e) {
    return { ok: false, reason: e.message };
  } finally { if (ws) try { ws.close(); } catch {} }
}

// 只在"窗口被拖得太小"时纠正尺寸: 不改变 windowState(最小化/最大化原样保留), 不置前
async function resizeWindow(tabId = null) {
  const tab = await windowTab(tabId);
  let ws;
  try {
    const c = await openBrowserWs(tab); ws = c.ws;
    const wr = await c.send('Browser.getWindowForTarget', { targetId: tab });
    if (wr.error) throw new Error(wr.error.message);
    const windowId = wr.result.windowId;
    const b = await c.send('Browser.getWindowBounds', { windowId });
    if (b.error) throw new Error(b.error.message);
    const bounds = b.result.bounds || {};
    const st = bounds.windowState || 'normal';
    if (st === 'minimized' || st === 'fullscreen') {
      return { ok: false, reason: 'skip state=' + st };   // 用户的选择, 一律不动
    }
    const W = CONFIG.cdp.windowW || 1280;
    const H = CONFIG.cdp.windowH || 800;
    if (Number(bounds.width) >= 800) {
      return { ok: false, reason: 'size ok ' + bounds.width + 'x' + bounds.height };
    }
    const r = await c.send('Browser.setWindowBounds', { windowId, bounds: { width: W, height: H } });
    if (r.error) throw new Error(r.error.message);
    return { ok: true, from: st + ' ' + bounds.width + 'x' + bounds.height, to: W + 'x' + H };
  } catch (e) {
    console.log('[cdp] 调整窗口尺寸失败:', e.message);
    return { ok: false, reason: e.message };
  } finally { if (ws) try { ws.close(); } catch {} }
}

// 兼容旧名: 语义已降级为"仅在窗口被拖得过小时纠正尺寸", 不再恢复窗口状态、不再置前
async function restoreWindow(tabId = null) { return resizeWindow(tabId); }

// 主动最小化(只给 start-all 首次拉起浏览器后用)。先打 intent 标记, 让守护把这次变化认作程序意图
async function minimizeWindow(tabId = null) {
  const tab = await windowTab(tabId);
  let ws;
  try {
    guardIntent('minimizeWindow');
    const c = await openBrowserWs(tab); ws = c.ws;
    const wr = await c.send('Browser.getWindowForTarget', { targetId: tab });
    if (wr.error) throw new Error(wr.error.message);
    const windowId = wr.result.windowId;
    const b = await c.send('Browser.getWindowBounds', { windowId });
    if (b.error) throw new Error(b.error.message);
    const bounds = b.result.bounds || {};
    if (bounds.windowState === 'minimized') return { ok: true, already: true, windowId };
    const r = await c.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    if (r.error) throw new Error(r.error.message);
    return { ok: true, windowId, from: bounds.windowState || 'normal' };
  } catch (e) {
    console.log('[cdp] 最小化窗口失败:', e.message);
    return { ok: false, reason: e.message };
  } finally { if (ws) try { ws.close(); } catch {} }
}

// 检查窗口是否可用于坐标计算: 最小化/视口不可用时直接放弃, 绝不还原窗口
async function ensureWindow() {
  const tab = await resolveTab();
  try {
    const info = await viewportInfo(tab);
    if (!info.ok) {
      console.log(`[cdp] 视口不可用(${info.w}x${info.h}, vis=${info.vis}), 保持窗口状态不变`);
      return false;
    }
    if (info.w < 800) {
      console.log(`[cdp] 窗口过小(${info.w}x${info.h}), 仅纠正尺寸(不还原窗口/不抢前台)`);
      const r = await resizeWindow(tab);
      return !!r.ok;
    }
    return false;
  } catch { return false; }
}

// 获取浏览器调试 WebSocket URL(自动检测 IPv4/IPv6 绑定, 兼容 115 浏览器两种绑定方式)
async function getBrowserDebugWs() {
  for (const host of ['127.0.0.1', '[::1]']) {
    try {
      const r = await fetch(`http://${host}:${WS_PORT}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        const ver = await r.json();
        if (ver.webSocketDebuggerUrl) return { wsUrl: ver.webSocketDebuggerUrl, ver };
      }
    } catch {}
  }
  throw new Error('无法连接浏览器调试端口 ' + WS_PORT);
}

// 关闭所有弹窗(offline-box / file-select)
async function closeDialogs(tabId = null) {
  const tab = tabId || await resolveTab();
  await evalJS(tab, `(() => {
    var obs = document.querySelectorAll('.offline-box');
    for (var i = 0; i < obs.length; i++) { var c = obs[i].querySelector('.close, a[btn=close]'); if (c) c.click(); }
    var fss = document.querySelectorAll('.file-select');
    for (var j = 0; j < fss.length; j++) { var c2 = fss[j].querySelector('.close, a[btn=close]'); if (c2) c2.click(); }
    return 'ok';
  })()`, 0);
  await sleep(1500);
}

// 重置网盘页面(弹窗随刷新消失)
async function resetPage(tabId = null) {
  await navigate('https://115.com/?cid=0&offset=0&mode=wangpan', tabId);
  await sleep(7000);
}

// ===== 目录弹窗 =====

// 读取目录弹窗路径
async function readDialogPath(tabId = null) {
  const tab = tabId || await resolveTab();
  try {
    const res = await evalJS(tab, `(() => {
      var iframe = document.querySelector('.file-select iframe');
      if (!iframe) return JSON.stringify({crumbs: ''});
      var idoc = iframe.contentDocument;
      if (!idoc) return JSON.stringify({crumbs: ''});
      var crumbs = [...idoc.querySelectorAll('[class*=crumb] a, [class*=path] a')].map(a => a.textContent.trim());
      return JSON.stringify({crumbs: crumbs.join('>'), text: idoc.body.innerText.slice(0, 100)});
    })()`, 0);
    return JSON.parse(res);
  } catch { return { crumbs: '' }; }
}

// 目录弹窗内搜索文件夹(真实输入+回车)并点击进入
async function searchDirInDialog(name, tabId = null) {
  const tab = tabId || await resolveTab();
  // 聚焦搜索框
  await evalJS(tab, `(() => {
    var i = document.querySelector('.file-select input[rel=search_input]');
    if (!i) return 'no input';
    i.focus(); i.select();
    return 'ok';
  })()`, 0);
  await sleep(500);
  await realTypeAndEnter(name, tab);
  await sleep(3000);
  // 点击结果(找同名文件夹链接, 绝对坐标点击, 轮询验证)
  for (let attempt = 0; attempt < 2; attempt++) {
    const pos = await evalJS(tab, `JSON.stringify((() => {
      var iframe = document.querySelector('.file-select iframe');
      if (!iframe) return null;
      var idoc = iframe.contentDocument;
      if (!idoc) return null;
      var ifr = iframe.getBoundingClientRect();
      var els = [...idoc.querySelectorAll('a')].filter(a => (a.textContent || '').trim() === ${JSON.stringify(name)} && a.getAttribute('data-btn') === 'open');
      if (!els.length) els = [...idoc.querySelectorAll('a')].filter(a => (a.textContent || '').trim() === ${JSON.stringify(name)});
      if (!els.length) return null;
      var r = els[0].getBoundingClientRect();
      return {x: Math.round(ifr.left + r.left + r.width / 2), y: Math.round(ifr.top + r.top + r.height / 2)};
    })())`, 0);
    if (pos && pos !== 'null') {
      const p = JSON.parse(pos);
      const rc = await realClick(p.x, p.y, tab);
      if (!rc) {
        // 坐标不可信(视口为 0 等) → 退回 iframe 内 DOM click
        await evalJS(tab, `(() => {
          var iframe = document.querySelector('.file-select iframe');
          if (!iframe || !iframe.contentDocument) return 'no frame';
          var els = [...iframe.contentDocument.querySelectorAll('a')].filter(a => (a.textContent || '').trim() === ${JSON.stringify(name)});
          if (!els.length) return 'no el';
          els[0].click();
          return 'dom';
        })()`, 0);
      }
      // 轮询验证路径
      for (let i = 0; i < 5; i++) {
        await sleep(2000);
        const path = await readDialogPath(tab);
        if (path.crumbs.includes(name)) return { ok: true, crumbs: path.crumbs };
      }
    }
    await sleep(1500);
  }
  return { ok: false, reason: '目录搜索未命中: ' + name };
}

// ===== 云下载弹窗 =====

// 打开云下载弹窗并粘贴磁力
async function openOfflineDialog(magnet, tabId = null) {
  const tab = tabId || await resolveTab();
  // 点顶部"云下载"按钮(弹窗打开)
  await evalJS(tab, `(() => {
    var links = [...document.querySelectorAll('a')].filter(a => (a.textContent || '').trim() === '云下载');
    if (links.length) { links[0].click(); return 'ok'; }
    return 'no';
  })()`, 0);
  await sleep(4000);
  // 粘贴磁力到 textarea
  const res = await evalJS(tab, `(() => {
    var ob = document.querySelector('.offline-box');
    if (!ob) return 'no ob';
    var ta = ob.querySelector('textarea');
    if (!ta) return 'no ta';
    var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(magnet)});
    ta.dispatchEvent(new Event('input', {bubbles: true}));
    ta.dispatchEvent(new Event('change', {bubbles: true}));
    return JSON.stringify({len: ta.value.length});
  })()`, 0);
  return res;
}

// 点击"选择其他文件夹"打开目录弹窗
async function openDirSelector(tabId = null) {
  const tab = tabId || await resolveTab();
  await evalJS(tab, `(() => {
    var dlg = document.querySelector('.offline-box');
    if (!dlg) return 'no dlg';
    var el = [...dlg.querySelectorAll('a, li, span')].find(e => (e.textContent || '').trim() === '选择其他文件夹…' && e.children.length === 0);
    if (el) { el.click(); return 'ok'; }
    return 'no btn';
  })()`, 0);
  await sleep(5000);
}

// 点击"保存到这里"
async function clickSaveHere(tabId = null) {
  const tab = tabId || await resolveTab();
  await evalJS(tab, `(() => {
    var dlg = document.querySelector('.file-select');
    if (!dlg) return 'no dlg';
    var el = [...dlg.querySelectorAll('button, a, [role=button]')].find(b => (b.textContent || '').trim() === '保存到这里');
    if (el) { el.click(); return 'ok'; }
    return 'no btn';
  })()`, 0);
  await sleep(3000);
}

// 点击"开始下载"(真实点击)
async function clickStartDownload(tabId = null) {
  const tab = tabId || await resolveTab();
  const pos = await evalJS(tab, `JSON.stringify((() => {
    var ob = document.querySelector('.offline-box');
    if (!ob) return null;
    var els = ob.querySelectorAll('a');
    for (var i = 0; i < els.length; i++) {
      if (els[i].textContent.trim() === '开始下载') {
        var r = els[i].getBoundingClientRect();
        return {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)};
      }
    }
    return null;
  })())`, 0);
  if (!pos || pos === 'null') return { ok: false, reason: '无开始下载按钮' };
  const p = JSON.parse(pos);
  const rc = await realClick(p.x, p.y, tab);
  await sleep(5000);
  let state = await evalJS(tab, 'document.querySelector(".offline-box") ? "open" : "closed"', 0);
  if (state !== 'closed') {
    // 坐标点击没生效(视口不可信/页面未响应) → 退回 DOM click。
    // 绝不用"还原窗口"来救, 那正是窗口弹到前台的元凶。
    console.log('[cdp] 开始下载未响应, 降级为 DOM click');
    await evalJS(tab, `(() => {
      var ob = document.querySelector('.offline-box');
      if (!ob) return 'no ob';
      var els = ob.querySelectorAll('a');
      for (var i = 0; i < els.length; i++) {
        if (els[i].textContent.trim() === '开始下载') { els[i].click(); return 'dom'; }
      }
      return 'no btn';
    })()`, 0);
    await sleep(5000);
    state = await evalJS(tab, 'document.querySelector(".offline-box") ? "open" : "closed"', 0);
  }
  return { ok: state === 'closed', state, via: rc ? 'real' : 'dom' };
}

// 完整离线提交流程
async function offlineSubmit(magnet, dirName, mode = 'single', tabId = null) {
  const tab = tabId || await resolveTab();
  await resetPage(tab);
  // 1. 打开云下载弹窗 + 粘贴磁力
  const paste = await openOfflineDialog(magnet, tab);
  if (typeof paste === 'string' && paste.startsWith('no')) return { ok: false, reason: paste };
  await sleep(1500);
  // 2. 选择目录
  await openDirSelector(tab);
  let dirOk = false;
  if (mode === 'multi') {
    const r = await searchDirInDialog('感谢祭、多人', tab);
    dirOk = r.ok;
    if (!dirOk) { await closeDialogs(tab); return { ok: false, reason: 'multi 目录未命中' }; }
  } else {
    const r = await searchDirInDialog(dirName, tab);
    dirOk = r.ok;
    if (!dirOk) { await closeDialogs(tab); return { ok: false, reason: '目录未命中: ' + dirName }; }
  }
  // 3. 保存到这里
  await clickSaveHere(tab);
  // 4. 开始下载
  const dl = await clickStartDownload(tab);
  if (!dl.ok) { await closeDialogs(tab); return { ok: false, reason: '开始下载无响应(' + dl.state + ')' }; }
  return { ok: true };
}

// ===== 云下载页面验证 =====

// 进入云下载管理页面(点左侧 a.grid-item)
async function openCloudPage(tabId = null) {
  const tab = tabId || await resolveTab();
  await closeDialogs(tab);
  const pos = await evalJS(tab, `JSON.stringify((() => {
    var a = [...document.querySelectorAll('a.grid-item')].find(x => (x.textContent || '').trim() === '云下载');
    if (!a) return null;
    var r = a.getBoundingClientRect();
    return {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)};
  })())`, 0);
  if (!pos || pos === 'null') return { ok: false, reason: '云下载入口未找到' };
  const p = JSON.parse(pos);
  const rc = await realClick(p.x, p.y, tab);
  if (!rc) {
    await evalJS(tab, `(() => {
      var a = [...document.querySelectorAll('a.grid-item')].find(x => (x.textContent || '').trim() === '云下载');
      if (!a) return 'no';
      a.click(); return 'dom';
    })()`, 0);
  }
  await sleep(8000);
  return { ok: true };
}

// 抓取云下载三栏任务文本
async function fetchCloudText(tabId = null) {
  const tab = tabId || await resolveTab();
  for (let i = 0; i < 8; i++) {
    await sleep(2500);
    try {
      const res = await evalJS(tab, `(() => {
        var frames = [...document.querySelectorAll('iframe')];
        var texts = [];
        for (var i = 0; i < frames.length; i++) {
          try {
            var idoc = frames[i].contentDocument;
            if (idoc && idoc.body) {
              var t = idoc.body.innerText || '';
              if (t.length > 50) texts.push(t);
            }
          } catch(e) {}
        }
        return JSON.stringify(texts.join('|||'));
      })()`, 0);
      const t = String(res || '');
      if (t.includes('正在下载') || t.includes('下载失败') || t.includes('完成记录')) return t;
    } catch {}
  }
  return '';
}

// 匹配磁力/番号在云下载三栏的状态
function matchCloudStatus(cloudText, code) {
  if (!cloudText) return { found: false, state: '页面未加载' };
  const idx = cloudText.indexOf(code);
  if (idx === -1) return { found: false, state: '未找到' };
  const ctx = cloudText.slice(Math.max(0, idx - 80), idx + 60);
  let state = '存在';
  if (/下载成功|已完成|成功/.test(ctx)) state = '成功';
  else if (/下载失败|失败/.test(ctx)) state = '失败';
  else if (/正在下载|下载中|0\.\d+%|\d+%/.test(ctx)) state = '下载中';
  return { found: true, state, ctx: ctx.replace(/\n/g, ' | ') };
}

// 关掉复用池里的常驻标签(可按 key 前缀过滤), 用于"一批补录跑完就收摊"
// 返回被关掉的 key 列表; 池里对应项同时清掉, 下次用到会自动重建
async function releaseTabs(prefix = '') {
  const closed = [];
  for (const k of Object.keys(_tabPool)) {
    if (prefix && !k.startsWith(prefix)) continue;
    const id = _tabPool[k];
    try { await fetch(`${CDP_HTTP}/close?target=${id}`); closed.push(k); } catch {}
    delete _tabPool[k];
    if (_cachedTab === id) _cachedTab = null;
  }
  return closed;
}

module.exports = {
  sleep, checkProxy, resolveTab, evalJS, navigate, newTab, closeTab, cleanupTabs, releaseTabs, reuseTab,
  realClick, realTypeAndEnter, ensureWindow, restoreWindow, closeDialogs, resetPage,
  readDialogPath, searchDirInDialog, offlineSubmit, openCloudPage, fetchCloudText, matchCloudStatus,
  // 窗口状态(只读查询 / 尺寸纠正 / 显式最小化), 详见本文件顶部"窗口操作铁律"
  windowStatus, viewportInfo, resizeWindow, minimizeWindow, guardIntent, anyPageTab,
  getBrowserDebugWs,
};
