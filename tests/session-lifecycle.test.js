const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const transcriptCore = require("../transcript-core.js");
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(predicate, turns = 30) {
  for (let turn = 0; turn < turns; turn += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("Timed out waiting for deferred test stage");
}

function transcriptResult(label) {
  return {
    success: true,
    transcript: [{ start: 0, duration: 2, text: `${label} transcript.` }],
    transcriptText: `${label} transcript.`,
    transcriptTextTimestamped: `[0:00] ${label} transcript.`,
    language: "en",
  };
}

function completeDeepAnalysis(label = "A") {
  return {
    schemaVersion: 2,
    maxTimestampSeconds: 180,
    reportComplete: true,
    summary: {
      oneSentenceZh: `${label} 的一句话结论`,
      executiveSummaryZh: `${label} 的完整概括`,
      coreThesisZh: `${label} 的核心论点`,
      whyItMattersZh: `${label} 的重要性`,
    },
    chapters: [
      {
        title: `${label} 开场`,
        summary: `${label} 的开场章节`,
        timestampSeconds: 0,
        timestamp: "0:00",
      },
      {
        title: `${label} 结尾`,
        summary: `${label} 的结尾章节`,
        timestampSeconds: 150,
        timestamp: "2:30",
      },
    ],
    keyInsights: Array.from({ length: 5 }, (_, index) => {
      const timestampSeconds = 30 + index * 20;
      return {
        titleZh: `${label} 洞见 ${index + 1}`,
        explanationZh: `${label} 洞见解释 ${index + 1}`,
        evidenceZh: `${label} 洞见证据 ${index + 1}`,
        timestampSeconds,
        timestamp: `${Math.floor(timestampSeconds / 60)}:${String(timestampSeconds % 60).padStart(2, "0")}`,
      };
    }),
    argumentMap: [
      {
        claimZh: `${label} 主张`,
        supportZh: `${label} 论据`,
        caveatZh: `${label} 限制`,
      },
    ],
    criticalThinking: {
      strengthsZh: [`${label} 优点`],
      limitationsZh: [`${label} 局限`],
      assumptionsZh: [`${label} 假设`],
      openQuestionsZh: [`${label} 问题`],
    },
    actionItemsZh: [`${label} 行动`],
    reviewQuestions: [
      { questionZh: `${label} 问题`, answerZh: `${label} 回答` },
    ],
    keyQuotes: [30, 90, 150].map((timestampSeconds, index) => ({
      quote: `${label} 引语 ${index + 1}`,
      timestampSeconds,
      timestamp: `${Math.floor(timestampSeconds / 60)}:${String(timestampSeconds % 60).padStart(2, "0")}`,
    })),
    keyMoments: [0, 60, 120, 180],
  };
}

async function cachedDigestV2(label = "cached A", overrides = {}) {
  const source = transcriptResult(label);
  const transcriptLanguage = transcriptCore.resolveTranscriptLanguage(
    source.language,
    source.transcript,
  );
  const segments = transcriptCore.groupTranscriptEntries(source.transcript);
  const transcriptFingerprint = await transcriptCore.fingerprintSegments(
    segments,
    { sourceLanguage: transcriptLanguage, crypto: webcrypto },
  );
  return {
    digestSchemaVersion: 2,
    timestamp: Date.now(),
    transcript: source.transcript,
    transcriptText: source.transcriptText,
    transcriptTimestamped: source.transcriptTextTimestamped,
    transcriptLanguage,
    transcriptFingerprint,
    videoTitle: `${label} title`,
    channelName: `${label} channel`,
    ...overrides,
  };
}

function digestBaseSuccess(timestamp = Date.now()) {
  return { success: true, timestamp };
}

function basicOverviewForTranscript(
  transcriptFingerprint,
  segments,
  overrides = {},
) {
  const segment = Array.isArray(segments) ? segments[0] : null;
  return {
    schemaVersion: 1,
    transcriptFingerprint,
    generatedAt: Date.now(),
    oneSentenceZh: "可信的一句话概览",
    conclusions: segment
      ? [{
          id: "conclusion-1",
          titleZh: "可信结论",
          explanationZh: "逐字稿支持这个结论。",
          evidenceLevel: "strong",
          evidenceSegmentIds: [segment.id],
        }]
      : [],
    chapters: segment
      ? [{
          titleZh: "开场",
          summaryZh: "逐字稿开场。",
          startSegmentId: segment.id,
          timestampSeconds: segment.start,
        }]
      : [],
    complete: overrides.complete === true,
    ...overrides,
  };
}

function basicOverviewForRequest(message, overrides = {}) {
  const payload = message.payload || {};
  return basicOverviewForTranscript(
    payload.transcriptFingerprint,
    payload.segments,
    overrides,
  );
}

async function clickNode(node) {
  node.focus?.();
  const callbacks = Array.from(node.listeners.get("click") || []);
  assert.ok(callbacks.length, `${node.id} should have a click listener`);
  for (const callback of callbacks) await callback({ currentTarget: node });
  await new Promise((resolve) => setImmediate(resolve));
}

function createNode(id = "") {
  const classes = new Set();
  const children = [];
  const listeners = new Map();
  const queriedChildren = new Map();
  const attributes = new Map();
  const node = {
    id,
    isConnected: true,
    style: { display: "" },
    dataset: {},
    disabled: false,
    hidden: false,
    open: false,
    textContent: "",
    innerHTML: "",
    parentElement: { insertBefore() {} },
    classList: {
      add(...values) {
        values.forEach((value) => classes.add(value));
      },
      remove(...values) {
        values.forEach((value) => classes.delete(value));
      },
      toggle(value, force) {
        if (force === undefined ? !classes.has(value) : force) classes.add(value);
        else classes.delete(value);
      },
      contains(value) {
        return classes.has(value);
      },
    },
    listeners,
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) {
      listeners.get(type)?.delete(callback);
    },
    attributes,
    setAttribute(name, value) {
      attributes.set(name, String(value));
      if (name === "hidden") node.hidden = true;
    },
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
    removeAttribute(name) {
      attributes.delete(name);
      if (name === "hidden") node.hidden = false;
    },
    children,
    appendChild(child) {
      children.push(child);
      child.parentElement = node;
      child.isConnected = true;
      return child;
    },
    append(...items) {
      for (const item of items) {
        if (item && typeof item === "object") node.appendChild(item);
        else node.textContent += String(item ?? "");
      }
    },
    replaceChildren(...items) {
      children.splice(0, children.length);
      node.textContent = "";
      node.innerHTML = "";
      node.append(...items);
    },
    remove() {
      if (Array.isArray(node.parentElement?.children)) {
        const index = node.parentElement.children.indexOf(node);
        if (index >= 0) node.parentElement.children.splice(index, 1);
      }
      node.isConnected = false;
    },
    showModal() {
      node.open = true;
      node.setAttribute("open", "");
    },
    close() {
      node.open = false;
      node.removeAttribute("open");
    },
    contains(target) {
      return target === node || children.some((child) => child.contains?.(target));
    },
    querySelector(selector) {
      if (selector === ".explain-btn") {
        if (!queriedChildren.has(selector)) {
          const child = createNode("explain-button");
          queriedChildren.set(selector, child);
          node.appendChild(child);
        }
        return queriedChildren.get(selector);
      }
      if (selector === ".transcript-copy") {
        return {
          set outerHTML(value) {
            node.innerHTML = value;
          },
        };
      }
      if (/^\.[A-Za-z0-9_-]+$/.test(selector)) {
        if (!queriedChildren.has(selector)) {
          const child = createNode(selector.slice(1));
          queriedChildren.set(selector, child);
          node.appendChild(child);
        }
        return queriedChildren.get(selector);
      }
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  return node;
}

function loadSidepanel(options = {}) {
  let vmContext = null;
  const ids = [
    "videoInfo",
    "videoTitle",
    "videoChannel",
    "tabsNav",
    "contentArea",
    "welcomeState",
    "loadingState",
    "loadingText",
    "loadingSubtext",
    "errorState",
    "errorTitle",
    "errorMessage",
    "errorCostNote",
    "errorBtn",
    "errorSecondaryBtn",
    "resultsState",
    "settingsBtn",
    "langSpinner",
    "copyTranscriptBtn",
    "exportTranscriptBtn",
    "exportCleanTranscriptBtn",
    "transcriptExportStatus",
    "transcriptList",
    "overviewState",
    "overviewLoadingState",
    "overviewLoadingTitle",
    "overviewLoadingMessage",
    "overviewErrorState",
    "overviewErrorTitle",
    "overviewErrorMessage",
    "overviewErrorCostNote",
    "overviewPrimaryActionBtn",
    "overviewSecondaryActionBtn",
    "overviewReadyState",
    "overviewStatusBadge",
    "overviewOneSentence",
    "overviewConclusions",
    "overviewChapterList",
    "overviewCacheWarning",
    "overviewCacheWarningMessage",
    "overviewCacheRetryBtn",
    "evidenceDialog",
    "evidenceDialogTitle",
    "evidenceDialogDescription",
    "evidenceTimestamp",
    "evidenceExactText",
    "evidencePreviousContext",
    "evidenceNextContext",
    "evidenceAiExplanation",
    "evidenceCopyStatus",
    "evidenceDialogCloseBtn",
    "evidenceCopyBtn",
    "evidenceSeekBtn",
    "deepAnalysisCard",
    "deepAnalysisActionBtn",
    "deepAnalysisState",
    "deepAnalysisResults",
    "regenerateAnalysisBtn",
    "analysisRecoveryContextBtn",
    "analysisExportReportBtn",
    "analysisExportStudyPackBtn",
    "analysisStatus",
    "analysisTakeawayTitle",
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
    "notesIntro",
    "notesList",
    "followPlaybackBtn",
  ];
  const nodes = Object.fromEntries(ids.map((id) => [id, createNode(id)]));
  let activeElement = null;
  Object.values(nodes).forEach((node) => {
    node.focus = () => {
      activeElement = node;
    };
    node.blur = () => {
      if (activeElement === node) activeElement = null;
    };
  });
  const tabs = ["overview", "transcript", "notes", "vocabulary"].map((name) => {
    const node = createNode(`tab-${name}`);
    node.dataset.tab = name;
    return node;
  });
  const panels = tabs.map((tab) => {
    const node = createNode(`panel-${tab.dataset.tab}`);
    node.dataset.panel = tab.dataset.tab;
    return node;
  });
  [...tabs, ...panels].forEach((node) => {
    node.focus = () => {
      activeElement = node;
    };
    node.blur = () => {
      if (activeElement === node) activeElement = null;
    };
  });
  const runtimeMessages = [];
  const runtimeMessageListeners = [];
  const tabUpdatedListeners = [];
  const tabActivatedListeners = [];
  const createdTabs = [];
  const storageChangedListeners = [];
  const documentEventListeners = new Map();
  const dynamicNodes = [];
  const body = createNode("body");
  const activeIntervals = new Set();
  const scheduledTimeouts = new Map();
  const allTimeouts = new Map();
  let intervalStarts = 0;
  let timeoutIdCounter = 0;
  const listener = { addListener() {} };
  const runtimeCrypto =
    options.crypto === undefined
      ? {
          subtle: webcrypto.subtle,
          randomUUID: () => "default-session-id",
        }
      : options.crypto === null
        ? null
        : {
            ...options.crypto,
            subtle: options.crypto.subtle || webcrypto.subtle,
          };
  const HostDate = Date;
  const RuntimeDate = class extends HostDate {
    static now() {
      return typeof options.now === "function"
        ? options.now()
        : HostDate.now();
    }
  };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    URL,
    Blob,
    TextDecoder,
    TextEncoder,
    Date: RuntimeDate,
    AbortController,
    crypto: runtimeCrypto,
    setTimeout(callback, delay = 0) {
      if (!options.captureTimeouts) return 0;
      const timeoutId = ++timeoutIdCounter;
      const entry = { callback, delay, cleared: false };
      scheduledTimeouts.set(timeoutId, entry);
      allTimeouts.set(timeoutId, entry);
      return timeoutId;
    },
    clearTimeout(timeoutId) {
      const entry = allTimeouts.get(timeoutId);
      if (entry) entry.cleared = true;
      scheduledTimeouts.delete(timeoutId);
    },
    setInterval() {
      intervalStarts += 1;
      activeIntervals.add(intervalStarts);
      return intervalStarts;
    },
    clearInterval(intervalId) {
      activeIntervals.delete(intervalId);
    },
    IntersectionObserver: class {
      disconnect() {}
      observe() {}
    },
    CSS: { escape: (value) => value },
    navigator: {
      onLine: options.onLine === undefined ? true : options.onLine,
      clipboard: {
        async writeText(value) {
          if (options.clipboardWrite) return options.clipboardWrite(value);
        },
      },
    },
    window: {
      getSelection: () =>
        options.getSelection ? options.getSelection() : null,
      close() {},
      scrollY: 0,
    },
    document: {
      get activeElement() {
        return activeElement;
      },
      set activeElement(value) {
        activeElement = value;
      },
      body,
      addEventListener(type, callback) {
        if (!documentEventListeners.has(type)) {
          documentEventListeners.set(type, new Set());
        }
        documentEventListeners.get(type).add(callback);
      },
      removeEventListener(type, callback) {
        documentEventListeners.get(type)?.delete(callback);
      },
      querySelectorAll(selector) {
        if (selector === ".tab") return tabs;
        if (selector === ".tab-panel") return panels;
        return [];
      },
      querySelector(selector) {
        const tabName = selector.match(
          /^\.tab\[data-tab="([^"]+)"\]$/,
        )?.[1];
        if (tabName) {
          return tabs.find((tab) => tab.dataset.tab === tabName) || null;
        }
        const panelName = selector.match(
          /^\.tab-panel\[data-panel="([^"]+)"\]$/,
        )?.[1];
        if (panelName) {
          return panels.find((panel) => panel.dataset.panel === panelName) || null;
        }
        const segmentId = selector.match(
          /^\.transcript-entry\[data-segment-id="([^"]+)"\]$/,
        )?.[1];
        const segmentIndex = selector.match(
          /^\.transcript-entry\[data-segment-index="([^"]+)"\]$/,
        )?.[1];
        return [...dynamicNodes].reverse().find((node) =>
          node.isConnected &&
          (segmentId
            ? node.dataset.segmentId === segmentId
            : segmentIndex
              ? String(node.dataset.segmentIndex) === segmentIndex
              : false)
        ) || null;
      },
      getElementById(id) {
        const existing =
          nodes[id] ||
          dynamicNodes.find((node) => node.id === id && node.isConnected) ||
          null;
        if (existing) return existing;
        if (id === "closeExplain" || id === "explanationContent") {
          const modal = dynamicNodes.find(
            (node) => node.id === "explainModal" && node.isConnected,
          );
          if (modal) {
            const child = createNode(id);
            dynamicNodes.push(child);
            modal.appendChild(child);
            return child;
          }
        }
        return null;
      },
      createElement(id) {
        const node = createNode(id);
        node.focus = () => {
          activeElement = node;
        };
        node.blur = () => {
          if (activeElement === node) activeElement = null;
        };
        dynamicNodes.push(node);
        return node;
      },
    },
    chrome: {
      runtime: {
        onMessage: {
          addListener(callback) {
            runtimeMessageListeners.push(callback);
          },
        },
        async sendMessage(message) {
          runtimeMessages.push(message);
          let response = options.sendMessage
            ? await options.sendMessage(message)
            : {};
          if (
            message.action === "bindVideoSession" &&
            (!response || Object.keys(response).length === 0)
          ) {
            response = { success: true };
          }
          if (
            message.sessionToken &&
            response &&
            typeof response === "object" &&
            options.autoEchoSessionToken !== false &&
            !response.sessionToken
          ) {
            return { ...response, sessionToken: message.sessionToken };
          }
          return response;
        },
      },
      storage: {
        local: {
          async get(query) {
            const result = options.storageGet
              ? await options.storageGet(query)
              : {};
            if (!options.storageCloneIntoVm) return result;
            sandbox.__storageCloneJson = JSON.stringify(result);
            return vm.runInContext("JSON.parse(__storageCloneJson)", vmContext);
          },
        },
        onChanged: {
          addListener(callback) {
            storageChangedListeners.push(callback);
          },
        },
      },
      windows: { getCurrent: async () => ({ id: 7 }) },
      tabs: {
        onUpdated: {
          addListener(callback) {
            tabUpdatedListeners.push(callback);
          },
        },
        onActivated: {
          addListener(callback) {
            tabActivatedListeners.push(callback);
          },
        },
        async query(query) {
          return options.tabsQuery ? options.tabsQuery(query) : [];
        },
        async get(tabId) {
          return options.tabsGet ? options.tabsGet(tabId) : null;
        },
        async create(options) {
          createdTabs.push(options);
        },
      },
    },
    YTD_SETTINGS: {},
  };
  sandbox.globalThis = sandbox;
  vmContext = vm.createContext(sandbox);
  vm.runInContext(read("transcript-core.js"), vmContext, {
    filename: "transcript-core.js",
  });
  vm.runInContext(read("overview-core.js"), vmContext, {
    filename: "overview-core.js",
  });
  vm.runInContext(read("sidepanel.js"), vmContext, { filename: "sidepanel.js" });
  return {
    helpers: sandbox.__YTD_TRANSCRIPT_TESTING__,
    nodes,
    tabs,
    panels,
    runtimeMessages,
    runtimeMessageListeners,
    tabUpdatedListeners,
    tabActivatedListeners,
    createdTabs,
    storageChangedListeners,
    dynamicNodes,
    getIntervalStarts: () => intervalStarts,
    getActiveIntervalCount: () => activeIntervals.size,
    getDocumentListenerCount: (type) =>
      documentEventListeners.get(type)?.size || 0,
    getActiveElement: () => activeElement,
    getScheduledTimeouts: () =>
      Array.from(allTimeouts, ([id, entry]) => ({
        id,
        delay: entry.delay,
        cleared: entry.cleared,
      })),
    runTimeout: async (timeoutId, { evenIfCleared = false } = {}) => {
      const entry = allTimeouts.get(timeoutId);
      assert.ok(entry, `timeout ${timeoutId} should exist`);
      if (entry.cleared && !evenIfCleared) return;
      scheduledTimeouts.delete(timeoutId);
      await entry.callback();
      await new Promise((resolve) => setImmediate(resolve));
    },
    dispatchDocumentEvent: async (type, event = {}) => {
      const callbacks = Array.from(documentEventListeners.get(type) || []);
      await Promise.all(callbacks.map((callback) => callback(event)));
    },
  };
}

function loadBackground({
  tabUrl = "https://www.youtube.com/watch?v=BBBBBB",
  tabPendingUrl = "",
  tabWindowId = 7,
  tabsGet,
  tabsSendMessage,
} = {}) {
  const listeners = [];
  const sent = [];
  const gets = [];
  const queries = [];
  const scripts = [];
  const broadcasts = [];
  const listener = () => ({ addListener() {} });
  const local = {
    async setAccessLevel() {},
    async get(query) {
      if (query === "ytd_reset_epoch") return { ytd_reset_epoch: 0 };
      return {};
    },
    async set() {},
    async remove() {},
    async getBytesInUse() { return 0; },
  };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    URL,
    TextDecoder,
    TextEncoder,
    AbortController,
    Uint8Array,
    Math,
    Date,
    crypto: {
      subtle: webcrypto.subtle,
      randomUUID: () => "test-id",
      getRandomValues: (bytes) => bytes,
    },
    fetch: async () => { throw new Error("Unexpected network request"); },
    setTimeout(callback) {
      callback();
      return 0;
    },
    clearTimeout() {},
    setInterval() { return 0; },
    clearInterval() {},
    chrome: {
      storage: { local },
      action: { onClicked: listener() },
      sidePanel: {
        setPanelBehavior() {},
        async setOptions() {},
        async open() {},
      },
      runtime: {
        onInstalled: listener(),
        onMessage: {
          addListener(fn) { listeners.push(fn); },
        },
        openOptionsPage() {},
        getURL: (resource) => `chrome-extension://test/${resource}`,
        async sendMessage(message) { broadcasts.push(message); },
      },
      tabs: {
        onUpdated: listener(),
        onActivated: listener(),
        async query(query) {
          queries.push(query);
          return [{ id: 11, url: "https://www.youtube.com/watch?v=AAAAAA" }];
        },
        async get(tabId) {
          gets.push(tabId);
          if (tabsGet) return tabsGet(tabId, gets.length);
          return {
            id: tabId,
            windowId: tabWindowId,
            url: tabUrl,
            ...(tabPendingUrl ? { pendingUrl: tabPendingUrl } : {}),
          };
        },
        async sendMessage(tabId, payload) {
          sent.push({ tabId, payload });
          if (tabsSendMessage) {
            return tabsSendMessage(tabId, payload, sent.length);
          }
          return { title: "DOM title" };
        },
      },
      scripting: {
        async executeScript(options) {
          scripts.push(options.target.tabId);
          return [{ result: { title: "Player title" } }];
        },
      },
    },
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  sandbox.importScripts = (...files) => {
    for (const file of files) vm.runInContext(read(file), context, { filename: file });
  };
  vm.runInContext(read("background.js"), context, { filename: "background.js" });

  function cloneIntoBackgroundRealm(value) {
    sandbox.__serializedMessageValue = JSON.stringify(value);
    try {
      return vm.runInContext(
        "JSON.parse(__serializedMessageValue)",
        context,
      );
    } finally {
      delete sandbox.__serializedMessageValue;
    }
  }

  async function send(
    message,
    sender = {
      documentId: "panel-document-1",
      url: "chrome-extension://test/sidepanel.html",
    },
  ) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) reject(new Error(`No response for ${message.action}`));
      }, 250);
      listeners[0](
        cloneIntoBackgroundRealm(message),
        cloneIntoBackgroundRealm(sender),
        (response) => {
          settled = true;
          clearTimeout(timeout);
          resolve(response);
        },
      );
    });
  }

  return { send, sent, gets, queries, scripts, broadcasts };
}

async function bindBackgroundSession(harness, sessionToken) {
  const response = await harness.send({
    action: "bindVideoSession",
    sessionToken,
  });
  assert.equal(response.success, true);
  return response;
}

test("VideoSession aborts its predecessor and distinguishes A-B-A", () => {
  const { createVideoSessionManager } = loadSidepanel().helpers;
  let id = 0;
  const manager = createVideoSessionManager(() => `session-${++id}`);
  const a1 = manager.begin({
    videoId: "AAAAAA",
    tabId: 11,
    windowId: 1,
    resetEpoch: 0,
  });
  const b = manager.begin({
    videoId: "BBBBBB",
    tabId: 12,
    windowId: 1,
    resetEpoch: 0,
  });
  const a2 = manager.begin({
    videoId: "AAAAAA",
    tabId: 11,
    windowId: 1,
    resetEpoch: 0,
  });

  assert.equal(a1.abortController.signal.aborted, true);
  assert.equal(b.abortController.signal.aborted, true);
  assert.equal(a2.abortController.signal.aborted, false);
  assert.equal(manager.isCurrent(a1), false);
  assert.equal(manager.isCurrent(b), false);
  assert.equal(manager.isCurrent(a2), true);
  assert.notEqual(a1.sessionId, a2.sessionId);
  assert.equal(a2.generation, 3);
  assert.ok(Object.isFrozen(manager.capture()));
});

test("VideoSession rejects ambiguous identity inputs", () => {
  const { createVideoSessionManager } = loadSidepanel().helpers;
  const manager = createVideoSessionManager(() => "session-1");
  for (const input of [
    null,
    { videoId: "", tabId: 1, windowId: 1, resetEpoch: 0 },
    { videoId: "AAAAAA", tabId: 1.5, windowId: 1, resetEpoch: 0 },
    { videoId: "AAAAAA", tabId: 1, windowId: -1, resetEpoch: 0 },
    { videoId: "AAAAAA", tabId: 1, windowId: 1, resetEpoch: -1 },
  ]) {
    assert.throws(() => manager.begin(input), { name: "TypeError" });
  }
});

