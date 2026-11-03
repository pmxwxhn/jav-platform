// ============================================
// 115影视资源自动管理平台 - 前端 SPA 核心
// 主题切换 / Hash 路由 / 视图管理 / 各页业务逻辑
// ============================================

// ---------- API ----------
async function api(url, method = 'GET', body = null) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opt.body = JSON.stringify(body);
  const r = await fetch(url, opt);
  return r.json();
}

function showMsg(el, text, type) {
  if (!el) return;
  el.textContent = text;
  el.className = 'msg show ' + (type || 'ok');
  setTimeout(() => { el.className = 'msg'; }, 5000);
}

// 复制文本到剪贴板(带按钮反馈; 平台所有 📋 按钮共用)
function copyText(text, btn) {
  const done = () => {
    if (!btn) return;
    const old = btn.textContent;
    btn.textContent = '✓ 已复制';
    setTimeout(() => { btn.textContent = old; }, 1500);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(String(text)).then(done).catch(() => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = String(text);
  ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch {}
  ta.remove();
  done();
}

function badge(status) {
  const map = {
    'success': ['ok', '✓ 成功'], 'running': ['blue', '● 运行中'],
    'partial': ['warn', '◐ 部分成功'], 'failed': ['red', '✕ 失败'],
    'stopped': ['gray', '■ 已停止'], 'downloading': ['warn', '↓ 离线中'],
    'pending': ['gray', '○ 待处理'], 'skipped': ['gray', '— 跳过'],
  };
  const [cls, txt] = map[status] || ['gray', status];
  return `<span class="badge ${cls}">${txt}</span>`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------- 主题 ----------
const THEMES = [
  { id: 'deepsea', name: '深海蓝', cls: 'td-deepsea', icon: '🌊' },
  { id: 'light', name: '极简白', cls: 'td-light', icon: '☀️' },
  { id: 'dark', name: '暗夜黑', cls: 'td-dark', icon: '🌙' },
  { id: 'mossgold', name: '墨绿金', cls: 'td-mossgold', icon: '🍃' },
];

function getTheme() { return localStorage.getItem('jav_theme') || 'deepsea'; }

function applyTheme(id) {
  document.documentElement.dataset.theme = id;
  localStorage.setItem('jav_theme', id);
  document.querySelectorAll('.theme-dot').forEach(d => {
    d.classList.toggle('active', d.dataset.theme === id);
  });
}

function renderThemeSwitch() {
  const holder = document.getElementById('themeSwitch');
  if (!holder) return;
  holder.innerHTML = THEMES.map(t => `
    <div class="theme-dot ${t.cls}" data-theme="${t.id}" title="${t.name}" onclick="applyTheme('${t.id}')"></div>`).join('');
  applyTheme(getTheme());
}

// ---------- 视图/路由 ----------
const VIEWS = ['dashboard', 'config', 'tasks', 'reports', 'actress-map', 'ai-zone', 'tg-jasna'];
const viewCleaners = {};

function currentView() {
  const h = location.hash.replace(/^#\/?/, '').split('?')[0] || 'dashboard';
  return VIEWS.includes(h) ? h : 'dashboard';
}

function parseQuery() {
  const q = location.hash.split('?')[1];
  const out = {};
  if (q) new URLSearchParams(q).forEach((v, k) => out[k] = v);
  return out;
}

function navigate(view) { location.hash = '/' + view; }

function switchView(view) {
  if (!VIEWS.includes(view)) view = 'dashboard';
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const el = document.getElementById('view-' + view);
  if (el) el.classList.add('active');
  document.querySelectorAll('.topbar nav a').forEach(a => {
    a.classList.toggle('active', a.dataset.view === view);
  });
  Object.values(viewCleaners).forEach(fn => { try { fn(); } catch {} });
  Object.keys(viewCleaners).forEach(k => delete viewCleaners[k]);
  const initFn = viewInits[view];
  if (initFn) initFn(parseQuery());
  window.scrollTo({ top: 0 });
}

window.addEventListener('hashchange', () => switchView(currentView()));

function startPolling(fn, ms, key) { stopPolling(key); viewCleaners[key] = setInterval(fn, ms); }
function stopPolling(key) { if (viewCleaners[key]) { clearInterval(viewCleaners[key]); delete viewCleaners[key]; } }

const viewInits = {};

// ============================================
// 仪表盘
// ============================================
viewInits.dashboard = () => {
  loadStats();
  loadRuns();
  startPolling(loadStats, 30000, 'stats');
  startPolling(loadRuns, 30000, 'runs');
};

async function loadStats() {
  const s = await api('/api/stats');
  const el = document.getElementById('stats');
  if (!el) return;
  el.innerHTML = `
    <div class="stat-card"><span class="stat-icon">🎬</span><div class="stat-num">${s.totalVideos}</div><div class="stat-label">累计影片记录</div></div>
    <div class="stat-card"><span class="stat-icon">🔁</span><div class="stat-num">${s.totalRuns}</div><div class="stat-label">运行次数</div></div>
    <div class="stat-card green"><span class="stat-icon">✅</span><div class="stat-num">${s.successRuns}</div><div class="stat-label">成功运行</div></div>
  `;
}

async function loadRuns() {
  const runs = await api('/api/runs?limit=15');
  const tbody = document.querySelector('#runsTbl');
  if (!tbody) return;
  tbody.innerHTML = runs.map(r => `
    <tr>
      <td><b>#${r.id}</b></td>
      <td>${r.type}</td>
      <td>${r.board ? (r.board === 103 ? '高清字幕' : '无码原创') : '全部'}</td>
      <td>${r.run_date || '-'}</td>
      <td>${badge(r.status)}</td>
      <td>${r.started_at || '-'}</td>
      <td>${r.duration_ms ? (r.duration_ms / 1000).toFixed(0) + 's' : '-'}</td>
      <td><a href="#/tasks?id=${r.id}">查看日志</a> · <a href="javascript:void(0)" onclick="deleteRun(${r.id})" style="color:var(--red)">删除</a></td>
    </tr>`).join('') || '<tr><td colspan="8"><div class="empty"><span class="big">🗂️</span>暂无运行记录,点右上角「立即运行」开始第一次抓取</div></td></tr>';
}

// 日期 'YYYY-MM-DD' → 'X月X日'
function fmtDate(d) {
  if (!d) return '';
  const p = d.split('-');
  if (p.length !== 3) return d;
  return parseInt(p[1]) + '月' + parseInt(p[2]) + '日';
}

// 板块中文名
function boardNames(board) {
  if (board === 'all') return '高清中文字幕、亚洲无码原创';
  return board === '103' ? '高清中文字幕' : '亚洲无码原创';
}

async function runPipeline(board) {
  const btns = document.querySelectorAll('.run-btn');
  const status = document.getElementById('runStatus');
  // 日期范围
  const dateStart = document.getElementById('runDateStart').value || null;
  const dateEnd = document.getElementById('runDateEnd').value || null;

  // 1. 校验日期选择
  if (dateStart && dateEnd && dateStart > dateEnd) {
    alert('⚠️ 开始日期不能晚于结束日期!\n请检查抓取日期范围。');
    return;
  }

  // 2. 运行前确认(明确告知将运行的日期与板块)
  // 本地日期(toISOString 是 UTC, 凌晨 0~8 点会算成前一天)
  const _d = new Date();
  const today = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, '0')}-${String(_d.getDate()).padStart(2, '0')}`;
  let dateDesc;
  if (dateStart && dateEnd) dateDesc = dateStart === dateEnd ? fmtDate(dateStart) : fmtDate(dateStart) + '-' + fmtDate(dateEnd);
  else if (dateStart) dateDesc = fmtDate(dateStart);
  else if (dateEnd) dateDesc = fmtDate(dateEnd);
  else dateDesc = fmtDate(today);
  const bName = boardNames(board);
  const targetDate = dateStart || dateEnd || today;

  // 已抓取提醒: 该板块该日期已有记录则提示覆盖
  const boards = board === 'all' ? [103, 36] : [parseInt(board)];
  const already = [];
  for (const b of boards) {
    try {
      const list = await api(`/api/videos?board=${b}&date=${targetDate}`);
      if (list && list.length) {
        const nm = b === 103 ? '高清中文字幕' : '亚洲无码原创';
        already.push(`${nm}(${fmtDate(targetDate)})`);
      }
    } catch {}
  }

  let msg = `即将开始运行 ${dateDesc} 的 ${bName} 抓取任务,是否继续?`;
  if (already.length) msg += `\n\n⚠️ 其中 ${already.join('、')} 已有抓取记录,继续将重新抓取并覆盖。`;
  if (!confirm(msg)) { status.textContent = '已取消'; return; }

  btns.forEach(b => b.disabled = true);
  status.textContent = '正在启动流水线...';
  const body = { board: board || 'all' };
  if (dateStart) body.dateStart = dateStart;
  if (dateEnd) body.dateEnd = dateEnd;
  const r = await api('/api/run', 'POST', body);
  if (r.ok) {
    status.textContent = '✅ ' + r.message;
    showMsg(document.getElementById('msgDash'), r.message, 'ok');
  } else {
    status.textContent = '❌ ' + r.error;
    showMsg(document.getElementById('msgDash'), r.error, 'err');
  }
  setTimeout(() => { btns.forEach(b => b.disabled = false); }, 3000);
  setTimeout(loadRuns, 5000);
  // 自动打开运行日志面板并实时滚动(轮询最新 running 任务)
  if (r && r.ok) {
    setTimeout(async () => {
      for (let i = 0; i < 15; i++) {
        await new Promise(r2 => setTimeout(r2, 1000));
        try {
          const runs = await api('/api/runs?limit=3');
          const run = (runs || []).find(x => x.status === 'running');
          if (run) { showLog(run.id); break; }
        } catch {}
      }
    }, 1500);
  }
}

// ============================================
// 配置
// ============================================
let cfgData = null;
viewInits.config = () => { if (!cfgData) loadConfig(); loadCleanupCfg(); };

// 进入仪表盘时: 如果清理区还没扫描过, 先显示空占位卡, 再自动后台触发一次扫描
(function initCleanupPlaceholder() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      const r = document.getElementById('cleanupResult');
      if (r && !r.innerHTML.trim()) {
        r.innerHTML = '<div style="padding:18px;background:#f8fafc;border:1px dashed #dfe6ee;border-radius:10px;font-size:13px;color:var(--muted);text-align:center">⏳ 正在自动加载清理清单...</div>';
        runCleanupScan();
      }
    });
  }
})();

function fillTimeSelect(selected) {
  const sel = document.getElementById('s_time');
  if (!sel) return;
  sel.innerHTML = '';
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 30]) {
      const val = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
      const opt = document.createElement('option');
      opt.value = val; opt.textContent = val;
      if (val === selected) opt.selected = true;
      sel.appendChild(opt);
    }
  }
}

function renderRules(rules) {
  const list = document.getElementById('ruleList');
  if (!list) return;
  list.innerHTML = '';
  rules.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'rule-row';
    row.innerHTML = `
      <span style="color:var(--primary-dark);font-weight:700">规则${i + 1}</span>
      <label>评分 &gt;</label>
      <input type="number" step="0.1" min="0" max="5" class="r-score" value="${r.score}">
      <label>人数 &gt;</label>
      <input type="number" min="0" class="r-votes" value="${r.votes || 0}" ${r.force ? 'disabled' : ''}>
      <label style="margin-left:6px"><input type="checkbox" class="r-force" ${r.force ? 'checked' : ''}> 无条件</label>
      <button class="rule-del" title="删除此规则">✕</button>`;
    const forceCb = row.querySelector('.r-force');
    const votesInput = row.querySelector('.r-votes');
    forceCb.addEventListener('change', () => { votesInput.disabled = forceCb.checked; });
    row.querySelector('.rule-del').addEventListener('click', () => { rules.splice(i, 1); renderRules(rules); });
    list.appendChild(row);
  });
}

async function loadConfig() {
  const cfg = await api('/api/config');
  cfgData = cfg;
  setSwitch('b103_enabled', cfg.boards[103].enabled);
  setSwitch('b36_enabled', cfg.boards[36].enabled);
  const rules = cfg.filter.rules && cfg.filter.rules.length ? cfg.filter.rules : [
    { id: 'r1', score: 4.0, votes: 200, force: false },
    { id: 'r2', score: 4.2, votes: 100, force: false },
    { id: 'r3', score: 4.5, votes: 0, force: true },
  ];
  renderRules(rules);
  document.getElementById('o_actressSearch').checked = cfg.offline.actressSearch;
  document.getElementById('o_simplified').checked = cfg.offline.simplified;
  document.getElementById('o_deleteDup').checked = cfg.offline.deleteDuplicate;
  document.getElementById('o_verifyCloud').checked = cfg.offline.verifyViaCloud;
  document.getElementById('o_retry').value = cfg.offline.retryTimes;
  document.getElementById('r_comments').checked = cfg.report.includeComments;
  document.getElementById('r_charts').checked = cfg.report.includeCharts;
  document.getElementById('s_enabled').checked = cfg.schedule.enabled;
  fillTimeSelect(cfg.schedule.time || '08:00');
  document.getElementById('s_mode').value = cfg.schedule.mode || 'builtin';
  const sc = await api('/api/schedule');
  document.getElementById('schedStatus').textContent = sc.builtinActive ? '● 内置调度运行中' : '○ 内置调度未运行';
}

function setSwitch(id, checked) {
  const el = document.getElementById(id);
  if (!el) return;
  el.checked = !!checked;
  const txt = document.getElementById(id + '_txt');
  if (txt) txt.textContent = checked ? '启用' : '停用';
}

function getSwitch(id) {
  const el = document.getElementById(id);
  const txt = document.getElementById(id + '_txt');
  if (el) {
    const v = el.checked;
    if (txt) txt.textContent = v ? '启用' : '停用';
    return v;
  }
  return false;
}

function collectConfig() {
  const ruleRows = [...document.querySelectorAll('#ruleList .rule-row')];
  const rules = ruleRows.map((row, i) => ({
    id: 'r' + (i + 1),
    score: parseFloat(row.querySelector('.r-score').value) || 0,
    votes: parseInt(row.querySelector('.r-votes').value) || 0,
    force: row.querySelector('.r-force').checked,
  }));
  if (!rules.length) rules.push({ id: 'r1', score: 5, votes: 0, force: true });
  return {
    boards: {
      103: { name: '高清中文字幕', enabled: getSwitch('b103_enabled'),
        dateStart: null, dateEnd: null, skipEuro: true, filter: 'sub' },
      36: { name: '亚洲无码原创', enabled: getSwitch('b36_enabled'),
        dateStart: null, dateEnd: null, skipFC2: true, filter: 'uncensor' },
    },
    filter: { rules, relatedScore: 4.0, relatedVotes: 300 },
    offline: {
      actressSearch: document.getElementById('o_actressSearch').checked,
      simplified: document.getElementById('o_simplified').checked,
      deleteDuplicate: document.getElementById('o_deleteDup').checked,
      verifyViaCloud: document.getElementById('o_verifyCloud').checked,
      retryTimes: parseInt(document.getElementById('o_retry').value) || 2,
    },
    report: {
      includeComments: document.getElementById('r_comments').checked,
      includeCharts: document.getElementById('r_charts').checked,
    },
    schedule: {
      enabled: document.getElementById('s_enabled').checked,
      time: document.getElementById('s_time').value,
      mode: document.getElementById('s_mode').value,
    },
  };
}

/* ============================================
115 垃圾文件清理(MCP 实现)
============================================ */
async function loadCleanupCfg() {
  const el = document.getElementById('cleanupFiles');
  const el2 = document.getElementById('cleanupPrefixes');
  if (!el || !el2) return;
  const r = await api('/api/cleanup/config');
  if (r.ok) {
    el.value = (r.files || []).join('\n');
    el2.value = (r.prefixes || []).join('\n');
  }
}
async function saveCleanupCfg() {
  const files = (document.getElementById('cleanupFiles').value || '').split('\n').map(x => x.trim()).filter(Boolean);
  const prefixes = (document.getElementById('cleanupPrefixes').value || '').split('\n').map(x => x.trim()).filter(Boolean);
  const r = await api('/api/cleanup/config', 'POST', { files, prefixes });
  const el = document.getElementById('msgCleanup');
  if (el) {
    el.textContent = r.ok ? `✅ 已保存: ${r.files.length} 个文件名 + ${r.prefixes.length} 个前缀` : '❌ ' + (r.error || '保存失败');
    el.style.color = r.ok ? 'var(--muted)' : '#d33';
  }
}
let _cleanupScan = { deleteTargets: [], renameTargets: [], delTotal: 0, renTotal: 0, dups: [] };
async function runCleanupScan() {
  const status = document.getElementById('cleanupStatus');
  const result = document.getElementById('cleanupResult');
  if (!status || !result) return;
  status.textContent = '⏳ 扫描中(逐关键字搜索 115-MCP, 精确匹配)...';
  result.style.display = 'block';  // 保持显示占位卡片
  result.innerHTML = '<div style="padding:14px;background:#f8fafc;border:1px dashed #dfe6ee;border-radius:10px;font-size:13px;color:var(--muted);text-align:center">⏳ 正在搜索 115 关键词...</div>';
  try {
    const r = await api('/api/cleanup/scan', 'POST', {});
    if (!r.ok) {
      status.textContent = '❌ ' + (r.error || '扫描失败');
      result.innerHTML = '<div style="padding:14px;background:#fbe9e9;border:1px solid #f3c0c0;border-radius:10px;font-size:13px;color:#b11">❌ 扫描失败: ' + esc(r.error || '未知错误') + '</div>';
      return;
    }
    _cleanupScan = {
      deleteTargets: r.deleteTargets || [],
      renameTargets: r.renameTargets || [],
      delTotal: r.delTotal || 0,
      renTotal: r.rTotal || r.renTotal || 0,
      dups: r.dups || [],
    };
    status.textContent = `✅ 扫描完成: 待删 ${_cleanupScan.delTotal} 项, 待去前缀重命名 ${_cleanupScan.renTotal} 项` +
      (_cleanupScan.dups.length ? `, 查重 ${_cleanupScan.dups.length} 组` : '');
    // 重新渲染清单
    result.innerHTML = renderCleanupChecklist();
    result.style.display = 'block';
    updateCleanupActionBtns();
    const logLines = [];
    (r.deleteTargets || []).forEach(g => logLines.push(`🗑️ [${g.keyword}] (${g.type}) 待删 ${g.count} 项`));
    (r.renameTargets || []).forEach(g => logLines.push(`✏️ [${g.keyword}] (${g.type}) 待去前缀 ${g.count} 项`));
    if (r.dups && r.dups.length) logLines.push(`🔄 查重: ${r.dups.length} 组`);
    showCleanupLogs(logLines.length ? logLines : ['扫描完成, 无匹配']);
  } catch (e) {
    status.textContent = '❌ 扫描异常: ' + e.message;
    result.innerHTML = '<div style="padding:14px;background:#fbe9e9;border:1px solid #f3c0c0;border-radius:10px;font-size:13px;color:#b11">❌ 扫描异常: ' + esc(e.message) + '</div>';
  }
}

// 渲染勾选清单: 分"删除文件"和"去前缀重命名"两个卡片组
function renderCleanupChecklist() {
  // 查重仅对删除类有意义(标记每组第 1 个为保留)
  const dupKeepFids = new Set();
  const dupExcessFids = new Set();
  if (_cleanupScan.dups) {
    for (const g of _cleanupScan.dups) {
      g.files.forEach((f, i) => { if (i === 0) dupKeepFids.add(f.fid); else dupExcessFids.add(f.fid); });
    }
  }
  let html = '<div style="padding:12px 14px;background:#fff7f0;border:1px solid #f5dcc0;border-radius:12px;font-size:13px">';
  if (_cleanupScan.deleteTargets.length) {
    html += renderCleanupGroup('�️ 待删除(按文件名+后缀精确匹配)', _cleanupScan.deleteTargets, 'del', dupKeepFids, dupExcessFids);
  }
  if (_cleanupScan.renameTargets.length) {
    html += renderCleanupGroup('✏️ 待去前缀重命名(去掉文件名里的前缀)', _cleanupScan.renameTargets, 'ren', new Set(), new Set());
  }
  html += '</div>';
  return html;
}

// 单个分类卡片: type='del' | 'ren'
function renderCleanupGroup(title, groups, type, dupKeepFids, dupExcessFids) {
  const totalCount = groups.reduce((n, g) => n + g.count, 0);
  let html = '<div style="margin-bottom:14px">' +
    '<div style="font-weight:600;color:#b3541e;margin-bottom:8px">' + title + ' (' + totalCount + ' 项)</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">' +
    '<button class="btn" style="padding:4px 10px;font-size:12px" onclick="cleanupSelectAllType(\'' + type + '\', true)">☑ 全选</button>' +
    '<button class="btn" style="padding:4px 10px;font-size:12px" onclick="cleanupSelectAllType(\'' + type + '\', false)">□ 清空</button>' +
    '</div>' +
    '<div style="display:flex;flex-direction:column;gap:8px;max-height:400px;overflow-y:auto">';
  groups.forEach((grp, gi) => {
    const grpId = 'cleanup' + type + 'Grp' + gi;
    html += '<div style="border:1px solid #f0dcc0;border-radius:10px;overflow:hidden;background:#fffdf9">' +
      '<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:#fdf3e8;cursor:pointer" onclick="cleanupToggleGrp(\'' + grpId + '\')">' +
      '<input type="checkbox" class="cleanup-grp cleanup-' + type + '-grp" data-type="' + type + '" data-gi="' + gi + '" onclick="event.stopPropagation();cleanupGrpChange(\'' + type + '\',' + gi + ')" style="flex-shrink:0;width:15px;height:15px">' +
      '<span style="font-weight:600;color:#0C447C;flex:1">' + esc(grp.keyword) + ' <span style="color:var(--muted);font-weight:400;font-size:12px">(' + grp.type + ', ' + grp.count + ' 条)</span></span>' +
      '<span style="font-size:11px;color:#8a5a00;flex-shrink:0" id="' + grpId + '-cnt">本组已选 0/' + grp.count + '</span>' +
      '<span id="' + grpId + '-arrow" style="flex-shrink:0;color:var(--muted);font-size:11px">▾ 展开</span>' +
      '</div>' +
      '<div id="' + grpId + '" style="display:block">';
    for (const it of grp.items) {
      const isKeep = dupKeepFids.has(it.fid);
      const isExcess = dupExcessFids.has(it.fid);
      const sizeStr = it.size ? fmtSize(it.size) : '';
      const newName = it.newName || '';
      html += '<label style="display:flex;align-items:center;gap:8px;padding:5px 12px;border-top:1px dashed #f5e6d0;cursor:pointer;word-break:break-all">' +
        '<input type="checkbox" class="cleanup-chk cleanup-' + type + '-chk" data-type="' + type + '" data-gi="' + gi + '" data-fid="' + esc(it.fid) + '" data-name="' + esc(it.name) + '"' + (it.newName ? ' data-newname="' + esc(newName) + '"' : '') + ' onchange="cleanupChkChange()" ' + (isExcess ? 'checked ' : '') + ' style="flex-shrink:0">' +
        '<span style="flex:1">' + esc(it.name) + (newName ? ' <span style="color:var(--primary);font-size:11px">→ ' + esc(newName) + '</span>' : '') + '</span>' +
        (isExcess ? '<span style="color:#8a5a00;font-size:11px;flex-shrink:0">🔄 重复</span>' : isKeep ? '<span style="color:#0F6E56;font-size:11px;flex-shrink:0">保留</span>' : '') +
        (sizeStr ? '<span style="color:var(--muted);font-size:11px;flex-shrink:0">' + sizeStr + '</span>' : '') +
        '</label>';
    }
    html += '</div></div>';
  });
  html += '</div></div>';
  return html;
}

// 按类型全选/清空
function cleanupSelectAllType(type, checked) {
  document.querySelectorAll('.cleanup-' + type + '-chk').forEach(cb => cb.checked = checked);
  cleanupChkChange();
}

// 展开/折叠分类
function cleanupToggleGrp(grpId) {
  const body = document.getElementById(grpId);
  const arrow = document.getElementById(grpId + '-arrow');
  if (!body || !arrow) return;
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  arrow.textContent = open ? '▸ 展开' : '▾ 收起';
}

// 分类 checkbox 变化: 勾选/取消该分类下所有文件
function cleanupGrpChange(type, gi) {
  const grpChk = document.querySelector('.cleanup-' + type + '-grp[data-gi="' + gi + '"]');
  if (!grpChk) return;
  const checked = grpChk.checked;
  document.querySelectorAll('.cleanup-' + type + '-chk[data-gi="' + gi + '"]').forEach(cb => cb.checked = checked);
  cleanupChkChange();
}

function fmtSize(s) {
  const n = parseInt(s);
  if (!n) return '';
  if (n > 1073741824) return (n / 1073741824).toFixed(1) + 'GB';
  if (n > 1048576) return (n / 1048576).toFixed(1) + 'MB';
  if (n > 1024) return (n / 1024).toFixed(0) + 'KB';
  return n + 'B';
}

// 勾选变化: 更新计数 + 组状态 + 删除/重命名按钮
function cleanupChkChange() {
  const delSel = document.querySelectorAll('.cleanup-del-chk:not(:disabled):checked').length;
  const renSel = document.querySelectorAll('.cleanup-ren-chk:not(:disabled):checked').length;
  const el = document.getElementById('cleanupSelCount');
  if (el) el.textContent = `已选 删 ${delSel}/重命名 ${renSel}`;
  // 同步每个组的 checkbox 状态
  for (const type of ['del', 'ren']) {
    const grpChks = document.querySelectorAll('.cleanup-' + type + '-grp');
    for (const g of grpChks) {
      const gi = g.dataset.gi;
      const chks = [...document.querySelectorAll('.cleanup-' + type + '-chk[data-gi="' + gi + '"]:not(:disabled)')];
      const checked = chks.filter(c => c.checked).length;
      const cntEl = document.getElementById('cleanup' + type + 'Grp' + gi + '-cnt');
      if (cntEl) cntEl.textContent = `本组已选 ${checked}/${chks.length}`;
      g.checked = checked > 0 && checked === chks.length;
      g.indeterminate = checked > 0 && checked < chks.length;
    }
  }
  updateCleanupActionBtns();
}
function updateCleanupActionBtns() {
  const delSel = document.querySelectorAll('.cleanup-del-chk:not(:disabled):checked').length;
  const renSel = document.querySelectorAll('.cleanup-ren-chk:not(:disabled):checked').length;
  const delBtn = document.getElementById('cleanupDelBtn');
  const renBtn = document.getElementById('cleanupRenBtn');
  const allBtn = document.getElementById('cleanupAllBtn');
  if (delBtn) {
    delBtn.style.display = delSel ? 'inline-block' : 'none';
    delBtn.textContent = `🗑️ 删除选中(${delSel})`;
  }
  if (renBtn) {
    renBtn.style.display = renSel ? 'inline-block' : 'none';
    renBtn.textContent = `✏️ 去前缀重命名(${renSel})`;
  }
  if (allBtn) {
    const delAvail = document.querySelectorAll('.cleanup-del-chk:not(:disabled)').length;
    const renAvail = document.querySelectorAll('.cleanup-ren-chk:not(:disabled)').length;
    const avail = delAvail + renAvail;
    allBtn.style.display = avail ? 'inline-block' : 'none';
    allBtn.textContent = `⚡ 一键全处理(${avail})`;
  }
}
// 兼容旧名
function updateCleanupDelBtn() { updateCleanupActionBtns(); }

async function runCleanupDelete() {
  const checked = [...document.querySelectorAll('.cleanup-del-chk:checked')];
  if (!checked.length) { alert('请先勾选要删除的文件'); return; }
  const fids = checked.map(cb => cb.getAttribute('data-fid')).filter(Boolean);
  const names = checked.map(cb => cb.getAttribute('data-name'));
  const shown = names.slice(0, 50).map(n => '· ' + n).join('\n');
  const more = names.length > 50 ? `\n… 共 ${names.length} 个` : '';
  const msg = `即将通过 115-MCP 删除选中的 ${fids.length} 个文件(进回收站):\n\n${shown}${more}\n\n⚠️ 删除后可在 115 回收站找回, 确认继续?`;
  if (!confirm(msg)) return;
  await doCleanup('delete', { fids }, '🗑️ 删除中...', fids);
}
async function runCleanupRename() {
  const checked = [...document.querySelectorAll('.cleanup-ren-chk:checked')];
  if (!checked.length) { alert('请先勾选要去前缀的文件'); return; }
  const items = checked.map(cb => ({ fid: cb.getAttribute('data-fid'), name: cb.getAttribute('data-name'), newName: cb.getAttribute('data-newname') })).filter(x => x.fid && x.newName);
  if (!items.length) { alert('勾选项缺少新名'); return; }
  const shown = items.slice(0, 30).map(x => '· ' + x.name + '  →  ' + x.newName).join('\n');
  const more = items.length > 30 ? `\n… 共 ${items.length} 项` : '';
  const msg = `即将通过 115-MCP 批量重命名(去掉前缀), 共 ${items.length} 项:\n\n${shown}${more}\n\n⚠️ 重命名会立即在 115 生效, 确认继续?`;
  if (!confirm(msg)) return;
  await doCleanup('rename', { items }, '✏️ 重命名中...', items.map(x => x.fid));
}
// ⚡ 一键全处理: 自动勾选所有项 → 先去前缀 → 再删除 → 一次确认
async function runCleanupAll() {
  const delItems = [...document.querySelectorAll('.cleanup-del-chk:not(:disabled)')];
  const renItems = [...document.querySelectorAll('.cleanup-ren-chk:not(:disabled)')];
  const delCount = delItems.length;
  const renCount = renItems.length;
  if (!delCount && !renCount) { alert('当前没有可处理的项(可能已处理完, 请先扫描)'); return; }
  let summary = '';
  if (renCount) summary += `· 去前缀重命名: ${renCount} 项\n`;
  if (delCount) summary += `· 删除进回收站: ${delCount} 项\n`;
  if (!confirm(`⚡ 一键全处理 (按规则自动处理全部命中项):\n\n${summary}\n执行顺序: 先去前缀 → 再删除\n\n确认继续?`)) return;
  // 自动勾选
  delItems.forEach(cb => cb.checked = true);
  renItems.forEach(cb => cb.checked = true);
  // 顺序执行, 不走 runCleanupRename/Delete(那俩有 confirm), 直接调 doCleanup
  if (renCount) {
    const items = renItems.map(cb => ({ fid: cb.getAttribute('data-fid'), name: cb.getAttribute('data-name'), newName: cb.getAttribute('data-newname') })).filter(x => x.fid && x.newName);
    await doCleanup('rename', { items }, '✏️ 去前缀重命名中...', items.map(x => x.fid));
  }
  if (delCount) {
    const fids = delItems.map(cb => cb.getAttribute('data-fid')).filter(Boolean);
    await doCleanup('delete', { fids }, '🗑️ 删除中...', fids);
  }
}
async function doCleanup(action, body, statusText, processedFids) {
  const status = document.getElementById('cleanupStatus');
  const actionBar = document.getElementById('cleanupActionBar');
  status.textContent = statusText;
  if (actionBar) {
    actionBar.style.display = 'block';
    actionBar.innerHTML = '<div style="padding:12px 14px;background:#f8fafc;border:1px dashed #a0b8d0;border-radius:10px;font-size:13px;color:#0C447C">⏳ 操作中... 请稍候</div>';
  }
  try {
    const r = await api('/api/cleanup/' + action, 'POST', Object.assign({ confirm: true }, body));
    if (r && r.error) {
      // 失败时: 显示在 actionBar, 清单仍可见(保留可重试)
      status.textContent = '❌ ' + r.error;
      if (actionBar) actionBar.innerHTML = '<div style="padding:12px 14px;background:#fbe9e9;border:1px solid #f3c0c0;border-radius:10px;font-size:13px;color:#b11">❌ ' + esc(r.error) + '<br><span style="font-size:12px;color:var(--muted)">清单仍显示, 可调整勾选后重试</span></div>';
      return;
    }
    // 成功: 标记已处理项为 ✅ 完成(不删 DOM), 保留清单可见
    if (processedFids && processedFids.length) {
      for (const fid of processedFids) {
        const cb = document.querySelector('.cleanup-chk[data-fid=\"' + cssEsc(fid) + '\"]');
        if (cb) {
          cb.checked = false;
          cb.disabled = true;
          cb.parentNode.style.opacity = '0.45';
          cb.parentNode.style.textDecoration = 'line-through';
          cb.parentNode.style.background = '#f0faf4';
          const tag = document.createElement('span');
          tag.textContent = action === 'delete' ? ' ✅ 已删' : ' ✅ 已改名';
          tag.style.cssText = 'color:#0F6E56;font-size:11px;font-weight:600;flex-shrink:0;margin-left:6px';
          cb.parentNode.appendChild(tag);
        }
      }
    }
    status.textContent = action === 'delete'
      ? `✅ 已删除 ${r.deleted || 0} 个文件(进回收站)`
      : `✅ 已重命名 ${r.renamed || 0} 个文件`;
    if (actionBar) {
      actionBar.innerHTML = '<div style="padding:14px;background:#f0faf4;border:1px solid #cdeedb;border-radius:10px;font-size:13px">' +
        '<b style="color:#0F6E56">' + (action === 'delete' ? `✅ 删除完成: ${r.deleted || 0} 项` : `✅ 去前缀重命名完成: ${r.renamed || 0} 项`) + '</b>' +
        '<div style=\"margin-top:8px;padding-top:8px;border-top:1px dashed #cdeedb;font-size:12px;color:var(--muted)\">清单已更新(已处理项标 ✅ 划线), 可继续处理剩余项或「🔍 重新扫描」</div></div>';
    }
    showCleanupLogs((r.logs || []).concat(['', action === 'delete' ? `✅ 删除完成 ${r.deleted || 0} 项` : `✅ 重命名完成 ${r.renamed || 0} 项`]));
    updateCleanupActionBtns();
  } catch (e) {
    status.textContent = '❌ 异常: ' + e.message;
    if (actionBar) actionBar.innerHTML = '<div style=\"padding:12px;background:#fbe9e9;border:1px solid #f3c0c0;border-radius:10px;font-size:13px;color:#b11\">❌ 异常: ' + esc(e.message) + '</div>';
  }
}
function cssEsc(s) { return String(s || '').replace(/[\"\\\\]/g, m => '\\\\' + m); }

// ===== 本次操作日志(只显示当前这轮, 不读历史) =====
function showCleanupLogs(logs) {
  const el = document.getElementById('cleanupLogs');
  if (!el) return;
  if (!logs || !logs.length) { el.textContent = '(本次无操作)'; return; }
  el.innerHTML = logs.map(l => '<div style="padding:3px 0">' + esc(l) + '</div>').join('');
}

async function loadCleanupLogs() {
  const el = document.getElementById('cleanupLogs');
  if (!el) return;
  try {
    const logs = await api('/api/cleanup/logs?limit=20');
    if (!logs || !logs.length) { el.textContent = '(暂无操作记录)'; return; }
    // 列出日志, 每条点击可加载详情
    el.innerHTML = logs.map(x => `<div style="padding:4px 0;cursor:pointer;color:var(--primary);text-decoration:underline" onclick="showCleanupLogDetail(${x.id}, this)">[${x.created_at}] [${x.action}] ${esc(x.summary)}</div>`).join('');
    // 存一份供详情加载
    window._cleanupLogs = logs;
  } catch { el.textContent = '(暂无操作记录)'; }
}
async function showCleanupLogDetail(id, el) {
  try {
    const r = await api('/api/cleanup/logs/' + id);
    if (!r || !r.id) return;
    const detail = JSON.parse(r.detail_json || '{}');
    let body = '';
    if (detail.logs && Array.isArray(detail.logs)) {
      body = detail.logs.map(l => '<div style="padding:3px 0;border-bottom:1px dashed #eef2f6">' + esc(l) + '</div>').join('');
    } else if (detail.results && Array.isArray(detail.results)) {
      body = '<pre style="white-space:pre-wrap;font-size:11px;background:#f8fafc;padding:8px;border-radius:6px;max-height:300px;overflow:auto">' + esc(JSON.stringify(detail.results, null, 2)) + '</pre>';
    } else {
      body = '<pre style="white-space:pre-wrap;font-size:11px">' + esc(JSON.stringify(detail, null, 2)) + '</pre>';
    }
    showLogModal('操作日志详情 - #' + id, body);
  } catch (e) { alert('加载日志失败: ' + e.message); }
}
function showLogModal(title, body) {
  let modal = document.getElementById('cleanupLogModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'cleanupLogModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(15,32,56,.45);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(2px)';
    document.body.appendChild(modal);
  }
  modal.innerHTML = '<div style="background:var(--card);border-radius:18px;box-shadow:0 20px 60px rgba(10,30,60,.35);width:760px;max-width:96vw;max-height:86vh;overflow-y:auto;padding:22px 26px;border:1px solid var(--border);position:relative">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px">' +
    `<b style="font-size:16px;color:#0C447C">📋 ${esc(title)}</b>` +
    '<button class="btn gray" style="padding:5px 14px" onclick="document.getElementById(\'cleanupLogModal\').style.display=\'none\'">✕ 关闭</button></div>' +
    '<div style="font-size:13px;line-height:1.6">' + body + '</div></div>';
  modal.style.display = 'flex';
}

async function saveConfig() {
  const r = await api('/api/config', 'POST', collectConfig());
  if (r.ok) {
    showMsg(document.getElementById('msgCfg'), '✅ 配置已保存', 'ok');
    cfgData = null;
    await api('/api/schedule/restart', 'POST');
    const sc = await api('/api/schedule');
    document.getElementById('schedStatus').textContent = sc.builtinActive ? '● 内置调度运行中' : '○ 内置调度未运行';
  } else {
    showMsg(document.getElementById('msgCfg'), '保存失败: ' + r.error, 'err');
  }
}

async function resetConfig() {
  if (!confirm('确定恢复默认配置?')) return;
  await api('/api/config/reset', 'POST');
  cfgData = null;
  loadConfig();
  showMsg(document.getElementById('msgCfg'), '已恢复默认配置', 'ok');
}

function addRule() {
  const rules = [...document.querySelectorAll('#ruleList .rule-row')].map((row, i) => ({
    id: 'r' + (i + 1),
    score: parseFloat(row.querySelector('.r-score').value) || 0,
    votes: parseInt(row.querySelector('.r-votes').value) || 0,
    force: row.querySelector('.r-force').checked,
  }));
  rules.push({ id: 'r' + (rules.length + 1), score: 4.0, votes: 100, force: false });
  renderRules(rules);
}

async function regTaskPlanner() {
  const r = await api('/api/schedule/register', 'POST');
  showMsg(document.getElementById('msgCfg'), r.message || r.error, r.ok ? 'ok' : 'err');
}
async function unregTaskPlanner() {
  const r = await api('/api/schedule/unregister', 'POST');
  showMsg(document.getElementById('msgCfg'), r.message || r.error, r.ok ? 'ok' : 'err');
}

// ============================================
// 任务
// ============================================
viewInits.tasks = (q) => {
  loadRunsAll();
  initVideosDates();   // 填充日期下拉 + 自动加载(默认全部日期倒序)
  if (q.id) setTimeout(() => showLog(parseInt(q.id)), 400);
};

async function loadRunsAll() {
  const runs = await api('/api/runs?limit=500');
  _pageCache.runsAllTbl = Array.isArray(runs) ? runs : [];
  renderRunsAllPage();
}

// 运行历史分页渲染(默认 5 条/页, 翻页只做 slice 不重复请求接口)
function renderRunsAllPage() {
  const tbody = document.querySelector('#runsAllTbl');
  if (!tbody) return;
  const rows = pageSlice('runsAllTbl');
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td><b>#${r.id}</b></td>
      <td>${r.type}</td>
      <td>${r.board ? (r.board === 103 ? '高清字幕' : '无码原创') : '全部'}</td>
      <td>${r.run_date || '-'}</td>
      <td>${badge(r.status)}</td>
      <td>${r.started_at || '-'}</td>
      <td>${r.duration_ms ? (r.duration_ms / 1000).toFixed(0) + 's' : '-'}</td>
      <td><a href="javascript:void(0)" onclick="showLog(${r.id})">查看日志</a></td>
      <td><a href="javascript:void(0)" onclick="deleteRun(${r.id})" style="color:var(--red)">删除</a></td>
    </tr>`).join('') || '<tr><td colspan="9"><div class="empty"><span class="big">🗂️</span>暂无运行记录</div></td></tr>';
  renderPager('runsAllTbl');
}

// 运行历史独立条数设置(不占用影片/待处理列表的条数记忆)
function setRunsPageSize(size) {
  localStorage.setItem('javRunsPageSize', String(size));
  _pageState.runsAllTbl = 1;
  renderRunsAllPage();
}

let logPollingId = null;
async function showLog(id) {
  const card = document.getElementById('logCard');
  if (!card) return;
  // logCard 在任务视图内: 若当前不在任务视图则切过去
  if (currentView() !== 'tasks') switchView('tasks');
  card.style.display = 'block';
  // 实时轮询日志(运行中自动刷新)
  if (logPollingId) clearInterval(logPollingId);
  const poll = async () => {
    const r = await api('/api/runs/' + id);
    if (!r || r.ok === false) return;
    document.getElementById('logTitle').textContent = `(#${r.id} ${r.status})`;
    const box = document.getElementById('logBox');
    box.textContent = r.log || '(等待日志输出...)';
    box.scrollTop = box.scrollHeight;
    if (r.status !== 'running') { clearInterval(logPollingId); logPollingId = null; }
  };
  await poll();
  logPollingId = setInterval(poll, 2000);
  card.scrollIntoView();
}

async function deleteRun(id) {
  // 两步确认: ① 是否删除 ② 是否级联(影片记录)
  if (!confirm(`确定删除运行记录 #${id}?\n(对应的资源报告会一并删除)`)) return;
  const cascade = confirm(`是否同时删除该板块该日期的影片记录?\n\n选「取消」= 只删运行记录+资源报告,保留影片记录\n选「确定」= 级联删除影片记录(不可恢复)`);
  const r = await api('/api/runs/' + id + '?cascade=' + (cascade ? 'true' : 'false'), 'DELETE');
  if (r.ok) {
    loadRuns(); loadRunsAll && loadRunsAll(); loadStats();
    showMsg(document.getElementById('msgDash') || document.getElementById('msgCfg'), r.message, 'ok');
  } else {
    showMsg(document.getElementById('msgDash') || document.getElementById('msgCfg'), r.error || '删除失败', 'err');
  }
}

// 自定义扁平下拉: 即时显示(无 transition 延迟), 点击外部/ESC 关闭
let _openDropdown = null;
function toggleDropdown(id, triggerBtn) {
  const dd = document.getElementById(id);
  const menu = dd.querySelector('.dropdown-menu');
  // 必须先读 isOpen, 再关闭其他(否则 closeAllDropdowns 会把当前也关了, 导致永远打不开)
  const isOpen = !menu.hasAttribute('hidden');
  closeAllDropdowns();
  if (isOpen) return; // 已是开 → 关闭后 return
  menu.removeAttribute('hidden');
  triggerBtn.classList.add('open');
  _openDropdown = id;
  // 滚动到当前选中项
  const sel = menu.querySelector('.selected');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}
function closeAllDropdowns() {
  document.querySelectorAll('.dropdown-menu').forEach(m => m.setAttribute('hidden', ''));
  document.querySelectorAll('.dropdown-trigger.open').forEach(b => b.classList.remove('open'));
  _openDropdown = null;
}
// 点击选项: 立即关闭 + 异步加载(不阻塞关闭动画)
function pickDropdown(li, ev) {
  ev.stopPropagation();
  const target = li.dataset.target; // 'vBoard' / 'vDate'
  const value = li.dataset.value;
  const label = li.textContent;
  // 更新 trigger label
  document.getElementById(target + '-label').textContent = label;
  // 更新选中样式
  const menu = li.parentElement;
  menu.querySelectorAll('.dropdown-item').forEach(x => x.classList.remove('selected'));
  li.classList.add('selected');
  // 关闭菜单(立即, 不等网络)
  closeAllDropdowns();
  // 异步触发查询(用 setTimeout 0 让关闭先完成)
  setTimeout(() => loadVideos(), 0);
}
// 点击外部关闭
document.addEventListener('click', function(e) {
  if (_openDropdown && !e.target.closest('.dropdown')) closeAllDropdowns();
});
// ESC 关闭
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && _openDropdown) closeAllDropdowns();
});

