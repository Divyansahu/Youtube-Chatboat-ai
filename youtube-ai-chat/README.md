# YouTube AI Chat — Chrome Extension

A ChatGPT-style floating chat panel for any YouTube video. Ask questions about the video content and get AI-powered answers from your own backend.

---

## Folder Structure

```
youtube-ai-chat/
├── manifest.json          ← Manifest V3 config
├── constants.js           ← ⚙️  Configure your backend URL here
├── background.js          ← Service worker: video detection, /process-video calls
├── content.js             ← Injected into YouTube: builds & manages chat panel
├── chat-panel.css         ← Injected into YouTube: panel styles
├── popup.html             ← Extension popup UI
├── popup.css              ← Popup styles
├── popup.js               ← Popup logic
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Quick Start

### 1. Configure your backend URL

Open `constants.js` and set your backend address:

```js
BACKEND_BASE_URL: "http://localhost:8000",  // ← Change this
```

### 2. Load the extension in Chrome

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `youtube-ai-chat/` folder

### 3. Use it

1. Navigate to any YouTube video (e.g. `https://www.youtube.com/watch?v=...`)
2. A chat button appears in the **bottom-right corner**
3. Click it to open the panel
4. Ask any question about the video!

---

## Backend API

Your backend must implement two endpoints:

### POST /process-video
Called automatically when a new video is detected.

**Request:**
```json
{ "video_id": "Ldt2onOANo4" }
```

**Response (200):**
```json
{ "success": true }
```

### POST /ask
Called when the user submits a question.

**Request:**
```json
{
  "question": "What is this video about?",
  "video_id": "Ldt2onOANo4"
}
```

**Response (200):**
```json
{ "answer": "This video is about..." }
```

The extension also accepts `response`, `message`, or `text` as the answer field key.

---

## Features

| Feature | Details |
|---|---|
| Auto-detection | Detects video ID from URL on load and SPA navigation |
| Transcript processing | Calls `/process-video` automatically in background |
| Chat panel | Dark-mode floating panel, collapsible, smooth animations |
| Message history | Persisted per video ID via `chrome.storage.local` |
| Typing indicator | Animated dots while waiting for AI response |
| Error handling | Timeout, network errors, bad responses — all handled gracefully |
| Video info | Shows thumbnail + title in the panel header |
| Suggested questions | Quick-start prompts for new conversations |
| Markdown formatting | Bold, italic, and inline code in AI responses |

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| Backend not running | Red error banner with message |
| `/process-video` fails | Status shows "Processing failed", user can still ask |
| `/ask` timeout (30s) | Error bubble in chat, can retry |
| Invalid JSON response | Graceful fallback, raw text displayed |
| No transcript available | Backend error surfaced in UI |

---

## Storage

Chat history is stored in `chrome.storage.local` under the key `chat_<videoId>`.
Each video's history is independent and persists across browser sessions.

To clear history for a video, use the **trash icon** in the panel header.

---

## Permissions Used

| Permission | Reason |
|---|---|
| `storage` | Persist chat history |
| `activeTab` | Read current tab URL |
| `scripting` | Inject content scripts |
| `tabs` | Detect YouTube navigation |

---

## Development Tips

- **Reload the extension** after any JS/CSS changes: go to `chrome://extensions` → click the refresh icon.
- **Inspect the panel**: right-click any element on YouTube → Inspect → find `#yt-ai-chat-root`.
- **View background logs**: `chrome://extensions` → "Service Worker" → inspect.
- **View content script logs**: open DevTools on the YouTube tab → Console.

<!-- runn the project-->

cd /Users/divyanshu/Desktop/Youtube_extension/youtube-ai-chat
source venv/bin/activate
python -m uvicorn backend:app --reload --port 8000