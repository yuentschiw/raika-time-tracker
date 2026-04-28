// Raika Time Tracker - Background Service Worker v3
// 架构：由 content script 驱动计时（页面可见+聚焦），解决多窗口误追踪问题

const JSONBIN_KEY = "$2a$10$ZprY/cMDxkU1VHSX5dEiJ.bppSYR8JXoxx2smTlJwPjOvtYdmh1qy";
const JSONBIN_BIN_ID = "69ddb7dc856a6821892f8a86";
const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;
const FLUSH_INTERVAL_MINUTES = 5;
const MIN_DURATION_SECONDS = 5;

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
    if (host.includes("feishu.cn") || host.includes("feishu.net") || host.includes("larksuite.com")) {
      return { category: "feishu", label: title || host };
    }
    return { category: "web", label: title || host };
  } catch {
    return { category: "web", label: title || url };
  }
}

// ─── Content script 驱动的计时 ─────────────────────────────────
// 只有页面 visible + focused 才累积时间，解决多窗口问题

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ── content script: 页面获得焦点（可见+聚焦）──
  if (msg.type === "PAGE_FOCUSED") {
    (async () => {
      const { currentSession } = await getState();
      const classified = classifyUrl(msg.url, msg.title);
      if (!classified) return;

      // 如果是同一个页面重新聚焦，不新建 session
      if (currentSession && currentSession.url === msg.url) return;

      // 不同页面 → 结束旧 session，开始新的
      if (currentSession) {
        await endCurrentSession("page-blur");
      }

      await setState({
        currentSession: {
          tabId: sender.tab?.id,
          url: msg.url,
          title: msg.title,
          startMs: Date.now(),
          category: classified.category,
          label: classified.label
        }
      });
      console.log(`[TimeTracker] focused: ${classified.label}`);
    })();
    sendResponse({ ok: true });
    return true;
  }

  // ── content script: 页面失去焦点（切走/切 tab/最小化）──
  if (msg.type === "PAGE_BLURRED") {
    (async () => {
      await endCurrentSession("page-blur");
    })();
    sendResponse({ ok: true });
    return true;
  }

  // ── content script: 上报累积的秒数 ──
  if (msg.type === "REPORT_TIME") {
    (async () => {
      const seconds = msg.seconds || 0;
      if (seconds < MIN_DURATION_SECONDS) return;

      const { currentSession, pendingRecords } = await getState();
      if (!currentSession) return;

      const record = {
        ts: new Date().toISOString(),
        d: seconds,
        c: currentSession.category,
        k: currentSession.url,
        lb: currentSession.label,
        rz: "focus-track"
      };
      pendingRecords.push(record);
      console.log(`[TimeTracker] +${seconds}s: ${currentSession.label}`);
      await setState({ pendingRecords });

      // 积累超过10条就 flush
      if (pendingRecords.length >= 10) await flush();
    })();
    sendResponse({ ok: true });
    return true;
  }

  // ── 窗口聚焦变化：通知所有 content script ──
  if (msg.type === "WINDOW_FOCUS") {
    (async () => {
      const { currentSession } = await getState();
      if (msg.focused && currentSession) {
        // 窗口获得聚焦，通知 content script 重新检查
        try {
          const [tab] = await chrome.tabs.query({ active: true, windowId: msg.windowId });
          if (tab) {
            chrome.tabs.sendMessage(tab.id, { type: "WINDOW_REFUSED" }).catch(() => {});
          }
        } catch (e) {}
      }
    })();
    sendResponse({ ok: true });
    return true;
  }

  // ── popup: ping / get status / force flush ──
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
      for (const r of pendingRecords.filter(r => r.ts && r.ts.startsWith(today))) {
        const k = r.lb || r.k;
        todayMap[k] = (todayMap[k] || 0) + r.d;
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

// ─── 结束当前 session ───────────────────────────────────────────

async function endCurrentSession(reason) {
  const { currentSession, pendingRecords } = await getState();
  if (!currentSession) return;

  const durationSeconds = Math.floor((Date.now() - currentSession.startMs) / 1000);
  if (durationSeconds >= MIN_DURATION_SECONDS) {
    const record = {
      ts: new Date().toISOString(),
      d: durationSeconds,
      c: currentSession.category,
      k: currentSession.url,
      lb: currentSession.label,
      rz: "session-end"
    };
    pendingRecords.push(record);
    console.log(`[TimeTracker] end: ${currentSession.label} ${durationSeconds}s`);
    await setState({ currentSession: null, pendingRecords });
  } else {
    await setState({ currentSession: null });
  }
}

// ─── 窗口聚焦事件：通知 content script ──────────────────────────

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    // 所有窗口失焦：结束当前 session
    await endCurrentSession("window-blur");
  } else {
    // 窗口获得聚焦：通知该窗口的 content script 重新检查
    try {
      const [tab] = await chrome.tabs.query({ active: true, windowId });
      if (tab) {
        chrome.tabs.sendMessage(tab.id, { type: "WINDOW_REFUSED" }).catch(() => {});
      }
    } catch (e) {}
  }
});

// ─── Idle 检测 ────────────────────────────────────────────────

chrome.idle.setDetectionInterval(60);
chrome.idle.onStateChanged.addListener(async (state) => {
  if (state === "idle" || state === "locked") {
    await endCurrentSession("idle");
  }
});

// ─── 定时 flush ───────────────────────────────────────────────

chrome.alarms.create("flush", { periodInMinutes: FLUSH_INTERVAL_MINUTES });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "flush" && alarm.name !== "flush-now") return;
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
    const getResp = await fetch(JSONBIN_URL + "/latest", {
      headers: { "X-Master-Key": JSONBIN_KEY }
    });
    const getJson = await getResp.json();
    const existing = getJson.record?.records || [];

    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    const merged = [...existing, ...pendingRecords]
      .filter(r => {
        const ts = r.ts || r.timestamp;
        return ts && new Date(ts).getTime() > cutoff;
      });

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

// ─── 启动 ─────────────────────────────────────────────────────

async function init() {
  console.log("[TimeTracker] Service Worker started v3");
  // 清空旧 session，等 content script 报告
  await setState({ currentSession: null });
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
init();
