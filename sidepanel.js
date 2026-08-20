/**
 * SIDE PANEL LOGIC
 *
 * Handles the UI for YouTube Digest Vocabulary: video detection, transcript analysis,
 * rendering results, and export features.
 */

const DEBUG = false;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};
const EMPTY_TRANSCRIPT_SEGMENTS = Object.freeze([]);
const DIGEST_CACHE_SCHEMA_VERSION = 2;
const DIGEST_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DIGEST_CACHE_MAX_INPUT_UNITS = 2 * 1024 * 1024;
const DIGEST_CACHE_MAX_PROPERTIES = 100_000;
const DIGEST_CACHE_MAX_DEPTH = 32;
const PARAGRAPH_CACHE_MAX_ENTRIES = 2_000;
const PARAGRAPH_CACHE_MAX_VALUE_CHARS = 20_000;
const INVALID_CACHED_DATA = Symbol("invalid cached data");

// ============================================================
// STATE
// ============================================================

let currentVideoId = null;
let currentVideoUrl = null;
let currentAnalysis = null;
let currentTranscript = null;
let currentTranscriptText = null; // Plain text (for display/export)
let currentTranscriptTimestamped = null; // With timestamps for AI analysis
let currentTranscriptLanguage = null;
let currentTranscriptFingerprint = null;
let currentBasicOverview = null;
let currentBasicOverviewFailure = null;
let basicOverviewPresentation = Object.freeze({
  sessionId: "",
  kind: "preparing",
  disposition: "",
  retryAfterMs: 0,
});
let overviewPrimaryAction = null;
let overviewSecondaryAction = null;
let currentConfigStatus = Object.freeze({
  hasSupadataKey: false,
  hasAiKey: false,
  autoBasicOverview: false,
});
let basicOverviewRequestSession = {
  sessionId: "",
  inFlightByFingerprint: new Map(),
  automaticRequestedFingerprints: new Set(),
};
let currentDigestBaseReady = false;
let currentDigestBaseValidUntil = 0;
let currentDigestBaseLastObservedAt = 0;
let digestBaseReadyInFlight = null;
let currentTranscriptSegments = EMPTY_TRANSCRIPT_SEGMENTS;
let currentVideoTitle = "";
let currentChannelName = "";
let currentVideoDescription = "";
let currentVideoDuration = 0;
let isAnalysisLoading = false; // Track if analysis is in progress
let errorAction = null;
let errorSecondaryAction = null;
let analysisContextRecoveryAction = null;
let currentVocabularyEntries = [];
let vocabularySearchQuery = "";
let transcriptFeaturesReady = false;
let explainFeatureCleanup = null;
let activeEvidenceDialog = null;
let evidenceDialogListenersReady = false;

// --- Translation state ---
// The public transcript control intentionally supports only the original
// subtitles, Chinese, and an aligned source + Chinese view.
let currentTranscriptMode = "original";
let translationGeneration = 0; // Invalidates responses from older UI modes/videos.
let translationWorkCount = 0;
let transcriptScrollObserver = null;
// Stable keys include the video, source mode, language, and semantic segment ID.
let transcriptParagraphCache = new Map();
let transcriptExportPreparation = null;
const TRANSLATION_MESSAGE_TIMEOUT_MS = 130_000;

let fallbackSessionId = 0;
const fallbackSessionEntropy = (() => {
  const time = Date.now().toString(36);
  const monotonic = Math.floor(
    Number(globalThis.performance?.now?.() || 0) * 1000,
  ).toString(36);
  const random = Math.random().toString(36).slice(2, 14);
  return `${time}-${monotonic}-${random}`;
})();

function defaultSessionIdFactory() {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (typeof uuid === "string" && uuid.trim()) return uuid.trim();
  } catch {
    // Fall through to getRandomValues, which is supported in older Chromium.
  }
  try {
    if (typeof globalThis.crypto?.getRandomValues === "function") {
      const bytes = new Uint8Array(16);
      globalThis.crypto.getRandomValues(bytes);
      return `panel-${Array.from(bytes, (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("")}`;
    }
  } catch {
    // Last-resort entropy below keeps independent documents from relying on
    // the same panel-local counter alone.
  }
  fallbackSessionId += 1;
  return `panel-session-${fallbackSessionEntropy}-${fallbackSessionId}`;
}

function validateVideoSessionInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Video session input is required.");
  }
  const videoId = typeof input.videoId === "string" ? input.videoId.trim() : "";
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) {
    throw new TypeError("Video session requires a valid YouTube video ID.");
  }
  if (!Number.isSafeInteger(input.tabId) || input.tabId <= 0) {
    throw new TypeError("Video session requires a safe tab ID.");
  }
  if (!Number.isSafeInteger(input.windowId) || input.windowId < 0) {
    throw new TypeError("Video session requires a safe window ID.");
  }
  if (!Number.isSafeInteger(input.resetEpoch) || input.resetEpoch < 0) {
    throw new TypeError("Video session requires a valid reset epoch.");
  }
  return {
    videoId,
    tabId: input.tabId,
    windowId: input.windowId,
    resetEpoch: input.resetEpoch,
  };
}

/**
 * Owns the one active video identity for a side-panel document. Every begin
 * aborts local work from its predecessor and creates a fresh A-B-A-safe token.
 */
function createVideoSessionManager(idFactory = defaultSessionIdFactory) {
  if (typeof idFactory !== "function") {
    throw new TypeError("Video session ID factory must be a function.");
  }
  let generation = 0;
  let active = null;

  const tokenFrom = (session) =>
    session
      ? Object.freeze({
          sessionId: session.sessionId,
          generation: session.generation,
          videoId: session.videoId,
          tabId: session.tabId,
          windowId: session.windowId,
          resetEpoch: session.resetEpoch,
          abortController: session.abortController,
          signal: session.abortController.signal,
        })
      : null;

  return Object.freeze({
    begin(input) {
      const identity = validateVideoSessionInput(input);
      const rawId = idFactory();
      if (typeof rawId !== "string" || !rawId.trim() || rawId.length > 128) {
        throw new TypeError("Video session ID factory returned an invalid ID.");
      }
      if (active) active.abortController.abort();
      generation += 1;
      active = Object.freeze({
        ...identity,
        sessionId: `${rawId.trim()}:${generation}`,
        generation,
        abortController: new AbortController(),
      });
      return active;
    },
    capture() {
      return tokenFrom(active);
    },
    isCurrent(token) {
      return Boolean(
        active &&
          token &&
          token.sessionId === active.sessionId &&
          token.generation === active.generation &&
          token.videoId === active.videoId &&
          token.tabId === active.tabId &&
          token.windowId === active.windowId &&
          token.resetEpoch === active.resetEpoch &&
          !active.abortController.signal.aborted,
      );
    },
    abort() {
      if (active) active.abortController.abort();
      active = null;
    },
  });
}

const videoSessionManager = createVideoSessionManager();
let sessionRebindInFlight = null;

function captureVideoSession() {
  return videoSessionManager.capture();
}

function isCurrentVideoSession(token) {
  return videoSessionManager.isCurrent(token);
}

function isCurrentSessionResponse(token, response) {
  return Boolean(
    isCurrentVideoSession(token) &&
      response &&
      isCurrentVideoSession(response.sessionToken),
  );
}

function publicSessionToken(token) {
  if (!token) return null;
  return Object.freeze({
    sessionId: token.sessionId,
    generation: token.generation,
    videoId: token.videoId,
    tabId: token.tabId,
    windowId: token.windowId,
    resetEpoch: token.resetEpoch,
  });
}

async function bindVideoSession(token) {
  if (!isCurrentVideoSession(token)) return null;
  const response = await chrome.runtime.sendMessage({
    action: "bindVideoSession",
    sessionToken: publicSessionToken(token),
  });
  return isCurrentSessionResponse(token, response) ? response : null;
}

async function rebindVideoSessionOnce(token) {
  if (!isCurrentVideoSession(token)) return null;
  if (sessionRebindInFlight?.sessionId === token.sessionId) {
    return sessionRebindInFlight.promise;
  }
  const promise = bindVideoSession(token);
  sessionRebindInFlight = { sessionId: token.sessionId, promise };
  try {
    return await promise;
  } finally {
    if (sessionRebindInFlight?.promise === promise) {
      sessionRebindInFlight = null;
    }
  }
}

async function sendVideoSessionMessage(message, token) {
  if (!isCurrentVideoSession(token)) return null;
  const request = {
    ...message,
    sessionToken: publicSessionToken(token),
  };
  let response = await chrome.runtime.sendMessage(request);
  if (!isCurrentVideoSession(token)) return null;
  if (response?.code !== "SESSION_UNKNOWN") return response;
  const rebound = await rebindVideoSessionOnce(token);
  if (!rebound?.success || !isCurrentVideoSession(token)) return response;
  response = await chrome.runtime.sendMessage(request);
  return isCurrentVideoSession(token) ? response : null;
}

/**
 * Prevent a stopped service worker or dead message channel from leaving the
 * transcript queue stuck forever. The underlying Chrome message cannot be
 * cancelled, so settled guards deliberately ignore any late response.
 */
function sendTranslationMessage(message, token = null) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      callback(value);
    };

    timeoutId = setTimeout(() => {
      finish(
        reject,
        new Error(
          "Translation request timed out after 130 seconds. Please Retry.",
        ),
      );
    }, TRANSLATION_MESSAGE_TIMEOUT_MS);

    let messagePromise;
    try {
      messagePromise = token
        ? sendVideoSessionMessage(message, token)
        : chrome.runtime.sendMessage(message);
    } catch (error) {
      finish(reject, error);
      return;
    }

    Promise.resolve(messagePromise).then(
      (result) => finish(resolve, result),
      (error) => finish(reject, error),
    );
  });
}

// --- Auto-scroll state (follow video playback in transcript) ---
let autoScrollEnabled = true; // True = scroll transcript to follow video playback
let autoScrollInterval = null; // setInterval ID for polling video time
let lastAutoScrollTime = 0; // Timestamp of last programmatic scroll (ignores scroll events within 1s)
let playbackTickInFlight = null;

// ============================================================
// TRANSCRIPT GROUPING
// ============================================================

const {
  normalizeCaptionText,
  splitOversizedThought,
  groupTranscriptEntries,
  buildTranscriptModeSnapshot,
} = YTD_TRANSCRIPT_CORE;

function createCanonicalTranscriptSegments(entries) {
  return Object.freeze(
    groupTranscriptEntries(entries).map((segment) =>
      Object.freeze({
        ...segment,
        texts: Object.freeze([...(segment.texts || [])]),
      }),
    ),
  );
}

// ============================================================
// INITIALIZATION
// ============================================================

document.addEventListener("DOMContentLoaded", async () => {
  setupEventListeners();
  await loadVocabulary();

  let configStatus;
  try {
    configStatus = await chrome.runtime.sendMessage({
      action: "checkConfig",
    });
  } catch {
    configStatus = null;
  }
  currentConfigStatus = normalizeConfigStatus(configStatus);
  setFeatureAvailability(currentConfigStatus);

  if (!currentConfigStatus.hasSupadataKey) {
    showVocabularyWithoutConfig(currentConfigStatus);
    return;
  }

  transcriptFeaturesReady = true;
  await checkCurrentTab();
});

// Listen for messages from the Digest button on YouTube page
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "startDigestFromButton") {
    // Load the digest for the current video. Served from cache when we've
    // seen this video before (no API calls); fetched fresh otherwise.
    // (This used to force-clear the cache on every click, which silently
    // burned a transcript credit + analysis tokens per click.)
    void handleStartDigestFromButton(message.tabId);
    sendResponse({ success: true });
  }
  if (message.action === "transcriptProgress") {
    // Background is telling us the transcript fetch status changed
    if (isCurrentVideoSession(message.sessionToken)) {
      updateLoading(message.title, message.subtitle);
    }
    sendResponse({ success: true });
  }
  if (message.action === "noteSaved") {
    // Refresh notes list when a new note is saved
    const token = captureVideoSession();
    const filterAll = document
      .getElementById("notesFilterAll")
      ?.classList.contains("active");
    if (
      token &&
      (filterAll ||
        !message.note?.videoId ||
        message.note.videoId === token.videoId)
    ) {
      loadNotes(filterAll ? null : token.videoId, token);
    }
    sendResponse({ success: true });
  }
  if (message.action === "vocabularyChanged") {
    loadVocabulary();
    sendResponse({ success: true });
  }
  return false;
});

// ============================================================
// FOLLOW THE ACTIVE TAB
// ============================================================
// The panel watches which tab is in front of it and reacts:
//   - Front tab is NOT YouTube  -> the panel closes itself (window.close()).
//     We do this OURSELVES rather than relying only on the background
//     script's per-tab enable/disable, because Chrome doesn't reliably
//     apply per-tab panel state to tabs spawned in unusual ways (e.g. a
//     link opened from another app) — which let the panel linger on
//     non-YouTube pages.
//   - Front tab IS YouTube but on a different video -> refresh the digest.
//     YouTube is a single-page app (clicking a video swaps content without
//     a reload), so we track URL changes; startDigest() caches per video,
//     making re-checks instant and free for already-digested videos.
//
// Everything is scoped to the window this panel lives in: tab switches in
// OTHER browser windows must not close this panel or hijack its content.

let navigationRefreshTimer = null;
let panelWindowId = null;
let tabCheckGeneration = 0;
let frontTabGeneration = 0;
const panelWindowReady = Promise.resolve(chrome.windows.getCurrent()).then(
  (windowInfo) => {
    if (!Number.isSafeInteger(windowInfo?.id) || windowInfo.id < 0) {
      throw new TypeError("Unable to identify the side-panel window.");
    }
    panelWindowId = windowInfo.id;
    return panelWindowId;
  },
);

chrome.storage?.onChanged?.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  const token = captureVideoSession();
  const nextEpoch = changes?.ytd_reset_epoch?.newValue;
  if (
    !Number.isSafeInteger(nextEpoch) ||
    nextEpoch < 0 ||
    (token && nextEpoch === token.resetEpoch)
  ) return;
  tabCheckGeneration += 1;
  frontTabGeneration += 1;
  if (navigationRefreshTimer !== null) {
    clearTimeout(navigationRefreshTimer);
    navigationRefreshTimer = null;
  }
  if (token) videoSessionManager.abort();
  resetVideoBoundUi();
  showState("welcome");
});

function scheduleDigestRefresh() {
  // Small delay lets YouTube finish rendering the new video's title and
  // description before we read them. Also collapses rapid-fire URL events
  // into a single refresh.
  clearTimeout(navigationRefreshTimer);
  const scheduledGeneration = tabCheckGeneration;
  const timerId = setTimeout(() => {
    if (navigationRefreshTimer !== timerId) return;
    navigationRefreshTimer = null;
    if (scheduledGeneration !== tabCheckGeneration) return;
    return checkCurrentTab();
  }, 600);
  navigationRefreshTimer = timerId;
}

function panelIsShowingResults() {
  const results = document.getElementById("resultsState");
  return results && results.style.display !== "none";
}

/**
 * Reacts to the URL now in front of the panel: close on non-YouTube,
 * refresh the digest when the video changed.
 */
function handleFrontTabUrl(url, tabId = null) {
  const activeToken = captureVideoSession();
  const nextVideoId = extractVideoId(url);
  if (
    activeToken &&
    (tabId !== activeToken.tabId || nextVideoId !== activeToken.videoId)
  ) {
    videoSessionManager.abort();
    resetVideoBoundUi();
  }
  if (!isAllowedYouTubeTabUrl(url)) {
    // Panel is a YouTube-only tool — remove itself from non-YouTube tabs.
    window.close();
    return;
  }

  const newVideoId = nextVideoId;
  // Refresh when the video changed, or when we're not currently showing
  // results (e.g. user went home, then clicked back into the same video).
  if (newVideoId !== currentVideoId || !panelIsShowingResults()) {
    scheduleDigestRefresh();
  }
}

// Fires when a tab's URL changes — including YouTube's no-reload navigation.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url || !tab.active) return;
  if (panelWindowId === null || tab.windowId !== panelWindowId) return;
  frontTabGeneration += 1;
  tabCheckGeneration += 1;
  handleFrontTabUrl(effectiveTabUrl(tab) || changeInfo.url, tabId);
});

// Fires when a different tab comes to the front — switching tabs, or a new
// tab being opened (including ones opened by clicking links in other apps).
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (panelWindowId === null || windowId !== panelWindowId) return;
  const activationGeneration = ++frontTabGeneration;
  tabCheckGeneration += 1;
  const activeToken = captureVideoSession();
  if (activeToken && activeToken.tabId !== tabId) {
    videoSessionManager.abort();
    resetVideoBoundUi();
  }
  try {
    const tab = await chrome.tabs.get(tabId);
    if (activationGeneration !== frontTabGeneration) return;
    handleFrontTabUrl(effectiveTabUrl(tab), tabId);
  } catch (e) {
    // Tab closed before we could read it — nothing to do.
  }
});

function setupEventListeners() {
  // Tab switching
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
    tab.addEventListener("keydown", handleTabKeydown);
  });

  // Error retry
  document.getElementById("errorBtn").addEventListener("click", () => {
    if (errorAction) {
      return errorAction();
    }
    if (currentVideoId) {
      return startDigest(currentVideoId, currentVideoUrl);
    }
  });
  document
    .getElementById("errorSecondaryBtn")
    ?.addEventListener("click", () => errorSecondaryAction?.());

  document.getElementById("settingsBtn")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "openOptions" });
  });
  document
    .getElementById("vocabularyConfigSettings")
    ?.addEventListener("click", () => {
      chrome.runtime.sendMessage({ action: "openOptions" });
    });

  // Transcript actions
  document
    .getElementById("copyTranscriptBtn")
    ?.addEventListener("click", copyTranscript);
  document
    .getElementById("exportTranscriptBtn")
    ?.addEventListener("click", exportTranscript);
  document
    .getElementById("exportCleanTranscriptBtn")
    ?.addEventListener("click", exportCleanTranscript);
  document
    .getElementById("regenerateAnalysisBtn")
    ?.addEventListener("click", () => triggerAnalysis(true));
  document
    .getElementById("deepAnalysisActionBtn")
    ?.addEventListener("click", () => triggerAnalysis(false));
  document
    .getElementById("overviewPrimaryActionBtn")
    ?.addEventListener("click", () => overviewPrimaryAction?.());
  document
    .getElementById("overviewSecondaryActionBtn")
    ?.addEventListener("click", () => overviewSecondaryAction?.());
  document
    .getElementById("overviewCacheRetryBtn")
    ?.addEventListener("click", () => runBasicOverviewCacheRetry());
  document
    .getElementById("analysisRecoveryContextBtn")
    ?.addEventListener("click", () => analysisContextRecoveryAction?.());
  document
    .getElementById("analysisExportReportBtn")
    ?.addEventListener("click", () => exportDeepAnalysis("report"));
  document
    .getElementById("analysisExportStudyPackBtn")
    ?.addEventListener("click", () => exportDeepAnalysis("study-pack"));
  setupEvidenceDialogListeners();
  document.querySelectorAll(".transcript-mode-btn").forEach((button) => {
    button.addEventListener("click", () => {
      handleTranscriptModeChange(button.dataset.transcriptMode);
    });
  });
  document
    .getElementById("transcriptList")
    ?.addEventListener("click", handleVocabularyWordClick);

  // Follow playback button — re-enables auto-scroll after user scrolled away
  document
    .getElementById("followPlaybackBtn")
    ?.addEventListener("click", () => {
      autoScrollEnabled = true;
      document.getElementById("followPlaybackBtn").style.display = "none";
      // Jump straight back to the line currently being spoken. We scroll
      // directly (not via playbackTrackingTick) because the tick skips
      // entries that are already highlighted — and the current line almost
      // always IS highlighted, which made this button appear to do nothing.
      if (!scrollToActiveEntry()) {
        playbackTrackingTick(); // No highlight yet — let a tick establish one
      }
    });

  // Notes filter buttons
  document.getElementById("notesFilterThis")?.addEventListener("click", () => {
    setNotesFilter(false);
    loadNotes(currentVideoId);
  });
  document.getElementById("notesFilterAll")?.addEventListener("click", () => {
    setNotesFilter(true);
    loadNotes(null); // Load all notes
  });

  document
    .getElementById("vocabularySearch")
    ?.addEventListener("input", (event) => {
      vocabularySearchQuery = event.target.value || "";
      renderVocabularyLibrary();
    });
  document.querySelectorAll("[data-vocabulary-export]").forEach((button) => {
    button.addEventListener("click", () =>
      exportVocabulary(button.dataset.vocabularyExport),
    );
  });
}

function setNotesFilter(showAll) {
  const thisVideoButton = document.getElementById("notesFilterThis");
  const allNotesButton = document.getElementById("notesFilterAll");
  thisVideoButton?.classList.toggle("active", !showAll);
  thisVideoButton?.setAttribute("aria-pressed", String(!showAll));
  allNotesButton?.classList.toggle("active", showAll);
  allNotesButton?.setAttribute("aria-pressed", String(showAll));
}

// ============================================================
// VIDEO DETECTION
// ============================================================

function isAllowedYouTubeTabUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" && parsed.hostname === "www.youtube.com"
    );
  } catch {
    return false;
  }
}

function effectiveTabUrl(tab) {
  if (!tab || typeof tab !== "object") return "";
  if (typeof tab.pendingUrl === "string" && tab.pendingUrl.trim()) {
    return tab.pendingUrl;
  }
  return typeof tab.url === "string" ? tab.url : "";
}

async function resolvePanelTab(tabsApi, windowId, explicitTabId) {
  if (
    !tabsApi ||
    typeof tabsApi.query !== "function" ||
    typeof tabsApi.get !== "function"
  ) {
    throw new TypeError("A Chrome-compatible tabs API is required.");
  }
  if (!Number.isSafeInteger(windowId) || windowId < 0) {
    throw new TypeError("A valid panel window ID is required.");
  }
  if (explicitTabId !== undefined && explicitTabId !== null) {
    if (!Number.isSafeInteger(explicitTabId) || explicitTabId <= 0) {
      throw new TypeError("A valid explicit tab ID is required.");
    }
    const tab = await tabsApi.get(explicitTabId);
    if (
      !tab ||
      tab.id !== explicitTabId ||
      tab.windowId !== windowId ||
      tab.active === false
    ) {
      return null;
    }
    return tab;
  }
  const tabs = await tabsApi.query({ active: true, windowId });
  return Array.isArray(tabs) ? tabs[0] || null : null;
}

async function handleStartDigestFromButton(tabId) {
  try {
    const windowId = await panelWindowReady;
    const tab = await resolvePanelTab(chrome.tabs, windowId, tabId);
    if (!tab) return;
    if (transcriptFeaturesReady) {
      await checkCurrentTab(tabId);
      return;
    }
    showState("results");
    switchTab("vocabulary");
    await loadVocabulary();
  } catch {
    // Invalid or other-window broadcasts are intentionally ignored.
  }
}

function clearVideoElement(id, { hide = false } = {}) {
  const element = document.getElementById(id);
  if (!element) return;
  element.textContent = "";
  element.innerHTML = "";
  if (hide) element.style.display = "none";
}

/** Clears every video-bound value before metadata for the next video awaits. */
function resetVideoBoundUi() {
  closeEvidenceDialog({ restoreFocus: false, clear: true });
  stopPlaybackTracking();
  teardownExplainFeature();
  isAnalysisLoading = false;
  errorAction = null;
  errorSecondaryAction = null;
  analysisContextRecoveryAction = null;
  overviewPrimaryAction = null;
  overviewSecondaryAction = null;
  translationGeneration += 1;
  translationWorkCount = 0;
  activeTranslationQueue?.cancel?.();
  activeTranslationQueue = null;
  if (transcriptScrollObserver) transcriptScrollObserver.disconnect();
  transcriptScrollObserver = null;
  transcriptParagraphCache = new Map();
  transcriptExportPreparation = null;

  currentVideoId = null;
  currentVideoUrl = null;
  currentAnalysis = null;
  currentTranscript = null;
  currentTranscriptText = null;
  currentTranscriptTimestamped = null;
  currentTranscriptLanguage = null;
  currentTranscriptFingerprint = null;
  currentBasicOverview = null;
  currentBasicOverviewFailure = null;
  basicOverviewPresentation = Object.freeze({
    sessionId: "",
    kind: "preparing",
    disposition: "",
    retryAfterMs: 0,
  });
  basicOverviewRequestSession = {
    sessionId: "",
    inFlightByFingerprint: new Map(),
    automaticRequestedFingerprints: new Set(),
  };
  currentDigestBaseReady = false;
  currentDigestBaseValidUntil = 0;
  currentDigestBaseLastObservedAt = 0;
  digestBaseReadyInFlight = null;
  currentTranscriptSegments = EMPTY_TRANSCRIPT_SEGMENTS;
  currentVideoTitle = "";
  currentChannelName = "";
  currentVideoDescription = "";
  currentVideoDuration = 0;
  currentTranscriptMode = "original";

  clearVideoElement("videoInfo", { hide: true });
  for (const id of [
    "videoTitle",
    "videoChannel",
    "transcriptList",
    "transcriptExportStatus",
    "analysisStatus",
    "analysisOneSentence",
    "analysisExecutiveSummary",
    "analysisCoreThesis",
    "analysisWhyItMatters",
    "analysisInsights",
    "analysisArgumentMap",
    "analysisStrengths",
    "analysisLimitations",
    "analysisAssumptions",
    "analysisOpenQuestions",
    "analysisActionItems",
    "analysisReviewQuestions",
    "chapterList",
    "quotesList",
    "overviewStatusBadge",
    "overviewOneSentence",
    "overviewConclusions",
    "overviewChapterList",
    "overviewErrorTitle",
    "overviewErrorMessage",
    "overviewErrorCostNote",
    "overviewCacheWarningMessage",
    "notesList",
    "errorTitle",
    "errorMessage",
    "errorCostNote",
  ]) {
    clearVideoElement(id);
  }
  clearVideoElement("notesIntro", { hide: true });
  document.getElementById("transcriptSourceBadge")?.remove();
  document.getElementById("explainModal")?.remove();
  document.getElementById("vocabularyCardModal")?.remove();
  const regenerateButton = document.getElementById("regenerateAnalysisBtn");
  if (regenerateButton) {
    regenerateButton.disabled = false;
    regenerateButton.textContent = "重新生成";
  }
  const analysisContextButton = document.getElementById(
    "analysisRecoveryContextBtn",
  );
  if (analysisContextButton) {
    analysisContextButton.textContent = "";
    analysisContextButton.style.display = "none";
  }
  const errorSecondaryButton = document.getElementById("errorSecondaryBtn");
  if (errorSecondaryButton) errorSecondaryButton.style.display = "none";
  const errorCostNote = document.getElementById("errorCostNote");
  if (errorCostNote) errorCostNote.style.display = "none";
  setAnalysisExportAvailability(false);
  resetBasicOverviewUi();
  resetDeepAnalysisUi();
  setTranscriptModeButtons("original");
  updateTranscriptExportControls("original");
  setTranslatingSpinner(false, true);
  switchTab("overview", { suppressAnalysis: true });
  showState("loading");
  updateLoading("Preparing video", "");
}

function renderCurrentVideoMetadata(token) {
  if (!isCurrentVideoSession(token)) return;
  const videoInfo = document.getElementById("videoInfo");
  const title = document.getElementById("videoTitle");
  const channel = document.getElementById("videoChannel");
  if (title) title.textContent = currentVideoTitle;
  if (channel) channel.textContent = currentChannelName;
  if (videoInfo) {
    videoInfo.style.display =
      currentVideoTitle || currentChannelName ? "block" : "none";
  }
}

