---
name: time-tracker
description: 时间追踪与任务时长分析 Skill。追踪用户每天在哪些网页/REDoc文档/Hi对话上花了多少时间，结合 Task Dashboard 进行任务分类，每天19:00 Hi推送日报。当用户问"我今天时间怎么分配的"、"我在XX任务上花了多久"、"时间统计"、"时间日报"，或想查看/分析时间追踪数据时使用此 skill。
---

# Time Tracker Skill

追踪芸汐每天工作时间分配，数据来源：Chrome 插件（网页停留）+ Hi 对话分析 + Session 日志。

## 数据流

```
Chrome插件 → GitHub: time-tracking-data.json
Raika      → 分析 → 结合 Task Dashboard 任务分类
每天19:00  → Hi 推送日报
```

## Chrome 插件安装

插件位于 `assets/chrome-extension/`，需要手动配置 GitHub Token：

1. 打开 `background.js`，第 4 行填入 GitHub Token
2. Chrome → 扩展程序 → 开发者模式 → 加载已解压扩展
3. 选择 `assets/chrome-extension/` 目录

插件每5分钟自动同步到 GitHub `time-tracking-data.json`。

## 分析脚本

```bash
# 今日报告
GITHUB_TOKEN=xxx python3 scripts/analyze_time.py

# 指定日期
GITHUB_TOKEN=xxx python3 scripts/analyze_time.py --date 2026-04-14

# JSON格式（供 Raika 处理）
GITHUB_TOKEN=xxx python3 scripts/analyze_time.py --json
```

脚本自动读取 `~/.openclaw/workspace/dashboard-config.json` 中的 `github_token`。

## Raika 日常操作

**查询今日时间分配：**
1. 运行 `scripts/analyze_time.py`
2. 解读并补充 Hi 对话分析（通过 hi-search skill 拉取今日消息摘要）
3. 与 Task Dashboard 任务关联

**每日19:00 Hi 日报格式：**
- 总追踪时长
- 按类别（文档/沟通/系统/网页）分布
- 按任务分布（关联 Dashboard）
- Top 5 停留页面
- 简短建议（如某类任务占比异常高）

## 数据存储

- GitHub: `yuentschiw/personal-task-dashboard/time-tracking-data.json`
- 保留最近30天
- 与 Task Dashboard 共享 GitHub Token（`dashboard-config.json`）

## URL 分类规则

| 类别 | 识别规则 |
|------|---------|
| redoc | xiaohongshu.com/doc/* |
| hi-im | xiaohongshu.com/im 或 /chat |
| xhs-internal | *.xiaohongshu.com 其他路径 |
| github | github.com |
| web | 其他域名 |
