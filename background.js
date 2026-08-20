/**
 * BACKGROUND SERVICE WORKER
 *
 * This is the "brain" of the extension. It runs in the background and handles:
 * 1. Opening the side panel when the user clicks the extension icon
 * 2. Fetching YouTube transcripts via Supadata API
 * 3. Calling DeepSeek to analyze the transcript
 * 4. Sending results back to the side panel
 *
 * Think of it like a backend server — it does the heavy lifting
 * so the UI (side panel) can stay fast and responsive.
 */

// Import safe defaults and validation helpers. Secret keys live in
// chrome.storage.local and are never part of the extension source.
importScripts(
  "settings.js",
  "providers.js",
  "persistence.js",
  "transcript-core.js",
  "overview-core.js",
);

const storageMutations = YTD_PERSISTENCE.createMutationCoordinator(
  chrome.storage.local,
);
void storageMutations.pruneExpiredOverviewAttempts().catch(() => {});

const DEBUG = false;
const AI_PROVIDER_IDLE_TIMEOUT_MS = 50_000;
const AI_PROVIDER_HARD_TIMEOUT_MS = 120_000;
const AI_PROVIDER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const SUPADATA_INITIAL_TIMEOUT_MS = 30_000;
const SUPADATA_POLL_TIMEOUT_MS = 15_000;
const SUPADATA_JOB_DEADLINE_MS = 90_000;
const SUPADATA_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const SUPADATA_POLL_INTERVAL_MS = 1_000;
const DIGEST_CACHE_SCHEMA_VERSION = 2;
const DIGEST_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DIGEST_CACHE_MAX_INPUT_BYTES = 2 * 1024 * 1024;
const DIGEST_CACHE_MAX_TRANSCRIPT_ENTRIES = 100_000;
const OVERVIEW_CACHE_RECOVERY_MAX_ENTRIES = 32;
const OVERVIEW_CACHE_RECOVERY_TTL_MS = 5 * 60 * 1000;
const STORAGE_KEYS = YTD_PERSISTENCE.STORAGE_KEYS;
const VOCABULARY_STORAGE_KEY = STORAGE_KEYS.vocabulary;
const VOCABULARY_SCHEMA_VERSION = 2;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

function mutationFailure(code) {
  return { success: false, code };
}

function legacyMutationFailure(code) {
  return { success: false, code, error: code };
}

function legacyCompatibleMutationResult(result) {
  if (result?.success === true) return result;
  const code = typeof result?.code === "string"
    ? result.code.slice(0, 64)
    : "STORAGE_WRITE_FAILED";
  return { ...result, success: false, code, error: code };
}

function unwrapCoordinatorResult(result) {
  if (!result || result.success !== true) return result;
  return result.value && typeof result.value === "object"
    ? result.value
    : { success: true };
}

async function commitCurrentMutation(operation, fallbackCode) {
  let operationStarted = false;
  try {
    const result = await storageMutations.commitCurrent((storage) => {
      operationStarted = true;
      return operation(storage);
    });
    return unwrapCoordinatorResult(result);
  } catch {
    return mutationFailure(
      operationStarted ? fallbackCode : "STORAGE_READ_FAILED",
    );
  }
}

function broadcastWithoutBlocking(message) {
  try {
    void Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => {});
  } catch {
    // Broadcast listeners are advisory and never gate committed mutations.
  }
}

function ownValue(value, key) {
  if (!value || typeof value !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value")
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeProviderStatuses(value, settings) {
  return {
    supadata: YTD_PROVIDERS.normalizeStatusRecord(
      ownValue(value, "supadata"),
      Boolean(settings.supadataApiKey),
    ),
    deepseek: YTD_PROVIDERS.normalizeStatusRecord(
      ownValue(value, "deepseek"),
      Boolean(settings.aiApiKey),
    ),
  };
}

function validProvider(provider) {
  return provider === "supadata" || provider === "deepseek";
}

function validExpectedEpoch(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validTabId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validVideoId(videoId) {
  try {
    YTD_SETTINGS.canonicalYouTubeUrl(videoId);
    return true;
  } catch {
    return false;
  }
}

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

function videoIdFromYouTubeTabUrl(url) {
  if (!isAllowedYouTubeTabUrl(url)) return "";
  try {
    return new URL(url).searchParams.get("v") || "";
  } catch {
    return "";
  }
}

function normalizedSessionToken(value) {
  const sessionId = ownValue(value, "sessionId");
  const generation = ownValue(value, "generation");
  const videoId = ownValue(value, "videoId");
  const tabId = ownValue(value, "tabId");
  const windowId = ownValue(value, "windowId");
  const resetEpoch = ownValue(value, "resetEpoch");
  if (
    typeof sessionId !== "string" ||
    !sessionId.trim() ||
    sessionId.length > 160 ||
    !Number.isSafeInteger(generation) ||
    generation <= 0 ||
    !validVideoId(videoId) ||
    !validTabId(tabId) ||
    !Number.isSafeInteger(windowId) ||
    windowId < 0 ||
    !validExpectedEpoch(resetEpoch)
  ) return null;
  return Object.freeze({
    sessionId: sessionId.trim(),
    generation,
    videoId,
    tabId,
    windowId,
    resetEpoch,
  });
}

function withSessionToken(response, value) {
  const token = normalizedSessionToken(value);
  if (!token || !response || typeof response !== "object") return response;
  return { ...response, sessionToken: token };
}

function relayFailure(code, sessionToken) {
  return withSessionToken({ success: false, code }, sessionToken);
}

function tabMatchesSession(tab, tabId, token) {
  if (
    !tab ||
    tab.id !== tabId ||
    tab.active === false ||
    !isAllowedYouTubeTabUrl(effectiveTabUrl(tab))
  ) {
    return false;
  }
  if (!token) return true;
  return Boolean(
    tab.id === token.tabId &&
      tab.windowId === token.windowId &&
      videoIdFromYouTubeTabUrl(effectiveTabUrl(tab)) ===
        token.videoId,
  );
}

function relayTabFailureCode(tab, tabId, token) {
  if (!tab || tab.id !== tabId) return "TAB_NOT_FOUND";
  if (tab.active === false) return "TAB_NOT_ACTIVE";
  if (!isAllowedYouTubeTabUrl(effectiveTabUrl(tab))) return "TAB_NOT_YOUTUBE";
  if (token && tab.windowId !== token.windowId) return "TAB_WINDOW_MISMATCH";
  if (
    token &&
    videoIdFromYouTubeTabUrl(effectiveTabUrl(tab)) !== token.videoId
  ) {
    return "TAB_VIDEO_MISMATCH";
  }
  return "";
}

const latestPanelSessionByWindow = new Map();
const panelSessionRevisionByWindow = new Map();
const panelBindCommitRevisionByWindow = new Map();
const panelDocumentsByWindow = new Map();
const MAX_PANEL_DOCUMENT_RECORDS_PER_TAB = 32;
let resetValidationRevision = 0;
let activeResetCount = 0;
const overviewCacheRecoveryByToken = new Map();
const overviewCacheRecoveryRequestByKey = new Map();
let overviewCacheRecoveryLastObservedAt = 0;

function bumpResetValidationRevision() {
  resetValidationRevision = resetValidationRevision >= Number.MAX_SAFE_INTEGER
    ? 1
    : resetValidationRevision + 1;
}

function sameSessionIdentity(left, right) {
  return Boolean(
    left &&
      right &&
      left.sessionId === right.sessionId &&
      left.generation === right.generation &&
      left.videoId === right.videoId &&
      left.tabId === right.tabId &&
      left.windowId === right.windowId &&
      left.resetEpoch === right.resetEpoch,
  );
}

function panelResetFailure(expectedRevision = resetValidationRevision) {
  if (activeResetCount > 0) return "RESET_DURING_REQUEST";
  return expectedRevision === resetValidationRevision ? "" : "SESSION_STALE";
}

function currentPanelSessionFailure(token) {
  const resetFailure = panelResetFailure();
  if (resetFailure) return resetFailure;
  const latestEntry = latestPanelSessionByWindow.get(token.windowId);
  const latest = latestEntry?.token;
  if (!latest) return "SESSION_UNKNOWN";
  if (!sameSessionIdentity(latest, token)) return "SESSION_STALE";
  const state = panelDocumentState(token.windowId, token.tabId);
  if (
    state?.pending &&
    (state.pending.documentId !== latestEntry.documentId ||
      !sameSessionIdentity(state.pending.token, latest))
  ) {
    return "SESSION_STALE";
  }
  return "";
}

function bumpPanelSessionRevision(windowId) {
  const revision = (panelSessionRevisionByWindow.get(windowId) || 0) + 1;
  panelSessionRevisionByWindow.set(windowId, revision);
  return revision;
}

function invalidatePanelSession(windowId) {
  if (!Number.isSafeInteger(windowId) || windowId < 0) return;
  latestPanelSessionByWindow.delete(windowId);
  bumpPanelSessionRevision(windowId);
}

function invalidateAllPanelSessions() {
  const windowIds = new Set([
    ...latestPanelSessionByWindow.keys(),
    ...panelSessionRevisionByWindow.keys(),
    ...panelBindCommitRevisionByWindow.keys(),
    ...panelDocumentsByWindow.keys(),
  ]);
  windowIds.forEach(invalidatePanelSession);
}

function forgetPanelWindow(windowId) {
  invalidatePanelSession(windowId);
  panelDocumentsByWindow.delete(windowId);
  panelSessionRevisionByWindow.delete(windowId);
  panelBindCommitRevisionByWindow.delete(windowId);
}

function panelTabsForWindow(windowId, create = false) {
  let tabs = panelDocumentsByWindow.get(windowId);
  if (!tabs && create) {
    tabs = new Map();
    panelDocumentsByWindow.set(windowId, tabs);
  }
  return tabs;
}

function panelDocumentState(windowId, tabId, create = false) {
  const tabs = panelTabsForWindow(windowId, create);
  if (!tabs) return null;
  let state = tabs.get(tabId);
  if (!state && create) {
    state = {
      bindRevision: 0,
      currentDocumentId: "",
      pending: null,
      records: new Map(),
    };
    tabs.set(tabId, state);
  }
  return state;
}

function forgetPanelTab(windowId, tabId) {
  const tabs = panelTabsForWindow(windowId);
  if (!tabs) return;
  tabs.delete(tabId);
  if (!tabs.size) panelDocumentsByWindow.delete(windowId);
}

function documentTabInWindow(windowId, documentId) {
  const tabs = panelTabsForWindow(windowId);
  if (!tabs) return null;
  for (const [tabId, state] of tabs) {
    if (
      state.currentDocumentId === documentId ||
      state.pending?.documentId === documentId ||
      state.records.has(documentId)
    ) {
      return tabId;
    }
  }
  return null;
}

function rememberPanelDocument(state, documentId, record) {
  state.records.delete(documentId);
  state.records.set(documentId, record);
}

async function readStoredResetEpoch() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.resetEpoch);
  return YTD_PERSISTENCE.normalizeEpoch(
    ownValue(stored, STORAGE_KEYS.resetEpoch),
  );
}

async function validatePanelSessionContext(
  token,
  {
    checkEpoch = true,
    resetRevision = resetValidationRevision,
  } = {},
) {
  let resetFailure = panelResetFailure(resetRevision);
  if (resetFailure) return { success: false, code: resetFailure };
  let code = currentPanelSessionFailure(token);
  if (code) return { success: false, code };
  if (checkEpoch) {
    let epoch;
    try {
      epoch = await readStoredResetEpoch();
    } catch {
      return { success: false, code: "STORAGE_READ_FAILED" };
    }
    resetFailure = panelResetFailure(resetRevision);
    if (resetFailure) return { success: false, code: resetFailure };
    code = currentPanelSessionFailure(token);
    if (code) return { success: false, code };
    if (epoch !== token.resetEpoch) {
      return { success: false, code: "SESSION_STALE" };
    }
  }
  let tab;
  try {
    tab = await chrome.tabs.get(token.tabId);
  } catch {
    return { success: false, code: "TAB_NOT_FOUND" };
  }
  resetFailure = panelResetFailure(resetRevision);
  if (resetFailure) return { success: false, code: resetFailure };
  code = currentPanelSessionFailure(token);
  if (code) return { success: false, code };
  const tabCode = relayTabFailureCode(tab, token.tabId, token);
  if (tabCode) return { success: false, code: tabCode };
  return { success: true, tab };
}

function normalizedPanelDocumentId(sender) {
  const documentId = sender?.documentId;
  if (
    typeof documentId !== "string" ||
    !documentId.trim() ||
    documentId.length > 256
  ) return "";
  let actualUrl;
  let sidepanelUrl;
  try {
    actualUrl = new URL(sender?.url || "");
    sidepanelUrl = new URL(chrome.runtime.getURL("sidepanel.html"));
  } catch {
    return "";
  }
  if (
    actualUrl.protocol !== sidepanelUrl.protocol ||
    actualUrl.host !== sidepanelUrl.host ||
    actualUrl.pathname !== sidepanelUrl.pathname
  ) return "";
  return documentId.trim();
}

function handleBindVideoSession(sessionTokenValue, sender) {
  const token = normalizedSessionToken(sessionTokenValue);
  if (!token) {
    return Promise.resolve(mutationFailure("INVALID_SESSION_TOKEN"));
  }
  const bindFailure = (code) =>
    withSessionToken(mutationFailure(code), token);
  const documentId = normalizedPanelDocumentId(sender);
  if (!documentId) {
    return Promise.resolve(bindFailure("INVALID_PANEL_DOCUMENT"));
  }
  const resetRevision = resetValidationRevision;
  const resetFailure = panelResetFailure(resetRevision);
  if (resetFailure) return Promise.resolve(bindFailure(resetFailure));

  const documentTab = documentTabInWindow(token.windowId, documentId);
  if (documentTab !== null && documentTab !== token.tabId) {
    return Promise.resolve(bindFailure("SESSION_STALE"));
  }
  const state = panelDocumentState(token.windowId, token.tabId, true);
  const watermark = state.records.get(documentId);
  const currentWatermark = state.records.get(state.currentDocumentId);
  if (
    state.currentDocumentId &&
    state.currentDocumentId !== documentId &&
    sameSessionIdentity(currentWatermark?.token, token)
  ) {
    return Promise.resolve(bindFailure("SESSION_STALE"));
  }
  if (!watermark && state.records.size >= MAX_PANEL_DOCUMENT_RECORDS_PER_TAB) {
    return Promise.resolve(bindFailure("SESSION_STALE"));
  }
  if (watermark?.retired) {
    return Promise.resolve(bindFailure("SESSION_STALE"));
  }
  if (watermark) {
    if (token.generation < watermark.generation) {
      return Promise.resolve(bindFailure("SESSION_STALE"));
    }
    if (
      token.generation === watermark.generation &&
      !sameSessionIdentity(watermark.token, token)
    ) {
      return Promise.resolve(bindFailure("SESSION_STALE"));
    }
  }
  if (
    state.pending &&
    state.pending.documentId !== documentId &&
    state.currentDocumentId === documentId
  ) {
    return Promise.resolve(bindFailure("SESSION_STALE"));
  }

  rememberPanelDocument(state, documentId, {
    generation: token.generation,
    token,
    retired: false,
  });
  state.bindRevision += 1;
  const bindRevision = state.bindRevision;
  const lifecycleRevision = panelSessionRevisionByWindow.get(token.windowId) || 0;
  const commitRevision =
    panelBindCommitRevisionByWindow.get(token.windowId) || 0;
  const pending = { documentId, revision: bindRevision, token };
  state.pending = pending;
  const rejectCandidate = (code) => {
    if (state.pending === pending) state.pending = null;
    return bindFailure(code);
  };
  const operation = async () => {
    let code = panelResetFailure(resetRevision);
    if (code) return rejectCandidate(code);
    let epoch;
    try {
      epoch = await readStoredResetEpoch();
    } catch {
      return rejectCandidate("STORAGE_READ_FAILED");
    }
    code = panelResetFailure(resetRevision);
    if (code) return rejectCandidate(code);
    if (
      (panelSessionRevisionByWindow.get(token.windowId) || 0) !==
        lifecycleRevision ||
      state.bindRevision !== bindRevision ||
      panelDocumentState(token.windowId, token.tabId) !== state ||
      state.pending !== pending
    ) {
      return rejectCandidate("SESSION_STALE");
    }
    if (epoch !== token.resetEpoch) return rejectCandidate("SESSION_STALE");
    let tab;
    try {
      tab = await chrome.tabs.get(token.tabId);
    } catch {
      return rejectCandidate("TAB_NOT_FOUND");
    }
    code = panelResetFailure(resetRevision);
    if (code) return rejectCandidate(code);
    if (
      (panelSessionRevisionByWindow.get(token.windowId) || 0) !==
        lifecycleRevision ||
      (panelBindCommitRevisionByWindow.get(token.windowId) || 0) !==
        commitRevision ||
      state.bindRevision !== bindRevision ||
      panelDocumentState(token.windowId, token.tabId) !== state ||
      state.pending !== pending
    ) {
      return rejectCandidate("SESSION_STALE");
    }
    const tabCode = relayTabFailureCode(tab, token.tabId, token);
    if (tabCode) return rejectCandidate(tabCode);
    for (const [knownDocumentId, knownRecord] of state.records) {
      if (knownDocumentId === documentId) continue;
      state.records.set(knownDocumentId, {
        ...knownRecord,
        retired: true,
      });
    }
    state.currentDocumentId = documentId;
    state.pending = null;
    rememberPanelDocument(state, documentId, {
      generation: token.generation,
      token,
      retired: false,
    });
    panelBindCommitRevisionByWindow.set(token.windowId, commitRevision + 1);
    latestPanelSessionByWindow.set(token.windowId, { token, documentId });
    return withSessionToken({ success: true }, token);
  };
  return operation();
}

async function runPanelVideoRequest(
  sessionTokenValue,
  operation,
  expectedVideoId,
) {
  const authority = await createPanelVideoRequestAuthority(
    sessionTokenValue,
    expectedVideoId,
  );
  if (!authority.success) return authority;
  const beforeDispatch = async () => {
    const latest = await authority.validateMutation();
    return latest;
  };
  return operation(beforeDispatch, authority.token, authority);
}

async function createPanelVideoRequestAuthority(
  sessionTokenValue,
  expectedVideoId,
) {
  const resetRevision = resetValidationRevision;
  const resetFailure = panelResetFailure(resetRevision);
  if (resetFailure) return mutationFailure(resetFailure);
  if (sessionTokenValue === undefined || sessionTokenValue === null) {
    return mutationFailure("INVALID_SESSION_TOKEN");
  }
  const token = normalizedSessionToken(sessionTokenValue);
  if (!token) return mutationFailure("INVALID_SESSION_TOKEN");
  if (expectedVideoId !== undefined && token.videoId !== expectedVideoId) {
    return mutationFailure("SESSION_BINDING_MISMATCH");
  }
  const validation = await validatePanelSessionContext(token, {
    resetRevision,
  });
  if (!validation.success) return mutationFailure(validation.code);
  const preDispatchFailure = currentPanelSessionFailure(token);
  if (preDispatchFailure) return mutationFailure(preDispatchFailure);
  const validateMutation = async () => {
    const latest = await validatePanelSessionContext(token, {
      resetRevision,
    });
    return latest.success ? true : latest.code;
  };
  const validateDispatchNow = () => {
    const resetFailureNow = panelResetFailure(resetRevision);
    if (resetFailureNow) return resetFailureNow;
    return currentPanelSessionFailure(token) || true;
  };
  return Object.freeze({
    success: true,
    token,
    resetRevision,
    validateMutation,
    validateDispatchNow,
  });
}

async function assertProviderDispatchAllowed(beforeDispatch) {
  if (!beforeDispatch) return;
  const result = await beforeDispatch();
  if (result === true) return;
  const error = new Error("Video session is no longer current.");
  error.code = typeof result === "string" ? result : "SESSION_STALE";
  throw error;
}

function providerMessageFailure(provider, stage, error) {
  return {
    success: false,
    ...YTD_PROVIDERS.mapThrownFailure({
      provider,
      stage,
      error,
      dispatched: true,
    }),
  };
}

function respondBounded(promise, sendResponse, fallbackCode) {
  Promise.resolve(promise).then(
    (response) => sendResponse(response),
    () => sendResponse(mutationFailure(fallbackCode)),
  );
  return true;
}

// Prevent the YouTube content script from reading API keys or cached data.
// Side panel, options, and service-worker contexts remain trusted.
chrome.storage.local
  .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch((error) =>
    console.warn("[YouTube Digest Vocabulary] Could not restrict storage access:", error),
  );

async function getSettings(storage = chrome.storage.local) {
  const stored = await storage.get(YTD_SETTINGS.STORAGE_KEY);
  return YTD_SETTINGS.normalize(stored[YTD_SETTINGS.STORAGE_KEY]);
}

const promptFileCache = new Map();

async function loadPromptSection(fileName, heading, variables = {}) {
  let markdown = promptFileCache.get(fileName);
  if (!markdown) {
    const response = await fetch(chrome.runtime.getURL(`prompts/${fileName}`));
    if (!response.ok) {
      throw new Error(`Could not load prompt file: ${fileName}`);
    }
    markdown = await response.text();
    promptFileCache.set(fileName, markdown);
  }

  const marker = `## ${heading}`;
  const markerIndex = markdown.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }
  const sectionStart = markerIndex + marker.length;
  const nextSection = markdown.indexOf("\n## ", sectionStart);
  const section = markdown.slice(
    sectionStart,
    nextSection === -1 ? markdown.length : nextSection,
  );
  const fenceMatch = section.match(/```(?:[A-Za-z0-9_-]+)?\n([\s\S]*?)\n```/);
  if (!fenceMatch) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }

  const replacements = new Map(
    Object.entries(variables).map(([key, value]) => [
      key,
      String(value ?? ""),
    ]),
  );
  return fenceMatch[1].replace(
    /\{([A-Za-z][A-Za-z0-9_]*)\}/g,
    (placeholder, key) =>
      replacements.has(key) ? replacements.get(key) : placeholder,
  );
}