// 填充影片日期下拉(有记录的日期, 倒序), 并默认加载
async function initVideosDates() {
  const board = document.getElementById('vBoard-label').textContent; // 暂用 label 文本
  const boardVal = getDropdownValue('vBoard');
  const dates = await api('/api/videos/dates' + (boardVal ? '?board=' + boardVal : ''));
  const menu = document.getElementById('vDate-menu');
  const currentVal = getDropdownValue('vDate');
  const currentLabel = document.getElementById('vDate-label').textContent;
  // 重建选项(保留"全部日期"第一个)
  menu.innerHTML = '<li class="dropdown-item" data-value="" data-target="vDate" onclick="pickDropdown(this, event)">全部日期(最新在前)</li>' +
    (dates || []).map(d => `<li class="dropdown-item" data-value="${d}" data-target="vDate" onclick="pickDropdown(this, event)">${d}</li>`).join('');
  // 恢复选中
  restoreDropdownSelection('vDate', currentVal, currentLabel);
  await loadVideos();
}
function getDropdownValue(target) {
  const li = document.querySelector(`#${target}-menu .dropdown-item.selected`);
  return li ? li.dataset.value : '';
}
function restoreDropdownSelection(target, val, label) {
  const menu = document.getElementById(target + '-menu');
  const items = menu.querySelectorAll('.dropdown-item');
  let found = false;
  items.forEach(li => {
    li.classList.remove('selected');
    if (!found && li.dataset.value === val) { li.classList.add('selected'); found = true; }
  });
  // label 同步
  if (label) document.getElementById(target + '-label').textContent = label;
}

