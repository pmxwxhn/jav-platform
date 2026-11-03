// 演员目录判断模块(fid=36 专用, f103 也可用)
// 三级候选: 帖子演员名 → javdb演员名 → 汉字前缀; 繁体转简体; 前缀匹配
const { sleep, evalJS, navigate, resolveTab } = require('./cdp');
const mcp = require('./mcp115');
const cfg = require('../config');

function mcpEnabled() { return cfg.mcp115 && cfg.mcp115.enabled; }

// 繁体→简体映射(常见演员名用字)
const TC2SC = {
  '澤': '泽', '華': '华', '綾': '绫', '結': '结', '亞': '亚', '條': '条', '邊': '边',
  '瀬': '濑', '渋': '涩', '渕': '渊', '繪': '绘', '蒼': '苍', '櫻': '樱', '凜': '凛',
  '優': '优', '島': '岛', '嶋': '嶋', '沢': '泽', '咲': '咲', '美': '美', '園': '园',
  '絵': '绘', '恵': '惠', '実': '实', '夢': '梦', '愛': '爱', '麗': '丽', '葉': '叶',
  '花': '花', '奈': '奈', '菜': '菜', '桃': '桃', '梨': '梨', '紗': '纱', '紗': '纱',
  '緒': '绪', '純': '纯', '鈴': '铃', '音': '音', '響': '响', '聖': '圣', '遥': '遥',
  '澪': '澪', '雛': '雏', '希': '希', '星': '星', '雪': '雪', '楓': '枫', '栞': '栞',
  '茜': '茜', '葵': '葵', '蕾': '蕾', '萌': '萌', '玲': '玲', '璃': '璃', '瑠': '瑠',
  '怜': '怜', '恋': '恋', '恋': '恋', '郁': '郁', '郁': '郁', '穂': '穗', '穂': '穗',
  '薫': '薰', '葵': '葵', '茉': '茉', '柚': '柚', '栞': '栞', '玲': '玲',
};
function toSC(s) {
  return s.split('').map(c => TC2SC[c] || c).join('');
}

// 汉字前缀: 取假名前的汉字部分; 全汉字名取前2字; 1字取该字
function kanjiPrefix(name) {
  const m = name.match(/^[\u4e00-\u9fff\u3400-\u4dbf]+/);
  if (m) {
    const kanji = m[0];
    return kanji.length > 2 ? kanji.slice(0, 2) : kanji;
  }
  return name.slice(0, 2);
}

// 男优常见名单(从 javdb 演员列表排除)
const MALE_ACTORS = [
  'イセドン内村', '藍井優太', '今井勇太', '日森一', '太刀茜祢', '平田司', '橋本誠吾',
  'ハッピー池田', '小田切ジュン', '吉村卓', '武田大樹', 'タラオ', '矢野慎二', 'ゴロー',
  '貞松大輔', '奥村友真', 'トミフミ', '七尾神', '渋谷優太', '澤地真人', '井口',
  'ジャイアント廣田', 'ピエール剣', 'えりぐち', 'レフト左', '天河', '野島誠', '清水健',
  'およよ中野', '市川哲也', '小梅', 'イタリアン高橋', 'TECH', '汁系', 'オクレ', 'ダンカ',
];

// 生成候选名列表
function buildCandidates(postActress, javdbActors) {
  const candidates = [];
  // 1. 帖子演员(清洗)
  let pa = (postActress || '').replace(/^[-·\s]+/, '').trim();
  if (pa && pa.length >= 2 && /[\u4e00-\u9fff\u3040-\u30ff]/.test(pa)) candidates.push(pa);
  // 2. javdb 演员(排除男优)
  for (const a of (javdbActors || [])) {
    if (!MALE_ACTORS.includes(a) && !candidates.includes(a)) candidates.push(a);
  }
  // 3. 汉字前缀(对日文名)
  for (const c of candidates.slice()) {
    if (/[\u3040-\u30ff]/.test(c)) {
      const p = kanjiPrefix(c);
      if (p && !candidates.includes(p)) candidates.push(p);
    }
  }
  // 4. 简体备选(原字优先, 简体补充)
  for (const c of candidates.slice()) {
    const sc = toSC(c);
    if (sc !== c && !candidates.includes(sc)) candidates.push(sc);
  }
  return candidates;
}