async function checkCurrentTab(explicitTabId) {
  const hasExplicitTab = explicitTabId !== undefined && explicitTabId !== null;
  const checkGeneration = ++tabCheckGeneration;
  try {
    const windowId = await panelWindowReady;
    if (checkGeneration !== tabCheckGeneration) return;
    const tab = await resolvePanelTab(chrome.tabs, windowId, explicitTabId);
    if (checkGeneration !== tabCheckGeneration) return;

    const tabUrl = effectiveTabUrl(tab);
    debugLog("[YouTube Digest Vocabulary Panel] Found tab:", tab?.id, tabUrl);

    // Runtime broadcasts reach every open panel. A button click from another
    // window is not evidence that this panel's current tab became invalid.
    if (!tab && hasExplicitTab) return;

    if (!tabUrl || !isAllowedYouTubeTabUrl(tabUrl)) {
      videoSessionManager.abort();
      resetVideoBoundUi();
      showState("welcome");
      return;
    }

    const videoId = extractVideoId(tabUrl);

    if (videoId) {
      // An explicit button can identify a different tab before its reset-epoch
      // read completes. Invalidate the old identity now so its late work cannot
      // mutate the panel during that pre-begin await.
      const activeToken = captureVideoSession();
      if (
        activeToken &&
        (activeToken.videoId !== videoId || activeToken.tabId !== tab.id)
      ) {
        videoSessionManager.abort();
      }

      const epochResult = await chrome.runtime.sendMessage({
        action: "getResetEpoch",
      });
      if (checkGeneration !== tabCheckGeneration) return;
      if (
        epochResult?.success !== true ||
        !Number.isSafeInteger(epochResult.resetEpoch)
      ) {
        throw new Error("Unable to bind this video to local data.");
      }
      const existingToken = captureVideoSession();
      if (
        existingToken &&
        existingToken.videoId === videoId &&
        existingToken.tabId === tab.id &&
        existingToken.windowId === windowId &&
        existingToken.resetEpoch === epochResult.resetEpoch
      ) {
        return;
      }
      const token = videoSessionManager.begin({
        videoId,
        tabId: tab.id,
        windowId,
        resetEpoch: epochResult.resetEpoch,
      });
      resetVideoBoundUi();
      currentVideoId = token.videoId;
      currentVideoUrl = tabUrl;

      const binding = await bindVideoSession(token);
      if (!isCurrentVideoSession(token)) return;
      if (!binding?.success) {
        showError(
          "Video session changed",
          "Please retry from the currently active YouTube tab.",
        );
        return;
      }

      try {
        // Route through background script for reliable message passing
        const result = await sendVideoSessionMessage({
          action: "relayToContent",
          tabId: token.tabId,
          payload: { action: "getVideoInfo" },
        }, token);
        if (!isCurrentSessionResponse(token, result)) return;
        debugLog("[YouTube Digest Vocabulary Panel] getVideoInfo result:", result);
        if (result.success && result.response) {
          currentVideoTitle = result.response.title || "";
          currentChannelName = result.response.channelName || "";
          currentVideoDescription = result.response.description || "";
          currentVideoDuration = result.response.duration || 0;
        }
      } catch (e) {
        if (!isCurrentVideoSession(token)) return;
        currentVideoTitle = "";
        currentChannelName = "";
        currentVideoDescription = "";
        currentVideoDuration = 0;
      }
      if (!isCurrentVideoSession(token)) return;
      renderCurrentVideoMetadata(token);
      await startDigest(videoId, tabUrl, token);
    } else {
      videoSessionManager.abort();
      resetVideoBoundUi();
      showState("welcome");
    }
  } catch (error) {
    if (checkGeneration === tabCheckGeneration) showState("welcome");
  }
}

function extractVideoId(url) {
  try {
    const urlObj = new URL(url);

    if (
      urlObj.hostname.includes("youtube.com") &&
      urlObj.searchParams.has("v")
    ) {
      return urlObj.searchParams.get("v");
    }

    if (urlObj.hostname === "youtu.be") {
      return urlObj.pathname.slice(1);
    }

    if (urlObj.pathname.startsWith("/embed/")) {
      return urlObj.pathname.split("/")[2];
    }

    return null;
  } catch {
    return null;
  }
}

// ============================================================
// DIGEST PIPELINE
// ============================================================

function isTranscriptFingerprintError(error) {
  return error?.code === "TRANSCRIPT_FINGERPRINT_UNAVAILABLE";
}

function showTranscriptFingerprintError(retry) {
  showError(
    "本地安全功能不可用",
    "当前环境无法使用 Web Crypto 计算 SHA-256 逐字稿指纹。请更新或重新启动 Chrome 后再试。",
  );
  if (typeof retry === "function") errorAction = retry;
}

function showFingerprintUnavailableCacheLimits() {
  setTranscriptExportStatus(
    "逐字稿已从本地缓存加载；当前环境无法使用 Web Crypto/SHA-256，因此不会读取或保存翻译缓存。",
  );
  setAnalysisStatus(
    "已保留本地缓存内容。当前环境无法使用 Web Crypto/SHA-256；为避免产生无法安全缓存的付费结果，新的 AI 分析已禁用。",
  );
  const regenerateButton = document.getElementById("regenerateAnalysisBtn");
  if (regenerateButton) {
    regenerateButton.disabled = true;
    regenerateButton.title = "需要 Web Crypto/SHA-256 逐字稿指纹";
  }
  const token = captureVideoSession();
  if (isCurrentVideoSession(token) && !currentBasicOverview) {
    showBasicOverviewMessage(
      {
        kind: "guidance",
        title: "当前环境无法校验基础概览",
        message:
          "字幕仍可阅读，但缺少 Web Crypto/SHA-256 时不会发送新的 AI 请求。请更新或重新启动 Chrome。",
        primaryLabel: "查看字幕",
        primaryAction: () => switchTab("transcript"),
      },
      token,
    );
  }
}

async function finalizeFreshTranscript(videoId, token) {
  let transcriptFingerprint;
  try {
    transcriptFingerprint = await YTD_TRANSCRIPT_CORE.fingerprintSegments(
      currentTranscriptSegments,
      { sourceLanguage: currentTranscriptLanguage },
    );
  } catch (error) {
    if (!isCurrentVideoSession(token)) return;
    if (isTranscriptFingerprintError(error)) {
      showTranscriptFingerprintError(() =>
        finalizeFreshTranscript(videoId, token),
      );
      return;
    }
    throw error;
  }
  if (!isCurrentVideoSession(token)) return;
  currentTranscriptFingerprint = transcriptFingerprint;

  // Render transcript immediately (no LLM needed)
  renderTranscript();
  showState("results");
  document.getElementById("tabsNav").style.display = "flex";
  showBasicOverviewPreparing(token);

  // Load notes for this video
  void loadNotes(videoId, token);

  // Persist only the canonical transcript base before enabling any paid
  // derived work. A failed base cannot safely receive later patches.
  // patch transactions and can never be overwritten by this call.
  await ensureDigestBaseReady(token);
  if (!isCurrentVideoSession(token)) return;
  if (currentDigestBaseReady) {
    void maybeRequestAutomaticBasicOverview(token);
    if (currentTranscriptMode !== "original") void translateTranscript(token);
  } else {
    renderBasicOverviewOutcome(
      panelOverviewFailure("DIGEST_BASE_NOT_READY"),
      token,
    );
  }
}

async function startDigest(videoId, videoUrl, token = captureVideoSession()) {
  if (!isCurrentVideoSession(token) || token.videoId !== videoId) return;
  clearProviderErrorSurface();
  // Check cache for this video
  let cached;
  try {
    cached = await loadFromCache(videoId, token);
  } catch (error) {
    if (!isCurrentVideoSession(token)) return;
    if (isTranscriptFingerprintError(error)) {
      showTranscriptFingerprintError();
      return;
    }
    throw error;
  }
  if (!isCurrentVideoSession(token)) return;
  if (cached) {
    debugLog("Loading from cache:", videoId);
    currentVideoId = token.videoId;
    currentVideoUrl = videoUrl;
    currentAnalysis = cached.deepAnalysis;
    currentTranscript = cached.transcript;
    currentTranscriptText = cached.transcriptText;
    currentTranscriptTimestamped = cached.transcriptTimestamped;
    currentTranscriptLanguage = cached.transcriptLanguage || null;
    currentTranscriptFingerprint = cached.transcriptFingerprint;
    currentBasicOverview = usableBasicOverview(
      cached.basicOverview,
      cached.transcriptFingerprint,
    )
      ? cached.basicOverview
      : null;
    currentBasicOverviewFailure = null;
    const cachedBaseClockIsValid = Boolean(
      Number.isSafeInteger(cached.digestBaseObservedAt) &&
        cached.digestBaseObservedAt >= 0 &&
        Number.isSafeInteger(cached.digestBaseValidUntil) &&
        cached.digestBaseValidUntil > cached.digestBaseObservedAt,
    );
    currentDigestBaseLastObservedAt = cachedBaseClockIsValid
      ? cached.digestBaseObservedAt
      : 0;
    currentDigestBaseValidUntil = cachedBaseClockIsValid
      ? cached.digestBaseValidUntil
      : 0;
    currentDigestBaseReady =
      cachedBaseClockIsValid &&
      !cached.transcriptFingerprintUnavailable &&
      !cached.needsBaseMigration;
    currentTranscriptSegments = Array.isArray(cached.transcriptSegments)
      ? cached.transcriptSegments
      : EMPTY_TRANSCRIPT_SEGMENTS;
    isAnalysisLoading = false;

    // Restore semantic-segment translations from persistent storage.
    if (Array.isArray(cached.paragraphCacheEntries)) {
      transcriptParagraphCache = new Map(cached.paragraphCacheEntries);
    }

    if (!currentVideoTitle) currentVideoTitle = cached.videoTitle || "";
    if (!currentChannelName) currentChannelName = cached.channelName || "";
    renderCurrentVideoMetadata(token);

    // Always render transcript first
    if (!isCurrentVideoSession(token)) return;
    renderTranscript();

    // Render analysis if we have it cached
    if (currentAnalysis) {
      renderAnalysisResults(currentAnalysis);
      void highlightMomentsOnPage(currentAnalysis.keyMoments, token);
    }
    if (cached.transcriptFingerprintUnavailable) {
      showFingerprintUnavailableCacheLimits();
    }

    if (!isCurrentVideoSession(token)) return;
    showState("results");
    document.getElementById("tabsNav").style.display = "flex";
    if (currentBasicOverview) {
      renderBasicOverview(currentBasicOverview, token);
    } else {
      showBasicOverviewPreparing(token);
    }

    // Load notes for this video
    void loadNotes(videoId, token);

    if (cached.needsBaseMigration) {
      await ensureDigestBaseReady(token);
    }
    if (!isCurrentVideoSession(token)) return;
    if (currentDigestBaseReady) {
      setupExplainFeature();
      void maybeRequestAutomaticBasicOverview(token);
      if (currentTranscriptMode !== "original") void translateTranscript(token);
    } else if (!cached.transcriptFingerprintUnavailable) {
      renderBasicOverviewOutcome(
        panelOverviewFailure("DIGEST_BASE_NOT_READY"),
        token,
      );
    }
    return;
  }

  if (!isCurrentVideoSession(token)) return;
  currentVideoId = token.videoId;
  currentVideoUrl = videoUrl;
  currentAnalysis = null;
  currentTranscript = null;
  currentTranscriptText = null;
  currentTranscriptTimestamped = null;
  currentTranscriptLanguage = null;
  currentTranscriptFingerprint = null;
  currentBasicOverview = null;
  currentBasicOverviewFailure = null;
  currentDigestBaseReady = false;
  currentDigestBaseValidUntil = 0;
  currentDigestBaseLastObservedAt = 0;
  digestBaseReadyInFlight = null;
  currentTranscriptSegments = EMPTY_TRANSCRIPT_SEGMENTS;
  isAnalysisLoading = false;

  renderCurrentVideoMetadata(token);

  try {
    YTD_TRANSCRIPT_CORE.assertSecureFingerprintAvailable();
  } catch (error) {
    if (!isCurrentVideoSession(token)) return;
    if (isTranscriptFingerprintError(error)) {
      showTranscriptFingerprintError(() => startDigest(videoId, videoUrl, token));
      return;
    }
    throw error;
  }

  showState("loading");
  updateLoading("Fetching transcript", "");

  const transcriptResult = await sendVideoSessionMessage({
    action: "fetchTranscript",
    videoId: token.videoId,
  }, token);
  if (!isCurrentSessionResponse(token, transcriptResult)) return;
  if (isSilentProviderAuthorityFailure(transcriptResult)) return;

  if (!transcriptResult.success) {
    showProviderFailure(transcriptResult, "transcript", () =>
      startDigest(token.videoId, videoUrl, token),
    );
    return;
  }

  currentTranscript = transcriptResult.transcript;
  currentTranscriptText = transcriptResult.transcriptText;
  currentTranscriptTimestamped = transcriptResult.transcriptTextTimestamped;
  currentTranscriptLanguage = YTD_TRANSCRIPT_CORE.resolveTranscriptLanguage(
    transcriptResult.language,
    currentTranscript,
  );
  const transcriptSegments = createCanonicalTranscriptSegments(
    currentTranscript,
  );
  currentTranscriptSegments = transcriptSegments;
  await finalizeFreshTranscript(videoId, token);
  if (!isCurrentVideoSession(token)) return;

  // Deep Analysis remains explicit; only the lightweight Basic Overview may
  // start automatically through the consent-aware orchestration above.
}

// ============================================================
// RENDERING
// ============================================================

