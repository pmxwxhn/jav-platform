// 离线下载模块: 批量提交离线任务(含重试/删除重复文件)
// 优先走 115 MCP(add_offline_download + 目录名解析为 cid, 稳定); MCP 不可用时回退浏览器 CDP
const { sleep, offlineSubmit, ensureWindow, closeDialogs, search115 } = require('./cdp');
const dupCheck = require('./dup-check');
const mcp = require('./mcp115');
const cfg = require('../config');
const dbMod = require('../db');

function mcpEnabled() { return cfg.mcp115 && cfg.mcp115.enabled; }

// 查演员映射表直接拿 cid(免 115 搜索/建目录)
// 优先按 javdb 演员名(清洗后)匹配 —— 这是权威键, 避免拿"猜测的目录名"去查撞上别的演员的映射
// 其次按 115 目录名匹配(兼容历史调用)
function lookupMapCid(name, javdbActors = []) {
  try {
    const list = [].concat(javdbActors || []).map(a => String(a).replace(/[♀♂]/g, '').trim()).filter(Boolean);
    for (const a of list) {
      const r = dbMod.getActressMapByJavdb(a);
      if (r && r.cid && r.status === 'mapped') return { cid: r.cid, dir: r.dir_name };
    }
    if (name) {
      const byDir = dbMod.getActressMapByDir(name);
      if (byDir && byDir.cid && byDir.status === 'mapped') return { cid: byDir.cid, dir: byDir.dir_name };
      const byJavdb = dbMod.getActressMapByJavdb(name);
      if (byJavdb && byJavdb.cid && byJavdb.status === 'mapped') return { cid: byJavdb.cid, dir: byJavdb.dir_name };
    }
  } catch (e) { /* 表未建/异常时静默回退 */ }
  return null;
}

// 单部离线(带重试)
async function offlineOne(magnet, dirName, mode, options = {}) {
  const { retryTimes = 2, javdbActors = [], mapCid = null } = options;
  const useMcp = mcpEnabled() && await mcp.ensure();
  let lastErr = '';
  for (let attempt = 0; attempt <= retryTimes; attempt++) {
    if (attempt > 0) {
      console.log(`  [offline] 重试 ${attempt}/${retryTimes}...`);
      await sleep(3000);
    }
    try {
      if (useMcp) {
        // cid 优先级: ① pipeline 已查映射表传的 mapCid(权威) → ② lookupMapCid 按 javdb 演员名查 → ③ resolveDir 搜索/新建
        let cid = mapCid || null, via = mapCid ? 'map' : null, mappedDir = null;
        if (!cid) {
          const mapped = lookupMapCid(dirName, javdbActors);
          if (mapped && mapped.cid) { cid = mapped.cid; via = 'map'; mappedDir = mapped.dir; }
        }
        if (!cid) {
          // 新建演员目录时固定建在"演员划分"下(根目录>学习资源>演员划分), 不再建到根目录
          const isActressDir = dirName && !['感谢祭、多人', 'FC2', '待确认'].includes(dirName);
          const parentCid = isActressDir && cfg.mcp115.actressDirCid ? cfg.mcp115.actressDirCid : cfg.mcp115.rootCid;
          cid = await mcp.resolveDir(dirName, { autoCreate: cfg.mcp115.autoCreateDir, parentCid });
          // 新演员自动补建映射记录: javdb 演员名 → 115目录名 → cid, 下次直接命中, 不再搜索/新建
          if (cid && isActressDir) {
            const javdbName = [].concat(javdbActors || []).map(a => String(a).replace(/[♀♂]/g, '').trim()).find(Boolean);
            if (javdbName && !dbMod.getActressMapByJavdb(javdbName)) {
              try {
                dbMod.upsertActressMap({
                  javdb_name: javdbName, dir_name: dirName, cid: String(cid),
                  via: 'auto', status: 'mapped', note: '离线时自动补建(演员划分)', count: 0,
                });
                console.log(`  [offline] 自动补建演员映射: ${javdbName} → ${dirName} (cid ${String(cid).slice(0, 8)}...)`);
              } catch (e) { console.log('  [offline] 自动补建映射失败: ' + e.message); }
            }
          }
        }
        if (!cid) {
          lastErr = '未找到目录且无法创建: ' + dirName + (mcp.lastError() ? ' (' + mcp.lastError() + ')' : '');
          console.log('  [offline] ' + lastErr);
        }
        else {
          const r = await mcp.addOfflineDownload([magnet], cid);
          if (r) return { ok: true, attempt: attempt + 1, dirCid: cid, via: via || 'mcp', dir: mappedDir || dirName, already: !!r.already };
          // 失败原因取真实错因(会话失效/接口报错/限流), 不再只有一句"返回空"
          lastErr = '离线提交无响应' + (mcp.lastError() ? ': ' + mcp.lastError() : '(MCP 返回空, 可能限流)');
          console.log('  [offline] ' + lastErr);
        }
      } else {
        await ensureWindow();
        const r = await offlineSubmit(magnet, dirName, mode);
        if (r.ok) return { ok: true, attempt: attempt + 1, via: 'cdp' };
        lastErr = r.reason || '未知';
        console.log(`  [offline] 失败: ${lastErr}`);
      }
    } catch (e) {
      lastErr = e.message;
      console.log(`  [offline] 异常: ${e.message}`);
    }
    if (!useMcp) { try { await closeDialogs(); } catch {} await sleep(2000); }
  }
  return { ok: false, reason: lastErr, attempts: retryTimes + 1 };
}

