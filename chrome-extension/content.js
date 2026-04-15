// content.js - 页面心跳，防止 Service Worker idle
// 每25秒 ping 一次 background，让 SW 保持活跃

(function () {
  let interval = null;

  function ping() {
    chrome.runtime.sendMessage({ type: "PING" }, (resp) => {
      if (chrome.runtime.lastError) {
        // SW 已死，停止 ping（它会在下次 tab 事件时自动重启）
        clearInterval(interval);
        interval = null;
      }
    });
  }

  // 页面可见时才 ping
  function startPing() {
    if (interval) return;
    interval = setInterval(ping, 25000);
    ping(); // 立刻 ping 一次
  }

  function stopPing() {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopPing();
    } else {
      startPing();
    }
  });

  if (!document.hidden) {
    startPing();
  }
})();
