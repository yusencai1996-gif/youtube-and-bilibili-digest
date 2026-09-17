const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const BVID = "BV1GJ411x7h7";
const CID_P1 = "111";
const CID_P2 = "222";
const VIDEO_P1 = {
  platform: "bilibili",
  bvid: BVID,
  aid: "80433022",
  cid: CID_P1,
  page: 1,
  videoKey: `bilibili:${BVID}:${CID_P1}`,
  canonicalUrl: `https://www.bilibili.com/video/${BVID}/?p=1`,
  title: "B 站视频一",
  channelName: "UP主甲",
  description: "简介",
  duration: 120,
};
const VIDEO_P2 = {
  ...VIDEO_P1,
  cid: CID_P2,
  page: 2,
  videoKey: `bilibili:${BVID}:${CID_P2}`,
  canonicalUrl: `https://www.bilibili.com/video/${BVID}/?p=2`,
  title: "B 站视频一 P2",
  duration: 90,
};
const YT_TAB = { id: 41, url: "https://www.youtube.com/watch?v=ytVideo123" };
const BILI_TAB_P1 = { id: 42, url: `https://www.bilibili.com/video/${BVID}/?p=1` };
const BILI_TAB_P2 = { id: 42, url: `https://www.bilibili.com/video/${BVID}/?p=2` };

// Cross-realm objects from the vm trip deepEqual; round-trip through JSON.
const plain = (value) => JSON.parse(JSON.stringify(value));

// ------------------------------------------------------------
// Fake DOM
// ------------------------------------------------------------

class FakeClassList {
  constructor() {
    this.set = new Set();
  }
  add(...names) {
    names.forEach((name) => this.set.add(name));
  }
  remove(...names) {
    names.forEach((name) => this.set.delete(name));
  }
  toggle(name, force) {
    const shouldAdd = force === undefined ? !this.set.has(name) : force;
    if (shouldAdd) this.set.add(name);
    else this.set.delete(name);
  }
  contains(name) {
    return this.set.has(name);
  }
}

class FakeElement {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.id = "";
    this.children = [];
    this.parentElement = null;
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.classList = new FakeClassList();
    this.textContent = "";
    this.innerHTML = "";
    this.value = "";
    this.title = "";
    this.disabled = false;
    this.hidden = false;
    this.scrollTop = 0;
    this.className = "";
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  addEventListener(type, listener) {
    (this.listeners[type] ||= []).push(listener);
  }
  removeEventListener(type, listener) {
    this.listeners[type] = (this.listeners[type] || []).filter(
      (candidate) => candidate !== listener,
    );
  }
  async click() {
    for (const listener of this.listeners.click || []) {
      await listener({
        preventDefault() {},
        stopPropagation() {},
        currentTarget: this,
        target: this,
      });
    }
  }
  appendChild(child) {
    child.parentElement?.removeChild?.(child);
    this.children.push(child);
    child.parentElement = this;
    return child;
  }
  insertBefore(child, before) {
    child.parentElement?.removeChild?.(child);
    const index = before ? this.children.indexOf(before) : -1;
    if (index >= 0) this.children.splice(index, 0, child);
    else this.children.push(child);
    child.parentElement = this;
    return child;
  }
  removeChild(child) {
    this.children = this.children.filter((candidate) => candidate !== child);
    if (child.parentElement === this) child.parentElement = null;
  }
  remove() {
    this.parentElement?.removeChild?.(this);
    this.parentElement = null;
    this.removed = true;
  }
  querySelector(selector) {
    // Auto-vivify per-selector stub children (e.g. ".explain-btn" inside the
    // tooltip built via innerHTML) so event wiring never crashes the harness.
    this._qsCache ||= new Map();
    if (!this._qsCache.has(selector)) {
      const stub = new FakeElement("button");
      stub.className = selector.replace(/^\./, "");
      this._qsCache.set(selector, stub);
    }
    return this._qsCache.get(selector);
  }
  querySelectorAll() {
    return [];
  }
  closest() {
    return null;
  }
  focus() {}
}