// ============================================
// 分页(两个列表共用)
// 筛选后的完整数据缓存在 _pageCache, 翻页只做 slice, 不重复请求接口
// ============================================
const _pageCache = { videosTbl: [], aiTbl: [], runsAllTbl: [], tgTbl: [] };
const _pageState = { videosTbl: 1, aiTbl: 1, runsAllTbl: 1, tgTbl: 1 };   // 当前页码(从 1 开始)
const PAGE_SIZES = [20, 50, 100, 200, 500];
const RUNS_PAGE_SIZES = [5, 10, 20, 50];   // 运行历史可选条数(默认 5)
const PAGE_SIZE_KEY = 'javPageSize';
const PAGER_BOX = { videosTbl: 'videosPager', aiTbl: 'aiPager', runsAllTbl: 'runsPager', tgTbl: 'tgPager' };   // tbodyId → 分页条容器

function getPageSize(tbodyId) {
  if (tbodyId === 'runsAllTbl') {   // 运行历史独立条数(默认 5 条/页)
    const v = parseInt(localStorage.getItem('javRunsPageSize') || '5', 10);
    return RUNS_PAGE_SIZES.includes(v) ? v : 5;
  }
  const v = parseInt(localStorage.getItem(PAGE_SIZE_KEY) || '50', 10);
  return PAGE_SIZES.includes(v) ? v : 50;
}
function setPageSize(size) {
  localStorage.setItem(PAGE_SIZE_KEY, String(size));
  _pageState.videosTbl = 1;   // 条数变了可能越界, 统一回到第 1 页
  _pageState.aiTbl = 1;
  _pageState.tgTbl = 1;
  renderVideosPage();
  renderAiPage();
  if (typeof renderTgPage === 'function') renderTgPage();
}
function pageCount(tbodyId) {
  return Math.max(1, Math.ceil((_pageCache[tbodyId] || []).length / getPageSize(tbodyId)));
}
// 当前页要渲染的数据(顺带把越界页码收敛回来)
function pageSlice(tbodyId) {
  const size = getPageSize(tbodyId);
  const list = _pageCache[tbodyId] || [];
  const pages = Math.max(1, Math.ceil(list.length / size));
  let p = _pageState[tbodyId] || 1;
  if (p > pages) p = pages;
  if (p < 1) p = 1;
  _pageState[tbodyId] = p;
  return list.slice((p - 1) * size, p * size);
}
function goPage(tbodyId, page) {
  const pages = pageCount(tbodyId);
  _pageState[tbodyId] = Math.min(Math.max(1, parseInt(page, 10) || 1), pages);
  if (tbodyId === 'aiTbl') renderAiPage();
  else if (tbodyId === 'tgTbl') renderTgPage();
  else if (tbodyId === 'runsAllTbl') renderRunsAllPage();
  else renderVideosPage();
  // 翻页后滚回表格顶部
  const wrap = document.getElementById(tbodyId) && document.getElementById(tbodyId).closest('.tbl-wrap');
  if (wrap) wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
// 页码序列(带省略号)
function pageNumbers(cur, pages) {
  const set = new Set([1, pages, cur - 2, cur - 1, cur, cur + 1, cur + 2]);
  const nums = [...set].filter(n => n >= 1 && n <= pages).sort((a, b) => a - b);
  const out = [];
  nums.forEach((n, i) => {
    if (i > 0 && n - nums[i - 1] > 1) out.push('...');
    out.push(n);
  });
  return out;
}
// 渲染分页条(影片/待处理/运行历史三个列表共用)
function renderPager(tbodyId) {
  const box = document.getElementById(PAGER_BOX[tbodyId] || tbodyId);
  if (!box) return;
  const total = (_pageCache[tbodyId] || []).length;
  if (!total) { box.innerHTML = ''; return; }
  const size = getPageSize(tbodyId);
  const pages = Math.max(1, Math.ceil(total / size));
  const cur = _pageState[tbodyId] || 1;
  const from = (cur - 1) * size + 1;
  const to = Math.min(cur * size, total);
  const nums = pageNumbers(cur, pages);
  const isRuns = tbodyId === 'runsAllTbl';
  const sizes = isRuns ? RUNS_PAGE_SIZES : PAGE_SIZES;
  const sizeChangeFn = isRuns ? 'setRunsPageSize' : 'setPageSize';
  const sizeOpts = sizes.map(n => `<option value="${n}"${n === size ? ' selected' : ''}>${n} 条/页</option>`).join('');
  box.innerHTML = `
    <span class="pg-info">共 <b>${total}</b> ${isRuns ? '条' : '部'} · 当前 ${from}-${to} · 第 <b>${cur}</b>/${pages} 页</span>
    <select class="pg-size" onchange="${sizeChangeFn}(parseInt(this.value,10))" title="每页显示条数(自动记忆)">${sizeOpts}</select>
    <button class="pg-btn" onclick="goPage('${tbodyId}',1)" ${cur === 1 ? 'disabled' : ''} title="首页">«</button>
    <button class="pg-btn" onclick="goPage('${tbodyId}',${cur - 1})" ${cur === 1 ? 'disabled' : ''} title="上一页">‹</button>
    ${nums.map(n => n === '...'
      ? '<span class="pg-gap">…</span>'
      : `<button class="pg-btn${n === cur ? ' active' : ''}" onclick="goPage('${tbodyId}',${n})">${n}</button>`).join('')}
    <button class="pg-btn" onclick="goPage('${tbodyId}',${cur + 1})" ${cur === pages ? 'disabled' : ''} title="下一页">›</button>
    <button class="pg-btn" onclick="goPage('${tbodyId}',${pages})" ${cur === pages ? 'disabled' : ''} title="末页">»</button>
  `;
}

// ============================================
// 人工处理进度标记(点开 javdb / 原贴)
// 两个都点过 = done(淡绿) | 只点一个 = doing(淡黄) | 都没点 = undone(常态)
// ============================================
function visitStateOf(v) {
  if (!v) return 'undone';
  const j = Number(v.visited_javdb) ? 1 : 0;
  const p = Number(v.visited_post) ? 1 : 0;
  if (j && p) return 'done';
  if (j || p) return 'doing';
  return 'undone';
}
// 行属性: 渲染时写入, 点击后原地改这几个 dataset 即可变色(不重刷整表, 滚动位置不丢)
function visitRowAttrs(src, v) {
  return `data-src="${src}" data-id="${v.id}" data-vj="${v.visited_javdb ? 1 : 0}" data-vp="${v.visited_post ? 1 : 0}"`;
}
// 重算单行的视觉状态
function applyVisitRow(tr) {
  if (!tr) return 'undone';
  const j = tr.dataset.vj === '1';
  const p = tr.dataset.vp === '1';
  const state = (j && p) ? 'done' : (j || p) ? 'doing' : 'undone';
  tr.classList.remove('v-done', 'v-doing', 'v-undone');
  tr.classList.add('v-' + state);
  const tag = tr.querySelector('.visit-tag');
  if (tag) {
    tag.textContent = state === 'done' ? '✅' : state === 'doing' ? '◐' : '○';
    tag.title = state === 'done' ? '已处理(javdb+原贴都已点开)' : state === 'doing' ? '处理中(只点开了一个)' : '未处理';
  }
  const reset = tr.querySelector('.visit-reset');
  if (reset) reset.style.visibility = state === 'undone' ? 'hidden' : 'visible';
  return state;
}
// 点开 javdb / 原贴 → 上报(乐观更新 UI, 请求失败也不打断跳转)
async function markVisit(el, src, id, kind) {
  const tr = el && el.closest ? el.closest('tr') : null;
  if (tr) {
    if (kind === 'javdb') tr.dataset.vj = '1'; else tr.dataset.vp = '1';
    applyVisitRow(tr);
    syncCacheVisit(src, id, tr.dataset.vj === '1' ? 1 : 0, tr.dataset.vp === '1' ? 1 : 0);
    refreshVisitStats(tr.closest('tbody').id);
  }
  try {
    await fetch('/api/visit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: src, id, kind, value: 1 }), keepalive: true,
    });
  } catch (e) { console.warn('记录访问标记失败:', e.message); }
}
// 撤销整行标记
async function resetVisit(el, src, id) {
  const tr = el && el.closest ? el.closest('tr') : null;
  if (tr) {
    tr.dataset.vj = '0'; tr.dataset.vp = '0';
    applyVisitRow(tr);
    syncCacheVisit(src, id, 0, 0);
    refreshVisitStats(tr.closest('tbody').id);
  }
  try {
    await fetch('/api/visit/reset', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: src, id }),
    });
  } catch (e) { console.warn('重置访问标记失败:', e.message); }
}
// 顶部进度统计(基于筛选后的完整缓存, 而不是当前页, 翻页时数字不会跳)
function refreshVisitStats(tbodyId) {
  const isAi = tbodyId === 'aiTbl';
  const list = _pageCache[tbodyId] || [];
  let done = 0, doing = 0, undone = 0;
  list.forEach(v => {
    const j = Number(v.visited_javdb) ? 1 : 0, p = Number(v.visited_post) ? 1 : 0;
    if (j && p) done++; else if (j || p) doing++; else undone++;
  });
  const txt = `共 ${list.length} 部 · ✅ 已处理 ${done} · ◐ 处理中 ${doing} · ○ 未处理 ${undone}`;
  const el = document.getElementById(isAi ? 'aiStats' : 'vVisitStats');
  if (el) el.textContent = txt;
}
// 标记变更时同步回缓存对象(否则翻页/统计会用到旧值)
function syncCacheVisit(src, id, vj, vp) {
  const tbodyId = src === 'ai-zone' ? 'aiTbl' : 'videosTbl';
  const it = (_pageCache[tbodyId] || []).find(x => String(x.id) === String(id));
  if (it) { it.visited_javdb = vj; it.visited_post = vp; }
}
// 滚动定位到下一个未处理: 先在当前页找, 本页没有就自动翻到它所在的那一页
function jumpNextUndone(tbodyId) {
  const list = _pageCache[tbodyId] || [];
  if (!list.length) return;
  const size = getPageSize();
  const cur = _pageState[tbodyId] || 1;
  const isDone = v => Number(v.visited_javdb) && Number(v.visited_post);
  let idx = -1;
  for (let i = (cur - 1) * size; i < Math.min(cur * size, list.length); i++) {
    if (!isDone(list[i])) { idx = i; break; }
  }
  if (idx < 0) idx = list.findIndex(v => !isDone(v));
  if (idx < 0) {
    const msgEl = document.getElementById(tbodyId === 'aiTbl' ? 'msgAI' : 'msgCfg');
    if (msgEl && typeof showMsg === 'function') showMsg(msgEl, '当前列表已全部处理完 ✅', 'ok');
    return;
  }
  // 不在当前页 → 先翻页再定位
  const targetPage = Math.floor(idx / size) + 1;
  if (targetPage !== cur) {
    _pageState[tbodyId] = targetPage;
    if (tbodyId === 'aiTbl') renderAiPage(); else renderVideosPage();
  }
  const tr = document.querySelector(`#${tbodyId} tr[data-id="${list[idx].id}"]`);
  if (!tr) return;
  tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
  tr.classList.remove('visit-flash');
  void tr.offsetWidth; // 强制重排, 保证连续点击时动画能重放
  tr.classList.add('visit-flash');
  setTimeout(() => tr.classList.remove('visit-flash'), 1800);
}
// 批量重置当前筛选范围的进度(想重新过一遍列表时用)
async function resetVisitBulk(src) {
  const body = { source: src };
  if (src === 'videos') {
    const b = getDropdownValue('vBoard'), d = getDropdownValue('vDate');
    if (b) body.board = parseInt(b, 10);
    if (d) body.date = d;
  } else {
    const ds = document.getElementById('aiDateStart'), de = document.getElementById('aiDateEnd');
    if (ds && ds.value) body.dateStart = ds.value;
    if (de && de.value) body.dateEnd = de.value;
  }
  const scoped = !!(body.board || body.date || body.dateStart || body.dateEnd);
  if (!scoped && !confirm('未选择板块/日期, 将重置【全部】影片的处理进度。确定继续?')) return;
  if (!confirm(`确定重置${scoped ? '当前筛选范围' : '全部'}的处理进度吗?`)) return;
  try {
    const r = await fetch('/api/visit/reset-bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(x => x.json());
    if (src === 'videos') await loadVideos(); else await loadAiZone();
    const msgEl = document.getElementById(src === 'videos' ? 'msgCfg' : 'msgAI');
    if (msgEl && typeof showMsg === 'function') showMsg(msgEl, `已重置 ${r.reset || 0} 条进度标记`, 'ok');
  } catch (e) { console.warn('批量重置失败:', e.message); }
}

// ============================================
// 勾选批量标记(多选 / 单选)
// ============================================
// 行首复选框(用 click 而非 change: 需要读 event.shiftKey) + 行首单条标记按钮
// ✓/↺ 放最左边: 表太宽, 不用滚到行尾就能直接标记
function selCheckboxTd(v, src) {
  return `<td style="text-align:center;white-space:nowrap"><input type="checkbox" class="row-sel" data-id="${v.id}" title="点击选择 · 按住 Shift 再点另一行 = 区间多选" onclick="onRowSelect(this, event)"> <button class="btn-mini" title="直接标记该片为已处理" onclick="markOne(this,'${src}',${v.id},1)">✓</button><button class="btn-mini visit-reset" title="撤销该片的处理标记" onclick="markOne(this,'${src}',${v.id},0)">↺</button></td>`;
}
// 表头全选 / 取消全选
function toggleSelectAll(tbodyId, checked) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  tbody.querySelectorAll('input.row-sel').forEach(cb => { cb.checked = checked; });
  syncSelAll(tbodyId);
  refreshSelInfo(tbodyId);
}
// 单行勾选; 按住 Shift 时把「上次点击的行 → 当前行」整段设为与当前行一致
// 注: 表格重渲染会清空 _lastSelIdx(行索引失效), 见 loadVideos/loadAiZone
const _lastSelIdx = {};
function onRowSelect(el, ev) {
  const tbody = el && el.closest ? el.closest('tbody') : null;
  if (!tbody) return;
  const boxes = [...tbody.querySelectorAll('input.row-sel')];
  const idx = boxes.indexOf(el);
  const prev = _lastSelIdx[tbody.id];
  if (ev && ev.shiftKey && prev != null && prev !== idx && idx >= 0) {
    const from = Math.min(prev, idx), to = Math.max(prev, idx);
    for (let i = from; i <= to; i++) boxes[i].checked = el.checked;
    // 清掉 shift 点击顺带产生的文本选区(浏览器在 mouseup 才完成选区扩展, 兜底再清一次)
    const clearSel = () => { try { window.getSelection().removeAllRanges(); } catch {} };
    clearSel();
    setTimeout(clearSel, 0);
  }
  if (idx >= 0) _lastSelIdx[tbody.id] = idx;
  syncSelAll(tbody.id);
  refreshSelInfo(tbody.id);
}
// 表头复选框三态: 全选 / 半选 / 未选
function syncSelAll(tbodyId) {
  const tbody = document.getElementById(tbodyId);
  const all = document.getElementById(tbodyId === 'aiTbl' ? 'aiSelAll' : 'vSelAll');
  if (!tbody || !all) return;
  const boxes = [...tbody.querySelectorAll('input.row-sel')];
  const n = boxes.filter(b => b.checked).length;
  all.checked = boxes.length > 0 && n === boxes.length;
  all.indeterminate = n > 0 && n < boxes.length;
}
// 刷新"已选 N 部"与批量按钮可用状态
function refreshSelInfo(tbodyId) {
  const isAi = tbodyId === 'aiTbl';
  const n = getSelectedIds(tbodyId).length;
  const label = n > 0 ? ` (${n})` : '';
  [['btnMarkDone', '✅ 标记已处理'], ['btnMarkUndo', '↩ 还原未处理']].forEach(([base, text]) => {
    const btn = document.getElementById(base + (isAi ? 'Ai' : 'Videos'));
    if (!btn) return;
    btn.disabled = n === 0;
    btn.textContent = text + label;
  });
}
function getSelectedIds(tbodyId) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return [];
  return [...tbody.querySelectorAll('input.row-sel:checked')]
    .map(b => parseInt(b.dataset.id, 10)).filter(n => Number.isFinite(n));
}
// 批量标记已处理(value=1) / 还原未处理(value=0)
async function markSelectedDone(tbodyId, src, value) {
  const ids = getSelectedIds(tbodyId);
  if (!ids.length) return;
  try {
    const r = await fetch('/api/visit/batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: src, ids, value }),
    }).then(x => x.json());
    if (!r.ok) { console.warn('批量标记失败:', r.error); return; }
    // 原地更新行状态(不重刷表格, 保留勾选与滚动位置)
    const tbody = document.getElementById(tbodyId);
    if (tbody) {
      const set = new Set(ids);
      tbody.querySelectorAll('tr[data-id]').forEach(tr => {
        if (!set.has(parseInt(tr.dataset.id, 10))) return;
        tr.dataset.vj = value ? '1' : '0';
        tr.dataset.vp = value ? '1' : '0';
        applyVisitRow(tr);
      });
      ids.forEach(id => syncCacheVisit(src, id, value ? 1 : 0, value ? 1 : 0));
      refreshVisitStats(tbody.id);
    }
  } catch (e) { console.warn('批量标记异常:', e.message); }
}
// 单条直接标记 / 撤销(不必先勾选)
async function markOne(el, src, id, value) {
  const tr = el && el.closest ? el.closest('tr') : null;
  if (tr) {
    tr.dataset.vj = value ? '1' : '0';
    tr.dataset.vp = value ? '1' : '0';
    applyVisitRow(tr);
    syncCacheVisit(src, id, value ? 1 : 0, value ? 1 : 0);
    refreshVisitStats(tr.closest('tbody').id);
  }
  try {
    await fetch('/api/visit/batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: src, ids: [id], value }),
    });
  } catch (e) { console.warn('单条标记失败:', e.message); }
}

