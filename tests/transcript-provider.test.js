const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const settingsRuntime = require("../settings.js");
const providersRuntime = require("../providers.js");
const persistenceRuntime = require("../persistence.js");

function listenerEvent() {
  return { addListener() {} };
}

function loadTranscriptProviderHelpers({
  fetchImpl = async () => {
    throw new Error("Unexpected network request");
  },
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  nowImpl = () => Date.now(),
  sleepImpl,
  storedSettings = {
    ...settingsRuntime.DEFAULTS,
    supadataApiKey: "supadata-test-key",
    aiApiKey: "deepseek-test-key",
  },
} = {}) {
  const local = {
    async setAccessLevel() {},
    async get(query) {
      if (query === settingsRuntime.STORAGE_KEY) {
        return { [settingsRuntime.STORAGE_KEY]: storedSettings };
      }
      if (query === persistenceRuntime.STORAGE_KEYS.resetEpoch) {
        return { [persistenceRuntime.STORAGE_KEYS.resetEpoch]: 0 };
      }
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
    Date,
    Math,
    crypto: { randomUUID: () => "test-session-id" },
    fetch: fetchImpl,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    importScripts() {},
    chrome: {
      storage: { local, onChanged: listenerEvent() },
      action: { onClicked: listenerEvent() },
      sidePanel: {
        setPanelBehavior() {},
        async setOptions() {},
        async open() {},
      },
      runtime: {
        onInstalled: listenerEvent(),
        onMessage: listenerEvent(),
        openOptionsPage() {},
        getURL: (resource) => `chrome-extension://test/${resource}`,
      },
      tabs: {
        onUpdated: listenerEvent(),
        onActivated: listenerEvent(),
        onRemoved: listenerEvent(),
        async get(tabId) {
          return {
            id: tabId,
            windowId: 7,
            active: true,
            url: "https://www.youtube.com/watch?v=abc123",
          };
        },
        async query() { return []; },
        async sendMessage() { return {}; },
      },
      windows: { onRemoved: listenerEvent() },
      scripting: { async executeScript() { return []; } },
    },
    YTD_SETTINGS: settingsRuntime,
    YTD_PROVIDERS: providersRuntime,
    YTD_PERSISTENCE: persistenceRuntime,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("transcript-core.js"), sandbox, {
    filename: "transcript-core.js",
  });
  vm.runInNewContext(read("overview-core.js"), sandbox, {
    filename: "overview-core.js",
  });
  vm.runInNewContext(read("background.js"), sandbox, {
    filename: "background.js",
  });
  const helpers = sandbox.__YTD_TRANSCRIPT_PROVIDER_TESTING__;
  if (helpers && (nowImpl || sleepImpl)) {
    helpers.configureTestRuntime?.({
      now: nowImpl,
      ...(sleepImpl ? { sleep: sleepImpl } : {}),
    });
  }
  return helpers;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function createManualTimers() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay, active: true });
      return id;
    },
    clearTimeout(id) {
      const timer = timers.get(id);
      if (timer) timer.active = false;
    },
    fire(delay) {
      const match = [...timers.values()].find(
        (timer) => timer.active && timer.delay === delay,
      );
      assert.ok(match, `Expected an active ${delay}ms timer`);
      match.active = false;
      match.callback();
    },
    activeCount(delay) {
      return [...timers.values()].filter(
        (timer) => timer.active && (delay === undefined || timer.delay === delay),
      ).length;
    },
    createdDelays() {
      return [...timers.values()].map((timer) => timer.delay);
    },
  };
}

function streamingJsonResponse(text, { status = 200, onCancel } = {}) {
  const chunks = [new TextEncoder().encode(text)];
  let index = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true };
            return { done: false, value: chunks[index++] };
          },
          async cancel() {
            onCancel?.();
          },
        };
      },
    },
  };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function providerStorage({ supadataApiKey = "supadata-test-key" } = {}) {
  return {
    async get() {
      return {
        [settingsRuntime.STORAGE_KEY]: {
          ...settingsRuntime.DEFAULTS,
          supadataApiKey,
        },
      };
    },
  };
}

function assertCanonicalFailure(actual, expected) {
  assert.deepEqual(plain(actual), { success: false, ...expected });
  assert.equal(Object.hasOwn(actual, "error"), false);
  assert.equal(Object.hasOwn(actual, "message"), false);
}

