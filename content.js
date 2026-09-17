/**
 * CONTENT SCRIPT
 *
 * This script runs ON the YouTube page itself. It can see and modify
 * the YouTube page DOM (the HTML elements).
 *
 * It handles:
 * 1. Extracting video info (title, channel name) from the page
 * 2. Injecting "key moment" markers onto YouTube's progress bar
 * 3. Adding a "Digest" button to YouTube's action bar (next to Share/Save)
 *
 * Think of it like a robot sitting inside the YouTube tab,
 * reading the page and making small visual changes.
 */

const DEBUG = false;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// ============================================================
// GLOBAL STATE
// ============================================================

let ytdNoteButton = null;
let ytdNoteButtonTimer = null;
let ytdNoteKeyboardListenerAdded = false;
let ytdNoteButtonRetryTimer = null;
let ytdDigestButton = null;
let digestButtonObserver = null;
let digestButtonReconcileTimer = null;
let digestButtonResizeListenerAdded = false;

// --- Bilibili state ---
// Declared up here (not near the functions below) because init() runs at
// load time and immediately touches this state on Bilibili pages.
const BILIBILI_BRIDGE_CHANNEL = "ytd-bilibili-v1";
const BILIBILI_BRIDGE_TIMEOUT_MS = 2000;
const BILIBILI_FINGERPRINT_INTERVAL_MS = 1000;
const BILIBILI_PLAYER_WAIT_TIMEOUT_MS = 4000;
const BILIBILI_BUTTON_ID = "ytd-bilibili-digest-button";

// BV ids are fixed-length ("BV1" + 9 base58 chars, no 0/I/O/l). av ids are
// plain positive integers. We never convert between the two.
const BILIBILI_BV_PATTERN = /^BV1[1-9A-HJ-NP-Za-km-z]{9}$/;
const BILIBILI_AV_PATTERN = /^av([1-9]\d*)$/i;

let bilibiliActive = false;
let bilibiliDigestButton = null;
let bilibiliButtonObserver = null;
let bilibiliPlayerObserver = null;
let bilibiliFingerprintTimer = null;
let bilibiliLastFingerprint = null;
let bilibiliBridgePending = null; // { requestId, resolve, timerId, promise }
let bilibiliPlayerWaitTimer = null;
let bilibiliPlayerWaitSettle = null; // settles the in-flight hydration wait
let bilibiliPersistentListenersAdded = false;

// ============================================================
// INITIALIZATION
// ============================================================

/**
 * When the page loads, inject our Digest button and Note button.
 * We wait a bit for YouTube's UI to fully render.
 *
 * On Bilibili video pages the same content script takes a completely separate
 * path: no YouTube observers or keyboard shortcuts are registered there.
 */
function init() {
  if (isBilibiliHost()) {
    if (isBilibiliVideoPage()) initBilibili();
    return;
  }

  // Register the global "n" keyboard shortcut once
  if (!ytdNoteKeyboardListenerAdded) {
    document.addEventListener("keydown", handleNoteKeyboardShortcut);
    ytdNoteKeyboardListenerAdded = true;
  }

  // Try to inject the buttons immediately
  injectDigestButton();
  tryInjectNoteButton();

  // Also set up an observer to handle YouTube's dynamic content loading
  // (YouTube is an SPA, so elements appear/disappear as you navigate)
  setupButtonObserver();
  setupDigestButtonResizeListener();
}

/**
 * Attempts to inject the note button. If the player container isn't ready yet,
 * retry a few times with a short delay. YouTube renders the player asynchronously
 * after navigation, so a single immediate attempt can miss it.
 */
function tryInjectNoteButton() {
  if (!window.location.pathname.includes("/watch")) return;

  // Clear any existing retry so we don't stack timers
  if (ytdNoteButtonRetryTimer) {
    clearInterval(ytdNoteButtonRetryTimer);
    ytdNoteButtonRetryTimer = null;
  }

  let attempts = 0;
  const maxAttempts = 30; // ~3 seconds of retrying

  function attempt() {
    attempts++;
    const playerContainer = document.querySelector(
      "#movie_player.html5-video-player, #movie_player, .html5-video-player",
    );

    if (playerContainer) {
      injectNoteButton();
      if (ytdNoteButtonRetryTimer) {
        clearInterval(ytdNoteButtonRetryTimer);
        ytdNoteButtonRetryTimer = null;
      }
      return;
    }

    if (attempts >= maxAttempts) {
      debugLog(
        "[YouTube Digest Content] Player container not found after retries, giving up",
      );
      if (ytdNoteButtonRetryTimer) {
        clearInterval(ytdNoteButtonRetryTimer);
        ytdNoteButtonRetryTimer = null;
      }
    }
  }

  attempt();
  if (!ytdNoteButton || !ytdNoteButton.isConnected) {
    ytdNoteButtonRetryTimer = setInterval(attempt, 100);
  }
}

// Run init when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// ============================================================
// MESSAGE HANDLING
// ============================================================

/**
 * Listen for messages from the side panel or background script.
 * When they ask for video info, we read it from the page.
 * When they send key moments, we highlight them on the progress bar.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  debugLog("[YouTube Digest Content] Received message:", message.action, message);

  // --- Bilibili actions (relayed from the background worker) ---
  // These are only meaningful on Bilibili video pages; the handlers check the
  // page themselves and refuse anything else.
  if (message.action === "bilibiliGetPageInfo") {
    getBilibiliPageInfo()
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          success: false,
          error: {
            code: "CONTENT_UNAVAILABLE",
            message: error?.message || "Could not read this page.",
            retryable: true,
          },
        }),
      );
    return true; // Async response (waits at most ~2s for the MAIN bridge)
  }

  if (message.action === "bilibiliGetCurrentTime") {
    sendResponse(handleBilibiliGetCurrentTime(message));
    return false;
  }

  if (message.action === "bilibiliSeekTo") {
    // May wait briefly for the player to hydrate before answering.
    return handleBilibiliSeekTo(message, sendResponse);
  }

  if (message.action === "getVideoInfo") {
    // Read video title and channel name from the page
    const info = extractVideoInfo();
    debugLog("[YouTube Digest Content] Returning video info:", info);
    sendResponse(info);
    return false; // Synchronous response
  }

  if (message.action === "highlightMoments") {
    // Key moment markers disabled — chapters are shown in the side panel only.
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "getCurrentTime") {
    // Return the current video playback time (used by auto-scroll)
    const video = document.querySelector("video.html5-main-video");
    sendResponse({
      currentTime: video ? Math.floor(video.currentTime) : 0,
      paused: video ? video.paused : true,
    });
    return false;
  }

  if (message.action === "seekTo") {
    // Jump the video to a specific timestamp
    debugLog("[YouTube Digest Content] Seeking to:", message.seconds);
    seekToTimestamp(message.seconds);
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "showNoteSavedFeedback") {
    // Show brief feedback that note was saved
    showNoteSavedToast(message.note);
    sendResponse({ success: true });
    return false;
  }

  // Unknown action - still send a response to prevent hanging
  debugLog("[YouTube Digest Content] Unknown action:", message.action);
  sendResponse({ success: false, error: "Unknown action" });
  return false;
});

// ============================================================
// DIGEST BUTTON INJECTION
// ============================================================

/**
 * Injects a "Digest" button into YouTube's action bar.
 * The button appears next to Share, Save, etc. below the video.
 *
 * When clicked, it opens the YouTube Digest side panel.
 */