async function loadVideos() {
  const board = getDropdownValue('vBoard');
  const date = getDropdownValue('vDate');
  const off = getDropdownValue('vOff');
  let url = '/api/videos?limit=5000';
  if (board) url += '&board=' + board;
  if (date) url += '&date=' + date;
  let videos = await api(url) || [];
  // 后端已按 run_date DESC 排序, 兜底再排一次(新日期在前)
  videos.sort((a, b) => (b.run_date || '').localeCompare(a.run_date || ''));
  // 离线状态筛选(细分失败/跳过原因)
  if (off) videos = videos.filter(v => matchOffline(v, off));
  // 处理进度筛选(未处理 / 处理中 / 已处理)
  const visit = getDropdownValue('vVisit');
  if (visit) videos = videos.filter(v => visitStateOf(v) === visit);
  // 存缓存 → 分页渲染(翻页不再重复请求接口)
  _pageCache.videosTbl = videos;
  _pageState.videosTbl = 1;
  renderVideosPage();
}

// 只渲染当前页(翻页/改每页条数时调用)
function renderVideosPage() {
  const tbody = document.querySelector('#videosTbl');
  if (!tbody) return;
  const rows = pageSlice('videosTbl');
  tbody.innerHTML = rows.map(v => {
    // 磁力列: 完整磁力 + 复制按钮(自动换行完整展示)
    const magCell = v.magnet
      ? `<span title="${esc(v.magnet)}" style="cursor:default;font-size:12px;color:#0F6E56;word-break:break-all">${esc(v.magnet)}</span> <button class="btn-mini" style="font-size:11px" onclick="copyText('${esc(String(v.magnet).replace(/'/g, "\\'"))}', this)">📋</button>`
      : '<span style="color:#c0c8d0">-</span>';
    return `<tr class="v-${visitStateOf(v)}" ${visitRowAttrs('videos', v)}>
      ${selCheckboxTd(v, 'videos')}
      <td><span class="visit-tag" title="">○</span> <b>${esc(v.code)}</b> <button class="btn-mini" style="font-size:11px" title="复制番号" onclick="copyText('${esc(String(v.code).replace(/'/g, "\\'"))}', this)">📋</button></td>
      <td class="${v.board === 103 ? 'bd-103' : 'bd-36'}">${v.board === 103 ? '高清中字' : '无码破解'}</td>
      <td>${v.run_date || '-'}</td>
      <td>${esc(v.javdb_actors || '-')}</td>
      <td class="td-dir">${esc(v.dir_display || v.dir_name || '-')}</td>
      <td style="white-space:nowrap">${v.score ? v.score.toFixed(2) : '-'} / ${v.votes || 0}人</td>
      <td>${v.pass ? '<span class="badge pass">✓ 符合</span>' : '<span class="badge fail">✗ 不符合</span>'}</td>
      <td class="td-dup">${renderDupCell(v)}</td>
      <td style="white-space:nowrap">${v.javdb_href ? `<a href="${esc(v.javdb_href)}" target="_blank" rel="noopener" class="btn sm${v.visited_javdb ? ' visited' : ''}" title="打开 javdb 详情(点击后自动标记)" onclick="markVisit(this,'videos',${v.id},'javdb')">🌐 javdb</a>` : '<span style="color:#c0c8d0">-</span>'}</td>
      <td style="white-space:nowrap"><button class="btn-mini" title="跳转到资源报告对应区域" onclick="openReportAnchor(${v.board}, '${v.run_date || ''}', ${v.id})">📄 跳转资源报告</button></td>
      <td class="td-magnet">${magCell}</td>
      <td style="white-space:nowrap">${v.post_href ? `<a href="${esc(v.post_href)}" target="_blank" rel="noopener" class="btn sm green${v.visited_post ? ' visited' : ''}" title="打开论坛原帖(点击后自动标记)" onclick="markVisit(this,'videos',${v.id},'post')">📄 原贴</a>` : '<span style="color:#c0c8d0">-</span>'}</td>
      <td style="white-space:nowrap"><a href="javascript:void(0)" onclick="showVideoDetail(${v.id})">详情</a></td>
    </tr>`;
  }).join('') || '<tr><td colspan="14"><div class="empty"><span class="big">🔍</span>无记录</div></td></tr>';
  // 行状态(标记图标/重置按钮显隐) + 顶部进度统计 + 分页条
  tbody.querySelectorAll('tr[data-id]').forEach(applyVisitRow);
  refreshVisitStats('videosTbl');
  // 重渲染后勾选状态清空, 避免对不可见的行误操作; 行索引失效, shift 区间锚点一并重置
  _lastSelIdx.videosTbl = null;
  syncSelAll('videosTbl');
  refreshSelInfo('videosTbl');
  renderPager('videosTbl');
}
// 115判重列: 展示已存状态 + 查到的同影片不同规格版本(如 XXX-123-UC / XXX-123-C 等)
// 未存时按板块提示缺少的版本(sub→-C, uncensor→-U)
// 已存条目显示 115 修改时间 + 影片大小(2026-09-04 用户要求)
// 大小格式化: MCP 返回字节数字, CDP 回退是 "6.5GB" 字符串, 两种都兼容
function fmtFileSize(sz) {
  if (sz == null || sz === '') return '';
  const s = String(sz).trim();
  if (/^\d+(\.\d+)?$/.test(s)) {
    let b = parseFloat(s), u = 0;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    while (b >= 1024 && u < units.length - 1) { b /= 1024; u++; }
    return (u === 0 ? b : b.toFixed(b >= 100 ? 0 : 1)) + ' ' + units[u];
  }
  return s;   // 已是 "6.5GB" 之类
}
// 已存条目的 [时间 · 大小] 附加标签
function dupMetaTag(m) {
  const parts = [];
  if (m.time) parts.push(esc(m.time));
  const sz = fmtFileSize(m.size);
  if (sz) parts.push(esc(sz));
  if (m.isFolder) parts.push('目录');
  return parts.length ? ` <span style="color:#2e8b57;white-space:nowrap">[${parts.join(' · ')}]</span>` : '';
}
function renderDupCell(v) {
  let det = null;
  try { det = v.dup_detail ? JSON.parse(v.dup_detail) : null; } catch {}
  let html = v.dup_exists
    ? '<span class="badge warn">✓ 已存</span>'
    : '<span class="badge gray">○ 未存</span>';
  // 未存: 提示缺少的版本
  if (!v.dup_exists) {
    const needLabel = v.board === 103 ? '-C(中文字幕)' : '-U(无码破解)';
    html += '<br><small style="color:#b7791f;line-height:1.5;display:block">⚠ 缺少 ' + needLabel + ' 版</small>';
  }
  // 收集查到的同番号版本(已匹配+其他规格)
  const seen = new Set();
  const names = [];
  for (const m of ((det && det.matched) || [])) { if (!seen.has(m.name)) { seen.add(m.name); names.push(m); } }
  for (const m of ((det && det.unmatched) || [])) { if (!seen.has(m.name)) { seen.add(m.name); names.push(m); } }
  if (names.length) {
    html += '<br><small style="color:#5a6b7d;line-height:1.5;display:block;word-break:break-all">' +
      names.map(m => '🔎 ' + esc(m.name) + dupMetaTag(m)).join('<br>') + '</small>';
  }
  return html;
}
// 离线状态匹配(供影片记录筛选下拉)
function matchOffline(v, off) {
  const st = v.offline_status || '';
  const det = (v.offline_detail || '');
  switch (off) {
    case 'success': return st === 'success';
    case 'downloading': return st === 'downloading';
    case 'failed': return st === 'failed';
    case 'fail-nomagnet': return st === 'failed' && /无磁力/.test(det);
    case 'fail-submit': return st === 'failed' && /提交失败|离线提交/.test(det);
    case 'fail-verify': return st === 'failed' && /云下载|验证/.test(det);
    case 'fail-other': return st === 'failed' && !/无磁力|提交失败|离线提交|云下载|验证/.test(det);
    case 'skipped': return st === 'skipped';
    case 'skip-nodir': return st === 'skipped' && /目录/.test(det);
    case 'skip-other': return st === 'skipped' && !/目录/.test(det);
    case 'none': return !st || st === 'pending';
    default: return true;
  }
}
// 离线状态 → 徽章颜色/文案
function offBadgeCls(s) {
  return { 'success': 'ok', 'downloading': 'warn', 'pending': 'gray', 'skipped': 'blue', 'failed': 'red' }[s] || 'gray';
}
function offLabel(s) {
  return { 'success': '✅ 离线成功', 'downloading': '↓ 离线中', 'pending': '○ 待处理', 'skipped': '— 跳过', 'failed': '✕ 离线失败' }[s] || (s || '未离线');
}

// ============================================
// 网络连通性检测(主动触发)
// ============================================
let _netResults = [];
async function runNetcheck() {
  const status = document.getElementById('netcheckStatus');
  const panel = document.getElementById('netcheckPanel');
  if (!status || !panel) return;
  panel.style.display = 'block';
  status.textContent = '⏳ 检测中...';
  try {
    const r = await api('/api/netcheck');
    if (!r.ok) { status.textContent = '❌ 检测失败: ' + (r.error || '未知'); return; }
    _netResults = r.results || [];
    const ok = _netResults.filter(x => x.ok).length;
    status.textContent = `✅ ${r.checked_at} | ${ok}/${_netResults.length} 项通过`;
    renderNetcheck(_netResults);
    loadNetcheckHistory();
  } catch (e) {
    status.textContent = '❌ 检测异常: ' + e.message;
  }
}
function renderNetcheck(results) {
  const tbody = document.getElementById('netcheckTbl');
  if (!tbody) return;
  tbody.innerHTML = results.map(x => netcheckRow(x)).join('');
}
function netcheckRow(x) {
  const cls = x.ok ? 'ok' : (x.status === 'timeout' ? 'warn' : 'red');
  const label = x.ok ? '✅ 成功' : (x.status === 'timeout' ? '⏱️ 超时' : '❌ 失败');
  const detail = x.ok
    ? (x.httpCode ? 'HTTP ' + x.httpCode : '端口可达')
    : (esc(x.reason || x.err || '失败') + (x.hint ? '<br><small style="color:#9aa7b5">💡 ' + esc(x.hint) + '</small>' : ''));
  return `<tr>
    <td><b>${esc(x.name)}</b><br><small style="color:#9aa7b5">${esc(x.addr || '')}</small></td>
    <td><span class="badge ${cls}">${label}</span></td>
    <td>${x.ms}ms</td>
    <td style="font-size:12px">${detail}</td>
    <td><button class="btn-mini" onclick="retryNetcheck('${esc(x.id)}', this)">🔄 重试</button></td>
  </tr>`;
}
async function retryNetcheck(id, btn) {
  const old = btn.textContent;
  btn.textContent = '⏳ 重试中...';
  try {
    const r = await api('/api/netcheck/retry', 'POST', { id });
    if (r.ok && r.result) {
      // 更新对应行
      const idx = _netResults.findIndex(x => x.id === id);
      if (idx >= 0) _netResults[idx] = r.result;
      const row = btn.closest('tr');
      if (row) row.outerHTML = netcheckRow(r.result);
      // 更新汇总
      const ok = _netResults.filter(x => x.ok).length;
      const status = document.getElementById('netcheckStatus');
      if (status) status.textContent = `✅ ${ok}/${_netResults.length} 项通过(单项重试)`;
      btn.textContent = '🔄 重试';
    } else {
      btn.textContent = '❌ ' + (r.error || '失败');
      setTimeout(() => { btn.textContent = old; }, 2000);
    }
  } catch (e) {
    btn.textContent = '❌ ' + e.message;
  }
}
async function loadNetcheckHistory() {
  const el = document.getElementById('netcheckHistory');
  if (!el) return;
  try {
    const h = await api('/api/netcheck/history?limit=5');
    el.textContent = (h || []).map(x => `${x.checked_at} ${x.summary}`).join('  |  ') || '(暂无记录)';
  } catch { el.textContent = '(暂无记录)'; }
}

// 跳转到资源报告对应影片区域(先重新生成报告保证锚点与最新数据一致, 再带锚点打开)
async function openReportAnchor(board, date, videoId) {
  if (!date) { alert('该记录无日期, 无法定位报告'); return; }
  const btn = event && event.target;
  const old = btn ? btn.textContent : '';
  if (btn) btn.textContent = '生成中...';
  try {
    const r = await api('/api/reports/regenerate', 'POST', { board, date });
    if (r.ok && r.url) {
      window.open(r.url + '#card-g-' + videoId, '_blank');
    } else {
      alert('无法生成报告: ' + (r.error || '无数据'));
    }
  } catch (e) {
    alert('跳转失败: ' + e.message);
  }
  if (btn) btn.textContent = old;
}

