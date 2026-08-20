const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const transcriptCore = require("../transcript-core.js");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const clone = (value) => structuredClone(value);

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settleWithin(promise, timeoutMs = 50) {
  let timeoutId;
  const outcome = await Promise.race([
    Promise.resolve(promise).then(
      (value) => ({ kind: "resolved", value }),
      (error) => ({ kind: "rejected", error }),
    ),
    new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    }),
  ]);
  clearTimeout(timeoutId);
  return outcome;
}

async function waitUntil(predicate, turns = 30) {
  for (let turn = 0; turn < turns; turn += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("Timed out waiting for deferred background stage");
}

function pickStored(state, query) {
  if (query === null || query === undefined) return clone(state);
  if (typeof query === "string") {
    return Object.hasOwn(state, query) ? { [query]: clone(state[query]) } : {};
  }
  if (Array.isArray(query)) {
    return Object.fromEntries(
      query
        .filter((key) => Object.hasOwn(state, key))
        .map((key) => [key, clone(state[key])]),
    );
  }
  if (query && typeof query === "object") {
    return Object.fromEntries(
      Object.entries(query).map(([key, fallback]) => [
        key,
        Object.hasOwn(state, key) ? clone(state[key]) : clone(fallback),
      ]),
    );
  }
  return {};
}

function loadBackground(options = {}) {
  const state = options.sharedState || clone(
    options.initialState || {
      ytd_settings: {
        provider: "deepseek",
        aiApiKey: "",
        aiBaseUrl: "https://api.deepseek.com",
        aiModel: "deepseek-v4-flash",
        supadataApiKey: "",
        autoBasicOverview: false,
      },
      ytd_reset_epoch: 0,
    },
  );
  const imports = [];
  const runtimeListeners = [];
  const broadcasts = [];
  const storageEvents = [];
  const storageWrites = [];
  const responseCallbacks = [];
  const tabUpdatedListeners = [];
  const tabActivatedListeners = [];
  const tabRemovedListeners = [];
  const windowRemovedListeners = [];
  const storageChangedListeners = [];
  const firstEpochGate = options.blockFirstEpochRead ? deferred() : null;
  let didBlockFirstEpoch = false;
  let epochReadCount = 0;
  let coordinatorCreations = 0;
  let fetchCalls = 0;
  const fetchUrls = [];
  let pendingStorageOperations = 0;
  let activeStorageOperations = 0;
  let maxConcurrentStorageOperations = 0;
  let activeWrites = 0;
  let maxConcurrentWrites = 0;
  let failNextSetMessage = options.failNextSetMessage || "";
  let uuidCounter = 0;
  let randomValueCalls = 0;
  let timerCreations = 0;
  let reentryResponse = null;
  let reentryAttempted = false;
  let tabGetCount = 0;

  async function tracked(kind, operation) {
    pendingStorageOperations += 1;
    activeStorageOperations += 1;
    maxConcurrentStorageOperations = Math.max(
      maxConcurrentStorageOperations,
      activeStorageOperations,
    );
    storageEvents.push(`${kind}:start`);
    try {
      return await operation();
    } finally {
      storageEvents.push(`${kind}:end`);
      activeStorageOperations -= 1;
      pendingStorageOperations -= 1;
    }
  }

  const local = {
    async setAccessLevel() {},
    get(query) {
      return tracked("get", async () => {
        if (options.storageGetFailure) {
          const failure = await options.storageGetFailure(query, { state });
          if (failure) throw failure;
        }
        if (query === "ytd_reset_epoch") epochReadCount += 1;
        if (options.storageGetHook) {
          await options.storageGetHook(query, {
            state,
            tabGetCount,
            epochReadCount,
          });
        }
        if (
          options.reenterOnProviderRead &&
          !reentryAttempted &&
          Array.isArray(query) &&
          query.includes("ytd_provider_status")
        ) {
          reentryAttempted = true;
          reentryResponse = new Promise((resolve) => {
            runtimeListeners[0]({ action: "resetExtensionData" }, {}, (value) =>
              resolve(clone(value)),
            );
          });
        }
        if (
          firstEpochGate &&
          !didBlockFirstEpoch &&
          query === "ytd_reset_epoch"
        ) {
          if (epochReadCount > (options.blockEpochReadAfter || 0)) {
            didBlockFirstEpoch = true;
            await firstEpochGate.promise;
          }
        }
        await Promise.resolve();
        const encoded = JSON.stringify(pickStored(state, query));
        return vm.runInContext(`JSON.parse(${JSON.stringify(encoded)})`, context);
      });
    },
    set(items) {
      return tracked("set", async () => {
        activeWrites += 1;
        maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites);
        try {
          await Promise.resolve();
          if (failNextSetMessage) {
            const message = failNextSetMessage;
            failNextSetMessage = "";
            throw new Error(message);
          }
          if (options.storageSetHook) {
            const handled = await options.storageSetHook(clone(items), {
              state,
              storageWrites: clone(storageWrites),
            });
            if (handled === true) {
              storageWrites.push(clone(items));
              return;
            }
          }
          storageWrites.push(clone(items));
          Object.assign(state, clone(items));
        } finally {
          activeWrites -= 1;
        }
      });
    },
    remove(keys) {
      return tracked("remove", async () => {
        activeWrites += 1;
        maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites);
        try {
          await Promise.resolve();
          if (options.ignoreRemovals) return;
          for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
        } finally {
          activeWrites -= 1;
        }
      });
    },
    async getBytesInUse(keys) {
      const selected = pickStored(state, keys);
      return Buffer.byteLength(JSON.stringify(selected), "utf8");
    },
  };

  const event = () => ({ addListener() {} });
  const sandbox = {
    console: {
      log() {},
      warn() {},
      error() {},
    },
    URL,
    TextDecoder,
    TextEncoder:
      options.TextEncoder === undefined ? TextEncoder : options.TextEncoder,
    AbortController,
    setTimeout(callback, delay, ...args) {
      timerCreations += 1;
      return setTimeout(callback, delay, ...args);
    },
    clearTimeout,
    Date: options.Date || Date,
    Math,
    navigator: options.navigator === undefined
      ? { onLine: true }
      : options.navigator,
    crypto:
      options.crypto === undefined
        ? {
            subtle: webcrypto.subtle,
            randomUUID: () =>
              `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`,
            getRandomValues(target) {
              randomValueCalls += 1;
              uuidCounter += 1;
              target.fill(uuidCounter % 251 || 1);
              return target;
            },
          }
        : options.crypto,
    fetch: async (...args) => {
      fetchCalls += 1;
      fetchUrls.push(String(args[0]));
      if (options.fetch) return options.fetch(...args);
      throw new Error("Unexpected provider request in persistence test");
    },
    chrome: {
      storage: {
        local,
        onChanged: {
          addListener(listener) {
            storageChangedListeners.push(listener);
          },
        },
      },
      action: { onClicked: event() },
      sidePanel: {
        setPanelBehavior() {},
        setOptions: async () => {},
        open: async () => {},
      },
      runtime: {
        onInstalled: event(),
        onMessage: {
          addListener(listener) {
            runtimeListeners.push(listener);
          },
        },
        openOptionsPage() {},
        getURL: (resource) => `chrome-extension://test/${resource}`,
        sendMessage(message) {
          broadcasts.push(clone(message));
          if (options.runtimeSendMessage) {
            return options.runtimeSendMessage(clone(message));
          }
          return Promise.resolve({});
        },
      },
      tabs: {
        onUpdated: {
          addListener(listener) {
            tabUpdatedListeners.push(listener);
          },
        },
        onActivated: {
          addListener(listener) {
            tabActivatedListeners.push(listener);
          },
        },
        onRemoved: {
          addListener(listener) {
            tabRemovedListeners.push(listener);
          },
        },
        get: async (tabId) => {
          tabGetCount += 1;
          if (options.tabsGet) {
            return clone(await options.tabsGet(tabId, tabGetCount));
          }
          return {
            id: tabId,
            windowId: 7,
            active: true,
            url: "https://www.youtube.com/watch?v=abc123",
          };
        },
        query: async () => [],
        sendMessage: async (tabId, payload) =>
          options.tabsSendMessage
            ? options.tabsSendMessage(tabId, clone(payload))
            : {},
      },
      windows: {
        onRemoved: {
          addListener(listener) {
            windowRemovedListeners.push(listener);
          },
        },
      },
      scripting: { executeScript: async () => [] },
    },
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  sandbox.importScripts = (...files) => {
    for (const file of files) {
      imports.push(file);
      vm.runInContext(read(file), context, { filename: file });
      if (file === "settings.js" && options.preserveAiModel) {
        const normalize = sandbox.YTD_SETTINGS.normalize;
        sandbox.YTD_SETTINGS.normalize = (value) => ({
          ...normalize(value),
          aiModel:
            typeof value?.aiModel === "string" && value.aiModel.trim()
              ? value.aiModel.trim()
              : "deepseek-v4-flash",
        });
      }
      if (file === "persistence.js") {
        const create = sandbox.YTD_PERSISTENCE.createMutationCoordinator;
        sandbox.YTD_PERSISTENCE.createMutationCoordinator = (...args) => {
          coordinatorCreations += 1;
          const coordinator = create(...args);
          return options.wrapCoordinator
            ? options.wrapCoordinator(coordinator)
            : coordinator;
        };
      }
    }
  };

  vm.runInContext(read("background.js"), context, { filename: "background.js" });

  async function send(message, sender) {
    const effectiveSender = sender === undefined
      ? message.action === "saveNote" && !message.sessionToken
        ? {
            tab: {
              id: 1,
              windowId: 7,
              active: true,
              url: "https://www.youtube.com/watch?v=abc123",
            },
          }
        : {
            documentId: options.panelDocumentId || "panel-document-1",
            url: "chrome-extension://test/sidepanel.html",
          }
      : sender;
    const listener = runtimeListeners[0];
    assert.ok(listener, "background message listener should be registered");
    sandbox.__runtimeMessageJson = JSON.stringify(message);
    const contextualMessage = vm.runInContext(
      "JSON.parse(__runtimeMessageJson)",
      context,
    );
    delete sandbox.__runtimeMessageJson;
    const responseCallback = { action: message.action, count: 0 };
    responseCallbacks.push(responseCallback);
    return new Promise((resolve, reject) => {
      let settled = false;
      const result = listener(contextualMessage, effectiveSender, (response) => {
        responseCallback.count += 1;
        if (!settled) {
          settled = true;
          resolve(clone(response));
        }
      });
      if (result !== true && !settled) {
        if (
          message.action === "requestBasicOverview" ||
          message.action === "retryBasicOverviewCacheWrite"
        ) {
          settled = true;
          resolve({ success: false, code: "UNHANDLED_TEST_ROUTE" });
          return;
        }
        reject(new Error(`Message was not handled: ${message.action}`));
      }
    });
  }

  function dispatchUnhandled(message, sender) {
    const effectiveSender = sender || {
      documentId: options.panelDocumentId || "panel-document-1",
      url: "chrome-extension://test/sidepanel.html",
    };
    sandbox.__runtimeMessageJson = JSON.stringify(message);
    const contextualMessage = vm.runInContext(
      "JSON.parse(__runtimeMessageJson)",
      context,
    );
    delete sandbox.__runtimeMessageJson;
    let responseCount = 0;
    const handled = runtimeListeners[0](
      contextualMessage,
      effectiveSender,
      () => { responseCount += 1; },
    );
    return { handled, responseCount };
  }

  return {
    send,
    dispatchUnhandled,
    state,
    imports,
    broadcasts,
    storageEvents,
    storageWrites,
    getResponseCallbacks: () => clone(responseCallbacks),
    releaseFirstEpochRead: () => firstEpochGate?.resolve(),
    getCoordinatorCreations: () => coordinatorCreations,
    getFetchCalls: () => fetchCalls,
    getFetchUrls: () => [...fetchUrls],
    getRandomValueCalls: () => randomValueCalls,
    getTimerCreations: () => timerCreations,
    getPendingStorageOperations: () => pendingStorageOperations,
    getMaxConcurrentStorageOperations: () => maxConcurrentStorageOperations,
    getReentryResponse: () => reentryResponse,
    getMaxConcurrentWrites: () => maxConcurrentWrites,
    getTabGetCount: () => tabGetCount,
    getEpochReadCount: () => epochReadCount,
    getOverviewCacheRecoverySize: () =>
      sandbox.__YTD_OVERVIEW_TESTING__.getOverviewCacheRecoverySize(),
    tabUpdatedListeners,
    tabActivatedListeners,
    tabRemovedListeners,
    windowRemovedListeners,
    storageChangedListeners,
  };
}

async function assertSingleResponseCallbacks(app, expectedActions) {
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    app.getResponseCallbacks(),
    expectedActions.map((action) => ({ action, count: 1 })),
  );
}

function assertExactStatus(actual, expected) {
  assert.deepEqual(Object.keys(actual).sort(), [
    "lastCheckedAt",
    "lastFailureCode",
    "state",
  ]);
  assert.deepEqual(actual, expected);
}

function digestSessionBinding({
  videoId = "abc123",
  tabId = 1,
  windowId = 7,
  resetEpoch = 0,
  generation = 1,
  sessionId = `digest-${videoId}-${tabId}-${resetEpoch}`,
} = {}) {
  return {
    tabId,
    sessionToken: {
      sessionId,
      generation,
      videoId,
      tabId,
      windowId,
      resetEpoch,
    },
  };
}

function defaultOverviewTranscript() {
  return [
    { text: "First source segment.", start: 0, duration: 2, language: "en" },
    { text: "Second source segment.", start: 12, duration: 2, language: "en" },
    { text: "Final source segment.", start: 30, duration: 2, language: "en" },
  ];
}

async function basicOverviewPayload(overrides = {}) {
  const transcriptLanguage = Object.hasOwn(overrides, "transcriptLanguage")
    ? overrides.transcriptLanguage
    : "en";
  const segments = Object.hasOwn(overrides, "segments")
    ? overrides.segments
    : transcriptCore.groupTranscriptEntries(defaultOverviewTranscript());
  const sourceLanguage = transcriptCore.resolveTranscriptLanguage(
    transcriptLanguage,
    [],
  );
  const transcriptFingerprint = Object.hasOwn(
    overrides,
    "transcriptFingerprint",
  )
    ? overrides.transcriptFingerprint
    : await transcriptCore.fingerprintSegments(segments, {
        sourceLanguage,
        crypto: webcrypto,
      });
  return {
    transcriptFingerprint,
    transcriptLanguage,
    segments,
    videoTitle: "Lesson",
    channelName: "Teacher",
    ...overrides,
  };
}

async function digestBaseValue(overrides = {}) {
  const transcript = overrides.transcript || defaultOverviewTranscript();
  const transcriptLanguage = Object.hasOwn(overrides, "transcriptLanguage")
    ? overrides.transcriptLanguage
    : "en";
  const sourceLanguage = transcriptCore.resolveTranscriptLanguage(
    transcriptLanguage,
    transcript,
  );
  const segments = transcriptCore.groupTranscriptEntries(transcript);
  const transcriptFingerprint = await transcriptCore.fingerprintSegments(
    segments,
    { sourceLanguage, crypto: webcrypto },
  );
  return {
    transcript,
    transcriptText: transcript.map((entry) => entry.text).join(" "),
    transcriptTimestamped: transcript
      .map((entry) => `[${Math.floor(entry.start / 60)}:${String(entry.start % 60).padStart(2, "0")}] ${entry.text}`)
      .join("\n"),
    transcriptLanguage,
    transcriptFingerprint,
    videoTitle: "Lesson",
    channelName: "Teacher",
    ...overrides,
  };
}

async function digestV2CacheValue(overrides = {}) {
  const {
    timestamp = Date.now(),
    digestSchemaVersion = 2,
    ...baseOverrides
  } = overrides;
  return {
    digestSchemaVersion,
    timestamp,
    ...(await digestBaseValue(baseOverrides)),
  };
}

function basicOverviewModelResponse() {
  return JSON.stringify({
    oneSentenceZh: "这是一句话结论。",
    conclusions: [0, 1, 2].map((index) => ({
      titleZh: `结论 ${index + 1}`,
      explanationZh: `解释 ${index + 1}`,
      evidenceLevel: "strong",
      evidenceSegmentIds: [`segment-${index}-${[0, 12000, 30000][index]}`],
    })),
    chapters: [
      {
        titleZh: "第一章",
        summaryZh: "章节概括",
        startSegmentId: "segment-0-0",
      },
    ],
  });
}

function overviewSettings(overrides = {}) {
  return {
    provider: "deepseek",
    aiApiKey: "test-key",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
    supadataApiKey: "",
    autoBasicOverview: true,
    ...overrides,
  };
}

async function overviewStorageState(overrides = {}) {
  return {
    ytd_reset_epoch: 0,
    ytd_settings: overviewSettings(),
    digest_abc123: await digestV2CacheValue(),
    ...overrides,
  };
}

async function overviewRequest(binding, overrides = {}) {
  return {
    action: "requestBasicOverview",
    videoId: binding.sessionToken.videoId,
    intent: "automatic",
    payload: await basicOverviewPayload(),
    ...binding,
    ...overrides,
  };
}

function overviewFetch({ modelContent = basicOverviewModelResponse() } = {}) {
  return async (url) => {
    if (String(url).startsWith("chrome-extension://test/prompts/")) {
      return {
        ok: true,
        status: 200,
        async text() {
          return read("prompts/overview.md");
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content: modelContent } }] };
      },
    };
  };
}

function overviewAttemptKeys(state) {
  return Object.keys(state).filter((key) =>
    key.startsWith("ytd_overview_attempt_"),
  );
}

function providerFetchCount(app) {
  return app.getFetchUrls().filter((url) =>
    url.includes("/chat/completions"),
  ).length;
}

function assertFreeOverviewFailure(result, code, overrides = {}) {
  assert.deepEqual(result, {
    success: false,
    code,
    provider: "deepseek",
    stage: "overview",
    retryable: false,
    primaryAction: "none",
    mayHaveConsumedCredit: false,
    ...overrides,
  });
}

async function bindDigestSession(app, binding = digestSessionBinding()) {
  const response = await app.send({
    action: "bindVideoSession",
    sessionToken: binding.sessionToken,
  });
  assert.equal(response.success, true);
  return binding;
}

function validVocabularyCard() {
  return {
    id: "vocab_run",
    lemma: "run",
    forms: ["running"],
    ipa: "/rʌn/",
    partOfSpeech: "verb",
    definitionEn: "to carry out",
    meaningZh: "执行",
    contextualMeaningEn: "carry out a test",
    contextualMeaningZh: "进行测试",
    collocations: ["run a test"],
    learningPlan: {
      contextAnchor: { explanationZh: "语境", collocationUseZh: "搭配" },
      morphology: {
        available: false,
        breakdown: "No reliable split.",
        explanationZh: "这里不强行拆分。",
      },
      soundBridge: { cueZh: "提示", safeguardZh: "不是词源。" },
      visualScene: {
        hookZh: "画面",
        sceneEn: "A lab.",
        sceneZh: "实验室。",
        recallPathZh: "路径",
      },
      contrast: {
        relatedWordEn: "conduct",
        distinctionZh: "区别",
        miniContrastEn: "Run it.",
      },
      retrieval: {
        clozePrompt: "___ a test.",
        meaningToWordPrompt: "哪个词？",
        productionPrompt: "造句",
        selfExplainPrompt: "解释",
      },
      generation: { exampleEn: "Run a test.", exampleZh: "进行测试。" },
      migrationNoteZh: "",
    },
    mnemonic: { hook: "", sceneEn: "", sceneZh: "", recallPath: "" },
    exampleEn: "Run a test.",
    clozePrompt: "___ a test.",
    productionPrompt: "Use run.",
    occurrences: [
      {
        form: "running",
        sentence: "We are running a test.",
        videoId: "abc123",
        videoTitle: "Lesson",
        channelName: "Teacher",
        timestampSeconds: 1,
        timestamp: "0:01",
        url: "https://www.youtube.com/watch?v=abc123&t=1s",
      },
    ],
    createdAt: 1,
    updatedAt: 2,
  };
}

test("background imports modules in dependency order and creates one coordinator", async () => {
  const app = loadBackground();

  assert.deepEqual(app.imports, [
    "settings.js",
    "providers.js",
    "persistence.js",
    "transcript-core.js",
    "overview-core.js",
  ]);
  assert.equal(app.getCoordinatorCreations(), 1);
  assert.deepEqual(await app.send({ action: "getResetEpoch" }), {
    success: true,
    resetEpoch: 0,
  });
  const binding = await bindDigestSession(app);
  const value = await digestBaseValue();
  await app.send({
    action: "persistDigestBase",
    expectedEpoch: 0,
    videoId: "abc123",
    value,
    ...binding,
  });
  assert.equal(app.getCoordinatorCreations(), 1);
});

test("background starts durable attempt pruning without delaying listener registration", async () => {
  const now = 1_800_000_000_000;
  class FrozenDate extends Date {
    static now() {
      return now;
    }
  }
  const pruneStarted = deferred();
  const pruneGate = deferred();
  let blockPrune = true;
  const fingerprint = `sha256-v1-${"a".repeat(64)}`;
  const attemptKey = `ytd_overview_attempt_v1_abc123_${fingerprint}`;
  const firstClaimedAt = now - 30 * 24 * 60 * 60 * 1_000;
  const app = loadBackground({
    Date: FrozenDate,
    initialState: {
      ytd_reset_epoch: 0,
      [attemptKey]: {
        schemaVersion: 1,
        videoId: "abc123",
        transcriptFingerprint: fingerprint,
        firstClaimedAt,
        expiresAt: now,
        currentAttempt: {
          id: "overview-background-prune",
          revision: 1,
          intent: "automatic",
          status: "claimed",
          resetEpoch: 0,
          claimedAt: firstClaimedAt,
          leaseUntil: firstClaimedAt + 180_000,
        },
      },
    },
    async storageGetHook(query) {
      if (blockPrune && query === null) {
        blockPrune = false;
        pruneStarted.resolve();
        await pruneGate.promise;
      }
    },
  });

  await pruneStarted.promise;
  const binding = await bindDigestSession(app);
  assert.equal(binding.sessionToken.videoId, "abc123");
  assert.equal(Object.hasOwn(app.state, attemptKey), true);
  pruneGate.resolve();
  await waitUntil(() => !Object.hasOwn(app.state, attemptKey));
});

