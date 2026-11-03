// 115 垃圾文件清理模块 (MCP 实现, 精确匹配 + 查重)
// 流程: MCP search_files 搜索 → 本地精确过滤(文件名+后缀) → 查重分组(sha1) → MCP delete_files 按 fid 删除
// 关键改进(v2):
//   1. 115 搜索是分词模糊匹配("聚 合 全 網 H 直 播" 会命中只含单字的文件/文件夹)
//      → 必须在本地按"完整文件名"精确过滤, 只保留匹配文件
//   2. 支持无后缀规则自动补全常见后缀(.html/.htm/.txt/.jpg/.png/.mp4 等)
//   3. 按 sha1 查重: 同一 sha1 的文件标记为重复组, 可一起删除(保留第一个)
// 安全: 删除/重命名需显式调用且 confirm=true; 删除按 fid 白名单, 绝不按关键字全删
const mcp = require('./mcp115');

// 常见后缀(无后缀规则自动补全用)
const COMMON_EXTS = ['.html', '.htm', '.txt', '.jpg', '.jpeg', '.png', '.gif', '.mp4', '.mkv', '.db', '.ini', '.log'];

// 规范化文件名: 去空白/NFC
function norm(s) {
  try { s = s.normalize('NFC'); } catch {}
  return String(s || '').trim().replace(/\s+/g, ' ');
}

// 判断 name 是否精确匹配规则: 规则无后缀时尝试常见后缀补全
function exactMatch(name, rule) {
  const n = norm(name);
  const r = norm(rule);
  if (!n || !r) return false;
  if (n === r) return true;
  // 规则无后缀 → 尝试 规则+常见后缀
  if (!/\.[a-zA-Z0-9]{1,5}$/.test(r)) {
    for (const ext of COMMON_EXTS) {
      if (n === r + ext) return true;
    }
  }
  return false;
}

// 搜索关键字, 返回 { notFound, files: [{name, fid, size, sha1}], folders }
// mode: 'exact' = 精确文件名匹配(含后缀补全) | 'prefix' = 前缀匹配(文件名以 keyword 开头, 用于重命名去前缀)
async function scanKeyword(keyword, mode = 'exact') {
  try {
    if (!(await mcp.ensure())) return { notFound: true, files: [], folders: [] };
    const data = await mcp.searchFiles(keyword, 0, 500);
    if (!data) return { notFound: true, files: [], folders: [] };
    const ents = mcp.findEntries(data);
    const files = [], folders = [];
    for (const e of ents) {
      const name = (e.file_name || e.name || e.fn || '').trim();
      const fid = String(e.file_id || e.fid || e.id || '');
      if (!name || !fid) continue;
      const size = e.file_size || e.fs || e.size || '';
      if (mcp.isFileEntry(e)) {
        const hit = mode === 'prefix' ? name.startsWith(keyword) : exactMatch(name, keyword);
        if (hit) {
          files.push({ name, fid, size: String(size), sha1: e.sha1 || '' });
        }
      } else {
        folders.push({ name, fid });
      }
    }
    return { notFound: files.length === 0 && folders.length === 0, files, folders };
  } catch (e) {
    console.log('[cleanup] 搜索异常:', e.message);
    return { notFound: true, files: [], folders: [] };
  }
}

// 前缀去重命名: 搜索匹配文件 → 去掉前缀 → 调 batch_rename
async function renameViaApi(prefix, { confirm = false } = {}) {
  const log = [];
  const { files } = await scanKeyword(prefix, 'prefix');
  const matched = files.filter(f => String(f.name).startsWith(prefix));
  matched.forEach(m => { m.newName = String(m.name).slice(prefix.length); });
  log.push(`搜索「${prefix}」→ 命中 ${files.length} 个文件(以「${prefix}」开头的 ${matched.length} 个)`);
  if (!matched.length) { log.push('无匹配, 跳过'); return { ok: false, log, matched: [] }; }
  if (!confirm) { log.push('⛔ 未授权最终确认, 未执行重命名'); return { ok: false, log, matched }; }
  const renames = {};
  for (const m of matched) renames[m.fid] = m.newName;
  try {
    const r = await mcp.batchRename(renames);
    if (r !== null) {
      log.push(`✅ 重命名完成: ${matched.length} 个文件(已去前缀「${prefix}」)`);
      return { ok: true, log, renamed: matched.length, matched };
    }
    log.push('❌ 重命名 API 返回空');
    return { ok: false, log, matched };
  } catch (e) {
    log.push('❌ 重命名异常: ' + e.message);
    return { ok: false, log, matched };
  }
}