function hasDeepAnalysis(analysis) {
  const nonemptyString = (value) =>
    typeof value === "string" && Boolean(value.trim());
  const maximum = analysis?.maxTimestampSeconds;
  const validSeconds = (value) =>
    Number.isSafeInteger(value) && value >= 0 && value <= maximum;
  const formattedSeconds = (value) =>
    `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
  const validTimedRecord = (item) =>
    validSeconds(item.timestampSeconds) &&
    item.timestamp === formattedSeconds(item.timestampSeconds);
  const sortedByTimestamp = (items) =>
    items.every(
      (item, index) =>
        index === 0 ||
        items[index - 1].timestampSeconds <= item.timestampSeconds,
    );
  const recordArray = (value, minimum, validate) =>
    Array.isArray(value) &&
    value.length >= minimum &&
    value.every(
      (item) =>
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        validate(item),
    );
  const summary = analysis?.summary;
  const hasCompleteSummary = [
    summary?.oneSentenceZh,
    summary?.executiveSummaryZh,
    summary?.coreThesisZh,
    summary?.whyItMattersZh,
  ].every(nonemptyString);
  const chaptersAreValid = recordArray(
    analysis?.chapters,
    1,
    (chapter) =>
      nonemptyString(chapter.title) &&
      nonemptyString(chapter.summary) &&
      validTimedRecord(chapter),
  );
  const chapters = chaptersAreValid ? analysis.chapters : [];
  const startCoverageLimit = Math.min(30, Math.floor(maximum * 0.1));
  const lateCoverageThreshold = Math.floor(maximum * 0.75);
  const chapterCoverageIsComplete = Boolean(
    chapters.length &&
      chapters[0].timestampSeconds <= startCoverageLimit &&
      chapters.at(-1).timestampSeconds >= lateCoverageThreshold,
  );
  const keyInsightsAreValid = recordArray(
    analysis?.keyInsights,
    5,
    (insight) =>
      nonemptyString(insight.titleZh) &&
      nonemptyString(insight.explanationZh) &&
      nonemptyString(insight.evidenceZh) &&
      validTimedRecord(insight),
  );
  const argumentMapIsValid = recordArray(
    analysis?.argumentMap,
    1,
    (item) =>
      nonemptyString(item.claimZh) &&
      nonemptyString(item.supportZh) &&
      typeof item.caveatZh === "string",
  );
  const reviewQuestionsAreValid = recordArray(
    analysis?.reviewQuestions,
    1,
    (item) =>
      nonemptyString(item.questionZh) && nonemptyString(item.answerZh),
  );
  const keyQuotesAreValid = recordArray(
    analysis?.keyQuotes,
    3,
    (quote) =>
      nonemptyString(quote.quote) && validTimedRecord(quote),
  );
  const hasKeyMoments =
    Array.isArray(analysis?.keyMoments) &&
    analysis.keyMoments.length >= 1 &&
    analysis.keyMoments.every(
      (seconds) => validSeconds(seconds),
    );
  const critical = analysis?.criticalThinking;
  const hasStringCollections = [
    analysis?.actionItemsZh,
    critical?.strengthsZh,
    critical?.limitationsZh,
    critical?.assumptionsZh,
    critical?.openQuestionsZh,
  ].every(
    (values) =>
      Array.isArray(values) &&
      values.length >= 1 &&
      values.every(nonemptyString),
  );
  return Boolean(
    analysis?.schemaVersion === 2 &&
      analysis?.reportComplete === true &&
      Number.isSafeInteger(maximum) &&
      maximum >= 0 &&
      hasCompleteSummary &&
      chaptersAreValid &&
      sortedByTimestamp(chapters) &&
      chapterCoverageIsComplete &&
      keyInsightsAreValid &&
      sortedByTimestamp(analysis.keyInsights) &&
      argumentMapIsValid &&
      reviewQuestionsAreValid &&
      keyQuotesAreValid &&
      sortedByTimestamp(analysis.keyQuotes) &&
      hasKeyMoments &&
      hasStringCollections,
  );
}

function analysisArray(value) {
  return Array.isArray(value) ? value : [];
}

function analysisRecords(value) {
  return analysisArray(value).filter(
    (item) => item && typeof item === "object" && !Array.isArray(item),
  );
}

function renderAnalysisList(elementId, values) {
  const list = document.getElementById(elementId);
  if (!list) return;
  list.innerHTML = "";
  const items = Array.isArray(values) ? values.filter(Boolean) : [];
  if (!items.length) {
    const empty = document.createElement("li");
    empty.className = "analysis-empty";
    empty.textContent = "本节没有足够的逐字稿证据。";
    list.appendChild(empty);
    return;
  }
  items.forEach((value) => {
    const item = document.createElement("li");
    item.textContent = value;
    list.appendChild(item);
  });
}

function setAnalysisExportAvailability(enabled) {
  ["analysisExportReportBtn", "analysisExportStudyPackBtn"].forEach((id) => {
    const button = document.getElementById(id);
    if (button) button.disabled = !enabled;
  });
}

function setAnalysisStatus(message) {
  const status = document.getElementById("analysisStatus");
  if (status) status.textContent = message;
}

function renderAnalysisNarrative(analysis) {
  const summary = analysis?.summary || {};
  const setText = (id, value) => {
    const element = document.getElementById(id);
    if (element) element.textContent = value || "本节暂无内容。";
  };
  setText("analysisOneSentence", summary.oneSentenceZh);
  setText("analysisExecutiveSummary", summary.executiveSummaryZh);
  setText("analysisCoreThesis", summary.coreThesisZh);
  setText("analysisWhyItMatters", summary.whyItMattersZh);

  const insights = document.getElementById("analysisInsights");
  if (insights) {
    insights.innerHTML = "";
    analysisRecords(analysis?.keyInsights).forEach((insight) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "analysis-insight";
      card.dataset.seconds = insight.timestampSeconds;
      card.innerHTML = `
        <span class="analysis-insight-time">${escapeHtml(insight.timestamp)}</span>
        <strong>${escapeHtml(insight.titleZh)}</strong>
        <span>${escapeHtml(insight.explanationZh)}</span>
        <small><b>逐字稿依据：</b>${escapeHtml(insight.evidenceZh)}</small>
      `;
      card.addEventListener("click", () => seekTo(Number(card.dataset.seconds)));
      insights.appendChild(card);
    });
    if (!insights.children.length) {
      insights.innerHTML = '<p class="analysis-empty">没有找到可验证的关键洞见。</p>';
    }
  }

  const argumentMap = document.getElementById("analysisArgumentMap");
  if (argumentMap) {
    argumentMap.innerHTML = "";
    analysisRecords(analysis?.argumentMap).forEach((item, index) => {
      const card = document.createElement("article");
      card.className = "analysis-argument";
      card.innerHTML = `
        <div class="analysis-argument-number">${index + 1}</div>
        <div><b>主张</b><p>${escapeHtml(item.claimZh)}</p></div>
        <div><b>支持</b><p>${escapeHtml(item.supportZh)}</p></div>
        ${item.caveatZh ? `<div><b>限制</b><p>${escapeHtml(item.caveatZh)}</p></div>` : ""}
      `;
      argumentMap.appendChild(card);
    });
    if (!argumentMap.children.length) {
      argumentMap.innerHTML = '<p class="analysis-empty">没有足够信息重建论证。</p>';
    }
  }

  const critical = analysis?.criticalThinking || {};
  renderAnalysisList("analysisStrengths", critical.strengthsZh);
  renderAnalysisList("analysisLimitations", critical.limitationsZh);
  renderAnalysisList("analysisAssumptions", critical.assumptionsZh);
  renderAnalysisList("analysisOpenQuestions", critical.openQuestionsZh);
  renderAnalysisList("analysisActionItems", analysis?.actionItemsZh);

  const questions = document.getElementById("analysisReviewQuestions");
  if (questions) {
    questions.innerHTML = "";
    analysisRecords(analysis?.reviewQuestions).forEach((item, index) => {
      const details = document.createElement("details");
      details.className = "analysis-review-question";
      const summaryElement = document.createElement("summary");
      summaryElement.textContent = `${index + 1}. ${item.questionZh}`;
      const answer = document.createElement("p");
      answer.textContent = item.answerZh;
      details.append(summaryElement, answer);
      questions.appendChild(details);
    });
    if (!questions.children.length) {
      questions.innerHTML = '<p class="analysis-empty">没有生成复习问题。</p>';
    }
  }

  const ready = hasDeepAnalysis(analysis);
  if (ready) {
    const overviewTab = document.querySelector('.tab[data-tab="overview"]');
    if (overviewTab) {
      overviewTab.disabled = false;
      overviewTab.title = "";
    }
  }
  setAnalysisExportAvailability(ready);
  setAnalysisStatus(
    ready
      ? "Deep analysis is ready. You can download the report or complete study pack."
      : "这是旧版 Deep Analysis，仍可继续查看；需要时请点击“重新生成”升级报告。",
  );
}

/** Renders both the version-2 narrative and the legacy timeline sections. */
function renderAnalysisResults(analysis) {
  const results = document.getElementById("deepAnalysisResults");
  if (results) results.style.display = "block";
  const action = document.getElementById("deepAnalysisActionBtn");
  if (action) action.style.display = "none";
  const card = document.getElementById("deepAnalysisCard");
  card?.setAttribute("aria-busy", "false");
  renderAnalysisNarrative(analysis);
  // Chapters
  const chapterList = document.getElementById("chapterList");
  chapterList.innerHTML = "";
  analysisRecords(analysis.chapters).forEach((chapter) => {
    const li = document.createElement("li");
    li.className = "chapter-item";
    li.dataset.seconds = chapter.timestampSeconds;
    li.innerHTML = `
      <span class="chapter-timestamp">${escapeHtml(chapter.timestamp)}</span>
      <div class="chapter-content">
        <span class="chapter-title">${escapeHtml(chapter.title)}</span>
        <span class="chapter-summary">${escapeHtml(chapter.summary || "")}</span>
      </div>
    `;
    li.addEventListener("click", () => {
      debugLog(
        "[YouTube Digest Vocabulary Panel] Chapter clicked:",
        chapter.timestamp,
        chapter.timestampSeconds,
      );
      seekTo(chapter.timestampSeconds);
    });
    chapterList.appendChild(li);
  });

  // Quotes - sort by timestamp (chronological order)
  const quotesList = document.getElementById("quotesList");
  quotesList.innerHTML = "";
  const sortedQuotes = [...analysisRecords(analysis.keyQuotes)].sort(
    (a, b) => (a.timestampSeconds || 0) - (b.timestampSeconds || 0),
  );
  sortedQuotes.forEach((quote) => {
    const div = document.createElement("div");
    div.className = "quote-item";
    div.dataset.seconds = quote.timestampSeconds;
    div.innerHTML = `
      <div class="quote-text">${escapeHtml(quote.quote)}</div>
      <div class="quote-meta">
        <span class="quote-timestamp">${escapeHtml(quote.timestamp)}</span>
        <div class="quote-actions">
          <button class="quote-save-note-btn" title="Save this quote as a note">📝 Note</button>
          <button class="quote-copy-btn" title="Copy this quote">⧉ Copy</button>
        </div>
      </div>
    `;
    div.addEventListener("click", () => {
      debugLog(
        "[YouTube Digest Vocabulary Panel] Quote clicked:",
        quote.timestamp,
        quote.timestampSeconds,
      );
      seekTo(quote.timestampSeconds);
    });

    const quoteCopyBtn = div.querySelector(".quote-copy-btn");
    quoteCopyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const token = captureVideoSession();
      if (!isCurrentVideoSession(token)) return;
      try {
        if (!(await copyToClipboard(quote.quote, token))) return;
        if (!isCurrentVideoSession(token)) return;
        quoteCopyBtn.textContent = "✓ Copied";
        setTimeout(() => {
          if (!isCurrentVideoSession(token)) return;
          quoteCopyBtn.textContent = "⧉ Copy";
        }, 1500);
      } catch (err) {
        console.error("Copy failed:", err);
      }
    });

    const quoteSaveNoteBtn = div.querySelector(".quote-save-note-btn");
    quoteSaveNoteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await saveQuoteAsNote(quote, quoteSaveNoteBtn);
    });

    quotesList.appendChild(div);
  });
}

/**
 * Saves a key quote as a timestamped note.
 */
async function saveQuoteAsNote(quote, btn) {
  const token = captureVideoSession();
  if (!isCurrentVideoSession(token)) return;
  const videoTitle = currentVideoTitle;
  const channelName = currentChannelName;

  const originalText = btn.textContent;
  btn.textContent = "Saving...";
  btn.disabled = true;

  try {
    const result = await sendVideoSessionMessage({
      action: "saveNote",
      videoId: token.videoId,
      timestamp: quote.timestampSeconds,
      videoTitle,
      channelName,
    }, token);

    if (!isCurrentSessionResponse(token, result)) return;
    if (result.success) {
      btn.textContent = "✓ Saved";
      setTimeout(() => {
        if (!isCurrentVideoSession(token)) return;
        btn.textContent = originalText;
        btn.disabled = false;
      }, 1500);
      // Refresh notes list if on Notes tab
      void loadNotes(token.videoId, token);
    } else {
      console.error("[YouTube Digest Vocabulary] Save quote as note failed:", result.error);
      btn.textContent = "Error";
      setTimeout(() => {
        if (!isCurrentVideoSession(token)) return;
        btn.textContent = originalText;
        btn.disabled = false;
      }, 1500);
    }
  } catch (error) {
    if (!isCurrentVideoSession(token)) return;
    console.error("[YouTube Digest Vocabulary] Save quote as note error:", error);
    btn.textContent = "Error";
    setTimeout(() => {
      if (!isCurrentVideoSession(token)) return;
      btn.textContent = originalText;
      btn.disabled = false;
    }, 1500);
  }
}

/**
 * Legacy function for backwards compatibility with cached data.
 * Renders both transcript and analysis.
 */
function renderResults(analysis) {
  renderAnalysisResults(analysis);

  renderTranscript();

  document.getElementById("tabsNav").style.display = "flex";

  // Setup explain feature for text selection
  setupExplainFeature();
}

/**
 * Returns true while the user has a range of text selected.
 * Transcript row clicks must not seek in that state: the click emitted after
 * selection mouseup belongs to the selection/explain interaction, not playback.
 */
function hasNonCollapsedTextSelection() {
  const selection = window.getSelection();
  return Boolean(
    selection && selection.rangeCount > 0 && !selection.isCollapsed,
  );
}

/**
 * Preserves normal row-click seeking while keeping text selection inert.
 */
function seekFromTranscriptEntryClick(event, seconds) {
  if (hasNonCollapsedTextSelection()) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  seekTo(seconds);
}

function renderTranscript() {
  if (!currentTranscript) return;

  const transcriptList = document.getElementById("transcriptList");
  transcriptList.innerHTML = "";

  // Show a small badge indicating the transcript came from the video's
  // existing subtitles. (We no longer AI-transcribe audio, so subtitles
  // are the only source.)
  const existingBadge = document.getElementById("transcriptSourceBadge");
  if (existingBadge) existingBadge.remove();

  const badge = document.createElement("div");
  badge.id = "transcriptSourceBadge";
  badge.className = "transcript-source-badge";
  badge.innerHTML = `<span class="source-dot source-dot--subs"></span> From video subtitles · ${escapeHtml(getOriginalTranscriptLabel())}`;
  transcriptList.parentElement.insertBefore(badge, transcriptList);

  // Group entries using smart sentence-boundary + time-guardrail logic
  const grouped = currentTranscriptSegments;

  grouped.forEach((group) => {
    const div = document.createElement("div");
    div.className = "transcript-entry";
    div.dataset.seconds = group.start;
    div.dataset.sourceText = group.text;

    const minutes = Math.floor(group.start / 60);
    const seconds = Math.floor(group.start % 60);
    const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

    div.innerHTML = `
      <span class="transcript-time">${timestamp}</span>
      <span class="transcript-text">${renderVocabularyText(group.text)}</span>
    `;

    div.addEventListener("click", (event) =>
      seekFromTranscriptEntryClick(event, group.start),
    );
    transcriptList.appendChild(div);
  });

}

function captureVideoSnapshot(token = captureVideoSession()) {
  if (!isCurrentVideoSession(token)) return null;
  return Object.freeze({
    token,
    analysis: currentAnalysis,
    transcript: currentTranscript,
    transcriptSegments: currentTranscriptSegments,
    transcriptText: currentTranscriptText || "",
    transcriptLanguage: currentTranscriptLanguage || "",
    transcriptFingerprint: currentTranscriptFingerprint,
    videoId: token.videoId,
    videoUrl: currentVideoUrl || "",
    videoTitle: currentVideoTitle,
    channelName: currentChannelName,
    videoDescription: currentVideoDescription,
  });
}

function evidenceDialogControls() {
  return [
    document.getElementById("evidenceDialogCloseBtn"),
    document.getElementById("evidenceCopyBtn"),
    document.getElementById("evidenceSeekBtn"),
  ].filter((element) => element && !element.disabled);
}

function setupEvidenceDialogListeners() {
  if (evidenceDialogListenersReady) return;
  const dialog = document.getElementById("evidenceDialog");
  if (!dialog) return;
  document
    .getElementById("evidenceDialogCloseBtn")
    ?.addEventListener("click", () => closeEvidenceDialog());
  document
    .getElementById("evidenceCopyBtn")
    ?.addEventListener("click", copyActiveEvidenceText);
  document
    .getElementById("evidenceSeekBtn")
    ?.addEventListener("click", seekActiveEvidenceSource);
  dialog.addEventListener("keydown", handleEvidenceDialogKeydown);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeEvidenceDialog();
  });
  evidenceDialogListenersReady = true;
}

function renderEvidenceContext(element, label, context) {
  if (!element) return;
  element.textContent = context
    ? `${label} · ${formatVocabularyDisplayTimestamp(context.timestampSeconds)}\n${context.text}`
    : "";
}

function closeEvidenceDialog({ restoreFocus = true, clear = false } = {}) {
  const dialog = document.getElementById("evidenceDialog");
  const state = activeEvidenceDialog;
  activeEvidenceDialog = null;
  if (dialog?.open && typeof dialog.close === "function") dialog.close();
  else dialog?.removeAttribute("open");
  if (clear) {
    for (const id of [
      "evidenceTimestamp",
      "evidenceExactText",
      "evidencePreviousContext",
      "evidenceNextContext",
      "evidenceAiExplanation",
      "evidenceCopyStatus",
    ]) {
      const element = document.getElementById(id);
      if (element) element.textContent = "";
    }
  }
  if (
    restoreFocus &&
    state?.trigger?.isConnected &&
    isCurrentVideoSession(state.token)
  ) {
    state.trigger.focus?.();
  }
}

function handleEvidenceDialogKeydown(event) {
  if (!activeEvidenceDialog) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeEvidenceDialog();
    return;
  }
  if (event.key !== "Tab") return;
  const controls = evidenceDialogControls();
  if (!controls.length) {
    event.preventDefault();
    return;
  }
  const first = controls[0];
  const last = controls[controls.length - 1];
  const activeIndex = controls.indexOf(document.activeElement);
  if (event.shiftKey && (activeIndex <= 0)) {
    event.preventDefault();
    last.focus?.();
  } else if (!event.shiftKey && (activeIndex === -1 || activeIndex === controls.length - 1)) {
    event.preventDefault();
    first.focus?.();
  }
}

function openEvidenceDialog(
  conclusion,
  segmentId,
  token = captureVideoSession(),
  trigger = document.activeElement,
) {
  const snapshot = captureVideoSnapshot(token);
  if (!snapshot || typeof YTD_OVERVIEW?.buildEvidenceView !== "function") {
    return false;
  }
  const view = YTD_OVERVIEW.buildEvidenceView(
    snapshot.transcriptSegments,
    conclusion,
    segmentId,
  );
  if (!view?.sufficient || !isCurrentVideoSession(token)) return false;

  const dialog = document.getElementById("evidenceDialog");
  if (!dialog) return false;
  closeEvidenceDialog({ restoreFocus: false });
  document.getElementById("evidenceDialogTitle").textContent =
    view.conclusionTitleZh || "核对这条结论";
  document.getElementById("evidenceTimestamp").textContent =
    formatVocabularyDisplayTimestamp(view.timestampSeconds);
  document.getElementById("evidenceExactText").textContent = view.exactText;
  document.getElementById("evidenceAiExplanation").textContent =
    view.explanationZh;
  document.getElementById("evidenceCopyStatus").textContent = "";
  renderEvidenceContext(
    document.getElementById("evidencePreviousContext"),
    "前一段",
    view.previous,
  );
  renderEvidenceContext(
    document.getElementById("evidenceNextContext"),
    "后一段",
    view.next,
  );
  activeEvidenceDialog = Object.freeze({ token, trigger, view });
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  document.getElementById("evidenceDialogCloseBtn")?.focus?.();
  return true;
}

async function copyActiveEvidenceText() {
  const state = activeEvidenceDialog;
  if (!state || !isCurrentVideoSession(state.token)) return false;
  const copied = await copyToClipboard(state.view.exactText, state.token);
  if (!copied || activeEvidenceDialog !== state) return false;
  const status = document.getElementById("evidenceCopyStatus");
  if (status) status.textContent = "已复制这段逐字稿原文。";
  return true;
}

async function seekActiveEvidenceSource() {
  const state = activeEvidenceDialog;
  if (!state || !isCurrentVideoSession(state.token)) return false;
  await seekTo(state.view.timestampSeconds, state.token);
  return Boolean(
    activeEvidenceDialog === state && isCurrentVideoSession(state.token),
  );
}

function renderBasicOverview(
  overview,
  token = captureVideoSession(),
  { cacheWarning = false } = {},
) {
  if (!isCurrentVideoSession(token)) return false;
  const snapshot = captureVideoSnapshot(token);
  if (!snapshot || !usableBasicOverview(overview, snapshot.transcriptFingerprint)) {
    return false;
  }

  const state = document.getElementById("overviewState");
  const loading = document.getElementById("overviewLoadingState");
  const message = document.getElementById("overviewErrorState");
  const ready = document.getElementById("overviewReadyState");
  const badge = document.getElementById("overviewStatusBadge");
  const takeaway = document.getElementById("overviewOneSentence");
  const conclusions = document.getElementById("overviewConclusions");
  const chapters = document.getElementById("overviewChapterList");
  const warning = document.getElementById("overviewCacheWarning");
  const warningMessage = document.getElementById(
    "overviewCacheWarningMessage",
  );
  const warningRetryButton = document.getElementById("overviewCacheRetryBtn");

  state?.setAttribute("aria-busy", "false");
  if (loading) loading.style.display = "none";
  if (message) message.style.display = "none";
  if (ready) ready.style.display = "grid";
  if (badge) {
    badge.textContent = overview.complete ? "概览就绪" : "部分概览";
    badge.dataset.state = overview.complete ? "ready" : "partial";
  }
  if (takeaway) takeaway.textContent = overview.oneSentenceZh;

  conclusions?.replaceChildren();
  const conclusionItems = Array.isArray(overview.conclusions)
    ? overview.conclusions
    : [];
  for (const [index, conclusion] of conclusionItems.entries()) {
    const article = document.createElement("article");
    article.className = "overview-conclusion-card";
    const number = document.createElement("span");
    number.className = "overview-conclusion-number";
    number.textContent = String(index + 1).padStart(2, "0");
    const copy = document.createElement("div");
    copy.className = "overview-conclusion-copy";
    const title = document.createElement("h3");
    title.textContent = conclusion.titleZh;
    const explanation = document.createElement("p");
    explanation.textContent = conclusion.explanationZh;
    const evidenceList = document.createElement("div");
    evidenceList.className = "overview-evidence-list";
    const evidence = document.createElement("span");
    evidence.className = `overview-evidence-summary overview-evidence-summary--${conclusion.evidenceLevel}`;
    const evidenceCount = Array.isArray(conclusion.evidenceSegmentIds)
      ? conclusion.evidenceSegmentIds.length
      : 0;
    const evidenceLabel = {
      strong: "证据充足",
      partial: "部分证据",
      insufficient: "证据不足",
    }[conclusion.evidenceLevel] || "证据不足";
    evidence.textContent = evidenceCount
      ? `${evidenceLabel} · ${evidenceCount} 段原文`
      : evidenceLabel;
    evidenceList.appendChild(evidence);
    for (const segmentId of Array.isArray(conclusion.evidenceSegmentIds)
      ? conclusion.evidenceSegmentIds
      : []) {
      const evidenceView = YTD_OVERVIEW?.buildEvidenceView?.(
        snapshot.transcriptSegments,
        conclusion,
        segmentId,
      );
      if (!evidenceView?.sufficient) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "overview-evidence-btn";
      button.textContent = `查看原文 ${formatVocabularyDisplayTimestamp(evidenceView.timestampSeconds)}`;
      button.addEventListener("click", () =>
        openEvidenceDialog(conclusion, segmentId, token, button),
      );
      evidenceList.appendChild(button);
    }
    copy.append(title, explanation, evidenceList);
    article.append(number, copy);
    conclusions?.appendChild(article);
  }
  if (conclusions && conclusionItems.length === 0) {
    const empty = document.createElement("p");
    empty.className = "overview-empty-copy";
    empty.textContent = "当前结果没有足够的本地证据形成核心结论。";
    conclusions.appendChild(empty);
  }

  chapters?.replaceChildren();
  const chapterItems = Array.isArray(overview.chapters)
    ? overview.chapters
    : [];
  for (const chapter of chapterItems) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "overview-chapter-btn";
    const time = document.createElement("span");
    time.className = "overview-chapter-time";
    time.textContent = formatVocabularyDisplayTimestamp(
      chapter.timestampSeconds,
    );
    const copy = document.createElement("span");
    copy.className = "overview-chapter-copy";
    const title = document.createElement("strong");
    title.textContent = chapter.titleZh;
    const summary = document.createElement("span");
    summary.textContent = chapter.summaryZh;
    copy.append(title, summary);
    button.append(time, copy);
    button.addEventListener("click", () =>
      seekTo(chapter.timestampSeconds, token),
    );
    item.appendChild(button);
    chapters?.appendChild(item);
  }
  if (chapters && chapterItems.length === 0) {
    const empty = document.createElement("li");
    empty.className = "overview-empty-copy";
    empty.textContent = "章节时间线尚未完整生成。";
    chapters.appendChild(empty);
  }

  const cacheFailure = currentBasicOverviewFailure;
  const hasCacheWarning = Boolean(
    cacheWarning ||
      cacheFailure?.stage === "overview_cache" ||
      cacheFailure?.code === "OVERVIEW_CACHE_WRITE_FAILED" ||
      cacheFailure?.code === "OVERVIEW_CACHE_RECOVERY_UNAVAILABLE",
  );
  const canRetryCacheWrite = Boolean(
    cacheFailure?.code === "OVERVIEW_CACHE_WRITE_FAILED" &&
      typeof cacheFailure?.recoveryToken === "string" &&
      cacheFailure.recoveryToken,
  );
  if (warning) warning.style.display = hasCacheWarning ? "flex" : "none";
  if (warningMessage) {
    warningMessage.textContent = !hasCacheWarning
      ? ""
      : cacheFailure?.code === "OVERVIEW_CACHE_RECOVERY_UNAVAILABLE"
        ? "基础概览仍可在当前面板查看，但本次缓存恢复凭证已经失效，无法继续重试本地保存。"
        : "基础概览已经生成，但暂时未能写入本地缓存。仅重试保存不会再次调用 AI。";
  }
  if (warningRetryButton) {
    warningRetryButton.style.display = canRetryCacheWrite
      ? "inline-flex"
      : "none";
  }
  basicOverviewPresentation = Object.freeze({
    sessionId: token.sessionId,
    kind: overview.complete ? "ready" : "partial",
    disposition: hasCacheWarning ? "cache_warning" : "",
    retryAfterMs: 0,
  });
  return true;
}

function resetBasicOverviewUi() {
  const state = document.getElementById("overviewState");
  state?.setAttribute("aria-busy", "false");
  const loading = document.getElementById("overviewLoadingState");
  if (loading) loading.style.display = "flex";
  const loadingTitle = document.getElementById("overviewLoadingTitle");
  if (loadingTitle) loadingTitle.textContent = "正在准备基础概览";
  const loadingMessage = document.getElementById("overviewLoadingMessage");
  if (loadingMessage) {
    loadingMessage.textContent = "字幕就绪后，会在这里整理可核验的结论。";
  }
  for (const id of ["overviewErrorState", "overviewReadyState"]) {
    const element = document.getElementById(id);
    if (element) element.style.display = "none";
  }
  const conclusions = document.getElementById("overviewConclusions");
  conclusions?.replaceChildren();
  const chapters = document.getElementById("overviewChapterList");
  chapters?.replaceChildren();
  const warning = document.getElementById("overviewCacheWarning");
  if (warning) warning.style.display = "none";
  const cacheRetryButton = document.getElementById("overviewCacheRetryBtn");
  if (cacheRetryButton) {
    cacheRetryButton.disabled = false;
    cacheRetryButton.textContent = "仅重试本地保存";
    cacheRetryButton.style.display = "inline-flex";
  }
  for (const id of ["overviewPrimaryActionBtn", "overviewSecondaryActionBtn"]) {
    const button = document.getElementById(id);
    if (!button) continue;
    button.textContent = "";
    button.style.display = "none";
    button.disabled = false;
  }
  overviewPrimaryAction = null;
  overviewSecondaryAction = null;
}

function showBasicOverviewPreparing(token = captureVideoSession()) {
  if (!isCurrentVideoSession(token)) return false;
  const state = document.getElementById("overviewState");
  state?.setAttribute("aria-busy", "true");
  const loading = document.getElementById("overviewLoadingState");
  if (loading) loading.style.display = "flex";
  const title = document.getElementById("overviewLoadingTitle");
  if (title) title.textContent = "字幕已就绪，正在准备基础概览";
  const message = document.getElementById("overviewLoadingMessage");
  if (message) message.textContent = "先确认本地缓存，再决定是否调用 AI。";
  const error = document.getElementById("overviewErrorState");
  if (error) error.style.display = "none";
  const ready = document.getElementById("overviewReadyState");
  if (ready) ready.style.display = "none";
  basicOverviewPresentation = Object.freeze({
    sessionId: token.sessionId,
    kind: "preparing",
    disposition: "",
    retryAfterMs: 0,
  });
  return true;
}

function showBasicOverviewLoading(token = captureVideoSession()) {
  if (!showBasicOverviewPreparing(token)) return false;
  const title = document.getElementById("overviewLoadingTitle");
  if (title) title.textContent = "正在生成基础概览";
  const message = document.getElementById("overviewLoadingMessage");
  if (message) {
    message.textContent = "字幕仍可随时阅读。基础概览完成后会自动出现在这里。";
  }
  basicOverviewPresentation = Object.freeze({
    sessionId: token.sessionId,
    kind: "loading",
    disposition: "",
    retryAfterMs: 0,
  });
  return true;
}

function showBasicOverviewMessage(
  {
    kind = "guidance",
    title = "基础概览暂不可用",
    message = "你仍可继续阅读字幕。",
    costNote = "",
    primaryLabel = "",
    primaryAction = null,
    secondaryLabel = "",
    secondaryAction = null,
    disposition = "",
    retryAfterMs = 0,
  },
  token = captureVideoSession(),
) {
  if (!isCurrentVideoSession(token)) return false;
  const state = document.getElementById("overviewState");
  state?.setAttribute("aria-busy", "false");
  const loading = document.getElementById("overviewLoadingState");
  if (loading) loading.style.display = "none";
  const ready = document.getElementById("overviewReadyState");
  if (ready) ready.style.display = "none";
  const error = document.getElementById("overviewErrorState");
  if (error) {
    error.style.display = "flex";
    error.setAttribute("role", kind === "error" ? "alert" : "status");
    error.dataset.state = kind;
  }
  const titleElement = document.getElementById("overviewErrorTitle");
  if (titleElement) titleElement.textContent = title;
  const messageElement = document.getElementById("overviewErrorMessage");
  if (messageElement) messageElement.textContent = message;
  const costElement = document.getElementById("overviewErrorCostNote");
  if (costElement) {
    costElement.textContent = costNote;
    costElement.style.display = costNote ? "block" : "none";
  }

  const primaryButton = document.getElementById("overviewPrimaryActionBtn");
  if (primaryButton) {
    primaryButton.textContent = primaryLabel;
    primaryButton.style.display = primaryLabel ? "inline-flex" : "none";
    primaryButton.disabled = false;
  }
  overviewPrimaryAction =
    typeof primaryAction === "function"
      ? () => isCurrentVideoSession(token) && primaryAction()
      : null;
  const secondaryButton = document.getElementById(
    "overviewSecondaryActionBtn",
  );
  if (secondaryButton) {
    secondaryButton.textContent = secondaryLabel;
    secondaryButton.style.display = secondaryLabel ? "inline-flex" : "none";
    secondaryButton.disabled = false;
  }
  overviewSecondaryAction =
    typeof secondaryAction === "function"
      ? () => isCurrentVideoSession(token) && secondaryAction()
      : null;
  basicOverviewPresentation = Object.freeze({
    sessionId: token.sessionId,
    kind,
    disposition,
    retryAfterMs,
  });
  return true;
}

function boundedOverviewDisposition(value) {
  return [
    "cached",
    "claimed",
    "failed",
    "inflight",
    "interrupted",
    "result_missing",
    "stored",
  ].includes(value)
    ? value
    : "";
}

function boundedOverviewRetryAfter(value) {
  return Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, 180_000)
    : 0;
}

function overviewRetryCopy(retryAfterMs) {
  if (!retryAfterMs) return "";
  return ` 建议约 ${Math.max(1, Math.ceil(retryAfterMs / 1000))} 秒后再检查。`;
}

function renderBasicOverviewOutcome(result, token = captureVideoSession()) {
  if (!isCurrentVideoSession(token)) return false;
  const snapshot = captureVideoSnapshot(token);
  if (!snapshot) return false;
  if (usableBasicOverview(currentBasicOverview, snapshot.transcriptFingerprint)) {
    return renderBasicOverview(currentBasicOverview, token, {
      cacheWarning:
        currentBasicOverviewFailure?.code === "OVERVIEW_CACHE_WRITE_FAILED",
    });
  }

  const disposition = boundedOverviewDisposition(result?.disposition);
  const retryAfterMs = boundedOverviewRetryAfter(result?.retryAfterMs);
  if (result?.success === true && result?.skipped === "already_attempted") {
    if (disposition === "inflight") {
      return showBasicOverviewMessage(
        {
          kind: "guidance",
          title: "基础概览正在另一项任务中生成",
          message: `同一份字幕不会重复调用 AI。${overviewRetryCopy(retryAfterMs)}`.trim(),
          primaryLabel: "稍后检查",
          primaryAction: () => runBasicOverviewRequest("manual_retry", token),
          disposition,
          retryAfterMs,
        },
        token,
      );
    }
    if (disposition === "interrupted" || disposition === "result_missing") {
      return showBasicOverviewMessage(
        {
          kind: "error",
          title: "上一次基础概览没有留下可用结果",
          message: "字幕与本地缓存仍然可用，可只重试基础概览。",
          primaryLabel: "重试概览",
          primaryAction: () => runBasicOverviewRequest("manual_retry", token),
          disposition,
          retryAfterMs,
        },
        token,
      );
    }
  }

  const failure = currentBasicOverviewFailure ||
    (result?.success === false ? result : null);
  if (failure?.code === "AUTO_OVERVIEW_DISABLED") {
    return showBasicOverviewMessage(
      {
        kind: "guidance",
        title: "自动概览尚未授权",
        message:
          "你可以手动生成一次基础概览；是否为后续视频自动生成，可在设置中决定。",
        primaryLabel: "手动生成一次",
        primaryAction: () => runBasicOverviewRequest("manual_retry", token),
        secondaryLabel: "打开设置",
        secondaryAction: () =>
          chrome.runtime.sendMessage({ action: "openOptions" }),
      },
      token,
    );
  }
  if (failure?.code === "MISSING_KEY") {
    return showBasicOverviewMessage(
      {
        kind: "guidance",
        title: "基础概览需要 DeepSeek API Key",
        message: "字幕已经可用。添加分析密钥后，可在这里生成可核验概览。",
        primaryLabel: "打开设置",
        primaryAction: () =>
          chrome.runtime.sendMessage({ action: "openOptions" }),
      },
      token,
    );
  }
  if (failure?.code === "NETWORK_ERROR") {
    return showBasicOverviewMessage(
      {
        kind: "guidance",
        title: "当前离线，基础概览尚未生成",
        message: "字幕仍可阅读。网络恢复后，只需重试概览。",
        primaryLabel: "重试概览",
        primaryAction: () => runBasicOverviewRequest("manual_retry", token),
      },
      token,
    );
  }
  if (failure?.code === "DIGEST_BASE_NOT_READY") {
    return showBasicOverviewMessage(
      {
        kind: "error",
        title: "本地缓存尚未就绪",
        message: "字幕已保留；恢复本地缓存后才会发送基础概览请求。",
        primaryLabel: "重试概览",
        primaryAction: () => runBasicOverviewRequest("manual_retry", token),
      },
      token,
    );
  }

  if (failure) {
    const presentation = providerFailurePresentation(failure, "overview");
    const primary = presentation.primaryAction;
    const secondary = presentation.secondaryAction;
    return showBasicOverviewMessage(
      {
        kind: "error",
        title: presentation.title,
        message: presentation.message,
        costNote: presentation.creditNote,
        primaryLabel: primary.label,
        primaryAction: () =>
          runProviderRecovery(primary, {
            stage: "overview",
            provider: presentation.provider,
            retry: () => runBasicOverviewRequest("manual_retry", token),
          }),
        secondaryLabel: secondary.label,
        secondaryAction: () =>
          runProviderRecovery(secondary, {
            stage: "overview",
            provider: presentation.provider,
            retry: () => runBasicOverviewRequest("manual_retry", token),
          }),
        disposition,
        retryAfterMs,
      },
      token,
    );
  }

  return showBasicOverviewMessage(
    {
      kind: "guidance",
      title: "基础概览尚未生成",
      message: "字幕已经可用，你可以现在手动生成一次。",
      primaryLabel: "手动生成一次",
      primaryAction: () => runBasicOverviewRequest("manual_retry", token),
    },
    token,
  );
}

async function runBasicOverviewRequest(
  intent = "manual_retry",
  token = captureVideoSession(),
) {
  if (!isCurrentVideoSession(token)) return null;
  showBasicOverviewLoading(token);
  const result = await requestBasicOverview(intent, token);
  if (!isCurrentVideoSession(token)) return result;
  renderBasicOverviewOutcome(result, token);
  return result;
}

async function runBasicOverviewCacheRetry(token = captureVideoSession()) {
  if (!isCurrentVideoSession(token)) return null;
  const button = document.getElementById("overviewCacheRetryBtn");
  if (button) {
    button.disabled = true;
    button.textContent = "正在保存…";
  }
  const result = await retryBasicOverviewCacheWrite(token);
  if (!isCurrentVideoSession(token)) return result;
  if (button) {
    button.disabled = false;
    button.textContent = "仅重试本地保存";
  }
  renderBasicOverviewOutcome(result, token);
  return result;
}

function resetDeepAnalysisUi() {
  const card = document.getElementById("deepAnalysisCard");
  card?.setAttribute("aria-busy", "false");
  const action = document.getElementById("deepAnalysisActionBtn");
  if (action) {
    action.disabled = false;
    action.textContent = "生成深度分析";
    action.style.display = "inline-flex";
  }
  const results = document.getElementById("deepAnalysisResults");
  if (results) results.style.display = "none";
  setAnalysisStatus("尚未生成，不会自动消耗额度。");
}

// ============================================================
// BASIC OVERVIEW ORCHESTRATION
// ============================================================

function panelOverviewFailure(code, stage = "overview") {
  const behavior = {
    MISSING_KEY: { retryable: false, primaryAction: "open_settings" },
    NETWORK_ERROR: { retryable: true, primaryAction: "retry" },
    AUTO_OVERVIEW_DISABLED: { retryable: false, primaryAction: "none" },
    DIGEST_BASE_NOT_READY: { retryable: true, primaryAction: "retry" },
    MALFORMED_RESPONSE: { retryable: false, primaryAction: "none" },
    OVERVIEW_CACHE_RECOVERY_UNAVAILABLE: {
      retryable: false,
      primaryAction: "none",
    },
  }[code] || { retryable: false, primaryAction: "none" };
  return {
    success: false,
    code,
    provider: "deepseek",
    stage,
    retryable: behavior.retryable,
    primaryAction: behavior.primaryAction,
    mayHaveConsumedCredit: false,
  };
}

function boundedBasicOverviewFailure(result, stage = "overview") {
  const code =
    typeof result?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(result.code)
      ? result.code
      : "MALFORMED_RESPONSE";
  const primaryAction = [
    "none",
    "retry",
    "open_settings",
    "retry_cache_write",
  ].includes(result?.primaryAction)
    ? result.primaryAction
    : "none";
  const failure = {
    success: false,
    code,
    provider: "deepseek",
    stage: result?.stage === "overview_cache" ? "overview_cache" : stage,
    retryable: result?.retryable === true,
    primaryAction,
    mayHaveConsumedCredit: result?.mayHaveConsumedCredit === true,
  };
  if (result?.providerSucceeded === true) failure.providerSucceeded = true;
  const disposition = boundedOverviewDisposition(result?.disposition);
  if (disposition) failure.disposition = disposition;
  const retryAfterMs = boundedOverviewRetryAfter(result?.retryAfterMs);
  if (retryAfterMs) failure.retryAfterMs = retryAfterMs;
  if (
    code === "OVERVIEW_CACHE_WRITE_FAILED" &&
    result?.providerSucceeded === true &&
    typeof result?.recoveryToken === "string" &&
    result.recoveryToken.length > 0 &&
    result.recoveryToken.length <= 512
  ) {
    failure.recoveryToken = result.recoveryToken;
  }
  return failure;
}

function usableBasicOverview(value, transcriptFingerprint) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof transcriptFingerprint === "string" &&
      value.transcriptFingerprint === transcriptFingerprint &&
      typeof value.oneSentenceZh === "string" &&
      value.oneSentenceZh.trim(),
  );
}

function normalizePanelBasicOverview(value, snapshot) {
  if (
    !snapshot ||
    !usableBasicOverview(value, snapshot.transcriptFingerprint) ||
    !Number.isSafeInteger(value.generatedAt) ||
    value.generatedAt < 0
  ) return null;
  try {
    const overview = YTD_OVERVIEW.normalizeBasicOverview(
      value,
      snapshot.transcriptSegments,
      {
        transcriptFingerprint: snapshot.transcriptFingerprint,
        generatedAt: value.generatedAt,
      },
    );
    return usableBasicOverview(overview, snapshot.transcriptFingerprint)
      ? overview
      : null;
  } catch {
    return null;
  }
}

function basicOverviewSessionState(token) {
  if (!isCurrentVideoSession(token)) return null;
  if (!basicOverviewRequestSession.sessionId) {
    basicOverviewRequestSession.sessionId = token.sessionId;
  }
  return basicOverviewRequestSession.sessionId === token.sessionId
    ? basicOverviewRequestSession
    : null;
}

async function requestBasicOverview(
  intent = "automatic",
  token = captureVideoSession(),
) {
  if (intent !== "automatic" && intent !== "manual_retry") {
    return panelOverviewFailure("MALFORMED_RESPONSE");
  }
  let snapshot = captureVideoSnapshot(token);
  const requestSession = basicOverviewSessionState(token);
  if (!snapshot || !requestSession) return null;
  const transcriptFingerprint = snapshot.transcriptFingerprint;
  if (
    typeof transcriptFingerprint !== "string" ||
    !/^sha256-v1-[a-f0-9]{64}$/.test(transcriptFingerprint) ||
    !Array.isArray(snapshot.transcriptSegments) ||
    snapshot.transcriptSegments.length === 0
  ) {
    return panelOverviewFailure("DIGEST_BASE_NOT_READY");
  }

  const existing = requestSession.inFlightByFingerprint.get(
    transcriptFingerprint,
  );
  if (existing) return existing;
  if (
    intent === "automatic" &&
    requestSession.automaticRequestedFingerprints.has(transcriptFingerprint)
  ) {
    return { success: true, skipped: "already_requested" };
  }
  if (
    intent === "automatic" &&
    currentConfigStatus.autoBasicOverview !== true
  ) {
    return panelOverviewFailure("AUTO_OVERVIEW_DISABLED");
  }
  if (currentConfigStatus.hasAiKey !== true) {
    return panelOverviewFailure("MISSING_KEY");
  }
  if (globalThis.navigator?.onLine === false) {
    return panelOverviewFailure("NETWORK_ERROR");
  }

  if (!digestBaseIsFresh(token)) {
    const renewed = await ensureDigestBaseReady(token);
    if (!renewed || !isCurrentVideoSession(token)) {
      return panelOverviewFailure("DIGEST_BASE_NOT_READY");
    }
    snapshot = captureVideoSnapshot(token);
    if (
      !snapshot ||
      snapshot.transcriptFingerprint !== transcriptFingerprint ||
      basicOverviewSessionState(token) !== requestSession
    ) return null;
    const renewedExisting = requestSession.inFlightByFingerprint.get(
      transcriptFingerprint,
    );
    if (renewedExisting) return renewedExisting;
    if (
      intent === "automatic" &&
      requestSession.automaticRequestedFingerprints.has(transcriptFingerprint)
    ) {
      return { success: true, skipped: "already_requested" };
    }
    if (
      intent === "automatic" &&
      currentConfigStatus.autoBasicOverview !== true
    ) {
      return panelOverviewFailure("AUTO_OVERVIEW_DISABLED");
    }
    if (currentConfigStatus.hasAiKey !== true) {
      return panelOverviewFailure("MISSING_KEY");
    }
    if (globalThis.navigator?.onLine === false) {
      return panelOverviewFailure("NETWORK_ERROR");
    }
  }

  const segments = snapshot.transcriptSegments.map((segment) => ({
    id: segment.id,
    start: segment.start,
    text: segment.text,
  }));
  const message = {
    action: "requestBasicOverview",
    videoId: snapshot.videoId,
    intent,
    payload: {
      transcriptFingerprint,
      transcriptLanguage: snapshot.transcriptLanguage,
      segments,
      videoTitle: snapshot.videoTitle,
      channelName: snapshot.channelName,
    },
  };
  if (intent === "automatic") {
    requestSession.automaticRequestedFingerprints.add(transcriptFingerprint);
  }

  const promise = (async () => {
    let response;
    try {
      response = await sendVideoSessionMessage(message, token);
    } catch {
      const failure = panelOverviewFailure("NETWORK_ERROR");
      if (isCurrentVideoSession(token)) currentBasicOverviewFailure = failure;
      return failure;
    }
    if (!isCurrentSessionResponse(token, response)) return null;

    const overview = normalizePanelBasicOverview(response?.overview, snapshot);
    if (response?.success === true) {
      if (response?.overview && !overview) {
        const failure = panelOverviewFailure("MALFORMED_RESPONSE");
        currentBasicOverviewFailure = failure;
        return failure;
      }
      if (overview) {
        currentBasicOverview = overview;
        currentBasicOverviewFailure = null;
        return { success: true, overview };
      }
      const durableFailure =
        response?.failure && typeof response.failure === "object"
          ? boundedBasicOverviewFailure(response.failure)
          : null;
      if (
        durableFailure &&
        !usableBasicOverview(
          currentBasicOverview,
          snapshot.transcriptFingerprint,
        )
      ) {
        currentBasicOverviewFailure = durableFailure;
      }
      return {
        success: true,
        ...(typeof response?.skipped === "string"
          ? { skipped: response.skipped.slice(0, 64) }
          : {}),
        ...(boundedOverviewDisposition(response?.disposition)
          ? { disposition: boundedOverviewDisposition(response.disposition) }
          : {}),
        ...(boundedOverviewRetryAfter(response?.retryAfterMs)
          ? { retryAfterMs: boundedOverviewRetryAfter(response.retryAfterMs) }
          : {}),
        ...(durableFailure ? { failure: durableFailure } : {}),
      };
    }

    const failure = boundedBasicOverviewFailure(response);
    if (failure.providerSucceeded === true && overview) {
      currentBasicOverview = overview;
    }
    currentBasicOverviewFailure = failure;
    return failure;
  })();
  requestSession.inFlightByFingerprint.set(transcriptFingerprint, promise);
  try {
    return await promise;
  } finally {
    if (
      basicOverviewRequestSession === requestSession &&
      requestSession.sessionId === token.sessionId &&
      requestSession.inFlightByFingerprint.get(transcriptFingerprint) === promise
    ) {
      requestSession.inFlightByFingerprint.delete(transcriptFingerprint);
    }
  }
}

async function maybeRequestAutomaticBasicOverview(
  token = captureVideoSession(),
) {
  const snapshot = captureVideoSnapshot(token);
  if (!snapshot || !currentDigestBaseReady) return null;
  if (usableBasicOverview(currentBasicOverview, snapshot.transcriptFingerprint)) {
    renderBasicOverview(currentBasicOverview, token, {
      cacheWarning:
        currentBasicOverviewFailure?.code === "OVERVIEW_CACHE_WRITE_FAILED",
    });
    return { success: true, skipped: "cached" };
  }
  if (currentConfigStatus.hasAiKey !== true) {
    const result = panelOverviewFailure("MISSING_KEY");
    renderBasicOverviewOutcome(result, token);
    return result;
  }
  if (globalThis.navigator?.onLine === false) {
    const result = panelOverviewFailure("NETWORK_ERROR");
    renderBasicOverviewOutcome(result, token);
    return result;
  }
  if (currentConfigStatus.autoBasicOverview !== true) {
    const result = panelOverviewFailure("AUTO_OVERVIEW_DISABLED");
    renderBasicOverviewOutcome(result, token);
    return result;
  }
  return runBasicOverviewRequest("automatic", token);
}

async function retryBasicOverviewCacheWrite(token = captureVideoSession()) {
  const snapshot = captureVideoSnapshot(token);
  if (!snapshot) return null;
  const recoveryToken =
    currentBasicOverviewFailure?.code === "OVERVIEW_CACHE_WRITE_FAILED" &&
    typeof currentBasicOverviewFailure?.recoveryToken === "string"
      ? currentBasicOverviewFailure.recoveryToken
      : "";
  if (!recoveryToken) {
    return panelOverviewFailure(
      "OVERVIEW_CACHE_RECOVERY_UNAVAILABLE",
      "overview_cache",
    );
  }

  let response;
  try {
    response = await sendVideoSessionMessage({
      action: "retryBasicOverviewCacheWrite",
      videoId: snapshot.videoId,
      recoveryToken,
    }, token);
  } catch {
    return panelOverviewFailure("NETWORK_ERROR", "overview_cache");
  }
  if (!isCurrentSessionResponse(token, response)) return null;

  const overview = normalizePanelBasicOverview(response?.overview, snapshot);
  if (response?.success === true && overview) {
    currentBasicOverview = overview;
    currentBasicOverviewFailure = null;
    const disposition = boundedOverviewDisposition(response?.disposition);
    return {
      success: true,
      overview,
      ...(disposition ? { disposition } : {}),
    };
  }
  const failure = boundedBasicOverviewFailure(response, "overview_cache");
  if (failure.providerSucceeded === true && overview) {
    currentBasicOverview = overview;
  }
  currentBasicOverviewFailure = failure;
  return failure;
}

function captureTranscriptModeSnapshot(token = captureVideoSession()) {
  const video = captureVideoSnapshot(token);
  if (!video) return null;
  const translationLookup = new Map();
  for (const segment of video.transcriptSegments) {
    const key = transcriptTranslationCacheKey(segment, video.videoId);
    const translated = key ? transcriptParagraphCache.get(key) : "";
    if (translated) translationLookup.set(segment.id, translated);
  }
  const transcriptMode = buildTranscriptModeSnapshot({
    segments: video.transcriptSegments,
    mode: currentTranscriptMode,
    translationLookup,
  });
  return Object.freeze({ ...video, transcriptMode });
}

function transcriptExportLabels(mode, complete) {
  if (mode === "zh") {
    return complete
      ? ["复制中文", "导出中文 TXT", "导出中文 Clean MD"]
      : ["翻译并复制中文", "翻译并导出 TXT", "翻译并导出 Clean MD"];
  }
  if (mode === "bilingual") {
    return complete
      ? ["复制双语", "导出双语 TXT", "导出双语 Clean MD"]
      : ["翻译并复制双语", "翻译并导出双语 TXT", "翻译并导出双语 Clean MD"];
  }
  return ["Copy", "TXT", "Clean MD"];
}

function updateTranscriptExportControls(
  mode = currentTranscriptMode,
  { busy = null } = {},
) {
  const snapshot = captureTranscriptModeSnapshot();
  const complete = snapshot?.transcriptMode?.complete ?? mode === "original";
  const labels = transcriptExportLabels(mode, complete);
  const controls = [
    document.getElementById("copyTranscriptBtn"),
    document.getElementById("exportTranscriptBtn"),
    document.getElementById("exportCleanTranscriptBtn"),
  ];
  const resolvedBusy = busy ?? Boolean(
    transcriptExportPreparation && transcriptExportPreparation.mode === mode
  );
  controls.forEach((button, index) => {
    if (!button) return;
    button.textContent = labels[index];
    button.disabled = resolvedBusy;
    button.setAttribute("aria-busy", String(resolvedBusy));
    button.setAttribute("aria-label", labels[index]);
  });
}

async function prepareTranscriptModeExport(
  token = captureVideoSession(),
  mode = currentTranscriptMode,
) {
  let snapshot = captureTranscriptModeSnapshot(token);
  if (!snapshot || snapshot.transcriptMode.mode !== mode) return null;
  if (snapshot.transcriptMode.complete) return snapshot;
  if (transcriptExportPreparation?.sessionId === token.sessionId &&
      transcriptExportPreparation.mode === mode) {
    return transcriptExportPreparation.promise;
  }

  const promise = (async () => {
    updateTranscriptExportControls(mode, { busy: true });
    setTranscriptExportStatus(
      `正在翻译 ${snapshot.transcriptMode.missingSegmentIds.length} 段后导出。这会调用 DeepSeek，可能产生费用。`,
    );
    if (
      !activeTranslationQueue ||
      activeTranslationQueue.sessionId !== token.sessionId ||
      activeTranslationQueue.mode !== mode
    ) {
      await translateTranscript(token);
    }
    if (!isCurrentVideoSession(token) || currentTranscriptMode !== mode) {
      return null;
    }
    const queue = activeTranslationQueue;
    if (
      !queue ||
      queue.sessionId !== token.sessionId ||
      queue.mode !== mode
    ) return null;
    snapshot = captureTranscriptModeSnapshot(token);
    const missing = new Set(snapshot.transcriptMode.missingSegmentIds);
    const indices = snapshot.transcriptSegments
      .map((segment, index) => (missing.has(segment.id) ? index : -1))
      .filter((index) => index >= 0);
    queue.ensureAll(indices);
    await queue.whenIdle();
    if (!isCurrentVideoSession(token) || currentTranscriptMode !== mode) {
      return null;
    }
    const completed = captureTranscriptModeSnapshot(token);
    if (!completed?.transcriptMode.complete) {
      const failed = completed?.transcriptMode.missingSegmentIds.length || 0;
      setTranscriptExportStatus(
        `仍有 ${failed} 段翻译失败，已阻止导出，不会回退为 Original。`,
      );
      return null;
    }
    return completed;
  })();
  transcriptExportPreparation = { sessionId: token.sessionId, mode, promise };
  try {
    return await promise;
  } finally {
    if (transcriptExportPreparation?.promise === promise) {
      transcriptExportPreparation = null;
    }
    if (isCurrentVideoSession(token) && currentTranscriptMode === mode) {
      updateTranscriptExportControls(mode);
    }
  }
}

async function copyTranscript() {
  const token = captureVideoSession();
  const snapshot = await prepareTranscriptModeExport(token, currentTranscriptMode);
  if (!snapshot || !isCurrentVideoSession(token)) return;
  await copyToClipboardWithFeedback(
    snapshot.transcriptMode.plainText,
    "copyTranscriptBtn",
    snapshot.token,
  );
}

async function exportTranscript() {
  const token = captureVideoSession();
  const snapshot = await prepareTranscriptModeExport(token, currentTranscriptMode);
  if (!snapshot || !isCurrentVideoSession(token)) return;
  const transcriptContent = snapshot.transcriptMode.plainText;
  const videoUrl = `https://youtube.com/watch?v=${snapshot.videoId}`;

  let exportText = "";
  exportText += `TRANSCRIPT${snapshot.transcriptMode.mode === "original" ? "" : ` (${snapshot.transcriptMode.label})`}\n`;
  exportText += `${"=".repeat(60)}\n\n`;
  exportText += `Title: ${snapshot.videoTitle || "Unknown"}\n`;
  exportText += `Channel: ${snapshot.channelName || "Unknown"}\n`;
  exportText += `URL: ${videoUrl}\n`;
  exportText += `\n${"—".repeat(60)}\n\n`;

  if (snapshot.videoDescription) {
    exportText += `DESCRIPTION:\n${snapshot.videoDescription}\n`;
    exportText += `\n${"—".repeat(60)}\n\n`;
  }

  exportText += `TRANSCRIPT:\n\n${transcriptContent}\n`;
  exportText += `\n${"—".repeat(60)}\n`;
  exportText += `Exported by YouTube Digest Vocabulary\n`;

  const filename = `${sanitizeFilename(snapshot.videoTitle)}-transcript.txt`;
  if (!isCurrentVideoSession(snapshot.token)) return;
  if (
    downloadTextFile(
      exportText,
      filename,
      "text/plain;charset=utf-8",
      snapshot.token,
    )
  ) {
    setTranscriptExportStatus(`已导出 ${snapshot.transcriptMode.label} TXT。`);
  }
}

