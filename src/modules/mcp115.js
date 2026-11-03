// 115 MCP 客户端(Node.js 版)
// 移植自 AI技能包 115-file-organizer/scripts/115_mcp_lib.py(实战锤炼版)
// 通过 115-Desktop 的 MCP 服务(默认 http://127.0.0.1:11502/mcp)操作 115 网盘
// 兼容接口三次格式变更: 解析器用兼容版; 命名字段多候选; 成功标志多形态
//
// 所有方法自动 ensure() 初始化; 若 MCP 不可用(服务未开/网络异常)返回 null,
// 调用方据此回退到浏览器 CDP 方案(cdp.js),保证生产流程不中断。

const MCP_URL = (process.env.MCP115_URL || 'http://127.0.0.1:11502/mcp');
const MCP_TOKEN = process.env.MCP115_TOKEN || '';
const BASE_HEADERS = {
  Accept: 'application/json, text/event-stream',
  'Content-Type': 'application/json',
};
if (MCP_TOKEN) BASE_HEADERS.Authorization = `Bearer ${MCP_TOKEN}`;
const TIMEOUT = 30000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ===== 兼容解析辅助 =====
const FID_KEYS = ['file_id', 'fid', 'id', 'fileId', 'cid'];
const NAME_KEYS = ['file_name', 'name', 'n', 'filename', 'fn'];
const SIZE_KEYS = ['size_byte', 'size', 'file_size', 's', 'fs'];
const CHILD_KEYS = ['children', 'child', 'list', 'items', 'data', 'tree', 'files'];
const CID_KEYS = ['cid', 'file_id', 'fid', 'id'];