test("independent panels use crypto entropy when randomUUID is unavailable", () => {
  let entropy = 0;
  const cryptoWithoutUuid = {
    getRandomValues(bytes) {
      entropy += 1;
      bytes.fill(entropy);
      return bytes;
    },
  };
  const firstManager = loadSidepanel({
    crypto: cryptoWithoutUuid,
  }).helpers.createVideoSessionManager();
  const secondManager = loadSidepanel({
    crypto: cryptoWithoutUuid,
  }).helpers.createVideoSessionManager();
  const identity = {
    videoId: "AAAAAA",
    tabId: 11,
    windowId: 7,
    resetEpoch: 0,
  };

  const first = firstManager.begin(identity);
  const second = secondManager.begin(identity);

  assert.notEqual(first.sessionId, second.sessionId);
  assert.ok(first.sessionId.length <= 160);
  assert.ok(second.sessionId.length <= 160);
});

test("same video in another tab or window always starts a distinct session", () => {
  const { createVideoSessionManager } = loadSidepanel().helpers;
  const manager = createVideoSessionManager(() => "stable-id");
  const first = manager.begin({
    videoId: "AAAAAA",
    tabId: 11,
    windowId: 1,
    resetEpoch: 0,
  });
  const otherTab = manager.begin({
    videoId: "AAAAAA",
    tabId: 12,
    windowId: 1,
    resetEpoch: 0,
  });
  const otherWindow = manager.begin({
    videoId: "AAAAAA",
    tabId: 12,
    windowId: 2,
    resetEpoch: 0,
  });

  assert.notEqual(first.sessionId, otherTab.sessionId);
  assert.notEqual(otherTab.sessionId, otherWindow.sessionId);
  assert.equal(manager.isCurrent(first), false);
  assert.equal(manager.isCurrent(otherTab), false);
  assert.equal(manager.isCurrent(otherWindow), true);
});

test("all deferred video effects silently reject session A after B begins", async () => {
  const { createVideoSessionManager } = loadSidepanel().helpers;
  let id = 0;
  const manager = createVideoSessionManager(() => `session-${++id}`);
  const a = manager.begin({ videoId: "AAAAAA", tabId: 11, windowId: 1, resetEpoch: 0 });
  const deferredEffects = [
    "metadata",
    "transcript",
    "cache",
    "notes",
    "translation",
    "playback",
    "export",
  ].map((name) => ({ name, ...deferred() }));
  const applied = [];
  const aWork = deferredEffects.map(({ name, promise }) =>
    promise.then(() => {
      if (manager.isCurrent(a)) applied.push(name);
    }),
  );

  const b = manager.begin({ videoId: "BBBBBB", tabId: 22, windowId: 1, resetEpoch: 0 });
  if (manager.isCurrent(b)) applied.push("B");
  deferredEffects.forEach(({ resolve }) => resolve());
  await Promise.all(aWork);

  assert.deepEqual(applied, ["B"]);
});

test("late metadata from A cannot replace B or start A transcript work", async () => {
  const metadataA = deferred();
  const harness = loadSidepanel({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      url: `https://www.youtube.com/watch?v=${tabId === 22 ? "BBBBBB" : "AAAAAA"}`,
    }),
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getResetEpoch") return { success: true, resetEpoch: 0 };
      if (
        message.action === "relayToContent" &&
        (message.tabId === 11 || message.tabId === 33)
      ) {
        return metadataA.promise;
      }
      if (message.action === "relayToContent") {
        return { success: true, response: { title: "Video B", channelName: "B" } };
      }
      if (message.action === "fetchTranscript") return transcriptResult("B");
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      return {};
    },
  });

  const aWork = harness.helpers.checkCurrentTab(11);
  await waitUntil(() =>
    harness.runtimeMessages.some(
      (message) => message.action === "relayToContent" && message.tabId === 11,
    ),
  );
  await harness.helpers.checkCurrentTab(22);
  metadataA.resolve({
    success: true,
    response: { title: "Late video A", channelName: "A" },
  });
  await aWork;

  const snapshot = harness.helpers.captureVideoSnapshot();
  assert.equal(snapshot.videoId, "BBBBBB");
  assert.equal(snapshot.videoTitle, "Video B");
  assert.equal(
    harness.runtimeMessages.some(
      (message) => message.action === "fetchTranscript" && message.videoId === "AAAAAA",
    ),
    false,
  );
});

test("a stale tab check cannot begin after its reset-epoch read resolves", async () => {
  const firstEpoch = deferred();
  let epochReads = 0;
  const harness = loadSidepanel({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      url: `https://www.youtube.com/watch?v=${tabId === 11 || tabId === 33 ? "AAAAAA" : "BBBBBB"}`,
    }),
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        epochReads += 1;
        return epochReads === 1
          ? firstEpoch.promise
          : { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: { title: "Video B" } };
      }
      if (message.action === "fetchTranscript") return transcriptResult("B");
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      return {};
    },
  });

  const aWork = harness.helpers.checkCurrentTab(11);
  await waitUntil(() => epochReads === 1);
  await harness.helpers.checkCurrentTab(22);
  firstEpoch.resolve({ success: true, resetEpoch: 0 });
  await aWork;

  const snapshot = harness.helpers.captureVideoSnapshot();
  assert.equal(snapshot.videoId, "BBBBBB");
  assert.equal(snapshot.videoTitle, "Video B");
  assert.equal(
    harness.runtimeMessages.some(
      (message) => message.action === "relayToContent" && message.tabId === 11,
    ),
    false,
  );
});

test("a reset event invalidates a pre-session epoch read", async () => {
  const epochRead = deferred();
  let epochRequested = false;
  const harness = loadSidepanel({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }),
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        epochRequested = true;
        return epochRead.promise;
      }
      return {};
    },
  });

  const staleCheck = harness.helpers.checkCurrentTab(11);
  await waitUntil(() => epochRequested);
  assert.equal(harness.storageChangedListeners.length, 1);
  harness.storageChangedListeners[0](
    { ytd_reset_epoch: { oldValue: 0, newValue: 1 } },
    "local",
  );
  epochRead.resolve({ success: true, resetEpoch: 0 });
  await staleCheck;

  assert.equal(harness.helpers.captureVideoSnapshot(), null);
  assert.equal(
    harness.runtimeMessages.some(
      (message) => message.action === "relayToContent",
    ),
    false,
  );
});

test("reset invalidates an activated tab lookup before it can schedule a refresh", async () => {
  const activatedTab = deferred();
  let activatedLookupStarted = false;
  const tab = {
    id: 22,
    windowId: 7,
    active: true,
    url: "https://www.youtube.com/watch?v=BBBBBB",
  };
  const harness = loadSidepanel({
    captureTimeouts: true,
    tabsGet: async () => {
      activatedLookupStarted = true;
      await activatedTab.promise;
      return tab;
    },
    tabsQuery: async () => [tab],
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 1 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: { title: "Video B" } };
      }
      if (message.action === "fetchTranscript") return transcriptResult("B");
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      return {};
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  const activation = harness.tabActivatedListeners[0]({
    tabId: 22,
    windowId: 7,
  });
  await waitUntil(() => activatedLookupStarted);
  harness.storageChangedListeners[0](
    { ytd_reset_epoch: { oldValue: 0, newValue: 1 } },
    "local",
  );
  const countedActions = new Set([
    "getResetEpoch",
    "bindVideoSession",
    "fetchTranscript",
    "persistDigestBase",
  ]);
  const countsBefore = Object.fromEntries(
    Array.from(countedActions, (action) => [
      action,
      harness.runtimeMessages.filter((message) => message.action === action).length,
    ]),
  );

  activatedTab.resolve();
  await activation;
  const lateRefresh = harness
    .getScheduledTimeouts()
    .find((timer) => timer.delay === 600 && !timer.cleared);
  if (lateRefresh) await harness.runTimeout(lateRefresh.id);

  const countsAfter = Object.fromEntries(
    Array.from(countedActions, (action) => [
      action,
      harness.runtimeMessages.filter((message) => message.action === action).length,
    ]),
  );
  assert.equal(lateRefresh, undefined);
  assert.deepEqual(countsAfter, countsBefore);
  assert.equal(harness.helpers.captureVideoSnapshot(), null);
  assert.equal(harness.nodes.welcomeState.style.display, "flex");
});

test("reset cancels an already scheduled navigation refresh generation", async () => {
  let currentVideoId = "AAAAAA";
  let resetEpoch = 0;
  const activeTab = () => ({
    id: 11,
    windowId: 7,
    active: true,
    url: `https://www.youtube.com/watch?v=${currentVideoId}`,
  });
  const harness = loadSidepanel({
    captureTimeouts: true,
    tabsGet: async () => activeTab(),
    tabsQuery: async () => [activeTab()],
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: { title: currentVideoId } };
      }
      if (message.action === "fetchTranscript") {
        return transcriptResult(currentVideoId);
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      return {};
    },
  });
  await harness.helpers.checkCurrentTab(11);

  currentVideoId = "BBBBBB";
  harness.tabUpdatedListeners[0](
    11,
    { url: "https://www.youtube.com/watch?v=BBBBBB" },
    activeTab(),
  );
  const refresh = harness
    .getScheduledTimeouts()
    .filter((timer) => timer.delay === 600)
    .at(-1);
  assert.ok(refresh, "navigation refresh should be scheduled");

  resetEpoch = 1;
  harness.storageChangedListeners[0](
    { ytd_reset_epoch: { oldValue: 0, newValue: 1 } },
    "local",
  );
  const countedActions = new Set([
    "getResetEpoch",
    "bindVideoSession",
    "fetchTranscript",
    "persistDigestBase",
  ]);
  const countsBefore = Object.fromEntries(
    Array.from(countedActions, (action) => [
      action,
      harness.runtimeMessages.filter((message) => message.action === action).length,
    ]),
  );

  await harness.runTimeout(refresh.id, { evenIfCleared: true });
  const countsAfter = Object.fromEntries(
    Array.from(countedActions, (action) => [
      action,
      harness.runtimeMessages.filter((message) => message.action === action).length,
    ]),
  );

  assert.equal(
    harness.getScheduledTimeouts().find((timer) => timer.id === refresh.id)?.cleared,
    true,
  );
  assert.deepEqual(countsAfter, countsBefore);
  assert.equal(harness.helpers.captureVideoSnapshot(), null);
});

test("a front-tab URL event invalidates a query that has not begun a session", async () => {
  const tabQuery = deferred();
  let queryRequested = false;
  const harness = loadSidepanel({
    tabsQuery() {
      queryRequested = true;
      return tabQuery.promise;
    },
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      return {};
    },
  });

  const staleCheck = harness.helpers.checkCurrentTab();
  await waitUntil(() => queryRequested);
  assert.equal(harness.tabUpdatedListeners.length, 1);
  harness.tabUpdatedListeners[0](
    22,
    { url: "https://www.youtube.com/watch?v=BBBBBB" },
    {
      id: 22,
      active: true,
      windowId: 7,
      url: "https://www.youtube.com/watch?v=BBBBBB",
    },
  );
  tabQuery.resolve([
    {
      id: 11,
      active: true,
      windowId: 7,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    },
  ]);
  await staleCheck;

  assert.equal(
    harness.runtimeMessages.some(
      (message) => message.action === "getResetEpoch",
    ),
    false,
  );
  assert.equal(harness.helpers.captureVideoSnapshot(), null);
});

test("an identified button target invalidates old work before its epoch arrives", async () => {
  const lateMetadataA = deferred();
  const epochB = deferred();
  let epochReads = 0;
  let metadataAReads = 0;
  const harness = loadSidepanel({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      url: `https://www.youtube.com/watch?v=${tabId === 11 ? "AAAAAA" : "BBBBBB"}`,
    }),
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        epochReads += 1;
        return epochReads === 3
          ? epochB.promise
          : { success: true, resetEpoch: 0 };
      }
      if (
        message.action === "relayToContent" &&
        (message.tabId === 11 || message.tabId === 33)
      ) {
        metadataAReads += 1;
        return metadataAReads === 2
          ? lateMetadataA.promise
          : { success: true, response: { title: "Video A" } };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: { title: "Video B" } };
      }
      if (message.action === "fetchTranscript") {
        return transcriptResult(message.videoId === "AAAAAA" ? "A" : "B");
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      return {};
    },
  });

  await harness.helpers.checkCurrentTab(11);
  const refreshA = harness.helpers.checkCurrentTab(33);
  await waitUntil(() => metadataAReads === 2);
  const loadB = harness.helpers.checkCurrentTab(22);
  await waitUntil(() => epochReads === 3);

  lateMetadataA.resolve({
    success: true,
    response: { title: "Late A must be ignored" },
  });
  await refreshA;
  assert.notEqual(harness.nodes.videoTitle.textContent, "Late A must be ignored");
  assert.equal(
    harness.runtimeMessages.filter(
      (message) =>
        message.action === "fetchTranscript" && message.videoId === "AAAAAA",
    ).length,
    1,
  );

  epochB.resolve({ success: true, resetEpoch: 0 });
  await loadB;
  assert.equal(harness.helpers.captureVideoSnapshot().videoId, "BBBBBB");
});

test("a duplicate same-tab video check reuses the in-flight session", async () => {
  const transcript = deferred();
  let metadataCalls = 0;
  let transcriptCalls = 0;
  const harness = loadSidepanel({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }),
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        metadataCalls += 1;
        return {
          success: true,
          response: { title: "Video A", channelName: "Channel A" },
        };
      }
      if (message.action === "fetchTranscript") {
        transcriptCalls += 1;
        return transcript.promise;
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      return {};
    },
  });

  const first = harness.helpers.checkCurrentTab(11);
  await waitUntil(() => transcriptCalls === 1);
  const firstToken = harness.helpers.captureVideoSnapshot().token;
  const duplicate = harness.helpers.checkCurrentTab(11);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(metadataCalls, 1);
  assert.equal(transcriptCalls, 1);
  assert.equal(
    harness.helpers.captureVideoSnapshot().token.sessionId,
    firstToken.sessionId,
  );

  transcript.resolve(transcriptResult("A"));
  await Promise.all([first, duplicate]);
});

test("worker restart recovery shares one bind and retries only SESSION_UNKNOWN", async () => {
  const rebindStarted = deferred();
  const rebindGate = deferred();
  let bindCalls = 0;
  let probeCalls = 0;
  let probeMode = "success";
  const harness = loadSidepanel({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }),
    storageGet: async () => ({}),
    async sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "bindVideoSession") {
        bindCalls += 1;
        if (bindCalls === 2) {
          rebindStarted.resolve();
          await rebindGate.promise;
        }
        return { success: true };
      }
      if (message.action === "probeBoundSession") {
        probeCalls += 1;
        if (probeMode === "unknown" && probeCalls <= 2) {
          return { success: false, code: "SESSION_UNKNOWN" };
        }
        if (probeMode === "stale") {
          return { success: false, code: "SESSION_STALE" };
        }
        return { success: true };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: { title: "Video A" } };
      }
      if (message.action === "fetchTranscript") {
        return transcriptResult("A");
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      return {};
    },
  });
  await harness.helpers.checkCurrentTab(11);
  const token = harness.helpers.captureVideoSnapshot().token;

  probeMode = "unknown";
  const first = harness.helpers.sendVideoSessionMessage(
    { action: "probeBoundSession" },
    token,
  );
  const second = harness.helpers.sendVideoSessionMessage(
    { action: "probeBoundSession" },
    token,
  );
  await rebindStarted.promise;
  assert.equal(bindCalls, 2);
  rebindGate.resolve();
  assert.equal((await first).success, true);
  assert.equal((await second).success, true);
  assert.equal(bindCalls, 2);
  assert.equal(probeCalls, 4);

  probeMode = "success";
  assert.equal(
    (await harness.helpers.sendVideoSessionMessage(
      { action: "probeBoundSession" },
      token,
    )).success,
    true,
  );
  assert.equal(bindCalls, 2);

  probeMode = "stale";
  const stale = await harness.helpers.sendVideoSessionMessage(
    { action: "probeBoundSession" },
    token,
  );
  assert.equal(stale.code, "SESSION_STALE");
  assert.equal(bindCalls, 2);
});

test("late transcript from A cannot render or persist after B", async () => {
  const transcriptA = deferred();
  const harness = loadSidepanel({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      url: `https://www.youtube.com/watch?v=${tabId === 11 ? "AAAAAA" : "BBBBBB"}`,
    }),
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getResetEpoch") return { success: true, resetEpoch: 0 };
      if (message.action === "relayToContent") {
        const label = message.tabId === 11 ? "A" : "B";
        return { success: true, response: { title: `Video ${label}` } };
      }
      if (message.action === "fetchTranscript" && message.videoId === "AAAAAA") {
        return transcriptA.promise;
      }
      if (message.action === "fetchTranscript") return transcriptResult("B");
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      return {};
    },
  });

  const aWork = harness.helpers.checkCurrentTab(11);
  await waitUntil(() =>
    harness.runtimeMessages.some(
      (message) => message.action === "fetchTranscript" && message.videoId === "AAAAAA",
    ),
  );
  await harness.helpers.checkCurrentTab(22);
  transcriptA.resolve(transcriptResult("late A"));
  await aWork;

  const snapshot = harness.helpers.captureVideoSnapshot();
  assert.equal(snapshot.videoId, "BBBBBB");
  assert.equal(snapshot.transcriptText, "B transcript.");
  assert.equal(
    harness.runtimeMessages.some(
      (message) => message.action === "persistDigestBase" && message.videoId === "AAAAAA",
    ),
    false,
  );
});

test("fresh transcript persistence records its session-bound SHA-256 fingerprint", async () => {
  const harness = loadSidepanel({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }),
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: { title: "Video A" } };
      }
      if (message.action === "fetchTranscript") return transcriptResult("A");
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      return {};
    },
  });

  await harness.helpers.checkCurrentTab(11);

  const persisted = harness.runtimeMessages.find(
    (message) => message.action === "persistDigestBase",
  );
  assert.ok(persisted);
  assert.deepEqual(Object.keys(persisted.value).sort(), [
    "channelName",
    "transcript",
    "transcriptFingerprint",
    "transcriptLanguage",
    "transcriptText",
    "transcriptTimestamped",
    "videoTitle",
  ]);
  assert.match(
    persisted.value.transcriptFingerprint,
    /^sha256-v1-[a-f0-9]{64}$/,
  );
  const snapshot = harness.helpers.captureVideoSnapshot();
  assert.equal(snapshot.transcriptFingerprint, persisted.value.transcriptFingerprint);
  assert.equal(
    snapshot.transcriptSegments,
    harness.helpers.getActiveTranscriptSegments(),
  );
  assert.ok(Object.isFrozen(snapshot.transcriptSegments));
  assert.ok(snapshot.transcriptSegments.every(Object.isFrozen));
  assert.equal(
    persisted.value.transcriptFingerprint,
    await transcriptCore.fingerprintSegments(
      structuredClone(snapshot.transcriptSegments),
      { sourceLanguage: "en", crypto: webcrypto },
    ),
  );
});

test("chunk language isolates identical fresh transcripts when top-level language is absent", async () => {
  const persistForLanguage = async (language) => {
    const harness = loadSidepanel({
      tabsGet: async (tabId) => ({
        id: tabId,
        windowId: 7,
        active: true,
        url: "https://www.youtube.com/watch?v=AAAAAA",
      }),
      storageGet: async () => ({}),
      sendMessage(message) {
        if (message.action === "getResetEpoch") {
          return { success: true, resetEpoch: 0 };
        }
        if (message.action === "relayToContent") {
          return { success: true, response: { title: "Same video" } };
        }
        if (message.action === "fetchTranscript") {
          return {
            success: true,
            transcript: [
              {
                start: 0,
                duration: 2,
                text: "Identical transcript.",
                language,
              },
            ],
            transcriptText: "Identical transcript.",
            transcriptTextTimestamped: "[0:00] Identical transcript.",
            language: null,
          };
        }
        if (message.action === "getNotes") return { success: true, notes: [] };
        if (message.action === "persistDigestBase") return digestBaseSuccess();
        return {};
      },
    });

    await harness.helpers.checkCurrentTab(11);
    return harness.runtimeMessages.find(
      (message) => message.action === "persistDigestBase",
    ).value;
  };

  const english = await persistForLanguage("en");
  const french = await persistForLanguage("fr");

  assert.equal(english.transcriptLanguage, "en");
  assert.equal(french.transcriptLanguage, "fr");
  assert.notEqual(english.transcriptFingerprint, french.transcriptFingerprint);
});

test("same-digest legacy translations persist under the computed fingerprint", async () => {
  const legacyKey = "AAAAAA:zh:semantic:segment-0-0";
  const harness = loadSidepanel({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }),
    storageGet: async (query) =>
      query === "digest_AAAAAA"
        ? {
            digest_AAAAAA: {
              timestamp: Date.now(),
              transcript: transcriptResult("cached A").transcript.map((entry) => ({
                ...entry,
                language: "en",
              })),
              transcriptText: "cached A transcript.",
              transcriptTimestamped: "[0:00] cached A transcript.",
              transcriptLanguage: null,
              paragraphCache: { [legacyKey]: "缓存译文。" },
            },
          }
        : {},
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: {} };
      }
      if (message.action === "fetchTranscript") {
        throw new Error("same-digest migration must reuse the cached transcript");
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      return {};
    },
  });

  await harness.helpers.checkCurrentTab(11);
  await waitUntil(() =>
    harness.runtimeMessages.some(
      (message) => message.action === "persistDigestBase",
    ),
  );

  const persisted = harness.runtimeMessages.find(
    (message) => message.action === "persistDigestBase",
  );
  const fingerprint = persisted.value.transcriptFingerprint;
  assert.equal(persisted.value.transcriptLanguage, "en");
  assert.equal(Object.hasOwn(persisted.value, "paragraphCache"), false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      harness.helpers.getTranscriptParagraphCacheEntries(),
    )),
    [[`AAAAAA:${fingerprint}:zh:semantic:segment-0-0`, "缓存译文。"]],
  );
});

test("deep analysis success persists only an exact deepAnalysis patch", async () => {
  const nextAnalysis = completeDeepAnalysis("Patched deep");
  const harness = loadSidepanel({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }),
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: { title: "Video A" } };
      }
      if (message.action === "fetchTranscript") return transcriptResult("A");
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      if (message.action === "analyzeTranscript") {
        return { success: true, analysis: nextAnalysis };
      }
      if (message.action === "patchDigestCache") return { success: true };
      if (message.action === "getNotes") return { success: true, notes: [] };
      return {};
    },
  });

  await harness.helpers.checkCurrentTab(11);
  await harness.helpers.triggerAnalysis(true);

  const patches = harness.runtimeMessages.filter(
    (message) => message.action === "patchDigestCache",
  );
  assert.equal(patches.length, 1, JSON.stringify(harness.runtimeMessages));
  assert.deepEqual(JSON.parse(JSON.stringify(patches[0].patch)), {
    deepAnalysis: nextAnalysis,
  });
  assert.match(patches[0].transcriptFingerprint, /^sha256-v1-[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(patches[0].patch, "paragraphCache"), false);
});

test("translation persists only successful entries from the current batch delta", async () => {
  let baseCalls = 0;
  let translationCalls = 0;
  let patchCalls = 0;
  const transcript = [
    {
      start: 0,
      duration: 2,
      text: "First source sentence is long enough to become a semantic paragraph.",
      language: "en",
    },
    {
      start: 30,
      duration: 2,
      text: "Second source sentence is also long enough to remain separate.",
      language: "en",
    },
  ];
  const harness = loadSidepanel({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }),
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: { title: "Video A" } };
      }
      if (message.action === "fetchTranscript") {
        return {
          success: true,
          transcript,
          transcriptText: transcript.map((entry) => entry.text).join(" "),
          transcriptTextTimestamped: transcript
            .map((entry) => `[0:${String(entry.start).padStart(2, "0")}] ${entry.text}`)
            .join("\n"),
          language: "en",
        };
      }
      if (message.action === "persistDigestBase") {
        baseCalls += 1;
        return digestBaseSuccess();
      }
      if (message.action === "translateContent") {
        translationCalls += 1;
        return {
          success: true,
          translatedContent: {
            segments: [{
              id: message.content.segments[0].id,
              text: "只有第一段成功",
            }],
          },
        };
      }
      if (message.action === "patchDigestCache") {
        patchCalls += 1;
        return patchCalls === 1
          ? { success: false, code: "DIGEST_EXPIRED" }
          : { success: true };
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      return {};
    },
  });

  await harness.helpers.checkCurrentTab(11);
  await harness.helpers.handleTranscriptModeChange("zh");
  await waitUntil(() => harness.runtimeMessages.some(
    (message) => message.action === "patchDigestCache",
  ));

  const patches = harness.runtimeMessages.filter(
    (message) => message.action === "patchDigestCache",
  );
  const patch = patches.at(-1);
  assert.equal(translationCalls, 1, "cache recovery must not repeat provider");
  assert.equal(baseCalls, 2, "expired patch must force exactly one rebase");
  assert.equal(patches.length, 2, "only the cache patch may retry once");
  assert.deepEqual(Object.values(JSON.parse(JSON.stringify(
    patch.patch.paragraphCache,
  ))), ["只有第一段成功"]);
  assert.equal(Object.hasOwn(patch.patch, "deepAnalysis"), false);
});