function isVisibleDigestHost(element) {
  if (!element || !element.isConnected) return false;

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;

  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

/**
 * YouTube keeps hidden copies of its responsive action toolbar in the DOM.
 * querySelector() can return one of those 0x0 copies before the toolbar the
 * viewer can actually see, so inspect every candidate and resolve the native
 * button group inside the visible action row for the current video.
 */
function findDigestButtonHost() {
  const primaryActionRows = Array.from(
    document.querySelectorAll("ytd-watch-metadata #actions-inner"),
  );

  for (const actionRow of primaryActionRows) {
    if (!isVisibleDigestHost(actionRow)) continue;

    const visibleButtonGroup = Array.from(
      actionRow.querySelectorAll("#top-level-buttons-computed"),
    ).find(isVisibleDigestHost);
    if (visibleButtonGroup) return visibleButtonGroup;
  }

  const fallbackCandidates = Array.from(
    document.querySelectorAll(
      "ytd-watch-metadata #actions #top-level-buttons-computed, " +
        "ytd-watch-metadata #top-level-buttons-computed, " +
        "#primary #actions #top-level-buttons-computed",
    ),
  );

  return (
    fallbackCandidates.find(
      (candidate) =>
        isVisibleDigestHost(candidate) &&
        (candidate.closest("ytd-watch-metadata") ||
          candidate.closest("#primary")),
    ) || null
  );
}

function createDigestButton() {
  const digestButton = document.createElement("button");
  digestButton.id = "ytd-digest-button";
  digestButton.type = "button";
  digestButton.setAttribute("aria-label", "Open YouTube Digest");
  digestButton.innerHTML = `<span class="ytd-digest-label">Digest</span>`;

  // Style the button — rounded pill in our terracotta accent, sized to sit
  // comfortably among YouTube's native action buttons.
  digestButton.style.cssText = `
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 0 18px;
    height: 36px;
    border: none;
    border-radius: 18px;
    background: #c8674f;
    color: white;
    font-family: "Roboto", "Arial", sans-serif;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    margin-right: 8px;
    transition: background 0.2s, transform 0.1s;
    flex: 0 0 auto;
    align-self: center;
    width: max-content;
    min-width: max-content;
    max-width: max-content;
    white-space: nowrap;
  `;

  // Hover effects
  digestButton.addEventListener("mouseenter", () => {
    digestButton.style.background = "#b25742";
    digestButton.style.transform = "scale(1.02)";
  });

  digestButton.addEventListener("mouseleave", () => {
    digestButton.style.background = "#c8674f";
    digestButton.style.transform = "scale(1)";
  });

  // Click handler — open the side panel
  digestButton.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();

    debugLog("[YouTube Digest] Digest button clicked");

    // Send message to background script to open side panel
    try {
      const result = await chrome.runtime.sendMessage({
        action: "openSidePanel",
      });
      debugLog("[YouTube Digest] openSidePanel response:", result);
    } catch (err) {
      console.error("[YouTube Digest] Failed to open side panel:", err);
    }
  });

  ytdDigestButton = digestButton;
  return digestButton;
}

/**
 * Reconciles the Digest button with YouTube's currently visible action row.
 * This is intentionally idempotent because YouTube rebuilds its watch page
 * during navigation and at responsive breakpoints.
 */
function injectDigestButton() {
  const existingButtons = Array.from(
    document.querySelectorAll("#ytd-digest-button"),
  );

  if (!window.location.pathname.includes("/watch")) {
    existingButtons.forEach((button) => button.remove());
    ytdDigestButton = null;
    return false;
  }

  const actionsContainer = findDigestButtonHost();
  if (!actionsContainer) {
    debugLog("[YouTube Digest Content] Visible actions container not found yet");
    return false;
  }

  let digestButton = existingButtons.find(
    (button) => button === ytdDigestButton,
  );

  if (!digestButton) {
    existingButtons.forEach((button) => button.remove());
    existingButtons.length = 0;
    digestButton = createDigestButton();
  }

  existingButtons.forEach((button) => {
    if (button !== digestButton) button.remove();
  });

  if (digestButton.parentElement !== actionsContainer) {
    // YouTube turns #actions-inner into a vertical flex column at narrow
    // breakpoints. A direct child there stretches into a full-width second
    // row, so keep Digest inside the native horizontal button group and
    // prepend it to preserve visibility when space is limited.
    actionsContainer.insertBefore(digestButton, actionsContainer.firstChild);
  }

  debugLog("[YouTube Digest Content] Digest button reconciled");
  return true;
}

function scheduleDigestButtonReconciliation(delay = 80) {
  if (digestButtonReconcileTimer) {
    clearTimeout(digestButtonReconcileTimer);
  }

  digestButtonReconcileTimer = setTimeout(() => {
    digestButtonReconcileTimer = null;
    injectDigestButton();
  }, delay);
}

function setupDigestButtonResizeListener() {
  if (digestButtonResizeListenerAdded) return;

  window.addEventListener("resize", () => {
    scheduleDigestButtonReconciliation(120);
  });
  digestButtonResizeListenerAdded = true;
}

/**
 * Sets up a MutationObserver to watch for YouTube's dynamic content changes.
 * When the action buttons container appears (after navigation), we inject our button.
 */
