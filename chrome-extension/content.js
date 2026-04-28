// content.js v4 - 仅保持 Service Worker 活跃
(function () {
  let interval = null;
  function ping() {
    chrome.runtime.sendMessage({ type: "PING" }, () => {
      if (chrome.runtime.lastError) { clearInterval(interval); interval = null; }
    });
  }
  function start() { if (!interval) { interval = setInterval(ping, 25000); ping(); } }
  function stop() { if (interval) { clearInterval(interval); interval = null; } }
  document.addEventListener("visibilitychange", () => document.hidden ? stop() : start());
  if (!document.hidden) start();
})();