function prepareAiCompletion({
  settings,
  messages,
  maxTokens,
  temperature,
  responseFormat,
}) {
  if (!settings.aiApiKey) {
    const error = new Error(
      "DeepSeek API key not configured. Open YouTube Digest Vocabulary Settings.",
    );
    error.code = "NO_AI_KEY";
    throw error;
  }
  const body = {
    model: settings.aiModel,
    max_tokens: maxTokens,
    messages,
  };
  if (typeof temperature === "number") body.temperature = temperature;
  if (responseFormat) {
    body.response_format = responseFormat;
  }
  // Product features need bounded, predictable latency rather than reasoning traces.
  body.thinking = { type: "disabled" };
  return Object.freeze({
    body: JSON.stringify(body),
    settings,
    url: YTD_SETTINGS.chatCompletionsUrl(),
  });
}

async function dispatchPreparedAiCompletion(prepared, { onDispatch } = {}) {
  if (!prepared || typeof prepared !== "object") {
    throw new TypeError("Prepared AI completion is required.");
  }

  const controller = new AbortController();
  let timeoutKind = "";
  let idleTimeoutId;
  let hardTimeoutId;
  const abortForTimeout = (kind) => {
    if (controller.signal.aborted) return;
    timeoutKind = kind;
    controller.abort();
  };
  const resetIdleTimeout = () => {
    clearTimeout(idleTimeoutId);
    idleTimeoutId = setTimeout(
      () => abortForTimeout("idle"),
      AI_PROVIDER_IDLE_TIMEOUT_MS,
    );
  };

  hardTimeoutId = setTimeout(
    () => abortForTimeout("hard"),
    AI_PROVIDER_HARD_TIMEOUT_MS,
  );
  resetIdleTimeout();
  try {
    onDispatch?.();
    const response = await fetch(
      prepared.url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${prepared.settings.aiApiKey}`,
        },
        body: prepared.body,
        signal: controller.signal,
      },
    );
    // Receiving headers proves DeepSeek is still making progress. DeepSeek
    // may then send blank-line body chunks while a non-streaming request queues.
    resetIdleTimeout();

    let data;
    try {
      data = await readBoundedAiResponse(response, resetIdleTimeout);
    } catch (error) {
      // Classification of an HTTP failure is based on its status even when the
      // provider supplied a blank, malformed, or oversized error body.
      if (response?.ok === false && Number.isInteger(Number(response.status))) {
        error.status = Number(response.status);
        error.providerPayload = {};
      }
      throw error;
    }
    if (!response.ok) {
      const errorData = data && typeof data === "object" ? data : {};
      const error = new Error(
        errorData.error?.message ||
          errorData.message ||
          `DeepSeek error: ${response.status}`,
      );
      error.status = response.status;
      // Keep the already bounded payload available to the canonical mapper so
      // documented quota markers can take precedence over 401/403 auth labels.
      error.providerPayload = errorData;
      throw error;
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw codedProviderError(
        YTD_PROVIDERS.ERROR_CODES.MALFORMED_RESPONSE,
        "DeepSeek returned a malformed response schema.",
      );
    }

    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) {
      const error = new Error("DeepSeek returned an empty response.");
      error.code = "EMPTY_AI_RESPONSE";
      throw error;
    }

    return { text, settings: prepared.settings };
  } catch (error) {
    if (timeoutKind === "idle") {
      const timeoutError = new Error(
        "DeepSeek request was inactive for 50 seconds. Please Retry.",
      );
      timeoutError.code = "AI_IDLE_TIMEOUT";
      throw timeoutError;
    }
    if (timeoutKind === "hard") {
      const timeoutError = new Error(
        "DeepSeek request exceeded the 120-second limit. Please Retry.",
      );
      timeoutError.code = "AI_HARD_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(idleTimeoutId);
    clearTimeout(hardTimeoutId);
  }
}

async function requestAiCompletion({
  messages,
  maxTokens,
  temperature,
  responseFormat,
  storage = chrome.storage.local,
  beforeDispatch,
  onDispatch,
}) {
  const settings = await getSettings(storage);
  const prepared = prepareAiCompletion({
    settings,
    messages,
    maxTokens,
    temperature,
    responseFormat,
  });
  // General AI features still use the asynchronous panel guard. Basic Overview
  // prepares this same request before its claim and uses a synchronous final
  // authority check instead.
  await assertProviderDispatchAllowed(beforeDispatch);
  return dispatchPreparedAiCompletion(prepared, { onDispatch });
}

async function readBoundedAiResponse(response, onActivity) {
  const reader = response.body?.getReader?.();
  if (reader) {
    const decoder = new TextDecoder();
    let responseText = "";
    let responseBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Every received chunk is activity, including DeepSeek's blank lines.
      onActivity();
      const byteLength = value?.byteLength ?? 0;
      responseBytes += byteLength;
      if (responseBytes > AI_PROVIDER_MAX_RESPONSE_BYTES) {
        await reader.cancel?.().catch(() => {});
        const error = new Error("DeepSeek response exceeded the 2 MiB limit.");
        error.code = "AI_RESPONSE_TOO_LARGE";
        throw error;
      }
      responseText += decoder.decode(value, { stream: true });
    }
    responseText += decoder.decode();
    return JSON.parse(responseText.trimStart());
  }

  // Some fetch implementations do not expose a readable stream. Preserve a
  // bounded body read for that case.
  if (typeof response.text === "function") {
    const responseText = await response.text();
    onActivity();
    const byteLength = new TextEncoder().encode(responseText).byteLength;
    if (byteLength > AI_PROVIDER_MAX_RESPONSE_BYTES) {
      const error = new Error("DeepSeek response exceeded the 2 MiB limit.");
      error.code = "AI_RESPONSE_TOO_LARGE";
      throw error;
    }
    return JSON.parse(responseText.trimStart());
  }

  // Legacy/test fetch shims may expose only json(). The hard and idle timers
  // still bound this fallback even though chunk-level activity is unavailable.
  const data = await response.json();
  onActivity();
  return data;
}

// ============================================================
// SIDE PANEL SETUP
// ============================================================

/**
 * When the user clicks the extension icon, open the side panel.
 * Chrome's Side Panel API lets us show a persistent panel alongside the page.
 */
chrome.action.onClicked.addListener((tab) => {
  // Re-enable + open without awaiting — preserves user gesture context
  chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: "sidepanel.html",
    enabled: true,
  });
  chrome.sidePanel.open({ tabId: tab.id });
});

/**
 * Allow the side panel to open on any page, but it's designed for YouTube.
 */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

/**
 * Keep the side panel scoped to YouTube tabs only.
 *
 * Chrome side panels are "global" by default: once opened, the panel follows
 * you to every tab. To make YouTube Digest Vocabulary behave like a YouTube-only tool, we
 * enable the panel on YouTube tabs and disable it everywhere else. Disabling
 * on a tab makes Chrome hide/close the panel for that tab, so it never lingers
 * on a new tab or some other website.
 *
 * We have to react to BOTH things that can change "what tab you're looking at":
 *   - onUpdated: the current tab navigates to a new URL
 *   - onActivated: you switch to (or open) a different tab
 * The original code only handled onUpdated, which is why the panel stayed
 * visible when switching to an already-loaded non-YouTube tab.
 */
function updatePanelForTab(tabId, url) {
  const isYouTube = (url || "").startsWith("https://www.youtube.com");
  // setOptions can reject if the tab just closed — ignore that harmlessly.
  chrome.sidePanel
    .setOptions({ tabId, path: "sidepanel.html", enabled: isYouTube })
    .catch(() => {});
}

// A tab navigated to a new URL.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return; // ignore title/favicon-only updates
  const windowId = tab?.windowId;
  const latest = latestPanelSessionByWindow.get(windowId)?.token;
  const nextUrl = effectiveTabUrl(tab) || changeInfo.url;
  if (
    latest?.tabId === tabId &&
    videoIdFromYouTubeTabUrl(nextUrl) !== latest.videoId
  ) {
    invalidatePanelSession(windowId);
  }
  updatePanelForTab(tabId, nextUrl);
});

// The user switched to a different tab (or opened a new one).
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const latest = latestPanelSessionByWindow.get(windowId)?.token;
  if (latest && latest.tabId !== tabId) invalidatePanelSession(windowId);
  try {
    const tab = await chrome.tabs.get(tabId);
    updatePanelForTab(tabId, effectiveTabUrl(tab));
  } catch (e) {
    // Tab vanished before we could read it — nothing to do.
  }
});

chrome.tabs.onRemoved?.addListener((tabId, removeInfo) => {
  const windowId = removeInfo?.windowId;
  const latest = latestPanelSessionByWindow.get(windowId)?.token;
  if (latest?.tabId === tabId) invalidatePanelSession(windowId);
  forgetPanelTab(windowId, tabId);
});

chrome.windows?.onRemoved?.addListener((windowId) => {
  forgetPanelWindow(windowId);
});

chrome.storage?.onChanged?.addListener((changes, areaName) => {
  if (areaName === "local" && changes?.[STORAGE_KEYS.resetEpoch]) {
    clearOverviewCacheRecoveries();
    bumpResetValidationRevision();
    invalidateAllPanelSessions();
  }
});

// ============================================================
// MESSAGE HANDLING
// ============================================================

async function handleGetResetEpoch() {
  try {
    const resetEpoch = await storageMutations.captureEpoch();
    return { success: true, resetEpoch };
  } catch {
    return mutationFailure("STORAGE_READ_FAILED");
  }
}

async function digestMutationAuthority(
  expectedEpoch,
  videoId,
  tabId,
  sessionTokenValue,
) {
  const resetRevision = resetValidationRevision;
  const resetFailure = panelResetFailure(resetRevision);
  if (resetFailure) return mutationFailure(resetFailure);
  if (!validExpectedEpoch(expectedEpoch)) {
    return mutationFailure("INVALID_RESET_EPOCH");
  }
  if (!validVideoId(videoId)) {
    return mutationFailure("INVALID_VIDEO_ID");
  }
  if (!validTabId(tabId)) return mutationFailure("INVALID_TAB_ID");
  const sessionToken = normalizedSessionToken(sessionTokenValue);
  if (!sessionToken) {
    return mutationFailure("INVALID_SESSION_TOKEN");
  }
  if (
    sessionToken &&
    (sessionToken.videoId !== videoId ||
      sessionToken.tabId !== tabId ||
      sessionToken.resetEpoch !== expectedEpoch)
  ) {
    return mutationFailure("SESSION_BINDING_MISMATCH");
  }
  const initialContext = await validatePanelSessionContext(sessionToken, {
    resetRevision,
  });
  if (!initialContext.success) return mutationFailure(initialContext.code);
  const validateBoundTab = async () =>
    (
      await validatePanelSessionContext(sessionToken, {
        resetRevision,
      })
    ).success === true;
  return {
    success: true,
    resetRevision,
    sessionToken,
    validateBoundTab,
  };
}

async function canonicalDigestBaseValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { success: false, code: "INVALID_DIGEST_VALUE" };
  }
  let transcript;
  let sourceLanguage;
  let segments;
  try {
    transcript = strictDigestTranscript(ownValue(value, "transcript"));
    if (!transcript) throw new TypeError("Invalid digest transcript.");
    sourceLanguage = YTD_TRANSCRIPT_CORE.resolveTranscriptLanguage(
      ownValue(value, "transcriptLanguage"),
      transcript,
    );
    segments = YTD_TRANSCRIPT_CORE.groupTranscriptEntries(transcript);
    if (!segments.length) throw new TypeError("Empty digest transcript.");
  } catch {
    return { success: false, code: "INVALID_DIGEST_VALUE" };
  }
  let transcriptFingerprint;
  try {
    transcriptFingerprint = await YTD_TRANSCRIPT_CORE.fingerprintSegments(
      segments,
      { sourceLanguage },
    );
  } catch (error) {
    return {
      success: false,
      code:
        error?.code === "TRANSCRIPT_FINGERPRINT_UNAVAILABLE"
          ? "TRANSCRIPT_FINGERPRINT_UNAVAILABLE"
          : "TRANSCRIPT_FINGERPRINT_FAILED",
    };
  }
  if (ownValue(value, "transcriptFingerprint") !== transcriptFingerprint) {
    return {
      success: false,
      code: "TRANSCRIPT_FINGERPRINT_MISMATCH",
    };
  }
  const normalized = {
    transcript,
    transcriptText: ownValue(value, "transcriptText"),
    transcriptTimestamped: ownValue(value, "transcriptTimestamped"),
    transcriptLanguage: sourceLanguage,
    transcriptFingerprint,
    videoTitle: ownValue(value, "videoTitle"),
    channelName: ownValue(value, "channelName"),
  };
  if (!digestBaseWithinInputBudget(normalized, transcript)) {
    return { success: false, code: "INVALID_DIGEST_VALUE" };
  }
  return {
    success: true,
    value: normalized,
    migrationContext: {
      canonicalSegmentIds: segments.map((segment) => segment.id),
    },
  };
}

async function handlePersistDigestBase(
  expectedEpoch,
  videoId,
  value,
  tabId,
  sessionTokenValue,
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return mutationFailure("INVALID_DIGEST_VALUE");
  }
  const authority = await digestMutationAuthority(
    expectedEpoch,
    videoId,
    tabId,
    sessionTokenValue,
  );
  if (!authority.success) return authority;
  const canonical = await canonicalDigestBaseValue(value);
  if (!canonical.success) return mutationFailure(canonical.code);
  const postHashContext = await validatePanelSessionContext(
    authority.sessionToken,
    { resetRevision: authority.resetRevision },
  );
  if (!postHashContext.success) {
    return mutationFailure(postHashContext.code);
  }
  try {
    return await storageMutations.commitDigestBase(
      expectedEpoch,
      videoId,
      canonical.value,
      authority.validateBoundTab,
      canonical.migrationContext,
    );
  } catch (error) {
    if (error?.name === "TypeError") {
      return mutationFailure("INVALID_DIGEST_VALUE");
    }
    return mutationFailure("STORAGE_WRITE_FAILED");
  }
}

async function handlePatchDigestCache(
  expectedEpoch,
  videoId,
  transcriptFingerprint,
  patch,
  tabId,
  sessionTokenValue,
) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return mutationFailure("INVALID_DIGEST_PATCH");
  }
  const authority = await digestMutationAuthority(
    expectedEpoch,
    videoId,
    tabId,
    sessionTokenValue,
  );
  if (!authority.success) return authority;
  try {
    return await storageMutations.patchDigest(
      expectedEpoch,
      videoId,
      transcriptFingerprint,
      patch,
      authority.validateBoundTab,
    );
  } catch (error) {
    if (error?.name === "TypeError") {
      return mutationFailure("INVALID_DIGEST_PATCH");
    }
    return mutationFailure("STORAGE_WRITE_FAILED");
  }
}

async function handleGetLocalDataSummary() {
  return commitCurrentMutation(async (storage) => {
    let all;
    try {
      all = await storage.get(null);
    } catch {
      return mutationFailure("STORAGE_READ_FAILED");
    }
    return {
      success: true,
      summary: YTD_PERSISTENCE.summarizeStoredData(all),
    };
  }, "STORAGE_READ_FAILED");
}

async function handleResetExtensionData() {
  clearOverviewCacheRecoveries();
  activeResetCount += 1;
  bumpResetValidationRevision();
  invalidateAllPanelSessions();
  try {
    return await storageMutations.resetExtensionData();
  } catch {
    return mutationFailure("RESET_STORAGE_FAILED");
  } finally {
    activeResetCount = Math.max(0, activeResetCount - 1);
  }
}

async function handleClearDigestCache() {
  clearOverviewCacheRecoveries();
  activeResetCount += 1;
  bumpResetValidationRevision();
  invalidateAllPanelSessions();
  try {
    return await storageMutations.clearDigestCache();
  } catch {
    return mutationFailure("STORAGE_WRITE_FAILED");
  } finally {
    activeResetCount = Math.max(0, activeResetCount - 1);
  }
}

function handleDeleteAllNotes() {
  return runNoteRequestInOrder(() =>
    commitCurrentMutation(async (storage) => {
      let before;
      try {
        before = await storage.get(STORAGE_KEYS.notes);
      } catch {
        return mutationFailure("STORAGE_READ_FAILED");
      }
      const storedNotes = ownValue(before, STORAGE_KEYS.notes);
      const deletedCount = Array.isArray(storedNotes)
        ? storedNotes.length
        : 0;
      try {
        await storage.remove(STORAGE_KEYS.notes);
      } catch {
        return mutationFailure("STORAGE_WRITE_FAILED");
      }
      let after;
      try {
        after = await storage.get(STORAGE_KEYS.notes);
      } catch {
        return mutationFailure("STORAGE_READ_FAILED");
      }
      if (Object.hasOwn(after, STORAGE_KEYS.notes)) {
        return mutationFailure("DELETE_NOTES_VERIFICATION_FAILED");
      }
      return { success: true, deletedCount };
    }, "STORAGE_WRITE_FAILED"),
  );
}

async function mutateProviderSettings(provider, apiKey, options, removeKey) {
  if (!validProvider(provider)) {
    return mutationFailure("INVALID_PROVIDER");
  }
  const normalizedKey = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!removeKey && (!normalizedKey || normalizedKey.length > 4096)) {
    return mutationFailure("INVALID_API_KEY");
  }

  return commitCurrentMutation(async (storage) => {
    let stored;
    try {
      stored = await storage.get([
        STORAGE_KEYS.settings,
        STORAGE_KEYS.providerStatus,
      ]);
    } catch {
      return mutationFailure("STORAGE_READ_FAILED");
    }
    const currentSettings = YTD_SETTINGS.normalize(
      ownValue(stored, STORAGE_KEYS.settings),
    );
    const currentKey = provider === "supadata"
      ? currentSettings.supadataApiKey
      : currentSettings.aiApiKey;
    const nextKey = removeKey ? "" : normalizedKey;
    const settings = YTD_SETTINGS.mergeProviderSettings(
      currentSettings,
      provider,
      nextKey,
      options,
    );
    const statuses = normalizeProviderStatuses(
      ownValue(stored, STORAGE_KEYS.providerStatus),
      settings,
    );
    const hasKey = provider === "supadata"
      ? Boolean(settings.supadataApiKey)
      : Boolean(settings.aiApiKey);
    if (removeKey || currentKey !== nextKey) {
      statuses[provider] = YTD_PROVIDERS.normalizeStatusRecord(null, hasKey);
    }

    try {
      await storage.set({
        [STORAGE_KEYS.settings]: settings,
        [STORAGE_KEYS.providerStatus]: statuses,
      });
    } catch {
      return mutationFailure("STORAGE_WRITE_FAILED");
    }
    return {
      success: true,
      provider,
      configured: hasKey,
      status: statuses[provider],
    };
  }, "STORAGE_WRITE_FAILED");
}

function handleSaveProviderSettings(provider, apiKey, options) {
  return mutateProviderSettings(provider, apiKey, options, false);
}

function handleRemoveProviderKey(provider) {
  return mutateProviderSettings(provider, "", {}, true);
}

/**
 * Listen for messages from the side panel and content script.
 * This is like a switchboard — different "actions" trigger different handlers.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // We need to return true to indicate we'll respond asynchronously
  if (message.action === "bindVideoSession") {
    return respondBounded(
      handleBindVideoSession(message.sessionToken, sender),
      sendResponse,
      "SESSION_BIND_FAILED",
    );
  }

  if (message.action === "getResetEpoch") {
    return respondBounded(
      handleGetResetEpoch(),
      sendResponse,
      "STORAGE_READ_FAILED",
    );
  }

  if (message.action === "persistDigestBase") {
    return respondBounded(
      handlePersistDigestBase(
        message.expectedEpoch,
        message.videoId,
        message.value,
        message.tabId,
        message.sessionToken,
      ).then((result) => withSessionToken(result, message.sessionToken)),
      sendResponse,
      "STORAGE_WRITE_FAILED",
    );
  }

  if (message.action === "patchDigestCache") {
    return respondBounded(
      handlePatchDigestCache(
        message.expectedEpoch,
        message.videoId,
        message.transcriptFingerprint,
        message.patch,
        message.tabId,
        message.sessionToken,
      ).then((result) => withSessionToken(result, message.sessionToken)),
      sendResponse,
      "STORAGE_WRITE_FAILED",
    );
  }

  if (message.action === "getLocalDataSummary") {
    return respondBounded(
      handleGetLocalDataSummary(),
      sendResponse,
      "STORAGE_READ_FAILED",
    );
  }

  if (message.action === "resetExtensionData") {
    return respondBounded(
      handleResetExtensionData(),
      sendResponse,
      "RESET_STORAGE_FAILED",
    );
  }

  if (message.action === "clearDigestCache") {
    return respondBounded(
      handleClearDigestCache(),
      sendResponse,
      "STORAGE_WRITE_FAILED",
    );
  }

  if (message.action === "deleteAllNotes") {
    return respondBounded(
      handleDeleteAllNotes(),
      sendResponse,
      "STORAGE_WRITE_FAILED",
    );
  }

  if (message.action === "saveProviderSettings") {
    return respondBounded(
      handleSaveProviderSettings(
        message.provider,
        message.apiKey,
        message.options,
      ),
      sendResponse,
      "STORAGE_WRITE_FAILED",
    );
  }

  if (message.action === "removeProviderKey") {
    return respondBounded(
      handleRemoveProviderKey(message.provider),
      sendResponse,
      "STORAGE_WRITE_FAILED",
    );
  }

  if (message.action === "fetchTranscript") {
    runPanelVideoRequest(
      message.sessionToken,
      (beforeDispatch) =>
        handleFetchTranscript(
          message.videoId,
          chrome.storage.local,
          beforeDispatch,
        ),
      message.videoId,
    )
      .then((result) =>
        sendResponse(withSessionToken(result, message.sessionToken)),
      )
      .catch((error) =>
        sendResponse(
          withSessionToken(
            providerMessageFailure("supadata", "transcript", error),
            message.sessionToken,
          ),
        ),
      );
    return true; // Keep the message channel open for async response
  }

  if (message.action === "requestBasicOverview") {
    createPanelVideoRequestAuthority(message.sessionToken, message.videoId)
      .then((authority) =>
        authority.success
          ? handleRequestBasicOverview(
              message.payload,
              message.intent,
              authority,
            )
          : overviewFailureEnvelope(authority.code),
      )
      .then((result) =>
        sendResponse(withSessionToken(result, message.sessionToken)),
      )
      .catch(() =>
        sendResponse(
          withSessionToken(
            overviewFailureEnvelope("UNKNOWN_PROVIDER_ERROR"),
            message.sessionToken,
          ),
        ),
      );
    return true;
  }

  if (message.action === "retryBasicOverviewCacheWrite") {
    runRetryBasicOverviewCacheWrite(
      message.recoveryToken,
      message.sessionToken,
      message.videoId,
    )
      .then((result) =>
        sendResponse(withSessionToken(result, message.sessionToken)),
      )
      .catch(() =>
        sendResponse(
          withSessionToken(
            overviewRecoveryUnavailable(),
            message.sessionToken,
          ),
        ),
      );
    return true;
  }

  if (message.action === "analyzeTranscript") {
    // Pass video duration to help the AI validate timestamps
    runPanelVideoRequest(message.sessionToken, (beforeDispatch) =>
      handleAnalyzeTranscript(
        message.transcriptText,
        message.videoTitle,
        message.channelName,
        message.videoDescription,
        message.videoDuration,
        beforeDispatch,
      ),
    )
      .then((result) =>
        sendResponse(withSessionToken(result, message.sessionToken)),
      )
      .catch((error) =>
        sendResponse(
          withSessionToken(
            providerMessageFailure("deepseek", "analysis", error),
            message.sessionToken,
          ),
        ),
      );
    return true;
  }

  if (message.action === "explainSelection") {
    // Explain selected text using DeepSeek.
    runPanelVideoRequest(message.sessionToken, (beforeDispatch) =>
      handleExplainSelection(
        message.selectedText,
        message.transcriptContext,
        message.videoTitle,
        beforeDispatch,
      ),
    )
      .then((result) =>
        sendResponse(withSessionToken(result, message.sessionToken)),
      )
      .catch((error) =>
        sendResponse(
          withSessionToken(
            providerMessageFailure("deepseek", "explanation", error),
            message.sessionToken,
          ),
        ),
      );
    return true;
  }

  if (message.action === "generateVocabularyCard") {
    handleGenerateVocabularyCard(message.payload)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "saveVocabularyCard") {
    handleSaveVocabularyCard(message.card)
      .then(sendResponse)
      .catch(() => sendResponse(legacyMutationFailure("VOCABULARY_SAVE_FAILED")));
    return true;
  }

  if (message.action === "getVocabulary") {
    handleGetVocabulary()
      .then(sendResponse)
      .catch(() => sendResponse(legacyMutationFailure("STORAGE_READ_FAILED")));
    return true;
  }

  if (message.action === "deleteVocabularyCard") {
    handleDeleteVocabularyCard(message.cardId)
      .then(sendResponse)
      .catch(() =>
        sendResponse(legacyMutationFailure("VOCABULARY_DELETE_FAILED")),
      );
    return true;
  }

  if (message.action === "saveNote") {
    // Save a note at the current timestamp
    handleSaveNote(
      message.videoId,
      message.timestamp,
      message.videoTitle,
      message.channelName,
      message.sessionToken,
      sender,
    )
      .then((result) =>
        sendResponse(withSessionToken(result, message.sessionToken)),
      )
      .catch(() =>
        sendResponse(
          withSessionToken(
            legacyMutationFailure("NOTE_SAVE_FAILED"),
            message.sessionToken,
          ),
        ),
      );
    return true;
  }

  if (message.action === "getNotes") {
    // Get all saved notes
    handleBoundGetNotes(message.videoId, message.sessionToken)
      .then((result) =>
        sendResponse(withSessionToken(result, message.sessionToken)),
      )
      .catch(() =>
        sendResponse(
          withSessionToken(
            legacyMutationFailure("STORAGE_READ_FAILED"),
            message.sessionToken,
          ),
        ),
      );
    return true;
  }

  if (message.action === "deleteNote") {
    // Delete a specific note
    handleDeleteNote(message.noteId, message.sessionToken)
      .then((result) =>
        sendResponse(withSessionToken(result, message.sessionToken)),
      )
      .catch(() =>
        sendResponse(
          withSessionToken(
            legacyMutationFailure("NOTE_DELETE_FAILED"),
            message.sessionToken,
          ),
        ),
      );
    return true;
  }

  if (message.action === "getVideoInfo") {
    handleGetVideoInfo(message.tabId)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  // Translation: send content to DeepSeek.
  if (message.action === "translateContent") {
    runPanelVideoRequest(message.sessionToken, (beforeDispatch) =>
      handleTranslateContent(
        message.content,
        message.contentType,
        message.targetLanguage,
        message.videoTitle,
        beforeDispatch,
      ),
    )
      .then((result) =>
        sendResponse(withSessionToken(result, message.sessionToken)),
      )
      .catch((error) =>
        sendResponse(
          withSessionToken(
            providerMessageFailure("deepseek", "translation", error),
            message.sessionToken,
          ),
        ),
      );
    return true;
  }

  if (message.action === "checkConfig") {
    getSettings()
      .then((settings) =>
        sendResponse({
          hasSupadataKey: Boolean(settings.supadataApiKey),
          hasAiKey: Boolean(settings.aiApiKey),
          autoBasicOverview: settings.autoBasicOverview === true,
        }),
      )
      .catch(() =>
        sendResponse({
          hasSupadataKey: false,
          hasAiKey: false,
          autoBasicOverview: false,
        }),
      );
    return true;
  }

  if (message.action === "openOptions") {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "openSidePanel") {
    const tabId = sender.tab?.id;
    debugLog("[YouTube Digest Vocabulary BG] openSidePanel requested from tab:", tabId);

    // Re-enable the panel (it may have been disabled by auto-close) and open it.
    // IMPORTANT: we call setOptions + open synchronously (no await between them)
    // to preserve the user gesture context. Chrome requires sidePanel.open()
    // to be called within a user gesture — awaiting anything first can expire it.
    if (tabId) {
      chrome.sidePanel.setOptions({
        tabId,
        path: "sidepanel.html",
        enabled: true,
      });
      chrome.sidePanel
        .open({ tabId })
        .then(() => {
          // Broadcast to side panel to start digest (in case it's already open)
          setTimeout(() => {
            chrome.runtime
              .sendMessage({ action: "startDigestFromButton", tabId })
              .catch(() => {});
          }, 300);
        })
        .catch((err) => {
          console.error("[YouTube Digest Vocabulary BG] openSidePanel error:", err);
        });
    } else {
      // Fallback: find the active tab
      chrome.tabs
        .query({ active: true, lastFocusedWindow: true })
        .then((tabs) => {
          if (tabs[0]) {
            chrome.sidePanel.setOptions({
              tabId: tabs[0].id,
              path: "sidepanel.html",
              enabled: true,
            });
            chrome.sidePanel.open({ tabId: tabs[0].id }).catch((err) => {
              console.error(
                "[YouTube Digest Vocabulary BG] openSidePanel fallback error:",
                err,
              );
            });
          }
        });
    }

    sendResponse({ success: true });
    return false;
  }

  // Relay messages from side panel to content script
  if (message.action === "relayToContent") {
    debugLog("[YouTube Digest Vocabulary BG] Relay request:", message.payload?.action);
    (async () => {
      const tabId = message.tabId;
      if (!validTabId(tabId)) {
        sendResponse(relayFailure("INVALID_TAB_ID", message.sessionToken));
        return;
      }
      if (
        !message.payload ||
        typeof message.payload !== "object" ||
        typeof message.payload.action !== "string" ||
        !message.payload.action ||
        message.payload.action.length > 80
      ) {
        sendResponse(relayFailure("INVALID_RELAY_PAYLOAD", message.sessionToken));
        return;
      }
      const sessionToken = normalizedSessionToken(message.sessionToken);
      if (!sessionToken) {
        sendResponse(relayFailure("INVALID_SESSION_TOKEN", null));
        return;
      }
      if (sessionToken.tabId !== tabId) {
        sendResponse(relayFailure("SESSION_TAB_MISMATCH", sessionToken));
        return;
      }

      const initialContext = await validatePanelSessionContext(sessionToken, {
        checkEpoch: false,
      });
      if (!initialContext.success) {
        sendResponse(relayFailure(initialContext.code, sessionToken));
        return;
      }

      try {
        const relayPayload = sessionToken
          ? { ...message.payload, expectedVideoId: sessionToken.videoId }
          : message.payload;
        const preRelayFailure = currentPanelSessionFailure(sessionToken);
        if (preRelayFailure) {
          sendResponse(relayFailure(preRelayFailure, sessionToken));
          return;
        }
        let response = await chrome.tabs.sendMessage(tabId, relayPayload);
        if (
          response?.success === false &&
          (response.code === "VIDEO_ID_MISMATCH" ||
            response.code === "INVALID_EXPECTED_VIDEO_ID")
        ) {
          sendResponse(relayFailure(response.code, sessionToken));
          return;
        }
        const postRelayContext = await validatePanelSessionContext(sessionToken, {
          checkEpoch: false,
        });
        if (!postRelayContext.success) {
          sendResponse(relayFailure(postRelayContext.code, sessionToken));
          return;
        }

        // YouTube's player data is canonical for metadata; DOM values remain
        // the field-by-field fallback. Both reads stay on the explicit tab.
        if (message.payload?.action === "getVideoInfo") {
          const playerInfo = await getPlayerVideoDetails(tabId);
          const postMetadataContext = await validatePanelSessionContext(
            sessionToken,
            { checkEpoch: false },
          );
          if (!postMetadataContext.success) {
            sendResponse(
              relayFailure(postMetadataContext.code, sessionToken),
            );
            return;
          }
          if (playerInfo) {
            response = {
              title: playerInfo.title || response?.title || "",
              channelName:
                playerInfo.channelName || response?.channelName || "",
              duration: playerInfo.duration || response?.duration || 0,
              description:
                playerInfo.description || response?.description || "",
            };
          }
        }

        sendResponse(
          withSessionToken({ success: true, response }, sessionToken),
        );
      } catch {
        sendResponse(relayFailure("CONTENT_RELAY_FAILED", sessionToken));
      }
    })();
    return true; // Keep channel open for async response
  }
});

/**
 * Reads the current video's full details straight from YouTube's player.
 *
 * Content scripts live in an isolated world and can't touch the page's own
 * JavaScript. But with the "scripting" permission we can run a tiny function
 * in the page's MAIN world, where YouTube's player object lives. Its
 * getPlayerResponse() carries videoDetails with the FULL description —
 * unlike the DOM, which truncates it until the user clicks "...more".
 *
 * Returns null on any failure so callers can fall back to DOM scraping.
 */
async function getPlayerVideoDetails(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        try {
          const player = document.getElementById("movie_player");
          const details = player?.getPlayerResponse?.()?.videoDetails;
          if (!details) return null;
          return {
            title: details.title || "",
            channelName: details.author || "",
            description: details.shortDescription || "",
            duration: Number(details.lengthSeconds) || 0,
          };
        } catch (e) {
          return null;
        }
      },
    });
    return results?.[0]?.result || null;
  } catch (e) {
    debugLog("[YouTube Digest Vocabulary BG] Player details unavailable");
    return null;
  }
}

// ============================================================
// TRANSCRIPT FETCHING VIA SUPADATA API
// ============================================================

function codedProviderError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Converts every Supadata transcript response into the one internal shape used
 * by synchronous and asynchronous jobs. Exact display/AI text is always built
 * from the same cleaned source so the two provider paths cannot drift.
 */
function normalizeSupadataTranscript(data) {
  const transcript = [];
  const plainText = [];
  const timestampedText = [];
  const content = Array.isArray(data?.content) ? data.content : [];

  for (const chunk of content) {
    if (!chunk || typeof chunk.text !== "string") continue;
    const cleanText = chunk.text.replace(/>> ?/g, "").trim();
    if (!cleanText) continue;

    const offsetMs = Number(chunk.offset);
    const durationMs = Number(chunk.duration);
    const startSeconds = Math.floor(
      Number.isFinite(offsetMs) && offsetMs > 0 ? offsetMs / 1000 : 0,
    );
    const durationSeconds = Math.floor(
      Number.isFinite(durationMs) && durationMs > 0 ? durationMs / 1000 : 0,
    );
    const minutes = Math.floor(startSeconds / 60);
    const seconds = startSeconds % 60;
    const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;
    const chunkLanguage = YTD_TRANSCRIPT_CORE.resolveTranscriptLanguage(
      chunk.lang,
    );
    const topLevelLanguage = YTD_TRANSCRIPT_CORE.resolveTranscriptLanguage(
      data?.lang,
    );

    transcript.push({
      text: cleanText,
      start: startSeconds,
      duration: durationSeconds,
      language: chunkLanguage || topLevelLanguage,
    });
    plainText.push(cleanText);
    timestampedText.push(`[${timestamp}] ${cleanText}`);
  }

  if (!transcript.length) {
    throw codedProviderError(
      YTD_PROVIDERS.ERROR_CODES.EMPTY_RESPONSE,
      "Supadata returned no usable transcript content.",
    );
  }

  return {
    success: true,
    transcript,
    transcriptText: plainText.join(" "),
    transcriptTextTimestamped: timestampedText.join("\n"),
    language: YTD_TRANSCRIPT_CORE.resolveTranscriptLanguage(
      data?.lang,
      transcript,
    ),
  };
}

async function readBoundedJsonResponse(response, maxBytes) {
  const reader = response?.body?.getReader?.();
  let responseText = "";

  if (reader) {
    const decoder = new TextDecoder();
    let responseBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      responseBytes += value?.byteLength || 0;
      if (responseBytes > maxBytes) {
        await reader.cancel?.().catch(() => {});
        throw codedProviderError(
          YTD_PROVIDERS.ERROR_CODES.RESPONSE_TOO_LARGE,
          "Provider response exceeded the configured size limit.",
        );
      }
      responseText += decoder.decode(value, { stream: true });
    }
    responseText += decoder.decode();
  } else if (typeof response?.text === "function") {
    responseText = await response.text();
    if (new TextEncoder().encode(responseText).byteLength > maxBytes) {
      throw codedProviderError(
        YTD_PROVIDERS.ERROR_CODES.RESPONSE_TOO_LARGE,
        "Provider response exceeded the configured size limit.",
      );
    }
  } else if (typeof response?.json === "function") {
    // Chrome Responses expose body/text. This compatibility path only supports
    // older test doubles while still rejecting their serialized result by size.
    let data;
    try {
      data = await response.json();
      responseText = JSON.stringify(data);
    } catch {
      throw codedProviderError(
        YTD_PROVIDERS.ERROR_CODES.MALFORMED_RESPONSE,
        "Provider returned malformed JSON.",
      );
    }
    if (new TextEncoder().encode(responseText).byteLength > maxBytes) {
      throw codedProviderError(
        YTD_PROVIDERS.ERROR_CODES.RESPONSE_TOO_LARGE,
        "Provider response exceeded the configured size limit.",
      );
    }
    return data;
  } else {
    throw codedProviderError(
      YTD_PROVIDERS.ERROR_CODES.MALFORMED_RESPONSE,
      "Provider response body was unavailable.",
    );
  }

  if (!responseText.trim()) {
    throw codedProviderError(
      YTD_PROVIDERS.ERROR_CODES.MALFORMED_RESPONSE,
      "Provider returned an empty JSON body.",
    );
  }
  try {
    return JSON.parse(responseText);
  } catch {
    throw codedProviderError(
      YTD_PROVIDERS.ERROR_CODES.MALFORMED_RESPONSE,
      "Provider returned malformed JSON.",
    );
  }
}

async function fetchWithDeadline(
  url,
  init = {},
  {
    timeoutMs,
    maxBytes,
    fetchImpl = fetch,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  },
) {
  const controller = new AbortController();
  let timeoutId;
  const timeout = new Promise((_resolve, reject) => {
    timeoutId = setTimeoutImpl(() => {
      controller.abort();
      reject(
        codedProviderError(
          YTD_PROVIDERS.ERROR_CODES.REQUEST_TIMEOUT,
          "Provider request exceeded its deadline.",
        ),
      );
    }, timeoutMs);
  });
  const operation = (async () => {
    const response = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
    if (response?.status === 206) {
      // A native-caption miss has no useful payload. Release the stream without
      // awaiting provider-controlled cancellation, which itself may never settle.
      try {
        const cancellation = response.body?.cancel?.();
        cancellation?.catch?.(() => {});
      } catch {
        // Cancellation is best-effort; the HTTP status remains authoritative.
      }
      return { response, data: {} };
    }
    let data;
    try {
      data = await readBoundedJsonResponse(response, maxBytes);
    } catch (error) {
      // HTTP status remains the primary classification for malformed provider
      // error bodies (for example, a blank 401 is still an invalid key).
      if (response?.ok === false && Number.isInteger(Number(response.status))) {
        error.status = Number(response.status);
      }
      throw error;
    }
    return { response, data };
  })();

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeoutImpl(timeoutId);
  }
}

function providerFailureResult(provider, stage, error, dispatched) {
  const mapped = YTD_PROVIDERS.mapThrownFailure({
    provider,
    stage,
    error,
    dispatched,
  });
  const authorityCode =
    typeof error?.code === "string" &&
    /^(?:TAB|SESSION)_[A-Z0-9_]{1,56}$/.test(error.code)
      ? error.code
      : "";
  if (
    authorityCode &&
    mapped.code === YTD_PROVIDERS.ERROR_CODES.UNKNOWN_PROVIDER_ERROR
  ) {
    // Session/tab authority failures belong to the lifecycle protocol rather
    // than the provider contract. Preserve their bounded code for callers that
    // must distinguish navigation from provider failure.
    return { success: false, code: authorityCode };
  }
  return {
    success: false,
    ...mapped,
  };
}

function providerHttpFailureResult(
  provider,
  stage,
  response,
  payload,
  dispatched,
) {
  return {
    success: false,
    ...YTD_PROVIDERS.mapHttpFailure({
      provider,
      stage,
      status: response?.status,
      payload,
      dispatched,
    }),
  };
}

function supadataRuntime(overrides = {}) {
  const setTimeoutImpl = overrides.setTimeoutImpl || setTimeout;
  const clearTimeoutImpl = overrides.clearTimeoutImpl || clearTimeout;
  return {
    fetchImpl: overrides.fetchImpl || fetch,
    now: overrides.now || (() => Date.now()),
    setTimeoutImpl,
    clearTimeoutImpl,
    sleep:
      overrides.sleep ||
      ((delay) => new Promise((resolve) => setTimeoutImpl(resolve, delay))),
  };
}

/**
 * Fetches the transcript for a YouTube video using Supadata API.
 *
 * Supadata is a specialized service that reliably extracts transcripts
 * from YouTube videos. It handles all the complexity of parsing YouTube's
 * internal data structures, dealing with different caption formats, etc.
 *
 * API Docs: https://docs.supadata.ai
 *
 * @param {string} videoId - The YouTube video ID (e.g., "dQw4w9WgXcQ")
 * @returns {Object} - { success, transcript, transcriptText, language } or { success: false, error }
 */
async function handleFetchTranscript(
  videoId,
  storage = chrome.storage.local,
  beforeDispatch,
  runtimeOverrides = {},
) {
  const runtime = supadataRuntime(runtimeOverrides);
  const requestState = { dispatched: false };
  try {
    const settings = await getSettings(storage);
    if (!settings.supadataApiKey) {
      throw codedProviderError(YTD_PROVIDERS.ERROR_CODES.MISSING_KEY);
    }

    // Share only the canonical watch URL. This strips playlist, referral,
    // timestamp, and other browsing parameters from the active tab URL.
    const canonicalVideoUrl = YTD_SETTINGS.canonicalYouTubeUrl(videoId);
    // Using the universal transcript endpoint with text=false to get timestamped chunks
    const apiUrl = new URL("https://api.supadata.ai/v1/transcript");
    apiUrl.searchParams.set("url", canonicalVideoUrl);
    apiUrl.searchParams.set("text", "false"); // Get timestamped chunks, not plain text
    apiUrl.searchParams.set("lang", "en"); // Prefer English
    // Caption-only product scope: never fall back to paid AI transcription.
    apiUrl.searchParams.set("mode", "native");

    // The absolute async-job budget begins immediately before the first paid
    // provider dispatch, not after the 202 response returns.
    await assertProviderDispatchAllowed(beforeDispatch);
    const jobDeadlineAt = runtime.now() + SUPADATA_JOB_DEADLINE_MS;
    requestState.dispatched = true;
    const { response, data } = await fetchWithDeadline(
      apiUrl.toString(),
      {
        method: "GET",
        headers: {
          "x-api-key": settings.supadataApiKey,
        },
      },
      {
        timeoutMs: SUPADATA_INITIAL_TIMEOUT_MS,
        maxBytes: SUPADATA_MAX_RESPONSE_BYTES,
        fetchImpl: runtime.fetchImpl,
        setTimeoutImpl: runtime.setTimeoutImpl,
        clearTimeoutImpl: runtime.clearTimeoutImpl,
      },
    );

    // Handle async jobs (for videos > 20 minutes, Supadata returns a job ID)
    if (response.status === 202) {
      const jobId = typeof data?.jobId === "string" ? data.jobId.trim() : "";
      // Accept only URI-unreserved ASCII so URL construction cannot throw on
      // malformed Unicode and the provider path stays a single bounded token.
      if (
        jobId === "." ||
        jobId === ".." ||
        !/^[A-Za-z0-9._~-]{1,512}$/.test(jobId)
      ) {
        throw codedProviderError(
          YTD_PROVIDERS.ERROR_CODES.MALFORMED_RESPONSE,
        );
      }
      return await pollTranscriptJob(
        jobId,
        settings.supadataApiKey,
        beforeDispatch,
        { jobDeadlineAt, requestState, runtime },
      );
    }

    if (response.status === 206 || !response.ok) {
      return providerHttpFailureResult(
        "supadata",
        "transcript",
        response,
        data,
        requestState.dispatched,
      );
    }
    return normalizeSupadataTranscript(data);
  } catch (error) {
    return providerFailureResult(
      "supadata",
      "transcript",
      error,
      requestState.dispatched,
    );
  }
}

/**
 * Polls for transcript job completion (for long videos).
 * Supadata processes videos > 20 minutes asynchronously.
 *
 * @param {string} jobId - The job ID returned by the initial request
 * @returns {Object} - Same format as handleFetchTranscript
 */
async function pollTranscriptJob(
  jobId,
  supadataApiKey,
  beforeDispatch,
  { jobDeadlineAt, requestState, runtime },
) {
  while (true) {
    const remainingBeforeSleep = jobDeadlineAt - runtime.now();
    if (remainingBeforeSleep <= 0) {
      throw codedProviderError(YTD_PROVIDERS.ERROR_CODES.REQUEST_TIMEOUT);
    }
    await runtime.sleep(
      Math.min(SUPADATA_POLL_INTERVAL_MS, remainingBeforeSleep),
    );
    const remainingBeforePoll = jobDeadlineAt - runtime.now();
    if (remainingBeforePoll <= 0) {
      throw codedProviderError(YTD_PROVIDERS.ERROR_CODES.REQUEST_TIMEOUT);
    }
    await assertProviderDispatchAllowed(beforeDispatch);
    const remainingAfterGuard = jobDeadlineAt - runtime.now();
    if (remainingAfterGuard <= 0) {
      throw codedProviderError(YTD_PROVIDERS.ERROR_CODES.REQUEST_TIMEOUT);
    }
    requestState.dispatched = true;
    const { response, data } = await fetchWithDeadline(
      `https://api.supadata.ai/v1/transcript/${encodeURIComponent(jobId)}`,
      {
        headers: { "x-api-key": supadataApiKey },
      },
      {
        timeoutMs: Math.min(SUPADATA_POLL_TIMEOUT_MS, remainingAfterGuard),
        maxBytes: SUPADATA_MAX_RESPONSE_BYTES,
        fetchImpl: runtime.fetchImpl,
        setTimeoutImpl: runtime.setTimeoutImpl,
        clearTimeoutImpl: runtime.clearTimeoutImpl,
      },
    );

    if (runtime.now() >= jobDeadlineAt) {
      throw codedProviderError(YTD_PROVIDERS.ERROR_CODES.REQUEST_TIMEOUT);
    }
    if (response.status === 206 || !response.ok) {
      return providerHttpFailureResult(
        "supadata",
        "transcript",
        response,
        data,
        requestState.dispatched,
      );
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw codedProviderError(YTD_PROVIDERS.ERROR_CODES.MALFORMED_RESPONSE);
    }

    if (data.status === "completed") {
      return normalizeSupadataTranscript(data);
    }

    if (data.status === "failed") {
      throw codedProviderError(
        YTD_PROVIDERS.ERROR_CODES.UNKNOWN_PROVIDER_ERROR,
      );
    }
    if (data.status !== "queued" && data.status !== "active") {
      throw codedProviderError(YTD_PROVIDERS.ERROR_CODES.MALFORMED_RESPONSE);
    }
  }
}

