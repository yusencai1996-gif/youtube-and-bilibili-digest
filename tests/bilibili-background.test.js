const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "background.js"), "utf8");
const bvid = "BV1MU411S7iJ";
const locator = { bvid, page: 2 };
const view = { bvid, aid: 123, title: "Video", owner: { mid: 88, name: "UP" },
  pages: [{ page: 1, cid: 111, duration: 90 }, { page: 2, cid: 222, duration: 120 }] };
const nav = { isLogin: true, wbi_img: { img_url: `https://i.example/${"a".repeat(32)}.png`, sub_url: `https://i.example/${"b".repeat(32)}.png` } };
const tracks = (lan = "en", url = "https://x.hdslb.com/222.json?auth_key=ephemeral") => ({ subtitle: { subtitles: [{ lan, id_str: "12345678901234567890", subtitle_url: url }] } });
const bcc = { body: [{ from: 1.2, to: 4.6, content: "Hello" }] };
const envelope = (data) => ({ code: 0, data });
const reply = (body, status = 200, extra = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, ...extra });
function harness(responses = [], session = {}) {
  let now = 1000000;
  let timerId = 0;
  const timers = new Map();
  const events = {}, calls = [], broadcasts = [], opens = [], relays = [];
  const local = {};
  const tab = { id: 1, windowId: 10, url: `https://www.bilibili.com/video/${bvid}/?p=2`, active: true };
  const event = (name) => ({ addListener(fn) { events[name] = fn; } });
  const store = (data) => ({ setAccessLevel: async () => {}, get: async (key) => ({ [key]: data[key] }), set: async (values) => Object.assign(data, values) });
  const chrome = {
    runtime: { id: "test", onMessage: event("message"), onInstalled: event("install"), getURL: (file) => `chrome-extension://test/${file}`,
      sendMessage: async (message) => { broadcasts.push(message); }, openOptionsPage() {} },
    storage: { local: store(local), session: store(session) },
    action: { onClicked: event("click") },
    sidePanel: { setPanelBehavior() {}, setOptions: async () => {}, open: (args) => { opens.push(args); return Promise.resolve(); } },
    tabs: { onUpdated: event("updated"), onActivated: event("activated"), get: async () => tab,
      query: async () => tab.active ? [tab] : [], sendMessage: async (...args) => { relays.push(args); return { success: true, currentTime: 3, paused: false }; } },
  };
  const sandbox = { console, URL, TextEncoder, TextDecoder, AbortController, importScripts() {}, chrome,
    YTD_SETTINGS: { STORAGE_KEY: "settings", normalizeSettings: () => ({}) },
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, ms) {
      const id = ++timerId; timers.set(id, { fn, ms });
      if (ms < 15000) queueMicrotask(() => { if (timers.delete(id)) { now += ms; fn(); } });
      return id;
    }, clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options) => {
      calls.push({ url, options, at: now });
      assert.ok(!url.includes("supadata"), "Bilibili must never call Supadata");
      const next = responses.shift();
      if (typeof next === "function") return next(url, options);
      assert.ok(next, `Unexpected fetch: ${new URL(url).pathname}`);
      return next;
    },
  };
  vm.runInNewContext(source, sandbox);
  const h = sandbox.__YTD_BILIBILI_TESTING__;
  const sender = { id: "test", url: "chrome-extension://test/sidepanel.html" };
  const send = async (action, fields = {}, from = sender) => {
    const message = { action, requestId: "request", tabId: 1, ...fields };
    try { return await h.handleBilibiliMessage(message, from); }
    catch (error) { return h.bilibiliFailure(message.requestId, error); }
  };
  return { h, send, calls, tab, chrome, events, broadcasts, opens, relays, local, session, responses,
    content: () => ({ id: "test", tab: { ...tab }, frameId: 0, url: tab.url }),
    tick(ms) { now += ms; }, fire(ms) { for (const [id, timer] of timers) if (timer.ms === ms) { timers.delete(id); timer.fn(); } },
    video: h.bilibiliVideoFromView(locator, view),
  };
}
const chain = (trackData = tracks(), tail = reply(bcc)) => [reply(envelope(view)), reply(envelope(nav)), reply(envelope(trackData)), tail];
const fetchVideo = (ctx, fields = {}) => ctx.send("fetchBilibiliTranscript", { video: ctx.video, ...fields });