test("Supadata exposes one shared transcript normalizer", () => {
  const helpers = loadTranscriptProviderHelpers();

  assert.equal(typeof helpers?.normalizeSupadataTranscript, "function");
  assert.deepEqual(plain(helpers.limits), {
    initialTimeoutMs: 30_000,
    pollTimeoutMs: 15_000,
    jobDeadlineMs: 90_000,
    maxResponseBytes: 5 * 1024 * 1024,
  });
});

test("shared normalization cleans synchronous and asynchronous timestamp text identically", () => {
  const { normalizeSupadataTranscript } = loadTranscriptProviderHelpers();
  const payload = {
    lang: "en",
    content: [
      { text: ">> First idea ", offset: 0, duration: 1400, lang: "en" },
      { text: "  >>   ", offset: 1400, duration: 500, lang: "en" },
      { text: "Second idea", offset: 61_900, duration: 2200 },
    ],
  };

  const synchronous = plain(normalizeSupadataTranscript(payload));
  const asynchronous = plain(normalizeSupadataTranscript(payload));

  assert.deepEqual(synchronous, asynchronous);
  assert.deepEqual(synchronous, {
    success: true,
    transcript: [
      { text: "First idea", start: 0, duration: 1, language: "en" },
      { text: "Second idea", start: 61, duration: 2, language: "en" },
    ],
    transcriptText: "First idea Second idea",
    transcriptTextTimestamped: "[0:00] First idea\n[1:01] Second idea",
    language: "en",
  });
  assert.doesNotMatch(synchronous.transcriptTextTimestamped, />>/);
});

test("normalization derives canonical language from the first valid chunk when top-level lang is empty", () => {
  const { normalizeSupadataTranscript } = loadTranscriptProviderHelpers();
  const normalized = plain(
    normalizeSupadataTranscript({
      lang: "   ",
      content: [
        { text: "First idea", offset: 0, duration: 1000, lang: " en " },
        { text: "Second idea", offset: 1000, duration: 1000, lang: "fr" },
      ],
    }),
  );

  assert.equal(normalized.language, "en");
});

test("shared normalization rejects a completed transcript with no cleaned entries", () => {
  const { normalizeSupadataTranscript } = loadTranscriptProviderHelpers();

  for (const payload of [
    {},
    { content: null },
    { content: [] },
    { content: [{ text: ">>  " }, { text: "" }, null] },
  ]) {
    assert.throws(
      () => normalizeSupadataTranscript(payload),
      (error) => error?.code === "EMPTY_RESPONSE",
    );
  }
});

test("initial request deadline includes response body consumption", async () => {
  const timers = createManualTimers();
  const helpers = loadTranscriptProviderHelpers();
  assert.equal(typeof helpers?.fetchWithDeadline, "function");
  let signal;
  const request = helpers.fetchWithDeadline(
    "https://api.supadata.ai/v1/transcript",
    {},
    {
      timeoutMs: 30_000,
      maxBytes: 5 * 1024 * 1024,
      fetchImpl: async (_url, init) => {
        signal = init.signal;
        return {
          ok: true,
          status: 200,
          body: {
            getReader() {
              return {
                read: () => new Promise(() => {}),
                async cancel() {},
              };
            },
          },
        };
      },
      setTimeoutImpl: timers.setTimeout,
      clearTimeoutImpl: timers.clearTimeout,
    },
  );

  await nextTurn();
  assert.equal(signal.aborted, false);
  assert.equal(timers.activeCount(30_000), 1);
  timers.fire(30_000);

  await assert.rejects(request, (error) => error?.code === "REQUEST_TIMEOUT");
  assert.equal(signal.aborted, true);
  assert.equal(timers.activeCount(), 0);
});

test("bounded response reader accepts exactly the configured byte limit", async () => {
  const helpers = loadTranscriptProviderHelpers();
  const body = '{"x":1}';

  const result = await helpers.fetchWithDeadline(
    "https://api.supadata.ai/v1/transcript",
    {},
    {
      timeoutMs: 30_000,
      maxBytes: Buffer.byteLength(body, "utf8"),
      fetchImpl: async () => streamingJsonResponse(body),
    },
  );

  assert.deepEqual(plain(result.data), { x: 1 });
});

