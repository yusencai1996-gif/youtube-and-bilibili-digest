const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../background.js"), "utf8");
const sandbox = { URL, TextEncoder };
vm.runInNewContext(source.slice(source.indexOf("const BILIBILI_ACTIONS"), source.indexOf("function bilibiliCheckTask")), sandbox);

for (const input of ["", "a", "abc", "message digest", "abcdefghijklmnopqrstuvwxyz", "你好，字幕 🌍", "a".repeat(55), "b".repeat(56), "c".repeat(64), "abc世界".repeat(1000)]) {
  test(`MD5 independent crypto vector (${input.length} characters)`, () => {
    assert.equal(sandbox.md5Hex(input), crypto.createHash("md5").update(input).digest("hex"));
  });
}
test("WBI uses independently fixed mixin, sorted filtered query, and does not mutate input", () => {
  const mixin = sandbox.bilibiliMixinKey(
    "https://i.example/7cd084941338484aae1ad9425b84077c.png",
    "https://i.example/4932caff0ff746eab6f01bf08b70ac45.png");
  assert.equal(mixin, "ea1db124af3c7062474693fa704f4ff8");
  const params = { z: "a b!'()*", foo: "你好", a: 2 };
  const expected = "a=2&foo=%E4%BD%A0%E5%A5%BD&wts=1702204169&z=a%20b";
  assert.equal(sandbox.signBilibiliParams(params, mixin, 1702204169),
    `${expected}&w_rid=${crypto.createHash("md5").update(expected + mixin).digest("hex")}`);
  assert.deepEqual(params, { z: "a b!'()*", foo: "你好", a: 2 });
});
test("WBI rejects missing and malformed keys", () => {
  assert.throws(() => sandbox.bilibiliMixinKey("bad", "bad"), { code: "WBI_KEY_UNAVAILABLE" });
  assert.throws(() => sandbox.signBilibiliParams({}, ""), { code: "WBI_KEY_UNAVAILABLE" });
});
