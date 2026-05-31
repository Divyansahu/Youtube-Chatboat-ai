/**
 * constants.js
 * ─────────────────────────────────────────────────────────
 * Central configuration for the YouTube AI Chat extension.
 * Change BACKEND_BASE_URL to point to your own server.
 * ─────────────────────────────────────────────────────────
 */

const CONFIG = {
  /** Base URL of your backend API – no trailing slash */
  BACKEND_BASE_URL: "http://localhost:8000",

  /** Endpoints */
  ENDPOINTS: {
    PROCESS_VIDEO: "/process-video",
    ASK: "/ask",
  },

  /** Storage keys */
  STORAGE_KEYS: {
    CHAT_HISTORY_PREFIX: "chat_", // chat_<videoId>
    SETTINGS: "yt_ai_settings",
  },

  /** UI settings */
  UI: {
    MAX_RETRIES: 3,
    REQUEST_TIMEOUT_MS: 30000,
    PANEL_WIDTH: "380px",
  },
};

// Make available in both content script and popup contexts

// CONFIG is available globally in all extension contexts