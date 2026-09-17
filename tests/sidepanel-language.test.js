const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { UI_I18N } = require("../settings.js");
const options = require("../options.js");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("side panel dictionary keeps English and Chinese keys in sync", () => {
  assert.deepEqual(
    Object.keys(UI_I18N.STRINGS.en).sort(),
    Object.keys(UI_I18N.STRINGS["zh-CN"]).sort(),
  );
  assert.doesNotMatch(JSON.stringify(UI_I18N.STRINGS), /—/);
});

test("every data-i18n key referenced by sidepanel.html exists in both languages", () => {
  const html = read("sidepanel.html");
  const referencedKeys = [
    ...html.matchAll(
      /data-i18n(?:-html|-aria-label|-placeholder|-title)?="([^"]+)"/g,
    ),
  ].map((match) => match[1]);

  assert.ok(referencedKeys.length >= 30, "expected the surveyed static keys");
  for (const key of new Set(referencedKeys)) {
    assert.ok(UI_I18N.STRINGS.en[key], `Missing English copy for ${key}`);
    assert.ok(UI_I18N.STRINGS["zh-CN"][key], `Missing Chinese copy for ${key}`);
  }
  assert.doesNotMatch(html, /—/);
});

test("side panel and options page share one language storage key", () => {
  assert.equal(UI_I18N.LANGUAGE_STORAGE_KEY, "ytd_options_language");
  assert.equal(options.LANGUAGE_STORAGE_KEY, UI_I18N.LANGUAGE_STORAGE_KEY);
});

test("translate renders plain strings, functions, and fallbacks", () => {
  assert.equal(UI_I18N.translate("en", "settingsButton"), "Settings");
  assert.equal(UI_I18N.translate("zh-CN", "settingsButton"), "设置");
  assert.equal(
    UI_I18N.translate("en", "searchCount", { index: 2, total: 5 }),
    "2 of 5",
  );
  assert.equal(
    UI_I18N.translate("zh-CN", "searchCount", { index: 2, total: 5 }),
    "2 / 5",
  );
  assert.equal(
    UI_I18N.translate("en", "rateLimitWait", { seconds: 60 }),
    "Wait 60s",
  );
  // Unknown language normalizes to English; unknown key falls back to English.
  assert.equal(UI_I18N.translate("fr", "settingsButton"), "Settings");
  assert.equal(UI_I18N.translate("zh-CN", "no-such-key"), "");
});

test("readUiLanguage follows storage and degrades safely", async () => {
  const storageWith = (value) => ({
    async get() {
      return { [UI_I18N.LANGUAGE_STORAGE_KEY]: value };
    },
  });

  assert.equal(await UI_I18N.readUiLanguage(storageWith("zh-CN")), "zh-CN");
  assert.equal(await UI_I18N.readUiLanguage(storageWith("en")), "en");
  assert.equal(await UI_I18N.readUiLanguage(storageWith(undefined)), "en");
  assert.equal(await UI_I18N.readUiLanguage(storageWith("fr")), "en");
  assert.equal(
    await UI_I18N.readUiLanguage({
      async get() {
        throw new Error("storage unavailable");
      },
    }),
    "en",
  );
});