// 按 fid 批量重命名(前端传 fids + newNames, 去掉前缀)
async function renameByIds(items, { confirm = false } = {}) {
  const log = [];
  const list = [].concat(items || []).map(x => ({ fid: String(x.fid), newName: String(x.newName) })).filter(x => x.fid && x.newName);
  if (!list.length) { log.push('无待重命名文件'); return { ok: false, log }; }
  log.push(`待重命名 ${list.length} 项(去掉前缀)`);
  if (!confirm) { log.push('⛔ 未授权最终确认, 未执行'); return { ok: false, log, items: list }; }
  const renames = {}; for (const x of list) renames[x.fid] = x.newName;
  try {
    const r = await mcp.batchRename(renames);
    // 115-Desktop MCP 协议对 batch_rename 的响应可能是空对象 {}, 不能因响应为空判断失败
    if (r && r.__error) { log.push('❌ ' + JSON.stringify(r.__error).slice(0, 200)); return { ok: false, log }; }
    log.push(`✅ 重命名 ${list.length} 项完成(进 115 即时生效)`);
    return { ok: true, log, renamed: list.length };
  } catch (e) {
    log.push('❌ 重命名异常: ' + e.message);
    return { ok: false, log };
  }
}

// 按 fid 列表删除(进回收站)
async function deleteByIds(ids, { confirm = false } = {}) {
  const log = [];
  const list = [].concat(ids || []).map(String).filter(Boolean);
  if (!list.length) { log.push('无待删文件'); return { ok: false, log }; }
  log.push(`待删除 ${list.length} 项(进回收站)`);
  if (!confirm) { log.push('⛔ 未授权最终确认(confirm=false), 未执行删除'); return { ok: false, log, ids: list }; }
  try {
    const r = await mcp.deleteFiles(list);
    // 115-Desktop MCP 协议对 delete_files 的响应可能是空对象 {}, 不能因响应为空判断失败
    // 只要 call() 没抛异常(JSON-RPC 错误), 且 r 不是错误对象, 即视为成功
    if (r && r.__error) { log.push('❌ ' + JSON.stringify(r.__error).slice(0, 200)); return { ok: false, log, ids: list }; }
    log.push(`✅ 已删除 ${list.length} 项(进回收站)`);
    return { ok: true, log, deleted: list.length, ids: list };
  } catch (e) {
    log.push('❌ 删除异常: ' + e.message);
    return { ok: false, log, ids: list };
  }
}

// 查重: 按 sha1 分组, 返回重复组(每组 ≥2 个文件)
// 用途: 垃圾文件常是同一文件复制多份, 可识别后一起删除
function groupDuplicates(files) {
  const bySha1 = new Map();
  for (const f of files) {
    if (!f.sha1) continue;
    if (!bySha1.has(f.sha1)) bySha1.set(f.sha1, []);
    bySha1.get(f.sha1).push(f);
  }
  const groups = [];
  for (const [sha1, items] of bySha1) {
    if (items.length >= 2) groups.push({ sha1, count: items.length, files: items });
  }
  // 按数量降序
  groups.sort((a, b) => b.count - a.count);
  return groups;
}

// 兼容旧接口名
async function deleteMatched(keyword, { confirm = false } = {}) {
  // 先精确扫描, 再按结果 fid 删除(不再按关键字全删)
  const { files, folders } = await scanKeyword(keyword);
  const all = [...files, ...folders.map(f => ({ ...f, isFolder: true }))];
  const log = [];
  log.push(`搜索「${keyword}」→ 精确命中 ${files.length} 个文件 + ${folders.length} 个文件夹`);
  if (!all.length) { log.push('无结果, 跳过'); return { ok: false, log }; }
  return deleteByIds(all.map(x => x.fid), { confirm });
}

async function selectAllForDelete(keyword, { confirm = false } = {}) {
  return deleteMatched(keyword, { confirm });
}

// 供 app.js 展示: 精确命中明细 + 查重组
async function scanForReport(keyword, mode = 'exact') {
  const r = await scanKeyword(keyword, mode);
  return {
    notFound: r.notFound,
    count: r.files.length,
    items: r.files.map(f => ({ name: f.name, size: f.size, fid: f.fid, sha1: f.sha1 })),
    folders: r.folders.map(f => ({ name: f.name, fid: f.fid })),
  };
}

module.exports = { scanKeyword, exactMatch, groupDuplicates, deleteByIds, deleteMatched, renameViaApi, renameByIds, selectAllForDelete, scanForReport, COMMON_EXTS, searchUrl: null };
