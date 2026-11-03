// ============================================================
// 前端只读适配 (公网分享模式)
// ------------------------------------------------------------
// 判定方式:
//   1. 优先读 window.__PUBLIC_READONLY__ —— 后端在返回首页 HTML 时注入,
//      同步生效, 没有异步竞态(访客手输 #/config 也进不去)。
//   2. 兜底: 异步问 /api/pub-mode。
// 生效后:
//   - 移除「配置」入口与配置视图(含 115 cookie / 账号等)
//   - 隐藏所有管理动作按钮(运行 / 抓取 / 离线 / 删除 / 保存 / 清理 / 标记)
//   - 拦截所有非 GET 请求(双保险, 后端也有 403)
//   - 保留: 浏览 / 搜索 / 筛选 / 翻页 / 预告片播放 / 导出 Excel
// 本机直连(非只读)下本脚本不做任何事。
// ============================================================
(function () {
  'use strict';

  // 需要隐藏的管理动作(函数名, 含动态表格里 onclick 生成的)
  var MGMT_FN = [
    'runPipeline', 'runNetcheck', 'retryNetcheck',                // 仪表盘
    'runCleanupScan', 'runCleanupDelete', 'runCleanupRename',     // 垃圾清理
    'runCleanupAll', 'cleanupSelectAllType', 'cleanupToggleGrp',
    'addRule', 'regTaskPlanner', 'unregTaskPlanner',              // 配置
    'saveConfig', 'resetConfig', 'saveCleanupCfg',
    'markSelectedDone', 'resetVisitBulk', 'markVisit', 'markOne', // 影片记录
    'syncActressMap', 'openAmCreate', 'saveAmEdit',               // 演员映射
    'delAm', 'delAmAlias', 'delAmDir', 'markAm',
    'openAmEdit', 'openAmEditDir', 'openAmInline', 'startAddAlias',
    'deleteRun',                                                  // 运行记录删除
    'runAiZone', 'clearAiZone', 'deleteAiLog',                    // AI 专区
    'runTgJasna', 'offlineTgPending', 'renameTgDir',              // Jasna-LTX
    'clearTgJasna', 'deleteTgLog',
    'toggleFetchLoop', 'enrichTgMeta',                            // Jasna-LTX 循环补链 / 元数据回填
    'delTgRow', 'editTgCode', 'editTgEd2k', 'toggleMetaSkip',     // Jasna-LTX 行内操作(删该条/改番号/改链接/无需补录)
    'saveAiZoneCfg',                                              // AI 专区保存配置
    'openReportAnchor',                                           // 报告"生成并定位"(会重新生成报告)
    'doCleanup',                                                  // 垃圾清理执行
  ];

  // 文字兜底: 动态渲染、没有 onclick 属性的按钮靠文字识别
  var MGMT_TEXT = [
    '删除', '清空', '移除', '重置', '保存', '抓取', '运行', '扫描',
    '重建', '新增', '新建', '编辑', '标记', '还原', '重试', '一键',
    '规范命名', '补离线', '全量',
  ];

  // 需要整卡移除的区块(按 h2 标题匹配)
  var DROP_CARDS = ['立即运行', '115 垃圾文件清理'];

  var domDone = false;

  // ---------- 同步阶段: 在任何初始化之前把防线立起来 ----------
  function applySync() {
    document.body.classList.add('ro-mode');
    patchFetch();
    patchRouter();
  }

  function patchRouter() {
    if (window.__RO_ROUTER_PATCHED__) return;
    window.__RO_ROUTER_PATCHED__ = true;
    // 屏蔽配置视图: 即便手输 #/config 也直接落回仪表盘
    var orig = window.switchView;
    if (typeof orig === 'function') {
      window.switchView = function (v) {
        if (String(v) === 'config') v = 'dashboard';
        return orig.call(this, v);
      };
    }
  }

  function patchFetch() {
    if (window.__RO_FETCH_PATCHED__) return;
    window.__RO_FETCH_PATCHED__ = true;
    var raw = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : ((input && input.url) || '');
      var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      var isAccess = url.indexOf('/api/access/') >= 0;
      if (!isAccess && method !== 'GET' && method !== 'HEAD') {
        toast('只读分享模式：该操作不可用');
        return Promise.resolve(new Response(
          JSON.stringify({ ok: false, code: 'READONLY', error: '只读分享模式: 该操作已禁用' }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        ));
      }
      return raw.apply(this, arguments);
    };
  }

  // ---------- DOM 阶段: 清理界面上的管理入口 ----------
  function fnName(el) {
    var oc = el.getAttribute && el.getAttribute('onclick');
    if (!oc) return '';
    var m = String(oc).match(/^\s*([A-Za-z_$][\w$]*)/);
    return m ? m[1] : '';
  }

  function isMgmt(el) {
    if (MGMT_FN.indexOf(fnName(el)) >= 0) return true;
    // 文字兜底: 只看 button / a, 且文字不要太长(避免误伤正文)
    var tag = el.tagName;
    if (tag !== 'BUTTON' && tag !== 'A') return false;
    var t = (el.textContent || '').trim();
    if (!t || t.length > 16) return false;
    for (var i = 0; i < MGMT_TEXT.length; i++) {
      if (t.indexOf(MGMT_TEXT[i]) >= 0) return true;
    }
    return false;
  }

  function hideMgmtButtons(root) {
    var list = (root || document).querySelectorAll('[onclick], button, a');
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (el.getAttribute('data-ro-hidden') === '1') continue;
      if (isMgmt(el)) {
        el.setAttribute('data-ro-hidden', '1');
        el.style.display = 'none';
      }
    }
  }

  function dropCards() {
    var cards = document.querySelectorAll('.card');
    for (var i = cards.length - 1; i >= 0; i--) {
      var c = cards[i];
      var h = c.querySelector('h2');
      var t = h ? h.textContent : '';
      for (var k = 0; k < DROP_CARDS.length; k++) {
        if (t.indexOf(DROP_CARDS[k]) >= 0) { c.remove(); break; }
      }
    }
  }

  function dropConfigView() {
    var nav = document.querySelector('nav a[data-view="config"]');
    if (nav && nav.parentNode) nav.parentNode.removeChild(nav);
    var v = document.getElementById('view-config');
    if (v && v.parentNode) v.parentNode.removeChild(v);
  }

  function guardRoute() {
    if (/^#\/config/.test(location.hash || '')) {
      location.hash = '#/dashboard';
    }
  }

  // 报告是 iframe 内嵌的独立 HTML, 它自己的"一键更新评分"按钮需要单独处理
  function patchIframes() {
    var frames = document.querySelectorAll('iframe');
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];
      try {
        var doc = f.contentDocument;
        if (!doc || !doc.documentElement) continue;
        if (doc.documentElement.getAttribute('data-ro') === '1') continue;
        doc.documentElement.setAttribute('data-ro', '1');

        var w = f.contentWindow;
        // 覆盖报告里的管理函数 + 让它内部的 fetch 也走只读拦截
        if (w) {
          w.refreshAllComments = function () { toast('只读分享模式：该操作不可用'); };
          w.refreshComments = w.refreshAllComments;
          w.fetch = window.fetch;
        }
        var kill = function () {
          var els = doc.querySelectorAll('[onclick]');
          for (var j = 0; j < els.length; j++) {
            var oc = els[j].getAttribute('onclick') || '';
            if (/refreshAllComments|refreshComments/.test(oc)) els[j].style.display = 'none';
          }
        };
        kill();
        if (doc.body) new MutationObserver(kill).observe(doc.body, { childList: true, subtree: true });
      } catch (e) { /* 跨域时忽略 */ }
    }
  }

  function applyDOM() {
    if (domDone) return;
    domDone = true;
    dropConfigView();
    dropCards();
    hideMgmtButtons(document);
    patchIframes();
    addBadge();
    guardRoute();
    window.addEventListener('hashchange', guardRoute);
    // iframe 切换日期会重新加载, 需要重新注入
    document.addEventListener('load', function (e) {
      if (e.target && e.target.tagName === 'IFRAME') patchIframes();
    }, true);

    // 动态渲染的表格(删除按钮等)也要处理
    var pending = false;
    var mo = new MutationObserver(function () {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () {
        pending = false;
        hideMgmtButtons(document);
        patchIframes();
      });
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // ---------- 界面提示 ----------
  var toastTimer = null;
  function toast(text) {
    var el = document.getElementById('roToast');
    if (!el) {
      if (!document.body) return;
      el = document.createElement('div');
      el.id = 'roToast';
      el.className = 'ro-toast';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }

  function addBadge() {
    var bar = document.querySelector('.topbar-right');
    if (!bar) return;
    var b = document.createElement('div');
    b.className = 'ro-badge';
    b.textContent = '👁 只读分享';
    b.title = '当前为只读分享访问，仅可浏览与导出';
    bar.insertBefore(b, bar.firstChild);
  }

  // ---------- 启动 ----------
  function run() {
    applySync();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { setTimeout(applyDOM, 0); });
    } else {
      setTimeout(applyDOM, 0);
    }
  }

  function boot() {
    if (window.__PUBLIC_READONLY__) { run(); return; }
    // 兜底: 后端未注入时异步探测一次
    fetch('/api/pub-mode', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.readonly) run(); })
      .catch(function () { /* 探测失败: 保持原样(后端仍有 403 兜底) */ });
  }

  boot();
})();
