// 云下载验证模块
// 优先用 115 MCP 的离线任务状态验证(稳定, 不依赖浏览器); MCP 不可用时回退浏览器 CDP
const mcp115 = require('./mcp115');
const { sleep, openCloudPage, fetchCloudText, matchCloudStatus, closeDialogs, resetPage } = require('./cdp');

// 验证一批番号: 返回 { code: {found, state, ctx} }
async function verifyBatch(codes) {
  // 优先走 MCP 离线任务状态
  try {
    if (await mcp115.ensure()) {
      const r = await mcp115.verifyOffline(codes);
      if (r) {
        console.log('  [云下载验证] 走 MCP 离线任务状态(已脱离浏览器)');
        return r;
      }
    }
  } catch (e) {
    console.log('  [云下载验证] MCP 失败, 回退 CDP:', e.message);
  }
  // 回退: 浏览器 CDP
  return await verifyBatchCdp(codes);
}

// 切换三栏标签(CDP 回退用)
async function switchTab(label) {
  const { evalJS, realClick, resolveTab } = require('./cdp');
  const tabId = await resolveTab();
  const pos = await evalJS(tabId, `JSON.stringify((() => {
    var frames = [...document.querySelectorAll('iframe')];
    for (var i = 0; i < frames.length; i++) {
      try {
        var idoc = frames[i].contentDocument;
        if (idoc && idoc.body && idoc.body.innerText.includes('正在下载')) {
          var els = idoc.querySelectorAll('a, span, li, em, b');
          for (var j = 0; j < els.length; j++) {
            var t = (els[j].textContent || '').trim();
            if (t.startsWith('${label}')) {
              var r = els[j].getBoundingClientRect();
              var fr = frames[i].getBoundingClientRect();
              return {x: Math.round(fr.left + r.left + r.width / 2), y: Math.round(fr.top + r.top + r.height / 2)};
            }
          }
        }
      } catch(e) {}
    }
    return null;
  })())`, 0);
  if (!pos || pos === 'null') return { ok: false };
  const p = JSON.parse(pos);
  const rc = await realClick(p.x, p.y, tabId);
  if (!rc) {
    // 坐标不可信 → 退回 DOM click(不靠还原窗口救)
    await evalJS(tabId, `(() => {
      var frames = [...document.querySelectorAll('iframe')];
      for (var i = 0; i < frames.length; i++) {
        try {
          var idoc = frames[i].contentDocument;
          if (!idoc || !idoc.body || !idoc.body.innerText.includes('正在下载')) continue;
          var els = idoc.querySelectorAll('a, span, li, em, b');
          for (var j = 0; j < els.length; j++) {
            if ((els[j].textContent || '').trim().startsWith('${label}')) { els[j].click(); return 'dom'; }
          }
        } catch(e) {}
      }
      return 'no';
    })()`, 0);
  }
  await sleep(4000);
  return { ok: true };
}

// ===== CDP 回退实现(原浏览器方案, 保留以备 MCP 不可用时) =====
async function verifyBatchCdp(codes) {
  const result = {};
  try {
    const opened = await openCloudPage();
    if (!opened.ok) {
      for (const c of codes) result[c] = { found: false, state: '云下载页打开失败' };
      return result;
    }
    let text = await fetchCloudText();
    const tabs = ['正在下载', '下载失败', '完成记录'];
    const allTexts = {};
    for (const t of tabs) {
      allTexts[t] = text;
      if (t !== tabs[tabs.length - 1]) {
        const switched = await switchTab(tabs[tabs.indexOf(t) + 1]);
        if (switched.ok) text = await fetchCloudText();
      }
    }
    for (const c of codes) {
      let found = false, state = '未找到';
      for (const [tabName, tabText] of Object.entries(allTexts)) {
        const m = matchCloudStatus(tabText, c);
        if (m.found) { found = true; state = `${m.state}(${tabName})`; break; }
      }
      result[c] = { found, state };
    }
  } catch (e) {
    for (const c of codes) result[c] = { found: false, state: '异常: ' + e.message };
  }
  return result;
}

module.exports = { verifyBatch };