function pick(d, keys) {
  if (!d || typeof d !== 'object') return null;
  for (const k of keys) {
    const v = d[k];
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}

// 从任意嵌套结构里找出 文件/文件夹 条目(含 name + id 的 dict)
function findEntries(data) {
  const out = [];
  function walk(x) {
    if (Array.isArray(x)) { for (const i of x) walk(i); return; }
    if (x && typeof x === 'object') {
      if (pick(x, NAME_KEYS) !== null && pick(x, FID_KEYS) !== null) out.push(x);
      for (const k of CHILD_KEYS) if (k in x) walk(x[k]);
    }
  }
  walk(data);
  // 去重(按 fid)
  const seen = new Set(); const uniq = [];
  for (const e of out) {
    const k = String(pick(e, FID_KEYS));
    if (!seen.has(k)) { seen.add(k); uniq.push(e); }
  }
  return uniq;
}

// 条目是否为文件(文件夹通常无 sha1 / file_category==='0' / type==='2')
function isFileEntry(e) {
  if (e && (e.sha1 || e.fs || e.file_size)) return true;
  if (e && (e.file_category === '1' || e.type === '1')) return true;
  if (e && (e.file_category === '0' || e.type === '2')) return false;
  return false; // 默认当文件夹(保守)
}

// 文件名归一化(匹配/去重): NFC + lower + 去前导符号 + 压缩空格
function normName(s) {
  try { s = s.normalize('NFC'); } catch {}
  s = String(s).toLowerCase().replace(/^[-—_　 ]+/, '').trim();
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/\(\s+/g, '(');
  return s;
}

// ===== SSE 解析(兼容三种成功格式) =====
// 返回解析后的内层 data; 明确失败返回 null; 解析异常返回 null
function parseSse(text) {
  if (!text) return null;
  const lines = text.split('\n');
  for (const line of lines) {
    const s = line.trim();
    if (!s.startsWith('data:')) continue;
    let d;
    try { d = JSON.parse(s.slice(5).trim()); } catch { continue; }
    if (d.error) return { __error: d.error }; // 顶层 error(如校验失败)
    if (!d.result) continue;
    const res = d.result;
    if (res.isError) return null;
    const content = res.content || [];
    const parts = content.filter(c => c.type === 'text').map(c => c.text || '').join('');
    if (!parts) return null;
    let inner;
    try { inner = JSON.parse(parts); } catch { return parts; }
    if (!inner || typeof inner !== 'object') return inner;
    // 工具内层错误(如 10008「任务已存在」): 只有 error 字段, 没有 state/code/data
    // 关键: 不能直接返回 null —— 那样调用方只看到"无响应", 无法区分错误类型
    //       (2026-10-08 离线全线静默失败即因此, 详见 _innerError 处理)
    if (inner.error && inner.state === undefined && !('data' in inner)) {
      return { __innerError: String(inner.error) };
    }
    const st = inner.state;
    if (st === false || (typeof st === 'string' && /fail|error|false/i.test(st))) return null;
    if (typeof inner.code === 'number' && inner.code !== 0 && !('data' in inner)) return null;
    if (st === true || st === 'success' || inner.code === 0) {
      return ('data' in inner) ? inner.data : inner;
    }
    if ('data' in inner) return inner.data;
    if ('children' in inner || 'cid' in inner) return inner;
    return null;
  }
  return null;
}

// ===== 客户端 =====
class Mcp115Client {
  constructor() { this.sid = null; this._id = 0; }

  async init() {
    const r = await fetch(MCP_URL, {
      method: 'POST',
      headers: BASE_HEADERS,
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'jav-platform', version: '1.0' } },
        id: 0,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    this.sid = r.headers.get('Mcp-Session-Id') || r.headers.get('mcp-session-id');
    if (!this.sid) throw new Error('MCP 会话获取失败(115-Desktop MCP 未启动?)');
  }

  async call(tool, args, retry = 2) {
    if (!this.sid) await this.init();
    this._id++;
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: tool, arguments: args }, id: this._id });
    for (let i = 0; i <= retry; i++) {
      try {
        const r = await fetch(MCP_URL, {
          method: 'POST',
          headers: { ...BASE_HEADERS, 'Mcp-Session-Id': this.sid },
          body,
          signal: AbortSignal.timeout(TIMEOUT),
        });
        if (r.status === 200) {
          const t = await r.text();
          const d = parseSse(t);
          if (d && d.__error) throw new Error('MCP error: ' + JSON.stringify(d.__error).slice(0, 200));
          if (d !== null) return d;
          // 解析不出结果: 打原始报文尾部, 便于排查(原来在这里静默返回 null)
          console.log(`[mcp115] ${tool} 响应无法解析: ${String(t).replace(/\s+/g, ' ').slice(-220)}`);
        } else {
          // 关键修复(2026-10-08): 115 客户端重启后, 旧会话立即失效并返回 404 "Session not found"。
          // 原代码只在 status===200 时处理, 404 被当成"无响应"重试 3 次后静默返回 null ——
          // 而 ensure() 已把 _available 缓存为 true, 于是平台会以失效会话永久静默失败:
          // 判重看似"未找到"(实为失败), 离线看似"提交失败"(实为根本没发出请求)。
          const t = await r.text().catch(() => '');
          const sessionGone = r.status === 404 || /session\s*not\s*found/i.test(t);
          if (sessionGone || r.status === 400 || r.status >= 500) {
            console.log(`[mcp115] HTTP ${r.status}${sessionGone ? ' (会话已失效)' : ''}, 重建 MCP 会话后重试...`);
            try { await this.init(); } catch (e) { console.log('[mcp115] 重建会话失败:', e.message); }
          } else {
            console.log(`[mcp115] ${tool} HTTP ${r.status}: ${String(t).slice(0, 150)}`);
          }
        }
      } catch (e) {
        if (i === retry) throw e;
      }
      if (i < retry) await sleep(500);
    }
    return null;
  }

  // ---- 高层封装(参数名经实测确认) ----
  listFiles(cid, offset = 0, limit = 200) {
    return this.call('list_files', { cid: String(cid), offset, limit });
  }
  searchFiles(keyword, offset = 0, limit = 200) {
    return this.call('search_files', { keyword: String(keyword), offset, limit });
  }
  createFolder(pid, name) {
    // 实测参数名为 name(非旧版 cname); 失败回退 cname
    return this.call('create_folder', { pid: String(pid), name });
  }
  deleteFiles(ids) {
    const arr = [].concat(ids).map(String);
    return this.call('delete_files', { file_ids: arr });
  }
  moveFiles(fids, toCid) {
    return this.call('move_files', { file_ids: [].concat(fids).map(String), to_cid: String(toCid) });
  }
  renameFile(fid, name) {
    return this.call('rename_file', { file_id: String(fid), name });
  }
  batchRename(renames) {
    const o = {}; for (const k in renames) o[String(k)] = renames[k];
    return this.call('batch_rename', { renames: o });
  }
  // 提交离线下载
  // 幂等语义: 115 对重复磁力返回 error 码 10008「任务已存在，请勿输入重复的链接地址」,
  //   这表示该磁力已在离线队列中 —— 应视为成功, 而不是失败。
  //   若队列中该任务已是「下载失败」状态, 则删除后重新提交, 否则会永久卡死(2026-10-08 修复)。
  async addOfflineDownload(urls, saveDirId = '0') {
    const arr = [].concat(urls).map(String);
    const args = { urls: arr, save_dir_id: String(saveDirId) };
    const r = await this.call('add_offline_download', args);
    if (r && r.__innerError) {
      const msg = r.__innerError;
      if (/任务已存在|已存在|重复的链接|10008/i.test(msg)) {
        const hash = (arr[0].match(/btih:([0-9a-fA-F]+)/i) || [])[1];
        if (hash) {
          try {
            const h = hash.toLowerCase();
            const all = await this.listOfflineTasks();
            const hit = (all || []).find(t => String(t.url || '').toLowerCase().includes(h));
            if (hit && (hit.status === -1 || /失败/.test(hit.status_text || ''))) {
              console.log(`  [mcp115] 队列中该任务已失败(${hit.name}), 删除后重新提交`);
              await this.call('delete_offline_task', { info_hash: h });
              const r2 = await this.call('add_offline_download', args);
              if (r2 && !r2.__innerError) return r2;
              throw new Error('失败任务删除后重提仍失败: ' + ((r2 && r2.__innerError) || '无响应'));
            }
          } catch (e) { console.log('[mcp115] 失败任务重提异常:', e.message); }
        }
        return { state: true, already: true, note: '任务已存在(已在离线队列中)' };
      }
      throw new Error('add_offline_download: ' + msg);
    }
    return r;
  }
  // 注意: 115 的 get_offline_tasks 分页参数是 page(从 1 开始), 不是 offset/limit
  // (2026-10-08 实测: 传 offset/limit 会被忽略, 永远只返回第 1 页)
  getOfflineTasks(page = 1) {
    return this.call('get_offline_tasks', { page: Number(page) || 1 });
  }
  // 分页拉取全部离线任务, 返回任务数组(兼容 tasks / list 两种返回结构)
  async listOfflineTasks(maxPage = 60) {
    const tasks = [];
    let pageCount = null;
    for (let p = 1; p <= maxPage; p++) {
      const r = await this.call('get_offline_tasks', { page: p });
      if (!r) break;
      // 115Lite MCP 返回: {"state":true,"data":{"data":{"tasks":[...]}}}
      // 旧 115-desktop MCP 是 {"tasks":[...]}; 这里两种都兼容
      const box = (r && r.data && r.data.data) || (r && r.data) || r || {};
      const arr = Array.isArray(r) ? r : (r.tasks || r.list || box.tasks || box.list || []);
      if (pageCount === null) pageCount = r.page_count || box.page_count || null;
      if (!arr.length) break;
      tasks.push(...arr);
      if (pageCount && p >= pageCount) break;   // 末页
      if (arr.length < 30) break;               // 兜底: 每页 30 条
    }
    return tasks;
  }
  // 用离线任务状态验证一批番号是否已成功下载
  // 返回 { code: {found, state, status} } —— state 含「成功/失败/正在下载」关键词, 供 pipeline 判定
  async verifyOffline(codes) {
    const tasks = await this.listOfflineTasks();
    if (!tasks) return null;
    const flat = (s) => (s || '').toLowerCase().replace(/\s+/g, '');
    const norm = (s) => flat(s).replace(/-/g, ''); // 去连字符, 容忍 FC2PPV-4159457 vs FC2PPV 4159457
    const idx = tasks.map(t => ({
      text: norm((t.name || '') + ' ' + (t.url || '')),
      status: t.status,
    }));
    const result = {};
    for (const code of codes) {
      const c = norm(code);
      const hit = idx.find(b => b.text.includes(c));
      if (hit) {
        let state;
        if (hit.status === 2) state = '下载成功';
        else if (hit.status === -1) state = '下载失败';
        else state = '正在下载';
        result[code] = { found: true, state, status: hit.status };
      } else {
        result[code] = { found: false, state: '未找到', status: null };
      }
    }
    return result;
  }
  getFileDetail(path) {
    return this.call('get_file_detail', { path });
  }

  // 枚举单文件夹, 返回 { files:{name:[fid]}, folders:{name:cid} }; 失败返回 null
  async enumFolder(cid, maxPage = 600) {
    const files = {}, folders = {};
    for (let page = 0; page < maxPage; page++) {
      const data = await this.listFiles(cid, page * 200);
      if (data == null) return null;
      const ents = findEntries(data);
      if (!ents.length) break;
      for (const e of ents) {
        const nm = pick(e, NAME_KEYS), fid = pick(e, FID_KEYS);
        if (!nm || !fid) continue;
        if (isFileEntry(e)) (files[normName(nm)] = files[normName(nm)] || []).push(String(fid));
        else folders[normName(nm)] = String(fid);
      }
      if (ents.length < 200) break;
      await sleep(100);
    }
    return { files, folders };
  }
}