function createStorageArea() {
  const data = {};
  return {
    data,
    async get(key) {
      if (key === null || key === undefined) return { ...data };
      if (Array.isArray(key)) {
        return Object.fromEntries(key.map((item) => [item, data[item]]));
      }
      return { [key]: data[key] };
    },
    async set(values) {
      Object.assign(data, values);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
    async clear() {
      for (const key of Object.keys(data)) delete data[key];
    },
  };
}

/**
 * Loads sidepanel.js against a fake DOM + programmable chrome.runtime
 * messaging. The backend is represented by protocol stubs only — no real
 * backend code is involved.
 */
function createSidepanelHarness({
  activeTab = BILI_TAB_P1,
  config = { hasSupadataKey: true, hasAiKey: true },
  resolveImpl,
  fetchImpl,
  extraHandlers = {},
} = {}) {
  const byId = new Map();
  const createdElements = [];
  const messages = [];
  const deferredByPredicate = [];
  const clipboardWrites = [];
  const downloads = [];
  const documentListeners = {};
  const runtimeListeners = [];
  const tabUpdatedListeners = [];
  const tabActivatedListeners = [];
  const timeouts = new Map();
  let nextTimerId = 1;

  const localArea = createStorageArea();
  const sessionArea = createStorageArea();

  function getEl(id) {
    // Prefer real elements created by the panel (badge, tooltip, ...) over
    // auto-vivified stand-ins.
    const created = createdElements.find(
      (element) => element.id === id && !element.removed,
    );
    if (created) {
      byId.set(id, created);
      return created;
    }
    if (!byId.has(id)) {
      const element = new FakeElement("div");
      element.id = id;
      byId.set(id, element);
    }
    return byId.get(id);
  }

  // The transcript list lives inside a .section container; the source badge
  // is inserted before it.
  const transcriptSection = new FakeElement("section");
  transcriptSection.appendChild(getEl("transcriptList"));
  const contentArea = getEl("contentArea");
  contentArea.appendChild(transcriptSection);

  const modeButtons = ["original", "zh", "bilingual"].map((mode) => {
    const button = new FakeElement("button");
    button.dataset.transcriptMode = mode;
    return button;
  });
  const tabButtons = ["transcript", "overview", "notes"].map((tab, index) => {
    const button = new FakeElement("button");
    button.dataset.tab = tab;
    if (index === 0) button.classList.add("active");
    return button;
  });
  const tabPanels = ["transcript", "overview", "notes"].map((panel, index) => {
    const element = new FakeElement("div");
    element.dataset.panel = panel;
    if (index === 0) element.classList.add("active");
    return element;
  });

  const document = {
    body: new FakeElement("body"),
    documentElement: { lang: "en" },
    addEventListener(type, listener) {
      documentListeners[type] = listener;
    },
    getElementById: getEl,
    createElement(tag) {
      const element = new FakeElement(tag);
      createdElements.push(element);
      return element;
    },
    createTextNode(text) {
      return { nodeValue: String(text) };
    },
    querySelectorAll(selector) {
      if (selector === ".tab") return tabButtons;
      if (selector === ".tab-panel") return tabPanels;
      if (selector === ".transcript-mode-btn") return modeButtons;
      return [];
    },
    querySelector(selector) {
      if (selector === ".tab.active") {
        return tabButtons.find((button) => button.classList.contains("active")) || null;
      }
      return null;
    },
  };

  const windowObject = {
    getSelection: () => null,
    close() {
      this.closed = true;
    },
    closed: false,
    addEventListener() {},
    scrollY: 0,
  };

  function dispatchMessage(message) {
    messages.push(message);
    for (const entry of deferredByPredicate) {
      if (entry.predicate(message)) return entry.promise;
    }
    const handler = {
      checkConfig: async () => config,
      resolveBilibiliVideo:
        resolveImpl ||
        (async (msg) => ({
          success: true,
          requestId: msg.requestId,
          video: VIDEO_P1,
        })),
      fetchBilibiliTranscript:
        fetchImpl || (async (msg) => readyResult(msg.video)),
      getNotes: async () => ({ success: true, notes: [] }),
      relayToContent: async () => ({
        success: true,
        response: { title: "", channelName: "", description: "", duration: 0 },
      }),
      fetchTranscript: async () => ({
        success: true,
        transcript: [{ text: "Hello world", start: 0, duration: 2 }],
        transcriptText: "Hello world",
        transcriptTextTimestamped: "[0:00] Hello world",
        language: "en",
      }),
      bilibiliRelayToContent: async () => ({
        success: true,
        requestId: "relay",
        response: { success: true, currentTime: 0, paused: true },
      }),
      saveNote: async () => ({ success: true, note: {} }),
      saveBilibiliNote: async (msg) => ({
        success: true,
        requestId: msg.requestId,
        note: {
          id: "note_b1",
          videoId: msg.video.videoKey,
          platform: "bilibili",
          bvid: msg.video.bvid,
          cid: msg.video.cid,
          page: msg.video.page,
          timestampSeconds: msg.timestamp,
          timestamp: "0:30",
          timestampedUrl: `${msg.video.canonicalUrl}&t=${msg.timestamp}`,
          text: msg.selectedText || "字幕原文",
        },
      }),
      analyzeTranscript: async () => ({ success: true, analysis: { chapters: [], keyQuotes: [] } }),
      translateContent: async () => ({ success: true, translatedContent: { segments: [] } }),
      openOptions: async () => ({ success: true }),
      ...extraHandlers,
    }[message.action];
    if (!handler) return Promise.resolve({ success: false, error: "unknown" });
    return Promise.resolve(handler(message));
  }

  const URLWithBlob = class extends URL {
    static createObjectURL(blob) {
      downloads.push({ blob });
      return "blob:fake";
    }
    static revokeObjectURL() {}
  };

  const sandbox = {
    console,
    URL: URLWithBlob,
    Blob,
    TextDecoder,
    TextEncoder,
    AbortController,
    IntersectionObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    CSS: { escape: (value) => value },
    setTimeout(callback, ms) {
      const id = nextTimerId++;
      timeouts.set(id, { callback, ms });
      return id;
    },
    clearTimeout(id) {
      timeouts.delete(id);
    },
    setInterval() {
      return nextTimerId++;
    },
    clearInterval() {},
    requestAnimationFrame(callback) {
      callback();
      return 1;
    },
    navigator: {
      clipboard: {
        async writeText(text) {
          clipboardWrites.push(text);
        },
      },
    },
    window: windowObject,
    document,
    chrome: {
      runtime: {
        onMessage: {
          addListener(listener) {
            runtimeListeners.push(listener);
          },
        },
        sendMessage: dispatchMessage,
      },
      storage: { local: localArea, session: sessionArea },
      windows: { getCurrent: async () => ({ id: 7 }) },
      tabs: {
        onUpdated: {
          addListener(listener) {
            tabUpdatedListeners.push(listener);
          },
        },
        onActivated: {
          addListener(listener) {
            tabActivatedListeners.push(listener);
          },
        },
        query: async () => [activeTab],
        sendMessage: async () => ({ success: true }),
        create: async () => ({ id: 99 }),
      },
    },
    YTD_SETTINGS: {},
  };
  sandbox.globalThis = sandbox;

  vm.runInNewContext(read("sidepanel.js"), sandbox);

  const testing = sandbox.__YTD_TRANSCRIPT_TESTING__;

  return {
    sandbox,
    testing,
    messages,
    clipboardWrites,
    downloads,
    documentListeners,
    runtimeListeners,
    localArea,
    sessionArea,
    modeButtons,
    tabButtons,
    windowObject,
    getEl,
    setActiveTab(tab) {
      activeTab = tab;
    },
    deferOnce(predicate) {
      let resolve;
      const promise = new Promise((res) => {
        resolve = res;
      });
      const entry = { predicate, promise, resolve };
      deferredByPredicate.push(entry);
      return {
        release(value) {
          deferredByPredicate.splice(deferredByPredicate.indexOf(entry), 1);
          resolve(value);
        },
      };
    },
    flushTimeouts() {
      for (const entry of [...timeouts.values()]) entry.callback();
      timeouts.clear();
    },
    messagesOf(action) {
      return messages.filter((message) => message.action === action);
    },
    fireTabUpdated(tabId, changeInfo, tab) {
      for (const listener of tabUpdatedListeners) {
        listener(tabId, changeInfo, tab);
      }
    },
    async fireTabActivated(activeInfo) {
      for (const listener of tabActivatedListeners) {
        await listener(activeInfo);
      }
    },
    async boot() {
      await documentListeners.DOMContentLoaded();
    },
  };
}

const readyResult = (video, overrides = {}) => ({
  success: true,
  requestId: "r",
  status: "ready",
  video,
  transcript: [
    { text: "你好，世界。", start: 0, duration: 2, language: "zh-CN" },
  ],
  transcriptText: "你好，世界。",
  transcriptTextTimestamped: "[0:00] 你好，世界。",
  language: "zh-CN",
  source: "cc",
  originalAvailable: true,
  coverage: { endSeconds: 118, videoDuration: 120, possiblyPartial: false },
  warnings: [],
  ...overrides,
});

// ------------------------------------------------------------
// Loading states
// ------------------------------------------------------------

test("ready: resolve → fetch renders transcript under the resolved videoKey", async () => {
  const harness = createSidepanelHarness();
  await harness.boot();

  const state = harness.testing.getBilibiliPanelState();
  assert.equal(state.currentPlatform, "bilibili");
  assert.equal(state.bilibiliTabId, 42);
  assert.equal(state.currentVideoId, VIDEO_P1.videoKey);
  assert.equal(state.currentTranscriptSource, "cc");
  assert.equal(state.currentTranscript.length, 1);

  assert.equal(harness.getEl("resultsState").style.display, "block");
  assert.ok(harness.getEl("transcriptList").children.length > 0);
  assert.equal(harness.getEl("videoTitle").textContent, "B 站视频一");

  // Cache was written under the resolved videoKey (never the bare BV).
  assert.ok(harness.localArea.data[`digest_${VIDEO_P1.videoKey}`]);
  // Notes were loaded scoped to this exact video part.
  const noteLoads = harness.messagesOf("getNotes");
  assert.equal(noteLoads.at(-1).videoId, VIDEO_P1.videoKey);
});

test("login-required shows a neutral login prompt, not an error spinner", async () => {
  const harness = createSidepanelHarness({
    fetchImpl: async (msg) => ({
      success: true,
      requestId: msg.requestId,
      status: "login-required",
      video: msg.video,
      message: "请先登录 B 站",
      warnings: [],
    }),
  });
  await harness.boot();

  assert.equal(harness.getEl("errorState").style.display, "block");
  assert.equal(harness.getEl("errorTitle").textContent, "请先登录 B 站");
  assert.equal(harness.getEl("errorBtn").textContent, "重试");
  assert.equal(harness.getEl("loadingState").style.display, "none");
});

test("no-subtitle shows a neutral empty state", async () => {
  const harness = createSidepanelHarness({
    fetchImpl: async (msg) => ({
      success: true,
      requestId: msg.requestId,
      status: "no-subtitle",
      video: msg.video,
      message: "该视频无字幕",
      warnings: [],
    }),
  });
  await harness.boot();

  assert.equal(harness.getEl("errorTitle").textContent, "该视频无字幕");
  assert.equal(harness.getEl("errorBtn").textContent, "重新检查");
});

test("RATE_LIMITED shows a cooling hint and never auto-requests", async () => {
  const harness = createSidepanelHarness({
    fetchImpl: async () => ({
      success: false,
      requestId: "r",
      error: {
        code: "RATE_LIMITED",
        message: "请求暂时受限，请稍后重试",
        retryable: true,
        retryAfterMs: 60000,
      },
    }),
  });
  await harness.boot();

  const button = harness.getEl("errorBtn");
  assert.equal(harness.getEl("errorTitle").textContent, "请求暂时受限");
  assert.equal(button.disabled, true);
  assert.match(button.textContent, /60/);

  const fetchesBefore = harness.messagesOf("fetchBilibiliTranscript").length;
  harness.flushTimeouts(); // cooldown expires
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "重试");
  // Only the button was restored — no automatic refetch.
  assert.equal(
    harness.messagesOf("fetchBilibiliTranscript").length,
    fetchesBefore,
  );
});

