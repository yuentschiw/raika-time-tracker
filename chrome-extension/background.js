// Raika Time Tracker - Background Service Worker v2
// 架构：所有状态存 chrome.storage.local，不依赖内存，兼容 SW 随时重启

const JSONBIN_KEY = "$2a$10$ZprY/cMDxkU1VHSX5dEiJ.bppSYR8JXoxx2smTlJwPjOvtYdmh1qy";
const JSONBIN_BIN_ID = "69ddb7dc856a6821892f8a86";
const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;
const FLUSH_INTERVAL_MINUTES = 5;
const MIN_DURATION_SECONDS = 5;
const IDLE_THRESHOLD_SECONDS = 120;

// ─── storage 读写 ─────────────────────────────────────────────

async function getState() {
  const data = await chrome.storage.local.get(["currentSession", "pendingRecords"]);
  return {
    currentSession: data.currentSession || null,   // {tabId, url, title, startMs, category, label}
    pendingRecords: data.pendingRecords || []
  };
}

async function setState(patch) {
  await chrome.storage.local.set(patch);
}

// ─── URL 分类 ─────────────────────────────────────────────────

function classifyUrl(url, title) {
  if (!url) return { category: "unknown", label: title || "未知" };
  try {
    const u = new URL(url);
    const host = u.hostname;
    const path = u.pathname;
    if (["chrome:", "chrome-extension:", "about:", "edge:"].includes(u.protocol)) return null;

    if (host.includes("xiaohongshu.com") && path.match(/\/doc\//)) {
      const docId = path.split("/doc/")[1]?.split("/")[0] || "";
      return { category: "redoc", label: `REDoc: ${title || docId}` };
    }
    if (host.includes("xiaohongshu.com") && path.match(/\/(im|chat)/)) {
      return { category: "hi-im", label: `Hi: ${title || "对话"}` };
    }
    if (host.includes("xiaohongshu.com") || host.includes("xhscdn.com")) {
      return { category: "xhs-internal", label: title || host };
    }
    if (host.includes("github.com")) {
      return { category: "github", label: `GitHub: ${title || path}` };
    }
    return { category: "web", label: title || host };
  } catch {
    return { category: "web", label: title || url };
  }
}

// ─── 结束当前 session，存为 pending record ────────────────────

async function endCurrentSession(reason) {
  const { currentSession, pendingRecords } = await getState();
  if (!currentSession) return;

  const durationSeconds = Math.floor((Date.now() - currentSession.startMs) / 1000);
  if (durationSeconds >= MIN_DURATION_SECONDS) {
    const record = {
      timestamp: new Date().toISOString(),
      url: currentSession.url,
      title: currentSession.title,
      durationSeconds,
      category: currentSession.category,
      label: currentSession.label,
      reason
    };
    pendingRecords.push(record);
    console.log(`[TimeTracker] +record: ${record.label} ${durationSeconds}s`);
    await setState({ currentSession: null, pendingRecords });
  } else {
    await setState({ currentSession: null });
  }
}

// ─── 开始新 session ───────────────────────────────────────────

async function startSession(tabId, url, title) {
  const classified = classifyUrl(url, title);
  if (!classified) return; // 过滤 chrome:// 等

  await setState({
    currentSession: {
      tabId,
      url,
      title,
      startMs: Date.now(),
      category: classified.category,
      label: classified.label
    }
  });
  console.log(`[TimeTracker] start: ${classified.label}`);
}

// ─── Tab 事件 ─────────────────────────────────────────────────

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await endCurrentSession("tab-switch");
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url) await startSession(tabId, tab.url, tab.title);
  } catch (e) {
    console.warn("[TimeTracker] onActivated error:", e.message);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  const { currentSession } = await getState();
  if (currentSession && currentSession.tabId === tabId && changeInfo.url && changeInfo.url !== currentSession.url) {
    await endCurrentSession("navigation");
    await startSession(tabId, tab.url, tab.title);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { currentSession } = await getState();
  if (currentSession && currentSession.tabId === tabId) {
    await endCurrentSession("tab-closed");
  }
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    // 窗口失焦：结束计时（记录当前，等重新获焦再开始）
    await endCurrentSession("window-blur");
  } else {
    // 窗口获焦：找当前活跃 tab 开始计时
    try {
      const [tab] = await chrome.tabs.query({ active: true, windowId });
      if (tab && tab.url) await startSession(tab.id, tab.url, tab.title);
    } catch (e) {}
  }
});

// ─── Idle 检测 ────────────────────────────────────────────────

chrome.idle.setDetectionInterval(IDLE_THRESHOLD_SECONDS);
chrome.idle.onStateChanged.addListener(async (state) => {
  if (state === "idle" || state === "locked") {
    await endCurrentSession("idle");
  } else if (state === "active") {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url) await startSession(tab.id, tab.url, tab.title);
    } catch (e) {}
  }
});

