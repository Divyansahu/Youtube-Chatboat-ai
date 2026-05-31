/**
 * popup.js — Logic for the extension popup
 * ─────────────────────────────────────────────────────────────────────────────
 * Responsibilities:
 *  1. Show the active tab's video info (if on YouTube).
 *  2. Display configured backend URL.
 *  3. Provide a "Ping Backend" button to test connectivity.
 *  4. Open YouTube when user clicks "Open YouTube".
 * ─────────────────────────────────────────────────────────────────────────────
 */

document.addEventListener("DOMContentLoaded", async () => {
  // ── Display the backend URL from config ──────────────────────────────────
  document.getElementById("backend-url-text").textContent =
    CONFIG.BACKEND_BASE_URL;

  // ── Get the currently active tab ─────────────────────────────────────────
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (activeTab?.url?.includes("youtube.com/watch")) {
    const videoId = new URL(activeTab.url).searchParams.get("v");
    if (videoId) {
      // Show video section
      document.getElementById("current-video-section").classList.remove("hidden");
      document.getElementById("current-id").textContent = `ID: ${videoId}`;
      document.getElementById("current-thumb").src =
        `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;

      // Try to get the title from the tab
      const title = activeTab.title?.replace(" - YouTube", "").trim() || videoId;
      document.getElementById("current-title").textContent = title;

      // Status: on YouTube
      setStatus("youtube", "Active on YouTube", "Chat panel is available");
    }
  } else if (activeTab?.url?.includes("youtube.com")) {
    setStatus("partial", "On YouTube", "Navigate to a video to start chatting");
  } else {
    setStatus("idle", "Not on YouTube", "Open a YouTube video to chat");
  }

  // ── "Open YouTube" button ─────────────────────────────────────────────────
  document.getElementById("btn-open-yt").addEventListener("click", () => {
    chrome.tabs.create({ url: "https://www.youtube.com" });
    window.close();
  });

  // ── "Ping Backend" button ─────────────────────────────────────────────────
  document.getElementById("btn-ping").addEventListener("click", pingBackend);
});

// ── Update popup status display ───────────────────────────────────────────
function setStatus(state, title, sub) {
  const dot = document.getElementById("status-dot");
  const titleEl = document.getElementById("status-title");
  const subEl = document.getElementById("status-sub");
  const backendDot = document.getElementById("backend-status-dot");

  titleEl.textContent = title;
  subEl.textContent = sub || "";

  // Reset classes
  dot.className = "";
  backendDot.className = "";

  switch (state) {
    case "youtube":
      dot.classList.add("dot-youtube");
      backendDot.classList.add("dot-youtube");
      break;
    case "partial":
      dot.style.background = "#f59e0b";
      break;
    case "idle":
    default:
      break;
  }
}

// ── Ping the backend to check connectivity ────────────────────────────────
async function pingBackend() {
  const resultEl = document.getElementById("ping-result");
  const pingBtn = document.getElementById("btn-ping");
  const textEl = document.getElementById("ping-result-text");
  const backendDot = document.getElementById("backend-status-dot");

  resultEl.classList.remove("hidden", "success", "error");
  textEl.textContent = "Pinging backend…";
  resultEl.classList.remove("hidden");
  pingBtn.disabled = true;

  const url = CONFIG.BACKEND_BASE_URL;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    const t0 = performance.now();
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timer);

    const elapsed = Math.round(performance.now() - t0);
    resultEl.classList.add("success");
    backendDot.classList.add("dot-online");
    textEl.textContent = `✓ Backend reachable (${response.status}) · ${elapsed}ms`;
  } catch (err) {
    const msg =
      err.name === "AbortError"
        ? "Timeout – no response within 5 seconds"
        : `Unreachable: ${err.message}`;
    resultEl.classList.add("error");
    backendDot.classList.add("dot-offline");
    textEl.textContent = `✗ ${msg}`;
  } finally {
    pingBtn.disabled = false;
  }
}