test("background routes authoritative digest base and patch mutations with exact session echo", async () => {
  const app = loadBackground();
  const binding = await bindDigestSession(app);
  const base = await digestBaseValue({
    transcript: [
      {
        text: "First source segment.",
        start: 0,
        duration: 2,
        unknownNested: "must-not-persist",
      },
      { text: "Second source segment.", start: 12, duration: 2 },
    ],
    basicOverview: { forged: true },
    deepAnalysis: { forged: true },
    paragraphCache: {
      [`abc123:sha256-v1-${"a".repeat(64)}:forged`]: "forged",
    },
  });

  const persisted = await app.send({
    action: "persistDigestBase",
    expectedEpoch: 0,
    videoId: "abc123",
    value: base,
    ...binding,
  });
  assert.equal(persisted.success, true, JSON.stringify(persisted));
  assert.equal(persisted.timestamp, app.state.digest_abc123.timestamp);
  assert.deepEqual(persisted.sessionToken, binding.sessionToken);
  assert.equal(app.state.digest_abc123.digestSchemaVersion, 2);
  assert.equal(
    app.state.digest_abc123.transcriptFingerprint,
    base.transcriptFingerprint,
  );
  assert.equal(Object.hasOwn(app.state.digest_abc123, "basicOverview"), false);
  assert.equal(Object.hasOwn(app.state.digest_abc123, "deepAnalysis"), false);
  assert.equal(Object.hasOwn(app.state.digest_abc123, "paragraphCache"), false);
  assert.equal(
    Object.hasOwn(app.state.digest_abc123.transcript[0], "unknownNested"),
    false,
  );

  const paragraphKey = `abc123:${base.transcriptFingerprint}:paragraph-1`;
  const patched = await app.send({
    action: "patchDigestCache",
    expectedEpoch: 0,
    videoId: "abc123",
    transcriptFingerprint: base.transcriptFingerprint,
    patch: {
      deepAnalysis: { schemaVersion: 2, reportComplete: false },
      paragraphCache: { [paragraphKey]: "译文" },
    },
    ...binding,
  });
  assert.equal(patched.success, true, JSON.stringify(patched));
  assert.deepEqual(patched.sessionToken, binding.sessionToken);
  assert.deepEqual(app.state.digest_abc123.deepAnalysis, {
    schemaVersion: 2,
    reportComplete: false,
  });
  assert.deepEqual(app.state.digest_abc123.paragraphCache, {
    [paragraphKey]: "译文",
  });

  await assertSingleResponseCallbacks(app, [
    "bindVideoSession",
    "persistDigestBase",
    "patchDigestCache",
  ]);
});

test("background rejects malformed or empty self-consistent digest bases before storage", async (t) => {
  const fixtures = [
    [
      "non-string text",
      await digestBaseValue({
        transcript: [{ text: { forged: true }, start: 0, duration: 2 }],
      }),
    ],
    [
      "string start",
      await digestBaseValue({
        transcript: [{ text: "source", start: "0", duration: 2 }],
      }),
    ],
    [
      "negative duration",
      await digestBaseValue({
        transcript: [{ text: "source", start: 0, duration: -1 }],
      }),
    ],
    [
      "invalid language",
      await digestBaseValue({
        transcript: [{ text: "source", start: 0, duration: 2, language: 42 }],
      }),
    ],
    [
      "empty canonical segments",
      await digestBaseValue({
        transcript: [{ text: "   ", start: 0, duration: 2 }],
      }),
    ],
    [
      "oversized aggregate",
      await digestBaseValue({ transcriptText: "x".repeat(2 * 1024 * 1024 + 1) }),
    ],
  ];

  for (const [name, value] of fixtures) {
    await t.test(name, async () => {
      const app = loadBackground();
      const binding = await bindDigestSession(app);
      const result = await app.send({
        action: "persistDigestBase",
        expectedEpoch: 0,
        videoId: "abc123",
        value,
        ...binding,
      });

      assert.deepEqual(result, {
        success: false,
        code: "INVALID_DIGEST_VALUE",
        sessionToken: binding.sessionToken,
      });
      assert.equal(Object.hasOwn(app.state, "digest_abc123"), false);
      assert.equal(
        app.storageWrites.some((write) => Object.hasOwn(write, "digest_abc123")),
        false,
      );
    });
  }
});

test("background supplies canonical segment proof for one-shot missing-fingerprint legacy migration", async () => {
  const base = await digestBaseValue();
  const legacy = {
    ...base,
    timestamp: Date.now() - 1_000,
    analysis: { schemaVersion: 2, reportComplete: false, marker: "paid" },
    paragraphCache: {
      "abc123:zh:semantic:segment-0-0": "旧译文",
      "abc123:zh:semantic:not-in-source": "不可迁",
    },
  };
  delete legacy.transcriptFingerprint;
  const app = loadBackground({
    initialState: {
      ytd_reset_epoch: 0,
      digest_abc123: legacy,
    },
  });
  const binding = await bindDigestSession(app);

  const result = await app.send({
    action: "persistDigestBase",
    expectedEpoch: 0,
    videoId: "abc123",
    value: base,
    ...binding,
  });

  assert.equal(result.success, true, JSON.stringify(result));
  assert.deepEqual(app.state.digest_abc123.deepAnalysis, {
    schemaVersion: 2,
    reportComplete: false,
    marker: "paid",
  });
  assert.deepEqual(app.state.digest_abc123.paragraphCache, {
    [`abc123:${base.transcriptFingerprint}:zh:semantic:segment-0-0`]: "旧译文",
  });
});

test("background rejects a claimed transcript fingerprint mismatch before storage", async () => {
  const app = loadBackground();
  const binding = await bindDigestSession(app);
  const base = await digestBaseValue({
    transcriptFingerprint: `sha256-v1-${"f".repeat(64)}`,
  });

  const result = await app.send({
    action: "persistDigestBase",
    expectedEpoch: 0,
    videoId: "abc123",
    value: base,
    ...binding,
  });

  assert.deepEqual(result, {
    success: false,
    code: "TRANSCRIPT_FINGERPRINT_MISMATCH",
    sessionToken: binding.sessionToken,
  });
  assert.equal(Object.hasOwn(app.state, "digest_abc123"), false);
  assert.equal(
    app.storageWrites.some((write) => Object.hasOwn(write, "digest_abc123")),
    false,
  );
});

test("background revalidates the exact session after transcript hashing", async () => {
  const hashStarted = deferred();
  const hashGate = deferred();
  const app = loadBackground({
    crypto: {
      randomUUID: () => "00000000-0000-4000-8000-000000000001",
      subtle: {
        async digest(...args) {
          hashStarted.resolve();
          await hashGate.promise;
          return webcrypto.subtle.digest(...args);
        },
      },
    },
  });
  const first = digestSessionBinding({ sessionId: "hash-session-1" });
  await bindDigestSession(app, first);
  const base = await digestBaseValue();
  const pending = app.send({
    action: "persistDigestBase",
    expectedEpoch: 0,
    videoId: "abc123",
    value: base,
    ...first,
  });
  await hashStarted.promise;
  await bindDigestSession(
    app,
    digestSessionBinding({
      generation: 2,
      sessionId: "hash-session-2",
    }),
  );
  hashGate.resolve();

  const result = await pending;
  assert.deepEqual(result, {
    success: false,
    code: "SESSION_STALE",
    sessionToken: first.sessionToken,
  });
  assert.equal(Object.hasOwn(app.state, "digest_abc123"), false);
});

test("requestBasicOverview claims once, dispatches once, and settles only basicOverview", async () => {
  const events = [];
  const initialDigest = await digestV2CacheValue({
    deepAnalysis: { reportComplete: false, marker: "preserve" },
    paragraphCache: { trusted: "translation" },
  });
  const app = loadBackground({
    initialState: await overviewStorageState({ digest_abc123: initialDigest }),
    crypto: {
      subtle: {
        async digest(...args) {
          events.push("hash");
          return webcrypto.subtle.digest(...args);
        },
      },
      getRandomValues(target) {
        events.push("random");
        target.fill(events.length + 1);
        return target;
      },
    },
    storageGetHook(query) {
      if (query === "ytd_settings") events.push("settings");
    },
    storageSetHook(items) {
      const attempt = Object.values(items).find((value) =>
        value?.currentAttempt?.status === "claimed",
      );
      if (attempt) events.push("claim");
      if (items.digest_abc123?.basicOverview) events.push("settle");
    },
    async fetch(url, init) {
      if (String(url).startsWith("chrome-extension://test/prompts/")) {
        events.push("prompt");
        return {
          ok: true,
          status: 200,
          async text() { return read("prompts/overview.md"); },
        };
      }
      events.push("provider");
      const body = JSON.parse(init.body);
      assert.equal(body.max_tokens, 3072);
      assert.deepEqual(body.response_format, { type: "json_object" });
      return {
        ok: true,
        status: 200,
        async json() {
          return { choices: [{ message: { content: basicOverviewModelResponse() } }] };
        },
      };
    },
  });
  const binding = await bindDigestSession(app);
  const message = await overviewRequest(binding);
  assert.equal(Object.hasOwn(message, "attemptId"), false);
  assert.equal(Object.hasOwn(message, "attemptRevision"), false);

  const result = await app.send(message);

  assert.equal(result.success, true);
  assert.equal(result.overview.transcriptFingerprint, message.payload.transcriptFingerprint);
  assert.deepEqual(result.sessionToken, binding.sessionToken);
  assert.equal(providerFetchCount(app), 1);
  assert.equal(Object.hasOwn(result, "attemptId"), false);
  assert.equal(Object.hasOwn(result, "attemptRevision"), false);
  assert.deepEqual(app.state.digest_abc123, {
    ...initialDigest,
    basicOverview: result.overview,
  });
  const [attemptKey] = overviewAttemptKeys(app.state);
  assert.equal(app.state[attemptKey].currentAttempt.status, "succeeded");
  assert.deepEqual(events, [
    "hash",
    "settings",
    "prompt",
    "random",
    "random",
    "settings",
    "settings",
    "claim",
    "provider",
    "settle",
  ]);
});

test("requestBasicOverview does not dispatch when the claim final set crosses an external epoch reset", async () => {
  let resetDuringClaim = true;
  const app = loadBackground({
    initialState: await overviewStorageState(),
    fetch: overviewFetch(),
    storageSetHook(items, { state }) {
      const attemptKey = Object.keys(items).find((key) =>
        key.startsWith("ytd_overview_attempt_"),
      );
      if (
        !resetDuringClaim ||
        !attemptKey ||
        items[attemptKey]?.currentAttempt?.status !== "claimed"
      ) return;
      resetDuringClaim = false;
      state.ytd_reset_epoch = 1;
      delete state.digest_abc123;
      delete state[attemptKey];
    },
  });
  const binding = await bindDigestSession(app);

  const result = await app.send(await overviewRequest(binding));

  assert.equal(result.success, false);
  assert.equal(result.code, "RESET_DURING_REQUEST");
  assert.equal(result.provider, "deepseek");
  assert.equal(result.stage, "overview");
  assert.equal(result.mayHaveConsumedCredit, false);
  assert.deepEqual(result.sessionToken, binding.sessionToken);
  assert.equal(providerFetchCount(app), 0);
  assert.equal(app.state.ytd_reset_epoch, 1);
  assert.equal(Object.hasOwn(app.state, "digest_abc123"), false);
  assert.equal(overviewAttemptKeys(app.state).length, 0);
});