function setupButtonObserver() {
  if (digestButtonObserver) return;

  digestButtonObserver = new MutationObserver(() => {
    // Check if we need to inject the buttons
    if (window.location.pathname.includes("/watch")) {
      scheduleDigestButtonReconciliation();
      if (!ytdNoteButton || !ytdNoteButton.isConnected) {
        tryInjectNoteButton();
      }
    }
  });

  // Watch the entire body for changes (YouTube rebuilds large chunks of the DOM)
  digestButtonObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

// ============================================================
// NOTE BUTTON (Overlay on Video Player)
// ============================================================

/**
 * Injects a "Note" button overlay on top of the YouTube video player.
 * The button appears when the mouse enters or moves over the player and hides
 * after the cursor stays still for more than 2 seconds or leaves the player.
 */
function injectNoteButton() {
  // Don't inject if we're not on a video page
  if (!window.location.pathname.includes("/watch")) return;

  // Don't inject if button already exists and is properly tracked.
  // If a stale button exists (e.g., from a previous content-script instance),
  // remove it and re-inject so event listeners are attached to the live one.
  const existingButton = document.getElementById("ytd-note-button");
  if (existingButton) {
    if (ytdNoteButton === existingButton && existingButton.isConnected) {
      return; // already injected and connected
    }
    existingButton.remove();
  }

  // Find the video player container. YouTube rebuilds this dynamically, so
  // we try the most common selectors.
  const playerContainer = document.querySelector(
    "#movie_player.html5-video-player, " +
      "#movie_player, " +
      ".html5-video-player",
  );

  if (!playerContainer) {
    debugLog(
      "[YouTube Digest Content] Player container not found yet, will retry",
    );
    return;
  }

  // Ensure the player container has relative positioning for absolute children
  if (
    window.getComputedStyle(playerContainer).position === "static" ||
    !playerContainer.style.position
  ) {
    playerContainer.style.position = "relative";
  }

  debugLog("[YouTube Digest Content] Injecting note button");

  // Create the note button — a soft rounded pill that floats over the player
  const noteButton = document.createElement("button");
  noteButton.id = "ytd-note-button";
  noteButton.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="margin-right: 7px;">
      <path d="M12 20h9"></path>
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
    </svg>
    <span>Note</span>
  `;

  // Soft rounded pill in the terracotta accent, with a gentle shadow.
  // Start hidden; visibility is controlled by mouse activity.
  noteButton.style.cssText = `
    position: absolute;
    top: 16px;
    right: 16px;
    z-index: 9999;
    display: flex;
    align-items: center;
    padding: 9px 16px;
    background: #c8674f;
    color: white;
    border: none;
    border-radius: 999px;
    font-family: system-ui, -apple-system, "Roboto", sans-serif;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.2px;
    cursor: pointer;
    transition: opacity 0.18s ease, transform 0.18s ease, background 0.18s ease, box-shadow 0.18s ease;
    opacity: 0;
    pointer-events: none;
    box-shadow: 0 4px 14px rgba(0,0,0,0.3);
  `;

  ytdNoteButton = noteButton;

  // Show button when mouse enters or moves over the player.
  // Hide after 2 seconds of idle or when the mouse leaves.
  playerContainer.addEventListener("mouseenter", () => {
    showNoteButton();
    resetNoteButtonTimer();
  });

  playerContainer.addEventListener("mousemove", () => {
    showNoteButton();
    resetNoteButtonTimer();
  });

  playerContainer.addEventListener("mouseleave", () => {
    clearTimeout(ytdNoteButtonTimer);
    ytdNoteButtonTimer = null;
    hideNoteButton();
  });

  // Hover effect — lift slightly
  noteButton.addEventListener("mouseenter", () => {
    noteButton.style.background = "#b25742";
    noteButton.style.boxShadow = "0 6px 18px rgba(0,0,0,0.35)";
    noteButton.style.transform = "translateY(-1px)";
  });

  noteButton.addEventListener("mouseleave", () => {
    noteButton.style.background = "#c8674f";
    noteButton.style.boxShadow = "0 4px 14px rgba(0,0,0,0.3)";
    noteButton.style.transform = "translateY(0)";
  });

  // Click handler — save the current moment as a note
  noteButton.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await saveCurrentNote();
  });

  playerContainer.appendChild(noteButton);

  debugLog("[YouTube Digest Content] Note button injected");
}

function showNoteButton() {
  if (!ytdNoteButton) return;
  ytdNoteButton.style.opacity = "1";
  ytdNoteButton.style.pointerEvents = "auto";
}

function hideNoteButton() {
  if (!ytdNoteButton) return;
  ytdNoteButton.style.opacity = "0";
  ytdNoteButton.style.pointerEvents = "none";
}

function resetNoteButtonTimer() {
  clearTimeout(ytdNoteButtonTimer);
  ytdNoteButtonTimer = setTimeout(() => {
    hideNoteButton();
  }, 2000);
}

/**
 * Handles the "n" keyboard shortcut for saving a note.
 * Only triggers on YouTube watch pages and when the user is not typing
 * in an input field.
 */
function handleNoteKeyboardShortcut(e) {
  if (!window.location.pathname.includes("/watch")) return;
  if (e.key !== "n" && e.key !== "N") return;

  // Ignore if the user is typing in an input/textarea/contenteditable
  const active = document.activeElement;
  if (
    active &&
    (active.tagName === "INPUT" ||
      active.tagName === "TEXTAREA" ||
      active.isContentEditable)
  ) {
    return;
  }

  // Prevent YouTube's own "n" shortcut (e.g. next video in playlist)
  e.preventDefault();
  e.stopPropagation();

  // Show brief visual feedback on the button, then save
  showNoteButton();
  resetNoteButtonTimer();
  saveCurrentNote();
}

/**
 * Captures the current timestamp and saves it as a note.
 */
async function saveCurrentNote() {
  debugLog("[YouTube Digest] Saving note");

  const video = document.querySelector("video.html5-main-video");
  if (!video) {
    console.error("[YouTube Digest] No video element found");
    return;
  }

  // Go back 3 seconds to capture what was just said (user reacts after hearing it)
  const currentTime = Math.max(0, Math.floor(video.currentTime) - 3);
  const videoInfo = extractVideoInfo();
  const videoId = new URLSearchParams(window.location.search).get("v");

  const noteButton = ytdNoteButton;
  const originalContent = noteButton ? noteButton.innerHTML : "";

  if (noteButton) {
    noteButton.innerHTML =
      '<span style="letter-spacing: 0.2px;">SAVING...</span>';
    noteButton.style.pointerEvents = "none";
  }

  try {
    const result = await chrome.runtime.sendMessage({
      action: "saveNote",
      videoId: videoId,
      timestamp: currentTime,
      videoTitle: videoInfo.title,
      channelName: videoInfo.channelName,
    });

    if (result.success) {
      if (noteButton) {
        noteButton.innerHTML =
          '<span style="letter-spacing: 0.2px;">SAVED</span>';
        noteButton.style.background = "#7c8b6f";
      }
      showNoteSavedToast(result.note);
    } else {
      if (noteButton) {
        noteButton.innerHTML =
          '<span style="letter-spacing: 0.2px;">ERROR</span>';
      }
      console.error("[YouTube Digest] Save note error:", result.error);
    }
  } catch (err) {
    if (noteButton) {
      noteButton.innerHTML =
        '<span style="letter-spacing: 0.2px;">ERROR</span>';
    }
    console.error("[YouTube Digest] Save note exception:", err);
  }

  setTimeout(() => {
    if (noteButton) {
      noteButton.innerHTML = originalContent;
      noteButton.style.background = "#c8674f";
      noteButton.style.pointerEvents = "auto";
    }
  }, 2000);
}

/**
 * Shows a toast notification when a note is saved.
 */
function showNoteSavedToast(note) {
  // Remove existing toast
  const existing = document.getElementById("ytd-note-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "ytd-note-toast";
  toast.innerHTML = `
    <div style="font-weight: 700; margin-bottom: 6px; color: #c8674f;">Note saved</div>
    <div style="font-size: 12px; color: #6b6258; margin-bottom: 8px;">${escapeHtmlForContent(note.timestamp)} — ${escapeHtmlForContent(note.videoTitle)}</div>
    <div style="font-size: 13px; line-height: 1.55; color: #2e2a24;">"${escapeHtmlForContent(note.text)}"</div>
    <div style="margin-top: 10px; font-size: 11px;">
      <a href="${escapeHtmlForContent(note.timestampedUrl)}" style="color: #c8674f; font-weight: 600; text-decoration: none;">Copy link</a>
    </div>
  `;

  toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 999999;
    background: #ffffff;
    border: 1px solid #ece5d9;
    border-radius: 14px;
    padding: 16px 20px;
    max-width: 350px;
    box-shadow: 0 12px 32px rgba(50, 42, 32, 0.2);
    font-family: system-ui, -apple-system, "Roboto", sans-serif;
    animation: ytdSlideIn 0.3s ease;
  `;

  // Add animation keyframes
  const style = document.createElement("style");
  style.textContent = `
    @keyframes ytdSlideIn {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
  `;
  document.head.appendChild(style);

  // Copy link handler
  toast.querySelector("a").addEventListener("click", async (e) => {
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(note.timestampedUrl);
      e.target.textContent = "Copied";
    } catch (err) {
      console.error("Copy failed:", err);
    }
  });

  document.body.appendChild(toast);

  // Auto-dismiss after 5 seconds
  setTimeout(() => {
    toast.style.animation = "ytdSlideIn 0.3s ease reverse";
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}

// ============================================================
// VIDEO INFO EXTRACTION
// ============================================================

/**
 * Reads the video title, channel name, and description directly from YouTube's page.
 * These are just sitting in the HTML — we grab them from the DOM elements.
 */
function extractVideoInfo() {
  // The video title is in an h1 element inside the #title container
  const titleElement = document.querySelector(
    "h1.ytd-watch-metadata yt-formatted-string, #title h1 yt-formatted-string",
  );

  // The channel name is in the channel info section
  const channelElement = document.querySelector(
    "#channel-name yt-formatted-string a, ytd-channel-name yt-formatted-string a",
  );

  // Video duration from the video element
  const videoElement = document.querySelector("video.html5-main-video");

  // Video description — YouTube has this in a few possible places
  const descriptionElement = document.querySelector(
    "#description-inner, " +
      "ytd-watch-metadata #description yt-attributed-string, " +
      "#description yt-formatted-string, " +
      "ytd-expander#description yt-attributed-string",
  );

  return {
    title: titleElement?.textContent?.trim() || "",
    channelName: channelElement?.textContent?.trim() || "",
    duration: videoElement?.duration || 0,
    description: descriptionElement?.textContent?.trim() || "",
  };
}

// ============================================================
// PROGRESS BAR KEY MOMENTS
// ============================================================

/**
 * Adds colored marker dots to YouTube's video progress bar
 * at the positions of key moments identified by the AI provider.
 *
 * How it works:
 * - YouTube's progress bar is a <div> element with a known class
 * - We calculate each moment's position as a percentage of total duration
 * - We inject small colored <div> elements at those positions
 * - The markers are absolutely positioned on top of the progress bar
 *
 * This is a "bonus feature" — it gives you a visual preview
 * of where the good stuff is in the video.
 */
function highlightKeyMoments(moments, videoDuration) {
  // Disabled: no timeline markers. Chapters live only in the side panel.
  return;
}

// ============================================================
// SEEK TO TIMESTAMP
// ============================================================

/**
 * Jumps the YouTube video to a specific timestamp (in seconds).
 * This is called when the user clicks a timestamp in the side panel.
 *
 * We simply set the video element's .currentTime property,
 * which is the standard HTML5 way to seek in a video.
 */
function seekToTimestamp(seconds) {
  const video = document.querySelector("video.html5-main-video");
  if (!video) {
    console.error("[YouTube Digest Content] No video element found for seek");
    return;
  }

  debugLog("[YouTube Digest Content] Seeking to:", seconds);
  video.currentTime = seconds;
  // Also play the video if it's paused
  if (video.paused) {
    video.play().catch(() => {}); // Ignore autoplay errors
  }
}

function escapeHtmlForContent(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

// ============================================================
// PAGE NAVIGATION DETECTION
// ============================================================

/**
 * YouTube is a "Single Page Application" (SPA). This means when you
 * click on a new video, the page doesn't fully reload — YouTube
 * dynamically swaps out the content. So our content script stays alive
 * but needs to detect when the video changes.
 *
 * We watch for URL changes using the `yt-navigate-finish` event,
 * which YouTube fires after navigation completes. When that happens,
 * we clean up old markers and re-inject the button.
 */
document.addEventListener("yt-navigate-finish", () => {
  // Clean up old key moment markers when navigating to a new video
  const existingMarkers = document.querySelectorAll(".ytd-key-moment-markers");
  existingMarkers.forEach((m) => m.remove());

  // Remove old buttons (they will be re-injected for the new video)
  document
    .querySelectorAll("#ytd-digest-button")
    .forEach((button) => button.remove());
  ytdDigestButton = null;
  if (digestButtonReconcileTimer) {
    clearTimeout(digestButtonReconcileTimer);
    digestButtonReconcileTimer = null;
  }

  const existingNoteButton = document.getElementById("ytd-note-button");
  if (existingNoteButton) existingNoteButton.remove();

  // Reset note button state
  ytdNoteButton = null;
  clearTimeout(ytdNoteButtonTimer);
  ytdNoteButtonTimer = null;
  if (ytdNoteButtonRetryTimer) {
    clearInterval(ytdNoteButtonRetryTimer);
    ytdNoteButtonRetryTimer = null;
  }

  // Remove any toasts
  const existingToast = document.getElementById("ytd-note-toast");
  if (existingToast) existingToast.remove();

  // Re-inject buttons for the new video (with a small delay for YouTube to render)
  setTimeout(() => {
    scheduleDigestButtonReconciliation(0);
    tryInjectNoteButton();
  }, 500);
});

// ============================================================
// BILIBILI SUPPORT
// ============================================================
// Everything below runs only on https://www.bilibili.com/video/*. It owns:
//   - the postMessage bridge to bilibili-page.js (MAIN world)
//   - the Digest button in Bilibili's action toolbar
//   - SPA navigation awareness (fingerprint polling + popstate)
//   - player reads and timestamp seeks with identity checks
//
// Bilibili's page can interfere with its own MAIN world, so bridge answers
// are hints. The background worker re-validates identity via the view API.

// ------------------------------------------------------------
// URL identity
// ------------------------------------------------------------

function isBilibiliHost() {
  return window.location.hostname === "www.bilibili.com";
}

function isBilibiliVideoPage() {
  return (
    isBilibiliHost() && window.location.pathname.startsWith("/video/")
  );
}

/**
 * Parses the video identity out of a Bilibili URL. Only the pathname and the
 * "p" query parameter identify the video; tracking parameters and the "t"
 * timestamp are ignored. Returns null when the URL is not a plain video page
 * or the page parameter is malformed.
 *
 * @returns {{bvid: string|null, aid: string|null, page: number} | null}
 */
function parseBilibiliLocatorFromUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (_error) {
    return null;
  }
  if (url.hostname !== "www.bilibili.com") return null;

  const match = url.pathname.match(/^\/video\/([^/]+)\/?$/);
  if (!match) return null;

  const segment = match[1];
  let bvid = null;
  let aid = null;
  if (BILIBILI_BV_PATTERN.test(segment)) {
    bvid = segment;
  } else {
    const avMatch = segment.match(BILIBILI_AV_PATTERN);
    if (avMatch) aid = avMatch[1];
  }
  if (!bvid && !aid) return null;

  let page = 1;
  const rawPage = url.searchParams.get("p");
  if (rawPage !== null) {
    if (!/^[1-9]\d*$/.test(rawPage)) return null;
    page = Number(rawPage);
  }

  return { bvid, aid, page };
}

function getCurrentBilibiliLocator() {
  return parseBilibiliLocatorFromUrl(window.location.href);
}

/**
 * The navigation fingerprint: video id + part number. Ignores t, spm, and
 * other non-identity parameters so random query noise does not look like a
 * navigation.
 */
function computeBilibiliFingerprint(locator) {
  if (!locator) return null;
  return `${locator.bvid || `av${locator.aid}`}|p${locator.page}`;
}

/**
 * Wire form of a locator. The background validator accepts only ABSENT
 * fields — an explicit null is INVALID_REQUEST — so a BV address sends
 * {bvid, page} and an av address sends {aid, page}, never the null twin.
 * cidHint rides along only when the MAIN-world state actually provided one.
 */
function serializeBilibiliLocator(locator) {
  const out = {};
  if (locator.bvid !== null && locator.bvid !== undefined) {
    out.bvid = locator.bvid;
  }
  if (locator.aid !== null && locator.aid !== undefined) {
    out.aid = locator.aid;
  }
  out.page = locator.page;
  if (locator.cidHint !== null && locator.cidHint !== undefined) {
    out.cidHint = locator.cidHint;
  }
  return out;
}

function createBilibiliRequestId() {
  return `bili-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ------------------------------------------------------------
// Lifecycle
// ------------------------------------------------------------

function initBilibili() {
  if (bilibiliActive) return;
  bilibiliActive = true;

  addBilibiliPersistentListeners();
  injectBilibiliButton();
  setupBilibiliButtonObserver();
  bilibiliLastFingerprint = computeBilibiliFingerprint(
    getCurrentBilibiliLocator(),
  );
  startBilibiliFingerprintPolling();
}

/**
 * Full teardown when the page leaves the supported surface: remove the
 * button, stop the poller, disconnect the local observers, and settle any
 * in-flight bridge read so nothing keeps tracking the old page.
 */
function cleanupBilibili() {
  bilibiliActive = false;
  bilibiliLastFingerprint = null;

  if (bilibiliFingerprintTimer) {
    clearInterval(bilibiliFingerprintTimer);
    bilibiliFingerprintTimer = null;
  }
  if (bilibiliButtonObserver) {
    bilibiliButtonObserver.disconnect();
    bilibiliButtonObserver = null;
  }
  cancelBilibiliPlayerWait();

  document
    .querySelectorAll(`#${BILIBILI_BUTTON_ID}`)
    .forEach((button) => button.remove());
  bilibiliDigestButton = null;

  if (bilibiliBridgePending) {
    clearTimeout(bilibiliBridgePending.timerId);
    const pending = bilibiliBridgePending;
    bilibiliBridgePending = null;
    pending.resolve(null);
  }
}

/**
 * popstate and the bridge message listener stay registered for the life of
 * the content script. They are what lets us come back after a SPA navigation
 * away from (and back to) a video page.
 */
function addBilibiliPersistentListeners() {
  if (bilibiliPersistentListenersAdded) return;
  window.addEventListener("popstate", handleBilibiliPopstate);
  window.addEventListener("message", handleBilibiliBridgeMessage);
  bilibiliPersistentListenersAdded = true;
}

function handleBilibiliPopstate() {
  if (isBilibiliVideoPage()) {
    if (bilibiliActive) bilibiliFingerprintTick();
    else initBilibili();
  } else if (bilibiliActive) {
    cleanupBilibili();
  }
}

// ------------------------------------------------------------
// SPA navigation awareness (fingerprint polling + popstate)
// ------------------------------------------------------------

function startBilibiliFingerprintPolling() {
  if (bilibiliFingerprintTimer) return;
  bilibiliFingerprintTimer = setInterval(
    bilibiliFingerprintTick,
    BILIBILI_FINGERPRINT_INTERVAL_MS,
  );
}

function bilibiliFingerprintTick() {
  if (!bilibiliActive) return;
  if (!isBilibiliVideoPage()) {
    cleanupBilibili();
    return;
  }

  // Hydration can finish AFTER init's single attempt: retry the local
  // observer (a no-op once created) and the injection itself until the
  // button is actually connected. Both calls are idempotent.
  setupBilibiliButtonObserver();
  if (!bilibiliDigestButton || !bilibiliDigestButton.isConnected) {
    injectBilibiliButton();
  }

  const locator = getCurrentBilibiliLocator();
  const fingerprint = computeBilibiliFingerprint(locator);
  if (!fingerprint) return; // Unrecognized URL shape — leave state alone.
  if (fingerprint !== bilibiliLastFingerprint) {
    bilibiliLastFingerprint = fingerprint;
    handleBilibiliNavigation(locator);
  }
}

/**
 * A video or part change: re-check the button (the toolbar may have been
 * rebuilt) and notify the background worker. We never fetch subtitles here —
 * the side panel drives that through resolveBilibiliVideo.
 */
function handleBilibiliNavigation(locator) {
  // A video/part change settles any seek still waiting for player hydration:
  // its callback re-validates identity and answers STALE_CONTEXT instead of
  // seeking the new part to the old timestamp.
  cancelBilibiliPlayerWait();
  injectBilibiliButton();
  try {
    const sent = chrome.runtime.sendMessage({
      action: "bilibiliVideoChanged",
      requestId: createBilibiliRequestId(),
      locator: serializeBilibiliLocator(locator),
    });
    Promise.resolve(sent).catch(() => {});
  } catch (error) {
    debugLog("[YouTube Digest Content] bilibiliVideoChanged failed:", error);
  }
}

// ------------------------------------------------------------
// Digest button injection (action toolbar)
// ------------------------------------------------------------

/**
 * Preferred host is the left side of the action toolbar (next to like/coin);
 * the title area is the documented fallback. Both exist in the SSR HTML.
 */
function findBilibiliButtonHost() {
  return (
    document.querySelector("#arc_toolbar_report .video-toolbar-left-main") ||
    document.querySelector("#viewbox_report")
  );
}

function createBilibiliButton() {
  const button = document.createElement("button");
  button.id = BILIBILI_BUTTON_ID;
  button.type = "button";
  button.setAttribute("aria-label", "Open YouTube Digest");
  button.innerHTML = `<span class="ytd-bilibili-digest-label">Digest</span>`;

  // A quiet pill that sits comfortably beside Bilibili's own toolbar items.
  button.style.cssText = `
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 0 16px;
    height: 28px;
    border: none;
    border-radius: 14px;
    background: #c8674f;
    color: white;
    font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    margin-right: 12px;
    transition: background 0.2s, transform 0.1s;
    flex: 0 0 auto;
    align-self: center;
    white-space: nowrap;
  `;

  button.addEventListener("mouseenter", () => {
    button.style.background = "#b25742";
    button.style.transform = "scale(1.03)";
  });
  button.addEventListener("mouseleave", () => {
    button.style.background = "#c8674f";
    button.style.transform = "scale(1)";
  });

  button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Fire the open request directly from the click handler — awaiting
    // anything first could expire Chrome's user-gesture requirement for
    // sidePanel.open().
    try {
      const sent = chrome.runtime.sendMessage({
        action: "bilibiliOpenSidePanel",
        requestId: createBilibiliRequestId(),
      });
      Promise.resolve(sent).catch(() => {});
    } catch (error) {
      console.error("[YouTube Digest] Failed to open side panel:", error);
    }
  });

  bilibiliDigestButton = button;
  return button;
}

