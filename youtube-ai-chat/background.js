/**
 * background.js — Service Worker (Manifest V3)
 * ─────────────────────────────────────────────────────────────────────────────
 * Responsibilities:
 *  1. Listen for tab updates to detect YouTube watch pages.
 *  2. Relay messages between content script ↔ popup.
 *  3. Call the backend /process-video endpoint when a new video is detected.
 *  4. Cache which video IDs have already been processed to avoid re-sends.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// import CONFIG from "./constants.js"; // Note: background.js uses ES module import
importScripts('constants.js');

// ── In-memory set of video IDs already sent to backend in this session ──────
const processedVideos = new Set();

// ── Helper: extract video ID from a YouTube URL ──────────────────────────────
function extractVideoId(url) {
  try {
    const urlObj = new URL(url);
    if (urlObj.hostname.includes("youtube.com") && urlObj.pathname === "/watch") {
      return urlObj.searchParams.get("v") || null;
    }
  } catch (_) {}
  return null;
}

// ── Helper: POST to /process-video with a timeout ───────────────────────────
async function processVideo(videoId) {
  if (processedVideos.has(videoId)) {
    console.log(`[YT AI Chat] Video ${videoId} already processed this session.`);
    return { success: true, cached: true };
  }

  const url = `${CONFIG.BACKEND_BASE_URL}${CONFIG.ENDPOINTS.PROCESS_VIDEO}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.UI.REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_id: videoId }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`Backend responded ${response.status}: ${errorText}`);
    }

    const data = await response.json().catch(() => ({}));
    processedVideos.add(videoId);
    console.log(`[YT AI Chat] Video ${videoId} processed successfully.`, data);
    return { success: true, data };
  } catch (err) {
    clearTimeout(timer);
    const message =
      err.name === "AbortError"
        ? "Request timed out – is your backend running?"
        : err.message;
    console.error(`[YT AI Chat] processVideo error:`, message);
    return { success: false, error: message };
  }
}

// ── Listen for tab navigation on YouTube ────────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Only act when the URL has settled (status = "complete") on YouTube
  if (changeInfo.status !== "complete" || !tab.url) return;

  const videoId = extractVideoId(tab.url);
  if (!videoId) return;

  // Trigger backend processing (fire-and-forget; content script is notified separately)
  processVideo(videoId).then((result) => {
    // Notify content script about processing result so UI can update
    chrome.tabs.sendMessage(tabId, {
      type: "VIDEO_PROCESSED",
      videoId,
      result,
    }).catch(() => {
      // Content script may not be ready yet – that's OK
    });
  });
});

// ── Message relay from content script ───────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PROCESS_VIDEO") {
    // Content script explicitly requests processing (e.g., on SPA navigation)
    processVideo(message.videoId).then(sendResponse);
    return true; // Keep message channel open for async response
  }

  if (message.type === "GET_TAB_URL") {
    // Let content/popup know which tab is active
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      sendResponse({ url: tabs[0]?.url || "" });
    });
    return true;
  }
});
