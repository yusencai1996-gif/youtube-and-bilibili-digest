const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const options = require("../options.js");
const settingsApi = require("../settings.js");

const rootDir = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(rootDir, file), "utf8");

// ------------------------------------------------------------
// Harness: minimal DOM + chrome.storage.local stub so the real
// initialize() wiring runs, including the submit handler.
// ------------------------------------------------------------

function createFakeElement(id) {
  const listeners = new Map();
  return {
    id,
    value: "",
    textContent: "",
    innerHTML: "",
    dataset: {},
    attributes: {},
    selectionStart: 0,
    selectionEnd: 0,
    selectionDirection: "none",
    scrollTop: 0,
    scrollLeft: 0,
    setSelectionRange(start, end, direction) {
      this.selectionStart = start;
      this.selectionEnd = end;
      this.selectionDirection = direction || "none";
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    async dispatch(type, event = {}) {
      for (const handler of listeners.get(type) || []) {
        await handler({ preventDefault() {}, ...event });
      }
    },
    async click() {
      await this.dispatch("click");
    },
  };
}

function createOptionsHarness() {
  const stored = {};
  const chromeApi = {
    storage: {
      local: {
        async get(key) {
          if (key === null || key === undefined) return { ...stored };
          return Object.hasOwn(stored, key) ? { [key]: stored[key] } : {};
        },
        async set(items) {
          Object.assign(stored, items);
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            delete stored[key];
          }
        },
        async clear() {
          for (const key of Object.keys(stored)) delete stored[key];
        },
      },
    },
  };

  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, createFakeElement(id));
    return elements.get(id);
  };

  const languageButtons = ["en", "zh-CN"].map((language) => {
    const button = createFakeElement(`language-${language}`);
    button.dataset.language = language;
    return button;
  });

  const doc = {
    readyState: "complete",
    documentElement: { lang: "" },
    title: "",
    getElementById: getElement,
    querySelectorAll(selector) {
      return selector === "[data-language]" ? [...languageButtons] : [];
    },
    addEventListener() {},
  };

  options.initialize({
    document: doc,
    chrome: chromeApi,
    YTD_SETTINGS: settingsApi,
    navigator: { clipboard: { async writeText() {} } },
    confirm: () => true,
  });

  return {
    stored,
    getElement,
    languageButtons,
    async flush() {
      // initialize() fires loadOptions() without awaiting it; let the
      // microtask chain settle before the test touches the inputs.
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    async submit() {
      await getElement("settingsForm").dispatch("submit");
    },
  };
}

// ------------------------------------------------------------
// F4: DeepSeek is the only hard requirement
// ------------------------------------------------------------

test("saving with only a DeepSeek key succeeds and persists trimmed settings", async () => {
  const harness = createOptionsHarness();
  await harness.flush();

  harness.getElement("aiApiKey").value = "  sk-deepseek-test  ";
  harness.getElement("supadataApiKey").value = "";
  await harness.submit();

  const saved = harness.stored[settingsApi.STORAGE_KEY];
  assert.ok(saved, "settings should be persisted without a Supadata key");
  assert.equal(saved.aiApiKey, "sk-deepseek-test");
  assert.equal(saved.supadataApiKey, "");
  assert.equal(
    harness.getElement("saveStatus").textContent,
    options.translate("en", "savedWithoutSupadata"),
  );
});

test("saving with both keys keeps the classic saved message", async () => {
  const harness = createOptionsHarness();
  await harness.flush();

  harness.getElement("aiApiKey").value = "sk-deepseek-test";
  harness.getElement("supadataApiKey").value = "  sp-supadata-test  ";
  await harness.submit();

  const saved = harness.stored[settingsApi.STORAGE_KEY];
  assert.ok(saved, "settings should be persisted");
  assert.equal(saved.aiApiKey, "sk-deepseek-test");
  assert.equal(saved.supadataApiKey, "sp-supadata-test");
  assert.equal(
    harness.getElement("saveStatus").textContent,
    options.translate("en", "saved"),
  );
});

test("a Supadata key without a DeepSeek key is still rejected", async () => {
  const harness = createOptionsHarness();
  await harness.flush();

  harness.getElement("aiApiKey").value = "";
  harness.getElement("supadataApiKey").value = "sp-only";
  await harness.submit();

  assert.equal(
    harness.stored[settingsApi.STORAGE_KEY],
    undefined,
    "nothing may be written when the DeepSeek key is missing",
  );
  assert.equal(
    harness.getElement("saveStatus").textContent,
    options.translate("en", "addDeepseekKey"),
  );
});

test("the Supadata-optional status renders in Chinese after switching language", async () => {
  const harness = createOptionsHarness();
  await harness.flush();

  const zhButton = harness.languageButtons.find(
    (button) => button.dataset.language === "zh-CN",
  );
  await zhButton.click();

  harness.getElement("aiApiKey").value = "sk-deepseek-test";
  harness.getElement("supadataApiKey").value = "";
  await harness.submit();

  assert.equal(
    harness.getElement("saveStatus").textContent,
    options.translate("zh-CN", "savedWithoutSupadata"),
  );
});

// ------------------------------------------------------------
// Copy: both languages describe Supadata as YouTube-only
// ------------------------------------------------------------

test("Supadata-optional copy exists in both languages and is on the page", () => {
  const enOptional = options.translate("en", "supadataOptional");
  const zhOptional = options.translate("zh-CN", "supadataOptional");
  assert.match(enOptional, /YouTube/);
  assert.match(enOptional, /Bilibili/);
  assert.match(zhOptional, /YouTube/);
  assert.match(zhOptional, /B 站/);
  assert.notEqual(enOptional, zhOptional);

  const enSaved = options.translate("en", "savedWithoutSupadata");
  const zhSaved = options.translate("zh-CN", "savedWithoutSupadata");
  assert.match(enSaved, /Bilibili/);
  assert.match(zhSaved, /B 站/);
  assert.notEqual(enSaved, zhSaved);

  const html = read("options.html");
  assert.match(html, /data-i18n="supadataOptional"/);
});
