// 115 判重模块: 搜索番号 → 解析文件 → 按板块标记匹配
// 优先走 115 MCP(search_files, 结构化结果, 稳定); MCP 不可用时回退浏览器 CDP
const { sleep, evalJS, navigate, resolveTab } = require('./cdp');
const mcp = require('./mcp115');
const cfg = require('../config');

function mcpEnabled() { return cfg.mcp115 && cfg.mcp115.enabled; }

// 在 115 搜索番号(结构化结果: { items:[{name,type,size}], notFound })
async function search115(code) {
  const searchKey = /^FC2PPV[-]?(\d+)$/i.test(code) ? code.match(/^FC2PPV[-]?(\d+)$/i)[1] : code;

  // ---- MCP 优先 ----
  if (mcpEnabled() && await mcp.ensure()) {
    try {
      const data = await mcp.searchFiles(searchKey, 0, 200);
      // 关键修复(2026-10-08): MCP 调用失败绝不能被当成"115 里没有这个番号" —— 那会直接导致重复下载。
      // 原来 `if (!data) return {items:[]}` 把"会话失效/超时"和"真的没搜到"混为一谈:
      // 判重日志显示"已存:false"看起来一切正常, 实际根本没查成功。现在抛出后走下面 CDP 兜底。
      if (data && data.__innerError) throw new Error('MCP 搜索返回错误: ' + data.__innerError);
      if (!data) throw new Error('MCP 搜索无响应' + (mcp.lastError() ? ': ' + mcp.lastError() : ''));
      const items = (Array.isArray(data) ? data : []).map(e => ({
        name: e.file_name || e.name || '',
        type: (e.file_category === '1' || e.type === '1' || e.sha1) ? 'file' : 'folder',
        size: e.file_size || e.size || '',
        fid: e.file_id || e.fid || '',
        // 115 时间戳(Unix 秒): user_ptime=创建, user_utime=更新
        ptime: e.user_ptime ? parseInt(e.user_ptime) * 1000 : null,
        utime: e.user_utime ? parseInt(e.user_utime) * 1000 : null,
      })).filter(i => i.name);
      return { items, notFound: items.length === 0, via: 'mcp' };
    } catch (e) {
      console.log('[dup] MCP 搜索异常, 回退 CDP:', e.message);
    }
  }

  // ---- CDP 回退(原网页搜索 → 文本) ----
  const tabId = await resolveTab();
  const searchUrl = 'https://115.com/?url=%2F%3Faid%3D1%26cid%3D0%26old_cid%3D0%26old_cid_name%3D%25E6%25A0%25B9%25E7%259B%25AE%25E5%25BD%2595%26search_value%3D' + encodeURIComponent(searchKey) + '%26ct%3Dfile%26ac%3Dsearch%26is_wl_tpl%3D1&submode=wangpan&mode=search';
  await navigate(searchUrl, tabId);
  for (let i = 0; i < 6; i++) {
    await sleep(3000);
    try {
      const res = await evalJS(tabId, `(() => {
        var frames = [...document.querySelectorAll('iframe')];
        for (var i = 0; i < frames.length; i++) {
          try {
            var idoc = frames[i].contentDocument;
            if (idoc && idoc.body) {
              var t = idoc.body.innerText || '';
              if (t.includes('当前共') || t.includes('没有找到') || t.includes('未找到')) {
                return JSON.stringify({text: t});
              }
            }
          } catch(e) {}
        }
        return JSON.stringify({text: ''});
      })()`, 0);
      const d = JSON.parse(res);
      if (d.text) return parseSearchItems(d.text);
    } catch {}
  }
  // MCP 与 CDP 双双失败: 明确标记 failed, 避免上层误认为"115 未存"
  return { items: [], notFound: false, via: 'cdp', failed: true };
}

// 解析搜索结果(兼容 文本 与 结构化对象)
function parseSearchItems(searchText) {
  if (searchText && typeof searchText === 'object') {
    if ('items' in searchText) return { items: searchText.items || [], notFound: !!searchText.notFound, failed: !!searchText.failed, via: searchText.via };
    return { items: [], notFound: false, failed: !!searchText.failed };
  }
  if (!searchText) return { items: [], notFound: false };
  if (searchText.includes('没有找到') || searchText.includes('未找到')) return { items: [], notFound: true };
  const lines = searchText.split('\n').map(l => l.trim()).filter(Boolean);
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const next = lines[i + 1] || '';
    if (next === '文件夹') { items.push({ name: lines[i], type: 'folder' }); i += 2; continue; }
    if (/^[\d.]+(GB|MB|KB|TB)$/i.test(next)) {
      items.push({ name: lines[i], type: lines[i + 2] || 'file', size: next });
      i += 3; continue;
    }
  }
  return { items, notFound: false };
}