// 处理重复文件(可选: 自动删除, 默认仅提示)
// 返回 { deleted: bool, detail }
async function handleDuplicate(code, options = {}) {
  const { deleteDuplicate = cfg.offline.deleteDuplicate } = options;

  // ---- MCP 优先 ----
  if (mcpEnabled() && await mcp.ensure()) {
    const data = await mcp.searchFiles(code, 0, 200);
    const videos = (Array.isArray(data) ? data : [])
      .filter(e => (e.file_category === '1' || e.type === '1' || e.sha1) && /\.(mp4|mkv|avi)$/i.test(e.file_name || e.name || ''))
      .map(e => ({ name: e.file_name || e.name || '', fid: e.file_id || e.fid || '' }))
      .filter(v => v.name);
    if (!videos.length) return { deleted: false, videos: [], note: '无匹配视频文件' };
    if (!deleteDuplicate) {
      return { deleted: false, videos, note: '发现重复文件, 未自动删除(配置为仅提示): ' + videos.map(v => v.name).join(', ') };
    }
    const fids = videos.map(v => v.fid).filter(Boolean);
    if (!fids.length) return { deleted: false, videos, note: '发现重复文件但无 file_id, 无法删除' };
    const r = await mcp.deleteFiles(fids);
    return { deleted: !!r, videos, note: r ? `已删除 ${fids.length} 个重复文件(进回收站)` : '删除失败' };
  }

  // ---- CDP 回退(原逻辑: 仅提示, 删除未实现) ----
  const text = await search115(code);
  const { items } = dupCheck.parseSearchItems(text);
  const videos = items.filter(i => i.type !== 'folder' && /\.(mp4|mkv|avi)$/i.test(i.name));
  if (!videos.length) return { deleted: false, videos: [], note: '无匹配视频文件' };
  if (!deleteDuplicate) {
    return { deleted: false, videos, note: '发现重复文件, 未自动删除(配置为仅提示): ' + videos.map(v => v.name).join(', ') };
  }
  return { deleted: false, videos, note: '自动删除未实现(UI 操作风险高, 建议手动删除): ' + videos.map(v => v.name).join(', ') };
}

module.exports = { offlineOne, handleDuplicate, lookupMapCid };