test("bounded response reader rejects one byte over the limit and cancels", async () => {
  const helpers = loadTranscriptProviderHelpers();
  const body = '{"x":10}';
  let cancelled = false;

  await assert.rejects(
    helpers.fetchWithDeadline(
      "https://api.supadata.ai/v1/transcript",
      {},
      {
        timeoutMs: 30_000,
        maxBytes: Buffer.byteLength(body, "utf8") - 1,
        fetchImpl: async () =>
          streamingJsonResponse(body, { onCancel: () => { cancelled = true; } }),
      },
    ),
    (error) => error?.code === "RESPONSE_TOO_LARGE",
  );
  assert.equal(cancelled, true);
});

test("bounded response reader counts UTF-8 bytes instead of JavaScript characters", async () => {
  const helpers = loadTranscriptProviderHelpers();
  const body = '{"x":"汉"}';
  assert.ok(Buffer.byteLength(body, "utf8") > body.length);

  await assert.rejects(
    helpers.fetchWithDeadline(
      "https://api.supadata.ai/v1/transcript",
      {},
      {
        timeoutMs: 30_000,
        maxBytes: body.length,
        fetchImpl: async () => streamingJsonResponse(body),
      },
    ),
    (error) => error?.code === "RESPONSE_TOO_LARGE",
  );
});

test("successful invalid JSON is a typed malformed response", async () => {
  const helpers = loadTranscriptProviderHelpers();

  await assert.rejects(
    helpers.fetchWithDeadline(
      "https://api.supadata.ai/v1/transcript",
      {},
      {
        timeoutMs: 30_000,
        maxBytes: 1024,
        fetchImpl: async () => streamingJsonResponse("not-json"),
      },
    ),
    (error) => error?.code === "MALFORMED_RESPONSE",
  );
});

test("synchronous and completed-job handlers use the same cleaned normalization", async () => {
  const helpers = loadTranscriptProviderHelpers();
  assert.equal(typeof helpers?.handleFetchTranscript, "function");
  const payload = {
    lang: "en",
    content: [
      { text: ">> First idea", offset: 0, duration: 1100 },
      { text: "Second idea", offset: 61_000, duration: 2300 },
    ],
  };

  const syncResult = await helpers.handleFetchTranscript(
    "abc123",
    providerStorage(),
    async () => true,
    {
      fetchImpl: async () =>
        streamingJsonResponse(JSON.stringify(payload), { status: 200 }),
    },
  );

  let asyncCall = 0;
  const asyncResult = await helpers.handleFetchTranscript(
    "abc123",
    providerStorage(),
    async () => true,
    {
      sleep: async () => {},
      fetchImpl: async () => {
        asyncCall += 1;
        return asyncCall === 1
          ? streamingJsonResponse(JSON.stringify({ jobId: "job-1" }), {
              status: 202,
            })
          : streamingJsonResponse(
              JSON.stringify({ status: "completed", ...payload }),
              { status: 200 },
            );
      },
    },
  );

  assert.deepEqual(plain(asyncResult), plain(syncResult));
  assert.doesNotMatch(asyncResult.transcriptTextTimestamped, />>/);
});

test("missing Supadata key is canonical and cannot consume credit", async () => {
  const helpers = loadTranscriptProviderHelpers();
  let fetchCalls = 0;
  const result = await helpers.handleFetchTranscript(
    "abc123",
    providerStorage({ supadataApiKey: "" }),
    async () => true,
    { fetchImpl: async () => { fetchCalls += 1; } },
  );

  assertCanonicalFailure(result, {
    code: "MISSING_KEY",
    provider: "supadata",
    stage: "transcript",
    retryable: false,
    mayHaveConsumedCredit: false,
    primaryAction: "open_settings",
  });
  assert.equal(fetchCalls, 0);
});

test("Supadata 206 is a canonical possibly billed no-transcript failure", async () => {
  const helpers = loadTranscriptProviderHelpers();
  const result = await helpers.handleFetchTranscript(
    "abc123",
    providerStorage(),
    async () => true,
    {
      fetchImpl: async () => ({ ok: true, status: 206, body: null }),
    },
  );

  assertCanonicalFailure(result, {
    code: "NO_TRANSCRIPT",
    provider: "supadata",
    stage: "transcript",
    retryable: false,
    mayHaveConsumedCredit: true,
    primaryAction: "choose_video",
  });
});

