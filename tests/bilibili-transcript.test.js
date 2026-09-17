const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../background.js"), "utf8");
const s = { URL, TextEncoder };
vm.runInNewContext(source.slice(source.indexOf("const BILIBILI_ACTIONS"), source.indexOf("function bilibiliCheckTask")), s);
const plain = (value) => JSON.parse(JSON.stringify(value));
const bvid = "BV1MU411S7iJ";
const view = { bvid, aid: 123, cid: 111, title: "Title", owner: { name: "UP", mid: 88 },
  pages: [{ page: 1, cid: 111, duration: 100 }, { page: 2, cid: 222, duration: 200.5 }] };
test("BV/av URL, default P and explicit P2 resolve canonical per-part identity", () => {
  assert.deepEqual(plain(s.parseBilibiliUrl(`https://www.bilibili.com/video/${bvid}/`)), { bvid, page: 1 });
  const locator = s.parseBilibiliUrl("https://www.bilibili.com/video/av123/?p=2&t=4");
  assert.deepEqual(plain(locator), { aid: "123", page: 2 });
  const video = s.bilibiliVideoFromView(locator, view);
  assert.equal(video.cid, "222"); assert.equal(video.duration, 200.5);
  assert.equal(video.videoKey, `bilibili:${bvid}:222`);
  assert.equal(video.canonicalUrl, `https://www.bilibili.com/video/${bvid}/?p=2`);
  assert.equal(s.bilibiliVideoFromView({ bvid, page: 1, cidHint: "222" }, view).cid, "111");
});
test("reject unsupported URLs, malformed IDs/pages, unavailable P and mismatched view", () => {
  for (const url of ["http://www.bilibili.com/video/av123", "https://www.bilibili.com.evil/video/av123", "https://www.bilibili.com/bangumi/play/ep1", "https://www.bilibili.com/video/BV0000000000", "https://www.bilibili.com/video/av0", "https://www.bilibili.com/video/av1?p=0", "https://www.bilibili.com/video/av1?p=2&p=3", "https://www.bilibili.com/video/av1?p=1.2"])
    assert.throws(() => s.parseBilibiliUrl(url));
  assert.throws(() => s.bilibiliVideoFromView({ bvid, page: 3 }, view), { code: "PAGE_NOT_FOUND" });
  assert.throws(() => s.bilibiliVideoFromView({ aid: "9", page: 1 }, view), { code: "SUBTITLE_MISMATCH" });
});
test("subtitle URL gate accepts HTTPS and relative protocol with exact cid token", () => {
  assert.equal(s.validateSubtitleUrl("//aisubtitle.hdslb.com/bfs/222/file.json?auth_key=x", "222"), "https://aisubtitle.hdslb.com/bfs/222/file.json?auth_key=x");
  assert.equal(s.validateSubtitleUrl("https://i0.hdslb.com/a/222.json", "222"), "https://i0.hdslb.com/a/222.json");
  for (const lan of ["en", "ai-en"]) {
    for (const url of ["https://hdslb.com.evil/a/222.json", "https://evilhdslb.com/222", "https://hdslb.com/222", "http://i0.hdslb.com/222", "https://x:y@i0.hdslb.com/222", "https://i0.hdslb.com:444/222", "https://i0.hdslb.com/1222.json", "https://i0.hdslb.com/2221.json"])
      assert.throws(() => s.validateSubtitleUrl(url, "222", lan), { code: "SUBTITLE_MISMATCH" });
  }
});
test("manual CC hashes need no cid but explicit numeric tokens must all match", () => {
  const url = "https://i0.hdslb.com/bfs/subtitle/d481a7f8c5e2c1e8.json";
  assert.equal(s.validateSubtitleUrl(url, "222", "zh-CN"), url);
  const selected = s.selectBilibiliTrack([{ lan: "zh-CN", subtitle_url: url }], "222");
  assert.equal(selected.mismatch, false); assert.equal(selected.track.url, url); assert.equal(selected.track.source, "cc");
  assert.equal(s.validateSubtitleUrl("https://i0.hdslb.com/222/222.json", "222"), "https://i0.hdslb.com/222/222.json");
  for (const path of ["999.json", "222/999.json", "hash_999.json", "1222.json", "2221.json"]) {
    const subtitle_url = `https://i0.hdslb.com/bfs/subtitle/${path}?cid=222`;
    assert.throws(() => s.validateSubtitleUrl(subtitle_url, "222"), { code: "SUBTITLE_MISMATCH" });
    const rejected = s.selectBilibiliTrack([{ lan: "zh-CN", subtitle_url }], "222");
    assert.equal(rejected.mismatch, true); assert.equal(rejected.track, undefined);
  }
});
test("AI hash filenames follow the same standalone-token rule as manual CC", () => {
  for (const [lan, prefix] of [["ai-en", "subtitle"], ["en", "ai_subtitle"]]) {
    const hash = `https://i0.hdslb.com/bfs/${prefix}/d481a7f8c5e2c1e8.json`;
    assert.equal(s.validateSubtitleUrl(hash, "222", lan), hash);
    assert.equal(s.selectBilibiliTrack([{ lan, subtitle_url: hash }], "222").track.source, "ai");
    for (const filename of ["999", "1222", "2221"]) {
      const subtitle_url = `https://i0.hdslb.com/bfs/${prefix}/${filename}.json?cid=222`;
      assert.throws(() => s.validateSubtitleUrl(subtitle_url, "222", lan), { code: "SUBTITLE_MISMATCH" });
      assert.equal(s.selectBilibiliTrack([{ lan, subtitle_url }], "222").track, undefined);
    }
    const selected = s.selectBilibiliTrack([{ lan, subtitle_url: `https://i0.hdslb.com/bfs/${prefix}/222.json` }], "222");
    assert.equal(selected.mismatch, false); assert.equal(selected.track.source, "ai");
  }
});
test("live AI subtitle URLs without a standalone cid pass (2026-09-17 regression)", () => {
  // Shapes captured from a live video (cid 41126921074): pure-hash names for
  // ai-en/ja/es/ar, and the cid embedded inside a longer digit run for ai-zh.
  const zhEmbedded = "https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/1171327509482194112692107401bd35bb057fddc87be3ed5b495b28da";
  for (const lan of ["ai-zh", "ai-en", "ai-ja", "ai-es", "ai-ar"]) {
    const url = lan === "ai-zh" ? zhEmbedded : `https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/${"a1b2c3d4".repeat(4)}`;
    assert.equal(s.validateSubtitleUrl(url, "41126921074", lan), url);
    assert.equal(s.selectBilibiliTrack([{ lan, subtitle_url: url }], "41126921074").mismatch, false);
  }
  assert.throws(() => s.validateSubtitleUrl("https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/999/x.json", "41126921074", "ai-zh"), { code: "SUBTITLE_MISMATCH" });
});
test("BCC text-only access notices are unavailable, while empty and malformed bodies stay distinct", () => {
  for (const body of [[{ content: "【稿件无法观看】" }], [{ content: "视频不可观看" }, { content: "请稍后重试" }]])
    assert.throws(() => s.convertBilibiliBCC({ body }, "zh-CN"), { code: "VIDEO_UNAVAILABLE" });
  assert.equal(s.convertBilibiliBCC({ body: [] }, "zh-CN").length, 0);
  for (const body of [[{ content: " " }], [null], [{ content: 123 }], [{ content: "bad", from: null }]])
    assert.throws(() => s.convertBilibiliBCC({ body }, "zh-CN"), { code: "INVALID_RESPONSE" });
});
test("BCC preserves float seconds, filters bad/empty rows, and sorts stably", () => {
  const rows = s.convertBilibiliBCC({ body: [
    { from: 4.2, to: 5, content: "later" }, { from: 1.86, to: 4.46, content: " first " },
    { from: 1.86, to: 2, content: "tie" }, { from: 0, to: 1, content: " " },
    { from: 2, to: 1, content: "bad" }, { from: "3", to: 4, content: "bad" },
  ] }, "ai-en");
  assert.deepEqual(plain(rows.map((row) => row.text)), ["first", "tie", "later"]);
  assert.equal(rows[0].start, 1.86); assert.ok(Math.abs(rows[0].duration - 2.6) < 1e-12); assert.equal(rows[0].language, "en");
  assert.equal(s.convertBilibiliBCC({ body: [] }, "zh").length, 0);
  assert.throws(() => s.convertBilibiliBCC({ body: [{ from: NaN, to: 3, content: "bad" }] }), { code: "INVALID_RESPONSE" });
  assert.throws(() => s.convertBilibiliBCC({}), { code: "INVALID_RESPONSE" });
});
test("BCC unknown text-only and migrated timing fields remain technical failures", () => {
  for (const body of [[{ content: "普通字幕" }], [{ content: "普通字幕", start: 0, end: 1 }]])
    assert.throws(() => s.convertBilibiliBCC({ body }, "zh-CN"), { code: "INVALID_RESPONSE" });
});
test("BCC access notice detection stops at eight rows", () => {
  const body = Array.from({ length: 8 }, () => ({ content: "稿件" }));
  assert.throws(() => s.convertBilibiliBCC({ body }, "zh-CN"), { code: "VIDEO_UNAVAILABLE" });
  assert.throws(() => s.convertBilibiliBCC({ body: [...body, { content: "稿件" }] }, "zh-CN"), { code: "INVALID_RESPONSE" });
});
test("empty or und language tracks are mismatches and cannot outrank valid Chinese", () => {
  const subtitle_url = "https://i0.hdslb.com/222.json";
  for (const lan of ["", "ai-", "und"]) {
    const rejected = s.selectBilibiliTrack([{ lan, subtitle_url }], "222");
    assert.equal(rejected.mismatch, true); assert.equal(rejected.track, undefined);
    const selected = s.selectBilibiliTrack([{ lan, subtitle_url }, { lan: "zh-CN", subtitle_url }], "222");
    assert.equal(selected.mismatch, true); assert.equal(selected.track.language, "zh-CN");
  }
});
test("track selection prefers Chinese (free AI translation), then player default, then English", () => {
  const url = (name) => `https://i0.hdslb.com/bfs/subtitle/${name}.json`;
  const multi = [
    { lan: "ai-ar", subtitle_url: url("aaa") },
    { lan: "ai-zh", subtitle_url: url("bbb") },
    { lan: "ai-en", subtitle_url: url("ccc") },
    { lan: "ai-ja", subtitle_url: url("ddd") },
  ];
  // Chinese wins regardless of the player default: the zh AI track is a free
  // pre-translated transcript, so no DeepSeek translation cost is incurred.
  for (const preferredLan of ["ai-zh", "", "ai-en", "ai-ja", "ai-ar"]) {
    assert.equal(s.selectBilibiliTrack(multi, "222", preferredLan).track.language, "zh-CN");
  }
  const foreignOnly = [
    { lan: "ai-ar", subtitle_url: url("aaa") },
    { lan: "ai-en", subtitle_url: url("ccc") },
    { lan: "ai-ja", subtitle_url: url("ddd") },
  ];
  assert.equal(s.selectBilibiliTrack(foreignOnly, "222", "ai-ja").track.language, "ja");
  assert.equal(s.selectBilibiliTrack(foreignOnly, "222", "").track.language, "en");
  assert.equal(s.selectBilibiliTrack(foreignOnly, "222").track.language, "en");
});
test("ASR reads only subtitle parts and distinguishes empty from damaged data", () => {
  const rows = s.convertBilibiliASR({ code: 0, model_result: { summary: "ignore", subtitle: [{ part_subtitle: [
    { content: "转写", start_timestamp: 1.2, end_timestamp: 3.8 },
  ] }] } });
  assert.equal(rows[0].start, 1.2); assert.equal(rows[0].language, "zh-CN");
  for (const data of [{ code: -1 }, { code: 1 }, { code: 0, model_result: { summary: "only" } }, { code: 0, model_result: { subtitle: [] } }]) assert.equal(s.convertBilibiliASR(data).length, 0);
  for (const data of [{}, { code: 0, model_result: { subtitle: [{}] } }, { code: 0, model_result: { subtitle: [{ part_subtitle: [{ content: "bad" }] }] } }])
    assert.throws(() => s.convertBilibiliASR(data), { code: "INVALID_RESPONSE" });
});
test("track order prefers Chinese first, then manual within language, id_str and safe URL", () => {
  const track = (lan, id_str) => ({ lan, id_str, subtitle_url: "//x.hdslb.com/222.json" });
  const selected = s.selectBilibiliTrack([track("zh-CN", "1"), track("ai-en", "2"), track("en", "3")], "222").track;
  assert.equal(selected.id, "1"); assert.equal(selected.language, "zh-CN");
  const foreign = s.selectBilibiliTrack([track("ai-en", "2"), track("en", "3")], "222").track;
  assert.equal(foreign.id, "3"); assert.equal(foreign.source, "cc");
  assert.equal(s.selectBilibiliTrack([track("ai-zh", "1")], "222").track.language, "zh-CN");
  assert.equal(s.selectBilibiliTrack([{ ...track("en", "1"), subtitle_url: "https://evil/222" }], "222").mismatch, true);
});
test("pending subtitle URLs are skipped before language and URL validation", () => {
  for (const subtitle_url of ["", null, undefined]) {
    const track = { lan: "", subtitle_url };
    const result = s.selectBilibiliTrack([track], "222");
    assert.equal(result.track, undefined);
    assert.equal(result.mismatch, false);
    assert.equal(result.pending, true);
    const mixed = s.selectBilibiliTrack([track, { lan: "en", subtitle_url: "https://x.hdslb.com/222.json" }], "222");
    assert.equal(mixed.track.language, "en");
    assert.equal(mixed.mismatch, false);
    assert.equal(mixed.pending, true);
  }
  assert.equal(s.selectBilibiliTrack([], "222").pending, false);
  assert.throws(() => s.selectBilibiliTrack([null], "222"), { code: "INVALID_RESPONSE" });
  assert.throws(() => s.selectBilibiliTrack([{ lan: "en", subtitle_url: {} }], "222"), { code: "INVALID_RESPONSE" });
});
test("coverage threshold and conclusion originalAvailable are explicit", () => {
  const video = s.bilibiliVideoFromView({ bvid, page: 2 }, view);
  const result = s.bilibiliTranscriptResult(video, [{ text: "hello", start: 1.9, duration: 2.6 }], "zh-CN", "conclusion");
  assert.equal(result.coverage.possiblyPartial, true); assert.equal(result.originalAvailable, false);
  assert.equal(result.transcriptTextTimestamped, "[0:01] hello");
  assert.equal(s.bilibiliTranscriptResult(video, [{ text: "end", start: 180, duration: 10 }], "en", "cc").coverage.possiblyPartial, false);
});
