/**
 * BACKGROUND SERVICE WORKER
 *
 * This is the "brain" of the extension. It runs in the background and handles:
 * 1. Opening the side panel when the user clicks the extension icon
 * 2. Fetching YouTube transcripts via Supadata API
 * 3. Calling DeepSeek to analyze the transcript
 * 4. Sending results back to the side panel
 *
 * Think of it like a backend server — it does the heavy lifting
 * so the UI (side panel) can stay fast and responsive.
 */

// Import safe defaults and validation helpers. Secret keys live in
// chrome.storage.local and are never part of the extension source.
importScripts("settings.js");

const DEBUG = false;
const AI_PROVIDER_IDLE_TIMEOUT_MS = 50_000;
const AI_PROVIDER_HARD_TIMEOUT_MS = 120_000;
const AI_PROVIDER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// Prevent the YouTube content script from reading API keys or cached data.
// Side panel, options, and service-worker contexts remain trusted.
chrome.storage.local
  .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch((error) =>
    console.warn("[YouTube Digest] Could not restrict storage access:", error),
  );

async function getSettings() {
  const stored = await chrome.storage.local.get(YTD_SETTINGS.STORAGE_KEY);
  return YTD_SETTINGS.normalize(stored[YTD_SETTINGS.STORAGE_KEY]);
}

const promptFileCache = new Map();

async function loadPromptSection(fileName, heading, variables = {}) {
  let markdown = promptFileCache.get(fileName);
  if (!markdown) {
    const response = await fetch(chrome.runtime.getURL(`prompts/${fileName}`));
    if (!response.ok) {
      throw new Error(`Could not load prompt file: ${fileName}`);
    }
    markdown = await response.text();
    promptFileCache.set(fileName, markdown);
  }

  const marker = `## ${heading}`;
  const markerIndex = markdown.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }
  const sectionStart = markerIndex + marker.length;
  const nextSection = markdown.indexOf("\n## ", sectionStart);
  const section = markdown.slice(
    sectionStart,
    nextSection === -1 ? markdown.length : nextSection,
  );
  const fenceMatch = section.match(/```(?:[A-Za-z0-9_-]+)?\n([\s\S]*?)\n```/);
  if (!fenceMatch) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }

  let prompt = fenceMatch[1];
  for (const [key, value] of Object.entries(variables)) {
    prompt = prompt.split(`{${key}}`).join(String(value ?? ""));
  }
  return prompt;
}

async function requestAiCompletion({
  messages,
  maxTokens,
  temperature,
  responseFormat,
}) {
  const settings = await getSettings();
  if (!settings.aiApiKey) {
    const error = new Error(
      "DeepSeek API key not configured. Open daweige digest Settings.",
    );
    error.code = "NO_AI_KEY";
    throw error;
  }
  const body = {
    model: settings.aiModel,
    max_tokens: maxTokens,
    messages,
  };
  if (typeof temperature === "number") body.temperature = temperature;
  if (responseFormat) {
    body.response_format = responseFormat;
  }
  // Product features need bounded, predictable latency rather than reasoning traces.
  body.thinking = { type: "disabled" };

  const controller = new AbortController();
  let timeoutKind = "";
  let idleTimeoutId;
  let hardTimeoutId;
  const abortForTimeout = (kind) => {
    if (controller.signal.aborted) return;
    timeoutKind = kind;
    controller.abort();
  };
  const resetIdleTimeout = () => {
    clearTimeout(idleTimeoutId);
    idleTimeoutId = setTimeout(
      () => abortForTimeout("idle"),
      AI_PROVIDER_IDLE_TIMEOUT_MS,
    );
  };

  hardTimeoutId = setTimeout(
    () => abortForTimeout("hard"),
    AI_PROVIDER_HARD_TIMEOUT_MS,
  );
  resetIdleTimeout();
  try {
    const response = await fetch(
      YTD_SETTINGS.chatCompletionsUrl(),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.aiApiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    // Receiving headers proves DeepSeek is still making progress. DeepSeek
    // may then send blank-line body chunks while a non-streaming request queues.
    resetIdleTimeout();

    const data = await readBoundedAiResponse(response, resetIdleTimeout);
    if (!response.ok) {
      const errorData = data && typeof data === "object" ? data : {};
      const error = new Error(
        errorData.error?.message ||
          errorData.message ||
          `DeepSeek error: ${response.status}`,
      );
      error.status = response.status;
      throw error;
    }

    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) {
      const error = new Error("DeepSeek returned an empty response.");
      error.code = "EMPTY_AI_RESPONSE";
      throw error;
    }

    return { text, settings };
  } catch (error) {
    if (timeoutKind === "idle") {
      const timeoutError = new Error(
        "DeepSeek request was inactive for 50 seconds. Please Retry.",
      );
      timeoutError.code = "AI_IDLE_TIMEOUT";
      throw timeoutError;
    }
    if (timeoutKind === "hard") {
      const timeoutError = new Error(
        "DeepSeek request exceeded the 120-second limit. Please Retry.",
      );
      timeoutError.code = "AI_HARD_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(idleTimeoutId);
    clearTimeout(hardTimeoutId);
  }
}

async function readBoundedAiResponse(response, onActivity) {
  const reader = response.body?.getReader?.();
  if (reader) {
    const decoder = new TextDecoder();
    let responseText = "";
    let responseBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Every received chunk is activity, including DeepSeek's blank lines.
      onActivity();
      const byteLength = value?.byteLength ?? 0;
      responseBytes += byteLength;
      if (responseBytes > AI_PROVIDER_MAX_RESPONSE_BYTES) {
        await reader.cancel?.().catch(() => {});
        const error = new Error("DeepSeek response exceeded the 2 MiB limit.");
        error.code = "AI_RESPONSE_TOO_LARGE";
        throw error;
      }
      responseText += decoder.decode(value, { stream: true });
    }
    responseText += decoder.decode();
    return JSON.parse(responseText.trimStart());
  }

  // Some fetch implementations do not expose a readable stream. Preserve a
  // bounded body read for that case.
  if (typeof response.text === "function") {
    const responseText = await response.text();
    onActivity();
    const byteLength = new TextEncoder().encode(responseText).byteLength;
    if (byteLength > AI_PROVIDER_MAX_RESPONSE_BYTES) {
      const error = new Error("DeepSeek response exceeded the 2 MiB limit.");
      error.code = "AI_RESPONSE_TOO_LARGE";
      throw error;
    }
    return JSON.parse(responseText.trimStart());
  }

  // Legacy/test fetch shims may expose only json(). The hard and idle timers
  // still bound this fallback even though chunk-level activity is unavailable.
  const data = await response.json();
  onActivity();
  return data;
}

// ============================================================
// SIDE PANEL SETUP
// ============================================================

/**
 * When the user clicks the extension icon, open the side panel.
 * Chrome's Side Panel API lets us show a persistent panel alongside the page.
 */
chrome.action.onClicked.addListener((tab) => {
  if (isBilibiliVideoUrl(tab.url)) {
    openBilibiliPanel(tab).catch(() => {});
    return;
  }
  if (!(tab.url || "").startsWith("https://www.youtube.com")) {
    void updatePanelForTab(tab.id, tab.url, tab.windowId);
    return;
  }

  // Re-enable + open without awaiting — preserves user gesture context
  chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: "sidepanel.html",
    enabled: true,
  });
  chrome.sidePanel.open({ tabId: tab.id });
});

/**
 * Allow the side panel to open on any page, but it's designed for YouTube.
 */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

/**
 * Keep the side panel scoped to YouTube tabs only.
 *
 * Chrome side panels are "global" by default: once opened, the panel follows
 * you to every tab. To make YouTube Digest behave like a YouTube-only tool, we
 * enable the panel on YouTube tabs and disable it everywhere else. Disabling
 * on a tab makes Chrome hide/close the panel for that tab, so it never lingers
 * on a new tab or some other website.
 *
 * We have to react to BOTH things that can change "what tab you're looking at":
 *   - onUpdated: the current tab navigates to a new URL
 *   - onActivated: you switch to (or open) a different tab
 * The original code only handled onUpdated, which is why the panel stayed
 * visible when switching to an already-loaded non-YouTube tab.
 */
async function closePanelForTab(tabId, windowId) {
  // Chrome 141 added an explicit close API. On older supported versions,
  // disabling the tab-specific panel below remains the compatibility path.
  if (typeof chrome.sidePanel.close !== "function") return;

  try {
    // This closes the tab-specific panel used by YouTube Digest.
    await chrome.sidePanel.close({ tabId });
    return;
  } catch (error) {
    // Chrome 145+ rejects tabId when the visible instance is global. Close
    // that instance by window instead.
  }

  if (Number.isInteger(windowId)) {
    await chrome.sidePanel.close({ windowId }).catch(() => {});
  }
}

async function updatePanelForTab(tabId, url, windowId) {
  if (isBilibiliVideoUrl(url)) {
    await chrome.sidePanel.setOptions({ tabId, path: "sidepanel.html", enabled: true }).catch(() => {});
    return;
  }
  const isYouTube = (url || "").startsWith("https://www.youtube.com");
  if (!isYouTube) {
    // Close the visible instance first. Then disable this tab so Chrome cannot
    // reopen the global default panel as navigation settles.
    await closePanelForTab(tabId, windowId);
    await chrome.sidePanel.setOptions({ tabId, enabled: false }).catch(() => {});
    return;
  }

  // setOptions can reject if the tab just closed. Ignore that harmlessly.
  await chrome.sidePanel
    .setOptions({ tabId, path: "sidepanel.html", enabled: true })
    .catch(() => {});
}

/**
 * Gets the best URL from a tab update that can change panel availability.
 * Chrome can apply tab-specific side-panel state before a navigation commits,
 * then reset it during the commit. Handling loading and complete gives the
 * first non-YouTube navigation a reliable second reconciliation.
 */
function getNavigationUrl(changeInfo, tab) {
  if (changeInfo.url) return changeInfo.url;
  if (changeInfo.status !== "loading" && changeInfo.status !== "complete") {
    return "";
  }
  return tab.pendingUrl || tab.url || "";
}

// A tab started or completed navigation. Reconcile at both stages because
// Chrome can replace per-tab side-panel options while the page commits.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = getNavigationUrl(changeInfo, tab);
  if (!url) return; // Ignore title and favicon-only updates.
  invalidateBilibiliTab(tabId, url);
  void updatePanelForTab(tabId, url, tab.windowId);
});

// The user switched to a different tab (or opened a new one).
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  cancelInactiveBilibiliTasks(tabId, windowId);
  try {
    const tab = await chrome.tabs.get(tabId);
    void updatePanelForTab(tabId, tab.url || tab.pendingUrl, windowId);
  } catch (e) {
    // Tab vanished before we could read it — nothing to do.
  }
});

// ============================================================
// MESSAGE HANDLING
// ============================================================

