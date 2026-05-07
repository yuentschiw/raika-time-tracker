// Raika Time Tracker - Background Service Worker v4.1
// 策略：仅追踪「当前聚焦窗口」的 active tab，解决多窗口误追踪

const JSONBIN_KEY = "$2a$10$ZprY/cMDxkU1VHSX5dEiJ.bppSYR8JXoxx2smTlJwPjOvtYdmh1qy";
const JSONBIN_BIN_ID = "69ddb7dc856a6821892f8a86";
const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;
const FLUSH_INTERVAL_MINUTES = 5;
const MIN_DURATION_SECONDS = 10;
const IDLE_THRESHOLD_SECONDS = 120;

// ─── 当前聚焦的 windowId ──────────────────────────────────────
let focusedWindowId = chrome.windows.WINDOW_ID_NONE;

// ─── storage 读写 ─────────────────────────────────────────────
async function getState() {
  const data = await chrome.storage.local.get(["currentSession", "pendingRecords"]);
  return {
    currentSession: data.currentSession || null,
    pendingRecords: data.pendingRecords || []
  };
}
async function setState(patch) {
  await chrome.storage.local.set(patch);
}

// ─── URL 分类 ─────────────────────────────────────────────────
function classifyUrl(url, title) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname;
    const path = u.pathname;
    if (["chrome:", "chrome-extension:", "about:", "edge:"].includes(u.protocol)) return null;
    if (host.includes("xiaohongshu.com") && path.match(/\/doc\//)) {
      return { category: "redoc", label: `REDoc: ${title || path}` };
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
    if (host.includes("feishu.cn") || host.includes("larksuite.com")) {
      return { category: "feishu", label: `飞书: ${title || host}` };
    }
    return { category: "web", label: title || host };
  } catch { return null; }
}

// ─── 结束当前 session ─────────────────────────────────────────
async function endCurrentSession(reason) {
  const { currentSession, pendingRecords } = await getState();
  if (!currentSession) return;
  const durationSeconds = Math.floor((Date.now() - currentSession.startMs) / 1000);
  if (durationSeconds >= MIN_DURATION_SECONDS) {
    pendingRecords.push({
      timestamp: new Date().toISOString(),
      url: currentSession.url,
      title: currentSession.title,
      durationSeconds,
      category: currentSession.category,
      label: currentSession.label,
      reason
    });
    console.log(`[TT] -${durationSeconds}s (${reason}): ${currentSession.label}`);
    await setState({ currentSession: null, pendingRecords });
  } else {
    await setState({ currentSession: null });
  }
}

// ─── 开始新 session ───────────────────────────────────────────
async function startSession(tab) {
  if (!tab || !tab.url) return;
  const classified = classifyUrl(tab.url, tab.title);
  if (!classified) return;
  await setState({
    currentSession: {
      tabId: tab.id,
      windowId: tab.windowId,
      url: tab.url,
      title: tab.title,
      startMs: Date.now(),
      category: classified.category,
      label: classified.label
    }
  });
  console.log(`[TT] +start: ${classified.label}`);
}

// ─── 核心：切换到指定窗口的当前 active tab ───────────────────
async function switchToFocusedWindowTab(windowId) {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    await endCurrentSession("window-blur");
    return;
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (!tab) return;
    const { currentSession } = await getState();
    // 如果已经在追踪这个 tab，不做任何事
    if (currentSession && currentSession.tabId === tab.id && currentSession.url === tab.url) return;
    await endCurrentSession("focus-change");
    await startSession(tab);
  } catch (e) {
    console.warn("[TT] switchToFocusedWindowTab error:", e.message);
  }
}

// ─── 窗口聚焦变化（核心：多窗口问题在这里解决）─────────────
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  focusedWindowId = windowId;
  await switchToFocusedWindowTab(windowId);
});

// ─── Tab 切换（只处理当前聚焦窗口）──────────────────────────
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  // 如果不是当前聚焦窗口，忽略
  if (windowId !== focusedWindowId) return;
  await endCurrentSession("tab-switch");
  try {
    const tab = await chrome.tabs.get(tabId);
    await startSession(tab);
  } catch (e) {}
});

