/**
 * Shared, non-secret configuration helpers.
 *
 * API keys are stored in chrome.storage.local by options.js. This file contains
 * defaults and validation only, so it is safe to publish.
 */
var YTD_SETTINGS = (() => {
  const STORAGE_KEY = "ytd_settings";
  const DEFAULTS = Object.freeze({
    provider: "deepseek",
    aiApiKey: "",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
    supadataApiKey: "",
  });

  function isLegacyCustom(input) {
    return !!input && input.provider === "custom";
  }

  function normalize(input = {}) {
    return {
      provider: DEFAULTS.provider,
      aiApiKey: isLegacyCustom(input)
        ? ""
        : typeof input.aiApiKey === "string"
          ? input.aiApiKey.trim()
          : "",
      aiBaseUrl: DEFAULTS.aiBaseUrl,
      aiModel: DEFAULTS.aiModel,
      supadataApiKey:
        typeof input.supadataApiKey === "string"
          ? input.supadataApiKey.trim()
          : "",
    };
  }

  function migrateLegacyCustom(input = {}) {
    return {
      settings: normalize(input),
      migrated: isLegacyCustom(input),
    };
  }

  function chatCompletionsUrl() {
    return `${DEFAULTS.aiBaseUrl}/chat/completions`;
  }

  function canonicalYouTubeUrl(videoId) {
    const normalized = String(videoId || "").trim();
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(normalized)) {
      throw new Error("Invalid YouTube video ID.");
    }
    return `https://www.youtube.com/watch?v=${normalized}`;
  }

  return {
    STORAGE_KEY,
    DEFAULTS,
    isLegacyCustom,
    normalize,
    migrateLegacyCustom,
    chatCompletionsUrl,
    canonicalYouTubeUrl,
  };
})();

/**
 * Shared interface-language strings for the whole extension UI.
 *
 * The options page owns the language picker; every other surface (side panel,
 * background-driven error rendering) reads the same storage key through this
 * module so the entire plugin follows one language choice. Values may be
 * strings or functions of `params` for interpolated copy.
 */