/**
 * Reconciles the Digest button with the current toolbar. Idempotent: safe to
 * call from the observer, the fingerprint tick, and navigation handling.
 */
function injectBilibiliButton() {
  const existingButtons = Array.from(
    document.querySelectorAll(`#${BILIBILI_BUTTON_ID}`),
  );

  if (!isBilibiliVideoPage()) {
    existingButtons.forEach((button) => button.remove());
    bilibiliDigestButton = null;
    return false;
  }

  const host = findBilibiliButtonHost();
  if (!host) {
    debugLog("[YouTube Digest Content] Bilibili toolbar not found yet");
    return false;
  }

  let button = existingButtons.find(
    (candidate) => candidate === bilibiliDigestButton,
  );
  if (!button) {
    existingButtons.forEach((candidate) => candidate.remove());
    button = createBilibiliButton();
  }
  existingButtons.forEach((candidate) => {
    if (candidate !== button) candidate.remove();
  });

  if (button.parentElement !== host) {
    host.appendChild(button);
  }
  return true;
}

/**
 * Watches a LOCAL subtree (the left column that contains the toolbar) so a
 * rebuilt toolbar gets its button back. We deliberately never observe
 * document.body: the danmaku list and comments churn constantly and would
 * fire this observer in a storm.
 */
function setupBilibiliButtonObserver() {
  if (bilibiliButtonObserver) return;

  const observeTarget =
    document.querySelector(".left-container") ||
    document.querySelector("#mirror-vdcon");
  if (!observeTarget) return; // Retried by the next fingerprint tick.

  bilibiliButtonObserver = new MutationObserver(() => {
    if (!bilibiliActive) return;
    const host = findBilibiliButtonHost();
    if (
      !bilibiliDigestButton ||
      !bilibiliDigestButton.isConnected ||
      (host && bilibiliDigestButton.parentElement !== host)
    ) {
      injectBilibiliButton();
    }
  });
  bilibiliButtonObserver.observe(observeTarget, {
    childList: true,
    subtree: true,
  });
}