test("Supadata 206 cancels an unread body without waiting for cancellation", async () => {
  const helpers = loadTranscriptProviderHelpers();
  const timers = createManualTimers();
  let cancelCalls = 0;
  let readerCalls = 0;
  const pending = helpers.fetchWithDeadline(
    "https://api.supadata.ai/v1/transcript",
    {},
    {
      timeoutMs: 30_000,
      maxBytes: 5 * 1024 * 1024,
      setTimeoutImpl: timers.setTimeout,
      clearTimeoutImpl: timers.clearTimeout,
      fetchImpl: async () => ({
        ok: true,
        status: 206,
        body: {
          cancel() {
            cancelCalls += 1;
            return new Promise(() => {});
          },
          getReader() {
            readerCalls += 1;
            throw new Error("206 body must not be read");
          },
        },
      }),
    },
  );

  const result = await Promise.race([
    pending,
    nextTurn().then(() => ({ timedOutLocally: true })),
  ]);

  assert.equal(result.timedOutLocally, undefined);
  assert.equal(result.response.status, 206);
  assert.equal(cancelCalls, 1);
  assert.equal(readerCalls, 0);
  assert.equal(timers.activeCount(), 0);
});

test("Supadata HTTP and network failures use the canonical integration envelope", async (t) => {
  const cases = [
    {
      name: "invalid key",
      response: streamingJsonResponse(JSON.stringify({ message: "rejected" }), {
        status: 401,
      }),
      expected: ["INVALID_KEY", false, "open_settings"],
    },
    {
      name: "documented quota marker",
      response: streamingJsonResponse(
        JSON.stringify({ billing: { reason: "insufficient_balance" } }),
        { status: 403 },
      ),
      expected: ["INSUFFICIENT_CREDIT", false, "open_billing"],
    },
    {
      name: "rate limited",
      response: streamingJsonResponse(JSON.stringify({}), { status: 429 }),
      expected: ["RATE_LIMITED", true, "retry_later"],
    },
    {
      name: "server unavailable",
      response: streamingJsonResponse(JSON.stringify({}), { status: 503 }),
      expected: ["UNKNOWN_PROVIDER_ERROR", true, "retry"],
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const helpers = loadTranscriptProviderHelpers();
      const result = await helpers.handleFetchTranscript(
        "abc123",
        providerStorage(),
        async () => true,
        { fetchImpl: async () => item.response },
      );
      assertCanonicalFailure(result, {
        code: item.expected[0],
        provider: "supadata",
        stage: "transcript",
        retryable: item.expected[1],
        mayHaveConsumedCredit: true,
        primaryAction: item.expected[2],
      });
    });
  }

  await t.test("network error", async () => {
    const helpers = loadTranscriptProviderHelpers();
    const result = await helpers.handleFetchTranscript(
      "abc123",
      providerStorage(),
      async () => true,
      {
        fetchImpl: async () => {
          throw new TypeError("Failed to fetch provider-secret");
        },
      },
    );
    assertCanonicalFailure(result, {
      code: "NETWORK_ERROR",
      provider: "supadata",
      stage: "transcript",
      retryable: true,
      mayHaveConsumedCredit: true,
      primaryAction: "retry",
    });
    assert.doesNotMatch(JSON.stringify(result), /provider-secret/);
  });
});

test("Supadata HTTP status wins when an error body is blank or malformed", async (t) => {
  const cases = [
    [401, "", "INVALID_KEY", false, "open_settings"],
    [429, "not-json", "RATE_LIMITED", true, "retry_later"],
    [404, "", "NO_TRANSCRIPT", false, "choose_video"],
  ];

  for (const [status, body, code, retryable, primaryAction] of cases) {
    await t.test(`initial ${status}`, async () => {
      const helpers = loadTranscriptProviderHelpers();
      const result = await helpers.handleFetchTranscript(
        "abc123",
        providerStorage(),
        async () => true,
        {
          fetchImpl: async () => streamingJsonResponse(body, { status }),
        },
      );

      assertCanonicalFailure(result, {
        code,
        provider: "supadata",
        stage: "transcript",
        retryable,
        mayHaveConsumedCredit: true,
        primaryAction,
      });
      assert.doesNotMatch(JSON.stringify(result), /not-json/);
    });
  }

  await t.test("poll 404", async () => {
    const helpers = loadTranscriptProviderHelpers();
    let fetchCalls = 0;
    const result = await helpers.handleFetchTranscript(
      "abc123",
      providerStorage(),
      async () => true,
      {
        sleep: async () => {},
        fetchImpl: async () => {
          fetchCalls += 1;
          return fetchCalls === 1
            ? streamingJsonResponse(JSON.stringify({ jobId: "job-404" }), {
                status: 202,
              })
            : streamingJsonResponse("not-json", { status: 404 });
        },
      },
    );

    assertCanonicalFailure(result, {
      code: "NO_TRANSCRIPT",
      provider: "supadata",
      stage: "transcript",
      retryable: false,
      mayHaveConsumedCredit: true,
      primaryAction: "choose_video",
    });
    assert.equal(fetchCalls, 2);
    assert.doesNotMatch(JSON.stringify(result), /not-json/);
  });
});

