const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const BVID = "BV1GJ411x7h7";
const BVID_OTHER = "BV1xx411c7mD";
const PAGE_URL = `https://www.bilibili.com/video/${BVID}/?p=1`;
const ORIGIN = "https://www.bilibili.com";

// Objects built inside the vm sandbox carry the sandbox realm's
// prototypes, which trips deepEqual. Round-trip through JSON first.
const plain = (value) => JSON.parse(JSON.stringify(value));

// ------------------------------------------------------------
// Fake DOM
// ------------------------------------------------------------

class FakeElement {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.id = "";
    this.children = [];
    this.parentElement = null;
    this.isConnected = true;
    this.style = {};
    this.dataset = {};
    this.listeners = {};
    this.attributes = {};
    this.textContent = "";
    this.innerHTML = "";
    this.className = "";
  }

  get firstChild() {
    return this.children[0] || null;
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  addEventListener(type, listener) {
    (this.listeners[type] ||= []).push(listener);
  }

  click() {
    (this.listeners.click || []).forEach((listener) =>
      listener({ preventDefault() {}, stopPropagation() {} }),
    );
  }

  appendChild(child) {
    child.parentElement?.removeChild(child);
    this.children.push(child);
    child.parentElement = this;
    child.isConnected = true;
    return child;
  }

  insertBefore(child, before) {
    child.parentElement?.removeChild(child);
    const index = before ? this.children.indexOf(before) : -1;
    if (index >= 0) this.children.splice(index, 0, child);
    else this.children.push(child);
    child.parentElement = this;
    child.isConnected = true;
    return child;
  }

  removeChild(child) {
    this.children = this.children.filter((candidate) => candidate !== child);
    if (child.parentElement === this) child.parentElement = null;
  }

  remove() {
    this.parentElement?.removeChild(this);
    this.isConnected = false;
  }
}

/**
 * Loads content.js in a vm sandbox wired to a Bilibili video URL. Selectors
 * resolve through a mutable map so each test can rebuild the page shape.
 */
function createBilibiliContentHarness({ url = PAGE_URL } = {}) {
  const selectorMap = new Map();
  const createdElements = [];
  const documentListeners = {};
  const windowListeners = {};
  const postedMessages = [];
  const sentMessages = [];
  const observers = [];
  const intervals = new Map();
  const timeouts = new Map();
  let nextTimerId = 1;

  const location = {
    href: url,
    origin: ORIGIN,
    get hostname() {
      return new URL(this.href).hostname;
    },
    get pathname() {
      return new URL(this.href).pathname;
    },
    get search() {
      return new URL(this.href).search;
    },
  };

  const document = {
    readyState: "complete", // init() runs immediately on script load
    body: new FakeElement("body"),
    addEventListener(type, listener) {
      documentListeners[type] = listener;
    },
    querySelector(selector) {
      if (selectorMap.has(selector)) return selectorMap.get(selector);
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "#ytd-bilibili-digest-button") {
        return createdElements.filter(
          (element) =>
            element.id === "ytd-bilibili-digest-button" && element.isConnected,
        );
      }
      if (selectorMap.has(selector)) {
        const value = selectorMap.get(selector);
        return Array.isArray(value) ? value : value ? [value] : [];
      }
      return [];
    },
    getElementById(id) {
      return (
        createdElements.find(
          (element) => element.id === id && element.isConnected,
        ) || null
      );
    },
    createElement(tag) {
      const element = new FakeElement(tag);
      createdElements.push(element);
      return element;
    },
    createTextNode(text) {
      return { nodeValue: String(text) };
    },
  };

  const windowObject = {
    location,
    addEventListener(type, listener) {
      (windowListeners[type] ||= []).push(listener);
    },
    postMessage(data, targetOrigin) {
      postedMessages.push({ data, targetOrigin });
    },
    getComputedStyle() {
      return { display: "flex", visibility: "visible", position: "relative" };
    },
  };

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.observing = null;
      this.disconnected = false;
      observers.push(this);
    }
    observe(target, options) {
      this.observing = { target, options };
    }
    disconnect() {
      this.disconnected = true;
      this.observing = null;
    }
    trigger() {
      this.callback([]);
    }
  }

  const sandbox = {
    console,
    URL,
    document,
    window: windowObject,
    MutationObserver: FakeMutationObserver,
    chrome: {
      runtime: {
        onMessage: {
          addListener(listener) {
            sandbox.__runtimeListener = listener;
          },
        },
        async sendMessage(message) {
          sentMessages.push(message);
          return { success: true };
        },
      },
    },
    setTimeout(callback, ms) {
      const id = nextTimerId++;
      timeouts.set(id, { callback, ms });
      return id;
    },
    clearTimeout(id) {
      timeouts.delete(id);
    },
    setInterval(callback, ms) {
      const id = nextTimerId++;
      intervals.set(id, { callback, ms });
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
  };
  sandbox.globalThis = sandbox;

  vm.runInNewContext(read("content.js"), sandbox);

  return {
    sandbox,
    selectorMap,
    createdElements,
    documentListeners,
    windowListeners,
    postedMessages,
    sentMessages,
    observers,
    testing: sandbox.__YTD_BILIBILI_CONTENT_TESTING__,
    get runtimeListener() {
      return sandbox.__runtimeListener;
    },
    setUrl(nextUrl) {
      location.href = nextUrl;
    },
    firePopstate() {
      (windowListeners.popstate || []).forEach((listener) => listener({}));
    },
    fireBridgeMessage(event) {
      (windowListeners.message || []).forEach((listener) => listener(event));
    },
    tickIntervals() {
      for (const entry of [...intervals.values()]) entry.callback();
    },
    flushTimeouts() {
      for (const entry of [...timeouts.values()]) entry.callback();
      timeouts.clear();
    },
    get intervalCount() {
      return intervals.size;
    },
    get timeoutCount() {
      return timeouts.size;
    },
    window: windowObject,
  };
}