// ===== 单例 + ensure() =====
let _client = null;
let _available = null; // null=未探测, true/false
let _lastError = '';   // 最近一次调用失败原因(供上层日志使用, 不再静默丢错)

async function ensure() {
  if (_available === true && _client) return true;
  if (_available === false) return false;
  try {
    _client = new Mcp115Client();
    await _client.init();
    _available = true;
    return true;
  } catch (e) {
    _available = false;
    _lastError = e.message;
    console.log('[mcp115] 不可用(回退 CDP):', e.message);
    return false;
  }
}

function client() { return _client; }

// ===== 对外方法(自动 ensure, 不可用返回 null) =====
async function _wrap(fn) {
  if (!(await ensure())) { _lastError = 'MCP 服务不可用'; return null; }
  try { const r = await fn(_client); _lastError = ''; return r; }
  catch (e) {
    _lastError = e.message;
    // 连接层错误(MCP 服务重启/端口未监听): 清掉可用性缓存,
    // 否则 _available=true 会被永久缓存, 后续所有调用静默失败
    if (/fetch failed|ECONNREFUSED|ECONNRESET|timeout|aborted|socket|terminated/i.test(e.message)) {
      _available = null; _client = null;
      console.log('[mcp115] 连接异常, 已清除可用性缓存, 下次调用将重新探测');
    }
    console.log('[mcp115] 调用异常:', e.message);
    return null;
  }
}