test("a delayed fingerprint from A cannot overwrite B or persist A", async () => {
  const firstDigestGate = deferred();
  let digestCalls = 0;
  const cryptoRuntime = {
    randomUUID: () => `session-${digestCalls}`,
    async getRandomValues(target) {
      return webcrypto.getRandomValues(target);
    },
    subtle: {
      async digest(algorithm, bytes) {
        digestCalls += 1;
        if (digestCalls === 1) await firstDigestGate.promise;
        return webcrypto.subtle.digest(algorithm, bytes);
      },
    },
  };
  const harness = loadSidepanel({
    crypto: cryptoRuntime,
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: `https://www.youtube.com/watch?v=${tabId === 11 ? "AAAAAA" : "BBBBBB"}`,
    }),
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: { title: message.sessionToken.videoId } };
      }
      if (message.action === "fetchTranscript") {
        return transcriptResult(message.videoId === "AAAAAA" ? "A" : "B");
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      return {};
    },
  });

  const aWork = harness.helpers.checkCurrentTab(11);
  await waitUntil(() => digestCalls === 1);
  await harness.helpers.checkCurrentTab(22);
  firstDigestGate.resolve();
  await aWork;

  const snapshot = harness.helpers.captureVideoSnapshot();
  assert.equal(snapshot.videoId, "BBBBBB");
  assert.equal(snapshot.transcriptText, "B transcript.");
  assert.match(snapshot.transcriptFingerprint, /^sha256-v1-[a-f0-9]{64}$/);
  assert.equal(
    harness.runtimeMessages.some(
      (message) =>
        message.action === "persistDigestBase" &&
        message.videoId === "AAAAAA",
    ),
    false,
  );
});

test("strict digest v2 cache view is whitelisted and normalizes cached overview", async () => {
  const { normalizeCachedDigestView } = loadSidepanel().helpers;
  assert.equal(typeof normalizeCachedDigestView, "function");
  const now = 2_000_000_000_000;
  const transcript = transcriptResult("cached A").transcript;
  const segments = transcriptCore.groupTranscriptEntries(transcript);
  const fingerprint = await transcriptCore.fingerprintSegments(segments, {
    sourceLanguage: "en",
  });
  let getterCalls = 0;
  const cached = {
    digestSchemaVersion: 2,
    timestamp: now - 1,
    transcript,
    transcriptText: "cached A transcript.",
    transcriptTimestamped: "[0:00] cached A transcript.",
    transcriptLanguage: " en ",
    transcriptFingerprint: fingerprint,
    videoTitle: "Cached title",
    channelName: "Cached channel",
    deepAnalysis: null,
    basicOverview: {
      schemaVersion: 999,
      transcriptFingerprint: fingerprint,
      generatedAt: now - 10,
      oneSentenceZh: "  可信的一句话  ",
      conclusions: [{
        id: "attacker-id",
        titleZh: "结论",
        explanationZh: "解释",
        evidenceLevel: "strong",
        evidenceSegmentIds: [segments[0].id, "invented"],
        unknown: "drop",
      }],
      chapters: [{
        titleZh: "第一章",
        summaryZh: "摘要",
        startSegmentId: segments[0].id,
        timestampSeconds: 99_999,
      }],
      unknown: "drop",
    },
    paragraphCache: {
      [`AAAAAA:${fingerprint}:zh:semantic:${segments[0].id}`]: "缓存翻译",
      attacker: "drop",
    },
    unknownTopLevel: "drop",
  };
  Object.defineProperty(cached, "unknownGetter", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("must never execute cache getters");
    },
  });
  Object.defineProperty(cached, "analysis", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("own deepAnalysis must prevent legacy analysis access");
    },
  });

  const view = await normalizeCachedDigestView(cached, {
    videoId: "AAAAAA",
    now,
  });
  const plain = JSON.parse(JSON.stringify(view));

  assert.equal(getterCalls, 0);
  assert.deepEqual(Object.keys(plain).sort(), [
    "basicOverview",
    "channelName",
    "deepAnalysis",
    "digestSchemaVersion",
    "needsBaseMigration",
    "paragraphCacheEntries",
    "paragraphCacheMigrated",
    "transcript",
    "transcriptFingerprint",
    "transcriptFingerprintUnavailable",
    "transcriptLanguage",
    "transcriptSegments",
    "transcriptText",
    "transcriptTimestamped",
    "videoTitle",
  ]);
  assert.equal(plain.deepAnalysis, null, "own v2 null must beat legacy analysis");
  assert.equal(plain.basicOverview.schemaVersion, 1);
  assert.equal(plain.basicOverview.oneSentenceZh, "可信的一句话");
  assert.deepEqual(plain.basicOverview.conclusions[0].evidenceSegmentIds, [
    segments[0].id,
  ]);
  assert.equal(plain.basicOverview.conclusions[0].evidenceLevel, "partial");
  assert.equal(plain.basicOverview.chapters[0].timestampSeconds, 0);
  assert.equal(Object.hasOwn(plain.basicOverview, "unknown"), false);
  assert.deepEqual(plain.paragraphCacheEntries, [
    [`AAAAAA:${fingerprint}:zh:semantic:${segments[0].id}`, "缓存翻译"],
  ]);
  assert.equal(plain.needsBaseMigration, false);
});

test("strict v2 cache requires every canonical base own field and ignores paragraph getters", async () => {
  const { normalizeCachedDigestView } = loadSidepanel().helpers;
  const now = 2_000_000_000_000;
  const transcript = transcriptResult("cached A").transcript;
  const segments = transcriptCore.groupTranscriptEntries(transcript);
  const fingerprint = await transcriptCore.fingerprintSegments(segments, {
    sourceLanguage: "en",
  });
  const canonical = {
    digestSchemaVersion: 2,
    timestamp: now - 1,
    transcript,
    transcriptText: "cached A transcript.",
    transcriptTimestamped: "[0:00] cached A transcript.",
    transcriptLanguage: "en",
    transcriptFingerprint: fingerprint,
    videoTitle: "Cached title",
    channelName: "Cached channel",
    deepAnalysis: null,
  };
  for (const field of [
    "transcript",
    "transcriptText",
    "transcriptTimestamped",
    "transcriptLanguage",
    "transcriptFingerprint",
    "videoTitle",
    "channelName",
  ]) {
    const incomplete = { ...canonical };
    delete incomplete[field];
    assert.equal(
      await normalizeCachedDigestView(incomplete, { videoId: "AAAAAA", now }),
      null,
      `${field} must be required`,
    );
  }

  let paragraphGetterCalls = 0;
  const paragraphCache = {};
  Object.defineProperty(
    paragraphCache,
    `AAAAAA:${fingerprint}:zh:semantic:${segments[0].id}`,
    {
      enumerable: true,
      get() {
        paragraphGetterCalls += 1;
        throw new Error("must not execute paragraph getter");
      },
    },
  );
  const view = await normalizeCachedDigestView(
    { ...canonical, paragraphCache },
    { videoId: "AAAAAA", now },
  );
  assert.equal(paragraphGetterCalls, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(view.paragraphCacheEntries)), []);
});

test("strict cache view rechecks TTL and monotonic clock after fingerprint await", async () => {
  const transcript = transcriptResult("cached A").transcript;
  const segments = transcriptCore.groupTranscriptEntries(transcript);
  const fingerprint = await transcriptCore.fingerprintSegments(segments, {
    sourceLanguage: "en",
  });
  const boundary = 2_000_000_000_000;
  const base = {
    digestSchemaVersion: 2,
    timestamp: boundary - THIRTY_DAYS_MS,
    transcript,
    transcriptText: "cached A transcript.",
    transcriptTimestamped: "[0:00] cached A transcript.",
    transcriptLanguage: "en",
    transcriptFingerprint: fingerprint,
    videoTitle: "Cached title",
    channelName: "Cached channel",
  };

  let now = boundary - 1;
  const crossing = loadSidepanel({
    crypto: {
      randomUUID: () => "ttl-race",
      subtle: {
        async digest(algorithm, bytes) {
          now = boundary;
          return webcrypto.subtle.digest(algorithm, bytes);
        },
      },
    },
  }).helpers;
  assert.equal(
    await crossing.normalizeCachedDigestView(base, {
      videoId: "AAAAAA",
      now: () => now,
    }),
    null,
  );

  now = boundary;
  const rollback = loadSidepanel({
    crypto: {
      randomUUID: () => "clock-race",
      subtle: {
        async digest(algorithm, bytes) {
          now = boundary - 1;
          return webcrypto.subtle.digest(algorithm, bytes);
        },
      },
    },
  }).helpers;
  assert.equal(
    await rollback.normalizeCachedDigestView(
      { ...base, timestamp: boundary - 100 },
      { videoId: "AAAAAA", now: () => now },
    ),
    null,
  );
});

test("strict cache view rejects missing future and exact-30-day timestamps", async () => {
  const { normalizeCachedDigestView } = loadSidepanel().helpers;
  const now = 2_000_000_000_000;
  const transcript = transcriptResult("cached A").transcript;
  const segments = transcriptCore.groupTranscriptEntries(transcript);
  const fingerprint = await transcriptCore.fingerprintSegments(segments, {
    sourceLanguage: "en",
  });
  const base = {
    digestSchemaVersion: 2,
    transcript,
    transcriptText: "cached A transcript.",
    transcriptTimestamped: "[0:00] cached A transcript.",
    transcriptLanguage: "en",
    transcriptFingerprint: fingerprint,
    videoTitle: "Cached title",
    channelName: "Cached channel",
  };

  for (const timestamp of [undefined, now + 1, now - THIRTY_DAYS_MS]) {
    assert.equal(
      await normalizeCachedDigestView({ ...base, timestamp }, {
        videoId: "AAAAAA",
        now,
      }),
      null,
    );
  }
  assert.ok(
    await normalizeCachedDigestView(
      { ...base, timestamp: now - THIRTY_DAYS_MS + 1 },
      { videoId: "AAAAAA", now },
    ),
  );
});

test("strict cache view rejects a forged v2 fingerprint and drops mismatched Basic", async () => {
  const { normalizeCachedDigestView } = loadSidepanel().helpers;
  const now = 2_000_000_000_000;
  const transcript = transcriptResult("cached A").transcript;
  const segments = transcriptCore.groupTranscriptEntries(transcript);
  const fingerprint = await transcriptCore.fingerprintSegments(segments, {
    sourceLanguage: "en",
  });
  const base = {
    digestSchemaVersion: 2,
    timestamp: now - 1,
    transcript,
    transcriptText: "cached A transcript.",
    transcriptTimestamped: "[0:00] cached A transcript.",
    transcriptLanguage: "en",
    transcriptFingerprint: fingerprint,
    videoTitle: "Cached title",
    channelName: "Cached channel",
  };

  assert.equal(
    await normalizeCachedDigestView(
      { ...base, transcriptFingerprint: `sha256-v1-${"0".repeat(64)}` },
      { videoId: "AAAAAA", now },
    ),
    null,
  );
  const view = await normalizeCachedDigestView({
    ...base,
    basicOverview: {
      transcriptFingerprint: `sha256-v1-${"1".repeat(64)}`,
      generatedAt: now - 10,
      oneSentenceZh: "伪造摘要",
    },
  }, { videoId: "AAAAAA", now });
  assert.equal(view.basicOverview, null);
});

test("strict cache view preserves partial deep data and legacy missing-fingerprint provenance", async () => {
  const { normalizeCachedDigestView } = loadSidepanel().helpers;
  const now = 2_000_000_000_000;
  const transcript = transcriptResult("cached A").transcript;
  const segments = transcriptCore.groupTranscriptEntries(transcript);
  const partialDeep = {
    schemaVersion: 2,
    reportComplete: false,
    summary: { oneSentenceZh: "部分结果仍可见" },
  };
  const legacyKey = `AAAAAA:zh:semantic:${segments[0].id}`;
  const view = await normalizeCachedDigestView({
    timestamp: now - 1,
    transcript,
    transcriptText: "cached A transcript.",
    transcriptLanguage: "en",
    analysis: partialDeep,
    paragraphCache: { [legacyKey]: "旧翻译" },
  }, { videoId: "AAAAAA", now });

  assert.equal(view.digestSchemaVersion, 2);
  assert.equal(view.needsBaseMigration, true);
  assert.equal(view.deepAnalysis.summary.oneSentenceZh, "部分结果仍可见");
  assert.equal(view.paragraphCacheMigrated, true);
  assert.deepEqual(JSON.parse(JSON.stringify(view.paragraphCacheEntries)), [[
    `AAAAAA:${view.transcriptFingerprint}:zh:semantic:${segments[0].id}`,
    "旧翻译",
  ]]);

  const forged = await normalizeCachedDigestView({
    timestamp: now - 1,
    transcript,
    transcriptLanguage: "en",
    transcriptFingerprint: `sha256-v1-${"f".repeat(64)}`,
    analysis: partialDeep,
    paragraphCache: { [legacyKey]: "旧翻译" },
  }, { videoId: "AAAAAA", now });
  assert.equal(forged.needsBaseMigration, true);
  assert.equal(forged.deepAnalysis, null);
  assert.deepEqual(JSON.parse(JSON.stringify(forged.paragraphCacheEntries)), []);
});

test("legacy explicit or primitive derived provenance fails closed", async () => {
  const { normalizeCachedDigestView } = loadSidepanel().helpers;
  const now = 2_000_000_000_000;
  const transcript = transcriptResult("cached A").transcript;
  const partialDeep = {
    schemaVersion: 2,
    reportComplete: false,
    summary: { oneSentenceZh: "must drop" },
  };
  for (const transcriptFingerprint of ["", "   ", `sha256-v1-${"f".repeat(64)}`]) {
    const view = await normalizeCachedDigestView({
      timestamp: now - 1,
      transcript,
      transcriptText: "cached A transcript.",
      transcriptTimestamped: "[0:00] cached A transcript.",
      transcriptLanguage: "en",
      transcriptFingerprint,
      videoTitle: "A",
      channelName: "A",
      analysis: partialDeep,
      paragraphCache: {
        "AAAAAA:zh:semantic:segment-0-0": "must drop",
      },
    }, { videoId: "AAAAAA", now });
    assert.equal(view.deepAnalysis, null, JSON.stringify(transcriptFingerprint));
    assert.deepEqual(JSON.parse(JSON.stringify(view.paragraphCacheEntries)), []);
  }

  const segments = transcriptCore.groupTranscriptEntries(transcript);
  const fingerprint = await transcriptCore.fingerprintSegments(segments, {
    sourceLanguage: "en",
  });
  for (const primitive of ["forged", 1, true]) {
    const view = await normalizeCachedDigestView({
      digestSchemaVersion: 2,
      timestamp: now - 1,
      transcript,
      transcriptText: "cached A transcript.",
      transcriptTimestamped: "[0:00] cached A transcript.",
      transcriptLanguage: "en",
      transcriptFingerprint: fingerprint,
      videoTitle: "A",
      channelName: "A",
      deepAnalysis: primitive,
      analysis: partialDeep,
    }, { videoId: "AAAAAA", now });
    assert.equal(view.deepAnalysis, null, String(primitive));
  }

  const noCrypto = loadSidepanel({ crypto: null }).helpers;
  const unverified = await noCrypto.normalizeCachedDigestView({
    timestamp: now - 1,
    transcript,
    transcriptText: "cached A transcript.",
    transcriptTimestamped: "[0:00] cached A transcript.",
    transcriptLanguage: "en",
    transcriptFingerprint: fingerprint,
    videoTitle: "A",
    channelName: "A",
    analysis: partialDeep,
  }, { videoId: "AAAAAA", now });
  assert.equal(unverified.transcriptFingerprintUnavailable, true);
  assert.equal(unverified.deepAnalysis, null);

  const missingFingerprint = await noCrypto.normalizeCachedDigestView({
    timestamp: now - 1,
    transcript,
    transcriptText: "cached A transcript.",
    transcriptTimestamped: "[0:00] cached A transcript.",
    transcriptLanguage: "en",
    videoTitle: "A",
    channelName: "A",
    analysis: partialDeep,
  }, { videoId: "AAAAAA", now });
  assert.equal(
    missingFingerprint.deepAnalysis.summary.oneSentenceZh,
    "must drop",
  );
});

test("strict paragraph view enforces writer entry and value bounds", async () => {
  const { normalizeCachedDigestView } = loadSidepanel().helpers;
  const now = 2_000_000_000_000;
  const transcript = transcriptResult("cached A").transcript;
  const segments = transcriptCore.groupTranscriptEntries(transcript);
  const fingerprint = await transcriptCore.fingerprintSegments(segments, {
    sourceLanguage: "en",
  });
  const base = {
    digestSchemaVersion: 2,
    timestamp: now - 1,
    transcript,
    transcriptText: "cached A transcript.",
    transcriptTimestamped: "[0:00] cached A transcript.",
    transcriptLanguage: "en",
    transcriptFingerprint: fingerprint,
    videoTitle: "A",
    channelName: "A",
  };
  const matchingKey =
    `AAAAAA:${fingerprint}:zh:semantic:${segments[0].id}`;
  const oversizedValue = await normalizeCachedDigestView({
    ...base,
    paragraphCache: { [matchingKey]: "译".repeat(20_001) },
  }, { videoId: "AAAAAA", now });
  assert.deepEqual(
    JSON.parse(JSON.stringify(oversizedValue.paragraphCacheEntries)),
    [],
  );

  const tooMany = Object.fromEntries(
    Array.from({ length: 2_001 }, (_, index) => [`unknown-${index}`, "译"]),
  );
  tooMany[matchingKey] = "must drop with malformed aggregate";
  const overEntryLimit = await normalizeCachedDigestView({
    ...base,
    paragraphCache: tooMany,
  }, { videoId: "AAAAAA", now });
  assert.deepEqual(
    JSON.parse(JSON.stringify(overEntryLimit.paragraphCacheEntries)),
    [],
  );
});

test("malformed safe partial deep collections cannot block cached transcript rendering", async () => {
  const partialDeep = {
    schemaVersion: 2,
    reportComplete: false,
    summary: { oneSentenceZh: "仍可显示的部分结论" },
    chapters: [null, "bad"],
    keyInsights: [null, 1],
    argumentMap: [null],
    reviewQuestions: [null],
    keyQuotes: [null],
    keyMoments: [],
  };
  const harness = loadSidepanel({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }),
    storageGet: async (query) => query === "digest_AAAAAA" ? {
      digest_AAAAAA: {
        timestamp: Date.now(),
        transcript: transcriptResult("cached partial").transcript,
        transcriptText: "cached partial transcript.",
        transcriptTimestamped: "[0:00] cached partial transcript.",
        transcriptLanguage: "en",
        videoTitle: "Partial",
        channelName: "Channel",
        analysis: partialDeep,
      },
    } : {},
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: {} };
      }
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      if (message.action === "getNotes") return { success: true, notes: [] };
      return {};
    },
  });

  await harness.helpers.checkCurrentTab(11);

  assert.equal(harness.nodes.resultsState.style.display, "block");
  assert.equal(
    harness.helpers.captureVideoSnapshot().transcriptText,
    "cached partial transcript.",
  );
  assert.equal(
    harness.nodes.analysisOneSentence.textContent,
    "仍可显示的部分结论",
  );
  assert.equal(harness.nodes.chapterList.children.length, 0);
  assert.equal(harness.nodes.quotesList.children.length, 0);
});

test("malformed complete-summary scalar stays fail-soft and cannot enable exports", async () => {
  const harness = loadSidepanel({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }),
    storageGet: async (query) => query === "digest_AAAAAA" ? {
      digest_AAAAAA: {
        timestamp: Date.now(),
        transcript: transcriptResult("cached malformed").transcript,
        transcriptText: "cached malformed transcript.",
        transcriptTimestamped: "[0:00] cached malformed transcript.",
        transcriptLanguage: "en",
        videoTitle: "Malformed",
        channelName: "Channel",
        analysis: {
          schemaVersion: 2,
          reportComplete: true,
          summary: {
            oneSentenceZh: 1,
            executiveSummaryZh: "summary",
            coreThesisZh: "thesis",
            whyItMattersZh: "why",
          },
          chapters: [],
          keyInsights: [],
          argumentMap: [],
          reviewQuestions: [],
          keyQuotes: [],
          keyMoments: [],
        },
      },
    } : {},
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: {} };
      }
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      if (message.action === "getNotes") return { success: true, notes: [] };
      return {};
    },
  });

  await harness.helpers.checkCurrentTab(11);

  assert.equal(harness.nodes.resultsState.style.display, "block");
  assert.equal(harness.nodes.analysisExportReportBtn.disabled, true);
  assert.equal(harness.nodes.analysisExportStudyPackBtn.disabled, true);
});

test("loadFromCache consumes a VM-native strict v2 view and revalidates reset epoch", async () => {
  const now = Date.now();
  const transcript = transcriptResult("cached v2").transcript;
  const segments = transcriptCore.groupTranscriptEntries(transcript);
  const fingerprint = await transcriptCore.fingerprintSegments(segments, {
    sourceLanguage: "en",
  });
  const deepAnalysis = completeDeepAnalysis("Own v2 deep");
  let epochReads = 0;
  let transcriptFetches = 0;
  const harness = loadSidepanel({
    storageCloneIntoVm: true,
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }),
    storageGet: async (query) => query === "digest_AAAAAA" ? {
      digest_AAAAAA: {
        digestSchemaVersion: 2,
        timestamp: now,
        transcript,
        transcriptText: "cached v2 transcript.",
        transcriptTimestamped: "[0:00] cached v2 transcript.",
        transcriptLanguage: "en",
        transcriptFingerprint: fingerprint,
        videoTitle: "Cached v2 title",
        channelName: "Cached v2 channel",
        deepAnalysis,
        analysis: completeDeepAnalysis("Legacy must lose"),
        paragraphCache: {},
      },
    } : {},
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        epochReads += 1;
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: {} };
      }
      if (message.action === "fetchTranscript") {
        transcriptFetches += 1;
        return transcriptResult("paid fallback");
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      return {};
    },
  });

  await harness.helpers.checkCurrentTab(11);

  assert.equal(epochReads, 2, "cache commit must re-read reset generation");
  assert.equal(transcriptFetches, 0);
  const snapshot = harness.helpers.captureVideoSnapshot();
  assert.equal(snapshot.transcriptText, "cached v2 transcript.");
  assert.equal(snapshot.analysis.summary.oneSentenceZh, "Own v2 deep 的一句话结论");
});

test("a reset epoch change while cache fingerprinting prevents stale cache apply", async () => {
  const transcript = transcriptResult("stale cached v2").transcript;
  const segments = transcriptCore.groupTranscriptEntries(transcript);
  const fingerprint = await transcriptCore.fingerprintSegments(segments, {
    sourceLanguage: "en",
  });
  const digestGate = deferred();
  let digestStarted = false;
  let epoch = 0;
  let fetches = 0;
  const harness = loadSidepanel({
    storageCloneIntoVm: true,
    crypto: {
      randomUUID: () => "cache-race-session",
      subtle: {
        async digest(algorithm, bytes) {
          digestStarted = true;
          await digestGate.promise;
          return webcrypto.subtle.digest(algorithm, bytes);
        },
      },
    },
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }),
    storageGet: async (query) => query === "digest_AAAAAA" ? {
      digest_AAAAAA: {
        digestSchemaVersion: 2,
        timestamp: Date.now(),
        transcript,
        transcriptText: "stale cached v2 transcript.",
        transcriptTimestamped: "[0:00] stale cached v2 transcript.",
        transcriptLanguage: "en",
        transcriptFingerprint: fingerprint,
        videoTitle: "Stale title",
        channelName: "Stale channel",
        deepAnalysis: null,
        paragraphCache: {},
      },
    } : {},
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: epoch };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: {} };
      }
      if (message.action === "fetchTranscript") {
        fetches += 1;
        return {
          success: false,
          code: "SESSION_STALE",
          sessionToken: message.sessionToken,
        };
      }
      return {};
    },
  });

  const work = harness.helpers.checkCurrentTab(11);
  await waitUntil(() => digestStarted);
  epoch = 1;
  digestGate.resolve();
  await work;

  assert.equal(fetches, 1);
  assert.equal(harness.helpers.captureVideoSnapshot().transcript, null);
});