/**
 * Listen for messages from the side panel and content script.
 * This is like a switchboard — different "actions" trigger different handlers.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (BILIBILI_ACTIONS.has(message.action)) {
    handleBilibiliMessage(message, sender)
      .then(sendResponse)
      .catch((error) => sendResponse(bilibiliFailure(message.requestId, error)));
    return true;
  }
  // We need to return true to indicate we'll respond asynchronously
  if (message.action === "fetchTranscript") {
    handleFetchTranscript(message.videoId)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true; // Keep the message channel open for async response
  }

  if (message.action === "analyzeTranscript") {
    // Pass video duration to help the AI validate timestamps
    handleAnalyzeTranscript(
      message.transcriptText,
      message.videoTitle,
      message.channelName,
      message.videoDescription,
      message.videoDuration,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "explainSelection") {
    // Explain selected text using DeepSeek.
    handleExplainSelection(
      message.selectedText,
      message.transcriptContext,
      message.videoTitle,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "saveNote") {
    // Save a note at the current timestamp, or save exact selected transcript
    // text when the side panel supplies it.
    handleSaveNote(
      message.videoId,
      message.timestamp,
      message.videoTitle,
      message.channelName,
      message.selectedText,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getNotes") {
    // Get all saved notes
    handleGetNotes(message.videoId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "deleteNote") {
    // Delete a specific note
    handleDeleteNote(message.noteId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getVideoInfo") {
    handleGetVideoInfo(message.tabId)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  // Translation: send content to DeepSeek.
  if (message.action === "translateContent") {
    handleTranslateContent(
      message.content,
      message.contentType,
      message.targetLanguage,
      message.videoTitle,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "checkConfig") {
    getSettings()
      .then((settings) =>
        sendResponse({
          hasSupadataKey: !!settings.supadataApiKey,
          hasAiKey: !!settings.aiApiKey,
        }),
      )
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message.action === "openOptions") {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "openSidePanel") {
    const tabId = sender.tab?.id;
    debugLog("[YouTube Digest BG] openSidePanel requested from tab:", tabId);

    // Re-enable the panel (it may have been disabled by auto-close) and open it.
    // IMPORTANT: we call setOptions + open synchronously (no await between them)
    // to preserve the user gesture context. Chrome requires sidePanel.open()
    // to be called within a user gesture — awaiting anything first can expire it.
    if (tabId) {
      chrome.sidePanel.setOptions({
        tabId,
        path: "sidepanel.html",
        enabled: true,
      });
      chrome.sidePanel
        .open({ tabId })
        .then(() => {
          // Broadcast to side panel to start digest (in case it's already open)
          setTimeout(() => {
            chrome.runtime
              .sendMessage({ action: "startDigestFromButton" })
              .catch(() => {});
          }, 300);
        })
        .catch((err) => {
          console.error("[YouTube Digest BG] openSidePanel error:", err);
        });
    } else {
      // Fallback: find the active tab
      chrome.tabs
        .query({ active: true, lastFocusedWindow: true })
        .then((tabs) => {
          if (tabs[0]) {
            chrome.sidePanel.setOptions({
              tabId: tabs[0].id,
              path: "sidepanel.html",
              enabled: true,
            });
            chrome.sidePanel.open({ tabId: tabs[0].id }).catch((err) => {
              console.error(
                "[YouTube Digest BG] openSidePanel fallback error:",
                err,
              );
            });
          }
        });
    }

    sendResponse({ success: true });
    return false;
  }

  // Relay messages from side panel to content script
  if (message.action === "relayToContent") {
    debugLog("[YouTube Digest BG] Relay request:", message.payload?.action);
    (async () => {
      try {
        // Query specifically for YouTube tabs to avoid side panel context issues
        // Try multiple query strategies to find the right tab
        let tabs = await chrome.tabs.query({
          active: true,
          lastFocusedWindow: true,
        });
        debugLog(
          "[YouTube Digest BG] Active tab in last focused window:",
          tabs.length,
          tabs[0]?.url,
        );

        // If no YouTube tab found, try broader query
        if (!tabs[0] || !tabs[0].url?.includes("youtube.com")) {
          tabs = await chrome.tabs.query({
            url: "https://www.youtube.com/*",
            active: true,
          });
          debugLog("[YouTube Digest BG] Active YouTube tabs:", tabs.length);
        }

        // Still nothing? Try any YouTube tab
        if (!tabs[0]) {
          tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
          debugLog("[YouTube Digest BG] Any YouTube tabs:", tabs.length);
        }

        if (tabs[0]) {
          debugLog(
            "[YouTube Digest BG] Sending to tab:",
            tabs[0].id,
            "URL:",
            tabs[0].url,
          );
          let response = await chrome.tabs.sendMessage(
            tabs[0].id,
            message.payload,
          );

          // For getVideoInfo, PREFER YouTube's own player data over the
          // DOM scrape. The player's videoDetails is canonical: its `author`
          // is always THIS video's channel and its `shortDescription` is the
          // full text. The DOM scrape is unreliable — e.g. on a playlist page
          // it grabbed the playlist owner's name ("Zara Zhang") instead of the
          // real channel ("Replit and Stripe"), and its description is
          // truncated while the box is collapsed. We fall back to the DOM
          // only for fields the player didn't provide.
          if (message.payload?.action === "getVideoInfo") {
            const playerInfo = await getPlayerVideoDetails(tabs[0].id);
            if (playerInfo) {
              response = {
                title: playerInfo.title || response?.title || "",
                channelName:
                  playerInfo.channelName || response?.channelName || "",
                duration: playerInfo.duration || response?.duration || 0,
                description:
                  playerInfo.description || response?.description || "",
              };
            }
          }

          debugLog("[YouTube Digest BG] Got response from content:", response);
          sendResponse({ success: true, response });
        } else {
          debugLog("[YouTube Digest BG] No YouTube tab found");
          sendResponse({ success: false, error: "No YouTube tab found" });
        }
      } catch (err) {
        console.error("[YouTube Digest BG] Relay error:", err.message);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep channel open for async response
  }
});

/**
 * Reads the current video's full details straight from YouTube's player.
 *
 * Content scripts live in an isolated world and can't touch the page's own
 * JavaScript. But with the "scripting" permission we can run a tiny function
 * in the page's MAIN world, where YouTube's player object lives. Its
 * getPlayerResponse() carries videoDetails with the FULL description —
 * unlike the DOM, which truncates it until the user clicks "...more".
 *
 * Returns null on any failure so callers can fall back to DOM scraping.
 */
async function getPlayerVideoDetails(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        try {
          const player = document.getElementById("movie_player");
          const details = player?.getPlayerResponse?.()?.videoDetails;
          if (!details) return null;
          return {
            title: details.title || "",
            channelName: details.author || "",
            description: details.shortDescription || "",
            duration: Number(details.lengthSeconds) || 0,
          };
        } catch (e) {
          return null;
        }
      },
    });
    return results?.[0]?.result || null;
  } catch (e) {
    console.warn("[YouTube Digest BG] Player details unavailable:", e.message);
    return null;
  }
}

// ============================================================
// TRANSCRIPT FETCHING VIA SUPADATA API
// ============================================================

/**
 * Fetches the transcript for a YouTube video using Supadata API.
 *
 * Supadata is a specialized service that reliably extracts transcripts
 * from YouTube videos. It handles all the complexity of parsing YouTube's
 * internal data structures, dealing with different caption formats, etc.
 *
 * API Docs: https://docs.supadata.ai
 *
 * @param {string} videoId - The YouTube video ID (e.g., "dQw4w9WgXcQ")
 * @returns {Object} - { success, transcript, transcriptText, language } or { success: false, error }
 */
async function handleFetchTranscript(videoId) {
  try {
    const settings = await getSettings();
    if (!settings.supadataApiKey) {
      return {
        success: false,
        error: "NO_SUPADATA_KEY",
        message: "Supadata API key not configured. Open daweige digest Settings.",
      };
    }

    // Share only the canonical watch URL. This strips playlist, referral,
    // timestamp, and other browsing parameters from the active tab URL.
    const canonicalVideoUrl = YTD_SETTINGS.canonicalYouTubeUrl(videoId);
    // Using the universal transcript endpoint with text=false to get timestamped chunks
    const apiUrl = new URL("https://api.supadata.ai/v1/transcript");
    apiUrl.searchParams.set("url", canonicalVideoUrl);
    apiUrl.searchParams.set("text", "false"); // Get timestamped chunks, not plain text
    apiUrl.searchParams.set("lang", "en"); // Prefer English
    // Caption-only product scope: never fall back to paid AI transcription.
    apiUrl.searchParams.set("mode", "native");

    // Make the API request
    const response = await fetch(apiUrl.toString(), {
      method: "GET",
      headers: {
        "x-api-key": settings.supadataApiKey,
      },
    });

    // Handle async jobs (for videos > 20 minutes, Supadata returns a job ID)
    if (response.status === 202) {
      const jobData = await response.json();
      // Poll for the result
      return await pollTranscriptJob(jobData.jobId, settings.supadataApiKey);
    }

    if (response.status === 206) {
      return {
        success: false,
        error: "NO_TRANSCRIPT",
        message: "No native subtitle track is available for this video.",
      };
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      if (response.status === 401) {
        return {
          success: false,
          error: "INVALID_SUPADATA_KEY",
          message: "Your Supadata API key is invalid. Open daweige digest Settings.",
        };
      }
      if (response.status === 404) {
        return {
          success: false,
          error: "NO_TRANSCRIPT",
          message: "No subtitles found for this video.",
        };
      }
      if (response.status === 429) {
        return {
          success: false,
          error: "RATE_LIMITED",
          message:
            "Supadata rate limit reached. Please wait a minute and try again.",
        };
      }
      throw new Error(
        errorData.message || `Supadata API error: ${response.status}`,
      );
    }

    const data = await response.json();

    // Parse the response into our internal format
    // Supadata returns: { content: [{ text, offset, duration, lang }], lang, availableLangs }
    const transcript = [];
    let transcriptTextPlain = ""; // Plain text for display/export
    let transcriptTextTimestamped = ""; // Timestamped text for AI analysis

    if (data.content && Array.isArray(data.content)) {
      for (const chunk of data.content) {
        if (chunk.text) {
          // Clean up caption artifacts:
          // ">>" = speaker change marker from YouTube auto-captions
          const cleanText = chunk.text.replace(/>> ?/g, "").trim();
          if (!cleanText) continue; // Skip if nothing left after cleanup

          // offset is in milliseconds, convert to seconds
          const startSeconds = Math.floor((chunk.offset || 0) / 1000);
          const minutes = Math.floor(startSeconds / 60);
          const seconds = startSeconds % 60;
          const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

          transcript.push({
            text: cleanText,
            start: startSeconds,
            duration: Math.floor((chunk.duration || 0) / 1000),
            language: chunk.lang || data.lang || null,
          });

          // Plain text without timestamps (for display/export)
          transcriptTextPlain += cleanText + " ";

          // Timestamped text for DeepSeek (format: [MM:SS] text)
          // This allows the model to reference actual transcript positions.
          transcriptTextTimestamped += `[${timestamp}] ${cleanText}\n`;
        }
      }
    }

    if (transcript.length === 0) {
      return {
        success: false,
        error: "EMPTY_TRANSCRIPT",
        message: "Supadata returned an empty transcript for this video.",
      };
    }

    return {
      success: true,
      transcript: transcript,
      transcriptText: transcriptTextPlain.trim(), // For display
      transcriptTextTimestamped: transcriptTextTimestamped.trim(), // For AI
      language: typeof data.lang === "string" ? data.lang : null,
    };
  } catch (error) {
    console.error("Transcript fetch error:", error);
    return {
      success: false,
      error: error.message || "Failed to fetch transcript",
    };
  }
}