test("network failure keeps the page with a manual retry", async () => {
  const harness = createSidepanelHarness({
    fetchImpl: async () => ({
      success: false,
      requestId: "r",
      error: { code: "NETWORK_ERROR", message: "网络异常", retryable: true },
    }),
  });
  await harness.boot();

  assert.equal(harness.getEl("errorTitle").textContent, "字幕获取失败");
  assert.equal(harness.getEl("errorBtn").textContent, "Try Again");

  // Manual retry re-runs the bilibili flow for the same locator.
  await harness.getEl("errorBtn").click();
  assert.ok(harness.messagesOf("resolveBilibiliVideo").length >= 2);
});

// ------------------------------------------------------------
// Tab scoping and stale responses
// ------------------------------------------------------------

test("only the current active tab is ever queried or addressed", async () => {
  const harness = createSidepanelHarness();
  await harness.boot();

  const resolve = harness.messagesOf("resolveBilibiliVideo")[0];
  assert.equal(resolve.tabId, 42);
  const fetch = harness.messagesOf("fetchBilibiliTranscript")[0];
  assert.equal(fetch.tabId, 42);
});

test("a slow earlier response cannot overwrite a newer video", async () => {
  // Tab starts on video A; A's resolve hangs. The user moves to video B,
  // which loads fully. A's late answer must be discarded.
  const videoA = { ...VIDEO_P1, bvid: "BV1xx411c7mD", videoKey: "bilibili:BV1xx411c7mD:111" };
  const harness = createSidepanelHarness({
    activeTab: { id: 42, url: `https://www.bilibili.com/video/BV1xx411c7mD/?p=1` },
    resolveImpl: async (msg) => {
      if (msg.locator.bvid === "BV1xx411c7mD") {
        return deferredA.promise;
      }
      return { success: true, requestId: msg.requestId, video: VIDEO_P2 };
    },
    fetchImpl: async (msg) => readyResult(msg.video),
  });
  const deferredA = harness.deferOnce(
    (msg) => msg.action === "resolveBilibiliVideo" && msg.locator.bvid === "BV1xx411c7mD",
  );

  const first = harness.boot();
  // Wait until A's resolve request is actually on the wire (the boot chain
  // crosses several awaited steps before it gets there).
  for (
    let i = 0;
    i < 100 && harness.messagesOf("resolveBilibiliVideo").length === 0;
    i += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(harness.messagesOf("resolveBilibiliVideo").length, 1);

  // User navigates to another video before A answers.
  harness.setActiveTab(BILI_TAB_P2);
  await harness.testing.checkCurrentTab();
  assert.equal(
    harness.testing.getBilibiliPanelState().currentVideoId,
    VIDEO_P2.videoKey,
  );

  // Now A finally resolves — its whole chain must be dropped.
  deferredA.release({
    success: true,
    requestId: "late",
    video: videoA,
  });
  await first;
  await new Promise((resolve) => setTimeout(resolve, 10));

  const state = harness.testing.getBilibiliPanelState();
  assert.equal(state.currentVideoId, VIDEO_P2.videoKey);
  assert.equal(state.currentBilibiliVideo.videoKey, VIDEO_P2.videoKey);
});

// ------------------------------------------------------------
// Cross-platform switching
// ------------------------------------------------------------

test("YouTube ↔ Bilibili switching resets platform state both ways", async () => {
  const harness = createSidepanelHarness();
  await harness.boot();
  assert.equal(harness.testing.getBilibiliPanelState().currentPlatform, "bilibili");

  // Bilibili → YouTube
  harness.setActiveTab(YT_TAB);
  await harness.testing.checkCurrentTab();
  let state = harness.testing.getBilibiliPanelState();
  assert.equal(state.currentPlatform, "youtube");
  assert.equal(state.bilibiliTabId, null);
  assert.equal(state.currentBilibiliVideo, null);
  assert.equal(state.youtubeTabId, 41);
  assert.equal(state.currentVideoId, "ytVideo123");
  assert.equal(state.currentTranscriptSource, null);

  // YouTube → Bilibili
  harness.setActiveTab(BILI_TAB_P1);
  await harness.testing.checkCurrentTab();
  state = harness.testing.getBilibiliPanelState();
  assert.equal(state.currentPlatform, "bilibili");
  assert.equal(state.bilibiliTabId, 42);
  assert.equal(state.currentVideoId, VIDEO_P1.videoKey);
});

test("YouTube without a Supadata key still hits the config gate", async () => {
  const harness = createSidepanelHarness({
    activeTab: YT_TAB,
    config: { hasSupadataKey: false, hasAiKey: true },
  });
  await harness.boot();

  assert.equal(harness.getEl("errorTitle").textContent, "API Keys Missing");
  assert.match(harness.getEl("errorMessage").textContent, /Supadata/);
  assert.equal(harness.messagesOf("fetchTranscript").length, 0);
});

test("Bilibili loads transcripts with no keys configured at all", async () => {
  const harness = createSidepanelHarness({
    config: { hasSupadataKey: false, hasAiKey: false },
  });
  await harness.boot();

  const state = harness.testing.getBilibiliPanelState();
  assert.equal(state.currentPlatform, "bilibili");
  assert.equal(state.currentTranscript.length, 1);
  assert.equal(harness.getEl("resultsState").style.display, "block");
});

test("Bilibili AI overview asks for the DeepSeek key at action time", async () => {
  const harness = createSidepanelHarness({
    config: { hasSupadataKey: false, hasAiKey: false },
  });
  await harness.boot();

  // Opening the Overview tab triggers analysis, which must stop at the key
  // check instead of calling the AI. switchTab fires triggerAnalysis without
  // awaiting it, so let the microtask queue settle before asserting.
  await harness.testing.checkCurrentTab(); // ensure loaded
  const overviewTab = harness.tabButtons.find((b) => b.dataset.tab === "overview");
  await overviewTab.click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.match(
    harness.getEl("chapterList").innerHTML,
    /DeepSeek API key/,
  );
  assert.equal(harness.messagesOf("analyzeTranscript").length, 0);
});

// ------------------------------------------------------------
// Per-part cache and notes isolation
// ------------------------------------------------------------

test("part switches isolate caches and notes per videoKey", async () => {
  const harness = createSidepanelHarness({
    resolveImpl: async (msg) => ({
      success: true,
      requestId: msg.requestId,
      video: msg.locator.page === 2 ? VIDEO_P2 : VIDEO_P1,
    }),
    fetchImpl: async (msg) =>
      readyResult(msg.video, {
        transcriptText: msg.video.page === 2 ? "P2 字幕" : "P1 字幕",
        transcript: [
          {
            text: msg.video.page === 2 ? "P2 字幕" : "P1 字幕",
            start: 0,
            duration: 2,
            language: "zh-CN",
          },
        ],
      }),
  });
  await harness.boot();
  assert.equal(
    harness.testing.getBilibiliPanelState().currentVideoId,
    VIDEO_P1.videoKey,
  );

  // Switch to P2 (SPA navigation, same tab).
  harness.setActiveTab(BILI_TAB_P2);
  await harness.testing.checkCurrentTab();
  const state = harness.testing.getBilibiliPanelState();
  assert.equal(state.currentVideoId, VIDEO_P2.videoKey);
  assert.equal(state.currentTranscriptText, "P2 字幕");

  // Both parts have independent cache entries.
  assert.ok(harness.localArea.data[`digest_${VIDEO_P1.videoKey}`]);
  assert.ok(harness.localArea.data[`digest_${VIDEO_P2.videoKey}`]);
  assert.equal(
    harness.localArea.data[`digest_${VIDEO_P1.videoKey}`].transcriptText,
    "P1 字幕",
  );
  assert.equal(
    harness.localArea.data[`digest_${VIDEO_P2.videoKey}`].transcriptText,
    "P2 字幕",
  );

  // Notes were loaded per part.
  const noteVideoIds = harness.messagesOf("getNotes").map((m) => m.videoId);
  assert.ok(noteVideoIds.includes(VIDEO_P1.videoKey));
  assert.ok(noteVideoIds.includes(VIDEO_P2.videoKey));

  // Back to P1: cache hit, no second fetch for P1.
  harness.setActiveTab(BILI_TAB_P1);
  const fetchesForP1 = () =>
    harness
      .messagesOf("fetchBilibiliTranscript")
      .filter((m) => m.video.videoKey === VIDEO_P1.videoKey).length;
  const before = fetchesForP1();
  await harness.testing.checkCurrentTab();
  assert.equal(fetchesForP1(), before);
  assert.equal(
    harness.testing.getBilibiliPanelState().currentTranscriptText,
    "P1 字幕",
  );
});

test("a refresh with changed text invalidates old translations and analysis", async () => {
  let fetchCount = 0;
  const harness = createSidepanelHarness({
    fetchImpl: async (msg) => {
      fetchCount += 1;
      const text = fetchCount === 1 ? "旧正文。" : "新正文。";
      return readyResult(msg.video, {
        transcript: [
          { text, start: 0, duration: 2, language: "zh-CN" },
        ],
        transcriptText: text,
        transcriptTextTimestamped: `[0:00] ${text}`,
      });
    },
  });
  await harness.boot();
  const videoKey = VIDEO_P1.videoKey;

  // Simulate a previous session's stored translations for this videoKey.
  harness.localArea.data[`digest_${videoKey}`] = {
    ...harness.localArea.data[`digest_${videoKey}`],
    paragraphCache: { [`${videoKey}:zh:semantic:segment-0-0`]: "旧翻译" },
    interfaceCache: { [`${videoKey}:zh:overview:chapter-0-title`]: "旧标题" },
    analysis: { chapters: [{ title: "old", timestampSeconds: 0 }] },
  };

  // Reopen (cache restore pulls the stale translations into memory).
  harness.setActiveTab({ id: 42, url: BILI_TAB_P1.url });
  await harness.testing.checkCurrentTab();
  let state = harness.testing.getBilibiliPanelState();
  assert.equal(state.transcriptParagraphCacheSize > 0, true);

  // Manual refresh: the fetch now returns DIFFERENT text.
  const oldFetch = harness.messagesOf("fetchBilibiliTranscript").length;
  await harness.testing.startBilibiliDigest(
    { bvid: BVID, aid: null, page: 1 },
    BILI_TAB_P1.url,
    { forceRefresh: true },
  );

  state = harness.testing.getBilibiliPanelState();
  assert.equal(state.currentTranscriptText, "新正文。");
  assert.equal(state.transcriptParagraphCacheSize, 0);
  assert.equal(state.interfaceTranslationCacheSize, 0);
  assert.equal(state.currentAnalysis, null);
  assert.ok(harness.messagesOf("fetchBilibiliTranscript").length > oldFetch);
});

// ------------------------------------------------------------
// Source provenance and bilingual honesty
// ------------------------------------------------------------

test("source badge labels cc / ai / conclusion provenance", async () => {
  for (const [source, expected] of [
    ["cc", "来源：B 站 CC 字幕"],
    ["ai", "来源：B 站 AI 字幕"],
  ]) {
    const harness = createSidepanelHarness({
      fetchImpl: async (msg) => readyResult(msg.video, { source }),
    });
    await harness.boot();
    const badge = harness.getEl("transcriptSourceBadge");
    const label = badge.children.find((c) => c.className === "transcript-source-label");
    assert.equal(label.textContent, expected, `source=${source}`);
  }
});

test("conclusion transcripts disclose the missing foreign original and disable fake bilingual", async () => {
  const harness = createSidepanelHarness({
    fetchImpl: async (msg) =>
      readyResult(msg.video, {
        source: "conclusion",
        originalAvailable: false,
        language: "zh-CN",
      }),
  });
  await harness.boot();

  const badge = harness.getEl("transcriptSourceBadge");
  const label = badge.children.find((c) => c.className === "transcript-source-label");
  assert.equal(label.textContent, "来源：B 站转写 · 未提供外文原文");

  const zhButton = harness.modeButtons.find((b) => b.dataset.transcriptMode === "zh");
  const bilingualButton = harness.modeButtons.find(
    (b) => b.dataset.transcriptMode === "bilingual",
  );
  const originalButton = harness.modeButtons.find(
    (b) => b.dataset.transcriptMode === "original",
  );
  assert.equal(zhButton.disabled, true);
  assert.equal(bilingualButton.disabled, true);
  assert.equal(originalButton.disabled, false);
  assert.match(zhButton.title, /未提供外文原文/);
});

test("possiblyPartial coverage shows the honest incomplete hint", async () => {
  const harness = createSidepanelHarness({
    fetchImpl: async (msg) =>
      readyResult(msg.video, {
        coverage: { endSeconds: 40, videoDuration: 120, possiblyPartial: true },
      }),
  });
  await harness.boot();

  const badge = harness.getEl("transcriptSourceBadge");
  const hint = badge.children.find((c) => c.className === "transcript-partial-hint");
  assert.ok(hint);
  assert.match(hint.textContent, /字幕可能尚未完整/);
  // Manual refresh is offered for the current video.
  const refresh = badge.children.find((c) => c.id === "bilibiliRefreshBtn");
  assert.ok(refresh);
});

// ------------------------------------------------------------
// Export, seek, and note links
// ------------------------------------------------------------

test("export uses the canonical Bilibili URL with the current part", async () => {
  const harness = createSidepanelHarness();
  await harness.boot();

  harness.testing.exportTranscript();
  assert.equal(harness.downloads.length, 1);
  const text = await harness.downloads[0].blob.text();
  assert.match(text, new RegExp(`URL: https://www\\.bilibili\\.com/video/${BVID}/\\?p=1`));
});

test("seek routes through bilibiliRelayToContent with video and floored seconds", async () => {
  const harness = createSidepanelHarness();
  await harness.boot();

  await harness.testing.bilibiliSeek(61.9);
  const relay = harness.messagesOf("bilibiliRelayToContent")[0];
  assert.equal(relay.tabId, 42);
  assert.equal(relay.payload.action, "bilibiliSeekTo");
  assert.equal(relay.payload.seconds, 61);
  assert.equal(relay.payload.video.videoKey, VIDEO_P1.videoKey);
});

test("selection notes go to saveBilibiliNote and keep the backend link shape", async () => {
  const harness = createSidepanelHarness();
  await harness.boot();

  const result = await harness.testing.saveBilibiliNoteRequest({
    timestamp: 30.7,
    selectedText: "选中的一句原文",
  });
  const message = harness.messagesOf("saveBilibiliNote")[0];
  assert.equal(message.tabId, 42);
  assert.equal(message.timestamp, 30); // floored integer seconds
  assert.equal(message.selectedText, "选中的一句原文");
  assert.equal(message.video.videoKey, VIDEO_P1.videoKey);

  // The backend-built note link uses the canonical ?p=N&t=秒 shape.
  assert.equal(
    plain(result).note.timestampedUrl,
    `https://www.bilibili.com/video/${BVID}/?p=1&t=30`,
  );
});

// ------------------------------------------------------------
// bilibiliPanelOpened event
// ------------------------------------------------------------

test("bilibiliPanelOpened only reacts to this window", async () => {
  const harness = createSidepanelHarness();
  await harness.boot();
  const listener = harness.runtimeListeners[0];
  const before = harness.messagesOf("resolveBilibiliVideo").length;

  // Other window's event: ignored.
  const responses = [];
  listener({ action: "bilibiliPanelOpened", tabId: 42, windowId: 999 }, null, (r) =>
    responses.push(r),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    harness.messagesOf("resolveBilibiliVideo").length,
    before,
  );

  // Same window (7, per the windows.getCurrent stub): re-checks the tab.
  listener({ action: "bilibiliPanelOpened", tabId: 42, windowId: 7 }, null, () => {});
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(harness.messagesOf("resolveBilibiliVideo").length > before);
});

test("front-tab tracking treats Bilibili video URLs as supported", async () => {
  const harness = createSidepanelHarness();
  await harness.boot();

  // A non-supported page closes the panel; a Bilibili video page must not.
  harness.testing.handleFrontTabUrl(`https://www.bilibili.com/video/${BVID}/?p=2`);
  assert.equal(harness.windowObject.closed, false);

  harness.testing.handleFrontTabUrl("https://example.com/");
  assert.equal(harness.windowObject.closed, true);
});

test("front-tab events from another window never close or refresh this panel", async () => {
  const harness = createSidepanelHarness();
  await harness.boot();
  // Let the chrome.windows.getCurrent() stub land: panelWindowId is now 7.
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.windowObject.closed, false);
  const resolvesBefore = harness.messagesOf("resolveBilibiliVideo").length;

  // A foreground tab in ANOTHER window lands on an unsupported page. If the
  // window gate leaked, handleFrontTabUrl would close this panel outright.
  harness.fireTabUpdated(
    77,
    { url: "https://example.com/" },
    { id: 77, windowId: 99, active: true, url: "https://example.com/" },
  );
  await harness.fireTabActivated({ tabId: 77, windowId: 99 });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.windowObject.closed, false);
  assert.equal(
    harness.messagesOf("resolveBilibiliVideo").length,
    resolvesBefore,
    "foreign-window events must not schedule a digest refresh",
  );

  // Control: the SAME window's unsupported navigation still closes the panel,
  // proving the listeners fire and only the window gate protected us above.
  harness.fireTabUpdated(
    42,
    { url: "https://example.com/" },
    { id: 42, windowId: 7, active: true, url: "https://example.com/" },
  );
  assert.equal(harness.windowObject.closed, true);
});

