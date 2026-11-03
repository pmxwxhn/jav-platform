// javdb 模块: 搜索评分/目标影片/关联影片 + 详情页(演员/全部评论)
const { sleep, evalJS, newTab, closeTab } = require('./cdp');

// 解析 javdb 评分字符串 "4.5 分 / 123 人"
function parseScore(scoreStr) {
  const m = scoreStr.match(/(\d+\.?\d*)\s*分?\s*[,,，]?\s*由?\s*(\d+)\s*人/);
  const m2 = scoreStr.match(/(\d+\.?\d*)\s*,\s*by\s*(\d+)\s*users/i);
  return m ? { score: parseFloat(m[1]), votes: parseInt(m[2]) } : (m2 ? { score: parseFloat(m2[1]), votes: parseInt(m2[2]) } : null);
}

// javdb 站点故障期间(2026-11-02 起)统一闸门: 任何调用直接抛错, 连标签页都不开
function assertJavdbUsable() {
  try {
    const d = require('../db');
    if (d && typeof d.isJavdbPaused === 'function' && d.isJavdbPaused()) {
      throw new Error('JAVDB_PAUSED: javdb 已暂停(站点故障), 恢复后再补评分');
    }
  } catch (e) {
    if (/JAVDB_PAUSED/.test(e.message)) throw e;
    // 读配置失败不影响正常流程
  }
}