/** Loads the MAIN-world bridge script with a controllable __INITIAL_STATE__. */
function createMainWorldHarness({ url = PAGE_URL, initialState = null } = {}) {
  const postedMessages = [];
  const windowListeners = {};
  const windowObject = {
    location: { href: url, origin: ORIGIN },
    __INITIAL_STATE__: initialState,
    addEventListener(type, listener) {
      (windowListeners[type] ||= []).push(listener);
    },
    postMessage(data, targetOrigin) {
      postedMessages.push({ data, targetOrigin });
    },
  };
  const sandbox = {
    console,
    URL,
    window: windowObject,
    globalThis: null,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("bilibili-page.js"), sandbox);
  return {
    sandbox,
    postedMessages,
    windowObject,
    testing: sandbox.__YTD_BILIBILI_PAGE_TESTING__,
    fireMessage(event) {
      (windowListeners.message || []).forEach((listener) => listener(event));
    },
  };
}

function sampleInitialState(overrides = {}) {
  return {
    bvid: BVID,
    aid: 80433022,
    cid: 137649199,
    p: 1,
    videoData: {
      bvid: BVID,
      aid: 80433022,
      cid: 137649199,
      title: "Test Video Title",
      desc: "A description.",
      duration: 120,
      owner: { name: "Test UP" },
      pages: [
        { cid: 137649199, page: 1, part: "P1", duration: 120 },
        { cid: 137649200, page: 2, part: "P2", duration: 90 },
      ],
      subtitle: {
        list: [
          {
            lan: "ai-zh",
            subtitle_url: "//aisubtitle.hdslb.com/secret?auth_key=abc",
          },
        ],
      },
    },
    ...overrides,
  };
}

// ------------------------------------------------------------
// URL parsing
// ------------------------------------------------------------