function escapeMarkdownText(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/([\[\]_*{}<>#])/g, "\\$1");
}

function buildCleanTranscriptMarkdown({
  transcript,
  modeSnapshot = null,
  videoId,
  videoTitle,
  channelName,
  videoDescription,
}) {
  if (
    modeSnapshot &&
    (!modeSnapshot.complete || !Array.isArray(modeSnapshot.rows))
  ) return "";
  if (!modeSnapshot && (!Array.isArray(transcript) || transcript.length === 0)) {
    return "";
  }
  const safeVideoId = String(videoId || "").trim();
  const videoUrl = safeVideoId
    ? `https://www.youtube.com/watch?v=${encodeURIComponent(safeVideoId)}`
    : "";
  const paragraphs = modeSnapshot
    ? modeSnapshot.rows.map((row) => ({
        start: row.start,
        sourceText: stripSubtitleFormatting(row.sourceText),
        translatedText: stripSubtitleFormatting(row.translatedText),
      }))
    : groupTranscriptEntries(
        transcript
          .map((entry) => ({
            ...entry,
            text: stripSubtitleFormatting(entry?.text),
          }))
          .filter((entry) => entry.text),
      ).map((entry) => ({
        start: entry.start,
        sourceText: stripSubtitleFormatting(entry.text),
        translatedText: "",
      }));
  if (!paragraphs.length) return "";
  const lines = [
    `# ${escapeMarkdownText(videoTitle || "Untitled video")}`,
    "",
    `**Channel:** ${escapeMarkdownText(channelName || "Unknown")}`,
  ];
  if (modeSnapshot?.mode && modeSnapshot.mode !== "original") {
    lines.push(`**Transcript mode:** ${escapeMarkdownText(modeSnapshot.label)}`);
  }
  if (videoUrl) lines.push(`**Source:** [YouTube video](${videoUrl})`);
  if (videoDescription) {
    lines.push(
      "",
      "## Description",
      "",
      escapeMarkdownText(videoDescription),
    );
  }
  lines.push("", "## Clean transcript", "");
  paragraphs.forEach((paragraph) => {
    const seconds = Math.max(0, Math.floor(Number(paragraph.start) || 0));
    const timestamp = formatVocabularyDisplayTimestamp(seconds);
    const timestampLabel = videoUrl
      ? `[${timestamp}](${videoUrl}&t=${seconds}s)`
      : `**${timestamp}**`;
    lines.push(
      `${timestampLabel}  `,
      escapeMarkdownText(
        modeSnapshot?.mode === "zh"
          ? paragraph.translatedText
          : paragraph.sourceText,
      ),
      "",
    );
    if (modeSnapshot?.mode === "bilingual") {
      lines.push(
        `> **简体中文：** ${escapeMarkdownText(paragraph.translatedText)}`,
        "",
      );
    }
  });
  lines.push("---", "Exported locally by YouTube Digest Vocabulary", "");
  return lines.join("\n");
}

function setTranscriptExportStatus(message) {
  const status = document.getElementById("transcriptExportStatus");
  if (status) status.textContent = message;
}

async function exportCleanTranscript() {
  const token = captureVideoSession();
  const snapshot = await prepareTranscriptModeExport(token, currentTranscriptMode);
  if (!snapshot || !isCurrentVideoSession(token)) return;
  const markdown = buildCleanTranscriptMarkdown({
    modeSnapshot: snapshot.transcriptMode,
    videoId: snapshot.videoId,
    videoTitle: snapshot.videoTitle,
    channelName: snapshot.channelName,
    videoDescription: snapshot.videoDescription,
  });
  if (!markdown) {
    setTranscriptExportStatus("No transcript is available to export.");
    return;
  }
  const filename = `${sanitizeFilename(snapshot.videoTitle)}-clean-transcript.md`;
  if (!isCurrentVideoSession(snapshot.token)) return;
  if (
    downloadTextFile(
      markdown,
      filename,
      "text/markdown;charset=utf-8",
      snapshot.token,
    )
  ) {
    setTranscriptExportStatus(
      `已导出 ${snapshot.transcriptMode.label} Clean Markdown。`,
    );
  }
}

function deepAnalysisVideoUrl(videoId) {
  const safeVideoId = String(videoId || "").trim();
  return safeVideoId
    ? `https://www.youtube.com/watch?v=${encodeURIComponent(safeVideoId)}`
    : "";
}

function analysisTimestampLink(item, videoUrl) {
  const seconds = Math.max(0, Math.floor(Number(item?.timestampSeconds) || 0));
  const timestamp = item?.timestamp || formatVocabularyDisplayTimestamp(seconds);
  return videoUrl ? `[${timestamp}](${videoUrl}&t=${seconds}s)` : timestamp;
}

function buildAnalysisMarkdownBody(analysis, videoUrl, heading = "##") {
  const lines = [];
  const addHeading = (title) => lines.push(`${heading} ${title}`, "");
  const addBullets = (values) => {
    const items = Array.isArray(values) ? values.filter(Boolean) : [];
    if (!items.length) lines.push("- 逐字稿没有提供足够信息。", "");
    else {
      items.forEach((value) => lines.push(`- ${escapeMarkdownText(value)}`));
      lines.push("");
    }
  };
  const summary = analysis.summary || {};

  addHeading("一句话看懂");
  lines.push(escapeMarkdownText(summary.oneSentenceZh), "");
  addHeading("内容概括");
  lines.push(escapeMarkdownText(summary.executiveSummaryZh), "");
  addHeading("核心论点");
  lines.push(escapeMarkdownText(summary.coreThesisZh), "");
  addHeading("为什么重要");
  lines.push(escapeMarkdownText(summary.whyItMattersZh), "");

  addHeading("关键洞见与证据");
  analysisRecords(analysis.keyInsights).forEach((insight, index) => {
    lines.push(
      `${heading}# ${index + 1}. ${escapeMarkdownText(insight.titleZh)} · ${analysisTimestampLink(insight, videoUrl)}`,
      "",
      escapeMarkdownText(insight.explanationZh),
      "",
      `**逐字稿依据：** ${escapeMarkdownText(insight.evidenceZh)}`,
      "",
    );
  });
  if (!analysis.keyInsights?.length) lines.push("没有可验证的关键洞见。", "");

  addHeading("论证结构");
  analysisRecords(analysis.argumentMap).forEach((item, index) => {
    lines.push(
      `${heading}# ${index + 1}. ${escapeMarkdownText(item.claimZh)}`,
      "",
      `- **主张：** ${escapeMarkdownText(item.claimZh)}`,
      `- **支持：** ${escapeMarkdownText(item.supportZh)}`,
    );
    if (item.caveatZh) {
      lines.push(`- **限制：** ${escapeMarkdownText(item.caveatZh)}`);
    }
    lines.push("");
  });
  if (!analysis.argumentMap?.length) lines.push("没有足够信息重建论证。", "");

  addHeading("批判性拆解");
  const critical = analysis.criticalThinking || {};
  for (const [title, values] of [
    ["优点", critical.strengthsZh],
    ["局限", critical.limitationsZh],
    ["隐藏前提", critical.assumptionsZh],
    ["开放问题", critical.openQuestionsZh],
  ]) {
    lines.push(`${heading}# ${title}`, "");
    addBullets(values);
  }

  addHeading("可执行启发");
  analysisArray(analysis.actionItemsZh).forEach((item, index) => {
    lines.push(`${index + 1}. ${escapeMarkdownText(item)}`);
  });
  if (!analysis.actionItemsZh?.length) lines.push("没有生成可执行启发。");
  lines.push("");

  addHeading("主动回忆");
  analysisRecords(analysis.reviewQuestions).forEach((item, index) => {
    lines.push(
      `${heading}# ${index + 1}. ${escapeMarkdownText(item.questionZh)}`,
      "",
      `**参考答案：** ${escapeMarkdownText(item.answerZh)}`,
      "",
    );
  });
  if (!analysis.reviewQuestions?.length) lines.push("没有生成复习问题。", "");

  addHeading("内容结构与章节");
  analysisRecords(analysis.chapters).forEach((chapter) => {
    lines.push(
      `- ${analysisTimestampLink(chapter, videoUrl)} **${escapeMarkdownText(chapter.title)}**`,
      `  ${escapeMarkdownText(chapter.summary)}`,
    );
  });
  lines.push("");

  addHeading("关键原话");
  analysisRecords(analysis.keyQuotes).forEach((quote) => {
    lines.push(
      `> ${escapeMarkdownText(quote.quote)}`,
      `> ${analysisTimestampLink(quote, videoUrl)}`,
      "",
    );
  });
  return lines;
}

function buildDeepAnalysisMarkdown({
  analysis,
  videoId,
  videoTitle,
  channelName,
}) {
  if (!hasDeepAnalysis(analysis)) return "";
  const videoUrl = deepAnalysisVideoUrl(videoId);
  const lines = [
    `# ${escapeMarkdownText(videoTitle || "Untitled video")} - Deep Analysis Report`,
    "",
    `**Channel:** ${escapeMarkdownText(channelName || "Unknown")}`,
  ];
  if (videoUrl) lines.push(`**Source:** [YouTube video](${videoUrl})`);
  lines.push("", ...buildAnalysisMarkdownBody(analysis, videoUrl), "---", "Generated by YouTube Digest Vocabulary", "");
  return lines.join("\n");
}

function buildStudyPackMarkdown({
  analysis,
  transcript,
  videoId,
  videoTitle,
  channelName,
  videoDescription,
}) {
  if (!hasDeepAnalysis(analysis)) return "";
  const cleanTranscript = buildCleanTranscriptMarkdown({
    transcript,
    videoId,
    videoTitle,
    channelName,
    videoDescription,
  });
  if (!cleanTranscript) return "";
  const transcriptHeadingIndex = cleanTranscript.indexOf("## Clean transcript");
  if (transcriptHeadingIndex < 0) return "";

  const videoUrl = deepAnalysisVideoUrl(videoId);
  const lines = [
    `# ${escapeMarkdownText(videoTitle || "Untitled video")} - Complete Study Pack`,
    "",
    `**Channel:** ${escapeMarkdownText(channelName || "Unknown")}`,
  ];
  if (videoUrl) lines.push(`**Source:** [YouTube video](${videoUrl})`);
  if (videoDescription) {
    lines.push("", `**Description:** ${escapeMarkdownText(videoDescription)}`);
  }
  lines.push(
    "",
    "## Deep analysis",
    "",
    ...buildAnalysisMarkdownBody(analysis, videoUrl, "###"),
    "---",
    "",
    cleanTranscript.slice(transcriptHeadingIndex).trimEnd(),
    "",
  );
  return lines.join("\n");
}

function exportDeepAnalysis(kind) {
  const snapshot = captureVideoSnapshot();
  if (!snapshot || !hasDeepAnalysis(snapshot.analysis)) {
    setAnalysisStatus("Build the deep analysis before exporting it.");
    return;
  }
  const metadata = {
    analysis: snapshot.analysis,
    transcript: snapshot.transcript,
    videoId: snapshot.videoId,
    videoTitle: snapshot.videoTitle,
    channelName: snapshot.channelName,
    videoDescription: snapshot.videoDescription,
  };
  const reportMarkdown = buildDeepAnalysisMarkdown(metadata);
  const studyPackMarkdown = buildStudyPackMarkdown(metadata);
  const isStudyPack = kind === "study-pack";
  const markdown = isStudyPack ? studyPackMarkdown : reportMarkdown;
  if (!markdown) {
    setAnalysisStatus("The requested report is incomplete and could not be exported.");
    return;
  }
  const suffix = isStudyPack ? "study-pack" : "deep-analysis";
  if (!isCurrentVideoSession(snapshot.token)) return;
  if (
    downloadTextFile(
      markdown,
      `${sanitizeFilename(snapshot.videoTitle)}-${suffix}.md`,
      "text/markdown;charset=utf-8",
      snapshot.token,
    )
  ) {
    setAnalysisStatus(
      isStudyPack
        ? "Downloaded the complete study pack."
        : "Downloaded the deep-analysis report.",
    );
  }
}

// ============================================================
// UI STATE MANAGEMENT
// ============================================================

const PANEL_PROVIDER_FAILURE_CODES = new Set([
  "MISSING_KEY",
  "INVALID_KEY",
  "NO_TRANSCRIPT",
  "RATE_LIMITED",
  "INSUFFICIENT_CREDIT",
  "NETWORK_ERROR",
  "REQUEST_TIMEOUT",
  "EMPTY_RESPONSE",
  "MALFORMED_RESPONSE",
  "INPUT_TOO_LARGE",
  "RESPONSE_TOO_LARGE",
  "SESSION_STALE",
  "RESET_DURING_REQUEST",
  "UNKNOWN_PROVIDER_ERROR",
]);

const PANEL_PROVIDER_FAILURE_ALIASES = Object.freeze({
  NO_AI_KEY: "MISSING_KEY",
  NO_SUPADATA_KEY: "MISSING_KEY",
  EMPTY_AI_RESPONSE: "EMPTY_RESPONSE",
  AI_RESPONSE_TOO_LARGE: "RESPONSE_TOO_LARGE",
  AI_IDLE_TIMEOUT: "REQUEST_TIMEOUT",
  AI_HARD_TIMEOUT: "REQUEST_TIMEOUT",
});

function providerFailureActionLabel(kind, stage) {
  if (kind === "open_settings") return "打开设置";
  if (kind === "choose_video") return "选择其他视频";
  if (kind === "show_transcript") return "查看字幕";
  if (kind === "open_provider_help") return "查看额度帮助";
  if (stage === "analysis") return "重试分析";
  if (stage === "overview") return "重试概览";
  return "重试字幕";
}

function providerFailurePresentation(failure = {}, expectedStage) {
  const stage =
    expectedStage === "analysis" ||
    expectedStage === "overview" ||
    expectedStage === "transcript"
      ? expectedStage
      : failure?.stage === "analysis" || failure?.stage === "overview"
        ? failure.stage
        : "transcript";
  const isAiStage = stage === "analysis" || stage === "overview";
  const isOverviewStage = stage === "overview";
  const rawCode =
    typeof failure?.code === "string"
      ? failure.code.trim().toUpperCase()
      : typeof failure?.error === "string"
        ? failure.error.trim().toUpperCase()
        : "";
  const aliasedCode = PANEL_PROVIDER_FAILURE_ALIASES[rawCode] || rawCode;
  const code = PANEL_PROVIDER_FAILURE_CODES.has(aliasedCode)
    ? aliasedCode
    : "UNKNOWN_PROVIDER_ERROR";
  const provider = isAiStage ? "deepseek" : "supadata";
  let title;
  let message;
  let primaryKind = "retry_step";

  switch (code) {
    case "MISSING_KEY":
      title = isOverviewStage
        ? "需要配置基础概览服务"
        : isAiStage
          ? "需要配置分析服务"
          : "需要配置字幕服务";
      message =
        isOverviewStage
          ? "请先在设置中添加 DeepSeek API Key，再生成基础概览。"
          : isAiStage
          ? "请先在设置中添加 DeepSeek API Key，再生成深度分析。"
          : "请先在设置中添加 Supadata API Key，再获取字幕。";
      primaryKind = "open_settings";
      break;
    case "INVALID_KEY":
      title = isOverviewStage
        ? "基础概览密钥未通过验证"
        : isAiStage
          ? "分析密钥未通过验证"
          : "字幕密钥未通过验证";
      message =
        isOverviewStage
          ? "DeepSeek 拒绝了当前密钥。请检查密钥后再生成基础概览。"
          : isAiStage
          ? "DeepSeek 拒绝了当前密钥。请检查密钥后再试。"
          : "Supadata 拒绝了当前密钥。请检查密钥后再试。";
      primaryKind = "open_settings";
      break;
    case "NO_TRANSCRIPT":
      title = "这个视频没有可用字幕";
      message = "字幕服务没有找到可用的原生字幕。你可以选择其他视频，或重试字幕步骤。";
      primaryKind = "choose_video";
      break;
    case "RATE_LIMITED":
      title = isOverviewStage ? "基础概览服务暂时繁忙" : "服务暂时繁忙";
      message = isOverviewStage
        ? "DeepSeek 正在限制请求频率。请稍后重试基础概览。"
        : "服务商正在限制请求频率。请稍后重试失败的这一步。";
      break;
    case "INSUFFICIENT_CREDIT":
      title = isOverviewStage
        ? "基础概览服务额度不足"
        : isAiStage
          ? "分析服务额度不足"
          : "字幕服务额度不足";
      message = isOverviewStage
        ? "DeepSeek 报告可用额度不足，暂时无法生成基础概览。请查看账户额度或计费帮助。"
        : "服务商报告可用额度不足。请查看账户额度或计费帮助。";
      primaryKind = "open_provider_help";
      break;
    case "NETWORK_ERROR":
      title = isOverviewStage ? "基础概览网络连接中断" : "网络连接中断";
      message = isOverviewStage
        ? "基础概览请求没有稳定完成。请检查网络后重试概览。"
        : "请求没有稳定完成。请检查网络后重试失败的这一步。";
      break;
    case "REQUEST_TIMEOUT":
      title = isOverviewStage
        ? "基础概览请求超时"
        : isAiStage
          ? "分析请求超时"
          : "字幕请求超时";
      message = isOverviewStage
        ? "DeepSeek 没有在限定时间内完成基础概览。请重试概览。"
        : "服务商没有在限定时间内完成请求。请重试失败的这一步。";
      break;
    case "EMPTY_RESPONSE":
      title = isOverviewStage
        ? "基础概览没有返回可用内容"
        : "服务没有返回可用内容";
      message = isOverviewStage
        ? "基础概览请求已完成，但返回内容为空。请重试概览。"
        : "请求已完成，但返回内容为空。请重试失败的这一步。";
      break;
    case "MALFORMED_RESPONSE":
      title = isOverviewStage
        ? "基础概览内容无法读取"
        : "服务返回内容无法读取";
      message = isOverviewStage
        ? "基础概览内容不符合预期格式。请重试概览。"
        : "返回内容不符合预期格式。请重试失败的这一步。";
      break;
    case "INPUT_TOO_LARGE":
      title = "字幕内容超过概览上限";
      message =
        "字幕内容超过基础概览的本地安全上限，本次未发送给分析服务。你仍可查看字幕，或选择较短的视频。";
      primaryKind = "show_transcript";
      break;
    case "RESPONSE_TOO_LARGE":
      title = "服务返回内容过大";
      message =
        isOverviewStage
          ? "基础概览结果超过安全上限，未被载入。请先查看字幕，再决定是否手动重试。"
          : isAiStage
          ? "分析结果超过安全上限，未被载入。请先查看字幕并缩小分析范围，再决定是否手动重试。"
          : "字幕结果超过安全上限，未被载入。请选择较短视频，避免原样请求再次消耗额度。";
      primaryKind = isAiStage ? "show_transcript" : "choose_video";
      break;
    case "SESSION_STALE":
      title = "视频已经切换";
      message = "这次结果属于之前的视频，已安全忽略。请在当前视频重试。";
      break;
    case "RESET_DURING_REQUEST":
      title = "请求期间数据已重置";
      message = "旧请求的结果已安全忽略。需要时可以重新开始这一步。";
      break;
    default:
      title = isOverviewStage
        ? "基础概览服务暂时不可用"
        : isAiStage
          ? "分析服务暂时不可用"
          : "字幕服务暂时不可用";
      message = isOverviewStage
        ? "基础概览没有正常完成。请稍后重试概览。"
        : "服务没有正常完成请求。请稍后重试失败的这一步。";
      break;
  }

  const secondaryKind =
    code === "INPUT_TOO_LARGE"
      ? "choose_video"
      : isAiStage
      ? primaryKind === "retry_step"
        ? "show_transcript"
        : "retry_step"
      : primaryKind === "retry_step"
        ? "open_settings"
        : "retry_step";
  const mayHaveConsumedCredit = failure?.mayHaveConsumedCredit !== false;
  const creditNote = mayHaveConsumedCredit
    ? "这次请求可能已经消耗服务额度；重试只会重做失败的这一步。"
    : "这次请求在发送前停止，不会消耗服务额度。";

  return {
    code,
    provider,
    stage,
    title,
    message,
    creditNote,
    primaryAction: {
      kind: primaryKind,
      label: providerFailureActionLabel(primaryKind, stage),
    },
    secondaryAction: {
      kind: secondaryKind,
      label: providerFailureActionLabel(secondaryKind, stage),
    },
  };
}

function runProviderRecovery(action, { stage, provider, retry } = {}) {
  if (!action) return;
  if (action.kind === "retry_step") return retry?.();
  if (action.kind === "open_settings") {
    return chrome.runtime.sendMessage({ action: "openOptions" });
  }
  if (action.kind === "choose_video") {
    // Keep navigation under the user's control in the current browser tab.
    // The panel will bind the next YouTube video when the user chooses one.
    clearProviderErrorSurface();
    showState("welcome");
    document.activeElement?.blur?.();
    document.getElementById("settingsBtn")?.focus?.();
    return;
  }
  if (action.kind === "open_provider_help") {
    // Options contains the extension's fixed, reviewed provider help links.
    return chrome.runtime.sendMessage({ action: "openOptions" });
  }
  if (action.kind === "show_transcript") {
    showState("results");
    return switchTab("transcript", { suppressAnalysis: true });
  }
  if (stage === "analysis" || stage === "overview") {
    return switchTab("transcript", { suppressAnalysis: true });
  }
}

function clearProviderErrorSurface() {
  errorAction = null;
  errorSecondaryAction = null;
  const title = document.getElementById("errorTitle");
  const message = document.getElementById("errorMessage");
  const costNote = document.getElementById("errorCostNote");
  const primaryButton = document.getElementById("errorBtn");
  const secondaryButton = document.getElementById("errorSecondaryBtn");
  if (title) title.textContent = "";
  if (message) message.textContent = "";
  if (costNote) {
    costNote.textContent = "";
    costNote.style.display = "none";
  }
  if (primaryButton) primaryButton.textContent = "Try Again";
  if (secondaryButton) {
    secondaryButton.textContent = "";
    secondaryButton.style.display = "none";
  }
}

function showProviderFailure(failure, stage, retry) {
  const presentation = providerFailurePresentation(failure, stage);
  clearProviderErrorSurface();
  showState("error");
  document.getElementById("errorTitle").textContent = presentation.title;
  document.getElementById("errorMessage").textContent = presentation.message;
  const costNote = document.getElementById("errorCostNote");
  costNote.textContent = presentation.creditNote;
  costNote.style.display = "block";

  const primaryButton = document.getElementById("errorBtn");
  primaryButton.textContent = presentation.primaryAction.label;
  errorAction = () =>
    runProviderRecovery(presentation.primaryAction, {
      stage: presentation.stage,
      provider: presentation.provider,
      retry,
    });

  const secondaryButton = document.getElementById("errorSecondaryBtn");
  secondaryButton.textContent = presentation.secondaryAction.label;
  secondaryButton.style.display = "block";
  errorSecondaryAction = () =>
    runProviderRecovery(presentation.secondaryAction, {
      stage: presentation.stage,
      provider: presentation.provider,
      retry,
    });
  return presentation;
}

function isSilentProviderAuthorityFailure(response) {
  return (
    response?.success === false &&
    (response.code === "SESSION_STALE" ||
      response.code === "RESET_DURING_REQUEST")
  );
}

function showState(state) {
  document.getElementById("welcomeState").style.display =
    state === "welcome" ? "flex" : "none";
  document.getElementById("loadingState").style.display =
    state === "loading" ? "block" : "none";
  document.getElementById("errorState").style.display =
    state === "error" ? "block" : "none";
  const uploadEl = document.getElementById("uploadState");
  if (uploadEl) uploadEl.style.display = "none"; // Upload state removed — always hidden
  document.getElementById("resultsState").style.display =
    state === "results" ? "block" : "none";

  // The tab bar only belongs on the results view. We toggle it HERE, in one
  // place, so it tracks the view automatically. Previously each caller had to
  // remember to re-show it after showState("results"), and one path forgot —
  // which is why the tabs could vanish when re-opening an already-analyzed video.
  document.getElementById("tabsNav").style.display =
    state === "results" ? "flex" : "none";

  if (state !== "results") {
    stopPlaybackTracking();
  }
}

function updateLoading(title, subtitle) {
  document.getElementById("loadingText").textContent = title;
  document.getElementById("loadingSubtext").textContent = subtitle;
}

function showError(title, message) {
  clearProviderErrorSurface();
  showState("error");
  document.getElementById("errorTitle").textContent = title;
  document.getElementById("errorMessage").textContent = message;
  document.getElementById("errorBtn").textContent = "Try Again";
}

function showConfigError(configStatus) {
  const missingKeys = [];
  if (!configStatus.hasSupadataKey) missingKeys.push("Supadata");
  if (!configStatus.hasAiKey) missingKeys.push("AI provider");

  clearProviderErrorSurface();
  showState("error");
  document.getElementById("errorTitle").textContent = "API Keys Missing";
  document.getElementById("errorMessage").textContent =
    `Add your ${missingKeys.join(" and ")} API key${missingKeys.length === 1 ? "" : "s"} in YouTube Digest Vocabulary Settings.`;
  document.getElementById("errorBtn").textContent = "Open Settings";
  errorAction = () => chrome.runtime.sendMessage({ action: "openOptions" });
}

function normalizeConfigStatus(value) {
  return Object.freeze({
    hasSupadataKey: value?.hasSupadataKey === true,
    hasAiKey: value?.hasAiKey === true,
    autoBasicOverview: value?.autoBasicOverview === true,
  });
}

function setFeatureAvailability(configStatus) {
  const hasSupadataKey = Boolean(configStatus?.hasSupadataKey);
  const hasAiKey = Boolean(configStatus?.hasAiKey);
  const transcriptTab = document.querySelector('.tab[data-tab="transcript"]');
  const overviewTab = document.querySelector('.tab[data-tab="overview"]');
  if (transcriptTab) {
    transcriptTab.disabled = !hasSupadataKey;
    transcriptTab.title = hasSupadataKey
      ? ""
      : "Add a Supadata API key in Settings to fetch transcripts.";
  }
  if (overviewTab) {
    overviewTab.disabled = false;
    overviewTab.title = hasAiKey
      ? ""
      : "基础概览仍可打开；在页面内查看配置说明。";
  }
  document
    .querySelectorAll(
      '[data-transcript-mode="zh"], [data-transcript-mode="bilingual"]',
    )
    .forEach((button) => {
      button.disabled = !hasAiKey;
      button.title = hasAiKey
        ? ""
        : "Add an AI provider key in Settings to translate transcripts.";
    });

  const missingKeys = [];
  if (!hasSupadataKey) missingKeys.push("Supadata");
  if (!hasAiKey) missingKeys.push("AI provider");
  const notice = document.getElementById("vocabularyConfigNotice");
  const message = document.getElementById("vocabularyConfigMessage");
  if (notice) notice.style.display = missingKeys.length ? "flex" : "none";
  if (message && missingKeys.length) {
    message.textContent = `Your saved vocabulary remains available. Add your ${missingKeys.join(" and ")} API key${missingKeys.length === 1 ? "" : "s"} to fetch transcripts and build new AI cards.`;
  }
}

function showVocabularyWithoutConfig() {
  showState("results");
  switchTab("vocabulary");
}

// ============================================================
// TAB SWITCHING
// ============================================================

function handleTabKeydown(event) {
  if (!event || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    return;
  }
  const tabs = Array.from(document.querySelectorAll(".tab")).filter(
    (tab) => !tab.disabled,
  );
  if (!tabs.length) return;
  const currentIndex = Math.max(0, tabs.indexOf(event.currentTarget));
  const targetIndex =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : event.key === "ArrowRight"
          ? (currentIndex + 1) % tabs.length
          : (currentIndex - 1 + tabs.length) % tabs.length;
  const target = tabs[targetIndex];
  if (!target) return;
  event.preventDefault();
  switchTab(target.dataset.tab);
  target.focus?.();
}

function switchTab(tabName, _options = {}) {
  document.querySelectorAll(".tab").forEach((tab) => {
    const active = tab.dataset.tab === tabName;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.setAttribute("tabindex", active ? "0" : "-1");
  });

  document.querySelectorAll(".tab-panel").forEach((panel) => {
    const active = panel.dataset.panel === tabName;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  });

  // Start/stop playback tracking based on which tab is active
  if (tabName === "transcript") {
    startPlaybackTracking();
  } else {
    stopPlaybackTracking();
  }

  if (tabName === "vocabulary") loadVocabulary();
}

/**
 * Triggers Deep Analysis only from its explicit action or regenerate control.
 */
function restoreAnalysisAfterFailure(failure, chapterList, quotesList) {
  const presentation = providerFailurePresentation(failure, "analysis");
  const hasExportableAnalysis = hasDeepAnalysis(currentAnalysis);
  if (currentAnalysis) {
    renderAnalysisResults(currentAnalysis);
  } else {
    const safeMessage = escapeHtml(
      `${presentation.title}：${presentation.message}`,
    );
    if (chapterList) {
      chapterList.innerHTML = `<li class="chapter-item" style="color: var(--accent); border: none;">Analysis failed: ${safeMessage}</li>`;
    }
    if (quotesList) {
      quotesList.innerHTML = `<div class="quote-item" style="color: var(--accent); border-left-color: var(--border);">Analysis failed: ${safeMessage}</div>`;
    }
  }
  setAnalysisStatus(
    `${presentation.title}：${presentation.message} ${presentation.creditNote}`,
  );
  setAnalysisExportAvailability(hasExportableAnalysis);
  const regenerateButton = document.getElementById("regenerateAnalysisBtn");
  if (regenerateButton) {
    regenerateButton.textContent = "重试分析";
  }
  const contextAction =
    presentation.primaryAction.kind === "retry_step"
      ? presentation.secondaryAction
      : presentation.primaryAction;
  const contextButton = document.getElementById("analysisRecoveryContextBtn");
  if (contextButton) {
    contextButton.textContent = contextAction.label;
    contextButton.style.display = "inline-flex";
  }
  analysisContextRecoveryAction = () =>
    runProviderRecovery(contextAction, {
      stage: "analysis",
      provider: presentation.provider,
      retry: () => triggerAnalysis(true),
    });
  return presentation;
}

function captureAnalysisUiState(chapterList, quotesList) {
  const regenerateButton = document.getElementById("regenerateAnalysisBtn");
  const contextButton = document.getElementById("analysisRecoveryContextBtn");
  const actionButton = document.getElementById("deepAnalysisActionBtn");
  const results = document.getElementById("deepAnalysisResults");
  return {
    status: document.getElementById("analysisStatus")?.textContent || "",
    chapterHtml: chapterList?.innerHTML || "",
    quotesHtml: quotesList?.innerHTML || "",
    reportDisabled: document.getElementById("analysisExportReportBtn")?.disabled,
    studyPackDisabled: document.getElementById("analysisExportStudyPackBtn")?.disabled,
    regenerateText: regenerateButton?.textContent || "Regenerate",
    regenerateDisabled: Boolean(regenerateButton?.disabled),
    contextText: contextButton?.textContent || "",
    contextDisplay: contextButton?.style.display || "none",
    contextAction: analysisContextRecoveryAction,
    actionText: actionButton?.textContent || "生成深度分析",
    actionDisplay: actionButton?.style.display || "inline-flex",
    actionDisabled: Boolean(actionButton?.disabled),
    resultsDisplay: results?.style.display || "none",
  };
}

function restoreAnalysisUiState(snapshot, chapterList, quotesList) {
  if (currentAnalysis) {
    renderAnalysisResults(currentAnalysis);
  } else {
    if (chapterList) chapterList.innerHTML = snapshot.chapterHtml;
    if (quotesList) quotesList.innerHTML = snapshot.quotesHtml;
  }
  setAnalysisStatus(snapshot.status);
  const reportButton = document.getElementById("analysisExportReportBtn");
  const studyPackButton = document.getElementById(
    "analysisExportStudyPackBtn",
  );
  if (reportButton && snapshot.reportDisabled !== undefined) {
    reportButton.disabled = snapshot.reportDisabled;
  }
  if (studyPackButton && snapshot.studyPackDisabled !== undefined) {
    studyPackButton.disabled = snapshot.studyPackDisabled;
  }
  const regenerateButton = document.getElementById("regenerateAnalysisBtn");
  if (regenerateButton) {
    regenerateButton.textContent = snapshot.regenerateText;
    regenerateButton.disabled = snapshot.regenerateDisabled;
  }
  const contextButton = document.getElementById("analysisRecoveryContextBtn");
  if (contextButton) {
    contextButton.textContent = snapshot.contextText;
    contextButton.style.display = snapshot.contextDisplay;
  }
  const actionButton = document.getElementById("deepAnalysisActionBtn");
  if (actionButton) {
    actionButton.textContent = snapshot.actionText;
    actionButton.style.display = snapshot.actionDisplay;
    actionButton.disabled = snapshot.actionDisabled;
  }
  const results = document.getElementById("deepAnalysisResults");
  if (results) results.style.display = snapshot.resultsDisplay;
  document
    .getElementById("deepAnalysisCard")
    ?.setAttribute("aria-busy", "false");
  analysisContextRecoveryAction = snapshot.contextAction;
}

async function triggerAnalysis(force = false) {
  const token = captureVideoSession();
  if (
    !isCurrentVideoSession(token) ||
    !currentTranscriptTimestamped ||
    isAnalysisLoading ||
    (!force && hasDeepAnalysis(currentAnalysis))
  ) return;
  if (!currentTranscriptFingerprint) {
    showFingerprintUnavailableCacheLimits();
    return;
  }
  const chapterList = document.getElementById("chapterList");
  const quotesList = document.getElementById("quotesList");
  const uiBeforeRequest = captureAnalysisUiState(chapterList, quotesList);
  let ignoredAuthorityFailure = false;
  analysisContextRecoveryAction = null;
  isAnalysisLoading = true;
  const deepCard = document.getElementById("deepAnalysisCard");
  deepCard?.setAttribute("aria-busy", "true");
  const deepActionButton = document.getElementById("deepAnalysisActionBtn");
  if (deepActionButton) {
    deepActionButton.disabled = true;
    deepActionButton.textContent = "正在生成…";
  }
  setAnalysisExportAvailability(false);
  setAnalysisStatus(
    force
      ? "正在重新生成 Deep Analysis…"
      : "正在阅读完整字幕并生成 Deep Analysis…",
  );
  const regenerateButton = document.getElementById("regenerateAnalysisBtn");
  if (regenerateButton) {
    regenerateButton.textContent = "正在生成…";
    regenerateButton.disabled = true;
  }
  const contextButton = document.getElementById("analysisRecoveryContextBtn");
  if (contextButton) {
    contextButton.textContent = "";
    contextButton.style.display = "none";
  }

  try {
    const digestBaseReady = await ensureDigestBaseReady(token);
    if (!isCurrentVideoSession(token)) return;
    if (!digestBaseReady) {
      setAnalysisStatus(
        "本地缓存暂时无法安全写入。请重试分析；恢复缓存前不会发送 AI 请求。",
      );
      if (regenerateButton) regenerateButton.textContent = "重试分析";
      return;
    }

    const transcriptText = currentTranscriptTimestamped;
    const videoTitle = currentVideoTitle;
    const channelName = currentChannelName;
    const videoDescription = currentVideoDescription;
    const videoDuration = currentVideoDuration;
    const hadDeepAnalysis = hasDeepAnalysis(currentAnalysis);
    if (chapterList && !hadDeepAnalysis) {
      chapterList.textContent = "正在生成章节…";
    }
    if (quotesList && !hadDeepAnalysis) {
      quotesList.textContent = "正在核对关键原话…";
    }

    const analysisResult = await sendVideoSessionMessage({
      action: "analyzeTranscript",
      transcriptText,
      videoTitle,
      channelName,
      videoDescription,
      videoDuration,
    }, token);
    if (!isCurrentSessionResponse(token, analysisResult)) return;
    if (isSilentProviderAuthorityFailure(analysisResult)) {
      ignoredAuthorityFailure = true;
      return;
    }

    if (!analysisResult.success) {
      restoreAnalysisAfterFailure(
        analysisResult,
        chapterList,
        quotesList,
      );
      return;
    }

    if (!hasDeepAnalysis(analysisResult.analysis)) {
      const error = new Error("The AI returned an incomplete deep-analysis report.");
      error.code = "MALFORMED_RESPONSE";
      throw error;
    }
    currentAnalysis = analysisResult.analysis;
    analysisContextRecoveryAction = null;
    if (contextButton) {
      contextButton.textContent = "";
      contextButton.style.display = "none";
    }
    if (regenerateButton) regenerateButton.textContent = "重新生成";
    renderAnalysisResults(currentAnalysis);
    void highlightMomentsOnPage(currentAnalysis.keyMoments, token);

    await patchDigestCache({ deepAnalysis: currentAnalysis }, token);
    if (!isCurrentVideoSession(token)) return;
  } catch (error) {
    if (isCurrentVideoSession(token)) {
      restoreAnalysisAfterFailure(
        {
          code: PANEL_PROVIDER_FAILURE_CODES.has(error?.code)
            ? error.code
            : "UNKNOWN_PROVIDER_ERROR",
          provider: "deepseek",
          stage: "analysis",
          mayHaveConsumedCredit: true,
        },
        chapterList,
        quotesList,
      );
    }
  } finally {
    if (isCurrentVideoSession(token)) {
      isAnalysisLoading = false;
      deepCard?.setAttribute("aria-busy", "false");
      if (ignoredAuthorityFailure) {
        restoreAnalysisUiState(uiBeforeRequest, chapterList, quotesList);
      } else {
        if (regenerateButton) regenerateButton.disabled = false;
        if (deepActionButton) {
          deepActionButton.disabled = false;
          deepActionButton.textContent = currentAnalysis
            ? "生成深度分析"
            : "重试深度分析";
          deepActionButton.style.display = currentAnalysis
            ? "none"
            : "inline-flex";
        }
      }
    }
  }
}

// ============================================================
// TIMESTAMP / SEEK
// ============================================================

async function seekTo(seconds, token = captureVideoSession()) {
  debugLog("[YouTube Digest Vocabulary Panel] seekTo called with:", seconds);
  if (!isCurrentVideoSession(token) || seconds === undefined || seconds === null) {
    debugLog("[YouTube Digest Vocabulary Panel] seekTo aborted - no seconds value");
    return;
  }

  const payload = {
    action: "seekTo",
    seconds: Number(seconds),
  };

  try {
    if (!isCurrentVideoSession(token)) return;
    const result = await sendVideoSessionMessage({
      action: "relayToContent",
      tabId: token.tabId,
      payload,
    }, token);
    if (!isCurrentSessionResponse(token, result)) return;
    debugLog("[YouTube Digest Vocabulary Panel] seekTo relay result:", result);
  } catch {
    // The bound tab may have closed or navigated. Never reroute to another tab.
  }
}

/**
 * Plays a saved note at its timestamp.
 * - If the note belongs to the video currently open, we seek the player in place.
 * - If it belongs to a DIFFERENT video (e.g. viewing "All Notes"), seeking the
 *   current player would jump to the wrong content, so we open that video in a
 *   new tab at the right timestamp instead.
 */
function playNote(note) {
  if (note.videoId && note.videoId === currentVideoId) {
    seekTo(note.timestampSeconds);
  } else {
    // note.timestampedUrl already includes the &t=<seconds>s anchor
    chrome.tabs.create({ url: note.timestampedUrl });
  }
}

async function highlightMomentsOnPage(moments, token = captureVideoSession()) {
  if (!isCurrentVideoSession(token) || !moments || !moments.length) return;

  try {
    // Route through background script for reliable message passing
    const result = await sendVideoSessionMessage({
      action: "relayToContent",
      tabId: token.tabId,
      payload: {
        action: "highlightMoments",
        moments: moments,
        videoDuration: currentVideoDuration,
      },
    }, token);
    if (!isCurrentSessionResponse(token, result)) return;
  } catch {
    // A stale/closed player is non-fatal and must not be replaced by another tab.
  }
}

// ============================================================
// UTILITY
// ============================================================

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

/**
 * Renders the small subset of inline formatting commonly present in subtitle
 * tracks and model translations. Everything is escaped first; only exact,
 * attribute-free allowlisted tags are restored as markup afterwards.
 */
function renderSubtitleInlineMarkup(text) {
  return escapeHtml(text).replace(
    /&lt;(\/?)(i|em|b|strong|u)&gt;|&lt;br(?:\s*\/)?&gt;/gi,
    (_match, closing, tagName) =>
      tagName ? `<${closing}${tagName.toLowerCase()}>` : "<br>",
  );
}

/**
 * Splits visible transcript copy into English-like word tokens and untouched
 * text. Apostrophes and hyphens remain inside a click target so contractions
 * and compounds keep the form the learner actually encountered.
 */
function tokenizeVocabularyText(text) {
  const source = String(text || "");
  const wordPattern =
    /[A-Za-zÀ-ÖØ-öø-ÿ]+(?:[’'][A-Za-zÀ-ÖØ-öø-ÿ]+)*(?:-[A-Za-zÀ-ÖØ-öø-ÿ]+(?:[’'][A-Za-zÀ-ÖØ-öø-ÿ]+)*)*/g;
  const tokens = [];
  let cursor = 0;

  for (const match of source.matchAll(wordPattern)) {
    if (match.index > cursor) {
      tokens.push({ type: "text", text: source.slice(cursor, match.index) });
    }
    tokens.push({ type: "word", text: match[0] });
    cursor = match.index + match[0].length;
  }

  if (cursor < source.length) {
    tokens.push({ type: "text", text: source.slice(cursor) });
  }
  return tokens;
}

function renderVocabularyText(text) {
  const source = String(text || "");
  const tagPattern = /<[^>]*>/g;
  const allowedTagPattern = /^<\/?(?:i|em|b|strong|u)>$|^<br\s*\/?>$/i;
  let cursor = 0;
  let html = "";
  const renderTextPart = (part) =>
    tokenizeVocabularyText(part)
      .map((token) => {
        if (token.type === "text") return escapeHtml(token.text);
        const safeWord = escapeHtml(token.text);
        return `<button class="vocab-word" type="button" data-word="${safeWord}" aria-label="Learn word: ${safeWord}">${safeWord}</button>`;
      })
      .join("");

  for (const match of source.matchAll(tagPattern)) {
    html += renderTextPart(source.slice(cursor, match.index));
    html += allowedTagPattern.test(match[0])
      ? renderSubtitleInlineMarkup(match[0])
      : escapeHtml(match[0]);
    cursor = match.index + match[0].length;
  }
  html += renderTextPart(source.slice(cursor));
  return html;
}

function stripSubtitleFormatting(text) {
  return String(text || "")
    .replace(/<\/?(?:i|em|b|strong|u)>|<br\s*\/?>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatVocabularyDisplayTimestamp(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainingSeconds = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`
    : `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function renderHighlightedVocabularySentence(sentence, target) {
  const source = String(sentence || "");
  const word = String(target || "").trim();
  if (!word) return escapeHtml(source);

  const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(escapedWord, "giu");
  let cursor = 0;
  let html = "";
  for (const match of source.matchAll(pattern)) {
    html += escapeHtml(source.slice(cursor, match.index));
    html += `<mark>${escapeHtml(match[0])}</mark>`;
    cursor = match.index + match[0].length;
  }
  html += escapeHtml(source.slice(cursor));
  return html;
}

function handleVocabularyWordClick(event) {
  const wordButton = event.target.closest(".vocab-word");
  if (!wordButton) return;
  if (hasNonCollapsedTextSelection()) return;

  event.preventDefault();
  event.stopPropagation();
  const entry = wordButton.closest(".transcript-entry");
  if (!entry || !currentVideoId) return;

  const rawSentence = entry.dataset.sourceText || entry.textContent;
  const sentence = stripSubtitleFormatting(rawSentence);
  showVocabularyCard(
    {
      word: wordButton.dataset.word || wordButton.textContent,
      sentence,
      context:
        getTranscriptContext(rawSentence) || getTranscriptContext(sentence),
      videoId: currentVideoId,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      timestampSeconds: Math.max(
        0,
        Math.floor(Number(entry.dataset.seconds) || 0),
      ),
    },
    wordButton,
  );
}

function vocabularyField(label, value, language = "") {
  if (!value) return "";
  return `<div class="vocabulary-field ${language ? `vocabulary-field--${language}` : ""}"><div class="vocabulary-field-label">${escapeHtml(label)}</div><div class="vocabulary-field-value">${escapeHtml(value)}</div></div>`;
}

function getVocabularyLearningPlan(card) {
  const source = card?.learningPlan || {};
  const contextAnchor = source.contextAnchor || {};
  const morphology = source.morphology || {};
  const soundBridge = source.soundBridge || {};
  const visualScene = source.visualScene || {};
  const contrast = source.contrast || {};
  const retrieval = source.retrieval || {};
  const generation = source.generation || {};
  return {
    contextAnchor: {
      explanationZh: contextAnchor.explanationZh || card?.contextualMeaningZh || "",
      collocationUseZh:
        contextAnchor.collocationUseZh || (card?.collocations || []).join("；"),
    },
    morphology: {
      available:
        typeof morphology.available === "boolean"
          ? morphology.available
          : Boolean(card?.morphology),
      breakdown: morphology.breakdown || card?.morphology || "",
      explanationZh: morphology.explanationZh || card?.morphology || "",
    },
    soundBridge: {
      cueZh: soundBridge.cueZh || "未生成声音/关键词联想。",
      safeguardZh:
        soundBridge.safeguardZh ||
        "声音联想只能辅助记忆，不是 IPA、词源或标准发音说明。",
    },
    visualScene: {
      hookZh: visualScene.hookZh || card?.mnemonic?.hook || "",
      sceneEn: visualScene.sceneEn || card?.mnemonic?.sceneEn || "",
      sceneZh: visualScene.sceneZh || card?.mnemonic?.sceneZh || "",
      recallPathZh:
        visualScene.recallPathZh || card?.mnemonic?.recallPath || "",
    },
    contrast: {
      relatedWordEn: contrast.relatedWordEn || "Not generated",
      distinctionZh: contrast.distinctionZh || "未生成易混词对比。",
      miniContrastEn: contrast.miniContrastEn || "No contrast example was generated.",
    },
    retrieval: {
      clozePrompt: retrieval.clozePrompt || card?.clozePrompt || "",
      meaningToWordPrompt:
        retrieval.meaningToWordPrompt || "根据中文含义回忆这个单词。",
      productionPrompt: retrieval.productionPrompt || card?.productionPrompt || "",
      selfExplainPrompt:
        retrieval.selfExplainPrompt || "说明它在原句中的具体含义。",
    },
    generation: {
      exampleEn: generation.exampleEn || card?.exampleEn || "",
      exampleZh: generation.exampleZh || "未生成新例句的中文翻译。",
    },
    migrationNoteZh: source.migrationNoteZh || "",
  };
}

function buildVocabularyReviewPlan(card) {
  const plan = getVocabularyLearningPlan(card);
  const retrieval = plan.retrieval;
  const lemma = card?.lemma || "这个单词";
  return [
    {
      day: "现在",
      taskZh: `看完后遮住答案，沿着“语境 → 画面 → ${lemma}”复述一次。`,
    },
    {
      day: "1 天后",
      taskZh: `先做完形：${retrieval.clozePrompt || "回到原句补出这个词。"}`,
    },
    {
      day: "3 天后",
      taskZh: `不看答案：${retrieval.meaningToWordPrompt || "根据中文含义回忆单词。"}`,
    },
    {
      day: "7 天后",
      taskZh: `不看卡片回答：${retrieval.selfExplainPrompt || "说明它在原句中的具体意思。"}`,
    },
    {
      day: "14 天后",
      taskZh: `比较易混词后，再完成：${retrieval.productionPrompt || "用这个词写一句话。"}`,
    },
    {
      day: "30 天后",
      taskZh: `脱离原视频，用 ${lemma} 造句，并说出它和易混词的差别。`,
    },
  ];
}

function renderVocabularyLearningPlan(card) {
  const plan = getVocabularyLearningPlan(card);
  const reviewSessions = buildVocabularyReviewPlan(card);
  const morphologyBody = plan.morphology.available
    ? `<p><strong>${escapeHtml(plan.morphology.breakdown)}</strong></p><p>${escapeHtml(plan.morphology.explanationZh)}</p>`
    : `<p><strong>不强行拆分</strong></p><p>${escapeHtml(plan.morphology.explanationZh)}</p>`;
  const reviewItems = reviewSessions
    .map(
      (session) => `<li><strong>${escapeHtml(session.day)}</strong><span>${escapeHtml(session.taskZh)}</span></li>`,
    )
    .join("");
  const method = (number, title, body) => `
    <section class="vocabulary-method-card">
      <div class="vocabulary-method-heading"><span class="vocabulary-method-number">${number}</span><h3>${escapeHtml(title)}</h3></div>
      <div class="vocabulary-method-body">${body}</div>
    </section>`;

  return `
    <section class="vocabulary-learning-plan" aria-label="多方法单词学习方案">
      <div class="vocabulary-learning-plan-intro">多方法学习方案 · 先理解，再联想，再主动提取</div>
      ${plan.migrationNoteZh ? `<p class="vocabulary-migration-note">${escapeHtml(plan.migrationNoteZh)}</p>` : ""}
      ${method(
        "01",
        "语境锚点",
        `<p>${escapeHtml(plan.contextAnchor.explanationZh)}</p><p><strong>搭配怎么记：</strong>${escapeHtml(plan.contextAnchor.collocationUseZh)}</p>`,
      )}
      ${method("02", "词形结构", morphologyBody)}
      ${method(
        "03",
        "声音 / 关键词桥",
        `<p>${escapeHtml(plan.soundBridge.cueZh)}</p><p class="vocabulary-method-safeguard">${escapeHtml(plan.soundBridge.safeguardZh)}</p>`,
      )}
      ${method(
        "04",
        "画面链",
        `<p class="vocabulary-visual-hook">${escapeHtml(plan.visualScene.hookZh)}</p><p lang="en">${escapeHtml(plan.visualScene.sceneEn)}</p><p lang="zh-CN">${escapeHtml(plan.visualScene.sceneZh)}</p><p><strong>回忆路径：</strong>${escapeHtml(plan.visualScene.recallPathZh)}</p>`,
      )}
      ${method(
        "05",
        "易混对比",
        `<p><strong>${escapeHtml(card.lemma || "")}</strong> vs. <strong>${escapeHtml(plan.contrast.relatedWordEn)}</strong></p><p>${escapeHtml(plan.contrast.distinctionZh)}</p><p lang="en">${escapeHtml(plan.contrast.miniContrastEn)}</p>`,
      )}
      ${method(
        "06",
        "主动提取",
        `<ol class="vocabulary-retrieval-list"><li><strong>填空：</strong>${escapeHtml(plan.retrieval.clozePrompt)}</li><li><strong>Meaning → word：</strong>${escapeHtml(plan.retrieval.meaningToWordPrompt)}</li><li><strong>Use it：</strong>${escapeHtml(plan.retrieval.productionPrompt)}</li><li><strong>解释：</strong>${escapeHtml(plan.retrieval.selfExplainPrompt)}</li></ol>`,
      )}
      ${method(
        "07",
        "新例句生成",
        `<p lang="en">${escapeHtml(plan.generation.exampleEn)}</p><p lang="zh-CN">${escapeHtml(plan.generation.exampleZh)}</p>`,
      )}
      ${method(
        "08",
        "间隔复习",
        `<p>每次先尝试回忆，再展开答案；忘记时回到画面链，而不是只反复阅读。</p><ol class="vocabulary-review-timeline">${reviewItems}</ol>`,
      )}
    </section>`;
}

function renderVocabularyCardContent(modal, card) {
  const content = modal.querySelector("#vocabularyCardContent");
  if (!content || !card) return;
  const source = card.occurrences?.[0] || {};
  const collocations = Array.isArray(card.collocations)
    ? card.collocations.map((item) => `<span>${escapeHtml(item)}</span>`).join("")
    : "";
  content.innerHTML = `
    <div class="vocabulary-word-heading">
      <div>
        <h2>${escapeHtml(card.lemma)}</h2>
        <div class="vocabulary-word-meta">${escapeHtml(card.ipa)} · ${escapeHtml(card.partOfSpeech)} · clicked: ${escapeHtml(source.form || "")}</div>
      </div>
    </div>
    <div class="vocabulary-definition-grid">
      ${vocabularyField("English meaning", card.definitionEn, "en")}
      ${vocabularyField("中文释义", card.meaningZh, "zh")}
      ${vocabularyField("Meaning here", card.contextualMeaningEn, "en")}
      ${vocabularyField("原句含义", card.contextualMeaningZh, "zh")}
    </div>
    <div class="vocabulary-source-sentence"><span>From the video · ${escapeHtml(source.timestamp || "")}</span>${renderHighlightedVocabularySentence(source.sentence, source.form)}</div>
    <div class="vocabulary-field"><div class="vocabulary-field-label">Useful combinations</div><div class="vocabulary-collocations">${collocations}</div></div>
    ${renderVocabularyLearningPlan(card)}
    <div class="vocabulary-modal-actions">
      <button class="vocabulary-secondary-btn" id="retryVocabularyCard" type="button">Regenerate</button>
      <button class="vocabulary-primary-btn" id="saveVocabularyCard" type="button">Add to vocabulary</button>
    </div>
    <div class="vocabulary-save-status" id="vocabularySaveStatus" role="status"></div>
  `;

  content
    .querySelector("#retryVocabularyCard")
    ?.addEventListener("click", () => generateVocabularyDraft(modal, modal.__payload));
  content
    .querySelector("#saveVocabularyCard")
    ?.addEventListener("click", () => saveVocabularyDraft(modal, card));

  chrome.runtime
    .sendMessage({ action: "getVocabulary" })
    .then((result) => {
      const button = modal.querySelector("#saveVocabularyCard");
      const exists = result?.success && result.entries?.some(
        (entry) => entry.lemma?.toLocaleLowerCase("en-US") === card.lemma.toLocaleLowerCase("en-US"),
      );
      if (button && exists) button.textContent = "Update vocabulary";
    })
    .catch(() => {});
}

function renderVocabularyGenerationError(modal, message) {
  const content = modal.querySelector("#vocabularyCardContent");
  if (!content) return;
  content.innerHTML = `
    <div class="vocabulary-generation-error">
      <strong>Could not build this card</strong>
      <p>${escapeHtml(message || "Unknown error")}</p>
      <div class="vocabulary-modal-actions">
        <button class="vocabulary-secondary-btn" id="openVocabularySettings" type="button">Settings</button>
        <button class="vocabulary-primary-btn" id="retryVocabularyCard" type="button">Retry</button>
      </div>
    </div>
  `;
  content
    .querySelector("#openVocabularySettings")
    ?.addEventListener("click", () => chrome.runtime.sendMessage({ action: "openOptions" }));
  content
    .querySelector("#retryVocabularyCard")
    ?.addEventListener("click", () => generateVocabularyDraft(modal, modal.__payload));
}

async function generateVocabularyDraft(modal, payload) {
  if (!modal?.isConnected) return;
  if (!currentTranscriptFingerprint) {
    renderVocabularyGenerationError(
      modal,
      "需要 Web Crypto/SHA-256 和可写入的安全逐字稿缓存。当前不会发送 AI 请求。",
    );
    return;
  }
  const token = captureVideoSession();
  const digestBaseReady = isCurrentVideoSession(token)
    ? await ensureDigestBaseReady(token)
    : false;
  if (!isCurrentVideoSession(token) || !modal.isConnected) return;
  if (!digestBaseReady) {
    renderVocabularyGenerationError(
      modal,
      "本地缓存暂时无法安全写入。请重试；恢复缓存前不会发送 AI 请求。",
    );
    return;
  }
  const content = modal.querySelector("#vocabularyCardContent");
  if (content) {
    content.innerHTML = `<div class="vocabulary-card-loading"><div class="loading-bar"></div><span>Building a bilingual memory card…</span><small>Meaning, context, memory scene, and recall prompts</small></div>`;
  }
  try {
    const result = await chrome.runtime.sendMessage({
      action: "generateVocabularyCard",
      payload,
    });
    if (!modal.isConnected) return;
    if (!result?.success || !result.card) {
      renderVocabularyGenerationError(
        modal,
        result?.message || result?.error || "The AI returned an invalid card.",
      );
      return;
    }
    renderVocabularyCardContent(modal, result.card);
  } catch (error) {
    if (modal.isConnected) renderVocabularyGenerationError(modal, error.message);
  }
}

async function saveVocabularyDraft(modal, card) {
  const button = modal.querySelector("#saveVocabularyCard");
  const status = modal.querySelector("#vocabularySaveStatus");
  if (!button || !status) return;
  button.disabled = true;
  button.textContent = "Saving…";
  status.textContent = "";
  try {
    const result = await chrome.runtime.sendMessage({
      action: "saveVocabularyCard",
      card,
    });
    if (!result?.success) throw new Error(result?.error || "Could not save word");
    button.textContent = "✓ Saved locally";
    status.textContent = `${result.entry.lemma} is ready in Vocabulary.`;
    await loadVocabulary();
  } catch (error) {
    button.disabled = false;
    button.textContent = "Try saving again";
    status.textContent = error.message;
  }
}

function closeVocabularyModal(modal, restoreFocus = true) {
  if (!modal) return;
  const returnFocus = modal.__returnFocus;
  modal.remove();
  if (restoreFocus && returnFocus?.isConnected) returnFocus.focus();
}

function getVocabularyModalFocusableElements(modal) {
  return Array.from(
    modal.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.getAttribute("aria-hidden") !== "true");
}

function handleVocabularyModalKeydown(event, modal) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeVocabularyModal(modal);
    return;
  }
  if (event.key !== "Tab") return;

  const focusable = getVocabularyModalFocusableElements(modal);
  if (!focusable.length) {
    event.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !modal.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !modal.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

function showVocabularyCard(payload, returnFocus = document.activeElement) {
  const existingModal = document.getElementById("vocabularyCardModal");
  if (existingModal) closeVocabularyModal(existingModal, false);
  const modal = document.createElement("div");
  modal.id = "vocabularyCardModal";
  modal.className = "vocabulary-modal-overlay";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "vocabularyCardTitle");
  modal.__payload = payload;
  modal.__returnFocus = returnFocus;
  const sourceTimestamp = formatVocabularyDisplayTimestamp(
    payload.timestampSeconds,
  );
  modal.innerHTML = `
    <div class="vocabulary-modal">
      <div class="vocabulary-modal-header">
        <div>
          <div class="vocabulary-modal-eyebrow">Click-to-learn · 点击学词</div>
          <div class="vocabulary-modal-title" id="vocabularyCardTitle">${escapeHtml(payload.word)} <span>· ${escapeHtml(sourceTimestamp)}</span></div>
        </div>
        <button class="vocabulary-modal-close" type="button" aria-label="Close vocabulary card">✕</button>
      </div>
      <div class="vocabulary-modal-content" id="vocabularyCardContent"></div>
    </div>
  `;
  const closeButton = modal.querySelector(".vocabulary-modal-close");
  closeButton?.addEventListener("click", () => closeVocabularyModal(modal));
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeVocabularyModal(modal);
  });
  modal.addEventListener("keydown", (event) =>
    handleVocabularyModalKeydown(event, modal),
  );
  document.body.appendChild(modal);
  closeButton?.focus();
  generateVocabularyDraft(modal, payload);
}

// ============================================================
// VOCABULARY LIBRARY
// ============================================================

function filterVocabularyEntries(entries, query) {
  const needle = String(query || "")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase();
  if (!needle) return Array.isArray(entries) ? [...entries] : [];

  return (Array.isArray(entries) ? entries : []).filter((entry) => {
    const occurrences = Array.isArray(entry.occurrences)
      ? entry.occurrences
      : [];
    const plan = getVocabularyLearningPlan(entry);
    const fields = [
      entry.lemma,
      ...(entry.forms || []),
      entry.ipa,
      entry.partOfSpeech,
      entry.definitionEn,
      entry.meaningZh,
      entry.contextualMeaningEn,
      entry.contextualMeaningZh,
      entry.morphology,
      ...(entry.collocations || []),
      entry.mnemonic?.hook,
      entry.mnemonic?.sceneEn,
      entry.mnemonic?.sceneZh,
      entry.exampleEn,
      plan.contextAnchor.explanationZh,
      plan.contextAnchor.collocationUseZh,
      plan.morphology.breakdown,
      plan.morphology.explanationZh,
      plan.soundBridge.cueZh,
      plan.soundBridge.safeguardZh,
      plan.visualScene.hookZh,
      plan.visualScene.sceneEn,
      plan.visualScene.sceneZh,
      plan.visualScene.recallPathZh,
      plan.contrast.relatedWordEn,
      plan.contrast.distinctionZh,
      plan.contrast.miniContrastEn,
      plan.retrieval.clozePrompt,
      plan.retrieval.meaningToWordPrompt,
      plan.retrieval.productionPrompt,
      plan.retrieval.selfExplainPrompt,
      plan.generation.exampleEn,
      plan.generation.exampleZh,
      ...occurrences.flatMap((occurrence) => [
        occurrence.form,
        occurrence.sentence,
        occurrence.videoTitle,
        occurrence.channelName,
      ]),
    ];
    return fields
      .filter(Boolean)
      .join(" ")
      .normalize("NFKC")
      .toLocaleLowerCase()
      .includes(needle);
  });
}

async function loadVocabulary() {
  try {
    const result = await chrome.runtime.sendMessage({ action: "getVocabulary" });
    if (!result?.success) throw new Error(result?.error || "Could not load vocabulary");
    currentVocabularyEntries = Array.isArray(result.entries)
      ? result.entries
      : [];
    renderVocabularyLibrary();
  } catch (error) {
    const empty = document.getElementById("vocabularyEmpty");
    if (empty) {
      empty.style.display = "block";
      empty.textContent = error.message;
    }
  }
}

function playVocabularyOccurrence(occurrence) {
  if (occurrence.videoId && occurrence.videoId === currentVideoId) {
    seekTo(occurrence.timestampSeconds);
    return;
  }
  if (occurrence.url) chrome.tabs.create({ url: occurrence.url });
}

async function deleteVocabularyEntry(cardId) {
  const result = await chrome.runtime.sendMessage({
    action: "deleteVocabularyCard",
    cardId,
  });
  if (!result?.success) throw new Error(result?.error || "Could not delete word");
  await loadVocabulary();
}

function armVocabularyDelete(button, cardId) {
  if (button.dataset.confirming === "true") {
    button.disabled = true;
    button.textContent = "Deleting…";
    deleteVocabularyEntry(cardId).catch((error) => {
      button.disabled = false;
      button.dataset.confirming = "false";
      button.textContent = error.message;
    });
    return;
  }

  button.dataset.confirming = "true";
  button.textContent = "Confirm delete";
  setTimeout(() => {
    if (!button.isConnected || button.disabled) return;
    button.dataset.confirming = "false";
    button.textContent = "Delete";
  }, 3500);
}

function renderVocabularyOccurrence(occurrence, index) {
  return `
    <button class="vocabulary-occurrence" type="button" data-occurrence-index="${index}">
      <span class="vocabulary-occurrence-time">${escapeHtml(occurrence.timestamp || "")}</span>
      <span><strong>${escapeHtml(occurrence.form || "")}</strong> · ${escapeHtml(occurrence.videoTitle || "Unknown video")}</span>
      <small>${escapeHtml(occurrence.sentence || "")}</small>
    </button>
  `;
}

function renderVocabularyLibrary() {
  const list = document.getElementById("vocabularyList");
  const empty = document.getElementById("vocabularyEmpty");
  const count = document.getElementById("vocabularyCount");
  if (!list || !empty || !count) return;

  const filtered = filterVocabularyEntries(
    currentVocabularyEntries,
    vocabularySearchQuery,
  );
  count.textContent = vocabularySearchQuery.trim()
    ? `${filtered.length} of ${currentVocabularyEntries.length} words`
    : `${currentVocabularyEntries.length} saved ${currentVocabularyEntries.length === 1 ? "word" : "words"}`;
  list.innerHTML = "";

  if (!filtered.length) {
    empty.style.display = "block";
    empty.textContent = currentVocabularyEntries.length
      ? "No saved words match this search."
      : "Click an English word in a transcript, build its bilingual memory card, then add it here.";
    return;
  }
  empty.style.display = "none";

  filtered.forEach((entry) => {
    const details = document.createElement("details");
    details.className = "vocabulary-library-card";
    const occurrences = Array.isArray(entry.occurrences)
      ? entry.occurrences
      : [];
    details.innerHTML = `
      <summary>
        <span class="vocabulary-library-word">${escapeHtml(entry.lemma)}</span>
        <span class="vocabulary-library-pos">${escapeHtml(entry.ipa || "")} · ${escapeHtml(entry.partOfSpeech || "")}</span>
        <span class="vocabulary-library-zh">${escapeHtml(entry.meaningZh || "")}</span>
        <span class="vocabulary-library-source-count">${occurrences.length} ${occurrences.length === 1 ? "source" : "sources"}</span>
      </summary>
      <div class="vocabulary-library-body">
        <div class="vocabulary-library-meanings">
          ${vocabularyField("English meaning", entry.definitionEn, "en")}
          ${vocabularyField("中文释义", entry.meaningZh, "zh")}
        </div>
        <div class="vocabulary-library-sentence">${escapeHtml(entry.contextualMeaningEn || "")}<span>${escapeHtml(entry.contextualMeaningZh || "")}</span></div>
        ${renderVocabularyLearningPlan(entry)}
        <div class="vocabulary-occurrences">${occurrences.map(renderVocabularyOccurrence).join("")}</div>
        <div class="vocabulary-library-actions">
          <span>Forms: ${escapeHtml((entry.forms || []).join(", "))}</span>
          <button class="vocabulary-delete-btn" type="button">Delete</button>
        </div>
      </div>
    `;
    details.querySelectorAll(".vocabulary-occurrence").forEach((button) => {
      button.addEventListener("click", () =>
        playVocabularyOccurrence(
          occurrences[Number(button.dataset.occurrenceIndex)],
        ),
      );
    });
    details
      .querySelector(".vocabulary-delete-btn")
      ?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        armVocabularyDelete(event.currentTarget, entry.id);
      });
    list.appendChild(details);
  });
}