// Regression fixtures captured from startBilibiliDigest in sidepanel.js and
// handleBilibiliNavigation in content.js (2026-09-16): both send
// { bvid: locator.bvid, aid: locator.aid, page: locator.page }, including null.
// Keep these legacy wire shapes even after senders start omitting absent IDs.
const frontendLocators = [
  { name: "BV", locator: { bvid: "BV1MU411S7iJ", aid: null, page: 2 }, aid: 123, cid: "222" },
  { name: "av", locator: { bvid: null, aid: "170001", page: 1 }, aid: 170001, cid: "111" },
];
for (const fixture of frontendLocators) {
  for (const shape of ["null", "omitted"]) {
    const wireLocator = shape === "null" ? fixture.locator :
      Object.fromEntries(Object.entries(fixture.locator).filter(([, value]) => value !== null));
    const tabUrl = `https://www.bilibili.com/video/${fixture.locator.bvid || `av${fixture.locator.aid}`}/?p=${fixture.locator.page}`;
    test(`frontend ${fixture.name} ${shape} locator resolves through background handler`, async () => {
      const c = harness([reply(envelope({ ...view, aid: fixture.aid }))]);
      c.tab.url = tabUrl;
      const result = await c.send("resolveBilibiliVideo", { locator: wireLocator });
      assert.equal(result.success, true);
      assert.equal(result.requestId, "request");
      assert.equal(result.video.bvid, bvid);
      assert.equal(result.video.aid, String(fixture.aid));
      assert.equal(result.video.page, fixture.locator.page);
      assert.equal(result.video.cid, fixture.cid);
      assert.equal(c.calls.length, 1);
      const url = new URL(c.calls[0].url);
      assert.equal(url.pathname, "/x/web-interface/view");
      assert.equal(url.searchParams.get(fixture.name === "BV" ? "bvid" : "aid"),
        fixture.locator.bvid || fixture.locator.aid);
    });
    test(`frontend ${fixture.name} ${shape} navigation locator reaches background handler`, async () => {
      const c = harness();
      c.tab.url = tabUrl;
      const result = await c.send("bilibiliVideoChanged", { locator: wireLocator }, c.content());
      assert.equal(result.success, true);
      assert.equal(result.requestId, "request");
      assert.equal(c.calls.length, 0);
    });
  }
}
for (const action of ["resolveBilibiliVideo", "bilibiliVideoChanged"]) {
  test(`${action} rejects absent IDs and malformed supplied IDs before fetching`, async () => {
    const invalidLocators = [
      ...[null, undefined].flatMap((bvid) => [null, undefined].map((aid) => ({ bvid, aid, page: 1 }))),
      { page: 1 },
      ...["", "BVbad", false, 123].map((bvid) => ({ bvid, aid: "170001", page: 1 })),
      ...["", "0", "-1", "1.5", 0, -1, 1.5, false, Number.MAX_SAFE_INTEGER + 1]
        .map((aid) => ({ bvid, aid, page: 2 })),
    ];
    for (const invalidLocator of invalidLocators) {
      const c = harness();
      const fields = { locator: invalidLocator };
      const result = action === "bilibiliVideoChanged" ?
        await c.send(action, fields, c.content()) : await c.send(action, fields);
      assert.equal(result.success, false);
      assert.equal(result.error.code, "INVALID_REQUEST");
      assert.equal(c.calls.length, 0);
    }
  });
}
test("four-step CC chain, credentials, global spacing and no URL in results/storage", async () => {
  const c = harness(chain());
  const resolved = await c.send("resolveBilibiliVideo", { locator });
  assert.equal(resolved.video.cid, "222");
  const result = await fetchVideo(c);
  assert.equal(result.status, "ready"); assert.equal(result.source, "cc");
  assert.equal(result.transcript[0].start, 1.2);
  assert.deepEqual(c.calls.map((call) => new URL(call.url).pathname), ["/x/web-interface/view", "/x/web-interface/nav", "/x/player/wbi/v2", "/222.json"]);
  c.calls.slice(1).forEach((call, i) => assert.ok(call.at - c.calls[i].at >= 1200));
  c.calls.slice(0, 3).forEach((call) => assert.equal(call.options.credentials, "include"));
  assert.equal(c.calls[3].options.credentials, "omit");
  c.calls.forEach((call) => assert.equal(call.options.redirect, "error"));
  assert.doesNotMatch(JSON.stringify([result, c.local, c.session]), /auth_key|hdslb/);
});
test("AI track retains true original language", async () => {
  const c = harness(chain(tracks("ai-en")));
  const result = await fetchVideo(c);
  assert.equal(result.source, "ai"); assert.equal(result.language, "en"); assert.equal(result.originalAvailable, true);
});
test("manual CC hash URL downloads without cid and still forbids redirects", async () => {
  const url = "https://i0.hdslb.com/bfs/subtitle/d481a7f8c5e2c1e8.json";
  const c = harness(chain(tracks("zh-CN", url)));
  const result = await fetchVideo(c);
  assert.equal(result.status, "ready"); assert.equal(result.source, "cc");
  assert.equal(result.transcript[0].text, "Hello"); assert.equal(c.calls[3].url, url);
  assert.equal(c.calls[3].options.redirect, "error"); assert.equal(c.calls[3].options.credentials, "omit");
  const d = harness(chain(tracks("zh-CN", url), () => { throw new TypeError("redirect refused"); }));
  assert.equal((await fetchVideo(d)).error.code, "NETWORK_ERROR"); assert.equal(d.calls.length, 4);
  assert.equal(d.calls[3].options.redirect, "error");
});
test("AI tracks missing or mismatching cid never download, for either AI indicator", async () => {
  for (const [lan, prefix] of [["ai-en", "subtitle"], ["en", "ai_subtitle"]]) {
    for (const filename of ["hash", "999"]) {
      const c = harness(chain(tracks(lan, `https://i0.hdslb.com/bfs/${prefix}/${filename}.json?cid=222`), reply(envelope({ code: -1 }))));
      assert.equal((await fetchVideo(c)).status, "no-subtitle");
      assert.ok(c.calls.every((call) => !call.url.includes("hdslb")));
    }
  }
});
test("text-only blocked BCC reports video unavailable; empty BCC falls back to no-subtitle", async () => {
  const c = harness(chain(tracks(), reply({ body: [{ content: "【稿件无法观看】" }] })));
  const result = await fetchVideo(c);
  assert.equal(result.success, false); assert.equal(result.error.code, "VIDEO_UNAVAILABLE");
  assert.equal(result.error.message, "视频不可访问或无权限"); assert.equal(c.calls.length, 4);
  const d = harness([...chain(tracks(), reply({ body: [] })), reply(envelope({ code: -1 }))]);
  assert.equal((await fetchVideo(d)).status, "no-subtitle"); assert.equal(d.calls.length, 5);
});
test("nav confirms logged-out state without conclusion request", async () => {
  for (const body of [envelope({ isLogin: false }), { code: -101 }]) {
    const c = harness([reply(envelope(view)), reply(body)]);
    const result = await fetchVideo(c);
    assert.equal(result.status, "login-required"); assert.equal(c.calls.length, 2);
  }
});
test("logged-in empty tracks fall back to ASR, with owner and cid", async () => {
  const c = harness(chain({ subtitle: { subtitles: [] }, need_login_subtitle: true }, reply(envelope({ code: 0, model_result: { subtitle: [{ part_subtitle: [{ content: "转写", start_timestamp: 0.5, end_timestamp: 5.1 }] }] } }))));
  const result = await fetchVideo(c);
  assert.equal(result.source, "conclusion"); assert.equal(result.language, "zh-CN"); assert.equal(result.originalAvailable, false);
  const url = new URL(c.calls[3].url);
  assert.equal(url.pathname, "/x/web-interface/view/conclusion/get"); assert.equal(url.searchParams.get("up_mid"), "88"); assert.equal(url.searchParams.get("cid"), "222");
});
for (const data of [{ code: -1 }, { code: 1 }, { code: 0, model_result: { subtitle: [] } }, { code: 0, model_result: { summary: "not a transcript" } }]) {
  test(`ASR empty/summary is no-subtitle: ${JSON.stringify(data)}`, async () => {
    const c = harness(chain({ subtitle: { subtitles: [] } }, reply(envelope(data))));
    assert.equal((await fetchVideo(c)).status, "no-subtitle"); assert.equal(c.calls.length, 4);
  });
}
test("conclusion -101 means login-required", async () => {
  const c = harness(chain({ subtitle: { subtitles: [] } }, reply({ code: -101 })));
  assert.equal((await fetchVideo(c)).status, "login-required");
});
const conclusionEmptyResponses = [
  { code: -1 }, { code: 1 }, envelope({ code: -1 }), envelope({ code: 1 }),
  envelope({ code: 0, model_result: { subtitle: [] } }),
  envelope({ code: 0, model_result: { subtitle: [{ part_subtitle: [] }] } }),
  envelope({ code: 0, model_result: { subtitle: [{ part_subtitle: [
    { content: " ", start_timestamp: 0, end_timestamp: 1 },
  ] }] } }),
  envelope({ code: 0, model_result: { summary: "only summary" } }),
];
for (const [index, body] of conclusionEmptyResponses.entries()) {
  test(`conclusion explicit empty ${index} overrides rejected URLs without pending warning`, async () => {
    for (const url of ["https://evil.example/222.json", "https://x.hdslb.com/999.json"]) {
      const c = harness(chain(tracks("en", url), reply(body)));
      const result = await fetchVideo(c);
      assert.equal(result.success, true);
      assert.equal(result.status, "no-subtitle");
      assert.equal(result.warnings.length, 0);
      assert.equal(c.calls.length, 4);
      assert.equal(new URL(c.calls[3].url).pathname, "/x/web-interface/view/conclusion/get");
      assert.ok(c.calls.every((call) => new URL(call.url).hostname === "api.bilibili.com"));
    }
  });
}
for (const subtitle_url of ["", null, undefined]) {
  test(`pending URL ${String(subtitle_url)} reaches conclusion and warns only on no-subtitle`, async () => {
    const c = harness(chain(tracks("zh-CN", subtitle_url), reply({ code: -1 })));
    // Explicit undefined represents a missing field, not the tracks helper default.
    c.responses[2] = reply(envelope({ subtitle: { subtitles: [{ lan: "zh-CN", subtitle_url }] } }));
    const result = await fetchVideo(c);
    assert.equal(result.status, "no-subtitle");
    assert.equal(JSON.stringify(result.warnings), '["SUBTITLE_PENDING"]');
    assert.equal(c.calls.length, 4);
    assert.equal(new URL(c.calls[3].url).pathname, "/x/web-interface/view/conclusion/get");
  });
}
test("pending track allows successful ASR or another ready CC track without pending warning", async () => {
  const asr = envelope({ code: 0, model_result: { subtitle: [{ part_subtitle: [
    { content: "转写", start_timestamp: 0, end_timestamp: 2 },
  ] }] } });
  const c = harness(chain(tracks("zh-CN", ""), reply(asr)));
  const result = await fetchVideo(c);
  assert.equal(result.status, "ready"); assert.equal(result.source, "conclusion");
  assert.equal(result.warnings.length, 0); assert.equal(c.calls.length, 4);
  const mixed = tracks(); mixed.subtitle.subtitles.unshift({ lan: "zh-CN", subtitle_url: null });
  const d = harness(chain(mixed));
  const cc = await fetchVideo(d);
  assert.equal(cc.status, "ready"); assert.equal(cc.source, "cc"); assert.equal(cc.warnings.length, 0);
});
test("rejected or pending URL preserves conclusion technical failures and login-required", async () => {
  for (const url of ["https://x.hdslb.com/999.json", ""]) {
    for (const [response, code] of [
      [() => { throw new TypeError("network"); }, "NETWORK_ERROR"],
      [reply({ code: 0, data: {} }), "INVALID_RESPONSE"],
      [reply(envelope({ code: 0, model_result: { subtitle: [{}] } })), "INVALID_RESPONSE"],
      [reply({}, 429), "RATE_LIMITED"],
      [reply({ code: -101 }), "login-required"],
    ]) {
      const c = harness(chain(tracks("en", url), response));
      const result = await fetchVideo(c);
      if (code === "login-required") {
        assert.equal(result.status, code); assert.equal(result.warnings.length, 0);
      } else {
        assert.equal(result.success, false); assert.equal(result.error.code, code);
      }
      assert.equal(c.calls.length, 4);
    }
  }
});
test("outer empty codes on player and view remain technical failures", async () => {
  for (const code of [-1, 1]) {
    const c = harness([reply({ code })]);
    assert.equal((await fetchVideo(c)).error.code, "INVALID_RESPONSE");
    const d = harness([reply(envelope(view)), reply(envelope(nav)), reply({ code })]);
    assert.equal((await fetchVideo(d)).error.code, "INVALID_RESPONSE");
    assert.equal(d.calls.length, 3);
  }
});
for (const [response, code] of [[reply({ code: -404 }), "VIDEO_UNAVAILABLE"], ...[401, 403, 404].map((status) => [reply({}, status), "VIDEO_UNAVAILABLE"]), [reply({ nonsense: true }), "INVALID_RESPONSE"]]) {
  test(`view ${code} stays technical failure`, async () => {
    const c = harness([response]); assert.equal((await fetchVideo(c)).error.code, code); assert.equal(c.calls.length, 1);
  });
}
for (const risk of [reply({}, 412), reply({}, 429), reply({ code: -352 }), reply({ code: 0, data: { v_voucher: "risk" } })]) {
  test(`risk ${risk.status} immediately stops chain and persists cooldown`, async () => {
    const c = harness([reply(envelope(view)), reply(envelope(nav)), risk]);
    assert.equal((await fetchVideo(c)).error.code, "RATE_LIMITED");
    assert.equal(c.calls.length, 3); assert.ok(c.session.bilibiliCooldownUntil > 1000000);
    assert.equal((await fetchVideo(c, { forceRefresh: true })).error.code, "RATE_LIMITED"); assert.equal(c.calls.length, 3);
    const restarted = harness([], c.session);
    assert.equal((await fetchVideo(restarted)).error.code, "RATE_LIMITED"); assert.equal(restarted.calls.length, 0);
  });
}
test("Retry-After longer than 60 seconds is honored", async () => {
  const c = harness([reply({}, 429, { headers: { get: () => "180" } })]);
  assert.ok((await fetchVideo(c)).error.retryAfterMs >= 180000);
});
for (const status of [401, 403, 404]) {
test(`subtitle ${status} refreshes list once, downloads fresh URL, then stops`, async () => {
  const c = harness([...chain(tracks(), reply({}, status)), reply(envelope(tracks("en", "https://x.hdslb.com/222.json?auth_key=new"))), reply(bcc)]);
  assert.equal((await fetchVideo(c)).status, "ready"); assert.equal(c.calls.length, 6);
  assert.notEqual(c.calls[3].url, c.calls[5].url);
  assert.equal(new URL(c.calls[4].url).pathname, "/x/player/wbi/v2");
  const d = harness([...chain(tracks(), reply({}, status)), reply(envelope(tracks())), reply({}, status)]);
  const result = await fetchVideo(d);
  assert.equal(result.error.code, "NETWORK_ERROR"); assert.equal(result.error.retryable, true); assert.equal(d.calls.length, 6);
});
}
test("signature expiry refreshes nav once; second expiry stops", async () => {
  const c = harness([reply(envelope(view)), reply(envelope(nav)), reply({ code: -403, message: "WBI signature expired" }), reply(envelope(nav)), reply(envelope(tracks())), reply(bcc)]);
  assert.equal((await fetchVideo(c)).status, "ready"); assert.equal(c.calls.length, 6);
  const d = harness([reply(envelope(view)), reply(envelope(nav)), reply({ code: -403, message: "WBI signature expired" }), reply(envelope(nav)), reply({ code: -403, message: "WBI signature expired" })]);
  assert.equal((await fetchVideo(d)).error.code, "WBI_KEY_UNAVAILABLE"); assert.equal(d.calls.length, 5);
});
test("unverifiable cid never downloads and explicit ASR emptiness wins", async () => {
  const c = harness(chain(tracks("en", "https://x.hdslb.com/1222.json?cid=222"), reply(envelope({ code: -1 }))));
  assert.equal((await fetchVideo(c)).status, "no-subtitle");
  assert.ok(c.calls.every((call) => !call.url.includes("hdslb")));
});
test("redirected subtitle is rejected without following to any origin", async () => {
  const c = harness(chain(tracks(), () => { throw new TypeError("redirect refused"); }));
  const result = await fetchVideo(c);
  assert.equal(result.error.code, "NETWORK_ERROR"); assert.equal(result.error.retryable, true); assert.equal(c.calls.length, 4);
  assert.equal(c.calls[3].options.redirect, "error");
});
test("same task concurrent clicks coalesce and preserve individual request IDs", async () => {
  const c = harness(chain());
  const [a, b] = await Promise.all([fetchVideo(c, { requestId: "a" }), fetchVideo(c, { requestId: "b", forceRefresh: true })]);
  assert.equal(a.status, "ready"); assert.equal(b.status, "ready");
  assert.equal(a.requestId, "a"); assert.equal(b.requestId, "b"); assert.equal(c.calls.length, 4);
});
test("forged cid and inactive/missing tabs cannot retrieve subtitles", async () => {
  const c = harness([reply(envelope(view))]);
  const forged = { ...c.video, cid: "999", videoKey: `bilibili:${bvid}:999` };
  assert.equal((await fetchVideo(c, { video: forged })).error.code, "STALE_CONTEXT"); assert.equal(c.calls.length, 1);
  c.tab.active = false;
  assert.equal((await fetchVideo(c)).error.code, "STALE_CONTEXT");
  c.chrome.tabs.get = async () => { throw new Error("gone"); };
  assert.equal((await fetchVideo(c)).error.code, "TAB_GONE");
});
test("navigation cancels running fetch and prevents subsequent requests", async () => {
  let begun;
  const started = new Promise((resolve) => { begun = resolve; });
  const c = harness([(url, options) => new Promise((resolve, reject) => { options.signal.addEventListener("abort", () => reject(options.signal.reason)); begun(); })]);
  const pending = fetchVideo(c); await started;
  c.tab.url = `https://www.bilibili.com/video/${bvid}/?p=1`;
  c.events.updated(1, { url: c.tab.url }, c.tab);
  assert.equal((await pending).error.code, "STALE_CONTEXT"); assert.equal(c.calls.length, 1);
});
for (const duration of [15000, 90000]) {
  test(`${duration}ms timeout aborts the task without fallback`, async () => {
    let begun; const started = new Promise((resolve) => { begun = resolve; });
    const c = harness([(url, options) => new Promise((resolve, reject) => { options.signal.addEventListener("abort", () => reject(options.signal.reason)); begun(); })]);
    const pending = fetchVideo(c); await started; c.fire(duration);
    assert.equal((await pending).error.code, "TIMEOUT"); assert.equal(c.calls.length, 1);
  });
}
test("sender boundary, top-frame requirement and synchronous panel open", async () => {
  const c = harness();
  assert.equal((await c.send("resolveBilibiliVideo", { locator }, { id: "alien" })).error.code, "INVALID_REQUEST");
  assert.equal((await c.send("bilibiliOpenSidePanel", {}, { ...c.content(), frameId: 2 })).error.code, "UNSUPPORTED_PAGE");
  const pending = c.send("bilibiliOpenSidePanel", {}, c.content());
  assert.equal(c.opens.length, 1); assert.equal((await pending).success, true);
  assert.equal(c.broadcasts[0].action, "bilibiliPanelOpened");
  assert.equal((await c.send("bilibiliVideoChanged", { locator }, c.content())).success, true); assert.equal(c.calls.length, 0);
});
test("listener returns true and responds exactly once on failure", async () => {
  const c = harness(); let replies = 0;
  const response = new Promise((resolve) => {
    assert.equal(c.events.message({ action: "resolveBilibiliVideo", requestId: "x" }, { id: "alien" }, (value) => { replies++; resolve(value); }), true);
  });
  assert.equal((await response).error.code, "INVALID_REQUEST"); await Promise.resolve(); assert.equal(replies, 1);
});
test("relay uses only supplied top-frame tab, strips extra fields and promotes failures", async () => {
  const c = harness([reply(envelope(view))]);
  const response = await c.send("bilibiliRelayToContent", { payload: { action: "bilibiliSeekTo", video: c.video, seconds: 999, script: "bad" } });
  assert.equal(response.success, true); assert.equal(c.relays[0][0], 1); assert.equal(c.relays[0][1].seconds, 120);
  assert.equal(c.relays[0][1].script, undefined); assert.equal(c.relays[0][2].frameId, 0);
  assert.equal((await c.send("bilibiliRelayToContent", { payload: { action: "eval" } })).error.code, "INVALID_REQUEST");
  c.chrome.tabs.sendMessage = async () => ({ success: false, error: { code: "PLAYER_NOT_READY" } });
  assert.equal((await c.send("bilibiliRelayToContent", { payload: { action: "bilibiliGetCurrentTime", video: c.video } })).error.code, "PLAYER_NOT_READY");
});
test("selected Bilibili note uses current P transcript, never Supadata or AI", async () => {
  const c = harness(chain()); await fetchVideo(c);
  const result = await c.send("saveBilibiliNote", { video: c.video, timestamp: 3.9, selectedText: "Exact selection" });
  assert.equal(result.success, true); assert.equal(result.note.text, "Exact selection"); assert.equal(c.calls.length, 4);
  assert.equal(result.note.videoId, `bilibili:${bvid}:222`); assert.match(result.note.timestampedUrl, /\?p=2&t=3$/);
  assert.equal(c.local.ytd_notes.length, 1);
  c.tab.url = `https://www.bilibili.com/video/${bvid}/?p=1`;
  assert.equal((await c.send("saveBilibiliNote", { video: c.video, timestamp: 3 })).error.code, "STALE_CONTEXT");
});
test("no transcript cannot fabricate a note; storage failure stays failure", async () => {
  const c = harness([reply(envelope(view))]);
  assert.equal((await c.send("saveBilibiliNote", { video: c.video, timestamp: 3, selectedText: "fake" })).error.code, "TRANSCRIPT_NOT_READY");
  c.local[`digest_${c.video.videoKey}`] = { transcript: [{ text: "text", start: 0 }] };
  c.chrome.storage.local.set = async () => { throw new Error("disk"); };
  assert.equal((await c.send("saveBilibiliNote", { video: c.video, timestamp: 3, selectedText: "text" })).error.code, "STORAGE_FAILED");
});
test("manifest freezes both Bilibili scripts, existing YouTube entry and limited hosts", () => {
  const m = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.ok(m.host_permissions.includes("https://api.bilibili.com/*")); assert.ok(m.host_permissions.includes("https://*.hdslb.com/*"));
  assert.ok(!m.permissions.includes("cookies")); assert.ok(!m.permissions.includes("activeTab"));
  assert.deepEqual(m.content_scripts[0], { matches: ["https://www.youtube.com/*"], js: ["content.js"], run_at: "document_idle" });
  const main = m.content_scripts.find((entry) => entry.world === "MAIN");
  assert.deepEqual(main.js, ["bilibili-page.js"]); assert.equal(main.all_frames, false);
  assert.deepEqual(main.matches, ["https://www.bilibili.com/video/*"]);
  assert.match(fs.readFileSync(path.join(root, "scripts/check-release.sh"), "utf8"), /"bilibili-page\.js"/);
});

