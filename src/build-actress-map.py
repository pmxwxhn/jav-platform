# -*- coding: utf-8 -*-
# 演员映射构建器: javdb 演员日文名 ↔ 115 演员目录名 ↔ cid
# 数据源:
#   1) 全量演员库 Actress-20250220.db (Info 21860 / Names 42185 别名 / Urls)
#   2) 115 演员目录 data/actress-dirs-115.json (由 MCP 枚举, 含 name+cid)
# 输出(写入平台 SQLite data/config.db 的 actress_map 表):
#   - status='mapped'  : 自动桥接匹配成功
#   - status='pending' : 115 有目录但未匹配到 javdb 名(占位名 @DIR:xxx, 待人工补录) | via='dup' 表示 115 重复目录
#   - status='excluded': 厂商/合辑等非演员目录(无需映射)
# 用法:
#   python build-actress-map.py                # 默认 merge 模式(保留 manual)
#   python build-actress-map.py --mode=rebuild # 全量重建(覆盖 manual)
import sqlite3, json, os, re, sys, collections, subprocess
import opencc

ROOT = os.path.dirname(os.path.abspath(__file__))
DIRS_JSON = os.path.join(ROOT, 'data', 'actress-dirs-115.json')
PLATFORM_DB = os.path.join(ROOT, 'data', 'config.db')
DEFAULT_FULL_DB = os.environ.get('ACTRESS_DB', os.path.join(ROOT, 'data', 'Actress-20250220.db'))
NODE_BIN = os.environ.get('NODE_BIN', 'node')

cc = opencc.OpenCC('t2s')  # 繁/日文汉字 → 简体

# ---------- 0. 实时枚举 115 目录(优先; 失败回退旧快照) ----------
def refresh_115_dirs():
    """调 refresh-actress-dirs.js 实时枚举 115 演员目录, 成功就覆盖本地快照。
    失败时保留旧快照(可能已过时), 不中止构建 — 用户可手动重新生成。"""
    script = os.path.join(ROOT, 'refresh-actress-dirs.js')
    if not os.path.exists(script):
        print('[0] refresh-actress-dirs.js 不存在, 使用旧快照')
        return False
    try:
        r = subprocess.run([NODE_BIN, script], capture_output=True, text=True, timeout=60, cwd=ROOT)
        if r.returncode == 0:
            tail = (r.stdout.strip().splitlines()[-1] if r.stdout.strip() else '')
            print(f'[0] 实时枚举 115: {tail}')
            return True
        print(f'[!] 实时枚举失败(code={r.returncode}): {r.stderr.strip()[:200]} → 使用旧快照')
    except Exception as e:
        print(f'[!] 实时枚举异常: {e} → 使用旧快照')
    return False

refresh_115_dirs()

# ---------- 1. 加载全量库路径(优先从 config.db settings 读) ----------
def load_full_db_path():
    try:
        con = sqlite3.connect(PLATFORM_DB)
        row = con.execute("SELECT value FROM settings WHERE key = 'actressDb.fullDbPath'").fetchone()
        con.close()
        if row and row[0]:
            import json as _json
            try: return _json.loads(row[0])
            except: return row[0]
    except Exception:
        pass
    return DEFAULT_FULL_DB

FULL_DB = load_full_db_path()
print(f'[1] 全量库路径: {FULL_DB}')

# ---------- 2. 加载全量库数据 ----------
con = sqlite3.connect(FULL_DB)
info = {}  # Name -> {name, namecn, roma}
for nm, namecn, roma in con.execute('SELECT Name, NameCN, Roma FROM Info'):
    info[nm] = {'name': nm, 'namecn': namecn, 'roma': roma}
alias_map = collections.defaultdict(list)  # Alias -> [Name]
for nm, roma, alias in con.execute('SELECT Name, Roma, Alias FROM Names'):
    alias_map[alias].append(nm)
con.close()
print(f'[2] 全量库: Info={len(info)} 别名条目={len(alias_map)}')

# ---------- 3. 分桶索引(按匹配来源区分 via) ----------
# 优先级: auto_name > auto_cn > auto_sc > auto_roma > auto_alias
name_idx  = collections.defaultdict(list)  # cc.convert(Name)   -> [info]
cn_idx    = collections.defaultdict(list)  # cc.convert(NameCN) -> [info]
roma_idx  = collections.defaultdict(list)  # Roma.lower()       -> [info]
alias_idx = collections.defaultdict(list)  # cc.convert(Alias)  -> [info]
for nm, d in info.items():
    name_idx[cc.convert(nm)].append(d)
    if d['namecn']:
        cn_idx[cc.convert(d['namecn'])].append(d)
    if d['roma']:
        roma_idx[d['roma'].lower().strip()].append(d)