/**
 * Polls for transcript job completion (for long videos).
 * Supadata processes videos > 20 minutes asynchronously.
 *
 * @param {string} jobId - The job ID returned by the initial request
 * @returns {Object} - Same format as handleFetchTranscript
 */
async function pollTranscriptJob(jobId, supadataApiKey) {
  const maxAttempts = 60; // Max 60 seconds of polling
  const pollInterval = 1000; // Poll every 1 second

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Wait before polling
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    const response = await fetch(
      `https://api.supadata.ai/v1/transcript/${encodeURIComponent(jobId)}`,
      {
        headers: { "x-api-key": supadataApiKey },
      },
    );

    if (!response.ok) {
      throw new Error(`Job polling failed: ${response.status}`);
    }

    const data = await response.json();

    if (data.status === "completed") {
      // Parse the completed transcript
      const transcript = [];
      let transcriptTextPlain = "";
      let transcriptTextTimestamped = "";

      if (data.content && Array.isArray(data.content)) {
        for (const chunk of data.content) {
          if (chunk.text) {
            // Clean up caption artifacts (">>" = speaker change marker)
            const cleanText = chunk.text.replace(/>> ?/g, "").trim();
            if (!cleanText) continue;

            const startSeconds = Math.floor((chunk.offset || 0) / 1000);
            const minutes = Math.floor(startSeconds / 60);
            const seconds = startSeconds % 60;
            const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

            transcript.push({
              text: cleanText,
              start: startSeconds,
              duration: Math.floor((chunk.duration || 0) / 1000),
              language: chunk.lang || data.lang || null,
            });
            transcriptTextPlain += cleanText + " ";
            transcriptTextTimestamped += `[${timestamp}] ${chunk.text}\n`;
          }
        }
      }

      return {
        success: true,
        transcript: transcript,
        transcriptText: transcriptTextPlain.trim(),
        transcriptTextTimestamped: transcriptTextTimestamped.trim(),
        language: typeof data.lang === "string" ? data.lang : null,
      };
    }

    if (data.status === "failed") {
      throw new Error("Transcript processing failed");
    }

    // Status is 'queued' or 'active' — keep polling
  }

  throw new Error("Transcript processing timed out");
}

// ============================================================
// JSON HELPER
// ============================================================

/**
 * Parses JSON returned by an LLM, tolerating the small mistakes they sometimes
 * make. Some models occasionally emit a trailing
 * comma before a ] or }, or wraps the JSON in prose / code fences. Plain
 * JSON.parse throws on those, which is what caused the "Unexpected token ']'"
 * error on the Overview tab. This function strips fences, isolates the outer
 * JSON object, removes trailing commas, and only then parses.
 *
 * @param {string} text - The raw text from the model
 * @returns {Object} - The parsed object (throws if still unparseable)
 */
function parseLooseJson(text) {
  let cleaned = (text || "").trim();

  // Strip ```json ... ``` style code fences
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }

  // Isolate the outermost { ... } in case the model added a sentence around it
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch (firstError) {
    // Most common LLM slip: a trailing comma right before a } or ].
    // e.g. ["a", "b", ]  ->  ["a", "b" ]
    const repaired = cleaned.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(repaired);
  }
}

// ============================================================
// DEEPSEEK ANALYSIS
// ============================================================

/**
 * Sends the transcript to DeepSeek for analysis.
 *
 * The prompt asks the model to produce chapters covering the whole video
 * and 3-5 key quotes with timestamps.
 *
 * @param {string} transcriptText - The full transcript as plain text
 * @param {string} videoTitle - The video title
 * @param {string} channelName - The channel name
 * @returns {Object} - { success, analysis } or { success: false, error }
 */
async function handleAnalyzeTranscript(
  transcriptText,
  videoTitle,
  channelName,
  videoDescription,
  videoDuration,
) {
  try {
    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: "DeepSeek API key not configured. Open daweige digest Settings.",
      };
    }

    // Convert duration to MM:SS format for context
    // The transcript text is already prefixed with [M:SS] markers. Its LAST
    // marker is the most reliable signal of where the content actually ends —
    // more trustworthy than the duration metadata, which is sometimes missing
    // or wrong. We use the larger of (metadata duration, last transcript stamp).
    let lastTranscriptSeconds = 0;
    const stampMatches = transcriptText.match(/\[(\d+):(\d{2})\]/g) || [];
    if (stampMatches.length) {
      const last =
        stampMatches[stampMatches.length - 1].match(/\[(\d+):(\d{2})\]/);
      lastTranscriptSeconds = parseInt(last[1]) * 60 + parseInt(last[2]);
    }

    const effectiveSeconds = Math.max(
      Math.floor(videoDuration || 0),
      lastTranscriptSeconds,
    );
    const durationMinutes = Math.floor(effectiveSeconds / 60);
    const durationSeconds = Math.floor(effectiveSeconds % 60);
    const durationFormatted = `${durationMinutes}:${String(durationSeconds).padStart(2, "0")}`;
    const maxTimestampSeconds = effectiveSeconds;

    // The "last chapter must be after" threshold (75% in) forces the model to
    // cover the WHOLE video instead of front-loading chapters near the start.
    // We do NOT prescribe a chapter count — the model picks the natural splits.
    const lateThresholdSeconds = Math.floor(effectiveSeconds * 0.75);
    const lateThreshold = `${Math.floor(lateThresholdSeconds / 60)}:${String(
      lateThresholdSeconds % 60,
    ).padStart(2, "0")}`;

    const promptVariables = {
      durationFormatted,
      lateThreshold,
      maxTimestampSeconds,
      videoTitle: videoTitle || "Unknown",
      channelName: channelName || "Unknown",
      videoDescription: videoDescription || "No description available",
      transcriptText,
    };
    const systemPrompt = await loadPromptSection(
      "analysis.md",
      "System prompt",
      promptVariables,
    );
    const userPrompt = await loadPromptSection(
      "analysis.md",
      "User prompt",
      promptVariables,
    );

    debugLog("[YouTube Digest] Requesting video analysis", settings.aiModel);
    const { text: responseText } = await requestAiCompletion({
      maxTokens: 8192,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    // Parse the JSON, tolerating trailing commas / stray prose
    let analysis = parseLooseJson(responseText);

    // Treat every model response as untrusted data. Rebuild the supported
    // schema and derive display timestamps from validated numeric seconds.
    analysis = validateAndFixTimestamps(analysis, maxTimestampSeconds);

    return {
      success: true,
      analysis: analysis,
    };
  } catch (error) {
    console.error("Analysis error:", error);
    if (error.status === 401) {
      return {
        success: false,
        error: "INVALID_AI_KEY",
        message: "DeepSeek rejected the API key.",
      };
    }
    if (error.status === 429) {
      return {
        success: false,
        error: "RATE_LIMITED",
        message: "DeepSeek rate-limited this request. Try again shortly.",
      };
    }
    return {
      success: false,
      error: error.message || "Failed to analyze transcript",
      code: error.code || null,
    };
  }
}

/**
 * Validates all timestamps in the analysis and fixes any that exceed video duration.
 * This is a safety net to prevent hallucinated timestamps from reaching the UI.
 *
 * @param {Object} analysis - The parsed analysis from DeepSeek
 * @param {number} maxSeconds - Maximum valid timestamp in seconds
 * @returns {Object} - Analysis with validated timestamps
 */