async function showVideoDetail(id) {
  const videos = await api('/api/videos?limit=1000');
  const v = videos.find(x => x.id === id);
  if (!v) return;
  const body = document.getElementById('videoDetailBody');
  const modal = document.getElementById('videoDetailModal');
  if (!body || !modal) return;
  // 离线状态描述
  const offMap = {
    'success': '<span class="badge ok">✅ 离线成功</span>', 'downloading': '<span class="badge warn">↓ 离线中</span>',
    'pending': '<span class="badge gray">○ 待处理</span>', 'skipped': '<span class="badge blue">— 跳过</span>',
    'failed': '<span class="badge red">✕ 离线失败</span>',
  };
  let dupHtml = '';
  if (v.dup_detail) {
    try {
      const d = JSON.parse(v.dup_detail);
      dupHtml = `<div class="detail-sec">
        <div class="detail-sec-title">115 查重情况</div>
        <div class="info-row"><span class="k">已收录</span> ${d.exists ? '<span class="badge warn">是</span>' : '<span class="badge gray">否</span>'} ${esc(d.label || '')}</div>
        <div class="info-row"><span class="k">匹配文件</span> ${(d.matched || []).map(m => esc(m.name) + dupMetaTag(m)).join('、') || '无'}</div>
        <div class="info-row"><span class="k">其他版本</span> ${(d.unmatched || []).map(m => esc(m.name) + (m.is4k ? ' <small>(4K)</small>' : '') + dupMetaTag(m)).join('、') || '无'}</div>
      </div>`;
    } catch {}
  }
  body.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:16px">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <b style="font-size:18px;color:#0C447C">${esc(v.code)}</b>
        <button class="btn-mini" onclick="copyText('${esc(String(v.code).replace(/'/g, "\\'"))}', this)">📋 复制番号</button>
        <span style="font-size:13px;color:var(--muted)">${esc(v.title || '')}</span>
      </div>
      <button class="btn gray" style="padding:5px 14px" onclick="closeVideoDetail()">✕ 关闭</button>
    </div>
    <div class="detail-sec">
      <div class="detail-sec-title">基本信息</div>
      <div class="info-row"><span class="k">板块</span> ${v.board === 103 ? '高清中文字幕' : '亚洲无码原创'} | 日期: ${esc(v.run_date || '-')}</div>
      <div class="info-row"><span class="k">javdb</span> ${esc(v.javdb_title || '-')} | 评分 ${v.score || '-'}分 / ${v.votes || 0}人</div>
      <div class="info-row"><span class="k">演员</span> ${esc(v.javdb_actors || '-')}</div>
      ${v.javdb_href ? `<div class="info-row" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span class="k">链接</span> <a href="${esc(v.javdb_href)}" target="_blank" class="btn-link" style="font-size:12px;padding:4px 10px">javdb 详情 ↗</a> ${v.post_href ? `<a href="${esc(v.post_href)}" target="_blank" class="btn-link" style="font-size:12px;padding:4px 10px">帖子 ↗</a>` : ''}</div>` : ''}
    </div>
    <div class="detail-sec">
      <div class="detail-sec-title">离线任务情况</div>
      <div class="info-row"><span class="k">离线状态</span> ${offMap[v.offline_status] || esc(v.offline_status || '未离线')}</div>
      <div class="info-row"><span class="k">离线时间</span> ${esc(v.offline_at || '-')}</div>
      <div class="info-row"><span class="k">详情</span> ${esc(v.offline_detail || '-')}</div>
      <div class="info-row"><span class="k">115目录</span> ${esc(v.dir_name || '无')} ${esc(v.dir_note || '')}</div>
    </div>
    <div class="detail-sec">
      <div class="detail-sec-title">原始磁力链接</div>
      ${v.magnet ? `<div class="magnet-copy" style="margin-top:6px"><span class="k">磁力</span><code class="magnet-code">${esc(v.magnet)}</code><button class="btn-mini" onclick="copyText(this.previousElementSibling.textContent, this)">📋 复制</button></div>` : '<div class="info-row">(无磁力)</div>'}
    </div>
    ${dupHtml}`;
  modal.style.display = 'flex';
}
function closeVideoDetail() {
  const modal = document.getElementById('videoDetailModal');
  if (modal) modal.style.display = 'none';
}
// ESC 关闭详情弹窗
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeVideoDetail();
});

// ============================================
// 资源报告
// ============================================
let reportDates = [];
let curReportDate = null;

viewInits.reports = () => {
  loadReportDates();
  loadReportLatest();
};

// 加载日期列表
async function loadReportDates() {
  reportDates = await api('/api/reports/dates');
  const sel = document.getElementById('reportDateSel');
  if (!sel) return;
  sel.innerHTML = reportDates.map(d => `<option value="${d}">${d}</option>`).join('');
  sel.onchange = () => { curReportDate = sel.value; loadReportDate(); };
  // 更新前后箭头
  updateArrows();
}

// 加载最新
async function loadReportLatest() {
  const r = await api('/api/reports/latest');
  if (!r.date) { renderReportEmpty('暂无报告,先运行流水线生成报告'); return; }
  curReportDate = r.date;
  const sel = document.getElementById('reportDateSel');
  if (sel) sel.value = r.date;
  renderReports(r.reports);
  updateArrows();
}

// 按当前日期加载
async function loadReportDate() {
  if (!curReportDate) return;
  const list = await api('/api/reports?date=' + curReportDate);
  const reports = {};
  for (const it of list) reports[it.boardId] = it.relPath;
  renderReports(reports);
  updateArrows();
}

function updateArrows() {
  const idx = reportDates.indexOf(curReportDate);
  const btnPrev = document.getElementById('btnPrevDay');
  const btnNext = document.getElementById('btnNextDay');
  if (btnPrev) btnPrev.disabled = idx >= reportDates.length - 1;
  if (btnNext) btnNext.disabled = idx <= 0;
}

function prevDay() {
  const idx = reportDates.indexOf(curReportDate);
  if (idx < reportDates.length - 1) {
    curReportDate = reportDates[idx + 1];
    const sel = document.getElementById('reportDateSel');
    if (sel) sel.value = curReportDate;
    loadReportDate();
  }
}
function nextDay() {
  const idx = reportDates.indexOf(curReportDate);
  if (idx > 0) {
    curReportDate = reportDates[idx - 1];
    const sel = document.getElementById('reportDateSel');
    if (sel) sel.value = curReportDate;
    loadReportDate();
  }
}

function panelHtml(boardId, date, relPath) {
  const name = boardId === 103 ? '📺 高清中文字幕' : '🔞 亚洲无码原创';
  if (!relPath) {
    return `<div class="report-panel">
      <div class="report-panel-head"><div class="bp">${name}</div><span class="date-tag">${date}</span></div>
      <div class="report-empty"><span class="big">📭</span>该日期无此板块报告</div>
    </div>`;
  }
  return `<div class="report-panel">
    <div class="report-panel-head">
      <div class="bp">${name}</div>
      <div style="display:flex;align-items:center;gap:10px">
        <span class="date-tag">${date}</span>
        <a class="btn sm" href="${relPath}" target="_blank" rel="noopener">新窗口打开 ↗</a>
      </div>
    </div>
    <iframe class="report-frame" src="${relPath}" loading="lazy"></iframe>
  </div>`;
}

// 当前选中板块(单板块完整展示)
let curBoard = null;

function switchReportBoard(b) {
  curBoard = b;
  const g = document.getElementById('reportGrid');
  if (g) g.style.opacity = 0;
  loadReportDate().then(() => {
    const g2 = document.getElementById('reportGrid');
    if (g2) g2.style.opacity = 1;
  });
}

function updateBoardSwitch() {
  const b103 = document.getElementById('boardBtn103');
  const b36 = document.getElementById('boardBtn36');
  if (b103) b103.classList.toggle('active', curBoard === 103);
  if (b36) b36.classList.toggle('active', curBoard === 36);
}

function renderReports(reports) {
  const grid = document.getElementById('reportGrid');
  if (!grid) return;
  const date = curReportDate || '';
  // 默认选中: 有报告的板块优先 103, 否则 36
  if (curBoard === null) curBoard = reports[103] ? 103 : (reports[36] ? 36 : 103);
  grid.innerHTML = panelHtml(curBoard, date, reports[curBoard]);
  updateBoardSwitch();
  const dateTag = document.getElementById('reportDateTag');
  if (dateTag) dateTag.textContent = date;
}

function renderReportEmpty(msg) {
  const grid = document.getElementById('reportGrid');
  if (grid) grid.innerHTML = `<div class="card" style="grid-column:1/-1"><div class="empty"><span class="big">📭</span>${msg}</div></div>`;
}

// ============================================
// 演员映射管理
// ============================================
let amStatusFilter = '';
let amOffset = 0;
const AM_PAGE = 50;
let amView = 'dir';   // dir=按115目录(可管多别名) | name=按javdb名(扁平)

viewInits['actress-map'] = () => { loadActressMap(); };

// 视图维度切换: 按 115 目录(一个目录可挂多个 javdb 别名) / 按 javdb 名(扁平)
function switchAmView(v) {
  if (amView === v) return;
  amView = v;
  amOffset = 0;
  document.querySelectorAll('#amViewSeg .seg-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.amview === v);
  });
  loadActressMap();
}

// 表头 + 提示随视图切换
function renderAmHead() {
  const head = document.getElementById('amHead');
  const tip = document.getElementById('amTip');
  if (!head) return;
  if (amView === 'dir') {
    head.innerHTML = '<th width="180">115 目录名</th><th>javdb 演员别名</th><th width="120">cid</th><th width="90">别名数</th><th width="80">出现次数</th><th width="200">操作</th>';
    if (tip) tip.innerHTML = '💡 <b>按目录</b>管理: 一行 = 一个 115 演员目录, 下面挂的多个 javdb 名都是它的别名(任一名命中即存到该目录)。别名可直接 ✕ 删除, 或点「➕ 别名」新增; 改目录名会<b>同步</b>更新该目录所有别名行。';
  } else {
    head.innerHTML = '<th>javdb 演员日文名</th><th>115 目录名</th><th>cid</th><th>匹配方式</th><th>出现次数</th><th>状态</th><th>操作</th>';
    if (tip) tip.innerHTML = '💡 离线下载时优先查此表直接拿 cid(免搜索); 未命中回退逐级搜索。自动匹配由「全量演员库 + 115目录」桥接生成, 待补录项可点「编辑」手动输入 javdb 日文名。';
  }
}

// 状态下拉(自定义: 不经 pickDropdown, 避免误触发 loadVideos)
function pickAmStatus(li, val) {
  amStatusFilter = val;
  amOffset = 0;
  document.getElementById('amStatus-label').textContent = li.textContent;
  const menu = li.parentElement;
  menu.querySelectorAll('.dropdown-item').forEach(x => x.classList.remove('selected'));
  li.classList.add('selected');
  closeAllDropdowns();
  loadActressMap();
}

async function loadActressMap(dir) {
  if (dir === 1) amOffset = 0; // 刷新到第一页
  renderAmHead();
  const kw = (document.getElementById('amKeyword').value || '').trim();
  const base = `keyword=${encodeURIComponent(kw)}&status=${amStatusFilter}&limit=${AM_PAGE}&offset=${amOffset}`;
  const r = await api(amView === 'dir' ? `/api/actress-map/dirs?${base}` : `/api/actress-map?${base}`);
  if (!r.ok) return;
  // 统计
  const s = r.stats;
  document.getElementById('amStats').innerHTML = `
    <span>总目录 <b>${s.total}</b></span>
    <span style="color:var(--green)">✅ 已映射 <b>${s.mapped}</b></span>
    <span style="color:var(--amber)">⏳ 待补录 <b>${s.pending}</b></span>
    <span style="color:var(--muted)">🚫 排除 <b>${s.excluded}</b></span>`;
  // 分页(目录视图用 total 字段, 扁平视图沿用 stats.total)
  const totalRows = amView === 'dir' ? (r.total != null ? r.total : s.total) : s.total;
  document.getElementById('amPager').innerHTML = `
    <button class="btn" style="padding:5px 12px" ${amOffset === 0 ? 'disabled' : ''} onclick="amOffset=Math.max(0,amOffset-${AM_PAGE});loadActressMap()">◀ 上一页</button>
    <span>第 ${Math.floor(amOffset / AM_PAGE) + 1} 页 · 已显示 ${Math.min(amOffset + (r.rows || []).length, totalRows)} / 共 ${totalRows} ${amView === 'dir' ? '个目录' : '条记录'}</span>
    <button class="btn" style="padding:5px 12px" ${(r.rows || []).length < AM_PAGE ? 'disabled' : ''} onclick="amOffset+=${AM_PAGE};loadActressMap()">下一页 ▶</button>`;
  if (amView === 'dir') return renderAmDirs(r.rows || []);
  renderAmNames(r.rows || []);
}

// ===== 视图A: 按 115 目录(一行一目录, 下面挂多个 javdb 别名) =====
function renderAmDirs(rows) {
  const tbody = document.getElementById('amTbl');
  if (!tbody) return;
  tbody.innerHTML = rows.map(g => {
    // 别名标签: 出现次数最多的视为主名(绿标), excluded 的加删除线
    const aliases = (g.aliases || []).slice().sort((a, b) => (b.count || 0) - (a.count || 0));
    const aliasHtml = aliases.length
      ? `<div class="am-aliases">${aliases.map((a, i) => {
          const cls = a.status === 'excluded' ? 'is-excluded' : (i === 0 ? 'is-main' : '');
          const via = a.via && a.via !== 'manual' ? `<span class="am-via">${escHtml(a.via)}</span>` : '';
          return `<span class="am-alias ${cls}" title="${escHtml('javdb名: ' + a.javdb_name + (a.via ? ' · 来源: ' + a.via : '') + (a.count ? ' · 出现 ' + a.count + ' 次' : ''))}">`
            + escHtml(a.javdb_name) + via
            + `<button class="am-del" title="删除该别名(只删这一条, 不影响目录)" onclick="delAmAlias(${JSON.stringify(String(a.javdb_name)).replace(/"/g, '&quot;')})">✕</button>`
            + `</span>`;
        }).join('')}</div>`
      : '<span class="am-empty">无别名</span>';
    return `<tr>
      <td><b>${escHtml(g.dir_name)}</b>${g.mapped_count === 0 ? ' <span style="font-size:11px;color:var(--amber)">(全部排除)</span>' : ''}</td>
      <td>${aliasHtml}</td>
      <td style="font-size:12px;color:var(--muted)">${g.cid ? String(g.cid).slice(0, 12) + '…' : '<span style="color:var(--red)">缺</span>'}</td>
      <td>${g.alias_count}${g.alias_count > 1 ? ' <span style="font-size:11px;color:var(--primary-dark)">多别名</span>' : ''}</td>
      <td>${g.total_count || 0}</td>
      <td style="white-space:nowrap">
        <button class="btn sm" onclick="startAddAlias(this, ${JSON.stringify(String(g.dir_name)).replace(/"/g, '&quot;')}, ${JSON.stringify(String(g.cid || '')).replace(/"/g, '&quot;')})" title="给该目录新增一个 javdb 别名">➕ 别名</button>
        <button class="btn sm" onclick="openAmEditDir(${JSON.stringify(String(g.dir_name)).replace(/"/g, '&quot;')}, ${JSON.stringify(String(g.cid || '')).replace(/"/g, '&quot;')}, ${g.alias_count})" title="改目录名 / 补 cid(会同步更新该目录所有别名)">✏️ 目录</button>
        <button class="btn sm red" onclick="delAmDir(${JSON.stringify(String(g.dir_name)).replace(/"/g, '&quot;')}, ${g.alias_count})" title="删除整个目录及其所有别名">🗑</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="6"><div class="empty"><span class="big">🔍</span>无匹配记录</div></td></tr>';
}

// ===== 视图B: 按 javdb 名(扁平, 原名视图) =====
function renderAmNames(rows) {
  const tbody = document.getElementById('amTbl');
  if (!tbody) return;
  tbody.innerHTML = rows.map(row => {
    const isPlaceholder = String(row.javdb_name).startsWith('@DIR:');
    // 占位 cell: 渲染为可点击链接, 点击触发 inline 编辑(下拉选+输入)
    const triggerKey = `t${Math.random().toString(36).slice(2, 8)}`;
    const jn = isPlaceholder
      ? `<a class="am-inline-trigger" data-key="${triggerKey}" href="javascript:void(0)" onclick="openAmInline(this, '${escHtml(row.javdb_name)}', '${escHtml(row.dir_name || '')}', '${escHtml(row.cid || '')}')" title="点击快速补录 javdb 名">📝 待补 javdb 名</a>`
      : escHtml(row.javdb_name);
    const stBadge = row.status === 'mapped' ? '<span style="color:var(--green)">✅ 已映射</span>'
      : row.status === 'pending' ? '<span style="color:var(--amber)">⏳ 待补录</span>'
      : '<span style="color:var(--muted)">🚫 排除</span>';
    const noteCell = row.note ? `<div style="font-size:11px;color:var(--red);margin-top:2px">⚠️ ${escHtml(row.note)}</div>` : '';
    return `<tr>
      <td>${jn}${noteCell}</td>
      <td>${escHtml(row.dir_name || '-')}</td>
      <td style="font-size:12px;color:var(--muted)">${row.cid ? row.cid.slice(0, 12) + '…' : '-'}</td>
      <td><span class="tag">${escHtml(row.via || '-')}</span></td>
      <td>${row.count || 0}</td>
      <td>${stBadge}</td>
      <td>
        <button class="btn" style="padding:4px 10px;font-size:12px" onclick="openAmEdit(${JSON.stringify(row).replace(/"/g, '&quot;')})">✏️ 编辑</button>
        ${row.status === 'pending' && !isPlaceholder ? `<button class="btn" style="padding:4px 10px;font-size:12px" onclick="markAm(${JSON.stringify(String(row.javdb_name)).replace(/"/g, '&quot;')}, &quot;mapped&quot;)">✅ 确认</button>` : ''}
        <button class="btn red" style="padding:4px 10px;font-size:12px" onclick="delAm(${JSON.stringify(String(row.javdb_name)).replace(/"/g, '&quot;')})">🗑</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="7"><div class="empty"><span class="big">🔍</span>无匹配记录</div></td></tr>';
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 编辑弹窗(三种模式: name=改单条别名 / dir=改目录(同步所有别名) / create=新建映射)
let amEditing = null;
let amEditMode = 'name';
function openAmEdit(row) {
  amEditing = row;
  amEditMode = 'name';
  const isPlaceholder = String(row.javdb_name).startsWith('@DIR:');
  document.getElementById('amEditBody').innerHTML = `
    <div style="display:grid;gap:10px">
      <label style="font-size:13px;color:var(--muted)">115 目录名 <small style="color:#9aa7b5">(可修改, 如演员改名/目录改名)</small></label>
      <input id="amE_dir" value="${escHtml(row.dir_name || '')}" list="amDirList" autocomplete="off" placeholder="115 网盘里的文件夹名(如 白峰美由)" oninput="amAutocomplete(this)" style="padding:8px;border:1px solid var(--border);border-radius:10px;background:var(--input-bg);color:var(--text)">
      <datalist id="amDirList"></datalist>
      <label style="font-size:13px;color:var(--muted)">115 目录 cid <small style="color:#9aa7b5">(可修改, 一般无需动)</small></label>
      <input id="amE_cid" value="${escHtml(row.cid || '')}" placeholder="115 文件夹 fid(数字)" style="padding:8px;border:1px solid var(--border);border-radius:10px;background:var(--input-bg);color:var(--text)">
      <label style="font-size:13px;color:var(--muted)">javdb 演员日文名 ${isPlaceholder ? '(待补录)' : ''}</label>
      <input id="amE_javdb" value="${isPlaceholder ? '' : escHtml(row.javdb_name)}" list="amJavdbList" autocomplete="off" placeholder="输入日文/中文/罗马音, 下拉选" oninput="amAutocomplete(this)" style="padding:8px;border:1px solid var(--border);border-radius:10px;background:var(--input-bg);color:var(--text)">
      <datalist id="amJavdbList"></datalist>
      <label style="font-size:13px;color:var(--muted)">状态</label>
      <select id="amE_status" style="padding:8px;border:1px solid var(--border);border-radius:10px;background:var(--input-bg);color:var(--text)">
        <option value="mapped" ${row.status === 'mapped' ? 'selected' : ''}>✅ 已映射</option>
        <option value="pending" ${row.status === 'pending' ? 'selected' : ''}>⏳ 待补录</option>
        <option value="excluded" ${row.status === 'excluded' ? 'selected' : ''}>🚫 排除</option>
      </select>
    </div>`;
  document.getElementById('amEditModal').style.display = 'flex';
}
function closeAmEdit() { document.getElementById('amEditModal').style.display = 'none'; amEditing = null; }

// ---- 改目录名 / 补 cid: 该目录下所有别名行一起同步 ----
function openAmEditDir(dirName, cid, aliasCount) {
  amEditing = { dir_name: dirName, cid: cid || '', alias_count: aliasCount || 1 };
  amEditMode = 'dir';
  document.getElementById('amEditBody').innerHTML = `
    <div style="display:grid;gap:10px">
      <div style="font-size:12px;color:var(--muted);background:var(--blue-bg);color:var(--blue-text);padding:8px 10px;border-radius:8px">
        ⚠️ 改名会同步更新该目录下 <b>${aliasCount || 1}</b> 条别名记录的目录名, 不会出现"改了一个别名、其他别名还指向旧目录"的情况。
      </div>
      <label style="font-size:13px;color:var(--muted)">115 目录名</label>
      <input id="amE_dir" value="${escHtml(dirName)}" list="amDirList" autocomplete="off" placeholder="115 网盘里的文件夹名" oninput="amAutocomplete(this)" style="padding:8px;border:1px solid var(--border);border-radius:10px;background:var(--input-bg);color:var(--text)">
      <datalist id="amDirList"></datalist>
      <label style="font-size:13px;color:var(--muted)">115 目录 cid <small>(留空则不改)</small></label>
      <input id="amE_cid" value="${escHtml(cid || '')}" placeholder="115 文件夹 fid(数字)" style="padding:8px;border:1px solid var(--border);border-radius:10px;background:var(--input-bg);color:var(--text)">
    </div>`;
  document.getElementById('amEditModal').style.display = 'flex';
}

// ---- 新建映射: 给已有目录加别名, 或直接新建一个目录 ----
function openAmCreate() {
  amEditing = { dir_name: '', cid: '', javdb_name: '' };
  amEditMode = 'create';
  document.getElementById('amEditBody').innerHTML = `
    <div style="display:grid;gap:10px">
      <div style="font-size:12px;padding:8px 10px;border-radius:8px;background:var(--blue-bg);color:var(--blue-text)">
        💡 给一个 115 目录添加 javdb 别名: 填目录名 + javdb 名即可; 目录名已存在则<b>新增一条别名</b>, 不存在则新建目录。
      </div>
      <label style="font-size:13px;color:var(--muted)">115 目录名 <small>(下拉可选已有目录, 也可直接输入新的)</small></label>
      <input id="amE_dir" value="" list="amDirList" autocomplete="off" placeholder="如 白峰美由" oninput="amAutocomplete(this)" style="padding:8px;border:1px solid var(--border);border-radius:10px;background:var(--input-bg);color:var(--text)">
      <datalist id="amDirList"></datalist>
      <label style="font-size:13px;color:var(--muted)">115 目录 cid <small>(目录已存在时可留空, 会自动沿用)</small></label>
      <input id="amE_cid" value="" placeholder="115 文件夹 fid(数字), 可留空" style="padding:8px;border:1px solid var(--border);border-radius:10px;background:var(--input-bg);color:var(--text)">
      <label style="font-size:13px;color:var(--muted)">javdb 演员日文名 <small>(输入日文/中文/罗马音, 下拉选)</small></label>
      <input id="amE_javdb" value="" list="amJavdbList" autocomplete="off" placeholder="如 白峰ミウ" oninput="amAutocomplete(this)" style="padding:8px;border:1px solid var(--border);border-radius:10px;background:var(--input-bg);color:var(--text)">
      <datalist id="amJavdbList"></datalist>
    </div>`;
  document.getElementById('amEditModal').style.display = 'flex';
  setTimeout(() => { const el = document.getElementById('amE_dir'); if (el) el.focus(); }, 50);
}

// ---- 删除单个别名(只删这一条, 目录和其他别名不受影响) ----
async function delAmAlias(javdbName) {
  if (!confirm(`删除别名「${javdbName}」?\n\n只删这一条映射, 所在 115 目录和其他别名不受影响。`)) return;
  const r = await api('/api/actress-map/' + encodeURIComponent(javdbName), 'DELETE');
  if (r.ok) {
    showMsg(document.getElementById('msgAM'), `✅ 已删除别名: ${javdbName}`, 'ok');
    loadActressMap();
  } else {
    showMsg(document.getElementById('msgAM'), '删除失败: ' + (r.error || ''), 'err');
  }
}

// ---- 删除整个目录(含所有别名) ----
async function delAmDir(dirName, aliasCount) {
  if (!confirm(`删除目录「${dirName}」及其下 ${aliasCount} 条别名?\n\n该目录下所有 javdb 别名映射都会一起删掉。`)) return;
  const r = await api('/api/actress-map/dir/' + encodeURIComponent(dirName), 'DELETE');
  if (r.ok) {
    showMsg(document.getElementById('msgAM'), `✅ 已删除目录「${dirName}」及 ${r.deleted} 条别名`, 'ok');
    loadActressMap();
  } else {
    showMsg(document.getElementById('msgAM'), '删除失败: ' + (r.error || ''), 'err');
  }
}