test("requestBasicOverview retries a transient post-claim epoch read without dispatching", async () => {
  let resetDuringClaim = true;
  let failPostClaimVerification = false;
  let verificationReadFailures = 0;
  const app = loadBackground({
    initialState: await overviewStorageState(),
    fetch: overviewFetch(),
    storageSetHook(items, { state }) {
      const attemptKey = Object.keys(items).find((key) =>
        key.startsWith("ytd_overview_attempt_"),
      );
      if (
        !resetDuringClaim ||
        !attemptKey ||
        items[attemptKey]?.currentAttempt?.status !== "claimed"
      ) return;
      resetDuringClaim = false;
      failPostClaimVerification = true;
      state.ytd_reset_epoch = 1;
      delete state.digest_abc123;
      delete state[attemptKey];
    },
    storageGetFailure(query) {
      if (
        !failPostClaimVerification ||
        !Array.isArray(query) ||
        !query.includes("ytd_reset_epoch") ||
        !query.some((key) => key.startsWith("ytd_overview_attempt_"))
      ) return null;
      failPostClaimVerification = false;
      verificationReadFailures += 1;
      return new Error("secret transient post-claim read");
    },
  });
  const binding = await bindDigestSession(app);

  const result = await app.send(await overviewRequest(binding));

  assert.equal(result.success, false);
  assert.equal(result.code, "RESET_DURING_REQUEST");
  assert.equal(result.mayHaveConsumedCredit, false);
  assert.deepEqual(result.sessionToken, binding.sessionToken);
  assert.equal(verificationReadFailures, 1);
  assert.equal(providerFetchCount(app), 0);
  assert.equal(app.state.ytd_reset_epoch, 1);
  assert.equal(Object.hasOwn(app.state, "digest_abc123"), false);
  assert.equal(overviewAttemptKeys(app.state).length, 0);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("requestBasicOverview does not dispatch when a claimed ledger write resolves as a no-op", async () => {
  let claimSetAttempts = 0;
  const app = loadBackground({
    initialState: await overviewStorageState(),
    fetch: overviewFetch(),
    storageSetHook(items) {
      const attempt = Object.values(items).find((value) =>
        value?.currentAttempt?.status === "claimed",
      );
      if (!attempt) return false;
      claimSetAttempts += 1;
      return true;
    },
  });
  const binding = await bindDigestSession(app);

  const result = await app.send(await overviewRequest(binding));

  assert.deepEqual(result, {
    success: false,
    code: "STORAGE_WRITE_VERIFICATION_FAILED",
    provider: "deepseek",
    stage: "overview",
    retryable: true,
    primaryAction: "retry",
    mayHaveConsumedCredit: false,
    sessionToken: binding.sessionToken,
  });
  assert.equal(claimSetAttempts, 1);
  assert.equal(providerFetchCount(app), 0);
  assert.equal(overviewAttemptKeys(app.state).length, 0);
});

test("requestBasicOverview cleans an ambiguous rejected claim write before dispatch", async () => {
  let rejectClaimWrite = true;
  const app = loadBackground({
    initialState: await overviewStorageState(),
    fetch: overviewFetch(),
    storageSetHook(items, { state }) {
      const attemptKey = Object.keys(items).find((key) =>
        key.startsWith("ytd_overview_attempt_"),
      );
      if (!rejectClaimWrite || !attemptKey) return false;
      rejectClaimWrite = false;
      state.ytd_reset_epoch = 1;
      delete state.digest_abc123;
      delete state[attemptKey];
      Object.assign(state, clone(items));
      throw new Error("secret rejected claim commit");
    },
  });
  const binding = await bindDigestSession(app);

  const result = await app.send(await overviewRequest(binding));

  assert.equal(result.success, false);
  assert.equal(result.code, "RESET_DURING_REQUEST");
  assert.equal(result.mayHaveConsumedCredit, false);
  assert.deepEqual(result.sessionToken, binding.sessionToken);
  assert.equal(providerFetchCount(app), 0);
  assert.equal(app.state.ytd_reset_epoch, 1);
  assert.equal(Object.hasOwn(app.state, "digest_abc123"), false);
  assert.equal(overviewAttemptKeys(app.state).length, 0);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("a shallow malformed cached overview cannot suppress the one durable provider attempt", async () => {
  const initialDigest = await digestV2CacheValue();
  initialDigest.basicOverview = {
    schemaVersion: 1,
    transcriptFingerprint: initialDigest.transcriptFingerprint,
    oneSentenceZh: "malformed cache poison",
  };
  const app = loadBackground({
    initialState: await overviewStorageState({ digest_abc123: initialDigest }),
    fetch: overviewFetch(),
  });
  const binding = await bindDigestSession(app);

  const result = await app.send(await overviewRequest(binding));

  assert.equal(result.success, true);
  assert.equal(providerFetchCount(app), 1);
  assert.equal(
    app.state.digest_abc123.basicOverview.oneSentenceZh,
    "这是一句话结论。",
  );
});

test("overview preflight failures create no ID, ledger, provider request, or timer", async (t) => {
  const valid = await basicOverviewPayload();
  const prefix = "[segment-0-0] [0:00] ";
  const cases = [
    {
      name: "invalid segments",
      payload: { ...valid, segments: [{ id: "bad", start: 0, text: "bad" }] },
      expected: {
        code: "MALFORMED_RESPONSE",
        retryable: true,
        primaryAction: "retry",
      },
    },
    {
      name: "empty transcript",
      payload: { ...valid, segments: [] },
      expected: {
        code: "EMPTY_RESPONSE",
        retryable: true,
        primaryAction: "retry",
      },
    },
    {
      name: "oversized transcript",
      payload: {
        ...valid,
        segments: [{
          id: "segment-0-0",
          start: 0,
          text: "x".repeat(320_001 - prefix.length),
        }],
      },
      expected: {
        code: "INPUT_TOO_LARGE",
        retryable: false,
        primaryAction: "reduce_request",
      },
    },
    {
      name: "tampered segment",
      payload: {
        ...valid,
        segments: valid.segments.map((segment, index) =>
          index === 0 ? { ...segment, text: `${segment.text} tampered` } : segment),
      },
      expected: {
        code: "TRANSCRIPT_FINGERPRINT_MISMATCH",
        retryable: false,
        primaryAction: "none",
      },
    },
    {
      name: "tampered source language",
      payload: { ...valid, transcriptLanguage: "fr" },
      expected: {
        code: "TRANSCRIPT_FINGERPRINT_MISMATCH",
        retryable: false,
        primaryAction: "none",
      },
    },
    {
      name: "secure hash unavailable",
      payload: valid,
      crypto: { getRandomValues: (target) => target.fill(1) },
      expected: {
        code: "TRANSCRIPT_FINGERPRINT_UNAVAILABLE",
        retryable: false,
        primaryAction: "none",
      },
    },
    {
      name: "automatic consent disabled",
      payload: valid,
      settings: { autoBasicOverview: false },
      expected: {
        code: "AUTO_OVERVIEW_DISABLED",
        retryable: false,
        primaryAction: "none",
      },
    },
    {
      name: "AI key missing",
      payload: valid,
      settings: { aiApiKey: "" },
      expected: {
        code: "MISSING_KEY",
        retryable: false,
        primaryAction: "open_settings",
      },
    },
    {
      name: "offline",
      payload: valid,
      navigator: { onLine: false },
      expected: {
        code: "NETWORK_ERROR",
        retryable: true,
        primaryAction: "retry",
      },
    },
    {
      name: "prompt unavailable",
      payload: valid,
      promptUnavailable: true,
      expected: {
        code: "OVERVIEW_PROMPT_UNAVAILABLE",
        retryable: false,
        primaryAction: "none",
      },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const initialState = await overviewStorageState({
        ytd_settings: overviewSettings(entry.settings),
      });
      const app = loadBackground({
        initialState,
        crypto: entry.crypto,
        navigator: entry.navigator,
        fetch: entry.promptUnavailable
          ? async () => ({ ok: false, status: 404, async text() { return "secret"; } })
          : overviewFetch(),
      });
      const binding = await bindDigestSession(app);
      const result = await app.send(await overviewRequest(binding, {
        payload: entry.payload,
      }));

      assert.deepEqual(result, {
        success: false,
        ...entry.expected,
        provider: "deepseek",
        stage: "overview",
        mayHaveConsumedCredit: false,
        sessionToken: binding.sessionToken,
      });
      assert.equal(app.getRandomValueCalls(), 0);
      assert.equal(overviewAttemptKeys(app.state).length, 0);
      assert.equal(providerFetchCount(app), 0);
      assert.equal(app.getTimerCreations(), 0);
      assert.deepEqual(app.storageWrites, []);
    });
  }
});

test("claim validator rechecks key, consent, online state, and exact model snapshot", async (t) => {
  const cases = [
    {
      name: "key removed",
      code: "MISSING_KEY",
      retryable: false,
      primaryAction: "open_settings",
      mutate: (state) => { state.ytd_settings.aiApiKey = ""; },
    },
    {
      name: "consent revoked",
      code: "AUTO_OVERVIEW_DISABLED",
      retryable: false,
      primaryAction: "none",
      mutate: (state) => { state.ytd_settings.autoBasicOverview = false; },
    },
    {
      name: "offline after prompt",
      code: "NETWORK_ERROR",
      retryable: true,
      primaryAction: "retry",
      mutate: (_state, navigator) => { navigator.onLine = false; },
    },
    {
      name: "settings read failed",
      code: "STORAGE_READ_FAILED",
      retryable: true,
      primaryAction: "retry",
      failSettingsRead: true,
    },
    {
      name: "model changed",
      code: "SESSION_STALE",
      retryable: false,
      primaryAction: "none",
      preserveAiModel: true,
      mutate: (state) => { state.ytd_settings.aiModel = "deepseek-other"; },
    },
    {
      name: "nonempty key changed",
      code: "SESSION_STALE",
      retryable: false,
      primaryAction: "none",
      mutate: (state) => { state.ytd_settings.aiApiKey = "replacement-key"; },
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const navigator = { onLine: true };
      let settingsReads = 0;
      const app = loadBackground({
        initialState: await overviewStorageState(),
        navigator,
        preserveAiModel: entry.preserveAiModel,
        fetch: overviewFetch(),
        storageGetFailure(query) {
          if (query !== "ytd_settings") return null;
          settingsReads += 1;
          return entry.failSettingsRead && settingsReads === 2
            ? new Error("secret settings read failure")
            : null;
        },
        storageGetHook(query, { state }) {
          if (query !== "ytd_settings") return;
          if (settingsReads === 2) entry.mutate?.(state, navigator);
        },
      });
      const binding = await bindDigestSession(app);
      const result = await app.send(await overviewRequest(binding));

      assert.deepEqual(result, {
        success: false,
        code: entry.code,
        provider: "deepseek",
        stage: "overview",
        retryable: entry.retryable,
        primaryAction: entry.primaryAction,
        mayHaveConsumedCredit: false,
        sessionToken: binding.sessionToken,
      });
      assert.equal(overviewAttemptKeys(app.state).length, 0);
      assert.equal(providerFetchCount(app), 0);
    });
  }
});

test("direct claim failures keep retryability and primary action coherent", async (t) => {
  for (const entry of [
    {
      code: "OVERVIEW_CLOCK_INVALID",
      retryable: false,
      primaryAction: "none",
    },
    {
      code: "STORAGE_READ_FAILED",
      retryable: true,
      primaryAction: "retry",
    },
  ]) {
    await t.test(entry.code, async () => {
      const app = loadBackground({
        initialState: await overviewStorageState(),
        fetch: overviewFetch(),
        wrapCoordinator(coordinator) {
          return {
            ...coordinator,
            async claimBasicOverview() {
              return {
                success: false,
                code: entry.code,
                retryable: entry.retryable,
              };
            },
          };
        },
      });
      const binding = await bindDigestSession(app);

      assert.deepEqual(await app.send(await overviewRequest(binding)), {
        success: false,
        code: entry.code,
        provider: "deepseek",
        stage: "overview",
        retryable: entry.retryable,
        primaryAction: entry.primaryAction,
        mayHaveConsumedCredit: false,
        sessionToken: binding.sessionToken,
      });
      assert.equal(providerFetchCount(app), 0);
    });
  }
});

test("concurrent panels and manual retry share one durable overview purchase", async () => {
  const providerStarted = deferred();
  const providerGate = deferred();
  const app = loadBackground({
    initialState: await overviewStorageState(),
    tabsGet(tabId) {
      return {
        id: tabId,
        windowId: tabId === 2 ? 8 : 7,
        active: true,
        url: "https://www.youtube.com/watch?v=abc123",
      };
    },
    async fetch(url) {
      if (String(url).startsWith("chrome-extension://test/prompts/")) {
        return { ok: true, status: 200, async text() { return read("prompts/overview.md"); } };
      }
      providerStarted.resolve();
      await providerGate.promise;
      return {
        ok: true,
        status: 200,
        async json() {
          return { choices: [{ message: { content: basicOverviewModelResponse() } }] };
        },
      };
    },
  });
  const first = digestSessionBinding({ tabId: 1, windowId: 7, sessionId: "panel-one" });
  const second = digestSessionBinding({ tabId: 2, windowId: 8, sessionId: "panel-two" });
  await bindDigestSession(app, first);
  await bindDigestSession(app, second);
  const firstPending = app.send(await overviewRequest(first));
  assert.equal((await settleWithin(providerStarted.promise)).kind, "resolved");
  const loser = await app.send(await overviewRequest(second));
  assert.equal(loser.success, true);
  assert.equal(loser.skipped, "already_attempted");
  assert.equal(loser.disposition, "inflight");
  assert.equal(Object.hasOwn(loser, "attemptId"), false);
  assert.equal(providerFetchCount(app), 1);

  providerGate.resolve();
  const winner = await firstPending;
  assert.equal(winner.success, true);
  const cachedManual = await app.send(await overviewRequest(second, {
    intent: "manual_retry",
  }));
  assert.equal(cachedManual.success, true);
  assert.equal(cachedManual.disposition, "cached");
  assert.equal(providerFetchCount(app), 1);
});

test("worker reload keeps automatic overview purchases exactly once until an eligible manual retry", async (t) => {
  await t.test("billed provider failure stays failed across reload", async () => {
    const sharedState = await overviewStorageState();
    const first = loadBackground({
      sharedState,
      fetch: overviewFetch({ modelContent: "not overview JSON" }),
    });
    const firstBinding = await bindDigestSession(first);
    const failure = await first.send(await overviewRequest(firstBinding));
    assert.equal(failure.success, false);
    assert.equal(failure.mayHaveConsumedCredit, true);
    assert.equal(providerFetchCount(first), 1);

    const restarted = loadBackground({ sharedState, fetch: overviewFetch() });
    const nextBinding = digestSessionBinding({
      sessionId: "reloaded-after-provider-failure",
      generation: 2,
    });
    await bindDigestSession(restarted, nextBinding);
    const automatic = await restarted.send(await overviewRequest(nextBinding));
    assert.equal(automatic.success, true);
    assert.equal(automatic.skipped, "already_attempted");
    assert.equal(automatic.disposition, "failed");
    assert.equal(
      providerFetchCount(first) + providerFetchCount(restarted),
      1,
    );

    const manual = await restarted.send(await overviewRequest(nextBinding, {
      intent: "manual_retry",
    }));
    assert.equal(manual.success, true);
    assert.equal(
      providerFetchCount(first) + providerFetchCount(restarted),
      2,
    );
  });

  await t.test("cache-write failure stays leased across reload", async () => {
    let now = 2_000_000_000_000;
    const RuntimeDate = class extends Date {
      static now() { return now; }
    };
    const sharedState = await overviewStorageState({
      digest_abc123: await digestV2CacheValue({ timestamp: now }),
    });
    const first = loadBackground({
      sharedState,
      Date: RuntimeDate,
      fetch: overviewFetch(),
      storageSetHook(items) {
        if (items.digest_abc123?.basicOverview) {
          throw new Error("disk unavailable");
        }
      },
    });
    const firstBinding = await bindDigestSession(first);
    const cacheFailure = await first.send(await overviewRequest(firstBinding));
    assert.equal(cacheFailure.code, "OVERVIEW_CACHE_WRITE_FAILED");
    assert.equal(cacheFailure.providerSucceeded, true);
    assert.equal(providerFetchCount(first), 1);

    const restarted = loadBackground({
      sharedState,
      Date: RuntimeDate,
      fetch: overviewFetch(),
    });
    const nextBinding = digestSessionBinding({
      sessionId: "reloaded-after-cache-failure",
      generation: 2,
    });
    await bindDigestSession(restarted, nextBinding);
    const automatic = await restarted.send(await overviewRequest(nextBinding));
    assert.equal(automatic.success, true);
    assert.equal(automatic.skipped, "already_attempted");
    assert.equal(automatic.disposition, "inflight");
    assert.equal(
      providerFetchCount(first) + providerFetchCount(restarted),
      1,
    );

    now += 180_001;
    const manual = await restarted.send(await overviewRequest(nextBinding, {
      intent: "manual_retry",
    }));
    assert.equal(manual.success, true);
    assert.equal(
      providerFetchCount(first) + providerFetchCount(restarted),
      2,
    );
  });
});

test("manual retry bypasses consent but never an active durable lease", async () => {
  const providerStarted = deferred();
  const providerGate = deferred();
  const app = loadBackground({
    initialState: await overviewStorageState({
      ytd_settings: overviewSettings({ autoBasicOverview: false }),
    }),
    async fetch(url) {
      if (String(url).startsWith("chrome-extension://test/prompts/")) {
        return { ok: true, status: 200, async text() { return read("prompts/overview.md"); } };
      }
      providerStarted.resolve();
      await providerGate.promise;
      return {
        ok: true,
        status: 200,
        async json() {
          return { choices: [{ message: { content: basicOverviewModelResponse() } }] };
        },
      };
    },
  });
  const binding = await bindDigestSession(app);
  const first = app.send(await overviewRequest(binding, { intent: "manual_retry" }));
  assert.equal((await settleWithin(providerStarted.promise)).kind, "resolved");
  const second = await app.send(await overviewRequest(binding, { intent: "manual_retry" }));
  assert.equal(second.success, true);
  assert.equal(second.disposition, "inflight");
  assert.equal(providerFetchCount(app), 1);
  providerGate.resolve();
  assert.equal((await first).success, true);
});

test("a synchronous stale session after claim leaves an interrupted lease without dispatch", async () => {
  let app;
  let rebound = false;
  const a = digestSessionBinding({ sessionId: "claim-a" });
  const b = digestSessionBinding({ sessionId: "claim-b", generation: 2 });
  app = loadBackground({
    initialState: await overviewStorageState(),
    fetch: overviewFetch(),
    async storageSetHook(items) {
      const claimed = Object.values(items).some((value) =>
        value?.currentAttempt?.status === "claimed",
      );
      if (claimed && !rebound) {
        rebound = true;
        await bindDigestSession(app, b);
      }
    },
  });
  await bindDigestSession(app, a);
  const result = await app.send(await overviewRequest(a));

  assert.equal(result.success, false);
  assert.equal(result.code, "SESSION_STALE");
  assert.equal(result.mayHaveConsumedCredit, false);
  assert.equal(providerFetchCount(app), 0);
  const [attemptKey] = overviewAttemptKeys(app.state);
  assert.equal(app.state[attemptKey].currentAttempt.status, "claimed");
});

test("provider dispatch survives A to B while canonical failure and reset settlement stay bounded", async (t) => {
  await t.test("A to B still settles A", async () => {
    const providerStarted = deferred();
    const providerGate = deferred();
    const app = loadBackground({
      initialState: await overviewStorageState(),
      async fetch(url) {
        if (String(url).startsWith("chrome-extension://test/prompts/")) {
          return { ok: true, status: 200, async text() { return read("prompts/overview.md"); } };
        }
        providerStarted.resolve();
        await providerGate.promise;
        return {
          ok: true,
          status: 200,
          async json() {
            return { choices: [{ message: { content: basicOverviewModelResponse() } }] };
          },
        };
      },
    });
    const a = digestSessionBinding({ sessionId: "provider-a" });
    const b = digestSessionBinding({ sessionId: "provider-b", generation: 2 });
    await bindDigestSession(app, a);
    const pending = app.send(await overviewRequest(a));
    assert.equal((await settleWithin(providerStarted.promise)).kind, "resolved");
    await bindDigestSession(app, b);
    providerGate.resolve();
    const result = await pending;
    assert.equal(result.success, true);
    assert.deepEqual(result.sessionToken, a.sessionToken);
    assert.equal(app.state.digest_abc123.basicOverview.oneSentenceZh, "这是一句话结论。");
  });

  await t.test("provider failure settles exact six fields", async () => {
    const app = loadBackground({
      initialState: await overviewStorageState(),
      async fetch(url) {
        if (String(url).startsWith("chrome-extension://test/prompts/")) {
          return { ok: true, status: 200, async text() { return read("prompts/overview.md"); } };
        }
        throw new TypeError("secret network detail");
      },
    });
    const binding = await bindDigestSession(app);
    const result = await app.send(await overviewRequest(binding));
    assert.deepEqual(result, {
      success: false,
      code: "NETWORK_ERROR",
      provider: "deepseek",
      stage: "overview",
      retryable: true,
      mayHaveConsumedCredit: true,
      primaryAction: "retry",
      sessionToken: binding.sessionToken,
    });
    const [attemptKey] = overviewAttemptKeys(app.state);
    assert.deepEqual(app.state[attemptKey].currentAttempt.failure, {
      code: "NETWORK_ERROR",
      provider: "deepseek",
      stage: "overview",
      retryable: true,
      primaryAction: "retry",
      mayHaveConsumedCredit: true,
    });
  });

  await t.test("reset after dispatch prevents late resurrection", async () => {
    const providerStarted = deferred();
    const providerGate = deferred();
    const app = loadBackground({
      initialState: await overviewStorageState(),
      async fetch(url) {
        if (String(url).startsWith("chrome-extension://test/prompts/")) {
          return { ok: true, status: 200, async text() { return read("prompts/overview.md"); } };
        }
        providerStarted.resolve();
        await providerGate.promise;
        return {
          ok: true,
          status: 200,
          async json() {
            return { choices: [{ message: { content: basicOverviewModelResponse() } }] };
          },
        };
      },
    });
    const binding = await bindDigestSession(app);
    const pending = app.send(await overviewRequest(binding));
    assert.equal((await settleWithin(providerStarted.promise)).kind, "resolved");
    assert.equal((await app.send({ action: "resetExtensionData" })).success, true);
    providerGate.resolve();
    await pending;
    assert.equal(Object.hasOwn(app.state, "digest_abc123"), false);
    assert.equal(overviewAttemptKeys(app.state).length, 0);
    assert.equal(providerFetchCount(app), 1);
  });
});

test("opaque cache recovery retries only the trusted settlement and coalesces double-clicks", async () => {
  let mode = "fail";
  const retryWriteStarted = deferred();
  const retryWriteGate = deferred();
  const app = loadBackground({
    initialState: await overviewStorageState(),
    fetch: overviewFetch(),
    async storageSetHook(items) {
      if (!items.digest_abc123?.basicOverview) return;
      if (mode === "fail") throw new Error("QUOTA_BYTES quota exceeded secret");
      if (mode === "gate") {
        retryWriteStarted.resolve();
        await retryWriteGate.promise;
        mode = "success";
      }
    },
  });
  const binding = await bindDigestSession(app);
  const first = await app.send(await overviewRequest(binding));
  assert.equal(first.success, false);
  assert.equal(first.code, "OVERVIEW_CACHE_WRITE_FAILED");
  assert.equal(first.providerSucceeded, true);
  assert.equal(typeof first.recoveryToken, "string");
  assert.ok(first.recoveryToken.length >= 32);
  assert.equal(Object.hasOwn(first, "attemptId"), false);
  assert.equal(Object.hasOwn(first, "attemptRevision"), false);
  const trustedSentence = first.overview.oneSentenceZh;
  first.overview.oneSentenceZh = "panel forged overview";
  mode = "gate";
  const retryMessage = {
    action: "retryBasicOverviewCacheWrite",
    videoId: "abc123",
    recoveryToken: first.recoveryToken,
    overview: first.overview,
    attemptId: "panel-forged-id",
    attemptRevision: 999,
    ...binding,
  };
  const one = app.send(retryMessage);
  assert.equal((await settleWithin(retryWriteStarted.promise)).kind, "resolved");
  const two = app.send(retryMessage);
  await new Promise((resolve) => setImmediate(resolve));
  retryWriteGate.resolve();
  const [oneResult, twoResult] = await Promise.all([one, two]);
  assert.equal(oneResult.success, true);
  assert.equal(twoResult.success, true);
  assert.equal(app.state.digest_abc123.basicOverview.oneSentenceZh, trustedSentence);
  assert.equal(providerFetchCount(app), 1);
  const unavailable = await app.send(retryMessage);
  assert.deepEqual(unavailable, {
    success: false,
    code: "OVERVIEW_CACHE_RECOVERY_UNAVAILABLE",
    provider: "deepseek",
    stage: "overview_cache",
    retryable: false,
    primaryAction: "none",
    mayHaveConsumedCredit: false,
    sessionToken: binding.sessionToken,
  });
});

test("opaque cache recovery repairs a succeeded ledger without buying overview twice", async (t) => {
  for (const mode of ["resolved", "rejected", "quota"]) {
    await t.test(mode, async () => {
      let forceLedgerOnly = true;
      let partialWriteCount = 0;
      const app = loadBackground({
        initialState: await overviewStorageState({
          ...(mode === "quota"
            ? { digest_oldest: { timestamp: 1, text: "eviction candidate" } }
            : {}),
        }),
        fetch: overviewFetch(),
        storageSetHook(items, { state }) {
          const [attemptKey] = overviewAttemptKeys(items);
          if (
            !forceLedgerOnly ||
            !attemptKey ||
            !items.digest_abc123?.basicOverview ||
            items[attemptKey]?.currentAttempt?.status !== "succeeded"
          ) return false;

          partialWriteCount += 1;
          state[attemptKey] = clone(items[attemptKey]);
          if (mode === "rejected") {
            throw new Error("secret reject after ledger-only write");
          }
          if (mode === "quota" && partialWriteCount === 1) {
            const error = new Error("secret quota after ledger-only write");
            error.name = "QuotaExceededError";
            throw error;
          }
          return true;
        },
      });
      const binding = await bindDigestSession(app);

      const first = await app.send(await overviewRequest(binding));

      assert.equal(first.success, false);
      assert.equal(first.code, "OVERVIEW_CACHE_WRITE_FAILED");
      assert.equal(first.providerSucceeded, true);
      assert.match(first.recoveryToken, /^[a-f0-9]{32}$/);
      assert.equal(Object.hasOwn(first, "attemptId"), false);
      assert.equal(Object.hasOwn(first, "attemptRevision"), false);
      assert.equal(providerFetchCount(app), 1);
      const [attemptKey] = overviewAttemptKeys(app.state);
      assert.equal(
        app.state[attemptKey].currentAttempt.status,
        "succeeded",
      );
      assert.equal(
        Object.hasOwn(app.state.digest_abc123, "basicOverview"),
        false,
      );
      assert.equal(
        partialWriteCount,
        mode === "resolved" ? 2 : mode === "quota" ? 3 : 1,
      );

      const trustedOverview = clone(first.overview);
      forceLedgerOnly = false;
      const retryMessage = {
        action: "retryBasicOverviewCacheWrite",
        videoId: "abc123",
        recoveryToken: first.recoveryToken,
        ...binding,
      };
      const [one, two] = await Promise.all([
        app.send(retryMessage),
        app.send(retryMessage),
      ]);

      assert.equal(one.success, true);
      assert.equal(two.success, true);
      assert.deepEqual(app.state.digest_abc123.basicOverview, trustedOverview);
      assert.equal(providerFetchCount(app), 1);
      assert.deepEqual(await app.send(retryMessage), {
        success: false,
        code: "OVERVIEW_CACHE_RECOVERY_UNAVAILABLE",
        provider: "deepseek",
        stage: "overview_cache",
        retryable: false,
        primaryAction: "none",
        mayHaveConsumedCredit: false,
        sessionToken: binding.sessionToken,
      });
      assert.equal(providerFetchCount(app), 1);

      const restarted = loadBackground({
        sharedState: app.state,
        fetch: overviewFetch(),
      });
      await bindDigestSession(restarted, binding);
      const cachedAfterRestart = await restarted.send(
        await overviewRequest(binding),
      );
      assert.equal(cachedAfterRestart.success, true);
      assert.equal(cachedAfterRestart.disposition, "cached");
      assert.deepEqual(cachedAfterRestart.overview, trustedOverview);
      assert.equal(providerFetchCount(restarted), 0);
    });
  }
});

test("clear and reset fence a late retryable cache-only settlement response", async (t) => {
  for (const fence of ["clear", "reset"]) {
    await t.test(fence, async () => {
      const retryStarted = deferred();
      const retryGate = deferred();
      let settlementCount = 0;
      const app = loadBackground({
        initialState: await overviewStorageState(),
        fetch: overviewFetch(),
        wrapCoordinator(coordinator) {
          return {
            ...coordinator,
            async settleBasicOverview(...args) {
              settlementCount += 1;
              if (settlementCount === 1) {
                return {
                  success: false,
                  code: "STORAGE_WRITE_FAILED",
                  retryable: true,
                };
              }
              if (settlementCount === 2) {
                retryStarted.resolve();
                await retryGate.promise;
                return {
                  success: false,
                  code: "STORAGE_WRITE_FAILED",
                  retryable: true,
                };
              }
              return coordinator.settleBasicOverview(...args);
            },
          };
        },
      });
      const binding = await bindDigestSession(app);
      const failure = await app.send(await overviewRequest(binding));
      assert.equal(failure.code, "OVERVIEW_CACHE_WRITE_FAILED");
      assert.equal(app.getOverviewCacheRecoverySize(), 1);

      const pendingRetry = app.send({
        action: "retryBasicOverviewCacheWrite",
        videoId: "abc123",
        recoveryToken: failure.recoveryToken,
        ...binding,
      });
      await retryStarted.promise;
      const fenced = await app.send({
        action: fence === "clear" ? "clearDigestCache" : "resetExtensionData",
      });
      assert.equal(fenced.success, true);
      assert.equal(app.getOverviewCacheRecoverySize(), 0);
      retryGate.resolve();

      assert.deepEqual(await pendingRetry, {
        success: false,
        code: "OVERVIEW_CACHE_RECOVERY_UNAVAILABLE",
        provider: "deepseek",
        stage: "overview_cache",
        retryable: false,
        primaryAction: "none",
        mayHaveConsumedCredit: false,
        sessionToken: binding.sessionToken,
      });
      assert.equal(app.getOverviewCacheRecoverySize(), 0);
      assert.equal(providerFetchCount(app), 1);
    });
  }
});

test("every retryable post-provider settlement failure enters opaque cache recovery", async (t) => {
  for (const mode of ["epoch read failure", "settlement throw"]) {
    await t.test(mode, async () => {
      let providerCompleted = false;
      let failSettlement = true;
      const app = loadBackground({
        initialState: await overviewStorageState(),
        async fetch(url) {
          if (String(url).startsWith("chrome-extension://test/prompts/")) {
            return {
              ok: true,
              status: 200,
              async text() { return read("prompts/overview.md"); },
            };
          }
          return {
            ok: true,
            status: 200,
            async json() {
              providerCompleted = true;
              return {
                choices: [{ message: { content: basicOverviewModelResponse() } }],
              };
            },
          };
        },
        storageGetFailure(query) {
          if (
            mode === "epoch read failure" &&
            failSettlement &&
            providerCompleted &&
            query === "ytd_reset_epoch"
          ) {
            failSettlement = false;
            return new Error("secret first settlement read failure");
          }
          return null;
        },
        wrapCoordinator(coordinator) {
          if (mode !== "settlement throw") return coordinator;
          return {
            ...coordinator,
            async settleBasicOverview(...args) {
              if (failSettlement) {
                failSettlement = false;
                throw new Error("secret settlement exception");
              }
              return coordinator.settleBasicOverview(...args);
            },
          };
        },
      });
      const binding = await bindDigestSession(app);

      const failure = await app.send(await overviewRequest(binding));

      assert.equal(failure.success, false);
      assert.equal(failure.code, "OVERVIEW_CACHE_WRITE_FAILED");
      assert.equal(failure.providerSucceeded, true);
      assert.equal(failure.overview.oneSentenceZh, "这是一句话结论。");
      assert.match(failure.recoveryToken, /^[a-f0-9]{32}$/);
      assert.equal(Object.hasOwn(failure, "attemptId"), false);
      assert.equal(Object.hasOwn(failure, "attemptRevision"), false);

      const recovered = await app.send({
        action: "retryBasicOverviewCacheWrite",
        videoId: "abc123",
        recoveryToken: failure.recoveryToken,
        ...binding,
      });
      assert.equal(recovered.success, true);
      assert.equal(providerFetchCount(app), 1);
      assert.equal(
        app.state.digest_abc123.basicOverview.oneSentenceZh,
        "这是一句话结论。",
      );
    });
  }
});

test("reset fences prevent a late retryable settlement failure from repopulating recovery", async (t) => {
  for (const fence of ["reset", "clear", "external epoch"]) {
    await t.test(fence, async () => {
      const settleStarted = deferred();
      const settleGate = deferred();
      let interceptSettlement = true;
      const app = loadBackground({
        initialState: await overviewStorageState(),
        fetch: overviewFetch(),
        wrapCoordinator(coordinator) {
          return {
            ...coordinator,
            async settleBasicOverview(...args) {
              if (!interceptSettlement) {
                return coordinator.settleBasicOverview(...args);
              }
              interceptSettlement = false;
              settleStarted.resolve();
              await settleGate.promise;
              return {
                success: false,
                code: "STORAGE_READ_FAILED",
                retryable: true,
              };
            },
          };
        },
      });
      const binding = await bindDigestSession(app);
      const pending = app.send(await overviewRequest(binding));
      await settleStarted.promise;

      if (fence === "reset") {
        assert.equal((await app.send({ action: "resetExtensionData" })).success, true);
      } else if (fence === "clear") {
        assert.equal((await app.send({ action: "clearDigestCache" })).success, true);
      } else {
        app.state.ytd_reset_epoch = 1;
        app.storageChangedListeners[0](
          { ytd_reset_epoch: { oldValue: 0, newValue: 1 } },
          "local",
        );
      }
      settleGate.resolve();
      const result = await pending;

      assert.equal(result.success, false);
      assert.equal(result.code, "OVERVIEW_CACHE_RECOVERY_UNAVAILABLE");
      assert.equal(result.providerSucceeded, true);
      assert.equal(result.mayHaveConsumedCredit, true);
      assert.equal(result.overview.oneSentenceZh, "这是一句话结论。");
      assert.equal(Object.hasOwn(result, "recoveryToken"), false);
      assert.equal(app.getOverviewCacheRecoverySize(), 0);
      assert.equal(providerFetchCount(app), 1);
      assert.equal(
        app.state.digest_abc123?.basicOverview,
        undefined,
      );
    });
  }
});

test("cache recovery tokens are unavailable when forged, restarted, rebound, expired, or reset", async (t) => {
  async function failedCacheApp(extra = {}) {
    const sharedState = await overviewStorageState();
    if (extra.Date) sharedState.digest_abc123.timestamp = extra.Date.now();
    const app = loadBackground({
      sharedState,
      fetch: overviewFetch(),
      storageSetHook(items) {
        if (items.digest_abc123?.basicOverview) {
          throw new Error("quota exceeded");
        }
      },
      ...extra,
    });
    const binding = await bindDigestSession(app);
    const failure = await app.send(await overviewRequest(binding));
    assert.equal(failure.code, "OVERVIEW_CACHE_WRITE_FAILED");
    return { app, binding, failure, sharedState };
  }
  const expected = (binding) => ({
    success: false,
    code: "OVERVIEW_CACHE_RECOVERY_UNAVAILABLE",
    provider: "deepseek",
    stage: "overview_cache",
    retryable: false,
    primaryAction: "none",
    mayHaveConsumedCredit: false,
    sessionToken: binding.sessionToken,
  });

  await t.test("forged token", async () => {
    const { app, binding } = await failedCacheApp();
    assert.deepEqual(await app.send({
      action: "retryBasicOverviewCacheWrite",
      videoId: "abc123",
      recoveryToken: "f".repeat(64),
      ...binding,
    }), expected(binding));
    assert.equal(providerFetchCount(app), 1);
  });

  await t.test("worker restart", async () => {
    const { binding, failure, sharedState } = await failedCacheApp();
    const restarted = loadBackground({ sharedState, fetch: overviewFetch() });
    await bindDigestSession(restarted, binding);
    assert.deepEqual(await restarted.send({
      action: "retryBasicOverviewCacheWrite",
      videoId: "abc123",
      recoveryToken: failure.recoveryToken,
      ...binding,
    }), expected(binding));
    assert.equal(providerFetchCount(restarted), 0);
  });

  await t.test("different current session", async () => {
    const { app, failure } = await failedCacheApp();
    const next = digestSessionBinding({ sessionId: "next", generation: 2 });
    await bindDigestSession(app, next);
    assert.deepEqual(await app.send({
      action: "retryBasicOverviewCacheWrite",
      videoId: "abc123",
      recoveryToken: failure.recoveryToken,
      ...next,
    }), expected(next));
  });

  await t.test("TTL expiry", async () => {
    let now = 2_000_000_000_000;
    const RuntimeDate = class extends Date {
      static now() { return now; }
    };
    const { app, binding, failure } = await failedCacheApp({ Date: RuntimeDate });
    now += 5 * 60 * 1000 + 1;
    assert.deepEqual(await app.send({
      action: "retryBasicOverviewCacheWrite",
      videoId: "abc123",
      recoveryToken: failure.recoveryToken,
      ...binding,
    }), expected(binding));
  });

  await t.test("oldest token is evicted at the 32-entry capacity", async () => {
    const videoIds = Array.from(
      { length: 33 },
      (_, index) => `evict${String(index).padStart(2, "0")}`,
    );
    const digest = await digestV2CacheValue();
    const initialState = {
      ytd_reset_epoch: 0,
      ytd_settings: overviewSettings(),
    };
    const bindings = videoIds.map((videoId, index) =>
      digestSessionBinding({
        videoId,
        tabId: 1_000 + index,
        windowId: 100 + index,
        sessionId: `capacity-${videoId}`,
      }),
    );
    const bindingByTab = new Map(bindings.map((binding) => [
      binding.tabId,
      binding,
    ]));
    for (const videoId of videoIds) {
      initialState[`digest_${videoId}`] = clone(digest);
    }
    const app = loadBackground({
      initialState,
      fetch: overviewFetch(),
      tabsGet(tabId) {
        const binding = bindingByTab.get(tabId);
        return {
          id: tabId,
          windowId: binding.sessionToken.windowId,
          active: true,
          url: `https://www.youtube.com/watch?v=${binding.sessionToken.videoId}`,
        };
      },
      storageSetHook(items) {
        if (Object.entries(items).some(([key, value]) =>
          key.startsWith("digest_") && value?.basicOverview,
        )) {
          throw new Error("disk unavailable");
        }
      },
    });

    const tokens = [];
    for (const binding of bindings) {
      await bindDigestSession(app, binding);
      const failure = await app.send(await overviewRequest(binding));
      assert.equal(
        failure.code,
        "OVERVIEW_CACHE_WRITE_FAILED",
        binding.sessionToken.videoId,
      );
      tokens.push(failure.recoveryToken);
    }
    assert.equal(app.getOverviewCacheRecoverySize(), 32);
    assert.equal(providerFetchCount(app), 33);

    assert.deepEqual(await app.send({
      action: "retryBasicOverviewCacheWrite",
      videoId: bindings[0].sessionToken.videoId,
      recoveryToken: tokens[0],
      ...bindings[0],
    }), expected(bindings[0]));
    const newest = await app.send({
      action: "retryBasicOverviewCacheWrite",
      videoId: bindings.at(-1).sessionToken.videoId,
      recoveryToken: tokens.at(-1),
      ...bindings.at(-1),
    });
    assert.equal(newest.code, "OVERVIEW_CACHE_WRITE_FAILED");
    assert.equal(newest.recoveryToken, tokens.at(-1));
    assert.equal(app.getOverviewCacheRecoverySize(), 32);
    assert.equal(providerFetchCount(app), 33);
  });

  await t.test("reset", async () => {
    const { app, failure } = await failedCacheApp();
    assert.equal((await app.send({ action: "resetExtensionData" })).success, true);
    const next = digestSessionBinding({
      sessionId: "after-reset",
      generation: 2,
      resetEpoch: 1,
    });
    await bindDigestSession(app, next);
    assert.deepEqual(await app.send({
      action: "retryBasicOverviewCacheWrite",
      videoId: "abc123",
      recoveryToken: failure.recoveryToken,
      ...next,
    }), expected(next));
  });
});

test("checkConfig is exact booleans on success and storage failure, and raw overview route is absent", async () => {
  const configured = loadBackground({
    initialState: await overviewStorageState({
      ytd_settings: overviewSettings({
        supadataApiKey: "supadata-secret",
        autoBasicOverview: true,
      }),
    }),
  });
  assert.deepEqual(await configured.send({ action: "checkConfig" }), {
    hasSupadataKey: true,
    hasAiKey: true,
    autoBasicOverview: true,
  });

  const failed = loadBackground({
    storageGetFailure(query) {
      return query === "ytd_settings"
        ? new Error("storage secret ai-key-123")
        : null;
    },
  });
  assert.deepEqual(await failed.send({ action: "checkConfig" }), {
    hasSupadataKey: false,
    hasAiKey: false,
    autoBasicOverview: false,
  });

  const raw = configured.dispatchUnhandled({
    action: "generateBasicOverview",
    videoId: "abc123",
    payload: await basicOverviewPayload(),
  });
  assert.notEqual(raw.handled, true);
  assert.equal(raw.responseCount, 0);
  assert.doesNotMatch(
    read("background.js"),
    /message\.action\s*===\s*["']generateBasicOverview["']/,
  );
});

test("requestBasicOverview maps initial authority failures to exact bounded envelopes", async (t) => {
  const expected = (code, binding) => ({
    success: false,
    code,
    provider: "deepseek",
    stage: "overview",
    retryable: true,
    primaryAction: "retry",
    mayHaveConsumedCredit: false,
    sessionToken: binding.sessionToken,
  });

  await t.test("message video mismatches the valid token", async () => {
    const app = loadBackground({
      initialState: await overviewStorageState(),
      fetch: overviewFetch(),
    });
    const binding = await bindDigestSession(app);
    const result = await app.send(await overviewRequest(binding, {
      videoId: "def456",
    }));

    assert.deepEqual(result, expected("SESSION_BINDING_MISMATCH", binding));
    assert.equal(providerFetchCount(app), 0);
    assert.equal(app.getRandomValueCalls(), 0);
    assert.equal(app.getTimerCreations(), 0);
    assert.equal(overviewAttemptKeys(app.state).length, 0);
  });

  await t.test("bound tab navigated to another video", async () => {
    let tabVideoId = "abc123";
    const app = loadBackground({
      initialState: await overviewStorageState(),
      fetch: overviewFetch(),
      tabsGet(tabId) {
        return {
          id: tabId,
          windowId: 7,
          active: true,
          url: `https://www.youtube.com/watch?v=${tabVideoId}`,
        };
      },
    });
    const binding = await bindDigestSession(app);
    tabVideoId = "def456";
    const result = await app.send(await overviewRequest(binding));

    assert.deepEqual(result, expected("TAB_VIDEO_MISMATCH", binding));
    assert.equal(providerFetchCount(app), 0);
    assert.equal(app.getRandomValueCalls(), 0);
    assert.equal(app.getTimerCreations(), 0);
    assert.equal(overviewAttemptKeys(app.state).length, 0);
  });

  await t.test("a newer valid panel session superseded the token", async () => {
    const app = loadBackground({
      initialState: await overviewStorageState(),
      fetch: overviewFetch(),
    });
    const first = await bindDigestSession(app, digestSessionBinding({
      sessionId: "overview-authority-first",
    }));
    await bindDigestSession(app, digestSessionBinding({
      sessionId: "overview-authority-next",
      generation: 2,
    }));
    const result = await app.send(await overviewRequest(first));

    assert.deepEqual(result, expected("SESSION_STALE", first));
    assert.equal(providerFetchCount(app), 0);
    assert.equal(app.getRandomValueCalls(), 0);
    assert.equal(app.getTimerCreations(), 0);
    assert.equal(overviewAttemptKeys(app.state).length, 0);
  });
});

test("all eight persistence actions respond exactly once", async () => {
  const app = loadBackground({
    initialState: {
      ytd_reset_epoch: 0,
      ytd_settings: { aiApiKey: "", supadataApiKey: "" },
      ytd_notes: [{ id: "n1" }],
    },
  });
  const actions = [
    "getResetEpoch",
    "persistDigestBase",
    "getLocalDataSummary",
    "clearDigestCache",
    "deleteAllNotes",
    "saveProviderSettings",
    "removeProviderKey",
    "resetExtensionData",
  ];

  await app.send({ action: "getResetEpoch" });
  const binding = await bindDigestSession(app);
  const value = await digestBaseValue();
  await app.send({
    action: "persistDigestBase",
    expectedEpoch: 0,
    videoId: "abc123",
    value,
    ...binding,
  });
  await app.send({ action: "getLocalDataSummary" });
  await app.send({ action: "clearDigestCache" });
  await app.send({ action: "deleteAllNotes" });
  await app.send({
    action: "saveProviderSettings",
    provider: "supadata",
    apiKey: ["supadata", "callback", "fixture"].join("-"),
  });
  await app.send({ action: "removeProviderKey", provider: "supadata" });
  await app.send({ action: "resetExtensionData" });

  await assertSingleResponseCallbacks(app, [
    "getResetEpoch",
    "bindVideoSession",
    ...actions.slice(1),
  ]);
});

test("provider keys save and remove independently without a paid probe or secret response", async () => {
  const supadataKey = ["supadata", "fixture", "key"].join("-");
  const deepseekKey = ["deepseek", "fixture", "key"].join("-");
  const app = loadBackground({
    initialState: {
      ytd_reset_epoch: 0,
      ytd_settings: {
        provider: "deepseek",
        aiApiKey: "deepseek-old",
        aiBaseUrl: "https://api.deepseek.com",
        aiModel: "deepseek-v4-flash",
        supadataApiKey: "supadata-old",
        autoBasicOverview: false,
      },
      ytd_provider_status: {
        supadata: { state: "connected", lastCheckedAt: 10, lastFailureCode: "" },
        deepseek: { state: "connected", lastCheckedAt: 20, lastFailureCode: "" },
      },
    },
  });

  const supadata = await app.send({
    action: "saveProviderSettings",
    provider: "supadata",
    apiKey: supadataKey,
  });
  assert.equal(supadata.success, true);
  assert.equal(JSON.stringify(supadata).includes(supadataKey), false);
  assert.equal(app.state.ytd_settings.supadataApiKey, supadataKey);
  assert.equal(app.state.ytd_settings.aiApiKey, "deepseek-old");
  assertExactStatus(app.state.ytd_provider_status.supadata, {
    state: "saved_untested",
    lastCheckedAt: null,
    lastFailureCode: "",
  });
  assertExactStatus(app.state.ytd_provider_status.deepseek, {
    state: "connected",
    lastCheckedAt: 20,
    lastFailureCode: "",
  });

  const deepseek = await app.send({
    action: "saveProviderSettings",
    provider: "deepseek",
    apiKey: deepseekKey,
    options: { autoBasicOverview: true },
  });
  assert.equal(deepseek.success, true);
  assert.equal(app.state.ytd_settings.supadataApiKey, supadataKey);
  assert.equal(app.state.ytd_settings.aiApiKey, deepseekKey);
  assert.equal(app.state.ytd_settings.autoBasicOverview, true);

  const removed = await app.send({
    action: "removeProviderKey",
    provider: "supadata",
  });
  assert.equal(removed.success, true);
  assert.equal(app.state.ytd_settings.supadataApiKey, "");
  assert.equal(app.state.ytd_settings.aiApiKey, deepseekKey);
  assertExactStatus(app.state.ytd_provider_status.supadata, {
    state: "unsaved",
    lastCheckedAt: null,
    lastFailureCode: "",
  });
  const removedDeepSeek = await app.send({
    action: "removeProviderKey",
    provider: "deepseek",
  });
  assert.equal(removedDeepSeek.success, true);
  assert.equal(app.state.ytd_settings.aiApiKey, "");
  assert.equal(app.state.ytd_settings.autoBasicOverview, true);
  assertExactStatus(app.state.ytd_provider_status.deepseek, {
    state: "unsaved",
    lastCheckedAt: null,
    lastFailureCode: "",
  });
  assert.equal(app.getFetchCalls(), 0);
});

test("saving an unchanged provider key preserves its verified canonical status", async () => {
  const app = loadBackground({
    initialState: {
      ytd_reset_epoch: 0,
      ytd_settings: {
        provider: "deepseek",
        aiApiKey: "deepseek-same",
        aiBaseUrl: "https://api.deepseek.com",
        aiModel: "deepseek-v4-flash",
        supadataApiKey: "supadata-same",
        autoBasicOverview: false,
      },
      ytd_provider_status: {
        deepseek: {
          state: "connected",
          lastCheckedAt: 101,
          lastFailureCode: "",
        },
        supadata: {
          state: "rejected",
          lastCheckedAt: 202,
          lastFailureCode: "INVALID_KEY",
        },
      },
    },
  });

  const deepseek = await app.send({
    action: "saveProviderSettings",
    provider: "deepseek",
    apiKey: "  deepseek-same  ",
    options: { autoBasicOverview: true },
  });
  assert.equal(deepseek.success, true);
  assert.equal(app.state.ytd_settings.autoBasicOverview, true);
  assertExactStatus(app.state.ytd_provider_status.deepseek, {
    state: "connected",
    lastCheckedAt: 101,
    lastFailureCode: "",
  });

  const supadata = await app.send({
    action: "saveProviderSettings",
    provider: "supadata",
    apiKey: "supadata-same",
  });
  assert.equal(supadata.success, true);
  assertExactStatus(app.state.ytd_provider_status.supadata, {
    state: "rejected",
    lastCheckedAt: 202,
    lastFailureCode: "INVALID_KEY",
  });

  app.state.ytd_provider_status.deepseek = {
    state: "unavailable",
    lastCheckedAt: 303,
    lastFailureCode: "NETWORK_ERROR",
  };
  app.state.ytd_provider_status.supadata = {
    state: "rate_limited",
    lastCheckedAt: 404,
    lastFailureCode: "RATE_LIMITED",
  };
  await app.send({
    action: "saveProviderSettings",
    provider: "deepseek",
    apiKey: "deepseek-same",
  });
  await app.send({
    action: "saveProviderSettings",
    provider: "supadata",
    apiKey: "supadata-same",
  });
  assertExactStatus(app.state.ytd_provider_status.deepseek, {
    state: "unavailable",
    lastCheckedAt: 303,
    lastFailureCode: "NETWORK_ERROR",
  });
  assertExactStatus(app.state.ytd_provider_status.supadata, {
    state: "rate_limited",
    lastCheckedAt: 404,
    lastFailureCode: "RATE_LIMITED",
  });
  assert.equal(app.getFetchCalls(), 0);
});

test("provider validation is typed and an empty key cannot disturb the other provider", async () => {
  const app = loadBackground({
    initialState: {
      ytd_reset_epoch: 0,
      ytd_settings: { aiApiKey: "deepseek-keep", supadataApiKey: "supadata-keep" },
    },
  });

  assert.deepEqual(
    await app.send({
      action: "saveProviderSettings",
      provider: "unknown",
      apiKey: "do-not-echo",
    }),
    { success: false, code: "INVALID_PROVIDER" },
  );
  assert.deepEqual(
    await app.send({
      action: "saveProviderSettings",
      provider: "supadata",
      apiKey: "   ",
    }),
    { success: false, code: "INVALID_API_KEY" },
  );
  assert.equal(app.state.ytd_settings.aiApiKey, "deepseek-keep");
  assert.equal(app.state.ytd_settings.supadataApiKey, "supadata-keep");
});

test("digest persistence validates identity and rejects an old reset epoch", async () => {
  const app = loadBackground();

  assert.deepEqual(
    await app.send({
      action: "persistDigestBase",
      expectedEpoch: "0",
      videoId: "abc123",
      value: {},
    }),
    { success: false, code: "INVALID_RESET_EPOCH" },
  );
  assert.deepEqual(
    await app.send({
      action: "persistDigestBase",
      expectedEpoch: 0,
      videoId: "bad id",
      value: {},
    }),
    { success: false, code: "INVALID_VIDEO_ID" },
  );

  const binding = await bindDigestSession(app);
  const reset = await app.send({ action: "resetExtensionData" });
  assert.equal(reset.success, true);
  assert.deepEqual(
    await app.send({
      action: "persistDigestBase",
      expectedEpoch: 0,
      videoId: "abc123",
      value: { timestamp: 2 },
      ...binding,
    }),
    {
      success: false,
      code: "SESSION_UNKNOWN",
      sessionToken: binding.sessionToken,
    },
  );
  assert.equal(Object.hasOwn(app.state, "digest_abc123"), false);
});

test("digest persistence revalidates the bound tab inside the commit queue", async () => {
  let currentUrl = "https://www.youtube.com/watch?v=abc123";
  const app = loadBackground({
    blockFirstEpochRead: true,
    blockEpochReadAfter: 4,
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      url: currentUrl,
    }),
  });
  const binding = await bindDigestSession(app);
  const value = await digestBaseValue({
    transcript: [{ text: "old page", start: 0, duration: 1 }],
  });

  const persist = app.send({
    action: "persistDigestBase",
    expectedEpoch: 0,
    videoId: "abc123",
    value,
    ...binding,
  });
  await waitUntil(
    () => app.getTabGetCount() >= 2 && app.getPendingStorageOperations() > 0,
  );
  currentUrl = "https://www.youtube.com/watch?v=def456";
  app.releaseFirstEpochRead();

  const result = await persist;
  assert.equal(result.success, false);
  assert.equal(result.code, "SESSION_STALE");
  assert.equal(result.retryable, false);
  assert.deepEqual(result.evictedKeys, []);
  assert.equal(Object.hasOwn(app.state, "digest_abc123"), false);
  assert.ok(app.getTabGetCount() >= 2);
});

test("digest persistence reads the epoch before its final tab identity check", async () => {
  const finalEpochStarted = deferred();
  const finalEpochGate = deferred();
  let currentUrl = "https://www.youtube.com/watch?v=abc123";
  const app = loadBackground({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: currentUrl,
    }),
    async storageGetHook(query, { epochReadCount }) {
      if (query === "ytd_reset_epoch" && epochReadCount === 5) {
        finalEpochStarted.resolve();
        await finalEpochGate.promise;
      }
    },
  });
  const binding = await bindDigestSession(app);
  const value = await digestBaseValue({
    transcript: [{ text: "must stay unwritten", start: 0, duration: 1 }],
  });

  const persist = app.send({
    action: "persistDigestBase",
    expectedEpoch: 0,
    videoId: "abc123",
    value,
    ...binding,
  });
  await finalEpochStarted.promise;
  currentUrl = "https://www.youtube.com/watch?v=def456";
  finalEpochGate.resolve();

  const result = await persist;
  assert.equal(result.success, false);
  assert.equal(result.code, "SESSION_STALE");
  assert.equal(Object.hasOwn(app.state, "digest_abc123"), false);
  assert.equal(
    app.storageWrites.some((write) => Object.hasOwn(write, "digest_abc123")),
    false,
  );
});