test("a late fresh-base acknowledgement from A cannot shorten B cache validity", async () => {
  let now = 2_000_000_000_000;
  const aTimestamp = now;
  const baseA = deferred();
  let bBaseWrites = 0;
  let bAnalysisCalls = 0;
  const harness = loadSidepanel({
    now: () => now,
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: `https://www.youtube.com/watch?v=${tabId === 11 ? "AAAAAA" : "BBBBBB"}`,
    }),
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: { title: message.sessionToken.videoId } };
      }
      if (message.action === "fetchTranscript") {
        return transcriptResult(message.videoId === "AAAAAA" ? "A" : "B");
      }
      if (message.action === "persistDigestBase") {
        if (message.videoId === "AAAAAA") return baseA.promise;
        bBaseWrites += 1;
        return digestBaseSuccess(now);
      }
      if (message.action === "analyzeTranscript") {
        bAnalysisCalls += 1;
        return { success: true, analysis: completeDeepAnalysis("B") };
      }
      if (message.action === "patchDigestCache") return { success: true };
      if (message.action === "getNotes") return { success: true, notes: [] };
      return {};
    },
  });

  const aWork = harness.helpers.checkCurrentTab(11);
  await waitUntil(() => harness.runtimeMessages.some(
    (message) => message.action === "persistDigestBase" && message.videoId === "AAAAAA",
  ));
  now += 1_000;
  await harness.helpers.checkCurrentTab(22);
  assert.equal(bBaseWrites, 1);
  baseA.resolve(digestBaseSuccess(aTimestamp));
  await aWork;

  now = aTimestamp + THIRTY_DAYS_MS + 500;
  await harness.helpers.triggerAnalysis(true);
  assert.equal(bAnalysisCalls, 1);
  assert.equal(
    bBaseWrites,
    1,
    "stale A must not replace B's later committed validity window",
  );
});

test("a late legacy migration failure from A cannot clear validated v2 B readiness", async () => {
  const baseA = deferred();
  const transcriptA = transcriptResult("cached A").transcript;
  const transcriptB = transcriptResult("cached B").transcript;
  const segmentsB = transcriptCore.groupTranscriptEntries(transcriptB);
  const fingerprintB = await transcriptCore.fingerprintSegments(segmentsB, {
    sourceLanguage: "en",
  });
  let bBaseWrites = 0;
  let bAnalysisCalls = 0;
  const harness = loadSidepanel({
    storageCloneIntoVm: true,
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: `https://www.youtube.com/watch?v=${tabId === 11 ? "AAAAAA" : "BBBBBB"}`,
    }),
    storageGet: async (query) => {
      if (query === "digest_AAAAAA") {
        return {
          digest_AAAAAA: {
            timestamp: Date.now(),
            transcript: transcriptA,
            transcriptText: "cached A transcript.",
            transcriptTimestamped: "[0:00] cached A transcript.",
            transcriptLanguage: "en",
            videoTitle: "A",
            channelName: "A",
          },
        };
      }
      if (query === "digest_BBBBBB") {
        return {
          digest_BBBBBB: {
            digestSchemaVersion: 2,
            timestamp: Date.now(),
            transcript: transcriptB,
            transcriptText: "cached B transcript.",
            transcriptTimestamped: "[0:00] cached B transcript.",
            transcriptLanguage: "en",
            transcriptFingerprint: fingerprintB,
            videoTitle: "B",
            channelName: "B",
            deepAnalysis: null,
          },
        };
      }
      return {};
    },
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: {} };
      }
      if (message.action === "persistDigestBase") {
        if (message.videoId === "AAAAAA") return baseA.promise;
        bBaseWrites += 1;
        return digestBaseSuccess();
      }
      if (message.action === "analyzeTranscript") {
        bAnalysisCalls += 1;
        return { success: true, analysis: completeDeepAnalysis("B") };
      }
      if (message.action === "patchDigestCache") return { success: true };
      if (message.action === "getNotes") return { success: true, notes: [] };
      return {};
    },
  });

  const aWork = harness.helpers.checkCurrentTab(11);
  await waitUntil(() => harness.runtimeMessages.some(
    (message) => message.action === "persistDigestBase" && message.videoId === "AAAAAA",
  ));
  await harness.helpers.checkCurrentTab(22);
  assert.equal(bBaseWrites, 0);
  baseA.resolve({ success: false, code: "STORAGE_WRITE_FAILED" });
  await aWork;

  await harness.helpers.triggerAnalysis(true);
  assert.equal(bAnalysisCalls, 1);
  assert.equal(bBaseWrites, 0, "validated v2 B must remain ready");
});

test("an expired cached base renews before Deep dispatch and a failed renewal stays free", async (t) => {
  for (const [name, renewalResult, expectedAnalysisCalls] of [
    ["renewal succeeds", { success: true, timestamp: 2_000_000_000_500 }, 1],
    ["renewal fails", { success: false, code: "STORAGE_WRITE_FAILED" }, 0],
    ["success is missing its committed timestamp", { success: true }, 0],
    ["success reports a future timestamp", { success: true, timestamp: 2_000_000_000_501 }, 0],
    [
      "success reports an exactly expired timestamp",
      { success: true, timestamp: 2_000_000_000_500 - THIRTY_DAYS_MS },
      0,
    ],
  ]) {
    await t.test(name, async () => {
      let now = 2_000_000_000_000;
      const renewal = deferred();
      const cached = await cachedDigestV2("near-expiry", {
        timestamp: now - THIRTY_DAYS_MS + 500,
        deepAnalysis: null,
      });
      let baseCalls = 0;
      let analysisCalls = 0;
      const harness = loadSidepanel({
        now: () => now,
        storageCloneIntoVm: true,
        tabsGet: async (tabId) => ({
          id: tabId,
          windowId: 7,
          active: true,
          url: "https://www.youtube.com/watch?v=AAAAAA",
        }),
        storageGet: async (query) =>
          query === "digest_AAAAAA" ? { digest_AAAAAA: cached } : {},
        sendMessage(message) {
          if (message.action === "getResetEpoch") {
            return { success: true, resetEpoch: 0 };
          }
          if (message.action === "relayToContent") {
            return { success: true, response: {} };
          }
          if (message.action === "getNotes") {
            return { success: true, notes: [] };
          }
          if (message.action === "persistDigestBase") {
            baseCalls += 1;
            return renewal.promise;
          }
          if (message.action === "analyzeTranscript") {
            analysisCalls += 1;
            return {
              success: true,
              analysis: completeDeepAnalysis("renewed"),
            };
          }
          if (message.action === "patchDigestCache") {
            return { success: true };
          }
          return {};
        },
      });

      await harness.helpers.checkCurrentTab(11);
      now += 500;
      const analysisWork = harness.helpers.triggerAnalysis(true);
      await waitUntil(() => baseCalls === 1);
      assert.equal(analysisCalls, 0, "provider must wait for durable renewal");
      renewal.resolve(renewalResult);
      await analysisWork;

      assert.equal(analysisCalls, expectedAnalysisCalls);
      assert.equal(baseCalls, 1);
    });
  }
});

test("failed Deep base renewal restores cached report controls and clears busy state", async () => {
  let now = 2_000_000_000_000;
  const renewal = deferred();
  const cachedAnalysis = completeDeepAnalysis("cached renewal failure");
  const cached = await cachedDigestV2("cached renewal failure", {
    timestamp: now - THIRTY_DAYS_MS + 500,
    deepAnalysis: cachedAnalysis,
  });
  let baseCalls = 0;
  let analysisCalls = 0;
  const harness = loadSidepanel({
    now: () => now,
    storageCloneIntoVm: true,
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }),
    storageGet: async (query) =>
      query === "digest_AAAAAA" ? { digest_AAAAAA: cached } : {},
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: {} };
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") {
        baseCalls += 1;
        return renewal.promise;
      }
      if (message.action === "analyzeTranscript") {
        analysisCalls += 1;
        return { success: true, analysis: completeDeepAnalysis("unexpected") };
      }
      return {};
    },
  });

  await harness.helpers.checkCurrentTab(11);
  assert.equal(harness.nodes.deepAnalysisResults.style.display, "block");
  now += 500;
  const work = harness.helpers.triggerAnalysis(true);
  await waitUntil(() => baseCalls === 1);
  assert.equal(harness.nodes.deepAnalysisCard.getAttribute("aria-busy"), "true");
  assert.equal(harness.nodes.regenerateAnalysisBtn.textContent, "正在生成…");

  renewal.resolve({ success: false, code: "STORAGE_WRITE_FAILED" });
  await work;

  assert.equal(analysisCalls, 0);
  assert.equal(harness.nodes.deepAnalysisCard.getAttribute("aria-busy"), "false");
  assert.equal(harness.nodes.deepAnalysisResults.style.display, "block");
  assert.equal(
    harness.nodes.analysisOneSentence.textContent,
    cachedAnalysis.summary.oneSentenceZh,
  );
  assert.equal(harness.nodes.regenerateAnalysisBtn.disabled, false);
  assert.match(harness.nodes.regenerateAnalysisBtn.textContent, /重试|重新/);
});

test("a paid Deep result rebases and retries only its cache patch after expiry", async () => {
  let now = 2_000_000_000_000;
  const cached = await cachedDigestV2("patch-expiry", {
    timestamp: now - THIRTY_DAYS_MS + 500,
    deepAnalysis: null,
  });
  let analysisCalls = 0;
  let baseCalls = 0;
  const patchCalls = [];
  const harness = loadSidepanel({
    now: () => now,
    storageCloneIntoVm: true,
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }),
    storageGet: async (query) =>
      query === "digest_AAAAAA" ? { digest_AAAAAA: cached } : {},
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: {} };
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "analyzeTranscript") {
        analysisCalls += 1;
        // The panel still sees one millisecond of freshness while the worker
        // crosses its own final mutation boundary and reports DIGEST_EXPIRED.
        now += 499;
        return {
          success: true,
          analysis: completeDeepAnalysis("paid once"),
        };
      }
      if (message.action === "persistDigestBase") {
        baseCalls += 1;
        return { success: true, timestamp: now };
      }
      if (message.action === "patchDigestCache") {
        patchCalls.push(JSON.parse(JSON.stringify(message.patch)));
        return patchCalls.length === 1
          ? { success: false, code: "DIGEST_EXPIRED" }
          : { success: true };
      }
      return {};
    },
  });

  await harness.helpers.checkCurrentTab(11);
  await harness.helpers.triggerAnalysis(true);

  assert.equal(analysisCalls, 1, "provider result must never be regenerated");
  assert.equal(baseCalls, 1, "expired patch must renew only the cache base");
  assert.equal(patchCalls.length, 2);
  assert.deepEqual(patchCalls[1], patchCalls[0]);
});

test("a clock rollback while base renewal awaits fails closed before Deep dispatch", async () => {
  let now = 2_000_000_000_000;
  const renewal = deferred();
  const cached = await cachedDigestV2("rollback", {
    timestamp: now - THIRTY_DAYS_MS + 1,
    deepAnalysis: null,
  });
  let baseCalls = 0;
  let analysisCalls = 0;
  const harness = loadSidepanel({
    now: () => now,
    storageCloneIntoVm: true,
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }),
    storageGet: async (query) =>
      query === "digest_AAAAAA" ? { digest_AAAAAA: cached } : {},
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: {} };
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") {
        baseCalls += 1;
        return renewal.promise;
      }
      if (message.action === "analyzeTranscript") {
        analysisCalls += 1;
        return { success: true, analysis: completeDeepAnalysis("forbidden") };
      }
      return {};
    },
  });

  await harness.helpers.checkCurrentTab(11);
  now += 1;
  const analysisWork = harness.helpers.triggerAnalysis(true);
  await waitUntil(() => baseCalls === 1);
  now -= 1;
  renewal.resolve({ success: true, timestamp: now });
  await analysisWork;

  assert.equal(analysisCalls, 0);
});

test("each delayed translation batch renews an expired base before provider dispatch", async () => {
  let now = 2_000_000_000_000;
  const renewal = deferred();
  const cached = await cachedDigestV2("translation-expiry", {
    timestamp: now - THIRTY_DAYS_MS + 500,
    deepAnalysis: null,
  });
  let baseCalls = 0;
  let translationCalls = 0;
  const harness = loadSidepanel({
    now: () => now,
    storageCloneIntoVm: true,
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }),
    storageGet: async (query) =>
      query === "digest_AAAAAA" ? { digest_AAAAAA: cached } : {},
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: {} };
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") {
        baseCalls += 1;
        return renewal.promise;
      }
      if (message.action === "translateContent") {
        translationCalls += 1;
        return {
          success: true,
          translatedContent: {
            segments: message.content.segments.map((segment) => ({
              id: segment.id,
              text: "译文",
            })),
          },
        };
      }
      if (message.action === "patchDigestCache") return { success: true };
      return {};
    },
  });

  await harness.helpers.checkCurrentTab(11);
  const translationWork = harness.helpers.handleTranscriptModeChange("zh");
  now += 500;
  await translationWork;
  await waitUntil(() => baseCalls === 1);
  assert.equal(translationCalls, 0);
  renewal.resolve({ success: true, timestamp: now });
  await waitUntil(() => translationCalls === 1);
  assert.equal(baseCalls, 1);
});

test("missing local Web Crypto displays a cached transcript without repurchasing it", async () => {
  let transcriptFetches = 0;
  const harness = loadSidepanel({
    crypto: null,
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }),
    storageGet: async (query) =>
      query === "digest_AAAAAA"
        ? {
            digest_AAAAAA: {
              timestamp: Date.now(),
              transcript: transcriptResult("cached A").transcript,
              transcriptText: "cached A transcript.",
              transcriptTimestamped: "[0:00] cached A transcript.",
              transcriptLanguage: "en",
            },
          }
        : {},
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: {} };
      }
      if (message.action === "fetchTranscript") {
        transcriptFetches += 1;
        return transcriptResult("paid fallback");
      }
      return {};
    },
  });

  await harness.helpers.checkCurrentTab(11);

  assert.equal(transcriptFetches, 0);
  assert.equal(harness.nodes.resultsState.style.display, "block");
  assert.equal(
    harness.helpers.captureVideoSnapshot().transcriptText,
    "cached A transcript.",
  );
  assert.equal(harness.helpers.captureVideoSnapshot().transcriptFingerprint, null);
  assert.match(
    harness.nodes.transcriptExportStatus.textContent,
    /Web Crypto|SHA-256/,
  );
  assert.equal(
    harness.runtimeMessages.some(
      (message) => message.action === "persistDigestBase",
    ),
    false,
  );
});

test("cached deep analysis stays viewable but Regenerate is blocked without a fingerprint", async () => {
  let analysisCalls = 0;
  const cachedAnalysis = completeDeepAnalysis("Cached secure fallback");
  const harness = loadSidepanel({
    crypto: null,
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }),
    storageGet: async (query) =>
      query === "digest_AAAAAA"
        ? {
            digest_AAAAAA: {
              timestamp: Date.now(),
              analysis: cachedAnalysis,
              transcript: transcriptResult("cached A").transcript,
              transcriptText: "cached A transcript.",
              transcriptTimestamped: "[0:00] cached A transcript.",
              transcriptLanguage: "en",
            },
          }
        : {},
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: {} };
      }
      if (message.action === "analyzeTranscript") {
        analysisCalls += 1;
        return { success: true, analysis: completeDeepAnalysis("New paid") };
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      return {};
    },
  });
  harness.helpers.setupEventListeners();

  await harness.helpers.checkCurrentTab(11);
  assert.equal(harness.nodes.resultsState.style.display, "block");
  assert.equal(
    harness.nodes.analysisOneSentence.textContent,
    "Cached secure fallback 的一句话结论",
  );

  await clickNode(harness.nodes.regenerateAnalysisBtn);

  assert.equal(analysisCalls, 0);
  assert.equal(harness.nodes.resultsState.style.display, "block");
  assert.equal(
    harness.nodes.analysisOneSentence.textContent,
    "Cached secure fallback 的一句话结论",
  );
  assert.match(harness.nodes.analysisStatus.textContent, /Web Crypto|SHA-256/);
  assert.equal(
    harness.runtimeMessages.some(
      (message) => message.action === "persistDigestBase",
    ),
    false,
  );
});

test("unfingerprinted cached transcripts never dispatch paid translation", async () => {
  let translationCalls = 0;
  const translationBatches = [];
  const transcript = [
    {
      start: 0,
      duration: 3,
      text: "First source sentence is deliberately long enough to form its own complete semantic paragraph.",
      language: "en",
    },
    {
      start: 30,
      duration: 3,
      text: "Second source sentence is also deliberately long enough to remain a separate semantic paragraph.",
      language: "en",
    },
  ];
  const harness = loadSidepanel({
    crypto: null,
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }),
    storageGet: async (query) =>
      query === "digest_AAAAAA"
        ? {
            digest_AAAAAA: {
              timestamp: Date.now(),
              transcript,
              transcriptText: transcript.map((entry) => entry.text).join(" "),
              transcriptTimestamped: transcript
                .map((entry, index) => `[0:${index ? "30" : "00"}] ${entry.text}`)
                .join("\n"),
              transcriptLanguage: null,
              paragraphCache: { "": "绝不能跨段复用的空键译文" },
            },
          }
        : {},
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: {} };
      }
      if (message.action === "translateContent") {
        translationCalls += 1;
        translationBatches.push(
          message.content.segments.map((segment) => ({ ...segment })),
        );
        return {
          success: true,
          translatedContent: {
            segments: message.content.segments.map((segment) => ({
              id: segment.id,
              text: segment.text.startsWith("First") ? "第一段译文" : "第二段译文",
            })),
          },
        };
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      return {};
    },
  });

  await harness.helpers.checkCurrentTab(11);
  await harness.helpers.handleTranscriptModeChange("zh");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(translationCalls, 0);
  assert.deepEqual(translationBatches, []);
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      harness.helpers.getTranscriptParagraphCacheEntries(),
    )),
    [],
  );

  await harness.helpers.handleTranscriptModeChange("original");
  await harness.helpers.handleTranscriptModeChange("zh");
  await harness.helpers.showExplanation("selected text");
  const vocabularyContent = { innerHTML: "", querySelector: () => null };
  await harness.helpers.generateVocabularyDraft({
    isConnected: true,
    querySelector(selector) {
      return selector === "#vocabularyCardContent" ? vocabularyContent : null;
    },
  }, { word: "source" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(translationCalls, 0);
  assert.equal(
    harness.runtimeMessages.some((message) =>
      ["explainSelection", "generateVocabularyCard"].includes(message.action)
    ),
    false,
  );
  assert.equal(
    harness.runtimeMessages.some(
      (message) => message.action === "persistDigestBase",
    ),
    false,
  );
});

test("missing local Web Crypto blocks a fresh paid fetch before dispatch and on retry", async () => {
  let transcriptFetches = 0;
  const harness = loadSidepanel({
    crypto: null,
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }),
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: {} };
      }
      if (message.action === "fetchTranscript") {
        transcriptFetches += 1;
        return transcriptResult("paid transcript");
      }
      return {};
    },
  });
  harness.helpers.setupEventListeners();

  await harness.helpers.checkCurrentTab(11);

  assert.equal(transcriptFetches, 0);
  assert.equal(harness.nodes.errorState.style.display, "block");
  assert.match(harness.nodes.errorMessage.textContent, /Web Crypto|SHA-256/);

  await clickNode(harness.nodes.errorBtn);
  assert.equal(transcriptFetches, 0);
});

test("a paid fresh transcript retries only its in-memory fingerprint", async () => {
  let transcriptFetches = 0;
  let digestCalls = 0;
  const harness = loadSidepanel({
    crypto: {
      randomUUID: () => "fingerprint-retry-session",
      subtle: {
        async digest(algorithm, bytes) {
          digestCalls += 1;
          if (digestCalls === 1) throw new Error("temporary local digest failure");
          return webcrypto.subtle.digest(algorithm, bytes);
        },
      },
    },
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }),
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: {} };
      }
      if (message.action === "fetchTranscript") {
        transcriptFetches += 1;
        return transcriptResult("paid transcript");
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      return {};
    },
  });
  harness.helpers.setupEventListeners();

  await harness.helpers.checkCurrentTab(11);

  assert.equal(transcriptFetches, 1);
  assert.equal(digestCalls, 1);
  assert.equal(harness.nodes.errorState.style.display, "block");

  await clickNode(harness.nodes.errorBtn);

  assert.equal(transcriptFetches, 1);
  assert.equal(digestCalls, 2);
  assert.equal(harness.nodes.resultsState.style.display, "block");
  assert.equal(
    harness.helpers.captureVideoSnapshot().transcriptText,
    "paid transcript transcript.",
  );
  assert.match(
    harness.helpers.captureVideoSnapshot().transcriptFingerprint,
    /^sha256-v1-[a-f0-9]{64}$/,
  );
});

test("late cache read from A cannot hydrate A or fetch after B", async () => {
  const cacheA = deferred();
  let cacheARequested = false;
  const harness = loadSidepanel({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      url: `https://www.youtube.com/watch?v=${tabId === 11 ? "AAAAAA" : "BBBBBB"}`,
    }),
    storageGet(query) {
      if (query === "digest_AAAAAA") {
        cacheARequested = true;
        return cacheA.promise;
      }
      return {};
    },
    sendMessage(message) {
      if (message.action === "getResetEpoch") return { success: true, resetEpoch: 0 };
      if (message.action === "relayToContent") {
        const label = message.tabId === 11 ? "A" : "B";
        return { success: true, response: { title: `Video ${label}` } };
      }
      if (message.action === "fetchTranscript") return transcriptResult("B");
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      return {};
    },
  });

  const aWork = harness.helpers.checkCurrentTab(11);
  await waitUntil(() =>
    harness.runtimeMessages.some(
      (message) => message.action === "relayToContent" && message.tabId === 11,
    ),
  );
  await waitUntil(() => cacheARequested);
  await harness.helpers.checkCurrentTab(22);
  cacheA.resolve({
    digest_AAAAAA: {
      ...transcriptResult("cached A"),
      transcriptTimestamped: "[0:00] cached A transcript.",
      timestamp: Date.now(),
    },
  });
  await aWork;

  const snapshot = harness.helpers.captureVideoSnapshot();
  assert.equal(snapshot.videoId, "BBBBBB");
  assert.equal(snapshot.transcriptText, "B transcript.");
  assert.equal(
    harness.runtimeMessages.some(
      (message) => message.action === "fetchTranscript" && message.videoId === "AAAAAA",
    ),
    false,
  );
});

test("late notes from A cannot replace the notes rendered for B", async () => {
  const notesA = deferred();
  const harness = loadSidepanel({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      url: `https://www.youtube.com/watch?v=${tabId === 11 ? "AAAAAA" : "BBBBBB"}`,
    }),
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: { title: `Video ${message.tabId}` } };
      }
      if (message.action === "fetchTranscript") {
        return transcriptResult(message.videoId === "AAAAAA" ? "A" : "B");
      }
      if (
        message.action === "getNotes" &&
        message.sessionToken.videoId === "AAAAAA"
      ) {
        return notesA.promise;
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      return {};
    },
  });

  await harness.helpers.checkCurrentTab(11);
  await waitUntil(() =>
    harness.runtimeMessages.some(
      (message) =>
        message.action === "getNotes" &&
        message.sessionToken.videoId === "AAAAAA",
    ),
  );
  await harness.helpers.checkCurrentTab(22);
  await waitUntil(() => harness.nodes.notesIntro.style.display === "block");

  notesA.resolve({
    success: true,
    notes: [
      {
        id: "late-a",
        videoId: "AAAAAA",
        timestamp: "0:01",
        timestampSeconds: 1,
        timestampedUrl: "https://www.youtube.com/watch?v=AAAAAA&t=1s",
        text: "Late A note",
      },
    ],
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.nodes.notesIntro.style.display, "block");
  assert.match(harness.nodes.notesIntro.textContent, /No notes/);
});