// ---- 行内「➕ 别名」: 原地变输入框, 带演员库自动补全 ----
let _amAddBusy = false;
async function startAddAlias(btn, dirName, cid) {
  if (_amAddBusy) return;
  _amAddBusy = true;
  const td = btn.parentNode;
  const origHTML = td.innerHTML;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;min-width:260px';
  wrap.innerHTML = `
    <input id="amAddInput" list="amJavdbListAdd" autocomplete="off" placeholder="输入/下拉选 javdb 别名"
           style="flex:1;min-width:150px;padding:6px 10px;border:1px solid var(--border);border-radius:8px;background:var(--input-bg);color:var(--text);font-size:13px">
    <datalist id="amJavdbListAdd"></datalist>
    <button class="btn sm run-btn" data-act="save">💾</button>
    <button class="btn sm" data-act="cancel">✕</button>`;
  td.innerHTML = '';
  td.appendChild(wrap);

  const input = wrap.querySelector('#amAddInput');
  const dl = wrap.querySelector('#amJavdbListAdd');
  const finish = () => { _amAddBusy = false; };

  // 初次候选 + 输入防抖
  const pull = async (q) => {
    try {
      const r = await api('/api/actress-names?q=' + encodeURIComponent(q || '') + '&limit=20');
      if (!dl) return;
      dl.innerHTML = (r.rows || []).map(x =>
        `<option value="${escHtml(x.Name)}">${escHtml((x.NameCN || '') + (x.Roma ? ' · ' + x.Roma : ''))}</option>`
      ).join('');
    } catch {}
  };
  await pull('');
  input.focus();
  let t = null;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => pull(input.value.trim()), 300); });

  const doCancel = () => { td.innerHTML = origHTML; finish(); };
  const doSave = async () => {
    const javdb_name = input.value.trim();
    if (!javdb_name) { input.focus(); return; }
    const saveBtn = wrap.querySelector('button[data-act="save"]');
    saveBtn.disabled = true; saveBtn.textContent = '⏳';
    const r = await api('/api/actress-map', 'POST', { javdb_name, dir_name: dirName, cid: cid || null, via: 'manual', status: 'mapped' });
    if (r.ok) {
      showMsg(document.getElementById('msgAM'), `✅ 已给「${dirName}」添加别名: ${javdb_name}`, 'ok');
      finish();
      loadActressMap();
    } else {
      saveBtn.disabled = false; saveBtn.textContent = '💾';
      showMsg(document.getElementById('msgAM'), '保存失败: ' + (r.error || ''), 'err');
    }
  };
  wrap.querySelector('button[data-act="save"]').addEventListener('click', doSave);
  wrap.querySelector('button[data-act="cancel"]').addEventListener('click', doCancel);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doSave(); }
    if (e.key === 'Escape') { e.preventDefault(); doCancel(); }
  });
}

async function saveAmEdit() {
  if (!amEditing) return;
  // 目录模式: 调 rename-dir, 同步该目录下所有别名
  if (amEditMode === 'dir') {
    const old_dir = amEditing.dir_name;
    const new_dir = document.getElementById('amE_dir').value.trim();
    const cid = document.getElementById('amE_cid').value.trim();
    if (!new_dir) { alert('目录名不能为空'); return; }
    const r = await api('/api/actress-map/rename-dir', 'POST', { old_dir, new_dir, cid: cid || null });
    closeAmEdit();
    if (r.ok) {
      showMsg(document.getElementById('msgAM'), `✅ 目录已更新: ${old_dir} → ${new_dir} (同步 ${r.updated} 条别名)`, 'ok');
    } else {
      showMsg(document.getElementById('msgAM'), '保存失败: ' + (r.error || ''), 'err');
    }
    loadActressMap();
    return;
  }
  // 新建模式
  if (amEditMode === 'create') {
    const dir_name = document.getElementById('amE_dir').value.trim();
    const cid = document.getElementById('amE_cid').value.trim();
    const javdb_name = document.getElementById('amE_javdb').value.trim();
    if (!dir_name || !javdb_name) { alert('115 目录名 和 javdb 演员名 都要填'); return; }
    const r = await api('/api/actress-map', 'POST', { javdb_name, dir_name, cid: cid || null, via: 'manual', status: 'mapped' });
    closeAmEdit();
    if (r.ok) {
      showMsg(document.getElementById('msgAM'), `✅ 已新增映射: ${javdb_name} → ${dir_name}`, 'ok');
    } else {
      showMsg(document.getElementById('msgAM'), '保存失败: ' + (r.error || ''), 'err');
    }
    loadActressMap();
    return;
  }
  const dir_name = document.getElementById('amE_dir').value;
  const cid = document.getElementById('amE_cid').value;
  const javdb_name = document.getElementById('amE_javdb').value.trim();
  const status = document.getElementById('amE_status').value;
  const isPlaceholder = String(amEditing.javdb_name).startsWith('@DIR:');
  // 占位项: 用户填了 javdb 名 → 删除占位记录, 新增正式映射
  if (isPlaceholder && javdb_name) {
    const r = await api('/api/actress-map', 'POST', { javdb_name, dir_name, cid, via: 'manual', status: 'mapped' });
    if (r.ok) await api('/api/actress-map/' + encodeURIComponent(amEditing.javdb_name), 'DELETE');
  } else if (javdb_name && javdb_name !== amEditing.javdb_name) {
    // javdb 名有改动(改名/纠正): 新名写入, 旧名删除
    const r = await api('/api/actress-map', 'POST', { javdb_name, dir_name, cid, via: amEditing.via || 'manual', status });
    if (r.ok && amEditing.javdb_name) await api('/api/actress-map/' + encodeURIComponent(amEditing.javdb_name), 'DELETE');
  } else {
    const r = await api('/api/actress-map', 'POST', { javdb_name: amEditing.javdb_name, dir_name, cid, via: amEditing.via || 'manual', status });
  }
  closeAmEdit();
  loadActressMap();
}
async function markAm(javdbName, status) {
  await api('/api/actress-map', 'POST', { javdb_name: javdbName, via: 'manual', status });
  loadActressMap();
}
async function delAm(javdbName) {
  if (!confirm('删除该映射记录?')) return;
  await api('/api/actress-map/' + encodeURIComponent(javdbName), 'DELETE');
  loadActressMap();
}
// autocomplete: 弹窗输入时实时拉候选, 300ms 防抖
//   dir 输入框 → amDirList(115 已映射目录名); javdb 输入框 → amJavdbList(演员库)
let _amAcTimer = null;
async function amAutocomplete(input) {
  clearTimeout(_amAcTimer);
  _amAcTimer = setTimeout(async () => {
    const q = input.value.trim();
    const isDir = input.id === 'amE_dir';
    if (isDir) {
      const dl = document.getElementById('amDirList');
      if (!dl) return;
      // 目录候选: 从当前已加载映射列表的 dir_name 聚合(避免额外接口)
      const r = await api('/api/actress-map?keyword=' + encodeURIComponent(q) + '&limit=100');
      const dirs = [...new Set((r.rows || []).map(x => x.dir_name).filter(Boolean))];
      dl.innerHTML = dirs.map(d => `<option value="${escHtml(d)}"></option>`).join('');
      return;
    }
    const r = await api('/api/actress-names?q=' + encodeURIComponent(q) + '&limit=20');
    const dl = document.getElementById('amJavdbList');
    if (!dl) return;
    dl.innerHTML = (r.rows || []).map(x =>
      `<option value="${escHtml(x.Name)}">${escHtml((x.NameCN || '') + (x.Roma ? ' · ' + x.Roma : ''))}</option>`
    ).join('');
  }, 300);
}

async function syncActressMap(mode) {
  mode = mode || 'merge';
  if (mode === 'rebuild' && !confirm('全量重建会覆盖人工手动修改的记录, 继续?')) return;
  if (mode === 'merge' && !confirm('重新构建(保留人工修改), 继续?')) return;
  const before = (await api('/api/actress-map')).stats;
  const r = await api('/api/actress-map/sync', 'POST', { mode });
  showMsg(document.getElementById('msgAM'), r.message || (r.ok ? '已启动' : r.error), r.ok ? 'ok' : 'err');
  if (!r.ok) return;
  // 轮询 stats, total/mapped 稳定后刷新(脚本通常 5-10s 完成)
  let lastTotal = before.total;
  const poll = setInterval(async () => {
    const cur = (await api('/api/actress-map')).stats;
    if (cur.total !== lastTotal || cur.mapped !== before.mapped) {
      lastTotal = cur.total;
      // 再连续两次无变化即认为完成
      setTimeout(async () => {
        const final = (await api('/api/actress-map')).stats;
        if (final.total === lastTotal) {
          clearInterval(poll);
          loadActressMap();
          showMsg(document.getElementById('msgAM'),
            `重建完成: ✅ ${final.mapped} 待补录 ${final.pending} 排除 ${final.excluded}`, 'ok');
        }
      }, 2000);
    }
  }, 1500);
  setTimeout(() => clearInterval(poll), 30000); // 30s 超时
}

// ============================================
// 演员映射 - 列表内 inline 快速补录
// 点击占位 cell 直接变成 input + datalist, Enter 保存 / Esc 取消
// ============================================
let _amInlineBusy = null;  // 防同 cell 重复打开

async function openAmInline(triggerEl, placeholder, dirName, cid) {
  if (_amInlineBusy) return;  // 已有 inline 编辑中
  _amInlineBusy = triggerEl;

  const cell = triggerEl.parentNode;
  const origHTML = cell.innerHTML;  // 备份原内容, 取消时还原

  // 替换为 inline 编辑区
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap';
  wrap.innerHTML = `
    <input id="amInlineInput" list="amJavdbListInline" autocomplete="off"
           placeholder="输入/下拉选 javdb 日文名"
           style="flex:1;min-width:160px;padding:6px 10px;border:1px solid var(--border);border-radius:8px;background:var(--input-bg);color:var(--text);font-size:13px">
    <datalist id="amJavdbListInline"></datalist>
    <button class="btn run-btn" style="padding:5px 12px;font-size:12px" data-act="save">💾 保存</button>
    <button class="btn" style="padding:5px 10px;font-size:12px" data-act="cancel">✕</button>
    <span style="font-size:11px;color:var(--muted)">Enter 保存 · Esc 取消</span>`;
  cell.innerHTML = '';
  cell.appendChild(wrap);

  const input = wrap.querySelector('#amInlineInput');
  const saveBtn = wrap.querySelector('button[data-act="save"]');
  const cancelBtn = wrap.querySelector('button[data-act="cancel"]');

  // 拉全量库前 20 条做初次候选
  await refreshAmDatalist('');
  input.focus();

  // 输入防抖拉候选
  let acT = null;
  input.addEventListener('input', () => {
    clearTimeout(acT);
    acT = setTimeout(() => refreshAmDatalist(input.value), 300);
  });

  // 键盘: Enter 保存, Esc 取消
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doSave(); }
    if (e.key === 'Escape') { e.preventDefault(); doCancel(); }
  });
  // 按钮事件
  saveBtn.addEventListener('click', doSave);
  cancelBtn.addEventListener('click', doCancel);

  const reset = () => { _amInlineBusy = null; };

  async function doSave() {
    const javdb_name = input.value.trim();
    if (!javdb_name) { input.focus(); return; }
    saveBtn.disabled = true; saveBtn.textContent = '⏳';
    const r = await api('/api/actress-map', 'POST', {
      javdb_name, dir_name: dirName, cid, via: 'manual', status: 'mapped',
    });
    if (r.ok) {
      // 删除占位行
      await api('/api/actress-map/' + encodeURIComponent(placeholder), 'DELETE');
      reset();
      loadActressMap();
      showMsg(document.getElementById('msgAM'), `✅ 已补录: ${javdb_name} → ${dirName}`, 'ok');
    } else {
      saveBtn.disabled = false; saveBtn.textContent = '💾 保存';
      showMsg(document.getElementById('msgAM'), '保存失败: ' + (r.error || ''), 'err');
    }
  }

  function doCancel() {
    cell.innerHTML = origHTML;
    reset();
  }
}

// 拉全量库候选填 datalist
let _amInlineDl = null;
async function refreshAmDatalist(q) {
  const dl = document.getElementById('amJavdbListInline');
  if (!dl) return;
  if (_amInlineDl) _amInlineDl.abort();
  _amInlineDl = new AbortController();
  try {
    const r = await fetch('/api/actress-names?q=' + encodeURIComponent(q || '') + '&limit=20', {
      signal: _amInlineDl.signal,
    });
    const j = await r.json();
    dl.innerHTML = (j.rows || []).map(x =>
      `<option value="${escHtml(x.Name)}">${escHtml((x.NameCN || '') + (x.Roma ? ' · ' + x.Roma : ''))}</option>`
    ).join('');
  } catch (e) {
    if (e.name !== 'AbortError') console.log('拉候选异常:', e.message);
  }
}

// ============================================
// AI 专区(sehuatang fid=166, 只存有价值影片)
// ============================================
// ============================================
// AI 专区抓取日志(回溯历史抓取 / 实时跟随)
// ============================================
let _aiLogTimer = null;
let _aiLogWatching = false;

// 拉取日志列表; pick 指定要选中的文件名(不传则保持当前选择, 没有就选最新)
async function loadAiLogs(pick) {
  const sel = document.getElementById('aiLogSel');
  const meta = document.getElementById('aiLogMeta');
  if (!sel) return;
  try {
    const r = await api('/api/ai-zone/logs');
    const logs = (r && r.logs) || [];
    if (!logs.length) {
      sel.innerHTML = '<option value="">(暂无日志)</option>';
      if (meta) meta.textContent = '';
      return;
    }
    const cur = pick || sel.value;
    sel.innerHTML = logs.map(l => {
      const t = l.name.replace(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.log$/, '$1-$2-$3 $4:$5:$6');
      return `<option value="${l.name}"${l.name === cur ? ' selected' : ''}>${t} (${(l.size / 1024).toFixed(1)} KB)</option>`;
    }).join('');
    const target = logs.some(l => l.name === cur) ? cur : logs[0].name;
    sel.value = target;
    await viewAiLog(target);
  } catch (e) { console.warn('加载日志列表失败:', e.message); }
}
// 读取并展示某个日志
async function viewAiLog(name) {
  const box = document.getElementById('aiLogBox');
  const meta = document.getElementById('aiLogMeta');
  if (!box) return;
  if (!name) { box.textContent = '（选择一个日志文件查看内容）'; if (meta) meta.textContent = ''; return; }
  try {
    const r = await fetch('/api/ai-zone/logs/' + encodeURIComponent(name)).then(x => x.json());
    if (!r.ok) { box.textContent = '读取失败: ' + (r.error || ''); return; }
    box.textContent = r.content || '(空)';
    box.scrollTop = box.scrollHeight;   // 跟随到最新一行
    if (meta) meta.textContent = `${name} · ${(r.content || '').split('\n').length} 行`;
  } catch (e) { box.textContent = '读取异常: ' + e.message; }
}
// 抓取过程中每 2 秒刷新, 出现「完成」自动停止并刷新列表
function toggleAiLogWatch() {
  const btn = document.getElementById('btnWatchAiLog');
  const stop = () => {
    clearInterval(_aiLogTimer); _aiLogTimer = null; _aiLogWatching = false;
    if (btn) { btn.textContent = '👁 实时跟随'; btn.classList.remove('run-btn'); }
  };
  if (_aiLogWatching) { stop(); return; }
  _aiLogWatching = true;
  if (btn) { btn.textContent = '⏹ 停止跟随'; btn.classList.add('run-btn'); }
  const tick = async () => {
    await loadAiLogs();
    const box = document.getElementById('aiLogBox');
    if (box && /\[AI专区\] 完成:/.test(box.textContent)) {
      stop();
      await loadAiZone();       // 抓完顺带刷新列表
      return;
    }
    // 抓取进程已退出且日志不再增长 → 兜底停止(避免一直轮询)
    if (!_aiLogWatching) return;
  };
  tick();
  _aiLogTimer = setInterval(tick, 2000);
}
// 删除当前选中的日志
async function deleteAiLog() {
  const sel = document.getElementById('aiLogSel');
  if (!sel || !sel.value) return;
  if (!confirm(`删除日志 ${sel.value} ?`)) return;
  try {
    await fetch('/api/ai-zone/logs/' + encodeURIComponent(sel.value), { method: 'DELETE' });
    await loadAiLogs();
  } catch (e) { console.warn('删除日志失败:', e.message); }
}

viewInits['ai-zone'] = () => { loadAiZone(); loadAiLogs(); };

async function loadAiZone() {
  const tbody = document.getElementById('aiTbl');
  if (!tbody) return;
  const ds = document.getElementById('aiDateStart');
  const de = document.getElementById('aiDateEnd');
  const kw = document.getElementById('aiKeyword');
  const qs = new URLSearchParams();
  if (ds && ds.value) qs.set('date-start', ds.value);
  if (de && de.value) qs.set('date-end', de.value);
  if (kw && kw.value.trim()) qs.set('keyword', kw.value.trim());
  try {
    const r = await api('/api/ai-zone?' + qs.toString());
    if (!r.ok) { showMsg(document.getElementById('msgAI'), r.error || '加载失败', 'err'); return; }
    // 填充评分/人数阈值配置(实时生效)
    if (r.config) {
      const sc = document.getElementById('aiMinScore');
      const vt = document.getElementById('aiMinVotes');
      if (sc && !sc.dataset.loaded) { sc.value = r.config.score != null ? r.config.score : 4; sc.dataset.loaded = '1'; }
      if (vt && !vt.dataset.loaded) { vt.value = r.config.votes != null ? r.config.votes : 200; vt.dataset.loaded = '1'; }
    }
    // 显示增量抓取水位(上次抓到什么时间)
    const waterEl = document.getElementById('aiWater');
    if (waterEl) {
      waterEl.textContent = r.config && r.config.lastRunAt
        ? `⏱ 水位: ${r.config.lastRunAt}（下次自动抓这段时间之后的）`
        : '⏱ 水位: 未记录（首次自动抓取默认抓最近 24 小时）';
    }
    const vsSel = document.getElementById('aiVisit');
    const vs = vsSel ? vsSel.value : '';
    let rows = r.rows || [];
    if (vs) rows = rows.filter(v => visitStateOf(v) === vs);
    // 存缓存 → 分页渲染
    _pageCache.aiTbl = rows;
    _pageState.aiTbl = 1;
    renderAiPage();
  } catch (e) {
    showMsg(document.getElementById('msgAI'), '加载异常: ' + e.message, 'err');
  }
}