test("provider dispatch reads the epoch before its final tab identity check", async () => {
  const finalEpochStarted = deferred();
  const finalEpochGate = deferred();
  let currentUrl = "https://www.youtube.com/watch?v=abc123";
  const app = loadBackground({
    initialState: {
      ytd_reset_epoch: 0,
      ytd_settings: { aiApiKey: "", supadataApiKey: "supadata-key" },
    },
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: currentUrl,
    }),
    async storageGetHook(query, { epochReadCount }) {
      if (query === "ytd_reset_epoch" && epochReadCount === 3) {
        finalEpochStarted.resolve();
        await finalEpochGate.promise;
      }
    },
    async fetch() {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            content: [{ text: "wrong page", offset: 0, duration: 1000 }],
            lang: "en",
          };
        },
      };
    },
  });
  const binding = await bindDigestSession(app);

  const transcript = app.send({
    action: "fetchTranscript",
    videoId: "abc123",
    ...binding,
  });
  await finalEpochStarted.promise;
  currentUrl = "https://www.youtube.com/watch?v=def456";
  finalEpochGate.resolve();

  const result = await transcript;
  assert.equal(result.success, false);
  assert.equal(result.code, "TAB_VIDEO_MISMATCH");
  assert.equal(app.getFetchCalls(), 0);
});