// ============================================================
// JSON HELPER
// ============================================================

/**
 * Parses JSON returned by an LLM, tolerating the small mistakes they sometimes
 * make. Some models occasionally emit a trailing
 * comma before a ] or }, or wraps the JSON in prose / code fences. Plain
 * JSON.parse throws on those, which is what caused the "Unexpected token ']'"
 * error on the Overview tab. This function strips fences, isolates the outer
 * JSON object, removes trailing commas, and only then parses.
 *
 * @param {string} text - The raw text from the model
 * @returns {Object} - The parsed object (throws if still unparseable)
 */
function parseLooseJson(text) {
  let cleaned = (text || "").trim();

  // Strip ```json ... ``` style code fences
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }

  // Isolate the outermost { ... } in case the model added a sentence around it
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch (firstError) {
    // Most common LLM slip: a trailing comma right before a } or ].
    // e.g. ["a", "b", ]  ->  ["a", "b" ]
    const repaired = cleaned.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(repaired);
  }
}

// ============================================================
// DEEPSEEK ANALYSIS
// ============================================================

function overviewInputFailure(code, message) {
  return codedProviderError(code, message || code);
}

const OVERVIEW_LOCAL_FAILURE_BEHAVIOR = Object.freeze({
  AUTO_OVERVIEW_DISABLED: Object.freeze({
    retryable: false,
    primaryAction: "none",
  }),
  TRANSCRIPT_FINGERPRINT_UNAVAILABLE: Object.freeze({
    retryable: false,
    primaryAction: "none",
  }),
  TRANSCRIPT_FINGERPRINT_MISMATCH: Object.freeze({
    retryable: false,
    primaryAction: "none",
  }),
  OVERVIEW_PROMPT_UNAVAILABLE: Object.freeze({
    retryable: false,
    primaryAction: "none",
  }),
  STORAGE_READ_FAILED: Object.freeze({
    retryable: true,
    primaryAction: "retry",
  }),
});