// 只渲染当前页(翻页/改每页条数时调用)
function renderAiPage() {
  const tbody = document.getElementById('aiTbl');
  if (!tbody) return;
  const rows = pageSlice('aiTbl');
  tbody.innerHTML = rows.map(v => {
      const actors = (v.actors || '').split(',').filter(Boolean).join(', ') || '-';
      const fullTitle = v.title || '';
      return `<tr class="v-${visitStateOf(v)}" ${visitRowAttrs('ai-zone', v)}>
        ${selCheckboxTd(v, 'ai-zone')}
        <td>${escHtml(v.run_date || '-')}</td>
        <td style="white-space:nowrap"><span class="visit-tag" title="">○</span> <b>${escHtml(v.code)}</b> <button class="btn-mini" style="font-size:11px" title="复制番号" onclick="copyText('${esc(String(v.code).replace(/'/g, "\\'"))}', this)">📋</button></td>
        <td style="max-width:320px;font-size:12px;color:var(--muted)" title="${escHtml(fullTitle)}">${escHtml(fullTitle.slice(0, 60))}${fullTitle.length > 60 ? '…' : ''}</td>
        <td style="white-space:nowrap">${v.score != null ? v.score.toFixed(2) : '-'} / ${v.votes || 0}人</td>
        <td style="max-width:180px">${escHtml(actors)}</td>
        <td style="min-width:160px;max-width:220px;word-break:break-all;white-space:normal;line-height:1.5">${renderDupCell(v)}</td>
        <td style="white-space:nowrap">${v.javdb_href ? `<a href="${escHtml(v.javdb_href)}" target="_blank" rel="noopener" class="btn sm${v.visited_javdb ? ' visited' : ''}" title="打开 javdb 详情(点击后自动标记)" onclick="markVisit(this,'ai-zone',${v.id},'javdb')">🌐 javdb</a>` : '<span style="color:#c0c8d0">-</span>'}</td>
        <td style="white-space:nowrap">${v.post_href ? `<a href="${escHtml(v.post_href)}" target="_blank" rel="noopener" class="btn sm green${v.visited_post ? ' visited' : ''}" title="打开色花堂原贴(点击后自动标记)" onclick="markVisit(this,'ai-zone',${v.id},'post')">📄 原贴</a>` : '<span style="color:#c0c8d0">-</span>'}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="9"><div class="empty"><span class="big">🤖</span>暂无记录 — 点击「▶️ 抓取AI专区」获取</div></td></tr>';
    tbody.querySelectorAll('tr[data-id]').forEach(applyVisitRow);
    refreshVisitStats('aiTbl');
    _lastSelIdx.aiTbl = null;
    syncSelAll('aiTbl');
    refreshSelInfo('aiTbl');
    renderPager('aiTbl');
}

async function saveAiZoneCfg() {
  const sc = document.getElementById('aiMinScore');
  const vt = document.getElementById('aiMinVotes');
  const score = parseFloat(sc.value);
  const votes = parseInt(vt.value);
  if (isNaN(score) || score < 0) { showMsg(document.getElementById('msgAI'), '评分阈值需为 ≥0 的数字', 'err'); return; }
  if (isNaN(votes) || votes < 0) { showMsg(document.getElementById('msgAI'), '人数阈值需为 ≥0 的整数', 'err'); return; }
  try {
    const r = await api('/api/ai-zone/config', 'POST', { score, votes });
    if (r.ok) showMsg(document.getElementById('msgAI'), `✅ 阈值已更新: 评分>=${score} 且 人数>${votes} (下次抓取生效)`, 'ok');
    else showMsg(document.getElementById('msgAI'), r.error || '保存失败', 'err');
  } catch (e) {
    showMsg(document.getElementById('msgAI'), '保存异常: ' + e.message, 'err');
  }
}

async function runAiZone() {
  const btn = event.target;
  const old = btn.textContent;
  btn.textContent = '⏳ 抓取中...';
  btn.disabled = true;
  const ds = document.getElementById('aiDateStart').value || null;
  const de = document.getElementById('aiDateEnd').value || null;
  try {
    const r = await api('/api/ai-zone/run', 'POST', { dateStart: ds, dateEnd: de });
    showMsg(document.getElementById('msgAI'), r.message || r.error || '已启动', r.ok ? 'ok' : 'err');
    if (r.ok) {
      // 日志面板自动跟随: 出现「[AI专区] 完成:」即判定结束(比按次数猜更准)
      await loadAiLogs();
      if (!_aiLogWatching) toggleAiLogWatch();
      await new Promise(resolve => {
        const iv = setInterval(() => {
          const box = document.getElementById('aiLogBox');
          if (box && /\[AI专区\] 完成:/.test(box.textContent)) { clearInterval(iv); resolve(); }
        }, 2000);
        setTimeout(() => { clearInterval(iv); resolve(); }, 10 * 60 * 1000);   // 10 分钟兜底
      });
      btn.textContent = old;
      btn.disabled = false;
      await loadAiZone();
      showMsg(document.getElementById('msgAI'), '✅ 抓取完成', 'ok');
    } else {
      btn.textContent = old;
      btn.disabled = false;
    }
  } catch (e) {
    showMsg(document.getElementById('msgAI'), '启动失败: ' + e.message, 'err');
    btn.textContent = old;
    btn.disabled = false;
  }
}

async function clearAiZone() {
  if (!confirm('确定清空所有AI专区记录?\n（会先自动备份到 data/backup/，不影响 115 里的文件）')) return;
  const r = await api('/api/ai-zone', 'DELETE');
  let msg;
  if (r.ok) {
    msg = `已清空 ${r.deleted} 条` + (r.backup ? `（备份: ${r.backup}）` : '');
  } else {
    msg = r.error || '失败';
  }
  showMsg(document.getElementById('msgAI'), msg, r.ok ? 'ok' : 'err');
  loadAiZone();
}

// ============================================
// Telegram Jasna-LTX(频道 @jasnashare · 关键词 Jasna-Ltx)
// 抓取 → 番号/ed2k/论坛地址 → 115 离线到 Jasna-LTX 目录
// ============================================
let _tgLogTimer = null;
let _tgLogWatching = false;

viewInits['tg-jasna'] = () => { loadTgJasna(); loadTgLogs(); };

function tgOfflineBadge(v) {
  if (!v.ed2k) return '<span class="badge warn" title="频道暂未放出下载链接, 等群成员补链后自动下载">⏳ 待补链</span>';
  const map = {
    submitted: ['blue', '↓ 已提交'], exists: ['ok', '✓ 115已有'],
    failed: ['red', '✕ 失败'], pending: ['gray', '○ 待离线'], skipped: ['gray', '— 跳过'],
  };
  const [cls, txt] = map[v.offline_status] || ['gray', v.offline_status || '○ 待离线'];
  const tip = v.offline_note ? ` title="${escHtml(v.offline_note)}"` : '';
  return `<span class="badge ${cls}"${tip}>${txt}</span>`;
}

function fmtBytes(n) {
  n = Number(n) || 0;
  if (!n) return '-';
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
  return (n / 1048576).toFixed(0) + ' MB';
}

// 修改番号: 纠正识别错误。提交后后端会清空该条旧评分/人数/演员，
// 便于点「📊 补录元数据」时按正确番号重新查询
// 删除错误记录: 抓错/链接错时整条移除(软删除, 该消息不会被重新抓回)
async function delTgRow(id, code) {
  const ok = confirm(`确定删除 ${code || '这条'} 记录吗？\n\n`
    + '· 只从列表移除，不影响 115 网盘里已存的资源\n'
    + '· 该条消息不会再被重新抓回来（指纹已记录）\n'
    + '· 如果只是链接错了，建议用「✏️ 改链接」而不是删除');
  if (!ok) return;
  const r = await api('/api/tg-jasna/delete', 'POST', { id });
  showMsg(document.getElementById('msgTG'), (r && r.message) || (r && r.error) || '已提交', r && r.ok ? 'ok' : 'err');
  if (r && r.ok) loadTgJasna();
}

async function editTgCode(id, oldCode) {  const old = (oldCode && oldCode !== '-') ? oldCode : '';
  const v = prompt('修改番号（字母/数字/横杠，例如 IPX-536）\n改完旧评分/演员会清空，可点「📊 补录元数据」按新番号重查。', old);
  if (v === null) return;
  const code = String(v).trim().toUpperCase();
  if (!code) return showMsg(document.getElementById('msgTG'), '番号不能为空', 'err');
  if (!/^[A-Z0-9][A-Z0-9_-]{1,24}$/.test(code)) {
    return showMsg(document.getElementById('msgTG'), '番号格式不对（只能用字母/数字/横杠/下划线）', 'err');
  }
  const r = await api('/api/tg-jasna/' + id + '/code', 'PATCH', { code });
  showMsg(document.getElementById('msgTG'), r.message || r.error || '已提交', r.ok ? 'ok' : 'err');
  if (r.ok) loadTgJasna();
}

// 手动修正下载链接: 链接抓错/失效时改掉, 改完自动重置离线状态, 可直接重推离线
async function editTgEd2k(id, oldLink) {
  const v = prompt(
    '修改下载链接（整条粘贴，必须以 ed2k:// 或 magnet:? 开头）\n\n'
    + '· 改完会自动把离线状态重置为「待离线」，可重新执行离线\n'
    + '· 留空并点确定 = 清空链接（标记为待补链）', oldLink || '');
  if (v === null) return;
  const link = String(v).trim();
  const r = await api('/api/tg-jasna/set-ed2k', 'POST', { id, ed2k: link });
  const box = document.getElementById('msgTG');
  if (r && r.ok) showMsg(box, '✅ ' + (r.message || '下载链接已更新'), 'ok');
  else showMsg(box, (r && r.error) || '修改失败', 'err');
  if (r && r.ok) loadTgJasna();
}

// 补录元数据: 全库补齐缺失的 javdb 评分/评分人数/演员
async function enrichTgMeta() {
  const btn = event.target;
  const old = btn.textContent;
  btn.textContent = '⏳ 已启动...';
  btn.disabled = true;
  try {
    const r = await api('/api/tg-jasna/enrich', 'POST', {});
    showMsg(document.getElementById('msgTG'), r.message || r.error || '已启动', r.ok ? 'ok' : 'err');
    if (r.ok) {
      showMsg(document.getElementById('msgTG'), (r.message || '') + ' ｜ 后台运行中，可稍后刷新查看进度', 'ok');
    }
    setTimeout(() => { btn.textContent = old; btn.disabled = false; loadTgLinkStatus(); }, 6000);
  } catch (e) {
    showMsg(document.getElementById('msgTG'), '请求失败: ' + e.message, 'err');
    btn.textContent = old;
    btn.disabled = false;
  }
}

// ===== 女演员筛选(点开即按片数从高到低平铺 + 首字母快捷筛选) =====
let _tgActorList = null;          // [{name, cn, count, initial}] 来自已抓取记录
let _tgActorFilter = '';          // 当前选中的演员(javdb 原名)
let _tgActorInitial = '';         // 当前选中的拼音首字母(A-Z / #)

async function toggleActorPanel(ev) {
  if (ev) ev.stopPropagation();
  const p = document.getElementById('tgActorPanel');
  if (!p) return;
  const willShow = p.style.display === 'none' || !p.style.display;
  p.style.display = willShow ? 'block' : 'none';
  if (!willShow) return;
  if (!_tgActorList) {
    const r = await api('/api/tg-jasna/actors', 'GET');
    _tgActorList = (r && r.ok) ? (r.actors || []) : [];
  }
  renderActorTree();
}

document.addEventListener('click', (e) => {
  const p = document.getElementById('tgActorPanel');
  if (!p || p.style.display !== 'block') return;
  // 用 composedPath 判断: 重渲染后 e.target 可能已脱离文档
  const path = (typeof e.composedPath === 'function' && e.composedPath()) || [];
  if (path.includes(p)) return;
  const b = document.getElementById('tgActorBtn');
  if (b && path.includes(b)) return;
  p.style.display = 'none';
});

function renderActorTree() {
  const box = document.getElementById('tgActorTree');
  if (!box) return;
  const kwEl = document.getElementById('tgActorSearch');
  const q = String((kwEl && kwEl.value) || '').trim().toLowerCase();
  const all = _tgActorList || [];
  const labelOf = (a) => a.cn || a.name;   // 优先中文名(115 目录名)

  // 首字母 → 搜索词 两级过滤
  let list = all;
  if (_tgActorInitial) list = list.filter(a => a.initial === _tgActorInitial);
  if (q) {
    list = list.filter(a => String(a.cn || '').toLowerCase().includes(q) || String(a.name).toLowerCase().includes(q));
  }

  // 首字母计数
  const cnt = {};
  for (const a of all) cnt[a.initial] = (cnt[a.initial] || 0) + 1;

  let html = `<div style="color:var(--muted);font-size:12px;margin-bottom:6px">已抓取 ${all.length} 位女演员 · 按片数从高到低 · 点名字筛选</div>`;

  // 首字母快捷条(A-Z + #), 空字母置灰
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').concat(['#']);
  html += '<div style="display:flex;flex-wrap:wrap;gap:3px;margin-bottom:8px">' + LETTERS.map(ch => {
    const n = cnt[ch] || 0;
    const on = _tgActorInitial === ch;
    const st = on
      ? 'background:var(--primary);color:#fff;border-color:var(--primary);font-weight:600'
      : (n ? '' : 'opacity:.3;cursor:default');
    return `<button class="btn-mini" ${n ? '' : 'disabled'} onclick="pickActorInitial('${ch}')" title="${ch} 开头 ${n} 位"
      style="min-width:23px;padding:1px 4px;font-size:11.5px;${st}">${ch}</button>`;
  }).join('') + '</div>';

  if (_tgActorFilter) {
    const cur = all.find(a => a.name === _tgActorFilter);
    const curLabel = cur ? labelOf(cur) : _tgActorFilter;
    html += `<div style="margin-bottom:8px"><button class="btn-mini" onclick="pickActor('')">✕ 取消筛选（当前：${escHtml(curLabel)}）</button></div>`;
  }

  const tip = (_tgActorInitial ? `首字母 ${_tgActorInitial} · ` : '') + `${list.length} 位`;
  html += `<div style="color:var(--muted);font-size:11.5px;margin-bottom:4px">${tip}</div>`;

  if (!list.length) {
    box.innerHTML = html + '<div style="color:var(--muted);padding:6px 0">没有匹配的演员</div>';
    return;
  }

  // 平铺: 数据处理侧已按 count 降序, 这里保持顺序即可
  html += '<div style="border-top:1px solid var(--border);padding-top:4px">' + list.map(a => {
    const on = a.name === _tgActorFilter;
    return `<div style="display:flex;align-items:center;gap:8px;padding:3px 5px;cursor:pointer;border-radius:6px;${on ? 'background:var(--row-striped);font-weight:600' : ''}"
      onmouseover="if(!this.dataset.on)this.style.background='var(--row-striped)'" onmouseout="if(!this.dataset.on)this.style.background=''" ${on ? 'data-on="1"' : ''}
      onclick="pickActor('${escHtml(a.name).replace(/'/g, "\\'")}')" title="${escHtml(a.name)}">
      <span style="flex:0 0 40px;text-align:right;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums">${a.count}</span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(labelOf(a))}</span>
      ${(a.cn && a.cn !== a.name) ? `<span style="flex:0 0 auto;color:var(--muted);font-size:11px;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(a.name)}</span>` : ''}
    </div>`;
  }).join('') + '</div>';
  box.innerHTML = html;
}

function pickActorInitial(ch) {
  _tgActorInitial = (_tgActorInitial === ch) ? '' : ch;
  renderActorTree();
}

function pickActor(name) {
  _tgActorFilter = name || '';
  // 按钮显示中文目录名(便于核对 115 文件夹), 筛选值仍是 javdb 原名
  let label = _tgActorFilter;
  if (label) {
    const hit = (_tgActorList || []).find(a => a.name === label);
    if (hit && hit.cn) label = hit.cn;
  }
  const btn = document.getElementById('tgActorBtn');
  if (btn) btn.textContent = _tgActorFilter ? `🎭 ${label}` : '🎭 全部女演员';
  const p = document.getElementById('tgActorPanel');
  if (p) p.style.display = 'none';
  loadTgJasna();
}

// 元数据筛选开关: 点状态条「待补元数据」→ 只看缺评分/演员的记录
let _tgMetaFilter = false;
function toggleTgMetaFilter() {
  _tgMetaFilter = !_tgMetaFilter;
  loadTgJasna();
  showMsg(document.getElementById('msgTG'),
    _tgMetaFilter ? '已筛选: 只显示缺评分/演员的记录（再点一次「待补元数据」取消）' : '已取消元数据筛选',
    'ok');
}

// 补链状态条自动刷新: 视图可见时每 30 秒拉一次(补链进度实时, 不用手动刷页面)
setInterval(() => {
  try {
    const v = document.getElementById('view-tg-jasna');
    if (!v) return;
    const hidden = v.style.display === 'none' || !v.classList.contains('active');
    if (!hidden) loadTgLinkStatus();
  } catch (e) {}
}, 30000);

// 点击版本徽标: 筛选该番号的全部版本(自制/常规对照查看); 记住筛选前状态, 可一键返回
let _tgSameCodePrev = null;   // { keyword, id, scrollY }
let _tgSameCodeActive = null; // 当前正在单独查看的番号
function searchSameCode(code, id) {
  const kw = document.getElementById('tgKeyword');
  _tgSameCodePrev = { keyword: kw ? kw.value : '', id: id || 0, scrollY: window.scrollY || 0 };
  _tgSameCodeActive = code;
  if (kw) kw.value = code;
  loadTgJasna();
  showSameCodeBar(code);
}

function showSameCodeBar(code) {
  let bar = document.getElementById('tgSameCodeBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'tgSameCodeBar';
    bar.style.cssText = 'margin:8px 0;padding:8px 12px;background:rgba(31,78,121,.08);border:1px solid rgba(31,78,121,.25);border-radius:10px;font-size:13px;display:flex;align-items:center;gap:12px;flex-wrap:wrap';
    const anchor = document.getElementById('tgLinkStatus');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(bar, anchor.nextSibling);
    else { const v = document.getElementById('view-tg-jasna'); if (v) v.prepend(bar); }
  }
  bar.innerHTML = `<span>🔍 正在单独查看番号 <b>${escHtml(code)}</b> 的全部版本（含无水印/有水印）</span>
    <button class="btn" style="padding:4px 12px" onclick="clearSameCodeFilter()">↩ 返回原列表</button>`;
  bar.style.display = 'flex';
}

function hideSameCodeBar() {
  const bar = document.getElementById('tgSameCodeBar');
  if (bar) bar.style.display = 'none';
  _tgSameCodeActive = null;
}

// 返回原列表: 等数据回来再按「记录 id」定位, 不再用裸 scrollY —— 筛选视图只有几行,
// 页面被压短后浏览器会把旧坐标钳到最底部, 表现出来就是"闪一下 + 跳到最下面的日志窗口"。
async function clearSameCodeFilter() {
  const prev = _tgSameCodePrev || { keyword: '', id: 0, scrollY: 0 };
  const kw = document.getElementById('tgKeyword');
  if (kw) kw.value = prev.keyword || '';
  hideSameCodeBar();
  _tgSameCodePrev = null;
  await loadTgJasna();                       // 等接口返回并完成渲染, 不用固定 350ms 猜时间
  const id = prev.id;
  const list = _pageCache.tgTbl || [];
  const idx = id ? list.findIndex(v => v.id === id) : -1;
  if (idx >= 0) {
    // 回到这条记录所在的页, 再把它滚到屏幕中间(列表变长后页码可能和筛选前不同)
    const targetPage = Math.floor(idx / getPageSize('tgTbl')) + 1;
    if (_pageState.tgTbl !== targetPage) {   // 同页就不重渲染, 少一次整表重绘(=闪一下)
      _pageState.tgTbl = targetPage;
      renderTgPage();
    }
    requestAnimationFrame(() => {
      const tr = document.querySelector('#tgTbl tr[data-id="' + id + '"]');
      if (tr) tr.scrollIntoView({ block: 'center' });
      else window.scrollTo(0, prev.scrollY || 0);
    });
    return;
  }
  requestAnimationFrame(() => window.scrollTo(0, prev.scrollY || 0));
}

// 持续补链: 启动/停止
async function toggleFetchLoop() {
  const btn = document.getElementById('tgFetchLoopBtn');
  const running = btn.dataset.running === '1';
  btn.disabled = true;
  try {
    const r = await api('/api/tg-jasna/fetch-loop/' + (running ? 'stop' : 'start'), 'POST', {});
    showMsg(document.getElementById('msgTG'), r.message || r.error || '', r.ok ? 'ok' : 'err');
  } catch (e) {
    showMsg(document.getElementById('msgTG'), '请求失败: ' + e.message, 'err');
  }
  btn.disabled = false;
  loadTgLinkStatus();
}

// 补链断点状态: 有链 / 待补 / 已删除 / 全局冷却 / 待补元数据 / 半小时任务是否在跑
async function loadTgLinkStatus() {
  const box = document.getElementById('tgLinkStatus');
  if (!box) return;
  try {
    const r = await api('/api/tg-jasna/link-status', 'GET');
    if (!r || !r.ok) { box.textContent = ''; return; }
    const parts = [];
    // 实时抓取状态(放最前): 有没有在抓 + 抓到哪条消息了
    if (r.latestMsgId) {
      const at = (r.latestMsgAt || '').slice(11, 16);
      const suffix = `最新消息 #${r.latestMsgId}${at ? ' · ' + at : ''}`;
      parts.push(r.fetchLoop
        ? `<span style="color:#0F6E56;font-weight:600" title="正在抓取: 持续补链每轮都会检查一次 Telegram 新消息(约 1-2 分钟)">🔄 抓取中 <span style="font-weight:400;opacity:.8">${suffix}</span></span>`
        : `<span style="opacity:.7" title="抓取待机: 持续补链未运行, 由半小时任务抓取">💤 待机 <span style="opacity:.8">${suffix}</span></span>`);
    }
    // 影片数 = 平台上能看到的全部影片(含新旧群); 待补/进度看 newTotal
    const realTotal = r.platformTotal || r.totalExclDup || r.total;
    const newTotal = r.totalExclDup || r.total;
    const detail = r.missing ? `平台共 ${realTotal} 部（新群 ${newTotal} 部），还有 ${r.missing} 部在补链` : `平台共 ${realTotal} 部影片（新群 ${newTotal} 部），全部已补到下载链接`;
    parts.push(`<span title="${detail}" style="cursor:help">📼 <b style="color:var(--text)">${realTotal}</b> 部影片</span>`);
    if (r.missing) parts.push(`<span style="color:#e8a33d" title="这 ${r.missing} 部还没拿到下载链接，正在自动补">⏳ 补链中，待补 ${r.missing}</span>`);
    else parts.push(`<span style="color:#0F6E56;font-weight:600" title="所有能补的影片链接都已拿到">✅ 补链完成</span>`);
    if (r.fetchLoop) parts.push(`<span style="color:#0F6E56" title="持续补链运行中: 每轮自动抓新消息 + 补链 + 即刻离线">♾️ 运行中</span>`);
    if (r.cooldown) parts.push(`<span style="color:#e8663d" title="Telegram 限流, 冷却中">🧊 ${String(r.cooldown).slice(11, 16)}</span>`);
    if (r.metaMissing) parts.push(`<span onclick="toggleTgMetaFilter()" title="缺评分/女演员的影片数, 点击只看这些" style="cursor:pointer;text-decoration:underline;text-underline-offset:3px;color:${_tgMetaFilter ? '#c2410c' : '#e8a33d'};font-weight:${_tgMetaFilter ? 600 : 400}">📊 缺资料 ${r.metaMissing}${_tgMetaFilter ? ' ✕' : ''}</span>`);
    parts.push(`<span title="半小时任务${r.halfActive ? '运行中' : '未启动'}" style="opacity:.55;cursor:help">⋯</span>`);
    box.innerHTML = parts.join('<span style="opacity:.22;margin:0 3px">·</span>');
    // 同步按钮状态
    const btn = document.getElementById('tgFetchLoopBtn');
    if (btn) { btn.dataset.running = r.fetchLoop ? '1' : '0'; btn.textContent = r.fetchLoop ? '⏹ 停止持续补链' : '♾️ 持续补链'; }
  } catch (e) { box.textContent = ''; }
}