test("content note commit reads the epoch before its final tab identity check", async () => {
  const finalEpochStarted = deferred();
  const finalEpochGate = deferred();
  let currentUrl = "https://www.youtube.com/watch?v=abc123";
  const app = loadBackground({
    initialState: {
      ytd_reset_epoch: 0,
      ytd_settings: { aiApiKey: "", supadataApiKey: "" },
      digest_abc123: await digestV2CacheValue({
        transcript: [{ text: "A cached sentence.", start: 0, duration: 5 }],
      }),
    },
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: false,
      url: currentUrl,
    }),
    async storageGetHook(query, { epochReadCount }) {
      if (query === "ytd_reset_epoch" && epochReadCount === 5) {
        finalEpochStarted.resolve();
        await finalEpochGate.promise;
      }
    },
  });

  const save = app.send({
    action: "saveNote",
    videoId: "abc123",
    timestamp: 1,
    videoTitle: "A",
    channelName: "Channel",
  });
  await finalEpochStarted.promise;
  currentUrl = "https://www.youtube.com/watch?v=def456";
  finalEpochGate.resolve();

  const result = await save;
  assert.equal(result.success, false);
  assert.equal(result.code, "TAB_VIDEO_MISMATCH");
  assert.equal(Object.hasOwn(app.state, "ytd_notes"), false);
  assert.equal(
    app.storageWrites.some((write) => Object.hasOwn(write, "ytd_notes")),
    false,
  );
});

test("summary, digest clearing, note deletion, and full reset stay scoped", async () => {
  const app = loadBackground({
    initialState: {
      ytd_options_language: "zh-CN",
      ytd_reset_epoch: 4,
      ytd_settings: { aiApiKey: "secret" },
      ytd_provider_status: { deepseek: { state: "saved_untested" } },
      digest_abc123: { timestamp: 1, paragraphCache: { a: "甲", b: "乙" } },
      digest_def456: { timestamp: 2 },
      [`ytd_overview_attempt_v1_abc123_sha256-v1-${"a".repeat(64)}`]: {
        keepUntilCacheClear: true,
      },
      ytd_notes: [{ id: "n1" }, { id: "n2" }],
      ytd_vocabulary: { entries: [{ id: "v1" }] },
      future_unknown_store: { keepUntilFullReset: true },
    },
  });

  assert.deepEqual(await app.send({ action: "getLocalDataSummary" }), {
    success: true,
    summary: {
      settings: 1,
      providerStatus: 1,
      digests: 2,
      translations: 2,
      notes: 2,
      vocabulary: 1,
    },
  });
  assert.deepEqual(await app.send({ action: "clearDigestCache" }), {
    success: true,
    resetEpoch: 5,
    removedCount: 2,
    removedAttemptCount: 1,
  });
  assert.equal(Object.hasOwn(app.state, "digest_abc123"), false);
  assert.equal(Object.hasOwn(app.state, "ytd_notes"), true);
  assert.equal(Object.hasOwn(app.state, "future_unknown_store"), true);
  assert.equal(
    Object.keys(app.state).some((key) =>
      key.startsWith("ytd_overview_attempt_v1_"),
    ),
    false,
  );

  assert.deepEqual(await app.send({ action: "deleteAllNotes" }), {
    success: true,
    deletedCount: 2,
  });
  assert.equal(Object.hasOwn(app.state, "ytd_notes"), false);
  assert.equal(Object.hasOwn(app.state, "ytd_vocabulary"), true);

  const reset = await app.send({ action: "resetExtensionData" });
  assert.equal(reset.success, true);
  assert.equal(reset.resetEpoch, 6);
  assert.deepEqual(Object.keys(app.state).sort(), [
    "ytd_options_language",
    "ytd_reset_epoch",
  ]);
});

test("scoped deletion verifies storage before reporting success", async () => {
  const app = loadBackground({
    initialState: {
      ytd_reset_epoch: 0,
      digest_abc123: { timestamp: 1 },
    },
    ignoreRemovals: true,
  });

  assert.deepEqual(await app.send({ action: "clearDigestCache" }), {
    success: false,
    code: "CLEAR_VERIFICATION_FAILED",
    resetEpoch: 1,
    removedCount: 0,
    removedAttemptCount: 0,
    remainingCount: 1,
    remainingKeys: ["digest_abc123"],
  });
});

test("digest clear verifies a large residual set without quadratic membership scans", async () => {
  const digestEntries = Object.fromEntries(
    Array.from({ length: 2_000 }, (_, index) => [
      `digest_large_${String(index).padStart(4, "0")}`,
      { timestamp: index },
    ]),
  );
  const app = loadBackground({
    initialState: { ytd_reset_epoch: 0, ...digestEntries },
    ignoreRemovals: true,
  });

  assert.deepEqual(await app.send({ action: "clearDigestCache" }), {
    success: false,
    code: "CLEAR_VERIFICATION_FAILED",
    resetEpoch: 1,
    removedCount: 0,
    removedAttemptCount: 0,
    remainingCount: 100,
    remainingKeys: Object.keys(digestEntries).sort().slice(0, 100),
  });
  await assertSingleResponseCallbacks(app, ["clearDigestCache"]);

  const clearHandler = read("background.js").match(
    /async function handleClearDigestCache\(\)[\s\S]*?(?=\n(?:async )?function handleDeleteAllNotes)/,
  )?.[0] || "";
  assert.ok(clearHandler, "missing clear-digest handler");
  assert.doesNotMatch(clearHandler, /\.includes\(/);
});

test("note deletion reports the exact bounded numeric count", async () => {
  const app = loadBackground({
    initialState: {
      ytd_reset_epoch: 0,
      ytd_notes: Array.from({ length: 125 }, (_, index) => ({ id: `n${index}` })),
    },
  });

  assert.deepEqual(await app.send({ action: "deleteAllNotes" }), {
    success: true,
    deletedCount: 125,
  });
});

test("invalid note deletion responds with a bounded failure", async () => {
  const app = loadBackground();
  assert.deepEqual(
    await app.send({ action: "saveNote", videoId: "not a video" }),
    {
      success: false,
      code: "INVALID_VIDEO_ID",
      error: "INVALID_VIDEO_ID",
    },
  );
  assert.deepEqual(await app.send({ action: "deleteNote", noteId: "" }), {
    success: false,
    code: "INVALID_NOTE_ID",
    error: "INVALID_NOTE_ID",
  });
});

test("concurrent provider writes share FIFO storage and await completion", async () => {
  const app = loadBackground();
  const [supadata, deepseek] = await Promise.all([
    app.send({
      action: "saveProviderSettings",
      provider: "supadata",
      apiKey: "supadata-key",
    }),
    app.send({
      action: "saveProviderSettings",
      provider: "deepseek",
      apiKey: "deepseek-key",
    }),
  ]);

  assert.equal(supadata.success, true);
  assert.equal(deepseek.success, true);
  assert.equal(app.state.ytd_settings.supadataApiKey, "supadata-key");
  assert.equal(app.state.ytd_settings.aiApiKey, "deepseek-key");
  assert.equal(app.getMaxConcurrentWrites(), 1);
  assert.equal(app.getPendingStorageOperations(), 0);
});

test("clear invalidates a later old-generation digest persistence request", async () => {
  const app = loadBackground({
    blockFirstEpochRead: true,
    blockEpochReadAfter: 1,
    initialState: {
      ytd_reset_epoch: 0,
      digest_before: { timestamp: 1, transcript: [] },
    },
  });

  const binding = await bindDigestSession(app);
  const value = await digestBaseValue({
    transcript: [{ text: "later", start: 0, duration: 1 }],
  });
  const clearPromise = app.send({ action: "clearDigestCache" });
  const persistPromise = app.send({
    action: "persistDigestBase",
    expectedEpoch: 0,
    videoId: "abc123",
    value,
    ...binding,
  });
  await new Promise((resolve) => setImmediate(resolve));
  app.releaseFirstEpochRead();
  const [cleared, persisted] = await Promise.all([
    clearPromise,
    persistPromise,
  ]);

  assert.deepEqual(cleared, {
    success: true,
    resetEpoch: 1,
    removedCount: 1,
    removedAttemptCount: 0,
  });
  assert.deepEqual(persisted, {
    success: false,
    code: "RESET_DURING_REQUEST",
    sessionToken: binding.sessionToken,
  });
  assert.equal(Object.hasOwn(app.state, "digest_before"), false);
  assert.equal(Object.hasOwn(app.state, "digest_abc123"), false);
  await assertSingleResponseCallbacks(app, [
    "bindVideoSession",
    "clearDigestCache",
    "persistDigestBase",
  ]);
});

test("summary reads stay on the same FIFO as a later mutation", async () => {
  const app = loadBackground();
  const [summary, saved] = await Promise.all([
    app.send({ action: "getLocalDataSummary" }),
    app.send({
      action: "saveProviderSettings",
      provider: "supadata",
      apiKey: "supadata-key",
    }),
  ]);

  assert.equal(summary.success, true);
  assert.equal(saved.success, true);
  assert.equal(app.getMaxConcurrentStorageOperations(), 1);
});

test("synchronous handler reentry fails fast without deadlocking the FIFO", async () => {
  const app = loadBackground({ reenterOnProviderRead: true });
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error("coordinator reentry deadlocked")),
      250,
    );
  });
  const saved = await Promise.race([
    app.send({
      action: "saveProviderSettings",
      provider: "supadata",
      apiKey: "supadata-key",
    }),
    timeout,
  ]);
  const reentry = await Promise.race([app.getReentryResponse(), timeout]);
  clearTimeout(timeoutId);

  assert.equal(saved.success, true);
  assert.deepEqual(reentry, {
    success: false,
    code: "RESET_STORAGE_FAILED",
  });
  assert.equal(app.state.ytd_reset_epoch, 0);
});

test("note reads wait on the shared FIFO before a later delete", async () => {
  const app = loadBackground({
    initialState: {
      ytd_reset_epoch: 0,
      ytd_notes: [{ id: "n1", videoId: "abc123" }],
    },
  });
  const binding = await bindDigestSession(app);
  const [readResult, deleteResult] = await Promise.all([
    app.send({ action: "getNotes", videoId: "abc123", ...binding }),
    app.send({ action: "deleteNote", noteId: "n1", ...binding }),
  ]);

  assert.equal(readResult.notes.length, 1);
  assert.equal(deleteResult.success, true);
  assert.equal(app.getMaxConcurrentWrites(), 1);
});

test("vocabulary reads wait on the shared FIFO before a later delete", async () => {
  const app = loadBackground({
    initialState: {
      ytd_reset_epoch: 0,
      ytd_vocabulary: { schemaVersion: 2, entries: [validVocabularyCard()] },
    },
  });
  const [readResult, deleteResult] = await Promise.all([
    app.send({ action: "getVocabulary" }),
    app.send({ action: "deleteVocabularyCard", cardId: "vocab_run" }),
  ]);

  assert.equal(readResult.entries.length, 1);
  assert.equal(deleteResult.success, true);
  assert.equal(app.getMaxConcurrentStorageOperations(), 1);
});

test("save-note trusts only a fresh exact digest v2 transcript", async () => {
  const now = 1_700_000_000_000;
  class FrozenDate extends Date {
    static now() {
      return now;
    }
  }
  const transcript = [
    { text: "A trusted cached sentence.", start: 0, duration: 5 },
  ];
  const app = loadBackground({
    Date: FrozenDate,
    initialState: {
      ytd_reset_epoch: 0,
      ytd_settings: { aiApiKey: "", supadataApiKey: "supadata-key" },
      digest_abc123: await digestV2CacheValue({ timestamp: now, transcript }),
    },
  });

  const saved = await app.send({
    action: "saveNote",
    videoId: "abc123",
    timestamp: 1,
    videoTitle: "Lesson",
    channelName: "Teacher",
  });

  assert.equal(saved.success, true);
  assert.equal(saved.note.rawText, "A trusted cached sentence.");
  assert.equal(app.getFetchCalls(), 0);
});

test("save-note refetches instead of trusting malformed, stale, future, or mismatched cache", async () => {
  const now = 1_700_000_000_000;
  const ttl = 30 * 24 * 60 * 60 * 1000;
  class FrozenDate extends Date {
    static now() {
      return now;
    }
  }
  const canonical = await digestV2CacheValue({
    timestamp: now,
    transcript: [{ text: "Untrusted cached sentence.", start: 0, duration: 5 }],
  });
  const fixtures = [
    ["missing schema marker", { ...canonical, digestSchemaVersion: undefined }],
    ["future timestamp", { ...canonical, timestamp: now + 1 }],
    ["exact ttl", { ...canonical, timestamp: now - ttl }],
    [
      "fingerprint mismatch",
      { ...canonical, transcriptFingerprint: `sha256-v1-${"f".repeat(64)}` },
    ],
    [
      "empty canonical segments",
      await digestV2CacheValue({
        timestamp: now,
        transcript: [{ text: "   ", start: 0, duration: 5 }],
      }),
    ],
    [
      "missing start",
      await digestV2CacheValue({
        timestamp: now,
        transcript: [{ text: "Malformed source.", duration: 5 }],
      }),
    ],
    [
      "string duration",
      await digestV2CacheValue({
        timestamp: now,
        transcript: [{ text: "Malformed source.", start: 0, duration: "5" }],
      }),
    ],
    [
      "negative start",
      await digestV2CacheValue({
        timestamp: now,
        transcript: [{ text: "Malformed source.", start: -1, duration: 5 }],
      }),
    ],
    [
      "non-string language",
      await digestV2CacheValue({
        timestamp: now,
        transcript: [
          { text: "Malformed source.", start: 0, duration: 5, language: 42 },
        ],
      }),
    ],
    [
      "oversized aggregate",
      { ...canonical, transcriptText: "x".repeat(2 * 1024 * 1024 + 1) },
    ],
  ];

  for (const [label, digest] of fixtures) {
    const app = loadBackground({
      Date: FrozenDate,
      initialState: {
        ytd_reset_epoch: 0,
        ytd_settings: { aiApiKey: "", supadataApiKey: "supadata-key" },
        digest_abc123: digest,
      },
      async fetch() {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              content: [
                { text: "Fresh provider sentence.", offset: 0, duration: 5000 },
              ],
              lang: "en",
            };
          },
        };
      },
    });

    const saved = await app.send({
      action: "saveNote",
      videoId: "abc123",
      timestamp: 1,
      videoTitle: "Lesson",
      channelName: "Teacher",
    });

    assert.equal(saved.success, true, label);
    assert.equal(saved.note.rawText, "Fresh provider sentence.", label);
    assert.equal(app.getFetchCalls(), 1, label);
  }
});

test("save-note fails free when WebCrypto cannot validate a cached digest", async () => {
  const now = 1_700_000_000_000;
  class FrozenDate extends Date {
    static now() {
      return now;
    }
  }
  const digest = await digestV2CacheValue({
    timestamp: now,
    transcript: [{ text: "Cached sentence.", start: 0, duration: 5 }],
  });
  const app = loadBackground({
    Date: FrozenDate,
    crypto: { randomUUID: () => "note-id" },
    initialState: {
      ytd_reset_epoch: 0,
      ytd_settings: { aiApiKey: "", supadataApiKey: "supadata-key" },
      digest_abc123: digest,
    },
  });

  const result = await app.send({
    action: "saveNote",
    videoId: "abc123",
    timestamp: 1,
    videoTitle: "Lesson",
    channelName: "Teacher",
  });

  assert.deepEqual(result, {
    success: false,
    code: "TRANSCRIPT_FINGERPRINT_UNAVAILABLE",
    error: "TRANSCRIPT_FINGERPRINT_UNAVAILABLE",
  });
  assert.equal(app.getFetchCalls(), 0);
  assert.equal(Object.hasOwn(app.state, "ytd_notes"), false);
});

test("save-note does not purchase a transcript when WebCrypto is unavailable", async () => {
  const app = loadBackground({
    crypto: { randomUUID: () => "note-id" },
    initialState: {
      ytd_reset_epoch: 0,
      ytd_settings: { aiApiKey: "", supadataApiKey: "supadata-key" },
    },
  });

  const result = await app.send({
    action: "saveNote",
    videoId: "abc123",
    timestamp: 1,
    videoTitle: "Lesson",
    channelName: "Teacher",
  });

  assert.deepEqual(result, {
    success: false,
    code: "TRANSCRIPT_FINGERPRINT_UNAVAILABLE",
    error: "TRANSCRIPT_FINGERPRINT_UNAVAILABLE",
  });
  assert.equal(app.getFetchCalls(), 0);
});

test("save-note does not purchase a transcript when secure fingerprint encoding is unavailable", async () => {
  const app = loadBackground({
    TextEncoder: null,
    initialState: {
      ytd_reset_epoch: 0,
      ytd_settings: { aiApiKey: "", supadataApiKey: "supadata-key" },
    },
    async fetch() {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            content: [
              { text: "Provider sentence.", offset: 0, duration: 5000 },
            ],
            lang: "en",
          };
        },
      };
    },
  });

  const result = await app.send({
    action: "saveNote",
    videoId: "abc123",
    timestamp: 1,
    videoTitle: "Lesson",
    channelName: "Teacher",
  });

  assert.deepEqual(result, {
    success: false,
    code: "TRANSCRIPT_FINGERPRINT_UNAVAILABLE",
    error: "TRANSCRIPT_FINGERPRINT_UNAVAILABLE",
  });
  assert.equal(app.getFetchCalls(), 0);
});

test("save-note rechecks panel authority after hashing a cached transcript", async () => {
  const now = 1_700_000_000_000;
  class FrozenDate extends Date {
    static now() {
      return now;
    }
  }
  const hashStarted = deferred();
  const hashGate = deferred();
  const digest = await digestV2CacheValue({
    timestamp: now,
    transcript: [{ text: "Cached sentence.", start: 0, duration: 5 }],
  });
  const app = loadBackground({
    Date: FrozenDate,
    crypto: {
      randomUUID: () => "note-id",
      subtle: {
        async digest(...args) {
          hashStarted.resolve();
          await hashGate.promise;
          return webcrypto.subtle.digest(...args);
        },
      },
    },
    initialState: {
      ytd_reset_epoch: 0,
      ytd_settings: { aiApiKey: "", supadataApiKey: "supadata-key" },
      digest_abc123: digest,
    },
  });
  const binding = await bindDigestSession(app);

  const pending = app.send({
    action: "saveNote",
    videoId: "abc123",
    timestamp: 1,
    videoTitle: "Lesson",
    channelName: "Teacher",
    ...binding,
  });
  await hashStarted.promise;
  app.state.ytd_reset_epoch = 1;
  app.storageChangedListeners[0](
    { ytd_reset_epoch: { oldValue: 0, newValue: 1 } },
    "local",
  );
  hashGate.resolve();

  const result = await pending;
  assert.equal(result.success, false);
  assert.equal(result.code, "SESSION_STALE");
  assert.deepEqual(result.sessionToken, binding.sessionToken);
  assert.equal(app.getFetchCalls(), 0);
  assert.equal(Object.hasOwn(app.state, "ytd_notes"), false);
});

test("save-note treats a digest crossing exact TTL during hashing as a cache miss", async () => {
  const ttl = 30 * 24 * 60 * 60 * 1000;
  let now = 1_700_000_000_000;
  class MovingDate extends Date {
    static now() {
      return now;
    }
  }
  const digest = await digestV2CacheValue({
    timestamp: now - ttl + 1,
    transcript: [{ text: "Nearly stale cached sentence.", start: 0, duration: 5 }],
  });
  const app = loadBackground({
    Date: MovingDate,
    crypto: {
      randomUUID: () => "note-id",
      subtle: {
        async digest(...args) {
          now += 2;
          return webcrypto.subtle.digest(...args);
        },
      },
    },
    initialState: {
      ytd_reset_epoch: 0,
      ytd_settings: { aiApiKey: "", supadataApiKey: "supadata-key" },
      digest_abc123: digest,
    },
    async fetch() {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            content: [
              { text: "Fresh provider sentence.", offset: 0, duration: 5000 },
            ],
            lang: "en",
          };
        },
      };
    },
  });

  const saved = await app.send({
    action: "saveNote",
    videoId: "abc123",
    timestamp: 1,
    videoTitle: "Lesson",
    channelName: "Teacher",
  });

  assert.equal(saved.success, true);
  assert.equal(saved.note.rawText, "Fresh provider sentence.");
  assert.equal(app.getFetchCalls(), 1);
});

test("save-note then delete-note commits in request order with unique fallback IDs", async () => {
  class FrozenDate extends Date {
    static now() {
      return 1_700_000_000_000;
    }
  }
  const app = loadBackground({
    Date: FrozenDate,
    crypto: {
      subtle: webcrypto.subtle,
      getRandomValues: (target) => target.fill(7),
    },
    initialState: {
      ytd_reset_epoch: 0,
      ytd_settings: { aiApiKey: "", supadataApiKey: "" },
      digest_abc123: await digestV2CacheValue({
        timestamp: FrozenDate.now(),
        transcript: [{ text: "A source sentence.", start: 0, duration: 5 }],
      }),
    },
  });
  const binding = await bindDigestSession(app);

  const [first, second] = await Promise.all([
    app.send({
      action: "saveNote",
      videoId: "abc123",
      timestamp: 1,
      videoTitle: "Lesson",
      channelName: "Teacher",
    }),
    app.send({
      action: "saveNote",
      videoId: "abc123",
      timestamp: 2,
      videoTitle: "Lesson",
      channelName: "Teacher",
    }),
  ]);
  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.notEqual(first.note.id, second.note.id);

  const thirdPromise = app.send({
    action: "saveNote",
    videoId: "abc123",
    timestamp: 3,
    videoTitle: "Lesson",
    channelName: "Teacher",
  });
  const expectedThirdId = "note_loyw3v28_3_0707070707070707";
  const deletePromise = app.send({
    action: "deleteNote",
    noteId: expectedThirdId,
    ...binding,
  });
  const [third, deleted] = await Promise.all([thirdPromise, deletePromise]);

  assert.equal(third.note.id, expectedThirdId);
  assert.equal(deleted.success, true);
  assert.equal(app.state.ytd_notes.some((note) => note.id === expectedThirdId), false);
  assert.equal(app.getFetchCalls(), 0);
  assert.equal(app.getPendingStorageOperations(), 0);
});

