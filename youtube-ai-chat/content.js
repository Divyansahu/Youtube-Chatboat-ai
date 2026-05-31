/**
 * content.js — Injected into every YouTube /watch page
 * ─────────────────────────────────────────────────────────────────────────────
 * Responsibilities:
 *  1. Detect the current video ID (initial load + YouTube SPA navigations).
 *  2. Inject and manage the floating chat panel DOM.
 *  3. Send /ask requests to the backend and render responses.
 *  4. Persist + restore per-video chat history via chrome.storage.local.
 * ─────────────────────────────────────────────────────────────────────────────
 */

(() => {
  "use strict";

  // ── Guard: only run once per page context ──────────────────────────────────
  if (window.__ytAiChatLoaded) return;
  window.__ytAiChatLoaded = true;

  // ── State ──────────────────────────────────────────────────────────────────
  let currentVideoId = null;
  let currentVideoTitle = "";
  let isProcessing = false; // backend /process-video in progress
  let isSending = false;    // backend /ask in progress
  let isPanelOpen = true;
  let chatMessages = [];    // { role: "user"|"ai", text, timestamp }

  // ── Utility: extract video ID from current URL ────────────────────────────
  function getVideoId() {
    const params = new URLSearchParams(window.location.search);
    return params.get("v") || null;
  }

  // ── Utility: get page title, falling back gracefully ─────────────────────
  function getVideoTitle() {
    // YouTube stores the title in several places; try the most reliable first
    return (
      document.querySelector("h1.ytd-watch-metadata yt-formatted-string")?.textContent?.trim() ||
      document.querySelector("h1.title.ytd-video-primary-info-renderer")?.textContent?.trim() ||
      document.title.replace(" - YouTube", "").trim() ||
      "Unknown Title"
    );
  }

  // ── Utility: format timestamp ─────────────────────────────────────────────
  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // ── Utility: escape HTML to prevent XSS ──────────────────────────────────
  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  // ── Utility: simple markdown-like formatting for AI responses ────────────
  function formatAiText(text) {
    return escapeHtml(text)
      .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.*?)\*/g, "<em>$1</em>")
      .replace(/`(.*?)`/g, "<code>$1</code>")
      .replace(/\n/g, "<br>");
  }

  // ── Storage: load messages for current video ──────────────────────────────
  async function loadChatHistory(videoId) {
    return new Promise((resolve) => {
      const key = CONFIG.STORAGE_KEYS.CHAT_HISTORY_PREFIX + videoId;
      chrome.storage.local.get([key], (result) => {
        resolve(result[key] || []);
      });
    });
  }

  // ── Storage: save messages for current video ──────────────────────────────
  async function saveChatHistory(videoId, messages) {
    const key = CONFIG.STORAGE_KEYS.CHAT_HISTORY_PREFIX + videoId;
    return new Promise((resolve) => {
      chrome.storage.local.set({ [key]: messages }, resolve);
    });
  }

  // ── Storage: clear messages for current video ─────────────────────────────
  async function clearChatHistory(videoId) {
    const key = CONFIG.STORAGE_KEYS.CHAT_HISTORY_PREFIX + videoId;
    return new Promise((resolve) => {
      chrome.storage.local.remove([key], resolve);
    });
  }

  // ── DOM: build the entire chat panel ─────────────────────────────────────
  function buildPanel() {
    // Remove any existing panel (e.g., after SPA navigation)
    document.getElementById("yt-ai-chat-root")?.remove();

    const root = document.createElement("div");
    root.id = "yt-ai-chat-root";
    root.innerHTML = `
      <!-- Toggle button (always visible) -->
      <button id="yac-toggle-btn" title="Toggle AI Chat">
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2C6.48 2 2 6.48 2 12C2 14.05 2.61 15.96 3.66 17.56L2 22L6.44 20.34C8.04 21.39 9.95 22 12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2Z" fill="currentColor"/>
          <circle cx="8" cy="12" r="1.2" fill="white"/>
          <circle cx="12" cy="12" r="1.2" fill="white"/>
          <circle cx="16" cy="12" r="1.2" fill="white"/>
        </svg>
        <span id="yac-notification-dot"></span>
      </button>

      <!-- Main panel -->
      <div id="yac-panel">
        <!-- Header -->
        <div id="yac-header">
          <div id="yac-header-left">
            <div id="yac-logo">
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 2C6.48 2 2 6.48 2 12C2 14.05 2.61 15.96 3.66 17.56L2 22L6.44 20.34C8.04 21.39 9.95 22 12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2Z" fill="currentColor"/>
              </svg>
            </div>
            <div>
              <div id="yac-title">YouTube AI Chat</div>
              <div id="yac-status-indicator">
                <span id="yac-status-dot"></span>
                <span id="yac-status-text">Initializing…</span>
              </div>
            </div>
          </div>
          <div id="yac-header-actions">
            <button id="yac-clear-btn" title="Clear chat history">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3,6 5,6 21,6"/><path d="M19,6L18.1,19.1A2,2,0,0,1,16.1,21H7.9A2,2,0,0,1,5.9,19.1L5,6"/><path d="M10,11V17"/><path d="M14,11V17"/><path d="M9,6V4A1,1,0,0,1,10,3H14A1,1,0,0,1,15,4V6"/>
              </svg>
            </button>
            <button id="yac-minimize-btn" title="Minimize">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
            </button>
          </div>
        </div>

        <!-- Video info bar -->
        <div id="yac-video-info">
          <div id="yac-video-thumbnail-container">
            <img id="yac-video-thumbnail" src="" alt="Thumbnail" />
          </div>
          <div id="yac-video-details">
            <div id="yac-video-title-text">Loading video info…</div>
            <div id="yac-video-id-text"></div>
          </div>
        </div>

        <!-- Processing banner (shown while backend processes transcript) -->
        <div id="yac-processing-banner" class="hidden">
          <div class="yac-spinner-small"></div>
          <span>Analyzing video transcript…</span>
        </div>

        <!-- Error banner -->
        <div id="yac-error-banner" class="hidden">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <span id="yac-error-text">An error occurred.</span>
          <button id="yac-error-dismiss">✕</button>
        </div>

        <!-- Messages container -->
        <div id="yac-messages">
          <div id="yac-welcome">
            <div id="yac-welcome-icon">✨</div>
            <div id="yac-welcome-title">Ask anything about this video</div>
            <div id="yac-welcome-sub">I've read the transcript and I'm ready to answer your questions.</div>
            <div id="yac-suggested-questions">
              <button class="yac-suggestion">Summarize this video</button>
              <button class="yac-suggestion">What are the key points?</button>
              <button class="yac-suggestion">Any action items?</button>
            </div>
          </div>
        </div>

        <!-- Input area -->
        <div id="yac-input-area">
          <div id="yac-input-wrapper">
            <textarea
              id="yac-input"
              placeholder="Ask a question about this video…"
              rows="1"
              maxlength="2000"
            ></textarea>
            <button id="yac-send-btn" disabled title="Send message">
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M22 2L11 13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                <path d="M22 2L15 22L11 13L2 9L22 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
          </div>
          <div id="yac-input-footer">
            <span id="yac-char-count">0 / 2000</span>
            <span id="yac-hint">Enter to send · Shift+Enter for new line</span>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(root);
    attachEventListeners();
  }

  // ── DOM: attach all event listeners ──────────────────────────────────────
  function attachEventListeners() {
    // Toggle panel open/close
    document.getElementById("yac-toggle-btn").addEventListener("click", togglePanel);
    document.getElementById("yac-minimize-btn").addEventListener("click", togglePanel);

    // Clear history
    document.getElementById("yac-clear-btn").addEventListener("click", async () => {
      if (!currentVideoId) return;
      if (!confirm("Clear chat history for this video?")) return;
      chatMessages = [];
      await clearChatHistory(currentVideoId);
      renderMessages();
    });

    // Dismiss error banner
    document.getElementById("yac-error-dismiss").addEventListener("click", () => {
      hideError();
    });

    // Textarea: auto-resize + char count + send on Enter
    const textarea = document.getElementById("yac-input");
    textarea.addEventListener("input", () => {
      // Auto-resize
      textarea.style.height = "auto";
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + "px";
      // Char count
      document.getElementById("yac-char-count").textContent =
        `${textarea.value.length} / 2000`;
      // Enable/disable send button
      document.getElementById("yac-send-btn").disabled =
        textarea.value.trim().length === 0 || isSending;
    });

    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });

    // Send button
    document.getElementById("yac-send-btn").addEventListener("click", handleSend);

    // Suggested questions
    document.querySelectorAll(".yac-suggestion").forEach((btn) => {
      btn.addEventListener("click", () => {
        const textarea = document.getElementById("yac-input");
        textarea.value = btn.textContent;
        textarea.dispatchEvent(new Event("input"));
        handleSend();
      });
    });
  }

  // ── UI: toggle panel open / closed ───────────────────────────────────────
  function togglePanel() {
    isPanelOpen = !isPanelOpen;
    const panel = document.getElementById("yac-panel");
    const toggleBtn = document.getElementById("yac-toggle-btn");
    if (isPanelOpen) {
      panel.classList.remove("yac-panel-hidden");
      toggleBtn.classList.add("yac-toggle-active");
      document.getElementById("yac-notification-dot").style.display = "none";
    } else {
      panel.classList.add("yac-panel-hidden");
      toggleBtn.classList.remove("yac-toggle-active");
    }
  }

  // ── UI: show/hide processing banner ──────────────────────────────────────
  function setProcessing(active) {
    isProcessing = active;
    const banner = document.getElementById("yac-processing-banner");
    const statusDot = document.getElementById("yac-status-dot");
    const statusText = document.getElementById("yac-status-text");
    if (active) {
      banner.classList.remove("hidden");
      statusDot.className = "yac-dot-processing";
      statusText.textContent = "Processing transcript…";
    } else {
      banner.classList.add("hidden");
    }
  }

  // ── UI: show status in header ─────────────────────────────────────────────
  function setStatus(state, text) {
    // state: "ready" | "processing" | "error" | "sending"
    const dot = document.getElementById("yac-status-dot");
    const statusText = document.getElementById("yac-status-text");
    dot.className = `yac-dot-${state}`;
    statusText.textContent = text;
  }

  // ── UI: show error banner ─────────────────────────────────────────────────
  function showError(msg) {
    const banner = document.getElementById("yac-error-banner");
    document.getElementById("yac-error-text").textContent = msg;
    banner.classList.remove("hidden");
    setStatus("error", "Error");
    // Auto-dismiss after 8 seconds
    setTimeout(hideError, 8000);
  }

  function hideError() {
    document.getElementById("yac-error-banner").classList.add("hidden");
  }

  // ── UI: update video info bar ─────────────────────────────────────────────
  function updateVideoInfo(videoId, title) {
    document.getElementById("yac-video-title-text").textContent =
      title || "Loading title…";
    document.getElementById("yac-video-id-text").textContent =
      videoId ? `ID: ${videoId}` : "";
    const thumb = document.getElementById("yac-video-thumbnail");
    thumb.src = videoId
      ? `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`
      : "";
  }

  // ── UI: render all chat messages ──────────────────────────────────────────
  function renderMessages() {
    const container = document.getElementById("yac-messages");
    const welcome = document.getElementById("yac-welcome");

    if (chatMessages.length === 0) {
      welcome.style.display = "flex";
      // Remove any previously rendered bubbles
      container.querySelectorAll(".yac-message").forEach((el) => el.remove());
      return;
    }

    welcome.style.display = "none";
    // Clear and re-render (simple approach for correctness)
    container.querySelectorAll(".yac-message").forEach((el) => el.remove());

    chatMessages.forEach((msg) => {
      const el = createMessageElement(msg);
      container.appendChild(el);
    });

    scrollToBottom();
  }

  // ── UI: create a single message bubble element ────────────────────────────
  function createMessageElement(msg) {
    const wrapper = document.createElement("div");
    wrapper.className = `yac-message yac-message-${msg.role}`;

    const bubble = document.createElement("div");
    bubble.className = "yac-bubble";

    if (msg.role === "user") {
      bubble.textContent = msg.text;
    } else {
      bubble.innerHTML = formatAiText(msg.text);
    }

    const meta = document.createElement("div");
    meta.className = "yac-message-meta";
    meta.textContent = formatTime(msg.timestamp);

    wrapper.appendChild(bubble);
    wrapper.appendChild(meta);
    return wrapper;
  }

  // ── UI: append a single new message (more efficient than full re-render) ──
  function appendMessage(msg) {
    const container = document.getElementById("yac-messages");
    document.getElementById("yac-welcome").style.display = "none";
    const el = createMessageElement(msg);
    container.appendChild(el);
    scrollToBottom();
  }

  // ── UI: show "AI is typing" indicator ────────────────────────────────────
  function showTypingIndicator() {
    const container = document.getElementById("yac-messages");
    const typing = document.createElement("div");
    typing.id = "yac-typing";
    typing.className = "yac-message yac-message-ai";
    typing.innerHTML = `
      <div class="yac-bubble yac-typing-bubble">
        <div class="yac-typing-dots">
          <span></span><span></span><span></span>
        </div>
      </div>
    `;
    container.appendChild(typing);
    scrollToBottom();
  }

  function removeTypingIndicator() {
    document.getElementById("yac-typing")?.remove();
  }

  // ── UI: auto-scroll messages to bottom ───────────────────────────────────
  function scrollToBottom() {
    const container = document.getElementById("yac-messages");
    container.scrollTop = container.scrollHeight;
  }

  // ── Core: send a question to the backend ──────────────────────────────────
  async function handleSend() {
    if (isSending || isProcessing) return;

    const textarea = document.getElementById("yac-input");
    const question = textarea.value.trim();
    if (!question) return;

    if (!currentVideoId) {
      showError("No video detected. Please navigate to a YouTube video.");
      return;
    }

    // ── Add user message ──
    const userMsg = { role: "user", text: question, timestamp: Date.now() };
    chatMessages.push(userMsg);
    appendMessage(userMsg);
    await saveChatHistory(currentVideoId, chatMessages);

    // ── Reset input ──
    textarea.value = "";
    textarea.style.height = "auto";
    textarea.dispatchEvent(new Event("input")); // reset char count + btn state

    // ── Show typing indicator ──
    isSending = true;
    document.getElementById("yac-send-btn").disabled = true;
    setStatus("sending", "Thinking…");
    showTypingIndicator();

    // ── Call backend ──
    try {
      const url = `${CONFIG.BACKEND_BASE_URL}${CONFIG.ENDPOINTS.ASK}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CONFIG.UI.REQUEST_TIMEOUT_MS);

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, video_id: currentVideoId }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        const errBody = await response.text().catch(() => "");
        throw new Error(
          `Server error ${response.status}${errBody ? ": " + errBody : ""}`
        );
      }

      const data = await response.json();
      const answer =
        data.answer || data.response || data.message || data.text ||
        JSON.stringify(data);

      removeTypingIndicator();

      const aiMsg = { role: "ai", text: answer, timestamp: Date.now() };
      chatMessages.push(aiMsg);
      appendMessage(aiMsg);
      await saveChatHistory(currentVideoId, chatMessages);

      setStatus("ready", "Ready");
    } catch (err) {
      removeTypingIndicator();
      const errText =
        err.name === "AbortError"
          ? "Request timed out. Is the backend running?"
          : `Failed to get response: ${err.message}`;
      showError(errText);

      const errorMsg = {
        role: "ai",
        text: `⚠️ ${errText}`,
        timestamp: Date.now(),
      };
      chatMessages.push(errorMsg);
      appendMessage(errorMsg);
      await saveChatHistory(currentVideoId, chatMessages);
    } finally {
      isSending = false;
      // Re-enable send button only if there's text
      const hasText = document.getElementById("yac-input").value.trim().length > 0;
      document.getElementById("yac-send-btn").disabled = !hasText;
    }
  }

  // ── Core: initialize / switch to a video ─────────────────────────────────
  async function initVideo(videoId) {
    if (!videoId) return;

    // No change – do nothing
    if (videoId === currentVideoId) return;

    currentVideoId = videoId;
    chatMessages = [];

    // Build the panel if it doesn't exist yet
    if (!document.getElementById("yt-ai-chat-root")) {
      buildPanel();
    }

    // Update video info (title may not be in DOM yet – wait a bit)
    setTimeout(() => {
      currentVideoTitle = getVideoTitle();
      updateVideoInfo(videoId, currentVideoTitle);
    }, 1500);

    updateVideoInfo(videoId, "Loading…");
    setStatus("processing", "Processing transcript…");
    setProcessing(true);

    // Load existing history
    chatMessages = await loadChatHistory(videoId);
    renderMessages();

    // Ask background script to process the video
    chrome.runtime.sendMessage(
      { type: "PROCESS_VIDEO", videoId },
      (result) => {
        setProcessing(false);
        if (result?.success) {
          setStatus("ready", "Ready to chat");
          // Show notification dot if panel is closed
          if (!isPanelOpen) {
            document.getElementById("yac-notification-dot").style.display = "block";
          }
        } else {
          const errMsg = result?.error || "Failed to process video transcript.";
          showError(errMsg);
          setStatus("error", "Processing failed");
        }
      }
    );
  }

  // ── Core: listen for messages from background script ─────────────────────
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "VIDEO_PROCESSED") {
      setProcessing(false);
      if (message.result?.success) {
        setStatus("ready", "Ready to chat");
      } else {
        showError(message.result?.error || "Processing failed.");
        setStatus("error", "Processing failed");
      }
    }
  });

  // ── Core: watch for YouTube SPA navigations ───────────────────────────────
  // YouTube is a single-page app; URL changes don't trigger a full page load.
  let lastUrl = location.href;

  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      const newVideoId = getVideoId();
      if (newVideoId && newVideoId !== currentVideoId) {
        // Small delay to let YouTube update the DOM with new title
        setTimeout(() => initVideo(newVideoId), 800);
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  const initialVideoId = getVideoId();
  if (initialVideoId) {
    // Wait for YouTube's DOM to be ready before building the panel
    const readyCheck = setInterval(() => {
      if (document.body) {
        clearInterval(readyCheck);
        buildPanel();
        initVideo(initialVideoId);
      }
    }, 100);
  }
})();