test("parseBilibiliLocatorFromUrl parses BV, av, and page, ignoring noise", () => {
  const harness = createBilibiliContentHarness();
  const { parseBilibiliLocatorFromUrl } = harness.testing;

  assert.deepEqual(plain(parseBilibiliLocatorFromUrl(PAGE_URL)), {
    bvid: BVID,
    aid: null,
    page: 1,
  });
  assert.deepEqual(
    plain(
      parseBilibiliLocatorFromUrl(
        `https://www.bilibili.com/video/${BVID}/?p=3&spm_id_from=333.788&t=95`,
      ),
    ),
    { bvid: BVID, aid: null, page: 3 },
  );
  assert.deepEqual(
    plain(parseBilibiliLocatorFromUrl("https://www.bilibili.com/video/av80433022/")),
    { bvid: null, aid: "80433022", page: 1 },
  );

  // Not supported / malformed
  assert.equal(
    parseBilibiliLocatorFromUrl("https://www.bilibili.com/bangumi/play/ss45990"),
    null,
  );
  assert.equal(
    parseBilibiliLocatorFromUrl("https://www.bilibili.com/video/BVbad/"),
    null,
  );
  assert.equal(
    parseBilibiliLocatorFromUrl(`https://www.bilibili.com/video/${BVID}/?p=0`),
    null,
  );
  assert.equal(
    parseBilibiliLocatorFromUrl("https://www.youtube.com/watch?v=abc"),
    null,
  );
});

// ------------------------------------------------------------
// MAIN bridge: whitelist, stale state, timeout, forgery
// ------------------------------------------------------------

test("MAIN bridge replies with only whitelisted metadata", () => {
  const harness = createMainWorldHarness({
    initialState: sampleInitialState(),
  });

  harness.fireMessage({
    source: harness.windowObject,
    origin: ORIGIN,
    data: { channel: "ytd-bilibili-v1", type: "read-state", requestId: "r1" },
  });

  assert.equal(harness.postedMessages.length, 1);
  const reply = plain(harness.postedMessages[0]);
  assert.equal(reply.targetOrigin, ORIGIN);
  assert.deepEqual(
    Object.keys(reply.data).sort(),
    [
      "aid",
      "available",
      "bvid",
      "channel",
      "channelName",
      "cidHint",
      "description",
      "duration",
      "page",
      "requestId",
      "stateMatched",
      "title",
      "type",
    ].sort(),
  );
  assert.equal(reply.data.requestId, "r1");
  assert.equal(reply.data.stateMatched, true);
  assert.equal(reply.data.cidHint, "137649199");
  assert.equal(reply.data.title, "Test Video Title");
  assert.equal(reply.data.channelName, "Test UP");
  assert.equal(reply.data.duration, 120);
  // The subtitle list and its signed URL must never cross the bridge.
  assert.equal(JSON.stringify(reply.data).includes("subtitle"), false);
  assert.equal(JSON.stringify(reply.data).includes("auth_key"), false);
});

test("MAIN bridge flags a stale __INITIAL_STATE__ as stateMatched=false", () => {
  const harness = createMainWorldHarness({
    url: `https://www.bilibili.com/video/${BVID_OTHER}/?p=2`,
    initialState: sampleInitialState(), // still describes BVID, page 1
  });

  harness.fireMessage({
    source: harness.windowObject,
    origin: ORIGIN,
    data: { channel: "ytd-bilibili-v1", type: "read-state", requestId: "r2" },
  });

  const reply = plain(harness.postedMessages[0]);
  assert.equal(reply.data.stateMatched, false);
  // A stale state must not lend its title or cid to the current video.
  assert.equal(reply.data.title, null);
  assert.equal(reply.data.cidHint, null);
  // URL identity is still reported so the caller can resolve via the API.
  assert.equal(reply.data.bvid, BVID_OTHER);
  assert.equal(reply.data.page, 2);
});

test("MAIN bridge ignores forged requests (wrong source/origin/shape)", () => {
  const harness = createMainWorldHarness({
    initialState: sampleInitialState(),
  });

  harness.fireMessage({
    source: {}, // not the window
    origin: ORIGIN,
    data: { channel: "ytd-bilibili-v1", type: "read-state", requestId: "x" },
  });
  harness.fireMessage({
    source: harness.windowObject,
    origin: "https://evil.example.com",
    data: { channel: "ytd-bilibili-v1", type: "read-state", requestId: "x" },
  });
  harness.fireMessage({
    source: harness.windowObject,
    origin: ORIGIN,
    data: { channel: "other-channel", type: "read-state", requestId: "x" },
  });
  harness.fireMessage({
    source: harness.windowObject,
    origin: ORIGIN,
    data: { channel: "ytd-bilibili-v1", type: "exec", requestId: "x" },
  });
  harness.fireMessage({
    source: harness.windowObject,
    origin: ORIGIN,
    data: { channel: "ytd-bilibili-v1", type: "read-state" }, // no requestId
  });

  assert.equal(harness.postedMessages.length, 0);
});