for alias, names in alias_map.items():
    for n in names:
        if n in info:
            alias_idx[cc.convert(alias)].append(info[n])
print(f'[3] 索引键数: name={len(name_idx)} cn={len(cn_idx)} roma={len(roma_idx)} alias={len(alias_idx)}')

# ---------- 4. 影片记录出现次数(多候选消歧用) ----------
pcon = sqlite3.connect(PLATFORM_DB)
pcon.row_factory = sqlite3.Row
counts = collections.Counter()
for (ja,) in pcon.execute("SELECT javdb_actors FROM videos WHERE javdb_actors IS NOT NULL AND javdb_actors != ''"):
    try: arr = json.loads(ja)
    except Exception: arr = str(ja).split(',')
    for a in arr:
        a = str(a).strip()
        if a and a != '-':
            counts[a] += 1

# 优先影片出现次数最多的候选
def best(cands):
    if len(cands) == 1: return cands[0]
    return max(cands, key=lambda d: counts.get(d['name'], 0))

# 已有人工确认映射的 115 目录(manual=手动补录, auto_query=批量反查确认)
# 这些目录跳过 pending 生成, 避免重建后同一目录出现 mapped+pending 冗余
MANUAL_MAPPED_DIRS = set()
for r in pcon.execute("SELECT dir_name FROM actress_map WHERE status='mapped' AND via IN ('manual','auto_query')"):
    if r['dir_name']:
        MANUAL_MAPPED_DIRS.add(r['dir_name'])
print(f'[3.5] 已人工映射目录(重建时保护): {len(MANUAL_MAPPED_DIRS)}')

# ---------- 5. 匹配 lookup(返回 (via, javdb_name) 或 None) ----------
def lookup(nm):
    if nm in info:
        return ('auto_name', nm)
    k = cc.convert(nm)
    if cn_idx.get(k):
        return ('auto_cn', best(cn_idx[k])['name'])
    if name_idx.get(k):
        return ('auto_sc', best(name_idx[k])['name'])
    rk = k.lower().strip()
    if roma_idx.get(rk):
        return ('auto_roma', best(roma_idx[rk])['name'])
    if alias_idx.get(k):
        return ('auto_alias', best(alias_idx[k])['name'])
    return None

# ---------- 6. 分类过滤 ----------
MALE_KEYWORDS = re.compile(r'厂商|精选|作品|合集|合辑|共演|专题|系列|字幕|编$')
GARBAGE_PATTERN = re.compile(r'^[\d\s\-_·.—、,。()（）【】.\\/]+$')

def classify_skip(name):
    if not name or not name.strip(): return '空名'
    if GARBAGE_PATTERN.fullmatch(name): return '纯符号/数字'
    if MALE_KEYWORDS.search(name): return '厂商/合辑/专题类'
    # 多演员合辑目录: 目录名含多个演员名(空格分隔≥2段), 几乎不会重遇, 忽略不映射
    # 注意先 strip 再分段, 避免 "音月みり " 这种尾部空格被误判
    if len(name.strip().split()) >= 2:
        return '多演员合辑'
    return None

chinese_count = lambda s: len(re.findall(r'[\u4e00-\u9fff]', str(s)))

# ---------- 7. 加载 115 目录 ----------
if not os.path.exists(DIRS_JSON):
    print('!! 缺少 115 目录清单, 请先用 MCP 枚举生成 data/actress-dirs-115.json')
    sys.exit(1)
dirs = json.load(open(DIRS_JSON, encoding='utf8'))
print(f'[4] 115 演员目录: {len(dirs)}')

# ---------- 8. 第一遍: 收集所有命中, 按 javdb_name 分组 ----------
excluded = []
by_javdb = collections.defaultdict(list)  # javdb_name -> [{dir, cid, via, chinese}]
pending_unmatched = []  # 完全未匹配的目录

for d in dirs:
    nm = (d.get('name') or '').strip()
    if not nm:
        continue
    skip = classify_skip(nm)
    if skip:
        excluded.append({'javdb': nm, 'dir': nm, 'cid': d['cid'], 'via': 'excluded', 'note': skip})
        continue
    hit = lookup(nm)
    if hit:
        by_javdb[hit[1]].append({
            'dir': nm, 'cid': d['cid'], 'via': hit[0],
            'chinese': chinese_count(nm),
        })
    else:
        # 该目录已有人工确认映射 → 跳过 pending, 防止冗余
        if nm in MANUAL_MAPPED_DIRS:
            continue
        pending_unmatched.append({'javdb': '@DIR:' + nm, 'dir': nm, 'cid': d['cid'], 'via': 'pending', 'note': ''})