function validateAndFixTimestamps(analysis, maxSeconds) {
  const safeMax =
    Number.isFinite(Number(maxSeconds)) && Number(maxSeconds) > 0
      ? Number(maxSeconds)
      : Number.MAX_SAFE_INTEGER;

  // Helper to format seconds as MM:SS
  const formatTimestamp = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, "0")}`;
  };

  const safeString = (value, maxLength) =>
    typeof value === "string" ? value.trim().slice(0, maxLength) : "";
  const safeSeconds = (value) => {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > safeMax) {
      return null;
    }
    return Math.floor(seconds);
  };

  const chapters = (Array.isArray(analysis?.chapters) ? analysis.chapters : [])
    .slice(0, 100)
    .map((chapter) => {
      const seconds = safeSeconds(chapter?.timestampSeconds);
      const title = safeString(chapter?.title, 300);
      if (seconds === null || !title) return null;
      return {
        title,
        summary: safeString(chapter?.summary, 1500),
        timestampSeconds: seconds,
        timestamp: formatTimestamp(seconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const keyQuotes = (
    Array.isArray(analysis?.keyQuotes) ? analysis.keyQuotes : []
  )
    .slice(0, 50)
    .map((quote) => {
      const seconds = safeSeconds(quote?.timestampSeconds);
      const text = safeString(quote?.quote, 3000);
      if (seconds === null || !text) return null;
      return {
        quote: text,
        timestampSeconds: seconds,
        timestamp: formatTimestamp(seconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const keyMoments = (
    Array.isArray(analysis?.keyMoments) ? analysis.keyMoments : []
  )
    .map(safeSeconds)
    .filter((seconds) => seconds !== null)
    .slice(0, 100);

  return { chapters, keyQuotes, keyMoments };
}

// ============================================================
// VIDEO INFO EXTRACTION
// ============================================================

/**
 * Gets video info (title, channel, description) from the active YouTube tab.
 * We do this by asking the content script to read the page.
 */
async function handleGetVideoInfo(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      action: "getVideoInfo",
    });
    return response;
  } catch (error) {
    return { title: "", channelName: "", description: "" };
  }
}

// ============================================================
// EXPLAIN SELECTION
// ============================================================

/**
 * Explains selected text using DeepSeek.
 * Provides context, definitions, and clarification for complex terms.
 *
 * @param {string} selectedText - The text the user selected
 * @param {string} transcriptContext - Surrounding transcript for context
 * @param {string} videoTitle - Video title for additional context
 * @returns {Object} - { success, explanation } or { success: false, error }
 */
// ============================================================
// NOTE MANAGEMENT
// ============================================================

/**
 * Saves a note at a timestamp. Exact selected text is stored directly.
 * Other note requests find the relevant transcript line and clean it up.
 */
async function handleSaveNote(
  videoId,
  timestamp,
  videoTitle,
  channelName,
  selectedText,
) {
  try {
    const canonicalVideoUrl = YTD_SETTINGS.canonicalYouTubeUrl(videoId);
    const safeTimestamp = Math.max(0, Math.floor(Number(timestamp) || 0));
    const exactSelectedText =
      typeof selectedText === "string"
        ? selectedText.replace(/\s+/g, " ").trim().slice(0, 3000)
        : "";

    // A selected transcript note is already the exact text the user wants.
    // Save it directly without a transcript fetch or an AI cleanup request.
    if (exactSelectedText) {
      const minutes = Math.floor(safeTimestamp / 60);
      const seconds = safeTimestamp % 60;
      const note = {
        id: `note_${Date.now()}`,
        videoId,
        videoTitle:
          typeof videoTitle === "string"
            ? videoTitle.slice(0, 500)
            : "Untitled Video",
        channelName:
          typeof channelName === "string" ? channelName.slice(0, 300) : "",
        timestamp: `${minutes}:${String(seconds).padStart(2, "0")}`,
        timestampSeconds: safeTimestamp,
        timestampedUrl: `${canonicalVideoUrl}&t=${safeTimestamp}s`,
        text: exactSelectedText,
        rawText: exactSelectedText,
        createdAt: Date.now(),
      };

      await saveNoteToStorage(note);
      chrome.runtime.sendMessage({ action: "noteSaved", note }).catch(() => {});
      return { success: true, note };
    }

    // First, try to get the transcript from the digest cache. The side panel
    // saves digests to chrome.storage.LOCAL — this used to look in
    // storage.session (the wrong store), so it missed every time and
    // refetched the transcript from Supadata on every saved note.
    let transcript = null;
    try {
      const cached = await chrome.storage.local.get(`digest_${videoId}`);
      if (cached[`digest_${videoId}`]?.transcript) {
        transcript = cached[`digest_${videoId}`].transcript;
        debugLog("[YouTube Digest] Using cached transcript for note");
      }
    } catch (e) {
      debugLog("[YouTube Digest] No cached transcript, fetching...");
    }

    // If no cached transcript, fetch it
    if (!transcript) {
      const transcriptResult = await handleFetchTranscript(videoId);
      if (!transcriptResult.success) {
        return { success: false, error: "Could not fetch transcript" };
      }
      transcript = transcriptResult.transcript;
    }

    // Find the transcript line at the current timestamp
    // Look for the line that contains this timestamp (or the closest one before)
    let matchedLine = null;
    let matchedIndex = 0;
    let contextLines = [];
    let beforeLine = null; // a few sentences before
    let afterLine = null; // a few sentences after

    for (let i = 0; i < transcript.length; i++) {
      const line = transcript[i];
      if (
        line.start <= safeTimestamp &&
        (!transcript[i + 1] || transcript[i + 1].start > safeTimestamp)
      ) {
        matchedLine = line;
        matchedIndex = i;

        // Build a buffer of 2 lines before and 4 lines after the target.
        // This gives the model enough text to find a natural sentence boundary
        // and complete a thought that spans multiple short caption chunks.
        const beforeLines = [];
        for (let j = 1; j <= 2 && i - j >= 0; j++) {
          beforeLines.unshift(transcript[i - j].text);
        }
        if (beforeLines.length > 0) {
          beforeLine = beforeLines.join(" ");
        }

        const afterLines = [];
        for (let j = 1; j <= 4 && i + j < transcript.length; j++) {
          afterLines.push(transcript[i + j].text);
        }
        if (afterLines.length > 0) {
          afterLine = afterLines.join(" ");
        }

        // Get broader context (8 lines before and 12 lines after) for understanding
        const startIdx = Math.max(0, i - 8);
        const endIdx = Math.min(transcript.length - 1, i + 12);
        for (let j = startIdx; j <= endIdx; j++) {
          contextLines.push(transcript[j].text);
        }
        break;
      }
    }

    if (!matchedLine) {
      // Fallback: use the last line if timestamp is beyond transcript
      matchedLine = transcript[transcript.length - 1];
      matchedIndex = transcript.length - 1;

      // Get buffer sentence (only before, since we're at the end)
      const beforeLines = [];
      for (let j = 1; j <= 2 && matchedIndex - j >= 0; j++) {
        beforeLines.unshift(transcript[matchedIndex - j].text);
      }
      if (beforeLines.length > 0) {
        beforeLine = beforeLines.join(" ");
      }

      const startIdx = Math.max(0, matchedIndex - 8);
      for (let j = startIdx; j <= matchedIndex; j++) {
        contextLines.push(transcript[j].text);
      }
    }

    // Clean up the text with DeepSeek.
    const cleanedText = await cleanupNoteText(
      matchedLine.text,
      beforeLine,
      afterLine,
      contextLines.join(" "),
      videoTitle,
    );

    // Format timestamp as MM:SS
    const minutes = Math.floor(safeTimestamp / 60);
    const seconds = safeTimestamp % 60;
    const formattedTimestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

    // Create timestamped URL
    const timestampedUrl = `${canonicalVideoUrl}&t=${safeTimestamp}s`;

    // Create the note object
    const note = {
      id: `note_${Date.now()}`,
      videoId: videoId,
      videoTitle:
        typeof videoTitle === "string"
          ? videoTitle.slice(0, 500)
          : "Untitled Video",
      channelName:
        typeof channelName === "string" ? channelName.slice(0, 300) : "",
      timestamp: formattedTimestamp,
      timestampSeconds: safeTimestamp,
      timestampedUrl: timestampedUrl,
      text: cleanedText,
      rawText: matchedLine.text,
      createdAt: Date.now(),
    };

    // Save to storage
    await saveNoteToStorage(note);

    // Notify side panel to refresh notes list
    chrome.runtime.sendMessage({ action: "noteSaved", note }).catch(() => {});

    return { success: true, note };
  } catch (error) {
    console.error("[YouTube Digest] Save note error:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Cleans up transcript lines using DeepSeek.
 * Takes the target line plus buffer sentences (1 before, 1 after).
 * Uses JSON output to prevent any preambles from appearing.
 */
async function cleanupNoteText(
  targetText,
  beforeText,
  afterText,
  fullContext,
  videoTitle,
) {
  const settings = await getSettings();
  if (!settings.aiApiKey) {
    return [beforeText, targetText, afterText].filter(Boolean).join(" ");
  }

  try {
    debugLog("[YouTube Digest] Requesting note cleanup");
    const variables = {
      videoTitle: videoTitle || "Unknown",
      fullContext,
      beforeText: beforeText || "(none)",
      targetText,
      afterText: afterText || "(none)",
    };
    const systemPrompt = await loadPromptSection(
      "note-cleanup.md",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "note-cleanup.md",
      "User prompt",
      variables,
    );
    const { text: resultText } = await requestAiCompletion({
      maxTokens: 512,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    let result = resultText.trim() || targetText;

    // Parse the JSON response (tolerating trailing commas / fences).
    try {
      const parsed = parseLooseJson(result);
      if (typeof parsed.quote === "string" && parsed.quote.trim()) {
        return parsed.quote.trim().slice(0, 3000);
      }
    } catch (parseError) {
      console.warn(
        "[YouTube Digest] JSON parse failed for note, stripping preambles:",
        parseError,
      );
      result = result.replace(
        /^(Here'?s?( the)?( cleaned)?( version)?:?\s*)/i,
        "",
      );
      result = result.replace(
        /^(The cleaned (quote|text|version)( is)?:?\s*)/i,
        "",
      );
      result = result.replace(/^(I will.*?:?\s*)/i, "");
      result = result.replace(/^(Cleaned:?\s*)/i, "");
      result = result.replace(/^["']|["']$/g, "");
    }

    return result.slice(0, 3000);
  } catch (e) {
    console.error("[YouTube Digest] Cleanup error:", e);
  }

  // Return combined raw text if cleanup fails
  return [beforeText, targetText, afterText].filter(Boolean).join(" ");
}

/**
 * Saves a note to chrome.storage.local
 */
async function saveNoteToStorage(note) {
  const result = await chrome.storage.local.get("ytd_notes");
  const notes = result.ytd_notes || [];
  notes.unshift(note); // Add to beginning (newest first)

  // Keep only last 100 notes to prevent storage bloat
  if (notes.length > 100) {
    notes.splice(100);
  }

  await chrome.storage.local.set({ ytd_notes: notes });
}

/**
 * Gets notes from storage, optionally filtered by video ID
 */
async function handleGetNotes(videoId) {
  try {
    const result = await chrome.storage.local.get("ytd_notes");
    let notes = result.ytd_notes || [];

    if (videoId) {
      notes = notes.filter((n) => n.videoId === videoId);
    }

    return { success: true, notes };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Deletes a note by ID
 */
async function handleDeleteNote(noteId) {
  try {
    const result = await chrome.storage.local.get("ytd_notes");
    let notes = result.ytd_notes || [];
    notes = notes.filter((n) => n.id !== noteId);
    await chrome.storage.local.set({ ytd_notes: notes });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function handleExplainSelection(
  selectedText,
  transcriptContext,
  videoTitle,
) {
  try {
    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: "DeepSeek API key not configured.",
      };
    }

    const variables = {
      videoTitle: videoTitle || "Unknown",
      selectedText,
      transcriptContext: transcriptContext || "None",
    };
    const systemPrompt = await loadPromptSection(
      "explain.md",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "explain.md",
      "User prompt",
      variables,
    );

    debugLog("[YouTube Digest] Requesting selection explanation");
    const { text: explanation } = await requestAiCompletion({
      maxTokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    return {
      success: true,
      explanation: explanation.trim(),
    };
  } catch (error) {
    console.error("Explain selection error:", error);
    return {
      success: false,
      error: error.message || "Failed to explain selection",
      code: error.code || null,
    };
  }
}

// ============================================================
// TRANSLATION — Translate transcript batches into Simplified Chinese
// ============================================================
// Uses a low temperature for consistent, natural translations.

/**
 * Shared base rules that every translation prompt includes.
 * These ensure translations sound natural rather than machine-translated.
 *
 * @param {string} targetLanguage - Must be 'zh'
 * @returns {Promise<string>} - The base translation rules
 */
async function getTranslationBaseRules(targetLanguage) {
  if (targetLanguage !== "zh") {
    throw new Error(`Unsupported translation target: ${targetLanguage}`);
  }
  const langName = "Simplified Chinese";
  const langSpecific = await loadPromptSection(
    "translation.md",
    "Chinese rules",
  );
  return loadPromptSection("translation.md", "Shared base rules", {
    langName,
    langSpecific,
  });
}

function validateTranscriptBatchRequest(content) {
  const segments = content?.segments;
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > 4) {
    throw new Error("Transcript translation requires 1 to 4 segments");
  }

  const seenIds = new Set();
  let totalCharacters = 0;
  const normalized = segments.map((segment) => {
    const id = typeof segment?.id === "string" ? segment.id.trim() : "";
    const text = typeof segment?.text === "string" ? segment.text.trim() : "";
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(id) || seenIds.has(id)) {
      throw new Error("Transcript translation segment IDs must be unique and stable");
    }
    if (!text || text.length > 4000) {
      throw new Error("Transcript translation segment text is invalid or too long");
    }
    seenIds.add(id);
    totalCharacters += text.length;
    return { id, text };
  });
  if (totalCharacters > 12000) {
    throw new Error("Transcript translation batch is too large");
  }
  return normalized;
}

function looksLikeChineseTranslation(text, sourceText) {
  const latinLetters = (sourceText.match(/[A-Za-z]/g) || []).length;
  if (latinLetters < 20) return true;
  return /[\u3400-\u9fff]/.test(text);
}

/**
 * Aligns untrusted model output by exact stable ID. Missing, duplicated,
 * unknown, empty, or clearly non-Chinese values become explicit row errors.
 */
function normalizeTranslatedSegmentBatch(parsed, sourceSegments) {
  const candidates = Array.isArray(parsed?.segments) ? parsed.segments : [];
  const sourceById = new Map(sourceSegments.map((segment) => [segment.id, segment]));
  const translatedById = new Map();

  candidates.forEach((candidate) => {
    if (
      typeof candidate?.id !== "string" ||
      typeof candidate?.text !== "string" ||
      !sourceById.has(candidate.id) ||
      translatedById.has(candidate.id)
    ) {
      return;
    }
    const text = candidate.text.trim();
    const source = sourceById.get(candidate.id);
    if (text && looksLikeChineseTranslation(text, source.text)) {
      translatedById.set(candidate.id, text);
    }
  });

  return {
    segments: sourceSegments.map((source) => ({
      id: source.id,
      text: translatedById.get(source.id) || "",
      error: translatedById.has(source.id)
        ? ""
        : "Missing or invalid Chinese translation",
    })),
  };
}

/**
 * Translates content using DeepSeek.
 * @param {Object} content - JSON object containing semantic transcript segments
 * @param {string} contentType - 'transcriptBatch' or 'interfaceBatch'
 * @param {string} targetLanguage - 'zh' for Simplified Chinese
 * @param {string} videoTitle - The video title (for context)
 * @returns {Object} - { success, translatedContent } or { success: false, error }
 */
async function handleTranslateContent(
  content,
  contentType,
  targetLanguage,
  videoTitle,
) {
  try {
    if (targetLanguage !== "zh") {
      return {
        success: false,
        error: `Unsupported translation target: ${String(targetLanguage)}`,
      };
    }
    if (!["transcriptBatch", "interfaceBatch"].includes(contentType)) {
      return {
        success: false,
        error: `Unsupported translation content type: ${String(contentType)}`,
      };
    }

    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return { success: false, error: "NO_AI_KEY" };
    }

    const sourceSegments = validateTranscriptBatchRequest(content);
    const langName = "Simplified Chinese";
    const baseRules = await getTranslationBaseRules(targetLanguage);
    const promptSection =
      contentType === "transcriptBatch"
        ? "Transcript batch translation"
        : "Interface content translation";
    const systemPrompt = await loadPromptSection(
      "translation.md",
      promptSection,
      {
        langName,
        videoTitle: videoTitle || "Unknown",
        baseRules,
      },
    );
    const userContent = JSON.stringify({ segments: sourceSegments });
    const translationOptions = {
      temperature: 0.2,
      maxTokens: 1536,
      responseFormat: { type: "json_object" },
    };
    let result = await callAiTranslation(
      systemPrompt,
      userContent,
      translationOptions,
    );

    // DeepSeek JSON mode can rarely return an empty content string. The prompt
    // already requires JSON, so retry once without response_format.
    if (!result.success && result.code === "EMPTY_AI_RESPONSE") {
      result = await callAiTranslation(systemPrompt, userContent, {
        temperature: translationOptions.temperature,
        maxTokens: translationOptions.maxTokens,
      });
    }
    if (!result.success) return result;

    const parsed = parseLooseJson(result.text);
    const aligned = normalizeTranslatedSegmentBatch(parsed, sourceSegments);
    if (!aligned.segments.some((segment) => segment.text)) {
      return {
        success: false,
        error: "Translation returned no valid Chinese segments",
      };
    }
    return { success: true, translatedContent: aligned };
  } catch (error) {
    console.error("[YouTube Digest] Translation error:", error);
    return {
      success: false,
      error: error.message || "Translation failed",
      code: error.code || null,
    };
  }
}

/**
 * Makes a single DeepSeek call for translation.
 * Uses temperature 0.3 for consistent, predictable translations.
 *
 * @param {string} systemPrompt - The system-level instructions
 * @param {string} userContent - The user message (content to translate)
 * @returns {Object} - { success, text } or { success: false, error }
 */
async function callAiTranslation(
  systemPrompt,
  userContent,
  { temperature = 0.3, maxTokens = 8192, responseFormat } = {},
) {
  try {
    const { text } = await requestAiCompletion({
      temperature,
      maxTokens,
      responseFormat,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    });

    return { success: true, text };
  } catch (error) {
    if (error.status === 429) {
      return {
        success: false,
        error: "Rate limited — try again in a moment",
        code: "RATE_LIMITED",
      };
    }
    return { success: false, error: error.message, code: error.code };
  }
}

// Pure validators are exposed for the repository's Node tests only.
globalThis.__YTD_TRANSLATION_TESTING__ = {
  requestAiCompletion,
  callAiTranslation,
  validateTranscriptBatchRequest,
  normalizeTranslatedSegmentBatch,
  handleSaveNote,
  handleTranslateContent,
  closePanelForTab,
  updatePanelForTab,
};

// Bilibili transport and identity remain separate from the YouTube pipeline.
const BILIBILI_ACTIONS = new Set([
  "bilibiliOpenSidePanel", "bilibiliVideoChanged", "resolveBilibiliVideo",
  "fetchBilibiliTranscript", "bilibiliRelayToContent", "saveBilibiliNote",
]);
const BILIBILI_MIXIN_TABLE = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
const bilibiliBindings = new Map();
const bilibiliTasks = new Map();
const bilibiliBodies = new Map();
let bilibiliTaskQueue = Promise.resolve();
let bilibiliApiQueue = Promise.resolve();
let bilibiliLastStart = -Infinity;
let bilibiliCooldownUntil = 0;
let bilibiliNav = null;
let bilibiliNoteQueue = Promise.resolve();
// Bilibili error text ships in both interface languages. The side panel picks
// `message` or `messageEn` from the wire payload based on the current UI
// language, so the worker itself never reads the language setting.
const BILIBILI_ERRORS = {
  INVALID_REQUEST: { "zh-CN": "请求参数无效", en: "Invalid request parameters" },
  UNSUPPORTED_PAGE: { "zh-CN": "不支持此页面", en: "This page is not supported" },
  STALE_CONTEXT: { "zh-CN": "视频页面已切换", en: "The video page has changed" },
  VIDEO_UNAVAILABLE: { "zh-CN": "视频不可访问或无权限", en: "Video unavailable or no permission" },
  PAGE_NOT_FOUND: { "zh-CN": "视频分 P 不存在", en: "Video part not found" },
  RATE_LIMITED: { "zh-CN": "请求暂时受限，请稍后重试", en: "Requests temporarily limited; please retry later" },
  NETWORK_ERROR: { "zh-CN": "网络请求失败，请重试", en: "Network request failed; please retry" },
  TIMEOUT: { "zh-CN": "请求超时，请重试", en: "Request timed out; please retry" },
  WBI_KEY_UNAVAILABLE: { "zh-CN": "签名信息暂不可用", en: "Signature data temporarily unavailable" },
  INVALID_RESPONSE: { "zh-CN": "无法安全读取响应", en: "Could not safely read the response" },
  SUBTITLE_MISMATCH: { "zh-CN": "无法确认字幕属于当前视频", en: "Could not confirm the subtitles belong to this video" },
  TAB_GONE: { "zh-CN": "标签页已关闭", en: "The tab was closed" },
  CONTENT_UNAVAILABLE: { "zh-CN": "页面脚本不可用，请刷新页面", en: "Page script unavailable; please refresh the page" },
  PLAYER_NOT_READY: { "zh-CN": "播放器尚未就绪", en: "Player not ready" },
  TRANSCRIPT_NOT_READY: { "zh-CN": "当前分 P 尚无可用字幕", en: "No subtitles available for this part yet" },
  STORAGE_FAILED: { "zh-CN": "本地存储失败", en: "Local storage failed" },
  PANEL_OPEN_FAILED: { "zh-CN": "侧边栏打开失败", en: "Could not open the side panel" },
};
function bilibiliErrorText(code) {
  return (BILIBILI_ERRORS[code] || BILIBILI_ERRORS.INVALID_RESPONSE)["zh-CN"];
}
function bilibiliError(code, extra = {}) {
  return Object.assign(new Error(bilibiliErrorText(code)), {
    code, retryable: ["RATE_LIMITED", "NETWORK_ERROR", "TIMEOUT", "WBI_KEY_UNAVAILABLE",
      "PLAYER_NOT_READY", "CONTENT_UNAVAILABLE", "STORAGE_FAILED", "PANEL_OPEN_FAILED"].includes(code), ...extra,
  });
}
function bilibiliFailure(requestId, error) {
  const safe = BILIBILI_ERRORS[error?.code] ? error : bilibiliError("INVALID_RESPONSE");
  return { success: false, requestId, error: {
    code: safe.code, message: bilibiliErrorText(safe.code),
    messageEn: BILIBILI_ERRORS[safe.code].en, retryable: !!safe.retryable,
    ...(safe.code === "RATE_LIMITED" ? { retryAfterMs: Math.max(0, safe.retryAfterMs || 60000) } : {}),
  } };
}
function bilibiliPositiveId(value) {
  return (typeof value === "string" && /^[1-9]\d*$/.test(value)) ||
    (Number.isSafeInteger(value) && value > 0);
}
function validateBilibiliLocator(input) {
  if (!input || typeof input !== "object") throw bilibiliError("INVALID_REQUEST");
  const { bvid, aid, page = 1 } = input;
  if ((bvid != null && (typeof bvid !== "string" || !/^BV[1-9A-HJ-NP-Za-km-z]{10}$/.test(bvid))) ||
      (aid != null && !bilibiliPositiveId(aid)) || (!bvid && !aid) ||
      !Number.isSafeInteger(page) || page < 1) throw bilibiliError("INVALID_REQUEST");
  return { ...(bvid ? { bvid } : {}), ...(aid ? { aid: String(aid) } : {}), page };
}
function parseBilibiliUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw bilibiliError("UNSUPPORTED_PAGE"); }
  if (url.protocol !== "https:" || url.hostname !== "www.bilibili.com" || url.port || url.username || url.password)
    throw bilibiliError("UNSUPPORTED_PAGE");
  const match = /^\/video\/(BV[1-9A-HJ-NP-Za-km-z]{10}|av[1-9]\d*)\/?$/.exec(url.pathname);
  if (!match) throw bilibiliError("UNSUPPORTED_PAGE");
  const pages = url.searchParams.getAll("p");
  if (pages.length > 1 || (pages.length && !/^[1-9]\d*$/.test(pages[0]))) throw bilibiliError("INVALID_REQUEST");
  return validateBilibiliLocator({ ...(match[1].startsWith("BV") ? { bvid: match[1] } : { aid: match[1].slice(2) }), page: pages.length ? Number(pages[0]) : 1 });
}
function isBilibiliVideoUrl(url) {
  try { parseBilibiliUrl(url); return true; } catch { return false; }
}
function bilibiliFingerprint(locator) {
  return `${locator.bvid || `av${locator.aid}`}:${locator.page}`;
}
function bilibiliLocatorMatches(locator, video) {
  return locator.page === video.page && (!locator.bvid || locator.bvid === video.bvid) &&
    (!locator.aid || locator.aid === video.aid);
}
function bilibiliVideoFromView(locator, data) {
  validateBilibiliLocator(locator);
  if (!data || !Array.isArray(data.pages) || !bilibiliPositiveId(data.aid) ||
      !/^BV[1-9A-HJ-NP-Za-km-z]{10}$/.test(data.bvid || "")) throw bilibiliError("INVALID_RESPONSE");
  if ((locator.bvid && locator.bvid !== data.bvid) || (locator.aid && locator.aid !== String(data.aid)))
    throw bilibiliError("SUBTITLE_MISMATCH");
  const part = data.pages.find((item) => item.page === locator.page);
  if (!part) throw bilibiliError("PAGE_NOT_FOUND");
  if (!bilibiliPositiveId(part.cid) || !Number.isFinite(part.duration) || part.duration < 0)
    throw bilibiliError("INVALID_RESPONSE");
  return { platform: "bilibili", bvid: data.bvid, aid: String(data.aid), cid: String(part.cid),
    page: locator.page, videoKey: `bilibili:${data.bvid}:${part.cid}`,
    canonicalUrl: `https://www.bilibili.com/video/${data.bvid}/?p=${locator.page}`,
    title: typeof data.title === "string" ? data.title : "",
    channelName: typeof data.owner?.name === "string" ? data.owner.name : "",
    description: typeof data.desc === "string" ? data.desc : "", duration: part.duration };
}