test("late translation from A cannot update cache or B transcript state", async () => {
  const translationA = deferred();
  let translationRequest;
  const harness = loadSidepanel({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      url: `https://www.youtube.com/watch?v=${tabId === 11 ? "AAAAAA" : "BBBBBB"}`,
    }),
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: { title: `Video ${message.tabId}` } };
      }
      if (message.action === "fetchTranscript") {
        return transcriptResult(message.videoId === "AAAAAA" ? "A" : "B");
      }
      if (message.action === "translateContent") {
        translationRequest = message;
        return translationA.promise;
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      return {};
    },
  });

  await harness.helpers.checkCurrentTab(11);
  const initialAPersists = harness.runtimeMessages.filter(
    (message) =>
      message.action === "persistDigestBase" && message.videoId === "AAAAAA",
  ).length;
  await harness.helpers.handleTranscriptModeChange("zh");
  await waitUntil(() => Boolean(translationRequest));
  await harness.helpers.checkCurrentTab(22);

  translationA.resolve({
    success: true,
    translatedContent: {
      segments: translationRequest.content.segments.map((segment) => ({
        id: segment.id,
        text: "迟到的 A 翻译",
      })),
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.helpers.captureVideoSnapshot().videoId, "BBBBBB");
  assert.equal(harness.helpers.captureVideoSnapshot().transcriptText, "B transcript.");
  assert.equal(
    harness.runtimeMessages.filter(
      (message) =>
        message.action === "persistDigestBase" &&
        message.videoId === "AAAAAA",
    ).length,
    initialAPersists,
  );
});

test("late playback from A cannot highlight rows after B begins", async () => {
  const playbackA = deferred();
  let playbackRequested = false;
  const harness = loadSidepanel({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      url: `https://www.youtube.com/watch?v=${tabId === 11 ? "AAAAAA" : "BBBBBB"}`,
    }),
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (
        message.action === "relayToContent" &&
        message.payload.action === "getCurrentTime"
      ) {
        playbackRequested = true;
        return playbackA.promise;
      }
      if (message.action === "relayToContent") {
        return { success: true, response: { title: `Video ${message.tabId}` } };
      }
      if (message.action === "fetchTranscript") {
        return transcriptResult(message.videoId === "AAAAAA" ? "A" : "B");
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      return {};
    },
  });

  await harness.helpers.checkCurrentTab(11);
  harness.helpers.switchTab("transcript");
  const entries = [createNode("entry-0"), createNode("entry-1")];
  entries[0].dataset.seconds = "0";
  entries[1].dataset.seconds = "10";
  harness.nodes.transcriptList.querySelectorAll = () => entries;
  const playbackWork = harness.helpers.playbackTrackingTick();
  await waitUntil(() => playbackRequested);
  await harness.helpers.checkCurrentTab(22);

  playbackA.resolve({ success: true, response: { currentTime: 5 } });
  await playbackWork;
  assert.equal(entries[0].classList.contains("active-playback"), false);
  assert.equal(entries[1].classList.contains("active-playback"), false);
});

test("playback polling is single-flight within one video session", async () => {
  const playbackGate = deferred();
  let playbackCalls = 0;
  const harness = loadSidepanel({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }),
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        if (message.payload?.action === "getCurrentTime") {
          playbackCalls += 1;
          return playbackGate.promise;
        }
        return { success: true, response: { title: "Video A" } };
      }
      if (message.action === "fetchTranscript") return transcriptResult("A");
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      return {};
    },
  });
  await harness.helpers.checkCurrentTab(11);
  harness.helpers.switchTab("transcript");

  const first = harness.helpers.playbackTrackingTick();
  await waitUntil(() => playbackCalls === 1);
  const second = harness.helpers.playbackTrackingTick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(playbackCalls, 1);

  playbackGate.resolve({ success: true, response: { currentTime: 1 } });
  await Promise.all([first, second]);
  assert.equal(playbackCalls, 1);
});

test("playback tick does not query the player while Overview is active", async () => {
  let playbackCalls = 0;
  const harness = loadSidepanel({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }),
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        if (message.payload?.action === "getCurrentTime") playbackCalls += 1;
        return { success: true, response: { title: "Video A", currentTime: 1 } };
      }
      if (message.action === "fetchTranscript") return transcriptResult("A");
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      return {};
    },
  });
  await harness.helpers.checkCurrentTab(11);

  await harness.helpers.playbackTrackingTick();

  assert.equal(playbackCalls, 0);
});

test("pending playback does not highlight after leaving Transcript", async () => {
  const playbackGate = deferred();
  let playbackCalls = 0;
  const harness = loadSidepanel({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }),
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        if (message.payload?.action === "getCurrentTime") {
          playbackCalls += 1;
          return playbackGate.promise;
        }
        return { success: true, response: { title: "Video A" } };
      }
      if (message.action === "fetchTranscript") return transcriptResult("A");
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      return {};
    },
  });
  await harness.helpers.checkCurrentTab(11);
  const entries = [createNode("entry-0"), createNode("entry-1")];
  entries[0].dataset.seconds = "0";
  entries[1].dataset.seconds = "10";
  harness.nodes.transcriptList.querySelectorAll = () => entries;
  harness.helpers.switchTab("transcript");

  const pending = harness.helpers.playbackTrackingTick();
  await waitUntil(() => playbackCalls === 1);
  harness.helpers.switchTab("overview", { suppressAnalysis: true });
  playbackGate.resolve({ success: true, response: { currentTime: 5 } });
  await pending;

  assert.equal(entries[0].classList.contains("active-playback"), false);
  assert.equal(entries[1].classList.contains("active-playback"), false);
});

test("copy uses one A snapshot and cannot report success on B", async () => {
  const clipboard = deferred();
  const copied = [];
  const harness = loadSidepanel({
    clipboardWrite(value) {
      copied.push(value);
      return clipboard.promise;
    },
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      url: `https://www.youtube.com/watch?v=${tabId === 11 ? "AAAAAA" : "BBBBBB"}`,
    }),
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: { title: `Video ${message.tabId}` } };
      }
      if (message.action === "fetchTranscript") {
        return transcriptResult(message.videoId === "AAAAAA" ? "A" : "B");
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      return {};
    },
  });

  await harness.helpers.checkCurrentTab(11);
  const copyWork = harness.helpers.copyTranscript();
  await waitUntil(() => copied.length === 1);
  await harness.helpers.checkCurrentTab(22);
  clipboard.resolve();
  await copyWork;

  assert.deepEqual(copied, ["A transcript."]);
  assert.equal(harness.nodes.copyTranscriptBtn.textContent, "Copy");
  assert.equal(harness.helpers.captureVideoSnapshot().transcriptText, "B transcript.");
});

test("failed Chinese export never copies an Original fallback", async () => {
  const copied = [];
  let translationCalls = 0;
  const harness = loadSidepanel({
    clipboardWrite(value) {
      copied.push(value);
    },
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }),
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: { title: "Video A" } };
      }
      if (message.action === "fetchTranscript") return transcriptResult("A");
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      if (message.action === "translateContent") {
        translationCalls += 1;
        return { success: false, error: "provider unavailable" };
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      return {};
    },
  });

  await harness.helpers.checkCurrentTab(11);
  await harness.helpers.handleTranscriptModeChange("zh");
  await harness.helpers.copyTranscript();

  assert.equal(translationCalls, 1);
  assert.deepEqual(copied, []);
  assert.match(harness.nodes.transcriptExportStatus.textContent, /不会回退为 Original/);
  assert.equal(harness.nodes.copyTranscriptBtn.textContent, "翻译并复制中文");
});

test("changing transcript mode cancels a pending translated export snapshot", async () => {
  const translationGate = deferred();
  const copied = [];
  let translationRequest = null;
  const harness = loadSidepanel({
    clipboardWrite(value) {
      copied.push(value);
    },
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }),
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: { title: "Video A" } };
      }
      if (message.action === "fetchTranscript") return transcriptResult("A");
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      if (message.action === "translateContent") {
        translationRequest = message;
        return translationGate.promise;
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      return {};
    },
  });

  await harness.helpers.checkCurrentTab(11);
  await harness.helpers.handleTranscriptModeChange("zh");
  const copyWork = harness.helpers.copyTranscript();
  await waitUntil(() => Boolean(translationRequest));
  await harness.helpers.handleTranscriptModeChange("original");
  translationGate.resolve({
    success: true,
    translatedContent: {
      segments: translationRequest.content.segments.map((segment) => ({
        id: segment.id,
        text: "不应复制的迟到译文",
      })),
    },
  });
  await copyWork;

  assert.deepEqual(copied, []);
  assert.equal(harness.nodes.transcriptExportStatus.textContent, "");
  assert.equal(harness.nodes.copyTranscriptBtn.textContent, "Copy");
  assert.equal(harness.nodes.exportTranscriptBtn.textContent, "TXT");
  assert.equal(harness.nodes.exportCleanTranscriptBtn.textContent, "Clean MD");
});

test("typed provider error HTML exposes cost and two recovery actions", () => {
  const html = read("sidepanel.html");

  assert.match(html, /id="errorState"[^>]*role="alert"/);
  assert.match(html, /id="errorCostNote"/);
  assert.match(html, /id="errorBtn"[^>]*type="button"/);
  assert.match(html, /id="errorSecondaryBtn"[^>]*type="button"/);
  assert.match(html, /id="analysisRecoveryContextBtn"[^>]*type="button"/);
});

test("provider failure presentation is bounded, Chinese, and stage-specific", () => {
  const { providerFailurePresentation } = loadSidepanel().helpers;
  assert.equal(typeof providerFailurePresentation, "function");

  const transcriptFailure = providerFailurePresentation({
    code: "NO_TRANSCRIPT",
    provider: "supadata",
    stage: "transcript",
    mayHaveConsumedCredit: true,
    message: "provider-secret-must-not-render",
  });
  assert.match(transcriptFailure.title, /字幕/);
  assert.match(transcriptFailure.message, /视频|字幕/);
  assert.match(transcriptFailure.creditNote, /可能.*额度/);
  assert.equal(transcriptFailure.primaryAction.kind, "choose_video");
  assert.equal(transcriptFailure.secondaryAction.kind, "retry_step");
  assert.doesNotMatch(JSON.stringify(transcriptFailure), /provider-secret/);

  const analysisFailure = providerFailurePresentation({
    code: "INVALID_KEY",
    provider: "deepseek",
    stage: "analysis",
    mayHaveConsumedCredit: false,
  });
  assert.match(analysisFailure.title, /分析.*密钥/);
  assert.match(analysisFailure.creditNote, /发送前|不会消耗/);
  assert.equal(analysisFailure.primaryAction.kind, "open_settings");
  assert.equal(analysisFailure.secondaryAction.kind, "retry_step");

  const unknown = providerFailurePresentation({
    code: "UNTRUSTED_CODE",
    stage: "analysis",
    message: "raw-secret",
  });
  assert.equal(unknown.code, "UNKNOWN_PROVIDER_ERROR");
  assert.doesNotMatch(JSON.stringify(unknown), /raw-secret/);
  assert.match(unknown.creditNote, /可能.*额度/);

  const oversizedTranscript = providerFailurePresentation(
    { code: "RESPONSE_TOO_LARGE", stage: "transcript" },
    "transcript",
  );
  assert.match(oversizedTranscript.message, /较短视频/);
  assert.equal(oversizedTranscript.primaryAction.kind, "choose_video");
  assert.equal(oversizedTranscript.secondaryAction.kind, "retry_step");

  const oversizedAnalysis = providerFailurePresentation(
    { code: "RESPONSE_TOO_LARGE", stage: "analysis" },
    "analysis",
  );
  assert.match(oversizedAnalysis.message, /缩小.*范围/);
  assert.equal(oversizedAnalysis.primaryAction.kind, "show_transcript");
  assert.equal(oversizedAnalysis.secondaryAction.kind, "retry_step");

  const oversizedOverviewInput = providerFailurePresentation(
    {
      code: "INPUT_TOO_LARGE",
      provider: "deepseek",
      stage: "overview",
      mayHaveConsumedCredit: false,
      message: "raw-provider-detail",
    },
    "overview",
  );
  assert.equal(oversizedOverviewInput.code, "INPUT_TOO_LARGE");
  assert.equal(oversizedOverviewInput.provider, "deepseek");
  assert.equal(oversizedOverviewInput.stage, "overview");
  assert.match(oversizedOverviewInput.title, /概览|字幕/);
  assert.match(oversizedOverviewInput.message, /上限|过长/);
  assert.match(oversizedOverviewInput.creditNote, /发送前|不会消耗/);
  assert.equal(oversizedOverviewInput.primaryAction.kind, "show_transcript");
  assert.notEqual(oversizedOverviewInput.secondaryAction.kind, "retry_step");
  assert.doesNotMatch(JSON.stringify(oversizedOverviewInput), /raw-provider-detail/);
});

test("overview provider failures use basic-overview copy and recovery actions", () => {
  const { providerFailurePresentation } = loadSidepanel().helpers;
  const cases = [
    ["MISSING_KEY", "open_settings", /配置|API Key/],
    ["INVALID_KEY", "open_settings", /密钥/],
    ["INSUFFICIENT_CREDIT", "open_provider_help", /额度/],
    ["REQUEST_TIMEOUT", "retry_step", /超时/],
  ];

  for (const [code, primaryKind, expectedCopy] of cases) {
    const presentation = providerFailurePresentation(
      { code, stage: "overview", mayHaveConsumedCredit: false },
      "overview",
    );
    const copy = `${presentation.title} ${presentation.message}`;
    assert.equal(presentation.stage, "overview");
    assert.equal(presentation.provider, "deepseek");
    assert.equal(presentation.primaryAction.kind, primaryKind);
    assert.match(copy, /基础概览/);
    assert.match(copy, expectedCopy);
    assert.doesNotMatch(copy, /深度分析|字幕服务/);
    if (primaryKind === "retry_step") {
      assert.equal(presentation.primaryAction.label, "重试概览");
    }
  }
});

test("provider recovery never navigates from a response action or URL", async () => {
  const harness = loadSidepanel();
  const { runProviderRecovery } = harness.helpers;
  assert.equal(typeof runProviderRecovery, "function");

  await runProviderRecovery({
    kind: "navigate",
    url: "https://attacker.invalid/provider-secret",
  });
  await runProviderRecovery(
    { kind: "choose_video" },
    { stage: "transcript", provider: "supadata" },
  );
  await runProviderRecovery(
    { kind: "open_provider_help" },
    { stage: "analysis", provider: "deepseek" },
  );

  assert.deepEqual(harness.createdTabs, []);
  assert.equal(harness.nodes.welcomeState.style.display, "flex");
  assert.ok(
    harness.runtimeMessages.some((message) => message.action === "openOptions"),
  );
});

test("typed transcript recovery hides raw provider text and retries only transcript", async () => {
  let fetchCalls = 0;
  const harness = loadSidepanel({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }),
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: { title: "Video A" } };
      }
      if (message.action === "fetchTranscript") {
        fetchCalls += 1;
        if (fetchCalls === 1) {
          return {
            success: false,
            code: "NO_TRANSCRIPT",
            provider: "supadata",
            stage: "transcript",
            retryable: false,
            mayHaveConsumedCredit: true,
            primaryAction: "choose_video",
            message: "raw-provider-secret",
          };
        }
        return transcriptResult("A");
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      return {};
    },
  });
  harness.helpers.setupEventListeners();

  await harness.helpers.checkCurrentTab(11);

  assert.equal(harness.nodes.errorState.style.display, "block");
  assert.match(harness.nodes.errorTitle.textContent, /字幕/);
  assert.match(harness.nodes.errorCostNote.textContent, /可能.*额度/);
  assert.notEqual(harness.nodes.errorSecondaryBtn.style.display, "none");
  assert.doesNotMatch(
    [
      harness.nodes.errorTitle.textContent,
      harness.nodes.errorMessage.textContent,
      harness.nodes.errorCostNote.textContent,
    ].join(" "),
    /raw-provider-secret/,
  );
  assert.equal(
    harness.runtimeMessages.some(
      (message) => message.action === "persistDigestBase",
    ),
    false,
  );

  await clickNode(harness.nodes.errorSecondaryBtn);
  await waitUntil(() => harness.nodes.resultsState.style.display === "block");
  assert.equal(fetchCalls, 2);
  assert.equal(harness.helpers.captureVideoSnapshot().transcriptText, "A transcript.");
  assert.equal(harness.nodes.errorCostNote.style.display, "none");

  await clickNode(harness.nodes.errorSecondaryBtn);
  assert.equal(fetchCalls, 2);
});

test("choosing another video clears hidden transcript recovery actions", async () => {
  let fetchCalls = 0;
  const harness = loadSidepanel({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }),
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: { title: "Video A" } };
      }
      if (message.action === "fetchTranscript") {
        fetchCalls += 1;
        return {
          success: false,
          code: "NO_TRANSCRIPT",
          provider: "supadata",
          stage: "transcript",
          mayHaveConsumedCredit: true,
        };
      }
      return {};
    },
  });
  harness.helpers.setupEventListeners();
  await harness.helpers.checkCurrentTab(11);

  await clickNode(harness.nodes.errorBtn);

  assert.equal(harness.nodes.welcomeState.style.display, "flex");
  assert.equal(harness.nodes.errorState.style.display, "none");
  assert.equal(harness.nodes.errorCostNote.style.display, "none");
  assert.equal(harness.nodes.errorSecondaryBtn.style.display, "none");
  assert.equal(harness.getActiveElement(), harness.nodes.settingsBtn);

  await clickNode(harness.nodes.errorSecondaryBtn);
  assert.equal(fetchCalls, 1);
});

test("current-token authority failures stay silent in transcript and analysis stages", async (t) => {
  for (const code of ["SESSION_STALE", "RESET_DURING_REQUEST"]) {
    await t.test(`transcript ${code}`, async () => {
      const harness = loadSidepanel({
        tabsGet: async (tabId) => ({
          id: tabId,
          windowId: 7,
          active: true,
          url: "https://www.youtube.com/watch?v=AAAAAA",
        }),
        storageGet: async () => ({}),
        sendMessage(message) {
          if (message.action === "getResetEpoch") {
            return { success: true, resetEpoch: 0 };
          }
          if (message.action === "relayToContent") {
            return { success: true, response: { title: "Video A" } };
          }
          if (message.action === "fetchTranscript") {
            return { success: false, code };
          }
          return {};
        },
      });

      await harness.helpers.checkCurrentTab(11);

      assert.notEqual(harness.nodes.errorState.style.display, "block");
      assert.doesNotMatch(
        `${harness.nodes.errorTitle.textContent} ${harness.nodes.errorMessage.textContent}`,
        /视频已经切换|数据已重置/,
      );
    });
  }

  for (const code of ["SESSION_STALE", "RESET_DURING_REQUEST"]) {
    await t.test(`analysis ${code}`, async () => {
      const cachedAnalysis = completeDeepAnalysis("Authority A");
      const cachedDigest = await cachedDigestV2("cached A", {
        deepAnalysis: cachedAnalysis,
      });
      const harness = loadSidepanel({
        tabsGet: async (tabId) => ({
          id: tabId,
          windowId: 7,
          active: true,
          url: "https://www.youtube.com/watch?v=AAAAAA",
        }),
        storageGet: async (query) =>
          query === "digest_AAAAAA"
            ? { digest_AAAAAA: cachedDigest }
            : {},
        sendMessage(message) {
          if (message.action === "getResetEpoch") {
            return { success: true, resetEpoch: 0 };
          }
          if (message.action === "relayToContent") {
            return { success: true, response: {} };
          }
          if (message.action === "analyzeTranscript") {
            return { success: false, code };
          }
          if (message.action === "getNotes") return { success: true, notes: [] };
          return {};
        },
      });
      await harness.helpers.checkCurrentTab(11);
      harness.nodes.regenerateAnalysisBtn.textContent = "Regenerate";
      const before = {
        status: harness.nodes.analysisStatus.textContent,
        takeaway: harness.nodes.analysisOneSentence.textContent,
        reportDisabled: harness.nodes.analysisExportReportBtn.disabled,
        packDisabled: harness.nodes.analysisExportStudyPackBtn.disabled,
        button: harness.nodes.regenerateAnalysisBtn.textContent,
      };

      await harness.helpers.triggerAnalysis(true);

      assert.deepEqual(
        {
          status: harness.nodes.analysisStatus.textContent,
          takeaway: harness.nodes.analysisOneSentence.textContent,
          reportDisabled: harness.nodes.analysisExportReportBtn.disabled,
          packDisabled: harness.nodes.analysisExportStudyPackBtn.disabled,
          button: harness.nodes.regenerateAnalysisBtn.textContent,
        },
        before,
      );
      assert.equal(harness.nodes.analysisRecoveryContextBtn.style.display, "none");
    });
  }
});

test("analysis failure re-renders a partial cached overview without enabling deep exports", async () => {
  const partialAnalysis = {
    schemaVersion: 1,
    reportComplete: false,
    summary: {
      oneSentenceZh: "保留这条部分概览",
      executiveSummaryZh: "已有但不完整的概览",
      coreThesisZh: "部分核心论点",
      whyItMattersZh: "部分重要性",
    },
    chapters: [
      { title: "已有章节", summary: "部分章节", timestampSeconds: 0, timestamp: "0:00" },
    ],
    keyQuotes: [],
  };
  const cachedDigest = await cachedDigestV2("cached A", {
    deepAnalysis: partialAnalysis,
  });
  const harness = loadSidepanel({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }),
    storageGet: async (query) =>
      query === "digest_AAAAAA"
        ? { digest_AAAAAA: cachedDigest }
        : {},
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: {} };
      }
      if (message.action === "analyzeTranscript") {
        return {
          success: false,
          code: "REQUEST_TIMEOUT",
          mayHaveConsumedCredit: true,
        };
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      return {};
    },
  });
  await harness.helpers.checkCurrentTab(11);
  const chapterRendersBefore = harness.nodes.chapterList.children.length;

  await harness.helpers.triggerAnalysis(true);

  assert.equal(harness.nodes.analysisOneSentence.textContent, "保留这条部分概览");
  assert.ok(harness.nodes.chapterList.children.length > chapterRendersBefore);
  assert.equal(harness.nodes.chapterList.children.at(-1).dataset.seconds, 0);
  assert.equal(harness.nodes.analysisExportReportBtn.disabled, true);
  assert.equal(harness.nodes.analysisExportStudyPackBtn.disabled, true);
  assert.match(harness.nodes.analysisStatus.textContent, /超时/);
});