test("202 without a usable job id is a billed malformed response and never polls", async () => {
  const helpers = loadTranscriptProviderHelpers();
  let fetchCalls = 0;
  const result = await helpers.handleFetchTranscript(
    "abc123",
    providerStorage(),
    async () => true,
    {
      fetchImpl: async () => {
        fetchCalls += 1;
        return streamingJsonResponse(JSON.stringify({ jobId: "  " }), {
          status: 202,
        });
      },
    },
  );

  assertCanonicalFailure(result, {
    code: "MALFORMED_RESPONSE",
    provider: "supadata",
    stage: "transcript",
    retryable: true,
    mayHaveConsumedCredit: true,
    primaryAction: "retry",
  });
  assert.equal(fetchCalls, 1);
});

test("202 validates job ids before constructing a polling URL", async (t) => {
  for (const [name, jobId] of [
    ["513 characters", "x".repeat(513)],
    ["lone surrogate", "job-\ud800"],
    ["dot segment", "."],
    ["parent segment", ".."],
  ]) {
    await t.test(name, async () => {
      const helpers = loadTranscriptProviderHelpers();
      let fetchCalls = 0;
      const result = await helpers.handleFetchTranscript(
        "abc123",
        providerStorage(),
        async () => true,
        {
          sleep: async () => {},
          fetchImpl: async () => {
            fetchCalls += 1;
            if (fetchCalls > 1) throw new Error("invalid job ID was polled");
            return streamingJsonResponse(JSON.stringify({ jobId }), {
              status: 202,
            });
          },
        },
      );

      assertCanonicalFailure(result, {
        code: "MALFORMED_RESPONSE",
        provider: "supadata",
        stage: "transcript",
        retryable: true,
        mayHaveConsumedCredit: true,
        primaryAction: "retry",
      });
      assert.equal(fetchCalls, 1);
    });
  }

  await t.test("512 URL-safe characters", async () => {
    const helpers = loadTranscriptProviderHelpers();
    const jobId = "x".repeat(512);
    let fetchCalls = 0;
    let pollUrl = "";
    const result = await helpers.handleFetchTranscript(
      "abc123",
      providerStorage(),
      async () => true,
      {
        sleep: async () => {},
        fetchImpl: async (url) => {
          fetchCalls += 1;
          if (fetchCalls === 1) {
            return streamingJsonResponse(JSON.stringify({ jobId }), {
              status: 202,
            });
          }
          pollUrl = String(url);
          return streamingJsonResponse(
            JSON.stringify({
              status: "completed",
              content: [{ text: "Transcript", offset: 0, duration: 1_000 }],
            }),
            { status: 200 },
          );
        },
      },
    );

    assert.equal(result.success, true);
    assert.equal(fetchCalls, 2);
    assert.ok(pollUrl.endsWith(jobId));
  });
});

test("Supadata dispatch guards preserve conservative credit state", async (t) => {
  await t.test("stale before the initial dispatch", async () => {
    const helpers = loadTranscriptProviderHelpers();
    let fetchCalls = 0;
    const result = await helpers.handleFetchTranscript(
      "abc123",
      providerStorage(),
      async () => "SESSION_STALE",
      { fetchImpl: async () => { fetchCalls += 1; } },
    );

    assertCanonicalFailure(result, {
      code: "SESSION_STALE",
      provider: "supadata",
      stage: "transcript",
      retryable: true,
      mayHaveConsumedCredit: false,
      primaryAction: "retry",
    });
    assert.equal(fetchCalls, 0);
  });

  await t.test("stale before polling after a 202", async () => {
    const helpers = loadTranscriptProviderHelpers();
    let fetchCalls = 0;
    let guardCalls = 0;
    const result = await helpers.handleFetchTranscript(
      "abc123",
      providerStorage(),
      async () => {
        guardCalls += 1;
        return guardCalls === 1 ? true : "SESSION_STALE";
      },
      {
        sleep: async () => {},
        fetchImpl: async () => {
          fetchCalls += 1;
          return streamingJsonResponse(JSON.stringify({ jobId: "job-stale" }), {
            status: 202,
          });
        },
      },
    );

    assertCanonicalFailure(result, {
      code: "SESSION_STALE",
      provider: "supadata",
      stage: "transcript",
      retryable: true,
      mayHaveConsumedCredit: true,
      primaryAction: "retry",
    });
    assert.equal(fetchCalls, 1);
  });
});