# ---------- 9. 第二遍: 同 javdb 名按汉字字符数最多优先, 其余标 dup ----------
matched = []
pending_dup = []
for javdb_name, items in by_javdb.items():
    # 排除已人工映射的目录(它们的映射由人工决定, 不被自动匹配覆盖)
    auto_items = [x for x in items if x['dir'] not in MANUAL_MAPPED_DIRS]
    if not auto_items:
        continue
    # 排序: 汉字数降序 > 目录名字符数降序(目录名长通常更具体)
    auto_items.sort(key=lambda x: (x['chinese'], len(x['dir'])), reverse=True)
    top = auto_items[0]
    matched.append({'javdb': javdb_name, 'dir': top['dir'], 'cid': top['cid'], 'via': top['via'], 'note': ''})
    for dup in auto_items[1:]:
        pending_dup.append({
            'javdb': '@DIR:' + dup['dir'], 'dir': dup['dir'], 'cid': dup['cid'],
            'via': 'dup',
            'note': f'115 重复目录: 与 [{top["dir"]}] 同 javdb 名 "{javdb_name}", 建议去 115 删除',
        })

pending = pending_unmatched + pending_dup

print(f'[5] 自动匹配: {len(matched)} | 待人工补录: {len(pending)} (未匹配 {len(pending_unmatched)} + 重复目录 {len(pending_dup)}) | 排除: {len(excluded)}')
via_cnt = collections.Counter(m['via'] for m in matched)
print(f'    via 分布: {dict(via_cnt)}')

# ---------- 10. 写入 actress_map 表(支持 merge / rebuild) ----------
mode = 'rebuild' if '--mode=rebuild' in sys.argv else 'merge'
print(f'[6] 模式: {mode}')
# 用户确认过的映射(manual=手动补录, auto_query=批量反查人工确认)在 merge 时保留
KEEP_VIA = ('manual', 'auto_query')
if mode == 'rebuild':
    pcon.execute('DELETE FROM actress_map')
else:
    placeholders = ','.join('?' for _ in KEEP_VIA)
    pcon.execute(f"DELETE FROM actress_map WHERE via NOT IN ({placeholders})", KEEP_VIA)

def to_row(e, status):
    return (e['javdb'], e['dir'], e['cid'], e['via'], status, e.get('note', ''), counts.get(e['javdb'].replace('@DIR:', ''), 0))
rows = ([to_row(e, 'mapped') for e in matched]
        + [to_row(e, 'pending') for e in pending]
        + [to_row(e, 'excluded') for e in excluded])
pcon.executemany('''INSERT INTO actress_map (javdb_name, dir_name, cid, via, status, note, count, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
                    ON CONFLICT(javdb_name) DO UPDATE SET
                    dir_name=excluded.dir_name, cid=excluded.cid,
                    via=CASE WHEN actress_map.via IN ('manual','auto_query') THEN actress_map.via ELSE excluded.via END,
                    status=CASE WHEN actress_map.via IN ('manual','auto_query') THEN actress_map.status ELSE excluded.status END,
                    note=CASE WHEN actress_map.via IN ('manual','auto_query') THEN actress_map.note ELSE excluded.note END,
                    count=excluded.count, updated_at=excluded.updated_at
                    WHERE actress_map.via NOT IN ('manual','auto_query') OR excluded.via NOT IN ('manual','auto_query') ''', rows)
pcon.commit()

stats = {r['status']: r['n'] for r in pcon.execute('SELECT status, COUNT(*) n FROM actress_map GROUP BY status')}
print(f'[7] 入库完成: {dict(stats)}')
print()
print('=== 单字目录"蕾/枫"修复验证 ===')
for e in matched:
    if e['dir'] in ('蕾', '枫'):
        print(f"  ✓ 115目录 {e['dir']} → javdb {e['javdb']}  [{e['via']}]")
print()
print('=== 自动匹配样例(前 15, 按计数排序) ===')
for e in matched[:15]:
    print(f"  {e['javdb']}  →  {e['dir']}  [{e['via']}]")
print()
print('=== 重复目录提示(前 10) ===')
for e in pending_dup[:10]:
    print(f"  ! {e['dir']}  →  {e['note']}")
print()
print('=== 待人工补录样例(前 10) ===')
for e in pending_unmatched[:10]:
    print(f"  115目录: {e['dir']}  (cid {str(e['cid'])[:10]}...)")
pcon.close()