test("content bridge resolves null on timeout and ignores forged events", async () => {
  const harness = createBilibiliContentHarness();

  const promise = harness.testing.requestBilibiliMainState();
  assert.equal(harness.postedMessages.length, 1);
  assert.equal(harness.postedMessages[0].data.type, "read-state");
  assert.equal(harness.postedMessages[0].targetOrigin, ORIGIN);
  const requestId = harness.postedMessages[0].data.requestId;

  // Forged responses: wrong origin, wrong source, wrong requestId, wrong type.
  harness.fireBridgeMessage({
    source: harness.window,
    origin: "https://evil.example.com",
    data: { channel: "ytd-bilibili-v1", type: "state", requestId },
  });
  harness.fireBridgeMessage({
    source: {},
    origin: ORIGIN,
    data: { channel: "ytd-bilibili-v1", type: "state", requestId },
  });
  harness.fireBridgeMessage({
    source: harness.window,
    origin: ORIGIN,
    data: { channel: "ytd-bilibili-v1", type: "state", requestId: "other" },
  });
  harness.fireBridgeMessage({
    source: harness.window,
    origin: ORIGIN,
    data: { channel: "ytd-bilibili-v1", type: "read-state", requestId },
  });
  assert.equal(harness.testing.getBilibiliState().hasBridgePending, true);

  harness.flushTimeouts(); // fire the 2s timeout
  const result = await promise;
  assert.equal(result, null);
  assert.equal(harness.testing.getBilibiliState().hasBridgePending, false);
});

test("content bridge accepts a well-formed state answer and sanitizes it", async () => {
  const harness = createBilibiliContentHarness();

  const promise = harness.testing.requestBilibiliMainState();
  const requestId = harness.postedMessages[0].data.requestId;

  harness.fireBridgeMessage({
    source: harness.window,
    origin: ORIGIN,
    data: {
      channel: "ytd-bilibili-v1",
      type: "state",
      requestId,
      available: true,
      stateMatched: true,
      bvid: BVID,
      aid: "80433022",
      page: 1,
      cidHint: "137649199",
      title: "  Padded title  ",
      channelName: "UP name",
      description: "desc",
      duration: 120,
      // Anything outside the whitelist is dropped by the sanitizer:
      subtitleUrl: "https://evil.example.com/x?auth_key=leak",
      cookie: "SESSDATA=stolen",
      nested: { evil: true },
    },
  });

  const state = plain(await promise);
  assert.equal(state.available, true);
  assert.equal(state.bvid, BVID);
  assert.equal(state.cidHint, "137649199");
  assert.equal(state.title, "Padded title");
  assert.deepEqual(Object.keys(state).sort(), [
    "aid",
    "available",
    "bvid",
    "channelName",
    "cidHint",
    "description",
    "duration",
    "page",
    "stateMatched",
    "title",
  ]);
  assert.equal(harness.testing.getBilibiliState().hasBridgePending, false);
});

test("getBilibiliPageInfo falls back to URL+DOM when MAIN state is stale", async () => {
  const harness = createBilibiliContentHarness();
  const titleEl = new FakeElement("h1");
  titleEl.textContent = "DOM Title";
  const upEl = new FakeElement("span");
  upEl.textContent = "DOM UP";
  harness.selectorMap.set("#viewbox_report h1.video-title, h1.video-title", titleEl);
  harness.selectorMap.set(
    ".up-info-container .up-name, .up-detail-top .up-name, .up-name",
    upEl,
  );

  const promise = harness.testing.getBilibiliPageInfo();
  const requestId = harness.postedMessages[0].data.requestId;
  harness.fireBridgeMessage({
    source: harness.window,
    origin: ORIGIN,
    data: {
      channel: "ytd-bilibili-v1",
      type: "state",
      requestId,
      available: true,
      stateMatched: false, // stale SPA state
      bvid: BVID_OTHER,
      aid: "999",
      page: 9,
      cidHint: "999999",
      title: "Stale Title",
      channelName: "Stale UP",
      description: null,
      duration: null,
    },
  });

  const info = plain(await promise);
  assert.equal(info.success, true);
  // Wire shape: null fields are OMITTED (the background validator rejects
  // explicit nulls as INVALID_REQUEST) — no aid, and a stale cid must not
  // become the hint.
  assert.deepEqual(info.locator, { bvid: BVID, page: 1 });
  assert.equal("aid" in info.locator, false);
  assert.equal("cidHint" in info.locator, false);
  assert.equal(info.title, "DOM Title");
  assert.equal(info.channelName, "DOM UP");
  assert.equal(info.stateMatched, false);
});