test("polling rejects null, missing, and unknown status schemas as malformed", async (t) => {
  const cases = [
    ["null", "null"],
    ["missing", "{}"],
    ["unknown", JSON.stringify({ status: "mystery" })],
  ];

  for (const [name, pollBody] of cases) {
    await t.test(name, async () => {
      const helpers = loadTranscriptProviderHelpers();
      let fetchCalls = 0;
      const result = await helpers.handleFetchTranscript(
        "abc123",
        providerStorage(),
        async () => true,
        {
          sleep: async () => {},
          fetchImpl: async () => {
            fetchCalls += 1;
            return fetchCalls === 1
              ? streamingJsonResponse(JSON.stringify({ jobId: "job-schema" }), {
                  status: 202,
                })
              : streamingJsonResponse(pollBody, { status: 200 });
          },
        },
      );

      assertCanonicalFailure(result, {
        code: "MALFORMED_RESPONSE",
        provider: "supadata",
        stage: "transcript",
        retryable: true,
        mayHaveConsumedCredit: true,
        primaryAction: "retry",
      });
      assert.equal(fetchCalls, 2);
    });
  }
});

test("completed async job with no cleaned transcript is EMPTY_RESPONSE", async () => {
  const helpers = loadTranscriptProviderHelpers();
  let fetchCalls = 0;
  const result = await helpers.handleFetchTranscript(
    "abc123",
    providerStorage(),
    async () => true,
    {
      sleep: async () => {},
      fetchImpl: async () => {
        fetchCalls += 1;
        return fetchCalls === 1
          ? streamingJsonResponse(JSON.stringify({ jobId: "job-empty" }), {
              status: 202,
            })
          : streamingJsonResponse(
              JSON.stringify({
                status: "completed",
                content: [{ text: ">> " }],
              }),
              { status: 200 },
            );
      },
    },
  );

  assertCanonicalFailure(result, {
    code: "EMPTY_RESPONSE",
    provider: "supadata",
    stage: "transcript",
    retryable: true,
    mayHaveConsumedCredit: true,
    primaryAction: "retry",
  });
});

test("each poll has a body-inclusive 15 second deadline", async () => {
  const timers = createManualTimers();
  const helpers = loadTranscriptProviderHelpers();
  let fetchCalls = 0;
  let pollSignal;
  const pending = helpers.handleFetchTranscript(
    "abc123",
    providerStorage(),
    async () => true,
    {
      sleep: async () => {},
      setTimeoutImpl: timers.setTimeout,
      clearTimeoutImpl: timers.clearTimeout,
      fetchImpl: async (_url, init) => {
        fetchCalls += 1;
        if (fetchCalls === 1) {
          return streamingJsonResponse(JSON.stringify({ jobId: "job-timeout" }), {
            status: 202,
          });
        }
        pollSignal = init.signal;
        return {
          ok: true,
          status: 200,
          body: {
            getReader() {
              return {
                read: () => new Promise(() => {}),
                async cancel() {},
              };
            },
          },
        };
      },
    },
  );

  for (let turn = 0; turn < 10 && !timers.activeCount(15_000); turn += 1) {
    await nextTurn();
  }
  assert.equal(timers.activeCount(30_000), 0);
  assert.equal(timers.activeCount(15_000), 1);
  timers.fire(15_000);
  const result = await pending;

  assert.equal(pollSignal.aborted, true);
  assertCanonicalFailure(result, {
    code: "REQUEST_TIMEOUT",
    provider: "supadata",
    stage: "transcript",
    retryable: true,
    mayHaveConsumedCredit: true,
    primaryAction: "retry",
  });
});