test("analysis failure preserves transcript, existing overview, and exports while retrying only analysis", async () => {
  const cachedAnalysis = completeDeepAnalysis("已缓存 A");
  const cachedDigest = await cachedDigestV2("cached A", {
    deepAnalysis: cachedAnalysis,
    videoTitle: "Cached A",
    channelName: "Channel A",
  });
  let analysisCalls = 0;
  const harness = loadSidepanel({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }),
    storageGet: async (query) =>
      query === "digest_AAAAAA"
        ? { digest_AAAAAA: cachedDigest }
        : {},
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: {} };
      }
      if (message.action === "fetchTranscript") {
        throw new Error("analysis retry must reuse the cached transcript");
      }
      if (message.action === "analyzeTranscript") {
        analysisCalls += 1;
        return {
          success: false,
          code: "REQUEST_TIMEOUT",
          provider: "deepseek",
          stage: "analysis",
          retryable: true,
          mayHaveConsumedCredit: true,
          primaryAction: "retry",
          error: "raw-analysis-secret",
        };
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      return {};
    },
  });
  harness.helpers.setupEventListeners();
  await harness.helpers.checkCurrentTab(11);
  const persistsBefore = harness.runtimeMessages.filter(
    (message) => message.action === "persistDigestBase",
  ).length;

  await harness.helpers.triggerAnalysis(true);

  const snapshot = harness.helpers.captureVideoSnapshot();
  assert.equal(snapshot.transcriptText, "cached A transcript.");
  assert.deepEqual(
    JSON.parse(JSON.stringify(snapshot.analysis)),
    cachedAnalysis,
  );
  assert.equal(harness.nodes.resultsState.style.display, "block");
  assert.equal(harness.nodes.errorState.style.display, "none");
  assert.equal(harness.nodes.analysisOneSentence.textContent, "已缓存 A 的一句话结论");
  assert.match(harness.nodes.analysisStatus.textContent, /超时/);
  assert.match(harness.nodes.analysisStatus.textContent, /可能.*额度/);
  assert.doesNotMatch(harness.nodes.analysisStatus.textContent, /raw-analysis-secret/);
  assert.equal(harness.nodes.analysisExportReportBtn.disabled, false);
  assert.equal(harness.nodes.analysisExportStudyPackBtn.disabled, false);
  assert.match(harness.nodes.regenerateAnalysisBtn.textContent, /重试分析/);
  assert.notEqual(harness.nodes.analysisRecoveryContextBtn.style.display, "none");
  assert.match(harness.nodes.analysisRecoveryContextBtn.textContent, /查看字幕/);
  assert.equal(
    harness.runtimeMessages.filter(
      (message) => message.action === "persistDigestBase",
    ).length,
    persistsBefore,
  );

  await clickNode(harness.nodes.analysisRecoveryContextBtn);
  assert.equal(
    harness.tabs.find((tab) => tab.dataset.tab === "transcript").classList.contains("active"),
    true,
  );
  assert.equal(analysisCalls, 1);
  harness.helpers.switchTab("overview", { suppressAnalysis: true });

  await clickNode(harness.nodes.regenerateAnalysisBtn);
  assert.equal(analysisCalls, 2);
  assert.equal(
    harness.runtimeMessages.some((message) => message.action === "fetchTranscript"),
    false,
  );
});

test("analysis key failures keep both settings and retry-analysis paths", async () => {
  let analysisCalls = 0;
  const cachedDigest = await cachedDigestV2("cached A", {
    deepAnalysis: completeDeepAnalysis("Cached A"),
  });
  const harness = loadSidepanel({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }),
    storageGet: async (query) =>
      query === "digest_AAAAAA"
        ? { digest_AAAAAA: cachedDigest }
        : {},
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: {} };
      }
      if (message.action === "analyzeTranscript") {
        analysisCalls += 1;
        return {
          success: false,
          code: "INVALID_KEY",
          provider: "deepseek",
          stage: "analysis",
          mayHaveConsumedCredit: true,
        };
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      return {};
    },
  });
  harness.helpers.setupEventListeners();
  await harness.helpers.checkCurrentTab(11);

  await harness.helpers.triggerAnalysis(true);

  assert.match(harness.nodes.regenerateAnalysisBtn.textContent, /重试分析/);
  assert.notEqual(harness.nodes.analysisRecoveryContextBtn.style.display, "none");
  assert.match(harness.nodes.analysisRecoveryContextBtn.textContent, /打开设置/);
  await clickNode(harness.nodes.analysisRecoveryContextBtn);
  assert.ok(
    harness.runtimeMessages.some((message) => message.action === "openOptions"),
  );
  assert.equal(analysisCalls, 1);

  await clickNode(harness.nodes.regenerateAnalysisBtn);
  assert.equal(analysisCalls, 2);
  assert.equal(
    harness.runtimeMessages.some((message) => message.action === "fetchTranscript"),
    false,
  );
});

test("atomic reset clears old Overview and activates it without analysis", () => {
  const { helpers, nodes, tabs, panels, runtimeMessages } = loadSidepanel();
  nodes.videoInfo.style.display = "block";
  nodes.videoTitle.textContent = "Old video";
  nodes.chapterList.innerHTML = "<li>Old overview</li>";
  nodes.quotesList.innerHTML = "<div>Old quote</div>";
  nodes.transcriptList.innerHTML = "Old transcript";
  nodes.notesList.innerHTML = "Old notes";
  nodes.analysisTakeawayTitle.textContent = "一句话看懂";
  nodes.overviewLoadingState.style.display = "none";
  nodes.overviewErrorState.style.display = "block";
  nodes.overviewReadyState.style.display = "block";
  nodes.overviewCacheWarning.style.display = "flex";
  nodes.overviewCacheRetryBtn.disabled = true;
  nodes.overviewCacheRetryBtn.textContent = "正在保存…";
  nodes.overviewConclusions.appendChild(createNode("old-overview-conclusion"));
  nodes.overviewChapterList.appendChild(createNode("old-overview-chapter"));
  nodes.deepAnalysisCard.setAttribute("aria-busy", "true");
  nodes.deepAnalysisActionBtn.disabled = true;
  nodes.deepAnalysisActionBtn.textContent = "正在生成…";
  nodes.deepAnalysisActionBtn.style.display = "none";
  nodes.deepAnalysisResults.style.display = "block";
  nodes.regenerateAnalysisBtn.textContent = "正在生成…";

  helpers.resetVideoBoundUi();

  assert.equal(nodes.videoInfo.style.display, "none");
  assert.equal(nodes.videoTitle.textContent, "");
  assert.equal(nodes.chapterList.innerHTML, "");
  assert.equal(nodes.quotesList.innerHTML, "");
  assert.equal(nodes.transcriptList.innerHTML, "");
  assert.equal(nodes.notesList.innerHTML, "");
  assert.equal(nodes.analysisTakeawayTitle.textContent, "一句话看懂");
  assert.equal(nodes.overviewLoadingState.style.display, "flex");
  assert.equal(nodes.overviewErrorState.style.display, "none");
  assert.equal(nodes.overviewReadyState.style.display, "none");
  assert.equal(nodes.overviewCacheWarning.style.display, "none");
  assert.equal(nodes.overviewCacheRetryBtn.disabled, false);
  assert.equal(nodes.overviewCacheRetryBtn.textContent, "仅重试本地保存");
  assert.equal(nodes.overviewConclusions.children.length, 0);
  assert.equal(nodes.overviewChapterList.children.length, 0);
  assert.equal(nodes.deepAnalysisCard.getAttribute("aria-busy"), "false");
  assert.equal(nodes.deepAnalysisActionBtn.disabled, false);
  assert.equal(nodes.deepAnalysisActionBtn.textContent, "生成深度分析");
  assert.equal(nodes.deepAnalysisActionBtn.style.display, "inline-flex");
  assert.equal(nodes.deepAnalysisResults.style.display, "none");
  assert.equal(nodes.regenerateAnalysisBtn.textContent, "重新生成");
  assert.equal(nodes.analysisStatus.textContent, "尚未生成，不会自动消耗额度。");
  assert.equal(tabs.find((tab) => tab.dataset.tab === "overview").classList.contains("active"), true);
  assert.equal(panels.find((panel) => panel.dataset.panel === "overview").classList.contains("active"), true);
  assert.equal(runtimeMessages.some((message) => message.action === "analyzeTranscript"), false);
});

test("a fresh transcript rendered under Overview does not start playback polling", async () => {
  const harness = loadSidepanel({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }),
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return {
          success: true,
          response: { title: "Fresh A", channelName: "Channel A" },
        };
      }
      if (message.action === "fetchTranscript") return transcriptResult("A");
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      return {};
    },
  });

  await harness.helpers.checkCurrentTab(11);

  assert.equal(
    harness.tabs.find((tab) => tab.dataset.tab === "overview").classList.contains("active"),
    true,
  );
  assert.equal(harness.getIntervalStarts(), 0);
  assert.equal(harness.getActiveIntervalCount(), 0);
});

test("a cached transcript rendered under Overview does not start playback polling", async () => {
  const harness = loadSidepanel({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }),
    storageGet: async (query) =>
      query === "digest_AAAAAA"
        ? {
            digest_AAAAAA: {
              timestamp: Date.now(),
              analysis: null,
              transcript: transcriptResult("cached A").transcript,
              transcriptText: "cached A transcript.",
              transcriptTimestamped: "[0:00] cached A transcript.",
              transcriptLanguage: "en",
              videoTitle: "Cached A",
              channelName: "Channel A",
            },
          }
        : {},
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: {} };
      }
      if (message.action === "fetchTranscript") {
        throw new Error("cached transcript must not be refetched");
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      return {};
    },
  });

  await harness.helpers.checkCurrentTab(11);

  assert.equal(
    harness.tabs.find((tab) => tab.dataset.tab === "overview").classList.contains("active"),
    true,
  );
  assert.equal(harness.getIntervalStarts(), 0);
  assert.equal(harness.getActiveIntervalCount(), 0);
});

test("reset removes the visible explain tooltip and its document listeners", async () => {
  let transcriptList;
  const selection = {
    rangeCount: 1,
    isCollapsed: false,
    anchorNode: null,
    toString: () => "A selected phrase",
    getRangeAt: () => ({
      getBoundingClientRect: () => ({ bottom: 10, left: 5, width: 20 }),
    }),
  };
  const harness = loadSidepanel({
    getSelection: () => selection,
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }),
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getResetEpoch") return { success: true, resetEpoch: 0 };
      if (message.action === "relayToContent") return { success: true, response: {} };
      if (message.action === "fetchTranscript") return transcriptResult("A");
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      return {};
    },
  });
  transcriptList = harness.nodes.transcriptList;
  selection.anchorNode = transcriptList;
  await harness.helpers.checkCurrentTab(11);
  await harness.dispatchDocumentEvent("mouseup", {});
  const renderedTooltip = harness.dynamicNodes.find(
    (node) => node.id === "explainTooltip" && node.isConnected,
  );
  assert.equal(
    harness.getDocumentListenerCount("mouseup"),
    1,
  );
  assert.equal(renderedTooltip?.style?.display ?? "block", "block");

  harness.helpers.resetVideoBoundUi();

  assert.equal(harness.getDocumentListenerCount("mouseup"), 0);
  assert.equal(harness.getDocumentListenerCount("mousedown"), 0);
  assert.equal(renderedTooltip.isConnected, false);
  assert.equal(
    harness.dynamicNodes.some(
      (node) => node.id === "explainTooltip" && node.isConnected,
    ),
    false,
  );
});

test("an old explain handler cannot bill the newly active video session", async () => {
  const selection = {
    rangeCount: 1,
    isCollapsed: false,
    anchorNode: null,
    toString: () => "Text selected on A",
    getRangeAt: () => ({
      getBoundingClientRect: () => ({ bottom: 10, left: 5, width: 20 }),
    }),
  };
  const harness = loadSidepanel({
    getSelection: () => selection,
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      url: `https://www.youtube.com/watch?v=${tabId === 11 ? "AAAAAA" : "BBBBBB"}`,
    }),
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getResetEpoch") return { success: true, resetEpoch: 0 };
      if (message.action === "relayToContent") return { success: true, response: {} };
      if (message.action === "fetchTranscript") {
        return transcriptResult(message.videoId === "AAAAAA" ? "A" : "B");
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      if (message.action === "explainSelection") {
        return { success: true, explanation: "explanation" };
      }
      return {};
    },
  });
  selection.anchorNode = harness.nodes.transcriptList;
  await harness.helpers.checkCurrentTab(11);
  await harness.dispatchDocumentEvent("mouseup", {});
  const oldTooltip = harness.dynamicNodes.find(
    (node) => node.id === "explainTooltip" && node.isConnected,
  );
  const oldButton = oldTooltip?.querySelector?.(".explain-btn");
  const oldClick = Array.from(oldButton?.listeners?.get("click") || [])[0];
  assert.equal(typeof oldClick, "function");

  await harness.helpers.checkCurrentTab(22);
  const before = harness.runtimeMessages.filter(
    (message) => message.action === "explainSelection",
  ).length;
  await oldClick({ preventDefault() {}, stopPropagation() {} });

  assert.equal(
    harness.runtimeMessages.filter(
      (message) => message.action === "explainSelection",
    ).length,
    before,
  );
});

test("repeated explain setup keeps one active document listener pair", async () => {
  const harness = loadSidepanel({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }),
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getResetEpoch") return { success: true, resetEpoch: 0 };
      if (message.action === "relayToContent") return { success: true, response: {} };
      if (message.action === "fetchTranscript") return transcriptResult("A");
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      return {};
    },
  });
  await harness.helpers.checkCurrentTab(11);

  for (let index = 0; index < 5; index += 1) {
    harness.helpers.setupExplainFeature();
  }

  assert.equal(harness.getDocumentListenerCount("mouseup"), 1);
  assert.equal(harness.getDocumentListenerCount("mousedown"), 1);
});

test("panel tab resolution is window-scoped and explicit button tabs never query", async () => {
  const { resolvePanelTab } = loadSidepanel().helpers;
  const calls = [];
  const tabsApi = {
    async query(query) {
      calls.push(["query", query]);
      return [{ id: 11, windowId: 7, url: "https://www.youtube.com/watch?v=AAAAAA" }];
    },
    async get(tabId) {
      calls.push(["get", tabId]);
      return { id: tabId, windowId: 7, url: "https://www.youtube.com/watch?v=BBBBBB" };
    },
  };

  await resolvePanelTab(tabsApi, 7);
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls)),
    [["query", { active: true, windowId: 7 }]],
  );
  calls.length = 0;
  const explicit = await resolvePanelTab(tabsApi, 7, 22);
  assert.equal(explicit.id, 22);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [["get", 22]]);
});

test("an explicit button tab from another window leaves this panel untouched", async () => {
  const harness = loadSidepanel({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: tabId === 11 ? 7 : 8,
      url: `https://www.youtube.com/watch?v=${tabId === 11 ? "AAAAAA" : "BBBBBB"}`,
    }),
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return {
          success: true,
          response: { title: "Window 7 video A", channelName: "Channel A" },
        };
      }
      if (message.action === "fetchTranscript") return transcriptResult("A");
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      return {};
    },
  });

  await harness.helpers.checkCurrentTab(11);
  const before = harness.helpers.captureVideoSnapshot();
  const epochCount = harness.runtimeMessages.filter(
    (message) => message.action === "getResetEpoch",
  ).length;
  const relayCount = harness.runtimeMessages.filter(
    (message) => message.action === "relayToContent",
  ).length;

  await harness.helpers.checkCurrentTab(22);
  const after = harness.helpers.captureVideoSnapshot();

  assert.equal(after.token.sessionId, before.token.sessionId);
  assert.equal(after.videoId, "AAAAAA");
  assert.equal(after.videoTitle, "Window 7 video A");
  assert.equal(harness.nodes.videoTitle.textContent, "Window 7 video A");
  assert.equal(
    harness.runtimeMessages.filter(
      (message) => message.action === "getResetEpoch",
    ).length,
    epochCount,
  );
  assert.equal(
    harness.runtimeMessages.filter(
      (message) => message.action === "relayToContent",
    ).length,
    relayCount,
  );
});

test("another-window button broadcast cannot switch an unconfigured panel", async () => {
  let tabRead = false;
  const harness = loadSidepanel({
    tabsGet: async (tabId) => {
      tabRead = true;
      return {
        id: tabId,
        windowId: 8,
        url: "https://www.youtube.com/watch?v=BBBBBB",
      };
    },
  });
  harness.nodes.resultsState.style.display = "sentinel";
  const overview = harness.tabs.find((tab) => tab.dataset.tab === "overview");
  overview.classList.add("active");

  assert.equal(harness.runtimeMessageListeners.length, 1);
  harness.runtimeMessageListeners[0](
    { action: "startDigestFromButton", tabId: 22 },
    {},
    () => {},
  );
  await waitUntil(() => tabRead);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.nodes.resultsState.style.display, "sentinel");
  assert.equal(overview.classList.contains("active"), true);
  assert.equal(
    harness.tabs.find((tab) => tab.dataset.tab === "vocabulary").classList.contains("active"),
    false,
  );
  assert.deepEqual(harness.runtimeMessages, []);
});

test("a delayed button broadcast from an inactive same-window tab cannot hijack B", async () => {
  let inactiveARead = false;
  const harness = loadSidepanel({
    tabsGet: async (tabId) => {
      if (tabId === 11) inactiveARead = true;
      return {
        id: tabId,
        windowId: 7,
        active: tabId === 22,
        url: `https://www.youtube.com/watch?v=${tabId === 22 ? "BBBBBB" : "AAAAAA"}`,
      };
    },
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getResetEpoch") return { success: true, resetEpoch: 0 };
      if (message.action === "relayToContent") {
        return { success: true, response: { title: "Video B" } };
      }
      if (message.action === "fetchTranscript") return transcriptResult("B");
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      return {};
    },
  });
  await harness.helpers.checkCurrentTab(22);
  const before = harness.helpers.captureVideoSnapshot();
  const epochReads = harness.runtimeMessages.filter(
    (message) => message.action === "getResetEpoch",
  ).length;

  harness.runtimeMessageListeners[0](
    { action: "startDigestFromButton", tabId: 11 },
    {},
    () => {},
  );
  await waitUntil(() => inactiveARead);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    harness.helpers.captureVideoSnapshot().token.sessionId,
    before.token.sessionId,
  );
  assert.equal(harness.helpers.captureVideoSnapshot().videoId, "BBBBBB");
  assert.equal(
    harness.runtimeMessages.filter(
      (message) => message.action === "getResetEpoch",
    ).length,
    epochReads,
  );
});

test("side panel treats a pending navigation as the tab's current video identity", async () => {
  const harness = loadSidepanel({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      url: "https://www.youtube.com/watch?v=AAAAAA",
      pendingUrl: "https://www.youtube.com/watch?v=BBBBBB",
    }),
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return {
          success: true,
          response: { title: "Pending video B", channelName: "Channel B" },
        };
      }
      if (message.action === "fetchTranscript") return transcriptResult("B");
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      return {};
    },
  });

  await harness.helpers.checkCurrentTab(11);
  const snapshot = harness.helpers.captureVideoSnapshot();

  assert.equal(snapshot.videoId, "BBBBBB");
  assert.equal(snapshot.videoUrl, "https://www.youtube.com/watch?v=BBBBBB");
  assert.equal(snapshot.videoTitle, "Pending video B");
  assert.ok(
    harness.runtimeMessages
      .filter((message) => message.sessionToken)
      .every((message) => message.sessionToken.videoId === "BBBBBB"),
  );
});

test("tab activation invalidates the old video when the tab is navigating", async () => {
  let pendingNavigation = false;
  const harness = loadSidepanel({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      url: "https://www.youtube.com/watch?v=AAAAAA",
      ...(pendingNavigation
        ? { pendingUrl: "https://www.youtube.com/watch?v=BBBBBB" }
        : {}),
    }),
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return {
          success: true,
          response: { title: "Video A", channelName: "Channel A" },
        };
      }
      if (message.action === "fetchTranscript") return transcriptResult("A");
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      return {};
    },
  });
  await harness.helpers.checkCurrentTab(11);
  assert.equal(harness.helpers.captureVideoSnapshot().videoId, "AAAAAA");

  pendingNavigation = true;
  await harness.tabActivatedListeners[0]({ tabId: 11, windowId: 7 });

  assert.equal(harness.helpers.captureVideoSnapshot(), null);
  assert.equal(harness.nodes.videoTitle.textContent, "");
});

test("tab URL updates prefer pending navigation over the committed video", async () => {
  const harness = loadSidepanel({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }),
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: { title: "Video A" } };
      }
      if (message.action === "fetchTranscript") return transcriptResult("A");
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      return {};
    },
  });
  await harness.helpers.checkCurrentTab(11);
  assert.equal(harness.helpers.captureVideoSnapshot().videoId, "AAAAAA");

  harness.tabUpdatedListeners[0](
    11,
    { url: "https://www.youtube.com/watch?v=AAAAAA" },
    {
      id: 11,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
      pendingUrl: "https://www.youtube.com/watch?v=BBBBBB",
    },
  );

  assert.equal(harness.helpers.captureVideoSnapshot(), null);
  assert.equal(harness.nodes.videoTitle.textContent, "");
});

test("relay uses explicit tab 22 for DOM and player details and never queries tab 11", async () => {
  const harness = loadBackground();
  const sessionToken = {
    sessionId: "s",
    generation: 1,
    videoId: "BBBBBB",
    tabId: 22,
    windowId: 7,
    resetEpoch: 0,
  };
  await bindBackgroundSession(harness, sessionToken);
  const response = await harness.send({
    action: "relayToContent",
    tabId: 22,
    sessionToken,
    payload: { action: "getVideoInfo" },
  });

  assert.equal(response.success, true);
  assert.ok(harness.gets.length >= 2);
  assert.ok(harness.gets.every((tabId) => tabId === 22));
  assert.deepEqual(harness.sent.map((entry) => entry.tabId), [22]);
  assert.equal(harness.sent[0].payload.expectedVideoId, "BBBBBB");
  assert.deepEqual(harness.scripts, [22]);
  assert.deepEqual(harness.queries, []);
  assert.equal(response.sessionToken.tabId, 22);
});

test("relay rejects a supplied session token after its tab moves windows", async () => {
  const harness = loadBackground({
    tabsGet(tabId, callNumber) {
      return {
        id: tabId,
        windowId: callNumber === 1 ? 7 : 8,
        url: "https://www.youtube.com/watch?v=BBBBBB",
      };
    },
  });
  const sessionToken = {
    sessionId: "window-7-session",
    generation: 1,
    videoId: "BBBBBB",
    tabId: 22,
    windowId: 7,
    resetEpoch: 0,
  };
  await bindBackgroundSession(harness, sessionToken);
  const response = await harness.send({
    action: "relayToContent",
    tabId: 22,
    sessionToken,
    payload: { action: "seekTo", seconds: 5 },
  });

  assert.equal(response.success, false);
  assert.equal(response.code, "TAB_WINDOW_MISMATCH");
  assert.deepEqual(harness.sent, []);
});

test("relay never accepts a committed URL while a different navigation is pending", async () => {
  const harness = loadBackground({
    tabsGet(tabId, callNumber) {
      return {
        id: tabId,
        windowId: 7,
        url: "https://www.youtube.com/watch?v=AAAAAA",
        ...(callNumber > 1
          ? { pendingUrl: "https://www.youtube.com/watch?v=BBBBBB" }
          : {}),
      };
    },
  });
  const sessionToken = {
    sessionId: "video-a-session",
    generation: 1,
    videoId: "AAAAAA",
    tabId: 22,
    windowId: 7,
    resetEpoch: 0,
  };
  await bindBackgroundSession(harness, sessionToken);
  const response = await harness.send({
    action: "relayToContent",
    tabId: 22,
    sessionToken,
    payload: { action: "seekTo", seconds: 5 },
  });

  assert.equal(response.success, false);
  assert.equal(response.code, "TAB_VIDEO_MISMATCH");
  assert.deepEqual(harness.sent, []);
});

test("metadata relay rechecks pending navigation after player details", async () => {
  const harness = loadBackground({
    tabsGet(tabId, callNumber) {
      return {
        id: tabId,
        windowId: 7,
        url: "https://www.youtube.com/watch?v=AAAAAA",
        ...(callNumber >= 4
          ? { pendingUrl: "https://www.youtube.com/watch?v=BBBBBB" }
          : {}),
      };
    },
  });
  const sessionToken = {
    sessionId: "video-a-metadata",
    generation: 1,
    videoId: "AAAAAA",
    tabId: 22,
    windowId: 7,
    resetEpoch: 0,
  };
  await bindBackgroundSession(harness, sessionToken);
  const response = await harness.send({
    action: "relayToContent",
    tabId: 22,
    sessionToken,
    payload: { action: "getVideoInfo" },
  });

  assert.equal(response.success, false);
  assert.equal(response.code, "TAB_VIDEO_MISMATCH");
  assert.deepEqual(harness.sent.map((entry) => entry.tabId), [22]);
  assert.deepEqual(harness.scripts, [22]);
});

test("metadata relay never merges player A after content rejects expected pending B", async () => {
  const harness = loadBackground({
    tabUrl: "https://www.youtube.com/watch?v=AAAAAA",
    tabPendingUrl: "https://www.youtube.com/watch?v=BBBBBB",
    tabsSendMessage: async () => ({
      success: false,
      code: "VIDEO_ID_MISMATCH",
    }),
  });
  const sessionToken = {
    sessionId: "pending-b",
    generation: 1,
    videoId: "BBBBBB",
    tabId: 22,
    windowId: 7,
    resetEpoch: 0,
  };
  await bindBackgroundSession(harness, sessionToken);

  const response = await harness.send({
    action: "relayToContent",
    tabId: 22,
    sessionToken,
    payload: { action: "getVideoInfo" },
  });

  assert.equal(response.success, false);
  assert.equal(response.code, "VIDEO_ID_MISMATCH");
  assert.deepEqual(harness.scripts, []);
});