// ─── 定时 flush ───────────────────────────────────────────────

chrome.alarms.create("flush", { periodInMinutes: FLUSH_INTERVAL_MINUTES });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "flush" && alarm.name !== "flush-now") return;
  console.log("[TimeTracker] Alarm:", alarm.name);

  // 先快照当前 session（不结束，只追加一条 snapshot 记录）
  const { currentSession, pendingRecords } = await getState();
  if (currentSession) {
    const elapsed = Math.floor((Date.now() - currentSession.startMs) / 1000);
    if (elapsed >= MIN_DURATION_SECONDS) {
      pendingRecords.push({
        timestamp: new Date().toISOString(),
        url: currentSession.url,
        title: currentSession.title,
        durationSeconds: elapsed,
        category: currentSession.category,
        label: currentSession.label,
        reason: "snapshot"
      });
      // 重置 session 起点
      await setState({
        currentSession: { ...currentSession, startMs: Date.now() },
        pendingRecords
      });
    }
  }

  await flush();
});

// ─── Flush 到 JSONBin ─────────────────────────────────────────

async function flush() {
  const { pendingRecords } = await getState();
  if (pendingRecords.length === 0) {
    console.log("[TimeTracker] Nothing to flush");
    return;
  }

  console.log(`[TimeTracker] Flushing ${pendingRecords.length} records...`);

  try {
    // 读取现有数据
    const getResp = await fetch(JSONBIN_URL + "/latest", {
      headers: { "X-Master-Key": JSONBIN_KEY }
    });
    const getJson = await getResp.json();
    const existing = getJson.record?.records || [];

    // 合并，只保留30天
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    const merged = [...existing, ...pendingRecords]
      .filter(r => new Date(r.timestamp).getTime() > cutoff);

    const putResp = await fetch(JSONBIN_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Master-Key": JSONBIN_KEY },
      body: JSON.stringify({ records: merged, lastUpdated: new Date().toISOString() })
    });

    if (putResp.ok) {
      console.log(`[TimeTracker] ✅ Flushed ${pendingRecords.length} records`);
      await setState({ pendingRecords: [] });
    } else {
      console.error("[TimeTracker] PUT failed:", await putResp.text());
    }
  } catch (e) {
    console.error("[TimeTracker] Flush error:", e);
  }
}

// ─── Popup 消息 ───────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "PING") {
    // 心跳：SW 保持活跃，顺便检查是否需要快照
    getState().then(async ({ currentSession, pendingRecords }) => {
      if (currentSession) {
        const elapsed = Math.floor((Date.now() - currentSession.startMs) / 1000);
        // 每5分钟做一次快照
        if (elapsed >= 300) {
          pendingRecords.push({
            timestamp: new Date().toISOString(),
            url: currentSession.url,
            title: currentSession.title,
            durationSeconds: elapsed,
            category: currentSession.category,
            label: currentSession.label,
            reason: "ping-snapshot"
          });
          await setState({
            currentSession: { ...currentSession, startMs: Date.now() },
            pendingRecords
          });
          console.log(`[TimeTracker] ping-snapshot: ${currentSession.label} ${elapsed}s`);
          // 积累超过10条就 flush
          if (pendingRecords.length >= 10) await flush();
        }
      }
      sendResponse({ ok: true, elapsed: currentSession ? Math.floor((Date.now() - currentSession.startMs) / 1000) : 0 });
    });
    return true;
  }

  if (msg.type === "GET_STATUS") {
    getState().then(({ currentSession, pendingRecords }) => {
      const elapsed = currentSession
        ? Math.floor((Date.now() - currentSession.startMs) / 1000)
        : 0;

      // 今日统计
      const today = new Date().toISOString().split("T")[0];
      const todayMap = {};
      for (const r of pendingRecords.filter(r => r.timestamp.startsWith(today))) {
        const k = r.label || r.url;
        todayMap[k] = (todayMap[k] || 0) + r.durationSeconds;
      }
      const todayStats = Object.entries(todayMap)
        .map(([label, totalSeconds]) => ({ label, totalSeconds }))
        .sort((a, b) => b.totalSeconds - a.totalSeconds);

      sendResponse({
        url: currentSession?.url,
        title: currentSession?.title,
        category: currentSession?.category,
        label: currentSession?.label,
        elapsedSeconds: elapsed,
        pendingCount: pendingRecords.length,
        todayStats
      });
    });
    return true;
  }

  if (msg.type === "FORCE_FLUSH") {
    flush().then(() => sendResponse({ ok: true }));
    return true;
  }
});

// ─── 启动 ─────────────────────────────────────────────────────

async function init() {
  console.log("[TimeTracker] Service Worker started");
  // 找当前活跃 tab
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) await startSession(tab.id, tab.url, tab.title);
  } catch (e) {}
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
init(); // SW 每次唤醒都执行