function csvCell(value) {
  const safe = String(value ?? "").replace(/^(\s*)([=+\-@])/, "$1'$2");
  return `"${safe.replaceAll('"', '""')}"`;
}

function vocabularySourcesText(entry) {
  return (entry.occurrences || [])
    .map(
      (occurrence) =>
        `${occurrence.timestamp || ""} | ${occurrence.form || ""} | ${occurrence.sentence || ""} | ${occurrence.videoTitle || ""} | ${occurrence.url || ""}`,
    )
    .join("\n");
}

function buildVocabularyCsv(entries) {
  const headers = [
    "Lemma",
    "Forms",
    "IPA",
    "Part of speech",
    "English meaning",
    "Chinese meaning",
    "Context meaning EN",
    "Context meaning ZH",
    "Morphology",
    "Collocations",
    "Mnemonic hook",
    "Memory scene EN",
    "Memory scene ZH",
    "Recall path",
    "Example",
    "Cloze",
    "Production prompt",
    "Context anchor · 语境锚点",
    "Collocation use · 搭配理解",
    "Morphology explanation · 词形说明",
    "Sound / keyword bridge · 声音 / 关键词桥",
    "Sound safeguard · 联想边界",
    "Contrast word · 易混词",
    "Contrast explanation · 易混对比",
    "Contrast example · 易混例句",
    "Meaning → word · 中文释义回忆",
    "Self explanation · 自我解释",
    "Example ZH · 新例句中文",
    "Review plan · 间隔复习",
    "Sources",
  ];
  const rows = (entries || []).map((entry) => {
    const plan = getVocabularyLearningPlan(entry);
    const reviewPlan = buildVocabularyReviewPlan(entry)
      .map((session) => `${session.day}: ${session.taskZh}`)
      .join("\n");
    return [
      entry.lemma,
      (entry.forms || []).join(", "),
      entry.ipa,
      entry.partOfSpeech,
      entry.definitionEn,
      entry.meaningZh,
      entry.contextualMeaningEn,
      entry.contextualMeaningZh,
      plan.morphology.breakdown,
      (entry.collocations || []).join(", "),
      plan.visualScene.hookZh,
      plan.visualScene.sceneEn,
      plan.visualScene.sceneZh,
      plan.visualScene.recallPathZh,
      plan.generation.exampleEn,
      plan.retrieval.clozePrompt,
      plan.retrieval.productionPrompt,
      plan.contextAnchor.explanationZh,
      plan.contextAnchor.collocationUseZh,
      plan.morphology.explanationZh,
      plan.soundBridge.cueZh,
      plan.soundBridge.safeguardZh,
      plan.contrast.relatedWordEn,
      plan.contrast.distinctionZh,
      plan.contrast.miniContrastEn,
      plan.retrieval.meaningToWordPrompt,
      plan.retrieval.selfExplainPrompt,
      plan.generation.exampleZh,
      reviewPlan,
      vocabularySourcesText(entry),
    ];
  });
  return `\uFEFF${[headers, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n")}\r\n`;
}