test("digest persistence requires and binds an explicit complete session identity", async () => {
  const harness = loadBackground({
    tabUrl: "https://www.youtube.com/watch?v=BBBBBB",
  });
  const token = {
    sessionId: "persist-session",
    generation: 1,
    videoId: "BBBBBB",
    tabId: 22,
    windowId: 7,
    resetEpoch: 0,
  };
  const transcript = [
    { text: "Bound transcript.", start: 0, duration: 2, language: "en" },
  ];
  const transcriptLanguage = "en";
  const transcriptFingerprint = await transcriptCore.fingerprintSegments(
    transcriptCore.groupTranscriptEntries(transcript),
    { sourceLanguage: transcriptLanguage, crypto: webcrypto },
  );
  const base = {
    action: "persistDigestBase",
    expectedEpoch: 0,
    videoId: "BBBBBB",
    value: {
      transcript,
      transcriptText: "Bound transcript.",
      transcriptTimestamped: "[0:00] Bound transcript.",
      transcriptLanguage,
      transcriptFingerprint,
      videoTitle: "Bound video",
      channelName: "Bound channel",
    },
  };

  assert.equal((await harness.send(base)).code, "INVALID_TAB_ID");
  assert.equal(
    (await harness.send({ ...base, tabId: 22 })).code,
    "INVALID_SESSION_TOKEN",
  );
  const moved = loadBackground({
    tabsGet(tabId, callNumber) {
      return {
        id: tabId,
        windowId: callNumber === 1 ? 7 : 8,
        url: "https://www.youtube.com/watch?v=BBBBBB",
      };
    },
  });
  await bindBackgroundSession(moved, token);
  assert.equal(
    (await moved.send({ ...base, tabId: 22, sessionToken: token })).code,
    "TAB_WINDOW_MISMATCH",
  );
  const videoAToken = { ...token, videoId: "AAAAAA" };
  const navigating = loadBackground({
    tabsGet(tabId, callNumber) {
      return {
        id: tabId,
        windowId: 7,
        url: "https://www.youtube.com/watch?v=AAAAAA",
        ...(callNumber > 1
          ? { pendingUrl: "https://www.youtube.com/watch?v=BBBBBB" }
          : {}),
      };
    },
  });
  await bindBackgroundSession(navigating, videoAToken);
  assert.equal(
    (
      await navigating.send({
        ...base,
        videoId: "AAAAAA",
        tabId: 22,
        sessionToken: videoAToken,
      })
    ).code,
    "TAB_VIDEO_MISMATCH",
  );
  await bindBackgroundSession(harness, token);
  const persisted = await harness.send({
    ...base,
    tabId: 22,
    sessionToken: token,
  });
  assert.equal(
    persisted.success,
    true,
    JSON.stringify(persisted),
  );
});

test("relay rejects missing IDs and non-YouTube tab URLs with bounded codes", async () => {
  const missing = loadBackground();
  assert.deepEqual(
    JSON.parse(JSON.stringify(await missing.send({ action: "relayToContent", payload: { action: "seekTo" } }))),
    { success: false, code: "INVALID_TAB_ID" },
  );
  assert.deepEqual(missing.sent, []);

  const wrongSite = loadBackground({ tabUrl: "https://example.com/watch?v=BBBBBB" });
  const wrongSiteToken = {
    sessionId: "wrong-site",
    generation: 1,
    videoId: "BBBBBB",
    tabId: 22,
    windowId: 7,
    resetEpoch: 0,
  };
  assert.deepEqual(
    JSON.parse(JSON.stringify(await wrongSite.send({
      action: "bindVideoSession",
      sessionToken: wrongSiteToken,
    }))),
    {
      success: false,
      code: "TAB_NOT_YOUTUBE",
      sessionToken: wrongSiteToken,
    },
  );
  assert.deepEqual(wrongSite.sent, []);
  assert.deepEqual(wrongSite.queries, []);
});

test("button-originated digest refresh preserves sender tab identity", async () => {
  const harness = loadBackground();
  await harness.send({ action: "openSidePanel" }, { tab: { id: 22 } });
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(
    harness.broadcasts.some(
      (message) => message.action === "startDigestFromButton" && message.tabId === 22,
    ),
  );
});

test("tabs expose keyboard navigation and synchronized ARIA state", async () => {
  const harness = loadSidepanel();
  harness.helpers.setupEventListeners();
  const overviewTab = harness.tabs.find(
    (tab) => tab.dataset.tab === "overview",
  );
  const transcriptTab = harness.tabs.find(
    (tab) => tab.dataset.tab === "transcript",
  );
  let prevented = false;
  const keydown = Array.from(overviewTab.listeners.get("keydown") || [])[0];

  assert.equal(typeof keydown, "function");
  await keydown({
    key: "ArrowRight",
    currentTarget: overviewTab,
    preventDefault() {
      prevented = true;
    },
  });

  assert.equal(prevented, true);
  assert.equal(transcriptTab.classList.contains("active"), true);
  assert.equal(transcriptTab.getAttribute("aria-selected"), "true");
  assert.equal(transcriptTab.getAttribute("tabindex"), "0");
  assert.equal(overviewTab.getAttribute("aria-selected"), "false");
  assert.equal(overviewTab.getAttribute("tabindex"), "-1");
  assert.equal(harness.getActiveElement(), transcriptTab);
  assert.equal(
    harness.panels.find((panel) => panel.dataset.panel === "transcript").hidden,
    false,
  );
  assert.equal(
    harness.panels.find((panel) => panel.dataset.panel === "overview").hidden,
    true,
  );
});

test("Overview renders a cached partial result without a provider request", async () => {
  const cached = await cachedDigestV2("partial UI");
  const segments = transcriptCore.groupTranscriptEntries(cached.transcript);
  cached.basicOverview = basicOverviewForTranscript(
    cached.transcriptFingerprint,
    segments,
    {
      complete: false,
      oneSentenceZh: "<img src=x onerror=alert(1)> 仍然只是文字",
    },
  );
  const harness = loadSidepanel({
    tabsQuery: async () => [{
      id: 11,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }],
    storageGet: async (query) =>
      query === "digest_AAAAAA" ? { digest_AAAAAA: cached } : {},
    sendMessage(message) {
      if (message.action === "getVocabulary") {
        return { success: true, entries: [] };
      }
      if (message.action === "checkConfig") {
        return {
          hasSupadataKey: true,
          hasAiKey: false,
          autoBasicOverview: false,
        };
      }
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: {} };
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      return {};
    },
  });

  await harness.dispatchDocumentEvent("DOMContentLoaded");

  assert.equal(harness.nodes.resultsState.style.display, "block");
  assert.equal(harness.nodes.overviewReadyState.style.display, "grid");
  assert.match(harness.nodes.overviewStatusBadge.textContent, /部分/);
  assert.equal(
    harness.nodes.overviewOneSentence.textContent,
    "<img src=x onerror=alert(1)> 仍然只是文字",
  );
  assert.equal(harness.nodes.overviewOneSentence.innerHTML, "");
  assert.equal(harness.nodes.overviewConclusions.children.length, 1);
  assert.equal(harness.nodes.overviewChapterList.children.length, 1);
  assert.equal(
    harness.runtimeMessages.some(
      (message) => message.action === "requestBasicOverview",
    ),
    false,
  );
  assert.equal(
    harness.tabs.find((tab) => tab.dataset.tab === "overview").disabled,
    false,
  );
});

test("Overview keeps missing consent, key, and offline guidance inline", async (t) => {
  const scenarios = [
    {
      name: "no consent",
      config: { hasSupadataKey: true, hasAiKey: true, autoBasicOverview: false },
      onLine: true,
      expected: /自动概览|授权|同意/,
      action: /生成一次|手动生成/,
    },
    {
      name: "missing key",
      config: { hasSupadataKey: true, hasAiKey: false, autoBasicOverview: true },
      onLine: true,
      expected: /DeepSeek|API Key|密钥/,
      action: /设置/,
    },
    {
      name: "missing key takes priority over disabled automation",
      config: { hasSupadataKey: true, hasAiKey: false, autoBasicOverview: false },
      onLine: true,
      expected: /DeepSeek|API Key|密钥/,
      action: /设置/,
    },
    {
      name: "offline",
      config: { hasSupadataKey: true, hasAiKey: true, autoBasicOverview: true },
      onLine: false,
      expected: /网络|离线/,
      action: /重试/,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      let overviewCalls = 0;
      const harness = loadSidepanel({
        onLine: scenario.onLine,
        tabsQuery: async () => [{
          id: 11,
          windowId: 7,
          active: true,
          url: "https://www.youtube.com/watch?v=AAAAAA",
        }],
        storageGet: async () => ({}),
        sendMessage(message) {
          if (message.action === "getVocabulary") {
            return { success: true, entries: [] };
          }
          if (message.action === "checkConfig") return scenario.config;
          if (message.action === "getResetEpoch") {
            return { success: true, resetEpoch: 0 };
          }
          if (message.action === "relayToContent") {
            return { success: true, response: { title: "Video A" } };
          }
          if (message.action === "fetchTranscript") return transcriptResult("A");
          if (message.action === "persistDigestBase") return digestBaseSuccess();
          if (message.action === "requestBasicOverview") {
            overviewCalls += 1;
            return {
              success: true,
              overview: basicOverviewForRequest(message),
            };
          }
          if (message.action === "getNotes") return { success: true, notes: [] };
          return {};
        },
      });

      await harness.dispatchDocumentEvent("DOMContentLoaded");
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(overviewCalls, 0);
      assert.equal(harness.nodes.resultsState.style.display, "block");
      assert.equal(harness.nodes.overviewErrorState.style.display, "flex");
      assert.match(
        `${harness.nodes.overviewErrorTitle.textContent} ${harness.nodes.overviewErrorMessage.textContent}`,
        scenario.expected,
      );
      assert.match(harness.nodes.overviewPrimaryActionBtn.textContent, scenario.action);
      assert.equal(
        harness.tabs.find((tab) => tab.dataset.tab === "overview").disabled,
        false,
      );
      assert.equal(
        harness.tabs.find((tab) => tab.dataset.tab === "transcript").disabled,
        false,
      );
      assert.equal(harness.nodes.errorState.style.display, "none");
    });
  }
});

test("automatic Overview owns loading then ready UI and never starts Deep", async () => {
  const overviewGate = deferred();
  let overviewMessage = null;
  const harness = loadSidepanel({
    tabsQuery: async () => [{
      id: 11,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }],
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getVocabulary") return { success: true, entries: [] };
      if (message.action === "checkConfig") {
        return { hasSupadataKey: true, hasAiKey: true, autoBasicOverview: true };
      }
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: { title: "Video A" } };
      }
      if (message.action === "fetchTranscript") return transcriptResult("A");
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      if (message.action === "requestBasicOverview") {
        overviewMessage = message;
        return overviewGate.promise;
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      return {};
    },
  });

  const ready = harness.dispatchDocumentEvent("DOMContentLoaded");
  await waitUntil(() => Boolean(overviewMessage));
  assert.equal(harness.nodes.overviewLoadingState.style.display, "flex");
  assert.match(
    `${harness.nodes.overviewLoadingTitle.textContent} ${harness.nodes.overviewLoadingMessage.textContent}`,
    /基础概览|概览/,
  );
  assert.equal(
    harness.runtimeMessages.some((message) => message.action === "analyzeTranscript"),
    false,
  );

  overviewGate.resolve({
    success: true,
    overview: basicOverviewForRequest(overviewMessage),
  });
  await ready;
  await waitUntil(() => harness.nodes.overviewReadyState.style.display === "grid");

  assert.equal(harness.nodes.overviewLoadingState.style.display, "none");
  assert.equal(harness.nodes.overviewOneSentence.textContent, "可信的一句话概览");
  assert.equal(
    harness.runtimeMessages.filter(
      (message) => message.action === "requestBasicOverview",
    ).length,
    1,
  );
  assert.equal(
    harness.runtimeMessages.some((message) => message.action === "analyzeTranscript"),
    false,
  );
});

test("cache-write recovery keeps Basic visible and retries no provider work", async () => {
  const cached = await cachedDigestV2("cache warning A");
  let providerCalls = 0;
  let cacheRetryCalls = 0;
  let providerMessage = null;
  const harness = loadSidepanel({
    tabsQuery: async () => [{
      id: 11,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }],
    storageGet: async (query) =>
      query === "digest_AAAAAA" ? { digest_AAAAAA: cached } : {},
    sendMessage(message) {
      if (message.action === "getVocabulary") return { success: true, entries: [] };
      if (message.action === "checkConfig") {
        return { hasSupadataKey: true, hasAiKey: true, autoBasicOverview: false };
      }
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") return { success: true, response: {} };
      if (message.action === "requestBasicOverview") {
        providerCalls += 1;
        providerMessage = message;
        return {
          success: false,
          code: "OVERVIEW_CACHE_WRITE_FAILED",
          provider: "deepseek",
          stage: "overview_cache",
          retryable: true,
          primaryAction: "retry_cache_write",
          mayHaveConsumedCredit: true,
          providerSucceeded: true,
          overview: basicOverviewForRequest(message),
          recoveryToken: "opaque-ui-recovery",
        };
      }
      if (message.action === "retryBasicOverviewCacheWrite") {
        cacheRetryCalls += 1;
        return {
          success: true,
          overview: basicOverviewForRequest(providerMessage),
        };
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      return {};
    },
  });

  await harness.dispatchDocumentEvent("DOMContentLoaded");
  await clickNode(harness.nodes.overviewPrimaryActionBtn);
  await waitUntil(() => harness.nodes.overviewCacheWarning.style.display === "flex");

  assert.equal(providerCalls, 1);
  assert.equal(harness.nodes.overviewReadyState.style.display, "grid");
  assert.match(harness.nodes.overviewCacheWarningMessage.textContent, /保存|缓存/);

  await clickNode(harness.nodes.overviewCacheRetryBtn);
  await waitUntil(() => cacheRetryCalls === 1);
  assert.equal(providerCalls, 1);
  assert.equal(harness.nodes.overviewReadyState.style.display, "grid");
  assert.equal(harness.nodes.overviewCacheWarning.style.display, "none");
});

test("an unavailable cache recovery keeps the trusted Basic warning visible without a dead retry", async () => {
  const cached = await cachedDigestV2("expired recovery A");
  let overviewRequest = null;
  let providerCalls = 0;
  let cacheRetryCalls = 0;
  const harness = loadSidepanel({
    tabsQuery: async () => [{
      id: 11,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }],
    storageGet: async (query) =>
      query === "digest_AAAAAA" ? { digest_AAAAAA: cached } : {},
    sendMessage(message) {
      if (message.action === "getVocabulary") return { success: true, entries: [] };
      if (message.action === "checkConfig") {
        return { hasSupadataKey: true, hasAiKey: true, autoBasicOverview: false };
      }
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") return { success: true, response: {} };
      if (message.action === "requestBasicOverview") {
        providerCalls += 1;
        overviewRequest = message;
        return {
          success: false,
          code: "OVERVIEW_CACHE_WRITE_FAILED",
          provider: "deepseek",
          stage: "overview_cache",
          retryable: true,
          primaryAction: "retry_cache_write",
          mayHaveConsumedCredit: true,
          providerSucceeded: true,
          overview: basicOverviewForRequest(message),
          recoveryToken: "opaque-expiring-recovery",
        };
      }
      if (message.action === "retryBasicOverviewCacheWrite") {
        cacheRetryCalls += 1;
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
      if (message.action === "getNotes") return { success: true, notes: [] };
      return {};
    },
  });

  await harness.dispatchDocumentEvent("DOMContentLoaded");
  await clickNode(harness.nodes.overviewPrimaryActionBtn);
  await waitUntil(() => harness.nodes.overviewCacheWarning.style.display === "flex");
  assert.equal(providerCalls, 1);
  assert.ok(overviewRequest);

  await clickNode(harness.nodes.overviewCacheRetryBtn);
  await waitUntil(() => cacheRetryCalls === 1);

  assert.equal(providerCalls, 1);
  assert.equal(harness.nodes.overviewReadyState.style.display, "grid");
  assert.equal(harness.nodes.overviewCacheWarning.style.display, "flex");
  assert.match(
    harness.nodes.overviewCacheWarningMessage.textContent,
    /恢复|失效|仍可查看|未保存/,
  );
  assert.equal(harness.nodes.overviewCacheRetryBtn.style.display, "none");
  assert.equal(
    harness.helpers.getBasicOverviewState().presentation.disposition,
    "cache_warning",
  );
});

test("a partial legacy Deep report is visible but never claims to rebuild automatically", async () => {
  const partialDeep = {
    ...completeDeepAnalysis("legacy partial"),
    reportComplete: false,
  };
  const cached = await cachedDigestV2("legacy partial", {
    deepAnalysis: partialDeep,
  });
  let analysisCalls = 0;
  const harness = loadSidepanel({
    storageCloneIntoVm: true,
    tabsQuery: async () => [{
      id: 11,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }],
    storageGet: async (query) =>
      query === "digest_AAAAAA" ? { digest_AAAAAA: cached } : {},
    sendMessage(message) {
      if (message.action === "getVocabulary") return { success: true, entries: [] };
      if (message.action === "checkConfig") {
        return { hasSupadataKey: true, hasAiKey: false, autoBasicOverview: false };
      }
      if (message.action === "getResetEpoch") return { success: true, resetEpoch: 0 };
      if (message.action === "relayToContent") return { success: true, response: {} };
      if (message.action === "analyzeTranscript") {
        analysisCalls += 1;
        return { success: true, analysis: completeDeepAnalysis("unexpected") };
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      return {};
    },
  });

  await harness.dispatchDocumentEvent("DOMContentLoaded");

  assert.equal(harness.nodes.deepAnalysisResults.style.display, "block");
  assert.equal(analysisCalls, 0);
  assert.doesNotMatch(harness.nodes.analysisStatus.textContent, /rebuild|重建中|正在重建/i);
  assert.match(harness.nodes.analysisStatus.textContent, /旧版|点击|重新生成|手动/);
});

test("Deep starts only from an explicit action and coalesces before base readiness", async () => {
  let now = 2_000_000_000_000;
  const cached = await cachedDigestV2("deep action A", {
    timestamp: now - THIRTY_DAYS_MS + 1,
    deepAnalysis: null,
  });
  const baseGate = deferred();
  const analysisGate = deferred();
  let baseCalls = 0;
  let analysisCalls = 0;
  const harness = loadSidepanel({
    now: () => now,
    storageCloneIntoVm: true,
    tabsQuery: async () => [{
      id: 11,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }],
    storageGet: async (query) =>
      query === "digest_AAAAAA" ? { digest_AAAAAA: cached } : {},
    sendMessage(message) {
      if (message.action === "getVocabulary") return { success: true, entries: [] };
      if (message.action === "checkConfig") {
        return { hasSupadataKey: true, hasAiKey: true, autoBasicOverview: false };
      }
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") return { success: true, response: {} };
      if (message.action === "persistDigestBase") {
        baseCalls += 1;
        return baseGate.promise;
      }
      if (message.action === "analyzeTranscript") {
        analysisCalls += 1;
        return analysisGate.promise;
      }
      if (message.action === "patchDigestCache") return { success: true };
      if (message.action === "getNotes") return { success: true, notes: [] };
      return {};
    },
  });

  await harness.dispatchDocumentEvent("DOMContentLoaded");
  harness.helpers.switchTab("transcript");
  harness.helpers.switchTab("overview");
  assert.equal(analysisCalls, 0);

  now += 1;
  const action = Array.from(
    harness.nodes.deepAnalysisActionBtn.listeners.get("click") || [],
  )[0];
  assert.equal(typeof action, "function");
  const first = action();
  await waitUntil(() => baseCalls === 1);
  const second = action();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(baseCalls, 1);
  assert.equal(analysisCalls, 0);
  assert.equal(harness.nodes.deepAnalysisCard.getAttribute("aria-busy"), "true");
  assert.equal(harness.nodes.deepAnalysisActionBtn.disabled, true);

  baseGate.resolve(digestBaseSuccess(now));
  await waitUntil(() => analysisCalls === 1);
  const third = action();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(analysisCalls, 1);

  analysisGate.resolve({ success: true, analysis: completeDeepAnalysis("Manual") });
  await Promise.all([first, second, third]);
  assert.equal(harness.nodes.deepAnalysisCard.getAttribute("aria-busy"), "false");
  assert.equal(harness.nodes.deepAnalysisResults.style.display, "block");
});

test("automatic basic overview waits for fresh base acknowledgement and uses normalized config", async () => {
  const baseGate = deferred();
  let overviewCalls = 0;
  const harness = loadSidepanel({
    tabsQuery: async () => [{
      id: 11,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }],
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getVocabulary") {
        return { success: true, entries: [] };
      }
      if (message.action === "checkConfig") {
        return {
          hasSupadataKey: true,
          hasAiKey: true,
          autoBasicOverview: true,
          aiApiKey: "must-not-be-stored",
        };
      }
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return {
          success: true,
          response: { title: "Video A", channelName: "Channel A" },
        };
      }
      if (message.action === "fetchTranscript") return transcriptResult("A");
      if (message.action === "persistDigestBase") return baseGate.promise;
      if (message.action === "getNotes") return { success: true, notes: [] };
      if (message.action === "requestBasicOverview") {
        overviewCalls += 1;
        return {
          success: true,
          overview: basicOverviewForRequest(message),
        };
      }
      return {};
    },
  });

  const ready = harness.dispatchDocumentEvent("DOMContentLoaded");
  await waitUntil(() =>
    harness.runtimeMessages.some(
      (message) => message.action === "persistDigestBase",
    )
  );
  assert.equal(overviewCalls, 0, "automatic work must wait for base durability");

  baseGate.resolve(digestBaseSuccess());
  await ready;
  await waitUntil(() => overviewCalls === 1);

  const request = harness.runtimeMessages.find(
    (message) => message.action === "requestBasicOverview",
  );
  assert.equal(request.intent, "automatic");
  assert.equal(request.videoId, "AAAAAA");
  assert.equal(request.payload.transcriptLanguage, "en");
  assert.match(
    request.payload.transcriptFingerprint,
    /^sha256-v1-[a-f0-9]{64}$/,
  );
  assert.equal(Object.hasOwn(request, "attemptId"), false);
  assert.equal(Object.hasOwn(request, "attemptRevision"), false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.helpers.getBasicOverviewState().config)),
    {
      hasSupadataKey: true,
      hasAiKey: true,
      autoBasicOverview: true,
    },
  );
});

test("cache load requests automatic overview once only when no usable matching overview exists", async (t) => {
  for (const scenario of [
    { name: "missing", overview: null, expectedCalls: 1 },
    { name: "usable partial", overview: "partial", expectedCalls: 0 },
    { name: "complete", overview: "complete", expectedCalls: 0 },
  ]) {
    await t.test(scenario.name, async () => {
      const cached = await cachedDigestV2(`cached ${scenario.name}`);
      const segments = transcriptCore.groupTranscriptEntries(cached.transcript);
      if (scenario.overview) {
        cached.basicOverview = basicOverviewForTranscript(
          cached.transcriptFingerprint,
          segments,
          { complete: scenario.overview === "complete" },
        );
      }
      let overviewCalls = 0;
      const harness = loadSidepanel({
        tabsQuery: async () => [{
          id: 11,
          windowId: 7,
          active: true,
          url: "https://www.youtube.com/watch?v=AAAAAA",
        }],
        storageGet: async (query) =>
          query === "digest_AAAAAA" ? { digest_AAAAAA: cached } : {},
        sendMessage(message) {
          if (message.action === "getVocabulary") {
            return { success: true, entries: [] };
          }
          if (message.action === "checkConfig") {
            return {
              hasSupadataKey: true,
              hasAiKey: true,
              autoBasicOverview: true,
            };
          }
          if (message.action === "getResetEpoch") {
            return { success: true, resetEpoch: 0 };
          }
          if (message.action === "relayToContent") {
            return { success: true, response: {} };
          }
          if (message.action === "requestBasicOverview") {
            overviewCalls += 1;
            return {
              success: true,
              overview: basicOverviewForRequest(message),
            };
          }
          if (message.action === "fetchTranscript") {
            throw new Error("cache overview orchestration must reuse transcript");
          }
          if (message.action === "getNotes") {
            return { success: true, notes: [] };
          }
          return {};
        },
      });

      await harness.dispatchDocumentEvent("DOMContentLoaded");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(overviewCalls, scenario.expectedCalls);
      const state = harness.helpers.getBasicOverviewState();
      if (scenario.overview) {
        assert.equal(
          state.overview.transcriptFingerprint,
          cached.transcriptFingerprint,
        );
      }
    });
  }
});