// javdb 搜索: 返回 { targetInfo, related }
async function queryJavdb(code) {
  assertJavdbUsable();
  const searchKey = /^FC2PPV[-]?(\d+)$/i.test(code) ? code.match(/^FC2PPV[-]?(\d+)$/i)[1] : code;
  const tab = await newTab('https://javdb.com/search?q=' + encodeURIComponent(searchKey) + '&f=all');
  await sleep(5000);
  try {
    // 18岁确认
    try {
      const needConfirm = await evalJS(tab, 'document.body.innerText.includes("我已滿18歲")', 0);
      if (needConfirm) {
        await evalJS(tab, `(() => { const b=[...document.querySelectorAll('a,button')].find(x=>/滿18歲/.test(x.textContent)); if(b){b.click();return true} return false })()`, 0);
        await sleep(3000);
      }
    } catch {}
    // 搜索结果
    const result = await evalJS(tab, `(() => {
      const items = [...document.querySelectorAll('.movie-list .item, .grid .item, .item')].map(el => {
        const codeEl = el.querySelector('.uid, .title a, h5 a, .video-title, .video-title a');
        const scoreEl = el.querySelector('.score, .rating, .rate');
        const link = el.querySelector('a');
        const img = el.querySelector('img');
        return { code: codeEl ? codeEl.textContent.trim() : '', score: scoreEl ? scoreEl.textContent.trim() : '', href: link ? link.href : '', cover: img ? img.src : '' };
      }).filter(x => x.code);
      return JSON.stringify(items.slice(0, 8));
    })()`);
    const items = JSON.parse(result);
    const target = items[0];
    let targetInfo = { code, found: false, score: null, votes: null, title: null, href: null, matched: false };
    if (target) {
      const p = parseScore(target.score);
      targetInfo = {
        code, found: true,
        score: p ? p.score : null,
        votes: p ? p.votes : null,
        title: target.code.slice(0, 60),
        href: target.href,
        matched: target.code.split(/[\s（(【]/)[0].toUpperCase().includes(code.split('-').pop()) || target.code.toUpperCase().includes(searchKey.toUpperCase()),
      };
    }
    // 关联影片(搜索结果 2-8, 严格过滤: 评分>4 且 人数>300, 规则既定不得放宽)
    const related = [];
    for (const item of items.slice(1, 8)) {
      const p = parseScore(item.score);
      if (p && p.score > 4 && p.votes > 300) {
        related.push({ code: item.code.split(/[\s（(【]/)[0], score: p.score, votes: p.votes, title: item.code.slice(0, 50), href: item.href, cover: item.cover || '' });
      }
    }
    return { targetInfo, related };
  } finally {
    await closeTab(tab);
  }
}

// 解析详情页评论(#N楼格式)
function parseComments(full) {
  const comments = [];
  const re = /#(\d+)楼\n([^\n]*)\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+点赞:(\d+)\n\n([\s\S]*?)(?=\n#\d+楼|你可能也喜歡|$)/g;
  let m;
  while ((m = re.exec(full)) !== null) {
    comments.push({ floor: parseInt(m[1]), user: m[2].trim(), time: m[3], likes: parseInt(m[4]), content: m[5].trim().slice(0, 500) });
  }
  return comments;
}

// 从带 ♀/♂ 符号的演员原文解析: 优先只保留 ♀ 女优(用户规则); 无 ♀ 则排除 ♂ 男优; 再无符号则保留全部
// 例: "畑中哲也♂ 桜みお♀" → ["桜みお"]; "桜空もも♀ 小田切ジュン♂ 野島誠♂" → ["桜空もも"]
function parseActorsByGender(raw) {
  // 分隔符有两种形态：带 ♀/♂ 时以空格分隔（"畑中哲也♂ 桜みお♀"），
  // 无性别符号的详情页字段以「逗号+空格」分隔（"安達夕莉, 鮫島, 大沢真司"）。
  // 只按空白切分会把逗号留在名字尾部（"安達夕莉,"），导致按姓名索引的演员映射库
  // 永远查不到中文名。逗号/顿号一并作为分隔符。
  const parts = String(raw || '').split(/[\s,，、]+/).map(s => s.trim()).filter(Boolean);
  if (!parts.length) return [];
  const females = parts.filter(p => p.includes('♀'));
  if (females.length) return females.map(p => p.replace(/[♀♂]/g, '').trim()).filter(Boolean);
  const noMale = parts.filter(p => !p.includes('♂'));
  if (noMale.length) return noMale.map(p => p.replace(/[♀♂]/g, '').trim()).filter(Boolean);
  return parts.map(p => p.replace(/[♀♂]/g, '').trim()).filter(Boolean);
}

// javdb 详情页: 标题 + 信息字段 + 缩略图 + 演员 + 全部评论 + 封面 + 预告片(下载本地)
async function fetchDetail(href, code) {
  assertJavdbUsable();
  const tab = await newTab(href);
  await sleep(5000);
  try {
    // 18岁确认
    try {
      const need = await evalJS(tab, 'document.body.innerText.includes("我已滿18歲") || document.body.innerText.includes("满18岁")', 0);
      if (need === 'true' || need === true) {
        await evalJS(tab, `(() => { const l=[...document.querySelectorAll('a,button')].find(a=>/满18岁|滿18歲/.test(a.textContent)); if(l){l.click();return true} return false })()`, 0);
        await sleep(3000);
      }
    } catch {}
    // 等标题
    for (let i = 0; i < 6; i++) {
      await sleep(2000);
      const t = await evalJS(tab, 'document.querySelector("h1, .video-title") ? "ready" : "loading"', 0);
      if (t === 'ready') break;
    }
    // 滚动触发缩略图懒加载
    try {
      await evalJS(tab, 'window.scrollTo(0, document.body.scrollHeight * 0.6)', 0);
      await sleep(2500);
      const n = await evalJS(tab, '[...document.querySelectorAll("img[src*=samples], img[data-src*=samples]")].length', 0);
      if (!n || n < 5) { await evalJS(tab, 'window.scrollTo(0, document.body.scrollHeight)', 0); await sleep(2500); }
    } catch {}
    const res = await evalJS(tab, `(() => {
      var full = document.body ? document.body.innerText : '';
      // 截断 "TA(們)還出演過" 区域(简繁): 该区是"相关清单"懒加载内容,不属于评论,避免污染
      var cut = full.search(/TA.{0,8}出.{1,3}[過过]/);
      if (cut > 0) full = full.slice(0, cut);
      var actors = [...new Set([...document.querySelectorAll('a[href*="/actors/"]')].map(a => a.textContent.trim()))].filter(t => t && t.length < 20 && !/有碼|無碼|歐美|推薦/.test(t)).slice(0, 6);
      // 封面图(javdb CDN, 可直接外链)
      var coverEl = document.querySelector('.cover img, .video-cover img, .movie-cover img, .column img');
      var cover = coverEl ? coverEl.src : (document.querySelector('meta[property="og:image"]') ? document.querySelector('meta[property="og:image"]').content : '');
      // 标题: 番号 + 原标题(current-title) + 中文翻译(translated-title)
      var tEl = document.querySelector('h2.title, .video-detail .title, h1');
      var origTitle = '', cnTitle = '';
      if (tEl) {
        var ct = tEl.querySelector('.current-title');
        var tt = tEl.querySelector('.translated-title');
        if (ct) origTitle = ct.textContent.trim();
        if (tt) cnTitle = tt.textContent.trim();
      }
      var title = origTitle || (tEl ? tEl.textContent.replace(/\s+/g, ' ').trim().slice(0, 100) : '');
      // 缩略图(samples, 兼容懒加载 data-src)
      var samples = [...new Set([...document.querySelectorAll('img[src*="samples"], img[data-src*="samples"]')]
        .map(i => (i.getAttribute('data-src') || i.src || '').replace(/^\\/\\//, 'https://'))
        .filter(s => /samples/.test(s)))];
      // 信息字段: .movie-panel-info .panel-block → {label: value}
      var info = {};
      var norm = (k) => {
        var kk = (k || '').replace(/[：:\\s]/g, '');
        var map = { '番號':'number','番号':'number','日期':'date','時長':'duration','时长':'duration','片商':'studio','系列':'series','評分':'rating','评分':'rating','類別':'categories','类别':'categories','演員':'actors','演员':'actors','導演':'director','导演':'director' };
        return map[kk] || kk;
      };
      document.querySelectorAll('.movie-panel-info .panel-block').forEach(function(b) {
        var v = b.querySelector('.value');
        if (!v) return;
        var label = (b.textContent.replace(v.textContent, '')).replace(/[：:\\s]/g, '');
        info[norm(label)] = v.textContent.trim().replace(/\\s+/g, ' ');
      });
      return JSON.stringify({title, origTitle, cnTitle, info, samples, actors, full: full.slice(0, 100000), cover});
    })()`);
    let d;
    try { d = JSON.parse(res); } catch { d = { actors: [], full: '', cover: '', title: '', info: {}, samples: [] }; }

    // 预告片 m3u8(带 token, 可能过期): 从 performance 资源记录读取; 没有则点击预告片容器触发加载后重读
    let preview = null;
    try {
      const p = await evalJS(tab, `(() => {
        var r = (performance.getEntriesByType('resource') || []).map(e => e.name).filter(n => /ttm3u8\\/preview\\/.*\\.m3u8/.test(n));
        return r.length ? r[r.length - 1] : '';
      })()`, 0);
      if (p) { preview = p; }
      else {
        // 点击预告片容器触发加载, 稍后重读
        await evalJS(tab, `(() => { var a = document.querySelector('.preview-video-container'); if (a) { a.click(); return true } return false })()`, 0);
        await sleep(3000);
        const p2 = await evalJS(tab, `(() => {
          var r = (performance.getEntriesByType('resource') || []).map(e => e.name).filter(n => /ttm3u8\\/preview\\/.*\\.m3u8/.test(n));
          return r.length ? r[r.length - 1] : '';
        })()`, 0);
        if (p2) preview = p2;
        // 关闭可能打开的 fancybox
        await evalJS(tab, `(() => { var c = document.querySelector('.fancybox-container'); if (c) { document.querySelector('.fancybox-button--close') && document.querySelector('.fancybox-button--close').click(); return true } return false })()`, 0);
      }
    } catch {}

    // 预告片下载已暂停(用户决策: 待定方案, 暂不下载到本地)
    // 需要时启用: 页面内拿 m3u8 → Node 下载分片 → AES解密 → ffmpeg 转 mp4
    let previewLocal = null;
    // if (preview && code) {
    //   const dl = await downloadPreview(code, preview, tab);
    //   if (dl.ok) previewLocal = dl.path;
    // }

    // 标题: 原标题 + 中文翻译, 并入 info
    const infoFinal = d.info || {};
    if (d.origTitle) infoFinal.title = d.origTitle;
    if (d.cnTitle) infoFinal.titleCn = d.cnTitle;

    return {
      title: d.title || null,
      info: infoFinal,
      samples: d.samples || [],
      // 清洗演员: 只保留 ♀ 女性演员(用户要求, 男优不展示)
      // 双源: ①信息面板原文(带 ♀/♂ 符号, 最可靠) ②a 链接文本(无符号时保留全部)
      actors: parseActorsByGender((d.info && d.info.actors) || (d.actors || []).join(' ')),
      comments: parseComments(d.full || ''),
      cover: d.cover || null,
      // 只有下载成功(本地 mp4)才返回, 避免 javdb m3u8(需登录态)播不了
      preview: previewLocal || null,
    };
  } finally {
    await closeTab(tab);
  }
}

// 筛选规则: 规则数组,任一满足即通过; force=true 表示评分>score 无条件
function passFilter(info, filterCfg) {
  if (!info.found || info.score === null || info.votes === null) return false;
  const rules = Array.isArray(filterCfg.rules) ? filterCfg.rules : [];
  // 兼容旧配置(无 rules 时用默认三条)
  if (!rules.length) {
    return (info.score > 4.0 && info.votes > 200) || (info.score > 4.2 && info.votes > 100) || (info.score > 4.5);
  }
  for (const r of rules) {
    if (!r || r.score == null) continue;
    if (r.force) {
      if (info.score > r.score) return true;
    } else {
      if (info.score > r.score && info.votes > (r.votes || 0)) return true;
    }
  }
  return false;
}

// 下载预告片到本地 mp4(Node 直接下载 CDN 分片 + ffmpeg 解密转封装)
// 流程: 页面内 fetch m3u8(带登录 cookie, 几KB) → Node 解析 key/ts URL(sign 在 URL 内)
//       → Node 直接下载(CDN 无需 cookie) → 生成本地 m3u8 → ffmpeg 转 mp4
// 返回 { ok, path, size } 或 { ok:false, error }
async function downloadPreview(code, m3u8Url, tab) {
  const fs = require('fs');
  const path = require('path');
  const { execFile } = require('child_process');
  const util = require('util');
  const execFileP = util.promisify(execFile);
  const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
  const safeCode = String(code || 'x').replace(/[^\w-]/g, '');
  const dl = async (u) => {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': UA } });
      if (!r.ok) return null;
      return Buffer.from(await r.arrayBuffer());
    } catch { return null; }
  };

  try {
    // 1. 页面内 fetch m3u8 文本(带登录 cookie; 数据几 KB, 传输无问题)
    const txt = await evalJS(tab, `(async () => {
      try {
        const r = await fetch(${JSON.stringify(m3u8Url)});
        if (!r.ok) return 'ERR:status=' + r.status;
        return await r.text();
      } catch(e) { return 'ERR:' + e.message; }
    })()`, 0);
    if (!txt || txt.startsWith('ERR:')) return { ok: false, error: txt || 'm3u8 获取失败' };

    // 2. 解析 key + ts 完整 URL(sign 在 URL 内, 各自独立)
    const keyM = txt.match(/#EXT-X-KEY:.*URI="([^"]+)"/);
    const keyUrl = keyM ? keyM[1] : null;
    const tsUrls = txt.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && /\.ts/.test(l));

    // 3. Node 直接下载 key + 所有 ts
    const dir = path.join(__dirname, '..', 'data', 'previews', safeCode);
    fs.mkdirSync(dir, { recursive: true });
    if (keyUrl) {
      const k = await dl(keyUrl);
      if (k && k.length >= 16) fs.writeFileSync(path.join(dir, 'key.bin'), k);
    }
    let okCount = 0;
    for (let i = 0; i < tsUrls.length; i++) {
      const buf = await dl(tsUrls[i]);
      if (buf && buf.length > 1000) {
        fs.writeFileSync(path.join(dir, 'seg-' + (i + 1) + '.ts'), buf);
        okCount++;
      }
      if (i % 3 === 0) await sleep(400);
    }
    if (okCount < 3) return { ok: false, error: 'ts 下载过少: ' + okCount + '/' + tsUrls.length };

    // 4. Node 解密分片(AES-128-CBC, HLS 默认 IV=分片序号) 拼接成完整 TS
    const crypto = require('crypto');
    const keyBuf = fs.existsSync(path.join(dir, 'key.bin')) ? fs.readFileSync(path.join(dir, 'key.bin')) : null;
    const parts = [];
    for (let i = 0; i < okCount; i++) {
      const seg = fs.readFileSync(path.join(dir, 'seg-' + (i + 1) + '.ts'));
      if (keyBuf) {
        try {
          const iv = Buffer.alloc(16); iv.writeUInt32BE(i + 1, 12);
          const d = crypto.createDecipheriv('aes-128-cbc', keyBuf, iv);
          parts.push(Buffer.concat([d.update(seg), d.final()]));
          continue;
        } catch { /* 解密失败回退原始数据 */ }
      }
      parts.push(seg);
    }
    const tsBuf = Buffer.concat(parts);
    if (tsBuf.length < 50000) return { ok: false, error: '解密后数据过小: ' + tsBuf.length + 'B' };
    fs.writeFileSync(path.join(dir, 'decoded.ts'), tsBuf);

    // 5. ffmpeg 转封装 mp4
    const mp4 = path.join(__dirname, '..', 'data', 'previews', safeCode + '.mp4');
    try {
      await execFileP(FFMPEG, ['-y', '-loglevel', 'error', '-i', 'decoded.ts', '-c', 'copy', '-bsf:a', 'aac_adtstoasc', mp4], { cwd: dir, timeout: 120000 });
      fs.rmSync(dir, { recursive: true, force: true });
      const size = fs.statSync(mp4).size;
      if (size < 50000) return { ok: false, error: 'mp4 过小: ' + size + 'B' };
      return { ok: true, path: '/previews/' + safeCode + '.mp4', size };
    } catch (e) {
      return { ok: false, error: 'ffmpeg 转换失败: ' + (e.message || '').slice(0, 150) };
    }
  } catch (e) {
    return { ok: false, error: '下载异常: ' + e.message };
  }
}

// 轻量: 重新抓取单部影片评论(javdb 偶尔加载不到, 0 条时重试 2 次)
async function fetchCommentsOnly(href, tries = 3) {
  for (let i = 0; i < tries; i++) {
    let tab = null;
    try {
      tab = await newTab(href);
      await sleep(6000);
      try {
        const need = await evalJS(tab, 'document.body.innerText.includes("我已滿18歲") || document.body.innerText.includes("满18岁")', 0);
        if (need === 'true' || need === true) {
          await evalJS(tab, `(() => { const l=[...document.querySelectorAll('a,button')].find(a=>/满18岁|滿18歲/.test(a.textContent)); if (l){l.click();return true} return false })()`, 0);
          await sleep(2500);
        }
      } catch {}
      const res = await evalJS(tab, `(() => {
        var full = document.body ? document.body.innerText : '';
        var cut = full.search(/TA.{0,8}出.{1,3}[過过]/);
        if (cut > 0) full = full.slice(0, cut);
        return full;
      })()`, 0);
      const comments = parseComments(res || '');
      try { await closeTab(tab); } catch {}
      if (comments.length > 0) return comments;
      console.log(`[fetchCommentsOnly] 第 ${i + 1} 次抓到 0 条, 准备重试`);
    } catch (e) {
      try { if (tab) await closeTab(tab); } catch {}
    }
    if (i < tries - 1) await sleep(3000);
  }
  return [];
}

// 轻量: 重新抓取单部影片的 评分 + 评分人数 + 评论(不动其他字段; 供报告"一键更新javdb数据"按钮使用)
// 评分来源: 详情页信息面板"評分"行(如 "4.32分, 由188人評價")
async function fetchScoreCommentsOnly(href, tries = 3) {
  for (let i = 0; i < tries; i++) {
    let tab = null;
    try {
      tab = await newTab(href);
      await sleep(6000);
      try {
        const need = await evalJS(tab, 'document.body.innerText.includes("我已滿18歲") || document.body.innerText.includes("满18岁")', 0);
        if (need === 'true' || need === true) {
          await evalJS(tab, `(() => { const l=[...document.querySelectorAll('a,button')].find(a=>/满18岁|滿18歲/.test(a.textContent)); if (l){l.click();return true} return false })()`, 0);
          await sleep(2500);
        }
      } catch {}
      const res = await evalJS(tab, `(() => {
        var full = document.body ? document.body.innerText : '';
        var cut = full.search(/TA.{0,8}出.{1,3}[過过]/);
        if (cut > 0) full = full.slice(0, cut);
        // 评分/人数: 信息面板 "評分" 行
        var score = null, votes = null;
        var blocks = document.querySelectorAll('.movie-panel-info .panel-block');
        for (var i = 0; i < blocks.length; i++) {
          var b = blocks[i];
          var v = b.querySelector('.value');
          if (!v) continue;
          var label = (b.textContent.replace(v.textContent, '')).replace(/[：:\\s]/g, '');
          if (/評分|评分/.test(label)) {
            var txt = v.textContent.trim();
            var sm = txt.match(/([\\d.]+)\\s*分/);
            var vm = txt.match(/([\\d,]+)\\s*人/);
            if (sm) score = parseFloat(sm[1]);
            if (vm) votes = parseInt(vm[1].replace(/,/g, ''), 10);
          }
        }
        return JSON.stringify({ full: full.slice(0, 100000), score, votes });
      })()`, 0);
      let d;
      try { d = JSON.parse(res); } catch { d = { full: '', score: null, votes: null }; }
      const comments = parseComments(d.full || '');
      try { await closeTab(tab); } catch {}
      if (comments.length > 0 || d.score !== null) {
        return { score: d.score, votes: d.votes, comments };
      }
      console.log(`[fetchScoreCommentsOnly] 第 ${i + 1} 次未获取到数据, 准备重试`);
    } catch (e) {
      try { if (tab) await closeTab(tab); } catch {}
    }
    if (i < tries - 1) await sleep(3000);
  }
  return { score: null, votes: null, comments: [] };
}

// 轻量抓详情: 只拿女优名单(批量反查映射用, 裁剪掉评论/缩略图/封面/预告片, 省时)
async function fetchActorsOnly(href, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const tab = await newTab(href);
    await sleep(5000);
    try {
      // 18岁确认
      try {
        const need = await evalJS(tab, 'document.body.innerText.includes("我已滿18歲") || document.body.innerText.includes("满18岁")', 0);
        if (need === 'true' || need === true) {
          await evalJS(tab, `(() => { const l=[...document.querySelectorAll('a,button')].find(a=>/满18岁|滿18歲/.test(a.textContent)); if(l){l.click();return true} return false })()`, 0);
          await sleep(3000);
        }
      } catch {}
      // 等标题
      for (let j = 0; j < 4; j++) {
        await sleep(2000);
        const t = await evalJS(tab, 'document.querySelector("h1, .video-title") ? "ready" : "loading"', 0);
        if (t === 'ready') break;
      }
      // 提取演员: 信息面板"演員"行(带♀/♂最可靠) + a链接文本兜底
      const res = await evalJS(tab, `(() => {
        var actors = [...new Set([...document.querySelectorAll('a[href*="/actors/"]')].map(a => a.textContent.trim()))]
          .filter(t => t && t.length < 20 && !/有碼|無碼|歐美|推薦/.test(t)).slice(0, 6);
        var infoActors = '';
        document.querySelectorAll('.movie-panel-info .panel-block').forEach(function(b) {
          var v = b.querySelector('.value'); if (!v) return;
          var label = (b.textContent.replace(v.textContent, '')).replace(/[：:\\s]/g, '');
          if (label === '演員' || label === '演员') infoActors = v.textContent.trim().replace(/\\s+/g, ' ');
        });
        return JSON.stringify({ actors, infoActors });
      })()`, 0);
      let d = { actors: [], infoActors: '' };
      try { d = JSON.parse(res); } catch {}
      const actors = parseActorsByGender(d.infoActors || (d.actors || []).join(' '));
      if (actors.length) return actors;
    } catch {} finally {
      await closeTab(tab);
    }
    if (i < tries - 1) await sleep(3000);
  }
  return null; // 最终失败
}