// ------------------------------------------------------------
// Button injection: idempotent, container rebuilds, local observer
// ------------------------------------------------------------

test("Bilibili button injection is idempotent and singular", () => {
  const harness = createBilibiliContentHarness();
  const host = new FakeElement("div");
  harness.selectorMap.set("#arc_toolbar_report .video-toolbar-left-main", host);

  assert.equal(harness.testing.injectBilibiliButton(), true);
  assert.equal(harness.testing.injectBilibiliButton(), true);

  const buttons = harness.createdElements.filter(
    (element) =>
      element.id === "ytd-bilibili-digest-button" && element.isConnected,
  );
  assert.equal(buttons.length, 1);
  assert.equal(host.children.length, 1);
  assert.equal(host.children[0], buttons[0]);
});

test("button falls back to #viewbox_report when the toolbar is absent", () => {
  const harness = createBilibiliContentHarness();
  const viewbox = new FakeElement("div");
  harness.selectorMap.set("#viewbox_report", viewbox);

  assert.equal(harness.testing.injectBilibiliButton(), true);
  const button = harness.createdElements.find(
    (element) => element.id === "ytd-bilibili-digest-button",
  );
  assert.equal(button.parentElement, viewbox);
});

test("local observer re-injects the button after the toolbar is rebuilt", () => {
  const harness = createBilibiliContentHarness();
  const leftColumn = new FakeElement("div");
  harness.selectorMap.set(".left-container", leftColumn);
  const oldHost = new FakeElement("div");
  harness.selectorMap.set("#arc_toolbar_report .video-toolbar-left-main", oldHost);

  harness.testing.injectBilibiliButton();
  harness.testing.setupBilibiliButtonObserver();
  const buttonObserver = harness.observers.at(-1);
  assert.equal(buttonObserver.observing.target, leftColumn);
  assert.equal(buttonObserver.observing.options.subtree, true);
  const button = harness.createdElements.find(
    (element) => element.id === "ytd-bilibili-digest-button",
  );
  assert.equal(button.parentElement, oldHost);

  // Bilibili rebuilds the toolbar: the old host is gone, a new one appears.
  oldHost.remove();
  const newHost = new FakeElement("div");
  harness.selectorMap.set("#arc_toolbar_report .video-toolbar-left-main", newHost);
  buttonObserver.trigger();

  assert.equal(button.parentElement, newHost);
  assert.equal(newHost.children.length, 1);
  assert.equal(
    harness.createdElements.filter(
      (element) =>
        element.id === "ytd-bilibili-digest-button" && element.isConnected,
    ).length,
    1,
  );
});

test("clicking the button fires bilibiliOpenSidePanel synchronously", () => {
  const harness = createBilibiliContentHarness();
  const host = new FakeElement("div");
  harness.selectorMap.set("#arc_toolbar_report .video-toolbar-left-main", host);

  harness.testing.injectBilibiliButton();
  const button = harness.createdElements.find(
    (element) => element.id === "ytd-bilibili-digest-button",
  );
  button.click();

  const openMessages = harness.sentMessages.filter(
    (message) => message.action === "bilibiliOpenSidePanel",
  );
  assert.equal(openMessages.length, 1);
  assert.equal(typeof openMessages[0].requestId, "string");
});

// ------------------------------------------------------------
// SPA navigation: fingerprint polling + popstate
// ------------------------------------------------------------