// ─── Tab 内容更新（页面跳转）────────────────────────────────
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  const { currentSession } = await getState();
  if (!currentSession || currentSession.tabId !== tabId) return;
  if (tab.windowId !== focusedWindowId) return;
  if (changeInfo.url && changeInfo.url !== currentSession.url) {
    await endCurrentSession("navigation");
    await startSession(tab);
  }
});

// ─── Tab 关闭 ────────────────────────────────────────────────
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { currentSession } = await getState();
  if (currentSession && currentSession.tabId === tabId) {
    await endCurrentSession("tab-closed");
  }
});

// ─── Idle 检测 ────────────────────────────────────────────────
chrome.idle.setDetectionInterval(IDLE_THRESHOLD_SECONDS);
chrome.idle.onStateChanged.addListener(async (state) => {
  if (state === "idle" || state === "locked") {
    await endCurrentSession("idle");
  } else if (state === "active") {
    await switchToFocusedWindowTab(focusedWindowId);
  }
});

// ─── 定时 snapshot + flush ────────────────────────────────────
chrome.alarms.create("flush", { periodInMinutes: FLUSH_INTERVAL_MINUTES });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "flush" && alarm.name !== "flush-now") return;
  // snapshot 当前 session
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
  if (pendingRecords.length === 0) return;
  try {
    // 读取现有数据
    const getResp = await fetch(JSONBIN_URL + "/latest", { headers: { "X-Master-Key": JSONBIN_KEY } });
    const getJson = await getResp.json();
    const existing = getJson.record?.records || [];

    // 去重 + 30天过滤 + 只保留最近 300 条（防止 payload 超限）
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    const merged = [...existing, ...pendingRecords]
      .filter(r => new Date(r.timestamp || r.ts).getTime() > cutoff)
      .sort((a, b) => new Date(a.timestamp || a.ts) - new Date(b.timestamp || b.ts))
      .slice(-300);  // 只保留最新 300 条，防止超出 JSONBin 单次大小限制

    const body = JSON.stringify({ records: merged, lastUpdated: new Date().toISOString() });
    console.log(`[TT] flush payload: ${(body.length / 1024).toFixed(1)}KB, ${merged.length} records`);

    const putResp = await fetch(JSONBIN_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Master-Key": JSONBIN_KEY },
      body
    });
    if (putResp.ok) {
      console.log(`[TT] ✅ flushed ${pendingRecords.length} pending records`);
      await setState({ pendingRecords: [] });
    } else {
      const errText = await putResp.text();
      console.error(`[TT] PUT failed ${putResp.status}:`, errText.slice(0, 200));
    }
  } catch (e) { console.error("[TT] flush error:", e); }
}

// ─── Popup 消息 ───────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "PING") {
    getState().then(({ currentSession }) => {
      sendResponse({ ok: true, elapsed: currentSession ? Math.floor((Date.now() - currentSession.startMs) / 1000) : 0 });
    });
    return true;
  }
  if (msg.type === "GET_STATUS") {
    getState().then(({ currentSession, pendingRecords }) => {
      const elapsed = currentSession ? Math.floor((Date.now() - currentSession.startMs) / 1000) : 0;
      const today = new Date().toISOString().split("T")[0];
      const todayMap = {};
      for (const r of pendingRecords.filter(r => (r.timestamp || r.ts || "").startsWith(today))) {
        const k = r.label || r.url;
        todayMap[k] = (todayMap[k] || 0) + (r.durationSeconds || r.d || 0);
      }
      const todayStats = Object.entries(todayMap).map(([label, totalSeconds]) => ({ label, totalSeconds })).sort((a, b) => b.totalSeconds - a.totalSeconds);
      sendResponse({ url: currentSession?.url, title: currentSession?.title, category: currentSession?.category, label: currentSession?.label, elapsedSeconds: elapsed, pendingCount: pendingRecords.length, todayStats });
    });
    return true;
  }
  if (msg.type === "FORCE_FLUSH") {
    flush().then(() => sendResponse({ ok: true }));
    return true;
  }
});

// ─── 启动 ────────────────────────────────────────────────────
async function init() {
  console.log("[TT] Service Worker v4 started");
  // 找当前聚焦窗口
  try {
    const win = await chrome.windows.getLastFocused({ populate: false });
    if (win && win.id) {
      focusedWindowId = win.id;
      await switchToFocusedWindowTab(win.id);
    }
  } catch (e) {}
}
chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
init();