function markdownValue(value) {
  return String(value ?? "")
    .replaceAll("\\", "\\\\")
    .replace(/([`*_{}\[\]<>])/g, "\\$1")
    .trim();
}

function buildVocabularyMarkdown(entries) {
  const sections = (entries || []).map((entry) => {
    const plan = getVocabularyLearningPlan(entry);
    const reviewPlan = buildVocabularyReviewPlan(entry)
      .map(
        (session) =>
          `- **${markdownValue(session.day)}**：${markdownValue(session.taskZh)}`,
      )
      .join("\n");
    const sources = (entry.occurrences || [])
      .map(
        (occurrence) =>
          `- [${markdownValue(occurrence.timestamp || "Source")} · ${markdownValue(occurrence.videoTitle || "YouTube")}](${occurrence.url}) — ${markdownValue(occurrence.sentence)}`,
      )
      .join("\n");
    return `## ${markdownValue(entry.lemma)}

**${markdownValue(entry.ipa)} · ${markdownValue(entry.partOfSpeech)}**<br>
Forms: ${markdownValue((entry.forms || []).join(", "))}

### Meaning · 含义

- EN: ${markdownValue(entry.definitionEn)}
- 中文: ${markdownValue(entry.meaningZh)}
- In context: ${markdownValue(entry.contextualMeaningEn)}
- 原句含义: ${markdownValue(entry.contextualMeaningZh)}

Collocations: ${markdownValue((entry.collocations || []).join("; "))}

### 语境锚点

${markdownValue(plan.contextAnchor.explanationZh)}

搭配怎么记：${markdownValue(plan.contextAnchor.collocationUseZh)}

### 词形结构

${plan.morphology.available ? markdownValue(plan.morphology.breakdown) : "不强行拆分"}

${markdownValue(plan.morphology.explanationZh)}

### 声音 / 关键词桥

${markdownValue(plan.soundBridge.cueZh)}

边界：${markdownValue(plan.soundBridge.safeguardZh)}

### 画面链 · Memory scene

**${markdownValue(plan.visualScene.hookZh)}**

${markdownValue(plan.visualScene.sceneEn)}

${markdownValue(plan.visualScene.sceneZh)}

Recall path: ${markdownValue(plan.visualScene.recallPathZh)}

### 易混对比

- ${markdownValue(entry.lemma)} vs. ${markdownValue(plan.contrast.relatedWordEn)}：${markdownValue(plan.contrast.distinctionZh)}
- ${markdownValue(plan.contrast.miniContrastEn)}

### Active recall · 主动回忆

- 新例句：${markdownValue(plan.generation.exampleEn)}
- 新例句中文：${markdownValue(plan.generation.exampleZh)}
- Fill the gap: ${markdownValue(plan.retrieval.clozePrompt)}
- Meaning → word: ${markdownValue(plan.retrieval.meaningToWordPrompt)}
- Use it: ${markdownValue(plan.retrieval.productionPrompt)}
- Self-explain: ${markdownValue(plan.retrieval.selfExplainPrompt)}

### 间隔复习

${reviewPlan}

### Sources

${sources || "- No source saved"}`;
  });
  return `# YouTube Digest Vocabulary

${sections.join("\n\n---\n\n")}
`;
}

function escapeAnkiHtml(value) {
  return String(value ?? "")
    .replace(/\t/g, " ")
    .split(/\r?\n/)
    .map((line) =>
      line
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;"),
    )
    .join("<br>");
}

function buildVocabularyAnkiTsv(entries) {
  const rows = (entries || []).map((entry) => {
    const source = entry.occurrences?.[0] || {};
    const plan = getVocabularyLearningPlan(entry);
    const reviewPlan = buildVocabularyReviewPlan(entry)
      .map((session) => `${session.day}: ${session.taskZh}`)
      .join("\n");
    const front = [
      `<b>Fill the gap</b><br>${escapeAnkiHtml(plan.retrieval.clozePrompt)}`,
      `<br><br><b>Meaning → word</b><br>${escapeAnkiHtml(plan.retrieval.meaningToWordPrompt)}`,
      `<br><br><b>Use it</b><br>${escapeAnkiHtml(plan.retrieval.productionPrompt)}`,
    ].join("");
    const back = [
      `<b>${escapeAnkiHtml(entry.lemma)}</b> ${escapeAnkiHtml(entry.ipa)} · ${escapeAnkiHtml(entry.partOfSpeech)}`,
      `<br>${escapeAnkiHtml(entry.definitionEn)} · ${escapeAnkiHtml(entry.meaningZh)}`,
      `<br><br><b>Source</b><br>${escapeAnkiHtml(source.sentence || "")}`,
      `<br><br><b>Context anchor · 语境锚点</b><br>${escapeAnkiHtml(plan.contextAnchor.explanationZh)}<br>${escapeAnkiHtml(plan.contextAnchor.collocationUseZh)}`,
      `<br><br><b>Word form · 词形结构</b><br>${escapeAnkiHtml(plan.morphology.breakdown)}<br>${escapeAnkiHtml(plan.morphology.explanationZh)}`,
      `<br><br><b>Sound / keyword bridge · 声音 / 关键词桥</b><br>${escapeAnkiHtml(plan.soundBridge.cueZh)}<br>${escapeAnkiHtml(plan.soundBridge.safeguardZh)}`,
      `<br><br><b>Memory scene · 记忆画面</b><br>${escapeAnkiHtml(plan.visualScene.hookZh)}<br>${escapeAnkiHtml(plan.visualScene.sceneEn)}<br>${escapeAnkiHtml(plan.visualScene.sceneZh)}`,
      `<br><b>Recall</b>: ${escapeAnkiHtml(plan.visualScene.recallPathZh)}`,
      `<br><br><b>Contrast · 易混对比</b><br>${escapeAnkiHtml(entry.lemma)} vs. ${escapeAnkiHtml(plan.contrast.relatedWordEn)}<br>${escapeAnkiHtml(plan.contrast.distinctionZh)}<br>${escapeAnkiHtml(plan.contrast.miniContrastEn)}`,
      `<br><br><b>New example · 新例句</b><br>${escapeAnkiHtml(plan.generation.exampleEn)}<br>${escapeAnkiHtml(plan.generation.exampleZh)}`,
      `<br><br><b>Self-explain</b><br>${escapeAnkiHtml(plan.retrieval.selfExplainPrompt)}`,
      `<br><br><b>Spaced review · 间隔复习</b><br>${escapeAnkiHtml(reviewPlan)}`,
      `<br><br><b>Collocations</b>: ${escapeAnkiHtml((entry.collocations || []).join("; "))}`,
      source.url
        ? `<br><br><a href="${escapeAnkiHtml(source.url)}">${escapeAnkiHtml(source.timestamp || "YouTube source")}</a>`
        : "",
    ].join("");
    return `${front}\t${back}`;
  });
  const headers = ["#separator:tab", "#html:true", "#columns:Front\tBack"];
  return `${headers.join("\n")}\n${rows.join("\n")}${rows.length ? "\n" : ""}`;
}

function exportVocabulary(format) {
  const status = document.getElementById("vocabularyExportStatus");
  const entries = filterVocabularyEntries(
    currentVocabularyEntries,
    vocabularySearchQuery,
  );
  if (!entries.length) {
    if (status) status.textContent = "No matching words to export.";
    return;
  }

  const exports = {
    csv: {
      text: buildVocabularyCsv(entries),
      filename: "youtube-digest-vocabulary.csv",
      mime: "text/csv;charset=utf-8",
    },
    markdown: {
      text: buildVocabularyMarkdown(entries),
      filename: "youtube-digest-vocabulary.md",
      mime: "text/markdown;charset=utf-8",
    },
    anki: {
      text: buildVocabularyAnkiTsv(entries),
      filename: "youtube-digest-vocabulary-anki.tsv",
      mime: "text/tab-separated-values;charset=utf-8",
    },
  };
  const selected = exports[format];
  if (!selected) return;
  downloadTextFile(selected.text, selected.filename, selected.mime);
  if (status) {
    status.textContent = `Exported ${entries.length} ${entries.length === 1 ? "word" : "words"} as ${format === "anki" ? "Anki TSV" : format.toUpperCase()}.`;
  }
}

async function copyToClipboard(text, token = null) {
  if (token && !isCurrentVideoSession(token)) return false;
  try {
    if (token && !isCurrentVideoSession(token)) return false;
    await navigator.clipboard.writeText(text);
    if (token && !isCurrentVideoSession(token)) return false;
    return true;
  } catch (error) {
    console.error("Copy failed:", error);
    return false;
  }
}

async function copyToClipboardWithFeedback(text, buttonId, token = null) {
  const btn = document.getElementById(buttonId);
  if (!btn || (token && !isCurrentVideoSession(token))) return;
  const original = btn.textContent;

  const success = await copyToClipboard(text, token);
  if (success && (!token || isCurrentVideoSession(token))) {
    btn.textContent = "✓ Copied";
    setTimeout(() => {
      if (token && !isCurrentVideoSession(token)) return;
      btn.textContent = original;
    }, 2000);
  }
}

function downloadTextFile(
  text,
  filename,
  mimeType = "text/plain;charset=utf-8",
  token = null,
) {
  if (token && !isCurrentVideoSession(token)) return false;
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  if (token && !isCurrentVideoSession(token)) {
    URL.revokeObjectURL(url);
    return false;
  }
  a.click();
  URL.revokeObjectURL(url);
  return true;
}

function sanitizeFilename(str) {
  return (str || "untitled")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .substring(0, 50)
    .toLowerCase();
}

// ============================================================
// TEXT SELECTION — EXPLAIN FEATURE
// ============================================================

/**
 * Sets up text selection handling in the transcript.
 * When user selects text, shows an "Explain" button.
 */
function setupExplainFeature() {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return;
  if (!currentTranscriptFingerprint || !currentDigestBaseReady) return;

  teardownExplainFeature();
  const token = captureVideoSession();
  if (!isCurrentVideoSession(token)) return;

  // Create the explain tooltip/button
  const tooltip = document.createElement("div");
  tooltip.id = "explainTooltip";
  tooltip.className = "explain-tooltip";
  tooltip.innerHTML = `<button class="explain-btn">💡 Explain</button>`;
  tooltip.style.display = "none";
  document.body.appendChild(tooltip);

  let selectedText = "";

  // Interacting with Explain must preserve the transcript selection and stay
  // isolated from document/row click behavior.
  tooltip.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  tooltip.addEventListener("mouseup", (event) => {
    event.stopPropagation();
  });
  tooltip.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  // Listen for text selection
  const handleSelectionMouseUp = () => {
    if (!isCurrentVideoSession(token)) return;
    const selection = window.getSelection();
    if (!selection) return;
    const text = selection.toString().trim();

    // Only show if selecting within transcript
    const isInTranscript = transcriptList.contains(selection.anchorNode);

    // Allow any selection length (removed 10+ char requirement)
    if (text.length > 0 && isInTranscript) {
      selectedText = text;

      // Position the tooltip near the selection
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();

      tooltip.style.display = "block";
      tooltip.style.top = `${rect.bottom + window.scrollY + 8}px`;
      tooltip.style.left = `${rect.left + rect.width / 2}px`;
    } else {
      tooltip.style.display = "none";
    }
  };
  document.addEventListener("mouseup", handleSelectionMouseUp);

  // Hide tooltip when clicking elsewhere
  const handleOutsideMouseDown = (e) => {
    if (!tooltip.contains(e.target)) {
      tooltip.style.display = "none";
    }
  };
  document.addEventListener("mousedown", handleOutsideMouseDown);

  // Handle explain button click
  const explainButton = tooltip.querySelector(".explain-btn");
  const handleExplainClick = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!selectedText || !isCurrentVideoSession(token)) return;

    tooltip.style.display = "none";
    await showExplanation(selectedText, token);
  };
  explainButton.addEventListener("click", handleExplainClick);

  const cleanup = () => {
    document.removeEventListener("mouseup", handleSelectionMouseUp);
    document.removeEventListener("mousedown", handleOutsideMouseDown);
    explainButton.removeEventListener("click", handleExplainClick);
    tooltip.remove();
    if (explainFeatureCleanup === cleanup) explainFeatureCleanup = null;
  };
  explainFeatureCleanup = cleanup;
}

function teardownExplainFeature() {
  const cleanup = explainFeatureCleanup;
  explainFeatureCleanup = null;
  if (cleanup) cleanup();
  else document.getElementById("explainTooltip")?.remove();
}

/**
 * Shows the explanation modal and fetches it from the configured AI provider.
 */
async function showExplanation(
  selectedText,
  token = captureVideoSession(),
) {
  if (
    !isCurrentVideoSession(token) ||
    !currentTranscriptFingerprint
  ) return;
  const digestBaseReady = await ensureDigestBaseReady(token);
  if (!isCurrentVideoSession(token) || !digestBaseReady) return;
  const videoTitle = currentVideoTitle;
  // Create modal
  const modal = document.createElement("div");
  modal.id = "explainModal";
  modal.className = "explain-modal-overlay";
  modal.innerHTML = `
    <div class="explain-modal">
      <div class="explain-modal-header">
        <div class="explain-modal-title">Explain</div>
        <button class="explain-modal-close" id="closeExplain">✕</button>
      </div>
      <div class="explain-selected-text">"${escapeHtml(selectedText.substring(0, 200))}${selectedText.length > 200 ? "..." : ""}"</div>
      <div class="explain-modal-content" id="explanationContent">
        <div class="explain-loading">
          <div class="loading-bar"></div>
          <span>Analyzing...</span>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Close handlers
  document
    .getElementById("closeExplain")
    .addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });

  // Get some context around the selection from the transcript
  const transcriptContext = getTranscriptContext(selectedText);

  // Fetch explanation
  try {
    const result = await sendVideoSessionMessage({
      action: "explainSelection",
      selectedText: selectedText,
      transcriptContext: transcriptContext,
      videoTitle,
    }, token);

    if (!isCurrentSessionResponse(token, result)) {
      modal.remove();
      return;
    }
    const contentDiv = document.getElementById("explanationContent");
    if (result.success) {
      contentDiv.innerHTML = `<div class="explain-text">${escapeHtml(result.explanation).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</div>`;
    } else {
      contentDiv.innerHTML = `<div class="explain-error">Failed to get explanation: ${escapeHtml(result.error)}</div>`;
    }
  } catch (error) {
    if (!isCurrentVideoSession(token)) {
      modal.remove();
      return;
    }
    const contentDiv = document.getElementById("explanationContent");
    contentDiv.innerHTML = `<div class="explain-error">Error: ${escapeHtml(error.message)}</div>`;
  }
}

/**
 * Gets surrounding context from the transcript for the selected text.
 */
function getTranscriptContext(selectedText) {
  const fullText = currentTranscriptText || "";
  const index = fullText.indexOf(selectedText);

  if (index === -1) return "";

  // Get 200 chars before and after
  const start = Math.max(0, index - 200);
  const end = Math.min(fullText.length, index + selectedText.length + 200);

  return fullText.substring(start, end);
}

// ============================================================
// CACHING
// ============================================================

function cachedOwnData(value, key) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return { present: false, valid: false, value: undefined };
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return { present: false, valid: true, value: undefined };
    if (!Object.hasOwn(descriptor, "value")) {
      return { present: true, valid: false, value: undefined };
    }
    return { present: true, valid: true, value: descriptor.value };
  } catch {
    return { present: false, valid: false, value: undefined };
  }
}

function cachedOwnKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    return Object.keys(value);
  } catch {
    return null;
  }
}

function snapshotCachedData(value, state = null, depth = 0) {
  const budget = state || { properties: 0, units: 0, seen: new Set() };
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    budget.units += value.length;
    return budget.units <= DIGEST_CACHE_MAX_INPUT_UNITS
      ? value
      : INVALID_CACHED_DATA;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : INVALID_CACHED_DATA;
  }
  if (typeof value !== "object" || depth >= DIGEST_CACHE_MAX_DEPTH) {
    return INVALID_CACHED_DATA;
  }
  if (budget.seen.has(value)) return INVALID_CACHED_DATA;
  budget.seen.add(value);

  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    budget.seen.delete(value);
    return INVALID_CACHED_DATA;
  }
  const keys = Object.keys(descriptors);
  budget.properties += keys.length;
  if (budget.properties > DIGEST_CACHE_MAX_PROPERTIES) {
    budget.seen.delete(value);
    return INVALID_CACHED_DATA;
  }

  if (Array.isArray(value)) {
    const lengthDescriptor = descriptors.length;
    const length = lengthDescriptor?.value;
    if (
      !lengthDescriptor ||
      !Object.hasOwn(lengthDescriptor, "value") ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > DIGEST_CACHE_MAX_PROPERTIES
    ) {
      budget.seen.delete(value);
      return INVALID_CACHED_DATA;
    }
    const copy = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) {
        budget.seen.delete(value);
        return INVALID_CACHED_DATA;
      }
      const item = snapshotCachedData(descriptor.value, budget, depth + 1);
      if (item === INVALID_CACHED_DATA) {
        budget.seen.delete(value);
        return INVALID_CACHED_DATA;
      }
      copy.push(item);
    }
    budget.seen.delete(value);
    return copy;
  }

  const copy = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, "value")) {
      budget.seen.delete(value);
      return INVALID_CACHED_DATA;
    }
    budget.units += key.length;
    if (budget.units > DIGEST_CACHE_MAX_INPUT_UNITS) {
      budget.seen.delete(value);
      return INVALID_CACHED_DATA;
    }
    const item = snapshotCachedData(descriptor.value, budget, depth + 1);
    if (item === INVALID_CACHED_DATA) {
      budget.seen.delete(value);
      return INVALID_CACHED_DATA;
    }
    Object.defineProperty(copy, key, {
      value: item,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  budget.seen.delete(value);
  return copy;
}

function snapshotCachedTranscript(value) {
  if (!Array.isArray(value)) return null;
  const lengthData = cachedOwnData(value, "length");
  const length = lengthData.value;
  if (
    !lengthData.valid ||
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > DIGEST_CACHE_MAX_PROPERTIES
  ) return null;

  const transcript = [];
  let inputUnits = 0;
  for (let index = 0; index < length; index += 1) {
    const entryData = cachedOwnData(value, String(index));
    const entry = entryData.value;
    if (
      !entryData.present ||
      !entryData.valid ||
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry)
    ) return null;
    const textData = cachedOwnData(entry, "text");
    const startData = cachedOwnData(entry, "start");
    const durationData = cachedOwnData(entry, "duration");
    const languageData = cachedOwnData(entry, "language");
    if (
      !textData.present ||
      !textData.valid ||
      typeof textData.value !== "string" ||
      !startData.present ||
      !startData.valid ||
      !Number.isFinite(startData.value) ||
      startData.value < 0 ||
      !durationData.present ||
      !durationData.valid ||
      !Number.isFinite(durationData.value) ||
      durationData.value < 0 ||
      !languageData.valid ||
      (languageData.present && typeof languageData.value !== "string")
    ) return null;
    inputUnits += textData.value.length + (languageData.value?.length || 0);
    if (inputUnits > DIGEST_CACHE_MAX_INPUT_UNITS) return null;
    const normalized = {
      text: textData.value,
      start: startData.value,
      duration: durationData.value,
    };
    if (languageData.present) normalized.language = languageData.value;
    transcript.push(normalized);
  }
  return transcript;
}

function cachedStringField(cached, key, { required = false } = {}) {
  const field = cachedOwnData(cached, key);
  if (!field.valid || (required && !field.present)) return INVALID_CACHED_DATA;
  if (!field.present) return "";
  if (
    typeof field.value !== "string" ||
    field.value.length > DIGEST_CACHE_MAX_INPUT_UNITS
  ) return INVALID_CACHED_DATA;
  return field.value;
}

function resolvedCachedDeepAnalysis(cached) {
  const deep = cachedOwnData(cached, "deepAnalysis");
  if (!deep.valid) return null;
  let selected;
  if (deep.present) {
    selected = deep.value;
  } else {
    const legacy = cachedOwnData(cached, "analysis");
    if (!legacy.valid) return null;
    selected = legacy.present ? legacy.value : null;
  }
  if (selected === null) return null;
  if (!selected || typeof selected !== "object" || Array.isArray(selected)) {
    return null;
  }
  const snapshot = snapshotCachedData(selected);
  return snapshot === INVALID_CACHED_DATA || !snapshot || Array.isArray(snapshot)
    ? null
    : snapshot;
}

function normalizeCachedBasicOverview(
  cached,
  segments,
  transcriptFingerprint,
  now,
) {
  const field = cachedOwnData(cached, "basicOverview");
  if (!field.present || !field.valid || !field.value) return null;
  const snapshot = snapshotCachedData(field.value);
  if (
    snapshot === INVALID_CACHED_DATA ||
    !snapshot ||
    Array.isArray(snapshot)
  ) return null;
  const fingerprint = cachedOwnData(snapshot, "transcriptFingerprint");
  const generatedAt = cachedOwnData(snapshot, "generatedAt");
  if (
    !fingerprint.present ||
    !fingerprint.valid ||
    fingerprint.value !== transcriptFingerprint ||
    !generatedAt.present ||
    !generatedAt.valid ||
    !Number.isSafeInteger(generatedAt.value) ||
    generatedAt.value < 0 ||
    generatedAt.value > now
  ) return null;
  try {
    return YTD_OVERVIEW.normalizeBasicOverview(snapshot, segments, {
      transcriptFingerprint,
      generatedAt: generatedAt.value,
    });
  } catch {
    return null;
  }
}

/**
 * Rebuilds one storage digest into the only cache view the panel may consume.
 * Every accepted field is an own data property; the raw object is never spread.
 */
async function normalizeCachedDigestView(
  cached,
  { videoId, now } = {},
) {
  const clock = typeof now === "function"
    ? now
    : now === undefined
      ? () => Date.now()
      : () => now;
  let initialNow;
  try {
    initialNow = clock();
  } catch {
    return null;
  }
  if (
    !cached ||
    typeof cached !== "object" ||
    Array.isArray(cached) ||
    typeof videoId !== "string" ||
    !Number.isSafeInteger(initialNow) ||
    initialNow < 0
  ) return null;
  const timestamp = cachedOwnData(cached, "timestamp");
  if (
    !timestamp.present ||
    !timestamp.valid ||
    !Number.isSafeInteger(timestamp.value) ||
    timestamp.value < 0 ||
    timestamp.value > initialNow ||
    initialNow - timestamp.value >= DIGEST_CACHE_TTL_MS
  ) return null;

  const schema = cachedOwnData(cached, "digestSchemaVersion");
  if (!schema.valid) return null;
  const isV2 = schema.present && schema.value === DIGEST_CACHE_SCHEMA_VERSION;
  if (schema.present && !isV2) return null;
  const transcriptData = cachedOwnData(cached, "transcript");
  if (!transcriptData.present || !transcriptData.valid) return null;
  const transcript = snapshotCachedTranscript(transcriptData.value);
  if (!transcript) return null;

  const transcriptText = cachedStringField(cached, "transcriptText", {
    required: isV2,
  });
  const transcriptTimestamped = cachedStringField(
    cached,
    "transcriptTimestamped",
    { required: isV2 },
  );
  const videoTitle = cachedStringField(cached, "videoTitle", { required: isV2 });
  const channelName = cachedStringField(cached, "channelName", {
    required: isV2,
  });
  if (
    transcriptText === INVALID_CACHED_DATA ||
    transcriptTimestamped === INVALID_CACHED_DATA ||
    videoTitle === INVALID_CACHED_DATA ||
    channelName === INVALID_CACHED_DATA
  ) return null;
  const languageData = cachedOwnData(cached, "transcriptLanguage");
  if (
    !languageData.valid ||
    (isV2 && !languageData.present) ||
    (languageData.present &&
      languageData.value !== null &&
      typeof languageData.value !== "string")
  ) return null;
  const transcriptLanguage = YTD_TRANSCRIPT_CORE.resolveTranscriptLanguage(
    languageData.present ? languageData.value : null,
    transcript,
  );
  const segments = createCanonicalTranscriptSegments(transcript);
  if (!segments.length) return null;
  const storedFingerprint = cachedOwnData(cached, "transcriptFingerprint");
  if (
    !storedFingerprint.valid ||
    (isV2 &&
      (!storedFingerprint.present ||
        typeof storedFingerprint.value !== "string")) ||
    (storedFingerprint.present && typeof storedFingerprint.value !== "string")
  ) return null;
  const deepAnalysis = resolvedCachedDeepAnalysis(cached);

  let transcriptFingerprint;
  try {
    transcriptFingerprint = await YTD_TRANSCRIPT_CORE.fingerprintSegments(
      segments,
      { sourceLanguage: transcriptLanguage || "" },
    );
  } catch (error) {
    if (!isTranscriptFingerprintError(error)) throw error;
    let observedNow;
    try {
      observedNow = clock();
    } catch {
      return null;
    }
    if (
      !Number.isSafeInteger(observedNow) ||
      observedNow < initialNow ||
      timestamp.value > observedNow ||
      observedNow - timestamp.value >= DIGEST_CACHE_TTL_MS
    ) return null;
    const mayUseCachedDeepWithoutFingerprint =
      (isV2 &&
        storedFingerprint.present &&
        /^sha256-v1-[a-f0-9]{64}$/.test(storedFingerprint.value)) ||
      (!isV2 && !storedFingerprint.present);
    return {
      digestSchemaVersion: DIGEST_CACHE_SCHEMA_VERSION,
      transcript,
      transcriptText,
      transcriptTimestamped,
      transcriptLanguage,
      transcriptFingerprint: null,
      transcriptSegments: segments,
      videoTitle,
      channelName,
      deepAnalysis: mayUseCachedDeepWithoutFingerprint ? deepAnalysis : null,
      basicOverview: null,
      paragraphCacheEntries: [],
      paragraphCacheMigrated: false,
      needsBaseMigration: false,
      transcriptFingerprintUnavailable: true,
    };
  }

  let observedNow;
  try {
    observedNow = clock();
  } catch {
    return null;
  }
  if (
    !Number.isSafeInteger(observedNow) ||
    observedNow < initialNow ||
    timestamp.value > observedNow ||
    observedNow - timestamp.value >= DIGEST_CACHE_TTL_MS
  ) return null;

  const claimedFingerprint = storedFingerprint.present
    ? storedFingerprint.value
    : "";
  if (isV2 && claimedFingerprint !== transcriptFingerprint) return null;
  const derivedProvenanceMatches =
    isV2 ||
    !storedFingerprint.present ||
    claimedFingerprint === transcriptFingerprint;
  const paragraph = cachedOwnData(cached, "paragraphCache");
  const paragraphKeys = paragraph.present
    ? cachedOwnKeys(paragraph.value)
    : [];
  const restored =
    derivedProvenanceMatches &&
    paragraph.valid &&
    paragraphKeys &&
    paragraphKeys.length <= PARAGRAPH_CACHE_MAX_ENTRIES
    ? prepareCachedParagraphTranslations({
        videoId,
        paragraphCache: paragraph.present ? paragraph.value : null,
        cachedTranscriptFingerprint: claimedFingerprint,
        currentTranscriptFingerprint: transcriptFingerprint,
        segments,
      })
    : { entries: [], migrated: false };

  return {
    digestSchemaVersion: DIGEST_CACHE_SCHEMA_VERSION,
    transcript,
    transcriptText,
    transcriptTimestamped,
    transcriptLanguage,
    transcriptFingerprint,
    transcriptSegments: segments,
    videoTitle,
    channelName,
    deepAnalysis: derivedProvenanceMatches ? deepAnalysis : null,
    basicOverview: derivedProvenanceMatches
      ? normalizeCachedBasicOverview(
          cached,
          segments,
          transcriptFingerprint,
          observedNow,
        )
      : null,
    paragraphCacheEntries: restored.entries,
    paragraphCacheMigrated: restored.migrated,
    needsBaseMigration: !isV2,
    transcriptFingerprintUnavailable: false,
  };
}

/**
 * Saves the current digest results to persistent local storage.
 * Results survive browser restarts — reopening the same video loads from cache
 * without consuming API tokens or Supadata calls.
 * The background coordinator enforces reset epochs and the digest byte budget.
 */
function observeDigestBaseClock(token = captureVideoSession()) {
  if (!isCurrentVideoSession(token)) return null;
  let observedAt;
  try {
    observedAt = Date.now();
  } catch {
    return null;
  }
  if (
    !Number.isSafeInteger(observedAt) ||
    observedAt < 0 ||
    observedAt < currentDigestBaseLastObservedAt
  ) return null;
  currentDigestBaseLastObservedAt = observedAt;
  return observedAt;
}

function invalidateDigestBaseReadiness(token = captureVideoSession()) {
  if (!isCurrentVideoSession(token)) return;
  currentDigestBaseReady = false;
  currentDigestBaseValidUntil = 0;
}

function digestBaseIsFresh(token = captureVideoSession()) {
  if (!isCurrentVideoSession(token) || !currentDigestBaseReady) return false;
  const observedAt = observeDigestBaseClock(token);
  if (
    observedAt === null ||
    !Number.isSafeInteger(currentDigestBaseValidUntil) ||
    observedAt >= currentDigestBaseValidUntil
  ) {
    invalidateDigestBaseReadiness(token);
    return false;
  }
  return true;
}

function validatedDigestBaseAcknowledgement(result, token) {
  if (!isCurrentSessionResponse(token, result) || result.success !== true) {
    return null;
  }
  const timestamp = cachedOwnData(result, "timestamp");
  const observedAt = observeDigestBaseClock(token);
  if (
    observedAt === null ||
    !timestamp.present ||
    !timestamp.valid ||
    !Number.isSafeInteger(timestamp.value) ||
    timestamp.value < 0 ||
    timestamp.value > observedAt
  ) return null;
  const validUntil = timestamp.value + DIGEST_CACHE_TTL_MS;
  if (
    !Number.isSafeInteger(validUntil) ||
    observedAt >= validUntil
  ) return null;
  return { observedAt, validUntil };
}

async function persistDigestBase(token = captureVideoSession()) {
  if (
    !isCurrentVideoSession(token) ||
    !currentTranscript ||
    !currentTranscriptFingerprint
  ) return false;

  if (observeDigestBaseClock(token) === null) return false;

  try {
    const cacheData = {
      transcript: currentTranscript,
      transcriptText: currentTranscriptText,
      transcriptTimestamped: currentTranscriptTimestamped,
      transcriptLanguage: currentTranscriptLanguage,
      transcriptFingerprint: currentTranscriptFingerprint,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
    };

    if (!isCurrentVideoSession(token)) return false;
    const result = await sendVideoSessionMessage({
      action: "persistDigestBase",
      expectedEpoch: token.resetEpoch,
      videoId: token.videoId,
      tabId: token.tabId,
      value: cacheData,
    }, token);
    const acknowledgement = validatedDigestBaseAcknowledgement(result, token);
    if (!acknowledgement) return false;
    debugLog(
      "Saved transcript base to cache:",
      token.videoId,
    );
    return acknowledgement;
  } catch {
    // Caching is best-effort; the active in-memory transcript remains usable.
    return false;
  }
}

async function ensureDigestBaseReady(token = captureVideoSession()) {
  if (!isCurrentVideoSession(token) || !currentTranscriptFingerprint) {
    return false;
  }
  if (digestBaseIsFresh(token)) return true;
  invalidateDigestBaseReadiness(token);
  if (digestBaseReadyInFlight?.sessionId === token.sessionId) {
    return digestBaseReadyInFlight.promise;
  }
  const promise = persistDigestBase(token).then((acknowledgement) => {
    if (isCurrentVideoSession(token)) {
      const ready = Boolean(acknowledgement);
      const becameReady = !currentDigestBaseReady && ready;
      currentDigestBaseReady = ready;
      currentDigestBaseValidUntil = ready
        ? acknowledgement.validUntil
        : 0;
      if (becameReady) setupExplainFeature();
    }
    return isCurrentVideoSession(token) && Boolean(acknowledgement);
  });
  digestBaseReadyInFlight = { sessionId: token.sessionId, promise };
  try {
    return await promise;
  } finally {
    if (digestBaseReadyInFlight?.promise === promise) {
      digestBaseReadyInFlight = null;
    }
  }
}

function boundedDigestPatchResult(result) {
  if (result?.success === true) return { success: true };
  const code =
    typeof result?.code === "string" &&
    /^[A-Z0-9_]{1,64}$/.test(result.code)
      ? result.code
      : "DIGEST_CACHE_WRITE_FAILED";
  return { success: false, code };
}

async function sendDigestPatchOnce(patch, token) {
  try {
    const result = await sendVideoSessionMessage({
      action: "patchDigestCache",
      expectedEpoch: token.resetEpoch,
      videoId: token.videoId,
      tabId: token.tabId,
      transcriptFingerprint: currentTranscriptFingerprint,
      patch,
    }, token);
    if (!isCurrentSessionResponse(token, result)) {
      return { success: false, code: "SESSION_STALE" };
    }
    return boundedDigestPatchResult(result);
  } catch {
    return { success: false, code: "DIGEST_CACHE_WRITE_FAILED" };
  }
}

async function patchDigestCache(
  patch,
  token = captureVideoSession(),
) {
  if (
    !isCurrentVideoSession(token) ||
    !currentTranscriptFingerprint ||
    !patch ||
    typeof patch !== "object" ||
    Array.isArray(patch)
  ) return { success: false, code: "INVALID_DIGEST_PATCH" };

  if (!(await ensureDigestBaseReady(token))) {
    return { success: false, code: "DIGEST_BASE_UNAVAILABLE" };
  }
  if (!isCurrentVideoSession(token)) {
    return { success: false, code: "SESSION_STALE" };
  }

  let result = await sendDigestPatchOnce(patch, token);
  if (result.success === true) {
    debugLog("Patched derived digest cache:", token.videoId);
    return result;
  }
  if (result.code !== "DIGEST_EXPIRED" || !isCurrentVideoSession(token)) {
    return result;
  }

  // The worker may cross the expiry boundary after the panel's last local
  // clock check. Force a coordinator-owned rebase, then retry only this cache
  // mutation. The already-paid provider request is never repeated.
  invalidateDigestBaseReadiness(token);
  if (!(await ensureDigestBaseReady(token))) {
    return { success: false, code: "DIGEST_BASE_UNAVAILABLE" };
  }
  if (!isCurrentVideoSession(token)) {
    return { success: false, code: "SESSION_STALE" };
  }
  result = await sendDigestPatchOnce(patch, token);
  if (result.success === true) {
    debugLog("Patched derived digest cache after rebase:", token.videoId);
  }
  return result;
}

/**
 * Loads digest results from persistent local storage.
 * Returns null if not cached or expired (30-day expiry).
 */
async function loadFromCache(videoId, token = captureVideoSession()) {
  if (!isCurrentVideoSession(token) || token.videoId !== videoId) return null;

  try {
    const result = await chrome.storage.local.get(`digest_${videoId}`);
    if (!isCurrentVideoSession(token)) return null;
    const cached = result[`digest_${videoId}`];
    if (!cached) return null;
    let lastObservedTime = null;
    const cacheClock = () => {
      const observed = Date.now();
      if (
        !Number.isSafeInteger(observed) ||
        observed < 0 ||
        (lastObservedTime !== null && observed < lastObservedTime)
      ) {
        throw new TypeError("Digest cache clock is invalid.");
      }
      lastObservedTime = observed;
      return observed;
    };
    const view = await normalizeCachedDigestView(cached, {
      videoId,
      now: cacheClock,
    });
    if (!view || !isCurrentVideoSession(token)) return null;
    const beforeEpochCheck = Date.now();
    if (
      !Number.isSafeInteger(beforeEpochCheck) ||
      beforeEpochCheck < 0 ||
      beforeEpochCheck < lastObservedTime
    ) {
      return null;
    }
    lastObservedTime = beforeEpochCheck;

    const epochResult = await chrome.runtime.sendMessage({
      action: "getResetEpoch",
    });
    const finalNow = Date.now();
    const timestamp = cachedOwnData(cached, "timestamp");
    if (
      !isCurrentVideoSession(token) ||
      !Number.isSafeInteger(finalNow) ||
      finalNow < beforeEpochCheck ||
      !timestamp.present ||
      !timestamp.valid ||
      !Number.isSafeInteger(timestamp.value) ||
      timestamp.value > finalNow ||
      finalNow - timestamp.value >= DIGEST_CACHE_TTL_MS ||
      !epochResult ||
      epochResult.success !== true ||
      !Number.isSafeInteger(epochResult.resetEpoch) ||
      epochResult.resetEpoch < 0 ||
      epochResult.resetEpoch !== token.resetEpoch
    ) return null;
    const validUntil = timestamp.value + DIGEST_CACHE_TTL_MS;
    if (
      !Number.isSafeInteger(validUntil) ||
      finalNow >= validUntil
    ) return null;
    Object.defineProperties(view, {
      digestBaseValidUntil: {
        value: validUntil,
        enumerable: false,
      },
      digestBaseObservedAt: {
        value: finalNow,
        enumerable: false,
      },
    });
    return view;
  } catch (error) {
    if (isTranscriptFingerprintError(error)) throw error;
    if (isCurrentVideoSession(token)) {
      console.error("Cache load error:", error);
    }
    return null;
  }
}