// ------------------------------------------------------------
// MAIN-world bridge (read-only, one request in flight, 2s timeout)
// ------------------------------------------------------------

/**
 * Asks bilibili-page.js (MAIN world) for the whitelisted page state. Resolves
 * to null on timeout or when a read is already in flight — callers then fall
 * back to URL + DOM metadata. At most one read is ever in flight.
 */
function requestBilibiliMainState() {
  if (bilibiliBridgePending) return bilibiliBridgePending.promise;

  const requestId = createBilibiliRequestId();
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });

  const timerId = setTimeout(() => {
    if (bilibiliBridgePending?.requestId === requestId) {
      bilibiliBridgePending = null;
      resolvePromise(null);
    }
  }, BILIBILI_BRIDGE_TIMEOUT_MS);

  bilibiliBridgePending = { requestId, resolve: resolvePromise, timerId, promise };

  try {
    window.postMessage(
      {
        channel: BILIBILI_BRIDGE_CHANNEL,
        type: "read-state",
        requestId,
      },
      window.location.origin,
    );
  } catch (error) {
    clearTimeout(timerId);
    bilibiliBridgePending = null;
    resolvePromise(null);
  }

  return promise;
}

/**
 * Validates an incoming bridge message strictly: same window, exact origin,
 * our channel, the "state" response type, and the in-flight requestId. The
 * page can post arbitrary messages, so anything off is ignored.
 */
