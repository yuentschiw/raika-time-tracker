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

# ─── 时间数据分析 ─────────────────────────────────────────────

def get_today_str():
    return datetime.now(CST).strftime("%Y-%m-%d")

def get_records_for_date(data, date_str=None):
    """获取指定日期的所有记录"""
    if date_str is None:
        date_str = get_today_str()
    records = data.get("records", [])
    result = []
    for r in records:
        ts = r.get("timestamp", "")
        # 转换为CST
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
    """按类别和标签汇总时间"""
    cat_map = defaultdict(lambda: {"totalSeconds": 0, "items": defaultdict(int)})
    
    CATEGORY_NAMES = {
        "redoc": "📄 写文档 (REDoc)",
        "hi-im": "💬 Hi 沟通",
        "xhs-internal": "🏢 内部系统",
        "github": "💻 GitHub",
        "web": "🌐 其他网页",
        "unknown": "❓ 未知"
    }
    
    for r in records:
        cat = r.get("category", "unknown")
        label = r.get("label", r.get("url", "未知"))
        dur = r.get("durationSeconds", 0)
        cat_map[cat]["totalSeconds"] += dur
        cat_map[cat]["items"][label] += dur
    
    result = []
    for cat, data in sorted(cat_map.items(), key=lambda x: -x[1]["totalSeconds"]):
        top_items = sorted(data["items"].items(), key=lambda x: -x[1])[:3]
        result.append({
            "category": cat,
            "categoryName": CATEGORY_NAMES.get(cat, cat),
            "totalSeconds": data["totalSeconds"],
            "topItems": [{"label": l, "seconds": s} for l, s in top_items]
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
    
    if not records:
        return f"📭 {date_str} 暂无时间追踪数据\n（确认 Chrome 插件已安装并在运行）"
    
    tasks = extract_tasks_from_dashboard()
    classified = classify_by_task(records, tasks)
    
    total_seconds = sum(r.get("durationSeconds", 0) for r in records)
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
    
    # 今日 Top 5 页面
    page_map = defaultdict(int)
    for r in records:
        label = r.get("label", r.get("title", r.get("url", "?"))[:50])
        page_map[label] += r.get("durationSeconds", 0)
    top_pages = sorted(page_map.items(), key=lambda x: -x[1])[:5]
    
    lines.append("**🔝 停留最久的页面**")
    for i, (label, secs) in enumerate(top_pages, 1):
        lines.append(f"  {i}. {label[:45]}：{fmt_dur(secs)}")
    
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