// ============================================================
// NOTES
// ============================================================

/**
 * Loads and renders notes from storage.
 * @param {string|null} videoId - Filter by video ID, or null for all notes
 */
async function loadNotes(videoId, token = captureVideoSession()) {
  if (!isCurrentVideoSession(token)) return;
  try {
    const result = await sendVideoSessionMessage({
      action: "getNotes",
      videoId: videoId,
    }, token);

    if (isCurrentSessionResponse(token, result) && result.success) {
      renderNotes(result.notes, videoId);
    }
  } catch {
    // Notes are secondary and stale/closed sessions are silently ignored.
  }
}

/**
 * Renders the notes list in the Notes tab.
 */
function renderNotes(notes, filteredVideoId) {
  const notesList = document.getElementById("notesList");
  const notesIntro = document.getElementById("notesIntro");

  if (!notesList) return;

  notesList.innerHTML = "";

  if (!notes || notes.length === 0) {
    notesIntro.style.display = "block";
    notesIntro.textContent = filteredVideoId
      ? "No notes for this video yet. Hover over the video and click 📝 Note to save."
      : "No notes saved yet. Hover over a video and click 📝 Note to save.";
    return;
  }

  notesIntro.style.display = "none";

  notes.forEach((note) => {
    const noteEl = document.createElement("div");
    noteEl.className = "note-item";
    noteEl.innerHTML = `
      <div class="note-header">
        <span class="note-timestamp" data-url="${escapeHtml(note.timestampedUrl)}" data-seconds="${Number(note.timestampSeconds) || 0}">${escapeHtml(note.timestamp)}</span>
        ${!filteredVideoId ? `<span class="note-video-title">${escapeHtml(note.videoTitle)}</span>` : ""}
        <button class="note-delete" data-id="${escapeHtml(note.id)}" title="Delete note">✕</button>
      </div>
      <div class="note-text">"${escapeHtml(note.text)}"</div>
      <div class="note-actions">
        <button class="note-action-btn note-copy-text">⧉ Copy text</button>
        <button class="note-action-btn note-copy-link" data-url="${escapeHtml(note.timestampedUrl)}">🔗 Copy timestamp</button>
        <button class="note-action-btn note-play" data-seconds="${Number(note.timestampSeconds) || 0}">▶ Play</button>
      </div>
    `;

    // Timestamp click - play from this point (in this tab or a new one)
    noteEl.querySelector(".note-timestamp").addEventListener("click", () => {
      playNote(note);
    });

    // Delete button
    noteEl
      .querySelector(".note-delete")
      .addEventListener("click", async (e) => {
        e.stopPropagation();
        const token = captureVideoSession();
        if (!isCurrentVideoSession(token)) return;
        await deleteNote(note.id, token);
        if (isCurrentVideoSession(token)) void loadNotes(filteredVideoId, token);
      });

    // Copy text button — copies just the note's text
    noteEl
      .querySelector(".note-copy-text")
      .addEventListener("click", async () => {
        const token = captureVideoSession();
        if (!isCurrentVideoSession(token)) return;
        try {
          if (!(await copyToClipboard(note.text, token))) return;
          if (!isCurrentVideoSession(token)) return;
          const btn = noteEl.querySelector(".note-copy-text");
          btn.textContent = "✓ Copied!";
          setTimeout(() => {
            if (!isCurrentVideoSession(token)) return;
            btn.textContent = "⧉ Copy text";
          }, 2000);
        } catch (err) {
          console.error("Copy failed:", err);
        }
      });

    // Copy timestamp button — copies the timestamped YouTube link
    noteEl
      .querySelector(".note-copy-link")
      .addEventListener("click", async () => {
        const token = captureVideoSession();
        if (!isCurrentVideoSession(token)) return;
        try {
          if (!(await copyToClipboard(note.timestampedUrl, token))) return;
          if (!isCurrentVideoSession(token)) return;
          const btn = noteEl.querySelector(".note-copy-link");
          btn.textContent = "✓ Copied!";
          setTimeout(() => {
            if (!isCurrentVideoSession(token)) return;
            btn.textContent = "🔗 Copy timestamp";
          }, 2000);
        } catch (err) {
          console.error("Copy failed:", err);
        }
      });

    // Play button (in this tab if it's the current video, else a new tab)
    noteEl.querySelector(".note-play").addEventListener("click", () => {
      playNote(note);
    });

    notesList.appendChild(noteEl);
  });
}

/**
 * Deletes a note by ID.
 */
async function deleteNote(noteId, token = captureVideoSession()) {
  if (!isCurrentVideoSession(token)) return;
  try {
    const result = await sendVideoSessionMessage({
      action: "deleteNote",
      noteId: noteId,
    }, token);
    if (!isCurrentSessionResponse(token, result)) return;
  } catch {
    // A stale notes action never refreshes the next video's list.
  }
}

// ============================================================
// AUTO-SCROLL — Follow video playback in transcript
// ============================================================
// While a video plays, the transcript automatically scrolls to show which
// 30-second chunk is currently being spoken. If the user manually scrolls
// (e.g., to read ahead), auto-scroll pauses and a "Follow playback" button
// appears so they can resume it. Highlight always stays active regardless.

/**
 * Starts polling the video's current time and highlighting/scrolling
 * to the matching transcript entry.
 */
function startPlaybackTracking() {
  if (!currentTranscript || !currentTranscript.length) return;

  // Don't restart if already tracking (preserves user's auto-scroll state)
  if (autoScrollInterval) return;

  autoScrollEnabled = true;
  document.getElementById("followPlaybackBtn").style.display = "none";

  // Poll video time every 500ms
  autoScrollInterval = setInterval(() => playbackTrackingTick(), 500);

  // Listen for manual scrolls on the content area
  const contentArea = document.getElementById("contentArea");
  contentArea.removeEventListener("scroll", onContentAreaScroll);
  contentArea.addEventListener("scroll", onContentAreaScroll);
}

/**
 * Stops playback tracking entirely. Called when leaving transcript tab,
 * starting a new digest, or leaving results state.
 */
function stopPlaybackTracking() {
  if (autoScrollInterval) {
    clearInterval(autoScrollInterval);
    autoScrollInterval = null;
  }
  autoScrollEnabled = true; // Reset for next time
  lastAutoScrollTime = 0;
  document.getElementById("followPlaybackBtn").style.display = "none";

  // Remove active highlights
  document
    .querySelectorAll(".transcript-entry.active-playback")
    .forEach((el) => {
      el.classList.remove("active-playback");
    });
}

/**
 * One tick of the playback tracker. Gets current video time from the
 * YouTube tab and highlights + scrolls to the matching transcript entry.
 */
async function playbackTrackingTick() {
  if (!transcriptTabIsActive()) return;
  const token = captureVideoSession();
  if (!isCurrentVideoSession(token)) return;
  if (playbackTickInFlight?.sessionId === token.sessionId) {
    return playbackTickInFlight.promise;
  }
  const request = (async () => {
    try {
      const result = await sendVideoSessionMessage({
        action: "relayToContent",
        tabId: token.tabId,
        payload: { action: "getCurrentTime" },
      }, token);

      if (
        !isCurrentSessionResponse(token, result) ||
        !transcriptTabIsActive()
      ) return;
      if (!result.success || !result.response) return;

      const currentTime = result.response.currentTime || 0;
      if (!transcriptTabIsActive()) return;
      highlightActiveEntry(currentTime);
    } catch (error) {
      // Silently ignore — YouTube tab might be closed or navigated away
    }
  })();
  playbackTickInFlight = { sessionId: token.sessionId, promise: request };
  try {
    return await request;
  } finally {
    if (playbackTickInFlight?.promise === request) {
      playbackTickInFlight = null;
    }
  }
}

function transcriptTabIsActive() {
  return Array.from(document.querySelectorAll(".tab")).some(
    (tab) =>
      tab.dataset.tab === "transcript" && tab.classList.contains("active"),
  );
}

/**
 * Scrolls the transcript to the entry currently being spoken (the one
 * carrying the active-playback highlight). Returns false if nothing is
 * highlighted yet. Stamps lastAutoScrollTime BEFORE scrolling so the scroll
 * events from our own smooth animation aren't mistaken for the user
 * scrolling away (which would re-disable auto-scroll immediately).
 */
function scrollToActiveEntry() {
  const activeEntry = document.querySelector(
    "#transcriptList .transcript-entry.active-playback",
  );
  if (!activeEntry) return false;

  lastAutoScrollTime = Date.now();
  activeEntry.scrollIntoView({ behavior: "smooth", block: "center" });
  return true;
}

/**
 * Finds the transcript entry matching the current playback time,
 * highlights it, and scrolls to it (if auto-scroll is enabled).
 *
 * @param {number} currentSeconds - Current video playback time in seconds
 */
function highlightActiveEntry(currentSeconds) {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return;

  const entries = transcriptList.querySelectorAll(".transcript-entry");
  if (entries.length === 0) return;

  // Find the entry whose time range contains the current playback time
  let activeEntry = null;
  entries.forEach((entry, index) => {
    const entrySeconds = parseInt(entry.dataset.seconds);
    const nextEntry = entries[index + 1];
    const nextSeconds = nextEntry
      ? parseInt(nextEntry.dataset.seconds)
      : Infinity;

    if (currentSeconds >= entrySeconds && currentSeconds < nextSeconds) {
      activeEntry = entry;
    }
  });

  if (!activeEntry) return;

  // Skip if this entry is already highlighted (no DOM thrashing)
  if (activeEntry.classList.contains("active-playback")) return;

  // Remove old highlight, add new one
  entries.forEach((e) => e.classList.remove("active-playback"));
  activeEntry.classList.add("active-playback");

  // Only scroll if auto-scroll is enabled
  if (autoScrollEnabled) {
    lastAutoScrollTime = Date.now();
    activeEntry.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

/**
 * Scroll event handler for the content area.
 * Detects manual scrolling and disables auto-scroll so the user
 * can read at their own pace without being yanked back.
 */
function onContentAreaScroll() {
  // Ignore scroll events within 1 second of a programmatic scroll
  // (smooth scroll animations can last longer than a simple boolean flag)
  if (Date.now() - lastAutoScrollTime < 1000) return;

  // User scrolled manually — disable auto-scroll and show the button
  if (autoScrollEnabled && autoScrollInterval) {
    autoScrollEnabled = false;
    document.getElementById("followPlaybackBtn").style.display = "block";
  }
}

// ============================================================
// TRANSCRIPT MODE UI — Original / Chinese / aligned bilingual
// ============================================================

function getOriginalTranscriptLabel() {
  const language = String(currentTranscriptLanguage || "").trim();
  return /^[A-Za-z0-9-]{1,20}$/.test(language)
    ? `Original (${language})`
    : "Original";
}

function getActiveTranscriptSegments() {
  return currentTranscriptSegments;
}

function transcriptTranslationCacheKey(
  segment,
  videoId = currentVideoId,
  transcriptFingerprint = currentTranscriptFingerprint,
) {
  const safeVideoId = typeof videoId === "string" ? videoId.trim() : "";
  const safeFingerprint =
    typeof transcriptFingerprint === "string"
      ? transcriptFingerprint.trim()
      : "";
  const segmentId = typeof segment?.id === "string" ? segment.id : "";
  if (!safeVideoId || !safeFingerprint || !segmentId) return "";
  return `${safeVideoId}:${safeFingerprint}:zh:semantic:${segmentId}`;
}

function prepareCachedParagraphTranslations({
  videoId,
  paragraphCache,
  cachedTranscriptFingerprint,
  currentTranscriptFingerprint: fingerprint,
  segments,
}) {
  const cache = paragraphCache && typeof paragraphCache === "object"
    ? paragraphCache
    : null;
  const storedFingerprint =
    typeof cachedTranscriptFingerprint === "string"
      ? cachedTranscriptFingerprint.trim()
      : "";
  const currentFingerprint =
    typeof fingerprint === "string" ? fingerprint.trim() : "";
  const canMigrateLegacy =
    Boolean(currentFingerprint) &&
    (!storedFingerprint || storedFingerprint === currentFingerprint);
  const entries = [];
  let migrated = false;

  for (const segment of Array.isArray(segments) ? segments : []) {
    if (entries.length >= PARAGRAPH_CACHE_MAX_ENTRIES) break;
    const currentKey = transcriptTranslationCacheKey(
      segment,
      videoId,
      currentFingerprint,
    );
    if (!currentKey) continue;
    const currentValue = cachedOwnData(cache, currentKey);
    if (
      currentValue.present &&
      currentValue.valid &&
      typeof currentValue.value === "string" &&
      currentValue.value.trim() &&
      currentValue.value.length <= PARAGRAPH_CACHE_MAX_VALUE_CHARS
    ) {
      entries.push([currentKey, currentValue.value]);
      continue;
    }

    if (!canMigrateLegacy) continue;
    const legacyKey = `${videoId}:zh:semantic:${segment.id}`;
    const legacyValue = cachedOwnData(cache, legacyKey);
    if (
      !legacyValue.present ||
      !legacyValue.valid ||
      typeof legacyValue.value !== "string" ||
      !legacyValue.value.trim() ||
      legacyValue.value.length > PARAGRAPH_CACHE_MAX_VALUE_CHARS
    ) continue;
    entries.push([currentKey, legacyValue.value]);
    migrated = true;
  }

  return { entries, migrated };
}

function setTranscriptModeButtons(mode) {
  document.querySelectorAll(".transcript-mode-btn").forEach((button) => {
    const active = button.dataset.transcriptMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

async function handleTranscriptModeChange(mode) {
  const token = captureVideoSession();
  if (!isCurrentVideoSession(token)) return;
  if (!["original", "zh", "bilingual"].includes(mode)) return;
  if (mode === currentTranscriptMode) return;

  currentTranscriptMode = mode;
  translationGeneration += 1;
  translationWorkCount = 0;
  transcriptExportPreparation = null;
  activeTranslationQueue?.cancel?.();
  activeTranslationQueue = null;
  setTranslatingSpinner(false);
  if (transcriptScrollObserver) transcriptScrollObserver.disconnect();
  transcriptScrollObserver = null;
  setTranscriptModeButtons(mode);
  setTranscriptExportStatus("");
  updateTranscriptExportControls(mode);

  if (mode === "original") {
    renderTranscript();
    return;
  }

  await translateTranscript(token);
}

function renderTranscriptSegmentContent(segment, mode, translated, error) {
  const original = renderVocabularyText(segment.text);
  const translationHtml = translated
    ? renderSubtitleInlineMarkup(translated)
    : error
      ? `${escapeHtml(error)}<button class="translation-retry-btn" type="button">Retry</button>`
      : "Waiting for translation…";

  if (mode === "bilingual") {
    return `<span class="transcript-copy"><span class="transcript-original">${original}</span><span class="transcript-translation ${translated ? "" : error ? "translation-error" : "translation-pending"}">${translationHtml}</span></span>`;
  }

  return `<span class="transcript-copy"><span class="transcript-translation ${translated ? "" : error ? "translation-error" : "translation-pending"}">${translationHtml}</span></span>`;
}

function renderTranscriptModeRows(segments, mode, token = captureVideoSession()) {
  if (!isCurrentVideoSession(token)) return [];
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return [];
  transcriptList.innerHTML = "";

  const existingBadge = document.getElementById("transcriptSourceBadge");
  if (existingBadge) existingBadge.remove();
  const badge = document.createElement("div");
  badge.id = "transcriptSourceBadge";
  badge.className = "transcript-source-badge";
  const originalLabel = getOriginalTranscriptLabel();
  const modeLabel =
    mode === "bilingual"
      ? `${originalLabel} + 简体中文`
      : `简体中文 · translated from ${originalLabel}`;
  badge.innerHTML = `<span class="source-dot source-dot--subs"></span> From video subtitles · ${modeLabel}`;
  transcriptList.parentElement.insertBefore(badge, transcriptList);

  const rows = [];
  segments.forEach((segment, index) => {
    const div = document.createElement("div");
    const cached = transcriptParagraphCache.get(
      transcriptTranslationCacheKey(segment, token.videoId),
    );
    div.className = `transcript-entry ${cached ? "translated" : "translating"}`;
    div.dataset.seconds = segment.start;
    div.dataset.segmentId = segment.id;
    div.dataset.segmentIndex = index;
    div.dataset.sourceText = segment.text;

    const minutes = Math.floor(segment.start / 60);
    const seconds = Math.floor(segment.start % 60);
    const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;
    div.innerHTML = `
      <span class="transcript-time">${timestamp}</span>
      ${renderTranscriptSegmentContent(segment, mode, cached, "")}
    `;
    div.addEventListener("click", (event) =>
      seekFromTranscriptEntryClick(event, segment.start),
    );
    transcriptList.appendChild(div);
    rows.push(div);
  });

  return rows;
}

/**
 * Rebuilds a provider response in source order. Unknown IDs are ignored and
 * missing IDs remain explicit errors, never positional guesses.
 */
function alignTranslatedSegmentBatch(sourceSegments, responseSegments) {
  const translatedById = new Map();
  if (Array.isArray(responseSegments)) {
    responseSegments.forEach((item) => {
      if (!item || typeof item.id !== "string" || typeof item.text !== "string")
        return;
      const text = item.text.trim();
      if (text && !translatedById.has(item.id)) {
        translatedById.set(item.id, text);
      }
    });
  }

  return sourceSegments.map((segment) => ({
    id: segment.id,
    text: translatedById.get(segment.id) || "",
    error: translatedById.has(segment.id) ? "" : "Translation unavailable.",
  }));
}

function updateTranslatedRow(segment, index, alignedItem, generation, token) {
  if (!isCurrentVideoSession(token) || generation !== translationGeneration) {
    return;
  }
  const row = document.querySelector(
    `.transcript-entry[data-segment-id="${CSS.escape(segment.id)}"]`,
  );
  if (!row) return;

  if (alignedItem.text) {
    const cacheKey = transcriptTranslationCacheKey(segment, token.videoId);
    if (cacheKey) transcriptParagraphCache.set(cacheKey, alignedItem.text);
  }

  const copy = row.querySelector(".transcript-copy");
  if (copy) {
    copy.outerHTML = renderTranscriptSegmentContent(
      segment,
      currentTranscriptMode,
      alignedItem.text,
      alignedItem.error,
    );
  }
  row.classList.toggle("translated", !!alignedItem.text);
  row.classList.toggle("translating", false);
  row.classList.toggle("translation-failed", !alignedItem.text);

  const retry = row.querySelector(".translation-retry-btn");
  if (retry) {
    ["mousedown", "mouseup"].forEach((eventName) => {
      retry.addEventListener(eventName, (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    });
    retry.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      retryTranslationSegment(index, generation, token);
    });
  }
}

let activeTranslationQueue = null;

async function requestTranscriptTranslationBatch(
  indices,
  segments,
  generation,
  videoId,
  mode,
  token,
) {
  if (!isCurrentVideoSession(token)) return;
  const sourceBatch = indices.map((index) => segments[index]);
  setTranslatingSpinner(true);
  const videoTitle = currentVideoTitle;
  try {
    const digestBaseReady = await ensureDigestBaseReady(token);
    if (
      !isCurrentVideoSession(token) ||
      generation !== translationGeneration ||
      videoId !== currentVideoId ||
      mode !== currentTranscriptMode
    ) return;
    if (!digestBaseReady) {
      sourceBatch.forEach((segment, batchIndex) => {
        updateTranslatedRow(
          segment,
          indices[batchIndex],
          {
            id: segment.id,
            text: "",
            error: "Local cache unavailable. Retry after storage recovers.",
          },
          generation,
          token,
        );
      });
      return;
    }
    const result = await sendTranslationMessage({
      action: "translateContent",
      content: {
        segments: sourceBatch.map(({ id, text }) => ({ id, text })),
      },
      contentType: "transcriptBatch",
      targetLanguage: "zh",
      videoTitle,
    }, token);

    const isStale =
      !isCurrentSessionResponse(token, result) ||
      generation !== translationGeneration ||
      videoId !== currentVideoId ||
      mode !== currentTranscriptMode;
    if (isStale) return;

    const responseSegments = result?.success
      ? result.translatedContent?.segments
      : [];
    const aligned = alignTranslatedSegmentBatch(sourceBatch, responseSegments);
    const paragraphDelta = {};
    aligned.forEach((item, batchIndex) => {
      if (!result?.success) {
        item.error = result?.error || "Translation failed.";
      }
      updateTranslatedRow(
        sourceBatch[batchIndex],
        indices[batchIndex],
        item,
        generation,
        token,
      );
      if (item.text) {
        const key = transcriptTranslationCacheKey(
          sourceBatch[batchIndex],
          token.videoId,
        );
        if (key) {
          Object.defineProperty(paragraphDelta, key, {
            value: item.text,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
      }
    });
    if (Object.keys(paragraphDelta).length) {
      await patchDigestCache({ paragraphCache: paragraphDelta }, token);
    }
    if (!isCurrentVideoSession(token)) return;
    if (mode === currentTranscriptMode) updateTranscriptExportControls(mode);
  } catch (error) {
    if (!isCurrentVideoSession(token) || generation !== translationGeneration) {
      return;
    }
    sourceBatch.forEach((segment, batchIndex) => {
      updateTranslatedRow(
        segment,
        indices[batchIndex],
        {
          id: segment.id,
          text: "",
          error: error.message || "Translation failed.",
        },
        generation,
        token,
      );
    });
  } finally {
    if (isCurrentVideoSession(token) && generation === translationGeneration) {
      setTranslatingSpinner(false);
    }
  }
}

function retryTranslationSegment(index, generation, token) {
  if (
    !isCurrentVideoSession(token) ||
    generation !== translationGeneration ||
    !activeTranslationQueue ||
    activeTranslationQueue.token !== token
  ) return;
  const row = document.querySelector(
    `.transcript-entry[data-segment-index="${index}"]`,
  );
  if (row) {
    row.classList.add("translating");
    row.classList.remove("translation-failed");
    const translation = row.querySelector(".transcript-translation");
    if (translation) {
      translation.className = "transcript-translation translation-pending";
      translation.textContent = "Retrying…";
    }
  }
  activeTranslationQueue.enqueue(index, true);
}

/**
 * Renders immediately, translates the first small batch, then observes the
 * remaining rows. Batches are sequential so the provider is never flooded.
 */
async function translateTranscript(token = captureVideoSession()) {
  if (!isCurrentVideoSession(token)) return;
  if (!currentTranscriptFingerprint) {
    showFingerprintUnavailableCacheLimits();
    return;
  }
  const digestBaseReady = await ensureDigestBaseReady(token);
  if (!isCurrentVideoSession(token)) return;
  if (!digestBaseReady) {
    setTranscriptExportStatus(
      "本地缓存暂时无法安全写入。请重试翻译；恢复缓存前不会发送翻译请求。",
    );
    return;
  }
  const segments = getActiveTranscriptSegments();
  if (!segments.length || currentTranscriptMode === "original") return;

  translationGeneration += 1;
  const generation = translationGeneration;
  const videoId = token.videoId;
  const mode = currentTranscriptMode;
  if (transcriptScrollObserver) transcriptScrollObserver.disconnect();

  const rows = renderTranscriptModeRows(segments, mode, token);
  const queue = [];
  const queued = new Set();
  const inFlight = new Set();
  const idleWaiters = new Set();
  let processing = false;

  const notifyIdle = () => {
    if (processing || queue.length) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };

  const processNext = async () => {
    if (
      processing ||
      queue.length === 0 ||
      generation !== translationGeneration ||
      !isCurrentVideoSession(token)
    )
      return;
    processing = true;
    const indices = queue.splice(0, 3);
    indices.forEach((index) => {
      queued.delete(index);
      inFlight.add(index);
    });
    try {
      await requestTranscriptTranslationBatch(
        indices,
        segments,
        generation,
        videoId,
        mode,
        token,
      );
    } finally {
      indices.forEach((index) => inFlight.delete(index));
      processing = false;
      if (
        queue.length &&
        generation === translationGeneration &&
        isCurrentVideoSession(token)
      ) void processNext();
      else {
        if (
          generation !== translationGeneration ||
          !isCurrentVideoSession(token)
        ) {
          queue.splice(0, queue.length);
          queued.clear();
        }
        notifyIdle();
      }
    }
  };

  const enqueue = (index, force = false) => {
    if (!Number.isInteger(index) || !segments[index]) return;
    const cached = transcriptParagraphCache.has(
      transcriptTranslationCacheKey(segments[index], token.videoId),
    );
    if ((!force && cached) || queued.has(index) || inFlight.has(index)) return;
    queue.push(index);
    queued.add(index);
    // Let all entries reported in the same viewport turn collect before the
    // worker starts, producing one small contextual multi-segment request.
    Promise.resolve().then(processNext);
  };
  const whenIdle = () =>
    !processing && queue.length === 0
      ? Promise.resolve()
      : new Promise((resolve) => idleWaiters.add(resolve));
  const ensureAll = (indices) => {
    for (const index of Array.isArray(indices) ? indices : []) {
      enqueue(index, true);
    }
  };
  const cancel = () => {
    queue.splice(0, queue.length);
    queued.clear();
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };
  activeTranslationQueue?.cancel?.();
  activeTranslationQueue = {
    enqueue,
    ensureAll,
    whenIdle,
    token,
    sessionId: token.sessionId,
    generation,
    mode,
    cancel,
  };

  transcriptScrollObserver = new IntersectionObserver(
    (observerEntries) => {
      if (!isCurrentVideoSession(token) || generation !== translationGeneration) {
        return;
      }
      observerEntries
        .filter((entry) => entry.isIntersecting)
        .sort(
          (a, b) =>
            Number(a.target.dataset.segmentIndex) -
            Number(b.target.dataset.segmentIndex),
        )
        .forEach((entry) => enqueue(Number(entry.target.dataset.segmentIndex)));
    },
    {
      root: document.getElementById("contentArea"),
      rootMargin: "320px 0px",
      threshold: 0,
    },
  );

  rows.forEach((row, index) => {
    if (!row.classList.contains("translated")) {
      transcriptScrollObserver.observe(row);
    }
    if (index < 3) enqueue(index);
  });
  updateTranscriptExportControls(mode);
}

function setTranslatingSpinner(show, reset = false) {
  if (reset) translationWorkCount = 0;
  else if (show) translationWorkCount += 1;
  else translationWorkCount = Math.max(0, translationWorkCount - 1);
  const isTranslating = translationWorkCount > 0;
  const spinner = document.getElementById("langSpinner");
  if (spinner) spinner.classList.toggle("visible", isTranslating);
}

// Pure helpers are exposed for the repository's Node tests. The extension does
// not read this object at runtime.
globalThis.__YTD_TRANSCRIPT_TESTING__ = {
  createVideoSessionManager,
  resolvePanelTab,
  resetVideoBoundUi,
  checkCurrentTab,
  setupEventListeners,
  triggerAnalysis,
  switchTab,
  setupExplainFeature,
  showExplanation,
  captureVideoSnapshot,
  openEvidenceDialog,
  closeEvidenceDialog,
  copyActiveEvidenceText,
  seekActiveEvidenceSource,
  requestBasicOverview,
  runBasicOverviewRequest,
  retryBasicOverviewCacheWrite,
  getBasicOverviewState: () => ({
    overview: currentBasicOverview,
    failure: currentBasicOverviewFailure,
    config: currentConfigStatus,
    inFlightCount: basicOverviewRequestSession.inFlightByFingerprint.size,
    automaticRequestedCount:
      basicOverviewRequestSession.automaticRequestedFingerprints.size,
    presentation: basicOverviewPresentation,
  }),
  copyTranscript,
  captureTranscriptModeSnapshot,
  prepareTranscriptModeExport,
  updateTranscriptExportControls,
  playbackTrackingTick,
  sendVideoSessionMessage,
  handleTranscriptModeChange,
  sendTranslationMessage,
  groupTranscriptEntries,
  splitOversizedThought,
  getActiveTranscriptSegments,
  getTranscriptParagraphCacheEntries: () => [
    ...transcriptParagraphCache.entries(),
  ],
  transcriptTranslationCacheKey,
  prepareCachedParagraphTranslations,
  normalizeCachedDigestView,
  alignTranslatedSegmentBatch,
  renderSubtitleInlineMarkup,
  renderTranscriptSegmentContent,
  tokenizeVocabularyText,
  renderVocabularyText,
  filterVocabularyEntries,
  generateVocabularyDraft,
  buildVocabularyReviewPlan,
  buildVocabularyCsv,
  buildVocabularyMarkdown,
  buildVocabularyAnkiTsv,
  formatVocabularyDisplayTimestamp,
  renderHighlightedVocabularySentence,
  buildCleanTranscriptMarkdown,
  providerFailurePresentation,
  runProviderRecovery,
  hasDeepAnalysis,
  buildDeepAnalysisMarkdown,
  buildStudyPackMarkdown,
};