function overviewFailureEnvelope(
  code,
  {
    stage = "overview",
    retryable,
    primaryAction,
    mayHaveConsumedCredit = false,
  } = {},
) {
  const boundedCode =
    typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)
      ? code
      : YTD_PROVIDERS.ERROR_CODES.UNKNOWN_PROVIDER_ERROR;
  const localBehavior = OVERVIEW_LOCAL_FAILURE_BEHAVIOR[boundedCode];
  if (localBehavior) {
    return {
      success: false,
      code: boundedCode,
      provider: "deepseek",
      stage,
      retryable:
        typeof retryable === "boolean" ? retryable : localBehavior.retryable,
      primaryAction:
        typeof primaryAction === "string"
          ? primaryAction.slice(0, 64)
          : localBehavior.primaryAction,
      mayHaveConsumedCredit: mayHaveConsumedCredit === true,
    };
  }
  const mapped = YTD_PROVIDERS.mapThrownFailure({
    provider: "deepseek",
    stage,
    error: codedProviderError(boundedCode),
    dispatched: mayHaveConsumedCredit === true,
  });
  if (
    mapped.code === YTD_PROVIDERS.ERROR_CODES.UNKNOWN_PROVIDER_ERROR &&
    boundedCode !== YTD_PROVIDERS.ERROR_CODES.UNKNOWN_PROVIDER_ERROR
  ) {
    return {
      success: false,
      code: boundedCode,
      provider: "deepseek",
      stage,
      retryable: typeof retryable === "boolean" ? retryable : true,
      primaryAction:
        typeof primaryAction === "string"
          ? primaryAction.slice(0, 64)
          : "retry",
      mayHaveConsumedCredit: mayHaveConsumedCredit === true,
    };
  }
  return {
    success: false,
    ...mapped,
    ...(typeof retryable === "boolean" ? { retryable } : {}),
    ...(typeof primaryAction === "string"
      ? { primaryAction: primaryAction.slice(0, 64) }
      : {}),
  };
}

function overviewFailureFromError(error, dispatched = false) {
  if (!dispatched && OVERVIEW_LOCAL_FAILURE_BEHAVIOR[error?.code]) {
    return overviewFailureEnvelope(error.code);
  }
  return providerFailureResult("deepseek", "overview", error, dispatched);
}

function normalizeBasicOverviewIntent(value) {
  if (value !== "automatic" && value !== "manual_retry") {
    throw overviewInputFailure(
      YTD_PROVIDERS.ERROR_CODES.MALFORMED_RESPONSE,
      "Basic overview intent is invalid.",
    );
  }
  return value;
}

function validateBasicOverviewRequest(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw overviewInputFailure(
      YTD_PROVIDERS.ERROR_CODES.MALFORMED_RESPONSE,
      "Basic overview payload is invalid.",
    );
  }
  const transcriptFingerprint =
    typeof payload.transcriptFingerprint === "string"
      ? payload.transcriptFingerprint.trim()
      : "";
  if (!/^sha256-v1-[a-f0-9]{64}$/.test(transcriptFingerprint)) {
    throw overviewInputFailure(
      YTD_PROVIDERS.ERROR_CODES.MALFORMED_RESPONSE,
      "Basic overview requires a valid transcript fingerprint.",
    );
  }
  if (!Array.isArray(payload.segments) || payload.segments.length === 0) {
    throw overviewInputFailure(
      YTD_PROVIDERS.ERROR_CODES.EMPTY_RESPONSE,
      "Basic overview requires transcript segments.",
    );
  }

  const segmentIds = new Set();
  const segments = payload.segments.map((segment) => {
    const id = typeof segment?.id === "string" ? segment.id.trim() : "";
    const start = Number(segment?.start);
    const text = typeof segment?.text === "string" ? segment.text : "";
    if (
      !/^segment-\d+-\d+$/.test(id) ||
      segmentIds.has(id) ||
      !Number.isFinite(start) ||
      start < 0 ||
      !text.trim()
    ) {
      throw overviewInputFailure(
        YTD_PROVIDERS.ERROR_CODES.MALFORMED_RESPONSE,
        "Basic overview transcript segments are invalid.",
      );
    }
    segmentIds.add(id);
    return { id, start, text };
  });

  let transcriptInput;
  try {
    transcriptInput = YTD_TRANSCRIPT_CORE.buildOverviewTranscriptInput(segments);
  } catch (error) {
    if (error?.code === "OVERVIEW_TRANSCRIPT_TOO_LARGE") {
      throw overviewInputFailure(
        YTD_PROVIDERS.ERROR_CODES.INPUT_TOO_LARGE,
        "Basic overview transcript exceeds the local input limit.",
      );
    }
    throw error;
  }
  if (!transcriptInput) {
    throw overviewInputFailure(
      YTD_PROVIDERS.ERROR_CODES.EMPTY_RESPONSE,
      "Basic overview transcript is empty.",
    );
  }

  const boundedMetadata = (value, limit) =>
    typeof value === "string" ? value.trim().slice(0, limit) : "";
  const sourceLanguage = YTD_TRANSCRIPT_CORE.resolveTranscriptLanguage(
    payload.transcriptLanguage,
    [],
  );
  return {
    transcriptFingerprint,
    sourceLanguage,
    segments,
    videoMetadataJson: JSON.stringify({
      title: boundedMetadata(payload.videoTitle, 500),
      channel: boundedMetadata(payload.channelName, 300),
    }),
    transcriptJson: JSON.stringify({
      format: "[segment-id] [M:SS] normalized source text",
      content: transcriptInput,
    }),
  };
}

async function prepareBasicOverviewDispatch(payload, intentValue) {
  const intent = normalizeBasicOverviewIntent(intentValue);
  const request = validateBasicOverviewRequest(payload);
  let recomputedFingerprint;
  try {
    recomputedFingerprint = await YTD_TRANSCRIPT_CORE.fingerprintSegments(
      request.segments,
      { sourceLanguage: request.sourceLanguage },
    );
  } catch {
    throw overviewInputFailure(
      "TRANSCRIPT_FINGERPRINT_UNAVAILABLE",
      "Secure transcript fingerprinting is unavailable.",
    );
  }
  if (recomputedFingerprint !== request.transcriptFingerprint) {
    throw overviewInputFailure(
      "TRANSCRIPT_FINGERPRINT_MISMATCH",
      "Basic overview transcript fingerprint does not match its source.",
    );
  }

  let settings;
  try {
    settings = await getSettings();
  } catch {
    throw overviewInputFailure(
      "STORAGE_READ_FAILED",
      "Overview settings are unavailable.",
    );
  }
  if (intent === "automatic" && settings.autoBasicOverview !== true) {
    throw overviewInputFailure(
      "AUTO_OVERVIEW_DISABLED",
      "Automatic overview generation is disabled.",
    );
  }
  if (!settings.aiApiKey) {
    throw codedProviderError(YTD_PROVIDERS.ERROR_CODES.MISSING_KEY);
  }
  if (globalThis.navigator?.onLine === false) {
    throw codedProviderError(YTD_PROVIDERS.ERROR_CODES.NETWORK_ERROR);
  }

  const promptVariables = {
    videoMetadataJson: request.videoMetadataJson,
    transcriptJson: request.transcriptJson,
  };
  let systemPrompt;
  let userPrompt;
  try {
    systemPrompt = await loadPromptSection(
      "overview.md",
      "System prompt",
      promptVariables,
    );
    userPrompt = await loadPromptSection(
      "overview.md",
      "User prompt",
      promptVariables,
    );
  } catch {
    throw overviewInputFailure(
      "OVERVIEW_PROMPT_UNAVAILABLE",
      "The packaged overview prompt is unavailable.",
    );
  }
  const aiRequest = prepareAiCompletion({
    settings,
    maxTokens: 3072,
    responseFormat: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });
  return Object.freeze({
    intent,
    request,
    settings,
    aiRequest,
  });
}

async function dispatchPreparedBasicOverview(prepared, onDispatch) {
  const requestState = { dispatched: false };
  try {
    const { text: responseText } = await dispatchPreparedAiCompletion(
      prepared.aiRequest,
      {
      onDispatch: () => {
        requestState.dispatched = true;
          onDispatch?.();
      },
      },
    );

    let rawOverview;
    try {
      rawOverview = parseLooseJson(responseText);
    } catch {
      throw codedProviderError(
        YTD_PROVIDERS.ERROR_CODES.MALFORMED_RESPONSE,
        "DeepSeek returned malformed basic-overview JSON.",
      );
    }
    const overview = YTD_OVERVIEW.normalizeBasicOverview(
      rawOverview,
      prepared.request.segments,
      {
        transcriptFingerprint: prepared.request.transcriptFingerprint,
        generatedAt: Date.now(),
      },
    );
    if (!overview.oneSentenceZh) {
      throw codedProviderError(
        YTD_PROVIDERS.ERROR_CODES.MALFORMED_RESPONSE,
        "DeepSeek returned no usable basic-overview takeaway.",
      );
    }
    return { success: true, overview };
  } catch (error) {
    const typedError =
      error?.name === "SyntaxError" &&
      !error?.code &&
      !Number.isInteger(Number(error?.status))
        ? codedProviderError(
            YTD_PROVIDERS.ERROR_CODES.MALFORMED_RESPONSE,
            "DeepSeek returned malformed basic-overview transport JSON.",
          )
        : error;
    return overviewFailureFromError(typedError, requestState.dispatched);
  }
}

async function handleGenerateBasicOverview(payload, beforeDispatch) {
  try {
    const prepared = await prepareBasicOverviewDispatch(payload, "manual_retry");
    await assertProviderDispatchAllowed(beforeDispatch);
    return dispatchPreparedBasicOverview(prepared);
  } catch (error) {
    return overviewFailureFromError(error, false);
  }
}

function secureOverviewRandomHex(byteLength) {
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength < 16 ||
    typeof globalThis.crypto?.getRandomValues !== "function"
  ) {
    throw overviewInputFailure(
      "TRANSCRIPT_FINGERPRINT_UNAVAILABLE",
      "Secure overview request entropy is unavailable.",
    );
  }
  const bytes = new Uint8Array(byteLength);
  try {
    globalThis.crypto.getRandomValues(bytes);
  } catch {
    throw overviewInputFailure(
      "TRANSCRIPT_FINGERPRINT_UNAVAILABLE",
      "Secure overview request entropy is unavailable.",
    );
  }
  return Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function cloneTrustedBasicOverview(value) {
  return {
    schemaVersion: value.schemaVersion,
    transcriptFingerprint: value.transcriptFingerprint,
    generatedAt: value.generatedAt,
    oneSentenceZh: value.oneSentenceZh,
    conclusions: value.conclusions.map((item) => ({
      id: item.id,
      titleZh: item.titleZh,
      explanationZh: item.explanationZh,
      evidenceLevel: item.evidenceLevel,
      evidenceSegmentIds: [...item.evidenceSegmentIds],
    })),
    chapters: value.chapters.map((item) => ({
      titleZh: item.titleZh,
      summaryZh: item.summaryZh,
      startSegmentId: item.startSegmentId,
      timestampSeconds: item.timestampSeconds,
    })),
    complete: value.complete === true,
  };
}

function clearOverviewCacheRecoveries() {
  overviewCacheRecoveryByToken.clear();
  overviewCacheRecoveryRequestByKey.clear();
  overviewCacheRecoveryLastObservedAt = 0;
}

function observeOverviewCacheRecoveryClock() {
  let now;
  try {
    now = Date.now();
  } catch {
    clearOverviewCacheRecoveries();
    return null;
  }
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now < overviewCacheRecoveryLastObservedAt
  ) {
    clearOverviewCacheRecoveries();
    return null;
  }
  overviewCacheRecoveryLastObservedAt = now;
  return now;
}

function pruneOverviewCacheRecoveries(now) {
  for (const [token, entry] of overviewCacheRecoveryByToken) {
    if (
      !entry ||
      !Number.isSafeInteger(entry.createdAt) ||
      !Number.isSafeInteger(entry.expiresAt) ||
      entry.createdAt > now ||
      entry.expiresAt <= now
    ) {
      overviewCacheRecoveryByToken.delete(token);
    }
  }
}