test("fingerprint polling detects part changes and BV changes", () => {
  const harness = createBilibiliContentHarness();
  const host = new FakeElement("div");
  harness.selectorMap.set("#arc_toolbar_report .video-toolbar-left-main", host);
  harness.testing.initBilibili();

  // Same URL tick: no notification.
  harness.tickIntervals();
  assert.equal(
    harness.sentMessages.filter((m) => m.action === "bilibiliVideoChanged")
      .length,
    0,
  );

  // Change part (?p=2) — no reload, just a new URL.
  harness.setUrl(`https://www.bilibili.com/video/${BVID}/?p=2`);
  harness.tickIntervals();
  let changed = harness.sentMessages.filter(
    (m) => m.action === "bilibiliVideoChanged",
  );
  assert.equal(changed.length, 1);
  // Wire shape omits the null twin — {bvid, page}, never aid: null.
  assert.deepEqual(plain(changed[0].locator), { bvid: BVID, page: 2 });
  assert.equal("aid" in changed[0].locator, false);

  // Change video entirely.
  harness.setUrl(`https://www.bilibili.com/video/${BVID_OTHER}/?p=1`);
  harness.tickIntervals();
  changed = harness.sentMessages.filter(
    (m) => m.action === "bilibiliVideoChanged",
  );
  assert.equal(changed.length, 2);
  assert.deepEqual(plain(changed[1].locator), { bvid: BVID_OTHER, page: 1 });

  // Non-identity noise (?t=) is not a navigation.
  harness.setUrl(`https://www.bilibili.com/video/${BVID_OTHER}/?t=42`);
  harness.tickIntervals();
  assert.equal(
    harness.sentMessages.filter((m) => m.action === "bilibiliVideoChanged")
      .length,
    2,
  );
});

test("popstate triggers the same fingerprint check (back/forward)", () => {
  const harness = createBilibiliContentHarness();
  const host = new FakeElement("div");
  harness.selectorMap.set("#arc_toolbar_report .video-toolbar-left-main", host);
  harness.testing.initBilibili();

  // Simulate browser Back: the URL changed before popstate fired.
  harness.setUrl(`https://www.bilibili.com/video/${BVID}/?p=2`);
  harness.firePopstate();

  const changed = harness.sentMessages.filter(
    (m) => m.action === "bilibiliVideoChanged",
  );
  assert.equal(changed.length, 1);
  assert.equal(changed[0].locator.page, 2);
});

test("leaving the video page cleans up button, timers, and observers", () => {
  const harness = createBilibiliContentHarness();
  const host = new FakeElement("div");
  const leftColumn = new FakeElement("div");
  harness.selectorMap.set("#arc_toolbar_report .video-toolbar-left-main", host);
  harness.selectorMap.set(".left-container", leftColumn);
  // init() already ran at script load (before the toolbar existed), so the
  // tracker is active but the button and observer still need their hosts.
  harness.testing.injectBilibiliButton();
  harness.testing.setupBilibiliButtonObserver();

  assert.equal(harness.testing.getBilibiliState().active, true);
  assert.equal(harness.testing.getBilibiliState().hasFingerprintTimer, true);
  assert.equal(harness.testing.getBilibiliState().hasButtonObserver, true);
  assert.equal(
    harness.createdElements.filter(
      (element) =>
        element.id === "ytd-bilibili-digest-button" && element.isConnected,
    ).length,
    1,
  );

  // SPA navigation to a non-video page (no reload).
  harness.setUrl("https://www.bilibili.com/");
  harness.tickIntervals();

  const state = harness.testing.getBilibiliState();
  assert.equal(state.active, false);
  assert.equal(state.hasFingerprintTimer, false);
  assert.equal(state.hasButtonObserver, false);
  assert.equal(state.lastFingerprint, null);
  assert.equal(
    harness.createdElements.filter(
      (element) =>
        element.id === "ytd-bilibili-digest-button" && element.isConnected,
    ).length,
    0,
  );
  assert.equal(harness.intervalCount, 0);

  // Coming back via popstate revives tracking.
  harness.setUrl(`https://www.bilibili.com/video/${BVID}/?p=1`);
  harness.firePopstate();
  assert.equal(harness.testing.getBilibiliState().active, true);
  assert.equal(harness.testing.getBilibiliState().hasFingerprintTimer, true);
});

// ------------------------------------------------------------
// Player hydration, current time, seek validation
// ------------------------------------------------------------

