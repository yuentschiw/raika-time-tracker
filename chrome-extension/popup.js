// popup.js - Raika Time Tracker Popup

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function getToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// 从 background 获取当前计时状态
async function getCurrentSession() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: "GET_STATUS" }, resolve);
  });
}

// 触发立刻上报（通过触发 alarm，兼容 Service Worker 唤醒）
async function forceFlush() {
  return new Promise(resolve => {
    // 先尝试 sendMessage，失败则触发 alarm
    chrome.runtime.sendMessage({ type: "FORCE_FLUSH" }, (r) => {
      if (chrome.runtime.lastError) {
        // Service Worker 已停止，触发 alarm 唤醒
        chrome.alarms.create("flush-now", { delayInMinutes: 0.01 });
      }
      resolve(r);
    });
  });
}

let tickInterval = null;
let currentSeconds = 0;

async function init() {
  const status = await getCurrentSession();
  
  const titleEl = document.getElementById("current-title");
  const timeEl = document.getElementById("current-time");
  const categoryEl = document.getElementById("current-category");
  const pendingBadge = document.getElementById("pending-badge");
  const statsList = document.getElementById("stats-list");

  if (status) {
    titleEl.textContent = status.title || status.url || "未知页面";
    titleEl.title = status.url || "";
    categoryEl.textContent = status.category || "web";
    currentSeconds = status.elapsedSeconds || 0;
    
    if (status.pendingCount > 0) {
      pendingBadge.style.display = "inline-block";
      pendingBadge.textContent = `${status.pendingCount} 待上报`;
    }
    
    // 实时计时器
    if (tickInterval) clearInterval(tickInterval);
    tickInterval = setInterval(() => {
      currentSeconds++;
      timeEl.textContent = formatDuration(currentSeconds);
    }, 1000);
    timeEl.textContent = formatDuration(currentSeconds);
    
    // 今日统计
    if (status.todayStats && status.todayStats.length > 0) {
      const top5 = status.todayStats.slice(0, 5);
      statsList.innerHTML = top5.map(item => `
        <div class="stat-row">
          <span class="name" title="${item.label}">${item.label}</span>
          <span class="dur">${formatDuration(item.totalSeconds)}</span>
        </div>
      `).join("");
    } else {
      statsList.innerHTML = '<div style="font-size:12px;color:#aaa;text-align:center;padding:8px 0">今日暂无记录</div>';
    }
  } else {
    titleEl.textContent = "无法获取状态";
  }
  
  // 上报按钮
  document.getElementById("flush-btn").addEventListener("click", async (e) => {
    e.target.disabled = true;
    e.target.textContent = "上报中...";
    await forceFlush();
    e.target.textContent = "✓ 已上报";
    setTimeout(() => {
      e.target.disabled = false;
      e.target.textContent = "立刻上报数据";
    }, 2000);
  });
}

init();