// ===== javdb 健康熔断 =====
// 背景(2026-09-02 事故): javdb 改版 / 登录态失效 / 被限流时, 搜索页会直接返回空结果,
//   一批番号全部"未找到"。此时若无保护, 这些无评分记录会被静默入库,
//   从日志看就像"片子不达标被筛掉", 极难发现(当天离线数直接归零也没人察觉)。
// 规则:
//   1) 开局连续 probeN(默认5) 个番号全部查不到 → 判定 javdb 异常, 返回中止理由;
//   2) 中途只要查到 1 个 → 证明站点可用, 立刻解除熔断, 后续不再干预。
// 正常情况"连续5个全部查不到"几乎不可能(历史每天 10~16 个番号通常 0 个未找到), 误伤概率低。
function createHealthGuard({ probeN = 5 } = {}) {
  let probed = 0, found = 0, armed = true;
  return {
    get stats() { return { probed, found }; },
    // ok = 本次是否查到; 返回 null 表示正常, 返回字符串表示应当中止(理由)
    check(ok) {
      if (!armed) return null;
      probed++;
      if (ok) { found++; armed = false; return null; }
      if (probed >= probeN && found === 0) {
        armed = false;
        return `javdb 连续 ${probed} 个番号全部查不到(疑似站点不可访问/登录态失效/被限流), 已中止本轮, 避免无评分记录被静默入库`;
      }
      return null;
    },
  };
}

module.exports = { queryJavdb, fetchDetail, fetchCommentsOnly, fetchScoreCommentsOnly, fetchActorsOnly, parseComments, parseActorsByGender, parseScore, passFilter, downloadPreview, createHealthGuard };