test("player hydration wait resolves when the video element appears", () => {
  const harness = createBilibiliContentHarness();
  const playerHost = new FakeElement("div");
  harness.selectorMap.set("#bilibili-player", playerHost);

  let resolvedWith = null;
  harness.testing.waitForBilibiliPlayerVideo((video) => {
    resolvedWith = video;
  });
  assert.equal(resolvedWith, null);
  const playerObserver = harness.observers.at(-1);
  assert.equal(playerObserver.observing.target, playerHost);

  // The player hydrates: <video> appears inside #bilibili-player.
  const videoEl = { currentTime: 12, duration: 300, paused: true };
  harness.selectorMap.set("#bilibili-player video", videoEl);
  playerObserver.trigger();

  assert.equal(resolvedWith, videoEl);
  assert.equal(
    harness.testing.getBilibiliState().hasPlayerObserver,
    false,
  );
});

test("seek validates identity, seconds, and reports PLAYER_NOT_READY honestly", () => {
  const harness = createBilibiliContentHarness();
  const responses = [];
  const sendResponse = (value) => responses.push(value);

  // Wrong part: the note belongs to P2 but the page shows P1.
  const syncResult = harness.testing.handleBilibiliSeekTo(
    {
      video: { bvid: BVID, aid: "80433022", page: 2 },
      seconds: 30,
    },
    sendResponse,
  );
  assert.equal(syncResult, false);
  assert.equal(responses[0].success, false);
  assert.equal(responses[0].error.code, "STALE_CONTEXT");

  // Malformed seconds.
  harness.testing.handleBilibiliSeekTo(
    { video: { bvid: BVID, aid: "80433022", page: 1 }, seconds: -5 },
    sendResponse,
  );
  assert.equal(responses[1].error.code, "INVALID_REQUEST");

  // Player not hydrated yet: the answer is deferred, then PLAYER_NOT_READY
  // after the bounded wait — never a fake success or a fake 0s.
  const asyncResult = harness.testing.handleBilibiliSeekTo(
    { video: { bvid: BVID, aid: "80433022", page: 1 }, seconds: 30 },
    sendResponse,
  );
  assert.equal(asyncResult, true);
  assert.equal(responses.length, 2);
  harness.flushTimeouts();
  assert.equal(responses.length, 3);
  assert.equal(responses[2].success, false);
  assert.equal(responses[2].error.code, "PLAYER_NOT_READY");
});

test("seek applies to the hydrated player and clamps to its duration", () => {
  const harness = createBilibiliContentHarness();
  const calls = [];
  const videoEl = {
    currentTime: 0,
    duration: 100,
    paused: true,
    play() {
      calls.push("play");
      return Promise.resolve();
    },
  };
  harness.selectorMap.set("#bilibili-player video", videoEl);

  const responses = [];
  const syncResult = harness.testing.handleBilibiliSeekTo(
    { video: { bvid: BVID, aid: "80433022", page: 1 }, seconds: 150 },
    (value) => responses.push(value),
  );

  assert.equal(syncResult, false);
  assert.deepEqual(plain(responses), [{ success: true }]);
  assert.equal(videoEl.currentTime, 100); // clamped to duration
  assert.deepEqual(calls, ["play"]);
});

test("a seek waiting for hydration answers STALE_CONTEXT after a part switch", () => {
  const harness = createBilibiliContentHarness();
  const playerHost = new FakeElement("div");
  harness.selectorMap.set("#bilibili-player", playerHost);

  // P1 asks to seek while the player has not hydrated yet → deferred answer.
  const responses = [];
  const asyncMode = harness.testing.handleBilibiliSeekTo(
    { video: { bvid: BVID, aid: "80433022", page: 1 }, seconds: 30 },
    (value) => responses.push(value),
  );
  assert.equal(asyncMode, true);
  assert.equal(responses.length, 0);
  const waitObserver = harness.observers.at(-1);
  assert.equal(waitObserver.observing.target, playerHost);

  // The user switches to P2 while we wait: navigation settles the old wait.
  harness.setUrl(`https://www.bilibili.com/video/${BVID}/?p=2`);
  harness.testing.bilibiliFingerprintTick();
  assert.equal(responses.length, 1);
  assert.equal(responses[0].success, false);
  assert.equal(responses[0].error.code, "STALE_CONTEXT");
  assert.equal(waitObserver.disconnected, true);

  // P2's player now hydrates. The stale wait must not seek it, must not
  // answer twice — even if its long-dead observer somehow fired again.
  const videoElP2 = {
    currentTime: 0,
    duration: 300,
    paused: true,
    play() {
      return Promise.resolve();
    },
  };
  harness.selectorMap.set("#bilibili-player video", videoElP2);
  waitObserver.trigger();
  harness.flushTimeouts();
  assert.equal(videoElP2.currentTime, 0);
  assert.equal(responses.length, 1);
});