test("save-note keeps the 100-note cap on the cached no-AI path", async () => {
  const existingNotes = Array.from({ length: 100 }, (_, index) => ({
    id: `existing-${index}`,
    videoId: "abc123",
  }));
  const app = loadBackground({
    initialState: {
      ytd_reset_epoch: 0,
      ytd_settings: { aiApiKey: "", supadataApiKey: "" },
      ytd_notes: existingNotes,
      digest_abc123: await digestV2CacheValue({
        transcript: [{ text: "A cached sentence.", start: 0, duration: 5 }],
      }),
    },
  });

  const saved = await app.send({
    action: "saveNote",
    videoId: "abc123",
    timestamp: 1,
    videoTitle: "Lesson",
    channelName: "Teacher",
  });

  assert.equal(saved.success, true);
  assert.equal(app.state.ytd_notes.length, 100);
  assert.equal(app.state.ytd_notes[0].id, saved.note.id);
  assert.equal(
    app.state.ytd_notes.some((note) => note.id === "existing-99"),
    false,
  );
  assert.equal(app.getFetchCalls(), 0);
});

test("full reset completes while note AI is pending and rejects the late note", async () => {
  const aiDispatched = deferred();
  const aiResponse = deferred();
  const app = loadBackground({
    initialState: {
      ytd_reset_epoch: 0,
      ytd_settings: {
        provider: "deepseek",
        aiApiKey: "deepseek-note-fixture",
        aiBaseUrl: "https://api.deepseek.com",
        aiModel: "deepseek-v4-flash",
        supadataApiKey: "",
        autoBasicOverview: false,
      },
      digest_abc123: await digestV2CacheValue({
        transcript: [{ text: "A source sentence.", start: 0, duration: 5 }],
      }),
    },
    fetch: async (url) => {
      if (String(url).startsWith("chrome-extension://")) {
        return {
          ok: true,
          text: async () => [
            "## System prompt",
            "```",
            "Clean {targetText}",
            "```",
            "## User prompt",
            "```",
            "{targetText}",
            "```",
          ].join("\n"),
        };
      }
      aiDispatched.resolve();
      return aiResponse.promise;
    },
  });

  const savePromise = app.send({
    action: "saveNote",
    videoId: "abc123",
    timestamp: 1,
    videoTitle: "Lesson",
    channelName: "Teacher",
  });
  await aiDispatched.promise;

  const resetPromise = app.send({ action: "resetExtensionData" });
  let resetDeadlineId;
  const resetBeforeAi = await Promise.race([
    resetPromise.then((value) => ({ settled: true, value })),
    new Promise((resolve) => {
      resetDeadlineId = setTimeout(
        () => resolve({ settled: false, value: null }),
        50,
      );
    }),
  ]);
  clearTimeout(resetDeadlineId);

  aiResponse.resolve({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: '{"quote":"Clean source."}' } }],
    }),
  });
  const [saved, reset] = await Promise.all([savePromise, resetPromise]);

  assert.equal(resetBeforeAi.settled, true);
  assert.deepEqual(resetBeforeAi.value, reset);
  assert.equal(reset.success, true);
  assert.equal(reset.resetEpoch, 1);
  assert.deepEqual(saved, {
    success: false,
    code: "RESET_DURING_REQUEST",
    error: "RESET_DURING_REQUEST",
  });
  assert.equal(Object.hasOwn(app.state, "ytd_notes"), false);
  assert.equal(
    app.storageWrites.some((items) => Object.hasOwn(items, "ytd_notes")),
    false,
  );
  assert.equal(
    app.broadcasts.some((message) => message.action === "noteSaved"),
    false,
  );
  assert.equal(app.getPendingStorageOperations(), 0);
});

test("delete-all requested after a pending note save deletes that saved note", async () => {
  const aiDispatched = deferred();
  const aiResponse = deferred();
  const app = loadBackground({
    initialState: {
      ytd_reset_epoch: 0,
      ytd_settings: {
        provider: "deepseek",
        aiApiKey: "deepseek-note-order-fixture",
        aiBaseUrl: "https://api.deepseek.com",
        aiModel: "deepseek-v4-flash",
        supadataApiKey: "",
        autoBasicOverview: false,
      },
      digest_abc123: await digestV2CacheValue({
        transcript: [{ text: "A source sentence.", start: 0, duration: 5 }],
      }),
    },
    fetch: async (url) => {
      if (String(url).startsWith("chrome-extension://")) {
        return {
          ok: true,
          text: async () => [
            "## System prompt",
            "```",
            "Clean {targetText}",
            "```",
            "## User prompt",
            "```",
            "{targetText}",
            "```",
          ].join("\n"),
        };
      }
      aiDispatched.resolve();
      return aiResponse.promise;
    },
  });

  const savePromise = app.send({
    action: "saveNote",
    videoId: "abc123",
    timestamp: 1,
    videoTitle: "Lesson",
    channelName: "Teacher",
  });
  await aiDispatched.promise;
  const deleteAllPromise = app.send({ action: "deleteAllNotes" });
  aiResponse.resolve({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: '{"quote":"Clean source."}' } }],
    }),
  });

  const [saved, deleted] = await Promise.all([savePromise, deleteAllPromise]);
  assert.equal(saved.success, true);
  assert.deepEqual(deleted, { success: true, deletedCount: 1 });
  assert.equal(Object.hasOwn(app.state, "ytd_notes"), false);
  await assertSingleResponseCallbacks(app, ["saveNote", "deleteAllNotes"]);
});

test("a note save requested after delete-all remains present", async () => {
  const app = loadBackground({
    initialState: {
      ytd_reset_epoch: 0,
      ytd_settings: { aiApiKey: "", supadataApiKey: "" },
      ytd_notes: [{ id: "old-note", videoId: "abc123" }],
      digest_abc123: await digestV2CacheValue({
        transcript: [{ text: "A cached sentence.", start: 0, duration: 5 }],
      }),
    },
  });

  const deleteAllPromise = app.send({ action: "deleteAllNotes" });
  const savePromise = app.send({
    action: "saveNote",
    videoId: "abc123",
    timestamp: 1,
    videoTitle: "Lesson",
    channelName: "Teacher",
  });
  const [deleted, saved] = await Promise.all([deleteAllPromise, savePromise]);

  assert.deepEqual(deleted, { success: true, deletedCount: 1 });
  assert.equal(saved.success, true);
  assert.deepEqual(
    app.state.ytd_notes.map((note) => note.id),
    [saved.note.id],
  );
  await assertSingleResponseCallbacks(app, ["deleteAllNotes", "saveNote"]);
});

test("delete-note then save-note leaves the later save present", async () => {
  const app = loadBackground({
    initialState: {
      ytd_reset_epoch: 0,
      ytd_settings: { aiApiKey: "", supadataApiKey: "" },
      digest_abc123: await digestV2CacheValue({
        transcript: [{ text: "A source sentence.", start: 0, duration: 5 }],
      }),
    },
  });
  const binding = await bindDigestSession(app);
  const generatedId = "note_00000000-0000-4000-8000-000000000001";
  const [deleted, saved] = await Promise.all([
    app.send({ action: "deleteNote", noteId: generatedId, ...binding }),
    app.send({
      action: "saveNote",
      videoId: "abc123",
      timestamp: 1,
      videoTitle: "Lesson",
      channelName: "Teacher",
    }),
  ]);

  assert.equal(deleted.success, true);
  assert.equal(saved.note.id, generatedId);
  assert.equal(app.state.ytd_notes.some((note) => note.id === generatedId), true);
});

test("a stuck note broadcast cannot block its response or later note requests", async () => {
  const broadcastStarted = deferred();
  const broadcastGate = deferred();
  const app = loadBackground({
    initialState: {
      ytd_reset_epoch: 0,
      ytd_settings: { aiApiKey: "", supadataApiKey: "" },
      digest_abc123: await digestV2CacheValue({
        transcript: [{ text: "A cached sentence.", start: 0, duration: 5 }],
      }),
    },
    runtimeSendMessage(message) {
      broadcastStarted.resolve(message);
      return broadcastGate.promise;
    },
  });
  const binding = await bindDigestSession(app);

  const savePromise = app.send({
    action: "saveNote",
    videoId: "abc123",
    timestamp: 1,
    videoTitle: "Lesson",
    channelName: "Teacher",
  });
  await broadcastStarted.promise;
  const readPromise = app.send({
    action: "getNotes",
    videoId: "abc123",
    ...binding,
  });
  const deletePromise = app.send({
    action: "deleteNote",
    noteId: "note_00000000-0000-4000-8000-000000000001",
    ...binding,
  });
  const requests = Promise.all([savePromise, readPromise, deletePromise]);
  const beforeBroadcastSettles = await settleWithin(requests);
  broadcastGate.resolve({});
  const [saved, readResult, deleted] = await requests;

  assert.equal(beforeBroadcastSettles.kind, "resolved");
  assert.equal(saved.success, true);
  assert.equal(readResult.notes.length, 1);
  assert.equal(deleted.success, true);
  assert.deepEqual(app.state.ytd_notes, []);
  await assertSingleResponseCallbacks(app, [
    "bindVideoSession",
    "saveNote",
    "getNotes",
    "deleteNote",
  ]);
});

test("vocabulary save/delete uses request order and broadcasts only committed writes", async () => {
  const app = loadBackground();
  const card = validVocabularyCard();

  const savePromise = app.send({ action: "saveVocabularyCard", card });
  const deletePromise = app.send({
    action: "deleteVocabularyCard",
    cardId: "vocab_run",
  });
  const [saved, deleted] = await Promise.all([savePromise, deletePromise]);

  assert.equal(saved.success, true);
  assert.equal(deleted.success, true);
  assert.deepEqual(app.state.ytd_vocabulary.entries, []);
  assert.deepEqual(
    app.broadcasts.filter((message) => message.action === "vocabularyChanged").map((message) => message.entryId),
    ["vocab_run", "vocab_run"],
  );
});

test("stuck vocabulary broadcasts cannot block save and delete responses", async () => {
  const broadcastsStarted = deferred();
  const broadcastGate = deferred();
  let broadcastCount = 0;
  const app = loadBackground({
    runtimeSendMessage() {
      broadcastCount += 1;
      if (broadcastCount === 2) broadcastsStarted.resolve();
      return broadcastGate.promise;
    },
  });
  const card = validVocabularyCard();

  const savePromise = app.send({ action: "saveVocabularyCard", card });
  const deletePromise = app.send({
    action: "deleteVocabularyCard",
    cardId: "vocab_run",
  });
  await broadcastsStarted.promise;
  const requests = Promise.all([savePromise, deletePromise]);
  const beforeBroadcastsSettle = await settleWithin(requests);
  broadcastGate.resolve({});
  const [saved, deleted] = await requests;

  assert.equal(beforeBroadcastsSettle.kind, "resolved");
  assert.equal(saved.success, true);
  assert.equal(deleted.success, true);
  assert.deepEqual(app.state.ytd_vocabulary.entries, []);
  await assertSingleResponseCallbacks(app, [
    "saveVocabularyCard",
    "deleteVocabularyCard",
  ]);
});

test("full reset invalidates captured note and vocabulary requests before they can write", async () => {
  const app = loadBackground({
    blockFirstEpochRead: true,
    initialState: {
      ytd_reset_epoch: 0,
      ytd_options_language: "en",
      ytd_settings: { aiApiKey: "", supadataApiKey: "" },
      digest_abc123: await digestV2CacheValue({
        transcript: [{ text: "A source sentence.", start: 0, duration: 5 }],
      }),
    },
  });
  const note = app.send({
    action: "saveNote",
    videoId: "abc123",
    timestamp: 1,
    videoTitle: "Lesson",
    channelName: "Teacher",
  });
  const vocabulary = app.send({
    action: "saveVocabularyCard",
    card: validVocabularyCard(),
  });
  const reset = app.send({ action: "resetExtensionData" });
  app.releaseFirstEpochRead();

  const [noteResult, vocabularyResult, resetResult] = await Promise.all([
    note,
    vocabulary,
    reset,
  ]);
  assert.equal(resetResult.success, true);
  assert.deepEqual(noteResult, { success: false, code: "RESET_DURING_REQUEST", error: "RESET_DURING_REQUEST" });
  assert.deepEqual(vocabularyResult, {
    success: false,
    code: "RESET_DURING_REQUEST",
    error: "RESET_DURING_REQUEST",
  });
  assert.equal(Object.hasOwn(app.state, "ytd_notes"), false);
  assert.equal(Object.hasOwn(app.state, "ytd_vocabulary"), false);
  assert.equal(app.state.ytd_reset_epoch, 1);
});

test("storage failures return bounded codes without leaking storage messages", async () => {
  const app = loadBackground({ failNextSetMessage: "secret-token leaked by storage" });
  const response = await app.send({
    action: "saveProviderSettings",
    provider: "supadata",
    apiKey: "provider-secret",
  });

  assert.deepEqual(response, { success: false, code: "STORAGE_WRITE_FAILED" });
  assert.equal(JSON.stringify(response).includes("secret"), false);
  assert.equal(app.getPendingStorageOperations(), 0);
});

test("panel video actions fail closed without an exact current session", async () => {
  const app = loadBackground({
    initialState: {
      ytd_reset_epoch: 0,
      ytd_settings: {
        aiApiKey: "deepseek-key",
        supadataApiKey: "supadata-key",
      },
      ytd_notes: [{ id: "a-note", videoId: "abc123" }],
    },
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=def456",
    }),
  });

  for (const message of [
    { action: "fetchTranscript", videoId: "def456" },
    { action: "analyzeTranscript", transcriptText: "[0:00] A" },
    { action: "explainSelection", selectedText: "A" },
    {
      action: "translateContent",
      contentType: "transcriptBatch",
      targetLanguage: "zh",
      content: { segments: [] },
    },
    { action: "getNotes", videoId: "def456" },
  ]) {
    const result = await app.send(message);
    assert.equal(result.success, false, message.action);
    assert.equal(result.code, "INVALID_SESSION_TOKEN", message.action);
  }
  assert.equal(app.getFetchCalls(), 0);

  const binding = digestSessionBinding({ videoId: "def456" });
  await bindDigestSession(app, binding);
  const transcript = await app.send({
    action: "fetchTranscript",
    videoId: "abc123",
    ...binding,
  });
  assert.equal(transcript.success, false);
  assert.equal(transcript.code, "SESSION_BINDING_MISMATCH");
  assert.equal(app.getFetchCalls(), 0);

  const wrongVideoNotes = await app.send({
    action: "getNotes",
    videoId: "abc123",
    ...binding,
  });
  assert.equal(wrongVideoNotes.success, false);
  assert.equal(wrongVideoNotes.code, "SESSION_BINDING_MISMATCH");
  const allNotes = await app.send({
    action: "getNotes",
    videoId: null,
    ...binding,
  });
  assert.equal(allNotes.success, true);
  assert.equal(allNotes.notes.length, 1);
});

test("a newer bind during settings I/O prevents the old provider dispatch", async () => {
  const settingsStarted = deferred();
  const settingsGate = deferred();
  let blockSettings = false;
  let currentVideoId = "abc123";
  const app = loadBackground({
    initialState: {
      ytd_reset_epoch: 0,
      ytd_settings: { supadataApiKey: "supadata-key", aiApiKey: "" },
    },
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: `https://www.youtube.com/watch?v=${currentVideoId}`,
    }),
    async storageGetHook(query) {
      if (blockSettings && query === "ytd_settings") {
        settingsStarted.resolve();
        await settingsGate.promise;
      }
    },
  });
  const a = digestSessionBinding({ videoId: "abc123", tabId: 1 });
  await bindDigestSession(app, a);
  blockSettings = true;
  const staleFetch = app.send({
    action: "fetchTranscript",
    videoId: "abc123",
    ...a,
  });
  await settingsStarted.promise;

  currentVideoId = "def456";
  const b = digestSessionBinding({
    videoId: "def456",
    tabId: 1,
    generation: 2,
  });
  await bindDigestSession(app, b);
  settingsGate.resolve();
  const result = await staleFetch;

  assert.equal(result.success, false);
  assert.equal(result.code, "SESSION_STALE");
  assert.equal(app.getFetchCalls(), 0);
});

test("a newer bind during prompt I/O prevents the old DeepSeek dispatch", async () => {
  const promptStarted = deferred();
  const promptGate = deferred();
  let currentVideoId = "abc123";
  const app = loadBackground({
    initialState: {
      ytd_reset_epoch: 0,
      ytd_settings: { aiApiKey: "deepseek-key", supadataApiKey: "" },
    },
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: `https://www.youtube.com/watch?v=${currentVideoId}`,
    }),
    async fetch(url) {
      if (String(url).startsWith("chrome-extension://test/prompts/")) {
        promptStarted.resolve();
        await promptGate.promise;
        return {
          ok: true,
          async text() {
            return [
              "## System prompt",
              "```",
              "Summarize {videoTitle}",
              "```",
              "## User prompt",
              "```",
              "{transcriptText}",
              "```",
            ].join("\n");
          },
        };
      }
      throw new Error("DeepSeek must not be dispatched for stale A");
    },
  });
  const a = digestSessionBinding({ videoId: "abc123", tabId: 1 });
  await bindDigestSession(app, a);
  const staleAnalysis = app.send({
    action: "analyzeTranscript",
    transcriptText: "[0:00] A sentence",
    videoTitle: "A",
    channelName: "Channel",
    videoDescription: "",
    videoDuration: 10,
    ...a,
  });
  await promptStarted.promise;

  currentVideoId = "def456";
  await bindDigestSession(
    app,
    digestSessionBinding({ videoId: "def456", tabId: 1, generation: 2 }),
  );
  promptGate.resolve();
  const result = await staleAnalysis;

  assert.equal(result.success, false);
  assert.equal(result.code, "SESSION_STALE");
  assert.equal(
    app.getFetchUrls().some((url) => url.includes("api.deepseek.com")),
    false,
  );
});

test("a reset already waiting on storage blocks a panel transcript provider dispatch", async () => {
  const settingsStarted = deferred();
  const settingsGate = deferred();
  const resetReadStarted = deferred();
  const resetReadGate = deferred();
  let blockSettings = false;
  let blockResetRead = false;
  const app = loadBackground({
    initialState: {
      ytd_reset_epoch: 0,
      ytd_settings: { supadataApiKey: "supadata-key", aiApiKey: "" },
    },
    async storageGetHook(query) {
      if (blockSettings && query === "ytd_settings") {
        blockSettings = false;
        settingsStarted.resolve();
        await settingsGate.promise;
      }
      if (blockResetRead && query === null) {
        blockResetRead = false;
        resetReadStarted.resolve();
        await resetReadGate.promise;
      }
    },
    async fetch(url) {
      assert.match(String(url), /api\.supadata\.ai/);
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            content: [{ text: "A sentence.", offset: 0, duration: 5000 }],
            lang: "en",
          };
        },
      };
    },
  });
  const binding = digestSessionBinding();
  await bindDigestSession(app, binding);
  blockSettings = true;
  const transcript = app.send({
    action: "fetchTranscript",
    videoId: "abc123",
    ...binding,
  });
  await settingsStarted.promise;

  blockResetRead = true;
  const reset = app.send({ action: "resetExtensionData" });
  await resetReadStarted.promise;
  settingsGate.resolve();
  const transcriptResult = await transcript;
  resetReadGate.resolve();
  const resetResult = await reset;

  assert.equal(transcriptResult.success, false);
  assert.equal(transcriptResult.code, "RESET_DURING_REQUEST");
  assert.equal(resetResult.success, true);
  assert.equal(
    app.getFetchUrls().filter((url) => url.includes("api.supadata.ai")).length,
    0,
  );
});

test("a reset already waiting on storage blocks a panel DeepSeek dispatch after prompt I/O", async () => {
  const promptStarted = deferred();
  const promptGate = deferred();
  const resetReadStarted = deferred();
  const resetReadGate = deferred();
  let blockResetRead = false;
  const app = loadBackground({
    initialState: {
      ytd_reset_epoch: 0,
      ytd_settings: { aiApiKey: "deepseek-key", supadataApiKey: "" },
    },
    async storageGetHook(query) {
      if (blockResetRead && query === null) {
        blockResetRead = false;
        resetReadStarted.resolve();
        await resetReadGate.promise;
      }
    },
    async fetch(url) {
      if (String(url).startsWith("chrome-extension://test/prompts/")) {
        promptStarted.resolve();
        await promptGate.promise;
        return {
          ok: true,
          async text() {
            return [
              "## System prompt",
              "```",
              "Summarize {videoTitle}",
              "```",
              "## User prompt",
              "```",
              "{transcriptText}",
              "```",
            ].join("\n");
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { choices: [{ message: { content: "{}" } }] };
        },
      };
    },
  });
  const binding = digestSessionBinding();
  await bindDigestSession(app, binding);
  const analysis = app.send({
    action: "analyzeTranscript",
    transcriptText: "[0:00] A sentence",
    videoTitle: "A",
    channelName: "Channel",
    videoDescription: "",
    videoDuration: 10,
    ...binding,
  });
  await promptStarted.promise;

  blockResetRead = true;
  const reset = app.send({ action: "resetExtensionData" });
  await resetReadStarted.promise;
  promptGate.resolve();
  const analysisResult = await analysis;
  resetReadGate.resolve();
  const resetResult = await reset;

  assert.equal(analysisResult.success, false);
  assert.equal(analysisResult.code, "RESET_DURING_REQUEST");
  assert.equal(resetResult.success, true);
  assert.equal(
    app.getFetchUrls().filter((url) => url.includes("api.deepseek.com")).length,
    0,
  );
});

test("a reset already waiting on storage blocks a content note provider dispatch", async () => {
  const settingsStarted = deferred();
  const settingsGate = deferred();
  const resetReadStarted = deferred();
  const resetReadGate = deferred();
  let blockSettings = true;
  let blockResetRead = false;
  const app = loadBackground({
    initialState: {
      ytd_reset_epoch: 0,
      ytd_settings: { aiApiKey: "", supadataApiKey: "supadata-key" },
    },
    async storageGetHook(query) {
      if (blockSettings && query === "ytd_settings") {
        blockSettings = false;
        settingsStarted.resolve();
        await settingsGate.promise;
      }
      if (blockResetRead && query === null) {
        blockResetRead = false;
        resetReadStarted.resolve();
        await resetReadGate.promise;
      }
    },
    async fetch(url) {
      assert.match(String(url), /api\.supadata\.ai/);
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            content: [{ text: "A sentence.", offset: 0, duration: 5000 }],
            lang: "en",
          };
        },
      };
    },
  });
  const note = app.send({
    action: "saveNote",
    videoId: "abc123",
    timestamp: 1,
    videoTitle: "A",
    channelName: "Channel",
  });
  await settingsStarted.promise;

  blockResetRead = true;
  const reset = app.send({ action: "resetExtensionData" });
  await resetReadStarted.promise;
  settingsGate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const providerCallsDuringReset = app
    .getFetchUrls()
    .filter((url) => url.includes("api.supadata.ai")).length;
  resetReadGate.resolve();
  const noteResult = await note;
  const resetResult = await reset;

  assert.equal(noteResult.success, false);
  assert.equal(noteResult.code, "RESET_DURING_REQUEST");
  assert.equal(resetResult.success, true);
  assert.equal(providerCallsDuringReset, 0);
});