// RFC 1321 rounds, implemented locally; no runtime library or Node dependency.
function md5Hex(text) {
  const bytes = new TextEncoder().encode(String(text));
  const length = Math.ceil((bytes.length + 9) / 64) * 64;
  const buffer = new Uint8Array(length);
  buffer.set(bytes); buffer[bytes.length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(length - 8, (bytes.length * 8) >>> 0, true);
  view.setUint32(length - 4, Math.floor(bytes.length / 0x20000000), true);
  const shifts = [[7,12,17,22], [5,9,14,20], [4,11,16,23], [6,10,15,21]];
  const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let offset = 0; offset < length; offset += 64) {
    let [a,b,c,d] = state;
    for (let i = 0; i < 64; i++) {
      const round = i >>> 4;
      const f = round === 0 ? (b & c) | (~b & d) : round === 1 ? (d & b) | (~d & c) : round === 2 ? b ^ c ^ d : c ^ (b | ~d);
      const index = round === 0 ? i : round === 1 ? (5 * i + 1) % 16 : round === 2 ? (3 * i + 5) % 16 : (7 * i) % 16;
      const sum = (a + f + Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) + view.getUint32(offset + index * 4, true)) | 0;
      const shift = shifts[round][i % 4];
      const next = (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0;
      a = d; d = c; c = b; b = next;
    }
    [a,b,c,d].forEach((word, index) => { state[index] = (state[index] + word) | 0; });
  }
  return state.map((word) => [0,8,16,24].map((shift) => ((word >>> shift) & 255).toString(16).padStart(2, "0")).join("")).join("");
}
function bilibiliMixinKey(imgUrl, subUrl) {
  const keys = [imgUrl, subUrl].map((value) => {
    try { return /\/([a-fA-F0-9]{32})\.[a-zA-Z0-9]+$/.exec(new URL(value).pathname)?.[1]; } catch { return null; }
  });
  if (keys.some((key) => !key)) throw bilibiliError("WBI_KEY_UNAVAILABLE");
  const raw = keys.join("");
  return BILIBILI_MIXIN_TABLE.slice(0, 32).map((index) => raw[index]).join("");
}
function signBilibiliParams(params, mixinKey, wts = Math.floor(Date.now() / 1000)) {
  if (!/^[a-fA-F0-9]{32}$/.test(mixinKey || "") || !Number.isSafeInteger(wts) || wts < 0)
    throw bilibiliError("WBI_KEY_UNAVAILABLE");
  const values = { ...params, wts };
  delete values.w_rid;
  const query = Object.keys(values).sort().map((key) =>
    `${encodeURIComponent(key)}=${encodeURIComponent(String(values[key]).replace(/[!'()*]/g, ""))}`).join("&");
  return `${query}&w_rid=${md5Hex(query + mixinKey)}`;
}
function validateSubtitleUrl(value, cid, language = "") {
  if (typeof value !== "string" || !bilibiliPositiveId(cid)) throw bilibiliError("SUBTITLE_MISMATCH");
  let url;
  try { url = new URL(value.startsWith("//") ? `https:${value}` : value); } catch { throw bilibiliError("SUBTITLE_MISMATCH"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !url.hostname.endsWith(".hdslb.com")) throw bilibiliError("SUBTITLE_MISMATCH");
  // Filenames are hashes for manual CC and AI tracks alike; real-world AI URLs
  // do not carry the cid as a standalone token (verified against a live video
  // on 2026-09-17, where all five ai-* tracks used pure-hash names). The cid
  // gate stays as defense in depth: any standalone numeric token must match
  // the current video. Hard guarantees are unchanged: host allowlist, official
  // wbi/v2 lists only, legacy API disabled, redirects rejected.
  const tokens = [...url.pathname.matchAll(/(?:^|[^a-z0-9])([0-9]+)(?=[^a-z0-9]|$)/gi)];
  if (tokens.some((match) => match[1] !== String(cid))) throw bilibiliError("SUBTITLE_MISMATCH");
  return url.href;
}
function bilibiliLanguage(value) {
  const language = String(value || "").replace(/^ai-/i, "");
  if (/^zh(?:-|$)/i.test(language)) return language === "zh" ? "zh-CN" : language;
  return language || "und";
}
function convertBilibiliRows(rows, language, asr = false) {
  if (!Array.isArray(rows)) throw bilibiliError("INVALID_RESPONSE");
  // Only short, recognizable access-block notices imply a business failure.
  if (!asr && rows.length && rows.length <= 8 && rows.every((row) => row &&
      typeof row.content === "string" && row.content.trim() &&
      !Object.prototype.hasOwnProperty.call(row, "from") && !Object.prototype.hasOwnProperty.call(row, "to")) &&
      rows.some((row) => /无法观看|不可观看|稿件/.test(row.content)))
    throw bilibiliError("VIDEO_UNAVAILABLE");
  let malformed = 0;
  const transcript = [];
  for (const row of rows) {
    const start = row?.[asr ? "start_timestamp" : "from"];
    const end = row?.[asr ? "end_timestamp" : "to"];
    if (typeof row?.content !== "string" || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
      malformed++; continue;
    }
    const text = row.content.trim();
    if (text) transcript.push({ text, start, duration: end - start, language });
  }
  if (rows.length && malformed === rows.length) throw bilibiliError("INVALID_RESPONSE");
  return transcript.sort((a, b) => a.start - b.start);
}
function convertBilibiliBCC(data, language) {
  return convertBilibiliRows(data?.body, bilibiliLanguage(language));
}
function convertBilibiliASR(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw bilibiliError("INVALID_RESPONSE");
  if (data.code === -1 || data.code === 1) return [];
  if (data.code !== 0 || !data.model_result || typeof data.model_result !== "object") throw bilibiliError("INVALID_RESPONSE");
  const groups = data.model_result.subtitle;
  if (groups === undefined) return []; // Summary/outline alone are not transcripts.
  if (!Array.isArray(groups) || groups.some((group) => !Array.isArray(group?.part_subtitle))) throw bilibiliError("INVALID_RESPONSE");
  return convertBilibiliRows(groups.flatMap((group) => group.part_subtitle), "zh-CN", true);
}
function bilibiliTranscriptResult(video, transcript, language, source) {
  const endSeconds = transcript.reduce((end, line) => Math.max(end, line.start + line.duration), 0);
  return { success: true, status: "ready", video, transcript,
    transcriptText: transcript.map((line) => line.text).join(" "),
    transcriptTextTimestamped: transcript.map((line) => `[${Math.floor(line.start / 60)}:${String(Math.floor(line.start) % 60).padStart(2, "0")}] ${line.text}`).join("\n"),
    language, source, originalAvailable: source !== "conclusion",
    coverage: { endSeconds, videoDuration: video.duration,
      possiblyPartial: video.duration - endSeconds > Math.max(30, video.duration * 0.05) }, warnings: [] };
}
function selectBilibiliTrack(tracks, cid) {
  if (!Array.isArray(tracks)) throw bilibiliError("INVALID_RESPONSE");
  const valid = [];
  let mismatch = false;
  let pending = false;
  for (const track of tracks) {
    if (!track || typeof track !== "object" || Array.isArray(track)) throw bilibiliError("INVALID_RESPONSE");
    // Bilibili can list a track before its subtitle file has been generated.
    if (!track.subtitle_url) { pending = true; continue; }
    if (typeof track.lan !== "string" || typeof track.subtitle_url !== "string") throw bilibiliError("INVALID_RESPONSE");
    try {
      if (bilibiliLanguage(track.lan) === "und") throw bilibiliError("SUBTITLE_MISMATCH");
      const url = validateSubtitleUrl(track.subtitle_url, cid, track.lan);
      valid.push({ url, language: bilibiliLanguage(track.lan),
        source: /^ai-/i.test(track.lan) || /(?:^|\/)ai_subtitle(?:\/|$)/i.test(new URL(url).pathname) ? "ai" : "cc",
        id: String(track.id_str ?? track.id ?? "") });
    } catch (error) { if (error.code !== "SUBTITLE_MISMATCH") throw error; mismatch = true; }
  }
  valid.sort((a, b) => Number(/^zh/i.test(a.language)) - Number(/^zh/i.test(b.language)) ||
    a.language.localeCompare(b.language) || Number(a.source === "ai") - Number(b.source === "ai") || a.id.localeCompare(b.id));
  return { track: valid[0], mismatch, pending };
}

function bilibiliCheckTask(task) {
  if (task?.controller.signal.aborted) throw task.controller.signal.reason || bilibiliError("STALE_CONTEXT");
  if (task && Date.now() >= task.deadline) throw bilibiliError("TIMEOUT");
}
function bilibiliDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
async function bilibiliCheckCooldown() {
  try {
    const saved = await chrome.storage.session.get("bilibiliCooldownUntil");
    if (Number.isFinite(saved.bilibiliCooldownUntil)) bilibiliCooldownUntil = Math.max(bilibiliCooldownUntil, saved.bilibiliCooldownUntil);
    const fallback = await chrome.storage.local.get("bilibiliCooldownUntil");
    if (Number.isFinite(fallback.bilibiliCooldownUntil)) bilibiliCooldownUntil = Math.max(bilibiliCooldownUntil, fallback.bilibiliCooldownUntil);
  } catch { throw bilibiliError("STORAGE_FAILED"); }
  if (Date.now() < bilibiliCooldownUntil) throw bilibiliError("RATE_LIMITED", { retryAfterMs: bilibiliCooldownUntil - Date.now() });
}
async function bilibiliEnterCooldown(response) {
  const value = response.headers?.get("Retry-After");
  const seconds = value === null || value === undefined ? NaN : Number(value);
  const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  bilibiliCooldownUntil = Math.max(bilibiliCooldownUntil, Date.now() + Math.max(60000, Number.isFinite(wait) ? wait : 0));
  try { await chrome.storage.session.set({ bilibiliCooldownUntil }); }
  catch {
    // Only a deadline is persisted; this fallback contains no account data.
    try { await chrome.storage.local.set({ bilibiliCooldownUntil }); }
    catch { throw bilibiliError("STORAGE_FAILED"); }
  }
  throw bilibiliError("RATE_LIMITED", { retryAfterMs: bilibiliCooldownUntil - Date.now() });
}
async function bilibiliAssertContext(tabId, locator) {
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { throw bilibiliError("TAB_GONE"); }
  const actual = parseBilibiliUrl(tab.pendingUrl || tab.url);
  const active = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  if (!active.some((candidate) => candidate.id === tabId) ||
      (locator && !bilibiliLocatorMatches(actual, locator))) throw bilibiliError("STALE_CONTEXT");
  return { tab, locator: actual };
}
async function bilibiliRequest(url, task, { subtitle = false, cid } = {}) {
  const execute = async () => {
    bilibiliCheckTask(task);
    await bilibiliCheckCooldown();
    const delay = bilibiliLastStart + 1200 - Date.now();
    if (delay > 0) await bilibiliDelay(delay, task?.controller.signal);
    bilibiliCheckTask(task);
    if (task) await bilibiliAssertContext(task.tabId, task.locator);
    await bilibiliCheckCooldown();
    bilibiliCheckTask(task);
    bilibiliLastStart = Date.now();
    const controller = new AbortController();
    const abort = () => controller.abort(task.controller.signal.reason);
    task?.controller.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(bilibiliError("TIMEOUT")), Math.min(15000, task ? Math.max(1, task.deadline - Date.now()) : 15000));
    try {
      // redirect:"error" refuses to follow redirects; fetch rejects and becomes NETWORK_ERROR.
      const response = await fetch(url, { credentials: subtitle ? "omit" : "include", redirect: "error", signal: controller.signal });
      if (response.status === 412 || response.status === 429) await bilibiliEnterCooldown(response);
      if (response.redirected || (response.url && response.url !== url)) {
        if (subtitle) validateSubtitleUrl(response.url, cid);
        throw bilibiliError(subtitle ? "SUBTITLE_MISMATCH" : "INVALID_RESPONSE");
      }
      if (subtitle && [401, 403, 404].includes(response.status)) throw bilibiliError("NETWORK_ERROR", { subtitleExpired: true });
      if (response.status === 401 || response.status === 403 || response.status === 404) throw bilibiliError("VIDEO_UNAVAILABLE");
      if (!response.ok) throw bilibiliError("NETWORK_ERROR");
      let body;
      try { body = await response.json(); } catch { throw bilibiliError("INVALID_RESPONSE"); }
      bilibiliCheckTask(task);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw bilibiliError("INVALID_RESPONSE");
      if (body.code === -352 || body.v_voucher || body.data?.v_voucher) await bilibiliEnterCooldown(response);
      if (!subtitle) {
        if (body.code === -101) throw bilibiliError("VIDEO_UNAVAILABLE", { loginRequired: true });
        if (body.code === -403 && /(?:wbi|signature|签名).*(?:expired|invalid|过期|失效|错误)/i.test(String(body.message || "")))
          throw bilibiliError("WBI_KEY_UNAVAILABLE", { signatureExpired: true });
        if ([-400,-403,-404,-10403,62002,62004].includes(body.code)) throw bilibiliError("VIDEO_UNAVAILABLE");
        // Only conclusion uses these outer codes to report an explicit empty result.
        if (new URL(url).pathname === "/x/web-interface/view/conclusion/get" && (body.code === -1 || body.code === 1))
          return { code: body.code };
        if (body.code !== 0 || !body.data || typeof body.data !== "object") throw bilibiliError("INVALID_RESPONSE");
        return body.data;
      }
      return body;
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason || bilibiliError("TIMEOUT");
      if (error?.code && BILIBILI_ERRORS[error.code]) throw error;
      throw bilibiliError("NETWORK_ERROR");
    } finally {
      clearTimeout(timer);
      task?.controller.signal.removeEventListener("abort", abort);
    }
  };
  const pending = bilibiliApiQueue.then(execute);
  bilibiliApiQueue = pending.catch(() => {});
  return pending;
}
async function bilibiliGetNav(task, refresh = false) {
  if (!refresh && bilibiliNav && Date.now() - bilibiliNav.at < 86400000) return bilibiliNav;
  let data;
  try { data = await bilibiliRequest("https://api.bilibili.com/x/web-interface/nav", task); }
  catch (error) { if (error.loginRequired) return { loggedIn: false }; throw error; }
  if (typeof data.isLogin !== "boolean") throw bilibiliError("INVALID_RESPONSE");
  if (!data.isLogin) return { loggedIn: false };
  bilibiliNav = { loggedIn: data.isLogin, mixinKey: bilibiliMixinKey(data.wbi_img?.img_url, data.wbi_img?.sub_url), at: Date.now() };
  return bilibiliNav;
}
async function bilibiliSignedRequest(path, params, task, nav) {
  try { return await bilibiliRequest(`https://api.bilibili.com${path}?${signBilibiliParams(params, nav.mixinKey)}`, task); }
  catch (error) {
    if (!error.signatureExpired) throw error;
    const fresh = await bilibiliGetNav(task, true);
    if (!fresh.loggedIn) throw bilibiliError("VIDEO_UNAVAILABLE", { loginRequired: true });
    return bilibiliRequest(`https://api.bilibili.com${path}?${signBilibiliParams(params, fresh.mixinKey)}`, task);
  }
}
async function resolveBilibiliVideo(tabId, locator, task) {
  locator = validateBilibiliLocator(locator);
  const { tab, locator: actual } = await bilibiliAssertContext(tabId);
  if (locator.page !== actual.page || (actual.bvid && locator.bvid !== actual.bvid) || (actual.aid && locator.aid !== actual.aid))
    throw bilibiliError("STALE_CONTEXT");
  const fingerprint = bilibiliFingerprint(actual);
  const cached = bilibiliBindings.get(tabId);
  if (cached?.fingerprint === fingerprint && Date.now() - cached.at < 300000 && bilibiliLocatorMatches(locator, cached.video)) return cached.video;
  const query = actual.bvid ? `bvid=${actual.bvid}` : `aid=${actual.aid}`;
  const data = await bilibiliRequest(`https://api.bilibili.com/x/web-interface/view?${query}`, task);
  const video = bilibiliVideoFromView(locator, data);
  await bilibiliAssertContext(tabId, video);
  bilibiliCheckTask(task);
  if (!bilibiliPositiveId(data.owner?.mid)) throw bilibiliError("INVALID_RESPONSE");
  bilibiliBindings.set(tabId, { fingerprint, video, mid: String(data.owner.mid), at: Date.now(), windowId: tab.windowId });
  return video;
}
function validateBilibiliVideo(video) {
  validateBilibiliLocator(video);
  if (video.platform !== "bilibili" || !bilibiliPositiveId(video.cid) || typeof video.cid !== "string" ||
      typeof video.aid !== "string" || !video.bvid || video.videoKey !== `bilibili:${video.bvid}:${video.cid}`)
    throw bilibiliError("INVALID_REQUEST");
}
async function bilibiliBoundVideo(tabId, supplied, task) {
  validateBilibiliVideo(supplied);
  const { locator } = await bilibiliAssertContext(tabId, supplied);
  if (!task) {
    const video = await runBilibiliTask(tabId, locator, "binding", (current) => bilibiliBoundVideo(tabId, supplied, current));
    if (["bvid","aid","cid","page","videoKey"].some((field) => supplied[field] !== video[field])) throw bilibiliError("STALE_CONTEXT");
    return video;
  }
  const video = await resolveBilibiliVideo(tabId, { ...locator, bvid: supplied.bvid, aid: supplied.aid }, task);
  if (["bvid","aid","cid","page","videoKey"].some((field) => supplied[field] !== video[field])) throw bilibiliError("STALE_CONTEXT");
  return video;
}
function runBilibiliTask(tabId, locator, kind, execute) {
  const key = `${tabId}:${bilibiliFingerprint(locator)}:${kind}`;
  const existing = bilibiliTasks.get(key);
  if (existing && !existing.controller.signal.aborted) return existing.promise;
  const task = { tabId, locator, controller: new AbortController(), deadline: Date.now() + 90000,
    windowId: bilibiliBindings.get(tabId)?.windowId };
  const timer = setTimeout(() => task.controller.abort(bilibiliError("TIMEOUT")), 90000);
  const work = bilibiliTaskQueue.then(async () => {
    bilibiliCheckTask(task);
    const { tab } = await bilibiliAssertContext(tabId, locator);
    task.windowId = tab.windowId;
    const result = await execute(task);
    bilibiliCheckTask(task);
    await bilibiliAssertContext(tabId, locator);
    return result;
  });
  let abortListener;
  const cancelled = new Promise((resolve, reject) => {
    abortListener = () => reject(task.controller.signal.reason);
    task.controller.signal.addEventListener("abort", abortListener, { once: true });
  });
  task.promise = Promise.race([work, cancelled]).finally(() => {
    clearTimeout(timer);
    task.controller.signal.removeEventListener("abort", abortListener);
    if (bilibiliTasks.get(key) === task) bilibiliTasks.delete(key);
  });
  bilibiliTaskQueue = work.catch(() => {});
  bilibiliTasks.set(key, task);
  return task.promise;
}
function invalidateBilibiliTab(tabId, url) {
  let locator;
  try { locator = parseBilibiliUrl(url); } catch { /* Leaving a supported page. */ }
  const binding = bilibiliBindings.get(tabId);
  if (!locator || binding?.fingerprint !== bilibiliFingerprint(locator)) bilibiliBindings.delete(tabId);
  for (const task of bilibiliTasks.values()) {
    if (task.tabId === tabId && (!locator || !bilibiliLocatorMatches(locator, task.locator)))
      task.controller.abort(bilibiliError("STALE_CONTEXT"));
  }
}
function cancelInactiveBilibiliTasks(tabId, windowId) {
  for (const task of bilibiliTasks.values()) {
    if (task.tabId !== tabId && (task.windowId === undefined || task.windowId === windowId))
      task.controller.abort(bilibiliError("STALE_CONTEXT"));
  }
}
async function fetchBilibiliTranscript(tabId, supplied, task) {
  const video = await bilibiliBoundVideo(tabId, supplied, task);
  // An empty/failed refresh must not leave an old transcript usable for notes.
  bilibiliBodies.set(video.videoKey, { transcript: [], at: Date.now() });
  let pending = false;
  const empty = (status) => ({ success: true, status, video,
    message: status === "login-required" ? "请先登录 B 站" : "当前视频暂无可用字幕",
    messageEn: status === "login-required" ? "Please log in to Bilibili" : "No subtitles available for this video",
    warnings: status === "no-subtitle" && pending ? ["SUBTITLE_PENDING"] : [] });
  try {
    // Refresh login state for each user task; cache contains no account details.
    const nav = await bilibiliGetNav(task, true);
    if (!nav.loggedIn) return empty("login-required");
    for (let attempt = 0; attempt < 2; attempt++) {
      const data = await bilibiliSignedRequest("/x/player/wbi/v2", { bvid: video.bvid, cid: video.cid }, task, nav);
      if (!data.subtitle || !Array.isArray(data.subtitle.subtitles)) throw bilibiliError("INVALID_RESPONSE");
      const selected = selectBilibiliTrack(data.subtitle.subtitles, video.cid);
      pending ||= selected.pending;
      if (!selected.track) break;
      const { track } = selected;
      let body;
      try { body = await bilibiliRequest(track.url, task, { subtitle: true, cid: video.cid }); }
      catch (error) {
        if (error.subtitleExpired && attempt === 0) continue;
        throw error;
      }
      const transcript = convertBilibiliBCC(body, track.language);
      if (!transcript.length) break;
      const result = bilibiliTranscriptResult(video, transcript, track.language, track.source);
      await bilibiliAssertContext(tabId, video);
      bilibiliCheckTask(task);
      bilibiliBodies.set(video.videoKey, { transcript, at: Date.now() });
      return result;
    }
    const mid = bilibiliBindings.get(tabId)?.mid;
    if (!mid) throw bilibiliError("STALE_CONTEXT");
    const data = await bilibiliSignedRequest("/x/web-interface/view/conclusion/get", { bvid: video.bvid, cid: video.cid, up_mid: mid }, task, bilibiliNav || nav);
    const transcript = convertBilibiliASR(data);
    // Explicit ASR emptiness wins over rejected tracks; technical failures still throw.
    if (!transcript.length) return empty("no-subtitle");
    const result = bilibiliTranscriptResult(video, transcript, "zh-CN", "conclusion");
    await bilibiliAssertContext(tabId, video);
    bilibiliCheckTask(task);
    bilibiliBodies.set(video.videoKey, { transcript, at: Date.now() });
    return result;
  } catch (error) {
    if (error.loginRequired) return empty("login-required");
    throw error;
  }
}