test("same-session automatic requests coalesce and remain attempted until reset", async () => {
  const cached = await cachedDigestV2("coalesced A");
  const overviewGate = deferred();
  let overviewCalls = 0;
  const harness = loadSidepanel({
    tabsQuery: async () => [{
      id: 11,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }],
    storageGet: async (query) =>
      query === "digest_AAAAAA" ? { digest_AAAAAA: cached } : {},
    sendMessage(message) {
      if (message.action === "getVocabulary") {
        return { success: true, entries: [] };
      }
      if (message.action === "checkConfig") {
        return {
          hasSupadataKey: true,
          hasAiKey: true,
          autoBasicOverview: true,
        };
      }
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: {} };
      }
      if (message.action === "requestBasicOverview") {
        overviewCalls += 1;
        return overviewGate.promise;
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      return {};
    },
  });

  await harness.dispatchDocumentEvent("DOMContentLoaded");
  await waitUntil(() => overviewCalls === 1);
  const token = harness.helpers.captureVideoSnapshot().token;
  const coalesced = harness.helpers.requestBasicOverview("automatic", token);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(overviewCalls, 1);

  const request = harness.runtimeMessages.find(
    (message) => message.action === "requestBasicOverview",
  );
  overviewGate.resolve({
    success: true,
    overview: basicOverviewForRequest(request),
  });
  await coalesced;
  await harness.helpers.requestBasicOverview("automatic", token);
  assert.equal(overviewCalls, 1, "automatic attempt set lasts for the session");

  harness.helpers.resetVideoBoundUi();
  const state = harness.helpers.getBasicOverviewState();
  assert.equal(state.overview, null);
  assert.equal(state.failure, null);
  assert.equal(state.inFlightCount, 0);
  assert.equal(state.automaticRequestedCount, 0);
});

test("manual basic overview bypasses consent and reuses the in-memory transcript", async () => {
  const cached = await cachedDigestV2("manual A");
  const requestGate = deferred();
  let transcriptFetches = 0;
  let overviewCalls = 0;
  const harness = loadSidepanel({
    tabsQuery: async () => [{
      id: 11,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }],
    storageGet: async (query) =>
      query === "digest_AAAAAA" ? { digest_AAAAAA: cached } : {},
    sendMessage(message) {
      if (message.action === "getVocabulary") {
        return { success: true, entries: [] };
      }
      if (message.action === "checkConfig") {
        return {
          hasSupadataKey: true,
          hasAiKey: true,
          autoBasicOverview: false,
        };
      }
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: {} };
      }
      if (message.action === "fetchTranscript") {
        transcriptFetches += 1;
        return transcriptResult("paid fallback");
      }
      if (message.action === "requestBasicOverview") {
        overviewCalls += 1;
        return requestGate.promise;
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      return {};
    },
  });

  await harness.dispatchDocumentEvent("DOMContentLoaded");
  assert.equal(overviewCalls, 0, "disabled automatic consent must fast-gate");
  const token = harness.helpers.captureVideoSnapshot().token;
  const first = harness.helpers.requestBasicOverview("manual_retry", token);
  const second = harness.helpers.requestBasicOverview("manual_retry", token);
  await waitUntil(() => overviewCalls === 1);
  assert.equal(transcriptFetches, 0);
  const request = harness.runtimeMessages.find(
    (message) => message.action === "requestBasicOverview",
  );
  assert.equal(request.intent, "manual_retry");
  requestGate.resolve({
    success: true,
    overview: basicOverviewForRequest(request),
  });
  await Promise.all([first, second]);
  assert.equal(
    harness.helpers.getBasicOverviewState().overview.oneSentenceZh,
    "可信的一句话概览",
  );
});

test("late overview A cannot overwrite or clear the in-flight overview B", async () => {
  let activeTab = {
    id: 11,
    windowId: 7,
    active: true,
    url: "https://www.youtube.com/watch?v=AAAAAA",
  };
  const requests = new Map();
  const harness = loadSidepanel({
    tabsQuery: async () => [activeTab],
    storageGet: async () => ({}),
    sendMessage(message) {
      if (message.action === "getVocabulary") {
        return { success: true, entries: [] };
      }
      if (message.action === "checkConfig") {
        return {
          hasSupadataKey: true,
          hasAiKey: true,
          autoBasicOverview: true,
        };
      }
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: {} };
      }
      if (message.action === "fetchTranscript") {
        return transcriptResult(message.videoId === "AAAAAA" ? "A" : "B");
      }
      if (message.action === "persistDigestBase") return digestBaseSuccess();
      if (message.action === "requestBasicOverview") {
        const gate = deferred();
        requests.set(message.videoId, { gate, message });
        return gate.promise;
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      return {};
    },
  });

  await harness.dispatchDocumentEvent("DOMContentLoaded");
  await waitUntil(() => requests.has("AAAAAA"));

  activeTab = {
    id: 12,
    windowId: 7,
    active: true,
    url: "https://www.youtube.com/watch?v=BBBBBB",
  };
  await harness.helpers.checkCurrentTab();
  await waitUntil(() => requests.has("BBBBBB"));
  const tokenB = harness.helpers.captureVideoSnapshot().token;
  assert.equal(harness.nodes.overviewLoadingState.style.display, "flex");

  const a = requests.get("AAAAAA");
  a.gate.resolve({
    success: true,
    overview: basicOverviewForRequest(a.message, {
      oneSentenceZh: "A must be ignored",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  const coalescedB = harness.helpers.requestBasicOverview("automatic", tokenB);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    harness.runtimeMessages.filter(
      (message) => message.action === "requestBasicOverview",
    ).length,
    2,
    "A completion must not remove B's in-flight coalescing entry",
  );
  assert.notEqual(
    harness.helpers.getBasicOverviewState().overview?.oneSentenceZh,
    "A must be ignored",
  );
  assert.equal(
    harness.nodes.overviewLoadingState.style.display,
    "flex",
    "late A completion must not clear B's loading UI",
  );

  const b = requests.get("BBBBBB");
  b.gate.resolve({
    success: true,
    overview: basicOverviewForRequest(b.message, {
      oneSentenceZh: "B remains current",
    }),
  });
  await coalescedB;
  await waitUntil(() =>
    harness.helpers.getBasicOverviewState().overview?.oneSentenceZh ===
      "B remains current"
  );
  assert.equal(harness.nodes.overviewReadyState.style.display, "grid");
  assert.equal(harness.nodes.overviewOneSentence.textContent, "B remains current");
});

test("overview cache failure retains trusted overview and retries with only its opaque token", async () => {
  const cached = await cachedDigestV2("recovery A");
  let overviewRequest = null;
  const harness = loadSidepanel({
    tabsQuery: async () => [{
      id: 11,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }],
    storageGet: async (query) =>
      query === "digest_AAAAAA" ? { digest_AAAAAA: cached } : {},
    sendMessage(message) {
      if (message.action === "getVocabulary") {
        return { success: true, entries: [] };
      }
      if (message.action === "checkConfig") {
        return {
          hasSupadataKey: true,
          hasAiKey: true,
          autoBasicOverview: false,
        };
      }
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: {} };
      }
      if (message.action === "requestBasicOverview") {
        overviewRequest = message;
        return {
          success: false,
          code: "OVERVIEW_CACHE_WRITE_FAILED",
          provider: "deepseek",
          stage: "overview_cache",
          retryable: true,
          primaryAction: "retry_cache_write",
          mayHaveConsumedCredit: true,
          providerSucceeded: true,
          overview: basicOverviewForRequest(message),
          recoveryToken: "opaque-recovery-token",
        };
      }
      if (message.action === "retryBasicOverviewCacheWrite") {
        return {
          success: true,
          overview: basicOverviewForRequest(overviewRequest),
        };
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      return {};
    },
  });

  await harness.dispatchDocumentEvent("DOMContentLoaded");
  const token = harness.helpers.captureVideoSnapshot().token;
  await harness.helpers.requestBasicOverview("manual_retry", token);
  const failedState = harness.helpers.getBasicOverviewState();
  assert.equal(failedState.overview.oneSentenceZh, "可信的一句话概览");
  assert.equal(failedState.failure.code, "OVERVIEW_CACHE_WRITE_FAILED");
  assert.equal(failedState.failure.primaryAction, "retry_cache_write");
  assert.equal(failedState.failure.recoveryToken, "opaque-recovery-token");

  await harness.helpers.retryBasicOverviewCacheWrite(token);
  const retry = harness.runtimeMessages.find(
    (message) => message.action === "retryBasicOverviewCacheWrite",
  );
  assert.deepEqual(Object.keys(retry).sort(), [
    "action",
    "recoveryToken",
    "sessionToken",
    "videoId",
  ]);
  assert.equal(retry.recoveryToken, "opaque-recovery-token");
  assert.equal(JSON.stringify(retry).includes("attempt"), false);
  assert.equal(JSON.stringify(retry).includes("overview"), false);
  assert.equal(
    harness.runtimeMessages.filter(
      (message) => message.action === "requestBasicOverview",
    ).length,
    1,
  );
});

test("an expired in-memory digest base renews before a manual overview request", async (t) => {
  for (const renewalSucceeds of [true, false]) {
    await t.test(renewalSucceeds ? "renewal succeeds" : "renewal fails free", async () => {
      let now = Date.now();
      const cached = await cachedDigestV2("renew manual A", {
        timestamp: now - THIRTY_DAYS_MS + 1_000,
      });
      const renewalGate = deferred();
      let renewals = 0;
      let overviewCalls = 0;
      let transcriptFetches = 0;
      const harness = loadSidepanel({
        now: () => now,
        tabsQuery: async () => [{
          id: 11,
          windowId: 7,
          active: true,
          url: "https://www.youtube.com/watch?v=AAAAAA",
        }],
        storageGet: async (query) =>
          query === "digest_AAAAAA" ? { digest_AAAAAA: cached } : {},
        sendMessage(message) {
          if (message.action === "getVocabulary") {
            return { success: true, entries: [] };
          }
          if (message.action === "checkConfig") {
            return {
              hasSupadataKey: true,
              hasAiKey: true,
              autoBasicOverview: false,
            };
          }
          if (message.action === "getResetEpoch") {
            return { success: true, resetEpoch: 0 };
          }
          if (message.action === "relayToContent") {
            return { success: true, response: {} };
          }
          if (message.action === "persistDigestBase") {
            renewals += 1;
            return renewalGate.promise;
          }
          if (message.action === "requestBasicOverview") {
            overviewCalls += 1;
            return {
              success: true,
              overview: basicOverviewForRequest(message),
            };
          }
          if (message.action === "fetchTranscript") {
            transcriptFetches += 1;
            return transcriptResult("paid fallback");
          }
          if (message.action === "getNotes") {
            return { success: true, notes: [] };
          }
          return {};
        },
      });

      await harness.dispatchDocumentEvent("DOMContentLoaded");
      const token = harness.helpers.captureVideoSnapshot().token;
      now += 2_000;
      const pending = harness.helpers.requestBasicOverview(
        "manual_retry",
        token,
      );
      await waitUntil(() => renewals === 1);
      assert.equal(overviewCalls, 0, "renewal acknowledgement must precede intent");
      renewalGate.resolve(
        renewalSucceeds
          ? digestBaseSuccess(now)
          : { success: false, code: "STORAGE_WRITE_FAILED" },
      );
      const result = await pending;

      assert.equal(overviewCalls, renewalSucceeds ? 1 : 0);
      assert.equal(transcriptFetches, 0);
      if (renewalSucceeds) {
        assert.equal(result.success, true);
      } else {
        assert.equal(result.success, false);
        assert.equal(result.code, "DIGEST_BASE_NOT_READY");
        assert.equal(result.mayHaveConsumedCredit, false);
      }
    });
  }
});

test("already-attempted overview responses retain their bounded durable failure", async () => {
  const cached = await cachedDigestV2("durable failure A");
  const harness = loadSidepanel({
    tabsQuery: async () => [{
      id: 11,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }],
    storageGet: async (query) =>
      query === "digest_AAAAAA" ? { digest_AAAAAA: cached } : {},
    sendMessage(message) {
      if (message.action === "getVocabulary") {
        return { success: true, entries: [] };
      }
      if (message.action === "checkConfig") {
        return {
          hasSupadataKey: true,
          hasAiKey: true,
          autoBasicOverview: false,
        };
      }
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: {} };
      }
      if (message.action === "requestBasicOverview") {
        return {
          success: true,
          skipped: "already_attempted",
          disposition: "failed",
          retryAfterMs: 42_000,
          failure: {
            code: "REQUEST_TIMEOUT",
            provider: "deepseek",
            stage: "overview",
            retryable: true,
            primaryAction: "retry",
            mayHaveConsumedCredit: true,
            raw: "must not survive",
          },
        };
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      return {};
    },
  });

  await harness.dispatchDocumentEvent("DOMContentLoaded");
  const token = harness.helpers.captureVideoSnapshot().token;
  const result = await harness.helpers.requestBasicOverview(
    "manual_retry",
    token,
  );
  const state = harness.helpers.getBasicOverviewState();

  assert.equal(result.success, true);
  assert.equal(result.skipped, "already_attempted");
  assert.equal(result.disposition, "failed");
  assert.equal(result.retryAfterMs, 42_000);
  assert.equal(state.overview, null);
  assert.deepEqual(JSON.parse(JSON.stringify(state.failure)), {
    success: false,
    code: "REQUEST_TIMEOUT",
    provider: "deepseek",
    stage: "overview",
    retryable: true,
    primaryAction: "retry",
    mayHaveConsumedCredit: true,
  });
});

test("overview response without the exact current session echo cannot mutate panel state", async () => {
  const cached = await cachedDigestV2("stale response A");
  const harness = loadSidepanel({
    autoEchoSessionToken: false,
    tabsQuery: async () => [{
      id: 11,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }],
    storageGet: async (query) =>
      query === "digest_AAAAAA" ? { digest_AAAAAA: cached } : {},
    sendMessage(message) {
      if (message.action === "getVocabulary") {
        return { success: true, entries: [] };
      }
      if (message.action === "checkConfig") {
        return {
          hasSupadataKey: true,
          hasAiKey: true,
          autoBasicOverview: false,
        };
      }
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "bindVideoSession") {
        return { success: true, sessionToken: message.sessionToken };
      }
      if (message.action === "relayToContent") {
        return {
          success: true,
          response: {},
          sessionToken: message.sessionToken,
        };
      }
      if (message.action === "requestBasicOverview") {
        return {
          success: true,
          overview: basicOverviewForRequest(message),
        };
      }
      if (message.action === "getNotes") {
        return {
          success: true,
          notes: [],
          sessionToken: message.sessionToken,
        };
      }
      return {};
    },
  });

  await harness.dispatchDocumentEvent("DOMContentLoaded");
  const token = harness.helpers.captureVideoSnapshot().token;
  await harness.helpers.requestBasicOverview("manual_retry", token);
  const state = harness.helpers.getBasicOverviewState();
  assert.equal(state.overview, null);
  assert.equal(state.failure, null);
});

test("side panel has no direct local-storage mutation or arbitrary-tab fallback", () => {
  const source = read("sidepanel.js");
  const checkStart = source.indexOf("async function checkCurrentTab");
  const checkEnd = source.indexOf("function extractVideoId", checkStart);
  const checkSource = source.slice(checkStart, checkEnd);

  assert.doesNotMatch(source, /chrome\.storage\.local\.(?:set|remove|clear)\s*\(/);
  assert.doesNotMatch(checkSource, /lastFocusedWindow|url:\s*["']https:\/\/www\.youtube\.com\/\*["']/);
  assert.doesNotMatch(source, /persistDigestCache|saveToCache|updateCache/);
  assert.match(source, /action:\s*["']persistDigestBase["']/);
  assert.match(source, /expectedEpoch:\s*token\.resetEpoch/);
  assert.match(source, /action:\s*["']relayToContent["'][\s\S]{0,180}?tabId:\s*token\.tabId/);
});

test("evidence dialog copies exact local text and seeks with the captured session", async () => {
  const copied = [];
  const cached = await cachedDigestV2("evidence A");
  const sourceSegments = transcriptCore.groupTranscriptEntries(cached.transcript);
  cached.basicOverview = basicOverviewForTranscript(
    cached.transcriptFingerprint,
    sourceSegments,
    {
      conclusions: [{
        id: "conclusion-1",
        titleZh: "可核验结论",
        explanationZh: "AI 解释不能被当成原文复制。",
        evidenceLevel: "strong",
        evidenceSegmentIds: [sourceSegments[0].id],
      }],
    },
  );
  const harness = loadSidepanel({
    clipboardWrite(value) {
      copied.push(value);
    },
    tabsQuery: async () => [{
      id: 11,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }],
    storageGet: async (query) =>
      query === "digest_AAAAAA" ? { digest_AAAAAA: cached } : {},
    sendMessage(message) {
      if (message.action === "getVocabulary") return { success: true, entries: [] };
      if (message.action === "checkConfig") {
        return { hasSupadataKey: true, hasAiKey: false, autoBasicOverview: false };
      }
      if (message.action === "getResetEpoch") {
        return { success: true, resetEpoch: 0 };
      }
      if (message.action === "relayToContent") {
        return { success: true, response: {} };
      }
      if (message.action === "getNotes") return { success: true, notes: [] };
      return {};
    },
  });

  await harness.dispatchDocumentEvent("DOMContentLoaded");
  const evidenceButton = harness.dynamicNodes.find(
    (node) => node.className === "overview-evidence-btn" && node.isConnected,
  );
  assert.ok(evidenceButton);
  const messagesBefore = harness.runtimeMessages.length;
  await clickNode(evidenceButton);

  assert.equal(harness.nodes.evidenceDialog.open, true);
  assert.equal(
    harness.nodes.evidenceExactText.textContent,
    sourceSegments[0].text,
  );
  assert.equal(
    harness.nodes.evidenceAiExplanation.textContent,
    cached.basicOverview.conclusions[0].explanationZh,
  );
  assert.equal(harness.nodes.evidenceExactText.innerHTML, "");

  await clickNode(harness.nodes.evidenceCopyBtn);
  assert.deepEqual(copied, [sourceSegments[0].text]);
  assert.equal(copied[0].includes("AI 解释"), false);

  await clickNode(harness.nodes.evidenceSeekBtn);
  const seek = harness.runtimeMessages.find(
    (message) =>
      message.action === "relayToContent" && message.payload?.action === "seekTo",
  );
  assert.equal(seek.payload.seconds, sourceSegments[0].start);
  assert.equal(seek.tabId, 11);
  assert.equal(seek.sessionToken.videoId, "AAAAAA");
  assert.equal(
    harness.runtimeMessages.slice(messagesBefore).some((message) =>
      ["requestBasicOverview", "analyzeTranscript", "patchDigestCache"].includes(
        message.action,
      ),
    ),
    false,
  );
});

test("evidence dialog traps focus and stale reset actions become no-ops", async () => {
  const copied = [];
  const cached = await cachedDigestV2("evidence reset");
  const sourceSegments = transcriptCore.groupTranscriptEntries(cached.transcript);
  cached.basicOverview = basicOverviewForTranscript(
    cached.transcriptFingerprint,
    sourceSegments,
  );
  const harness = loadSidepanel({
    clipboardWrite(value) {
      copied.push(value);
    },
    tabsQuery: async () => [{
      id: 11,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=AAAAAA",
    }],
    storageGet: async (query) =>
      query === "digest_AAAAAA" ? { digest_AAAAAA: cached } : {},
    sendMessage(message) {
      if (message.action === "getVocabulary") return { success: true, entries: [] };
      if (message.action === "checkConfig") {
        return { hasSupadataKey: true, hasAiKey: false, autoBasicOverview: false };
      }
      if (message.action === "getResetEpoch") return { success: true, resetEpoch: 0 };
      if (message.action === "relayToContent") return { success: true, response: {} };
      if (message.action === "getNotes") return { success: true, notes: [] };
      return {};
    },
  });

  await harness.dispatchDocumentEvent("DOMContentLoaded");
  const evidenceButton = harness.dynamicNodes.find(
    (node) => node.className === "overview-evidence-btn" && node.isConnected,
  );
  await clickNode(evidenceButton);
  const keydown = Array.from(
    harness.nodes.evidenceDialog.listeners.get("keydown") || [],
  )[0];
  assert.equal(typeof keydown, "function");
  harness.helpers.setupEventListeners();
  assert.equal(harness.nodes.evidenceDialog.listeners.get("keydown").size, 1);
  assert.equal(harness.nodes.evidenceCopyBtn.listeners.get("click").size, 1);
  harness.nodes.evidenceDialogCloseBtn.focus();
  let prevented = false;
  keydown({
    key: "Tab",
    shiftKey: true,
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  assert.equal(harness.getActiveElement(), harness.nodes.evidenceSeekBtn);

  keydown({ key: "Escape", preventDefault() {} });
  assert.equal(harness.nodes.evidenceDialog.open, false);
  assert.equal(harness.getActiveElement(), evidenceButton);
  await clickNode(evidenceButton);

  const staleCopy = Array.from(
    harness.nodes.evidenceCopyBtn.listeners.get("click") || [],
  )[0];
  const staleSeek = Array.from(
    harness.nodes.evidenceSeekBtn.listeners.get("click") || [],
  )[0];
  const messagesBeforeReset = harness.runtimeMessages.length;
  harness.helpers.resetVideoBoundUi();
  evidenceButton.isConnected = false;
  assert.equal(harness.nodes.evidenceDialog.open, false);
  await staleCopy();
  await staleSeek();
  assert.deepEqual(copied, []);
  assert.equal(harness.runtimeMessages.length, messagesBeforeReset);
  assert.notEqual(harness.getActiveElement(), evidenceButton);
});

test("concrete notes, translation, playback, cache, and export effects are session-gated", () => {
  const source = read("sidepanel.js");
  const between = (startName, endName) => {
    const start = source.indexOf(startName);
    const end = source.indexOf(endName, start + startName.length);
    assert.ok(start >= 0 && end > start, `${startName} source should be bounded`);
    return source.slice(start, end);
  };

  const notes = between("async function loadNotes", "function renderNotes");
  assert.match(notes, /await sendVideoSessionMessage/);
  assert.match(notes, /isCurrentSessionResponse\(token, result\)[\s\S]*?renderNotes/);

  const translation = between(
    "async function requestTranscriptTranslationBatch",
    "function retryTranslationSegment",
  );
  assert.match(translation, /await sendTranslationMessage/);
  assert.match(translation, /isCurrentSessionResponse\(token, result\)/);
  assert.match(
    translation,
    /updateTranslatedRow[\s\S]*?patchDigestCache\(\{ paragraphCache: paragraphDelta \}, token\)/,
  );

  const playback = between(
    "async function playbackTrackingTick",
    "function scrollToActiveEntry",
  );
  assert.match(playback, /tabId: token\.tabId/);
  assert.match(playback, /isCurrentSessionResponse\(token, result\)[\s\S]*?highlightActiveEntry/);

  const cache = between("async function persistDigestBase", "async function loadFromCache");
  assert.match(cache, /expectedEpoch: token\.resetEpoch/);
  assert.match(cache, /isCurrentSessionResponse\(token, result\)/);

  const exports = between("function captureVideoSnapshot", "function escapeMarkdownText");
  assert.match(exports, /copyToClipboardWithFeedback[\s\S]*?snapshot\.token/);
  assert.match(exports, /isCurrentVideoSession\(snapshot\.token\)[\s\S]*?downloadTextFile/);
  assert.match(
    source,
    /function exportDeepAnalysis[\s\S]*?isCurrentVideoSession\(snapshot\.token\)[\s\S]*?downloadTextFile/,
  );
});