test("a failed reset leaves the old session unknown and permits an explicit rebind", async () => {
  const app = loadBackground({
    failNextSetMessage: "reset epoch write failed",
  });
  const binding = digestSessionBinding();
  await bindDigestSession(app, binding);

  const reset = await app.send({ action: "resetExtensionData" });
  const staleRelay = await app.send({
    action: "relayToContent",
    payload: { action: "getCurrentTime" },
    ...binding,
  });
  const rebound = await app.send({
    action: "bindVideoSession",
    sessionToken: binding.sessionToken,
  });
  const recoveredRelay = await app.send({
    action: "relayToContent",
    payload: { action: "getCurrentTime" },
    ...binding,
  });

  assert.equal(reset.success, false);
  assert.equal(staleRelay.success, false);
  assert.equal(staleRelay.code, "SESSION_UNKNOWN");
  assert.equal(rebound.success, true);
  assert.equal(recoveredRelay.success, true);
});

test("a queued delete cannot adopt a failed reset revision after rebind", async () => {
  const promptStarted = deferred();
  const promptGate = deferred();
  const app = loadBackground({
    failNextSetMessage: "reset epoch write failed",
    initialState: {
      ytd_reset_epoch: 0,
      ytd_settings: { aiApiKey: "deepseek-key", supadataApiKey: "" },
      digest_abc123: await digestV2CacheValue({
        transcript: [{ text: "A source sentence.", start: 0, duration: 5 }],
      }),
      ytd_notes: [{ id: "keep-note", videoId: "abc123" }],
    },
    async fetch(url) {
      if (String(url).startsWith("chrome-extension://test/prompts/")) {
        promptStarted.resolve();
        await promptGate.promise;
        return {
          ok: true,
          async text() {
            return [
              "## System prompt",
              "```",
              "Clean {targetText}",
              "```",
              "## User prompt",
              "```",
              "{targetText}",
              "```",
            ].join("\n");
          },
        };
      }
      throw new Error("An old note request must not reach DeepSeek");
    },
  });
  const binding = digestSessionBinding();
  await bindDigestSession(app, binding);
  const save = app.send({
    action: "saveNote",
    videoId: "abc123",
    timestamp: 1,
    videoTitle: "A",
    channelName: "Channel",
    ...binding,
  });
  await promptStarted.promise;
  const epochReadsBeforeDelete = app.getEpochReadCount();
  const tabReadsBeforeDelete = app.getTabGetCount();
  const deletion = app.send({
    action: "deleteNote",
    noteId: "keep-note",
    ...binding,
  });
  await waitUntil(
    () =>
      app.getEpochReadCount() >= epochReadsBeforeDelete + 2 &&
      app.getTabGetCount() >= tabReadsBeforeDelete + 1,
  );

  const reset = await app.send({ action: "resetExtensionData" });
  const rebound = await app.send({
    action: "bindVideoSession",
    sessionToken: binding.sessionToken,
  });
  promptGate.resolve();
  const [saveResult, deleteResult] = await Promise.all([save, deletion]);

  assert.equal(reset.success, false);
  assert.equal(rebound.success, true);
  assert.equal(saveResult.success, false);
  assert.equal(deleteResult.success, false);
  assert.equal(deleteResult.code, "SESSION_STALE");
  assert.deepEqual(app.state.ytd_notes, [
    { id: "keep-note", videoId: "abc123" },
  ]);
  assert.equal(
    app.getFetchUrls().some((url) => url.includes("api.deepseek.com")),
    false,
  );
});

test("overlapping resets keep binds closed until every reset finishes", async () => {
  const secondResetStarted = deferred();
  const secondResetGate = deferred();
  let resetReadCount = 0;
  const app = loadBackground({
    failNextSetMessage: "first reset epoch write failed",
    async storageGetHook(query) {
      if (query !== null) return;
      resetReadCount += 1;
      if (resetReadCount === 3) {
        secondResetStarted.resolve();
        await secondResetGate.promise;
      }
    },
  });
  const binding = digestSessionBinding();
  await bindDigestSession(app, binding);

  const firstReset = app.send({ action: "resetExtensionData" });
  const secondReset = app.send({ action: "resetExtensionData" });
  await secondResetStarted.promise;
  const firstResult = await firstReset;
  const bindDuringSecond = await app.send({
    action: "bindVideoSession",
    sessionToken: binding.sessionToken,
  });
  secondResetGate.resolve();
  const secondResult = await secondReset;

  assert.equal(firstResult.success, false);
  assert.equal(bindDuringSecond.success, false);
  assert.equal(bindDuringSecond.code, "RESET_DURING_REQUEST");
  assert.equal(secondResult.success, true);
});

test("binds are concurrent across windows and arrival-ordered within a window", async () => {
  const slowTab = deferred();
  const app = loadBackground({
    tabsGet: async (tabId) => {
      if (tabId === 1) await slowTab.promise;
      return {
        id: tabId,
        windowId: tabId === 3 ? 8 : 7,
        active: true,
        url: `https://www.youtube.com/watch?v=${tabId === 1 ? "abc123" : "def456"}`,
      };
    },
  });
  const slowA = digestSessionBinding({ videoId: "abc123", tabId: 1, windowId: 7 });
  const newerB = digestSessionBinding({
    videoId: "def456",
    tabId: 2,
    windowId: 7,
    generation: 2,
  });
  const otherWindow = digestSessionBinding({ videoId: "def456", tabId: 3, windowId: 8 });

  const slowResult = app.send({ action: "bindVideoSession", sessionToken: slowA.sessionToken });
  await new Promise((resolve) => setImmediate(resolve));
  const [newerOutcome, otherOutcome] = await Promise.all([
    settleWithin(app.send(
      { action: "bindVideoSession", sessionToken: newerB.sessionToken },
      {
        documentId: "panel-document-tab-2",
        url: "chrome-extension://test/sidepanel.html",
      },
    )),
    settleWithin(app.send({ action: "bindVideoSession", sessionToken: otherWindow.sessionToken })),
  ]);
  assert.equal(newerOutcome.kind, "resolved");
  assert.equal(newerOutcome.value.success, true);
  assert.equal(otherOutcome.kind, "resolved");
  assert.equal(otherOutcome.value.success, true);

  slowTab.resolve();
  const stale = await slowResult;
  assert.equal(stale.success, false);
  assert.equal(stale.code, "SESSION_STALE");
});

test("same panel document rejects delayed lower and conflicting generations", async () => {
  const app = loadBackground();
  const a2 = digestSessionBinding({
    generation: 2,
    sessionId: "panel-a-generation-2",
  });
  const delayedA1 = digestSessionBinding({
    generation: 1,
    sessionId: "panel-a-generation-1",
  });
  const conflictingA2 = digestSessionBinding({
    generation: 2,
    sessionId: "panel-a-conflicting-generation-2",
  });
  await bindDigestSession(app, a2);

  const lower = await app.send({
    action: "bindVideoSession",
    sessionToken: delayedA1.sessionToken,
  });
  const conflicting = await app.send({
    action: "bindVideoSession",
    sessionToken: conflictingA2.sessionToken,
  });
  const exactRebind = await app.send({
    action: "bindVideoSession",
    sessionToken: a2.sessionToken,
  });
  assert.equal(lower.success, false);
  assert.equal(lower.code, "SESSION_STALE");
  assert.deepEqual(lower.sessionToken, delayedA1.sessionToken);
  assert.equal(conflicting.success, false);
  assert.equal(conflicting.code, "SESSION_STALE");
  assert.equal(exactRebind.success, true);

  const currentRelay = await app.send({
    action: "relayToContent",
    payload: { action: "getCurrentTime" },
    ...a2,
  });
  const oldRelay = await app.send({
    action: "relayToContent",
    payload: { action: "getCurrentTime" },
    ...delayedA1,
  });
  assert.equal(currentRelay.success, true);
  assert.equal(oldRelay.success, false);
  assert.equal(oldRelay.code, "SESSION_STALE");
});

test("bind requires a stable side-panel document identity", async () => {
  const binding = digestSessionBinding();
  const app = loadBackground();
  const response = await app.send(
    { action: "bindVideoSession", sessionToken: binding.sessionToken },
    { url: "chrome-extension://test/sidepanel.html" },
  );
  assert.equal(response.success, false);
  assert.equal(response.code, "INVALID_PANEL_DOCUMENT");
  assert.deepEqual(response.sessionToken, binding.sessionToken);
  const wrongPage = await app.send(
    { action: "bindVideoSession", sessionToken: binding.sessionToken },
    {
      documentId: "panel-document-1",
      url: "chrome-extension://test/options.html",
    },
  );
  assert.equal(wrongPage.success, false);
  assert.equal(wrongPage.code, "INVALID_PANEL_DOCUMENT");
  assert.deepEqual(wrongPage.sessionToken, binding.sessionToken);
});

test("a new panel document may restart its generation counter", async () => {
  const app = loadBackground();
  const oldDocument = digestSessionBinding({
    generation: 2,
    sessionId: "old-document-generation-2",
  });
  await bindDigestSession(app, oldDocument);
  const newDocument = digestSessionBinding({
    generation: 1,
    sessionId: "new-document-generation-1",
  });
  const rebound = await app.send(
    {
      action: "bindVideoSession",
      sessionToken: newDocument.sessionToken,
    },
    {
      documentId: "panel-document-2",
      url: "chrome-extension://test/sidepanel.html",
    },
  );
  assert.equal(rebound.success, true);
  const relay = await app.send({
    action: "relayToContent",
    payload: { action: "getCurrentTime" },
    ...newDocument,
  });
  const retiredDocument = digestSessionBinding({
    generation: 3,
    sessionId: "old-document-generation-3",
  });
  const retired = await app.send({
    action: "bindVideoSession",
    sessionToken: retiredDocument.sessionToken,
  });
  assert.equal(relay.success, true);
  assert.equal(retired.success, false);
  assert.equal(retired.code, "SESSION_STALE");
});

test("a tab-specific side panel document may rebind after switching away and back", async () => {
  let activeTabId = 1;
  const app = loadBackground({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: tabId === activeTabId,
      url: `https://www.youtube.com/watch?v=${tabId === 1 ? "abc123" : "def456"}`,
    }),
  });
  const tabA1 = digestSessionBinding({
    videoId: "abc123",
    tabId: 1,
    generation: 1,
    sessionId: "tab-a-generation-1",
  });
  await bindDigestSession(app, tabA1);

  activeTabId = 2;
  await app.tabActivatedListeners[0]({ tabId: 2, windowId: 7 });
  const tabB = digestSessionBinding({
    videoId: "def456",
    tabId: 2,
    generation: 1,
    sessionId: "tab-b-generation-1",
  });
  const boundB = await app.send(
    { action: "bindVideoSession", sessionToken: tabB.sessionToken },
    {
      documentId: "panel-document-tab-b",
      url: "chrome-extension://test/sidepanel.html",
    },
  );
  assert.equal(boundB.success, true);

  activeTabId = 1;
  await app.tabActivatedListeners[0]({ tabId: 1, windowId: 7 });
  const tabA2 = digestSessionBinding({
    videoId: "abc123",
    tabId: 1,
    generation: 2,
    sessionId: "tab-a-generation-2",
  });
  const reboundA = await app.send(
    { action: "bindVideoSession", sessionToken: tabA2.sessionToken },
    {
      documentId: "panel-document-1",
      url: "chrome-extension://test/sidepanel.html",
    },
  );
  const relayA = await app.send({
    action: "relayToContent",
    payload: { action: "getCurrentTime" },
    ...tabA2,
  });

  assert.equal(reboundA.success, true);
  assert.equal(relayA.success, true);
});

test("a side panel document cannot bind a different tab in the same window", async () => {
  let activeTabId = 1;
  const app = loadBackground({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: tabId === activeTabId,
      url: `https://www.youtube.com/watch?v=${tabId === 1 ? "abc123" : "def456"}`,
    }),
  });
  const tabA = digestSessionBinding({
    videoId: "abc123",
    tabId: 1,
    generation: 1,
    sessionId: "shared-document-tab-a",
  });
  await bindDigestSession(app, tabA);
  activeTabId = 2;
  await app.tabActivatedListeners[0]({ tabId: 2, windowId: 7 });
  const tabB = digestSessionBinding({
    videoId: "def456",
    tabId: 2,
    generation: 2,
    sessionId: "shared-document-tab-b",
  });

  const crossed = await app.send({
    action: "bindVideoSession",
    sessionToken: tabB.sessionToken,
  });

  assert.equal(crossed.success, false);
  assert.equal(crossed.code, "SESSION_STALE");
});

test("a failed same-tab document candidate does not retire the current document", async () => {
  let tabActive = true;
  const app = loadBackground({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: tabActive,
      url: "https://www.youtube.com/watch?v=abc123",
    }),
  });
  const current = digestSessionBinding({
    generation: 1,
    sessionId: "current-document-generation-1",
  });
  await bindDigestSession(app, current);
  const failedCandidate = digestSessionBinding({
    generation: 1,
    sessionId: "failed-document-generation-1",
  });
  tabActive = false;
  const failed = await app.send(
    {
      action: "bindVideoSession",
      sessionToken: failedCandidate.sessionToken,
    },
    {
      documentId: "panel-document-failed-candidate",
      url: "chrome-extension://test/sidepanel.html",
    },
  );
  tabActive = true;
  const recovered = digestSessionBinding({
    generation: 2,
    sessionId: "current-document-generation-2",
  });
  const rebound = await app.send({
    action: "bindVideoSession",
    sessionToken: recovered.sessionToken,
  });
  const relay = await app.send({
    action: "relayToContent",
    payload: { action: "getCurrentTime" },
    ...recovered,
  });

  assert.equal(failed.success, false);
  assert.equal(failed.code, "TAB_NOT_ACTIVE");
  assert.equal(rebound.success, true);
  assert.equal(relay.success, true);
});

test("a failed document candidate cannot reuse its identity on another tab", async () => {
  let activeTabId = 1;
  const app = loadBackground({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: tabId === activeTabId,
      url: `https://www.youtube.com/watch?v=${tabId === 1 ? "abc123" : "def456"}`,
    }),
  });
  await bindDigestSession(app, digestSessionBinding());
  const failedDocument = {
    documentId: "panel-document-failed-cross-tab",
    url: "chrome-extension://test/sidepanel.html",
  };
  const failedOnA = digestSessionBinding({
    videoId: "abc123",
    tabId: 1,
    generation: 1,
    sessionId: "failed-cross-tab-a",
  });
  activeTabId = 2;
  const failed = await app.send(
    { action: "bindVideoSession", sessionToken: failedOnA.sessionToken },
    failedDocument,
  );
  const crossedToB = digestSessionBinding({
    videoId: "def456",
    tabId: 2,
    generation: 2,
    sessionId: "failed-cross-tab-b",
  });
  const crossed = await app.send(
    { action: "bindVideoSession", sessionToken: crossedToB.sessionToken },
    failedDocument,
  );

  assert.equal(failed.success, false);
  assert.equal(failed.code, "TAB_NOT_ACTIVE");
  assert.equal(crossed.success, false);
  assert.equal(crossed.code, "SESSION_STALE");
});

test("an inactive tab document candidate cannot clear the active session", async () => {
  const app = loadBackground({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: tabId === 1,
      url: `https://www.youtube.com/watch?v=${tabId === 1 ? "abc123" : "def456"}`,
    }),
  });
  const active = digestSessionBinding({ videoId: "abc123", tabId: 1 });
  await bindDigestSession(app, active);
  const inactive = digestSessionBinding({
    videoId: "def456",
    tabId: 2,
    generation: 1,
    sessionId: "inactive-tab-document",
  });

  const rejected = await app.send(
    { action: "bindVideoSession", sessionToken: inactive.sessionToken },
    {
      documentId: "panel-document-inactive-tab",
      url: "chrome-extension://test/sidepanel.html",
    },
  );
  const activeRelay = await app.send({
    action: "relayToContent",
    payload: { action: "getCurrentTime" },
    ...active,
  });

  assert.equal(rejected.success, false);
  assert.equal(rejected.code, "TAB_NOT_ACTIVE");
  assert.equal(activeRelay.success, true);
});

test("an inactive old-tab bind cannot cancel a pending active-tab bind", async () => {
  const activeBindStarted = deferred();
  const activeBindGate = deferred();
  let activeTabId = 1;
  let blockActiveBind = false;
  const app = loadBackground({
    tabsGet: async (tabId) => {
      if (blockActiveBind && tabId === 2) {
        blockActiveBind = false;
        activeBindStarted.resolve();
        await activeBindGate.promise;
      }
      return {
        id: tabId,
        windowId: 7,
        active: tabId === activeTabId,
        url: `https://www.youtube.com/watch?v=${tabId === 1 ? "abc123" : "def456"}`,
      };
    },
  });
  const tabA1 = digestSessionBinding({
    videoId: "abc123",
    tabId: 1,
    generation: 1,
    sessionId: "active-race-tab-a-1",
  });
  await bindDigestSession(app, tabA1);
  activeTabId = 2;
  await app.tabActivatedListeners[0]({ tabId: 2, windowId: 7 });
  const tabB = digestSessionBinding({
    videoId: "def456",
    tabId: 2,
    generation: 1,
    sessionId: "active-race-tab-b-1",
  });
  blockActiveBind = true;
  const pendingB = app.send(
    { action: "bindVideoSession", sessionToken: tabB.sessionToken },
    {
      documentId: "panel-document-active-race-b",
      url: "chrome-extension://test/sidepanel.html",
    },
  );
  await activeBindStarted.promise;

  const lateA = digestSessionBinding({
    videoId: "abc123",
    tabId: 1,
    generation: 2,
    sessionId: "active-race-tab-a-2",
  });
  const rejectedA = await app.send({
    action: "bindVideoSession",
    sessionToken: lateA.sessionToken,
  });
  activeBindGate.resolve();
  const boundB = await pendingB;
  const relayB = await app.send({
    action: "relayToContent",
    payload: { action: "getCurrentTime" },
    ...tabB,
  });

  assert.equal(rejectedA.success, false);
  assert.equal(rejectedA.code, "TAB_NOT_ACTIVE");
  assert.equal(boundB.success, true);
  assert.equal(relayB.success, true);
});

test("a pending replacement blocks the old token but a failed candidate permits recovery", async () => {
  const candidateStarted = deferred();
  const candidateGate = deferred();
  let blockCandidate = false;
  let tabActive = true;
  const app = loadBackground({
    async storageGetHook(query) {
      if (blockCandidate && query === "ytd_reset_epoch") {
        blockCandidate = false;
        candidateStarted.resolve();
        await candidateGate.promise;
      }
    },
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: tabActive,
      url: "https://www.youtube.com/watch?v=abc123",
    }),
  });
  const current = digestSessionBinding({
    generation: 1,
    sessionId: "committed-document",
  });
  await bindDigestSession(app, current);
  const candidate = digestSessionBinding({
    generation: 1,
    sessionId: "pending-replacement-document",
  });
  blockCandidate = true;
  const pending = app.send(
    { action: "bindVideoSession", sessionToken: candidate.sessionToken },
    {
      documentId: "panel-document-pending-replacement",
      url: "chrome-extension://test/sidepanel.html",
    },
  );
  await candidateStarted.promise;

  const currentRelay = await app.send({
    action: "relayToContent",
    payload: { action: "getCurrentTime" },
    ...current,
  });
  tabActive = false;
  candidateGate.resolve();
  const replacement = await pending;
  tabActive = true;
  const recovered = digestSessionBinding({
    generation: 2,
    sessionId: "committed-document-recovered",
  });
  const rebound = await app.send({
    action: "bindVideoSession",
    sessionToken: recovered.sessionToken,
  });
  const recoveredRelay = await app.send({
    action: "relayToContent",
    payload: { action: "getCurrentTime" },
    ...recovered,
  });

  assert.equal(currentRelay.success, false);
  assert.equal(currentRelay.code, "SESSION_STALE");
  assert.equal(replacement.success, false);
  assert.equal(replacement.code, "TAB_NOT_ACTIVE");
  assert.equal(rebound.success, true);
  assert.equal(recoveredRelay.success, true);
});

test("a different document cannot claim an identical active token", async () => {
  const app = loadBackground();
  const current = digestSessionBinding({
    generation: 1,
    sessionId: "identical-token-document",
  });
  await bindDigestSession(app, current);
  const replacement = await app.send(
    { action: "bindVideoSession", sessionToken: current.sessionToken },
    {
      documentId: "panel-document-identical-token-replacement",
      url: "chrome-extension://test/sidepanel.html",
    },
  );
  const currentRelay = await app.send({
    action: "relayToContent",
    payload: { action: "getCurrentTime" },
    ...current,
  });

  assert.equal(replacement.success, false);
  assert.equal(replacement.code, "SESSION_STALE");
  assert.equal(currentRelay.success, true);
});