// 判重: 按板块标记(sub=中文字幕, uncensor=破解)
// 关键规则(用户确认):
//   -UC 优先级 > -C: 若离线资源是 -C(中文字幕), 而 115 已存在 -UC(含 -4K-UC、-U.chs, 即"无码+中文字幕")资源时, 视为已存在, 不再重复存储 -C
//   -UC 与 -U.chs 是同一个意思(2026-09-04 用户再次确认), 双向等价顶替
//   判重依据 = 视频文件 + 带版本标记的番号目录:
//     115 搜索常只返回整理目录(如 CAWD-989-U.chs/)而不返回目录内视频文件,
//     目录名携带版本信息 → 视为该版本已存(2026-09-04 CAWD-989 教训: 只看文件导致 -U.chs 目录被漏判, 重复离线了 -C)
//     纯番号目录(名字不带 -C/.chs/-U/-UC 等标记)仍不作为已存依据
function checkDuplicate(code, boardType, searchResult) {
  const { items, notFound, failed } = parseSearchItems(searchResult);
  const need = boardType === 'sub' ? { mark: 'sub', label: '中文字幕(-C/.chs)' } : { mark: 'uncensor', label: '破解(-U)' };
  // 视频文件直接参与; 目录仅在名字带版本标记时参与
  const entries = items.filter(i => {
    if (i.type === 'folder') return /-UC\b|-U\.chs|-C\b|\.chs|-U\b|-4K/i.test(i.name);
    return /\.(mp4|mkv|avi|wmv|ts|mov|flv|rmvb)$/i.test(i.name);
  });
  const codeNorm = code.toUpperCase();
  const fc2Num = /^FC2PPV[-]?(\d+)$/i.test(code) ? code.match(/^FC2PPV[-]?(\d+)$/i)[1] : null;
  const matched = [], unmatched = [];
  for (const v of entries) {
    const nameUpper = v.name.toUpperCase();
    let isSameCode = fc2Num ? nameUpper.includes(fc2Num)
      : (nameUpper.startsWith(codeNorm + '-') || nameUpper.startsWith(codeNorm + '.') || nameUpper.startsWith(codeNorm + '_') || nameUpper.startsWith(codeNorm + ' '));
    if (!isSameCode) continue;
    const is4k = /-4K/i.test(v.name);
    // 版本判定(优先级: UC > C, UC > U):
    //   isUC: -UC / -4K-UC / -U.chs / -4K-U.chs (无码+中文字幕, 最完整)
    //   isC : -C / .chs (中文字幕)
    //   isU : -U (无码/破解, 无字幕)
    const isUC = /-UC\b|-U\.chs/i.test(v.name);
    const isC = !isUC && (/-C\b|\.chs/i.test(v.name));
    const isU = !isUC && !isC && (/-U\b/i.test(v.name));
    // 匹配: sub 板块要 -C, -UC 可顶替(用户规则); uncensor 板块要 -U, -UC 可顶替
    const ok = need.mark === 'sub' ? (isUC || isC) : (isUC || isU);
    const rec = { name: v.name, size: v.size, is4k, isUC, isC, isU, isFolder: v.type === 'folder' };
    // 115 修改时间(Unix 秒 → 可读); 优先 utime(更新), 无则 ptime(创建)
    if (v.utime || v.ptime) {
      const ts = v.utime || v.ptime;
      const dt = new Date(ts);
      rec.time = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
    }
    if (ok) matched.push(rec); else unmatched.push(rec);
  }
  return {
    code, exists: matched.length > 0, notFound,
    // failed=true 表示"这次没查成功", 而不是"115 里没有" —— 上层须区分, 否则会重复下载
    failed: !!failed, unknown: !!failed,
    matched, unmatched,
    hasOtherVersions: matched.length + unmatched.length > 1,
    label: need.label,
  };
}

module.exports = { search115, parseSearchItems, checkDuplicate };
