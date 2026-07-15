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

  // Pipeline Agent State
  let activeTab = "chat";
  let currentSummary = null;
  let currentQuiz = null;
  let currentRoadmap = null;
  let isGeneratingSummary = false;
  let isGeneratingQuiz = false;
  let isGeneratingRoadmap = false;

  // Interactive Quiz State
  let quizActiveIndex = 0;
  let quizScore = 0;
  let selectedOptionIndex = null;
  let questionAnswered = false;
  let roadmapCheckpointsState = {};

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

  // ── Utility: convert timestamp (MM:SS, HH:MM:SS, or seconds) to seconds ───
  function timestampToSeconds(timeStr) {
    if (!timeStr) return 0;
    const parts = timeStr.trim().split(':');
    if (parts.length === 2) {
      return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
    } else if (parts.length === 3) {
      return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10);
    }
    return parseInt(timeStr, 10) || 0;
  }

  // ── Utility: seek YouTube video to timestamp ───────────────────────────────
  function seekVideoTo(seconds) {
    const video = document.querySelector('video');
    if (video) {
      video.currentTime = seconds;
      video.play();
    }
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

  // Generic Storage Helpers for Pipeline
  async function loadStorageItem(videoId, prefix) {
    return new Promise((resolve) => {
      const key = prefix + videoId;
      chrome.storage.local.get([key], (result) => {
        resolve(result[key] || null);
      });
    });
  }

  async function saveStorageItem(videoId, prefix, data) {
    const key = prefix + videoId;
    return new Promise((resolve) => {
      chrome.storage.local.set({ [key]: data }, resolve);
    });
  }

  async function deleteStorageItem(videoId, prefix) {
    const key = prefix + videoId;
    return new Promise((resolve) => {
      chrome.storage.local.remove([key], resolve);
    });
  }

  async function loadRoadmapCheckpointsState(videoId) {
    return new Promise((resolve) => {
      const key = "roadmap_checkpoints_" + videoId;
      chrome.storage.local.get([key], (result) => {
        roadmapCheckpointsState = result[key] || {};
        resolve();
      });
    });
  }

  async function saveRoadmapCheckpointsState(videoId) {
    const key = "roadmap_checkpoints_" + videoId;
    return new Promise((resolve) => {
      chrome.storage.local.set({ [key]: roadmapCheckpointsState }, resolve);
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
      <button id="yac-toggle-btn" class="${isPanelOpen ? 'yac-toggle-active' : ''}" title="Toggle AI Chat">
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2C6.48 2 2 6.48 2 12C2 14.05 2.61 15.96 3.66 17.56L2 22L6.44 20.34C8.04 21.39 9.95 22 12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2Z" fill="currentColor"/>
          <circle cx="8" cy="12" r="1.2" fill="white"/>
          <circle cx="12" cy="12" r="1.2" fill="white"/>
          <circle cx="16" cy="12" r="1.2" fill="white"/>
        </svg>
        <span id="yac-notification-dot"></span>
      </button>

      <!-- Main panel -->
      <div id="yac-panel" class="${isPanelOpen ? '' : 'yac-panel-hidden'}">
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

        <!-- Tabs Navigation -->
        <div id="yac-tabs">
          <button class="yac-tab-btn active" data-tab="chat">💬 Chat</button>
          <button class="yac-tab-btn" data-tab="summary">📝 Summary</button>
          <button class="yac-tab-btn" data-tab="quiz">🧩 Quiz</button>
          <button class="yac-tab-btn" data-tab="roadmap">🎯 Roadmap</button>
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

        <!-- Tab Content Wrapper -->
        <div id="yac-tab-content">
          <!-- Chat Tab -->
          <div id="yac-tab-pane-chat" class="yac-tab-pane active-pane">
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
          </div>

          <!-- Summary Tab -->
          <div id="yac-tab-pane-summary" class="yac-tab-pane">
            <div class="yac-tab-scrollable" id="yac-summary-scrollable">
              <!-- CTA / Summary content gets injected here -->
            </div>
          </div>

          <!-- Quiz Tab -->
          <div id="yac-tab-pane-quiz" class="yac-tab-pane">
            <div class="yac-tab-scrollable" id="yac-quiz-scrollable">
              <!-- CTA / Quiz questions get injected here -->
            </div>
          </div>



          <!-- Roadmap Tab -->
          <div id="yac-tab-pane-roadmap" class="yac-tab-pane">
            <div class="yac-tab-scrollable" id="yac-roadmap-scrollable">
              <!-- CTA / Roadmap steps get injected here -->
            </div>
          </div>
        </div>

        <!-- Input area (only for Chat) -->
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

    // Click delegation for timestamp seeking
    document.getElementById("yt-ai-chat-root").addEventListener("click", (e) => {
      const badge = e.target.closest(".yt-chat-timestamp-badge");
      if (badge) {
        const timeStr = badge.getAttribute("data-time");
        const seconds = timestampToSeconds(timeStr);
        seekVideoTo(seconds);
      }
    });

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

    // Tab buttons click triggers
    document.querySelectorAll(".yac-tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tabId = btn.getAttribute("data-tab");
        switchTab(tabId);
      });
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
//   User types question
//           ↓
//  Validate input
//           ↓
//   Add user message
//           ↓
//  Save history
//           ↓
//  Show typing indicator
//           ↓
//  POST /ask
//           ↓
//  Backend response
//           ↓
//   Create AI message
//           ↓
//   Save history
//           ↓
//   Display answer
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
//   Video Opened
//       ↓
// Load History
//       ↓
// Update Title
//       ↓
// Show Processing
//       ↓
// Ask Background Script
//       ↓
// Process Transcript
//       ↓
// Ready To Chat
  async function initVideo(videoId) {
    if (!videoId) return;

    // No change – do nothing
    if (videoId === currentVideoId) return;

    currentVideoId = videoId;
    chatMessages = [];
    currentSummary = null;
    currentQuiz = null;
    currentRoadmap = null;

    // Build the panel if it doesn't exist yet
    if (!document.getElementById("yt-ai-chat-root")) {
      buildPanel();
    }

    switchTab("chat");

    // Update video info (title may not be in DOM yet – wait a bit)
    setTimeout(() => {
      currentVideoTitle = getVideoTitle();
      updateVideoInfo(videoId, currentVideoTitle);
    }, 1500);

    updateVideoInfo(videoId, "Loading…");
    setStatus("processing", "Processing transcript…");
    setProcessing(true);

    // Load existing history & data from storage
    chatMessages = await loadChatHistory(videoId);
    currentSummary = await loadStorageItem(videoId, CONFIG.STORAGE_KEYS.SUMMARY_PREFIX);
    currentQuiz = await loadStorageItem(videoId, CONFIG.STORAGE_KEYS.QUIZ_PREFIX);
    currentRoadmap = await loadStorageItem(videoId, CONFIG.STORAGE_KEYS.ROADMAP_PREFIX);
    await loadRoadmapCheckpointsState(videoId);

    renderMessages();
    renderTabContent(activeTab);

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

  // ── Tab Switching & Rendering Logic ──────────────────────────────────────
  function switchTab(tabId) {
    activeTab = tabId;

    // Update active tab button style
    document.querySelectorAll(".yac-tab-btn").forEach((btn) => {
      if (btn.getAttribute("data-tab") === tabId) {
        btn.classList.add("active");
      } else {
        btn.classList.remove("active");
      }
    });

    // Update active pane visibility
    document.querySelectorAll(".yac-tab-pane").forEach((pane) => {
      if (pane.id === `yac-tab-pane-${tabId}`) {
        pane.classList.add("active-pane");
      } else {
        pane.classList.remove("active-pane");
      }
    });

    // Show/hide input area (only visible for Chat)
    const inputArea = document.getElementById("yac-input-area");
    if (inputArea) {
      if (tabId === "chat") {
        inputArea.classList.remove("hidden");
      } else {
        inputArea.classList.add("hidden");
      }
    }

    // Load content for specific tab if needed
    renderTabContent(tabId);
  }

  function renderTabContent(tabId) {
    if (tabId === "chat") {
      renderMessages();
      return;
    }

    if (tabId === "summary") {
      const scrollable = document.getElementById("yac-summary-scrollable");
      if (currentSummary) {
        scrollable.innerHTML = `
          <div class="yac-summary-container">
            <div class="yac-summary-actions">
              <button class="yac-action-btn-sm" id="yac-copy-summary-btn">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
                Copy Summary
              </button>
              <button class="yac-action-btn-sm" id="yac-regen-summary-btn" style="background: rgba(239, 68, 68, 0.08); color: #ef4444; border-color: rgba(239, 68, 68, 0.2);" title="Regenerate summary (clears downstream quiz, cards, roadmap)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                  <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
                </svg>
                Regenerate
              </button>
            </div>
            <div class="yac-summary-text">
              ${parseSummaryMarkdown(currentSummary)}
            </div>
          </div>
        `;
        document.getElementById("yac-copy-summary-btn").addEventListener("click", () => {
          navigator.clipboard.writeText(currentSummary);
          const btn = document.getElementById("yac-copy-summary-btn");
          const origText = btn.innerHTML;
          btn.innerHTML = "✓ Copied!";
          setTimeout(() => { btn.innerHTML = origText; }, 2000);
        });
        document.getElementById("yac-regen-summary-btn").addEventListener("click", () => {
          if (confirm("Regenerate summary? This will also clear your quiz and roadmap history for this video.")) {
            generateSummary(true);
          }
        });
      } else if (isGeneratingSummary) {
        renderLoading(scrollable, "Generating summary...", "Summarizer Agent is reading the video transcript...");
      } else {
        renderCTA(
          scrollable,
          "📝",
          "Generate Summary",
          "Read a structured overview, key takeaways, and action items from this video.",
          "yac-gen-summary-btn",
          "Summary"
        );
        document.getElementById("yac-gen-summary-btn").addEventListener("click", () => generateSummary());
      }
    }

    if (tabId === "quiz") {
      const scrollable = document.getElementById("yac-quiz-scrollable");
      if (currentQuiz) {
        renderQuiz();
      } else if (isGeneratingQuiz) {
        renderLoading(scrollable, "Generating quiz...", "Quiz Agent is analyzing the summary content...");
      } else {
        renderCTA(
          scrollable,
          "🧠",
          "Generate Video Quiz",
          "Test your understanding of the concepts presented in this video with a 5-question multiple choice quiz.",
          "yac-gen-quiz-btn",
          "Quiz"
        );
        document.getElementById("yac-gen-quiz-btn").addEventListener("click", () => generateQuiz());
      }
    }



    if (tabId === "roadmap") {
      const scrollable = document.getElementById("yac-roadmap-scrollable");
      if (currentRoadmap) {
        renderRoadmap();
      } else if (isGeneratingRoadmap) {
        renderLoading(scrollable, "Generating roadmap...", "Roadmap Agent is designing your study path...");
      } else {
        renderCTA(
          scrollable,
          "🗺️",
          "Generate Study Roadmap",
          "Get a custom step-by-step roadmap and learning checklist to master the topics in this video.",
          "yac-gen-roadmap-btn",
          "Roadmap"
        );
        document.getElementById("yac-gen-roadmap-btn").addEventListener("click", () => generateRoadmap());
      }
    }
  }

  function renderCTA(element, emoji, title, subText, btnId, tabName) {
    element.innerHTML = `
      <div class="yac-cta-state">
        <div class="yac-cta-icon">${emoji}</div>
        <div class="yac-cta-title">${title}</div>
        <div class="yac-cta-sub">${subText}</div>
        <button class="yac-action-btn" id="${btnId}">Generate ${tabName}</button>
      </div>
    `;
  }

  function renderLoading(element, title, subText) {
    element.innerHTML = `
      <div class="yac-loading-state">
        <div class="yac-spinner-large"></div>
        <div class="yac-loading-title">${title}</div>
        <div class="yac-loading-sub">${subText}</div>
      </div>
    `;
  }

  // ── API Generation Methods ────────────────────────────────────────────────
  async function generateSummary(force = false) {
    if (force) {
      currentSummary = null;
      currentQuiz = null;
      currentRoadmap = null;
      await deleteStorageItem(currentVideoId, CONFIG.STORAGE_KEYS.SUMMARY_PREFIX);
      await deleteStorageItem(currentVideoId, CONFIG.STORAGE_KEYS.QUIZ_PREFIX);
      await deleteStorageItem(currentVideoId, CONFIG.STORAGE_KEYS.ROADMAP_PREFIX);
    }
    isGeneratingSummary = true;
    renderTabContent("summary");
    try {
      const url = `${CONFIG.BACKEND_BASE_URL}${CONFIG.ENDPOINTS.SUMMARY}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video_id: currentVideoId, force_regenerate: force }),
      });
      if (!response.ok) throw new Error(`HTTP error ${response.status}`);
      const data = await response.json();
      if (data.success && data.summary) {
        currentSummary = data.summary;
        await saveStorageItem(currentVideoId, CONFIG.STORAGE_KEYS.SUMMARY_PREFIX, currentSummary);
      }
    } catch (err) {
      showError(`Failed to generate summary: ${err.message}`);
    } finally {
      isGeneratingSummary = false;
      renderTabContent("summary");
    }
  }

  async function generateQuiz(force = false) {
    if (force) {
      currentQuiz = null;
      currentRoadmap = null;
      await deleteStorageItem(currentVideoId, CONFIG.STORAGE_KEYS.QUIZ_PREFIX);
      await deleteStorageItem(currentVideoId, CONFIG.STORAGE_KEYS.ROADMAP_PREFIX);
      quizActiveIndex = 0;
      quizScore = 0;
      selectedOptionIndex = null;
      questionAnswered = false;
    }
    isGeneratingQuiz = true;
    renderTabContent("quiz");
    try {
      const url = `${CONFIG.BACKEND_BASE_URL}${CONFIG.ENDPOINTS.QUIZ}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video_id: currentVideoId, force_regenerate: force }),
      });
      if (!response.ok) throw new Error(`HTTP error ${response.status}`);
      const data = await response.json();
      if (data.success && data.quiz) {
        currentQuiz = data.quiz;
        quizActiveIndex = 0;
        quizScore = 0;
        selectedOptionIndex = null;
        questionAnswered = false;
        await saveStorageItem(currentVideoId, CONFIG.STORAGE_KEYS.QUIZ_PREFIX, currentQuiz);
      }
    } catch (err) {
      showError(`Failed to generate quiz: ${err.message}`);
    } finally {
      isGeneratingQuiz = false;
      renderTabContent("quiz");
    }
  }

  async function generateRoadmap(force = false) {
    if (force) {
      currentRoadmap = null;
      await deleteStorageItem(currentVideoId, CONFIG.STORAGE_KEYS.ROADMAP_PREFIX);
      roadmapCheckpointsState = {};
      await saveRoadmapCheckpointsState(currentVideoId);
    }
    isGeneratingRoadmap = true;
    renderTabContent("roadmap");
    try {
      const url = `${CONFIG.BACKEND_BASE_URL}${CONFIG.ENDPOINTS.ROADMAP}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video_id: currentVideoId, force_regenerate: force }),
      });
      if (!response.ok) throw new Error(`HTTP error ${response.status}`);
      const data = await response.json();
      if (data.success && data.roadmap) {
        currentRoadmap = data.roadmap;
        await saveStorageItem(currentVideoId, CONFIG.STORAGE_KEYS.ROADMAP_PREFIX, currentRoadmap);
      }
    } catch (err) {
      showError(`Failed to generate roadmap: ${err.message}`);
    } finally {
      isGeneratingRoadmap = false;
      renderTabContent("roadmap");
    }
  }

  // ── Render Utilities ──────────────────────────────────────────────────────
  function renderQuiz() {
    const container = document.getElementById("yac-quiz-scrollable");
    if (!currentQuiz || currentQuiz.length === 0) return;

    if (quizActiveIndex >= currentQuiz.length) {
      const percentage = Math.round((quizScore / currentQuiz.length) * 100);
      let feedback = "Let's try again to master this content!";
      let badge = "🥈 Keep Learning";
      if (percentage === 100) {
        feedback = "Perfect score! You've mastered this video.";
        badge = "🏆 Perfect Score";
      } else if (percentage >= 80) {
        feedback = "Great job! You have a solid grasp of the concepts.";
        badge = "🥇 Excellent";
      } else if (percentage >= 50) {
        feedback = "Good effort! Review the summary and try again.";
        badge = "📈 Good Effort";
      }
      
      container.innerHTML = `
        <div class="yac-quiz-results">
          <div class="yac-results-badge">${badge}</div>
          <div class="yac-results-score-circle">
            <span class="yac-results-score">${quizScore}</span>
            <span class="yac-results-total">/ ${currentQuiz.length}</span>
          </div>
          <div class="yac-results-percentage">${percentage}% Correct</div>
          <div class="yac-results-feedback">${feedback}</div>
          <div style="display: flex; gap: 8px; justify-content: center; width: 100%;">
            <button class="yac-action-btn" id="yac-quiz-retry-btn" style="flex: 1;">Retake Quiz</button>
            <button class="yac-action-btn" id="yac-regen-quiz-results-btn" style="flex: 1; background: rgba(239, 68, 68, 0.08); color: #ef4444; border-color: rgba(239, 68, 68, 0.2);" title="Regenerate Quiz">Regenerate</button>
          </div>
        </div>
      `;
      
      document.getElementById("yac-quiz-retry-btn").addEventListener("click", () => {
        quizActiveIndex = 0;
        quizScore = 0;
        selectedOptionIndex = null;
        questionAnswered = false;
        renderQuiz();
      });
      document.getElementById("yac-regen-quiz-results-btn").addEventListener("click", () => {
        if (confirm("Regenerate quiz? This will also clear your roadmap history for this video.")) {
          generateQuiz(true);
        }
      });
      return;
    }

    const q = currentQuiz[quizActiveIndex];
    let optionsHtml = q.options.map((opt, idx) => {
      let btnClass = "yac-quiz-option";
      if (questionAnswered) {
        if (idx === q.answer) {
          btnClass += " correct";
        } else if (idx === selectedOptionIndex) {
          btnClass += " incorrect";
        } else {
          btnClass += " disabled";
        }
      } else if (idx === selectedOptionIndex) {
        btnClass += " selected";
      }
      
      return `
        <button class="${btnClass}" data-index="${idx}" ${questionAnswered ? "disabled" : ""}>
          <span class="yac-option-letter">${String.fromCharCode(65 + idx)}</span>
          <span class="yac-option-text">${escapeHtml(opt)}</span>
        </button>
      `;
    }).join("");

    let actionBtnHtml = "";
    if (questionAnswered) {
      const isLast = quizActiveIndex === currentQuiz.length - 1;
      actionBtnHtml = `<button class="yac-action-btn" id="yac-quiz-next-btn">${isLast ? "View Results" : "Next Question"}</button>`;
    } else {
      actionBtnHtml = `<button class="yac-action-btn" id="yac-quiz-submit-btn" ${selectedOptionIndex === null ? "disabled" : ""}>Submit Answer</button>`;
    }

    container.innerHTML = `
      <div class="yac-quiz-card">
        <div class="yac-quiz-header" style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
          <div style="flex: 1;">
            <span class="yac-quiz-progress">Question ${quizActiveIndex + 1} of ${currentQuiz.length}</span>
            <div class="yac-quiz-progress-bar">
              <div class="yac-quiz-progress-fill" style="width: ${((quizActiveIndex) / currentQuiz.length) * 100}%"></div>
            </div>
          </div>
          <button class="yac-action-btn-sm" id="yac-regen-quiz-btn" style="background: transparent; border: none; padding: 4px; color: var(--yac-text-muted); cursor: pointer; display: flex; align-items: center; justify-content: center;" title="Regenerate quiz (clears downstream cards, roadmap)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8m0 0H15m6 0V2m-9 20a9 9 0 0 1-9-9"/>
            </svg>
          </button>
        </div>
        <div class="yac-quiz-question">${escapeHtml(q.question)}</div>
        <div class="yac-quiz-options">
          ${optionsHtml}
        </div>
        <div class="yac-quiz-footer">
          ${actionBtnHtml}
        </div>
      </div>
    `;

    container.querySelectorAll(".yac-quiz-option").forEach(btn => {
      btn.addEventListener("click", () => {
        if (questionAnswered) return;
        selectedOptionIndex = parseInt(btn.getAttribute("data-index"));
        renderQuiz();
      });
    });

    const submitBtn = document.getElementById("yac-quiz-submit-btn");
    if (submitBtn) {
      submitBtn.addEventListener("click", () => {
        if (selectedOptionIndex === null) return;
        questionAnswered = true;
        if (selectedOptionIndex === q.answer) {
          quizScore++;
        }
        renderQuiz();
      });
    }

    const nextBtn = document.getElementById("yac-quiz-next-btn");
    if (nextBtn) {
      nextBtn.addEventListener("click", () => {
        quizActiveIndex++;
        selectedOptionIndex = null;
        questionAnswered = false;
        renderQuiz();
      });
    }

    const regenBtn = document.getElementById("yac-regen-quiz-btn");
    if (regenBtn) {
      regenBtn.addEventListener("click", () => {
        if (confirm("Regenerate quiz? This will also clear your roadmap history for this video.")) {
          generateQuiz(true);
        }
      });
    }
  }

  function renderRoadmap() {
    const container = document.getElementById("yac-roadmap-scrollable");
    if (!currentRoadmap || currentRoadmap.length === 0) return;

    let stepsHtml = currentRoadmap.map((item, stepIdx) => {
      let checkpointsHtml = "";
      if (item.checkpoints && item.checkpoints.length > 0) {
        checkpointsHtml = `
          <ul class="yac-roadmap-checkpoints">
            ${item.checkpoints.map((cp, cpIdx) => {
              const stateKey = `${stepIdx}_${cpIdx}`;
              const isChecked = !!roadmapCheckpointsState[stateKey];
              return `
                <li class="yac-roadmap-checkpoint">
                  <label class="yac-checkpoint-label">
                    <input type="checkbox" class="yac-checkpoint-checkbox" data-step="${stepIdx}" data-checkpoint="${cpIdx}" ${isChecked ? "checked" : ""}>
                    <span class="yac-checkbox-custom"></span>
                    <span class="yac-checkpoint-text">${escapeHtml(cp)}</span>
                  </label>
                </li>
              `;
            }).join("")}
          </ul>
        `;
      }

      return `
        <div class="yac-roadmap-step">
          <div class="yac-roadmap-timeline">
            <div class="yac-step-circle">${item.step || (stepIdx + 1)}</div>
            ${stepIdx < currentRoadmap.length - 1 ? '<div class="yac-step-line"></div>' : ""}
          </div>
          <div class="yac-roadmap-details">
            <h3 class="yac-roadmap-step-title">
              ${escapeHtml(item.title)}
              ${item.timestamp ? `<span class="yt-chat-timestamp-badge" data-time="${escapeHtml(item.timestamp)}">⏱️ ${escapeHtml(item.timestamp)}</span>` : ""}
            </h3>
            <p class="yac-roadmap-step-desc">${escapeHtml(item.description)}</p>
            ${checkpointsHtml}
          </div>
        </div>
      `;
    }).join("");

    container.innerHTML = `
      <div class="yac-roadmap-container">
        <div class="yac-roadmap-header" style="display: flex; justify-content: space-between; align-items: flex-start; width: 100%;">
          <div>
            <h2>Learning Path</h2>
            <p>Follow these steps to master the video content. Check off items as you complete them.</p>
          </div>
          <button class="yac-action-btn-sm" id="yac-regen-roadmap-btn" style="background: transparent; border: none; padding: 4px; color: var(--yac-text-muted); cursor: pointer; flex-shrink: 0; margin-top: 2px;" title="Regenerate roadmap">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8m0 0H15m6 0V2m-9 20a9 9 0 0 1-9-9"/>
            </svg>
          </button>
        </div>
        <div class="yac-roadmap-steps">
          ${stepsHtml}
        </div>
      </div>
    `;

    container.querySelectorAll(".yac-checkpoint-checkbox").forEach(cb => {
      cb.addEventListener("change", async (e) => {
        const stepIdx = cb.getAttribute("data-step");
        const cpIdx = cb.getAttribute("data-checkpoint");
        const stateKey = `${stepIdx}_${cpIdx}`;
        roadmapCheckpointsState[stateKey] = cb.checked;
        await saveRoadmapCheckpointsState(currentVideoId);
      });
    });

    const regenRoadmapBtn = document.getElementById("yac-regen-roadmap-btn");
    if (regenRoadmapBtn) {
      regenRoadmapBtn.addEventListener("click", () => {
        if (confirm("Regenerate learning roadmap?")) {
          generateRoadmap(true);
        }
      });
    }
  }

  function parseSummaryMarkdown(md) {
    if (!md) return "";
    const lines = md.split("\n");
    let inList = false;
    let htmlLines = [];

    for (let line of lines) {
      let trimmed = line.trim();
      
      if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
        if (!inList) {
          htmlLines.push('<ul class="yac-summary-list">');
          inList = true;
        }
        let content = trimmed.substring(2);
        content = formatInlineMarkdown(content);
        htmlLines.push(`<li>${content}</li>`);
        continue;
      } else {
        if (inList) {
          htmlLines.push("</ul>");
          inList = false;
        }
      }

      if (trimmed.startsWith("### ")) {
        htmlLines.push(`<h3>${formatInlineMarkdown(trimmed.substring(4))}</h3>`);
      } else if (trimmed.startsWith("## ")) {
        htmlLines.push(`<h2>${formatInlineMarkdown(trimmed.substring(3))}</h2>`);
      } else if (trimmed.startsWith("# ")) {
        htmlLines.push(`<h1>${formatInlineMarkdown(trimmed.substring(2))}</h1>`);
      } else if (trimmed === "") {
        continue;
      } else {
        htmlLines.push(`<p>${formatInlineMarkdown(trimmed)}</p>`);
      }
    }
    
    if (inList) {
      htmlLines.push("</ul>");
    }

    return htmlLines.join("\n");
  }

  function formatInlineMarkdown(text) {
    let escaped = escapeHtml(text)
      .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.*?)\*/g, "<em>$1</em>")
      .replace(/`(.*?)`/g, "<code>$1</code>");

    // Replace [MM:SS] or (MM:SS) or [H:MM:SS] with clickable badges
    escaped = escaped.replace(/(\[|\()(\d{1,2}:\d{2}(?::\d{2})?)(\]|\))/g, (match, open, timeStr, close) => {
      return `<span class="yt-chat-timestamp-badge" data-time="${timeStr}">⏱️ ${timeStr}</span>`;
    });

    return escaped;
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
    const newVideoId = getVideoId();
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (newVideoId && newVideoId !== currentVideoId) {
        // Small delay to let YouTube update the DOM with new title
        setTimeout(() => initVideo(newVideoId), 800);
      } else if (!newVideoId) {
        document.getElementById("yt-ai-chat-root")?.remove();
        currentVideoId = null;
      }
    }

    // Self-healing: Ensure panel is always injected and intact on watch pages
    if (newVideoId) {
      if (!document.getElementById("yt-ai-chat-root") && document.body) {
        buildPanel();
        if (currentVideoId === newVideoId) {
          renderTabContent(activeTab || "chat");
        } else {
          initVideo(newVideoId);
        }
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