function handleBilibiliBridgeMessage(event) {
  const pending = bilibiliBridgePending;
  if (!pending) return;
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;

  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.channel !== BILIBILI_BRIDGE_CHANNEL) return;
  if (data.type !== "state") return;
  if (data.requestId !== pending.requestId) return;

  bilibiliBridgePending = null;
  clearTimeout(pending.timerId);
  pending.resolve(sanitizeBilibiliMainState(data));
}

/**
 * Keeps only the whitelisted fields with strict types. The MAIN world is
 * page-influenced, so its answer is treated as untrusted input.
 */
function sanitizeBilibiliMainState(data) {
  const cleanString = (value, max) =>
    typeof value === "string" && value.trim()
      ? value.trim().slice(0, max)
      : null;
  const idString = (value) =>
    typeof value === "string" && /^[1-9]\d*$/.test(value) ? value : null;

  return {
    available: data.available === true,
    stateMatched: data.stateMatched === true,
    bvid:
      typeof data.bvid === "string" && BILIBILI_BV_PATTERN.test(data.bvid)
        ? data.bvid
        : null,
    aid: idString(data.aid),
    page: Number.isInteger(data.page) && data.page > 0 ? data.page : null,
    cidHint: idString(data.cidHint),
    title: cleanString(data.title, 500),
    channelName: cleanString(data.channelName, 300),
    description: cleanString(data.description, 5000),
    duration:
      Number.isFinite(data.duration) && data.duration > 0
        ? data.duration
        : null,
  };
}