test("an av-address navigation broadcasts {aid, page} without the null twin", () => {
  const harness = createBilibiliContentHarness({
    url: "https://www.bilibili.com/video/av80433022/?p=1",
  });
  harness.setUrl("https://www.bilibili.com/video/av80433022/?p=2");
  harness.tickIntervals();

  const changed = harness.sentMessages.filter(
    (m) => m.action === "bilibiliVideoChanged",
  );
  assert.equal(changed.length, 1);
  assert.deepEqual(plain(changed[0].locator), { aid: "80433022", page: 2 });
  assert.equal("bvid" in changed[0].locator, false);
});

test("getCurrentTime validates identity and reports PLAYER_NOT_READY", () => {
  const harness = createBilibiliContentHarness();

  // Player missing → honest error, not a fake 0.
  let response = harness.testing.handleBilibiliGetCurrentTime({
    video: { bvid: BVID, aid: "80433022", page: 1 },
  });
  assert.equal(response.success, false);
  assert.equal(response.error.code, "PLAYER_NOT_READY");

  // Wrong BV → stale context.
  response = harness.testing.handleBilibiliGetCurrentTime({
    video: { bvid: BVID_OTHER, aid: "1", page: 1 },
  });
  assert.equal(response.error.code, "STALE_CONTEXT");

  harness.selectorMap.set("#bilibili-player video", {
    currentTime: 61.4,
    paused: false,
  });
  response = harness.testing.handleBilibiliGetCurrentTime({
    video: { bvid: BVID, aid: "80433022", page: 1 },
  });
  assert.deepEqual(plain(response), {
    success: true,
    currentTime: 61.4,
    paused: false,
  });
});

test("runtime listener routes bilibili actions with correct sync/async modes", async () => {
  const harness = createBilibiliContentHarness();
  const listener = harness.runtimeListener;
  assert.equal(typeof listener, "function");

  // bilibiliGetPageInfo is async (bridge wait).
  const infoPromise = new Promise((resolve) => {
    const mode = listener(
      { action: "bilibiliGetPageInfo" },
      null,
      resolve,
    );
    assert.equal(mode, true);
  });
  const requestId = harness.postedMessages[0].data.requestId;
  harness.fireBridgeMessage({
    source: harness.window,
    origin: ORIGIN,
    data: {
      channel: "ytd-bilibili-v1",
      type: "state",
      requestId,
      available: false,
      stateMatched: false,
      bvid: BVID,
      aid: null,
      page: 1,
      cidHint: null,
      title: null,
      channelName: null,
      description: null,
      duration: null,
    },
  });
  const info = plain(await infoPromise);
  assert.equal(info.success, true);
  assert.equal(info.locator.bvid, BVID);

  // bilibiliGetCurrentTime answers synchronously.
  const timeResult = listener(
    {
      action: "bilibiliGetCurrentTime",
      video: { bvid: BVID, aid: "80433022", page: 1 },
    },
    null,
    () => {},
  );
  assert.equal(timeResult, false);
});

test("MAIN world only exports whitelisted state through the testing hook too", () => {
  const harness = createMainWorldHarness({
    initialState: sampleInitialState(),
  });
  const payload = plain(
    harness.testing.buildWhitelistedState(sampleInitialState(), PAGE_URL),
  );
  assert.equal("subtitle" in payload, false);
  assert.equal("videoData" in payload, false);
  assert.equal(payload.stateMatched, true);

  // Out-of-range page: no cid borrowed from the first part.
  const outOfRange = plain(
    harness.testing.buildWhitelistedState(
      sampleInitialState(),
      `https://www.bilibili.com/video/${BVID}/?p=7`,
    ),
  );
  // p=7 parses as a locator, but pages[] has no entry 7: cidHint must be null.
  assert.equal(outOfRange.cidHint, null);
});