// ------------------------------------------------------------
// Wire protocol: locator field omission (backend rejects explicit nulls)
// ------------------------------------------------------------

test("resolve requests omit null locator fields on the wire", async () => {
  // BV address → {bvid, page}: the null aid twin is absent, not null.
  const bvHarness = createSidepanelHarness();
  await bvHarness.boot();
  const bvResolve = bvHarness.messagesOf("resolveBilibiliVideo")[0];
  assert.deepEqual(plain(bvResolve.locator), { bvid: BVID, page: 1 });
  assert.equal("aid" in bvResolve.locator, false);

  // av address → {aid, page}: the null bvid twin is absent, not null.
  const avHarness = createSidepanelHarness({
    activeTab: { id: 43, url: "https://www.bilibili.com/video/av80433022/?p=2" },
  });
  await avHarness.boot();
  const avResolve = avHarness.messagesOf("resolveBilibiliVideo")[0];
  assert.deepEqual(plain(avResolve.locator), { aid: "80433022", page: 2 });
  assert.equal("bvid" in avResolve.locator, false);
});

// ------------------------------------------------------------
// Async context isolation (PLAN: check context before applying results)
// ------------------------------------------------------------

test("a slow analysis from a previous part never lands on the new part or its cache", async () => {
  const harness = createSidepanelHarness({
    resolveImpl: async (msg) => ({
      success: true,
      requestId: msg.requestId,
      video: msg.locator.page === 2 ? VIDEO_P2 : VIDEO_P1,
    }),
  });
  await harness.boot();
  assert.equal(
    harness.testing.getBilibiliPanelState().currentVideoId,
    VIDEO_P1.videoKey,
  );

  // P1: opening the Overview tab sends the analysis request; make it hang.
  const deferred = harness.deferOnce((msg) => msg.action === "analyzeTranscript");
  const overviewTab = harness.tabButtons.find((b) => b.dataset.tab === "overview");
  await overviewTab.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.messagesOf("analyzeTranscript").length, 1);

  // The user switches to P2 before P1's analysis answers.
  harness.setActiveTab(BILI_TAB_P2);
  await harness.testing.checkCurrentTab();
  assert.equal(
    harness.testing.getBilibiliPanelState().currentVideoId,
    VIDEO_P2.videoKey,
  );

  // P1's analysis finally returns — it must be dropped entirely.
  deferred.release({
    success: true,
    analysis: { chapters: [{ title: "P1章节", timestampSeconds: 1 }], keyQuotes: [] },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const state = harness.testing.getBilibiliPanelState();
  assert.equal(state.currentAnalysis, null);
  assert.equal(
    harness.getEl("chapterList").innerHTML.includes("P1章节"),
    false,
  );

  // P2's persistent cache must not contain P1's analysis either.
  const p2Cache = harness.localArea.data[`digest_${VIDEO_P2.videoKey}`];
  assert.ok(p2Cache, "P2 transcript cache exists");
  assert.equal(p2Cache.analysis ?? null, null);
});

test("a slow YouTube transcript answer never lands on the Bilibili view", async () => {
  const harness = createSidepanelHarness({ activeTab: YT_TAB });
  // The YouTube transcript fetch hangs.
  const deferred = harness.deferOnce((msg) => msg.action === "fetchTranscript");
  const boot = harness.boot();
  for (
    let i = 0;
    i < 100 && harness.messagesOf("fetchTranscript").length === 0;
    i += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(harness.messagesOf("fetchTranscript").length, 1);

  // The user moves to a Bilibili tab, which loads fully.
  harness.setActiveTab(BILI_TAB_P1);
  await harness.testing.checkCurrentTab();
  assert.equal(
    harness.testing.getBilibiliPanelState().currentVideoId,
    VIDEO_P1.videoKey,
  );

  // The YouTube answer finally arrives — it must not touch the Bilibili view.
  deferred.release({
    success: true,
    transcript: [{ text: "late youtube text", start: 0, duration: 2 }],
    transcriptText: "late youtube text",
    transcriptTextTimestamped: "[0:00] late youtube text",
    language: "en",
  });
  await boot;
  await new Promise((resolve) => setTimeout(resolve, 10));

  const state = harness.testing.getBilibiliPanelState();
  assert.equal(state.currentPlatform, "bilibili");
  assert.equal(state.currentVideoId, VIDEO_P1.videoKey);
  assert.equal(state.currentTranscriptText, "你好，世界。");
});

// ------------------------------------------------------------
// Source badge across language mode switches
// ------------------------------------------------------------

test("the source badge survives cycling through all three language modes", async () => {
  const harness = createSidepanelHarness();
  await harness.boot();

  const badgeAlive = () => {
    const badge = harness.getEl("transcriptSourceBadge");
    return Boolean(badge && !badge.removed && badge.parentElement);
  };
  assert.equal(badgeAlive(), true, "badge present after initial load");

  for (const mode of ["zh", "bilingual", "original"]) {
    const button = harness.modeButtons.find(
      (b) => b.dataset.transcriptMode === mode,
    );
    await button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(badgeAlive(), true, `badge present after switching to ${mode}`);
    const badge = harness.getEl("transcriptSourceBadge");
    const label = badge.children.find(
      (c) => c.className === "transcript-source-label",
    );
    assert.equal(label.textContent, "来源：B 站 CC 字幕");
  }
});

// ------------------------------------------------------------
// Partial transcript freshness clock
// ------------------------------------------------------------

test("analysis re-saves never renew a partial transcript's fetch clock", async () => {
  const harness = createSidepanelHarness({
    fetchImpl: async (msg) =>
      readyResult(msg.video, {
        coverage: { endSeconds: 30, videoDuration: 120, possiblyPartial: true },
      }),
  });
  await harness.boot();

  const key = `digest_${VIDEO_P1.videoKey}`;
  const firstSave = harness.localArea.data[key];
  assert.ok(firstSave, "transcript cached after fetch");
  const fetchedAt = firstSave.transcriptFetchedAt;
  assert.equal(typeof fetchedAt, "number");

  // Analysis completes → the cache entry is re-saved with the analysis.
  const overviewTab = harness.tabButtons.find((b) => b.dataset.tab === "overview");
  await overviewTab.click();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const resaved = harness.localArea.data[key];
  assert.ok(resaved.analysis, "analysis was persisted");
  assert.equal(
    resaved.transcriptFetchedAt,
    fetchedAt,
    "partial transcript age must not reset on analysis writes",
  );
});

test("a partial transcript older than 5 minutes refetches even when its entry was just rewritten", async () => {
  const harness = createSidepanelHarness();
  // Seed: fetched 6 minutes ago, but an analysis write bumped `timestamp`
  // to just now — reading `timestamp` would wrongly keep it alive.
  harness.localArea.data[`digest_${VIDEO_P1.videoKey}`] = {
    analysis: { chapters: [], keyQuotes: [] },
    transcript: [{ text: "旧字幕", start: 0, duration: 2 }],
    transcriptText: "旧字幕",
    transcriptTimestamped: "[0:00] 旧字幕",
    transcriptLanguage: "zh-CN",
    source: "cc",
    originalAvailable: true,
    coverage: { endSeconds: 30, videoDuration: 120, possiblyPartial: true },
    transcriptFetchedAt: Date.now() - 6 * 60 * 1000,
    timestamp: Date.now(),
  };

  await harness.boot();
  assert.ok(
    harness.messagesOf("fetchBilibiliTranscript").length >= 1,
    "a stale partial transcript must refetch from the network",
  );
  const state = harness.testing.getBilibiliPanelState();
  assert.equal(state.currentTranscriptText, "你好，世界。");
});
