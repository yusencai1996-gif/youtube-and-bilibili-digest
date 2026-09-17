/**
 * BILIBILI PAGE BRIDGE (MAIN world)
 *
 * Runs in the page's MAIN world on https://www.bilibili.com/video/*, where the
 * page's own JavaScript context (and window.__INITIAL_STATE__) is reachable.
 * The isolated-world content script (content.js) cannot read that object, so
 * this script answers carefully scoped "read-state" requests over
 * window.postMessage.
 *
 * Hard rules (frozen bridge contract, channel "ytd-bilibili-v1"):
 * - Only "read-state" requests are answered. No fetch, no script execution,
 *   no writes of any kind.
 * - Replies carry a whitelist of metadata fields only. The full
 *   __INITIAL_STATE__, subtitle URLs, account data, and cookies never leave
 *   this world.
 * - Both directions validate event.source, the exact origin, and the message
 *   shape; replies echo the caller's requestId.
 *
 * The page itself can interfere with this world, so everything returned here
 * is a HINT. The background worker confirms identity and cid through the
 * official view API before any subtitle is fetched.
 */

(function () {
  "use strict";

  const CHANNEL = "ytd-bilibili-v1";
  const REQUEST_TYPE = "read-state";
  const RESPONSE_TYPE = "state";

  // BV ids are fixed-length: "BV1" followed by 9 base58 characters
  // (base58 excludes 0, I, O, and l).
  const BV_PATTERN = /^BV1[1-9A-HJ-NP-Za-km-z]{9}$/;
  const AV_PATTERN = /^av([1-9]\d*)$/i;

  /**
   * Parses the video identity out of a bilibili /video/ URL. Only the pathname
   * and the "p" query parameter are identity; tracking parameters and the "t"
   * timestamp are deliberately ignored.
   *
   * @returns {{bvid: string|null, aid: string|null, page: number} | null}
   */
  function parseVideoUrlIdentity(rawUrl) {
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
    if (BV_PATTERN.test(segment)) {
      bvid = segment;
    } else {
      const avMatch = segment.match(AV_PATTERN);
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

  /**
   * Structure check for incoming requests. Anything that is not exactly a
   * read-state request on our channel is ignored.
   */
  function isReadStateRequest(data) {
    return Boolean(
      data &&
        typeof data === "object" &&
        data.channel === CHANNEL &&
        data.type === REQUEST_TYPE &&
        typeof data.requestId === "string" &&
        data.requestId.length > 0 &&
        data.requestId.length <= 128,
    );
  }

  function asCleanString(value, maxLength) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, maxLength);
  }

  function asIdString(value) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return String(Math.trunc(value));
    }
    if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return value;
    return null;
  }

  /**
   * Picks the pages[] entry for the requested page number. Returns null when
   * the page list is missing or the page is out of range — callers must never
   * silently fall back to the first part.
   */
  function selectPageEntry(pages, page) {
    if (!Array.isArray(pages) || !pages.length) return null;
    const wanted = Number.isInteger(page) && page > 0 ? page : 1;
    return (
      pages.find(
        (entry) => entry && Number(entry.page) === wanted && entry.cid,
      ) || null
    );
  }

  /**
   * Builds the whitelisted reply payload from window.__INITIAL_STATE__.
   *
   * Only these fields may cross the bridge:
   *   bvid, aid, page, cidHint, title, channelName, description, duration
   * plus the bookkeeping flags available/stateMatched.
   *
   * stateMatched tells the caller whether the SSR state's identity still
   * matches the address bar. Bilibili's SPA does not always refresh
   * __INITIAL_STATE__ on client-side navigation, so a mismatched state is
   * stale and must not speak for the current video.
   */
  function buildWhitelistedState(state, rawUrl) {
    const identity = parseVideoUrlIdentity(rawUrl);
    if (!identity) return { available: false, stateMatched: false };

    if (!state || typeof state !== "object") {
      return {
        available: false,
        stateMatched: false,
        bvid: identity.bvid,
        aid: identity.aid,
        page: identity.page,
        cidHint: null,
        title: null,
        channelName: null,
        description: null,
        duration: null,
      };
    }

    const videoData =
      state.videoData && typeof state.videoData === "object"
        ? state.videoData
        : {};

    const stateBvid = asCleanString(state.bvid ?? videoData.bvid, 16);
    const stateAid = asIdString(state.aid ?? videoData.aid);

    // The state is stale when it names a different video than the URL.
    const stateMatched = Boolean(
      (identity.bvid && stateBvid === identity.bvid) ||
        (!identity.bvid && identity.aid && stateAid === identity.aid),
    );

    const pageEntry = selectPageEntry(videoData.pages, identity.page);
    // cidHint must name THIS part's cid. When the page list exists but has no
    // entry for the requested page, we refuse to borrow the first part's cid;
    // only a missing page list lets us fall back to the top-level cid.
    const pageListUsable = Array.isArray(videoData.pages) && videoData.pages.length > 0;
    const cidHint = pageEntry
      ? asIdString(pageEntry.cid)
      : pageListUsable
        ? null
        : asIdString(state.cid ?? videoData.cid);

    let duration = null;
    const pageDuration = Number(pageEntry?.duration);
    const totalDuration = Number(videoData.duration);
    if (Number.isFinite(pageDuration) && pageDuration > 0) {
      duration = pageDuration;
    } else if (Number.isFinite(totalDuration) && totalDuration > 0) {
      duration = totalDuration;
    }

    const owner =
      videoData.owner && typeof videoData.owner === "object"
        ? videoData.owner
        : state.owner && typeof state.owner === "object"
          ? state.owner
          : null;

    return {
      available: true,
      stateMatched,
      bvid: stateMatched ? stateBvid || identity.bvid : identity.bvid,
      aid: stateMatched ? stateAid || identity.aid : identity.aid,
      page: identity.page,
      cidHint: stateMatched ? cidHint : null,
      title: stateMatched ? asCleanString(videoData.title, 500) : null,
      channelName: stateMatched ? asCleanString(owner?.name, 300) : null,
      description: stateMatched ? asCleanString(videoData.desc, 5000) : null,
      duration: stateMatched ? duration : null,
    };
  }

  /**
   * Replies to a read-state request. The reply goes only to the page's own
   * origin and echoes the requestId so the caller can match it.
   */
  function handleMessage(event) {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    if (!isReadStateRequest(event.data)) return;

    let payload;
    try {
      payload = buildWhitelistedState(
        window.__INITIAL_STATE__,
        window.location.href,
      );
    } catch (_error) {
      payload = { available: false, stateMatched: false };
    }

    window.postMessage(
      {
        channel: CHANNEL,
        type: RESPONSE_TYPE,
        requestId: event.data.requestId,
        ...payload,
      },
      window.location.origin,
    );
  }

  window.addEventListener("message", handleMessage);

  // Pure helpers are exposed for the repository's Node tests. The page does
  // not read this object at runtime.
  globalThis.__YTD_BILIBILI_PAGE_TESTING__ = {
    CHANNEL,
    parseVideoUrlIdentity,
    isReadStateRequest,
    selectPageEntry,
    buildWhitelistedState,
    handleMessage,
  };
})();