function openBilibiliPanel(tab) {
  // Keep open in the original user-gesture stack, before any await.
  try {
    chrome.sidePanel.setOptions({ tabId: tab.id, path: "sidepanel.html", enabled: true }).catch(() => {});
    return Promise.resolve(chrome.sidePanel.open({ tabId: tab.id })).then(() => {
      chrome.runtime.sendMessage({ action: "bilibiliPanelOpened", tabId: tab.id, windowId: tab.windowId }).catch(() => {});
    }).catch(() => { throw bilibiliError("PANEL_OPEN_FAILED"); });
  } catch { return Promise.reject(bilibiliError("PANEL_OPEN_FAILED")); }
}
async function handleSaveBilibiliNote(message) {
  const { tabId, timestamp, selectedText } = message;
  if (!Number.isFinite(timestamp) || timestamp < 0 || (selectedText !== undefined && typeof selectedText !== "string")) throw bilibiliError("INVALID_REQUEST");
  const video = await bilibiliBoundVideo(tabId, message.video);
  let transcript = bilibiliBodies.get(video.videoKey)?.transcript;
  if (!transcript) {
    try { transcript = (await chrome.storage.local.get(`digest_${video.videoKey}`))[`digest_${video.videoKey}`]?.transcript; }
    catch { throw bilibiliError("STORAGE_FAILED"); }
  }
  if (!Array.isArray(transcript) || !transcript.length || transcript.some((line) => typeof line?.text !== "string" || !Number.isFinite(line.start)))
    throw bilibiliError("TRANSCRIPT_NOT_READY");
  const seconds = Math.floor(Math.min(timestamp, video.duration));
  let rawText = selectedText?.trim() ? selectedText : "";
  let text = rawText;
  if (!rawText) {
    const index = transcript.findLastIndex((line) => line.start <= timestamp);
    if (index < 0) throw bilibiliError("TRANSCRIPT_NOT_READY");
    rawText = transcript[index].text;
    text = await cleanupNoteText(rawText, transcript.slice(Math.max(0, index - 2), index).map((line) => line.text).join(" "),
      transcript.slice(index + 1, index + 5).map((line) => line.text).join(" "),
      transcript.slice(Math.max(0, index - 8), index + 13).map((line) => line.text).join(" "), video.title);
  }
  const note = { id: `note_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`, platform: "bilibili",
    bvid: video.bvid, cid: video.cid, page: video.page, videoId: video.videoKey,
    videoTitle: video.title.slice(0, 500), channelName: video.channelName.slice(0, 300),
    timestamp: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`, timestampSeconds: seconds,
    timestampedUrl: `${video.canonicalUrl}&t=${seconds}`, text, rawText, createdAt: Date.now() };
  const save = bilibiliNoteQueue.then(async () => {
    await bilibiliAssertContext(tabId, video);
    try { await saveNoteToStorage(note); } catch { throw bilibiliError("STORAGE_FAILED"); }
  });
  bilibiliNoteQueue = save.catch(() => {});
  await save;
  chrome.runtime.sendMessage({ action: "noteSaved", note }).catch(() => {});
  return { success: true, note };
}
async function handleBilibiliMessage(message, sender) {
  if (sender.id !== chrome.runtime.id || typeof message.requestId !== "string" || !message.requestId || message.requestId.length > 200)
    throw bilibiliError("INVALID_REQUEST");
  const ok = (value = {}) => ({ success: true, requestId: message.requestId, ...value });
  if (["bilibiliOpenSidePanel", "bilibiliVideoChanged"].includes(message.action)) {
    if (!sender.tab || sender.frameId !== 0 || !isBilibiliVideoUrl(sender.url) || !isBilibiliVideoUrl(sender.tab.url))
      throw bilibiliError("UNSUPPORTED_PAGE");
    if (bilibiliFingerprint(parseBilibiliUrl(sender.url)) !== bilibiliFingerprint(parseBilibiliUrl(sender.tab.url))) throw bilibiliError("STALE_CONTEXT");
    if (message.action === "bilibiliOpenSidePanel") {
      await openBilibiliPanel(sender.tab);
      return ok();
    }
    const locator = validateBilibiliLocator(message.locator);
    const actual = parseBilibiliUrl(sender.tab.url);
    if (!bilibiliLocatorMatches(actual, locator)) throw bilibiliError("STALE_CONTEXT");
    invalidateBilibiliTab(sender.tab.id, sender.tab.url);
    // Original content event also reaches sidepanel with sender.tab intact.
    return ok();
  }
  if (sender.tab || sender.url !== chrome.runtime.getURL("sidepanel.html") || !Number.isInteger(message.tabId) || message.tabId < 0)
    throw bilibiliError("INVALID_REQUEST");
  const { locator } = await bilibiliAssertContext(message.tabId);
  if (message.action === "resolveBilibiliVideo") {
    const requested = validateBilibiliLocator(message.locator);
    // Check each caller before coalescing requests with the same URL identity.
    if (!bilibiliLocatorMatches(locator, requested)) throw bilibiliError("STALE_CONTEXT");
    const video = await runBilibiliTask(message.tabId, requested, "resolve", (task) => resolveBilibiliVideo(message.tabId, requested, task));
    if (!bilibiliLocatorMatches(requested, video)) throw bilibiliError("STALE_CONTEXT");
    return ok({ video });
  }
  if (message.action === "fetchBilibiliTranscript") {
    validateBilibiliVideo(message.video);
    if (!bilibiliLocatorMatches(locator, message.video)) throw bilibiliError("STALE_CONTEXT");
    if (message.forceRefresh !== undefined && typeof message.forceRefresh !== "boolean") throw bilibiliError("INVALID_REQUEST");
    const result = await runBilibiliTask(message.tabId, locator, "transcript", (task) => fetchBilibiliTranscript(message.tabId, message.video, task));
    // Do not let a forged cid piggyback on an already-running valid request.
    if (["bvid", "aid", "cid", "page", "videoKey"].some((field) => message.video[field] !== result.video[field])) throw bilibiliError("STALE_CONTEXT");
    return ok(result);
  }
  if (message.action === "saveBilibiliNote") return ok(await handleSaveBilibiliNote(message));
  if (message.action === "bilibiliRelayToContent") {
    const action = message.payload?.action;
    if (!["bilibiliGetPageInfo", "bilibiliGetCurrentTime", "bilibiliSeekTo"].includes(action)) throw bilibiliError("INVALID_REQUEST");
    const payload = { action };
    if (action !== "bilibiliGetPageInfo") payload.video = await bilibiliBoundVideo(message.tabId, message.payload.video);
    if (action === "bilibiliSeekTo") {
      if (!Number.isFinite(message.payload.seconds) || message.payload.seconds < 0) throw bilibiliError("INVALID_REQUEST");
      payload.seconds = Math.min(message.payload.seconds, payload.video.duration);
    }
    let response;
    try { response = await chrome.tabs.sendMessage(message.tabId, payload, { frameId: 0 }); }
    catch { throw bilibiliError("CONTENT_UNAVAILABLE"); }
    await bilibiliAssertContext(message.tabId, locator);
    if (!response?.success) throw bilibiliError(BILIBILI_ERRORS[response?.error?.code] ? response.error.code : "CONTENT_UNAVAILABLE");
    return ok({ response });
  }
  throw bilibiliError("INVALID_REQUEST");
}

globalThis.__YTD_BILIBILI_TESTING__ = {
  md5Hex, bilibiliMixinKey, signBilibiliParams, validateBilibiliLocator, parseBilibiliUrl,
  bilibiliVideoFromView, validateSubtitleUrl, convertBilibiliBCC, convertBilibiliASR,
  bilibiliTranscriptResult, selectBilibiliTrack, handleBilibiliMessage, bilibiliFailure,
  resolveBilibiliVideo, fetchBilibiliTranscript, runBilibiliTask, bilibiliRequest,
  invalidateBilibiliTab, cancelInactiveBilibiliTasks, handleSaveBilibiliNote,
};