// 填充「消息日期」单选下拉(保留当前选中值)
function fillTgMsgDates(list, current) {
  const sel = document.getElementById('tgMsgDateFilter');
  if (!sel || !Array.isArray(list) || !list.length) return;
  const cur = current || sel.value || '';
  sel.innerHTML = ['<option value="">全部消息日期</option>']
    .concat(list.map(d => `<option value="${escHtml(d)}"${d === cur ? ' selected' : ''}>${escHtml(d)}</option>`))
    .join('');
}

// 标记/取消「不需要补元数据」: javdb 本身没有这部片的记录, 反复重试没意义
async function toggleMetaSkip(id, skip) {
  const r = await api('/api/tg-jasna/meta-skip', 'POST', { id, skip: skip ? 1 : 0 });
  if (r && r.ok) {
    showMsg(document.getElementById('msgTG'), skip ? '已标记为无需补录，今后不再重试' : '已恢复，下次补录会重新查询', 'ok');
    loadTgJasna();
  } else {
    showMsg(document.getElementById('msgTG'), (r && r.error) || '操作失败', 'err');
  }
}

// 列宽统一由 index.html 的 colgroup 百分比控制(12 列), 前端不再逐列覆盖
function initColResize() { /* 占位: 渲染后无需再做列宽处理 */ }

// 关键词框右侧的 × : 有内容才显示; 点一下清空并重新加载全部
function syncKwClear() {
  const kw = document.getElementById('tgKeyword');
  const btn = document.getElementById('tgKwClear');
  if (kw && btn) btn.classList.toggle('show', !!String(kw.value || '').trim());
}
function clearTgKeyword() {
  const kw = document.getElementById('tgKeyword');
  if (!kw) return;
  kw.value = '';
  syncKwClear();
  // 正在"单独查看某番号"时, 清空关键词也要把返回条一起收掉
  if (typeof _tgSameCodeActive !== 'undefined' && _tgSameCodeActive) {
    hideSameCodeBar();
    _tgSameCodePrev = null;
  }
  loadTgJasna();
  kw.focus();
}

async function loadTgJasna() {
  // 用户手动改了关键词(不再是单独查看的那个番号) → 自动收起返回条
  if (_tgSameCodeActive) {
    const kwv = ((document.getElementById('tgKeyword') || {}).value || '').trim();
    if (kwv.toUpperCase() !== _tgSameCodeActive.toUpperCase()) {
      hideSameCodeBar();
      _tgSameCodePrev = null;
    }
  }
  loadTgLinkStatus();
  const tbody = document.getElementById('tgTbl');
  if (!tbody) return;
  const qs = new URLSearchParams();
  const ds = document.getElementById('tgDateStart'), de = document.getElementById('tgDateEnd');
  const kw = document.getElementById('tgKeyword'), of = document.getElementById('tgOfflineFilter');
  if (ds && ds.value) qs.set('date-start', ds.value);
  if (de && de.value) qs.set('date-end', de.value);
  if (kw && kw.value.trim()) qs.set('keyword', kw.value.trim());
  if (of && of.value) qs.set('offline', of.value);
  if (_tgMetaFilter) qs.set('meta', 'missing');
  const sf = document.getElementById('tgScoreFilter'), vf = document.getElementById('tgVotesFilter');
  if (sf && sf.value) qs.set('score-band', sf.value);
  if (vf && vf.value) qs.set('votes-band', vf.value);
  const rf = document.getElementById('tgResolutionFilter');
  if (rf && rf.value) qs.set('resolution', rf.value);
  const df = document.getElementById('tgDualFilter');
  if (df && df.value) qs.set('dual', df.value);
  if (_tgActorFilter) qs.set('actor', _tgActorFilter);
  const mdf = document.getElementById('tgMsgDateFilter'), vsf = document.getElementById('tgVisitFilter');
  if (mdf && mdf.value) qs.set('msg-date', mdf.value);
  if (vsf && vsf.value) qs.set('visit', vsf.value);
  try {
    const r = await api('/api/tg-jasna?' + qs.toString());
    if (!r.ok) { showMsg(document.getElementById('msgTG'), r.error || '加载失败', 'err'); return; }
    fillTgMsgDates(r.msgDates, (mdf && mdf.value) || '');
    const s = r.stats || {};
    const el = document.getElementById('tgStats');
    if (el) {
      el.innerHTML = `共 <b>${s.total || 0}</b> 条 · 今日 <b>${s.today || 0}</b> · 已离线 <b>${s.submitted || 0}</b> · 待离线 <b style="color:var(--warn,#d08a00)">${s.pending || 0}</b>`
        + (s.missingLink ? ` · <b style="color:#d97706" title="频道改版后正文不再带链接, 等群成员补链">待补链 ${s.missingLink}</b>` : '')
        + ` · 合计 ${fmtBytes(s.bytes)}`
        + (s.lastMsgAt ? ` · 最近 ${escHtml(s.lastMsgAt)}` : '');
    }
    _pageCache.tgTbl = r.rows || [];
    _pageState.tgTbl = 1;
    renderTgPage();
    syncKwClear();
  } catch (e) {
    showMsg(document.getElementById('msgTG'), '加载异常: ' + e.message, 'err');
  }
}

function renderTgPage() {
  const tbody = document.getElementById('tgTbl');
  if (!tbody) return;
  const rows = pageSlice('tgTbl');
  tbody.innerHTML = rows.map(v => {
    const text = String(v.text || '');
    const code = v.code || '-';
    // 演员列优先显示 115 中文目录名(后端已按 actress_map 映射), 没有则回退 javdb 日文名
    const actors = String(v.actors_cn || v.actors || '').trim();
    const vs = visitStateOf(v);
    return `<tr class="v-${vs}" ${visitRowAttrs('tg-jasna', v)}>
      <td style="text-align:center;white-space:nowrap">
        <span class="visit-tag" style="margin-right:3px" title="${vs === 'done' ? '已存' : '未存'}">${vs === 'done' ? '✅' : '○'}</span>
        <button class="btn-mini" style="padding:1px 4px" title="标记为已存" onclick="markOne(this,'tg-jasna',${v.id},1)">✓</button>
        <button class="btn-mini" style="padding:1px 4px" title="取消已存标记" onclick="markOne(this,'tg-jasna',${v.id},0)">↺</button>
        <button class="btn-mini" style="padding:1px 4px" title="删除这条记录（抓错/链接错误时用；不影响 115 网盘已有资源）" onclick="delTgRow(${v.id}, '${escHtml(code).replace(/'/g, "\\'")}')">🗑</button>
      </td>
      <td style="white-space:nowrap;font-size:12px">${escHtml((v.msg_date || v.run_date || '').slice(5, 16))}</td>
      <td class="tg-code-cell">
        <div style="white-space:nowrap"><b>${escHtml(code)}</b></div>
        ${(v.version === 'selfmade' || v.other_ver > 0) ? `<div style="margin-top:2px;white-space:normal;line-height:1.7">${v.version === 'selfmade' ? `<span onclick="searchSameCode('${escHtml(code).replace(/'/g, "\\'")}', ${v.id})" title="消息含「自制投稿」= 无水印自制版，与常规有水印版是不同资源；点击查看该番号全部版本" style="cursor:pointer;font-size:10px;color:#0F6E56;background:rgba(15,110,86,.14);padding:0 4px;border-radius:4px;vertical-align:middle">无水印</span>` : ''}${v.other_ver > 0 ? `<span onclick="searchSameCode('${escHtml(code).replace(/'/g, "\\'")}', ${v.id})" title="该番号还有另一版本（自制/常规），点击一起查看" style="cursor:pointer;font-size:10px;color:#1F4E79;background:rgba(31,78,121,.12);padding:0 4px;border-radius:4px;margin-left:3px;vertical-align:middle">🔀 双版本</span>` : ''}</div>` : ''}
        <div style="margin-top:2px;white-space:nowrap">
          <button class="btn-mini" title="复制番号" onclick="copyText('${escHtml(code).replace(/'/g, "\\'")}', this)">📋</button>
          <button class="btn-mini" title="修改番号（纠正识别错误；改完会清空旧评分/演员，可重新补录）" onclick="editTgCode(${v.id}, '${escHtml(v.code || '').replace(/'/g, "\\'")}')">✏️</button>
        </div>
      </td>
      <td style="white-space:nowrap;text-align:center">${v.resolution
        ? `<span class="res-tag res-${{ '4K': '4k', '1080P': '1080', '720P': '720', 'SD': 'sd' }[v.resolution] || 'sd'}" title="按文件名/正文/文件大小自动判定">${escHtml(v.resolution)}</span>`
        : '<span style="color:#c0c8d0">-</span>'}${Number(v.fps60) === 1
        ? '<span class="fps-tag" title="消息/文件名标注 60 帧">60帧</span>' : ''}</td>
      <td style="white-space:nowrap;text-align:center">${v.score != null && v.score > 0
        ? Number(v.score).toFixed(2)
        : (Number(v.meta_skip) === 1
          ? `<span class="meta-skip-tag" title="javdb 没有这部片的记录，已标记跳过；点一下恢复重试" onclick="toggleMetaSkip(${v.id}, 0)">🚫 无需补录</span>`
          : '<span style="color:#c0c8d0">-</span>')}</td>
      <td style="white-space:nowrap;text-align:center">${v.votes != null && v.votes > 0 ? Number(v.votes).toLocaleString() : '<span style="color:#c0c8d0">-</span>'}</td>
      <td style="font-size:12px;line-height:1.5;word-break:break-word">${actors && actors !== '-' ? escHtml(actors) : '<span style="color:#c0c8d0">-</span>'}</td>
      <td style="font-size:12px;word-break:break-all;line-height:1.5">${escHtml(v.file_name || '-')}
        <div style="color:var(--muted);font-size:11px">${fmtBytes(v.file_size)}</div></td>
      <td style="font-size:10.5px;line-height:1.32;word-break:break-all">${v.ed2k
        ? `<div style="color:var(--text);opacity:.72">${escHtml(v.ed2k)}</div>
           <button class="btn-mini" style="margin-top:2px" title="复制下载链接" onclick="copyText('${escHtml(v.ed2k).replace(/'/g, "\\'")}', this)">📋 复制</button>
           <button class="btn-mini" style="margin-top:2px" title="链接抓错/失效时可手动修正，改完能重新推离线" onclick="editTgEd2k(${v.id}, '${escHtml(v.ed2k).replace(/'/g, "\\'")}')">✏️ 改链接</button>`
        : `<span class="badge warn" title="频道改版后正文不带链接, 等群成员补链; 系统每次抓取会自动重扫捡回">⏳ 待补链</span>
           <div style="margin-top:3px"><button class="btn-mini" onclick="editTgEd2k(${v.id}, '')" title="手动填入下载链接">✏️ 填链接</button></div>`}</td>
      <td style="white-space:nowrap">${v.forum_url
        ? `<a href="${escHtml(v.forum_url)}" target="_blank" rel="noopener" class="btn sm green">📄 原贴</a>`
        : '<span style="color:#c0c8d0" title="自制投稿/无论坛来源">-</span>'}</td>
      <td style="white-space:nowrap">${tgOfflineBadge(v)}</td>
      <td style="font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word">${escHtml(text) || '<span style="color:#c0c8d0">-</span>'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="12"><div class="empty"><span class="big">📡</span>暂无记录 — 点「▶️ 立即抓取 + 补链」或等半小时任务</div></td></tr>';
  renderPager('tgTbl');
  initColResize();
}

// 抓取(带日志实时跟随, 出现「完成:」判定结束)
async function runTgJasna() {
  const btn = event.target;
  const old = btn.textContent;
  btn.textContent = '⏳ 抓取中...';
  btn.disabled = true;
  try {
    const noOffline = false;
    const r = await api('/api/tg-jasna/run', 'POST', { noOffline });
    showMsg(document.getElementById('msgTG'), r.message || r.error || '已启动', r.ok ? 'ok' : 'err');
    if (!r.ok) { btn.textContent = old; btn.disabled = false; return; }
    await loadTgLogs();
    if (!_tgLogWatching) toggleTgLogWatch();
    await new Promise(resolve => {
      const iv = setInterval(() => {
        const box = document.getElementById('tgLogBox');
        if (box && /\[Jasna-LTX\] 完成:/.test(box.textContent)) { clearInterval(iv); resolve(); }
      }, 2000);
      setTimeout(() => { clearInterval(iv); resolve(); }, 8 * 60 * 1000);
    });
    await loadTgJasna();
    showMsg(document.getElementById('msgTG'), '✅ 抓取完成', 'ok');
  } catch (e) {
    showMsg(document.getElementById('msgTG'), '启动失败: ' + e.message, 'err');
  }
  btn.textContent = old;
  btn.disabled = false;
}

// 补离线队列里的 N 条
async function offlineTgPending(n) {
  const btn = event.target;
  const old = btn.textContent;
  btn.textContent = '⏳ 提交中...';
  btn.disabled = true;
  try {
    const r = await api('/api/tg-jasna/offline', 'POST', { limit: n });
    showMsg(document.getElementById('msgTG'), r.message || r.error || '已启动', r.ok ? 'ok' : 'err');
    if (r.ok) {
      await loadTgLogs();
      if (!_tgLogWatching) toggleTgLogWatch();
      await new Promise(resolve => {
        const iv = setInterval(() => {
          const box = document.getElementById('tgLogBox');
          if (box && /\[Jasna-LTX\] 完成:/.test(box.textContent)) { clearInterval(iv); resolve(); }
        }, 1500);
        setTimeout(() => { clearInterval(iv); resolve(); }, 5 * 60 * 1000);
      });
      await loadTgJasna();
    }
  } catch (e) {
    showMsg(document.getElementById('msgTG'), '提交失败: ' + e.message, 'err');
  }
  btn.textContent = old;
  btn.disabled = false;
}

// 一键导出当前筛选结果为 Excel
function exportTgJasna() {
  const qs = new URLSearchParams();
  const ds = document.getElementById('tgDateStart'), de = document.getElementById('tgDateEnd');
  const kw = document.getElementById('tgKeyword'), of = document.getElementById('tgOfflineFilter');
  if (ds && ds.value) qs.set('date-start', ds.value);
  if (de && de.value) qs.set('date-end', de.value);
  if (kw && kw.value.trim()) qs.set('keyword', kw.value.trim());
  if (of && of.value) qs.set('offline', of.value);
  if (_tgMetaFilter) qs.set('meta', 'missing');
  const sf2 = document.getElementById('tgScoreFilter'), vf2 = document.getElementById('tgVotesFilter');
  if (sf2 && sf2.value) qs.set('score-band', sf2.value);
  if (vf2 && vf2.value) qs.set('votes-band', vf2.value);
  if (_tgActorFilter) qs.set('actor', _tgActorFilter);
  const mdf2 = document.getElementById('tgMsgDateFilter'), vsf2 = document.getElementById('tgVisitFilter');
  if (mdf2 && mdf2.value) qs.set('msg-date', mdf2.value);
  if (vsf2 && vsf2.value) qs.set('visit', vsf2.value);
  const n = (_pageCache.tgTbl || []).length;
  showMsg(document.getElementById('msgTG'), `正在生成 Excel（${n} 条）...`, 'ok');
  window.location.href = '/api/tg-jasna/export?' + qs.toString();
}

// 规范命名(番号_JasnaLTX-U / -4K-U)
async function renameTgDir() {
  const btn = event.target;
  const old = btn.textContent;
  btn.textContent = '⏳ 改名中...';
  btn.disabled = true;
  try {
    const r = await api('/api/tg-jasna/rename', 'POST', {});
    showMsg(document.getElementById('msgTG'), r.message || r.error || '已开始', r.ok ? 'ok' : 'err');
    if (r.ok) {
      await new Promise(res => setTimeout(res, 20000));
      await loadTgJasna();
    }
  } catch (e) {
    showMsg(document.getElementById('msgTG'), '改名失败: ' + e.message, 'err');
  }
  btn.textContent = old;
  btn.disabled = false;
}

async function clearTgJasna() {
  if (!confirm('确定清空所有 Jasna-LTX 记录?\n（会先自动备份到 data/backup/，不影响 115 里的文件）')) return;
  const r = await api('/api/tg-jasna', 'DELETE');
  let msg;
  if (r.ok) {
    msg = `已清空 ${r.deleted} 条` + (r.backup ? `（备份: ${r.backup}）` : '');
  } else {
    msg = r.error || '失败';
  }
  showMsg(document.getElementById('msgTG'), msg, r.ok ? 'ok' : 'err');
  loadTgJasna();
}

// ----- 抓取日志 -----
async function loadTgLogs(pick) {
  const sel = document.getElementById('tgLogSel');
  const meta = document.getElementById('tgLogMeta');
  if (!sel) return;
  try {
    const r = await api('/api/tg-jasna/logs');
    const logs = (r && r.logs) || [];
    if (!logs.length) {
      sel.innerHTML = '<option value="">(暂无日志)</option>';
      if (meta) meta.textContent = '';
      return;
    }
    const cur = pick || sel.value;
    sel.innerHTML = logs.map(l => {
      const t = l.name.replace(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.log$/, '$1-$2-$3 $4:$5:$6');
      return `<option value="${l.name}"${l.name === cur ? ' selected' : ''}>${t} (${(l.size / 1024).toFixed(1)} KB)</option>`;
    }).join('');
    const target = logs.some(l => l.name === cur) ? cur : logs[0].name;
    sel.value = target;
    await viewTgLog(target);
  } catch (e) { console.warn('加载 Jasna-LTX 日志失败:', e.message); }
}

async function viewTgLog(name) {
  const box = document.getElementById('tgLogBox');
  const meta = document.getElementById('tgLogMeta');
  if (!box) return;
  if (!name) { box.textContent = '（选择一个日志文件查看内容）'; if (meta) meta.textContent = ''; return; }
  try {
    const r = await fetch('/api/tg-jasna/logs/' + encodeURIComponent(name)).then(x => x.json());
    if (!r.ok) { box.textContent = '读取失败: ' + (r.error || ''); return; }
    box.textContent = r.content || '(空)';
    box.scrollTop = box.scrollHeight;
    if (meta) meta.textContent = `${name} · ${(r.content || '').split('\n').length} 行`;
  } catch (e) { box.textContent = '读取异常: ' + e.message; }
}

function toggleTgLogWatch() {
  const btn = document.getElementById('btnWatchTgLog');
  const stop = () => {
    clearInterval(_tgLogTimer); _tgLogTimer = null; _tgLogWatching = false;
    if (btn) { btn.textContent = '👁 实时跟随'; btn.classList.remove('run-btn'); }
  };
  if (_tgLogWatching) { stop(); return; }
  _tgLogWatching = true;
  if (btn) { btn.textContent = '⏹ 停止跟随'; btn.classList.add('run-btn'); }
  const tick = async () => {
    await loadTgLogs();
    const box = document.getElementById('tgLogBox');
    if (box && /\[Jasna-LTX\] 完成:/.test(box.textContent)) {
      stop();
      await loadTgJasna();
    }
  };
  tick();
  _tgLogTimer = setInterval(tick, 2000);
}

async function deleteTgLog() {
  const sel = document.getElementById('tgLogSel');
  if (!sel || !sel.value) return;
  if (!confirm(`删除日志 ${sel.value} ?`)) return;
  try {
    await fetch('/api/tg-jasna/logs/' + encodeURIComponent(sel.value), { method: 'DELETE' });
    await loadTgLogs();
  } catch (e) { console.warn('删除日志失败:', e.message); }
}

// ============================================
// 启动
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  renderThemeSwitch();
  switchView(currentView());
  // 日期框: 点击任意位置直接弹出日期选择器(不需要点右侧图标)
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t && t.tagName === 'INPUT' && t.type === 'date') {
      try { t.showPicker && t.showPicker(); } catch {}
    }
  });
});
