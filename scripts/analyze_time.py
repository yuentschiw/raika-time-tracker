#!/usr/bin/env python3
"""
Raika Time Tracker - 时间数据分析器
从 GitHub 读取时间追踪数据，结合 Task Dashboard 进行任务分类，生成日报
"""

import json
import sys
import os
import base64
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone
from collections import defaultdict

# ─── 配置 ────────────────────────────────────────────────────

JSONBIN_KEY = "$2a$10$ZprY/cMDxkU1VHSX5dEiJ.bppSYR8JXoxx2smTlJwPjOvtYdmh1qy"
JSONBIN_BIN_ID = "69ddb7dc856a6821892f8a86"
JSONBIN_URL = f"https://api.jsonbin.io/v3/b/{JSONBIN_BIN_ID}"

# Task Dashboard BIN（读取任务列表用）
TASK_BIN_ID = "69d898a1856a6821891a1535"
TASK_BIN_URL = f"https://api.jsonbin.io/v3/b/{TASK_BIN_ID}"

CST = timezone(timedelta(hours=8))

# ─── GitHub 读取 ──────────────────────────────────────────────

def jsonbin_get(url):
    req = urllib.request.Request(url + "/latest", headers={
        "X-Master-Key": JSONBIN_KEY,
        "User-Agent": "Raika/1.0"
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read()).get("record", {})
    except Exception as e:
        print(f"[ERROR] JSONBin read failed: {e}", file=sys.stderr)
        return None

# ─── Task Dashboard 任务提取 ──────────────────────────────────

def extract_tasks_from_dashboard():
    """从 Task Dashboard JSONBin 提取任务列表（关键词用于分类）"""
    data = jsonbin_get(TASK_BIN_URL)
    tasks = []
    if data:
        for task in data.get("activeTasks", []):
            title = task.get("title") or task.get("name") or ""
            if title and len(title) > 2:
                tasks.append(title.strip())
        for task in data.get("completedTasks", []):
            title = task.get("title") or task.get("name") or ""
            if title and len(title) > 2:
                tasks.append(title.strip())
    # 去重
    seen = set()
    unique = []
    for t in tasks:
        if t not in seen:
            seen.add(t)
            unique.append(t)
    return unique[:50]

# ─── Raika 对话时长（从 session 日志估算）────────────────────

def get_raika_session_records(date_str=None):
    """
    从 OpenClaw session 日志估算当天与 Raika 的对话时长。
    策略：
    - 只取 User 发出的真实消息（带时间戳）
    - 过滤掉 heartbeat（含 HEARTBEAT_OK / Read HEARTBEAT.md 的行）
    - 相邻消息间隔 < 30min 算同一对话段
    - 每段时长 = 首末时间差 + 每条消息 60s buffer（回复思考时间）
    - 每段按关键词映射到任务分类
    """
    import re

    if date_str is None:
        date_str = get_today_str()

    SESSION_LOG_DIR = os.path.expanduser("~/.openclaw/agents/main/qmd/sessions")
    if not os.path.isdir(SESSION_LOG_DIR):
        return []

    GAP_THRESHOLD = 30 * 60  # 30分钟视为新段

    # 按行扫描，识别 User 消息行（带 Current time 时间戳）
    # 格式示例（每行）:
    # User: [Wed 2026-04-15 19:12 GMT+8] 你的时间tracking功能...
    # User: ... Current time: Wednesday, April 15th, 2026 — 19:12 (Asia/Shanghai) / ...
    MONTH_MAP = {
        "January":1,"February":2,"March":3,"April":4,"May":5,"June":6,
        "July":7,"August":8,"September":9,"October":10,"November":11,"December":12
    }

    all_msgs = []  # {"ts": datetime, "text": str}

    for fname in sorted(os.listdir(SESSION_LOG_DIR)):
        if not fname.endswith(".md"):
            continue
        fpath = os.path.join(SESSION_LOG_DIR, fname)
        try:
            with open(fpath, encoding="utf-8", errors="replace") as f:
                lines = f.readlines()
        except Exception:
            continue

        for line in lines:
            # 只处理 User 行
            if not line.startswith("User:"):
                continue

            text = line[5:].strip()

            # 过滤 heartbeat
            if re.search(r'HEARTBEAT', text, re.IGNORECASE):
                continue
            # 过滤纯系统轮询（Read HEARTBEAT.md...）
            if text.startswith("Read HEARTBEAT.md"):
                continue

            # 提取时间戳 —— 格式A: [Wed 2026-04-15 19:12 GMT+8]
            ts_dt = None
            m = re.search(r'\[(?:\w+ )?(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) GMT\+8\]', text)
            if m:
                try:
                    ts_dt = datetime.strptime(f"{m.group(1)} {m.group(2)}", "%Y-%m-%d %H:%M").replace(tzinfo=CST)
                except Exception:
                    pass

            # 格式B: Current time: ..., April 15th, 2026 — 19:12 (Asia/Shanghai)
            if ts_dt is None:
                m = re.search(
                    r'Current time:\s+\w+,?\s+(January|February|March|April|May|June|July|'
                    r'August|September|October|November|December)\s+(\d+)\w*,?\s+(\d{4})\s*[—\-]\s*(\d{1,2}):(\d{2})\s*\(Asia/Shanghai\)',
                    text
                )
                if m:
                    try:
                        ts_dt = datetime(
                            int(m.group(3)), MONTH_MAP[m.group(1)], int(m.group(2)),
                            int(m.group(4)), int(m.group(5)), tzinfo=CST
                        )
                    except Exception:
                        pass

            if ts_dt is None:
                continue

            if ts_dt.strftime("%Y-%m-%d") != date_str:
                continue

            # 去掉时间戳部分，保留消息正文
            clean = re.sub(r'\[(?:\w+ )?\d{4}-\d{2}-\d{2} \d{2}:\d{2} GMT\+8\]', '', text).strip()
            clean = re.sub(r'Current time:[^\n/]+', '', clean).strip()

            all_msgs.append({"ts": ts_dt, "text": clean or "对话"})

    if not all_msgs:
        return []

    # 去重（同文件同时间戳可能重复）
    seen_ts = set()
    unique_msgs = []
    for msg in sorted(all_msgs, key=lambda x: x["ts"]):
        key = msg["ts"].isoformat()
        if key not in seen_ts:
            seen_ts.add(key)
            unique_msgs.append(msg)
    all_msgs = unique_msgs

    # 按间隔分组
    groups = []
    cur = [all_msgs[0]]
    for msg in all_msgs[1:]:
        gap = (msg["ts"] - cur[-1]["ts"]).total_seconds()
        if gap > GAP_THRESHOLD:
            groups.append(cur)
            cur = [msg]
        else:
            cur.append(msg)
    groups.append(cur)

    records = []
    for g in groups:
        start = g[0]["ts"]
        end = g[-1]["ts"]
        # 时长 = 首末差 + 每条 60s（AI 回复时间）
        duration = int((end - start).total_seconds()) + len(g) * 60
        if duration < 60:
            continue

        all_text = " ".join(m["text"] for m in g)
        task = _infer_task_from_text(all_text)

        records.append({
            "timestamp": start.isoformat(),
            "url": "raika://chat",
            "title": f"与 Raika 对话（{len(g)} 条消息）",
            "durationSeconds": duration,
            "category": "raika",
            "label": f"🤖 Raika 对话 · {task}",
            "key": f"raika:{task}",
            "task": task,
            "reason": "session-log"
        })

    return records


# 任务关键词映射（可扩展）
TASK_KEYWORDS = {
    "time-tracker": ["时间追踪", "time track", "时间日报", "chrome插件", "chrome extension", "tracking"],
    "skill 开发": ["skill", "clawhub", "SKILL.md", "技能"],
    "dashboard": ["dashboard", "任务看板", "jsonbin", "任务", "cron"],
    "渠道工作": ["渠道", "channel", "经理", "工作流"],
    "数据分析": ["sql", "bi", "数据", "取数", "指标", "看板数据"],
}

def _infer_task_from_text(text):
    text_lower = text.lower()
    for task, keywords in TASK_KEYWORDS.items():
        if any(kw.lower() in text_lower for kw in keywords):
            return task
    return "其他对话"


# ─── 时间数据分析 ─────────────────────────────────────────────

def get_today_str():
    return datetime.now(CST).strftime("%Y-%m-%d")

def normalize_record(r):
    """统一 compact 格式（字段缩写）和旧格式为标准格式"""
    if "ts" in r:
        # compact 格式
        return {
            "timestamp":       r.get("ts", ""),
            "durationSeconds": r.get("d", 0),
            "category":        r.get("c", "unknown"),
            "key":             r.get("k", ""),
            "label":           r.get("lb", r.get("k", "")),
            "reason":          r.get("rz", ""),
        }
    return r  # 旧格式，原样返回

def get_records_for_date(data, date_str=None):
    """获取指定日期的所有记录，兼容 compact 和旧格式"""
    if date_str is None:
        date_str = get_today_str()
    records = data.get("records", [])
    result = []
    for r in records:
        r = normalize_record(r)
        ts = r.get("timestamp", "")
        try:
            dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            dt_cst = dt.astimezone(CST)
            if dt_cst.strftime("%Y-%m-%d") == date_str:
                result.append(r)
        except Exception:
            pass
    return result

def classify_by_task(records, tasks):
    """尝试将记录关联到 Task Dashboard 中的任务"""
    def find_task(label, url, title):
        text = f"{label} {url} {title}".lower()
        for task in tasks:
            if any(kw.lower() in text for kw in task.split()):
                return task
        return None
    
    classified = []
    for r in records:
        task = find_task(r.get("label",""), r.get("url",""), r.get("title",""))
        classified.append({**r, "task": task})
    return classified

def aggregate_by_category(records):
    """按类别和标签汇总时间（用 key 聚合，展示最新 label）"""
    cat_map = defaultdict(lambda: {"totalSeconds": 0, "items": defaultdict(lambda: {"seconds": 0, "label": ""})})

    CATEGORY_NAMES = {
        "redoc": "📄 写文档 (REDoc)",
        "hi-im": "💬 Hi 沟通",
        "xhs-internal": "🏢 内部系统",
        "github": "💻 GitHub",
        "web": "🌐 其他网页",
        "raika": "🤖 与 Raika 对话",
        "unknown": "❓ 未知"
    }

    for r in records:
        cat = r.get("category", "unknown")
        # 优先用 key 聚合，key 不存在则降级到 label
        key = r.get("key") or r.get("label") or r.get("url", "未知")
        label = r.get("label") or key
        dur = r.get("durationSeconds", 0)
        cat_map[cat]["totalSeconds"] += dur
        cat_map[cat]["items"][key]["seconds"] += dur
        # 保留最新/最长的 label 作为展示名
        if label:
            cat_map[cat]["items"][key]["label"] = label

    result = []
    for cat, data in sorted(cat_map.items(), key=lambda x: -x[1]["totalSeconds"]):
        top_items = sorted(data["items"].items(), key=lambda x: -x[1]["seconds"])[:3]
        result.append({
            "category": cat,
            "categoryName": CATEGORY_NAMES.get(cat, cat),
            "totalSeconds": data["totalSeconds"],
            "topItems": [{"label": v["label"] or k, "seconds": v["seconds"]} for k, v in top_items]
        })
    return result

def aggregate_by_task(records):
    """按关联任务汇总"""
    task_map = defaultdict(int)
    for r in records:
        task = r.get("task") or "未分类"
        task_map[task] += r.get("durationSeconds", 0)
    return sorted(task_map.items(), key=lambda x: -x[1])

# ─── 格式化输出 ───────────────────────────────────────────────

def fmt_dur(seconds):
    h = seconds // 3600
    m = (seconds % 3600) // 60
    if h > 0:
        return f"{h}h {m}m"
    if m > 0:
        return f"{m}m"
    return f"{seconds}s"

def generate_report(date_str=None):
    """生成日报文本"""
    if date_str is None:
        date_str = get_today_str()
    
    data = jsonbin_get(JSONBIN_URL)
    if not data:
        return "❌ 无法读取时间数据，请检查 GitHub Token 配置"
    
    records = get_records_for_date(data, date_str)
    raika_records = get_raika_session_records(date_str)

    if not records and not raika_records:
        return f"📭 {date_str} 暂无时间追踪数据\n（确认 Chrome 插件已安装并在运行）"

    tasks = extract_tasks_from_dashboard()
    classified = classify_by_task(records, tasks)
    # Raika 对话记录已自带 task 字段，直接合并
    classified = classified + raika_records
    
    total_seconds = sum(r.get("durationSeconds", 0) for r in classified)
    by_category = aggregate_by_category(classified)
    by_task = aggregate_by_task(classified)
    
    lines = []
    lines.append(f"🌸 **{date_str} 时间日报**")
    lines.append(f"⏱ 总追踪时长：**{fmt_dur(total_seconds)}**")
    lines.append("")
    
    # 按类别
    lines.append("**📊 按类别分布**")
    for item in by_category:
        pct = int(item["totalSeconds"] / total_seconds * 100) if total_seconds else 0
        lines.append(f"  {item['categoryName']}：{fmt_dur(item['totalSeconds'])} ({pct}%)")
        for sub in item["topItems"][:2]:
            lines.append(f"    └ {sub['label'][:40]}：{fmt_dur(sub['seconds'])}")
    
    lines.append("")
    
    # 按任务（如果有）
    if tasks:
        lines.append("**✅ 按任务分布**")
        for task, secs in by_task[:6]:
            pct = int(secs / total_seconds * 100) if total_seconds else 0
            lines.append(f"  • {task}：{fmt_dur(secs)} ({pct}%)")
        lines.append("")
    
    # 今日 Top 5 页面（用 key 聚合，展示 label）
    page_map = defaultdict(lambda: {"seconds": 0, "label": ""})
    for r in classified:
        key = r.get("key") or r.get("label") or r.get("url", "?")
        label = r.get("label") or key
        page_map[key]["seconds"] += r.get("durationSeconds", 0)
        if label:
            page_map[key]["label"] = label
    top_pages = sorted(page_map.items(), key=lambda x: -x[1]["seconds"])[:5]

    lines.append("**🔝 停留最久的页面/任务**")
    for i, (key, v) in enumerate(top_pages, 1):
        lines.append(f"  {i}. {v['label'][:48]}：{fmt_dur(v['seconds'])}")
    
    return "\n".join(lines)

# ─── CLI 入口 ─────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Raika Time Tracker Analyzer")
    parser.add_argument("--date", default=None, help="分析日期 YYYY-MM-DD，默认今天")
    parser.add_argument("--json", action="store_true", help="输出 JSON 格式")
    args = parser.parse_args()
    
    if args.json:
        data = jsonbin_get(JSONBIN_URL)
        if not data:
            print(json.dumps({"error": "Failed to fetch data"}, ensure_ascii=False))
            sys.exit(1)
        records = get_records_for_date(data, args.date)
        tasks = extract_tasks_from_dashboard()
        classified = classify_by_task(records, tasks)
        by_cat = aggregate_by_category(classified)
        by_task = aggregate_by_task(classified)
        print(json.dumps({
            "date": args.date or get_today_str(),
            "totalRecords": len(records),
            "totalSeconds": sum(r.get("durationSeconds",0) for r in records),
            "byCategory": by_cat,
            "byTask": [{"task": t, "seconds": s} for t, s in by_task]
        }, ensure_ascii=False, indent=2))
    else:
        print(generate_report(args.date))