test("async polling uses one absolute 90 second wall-clock deadline", async () => {
  const timers = createManualTimers();
  const helpers = loadTranscriptProviderHelpers();
  let now = 0;
  let fetchCalls = 0;
  const result = await helpers.handleFetchTranscript(
    "abc123",
    providerStorage(),
    async () => true,
    {
      now: () => now,
      sleep: async (delay) => { now += delay; },
      setTimeoutImpl: timers.setTimeout,
      clearTimeoutImpl: timers.clearTimeout,
      fetchImpl: async () => {
        fetchCalls += 1;
        if (fetchCalls === 1) {
          now += 10_000;
          return streamingJsonResponse(JSON.stringify({ jobId: "job-deadline" }), {
            status: 202,
          });
        }
        now += 29_000;
        return streamingJsonResponse(JSON.stringify({ status: "active" }), {
          status: 200,
        });
      },
    },
  );

  assertCanonicalFailure(result, {
    code: "REQUEST_TIMEOUT",
    provider: "supadata",
    stage: "transcript",
    retryable: true,
    mayHaveConsumedCredit: true,
    primaryAction: "retry",
  });
  assert.equal(fetchCalls, 4);
  assert.equal(now, 100_000);
});

test("the final poll timeout is capped to remaining job budget", async () => {
  const timers = createManualTimers();
  const helpers = loadTranscriptProviderHelpers();
  let now = 0;
  let fetchCalls = 0;
  const result = await helpers.handleFetchTranscript(
    "abc123",
    providerStorage(),
    async () => true,
    {
      now: () => now,
      sleep: async (delay) => { now += delay; },
      setTimeoutImpl: timers.setTimeout,
      clearTimeoutImpl: timers.clearTimeout,
      fetchImpl: async () => {
        fetchCalls += 1;
        if (fetchCalls === 1) {
          return streamingJsonResponse(JSON.stringify({ jobId: "job-budget" }), {
            status: 202,
          });
        }
        if (fetchCalls === 2) now = 88_000;
        else now = 90_000;
        return streamingJsonResponse(JSON.stringify({ status: "active" }), {
          status: 200,
        });
      },
    },
  );

  assert.equal(result.code, "REQUEST_TIMEOUT");
  assert.ok(timers.createdDelays().includes(1_000));
  assert.equal(fetchCalls, 3);
});

test("poll rechecks the absolute deadline after an asynchronous dispatch guard", async () => {
  const helpers = loadTranscriptProviderHelpers();
  let now = 0;
  let fetchCalls = 0;
  let guardCalls = 0;
  const result = await helpers.handleFetchTranscript(
    "abc123",
    providerStorage(),
    async () => {
      guardCalls += 1;
      if (guardCalls === 2) now = 90_001;
      return true;
    },
    {
      now: () => now,
      sleep: async () => {},
      fetchImpl: async () => {
        fetchCalls += 1;
        return fetchCalls === 1
          ? streamingJsonResponse(JSON.stringify({ jobId: "job-guard" }), {
              status: 202,
            })
          : streamingJsonResponse(JSON.stringify({ status: "active" }), {
              status: 200,
            });
      },
    },
  );

  assert.equal(result.code, "REQUEST_TIMEOUT");
  assert.equal(fetchCalls, 1);
});

test("poll timeout uses the budget remaining after its dispatch guard", async () => {
  const timers = createManualTimers();
  const helpers = loadTranscriptProviderHelpers();
  let now = 0;
  let fetchCalls = 0;
  let guardCalls = 0;
  const result = await helpers.handleFetchTranscript(
    "abc123",
    providerStorage(),
    async () => {
      guardCalls += 1;
      if (guardCalls === 2) now = 89_500;
      return true;
    },
    {
      now: () => now,
      sleep: async () => {},
      setTimeoutImpl: timers.setTimeout,
      clearTimeoutImpl: timers.clearTimeout,
      fetchImpl: async () => {
        fetchCalls += 1;
        if (fetchCalls === 1) {
          return streamingJsonResponse(JSON.stringify({ jobId: "job-clamp" }), {
            status: 202,
          });
        }
        now = 90_000;
        return streamingJsonResponse(JSON.stringify({ status: "active" }), {
          status: 200,
        });
      },
    },
  );

  assert.equal(result.code, "REQUEST_TIMEOUT");
  assert.ok(timers.createdDelays().includes(500));
  assert.equal(timers.createdDelays().includes(15_000), false);
});