// ------------------------------------------------------------
// Page info assembly (URL identity + MAIN hints + DOM fallback)
// ------------------------------------------------------------

/**
 * Best-effort DOM metadata for when the MAIN bridge is missing or its state
 * is stale. These are hints for the panel header; identity always comes from
 * the URL, and the background view API is the final authority.
 */
function readBilibiliDomMetadata() {
  const titleEl = document.querySelector(
    "#viewbox_report h1.video-title, h1.video-title",
  );
  const channelEl = document.querySelector(
    ".up-info-container .up-name, .up-detail-top .up-name, .up-name",
  );
  const descEl = document.querySelector("#v_desc .desc-info-text, #v_desc");
  const video = findBilibiliPlayerVideo();
  const duration =
    video && Number.isFinite(video.duration) && video.duration > 0
      ? video.duration
      : null;

  return {
    title: titleEl?.textContent?.trim() || null,
    channelName: channelEl?.textContent?.trim() || null,
    description: descEl?.textContent?.trim() || null,
    duration,
  };
}

/**
 * Answers the relayed bilibiliGetPageInfo request. Identity (bvid/aid/page)
 * always comes from the URL. The MAIN state contributes title/channel/cid
 * only when it still matches the URL — a stale __INITIAL_STATE__ must not
 * speak for the current video.
 */
async function getBilibiliPageInfo() {
  const locator = getCurrentBilibiliLocator();
  if (!locator) {
    return {
      success: false,
      error: {
        code: "UNSUPPORTED_PAGE",
        message: "This is not a supported Bilibili video page.",
        retryable: false,
      },
    };
  }

  const state = await requestBilibiliMainState();
  const dom = readBilibiliDomMetadata();

  let cidHint = null;
  let title = dom.title;
  let channelName = dom.channelName;
  let description = dom.description;
  let duration = dom.duration;
  let stateMatched = false;

  if (state && state.available && state.stateMatched) {
    const identityMatches =
      (locator.bvid && state.bvid === locator.bvid) ||
      (!locator.bvid && locator.aid && state.aid === locator.aid);
    if (identityMatches) {
      stateMatched = true;
      cidHint = state.cidHint;
      title = state.title || title;
      channelName = state.channelName || channelName;
      description = state.description || description;
      duration = state.duration || duration;
    }
  }

  return {
    success: true,
    locator: serializeBilibiliLocator({
      bvid: locator.bvid,
      aid: locator.aid,
      page: locator.page,
      cidHint,
    }),
    title: title || "",
    channelName: channelName || "",
    description: description || "",
    duration: duration || 0,
    stateMatched,
  };
}

// ------------------------------------------------------------
// Player reads and timestamp seeks
// ------------------------------------------------------------

/**
 * The SSR HTML ships an empty #bilibili-player div; the <video> element only
 * appears after the player hydrates. Keep the selector loose so player DOM
 * reshuffles do not break us.
 */
function findBilibiliPlayerVideo() {
  return (
    document.querySelector("#bilibili-player video") ||
    document.querySelector("#playerWrap video") ||
    document.querySelector(".bpx-player-video-wrap video")
  );
}

function cancelBilibiliPlayerWait() {
  // Settle any in-flight hydration wait so its async sendResponse always
  // fires exactly once. The callback re-validates identity, so a navigation
  // cancel surfaces as STALE_CONTEXT instead of a hung relay.
  const settle = bilibiliPlayerWaitSettle;
  bilibiliPlayerWaitSettle = null;
  if (bilibiliPlayerObserver) {
    bilibiliPlayerObserver.disconnect();
    bilibiliPlayerObserver = null;
  }
  if (bilibiliPlayerWaitTimer) {
    clearTimeout(bilibiliPlayerWaitTimer);
    bilibiliPlayerWaitTimer = null;
  }
  if (settle) settle(null);
}

/**
 * Waits (bounded) for the hydrated player video element. Watches only the
 * player container subtree. Calls back with null on timeout or when the wait
 * is cancelled (e.g. the page navigated to another video/part).
 */
function waitForBilibiliPlayerVideo(
  callback,
  timeoutMs = BILIBILI_PLAYER_WAIT_TIMEOUT_MS,
) {
  cancelBilibiliPlayerWait(); // settles any previous wait as timed out

  let settled = false;
  const finish = (video) => {
    if (settled) return;
    settled = true;
    if (bilibiliPlayerWaitSettle === finish) bilibiliPlayerWaitSettle = null;
    cancelBilibiliPlayerWait();
    callback(video || null);
  };
  bilibiliPlayerWaitSettle = finish;

  const immediate = findBilibiliPlayerVideo();
  if (immediate) {
    finish(immediate);
    return;
  }

  const host =
    document.querySelector("#bilibili-player") ||
    document.querySelector("#playerWrap");
  if (host) {
    bilibiliPlayerObserver = new MutationObserver(() => {
      const video = findBilibiliPlayerVideo();
      if (video) finish(video);
    });
    bilibiliPlayerObserver.observe(host, { childList: true, subtree: true });
  }

  bilibiliPlayerWaitTimer = setTimeout(
    () => finish(findBilibiliPlayerVideo()),
    timeoutMs,
  );
}