test("a superseded document candidate cannot revive after the newer replacement commits", async () => {
  const olderStarted = deferred();
  const olderGate = deferred();
  let blockOlder = false;
  const app = loadBackground({
    async storageGetHook(query) {
      if (blockOlder && query === "ytd_reset_epoch") {
        blockOlder = false;
        olderStarted.resolve();
        await olderGate.promise;
      }
    },
  });
  const current = digestSessionBinding({
    generation: 1,
    sessionId: "superseded-current-a",
  });
  await bindDigestSession(app, current);
  const older = digestSessionBinding({
    generation: 1,
    sessionId: "superseded-candidate-b",
  });
  blockOlder = true;
  const pendingOlder = app.send(
    { action: "bindVideoSession", sessionToken: older.sessionToken },
    {
      documentId: "panel-document-superseded-b",
      url: "chrome-extension://test/sidepanel.html",
    },
  );
  await olderStarted.promise;
  const newer = digestSessionBinding({
    generation: 1,
    sessionId: "superseded-candidate-c",
  });
  const committedNewer = await app.send(
    { action: "bindVideoSession", sessionToken: newer.sessionToken },
    {
      documentId: "panel-document-superseded-c",
      url: "chrome-extension://test/sidepanel.html",
    },
  );
  olderGate.resolve();
  const staleOlder = await pendingOlder;
  const revivedOlder = await app.send(
    { action: "bindVideoSession", sessionToken: older.sessionToken },
    {
      documentId: "panel-document-superseded-b",
      url: "chrome-extension://test/sidepanel.html",
    },
  );
  const newerRelay = await app.send({
    action: "relayToContent",
    payload: { action: "getCurrentTime" },
    ...newer,
  });

  assert.equal(committedNewer.success, true);
  assert.equal(staleOlder.success, false);
  assert.equal(revivedOlder.success, false);
  assert.equal(revivedOlder.code, "SESSION_STALE");
  assert.equal(newerRelay.success, true);
});

test("document ownership fails closed when its bounded tombstone registry is full", async () => {
  const app = loadBackground();
  let latest;
  for (let index = 0; index < 32; index += 1) {
    const binding = digestSessionBinding({
      generation: 1,
      sessionId: `bounded-document-${index}`,
    });
    const result = await app.send(
      { action: "bindVideoSession", sessionToken: binding.sessionToken },
      {
        documentId: `panel-document-bounded-${index}`,
        url: "chrome-extension://test/sidepanel.html",
      },
    );
    assert.equal(result.success, true, `document ${index}`);
    latest = binding;
  }
  const overflow = digestSessionBinding({
    generation: 1,
    sessionId: "bounded-document-overflow",
  });
  const overflowResult = await app.send(
    { action: "bindVideoSession", sessionToken: overflow.sessionToken },
    {
      documentId: "panel-document-bounded-overflow",
      url: "chrome-extension://test/sidepanel.html",
    },
  );
  const retired = digestSessionBinding({
    generation: 2,
    sessionId: "bounded-document-retired-retry",
  });
  const retiredResult = await app.send(
    { action: "bindVideoSession", sessionToken: retired.sessionToken },
    {
      documentId: "panel-document-bounded-0",
      url: "chrome-extension://test/sidepanel.html",
    },
  );
  const latestRelay = await app.send({
    action: "relayToContent",
    payload: { action: "getCurrentTime" },
    ...latest,
  });

  assert.equal(overflowResult.success, false);
  assert.equal(overflowResult.code, "SESSION_STALE");
  assert.equal(retiredResult.success, false);
  assert.equal(retiredResult.code, "SESSION_STALE");
  assert.equal(latestRelay.success, true);
});

test("a newly arrived panel document rejects the old document while bind waits", async () => {
  const candidateStarted = deferred();
  const candidateGate = deferred();
  let blockNextEpoch = false;
  const app = loadBackground({
    async storageGetHook(query) {
      if (blockNextEpoch && query === "ytd_reset_epoch") {
        blockNextEpoch = false;
        candidateStarted.resolve();
        await candidateGate.promise;
      }
    },
  });
  const a = digestSessionBinding({
    generation: 1,
    sessionId: "document-a-generation-1",
  });
  await bindDigestSession(app, a);
  const b = digestSessionBinding({
    generation: 1,
    sessionId: "document-b-generation-1",
  });
  blockNextEpoch = true;
  const pendingB = app.send(
    { action: "bindVideoSession", sessionToken: b.sessionToken },
    {
      documentId: "panel-document-2",
      url: "chrome-extension://test/sidepanel.html",
    },
  );
  await candidateStarted.promise;

  const lateA = await app.send({
    action: "bindVideoSession",
    sessionToken: a.sessionToken,
  });
  candidateGate.resolve();
  const boundB = await pendingB;

  assert.equal(lateA.success, false);
  assert.equal(lateA.code, "SESSION_STALE");
  assert.deepEqual(lateA.sessionToken, a.sessionToken);
  assert.equal(boundB.success, true);
});

test("a delayed A1 rebind cannot revive its queued digest after A2", async () => {
  const mutationStarted = deferred();
  const mutationGate = deferred();
  let blockDigestRead = false;
  const app = loadBackground({
    initialState: {
      ytd_reset_epoch: 0,
      ytd_settings: { aiApiKey: "", supadataApiKey: "" },
      digest_abc123: { timestamp: 1, transcript: [] },
    },
    async storageGetHook(query) {
      if (blockDigestRead && query === null) {
        blockDigestRead = false;
        mutationStarted.resolve();
        await mutationGate.promise;
      }
    },
  });
  const a1 = digestSessionBinding({
    generation: 1,
    sessionId: "queued-a-generation-1",
  });
  const a2 = digestSessionBinding({
    generation: 2,
    sessionId: "current-a-generation-2",
  });
  await bindDigestSession(app, a1);
  const value = await digestBaseValue({
    transcript: [{ text: "late A1", start: 0, duration: 1 }],
  });
  blockDigestRead = true;
  const pendingPersist = app.send({
    action: "persistDigestBase",
    expectedEpoch: 0,
    videoId: "abc123",
    value,
    ...a1,
  });
  await mutationStarted.promise;
  await bindDigestSession(app, a2);
  const delayedRebind = await app.send({
    action: "bindVideoSession",
    sessionToken: a1.sessionToken,
  });
  const currentRelay = await app.send({
    action: "relayToContent",
    payload: { action: "getCurrentTime" },
    ...a2,
  });
  mutationGate.resolve();
  const persisted = await pendingPersist;

  assert.equal(delayedRebind.success, false);
  assert.equal(delayedRebind.code, "SESSION_STALE");
  assert.equal(currentRelay.success, true);
  assert.equal(persisted.success, false);
  assert.equal(persisted.code, "SESSION_STALE");
  assert.equal(app.state.digest_abc123.timestamp, 1);
});

test("a restarted worker requires one bind and later relays avoid epoch reads", async () => {
  const app = loadBackground();
  const binding = digestSessionBinding({ videoId: "abc123", tabId: 1 });
  const relay = () => app.send({
    action: "relayToContent",
    payload: { action: "getCurrentTime" },
    ...binding,
  });

  const unknown = await relay();
  assert.equal(unknown.success, false);
  assert.equal(unknown.code, "SESSION_UNKNOWN");
  assert.equal(app.getEpochReadCount(), 0);

  await bindDigestSession(app, binding);
  assert.equal(app.getEpochReadCount(), 1);
  assert.equal((await relay()).success, true);
  assert.equal((await relay()).success, true);
  assert.equal(app.getEpochReadCount(), 1);
});

test("tab lifecycle invalidates only the bound video identity", async () => {
  let tabState = {
    id: 1,
    windowId: 7,
    active: true,
    url: "https://www.youtube.com/watch?v=abc123",
  };
  const app = loadBackground({ tabsGet: async () => tabState });
  const binding = digestSessionBinding({ videoId: "abc123", tabId: 1 });
  await bindDigestSession(app, binding);

  app.tabUpdatedListeners[0](
    99,
    { url: "https://www.youtube.com/watch?v=def456" },
    { id: 99, windowId: 7, active: false },
  );
  assert.equal(
    (await app.send({
      action: "relayToContent",
      payload: { action: "getCurrentTime" },
      ...binding,
    })).success,
    true,
  );

  tabState = {
    ...tabState,
    pendingUrl: "https://www.youtube.com/watch?v=def456",
  };
  app.tabUpdatedListeners[0](
    1,
    { url: "https://www.youtube.com/watch?v=abc123" },
    tabState,
  );
  const invalidated = await app.send({
    action: "relayToContent",
    payload: { action: "getCurrentTime" },
    ...binding,
  });
  assert.equal(invalidated.success, false);
  assert.equal(invalidated.code, "SESSION_UNKNOWN");
});

test("activation, removal, window close, and reset events fail closed", async () => {
  const app = loadBackground({
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=abc123",
    }),
  });
  const binding = digestSessionBinding({ videoId: "abc123", tabId: 1 });
  const relay = () => app.send({
    action: "relayToContent",
    payload: { action: "getCurrentTime" },
    ...binding,
  });

  await bindDigestSession(app, binding);
  await app.tabActivatedListeners[0]({ tabId: 1, windowId: 7 });
  assert.equal((await relay()).success, true);
  await app.tabActivatedListeners[0]({ tabId: 2, windowId: 7 });
  assert.equal((await relay()).code, "SESSION_UNKNOWN");

  await bindDigestSession(app, binding);
  app.tabRemovedListeners[0](1, { windowId: 7 });
  assert.equal((await relay()).code, "SESSION_UNKNOWN");

  await bindDigestSession(app, binding);
  app.windowRemovedListeners[0](7);
  assert.equal((await relay()).code, "SESSION_UNKNOWN");

  await bindDigestSession(app, binding);
  app.storageChangedListeners[0](
    { ytd_reset_epoch: { oldValue: 0, newValue: 1 } },
    "local",
  );
  assert.equal((await relay()).code, "SESSION_UNKNOWN");
});

test("A-B-A cannot revive delayed panel cache, save, or delete mutations", async (t) => {
  for (const operation of ["persist", "save", "delete"]) {
    await t.test(operation, async () => {
    const mutationStarted = deferred();
    const mutationGate = deferred();
    let shouldBlock = false;
    let currentVideoId = "abc123";
    const initialDigest = await digestV2CacheValue({
      transcript: [{ text: "A sentence.", start: 0, duration: 5 }],
    });
    const app = loadBackground({
      initialState: {
        ytd_reset_epoch: 0,
        ytd_settings: { aiApiKey: "", supadataApiKey: "" },
        digest_abc123: initialDigest,
        ytd_notes: [{ id: "old-note", videoId: "abc123" }],
      },
      tabsGet: async (tabId) => ({
        id: tabId,
        windowId: 7,
        active: true,
        url: `https://www.youtube.com/watch?v=${currentVideoId}`,
      }),
      async storageGetHook(query) {
        const target =
          (operation === "persist" && query === "digest_abc123") ||
          (operation === "save" && query === "digest_abc123") ||
          (operation === "delete" && query === "ytd_notes");
        if (shouldBlock && target) {
          shouldBlock = false;
          mutationStarted.resolve();
          await mutationGate.promise;
        }
      },
    });
    const a1 = digestSessionBinding({ videoId: "abc123", tabId: 1 });
    await bindDigestSession(app, a1);
    shouldBlock = true;
    let pending;
    if (operation === "persist") {
      const value = await digestBaseValue({
        transcript: initialDigest.transcript,
        videoTitle: "late title",
      });
      pending = app.send({
        action: "persistDigestBase",
        expectedEpoch: 0,
        videoId: "abc123",
        value,
        ...a1,
      });
    } else if (operation === "save") {
      pending = app.send({
        action: "saveNote",
        videoId: "abc123",
        timestamp: 1,
        videoTitle: "A",
        channelName: "Channel",
        ...a1,
      });
    } else {
      pending = app.send({
        action: "deleteNote",
        noteId: "old-note",
        ...a1,
      });
    }
    await mutationStarted.promise;

    currentVideoId = "def456";
    await bindDigestSession(
      app,
      digestSessionBinding({
        videoId: "def456",
        tabId: 1,
        generation: 2,
      }),
    );
    currentVideoId = "abc123";
    const a2 = {
      tabId: 1,
      sessionToken: {
        ...a1.sessionToken,
        sessionId: `digest-abc123-a2-${operation}`,
        generation: 3,
      },
    };
    await bindDigestSession(app, a2);
    mutationGate.resolve();

    const result = await pending;
    assert.equal(result.success, false, operation);
    assert.equal(result.code, "SESSION_STALE", operation);
    if (operation === "persist") {
      assert.equal(app.state.digest_abc123.timestamp, initialDigest.timestamp);
    } else if (operation === "save") {
      assert.equal(app.state.ytd_notes.length, 1);
    } else {
      assert.equal(app.state.ytd_notes.some((note) => note.id === "old-note"), true);
    }
    });
  }
});

test("the current B panel may delete an older A note", async () => {
  const app = loadBackground({
    initialState: {
      ytd_reset_epoch: 0,
      ytd_notes: [{ id: "note-from-a", videoId: "abc123" }],
    },
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=def456",
    }),
  });
  const b = digestSessionBinding({ videoId: "def456", tabId: 1 });
  await bindDigestSession(app, b);
  const result = await app.send({
    action: "deleteNote",
    noteId: "note-from-a",
    ...b,
  });
  assert.equal(result.success, true);
  assert.deepEqual(app.state.ytd_notes, []);
});

test("content note authority allows tab switching but rejects navigation", async () => {
  const makeApp = async (finalVideoId) => {
    const preparationStarted = deferred();
    const preparationGate = deferred();
    let currentVideoId = "abc123";
    const app = loadBackground({
      initialState: {
        ytd_reset_epoch: 0,
        ytd_settings: { aiApiKey: "", supadataApiKey: "" },
        digest_abc123: await digestV2CacheValue({
          transcript: [{ text: "A sentence.", start: 0, duration: 5 }],
        }),
      },
      tabsGet: async (tabId) => ({
        id: tabId,
        windowId: 7,
        active: false,
        url: `https://www.youtube.com/watch?v=${currentVideoId}`,
      }),
      async storageGetHook(query) {
        if (query === "digest_abc123") {
          preparationStarted.resolve();
          await preparationGate.promise;
        }
      },
    });
    return {
      app,
      preparationStarted,
      release() {
        currentVideoId = finalVideoId;
        preparationGate.resolve();
      },
    };
  };

  for (const [finalVideoId, succeeds] of [["abc123", true], ["def456", false]]) {
    const fixture = await makeApp(finalVideoId);
    const pending = fixture.app.send({
      action: "saveNote",
      videoId: "abc123",
      timestamp: 1,
      videoTitle: "A",
      channelName: "Channel",
    }, {
      tab: {
        id: 1,
        windowId: 7,
        active: true,
        url: "https://www.youtube.com/watch?v=abc123",
      },
    });
    await fixture.preparationStarted.promise;
    fixture.release();
    const result = await pending;
    assert.equal(result.success, succeeds, finalVideoId);
    if (!succeeds) assert.equal(result.code, "TAB_VIDEO_MISMATCH");
  }
});

test("panel note cache miss rechecks authority before Supadata dispatch", async () => {
  const settingsStarted = deferred();
  const settingsGate = deferred();
  let currentVideoId = "abc123";
  let blockSettings = false;
  const app = loadBackground({
    initialState: {
      ytd_reset_epoch: 0,
      ytd_settings: { aiApiKey: "", supadataApiKey: "supadata-key" },
    },
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: `https://www.youtube.com/watch?v=${currentVideoId}`,
    }),
    async storageGetHook(query) {
      if (blockSettings && query === "ytd_settings") {
        blockSettings = false;
        settingsStarted.resolve();
        await settingsGate.promise;
      }
    },
    async fetch() {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            content: [{ text: "A source sentence.", offset: 0, duration: 5000 }],
            lang: "en",
          };
        },
      };
    },
  });
  const binding = await bindDigestSession(app);
  blockSettings = true;

  const pending = app.send({
    action: "saveNote",
    videoId: "abc123",
    timestamp: 1,
    videoTitle: "A",
    channelName: "Channel",
    ...binding,
  });
  await settingsStarted.promise;
  currentVideoId = "def456";
  settingsGate.resolve();

  const result = await pending;
  assert.equal(result.success, false);
  assert.equal(
    app.getFetchUrls().filter((url) => url.includes("api.supadata.ai")).length,
    0,
  );
});

test("content note cache miss rechecks navigation before Supadata dispatch", async () => {
  const settingsStarted = deferred();
  const settingsGate = deferred();
  let currentVideoId = "abc123";
  let blockSettings = true;
  const app = loadBackground({
    initialState: {
      ytd_reset_epoch: 0,
      ytd_settings: { aiApiKey: "", supadataApiKey: "supadata-key" },
    },
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: false,
      url: `https://www.youtube.com/watch?v=${currentVideoId}`,
    }),
    async storageGetHook(query) {
      if (blockSettings && query === "ytd_settings") {
        blockSettings = false;
        settingsStarted.resolve();
        await settingsGate.promise;
      }
    },
    async fetch() {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            content: [{ text: "A source sentence.", offset: 0, duration: 5000 }],
            lang: "en",
          };
        },
      };
    },
  });

  const pending = app.send({
    action: "saveNote",
    videoId: "abc123",
    timestamp: 1,
    videoTitle: "A",
    channelName: "Channel",
  });
  await settingsStarted.promise;
  currentVideoId = "def456";
  settingsGate.resolve();

  const result = await pending;
  assert.equal(result.success, false);
  assert.equal(
    app.getFetchUrls().filter((url) => url.includes("api.supadata.ai")).length,
    0,
  );
});

test("content note rejects reset after epoch but before the final provider tab check", async () => {
  const finalTabStarted = deferred();
  const finalTabGate = deferred();
  const app = loadBackground({
    initialState: {
      ytd_reset_epoch: 0,
      ytd_settings: { aiApiKey: "", supadataApiKey: "supadata-key" },
    },
    tabsGet: async (tabId, tabGetCount) => {
      if (tabGetCount === 3) {
        finalTabStarted.resolve();
        await finalTabGate.promise;
      }
      return {
        id: tabId,
        windowId: 7,
        active: false,
        url: "https://www.youtube.com/watch?v=abc123",
      };
    },
    async fetch() {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            content: [{ text: "A source sentence.", offset: 0, duration: 5000 }],
            lang: "en",
          };
        },
      };
    },
  });

  const pending = app.send({
    action: "saveNote",
    videoId: "abc123",
    timestamp: 1,
    videoTitle: "A",
    channelName: "Channel",
  });
  await finalTabStarted.promise;
  app.state.ytd_reset_epoch = 1;
  app.storageChangedListeners[0](
    { ytd_reset_epoch: { oldValue: 0, newValue: 1 } },
    "local",
  );
  finalTabGate.resolve();

  const result = await pending;
  assert.equal(result.success, false);
  assert.equal(result.code, "RESET_DURING_REQUEST");
  assert.equal(
    app.getFetchUrls().filter((url) => url.includes("api.supadata.ai")).length,
    0,
  );
});

test("content note provider guard still permits an inactive unchanged video tab", async () => {
  const app = loadBackground({
    initialState: {
      ytd_reset_epoch: 0,
      ytd_settings: { aiApiKey: "", supadataApiKey: "supadata-key" },
    },
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: false,
      url: "https://www.youtube.com/watch?v=abc123",
    }),
    async fetch() {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            content: [{ text: "A source sentence.", offset: 0, duration: 5000 }],
            lang: "en",
          };
        },
      };
    },
  });

  const result = await app.send({
    action: "saveNote",
    videoId: "abc123",
    timestamp: 1,
    videoTitle: "A",
    channelName: "Channel",
  });

  assert.equal(result.success, true);
  assert.equal(
    app.getFetchUrls().filter((url) => url.includes("api.supadata.ai")).length,
    1,
  );
  assert.equal(app.state.ytd_notes.length, 1);
});

test("panel note cleanup rechecks reset before DeepSeek dispatch", async () => {
  const promptStarted = deferred();
  const promptGate = deferred();
  const app = loadBackground({
    initialState: {
      ytd_reset_epoch: 0,
      ytd_settings: {
        aiApiKey: "deepseek-key",
        aiBaseUrl: "https://api.deepseek.com",
        aiModel: "deepseek-v4-flash",
        supadataApiKey: "",
      },
      digest_abc123: await digestV2CacheValue({
        transcript: [{ text: "A cached sentence.", start: 0, duration: 5 }],
      }),
    },
    tabsGet: async (tabId) => ({
      id: tabId,
      windowId: 7,
      active: true,
      url: "https://www.youtube.com/watch?v=abc123",
    }),
    async fetch(url) {
      if (String(url).startsWith("chrome-extension://test/prompts/")) {
        promptStarted.resolve();
        await promptGate.promise;
        return {
          ok: true,
          async text() {
            return [
              "## System prompt",
              "```",
              "Clean {targetText}",
              "```",
              "## User prompt",
              "```",
              "{targetText}",
              "```",
            ].join("\n");
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { choices: [{ message: { content: '{"quote":"Clean A."}' } }] };
        },
      };
    },
  });
  const binding = await bindDigestSession(app);

  const pending = app.send({
    action: "saveNote",
    videoId: "abc123",
    timestamp: 1,
    videoTitle: "A",
    channelName: "Channel",
    ...binding,
  });
  await promptStarted.promise;
  app.state.ytd_reset_epoch = 1;
  app.storageChangedListeners[0](
    { ytd_reset_epoch: { oldValue: 0, newValue: 1 } },
    "local",
  );
  promptGate.resolve();

  const result = await pending;
  assert.equal(result.success, false);
  assert.equal(
    app.getFetchUrls().filter((url) => url.includes("api.deepseek.com")).length,
    0,
  );
});

test("background source has one coordinator construction and no legacy vocabulary queue", () => {
  const source = read("background.js");
  assert.equal((source.match(/createMutationCoordinator\(/g) || []).length, 1);
  assert.doesNotMatch(source, /vocabularyMutationQueue|enqueueVocabularyMutation/);
  assert.doesNotMatch(
    source,
    /persistDigestCache|handlePersistDigestCache|legacyAdapter|\.commitDigest\(/,
  );
  assert.match(
    source,
    /importScripts\(\s*"settings\.js",\s*"providers\.js",\s*"persistence\.js",\s*"transcript-core\.js",\s*"overview-core\.js",?\s*\)/,
  );
  for (const action of [
    "saveVocabularyCard",
    "getVocabulary",
    "deleteVocabularyCard",
    "saveNote",
    "getNotes",
    "deleteNote",
  ]) {
    const block = source.match(
      new RegExp(`if \\(message\\.action === "${action}"\\) \\{[\\s\\S]*?(?=\\n  if \\(message\\.action|\\n  // Translation)`),
    )?.[0] || "";
    assert.ok(block, `missing ${action} message handler`);
    assert.doesNotMatch(block, /err(?:or)?\.message/);
  }
});