function rememberOverviewCacheRecovery(
  recoveryToken,
  authority,
  identity,
  trustedOverview,
) {
  if (!authority || panelResetFailure(authority.resetRevision)) return false;
  const authorityToken = authority.token;
  const now = observeOverviewCacheRecoveryClock();
  if (now === null) return false;
  pruneOverviewCacheRecoveries(now);
  while (overviewCacheRecoveryByToken.size >= OVERVIEW_CACHE_RECOVERY_MAX_ENTRIES) {
    const oldest = overviewCacheRecoveryByToken.keys().next().value;
    if (oldest === undefined) break;
    overviewCacheRecoveryByToken.delete(oldest);
  }
  const expiresAt = now + OVERVIEW_CACHE_RECOVERY_TTL_MS;
  if (!Number.isSafeInteger(expiresAt)) return false;
  overviewCacheRecoveryByToken.set(recoveryToken, {
    createdAt: now,
    expiresAt,
    expectedEpoch: authorityToken.resetEpoch,
    sessionToken: authorityToken,
    videoId: authorityToken.videoId,
    transcriptFingerprint: identity.transcriptFingerprint,
    attemptId: identity.attemptId,
    attemptRevision: identity.attemptRevision,
    trustedOverview: cloneTrustedBasicOverview(trustedOverview),
    settlePromise: null,
  });
  return true;
}

function retryableOverviewCacheSettlementFailure(result) {
  return Boolean(
    result &&
      typeof result === "object" &&
      (result.code === "OVERVIEW_CACHE_WRITE_FAILED" ||
        result.retryable === true),
  );
}

function overviewCacheRecoveryFailure(
  settlement,
  recoveryToken,
  authority,
  settlementIdentity,
  trustedOverview,
) {
  const recoveryStored = rememberOverviewCacheRecovery(
    recoveryToken,
    authority,
    settlementIdentity,
    trustedOverview,
  );
  if (!recoveryStored) {
    return {
      ...overviewRecoveryUnavailable(),
      providerSucceeded: true,
      mayHaveConsumedCredit: true,
      overview: cloneTrustedBasicOverview(trustedOverview),
    };
  }
  return {
    success: false,
    code: "OVERVIEW_CACHE_WRITE_FAILED",
    storageCode:
      typeof settlement?.storageCode === "string"
        ? settlement.storageCode.slice(0, 64)
        : typeof settlement?.code === "string"
          ? settlement.code.slice(0, 64)
          : "STORAGE_WRITE_FAILED",
    provider: "deepseek",
    stage: "overview_cache",
    providerSucceeded: true,
    mayHaveConsumedCredit: true,
    primaryAction: "retry_cache_write",
    retryable: true,
    overview: cloneTrustedBasicOverview(trustedOverview),
    recoveryToken,
  };
}

function overviewRecoveryUnavailable() {
  return {
    success: false,
    code: "OVERVIEW_CACHE_RECOVERY_UNAVAILABLE",
    provider: "deepseek",
    stage: "overview_cache",
    retryable: false,
    primaryAction: "none",
    mayHaveConsumedCredit: false,
  };
}

function overviewNonClaimedResult(claim) {
  if (claim.disposition === "cached") {
    return {
      success: true,
      disposition: "cached",
      overview: cloneTrustedBasicOverview(claim.overview),
    };
  }
  if (!["inflight", "failed", "interrupted", "result_missing"].includes(
    claim.disposition,
  )) {
    return overviewFailureEnvelope("OVERVIEW_CLAIM_INVALID", {
      retryable: false,
      primaryAction: "none",
    });
  }
  const result = {
    success: true,
    skipped: "already_attempted",
    disposition: claim.disposition,
  };
  if (Number.isSafeInteger(claim.retryAfterMs) && claim.retryAfterMs >= 0) {
    result.retryAfterMs = Math.min(claim.retryAfterMs, 180_000);
  }
  if (claim.failure && typeof claim.failure === "object") {
    result.failure = {
      code: claim.failure.code,
      provider: "deepseek",
      stage: "overview",
      retryable: claim.failure.retryable === true,
      primaryAction:
        typeof claim.failure.primaryAction === "string"
          ? claim.failure.primaryAction.slice(0, 64)
          : "none",
      mayHaveConsumedCredit: claim.failure.mayHaveConsumedCredit === true,
    };
  }
  return result;
}

function overviewConfigSnapshotFailure(prepared, latestSettings) {
  if (
    prepared.intent === "automatic" &&
    latestSettings.autoBasicOverview !== true
  ) return "AUTO_OVERVIEW_DISABLED";
  if (!latestSettings.aiApiKey) return YTD_PROVIDERS.ERROR_CODES.MISSING_KEY;
  if (globalThis.navigator?.onLine === false) {
    return YTD_PROVIDERS.ERROR_CODES.NETWORK_ERROR;
  }
  if (
    latestSettings.aiApiKey !== prepared.settings.aiApiKey ||
    latestSettings.aiModel !== prepared.settings.aiModel
  ) return YTD_PROVIDERS.ERROR_CODES.SESSION_STALE;
  return "";
}

function overviewClaimFailureResult(claim, validationFailure) {
  const mappedValidationCode =
    claim?.code === YTD_PROVIDERS.ERROR_CODES.SESSION_STALE &&
    typeof validationFailure === "string" &&
    validationFailure
      ? validationFailure
      : "";
  if (
    [
      "AUTO_OVERVIEW_DISABLED",
      YTD_PROVIDERS.ERROR_CODES.MISSING_KEY,
      YTD_PROVIDERS.ERROR_CODES.NETWORK_ERROR,
      "STORAGE_READ_FAILED",
    ].includes(mappedValidationCode)
  ) {
    return overviewFailureEnvelope(mappedValidationCode);
  }
  const retryable = claim?.retryable === true;
  return overviewFailureEnvelope(mappedValidationCode || claim?.code, {
    retryable,
    primaryAction: retryable ? "retry" : "none",
  });
}

async function handleRequestBasicOverview(payload, intentValue, authority) {
  let prepared;
  try {
    prepared = await prepareBasicOverviewDispatch(payload, intentValue);
  } catch (error) {
    return overviewFailureFromError(error, false);
  }

  let attemptId;
  let recoveryToken;
  try {
    attemptId = `overview_${secureOverviewRandomHex(32)}`;
    recoveryToken = secureOverviewRandomHex(16);
  } catch (error) {
    return overviewFailureFromError(error, false);
  }

  let claimValidationFailure = "";
  const validateClaim = async () => {
    const authorityResult = await authority.validateMutation();
    if (authorityResult !== true) {
      claimValidationFailure =
        typeof authorityResult === "string"
          ? authorityResult.slice(0, 64)
          : YTD_PROVIDERS.ERROR_CODES.SESSION_STALE;
      return false;
    }
    let latestSettings;
    try {
      latestSettings = await getSettings();
    } catch {
      claimValidationFailure = "STORAGE_READ_FAILED";
      return false;
    }
    claimValidationFailure = overviewConfigSnapshotFailure(
      prepared,
      latestSettings,
    );
    return claimValidationFailure === "";
  };

  let claim;
  try {
    // This is deliberately the final awaited I/O before the zero-await dispatch
    // boundary. The coordinator invokes validateClaim twice before writing.
    claim = await storageMutations.claimBasicOverview(
      authority.token.resetEpoch,
      {
        videoId: authority.token.videoId,
        transcriptFingerprint: prepared.request.transcriptFingerprint,
        attemptId,
        intent: prepared.intent,
      },
      validateClaim,
    );
  } catch {
    return overviewFailureEnvelope("OVERVIEW_CLAIM_FAILED", {
      retryable: true,
      primaryAction: "retry",
    });
  }

  if (claim?.success !== true) {
    return overviewClaimFailureResult(claim, claimValidationFailure);
  }
  if (claim.disposition !== "claimed") {
    return overviewNonClaimedResult(claim);
  }
  if (
    claim.attemptId !== attemptId ||
    !Number.isSafeInteger(claim.attemptRevision) ||
    claim.attemptRevision < 1
  ) {
    return overviewFailureEnvelope("OVERVIEW_CLAIM_INVALID", {
      retryable: false,
      primaryAction: "none",
    });
  }
  const dispatchAuthority = authority.validateDispatchNow();
  if (dispatchAuthority !== true) {
    return overviewFailureEnvelope(dispatchAuthority);
  }

  let providerDispatched = false;
  // Calling the async dispatcher synchronously reaches onDispatch + fetch before
  // it returns this promise. No settings, prompt, storage, tab, or async guard is
  // consulted between the claim and provider dispatch.
  const providerPromise = dispatchPreparedBasicOverview(prepared, () => {
    providerDispatched = true;
  });
  const providerResult = await providerPromise;
  const settlementIdentity = {
    videoId: authority.token.videoId,
    transcriptFingerprint: prepared.request.transcriptFingerprint,
    attemptId,
    attemptRevision: claim.attemptRevision,
  };

  if (providerResult.success !== true) {
    if (providerDispatched && providerResult.mayHaveConsumedCredit === true) {
      try {
        await storageMutations.settleBasicOverview(authority.token.resetEpoch, {
          ...settlementIdentity,
          outcome: { type: "failure", failure: providerResult },
        });
      } catch {
        // The exact provider failure remains the only public failure. A failed
        // settlement must never cause a second provider purchase.
      }
    }
    return providerResult;
  }

  let settlement;
  try {
    settlement = await storageMutations.settleBasicOverview(
      authority.token.resetEpoch,
      {
        ...settlementIdentity,
        outcome: { type: "success", overview: providerResult.overview },
      },
    );
  } catch {
    settlement = { success: false, code: "STORAGE_WRITE_FAILED", retryable: true };
  }
  if (settlement?.success === true) {
    return {
      success: true,
      disposition: settlement.disposition,
      overview: cloneTrustedBasicOverview(settlement.overview),
    };
  }
  if (retryableOverviewCacheSettlementFailure(settlement)) {
    return overviewCacheRecoveryFailure(
      settlement,
      recoveryToken,
      authority,
      settlementIdentity,
      providerResult.overview,
    );
  }
  return {
    ...overviewFailureEnvelope(settlement?.code, {
      stage: "overview_cache",
      retryable: settlement?.retryable === true,
      primaryAction: settlement?.retryable === true ? "retry_cache_write" : "none",
      mayHaveConsumedCredit: true,
    }),
    providerSucceeded: true,
    overview: cloneTrustedBasicOverview(providerResult.overview),
  };
}

function matchingRecoveryEntry(recoveryToken, authority) {
  const now = observeOverviewCacheRecoveryClock();
  if (now === null) return null;
  pruneOverviewCacheRecoveries(now);
  if (
    typeof recoveryToken !== "string" ||
    !/^[a-f0-9]{32}$/.test(recoveryToken)
  ) return null;
  const entry = overviewCacheRecoveryByToken.get(recoveryToken);
  if (
    !entry ||
    entry.expectedEpoch !== authority.token.resetEpoch ||
    entry.videoId !== authority.token.videoId ||
    !sameSessionIdentity(entry.sessionToken, authority.token)
  ) return null;
  return entry;
}

async function handleRetryBasicOverviewCacheWrite(recoveryToken, authority) {
  const entry = matchingRecoveryEntry(recoveryToken, authority);
  if (!entry) return overviewRecoveryUnavailable();
  if (entry.settlePromise) return entry.settlePromise;

  const settlePromise = (async () => {
    let result;
    try {
      result = await storageMutations.settleBasicOverview(entry.expectedEpoch, {
        videoId: entry.videoId,
        transcriptFingerprint: entry.transcriptFingerprint,
        attemptId: entry.attemptId,
        attemptRevision: entry.attemptRevision,
        outcome: {
          type: "success",
          overview: cloneTrustedBasicOverview(entry.trustedOverview),
        },
      });
    } catch {
      result = { success: false, code: "STORAGE_WRITE_FAILED", retryable: true };
    }
    if (result?.success === true) {
      overviewCacheRecoveryByToken.delete(recoveryToken);
      return {
        success: true,
        disposition: result.disposition,
        overview: cloneTrustedBasicOverview(entry.trustedOverview),
      };
    }
    if (
      overviewCacheRecoveryByToken.get(recoveryToken) !== entry ||
      panelResetFailure(authority.resetRevision)
    ) {
      return overviewRecoveryUnavailable();
    }
    const retryableStorageFailure =
      result?.code === "OVERVIEW_CACHE_WRITE_FAILED" ||
      result?.code === "STORAGE_WRITE_FAILED" ||
      result?.code === "STORAGE_QUOTA_EXCEEDED" ||
      result?.retryable === true;
    if (!retryableStorageFailure) {
      overviewCacheRecoveryByToken.delete(recoveryToken);
      return overviewRecoveryUnavailable();
    }
    return {
      success: false,
      code: "OVERVIEW_CACHE_WRITE_FAILED",
      storageCode:
        typeof result?.storageCode === "string"
          ? result.storageCode.slice(0, 64)
          : typeof result?.code === "string"
            ? result.code.slice(0, 64)
            : "STORAGE_WRITE_FAILED",
      provider: "deepseek",
      stage: "overview_cache",
      providerSucceeded: true,
      mayHaveConsumedCredit: false,
      primaryAction: "retry_cache_write",
      retryable: true,
      overview: cloneTrustedBasicOverview(entry.trustedOverview),
      recoveryToken,
    };
  })();
  entry.settlePromise = settlePromise;
  try {
    return await settlePromise;
  } finally {
    if (
      overviewCacheRecoveryByToken.get(recoveryToken) === entry &&
      entry.settlePromise === settlePromise
    ) {
      entry.settlePromise = null;
    }
  }
}

function runRetryBasicOverviewCacheWrite(
  recoveryToken,
  sessionTokenValue,
  videoId,
) {
  const sessionToken = normalizedSessionToken(sessionTokenValue);
  const boundedRecoveryToken =
    typeof recoveryToken === "string" && /^[a-f0-9]{32}$/.test(recoveryToken)
      ? recoveryToken
      : "";
  const requestKey =
    boundedRecoveryToken && sessionToken && sessionToken.videoId === videoId
      ? [
          boundedRecoveryToken,
          sessionToken.sessionId,
          sessionToken.generation,
          sessionToken.videoId,
          sessionToken.tabId,
          sessionToken.windowId,
          sessionToken.resetEpoch,
        ].join(":")
      : "";
  if (requestKey && overviewCacheRecoveryRequestByKey.has(requestKey)) {
    return overviewCacheRecoveryRequestByKey.get(requestKey);
  }
  const promise = createPanelVideoRequestAuthority(sessionTokenValue, videoId)
    .then((authority) =>
      authority.success
        ? handleRetryBasicOverviewCacheWrite(recoveryToken, authority)
        : authority,
    );
  if (
    requestKey &&
    overviewCacheRecoveryRequestByKey.size < OVERVIEW_CACHE_RECOVERY_MAX_ENTRIES
  ) {
    overviewCacheRecoveryRequestByKey.set(requestKey, promise);
    void promise.finally(() => {
      if (overviewCacheRecoveryRequestByKey.get(requestKey) === promise) {
        overviewCacheRecoveryRequestByKey.delete(requestKey);
      }
    }).catch(() => {});
  }
  return promise;
}

/**
 * Sends the transcript to DeepSeek for analysis.
 *
 * The prompt asks the model to produce chapters covering the whole video
 * and 3-5 key quotes with timestamps.
 *
 * @param {string} transcriptText - The full transcript as plain text
 * @param {string} videoTitle - The video title
 * @param {string} channelName - The channel name
 * @returns {Object} - { success, analysis } or { success: false, error }
 */