/**
 * The background sends its authoritative video object with player requests.
 * We still check it against the address bar: bvid (or aid for av URLs) and
 * the part number must match, otherwise the request belongs to a previous
 * video/part and is refused as STALE_CONTEXT.
 */
function bilibiliVideoMatchesPage(video) {
  if (!video || typeof video !== "object") return false;
  const locator = getCurrentBilibiliLocator();
  if (!locator) return false;

  const videoBvid =
    typeof video.bvid === "string" && BILIBILI_BV_PATTERN.test(video.bvid)
      ? video.bvid
      : null;
  const videoAid =
    typeof video.aid === "string" && /^[1-9]\d*$/.test(video.aid)
      ? video.aid
      : null;
  const videoPage =
    Number.isInteger(video.page) && video.page > 0 ? video.page : null;

  if (locator.bvid) {
    if (!videoBvid || videoBvid !== locator.bvid) return false;
  } else if (locator.aid) {
    if (!videoAid || videoAid !== locator.aid) return false;
  } else {
    return false;
  }

  return videoPage !== null && videoPage === locator.page;
}

function bilibiliContentError(code, message, retryable) {
  return { success: false, error: { code, message, retryable } };
}

function handleBilibiliGetCurrentTime(message) {
  if (!isBilibiliVideoPage()) {
    return bilibiliContentError(
      "UNSUPPORTED_PAGE",
      "This is not a supported Bilibili video page.",
      false,
    );
  }
  if (!bilibiliVideoMatchesPage(message?.video)) {
    return bilibiliContentError(
      "STALE_CONTEXT",
      "The player request belongs to a different video or part.",
      false,
    );
  }
  const video = findBilibiliPlayerVideo();
  if (!video) {
    return bilibiliContentError(
      "PLAYER_NOT_READY",
      "The player is still loading.",
      true,
    );
  }
  return {
    success: true,
    currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
    paused: video.paused !== false,
  };
}

/**
 * Seeks after validating identity and the seconds value. If the player has
 * not hydrated yet, waits briefly (bounded) before reporting
 * PLAYER_NOT_READY — we never pretend a missing player is a successful seek
 * or a valid 0-second position.
 */
function handleBilibiliSeekTo(message, sendResponse) {
  const fail = (code, text, retryable) => {
    sendResponse(bilibiliContentError(code, text, retryable));
    return false;
  };

  if (!isBilibiliVideoPage()) {
    return fail(
      "UNSUPPORTED_PAGE",
      "This is not a supported Bilibili video page.",
      false,
    );
  }
  if (!bilibiliVideoMatchesPage(message?.video)) {
    return fail(
      "STALE_CONTEXT",
      "The seek request belongs to a different video or part.",
      false,
    );
  }

  const seconds = Number(message.seconds);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return fail(
      "INVALID_REQUEST",
      "Seek position must be a finite, non-negative number of seconds.",
      false,
    );
  }

  const video = findBilibiliPlayerVideo();
  if (video) {
    sendResponse(applyBilibiliSeek(video, seconds));
    return false;
  }

  waitForBilibiliPlayerVideo((found) => {
    // Navigation may have moved to another video/part while we waited for
    // hydration: re-validate against the address bar BEFORE touching the
    // player, so a stale wait can never seek the new part to the old
    // timestamp or report a fake success.
    if (!isBilibiliVideoPage() || !bilibiliVideoMatchesPage(message.video)) {
      sendResponse(
        bilibiliContentError(
          "STALE_CONTEXT",
          "The seek request belongs to a different video or part.",
          false,
        ),
      );
      return;
    }
    if (!found) {
      sendResponse(
        bilibiliContentError(
          "PLAYER_NOT_READY",
          "The player is still loading. Try again in a moment.",
          true,
        ),
      );
      return;
    }
    sendResponse(applyBilibiliSeek(found, seconds));
  });
  return true; // Async response while we wait for hydration
}

function applyBilibiliSeek(video, seconds) {
  let target = seconds;
  if (Number.isFinite(video.duration) && video.duration > 0) {
    target = Math.min(seconds, video.duration);
  }
  try {
    video.currentTime = target;
    if (video.paused) {
      const played = video.play?.();
      played?.catch?.(() => {}); // Autoplay policies may reject — harmless.
    }
  } catch (error) {
    return bilibiliContentError(
      "PLAYER_NOT_READY",
      "Could not seek the player.",
      true,
    );
  }
  return { success: true };
}

// Persistent listeners let the script survive SPA trips away from and back
// to video pages. Registration is host-gated so YouTube pages never see them.
if (isBilibiliHost()) {
  addBilibiliPersistentListeners();
}

// Helpers are exposed for the repository's Node tests. The page does not
// read this object at runtime.
globalThis.__YTD_BILIBILI_CONTENT_TESTING__ = {
  isBilibiliHost,
  isBilibiliVideoPage,
  parseBilibiliLocatorFromUrl,
  computeBilibiliFingerprint,
  serializeBilibiliLocator,
  initBilibili,
  cleanupBilibili,
  handleBilibiliPopstate,
  bilibiliFingerprintTick,
  handleBilibiliNavigation,
  findBilibiliButtonHost,
  injectBilibiliButton,
  setupBilibiliButtonObserver,
  requestBilibiliMainState,
  handleBilibiliBridgeMessage,
  sanitizeBilibiliMainState,
  readBilibiliDomMetadata,
  getBilibiliPageInfo,
  findBilibiliPlayerVideo,
  waitForBilibiliPlayerVideo,
  cancelBilibiliPlayerWait,
  bilibiliVideoMatchesPage,
  handleBilibiliGetCurrentTime,
  handleBilibiliSeekTo,
  applyBilibiliSeek,
  getBilibiliState() {
    return {
      active: bilibiliActive,
      lastFingerprint: bilibiliLastFingerprint,
      hasFingerprintTimer: bilibiliFingerprintTimer !== null,
      hasButtonObserver: bilibiliButtonObserver !== null,
      hasPlayerObserver: bilibiliPlayerObserver !== null,
      hasBridgePending: bilibiliBridgePending !== null,
      button: bilibiliDigestButton,
    };
  },
};