test("generic -403 permission error does not refresh WBI keys", async () => {
  const c = harness([reply(envelope(view)), reply(envelope(nav)), reply({ code: -403, message: "Access denied" })]);
  assert.equal((await fetchVideo(c)).error.code, "VIDEO_UNAVAILABLE"); assert.equal(c.calls.length, 3);
});
test("cooldown session failure falls back to durable deadline; total failure is explicit", async () => {
  const c = harness([reply({}, 412)]);
  c.chrome.storage.session.set = async () => { throw new Error("session down"); };
  assert.equal((await fetchVideo(c)).error.code, "RATE_LIMITED");
  assert.ok(c.local.bilibiliCooldownUntil > 1000000);
  const restart = harness(); Object.assign(restart.local, c.local);
  assert.equal((await fetchVideo(restart)).error.code, "RATE_LIMITED"); assert.equal(restart.calls.length, 0);
  const d = harness([reply({}, 412)]);
  d.chrome.storage.session.set = d.chrome.storage.local.set = async () => { throw new Error("storage down"); };
  assert.equal((await fetchVideo(d)).error.code, "STORAGE_FAILED");
  assert.equal((await fetchVideo(d)).error.code, "RATE_LIMITED"); assert.equal(d.calls.length, 1);
});
test("selected note preserves long text and surrounding whitespace exactly", async () => {
  const c = harness(chain()); await fetchVideo(c);
  const selectedText = `  ${"字幕".repeat(2000)}\n `;
  const result = await c.send("saveBilibiliNote", { video: c.video, timestamp: 3, selectedText });
  assert.equal(result.note.text, selectedText); assert.equal(result.note.rawText, selectedText);
});
for (const navigation of ["page", "activation"]) {
  test(`queued relay binding cancelled on ${navigation} emits no old view request`, async () => {
    let release, started;
    const began = new Promise((resolve) => { started = resolve; });
    const c = harness([() => new Promise((resolve) => { release = () => resolve(reply(envelope({}))); started(); })]);
    const blocker = c.h.bilibiliRequest("https://api.bilibili.com/x/web-interface/nav");
    await began;
    const pending = c.send("bilibiliRelayToContent", { payload: { action: "bilibiliGetCurrentTime", video: c.video } });
    // Drain the async tab/binding checks until the view is queued.
    await new Promise((resolve) => setImmediate(resolve));
    if (navigation === "page") {
      c.tab.url = `https://www.bilibili.com/video/${bvid}/?p=1`;
      c.events.updated(1, { url: c.tab.url }, c.tab);
    } else {
      c.tab.active = false; c.h.cancelInactiveBilibiliTasks(2, 10);
    }
    assert.equal((await pending).error.code, "STALE_CONTEXT");
    release(); await blocker;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(c.calls.length, 1); assert.equal(c.relays.length, 0);
  });
}
test("refresh to no-subtitle prevents notes from stale body or local cache", async () => {
  const c = harness(chain()); await fetchVideo(c);
  c.local[`digest_${c.video.videoKey}`] = { transcript: [{ text: "stale", start: 0 }] };
  c.responses.push(reply(envelope(nav)), reply(envelope({ subtitle: { subtitles: [] } })), reply(envelope({ code: -1 })));
  assert.equal((await fetchVideo(c, { forceRefresh: true })).status, "no-subtitle");
  assert.equal((await c.send("saveBilibiliNote", { video: c.video, timestamp: 3, selectedText: "stale" })).error.code, "TRANSCRIPT_NOT_READY");
});
test("malformed subtitle and network errors never turn into ASR empty states", async () => {
  for (const response of [reply({ body: [{ content: "broken" }] }), () => { throw new TypeError("network"); }]) {
    const c = harness(chain(tracks(), response));
    assert.equal((await fetchVideo(c)).success, false); assert.equal(c.calls.length, 4);
  }
});