async function handleAnalyzeTranscript(
  transcriptText,
  videoTitle,
  channelName,
  videoDescription,
  videoDuration,
  beforeDispatch,
) {
  const requestState = { dispatched: false };
  try {
    const settings = await getSettings();
    if (!settings.aiApiKey) {
      throw codedProviderError(YTD_PROVIDERS.ERROR_CODES.MISSING_KEY);
    }

    // Convert duration to MM:SS format for context
    // The transcript text is already prefixed with [M:SS] markers. Its LAST
    // marker is the most reliable signal of where the content actually ends —
    // more trustworthy than the duration metadata, which is sometimes missing
    // or wrong. We use the larger of (metadata duration, last transcript stamp).
    let lastTranscriptSeconds = 0;
    const stampMatches = transcriptText.match(/\[(\d+):(\d{2})\]/g) || [];
    if (stampMatches.length) {
      const last =
        stampMatches[stampMatches.length - 1].match(/\[(\d+):(\d{2})\]/);
      lastTranscriptSeconds = parseInt(last[1]) * 60 + parseInt(last[2]);
    }

    const effectiveSeconds = Math.max(
      Math.floor(videoDuration || 0),
      lastTranscriptSeconds,
    );
    const durationMinutes = Math.floor(effectiveSeconds / 60);
    const durationSeconds = Math.floor(effectiveSeconds % 60);
    const durationFormatted = `${durationMinutes}:${String(durationSeconds).padStart(2, "0")}`;
    const maxTimestampSeconds = effectiveSeconds;

    // The "last chapter must be after" threshold (75% in) forces the model to
    // cover the WHOLE video instead of front-loading chapters near the start.
    // We do NOT prescribe a chapter count — the model picks the natural splits.
    const lateThresholdSeconds = Math.floor(effectiveSeconds * 0.75);
    const lateThreshold = `${Math.floor(lateThresholdSeconds / 60)}:${String(
      lateThresholdSeconds % 60,
    ).padStart(2, "0")}`;

    const promptVariables = {
      durationFormatted,
      lateThreshold,
      maxTimestampSeconds,
      videoTitle: videoTitle || "Unknown",
      channelName: channelName || "Unknown",
      videoDescription: videoDescription || "No description available",
      transcriptText,
    };
    const systemPrompt = await loadPromptSection(
      "analysis.md",
      "System prompt",
      promptVariables,
    );
    const userPrompt = await loadPromptSection(
      "analysis.md",
      "User prompt",
      promptVariables,
    );

    debugLog("[YouTube Digest Vocabulary] Requesting video analysis", settings.aiModel);
    const { text: responseText } = await requestAiCompletion({
      maxTokens: 8192,
      responseFormat: { type: "json_object" },
      beforeDispatch,
      onDispatch: () => {
        requestState.dispatched = true;
      },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    // Parse the JSON, tolerating trailing commas / stray prose
    let analysis = parseLooseJson(responseText);

    // Treat every model response as untrusted data. Rebuild the supported
    // schema and derive display timestamps from validated numeric seconds.
    analysis = validateAndFixTimestamps(analysis, maxTimestampSeconds);
    if (!analysis.reportComplete) {
      throw codedProviderError(
        YTD_PROVIDERS.ERROR_CODES.MALFORMED_RESPONSE,
        "DeepSeek returned an incomplete analysis report.",
      );
    }

    return {
      success: true,
      analysis: analysis,
    };
  } catch (error) {
    const typedError =
      error?.name === "SyntaxError" &&
      !error?.code &&
      !Number.isInteger(Number(error?.status))
        ? codedProviderError(
            YTD_PROVIDERS.ERROR_CODES.MALFORMED_RESPONSE,
            "DeepSeek returned malformed analysis JSON.",
          )
        : error;
    return providerFailureResult(
      "deepseek",
      "analysis",
      typedError,
      requestState.dispatched,
    );
  }
}

/**
 * Validates all timestamps in the analysis and fixes any that exceed video duration.
 * This is a safety net to prevent hallucinated timestamps from reaching the UI.
 *
 * @param {Object} analysis - The parsed analysis from DeepSeek
 * @param {number} maxSeconds - Maximum valid timestamp in seconds
 * @returns {Object} - Analysis with validated timestamps
 */
function isCompleteNormalizedAnalysis(analysis) {
  const summary = analysis?.summary || {};
  const critical = analysis?.criticalThinking || {};
  const chapters = Array.isArray(analysis?.chapters) ? analysis.chapters : [];
  const maximum = Number(analysis?.maxTimestampSeconds);
  if (!Number.isFinite(maximum) || maximum < 0 || !chapters.length) return false;

  const firstChapter = chapters[0];
  const lastChapter = chapters[chapters.length - 1];
  const startCoverageLimit = Math.min(30, Math.floor(maximum * 0.1));
  const lateCoverageThreshold = Math.floor(maximum * 0.75);
  const chaptersAreComplete =
    chapters.every((chapter) => chapter.title && chapter.summary) &&
    firstChapter.timestampSeconds <= startCoverageLimit &&
    lastChapter.timestampSeconds >= lateCoverageThreshold;

  return Boolean(
    Number(analysis?.schemaVersion) >= 2 &&
      summary.oneSentenceZh &&
      summary.executiveSummaryZh &&
      summary.coreThesisZh &&
      summary.whyItMattersZh &&
      chaptersAreComplete &&
      analysis.keyInsights?.length >= 5 &&
      analysis.argumentMap?.length >= 1 &&
      critical.strengthsZh?.length >= 1 &&
      critical.limitationsZh?.length >= 1 &&
      critical.assumptionsZh?.length >= 1 &&
      critical.openQuestionsZh?.length >= 1 &&
      analysis.actionItemsZh?.length >= 1 &&
      analysis.reviewQuestions?.length >= 1 &&
      analysis.keyQuotes?.length >= 3 &&
      analysis.keyMoments?.length >= 1,
  );
}

function validateAndFixTimestamps(analysis, maxSeconds) {
  const hasKnownMaximum =
    maxSeconds !== null &&
    maxSeconds !== undefined &&
    Number.isFinite(Number(maxSeconds)) &&
    Number(maxSeconds) >= 0;
  const safeMax = hasKnownMaximum
    ? Number(maxSeconds)
    : Number.MAX_SAFE_INTEGER;

  // Helper to format seconds as MM:SS
  const formatTimestamp = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, "0")}`;
  };

  const safeString = (value, maxLength) =>
    typeof value === "string" ? value.trim().slice(0, maxLength) : "";
  const safeStringArray = (value, maxItems = 12, maxLength = 1200) =>
    (Array.isArray(value) ? value : [])
      .map((item) => safeString(item, maxLength))
      .filter(Boolean)
      .slice(0, maxItems);
  const safeSeconds = (value) => {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > safeMax) {
      return null;
    }
    return Math.floor(seconds);
  };

  const chapters = (Array.isArray(analysis?.chapters) ? analysis.chapters : [])
    .slice(0, 100)
    .map((chapter) => {
      const seconds = safeSeconds(chapter?.timestampSeconds);
      const title = safeString(chapter?.title, 300);
      if (seconds === null || !title) return null;
      return {
        title,
        summary: safeString(chapter?.summary, 1500),
        timestampSeconds: seconds,
        timestamp: formatTimestamp(seconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const keyQuotes = (
    Array.isArray(analysis?.keyQuotes) ? analysis.keyQuotes : []
  )
    .slice(0, 50)
    .map((quote) => {
      const seconds = safeSeconds(quote?.timestampSeconds);
      const text = safeString(quote?.quote, 3000);
      if (seconds === null || !text) return null;
      return {
        quote: text,
        timestampSeconds: seconds,
        timestamp: formatTimestamp(seconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const keyMoments = (
    Array.isArray(analysis?.keyMoments) ? analysis.keyMoments : []
  )
    .map(safeSeconds)
    .filter((seconds) => seconds !== null)
    .slice(0, 100);

  const summarySource =
    analysis?.summary && typeof analysis.summary === "object"
      ? analysis.summary
      : {};
  const summary = {
    oneSentenceZh: safeString(summarySource.oneSentenceZh, 300),
    executiveSummaryZh: safeString(summarySource.executiveSummaryZh, 4000),
    coreThesisZh: safeString(summarySource.coreThesisZh, 2000),
    whyItMattersZh: safeString(summarySource.whyItMattersZh, 2000),
  };

  const keyInsights = (
    Array.isArray(analysis?.keyInsights) ? analysis.keyInsights : []
  )
    .slice(0, 12)
    .map((insight) => {
      const timestampSeconds = safeSeconds(insight?.timestampSeconds);
      const titleZh = safeString(insight?.titleZh, 300);
      const explanationZh = safeString(insight?.explanationZh, 2500);
      const evidenceZh = safeString(insight?.evidenceZh, 2000);
      if (
        timestampSeconds === null ||
        !titleZh ||
        !explanationZh ||
        !evidenceZh
      ) {
        return null;
      }
      return {
        titleZh,
        explanationZh,
        evidenceZh,
        timestampSeconds,
        timestamp: formatTimestamp(timestampSeconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const argumentMap = (
    Array.isArray(analysis?.argumentMap) ? analysis.argumentMap : []
  )
    .slice(0, 12)
    .map((item) => {
      const claimZh = safeString(item?.claimZh, 1500);
      const supportZh = safeString(item?.supportZh, 2500);
      if (!claimZh || !supportZh) return null;
      return {
        claimZh,
        supportZh,
        caveatZh: safeString(item?.caveatZh, 1800),
      };
    })
    .filter(Boolean);

  const criticalSource =
    analysis?.criticalThinking &&
    typeof analysis.criticalThinking === "object"
      ? analysis.criticalThinking
      : {};
  const criticalThinking = {
    strengthsZh: safeStringArray(criticalSource.strengthsZh),
    limitationsZh: safeStringArray(criticalSource.limitationsZh),
    assumptionsZh: safeStringArray(criticalSource.assumptionsZh),
    openQuestionsZh: safeStringArray(criticalSource.openQuestionsZh),
  };

  const reviewQuestions = (
    Array.isArray(analysis?.reviewQuestions) ? analysis.reviewQuestions : []
  )
    .slice(0, 12)
    .map((item) => {
      const questionZh = safeString(item?.questionZh, 1000);
      const answerZh = safeString(item?.answerZh, 1800);
      return questionZh && answerZh ? { questionZh, answerZh } : null;
    })
    .filter(Boolean);

  const normalized = {
    schemaVersion: 2,
    maxTimestampSeconds: hasKnownMaximum ? Math.floor(safeMax) : null,
    summary,
    chapters,
    keyInsights,
    argumentMap,
    criticalThinking,
    actionItemsZh: safeStringArray(analysis?.actionItemsZh),
    reviewQuestions,
    keyQuotes,
    keyMoments,
  };
  normalized.reportComplete = isCompleteNormalizedAnalysis(normalized);
  return normalized;
}

// ============================================================
// VIDEO INFO EXTRACTION
// ============================================================

/**
 * Gets video info (title, channel, description) from the active YouTube tab.
 * We do this by asking the content script to read the page.
 */
async function handleGetVideoInfo(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      action: "getVideoInfo",
    });
    return response;
  } catch (error) {
    return { title: "", channelName: "", description: "" };
  }
}

// ============================================================
// EXPLAIN SELECTION
// ============================================================

/**
 * Explains selected text using DeepSeek.
 * Provides context, definitions, and clarification for complex terms.
 *
 * @param {string} selectedText - The text the user selected
 * @param {string} transcriptContext - Surrounding transcript for context
 * @param {string} videoTitle - Video title for additional context
 * @returns {Object} - { success, explanation } or { success: false, error }
 */
// ============================================================
// NOTE MANAGEMENT
// ============================================================

let fallbackNoteIdCounter = 0;

function createNoteId() {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (typeof uuid === "string" && uuid) {
      return `note_${uuid.slice(0, 64)}`;
    }
  } catch {
    // Continue with the bounded local fallback.
  }

  fallbackNoteIdCounter = (fallbackNoteIdCounter + 1) % 1_679_616;
  const timestamp = Math.max(0, Math.floor(Date.now())).toString(36);
  let randomPart = "";
  try {
    const bytes = new Uint8Array(8);
    globalThis.crypto?.getRandomValues?.(bytes);
    randomPart = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  } catch {
    randomPart = "";
  }
  if (!randomPart || /^0+$/.test(randomPart)) {
    randomPart = Math.random().toString(36).slice(2, 18).padEnd(16, "0");
  }
  return `note_${timestamp}_${fallbackNoteIdCounter.toString(36)}_${randomPart}`
    .slice(0, 120);
}

/**
 * Saves a note at the current timestamp.
 * Fetches the transcript if needed, finds the relevant line, and cleans it up.
 */
async function validateContentNoteAuthority(authority, expectedEpoch) {
  const resetRevision = authority.resetRevision;
  if (
    activeResetCount > 0 ||
    resetRevision !== resetValidationRevision
  ) {
    return mutationFailure("RESET_DURING_REQUEST");
  }
  if (expectedEpoch !== undefined) {
    let epoch;
    try {
      epoch = await readStoredResetEpoch();
    } catch {
      return mutationFailure("STORAGE_READ_FAILED");
    }
    if (resetRevision !== resetValidationRevision) {
      return mutationFailure("RESET_DURING_REQUEST");
    }
    if (epoch !== expectedEpoch) {
      return mutationFailure("RESET_DURING_REQUEST");
    }
  }
  let tab;
  try {
    tab = await chrome.tabs.get(authority.tabId);
  } catch {
    return mutationFailure("TAB_NOT_FOUND");
  }
  if (resetRevision !== resetValidationRevision) {
    return mutationFailure("RESET_DURING_REQUEST");
  }
  if (tab?.windowId !== authority.windowId) {
    return mutationFailure("TAB_WINDOW_MISMATCH");
  }
  if (
    !tab ||
    tab.id !== authority.tabId ||
    videoIdFromYouTubeTabUrl(effectiveTabUrl(tab)) !== authority.videoId
  ) {
    return mutationFailure("TAB_VIDEO_MISMATCH");
  }
  return { success: true };
}

async function createSaveNoteAuthority(
  videoId,
  sessionTokenValue,
  sender,
  resetRevision,
) {
  if (
    activeResetCount > 0 ||
    resetRevision !== resetValidationRevision
  ) {
    return mutationFailure("RESET_DURING_REQUEST");
  }
  if (sessionTokenValue !== undefined && sessionTokenValue !== null) {
    const token = normalizedSessionToken(sessionTokenValue);
    if (!token) return mutationFailure("INVALID_SESSION_TOKEN");
    if (token.videoId !== videoId) {
      return mutationFailure("SESSION_BINDING_MISMATCH");
    }
    const validation = await validatePanelSessionContext(token, {
      resetRevision,
    });
    if (!validation.success) return mutationFailure(validation.code);
    return { success: true, kind: "panel", token, resetRevision };
  }

  const senderTab = sender?.tab;
  if (
    !validTabId(senderTab?.id) ||
    !Number.isSafeInteger(senderTab?.windowId) ||
    senderTab.windowId < 0
  ) {
    return mutationFailure("INVALID_SESSION_TOKEN");
  }
  const authority = {
    kind: "content",
    tabId: senderTab.id,
    windowId: senderTab.windowId,
    videoId,
    resetRevision,
  };
  const validation = await validateContentNoteAuthority(authority);
  return validation.success
    ? { success: true, ...authority }
    : validation;
}

async function validateSaveNoteAuthority(authority, expectedEpoch) {
  if (authority.kind === "panel") {
    if (authority.token.resetEpoch !== expectedEpoch) {
      return mutationFailure("SESSION_STALE");
    }
    const validation = await validatePanelSessionContext(authority.token, {
      resetRevision: authority.resetRevision,
    });
    return validation.success
      ? { success: true }
      : mutationFailure(validation.code);
  }
  return validateContentNoteAuthority(authority, expectedEpoch);
}

function handleSaveNote(
  videoId,
  timestamp,
  videoTitle,
  channelName,
  sessionTokenValue,
  sender,
) {
  let canonicalVideoUrl;
  try {
    canonicalVideoUrl = YTD_SETTINGS.canonicalYouTubeUrl(videoId);
  } catch {
    return Promise.resolve(legacyMutationFailure("INVALID_VIDEO_ID"));
  }

  // Capture reset identity at message arrival. Tab/session authorization can
  // await I/O, but a reset that starts afterward must still invalidate this
  // request rather than letting it adopt the new epoch.
  const resetRevision = resetValidationRevision;
  const epochCapture = storageMutations.captureEpoch().then(
    (expectedEpoch) => ({ success: true, expectedEpoch }),
    () => mutationFailure("STORAGE_READ_FAILED"),
  );
  const preparation = (async () => {
    const authority = await createSaveNoteAuthority(
      videoId,
      sessionTokenValue,
      sender,
      resetRevision,
    );
    if (authority.success !== true) return authority;
    const captured = await epochCapture;
    if (captured.success !== true) return captured;
    const validation = await validateSaveNoteAuthority(
      authority,
      captured.expectedEpoch,
    );
    if (!validation.success) return validation;
    const beforeDispatch = async () => {
      const latest = await validateSaveNoteAuthority(
        authority,
        captured.expectedEpoch,
      );
      return latest.success ? true : latest.code;
    };
    return {
      success: true,
      expectedEpoch: captured.expectedEpoch,
      authority,
      prepared: await prepareNote(
        chrome.storage.local,
        videoId,
        timestamp,
        videoTitle,
        channelName,
        canonicalVideoUrl,
        beforeDispatch,
      ),
    };
  })();

  return runNoteRequestInOrder(async () => {
    const ready = await preparation;
    if (ready.success !== true) {
      return legacyCompatibleMutationResult(ready);
    }
    const currentAuthority = await validateSaveNoteAuthority(
      ready.authority,
      ready.expectedEpoch,
    );
    if (!currentAuthority.success) {
      return legacyCompatibleMutationResult(currentAuthority);
    }
    if (ready.prepared?.success !== true) {
      return legacyCompatibleMutationResult(ready.prepared);
    }

    let committed;
    try {
      committed = await storageMutations.commit(
        ready.expectedEpoch,
        async (storage) => {
          const saved = await saveNoteToStorage(
            storage,
            ready.prepared.note,
            () =>
              validateSaveNoteAuthority(
                ready.authority,
                ready.expectedEpoch,
              ),
          );
          if (saved?.success === false) return saved;
          return ready.prepared;
        },
      );
    } catch {
      return legacyMutationFailure("STORAGE_WRITE_FAILED");
    }
    const response = legacyCompatibleMutationResult(
      unwrapCoordinatorResult(committed),
    );
    if (response.success) {
      broadcastWithoutBlocking({ action: "noteSaved", note: response.note });
    }
    return response;
  });
}

function validNoteDigestBase(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (ownValue(value, "digestSchemaVersion") !== DIGEST_CACHE_SCHEMA_VERSION) {
    return false;
  }
  const timestamp = ownValue(value, "timestamp");
  const transcriptLanguage = ownValue(value, "transcriptLanguage");
  const transcriptFingerprint = ownValue(value, "transcriptFingerprint");
  return Boolean(
    Number.isSafeInteger(timestamp) &&
      timestamp >= 0 &&
      (transcriptLanguage === null ||
        typeof transcriptLanguage === "string") &&
      typeof transcriptFingerprint === "string" &&
      /^sha256-v1-[a-f0-9]{64}$/.test(transcriptFingerprint) &&
      [
        "transcriptText",
        "transcriptTimestamped",
        "videoTitle",
        "channelName",
      ].every((key) => typeof ownValue(value, key) === "string")
  );
}

function strictDigestTranscript(value) {
  if (!Array.isArray(value)) return null;
  let length;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "length");
    length = descriptor?.value;
  } catch {
    return null;
  }
  if (
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > DIGEST_CACHE_MAX_TRANSCRIPT_ENTRIES
  ) return null;

  const transcript = [];
  for (let index = 0; index < length; index += 1) {
    let entry;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
      entry = descriptor.value;
      const prototype = Object.getPrototypeOf(entry);
      if (
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        (prototype !== Object.prototype && prototype !== null)
      ) return null;
    } catch {
      return null;
    }
    const text = ownValue(entry, "text");
    const start = ownValue(entry, "start");
    const duration = ownValue(entry, "duration");
    let languageDescriptor;
    try {
      languageDescriptor = Object.getOwnPropertyDescriptor(entry, "language");
    } catch {
      return null;
    }
    if (
      typeof text !== "string" ||
      typeof start !== "number" ||
      !Number.isFinite(start) ||
      start < 0 ||
      typeof duration !== "number" ||
      !Number.isFinite(duration) ||
      duration < 0 ||
      (languageDescriptor &&
        (!Object.hasOwn(languageDescriptor, "value") ||
          typeof languageDescriptor.value !== "string"))
    ) return null;
    const normalized = { text, start, duration };
    if (languageDescriptor) normalized.language = languageDescriptor.value;
    transcript.push(normalized);
  }
  return transcript;
}

function digestBaseWithinInputBudget(digest, transcript) {
  let serialized;
  try {
    serialized = JSON.stringify({
      transcript,
      transcriptText: ownValue(digest, "transcriptText"),
      transcriptTimestamped: ownValue(digest, "transcriptTimestamped"),
      transcriptLanguage: ownValue(digest, "transcriptLanguage"),
      transcriptFingerprint: ownValue(digest, "transcriptFingerprint"),
      videoTitle: ownValue(digest, "videoTitle"),
      channelName: ownValue(digest, "channelName"),
    });
  } catch {
    return false;
  }
  try {
    return new TextEncoder().encode(serialized).byteLength <=
      DIGEST_CACHE_MAX_INPUT_BYTES;
  } catch {
    return false;
  }
}

async function readValidatedNoteTranscript(
  storage,
  videoId,
  beforeDispatch,
) {
  try {
    YTD_TRANSCRIPT_CORE.assertSecureFingerprintAvailable();
  } catch {
    return mutationFailure("TRANSCRIPT_FINGERPRINT_UNAVAILABLE");
  }
  let digest;
  try {
    const cached = await storage.get(`digest_${videoId}`);
    digest = ownValue(cached, `digest_${videoId}`);
  } catch {
    return { success: true, transcript: null };
  }
  if (!validNoteDigestBase(digest)) {
    return { success: true, transcript: null };
  }

  const timestamp = ownValue(digest, "timestamp");
  const initialNow = Date.now();
  if (
    !Number.isSafeInteger(initialNow) ||
    initialNow < timestamp ||
    initialNow - timestamp >= DIGEST_CACHE_TTL_MS
  ) {
    return { success: true, transcript: null };
  }

  let transcript;
  let sourceLanguage;
  let segments;
  try {
    transcript = strictDigestTranscript(ownValue(digest, "transcript"));
    if (!transcript || !digestBaseWithinInputBudget(digest, transcript)) {
      return { success: true, transcript: null };
    }
    sourceLanguage = YTD_TRANSCRIPT_CORE.resolveTranscriptLanguage(
      ownValue(digest, "transcriptLanguage"),
      transcript,
    );
    if (sourceLanguage !== ownValue(digest, "transcriptLanguage")) {
      return { success: true, transcript: null };
    }
    segments = YTD_TRANSCRIPT_CORE.groupTranscriptEntries(transcript);
    if (!segments.length) return { success: true, transcript: null };
  } catch {
    return { success: true, transcript: null };
  }

  let transcriptFingerprint;
  try {
    transcriptFingerprint = await YTD_TRANSCRIPT_CORE.fingerprintSegments(
      segments,
      { sourceLanguage },
    );
  } catch (error) {
    if (error?.code === "TRANSCRIPT_FINGERPRINT_UNAVAILABLE") {
      return mutationFailure("TRANSCRIPT_FINGERPRINT_UNAVAILABLE");
    }
    return mutationFailure("TRANSCRIPT_FINGERPRINT_FAILED");
  }

  const observedNow = Date.now();
  if (
    !Number.isSafeInteger(observedNow) ||
    observedNow < initialNow
  ) {
    return mutationFailure("TRANSCRIPT_CACHE_CLOCK_INVALID");
  }
  if (
    observedNow < timestamp ||
    observedNow - timestamp >= DIGEST_CACHE_TTL_MS ||
    transcriptFingerprint !== ownValue(digest, "transcriptFingerprint")
  ) {
    return { success: true, transcript: null };
  }

  if (beforeDispatch) {
    let authority;
    try {
      authority = await beforeDispatch();
    } catch {
      return mutationFailure("SESSION_STALE");
    }
    if (authority !== true) {
      return mutationFailure(
        typeof authority === "string" ? authority : "SESSION_STALE",
      );
    }
  }
  const finalNow = Date.now();
  if (
    !Number.isSafeInteger(finalNow) ||
    finalNow < observedNow
  ) {
    return mutationFailure("TRANSCRIPT_CACHE_CLOCK_INVALID");
  }
  if (
    finalNow < timestamp ||
    finalNow - timestamp >= DIGEST_CACHE_TTL_MS
  ) {
    return { success: true, transcript: null };
  }
  return { success: true, transcript };
}

async function prepareNote(
  storage,
  videoId,
  timestamp,
  videoTitle,
  channelName,
  canonicalVideoUrl,
  beforeDispatch,
) {
  try {
    const safeTimestamp = Math.max(0, Math.floor(Number(timestamp) || 0));

    // A saved note may reuse only the same strict v2 digest view that the
    // panel can prove locally. A stale, forged, or legacy cache is a miss;
    // unavailable WebCrypto fails free rather than purchasing the transcript
    // again merely because local verification is unavailable.
    const cachedTranscript = await readValidatedNoteTranscript(
      storage,
      videoId,
      beforeDispatch,
    );
    if (cachedTranscript.success !== true) return cachedTranscript;
    let transcript = cachedTranscript.transcript;
    if (transcript) {
      debugLog("[YouTube Digest Vocabulary] Using validated cached transcript for note");
    }

    // If no cached transcript, fetch it
    if (!transcript) {
      const transcriptResult = await handleFetchTranscript(
        videoId,
        storage,
        beforeDispatch,
      );
      if (!transcriptResult.success) {
        return mutationFailure(
          typeof transcriptResult.code === "string"
            ? transcriptResult.code
            : "TRANSCRIPT_UNAVAILABLE",
        );
      }
      transcript = transcriptResult.transcript;
    }

    // Find the transcript line at the current timestamp
    // Look for the line that contains this timestamp (or the closest one before)
    let matchedLine = null;
    let matchedIndex = 0;
    let contextLines = [];
    let beforeLine = null; // a few sentences before
    let afterLine = null; // a few sentences after

    for (let i = 0; i < transcript.length; i++) {
      const line = transcript[i];
      if (
        line.start <= safeTimestamp &&
        (!transcript[i + 1] || transcript[i + 1].start > safeTimestamp)
      ) {
        matchedLine = line;
        matchedIndex = i;

        // Build a buffer of 2 lines before and 4 lines after the target.
        // This gives the model enough text to find a natural sentence boundary
        // and complete a thought that spans multiple short caption chunks.
        const beforeLines = [];
        for (let j = 1; j <= 2 && i - j >= 0; j++) {
          beforeLines.unshift(transcript[i - j].text);
        }
        if (beforeLines.length > 0) {
          beforeLine = beforeLines.join(" ");
        }

        const afterLines = [];
        for (let j = 1; j <= 4 && i + j < transcript.length; j++) {
          afterLines.push(transcript[i + j].text);
        }
        if (afterLines.length > 0) {
          afterLine = afterLines.join(" ");
        }

        // Get broader context (8 lines before and 12 lines after) for understanding
        const startIdx = Math.max(0, i - 8);
        const endIdx = Math.min(transcript.length - 1, i + 12);
        for (let j = startIdx; j <= endIdx; j++) {
          contextLines.push(transcript[j].text);
        }
        break;
      }
    }

    if (!matchedLine) {
      // Fallback: use the last line if timestamp is beyond transcript
      matchedLine = transcript[transcript.length - 1];
      matchedIndex = transcript.length - 1;

      // Get buffer sentence (only before, since we're at the end)
      const beforeLines = [];
      for (let j = 1; j <= 2 && matchedIndex - j >= 0; j++) {
        beforeLines.unshift(transcript[matchedIndex - j].text);
      }
      if (beforeLines.length > 0) {
        beforeLine = beforeLines.join(" ");
      }

      const startIdx = Math.max(0, matchedIndex - 8);
      for (let j = startIdx; j <= matchedIndex; j++) {
        contextLines.push(transcript[j].text);
      }
    }

    // Clean up the text with DeepSeek.
    const cleanedText = await cleanupNoteText(
      matchedLine.text,
      beforeLine,
      afterLine,
      contextLines.join(" "),
      videoTitle,
      storage,
      beforeDispatch,
    );

    // Format timestamp as MM:SS
    const minutes = Math.floor(safeTimestamp / 60);
    const seconds = safeTimestamp % 60;
    const formattedTimestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

    // Create timestamped URL
    const timestampedUrl = `${canonicalVideoUrl}&t=${safeTimestamp}s`;

    // Create the note object
    const note = {
      id: createNoteId(),
      videoId: videoId,
      videoTitle:
        typeof videoTitle === "string"
          ? videoTitle.slice(0, 500)
          : "Untitled Video",
      channelName:
        typeof channelName === "string" ? channelName.slice(0, 300) : "",
      timestamp: formattedTimestamp,
      timestampSeconds: safeTimestamp,
      timestampedUrl: timestampedUrl,
      text: cleanedText,
      rawText: matchedLine.text,
      createdAt: Date.now(),
    };

    return { success: true, note };
  } catch {
    return mutationFailure("NOTE_SAVE_FAILED");
  }
}

/**
 * Cleans up transcript lines using DeepSeek.
 * Takes the target line plus buffer sentences (1 before, 1 after).
 * Uses JSON output to prevent any preambles from appearing.
 */
async function cleanupNoteText(
  targetText,
  beforeText,
  afterText,
  fullContext,
  videoTitle,
  storage = chrome.storage.local,
  beforeDispatch,
) {
  const settings = await getSettings(storage);
  if (!settings.aiApiKey) {
    return [beforeText, targetText, afterText].filter(Boolean).join(" ");
  }

  try {
    debugLog("[YouTube Digest Vocabulary] Requesting note cleanup");
    const variables = {
      videoTitle: videoTitle || "Unknown",
      fullContext,
      beforeText: beforeText || "(none)",
      targetText,
      afterText: afterText || "(none)",
    };
    const systemPrompt = await loadPromptSection(
      "note-cleanup.md",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "note-cleanup.md",
      "User prompt",
      variables,
    );
    const { text: resultText } = await requestAiCompletion({
      maxTokens: 512,
      responseFormat: { type: "json_object" },
      storage,
      beforeDispatch,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    let result = resultText.trim() || targetText;

    // Parse the JSON response (tolerating trailing commas / fences).
    try {
      const parsed = parseLooseJson(result);
      if (typeof parsed.quote === "string" && parsed.quote.trim()) {
        return parsed.quote.trim().slice(0, 3000);
      }
    } catch (parseError) {
      console.warn(
        "[YouTube Digest Vocabulary] JSON parse failed for note, stripping preambles:",
        parseError,
      );
      result = result.replace(
        /^(Here'?s?( the)?( cleaned)?( version)?:?\s*)/i,
        "",
      );
      result = result.replace(
        /^(The cleaned (quote|text|version)( is)?:?\s*)/i,
        "",
      );
      result = result.replace(/^(I will.*?:?\s*)/i, "");
      result = result.replace(/^(Cleaned:?\s*)/i, "");
      result = result.replace(/^["']|["']$/g, "");
    }

    return result.slice(0, 3000);
  } catch (e) {
    console.error("[YouTube Digest Vocabulary] Cleanup error:", e);
  }

  // Return combined raw text if cleanup fails
  return [beforeText, targetText, afterText].filter(Boolean).join(" ");
}

/**
 * Saves a note to chrome.storage.local
 */
async function saveNoteToStorage(storage, note, validateMutation) {
  const result = await storage.get(STORAGE_KEYS.notes);
  const storedNotes = ownValue(result, STORAGE_KEYS.notes);
  const notes = Array.isArray(storedNotes) ? [...storedNotes] : [];
  notes.unshift(note); // Add to beginning (newest first)

  // Keep only last 100 notes to prevent storage bloat
  if (notes.length > 100) {
    notes.splice(100);
  }

  if (validateMutation) {
    const validation = await validateMutation();
    if (validation?.success !== true) return validation;
  }
  await storage.set({ [STORAGE_KEYS.notes]: notes });
  return { success: true };
}

// Keep note requests in arrival order without holding the global storage
// coordinator during transcript or AI work. Every actual write still enters
// storageMutations for durable epoch validation and cross-feature FIFO safety.
let noteRequestTail = Promise.resolve();

function runNoteRequestInOrder(operation) {
  const result = noteRequestTail.then(operation, operation);
  noteRequestTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Gets notes from storage, optionally filtered by video ID
 */
function handleBoundGetNotes(videoId, sessionTokenValue) {
  const token = normalizedSessionToken(sessionTokenValue);
  if (!token) {
    return Promise.resolve(legacyMutationFailure("INVALID_SESSION_TOKEN"));
  }
  if (videoId && token.videoId !== videoId) {
    return Promise.resolve(
      legacyMutationFailure("SESSION_BINDING_MISMATCH"),
    );
  }
  return handleGetNotes(videoId, validatePanelSessionContext(token));
}

function handleGetNotes(
  videoId,
  authorization = Promise.resolve({ success: true }),
) {
  if (videoId && !validVideoId(videoId)) {
    return Promise.resolve(legacyMutationFailure("INVALID_VIDEO_ID"));
  }
  return runNoteRequestInOrder(async () => {
    const allowed = await authorization;
    if (!allowed.success) return legacyCompatibleMutationResult(allowed);
    const response = await commitCurrentMutation(async (storage) => {
      let result;
      try {
        result = await storage.get(STORAGE_KEYS.notes);
      } catch {
        return mutationFailure("STORAGE_READ_FAILED");
      }
      const storedNotes = ownValue(result, STORAGE_KEYS.notes);
      let notes = Array.isArray(storedNotes) ? storedNotes : [];

      if (videoId) {
        notes = notes.filter((n) => n.videoId === videoId);
      }

      return { success: true, notes };
    }, "STORAGE_READ_FAILED");
    return legacyCompatibleMutationResult(response);
  });
}

/**
 * Deletes a note by ID
 */
function handleDeleteNote(noteId, sessionTokenValue) {
  const resetRevision = resetValidationRevision;
  const safeNoteId = typeof noteId === "string" ? noteId.trim() : "";
  if (!safeNoteId || safeNoteId.length > 160) {
    return Promise.resolve(legacyMutationFailure("INVALID_NOTE_ID"));
  }
  const token = normalizedSessionToken(sessionTokenValue);
  if (!token) {
    return Promise.resolve(legacyMutationFailure("INVALID_SESSION_TOKEN"));
  }
  const initialValidation = validatePanelSessionContext(token, {
    resetRevision,
  });

  const epoch = storageMutations.captureEpoch().then(
    (expectedEpoch) => ({ success: true, expectedEpoch }),
    () => mutationFailure("STORAGE_READ_FAILED"),
  );
  return runNoteRequestInOrder(async () => {
    const initial = await initialValidation;
    if (!initial.success) {
      return legacyCompatibleMutationResult(initial);
    }
    const captured = await epoch;
    if (captured.success !== true) {
      return legacyCompatibleMutationResult(captured);
    }
    if (token.resetEpoch !== captured.expectedEpoch) {
      return legacyMutationFailure("SESSION_STALE");
    }
    let committed;
    try {
      committed = await storageMutations.commit(
        captured.expectedEpoch,
        async (storage) => {
          let result;
          try {
            result = await storage.get(STORAGE_KEYS.notes);
          } catch {
            return mutationFailure("STORAGE_READ_FAILED");
          }
          const storedNotes = ownValue(result, STORAGE_KEYS.notes);
          const notes = (Array.isArray(storedNotes) ? storedNotes : []).filter(
            (note) => note?.id !== safeNoteId,
          );
          const finalValidation = await validatePanelSessionContext(token, {
            resetRevision,
          });
          if (!finalValidation.success) return finalValidation;
          try {
            await storage.set({ [STORAGE_KEYS.notes]: notes });
          } catch {
            return mutationFailure("STORAGE_WRITE_FAILED");
          }
          return { success: true, count: notes.length };
        },
      );
    } catch {
      return legacyMutationFailure("STORAGE_WRITE_FAILED");
    }
    return legacyCompatibleMutationResult(unwrapCoordinatorResult(committed));
  });
}

async function handleExplainSelection(
  selectedText,
  transcriptContext,
  videoTitle,
  beforeDispatch,
) {
  try {
    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: "DeepSeek API key not configured.",
      };
    }

    const variables = {
      videoTitle: videoTitle || "Unknown",
      selectedText,
      transcriptContext: transcriptContext || "None",
    };
    const systemPrompt = await loadPromptSection(
      "explain.md",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "explain.md",
      "User prompt",
      variables,
    );

    debugLog("[YouTube Digest Vocabulary] Requesting selection explanation");
    const { text: explanation } = await requestAiCompletion({
      maxTokens: 1024,
      beforeDispatch,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    return {
      success: true,
      explanation: explanation.trim(),
    };
  } catch (error) {
    console.error("Explain selection error:", error);
    return {
      success: false,
      error: error.message || "Failed to explain selection",
      ...(error.code ? { code: error.code } : {}),
    };
  }
}

// ============================================================
// VOCABULARY MEMORY CARDS
// ============================================================

function vocabularyString(value, field, maxLength, required = true) {
  const normalized = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
  if (required && !normalized) {
    throw new Error(`Vocabulary card is missing ${field}`);
  }
  return normalized;
}

function vocabularyStringArray(value, field, maxItems = 8, maxLength = 120) {
  if (!Array.isArray(value)) {
    throw new Error(`Vocabulary card is missing ${field}`);
  }
  const normalized = value
    .map((item) => vocabularyString(item, field, maxLength, false))
    .filter(Boolean)
    .filter((item, index, items) => items.indexOf(item) === index)
    .slice(0, maxItems);
  if (!normalized.length) {
    throw new Error(`Vocabulary card is missing ${field}`);
  }
  return normalized;
}

function vocabularyBoolean(value, field) {
  if (typeof value !== "boolean") {
    throw new Error(`Vocabulary card is missing ${field}`);
  }
  return value;
}

function normalizeVocabularyLearningPlan(value) {
  const source = value && typeof value === "object" ? value : {};
  const contextAnchor =
    source.contextAnchor && typeof source.contextAnchor === "object"
      ? source.contextAnchor
      : {};
  const morphology =
    source.morphology && typeof source.morphology === "object"
      ? source.morphology
      : {};
  const soundBridge =
    source.soundBridge && typeof source.soundBridge === "object"
      ? source.soundBridge
      : {};
  const visualScene =
    source.visualScene && typeof source.visualScene === "object"
      ? source.visualScene
      : {};
  const contrast =
    source.contrast && typeof source.contrast === "object" ? source.contrast : {};
  const retrieval =
    source.retrieval && typeof source.retrieval === "object"
      ? source.retrieval
      : {};
  const generation =
    source.generation && typeof source.generation === "object"
      ? source.generation
      : {};

  return {
    contextAnchor: {
      explanationZh: vocabularyString(
        contextAnchor.explanationZh,
        "learningPlan.contextAnchor.explanationZh",
        600,
      ),
      collocationUseZh: vocabularyString(
        contextAnchor.collocationUseZh,
        "learningPlan.contextAnchor.collocationUseZh",
        500,
      ),
    },
    morphology: {
      available: vocabularyBoolean(
        morphology.available,
        "learningPlan.morphology.available",
      ),
      breakdown: vocabularyString(
        morphology.breakdown,
        "learningPlan.morphology.breakdown",
        500,
      ),
      explanationZh: vocabularyString(
        morphology.explanationZh,
        "learningPlan.morphology.explanationZh",
        600,
      ),
    },
    soundBridge: {
      cueZh: vocabularyString(
        soundBridge.cueZh,
        "learningPlan.soundBridge.cueZh",
        500,
      ),
      safeguardZh: vocabularyString(
        soundBridge.safeguardZh,
        "learningPlan.soundBridge.safeguardZh",
        500,
      ),
    },
    visualScene: {
      hookZh: vocabularyString(
        visualScene.hookZh,
        "learningPlan.visualScene.hookZh",
        300,
      ),
      sceneEn: vocabularyString(
        visualScene.sceneEn,
        "learningPlan.visualScene.sceneEn",
        800,
      ),
      sceneZh: vocabularyString(
        visualScene.sceneZh,
        "learningPlan.visualScene.sceneZh",
        800,
      ),
      recallPathZh: vocabularyString(
        visualScene.recallPathZh,
        "learningPlan.visualScene.recallPathZh",
        600,
      ),
    },
    contrast: {
      relatedWordEn: vocabularyString(
        contrast.relatedWordEn,
        "learningPlan.contrast.relatedWordEn",
        120,
      ),
      distinctionZh: vocabularyString(
        contrast.distinctionZh,
        "learningPlan.contrast.distinctionZh",
        600,
      ),
      miniContrastEn: vocabularyString(
        contrast.miniContrastEn,
        "learningPlan.contrast.miniContrastEn",
        600,
      ),
    },
    retrieval: {
      clozePrompt: vocabularyString(
        retrieval.clozePrompt,
        "learningPlan.retrieval.clozePrompt",
        600,
      ),
      meaningToWordPrompt: vocabularyString(
        retrieval.meaningToWordPrompt,
        "learningPlan.retrieval.meaningToWordPrompt",
        600,
      ),
      productionPrompt: vocabularyString(
        retrieval.productionPrompt,
        "learningPlan.retrieval.productionPrompt",
        600,
      ),
      selfExplainPrompt: vocabularyString(
        retrieval.selfExplainPrompt,
        "learningPlan.retrieval.selfExplainPrompt",
        600,
      ),
    },
    generation: {
      exampleEn: vocabularyString(
        generation.exampleEn,
        "learningPlan.generation.exampleEn",
        600,
      ),
      exampleZh: vocabularyString(
        generation.exampleZh,
        "learningPlan.generation.exampleZh",
        600,
      ),
    },
    migrationNoteZh: vocabularyString(
      source.migrationNoteZh,
      "learningPlan.migrationNoteZh",
      300,
      false,
    ),
  };
}

function createLegacyVocabularyLearningPlan(source) {
  const mnemonic =
    source.mnemonic && typeof source.mnemonic === "object" ? source.mnemonic : {};
  const morphology = vocabularyString(source.morphology, "morphology", 500, false);
  const clozePrompt = vocabularyString(source.clozePrompt, "clozePrompt", 600);
  const productionPrompt = vocabularyString(
    source.productionPrompt,
    "productionPrompt",
    600,
  );
  const definitionZh = vocabularyString(source.meaningZh, "meaningZh", 500);
  const contextualMeaningZh = vocabularyString(
    source.contextualMeaningZh,
    "contextualMeaningZh",
    600,
  );
  const exampleEn = vocabularyString(source.exampleEn, "exampleEn", 600);
  const hook = vocabularyString(mnemonic.hook, "mnemonic.hook", 300);
  const sceneEn = vocabularyString(mnemonic.sceneEn, "mnemonic.sceneEn", 800);
  const sceneZh = vocabularyString(mnemonic.sceneZh, "mnemonic.sceneZh", 800);
  const recallPath = vocabularyString(
    mnemonic.recallPath,
    "mnemonic.recallPath",
    500,
  );
  return normalizeVocabularyLearningPlan({
    contextAnchor: {
      explanationZh: contextualMeaningZh,
      collocationUseZh: `旧版卡片保留的核心含义：${definitionZh}`,
    },
    morphology: {
      available: Boolean(morphology),
      breakdown: morphology || "旧版卡片没有可靠的词形结构提示。",
      explanationZh: morphology || "不强行拆分：旧版卡片没有可验证的词形提示。",
    },
    soundBridge: {
      cueZh: "旧版未生成声音/关键词联想；请在重新生成后获得经过标注的辅助联想。",
      safeguardZh: "声音联想只能辅助记忆，不是 IPA、词源或标准发音说明。",
    },
    visualScene: {
      hookZh: hook,
      sceneEn,
      sceneZh,
      recallPathZh: recallPath,
    },
    contrast: {
      relatedWordEn: "Not generated",
      distinctionZh: "旧版卡片未生成易混词对比；重新生成可补全。",
      miniContrastEn: "No contrast example was generated for this legacy card.",
    },
    retrieval: {
      clozePrompt,
      meaningToWordPrompt: `看到“${definitionZh}”，请先回忆这个单词。`,
      productionPrompt,
      selfExplainPrompt: `用自己的话说明它在原句里为什么表示“${contextualMeaningZh}”。`,
    },
    generation: {
      exampleEn,
      exampleZh: "旧版卡片未生成例句翻译；重新生成可补全。",
    },
    migrationNoteZh: "旧版记忆卡已安全迁移；重新生成可获得完整的多方法学习方案。",
  });
}

function vocabularyLearningPlanAliases(learningPlan) {
  return {
    morphology: learningPlan.morphology.available
      ? learningPlan.morphology.breakdown
      : "",
    mnemonic: {
      hook: learningPlan.visualScene.hookZh,
      sceneEn: learningPlan.visualScene.sceneEn,
      sceneZh: learningPlan.visualScene.sceneZh,
      recallPath: learningPlan.visualScene.recallPathZh,
    },
    exampleEn: learningPlan.generation.exampleEn,
    clozePrompt: learningPlan.retrieval.clozePrompt,
    productionPrompt: learningPlan.retrieval.productionPrompt,
  };
}

function vocabularyLemmaKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US");
}

function formatVocabularyTimestamp(seconds) {
  const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function validateVocabularyRequest(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const word = vocabularyString(source.word, "word", 80);
  if (
    !/^[A-Za-zÀ-ÖØ-öø-ÿ]+(?:[’'][A-Za-zÀ-ÖØ-öø-ÿ]+)*(?:-[A-Za-zÀ-ÖØ-öø-ÿ]+(?:[’'][A-Za-zÀ-ÖØ-öø-ÿ]+)*)*$/.test(
      word,
    )
  ) {
    throw new Error("Select one English word to create a vocabulary card");
  }

  const videoId = vocabularyString(source.videoId, "videoId", 32);
  if (!/^[A-Za-z0-9_-]+$/.test(videoId)) {
    throw new Error("Vocabulary source has an invalid video ID");
  }
  const timestampSeconds = Math.max(
    0,
    Math.min(24 * 60 * 60, Math.floor(Number(source.timestampSeconds) || 0)),
  );
  const canonicalUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;

  return {
    word,
    sentence: vocabularyString(source.sentence, "sentence", 1000),
    context: vocabularyString(source.context, "context", 1200, false),
    videoId,
    videoTitle: vocabularyString(
      source.videoTitle || "Unknown video",
      "videoTitle",
      300,
    ),
    channelName: vocabularyString(
      source.channelName || "Unknown channel",
      "channelName",
      200,
    ),
    timestampSeconds,
    timestamp: formatVocabularyTimestamp(timestampSeconds),
    url: `${canonicalUrl}&t=${timestampSeconds}s`,
  };
}

function normalizeVocabularyCard(value, request, now = Date.now()) {
  const source = value && typeof value === "object" ? value : {};
  const lemma = vocabularyString(source.lemma, "lemma", 80).toLocaleLowerCase(
    "en-US",
  );
  if (!/^[A-Za-zÀ-ÖØ-öø-ÿ]+(?:[’'-][A-Za-zÀ-ÖØ-öø-ÿ]+)*$/.test(lemma)) {
    throw new Error("Vocabulary card returned an invalid lemma");
  }

  const learningPlan = normalizeVocabularyLearningPlan({
    ...(source.learningPlan && typeof source.learningPlan === "object"
      ? source.learningPlan
      : {}),
    migrationNoteZh: "",
  });
  const aliases = vocabularyLearningPlanAliases(learningPlan);
  const clickedForm = vocabularyLemmaKey(request.word);
  const occurrence = {
    form: clickedForm,
    sentence: request.sentence,
    context: request.context,
    videoId: request.videoId,
    videoTitle: request.videoTitle,
    channelName: request.channelName,
    timestampSeconds: request.timestampSeconds,
    timestamp: request.timestamp,
    url: request.url,
    capturedAt: now,
  };

  return {
    id: `vocab_${vocabularyLemmaKey(lemma)}`,
    lemma,
    forms: [clickedForm],
    ipa: vocabularyString(source.ipa, "ipa", 100),
    partOfSpeech: vocabularyString(
      source.partOfSpeech,
      "partOfSpeech",
      80,
    ),
    definitionEn: vocabularyString(
      source.definitionEn,
      "definitionEn",
      500,
    ),
    meaningZh: vocabularyString(source.meaningZh, "meaningZh", 500),
    contextualMeaningEn: vocabularyString(
      source.contextualMeaningEn,
      "contextualMeaningEn",
      600,
    ),
    contextualMeaningZh: vocabularyString(
      source.contextualMeaningZh,
      "contextualMeaningZh",
      600,
    ),
    collocations: vocabularyStringArray(source.collocations, "collocations"),
    learningPlan,
    ...aliases,
    occurrences: [occurrence],
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeVocabularyOccurrence(value) {
  const source = value && typeof value === "object" ? value : {};
  const videoId = vocabularyString(source.videoId, "videoId", 32);
  const timestampSeconds = Math.max(
    0,
    Math.min(24 * 60 * 60, Math.floor(Number(source.timestampSeconds) || 0)),
  );
  return {
    form: vocabularyLemmaKey(
      vocabularyString(source.form, "occurrence.form", 80),
    ),
    sentence: vocabularyString(
      source.sentence,
      "occurrence.sentence",
      1000,
    ),
    context: vocabularyString(
      source.context,
      "occurrence.context",
      1200,
      false,
    ),
    videoId,
    videoTitle: vocabularyString(
      source.videoTitle || "Unknown video",
      "occurrence.videoTitle",
      300,
    ),
    channelName: vocabularyString(
      source.channelName || "Unknown channel",
      "occurrence.channelName",
      200,
    ),
    timestampSeconds,
    timestamp: formatVocabularyTimestamp(timestampSeconds),
    url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${timestampSeconds}s`,
    capturedAt: Math.max(0, Math.floor(Number(source.capturedAt) || Date.now())),
  };
}