var YTD_UI_I18N = (() => {
  const LANGUAGE_STORAGE_KEY = "ytd_options_language";
  const SUPPORTED_LANGUAGES = new Set(["en", "zh-CN"]);

  const STRINGS = {
    en: {
      // Header and tabs
      settingsButtonTitle: "Open daweige digest settings",
      settingsButton: "Settings",
      contentLanguageLabel: "Content language",
      modeOriginal: "Original",
      modeChinese: "Chinese",
      modeBilingual: "Bilingual",
      translatingSpinner: "Translating",
      tabTranscript: "Transcript",
      tabOverview: "Overview",
      tabNotes: "Notes",
      // Welcome / loading / error shells
      welcomeTitle: "Ready to Digest",
      welcomeDesc:
        "Open a YouTube or Bilibili video and click the extension icon to get an AI-powered digest.",
      loadingTitle: "Fetching transcript",
      loadingSubtitle: "Extracting captions from video...",
      loadingResolving: "Resolving Bilibili video...",
      errorTitle: "Error",
      errorGenericMessage: "Something went wrong.",
      tryAgain: "Try Again",
      retry: "Retry",
      recheck: "Check again",
      // Transcript tab
      fullTranscript: "Full Transcript",
      copyButton: "Copy",
      exportButton: "Export",
      searchPlaceholder: "Search words or phrases",
      searchAriaLabel: "Search transcript",
      searchClearAria: "Clear transcript search",
      searchClearTitle: "Clear search",
      searchResultsAria: "Search results",
      searchPrevAria: "Previous transcript match",
      searchPrevTitle: "Previous match (Shift + Enter)",
      searchNextAria: "Next transcript match",
      searchNextTitle: "Next match (Enter)",
      searchCount: ({ index, total }) => `${index} of ${total}`,
      noMatches: "No matches",
      // Overview tab
      chaptersTitle: "Chapters",
      chaptersEmpty: "Chapters will appear here",
      quotesTitle: "Key Quotes",
      quotesEmpty: "Quotes will be extracted when you view this tab...",
      loadingChapters: "Loading chapters...",
      loadingQuotes: "Loading quotes...",
      quoteNoteTitle: "Save this quote as a note",
      quoteCopyTitle: "Copy this quote",
      noteAction: "Note",
      copied: "Copied",
      saving: "Saving...",
      saved: "Saved",
      actionError: "Error",
      analysisFailed: ({ error }) => `Analysis failed: ${error}`,
      unknownError: "Unknown error",
      errorPrefix: ({ message }) => `Error: ${message}`,
      // Notes tab
      savedNotes: "Saved Notes",
      notesThisVideo: "This Video",
      notesAll: "All Notes",
      notesIntro:
        'Move your mouse over the video and click Note to save a timestamped note, or press the "n" key while the video is focused.',
      notesEmptyThis:
        "No notes for this video yet. Hover over the video and click Note to save.",
      notesEmptyAll:
        "No notes saved yet. Hover over a video and click Note to save.",
      copyText: "Copy text",
      copyTimestamp: "Copy timestamp",
      playAction: "Play",
      deleteNote: "Delete note",
      // Selection toolbar and explain modal
      selectionToolbarAria: "Selected transcript actions",
      explainAction: "Explain",
      closeAction: "Close",
      analyzing: "Analyzing...",
      explainFailed: ({ error }) => `Failed to get explanation: ${error}`,
      couldNotSaveNote: "Could not save note",
      // Translation states
      translationUnavailable: "Translation unavailable.",
      translating: "Translating...",
      waitingForTranslation: "Waiting for translation…",
      translationFailed: "Translation failed.",
      retrying: "Retrying…",
      translationTimeout:
        "Translation request timed out after 130 seconds. Please Retry.",
      // Playback follow
      followPlayback: "Follow playback",
      // Export
      exportedBy: "Exported by daweige digest",
      // Configuration and provider errors
      apiKeyMissing: "API key missing",
      configErrorTitle: "API Keys Missing",
      configErrorMessage: ({ keys, plural }) =>
        `Add your ${keys} API key${plural ? "s" : ""} in daweige digest Settings.`,
      aiProviderName: "AI provider",
      openSettings: "Open Settings",
      addSupadataKeyPrompt:
        "Add your Supadata API key in daweige digest Settings.",
      addDeepseekKeyPrompt:
        "Add your DeepSeek API key in daweige digest Settings to use AI features.",
      noTranscriptFound: "No transcript found",
      deepseekKeyMissingPrompt:
        "DeepSeek API key not configured. Open daweige digest Settings.",
      deepseekKeyInvalid: "DeepSeek rejected the API key.",
      deepseekRateLimited:
        "DeepSeek rate-limited this request. Try again shortly.",
      aiIdleTimeout:
        "DeepSeek request was inactive for 50 seconds. Please Retry.",
      aiHardTimeout:
        "DeepSeek request exceeded the 120-second limit. Please Retry.",
      aiEmptyResponse: "DeepSeek returned an empty response.",
      aiResponseTooLarge: "DeepSeek response exceeded the 2 MiB limit.",
      supadataKeyInvalid:
        "Your Supadata API key is invalid. Open daweige digest Settings.",
      noSubtitlesForVideo: "No subtitles found for this video.",
      supadataRateLimited:
        "Supadata rate limit reached. Please wait a minute and try again.",
      emptyTranscript: "Supadata returned an empty transcript for this video.",
      // Panel reachability
      pageUnreachableTitle: "Could not reach the page",
      pageUnreachableMessage: "Reload the Bilibili tab and try again.",
      noResponseTitle: "No response",
      noResponseMessage: "The background worker did not answer.",
      unexpectedTranscriptResponse: "Unexpected transcript response.",
      // Bilibili neutral states
      biliLoginTitle: "Log in to Bilibili",
      biliLoginMessage: "Log in to Bilibili to read this video's subtitles.",
      biliNoSubtitleTitle: "No subtitles for this video",
      biliNoSubtitleMessage: "This video currently has no available subtitles.",
      // Bilibili error titles and fallbacks
      biliVideoUnavailableTitle: "Video unavailable",
      biliVideoUnavailableMessage:
        "This video is unavailable or you do not have permission to watch it.",
      biliUnsupportedTitle: "Unsupported page",
      biliUnsupportedMessage: "This page is not supported.",
      biliUnsafeSubtitleTitle: "Could not safely read subtitles",
      biliUnsafeSubtitleMessage:
        "The subtitle data returned by Bilibili could not be verified and was not shown.",
      biliDisconnectedTitle: "Page connection lost",
      biliDisconnectedMessage: "Refresh the current Bilibili page and try again.",
      biliActionIncompleteTitle: "Action not completed",
      biliFetchFailedTitle: "Failed to fetch subtitles",
      biliRateLimitedTitle: "Requests temporarily limited",
      biliRateLimitedMessage:
        "Too many requests to Bilibili. Please try again later.",
      rateLimitWait: ({ seconds }) => `Wait ${seconds}s`,
      biliTabMissing: "No Bilibili tab is connected.",
      // Bilibili transcript provenance
      sourceCc: "Source: Bilibili CC subtitles",
      sourceAi: "Source: Bilibili AI subtitles",
      sourceConclusion: "Source: Bilibili auto-transcription",
      sourceConclusionNoOriginal:
        "Source: Bilibili auto-transcription · No foreign-language original",
      sourceGeneric: "Source: Bilibili subtitles",
      partialHint:
        "Subtitles may be incomplete; the available part has been loaded.",
      refreshSubtitles: "Refresh subtitles",
      noOriginalTitle:
        "Bilibili auto-transcription has no foreign-language original, so bilingual view is unavailable",
    },
    "zh-CN": {
      // Header and tabs
      settingsButtonTitle: "打开 daweige digest 设置",
      settingsButton: "设置",
      contentLanguageLabel: "内容语言",
      modeOriginal: "原文",
      modeChinese: "中文",
      modeBilingual: "双语",
      translatingSpinner: "正在翻译",
      tabTranscript: "字幕",
      tabOverview: "概览",
      tabNotes: "笔记",
      // Welcome / loading / error shells
      welcomeTitle: "准备开始摘要",
      welcomeDesc: "打开一个 YouTube 或 B 站视频，点击扩展图标，即可获得 AI 生成的摘要。",
      loadingTitle: "正在获取字幕",
      loadingSubtitle: "正在从视频中提取字幕…",
      loadingResolving: "正在解析 B 站视频…",
      errorTitle: "出错了",
      errorGenericMessage: "出现了一点问题。",
      tryAgain: "重试",
      retry: "重试",
      recheck: "重新检查",
      // Transcript tab
      fullTranscript: "完整字幕",
      copyButton: "复制",
      exportButton: "导出",
      searchPlaceholder: "搜索单词或短语",
      searchAriaLabel: "搜索字幕",
      searchClearAria: "清除字幕搜索",
      searchClearTitle: "清除搜索",
      searchResultsAria: "搜索结果",
      searchPrevAria: "上一个字幕匹配",
      searchPrevTitle: "上一个匹配 (Shift + Enter)",
      searchNextAria: "下一个字幕匹配",
      searchNextTitle: "下一个匹配 (Enter)",
      searchCount: ({ index, total }) => `${index} / ${total}`,
      noMatches: "无匹配结果",
      // Overview tab
      chaptersTitle: "章节",
      chaptersEmpty: "章节将显示在这里",
      quotesTitle: "重点引用",
      quotesEmpty: "查看此标签页时会自动提取引用…",
      loadingChapters: "正在加载章节…",
      loadingQuotes: "正在加载引用…",
      quoteNoteTitle: "把这条引用保存为笔记",
      quoteCopyTitle: "复制这条引用",
      noteAction: "存为笔记",
      copied: "已复制",
      saving: "正在保存…",
      saved: "已保存",
      actionError: "失败",
      analysisFailed: ({ error }) => `分析失败：${error}`,
      unknownError: "未知错误",
      errorPrefix: ({ message }) => `错误：${message}`,
      // Notes tab
      savedNotes: "已保存的笔记",
      notesThisVideo: "当前视频",
      notesAll: "全部笔记",
      notesIntro:
        "把鼠标移到视频上并点击 Note 可以保存带时间戳的笔记，也可以在视频处于焦点时按 n 键。",
      notesEmptyThis:
        "这个视频还没有笔记。把鼠标移到视频上并点击 Note 即可保存。",
      notesEmptyAll:
        "还没有保存的笔记。把鼠标移到视频上并点击 Note 即可保存。",
      copyText: "复制文本",
      copyTimestamp: "复制时间戳",
      playAction: "播放",
      deleteNote: "删除笔记",
      // Selection toolbar and explain modal
      selectionToolbarAria: "选中字幕后可用的操作",
      explainAction: "讲解",
      closeAction: "关闭",
      analyzing: "正在分析…",
      explainFailed: ({ error }) => `获取讲解失败：${error}`,
      couldNotSaveNote: "无法保存笔记",
      // Translation states
      translationUnavailable: "翻译不可用。",
      translating: "正在翻译…",
      waitingForTranslation: "等待翻译…",
      translationFailed: "翻译失败。",
      retrying: "正在重试…",
      translationTimeout: "翻译请求超过 130 秒未响应，请重试。",
      // Playback follow
      followPlayback: "跟随播放",
      // Export
      exportedBy: "由 daweige digest 导出",
      // Configuration and provider errors
      apiKeyMissing: "缺少 API 密钥",
      configErrorTitle: "缺少 API 密钥",
      configErrorMessage: ({ keys }) =>
        `请在 daweige digest 设置中添加 ${keys} API 密钥。`,
      aiProviderName: "AI 服务",
      openSettings: "打开设置",
      addSupadataKeyPrompt: "请在 daweige digest 设置中添加 Supadata API 密钥。",
      addDeepseekKeyPrompt:
        "在 daweige digest 设置中添加 DeepSeek API 密钥后，即可使用 AI 功能。",
      noTranscriptFound: "未找到字幕",
      deepseekKeyMissingPrompt:
        "未配置 DeepSeek API 密钥。请打开 daweige digest 设置。",
      deepseekKeyInvalid: "DeepSeek 拒绝了该 API 密钥。",
      deepseekRateLimited: "DeepSeek 对本次请求限速，请稍后重试。",
      aiIdleTimeout: "DeepSeek 请求 50 秒没有响应，请重试。",
      aiHardTimeout: "DeepSeek 请求超过 120 秒上限，请重试。",
      aiEmptyResponse: "DeepSeek 返回了空响应。",
      aiResponseTooLarge: "DeepSeek 的响应超过 2 MiB 上限。",
      supadataKeyInvalid:
        "Supadata API 密钥无效。请打开 daweige digest 设置。",
      noSubtitlesForVideo: "找不到这个视频的字幕。",
      supadataRateLimited: "已达到 Supadata 限速，请等一分钟后再试。",
      emptyTranscript: "Supadata 对这个视频返回了空字幕。",
      // Panel reachability
      pageUnreachableTitle: "无法连接到页面",
      pageUnreachableMessage: "请刷新 B 站标签页后重试。",
      noResponseTitle: "没有响应",
      noResponseMessage: "后台服务没有回应。",
      unexpectedTranscriptResponse: "字幕响应格式异常。",
      // Bilibili neutral states
      biliLoginTitle: "请先登录 B 站",
      biliLoginMessage: "登录 B 站后即可读取该视频的字幕。",
      biliNoSubtitleTitle: "该视频无字幕",
      biliNoSubtitleMessage: "这个视频目前没有可用的字幕。",
      // Bilibili error titles and fallbacks
      biliVideoUnavailableTitle: "视频不可访问",
      biliVideoUnavailableMessage: "视频不可访问或无权限观看。",
      biliUnsupportedTitle: "页面不受支持",
      biliUnsupportedMessage: "这个页面不在支持范围内。",
      biliUnsafeSubtitleTitle: "无法安全读取字幕",
      biliUnsafeSubtitleMessage: "B 站返回的字幕数据无法验证，未予显示。",
      biliDisconnectedTitle: "页面连接已断开",
      biliDisconnectedMessage: "请刷新当前 B 站页面后重试。",
      biliActionIncompleteTitle: "操作未完成",
      biliFetchFailedTitle: "字幕获取失败",
      biliRateLimitedTitle: "请求暂时受限",
      biliRateLimitedMessage: "B 站请求过于频繁，请稍后再试。",
      rateLimitWait: ({ seconds }) => `请等待 ${seconds} 秒`,
      biliTabMissing: "没有连接 B 站标签页。",
      // Bilibili transcript provenance
      sourceCc: "来源：B 站 CC 字幕",
      sourceAi: "来源：B 站 AI 字幕",
      sourceConclusion: "来源：B 站转写",
      sourceConclusionNoOriginal: "来源：B 站转写 · 未提供外文原文",
      sourceGeneric: "来源：B 站字幕",
      partialHint: "字幕可能尚未完整，已加载现有部分。",
      refreshSubtitles: "刷新字幕",
      noOriginalTitle: "B 站转写未提供外文原文，无法进行双语对照",
    },
  };

  function normalizeLanguage(language) {
    return SUPPORTED_LANGUAGES.has(language) ? language : "en";
  }

  function translate(language, key, params = {}) {
    const normalizedLanguage = normalizeLanguage(language);
    const value = STRINGS[normalizedLanguage][key] ?? STRINGS.en[key] ?? "";
    return typeof value === "function" ? value(params) : value;
  }

  async function readUiLanguage(storage) {
    try {
      const stored = await storage.get(LANGUAGE_STORAGE_KEY);
      return normalizeLanguage(stored?.[LANGUAGE_STORAGE_KEY]);
    } catch (_error) {
      return "en";
    }
  }

  return {
    LANGUAGE_STORAGE_KEY,
    SUPPORTED_LANGUAGES,
    STRINGS,
    normalizeLanguage,
    translate,
    readUiLanguage,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SETTINGS;
  module.exports.UI_I18N = YTD_UI_I18N;
}
