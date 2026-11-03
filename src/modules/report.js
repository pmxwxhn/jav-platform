// HTML 报告生成模块
// 生成自包含 HTML(内联 CSS, 蓝色主题卡片布局, 纯 CSS 图表)
const fs = require('fs');
const path = require('path');

const BOARD_NAMES = { 103: '高清中文字幕', 36: '亚洲无码原创' };

// 生成单日单板块报告 HTML
function generateBoardReport(board, runDate, videos, config) {
  const boardName = BOARD_NAMES[board] || '板块' + board;
  const passed = videos.filter(v => v.pass === 1);
  const notPassed = videos.filter(v => v.pass === 0);
  const downloaded = passed.filter(v => v.offline_status === 'success');
  const downloading = passed.filter(v => v.offline_status === 'downloading');
  const pending = passed.filter(v => !v.offline_status || v.offline_status === 'pending' || v.offline_status === 'failed');

  // 统计卡片(仅抓取番号 + 筛选通过, 离线状态不展示)
  const statsCards = `
    <div class="stat-card"><span class="stat-ic">🎬</span><div class="stat-body"><div class="stat-num">${videos.length}</div><div class="stat-label">抓取番号</div></div></div>
    <div class="stat-card"><span class="stat-ic">🎯</span><div class="stat-body"><div class="stat-num">${passed.length}</div><div class="stat-label">筛选通过</div></div></div>
  `;

  // 评分条形图(通过影片) - 点击行跳转对应影片卡
  let chartHtml = '';
  if (passed.length) {
    chartHtml = `<div class="section"><h2>通过影片评分分布</h2><div class="chart">`;
    for (const v of passed) {
      const pct = Math.min(100, Math.round((v.score / 5) * 100));
      const cid = 'card-g-' + (v.id || v.code.replace(/\W/g, ''));
      chartHtml += `<div class="bar-row" onclick="(function(){var el=document.getElementById('${cid}');if(!el)return;var y=el.getBoundingClientRect().top+window.pageYOffset-24;window.scrollTo(0,y);el.style.boxShadow='0 0 0 3px rgba(24,95,165,.4)';setTimeout(function(){el.style.boxShadow=''},2000)})()" title="点击跳转到 ${esc(v.code)} 详情">
        <div class="bar-label">${v.code}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        <div class="bar-score">${v.score ? v.score.toFixed(2) : '-'}<small>/${v.votes || 0}人</small></div>
      </div>`;
    }
    chartHtml += `</div></div>`;
  }

  // 通过影片详情
  let passHtml = '';
  let useFancy = false;
  for (const v of passed) {
    let commentsHtml = '';
    // 解析评论(供卡片工具条展示计数)
    let comments = [];
    if (config.report.includeComments && v.comments_json) {
      try { comments = JSON.parse(v.comments_json); } catch { comments = []; }
      if (comments.length) {
        commentsHtml = `<details class="comments" open><summary>javdb 评论 (${comments.length} 条)</summary>`;
        for (const c of comments.slice(0, 30)) {
          commentsHtml += `<div class="comment"><div class="comment-meta">#${c.floor}楼 ${c.user} · ${c.time} · 点赞${c.likes}</div><div class="comment-body">${esc(c.content)}</div></div>`;
        }
        if (comments.length > 30) commentsHtml += `<div class="comment-more">…共 ${comments.length} 条</div>`;
        commentsHtml += `</details>`;
      } else if (v.javdb_href) {
        // 有 javdb 链接但评论为空 → 显示未抓到的原因
        commentsHtml = `<div class="comment-fail">⚠️ 评论未抓到: ${esc(v.comment_fail || 'javdb 详情页未加载出评分/评论(可点击上方「更新评分/评论」重试)')}</div>`;
      }
    } else if (v.javdb_href && !config.report.includeComments) {
      commentsHtml = `<div class="comment-fail">ℹ️ 报告未开启评论展示(config.report.includeComments=false)</div>`;
    } else if (v.javdb_href && v.comment_fail) {
      commentsHtml = `<div class="comment-fail">⚠️ 评论未抓到: ${esc(v.comment_fail)}</div>`;
    }
    // 关联影片(默认折叠, 点击展开; 紧凑小区域; 显示封面/标题/评分/评论, 无预告片)
    // 过滤规则既定(评分>4且人数>300): 无符合规则的影片时显示"无关联影片", 不放宽条件
    let relatedHtml = '';
    if (v.javdb_href) {
      let rels = [];
      try { rels = v.related_json ? JSON.parse(v.related_json) : []; } catch { rels = []; }
      if (rels.length) {
        const relItems = rels.map(r => `<div class="related-item">
          ${r.cover ? `<a href="${esc(r.href)}" target="_blank"><img class="rel-cover" src="${esc(r.cover)}" loading="lazy" onerror="this.style.display='none'"></a>` : ''}
          <div class="rel-info">
            <div class="rel-line"><a class="rel-code" href="${esc(r.href)}" target="_blank">${esc(r.code)}</a><button class="btn-mini rel-copy" title="复制番号" onclick="copyText('${esc(String(r.code).replace(/'/g, "\\'"))}', this)">📋</button><span class="rel-meta">${r.score}分/${r.votes}人</span></div>
            ${r.href ? `<div class="rel-actions"><a class="btn-link" href="${esc(r.href)}" target="_blank">javdb 详情 ↗</a></div>` : ''}
            ${r.title ? `<div class="rel-title">${esc(r.title)}</div>` : ''}
            ${r.actors && r.actors.length ? `<div class="rel-actors">演员: ${esc(r.actors.join('、'))}</div>` : ''}
            ${(r.comments || []).length ? `<details class="comments rel-comments"><summary>评论 (${r.comments.length} 条)</summary>
              ${r.comments.slice(0, 20).map(c => `<div class="comment"><div class="comment-meta">#${c.floor}楼 ${esc(c.user)} · ${esc(c.time)} · 点赞${c.likes}</div><div class="comment-body">${esc(c.content)}</div></div>`).join('')}
              ${r.comments.length > 20 ? `<div class="comment-more">…共 ${r.comments.length} 条</div>` : ''}
            </details>` : ''}
          </div>
        </div>`).join('');
        relatedHtml = `<div class="related">
          <button type="button" class="related-toggle" onclick="toggleRelated(this)"><span>🎬 关联影片 (${rels.length})</span><span class="rel-arrow">▾</span></button>
          <div class="related-body" hidden>${relItems}</div>
        </div>`;
      } else {
        // 无符合规则(评分>4且人数>300)的关联影片 → 明确提示, 不放宽条件
        relatedHtml = `<div class="related"><div class="related-empty">🎬 无关联影片(规则: 评分&gt;4 且 人数&gt;300)</div></div>`;
      }
    }
    const dupBadge = v.dup_exists ? '<span class="badge ok">115已存</span>' : '<span class="badge warn">115未存</span>';
    const offBadge = {
      success: '<span class="badge ok">✅ 离线成功</span>',
      downloading: '<span class="badge warn">⏳ 离线中</span>',
      pending: '<span class="badge gray">待处理</span>',
      failed: '<span class="badge red">❌ 失败</span>',
      skipped: '<span class="badge gray">跳过</span>',
    }[v.offline_status] || '<span class="badge gray">待处理</span>';

    // 解析 JSON 工具
    let samples = [], info = {};
    try { samples = v.samples_json ? JSON.parse(v.samples_json) : []; } catch {}
    try { info = v.info_json ? JSON.parse(v.info_json) : {}; } catch {}
    const hasDetail = !!v.javdb_href && (samples.length > 0 || Object.keys(info).length > 0);

    // 信息区字段(新版式)
    const infoRows = (info, v) => {
      const rows = [];
      const add = (label, val) => { if (val) rows.push(`<div class="info-row"><span class="ik">${label}</span><span class="iv">${val}</span></div>`); };
      add('番號', esc(info.number || v.code));
      add('日期', esc(info.date));
      add('時長', esc(info.duration));
      add('片商', esc(info.studio));
      add('系列', esc(info.series));
      add('評分', esc(info.rating || (v.score ? v.score.toFixed(2) + '分' : '')));
      add('類別', esc(info.categories));
      add('演員', esc(info.actors || v.actress));
      return rows.join('');
    };

        let cardHtml;
    if (hasDetail) {
      useFancy = true;
      // ===== javdb 版式: 海报 2/3 + 信息 1/3 + 缩略图行(预告片+全部) + fancybox 查看器 =====
      const gid = 'g-' + (v.id || v.code.replace(/\W/g, ''));
      const imgs = [];
      if (v.cover_url) imgs.push(v.cover_url);
      for (const s of samples) if (!imgs.includes(s)) imgs.push(s);
      // 大图版本: _s_ → _l_(fancybox 打开用清晰大图)
      const bigOf = (u) => u.replace(/_s_(\d+)\.jpg/, '_l_$1.jpg');
      const tileItems = imgs.map((s, i) => `<a class="tile-item" href="${esc(bigOf(s))}" data-fancybox="${gid}" data-caption="${esc(v.code)} · ${i === 0 ? '封面' : '图 ' + i}">
          <img src="${esc(s)}" loading="lazy" onerror="this.style.display='none'">
        </a>`).join('');
      const previewTile = v.preview_url ? `
        <a class="tile-item preview-video-container" href="#pv-${gid}" data-fancybox="${gid}">
          <span class="pv-tag">▶ 預告片</span>
          <img src="${esc(v.cover_url || imgs[0] || '')}" onerror="this.style.display='none'">
        </a>
        <video id="pv-${gid}" class="preview-video" src="${esc(v.preview_url)}" playsinline controls muted preload="none"></video>` : '';
      cardHtml = `<div class="card detail-card" id="card-${gid}">
        <div class="detail-head">
          <h3>${esc(info.number || v.code)} ${dupBadge} ${offBadge}
            <button class="btn-mini copy-btn" title="复制番号" onclick="copyText('${esc(String(info.number || v.code).replace(/'/g, "\\'"))}', this)">📋 复制番号</button>
          </h3>
          ${info.title || v.javdb_title || v.title ? `<div class="orig-title" style="font-family:'SimHei','黑体','Yu Gothic','Meiryo','MS Gothic',sans-serif!important">${esc(info.title || v.javdb_title || v.title)}</div>` : ''}
          ${info.titleCn ? `<div class="cn-title" style="font-family:'SimHei','黑体',sans-serif!important">${esc(info.titleCn)}</div>` : ''}
        </div>
        <div class="detail-flex">
          <div class="poster-col">
            ${v.cover_url ? `<a href="${esc(v.cover_url)}" data-fancybox="${gid}" data-caption="${esc(v.code)} 封面"><img src="${esc(v.cover_url)}" alt="${esc(v.code)} 海报" loading="lazy" onerror="this.style.display='none'"></a>` : ''}
          </div>
          <div class="info-col">
            <div class="info-grid">${infoRows(info, v)}</div>
            <div class="detail-links">
              ${v.javdb_href ? `<a href="${esc(v.javdb_href)}" target="_blank" class="btn-link">javdb 详情 ↗</a>` : ''}
              ${v.magnet ? `<span class="magnet-link" title="${esc(v.magnet)}">磁力已提取</span>` : ''}
            </div>
          </div>
        </div>
        ${imgs.length > 1 || previewTile ? `<div class="tile-row">${previewTile}${tileItems}</div>` : ''}
        ${v.offline_detail ? `<div class="info-line" style="margin-top:10px"><span class="k">处理</span> ${esc(v.offline_detail)}</div>` : ''}
        ${v.dir_name ? `<div class="info-line"><span class="k">115目录</span> ${esc(v.dir_name)}${v.dir_note ? ' <small>' + esc(v.dir_note) + '</small>' : ''}</div>` : ''}
        ${v.magnet ? `<div class="magnet-copy"><span class="k">磁力</span><code class="magnet-code">${esc(v.magnet)}</code><button class="btn-mini" onclick="copyText(this.previousElementSibling.textContent, this)">📋 复制</button></div>` : ''}
        ${relatedHtml}
        ${v.javdb_href ? `<div class="comment-tools"><button class="btn-mini" onclick="refreshOneComment(${v.id}, this)">🔄 更新评分/评论</button><span class="comment-count">${comments.length} 条</span></div>` : ''}
        ${commentsHtml}
      </div>`;
    } else {
      // ===== 旧卡片(无 javdb 详情) =====
      cardHtml = `<div class="card">
        ${v.cover_url ? `<div class="poster"><img src="${esc(v.cover_url)}" alt="${esc(v.code)} 海报" loading="lazy" onerror="this.style.display='none'"></div>` : ''}
        <div class="card-head">
          <h3>${esc(v.code)} ${dupBadge} ${offBadge}</h3>
          <div class="score">${v.score ? v.score.toFixed(2) : '-'} 分 / ${v.votes || 0} 人</div>
        </div>
        <div class="card-body">
          <div class="info-line"><span class="k">帖子</span> ${esc(v.title || '')}</div>
          ${v.actress ? `<div class="info-line"><span class="k">演员</span> ${esc(v.actress)}</div>` : ''}
          ${v.dir_name ? `<div class="info-line"><span class="k">115目录</span> ${esc(v.dir_name)}${v.dir_note ? ' <small>' + esc(v.dir_note) + '</small>' : ''}</div>` : ''}
          ${v.magnet ? `<div class="magnet-copy"><span class="k">磁力</span><code class="magnet-code">${esc(v.magnet)}</code><button class="btn-mini" onclick="copyText(this.previousElementSibling.textContent, this)">📋 复制</button></div>` : ''}
          ${v.javdb_href ? `<div class="info-line"><span class="k">javdb</span> <a href="${esc(v.javdb_href)}" target="_blank">${esc(v.javdb_title || v.javdb_href)}</a></div>` : ''}
          ${v.offline_detail ? `<div class="info-line"><span class="k">处理</span> ${esc(v.offline_detail)}</div>` : ''}
          ${relatedHtml}
          ${commentsHtml}
        </div>
      </div>`;
    }
    passHtml += cardHtml;
  }

  // 未通过
  let notPassHtml = '<table class="tbl"><thead><tr><th>番号</th><th>评分</th><th>人数</th><th>原因</th><th>磁力</th></tr></thead><tbody>';
  for (const v of notPassed) {
    const reason = !v.javdb_href ? 'javdb未精确匹配' : `评分${v.score || '-'}/${v.votes || 0}人不满足门槛`;
    const magnetCell = v.magnet
      ? `<button class="btn-mini" style="font-size:11px" onclick="copyText('${esc(String(v.magnet).replace(/'/g, "\\'"))}', this)">📋 复制磁力</button>`
      : '<span style="color:#c0c8d0">-</span>';
    notPassHtml += `<tr><td>${esc(v.code)}</td><td>${v.score || '-'}</td><td>${v.votes || '-'}</td><td>${reason}</td><td>${magnetCell}</td></tr>`;
  }
  notPassHtml += '</tbody></table>';

  const css = generateCSS();
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${boardName} ${runDate} 资源报告</title>
${useFancy ? '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/fancybox/3.5.7/jquery.fancybox.min.css">' : ''}
<style>${css}</style>
</head>
<body>
<div class="container">
  <header class="page-head">
    <h1>${boardName} · 资源报告</h1>
    <div class="date">${runDate} · 生成于 ${new Date().toLocaleString('zh-CN')}</div>
  </header>
  <div class="report-actions">
    <button class="btn-action" onclick="refreshAllComments(${board}, '${runDate}')">🔄 一键更新 javdb 评分/评论(全报告)</button>
    <span class="action-hint">评论区数据可能更新, 可重新抓取</span>
  </div>
  <div class="stats">${statsCards}</div>
  ${chartHtml}
  <div class="section"><h2>通过筛选影片 (${passed.length})</h2>${passHtml || '<p class="empty">今日无通过影片</p>'}</div>
  <div class="section"><h2>未通过筛选 (${notPassed.length})</h2>${notPassHtml}</div>
  <footer class="page-foot">本报告由 115影视资源自动管理平台 自动生成 · 供人工复盘与判断</footer>
</div>
${useFancy ? `
<script src="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/fancybox/3.5.7/jquery.fancybox.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.13/hls.min.js"></script>
<script>
// 折叠/展开关联影片(点击入口)
function toggleRelated(btn) {
  const body = btn.nextElementSibling;
  const arrow = btn.querySelector('.rel-arrow');
  if (!body) return;
  if (body.hasAttribute('hidden')) {
    body.removeAttribute('hidden');
    arrow.textContent = '▴';
    btn.classList.add('open');
  } else {
    body.setAttribute('hidden', '');
    arrow.textContent = '▾';
    btn.classList.remove('open');
  }
}

// 复制文本到剪贴板(带按钮反馈)
function copyText(text, btn) {
  const done = () => {
    if (!btn) return;
    const old = btn.textContent;
    btn.textContent = '✓ 已复制';
    setTimeout(() => { btn.textContent = old; }, 1500);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch {}
  ta.remove();
  done();
}

// fancybox 初始化(与 javdb 原站一致的图片切换器)
$(function(){
  $('[data-fancybox]').fancybox({
    loop: true,
    buttons: ['zoom', 'slideShow', 'fullScreen', 'thumbs', 'close'],
    // 点击图片区域任意位置直接退出大图浏览
    clickContent: 'close',
    clickSlide: 'close',
    caption: function(instance, item) { return item.opts.$orig.data('caption') || ''; },
    afterShow: function(instance, slide) {
      // 预告片: 视频元素 → hls.js 播放 m3u8
      var el = slide.type === 'inline' ? slide.src : null;
      if (el && el.tagName === 'VIDEO') {
        var src = el.getAttribute('src');
        if (src && src.indexOf('.m3u8') > -1) {
          if (Hls.isSupported()) {
            var hls = new Hls();
            hls.loadSource(src);
            hls.attachMedia(el);
            hls.on(Hls.Events.ERROR, function(evt, data) { if (data.fatal) { el.insertAdjacentHTML('afterend', '<div style="color:#f66;padding:10px">預告片已過期或不可用</div>'); } });
            el.play().catch(function(){});
          } else if (el.canPlayType('application/vnd.apple.mpegurl')) {
            el.play().catch(function(){});
          }
        } else {
          el.play().catch(function(){});
        }
      }
    }
  });
});

// 刷新单部影片评论
async function refreshOneComment(videoId, btn) {
  if (!confirm('重新抓取该影片的 javdb 评分/评分人数/评论(约 20-30 秒)?\\n抓取完成后请刷新当前页面查看最新数据。')) return;
  btn.disabled = true; btn.textContent = '⏳ 刷新中...';
  try {
    const r = await fetch('/api/refresh-comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ videoId: videoId }) });
    const d = await r.json();
    if (d.ok) { alert('✅ ' + d.message + '\\n\\n完成后请按 F5 刷新本页面'); btn.textContent = '✓ 已启动后台'; }
    else { alert('❌ 失败: ' + (d.error || '未知错误')); btn.disabled = false; btn.textContent = '🔄 更新评分/评论'; }
  } catch (e) { alert('❌ 网络错误: ' + e.message); btn.disabled = false; btn.textContent = '🔄 更新评分/评论'; }
}

// 刷新整个报告的所有评论
async function refreshAllComments(board, date) {
  if (!confirm('重新抓取该报告全部影片的 javdb 评分/评分人数/评论(共约 ' + document.querySelectorAll('.detail-card').length + ' 部影片, 需几分钟)?\\n完成后请刷新当前页面查看最新数据。')) return;
  const btn = event.target; btn.disabled = true; btn.textContent = '⏳ 刷新中...';
  try {
    const r = await fetch('/api/refresh-comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ board: board, date: date }) });
    const d = await r.json();
    if (d.ok) { alert('✅ ' + d.message + '\\n\\n完成后请按 F5 刷新本页面'); btn.textContent = '✓ 已启动后台'; }
    else { alert('❌ 失败: ' + (d.error || '未知错误')); btn.disabled = false; btn.textContent = '🔄 一键更新 javdb 评分/评论(全报告)'; }
  } catch (e) { alert('❌ 网络错误: ' + e.message); btn.disabled = false; btn.textContent = '🔄 一键更新 javdb 评分/评论(全报告)'; }
}
</script>` : ''}
</body>
</html>`;
  return html;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function generateCSS() {
  return `
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Microsoft YaHei',system-ui,sans-serif;background:#f0f4f8;color:#1a2733;line-height:1.6}
.container{max-width:none;margin:0 auto;padding:24px 28px}
.page-head{border-bottom:3px solid #185FA5;padding-bottom:12px;margin-bottom:20px}
.page-head h1{font-size:24px;color:#0C447C}
.date{color:#5F6b7a;font-size:13px;margin-top:4px}
.stats{display:flex;gap:12px;margin-bottom:18px}
.stat-card{flex:1;display:flex;align-items:center;gap:12px;background:#fff;border:1px solid #dce6f0;border-radius:14px;padding:12px 18px;box-shadow:0 1px 3px rgba(24,95,165,.06);transition:box-shadow .2s}
.stat-card:hover{box-shadow:0 4px 12px rgba(24,95,165,.12)}
.stat-ic{font-size:26px;opacity:.9}
.stat-num{font-size:26px;font-weight:700;color:#185FA5;line-height:1}
.stat-label{font-size:12px;color:#5F6b7a;margin-top:3px}
.stat-card.blue .stat-num{color:#0F6E56}
.stat-card.amber .stat-num{color:#BA7517}
.stat-card.red .stat-num{color:#A32D2D}
.section{margin-bottom:28px}
.section h2{font-size:18px;color:#0C447C;margin-bottom:14px;padding-left:10px;border-left:4px solid #185FA5}
.chart{background:#fff;border:1px solid #dce6f0;border-radius:12px;padding:16px;margin-bottom:20px}
.bar-row{display:flex;align-items:center;gap:10px;margin-bottom:8px;cursor:pointer;border-radius:6px;padding:2px 6px;transition:background .2s}
.bar-row:hover{background:#f0f7ff}
.bar-label{width:130px;font-size:12px;color:#3a4a5a;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar-track{flex:1;height:18px;background:#eef3f8;border-radius:4px;overflow:hidden}
.bar-fill{height:100%;background:linear-gradient(90deg,#85B7EB,#185FA5);border-radius:4px}
.bar-score{width:90px;font-size:12px;color:#0C447C;font-weight:600}
.bar-score small{color:#7a8a9a;font-weight:400}
.card{background:#fff;border:1px solid #dce6f0;border-radius:12px;margin-bottom:14px;overflow:hidden;box-shadow:0 1px 3px rgba(24,95,165,.06)}
.card-head{display:flex;justify-content:space-between;align-items:center;background:#f7fafc;padding:10px 16px;border-bottom:1px solid #e6edf4}
.card-head h3{font-size:15px;color:#0C447C}
.score{font-size:13px;color:#185FA5;font-weight:600}
.card-body{padding:12px 16px}
.info-line{font-size:13px;margin-bottom:6px;color:#3a4a5a}
.poster{text-align:center;margin-bottom:14px}
.poster img{max-width:240px;max-height:340px;border-radius:10px;box-shadow:0 4px 14px rgba(0,0,0,.18);object-fit:cover}
.info-line .k{display:inline-block;min-width:56px;color:#7a8a9a;font-weight:500}
.info-line.magnet code{background:#f4f7fb;padding:2px 6px;border-radius:4px;font-size:12px;color:#0C447C;word-break:break-all}
/* javdb 版式卡片: 标题区(海报上方) + 海报 2/3 + 信息 1/3 + 缩略图行 */
.detail-card{padding:16px}
.detail-head{margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid #e6edf4}
.detail-head h3{font-size:17px;color:#0C447C;margin-bottom:6px}
.orig-title{font-size:18px;font-weight:700;font-family:'SimHei','黑体','Yu Gothic','Meiryo','MS Gothic',sans-serif!important;color:#1a2733;line-height:1.5;margin-bottom:4px}
.cn-title{font-size:16px;font-weight:700;font-family:'SimHei','黑体',sans-serif!important;color:#1a2733;line-height:1.5;display:inline-block;background:#ffffff;padding:2px 8px;border-radius:4px;border:1px solid #e8edf3}
.detail-flex{display:grid;grid-template-columns:2fr 1fr;gap:24px;align-items:start}
.poster-col img{width:100%;max-width:760px;border-radius:12px;box-shadow:0 6px 20px rgba(0,0,0,.2);display:block;cursor:zoom-in;transition:transform .2s}
.poster-col img:hover{transform:scale(1.01)}
.info-col{min-width:0}
.info-col h3{font-size:16px;color:#0C447C;margin-bottom:8px}
.report-actions{display:flex;align-items:center;gap:14px;margin-bottom:14px;padding:10px 16px;background:#f0f7ff;border:1px solid #d6e6f5;border-radius:10px}
.btn-action{background:linear-gradient(135deg,#185FA5,#2E86D1);color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
.btn-action:hover{opacity:.9}
.btn-action:disabled{opacity:.5;cursor:not-allowed}
.action-hint{color:#7a8a9a;font-size:12px}
.comment-tools{display:flex;align-items:center;gap:10px;margin-top:12px;padding:8px 0;border-top:1px dashed #e6edf4}
.btn-mini{background:#fff;border:1px solid #185FA5;color:#185FA5;border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;font-family:inherit}
.btn-mini:hover{background:#f0f7ff}
.btn-mini:disabled{opacity:.5;cursor:not-allowed}
.comment-count{color:#7a8a9a;font-size:12px}
.comment-fail{background:#FFF7E6;border:1px solid #F5DCC0;border-radius:8px;padding:8px 12px;font-size:12px;color:#A3541E;margin-top:8px;line-height:1.6}
/* 关联影片(折叠/展开, 紧凑小区域) */
.related{margin-top:12px;border-top:1px dashed #e6edf4;padding-top:10px}
.related-toggle{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;padding:9px 14px;background:#f4f9ff;border:1px solid #d6e6f5;border-radius:10px;font-size:13px;font-weight:600;color:#185FA5;cursor:pointer;font-family:inherit;transition:background .15s}
.related-toggle:hover{background:#eaf4ff}
.related-toggle.open{border-color:#85B7EB}
.rel-arrow{font-size:12px;color:#185FA5;transition:transform .15s}
.related-body{margin-top:10px;display:grid;gap:10px}
.related-item{display:flex;gap:14px;padding:12px;background:#fafcfe;border:1px solid #eef2f6;border-radius:12px;align-items:flex-start}
.rel-cover{width:132px;height:auto;border-radius:8px;object-fit:cover;display:block;flex-shrink:0;box-shadow:0 2px 8px rgba(0,0,0,.10)}
.rel-info{flex:1;min-width:0}
.rel-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rel-code{font-weight:600;color:#185FA5;font-size:14px;text-decoration:none}
.rel-copy{margin-left:2px}
.rel-meta{color:#7a8a9a;font-size:12px}
.rel-actions{margin-top:6px}
.rel-actions .btn-link{font-size:12px;padding:5px 10px;display:inline-block;color:#fff;background:linear-gradient(135deg,#185FA5,#2E86D1);text-decoration:none;border-radius:8px}
.rel-title{font-size:12px;color:#5a6b7d;line-height:1.4;margin-top:3px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.rel-actors{font-size:12px;color:#7a8a9a;margin-top:2px}
.rel-comments{margin-top:6px}
.rel-comments summary{font-size:12px;color:#185FA5;cursor:pointer}
.related-empty{padding:8px 14px;font-size:12px;color:#9aa7b5;background:#f7f9fb;border:1px dashed #dfe6ee;border-radius:10px}
.copy-btn{margin-left:8px;vertical-align:middle}
.magnet-copy{display:flex;align-items:center;gap:8px;margin-top:8px;padding:8px 10px;background:#fff8ec;border:1px solid #f0d9a8;border-radius:8px;flex-wrap:wrap}
.magnet-copy .k{flex-shrink:0;font-size:12px;color:#8a6d1a}
.magnet-code{flex:1;min-width:0;font-size:12px;color:#7a5b00;word-break:break-all;overflow-wrap:anywhere}
.detail-title{font-size:13px;color:#5a6b7d;margin-bottom:12px;line-height:1.6;padding:8px 10px;background:#f7fafc;border-radius:8px;border-left:3px solid #85B7EB}.info-grid{display:grid;grid-template-columns:1fr;gap:6px;margin-bottom:12px}
.info-row{font-size:13px;color:#3a4a5a}
.info-row .ik{display:inline-block;min-width:40px;color:#7a8a9a;font-weight:500}
.info-row .iv{color:#1a2733}
.detail-links{margin-bottom:6px}
.btn-link{display:inline-block;font-size:13px;color:#fff;background:linear-gradient(135deg,#185FA5,#2E86D1);padding:6px 14px;border-radius:8px;text-decoration:none;margin-right:8px}
.btn-link:hover{opacity:.9}
.magnet-link{font-size:12px;color:#0F6E56}
/* 缩略图行(预告片 + 全部缩略图) */
.tile-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px;padding-top:14px;border-top:1px solid #e6edf4}
.tile-item{position:relative;flex:0 0 auto;width:200px;border-radius:8px;overflow:hidden;border:1px solid #e6edf4;transition:transform .2s,box-shadow .2s}
.tile-item:hover{transform:translateY(-2px);box-shadow:0 6px 16px rgba(0,0,0,.15)}
.tile-item img{width:100%;height:128px;object-fit:cover;display:block;background:#f0f3f7}
.tile-item.preview-video-container{background:linear-gradient(135deg,#0C447C,#2E86D1)}
.tile-item.preview-video-container img{opacity:.55}
.pv-tag{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:2;color:#fff;font-size:13px;font-weight:600;text-shadow:0 1px 4px rgba(0,0,0,.6);pointer-events:none}
.preview-video{display:none}
@media(max-width:900px){.detail-flex{grid-template-columns:1fr}.tile-item{width:160px}}
.badge{display:inline-block;font-size:12px;padding:2px 8px;border-radius:10px;margin-left:6px;vertical-align:middle}
.badge.ok{background:#EAF3DE;color:#27500A}
.badge.warn{background:#FAEEDA;color:#633806}
.badge.red{background:#FCEBEB;color:#791F1F}
.badge.gray{background:#F1EFE8;color:#444441}
.related{font-size:13px;margin-top:8px;padding:8px 10px;background:#f0f7ff;border-radius:8px}
.related-item{margin-bottom:6px}
.related a{color:#185FA5;text-decoration:none}
.comments{margin-top:10px;font-size:13px}
.comments summary{cursor:pointer;color:#185FA5;font-weight:500;margin-bottom:6px}
.comment{background:#f8fafc;border-left:3px solid #85B7EB;padding:8px 10px;margin-bottom:8px;border-radius:0 8px 8px 0}
.comment-meta{font-size:12px;color:#7a8a9a;margin-bottom:4px}
.comment-body{color:#3a4a5a;white-space:pre-wrap}
.comment-more{color:#7a8a9a;font-size:12px;text-align:center;margin:8px 0}
.tbl{width:100%;border-collapse:collapse;background:#fff;border:1px solid #dce6f0;border-radius:12px;overflow:hidden;font-size:13px}
.tbl th{background:#f2f6fb;color:#0C447C;padding:8px 12px;text-align:left;font-weight:500}
.tbl td{padding:8px 12px;border-top:1px solid #eef3f8}
.empty{color:#7a8a9a;padding:16px;text-align:center}
.page-foot{margin-top:30px;padding-top:12px;border-top:1px solid #dce6f0;color:#7a8a9a;font-size:12px;text-align:center}
a{color:#185FA5}
@media(max-width:700px){.bar-label{width:80px}}
`;
}

// 保存报告
function saveReport(board, runDate, html) {
  const outDir = path.join(__dirname, '..', 'reports', runDate);
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${board}-${runDate}.html`);
  fs.writeFileSync(file, html, 'utf8');
  return file;
}

// 报告索引页(列出所有历史报告)
function generateIndex(reports) {
  const cards = reports.map(r => {
    const badge = BOARD_NAMES[r.board] || '';
    return `<div class="card">
      <div class="card-body">
        <div><b>${r.date}</b> · ${badge}</div>
        <div class="date">${r.status}</div>
        <a class="btn" href="${r.relPath}" target="_blank">查看报告</a>
      </div>
    </div>`;
  }).join('');
  const css = generateCSS();
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>历史报告索引</title>
  <style>${css} .btn{display:inline-block;margin-top:8px;padding:6px 14px;background:#185FA5;color:#fff;border-radius:8px;text-decoration:none;font-size:13px}</style></head>
  <body><div class="container">
  <header class="page-head"><h1>历史报告索引</h1><div class="date">共 ${reports.length} 份报告</div></header>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px">${cards}</div>
  </div></body></html>`;
}

module.exports = { generateBoardReport, saveReport, generateIndex, BOARD_NAMES };