function normalizeStoredVocabularyEntry(value) {
  const source = value && typeof value === "object" ? value : {};
  const lemma = vocabularyString(source.lemma, "lemma", 80).toLocaleLowerCase(
    "en-US",
  );
  const learningPlan = source.learningPlan
    ? normalizeVocabularyLearningPlan(source.learningPlan)
    : createLegacyVocabularyLearningPlan(source);
  const aliases = vocabularyLearningPlanAliases(learningPlan);
  const occurrences = Array.isArray(source.occurrences)
    ? source.occurrences
        .map((occurrence) => {
          try {
            return normalizeVocabularyOccurrence(occurrence);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .slice(0, 100)
    : [];
  if (!occurrences.length) {
    throw new Error("Vocabulary card is missing occurrences");
  }

  const forms = Array.from(
    new Set(
      [
        ...(Array.isArray(source.forms) ? source.forms : []),
        ...occurrences.map((occurrence) => occurrence.form),
      ]
        .map(vocabularyLemmaKey)
        .filter(Boolean),
    ),
  ).sort((a, b) => a.localeCompare(b));

  return {
    id: `vocab_${vocabularyLemmaKey(lemma)}`,
    lemma,
    forms,
    ipa: vocabularyString(source.ipa, "ipa", 100),
    partOfSpeech: vocabularyString(
      source.partOfSpeech,
      "partOfSpeech",
      80,
    ),
    definitionEn: vocabularyString(
      source.definitionEn,
      "definitionEn",
      500,
    ),
    meaningZh: vocabularyString(source.meaningZh, "meaningZh", 500),
    contextualMeaningEn: vocabularyString(
      source.contextualMeaningEn,
      "contextualMeaningEn",
      600,
    ),
    contextualMeaningZh: vocabularyString(
      source.contextualMeaningZh,
      "contextualMeaningZh",
      600,
    ),
    collocations: vocabularyStringArray(source.collocations, "collocations"),
    learningPlan,
    ...aliases,
    occurrences,
    createdAt: Math.max(0, Math.floor(Number(source.createdAt) || Date.now())),
    updatedAt: Math.max(0, Math.floor(Number(source.updatedAt) || Date.now())),
  };
}

function vocabularyOccurrenceSignature(occurrence) {
  return [
    occurrence.videoId,
    occurrence.timestampSeconds,
    vocabularyLemmaKey(occurrence.form),
    occurrence.sentence.normalize("NFKC").trim(),
  ].join("\u0000");
}

function mergeVocabularyEntry(existing, incoming, now = Date.now()) {
  const older = normalizeStoredVocabularyEntry(existing);
  const newer = normalizeStoredVocabularyEntry(incoming);
  if (vocabularyLemmaKey(older.lemma) !== vocabularyLemmaKey(newer.lemma)) {
    throw new Error("Cannot merge vocabulary entries with different lemmas");
  }

  const occurrences = [];
  const signatures = new Set();
  for (const occurrence of [
    ...newer.occurrences,
    ...older.occurrences,
  ]) {
    const signature = vocabularyOccurrenceSignature(occurrence);
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    occurrences.push(occurrence);
  }

  return normalizeStoredVocabularyEntry({
    ...older,
    ...newer,
    forms: Array.from(new Set([...older.forms, ...newer.forms])).sort((a, b) =>
      a.localeCompare(b),
    ),
    occurrences,
    createdAt: older.createdAt,
    updatedAt: now,
  });
}

function normalizeVocabularyLibrary(value) {
  const source = value && typeof value === "object" ? value : {};
  const entries = [];
  for (const item of Array.isArray(source.entries) ? source.entries : []) {
    try {
      entries.push(normalizeStoredVocabularyEntry(item));
    } catch {
      // Ignore a corrupt record rather than making the entire library unreadable.
    }
  }
  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  return { schemaVersion: VOCABULARY_SCHEMA_VERSION, entries };
}

async function readVocabularyLibrary(storage = chrome.storage.local) {
  const stored = await storage.get(VOCABULARY_STORAGE_KEY);
  return normalizeVocabularyLibrary(stored[VOCABULARY_STORAGE_KEY]);
}

async function handleSaveVocabularyCard(card) {
  let incoming;
  try {
    incoming = normalizeStoredVocabularyEntry(card);
  } catch {
    return legacyMutationFailure("INVALID_VOCABULARY_CARD");
  }
  let expectedEpoch;
  try {
    expectedEpoch = await storageMutations.captureEpoch();
  } catch {
    return legacyMutationFailure("STORAGE_READ_FAILED");
  }
  let committed;
  try {
    committed = await storageMutations.commit(expectedEpoch, async (storage) => {
      let library;
      try {
        library = await readVocabularyLibrary(storage);
      } catch {
        return mutationFailure("STORAGE_READ_FAILED");
      }
      const matchIndex = library.entries.findIndex(
        (entry) =>
          vocabularyLemmaKey(entry.lemma) ===
          vocabularyLemmaKey(incoming.lemma),
      );
      const entry =
        matchIndex >= 0
          ? mergeVocabularyEntry(library.entries[matchIndex], incoming)
          : incoming;
      if (matchIndex >= 0) library.entries[matchIndex] = entry;
      else library.entries.unshift(entry);
      library.entries.sort((a, b) => b.updatedAt - a.updatedAt);
      try {
        await storage.set({ [VOCABULARY_STORAGE_KEY]: library });
      } catch {
        return mutationFailure("STORAGE_WRITE_FAILED");
      }
      return { success: true, entry, count: library.entries.length };
    });
  } catch {
    return legacyMutationFailure("STORAGE_WRITE_FAILED");
  }
  const response = legacyCompatibleMutationResult(
    unwrapCoordinatorResult(committed),
  );
  if (response.success) {
    broadcastWithoutBlocking({
      action: "vocabularyChanged",
      entryId: response.entry.id,
    });
  }
  return response;
}

async function handleGetVocabulary() {
  const response = await commitCurrentMutation(async (storage) => {
    let library;
    try {
      library = await readVocabularyLibrary(storage);
    } catch {
      return mutationFailure("STORAGE_READ_FAILED");
    }
    return { success: true, entries: library.entries };
  }, "STORAGE_READ_FAILED");
  return legacyCompatibleMutationResult(response);
}

async function handleDeleteVocabularyCard(cardId) {
  let safeId;
  try {
    safeId = vocabularyString(cardId, "cardId", 120);
  } catch {
    return legacyMutationFailure("INVALID_VOCABULARY_ID");
  }
  let expectedEpoch;
  try {
    expectedEpoch = await storageMutations.captureEpoch();
  } catch {
    return legacyMutationFailure("STORAGE_READ_FAILED");
  }
  let committed;
  try {
    committed = await storageMutations.commit(expectedEpoch, async (storage) => {
      let library;
      try {
        library = await readVocabularyLibrary(storage);
      } catch {
        return mutationFailure("STORAGE_READ_FAILED");
      }
      const nextEntries = library.entries.filter((entry) => entry.id !== safeId);
      if (nextEntries.length === library.entries.length) {
        return mutationFailure("VOCABULARY_NOT_FOUND");
      }
      try {
        await storage.set({
          [VOCABULARY_STORAGE_KEY]: {
            schemaVersion: VOCABULARY_SCHEMA_VERSION,
            entries: nextEntries,
          },
        });
      } catch {
        return mutationFailure("STORAGE_WRITE_FAILED");
      }
      return { success: true, count: nextEntries.length };
    });
  } catch {
    return legacyMutationFailure("STORAGE_WRITE_FAILED");
  }
  const response = legacyCompatibleMutationResult(
    unwrapCoordinatorResult(committed),
  );
  if (response.success) {
    broadcastWithoutBlocking({ action: "vocabularyChanged", entryId: safeId });
  }
  return response;
}

async function handleGenerateVocabularyCard(payload) {
  try {
    const request = validateVocabularyRequest(payload);
    const systemPrompt = await loadPromptSection(
      "vocabulary.md",
      "System prompt",
    );
    const userPrompt = await loadPromptSection(
      "vocabulary.md",
      "User prompt",
      {
        word: request.word,
        sentence: request.sentence,
        context: request.context || "None",
        videoTitle: request.videoTitle,
        channelName: request.channelName,
      },
    );
    const completion = {
      temperature: 0.45,
      maxTokens: 1800,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    };

    let response;
    try {
      response = await requestAiCompletion(completion);
    } catch (error) {
      if (error.code !== "EMPTY_AI_RESPONSE") throw error;
      response = await requestAiCompletion({
        ...completion,
        responseFormat: undefined,
      });
    }

    const parsed = parseLooseJson(response.text);
    return {
      success: true,
      card: normalizeVocabularyCard(parsed, request),
    };
  } catch (error) {
    console.error("Vocabulary generation error:", error);
    return {
      success: false,
      error: error.message || "Failed to generate vocabulary card",
      code: error.code,
    };
  }
}

// ============================================================
// TRANSLATION — Translate transcript batches into Simplified Chinese
// ============================================================
// Uses a low temperature for consistent, natural translations.

/**
 * Shared base rules that every translation prompt includes.
 * These ensure translations sound natural rather than machine-translated.
 *
 * @param {string} targetLanguage - Must be 'zh'
 * @returns {Promise<string>} - The base translation rules
 */
async function getTranslationBaseRules(targetLanguage) {
  if (targetLanguage !== "zh") {
    throw new Error(`Unsupported translation target: ${targetLanguage}`);
  }
  const langName = "Simplified Chinese";
  const langSpecific = await loadPromptSection(
    "translation.md",
    "Chinese rules",
  );
  return loadPromptSection("translation.md", "Shared base rules", {
    langName,
    langSpecific,
  });
}

function validateTranscriptBatchRequest(content) {
  const segments = content?.segments;
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > 4) {
    throw new Error("Transcript translation requires 1 to 4 segments");
  }

  const seenIds = new Set();
  let totalCharacters = 0;
  const normalized = segments.map((segment) => {
    const id = typeof segment?.id === "string" ? segment.id.trim() : "";
    const text = typeof segment?.text === "string" ? segment.text.trim() : "";
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(id) || seenIds.has(id)) {
      throw new Error("Transcript translation segment IDs must be unique and stable");
    }
    if (!text || text.length > 4000) {
      throw new Error("Transcript translation segment text is invalid or too long");
    }
    seenIds.add(id);
    totalCharacters += text.length;
    return { id, text };
  });
  if (totalCharacters > 12000) {
    throw new Error("Transcript translation batch is too large");
  }
  return normalized;
}

function looksLikeChineseTranslation(text, sourceText) {
  const latinLetters = (sourceText.match(/[A-Za-z]/g) || []).length;
  if (latinLetters < 20) return true;
  return /[\u3400-\u9fff]/.test(text);
}

/**
 * Aligns untrusted model output by exact stable ID. Missing, duplicated,
 * unknown, empty, or clearly non-Chinese values become explicit row errors.
 */
function normalizeTranslatedSegmentBatch(parsed, sourceSegments) {
  const candidates = Array.isArray(parsed?.segments) ? parsed.segments : [];
  const sourceById = new Map(sourceSegments.map((segment) => [segment.id, segment]));
  const translatedById = new Map();

  candidates.forEach((candidate) => {
    if (
      typeof candidate?.id !== "string" ||
      typeof candidate?.text !== "string" ||
      !sourceById.has(candidate.id) ||
      translatedById.has(candidate.id)
    ) {
      return;
    }
    const text = candidate.text.trim();
    const source = sourceById.get(candidate.id);
    if (text && looksLikeChineseTranslation(text, source.text)) {
      translatedById.set(candidate.id, text);
    }
  });

  return {
    segments: sourceSegments.map((source) => ({
      id: source.id,
      text: translatedById.get(source.id) || "",
      error: translatedById.has(source.id)
        ? ""
        : "Missing or invalid Chinese translation",
    })),
  };
}

/**
 * Translates content using DeepSeek.
 * @param {Object} content - JSON object containing semantic transcript segments
 * @param {string} contentType - Must be 'transcriptBatch'
 * @param {string} targetLanguage - 'zh' for Simplified Chinese
 * @param {string} videoTitle - The video title (for context)
 * @returns {Object} - { success, translatedContent } or { success: false, error }
 */
async function handleTranslateContent(
  content,
  contentType,
  targetLanguage,
  videoTitle,
  beforeDispatch,
) {
  try {
    if (targetLanguage !== "zh") {
      return {
        success: false,
        error: `Unsupported translation target: ${String(targetLanguage)}`,
      };
    }
    if (contentType !== "transcriptBatch") {
      return {
        success: false,
        error: `Unsupported translation content type: ${String(contentType)}`,
      };
    }

    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return { success: false, error: "DeepSeek API key not configured" };
    }

    const sourceSegments = validateTranscriptBatchRequest(content);
    const langName = "Simplified Chinese";
    const baseRules = await getTranslationBaseRules(targetLanguage);
    const systemPrompt = await loadPromptSection(
      "translation.md",
      "Transcript batch translation",
      {
        langName,
        videoTitle: videoTitle || "Unknown",
        baseRules,
      },
    );
    const userContent = JSON.stringify({ segments: sourceSegments });
    const translationOptions = {
      temperature: 0.2,
      maxTokens: 1536,
      responseFormat: { type: "json_object" },
    };
    let result = await callAiTranslation(
      systemPrompt,
      userContent,
      { ...translationOptions, beforeDispatch },
    );

    // DeepSeek JSON mode can rarely return an empty content string. The prompt
    // already requires JSON, so retry once without response_format.
    if (!result.success && result.code === "EMPTY_AI_RESPONSE") {
      result = await callAiTranslation(systemPrompt, userContent, {
        temperature: translationOptions.temperature,
        maxTokens: translationOptions.maxTokens,
        beforeDispatch,
      });
    }
    if (!result.success) return result;

    const parsed = parseLooseJson(result.text);
    const aligned = normalizeTranslatedSegmentBatch(parsed, sourceSegments);
    if (!aligned.segments.some((segment) => segment.text)) {
      return {
        success: false,
        error: "Translation returned no valid Chinese segments",
      };
    }
    return { success: true, translatedContent: aligned };
  } catch (error) {
    console.error("[YouTube Digest Vocabulary] Translation error:", error);
    return {
      success: false,
      error: error.message || "Translation failed",
      ...(error.code ? { code: error.code } : {}),
    };
  }
}

