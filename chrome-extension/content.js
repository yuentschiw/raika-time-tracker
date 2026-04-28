// content.js v3 — 只有页面可见+聚焦时才上报时间
// 解决多窗口误追踪问题

(function () {
  let accumulatedSeconds = 0;
  let tickInterval = null;
  let isReporting = false;
  let isPageVisible = false;
  let isPageFocused = false;

  // ── 检查页面是否应该被追踪 ──
  function shouldTrack() {
    return document.visibilityState === "visible" && document.hasFocus();
  }

  // ── 启动计时 ──
  function startTracking() {
    if (tickInterval) return; // 已经在计时
    isPageVisible = document.visibilityState === "visible";
    isPageFocused = document.hasFocus();
    if (!shouldTrack()) return;

    // 通知 background：页面获得聚焦
    chrome.runtime.sendMessage({
      type: "PAGE_FOCUSED",
      url: location.href,
      title: document.title
    }).catch(() => {});

    // 每30秒上报一次累积时间
    accumulatedSeconds = 0;
    tickInterval = setInterval(() => {
      accumulatedSeconds += 30;
      // 每60秒上报一次，减少消息量
      if (accumulatedSeconds >= 60 && !isReporting) {
        isReporting = true;
        const seconds = accumulatedSeconds;
        accumulatedSeconds = 0;
        chrome.runtime.sendMessage({
          type: "REPORT_TIME",
          seconds
        }).catch(() => {
          // 如果发送失败，时间还在 accumulatedSeconds 里，下次一起报
          accumulatedSeconds += seconds;
        }).finally(() => {
          isReporting = false;
        });
      }
    }, 30000);
  }

  // ── 停止计时 ──
  function stopTracking() {
    if (!tickInterval) return;
    clearInterval(tickInterval);
    tickInterval = null;

    // 上报剩余累积时间
    if (accumulatedSeconds >= 5) {
      chrome.runtime.sendMessage({
        type: "REPORT_TIME",
        seconds: accumulatedSeconds
      }).catch(() => {});
    }
    accumulatedSeconds = 0;

    // 通知 background：页面失去聚焦
    chrome.runtime.sendMessage({
      type: "PAGE_BLURRED"
    }).catch(() => {});
  }

  // ── 页面可见性变化 ──
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopTracking();
    } else if (document.hasFocus()) {
      startTracking();
    }
  });

  // ── 窗口聚焦变化 ──
  window.addEventListener("focus", () => {
    if (document.visibilityState === "visible") {
      startTracking();
    }
  });

  window.addEventListener("blur", () => {
    stopTracking();
  });

  // ── background 通知：窗口重新获得聚焦 ──
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "WINDOW_REFUSED") {
      // 窗口被聚焦，检查是否应该开始追踪
      if (shouldTrack()) {
        startTracking();
      } else {
        stopTracking();
      }
    }
  });

  // ── 初始化 ──
  if (shouldTrack()) {
    startTracking();
  }
})();