const mcp115 = {
  available: () => _available,
  ensure,
  client,
  lastError: () => _lastError,
  setUrl(u) { /* 仅供测试覆盖 */ if (u) process.env.MCP115_URL = u; },
  listFiles: (cid, o, l) => _wrap(c => c.listFiles(cid, o, l)),
  searchFiles: (kw, o, l) => _wrap(c => c.searchFiles(kw, o, l)),
  createFolder: (pid, name) => _wrap(c => c.createFolder(pid, name)),
  deleteFiles: (ids) => _wrap(c => c.deleteFiles(ids)),
  moveFiles: (fids, toCid) => _wrap(c => c.moveFiles(fids, toCid)),
  renameFile: (fid, name) => _wrap(c => c.renameFile(fid, name)),
  batchRename: (renames) => _wrap(c => c.batchRename(renames)),
  addOfflineDownload: (urls, saveDirId) => _wrap(c => c.addOfflineDownload(urls, saveDirId)),
  getOfflineTasks: (o, l) => _wrap(c => c.getOfflineTasks(o, l)),
  listOfflineTasks: () => _wrap(c => c.listOfflineTasks()),
  verifyOffline: (codes) => _wrap(c => c.verifyOffline(codes)),
  getFileDetail: (path) => _wrap(c => c.getFileDetail(path)),
  enumFolder: (cid, mp) => _wrap(c => c.enumFolder(cid, mp)),

  // 按名称找文件夹, 返回 cid 或 null(只认文件夹)
  async findFolderByName(name, parentCid = null) {
    const data = await mcp115.searchFiles(name, 0, 50);
    if (data && data.__innerError) { _lastError = 'search_files: ' + data.__innerError; return null; }
    if (!data) return null;   // 调用失败(_lastError 已记录) / 无结果
    const target = normName(name);
    const ents = findEntries(data);
    for (const e of ents) {
      const nm = pick(e, NAME_KEYS), fid = pick(e, FID_KEYS);
      if (!nm || !fid) continue;
      if (normName(nm) === target && !isFileEntry(e)) return String(fid);
    }
    return null;
  },

  // 解析目录名 → cid(供离线下载 save_dir_id)
  // 找不到时若 autoCreate 则建在 root(默认 '0')下并返回新 cid, 否则返回 null
  async resolveDir(name, { autoCreate = true, parentCid = '0' } = {}) {
    if (!name) return null;
    const cid = await mcp115.findFolderByName(name);
    if (cid) return cid;
    if (autoCreate) {
      const r = await mcp115.createFolder(parentCid, name);
      if (r && r.file_id) return String(r.file_id);
      if (r && r.fid) return String(r.fid);
      if (r && r.cid) return String(r.cid);
      // 建目录失败时保留原因, 供 offline.js 打出可诊断的错(原来是静默返回 null)
      if (r && r.__innerError) _lastError = 'create_folder: ' + r.__innerError;
      else if (!r) _lastError = _lastError || 'create_folder 无响应';
    }
    return null;
  },
};

module.exports = mcp115;
module.exports.findEntries = findEntries;
module.exports.isFileEntry = isFileEntry;
module.exports.normName = normName;
module.exports.pick = pick;