// 在 115 搜索演员目录, 返回匹配的文件夹
async function searchDir(name) {
  // ---- MCP 优先(结构化, 稳定) ----
  if (mcpEnabled() && await mcp.ensure()) {
    try {
      const data = await mcp.searchFiles(name, 0, 50);
      if (!data) return { name, searched: false, folders: [] };
      const folders = (Array.isArray(data) ? data : [])
        .filter(e => {
          const isFile = (e.file_category === '1' || e.type === '1' || e.sha1);
          return !isFile; // 只留文件夹
        })
        .map(e => ({ name: e.file_name || e.name || '', loc: '' }))
        .filter(f => f.name);
      return { name, searched: true, folders, via: 'mcp' };
    } catch (e) {
      console.log('[actress] MCP 搜索异常, 回退 CDP:', e.message);
    }
  }

  // ---- CDP 回退(原网页搜索 + iframe 解析) ----
  const tabId = await resolveTab();
  const searchUrl = 'https://115.com/?url=%2F%3Faid%3D1%26cid%3D0%26old_cid%3D0%26old_cid_name%3D%25E6%25A0%25B9%25E7%259B%25AE%25E5%25BD%2595%26search_value%3D' + encodeURIComponent(name) + '%26ct%3Dfile%26ac%3Dsearch%26is_wl_tpl%3D1&submode=wangpan&mode=search';
  await navigate(searchUrl, tabId);
  let text = '';
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
      if (d.text) { text = d.text; break; }
    } catch {}
  }
  if (!text) return { name, searched: false, folders: [] };
  if (text.includes('没有找到') || text.includes('未找到')) return { name, searched: true, folders: [] };
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const folders = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i + 1] === '文件夹' && lines[i].length < 30) {
      folders.push({ name: lines[i], loc: lines[i + 3] || '' });
      i += 3;
    }
  }
  return { name, searched: true, folders, via: 'cdp' };
}

// 主流程: ① 先查演员映射表(javdb 演员名权威键) → 命中直接用映射目录, 绝不拆字搜索
//        ② 未命中才走三级候选拆字搜索(帖子名→javdb名→汉字前缀)
async function resolveActressDir(postActress, javdbActors, options = {}) {
  const { simplified = true } = options;
  const log = [];

  // ---- ① 映射表优先(关键!): 用 javdb 演员名(清洗去符号)精确查映射表 ----
  // 映射表 = 用户确认过的权威对应关系(javdb日文名 ↔ 115目录 ↔ cid), 命中直接返回, 跳过拆字搜索
  try {
    const dbMod = require('../db');
    const clean = (a) => String(a).replace(/[♀♂]/g, '').trim();
    const keys = [];
    for (const a of (javdbActors || [])) {
      const c = clean(a);
      if (c && !MALE_ACTORS.includes(c) && !keys.includes(c)) keys.push(c);
    }
    if (postActress) {
      const pc = clean(postActress);
      if (pc && !keys.includes(pc)) keys.push(pc);
    }
    for (const k of keys) {
      const hit = dbMod.getActressMapByJavdb(k);
      if (hit && hit.cid && hit.status === 'mapped') {
        log.push(`映射表[${k}] → ${hit.dir_name} (cid ${String(hit.cid).slice(0, 8)}...)`);
        return { ok: true, dir: hit.dir_name, candidate: '映射表:' + k, cid: hit.cid, fromMap: true, folders: [], log };
      }
    }
    if (!keys.length) log.push('映射表: 无可用演员名');
  } catch (e) {
    log.push('映射表查询异常: ' + e.message);
  }

  // ---- ② 未命中映射表, 回退三级候选拆字搜索 ----
  const candidates = buildCandidates(postActress, javdbActors);
  for (const cand of candidates) {
    const r = await searchDir(cand);
    log.push(`搜[${cand}]: ${r.folders.length ? r.folders.map(f => f.name + '@' + f.loc).join('; ') : (r.searched ? '无' : '异常')}`);
    if (r.folders && r.folders.length > 0) {
      // 命中: 优先独立演员目录(演员划分), 其次第一个文件夹
      const prefer = r.folders.find(f => f.loc.includes('演员划分')) || r.folders[0];
      return { ok: true, dir: prefer.name, candidate: cand, folders: r.folders, log };
    }
  }
  return { ok: false, dir: null, candidate: null, folders: [], log };
}

module.exports = { buildCandidates, resolveActressDir, toSC, kanjiPrefix, searchDir, MALE_ACTORS };