/**
 * Makes a single DeepSeek call for translation.
 * Uses temperature 0.3 for consistent, predictable translations.
 *
 * @param {string} systemPrompt - The system-level instructions
 * @param {string} userContent - The user message (content to translate)
 * @returns {Object} - { success, text } or { success: false, error }
 */
async function callAiTranslation(
  systemPrompt,
  userContent,
  {
    temperature = 0.3,
    maxTokens = 8192,
    responseFormat,
    beforeDispatch,
  } = {},
) {
  try {
    const { text } = await requestAiCompletion({
      temperature,
      maxTokens,
      responseFormat,
      beforeDispatch,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    });

    return { success: true, text };
  } catch (error) {
    if (error.status === 429) {
      return {
        success: false,
        error: "Rate limited — try again in a moment",
        code: "RATE_LIMITED",
      };
    }
    return { success: false, error: error.message, code: error.code };
  }
}

// Pure validators are exposed for the repository's Node tests only.
globalThis.__YTD_TRANSLATION_TESTING__ = {
  requestAiCompletion,
  callAiTranslation,
  validateTranscriptBatchRequest,
  normalizeTranslatedSegmentBatch,
  handleTranslateContent,
};

globalThis.__YTD_TRANSCRIPT_PROVIDER_TESTING__ = {
  fetchWithDeadline,
  handleFetchTranscript,
  normalizeSupadataTranscript,
  pollTranscriptJob,
  limits: Object.freeze({
    initialTimeoutMs: SUPADATA_INITIAL_TIMEOUT_MS,
    pollTimeoutMs: SUPADATA_POLL_TIMEOUT_MS,
    jobDeadlineMs: SUPADATA_JOB_DEADLINE_MS,
    maxResponseBytes: SUPADATA_MAX_RESPONSE_BYTES,
  }),
};

globalThis.__YTD_ANALYSIS_TESTING__ = {
  handleAnalyzeTranscript,
  validateAndFixTimestamps,
};

globalThis.__YTD_OVERVIEW_TESTING__ = {
  validateBasicOverviewRequest,
  prepareBasicOverviewDispatch,
  dispatchPreparedBasicOverview,
  handleGenerateBasicOverview,
  handleRequestBasicOverview,
  handleRetryBasicOverviewCacheWrite,
  getOverviewCacheRecoverySize: () => overviewCacheRecoveryByToken.size,
  recoveryLimits: Object.freeze({
    maxEntries: OVERVIEW_CACHE_RECOVERY_MAX_ENTRIES,
    ttlMs: OVERVIEW_CACHE_RECOVERY_TTL_MS,
  }),
};

globalThis.__YTD_VOCABULARY_TESTING__ = {
  validateVocabularyRequest,
  normalizeVocabularyCard,
  normalizeVocabularyLearningPlan,
  normalizeVocabularyLibrary,
  mergeVocabularyEntry,
  handleGenerateVocabularyCard,
};
