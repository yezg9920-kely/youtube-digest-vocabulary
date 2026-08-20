const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const persistence = require("../persistence.js");

const {
  STORAGE_KEYS,
  DIGEST_PREFIX,
  DIGEST_BUDGET_BYTES,
  OVERVIEW_ATTEMPT_PREFIX,
  OVERVIEW_ATTEMPT_TTL_MS,
  OVERVIEW_CLAIM_LEASE_MS,
  normalizeEpoch,
  summarizeStoredData,
  listResettableKeys,
  createMutationCoordinator,
} = persistence;

const OVERVIEW_NOW = 1_800_000_000_000;
const OVERVIEW_FINGERPRINT = `sha256-v1-${"a".repeat(64)}`;
const OTHER_OVERVIEW_FINGERPRINT = `sha256-v1-${"b".repeat(64)}`;

function basicOverview(fingerprint = OVERVIEW_FINGERPRINT) {
  return {
    schemaVersion: 1,
    transcriptFingerprint: fingerprint,
    generatedAt: OVERVIEW_NOW,
    oneSentenceZh: "可靠的基础概览。",
    conclusions: [],
    chapters: [],
    complete: false,
  };
}

function overviewDigest({
  fingerprint = OVERVIEW_FINGERPRINT,
  timestamp = OVERVIEW_NOW - 1000,
  ...overrides
} = {}) {
  return {
    digestSchemaVersion: 2,
    transcript: [{ text: "source", start: 0, duration: 2 }],
    transcriptSegments: [{ id: "segment-0-0", text: "source", start: 0 }],
    transcriptText: "source",
    transcriptTimestamped: "[0:00] source",
    transcriptLanguage: "en",
    transcriptFingerprint: fingerprint,
    analysis: { legacy: true },
    deepAnalysis: { schemaVersion: 2, reportComplete: true },
    paragraphCache: { translated: "译文" },
    videoTitle: "Title",
    channelName: "Channel",
    timestamp,
    futureField: { keep: true },
    ...overrides,
  };
}

function digestBase({
  fingerprint = OVERVIEW_FINGERPRINT,
  transcript = [{ text: "source", start: 0, duration: 2 }],
  ...overrides
} = {}) {
  return {
    transcript,
    transcriptText: "source",
    transcriptTimestamped: "[0:00] source",
    transcriptLanguage: "en",
    transcriptFingerprint: fingerprint,
    videoTitle: "Title",
    channelName: "Channel",
    ...overrides,
  };
}

function completeDeepAnalysis(marker = "deep") {
  return {
    schemaVersion: 2,
    reportComplete: true,
    summary: {
      oneSentenceZh: marker,
      executiveSummaryZh: `${marker}-executive`,
      coreThesisZh: `${marker}-thesis`,
      whyItMattersZh: `${marker}-why`,
    },
  };
}

function digestV2({
  fingerprint = OVERVIEW_FINGERPRINT,
  timestamp = OVERVIEW_NOW - 1_000,
  ...overrides
} = {}) {
  return {
    digestSchemaVersion: 2,
    ...digestBase({ fingerprint }),
    timestamp,
    ...overrides,
  };
}

function overviewClaim(
  intent = "automatic",
  {
    videoId = "abc123",
    transcriptFingerprint = OVERVIEW_FINGERPRINT,
    attemptId = `overview-${intent}-1`,
  } = {},
) {
  return { videoId, transcriptFingerprint, attemptId, intent };
}

function overviewAttemptKey(
  videoId = "abc123",
  fingerprint = OVERVIEW_FINGERPRINT,
) {
  return `${OVERVIEW_ATTEMPT_PREFIX}${videoId}_${fingerprint}`;
}

const utf8Bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const entryBytes = (key, value) =>
  Buffer.byteLength(key, "utf8") + utf8Bytes(value);

async function settleWithin(promise, timeoutMs = 100) {
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

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createStorage(
  initial = {},
  {
    withGetBytesInUse = true,
    onGet,
    afterGet,
    onSet,
    onRemove,
    onGetBytesInUse,
  } = {},
) {
  const state = { ...initial };
  const events = [];
  const byteQueries = [];

  function selectedKeys(query) {
    if (query === null || query === undefined) return Object.keys(state);
    if (typeof query === "string") return [query];
    if (Array.isArray(query)) return query;
    if (query && typeof query === "object") return Object.keys(query);
    return [];
  }

  const storage = {
    state,
    events,
    byteQueries,
    async get(query) {
      events.push({ type: "get", query });
      if (onGet) await onGet(query, storage);
      const result = {};
      for (const key of selectedKeys(query)) {
        if (Object.hasOwn(state, key)) result[key] = state[key];
        else if (query && !Array.isArray(query) && typeof query === "object") {
          result[key] = query[key];
        }
      }
      if (afterGet) await afterGet(query, storage, result);
      return result;
    },
    async set(items) {
      events.push({ type: "set", keys: Object.keys(items).sort() });
      if (onSet && (await onSet(items, storage)) === true) return;
      Object.assign(state, items);
    },
    async remove(keys) {
      const normalized = (Array.isArray(keys) ? keys : [keys]).slice().sort();
      events.push({ type: "remove", keys: normalized });
      if (onRemove) {
        const handled = await onRemove(normalized, storage);
        if (handled === true) return;
      }
      for (const key of normalized) delete state[key];
    },
  };

  if (withGetBytesInUse) {
    storage.getBytesInUse = async (query) => {
      const keys = selectedKeys(query);
      byteQueries.push(keys.slice());
      if (onGetBytesInUse) {
        return onGetBytesInUse(keys.slice(), storage);
      }
      return keys.reduce(
        (total, key) =>
          total + (Object.hasOwn(state, key) ? entryBytes(key, state[key]) : 0),
        0,
      );
    };
  }

  return storage;
}

function zeroSummary() {
  return {
    settings: 0,
    providerStatus: 0,
    digests: 0,
    translations: 0,
    notes: 0,
    vocabulary: 0,
  };
}

test("exports the durable storage contract for the classic extension runtime", () => {
  assert.deepEqual(STORAGE_KEYS, {
    settings: "ytd_settings",
    providerStatus: "ytd_provider_status",
    notes: "ytd_notes",
    vocabulary: "ytd_vocabulary",
    language: "ytd_options_language",
    resetEpoch: "ytd_reset_epoch",
  });
  assert.equal(DIGEST_PREFIX, "digest_");
  assert.equal(DIGEST_BUDGET_BYTES, 8 * 1024 * 1024);
});

test("classic-script loading exposes YTD_PERSISTENCE without CommonJS", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "..", "persistence.js"),
    "utf8",
  );
  const context = {};
  vm.createContext(context);
  vm.runInContext(source, context);

  assert.equal(typeof context.YTD_PERSISTENCE, "object");
  assert.equal(
    typeof context.YTD_PERSISTENCE.createMutationCoordinator,
    "function",
  );
  const coordinator = context.YTD_PERSISTENCE.createMutationCoordinator({
    get: async () => ({}),
    set: async () => {},
    remove: async () => {},
  });
  assert.equal(typeof coordinator.commitCurrent, "function");
  assert.equal(context.YTD_PERSISTENCE.DIGEST_PREFIX, "digest_");
});

test("normalizes only durable nonnegative safe-integer reset epochs", () => {
  assert.equal(normalizeEpoch(0), 0);
  assert.equal(normalizeEpoch(42), 42);
  for (const value of [-1, 1.5, "2", Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(normalizeEpoch(value), 0, String(value));
  }
});

test("summarizes every reset category including paragraph-cache translations", () => {
  const summary = summarizeStoredData({
    [STORAGE_KEYS.settings]: {},
    [STORAGE_KEYS.providerStatus]: { deepseek: { state: "connected" } },
    digest_first: {
      paragraphCache: { "v:0": "一", "v:1": "二" },
    },
    digest_second: {
      paragraphCache: { "v:2": { text: "三" } },
    },
    [STORAGE_KEYS.notes]: [{ id: "n1" }, { id: "n2" }],
    [STORAGE_KEYS.vocabulary]: {
      schemaVersion: 2,
      entries: [{ id: "v1" }, { id: "v2" }, { id: "v3" }],
    },
  });

  assert.deepEqual(summary, {
    settings: 1,
    providerStatus: 1,
    digests: 2,
    translations: 3,
    notes: 2,
    vocabulary: 3,
  });
});

test("summary counts large sparse note and vocabulary arrays exactly", () => {
  const notes = new Array(1_000_003);
  const entries = new Array(1_000_007);

  assert.deepEqual(
    summarizeStoredData({
      [STORAGE_KEYS.notes]: notes,
      [STORAGE_KEYS.vocabulary]: { entries },
    }),
    {
      ...zeroSummary(),
      notes: 1_000_003,
      vocabulary: 1_000_007,
    },
  );
});

test("summary helpers stay finite and do not execute hostile getters", () => {
  const throwingProxy = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("do not inspect me");
      },
    },
  );
  const all = {};
  Object.defineProperty(all, STORAGE_KEYS.notes, {
    enumerable: true,
    get() {
      throw new Error("do not call getter");
    },
  });
  all.digest_hostile = { paragraphCache: throwingProxy };
  all[STORAGE_KEYS.vocabulary] = { entries: { length: Infinity } };

  assert.deepEqual(summarizeStoredData(null), zeroSummary());
  assert.deepEqual(summarizeStoredData(throwingProxy), zeroSummary());
  assert.deepEqual(summarizeStoredData(all), {
    ...zeroSummary(),
    digests: 1,
  });
});

test("reset targets are deterministic and preserve only language and epoch", () => {
  assert.deepEqual(
    listResettableKeys({
      z_legacy: true,
      [STORAGE_KEYS.language]: "zh-CN",
      digest_b: {},
      [STORAGE_KEYS.resetEpoch]: 3,
      a_legacy: true,
    }),
    ["a_legacy", "digest_b", "z_legacy"],
  );
  assert.deepEqual(listResettableKeys(null), []);
  assert.deepEqual(
    listResettableKeys(
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("hostile");
          },
        },
      ),
    ),
    [],
  );
});

test("reset rejects a late write holding the old durable epoch", async () => {
  const storage = createStorage({
    [STORAGE_KEYS.language]: "zh-CN",
    [STORAGE_KEYS.resetEpoch]: 7,
    [STORAGE_KEYS.settings]: { aiApiKey: "secret" },
  });
  const coordinator = createMutationCoordinator(storage);
  const oldEpoch = await coordinator.captureEpoch();
  const reset = await coordinator.resetExtensionData();
  let called = false;
  const late = await coordinator.commit(oldEpoch, async (store) => {
    called = true;
    await store.set({ [STORAGE_KEYS.vocabulary]: [{ id: "late" }] });
  });

  assert.equal(reset.success, true);
  assert.equal(reset.resetEpoch, 8);
  assert.equal(late.success, false);
  assert.equal(late.code, "RESET_DURING_REQUEST");
  assert.equal(called, false);
  assert.deepEqual(Object.keys(storage.state).sort(), [
    STORAGE_KEYS.language,
    STORAGE_KEYS.resetEpoch,
  ].sort());
});

test("reset refuses an exhausted epoch without changing or deleting data", async () => {
  const initial = {
    [STORAGE_KEYS.language]: "zh-CN",
    [STORAGE_KEYS.resetEpoch]: Number.MAX_SAFE_INTEGER,
    [STORAGE_KEYS.settings]: { keep: true },
    digest_keep: { timestamp: 1 },
  };
  const storage = createStorage(initial);
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.resetExtensionData();

  assert.deepEqual(result, {
    success: false,
    code: "RESET_EPOCH_EXHAUSTED",
  });
  assert.deepEqual(storage.state, initial);
  assert.equal(storage.events.some((event) => event.type === "set"), false);
  assert.equal(storage.events.some((event) => event.type === "remove"), false);
});

test("commit serializes a delayed save before a queued delete", async () => {
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    [STORAGE_KEYS.notes]: [{ id: "old" }],
  });
  const coordinator = createMutationCoordinator(storage);
  let releaseSave;
  const saveGate = new Promise((resolve) => {
    releaseSave = resolve;
  });
  const order = [];

  const save = coordinator.commit(0, async (store) => {
    order.push("save:start");
    const snapshot = await store.get(STORAGE_KEYS.notes);
    await saveGate;
    await store.set({
      [STORAGE_KEYS.notes]: [...snapshot[STORAGE_KEYS.notes], { id: "new" }],
    });
    order.push("save:end");
    return "saved";
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["save:start"]);

  // This is a normal external call made while the first async operation is
  // suspended. It must queue, not trip the synchronous reentry guard.
  const remove = coordinator.commit(0, async (store) => {
    order.push("delete:start");
    const snapshot = await store.get(STORAGE_KEYS.notes);
    await store.set({
      [STORAGE_KEYS.notes]: snapshot[STORAGE_KEYS.notes].filter(
        (note) => note.id !== "old",
      ),
    });
    order.push("delete:end");
    return "deleted";
  });

  assert.deepEqual(order, ["save:start"]);
  releaseSave();
  assert.deepEqual(await save, { success: true, value: "saved" });
  assert.deepEqual(await remove, { success: true, value: "deleted" });
  assert.deepEqual(order, [
    "save:start",
    "save:end",
    "delete:start",
    "delete:end",
  ]);
  assert.deepEqual(storage.state[STORAGE_KEYS.notes], [{ id: "new" }]);
});

test("commitCurrent owns one FIFO slot before a later digest commit", async () => {
  let epochReads = 0;
  let releaseFirstEpochRead;
  const firstEpochRead = new Promise((resolve) => {
    releaseFirstEpochRead = resolve;
  });
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_before: { timestamp: 1, text: "old" },
    },
    {
      async onGet(query) {
        if (query !== STORAGE_KEYS.resetEpoch) return;
        epochReads += 1;
        if (epochReads === 1) await firstEpochRead;
      },
    },
  );
  const coordinator = createMutationCoordinator(storage);
  assert.equal(typeof coordinator.commitCurrent, "function");

  const clear = coordinator.commitCurrent(async (store) => {
    const all = await store.get(null);
    const digestKeys = Object.keys(all).filter((key) =>
      key.startsWith(DIGEST_PREFIX),
    );
    await store.remove(digestKeys);
    return { removedCount: digestKeys.length };
  });
  const persist = coordinator.commitDigest(0, "after-clear", {
    timestamp: 2,
    text: "new",
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(storage.events, [
    { type: "get", query: STORAGE_KEYS.resetEpoch },
  ]);
  releaseFirstEpochRead();

  assert.deepEqual(await clear, {
    success: true,
    value: { removedCount: 1 },
  });
  assert.equal((await persist).success, true);
  assert.equal(Object.hasOwn(storage.state, "digest_before"), false);
  assert.deepEqual(storage.state["digest_after-clear"], {
    timestamp: 2,
    text: "new",
  });
});

test("commitCurrent rejects synchronous reentry and recovers after errors", async () => {
  const storage = createStorage({ [STORAGE_KEYS.resetEpoch]: 0 });
  const coordinator = createMutationCoordinator(storage);
  assert.equal(typeof coordinator.commitCurrent, "function");

  const reentry = await settleWithin(
    coordinator.commitCurrent(() => coordinator.captureEpoch()),
  );
  assert.equal(reentry.kind, "rejected");
  assert.equal(reentry.error.code, "COORDINATOR_REENTRANCY_FORBIDDEN");

  await assert.rejects(
    coordinator.commitCurrent(async () => {
      throw new Error("operation failed");
    }),
    /operation failed/,
  );

  let receivedStorage;
  let receivedArgumentCount;
  const recovered = await coordinator.commitCurrent(function (store) {
    receivedStorage = store;
    receivedArgumentCount = arguments.length;
    return "recovered";
  });
  assert.deepEqual(recovered, { success: true, value: "recovered" });
  assert.equal(receivedStorage, storage);
  assert.equal(receivedArgumentCount, 1);
});

test("commit, reset, and digest writes share one deferred epoch FIFO", async () => {
  let epochReads = 0;
  let releaseFirstEpochRead;
  const firstEpochRead = new Promise((resolve) => {
    releaseFirstEpochRead = resolve;
  });
  const storage = createStorage(
    { [STORAGE_KEYS.resetEpoch]: 0 },
    {
      async onGet(query) {
        if (query !== STORAGE_KEYS.resetEpoch) return;
        epochReads += 1;
        if (epochReads === 1) await firstEpochRead;
      },
    },
  );
  const coordinator = createMutationCoordinator(storage);

  const commit = coordinator.commit(0, async (store) => {
    await store.set({ [STORAGE_KEYS.notes]: [{ id: "queued" }] });
    return "committed";
  });
  const reset = coordinator.resetExtensionData();
  const digest = coordinator.commitDigest(0, "queued-video", {
    timestamp: 1,
    text: "stale",
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(storage.events, [
    { type: "get", query: STORAGE_KEYS.resetEpoch },
  ]);

  releaseFirstEpochRead();
  assert.deepEqual(await commit, { success: true, value: "committed" });
  assert.equal((await reset).success, true);
  assert.deepEqual(await digest, {
    success: false,
    code: "RESET_DURING_REQUEST",
  });
  assert.equal(Object.hasOwn(storage.state, "digest_queued-video"), false);
  assert.deepEqual(
    storage.events.map((event) => {
      if (event.type === "get") {
        return `get:${event.query === null ? "all" : event.query}`;
      }
      return `${event.type}:${event.keys.join(",")}`;
    }),
    [
      `get:${STORAGE_KEYS.resetEpoch}`,
      `set:${STORAGE_KEYS.notes}`,
      "get:all",
      `set:${STORAGE_KEYS.resetEpoch}`,
      `remove:${STORAGE_KEYS.notes}`,
      "get:all",
      `get:${STORAGE_KEYS.resetEpoch}`,
    ],
  );
});

test("direct coordinator reentry fails fast instead of deadlocking the FIFO", async () => {
  const storage = createStorage({ [STORAGE_KEYS.resetEpoch]: 0 });
  const coordinator = createMutationCoordinator(storage);

  const outcome = await settleWithin(
    coordinator.commit(0, () => coordinator.captureEpoch()),
  );

  assert.equal(outcome.kind, "rejected");
  assert.equal(outcome.error.code, "COORDINATOR_REENTRANCY_FORBIDDEN");
  assert.match(outcome.error.message, /must not call its coordinator/i);
  assert.deepEqual(await coordinator.commit(0, async () => "recovered"), {
    success: true,
    value: "recovered",
  });
});

test("async callback reentry before its first suspension fails fast", async () => {
  const storage = createStorage({ [STORAGE_KEYS.resetEpoch]: 0 });
  const coordinator = createMutationCoordinator(storage);

  const outcome = await settleWithin(
    coordinator.commit(0, async () => {
      await coordinator.resetExtensionData();
    }),
  );

  assert.equal(outcome.kind, "rejected");
  assert.equal(outcome.error.code, "COORDINATOR_REENTRANCY_FORBIDDEN");
  assert.deepEqual(await coordinator.commit(0, async () => "recovered"), {
    success: true,
    value: "recovered",
  });
});

test("a mutation completed before reset is subsequently cleared", async () => {
  const storage = createStorage({
    [STORAGE_KEYS.language]: "en",
    [STORAGE_KEYS.resetEpoch]: 2,
  });
  const coordinator = createMutationCoordinator(storage);
  let releaseMutation;
  const gate = new Promise((resolve) => {
    releaseMutation = resolve;
  });

  const mutation = coordinator.commit(2, async (store) => {
    await gate;
    await store.set({ [STORAGE_KEYS.notes]: [{ id: "before-reset" }] });
  });
  const reset = coordinator.resetExtensionData();
  releaseMutation();

  assert.equal((await mutation).success, true);
  assert.equal((await reset).success, true);
  assert.deepEqual(storage.state, {
    [STORAGE_KEYS.language]: "en",
    [STORAGE_KEYS.resetEpoch]: 3,
  });
});

test("reset clears unknown historical keys and returns the exact pre-reset summary", async () => {
  const storage = createStorage({
    [STORAGE_KEYS.language]: "zh-CN",
    [STORAGE_KEYS.resetEpoch]: 0,
    [STORAGE_KEYS.settings]: {},
    [STORAGE_KEYS.providerStatus]: {},
    [STORAGE_KEYS.notes]: [{ id: "n" }],
    [STORAGE_KEYS.vocabulary]: { entries: [{ id: "v" }] },
    digest_video: { paragraphCache: { p1: "译文" } },
    retired_schema_key: { anything: true },
  });
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.resetExtensionData();

  assert.deepEqual(result, {
    success: true,
    resetEpoch: 1,
    summary: {
      settings: 1,
      providerStatus: 1,
      digests: 1,
      translations: 1,
      notes: 1,
      vocabulary: 1,
    },
  });
  assert.deepEqual(storage.state, {
    [STORAGE_KEYS.language]: "zh-CN",
    [STORAGE_KEYS.resetEpoch]: 1,
  });
  const resetEvents = storage.events.map((event) => {
    if (event.type === "get") {
      return `get:${event.query === null ? "all" : event.query}`;
    }
    return `${event.type}:${event.keys.join(",")}`;
  });
  assert.equal(resetEvents[0], "get:all");
  assert.equal(resetEvents[1], `set:${STORAGE_KEYS.resetEpoch}`);
  assert.match(resetEvents[2], /^remove:/);
  assert.equal(resetEvents.at(-1), "get:all");
});

test("reset reports bounded verification failure when a target remains", async () => {
  const storage = createStorage(
    {
      [STORAGE_KEYS.language]: "en",
      [STORAGE_KEYS.resetEpoch]: 0,
      stubborn_legacy_key: { value: true },
    },
    {
      onRemove(keys, target) {
        for (const key of keys) {
          if (key !== "stubborn_legacy_key") delete target.state[key];
        }
        return true;
      },
    },
  );
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.resetExtensionData();

  assert.deepEqual(result, {
    success: false,
    code: "RESET_VERIFICATION_FAILED",
    resetEpoch: 1,
    remainingKeys: ["stubborn_legacy_key"],
  });
});

test("reset bounds the combined residual and epoch verification keys", async () => {
  const stubbornKeys = Object.fromEntries(
    Array.from({ length: 105 }, (_, index) => [
      `z_stubborn_${String(index).padStart(3, "0")}`,
      true,
    ]),
  );
  const storage = createStorage(
    {
      [STORAGE_KEYS.language]: "en",
      [STORAGE_KEYS.resetEpoch]: 0,
      ...stubbornKeys,
    },
    {
      onSet(items) {
        if (Object.hasOwn(items, STORAGE_KEYS.resetEpoch)) {
          items[STORAGE_KEYS.resetEpoch] = 999;
        }
      },
      onRemove() {
        return true;
      },
    },
  );
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.resetExtensionData();

  assert.equal(result.success, false);
  assert.equal(result.code, "RESET_VERIFICATION_FAILED");
  assert.equal(result.remainingKeys.length, 100);
  assert.deepEqual(result.remainingKeys, [
    STORAGE_KEYS.resetEpoch,
    ...Array.from(
      { length: 99 },
      (_, index) => `z_stubborn_${String(index).padStart(3, "0")}`,
    ),
  ]);
});

test("reset set failure is typed, bounded, non-destructive, and queue-safe", async () => {
  const initial = {
    [STORAGE_KEYS.language]: "en",
    [STORAGE_KEYS.resetEpoch]: 4,
    [STORAGE_KEYS.settings]: { keep: true },
  };
  const storage = createStorage(initial, {
    onSet(items) {
      if (Object.hasOwn(items, STORAGE_KEYS.resetEpoch)) {
        throw new Error("secret epoch write payload");
      }
    },
  });
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.resetExtensionData();

  assert.deepEqual(result, {
    success: false,
    code: "RESET_STORAGE_FAILED",
    stage: "write_epoch",
  });
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.deepEqual(storage.state, initial);
  assert.deepEqual(await coordinator.commit(4, async () => "recovered"), {
    success: true,
    value: "recovered",
  });
});

test("reset remove failure is typed, bounded, and leaves the FIFO usable", async () => {
  const storage = createStorage(
    {
      [STORAGE_KEYS.language]: "en",
      [STORAGE_KEYS.resetEpoch]: 9,
      [STORAGE_KEYS.settings]: { remains: true },
    },
    {
      onRemove() {
        throw new Error("secret remove payload");
      },
    },
  );
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.resetExtensionData();

  assert.deepEqual(result, {
    success: false,
    code: "RESET_STORAGE_FAILED",
    stage: "remove_data",
    resetEpoch: 10,
  });
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(storage.state[STORAGE_KEYS.resetEpoch], 10);
  assert.equal(Object.hasOwn(storage.state, STORAGE_KEYS.settings), true);
  assert.deepEqual(await coordinator.commit(10, async () => "recovered"), {
    success: true,
    value: "recovered",
  });
});

test("reset initial read failure is typed and the FIFO recovers", async () => {
  let failInitialRead = true;
  const initial = {
    [STORAGE_KEYS.language]: "en",
    [STORAGE_KEYS.resetEpoch]: 3,
    [STORAGE_KEYS.settings]: { keep: true },
  };
  const storage = createStorage(initial, {
    onGet(query) {
      if (query === null && failInitialRead) {
        failInitialRead = false;
        throw new Error("secret initial read payload");
      }
    },
  });
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.resetExtensionData();

  assert.deepEqual(result, {
    success: false,
    code: "RESET_STORAGE_FAILED",
    stage: "read_before",
  });
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.deepEqual(storage.state, initial);
  assert.deepEqual(await coordinator.commit(3, async () => "recovered"), {
    success: true,
    value: "recovered",
  });
});

test("reset verification read failure is typed and the new-epoch FIFO recovers", async () => {
  let allReads = 0;
  const storage = createStorage(
    {
      [STORAGE_KEYS.language]: "zh-CN",
      [STORAGE_KEYS.resetEpoch]: 6,
      [STORAGE_KEYS.settings]: { remove: true },
    },
    {
      onGet(query) {
        if (query !== null) return;
        allReads += 1;
        if (allReads === 2) throw new Error("secret verification payload");
      },
    },
  );
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.resetExtensionData();

  assert.deepEqual(result, {
    success: false,
    code: "RESET_VERIFICATION_FAILED",
    stage: "verify",
    resetEpoch: 7,
    remainingKeys: [],
  });
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.deepEqual(storage.state, {
    [STORAGE_KEYS.language]: "zh-CN",
    [STORAGE_KEYS.resetEpoch]: 7,
  });
  assert.deepEqual(await coordinator.commit(7, async () => "recovered"), {
    success: true,
    value: "recovered",
  });
});

test("the FIFO continues after a synchronous or asynchronous operation throws", async () => {
  const storage = createStorage({ [STORAGE_KEYS.resetEpoch]: 0 });
  const coordinator = createMutationCoordinator(storage);

  await assert.rejects(
    coordinator.commit(0, () => {
      throw new Error("sync failure");
    }),
    /sync failure/,
  );
  await assert.rejects(
    coordinator.commit(0, async () => {
      throw new Error("async failure");
    }),
    /async failure/,
  );
  const recovered = await coordinator.commit(0, async (store) => {
    await store.set({ recovered: true });
    return 3;
  });

  assert.deepEqual(recovered, { success: true, value: 3 });
  assert.equal(storage.state.recovered, true);
});

test("commitDigest pre-evicts only digest data before an over-budget write", async () => {
  const oldKey = "digest_old-video";
  const newKey = "digest_new-video";
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    [STORAGE_KEYS.settings]: { large: "s".repeat(5 * 1024 * 1024) },
    [STORAGE_KEYS.providerStatus]: { deepseek: { state: "connected" } },
    [STORAGE_KEYS.notes]: [{ id: "note" }],
    [STORAGE_KEYS.vocabulary]: { entries: [{ id: "word" }] },
    [STORAGE_KEYS.language]: "zh-CN",
    unknown_non_digest: { large: "u".repeat(2 * 1024 * 1024) },
    [oldKey]: { timestamp: 1, text: "o".repeat(5 * 1024 * 1024) },
  });
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.commitDigest(0, "new-video", {
    timestamp: 2,
    text: "n".repeat(4 * 1024 * 1024),
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.evictedKeys, [oldKey]);
  assert.equal(Object.hasOwn(storage.state, oldKey), false);
  assert.equal(Object.hasOwn(storage.state, newKey), true);
  for (const key of [
    STORAGE_KEYS.settings,
    STORAGE_KEYS.providerStatus,
    STORAGE_KEYS.notes,
    STORAGE_KEYS.vocabulary,
    STORAGE_KEYS.language,
    STORAGE_KEYS.resetEpoch,
    "unknown_non_digest",
  ]) {
    assert.equal(Object.hasOwn(storage.state, key), true, key);
  }
  const removeIndex = storage.events.findIndex((event) => event.type === "remove");
  const digestSetIndex = storage.events.findIndex(
    (event) => event.type === "set" && event.keys.includes(newKey),
  );
  assert.ok(removeIndex >= 0 && removeIndex < digestSetIndex);
  assert.ok(
    storage.byteQueries.length > 0 &&
    storage.byteQueries.every((keys) =>
      keys.length > 0 && keys.every((key) => key.startsWith(DIGEST_PREFIX)),
    ),
  );
});

test("commitDigest bounds a rejected mutation validator and does not write", async () => {
  const storage = createStorage({ [STORAGE_KEYS.resetEpoch]: 0 });
  const coordinator = createMutationCoordinator(storage);
  let validationCalls = 0;

  const result = await coordinator.commitDigest(
    0,
    "guarded-video",
    { timestamp: 1 },
    async () => {
      validationCalls += 1;
      throw new Error("secret tab state");
    },
  );

  assert.deepEqual(result, {
    success: false,
    code: "SESSION_STALE",
    retryable: false,
    evictedKeys: [],
  });
  assert.equal(validationCalls, 1);
  assert.equal(Object.hasOwn(storage.state, "digest_guarded-video"), false);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("commitDigest validates immediately before planned eviction and first write", async () => {
  const order = [];
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      "digest_old-video": {
        timestamp: 1,
        text: "o".repeat(5 * 1024 * 1024),
      },
    },
    {
      onRemove() {
        order.push("remove");
      },
      onSet(items) {
        if (Object.hasOwn(items, "digest_new-video")) order.push("set");
      },
    },
  );
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.commitDigest(
    0,
    "new-video",
    { timestamp: 2, text: "n".repeat(4 * 1024 * 1024) },
    async () => {
      order.push("validate");
      return true;
    },
  );

  assert.equal(result.success, true);
  assert.deepEqual(order, ["validate", "remove", "validate", "set"]);
});

test("commitDigest revalidates before quota eviction and retry write", async () => {
  const order = [];
  let attempts = 0;
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_oldest: { timestamp: 1, text: "old" },
    },
    {
      onSet(items) {
        if (!Object.hasOwn(items, "digest_quota-guard")) return;
        order.push("set");
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("QUOTA_BYTES exceeded");
          error.name = "QuotaExceededError";
          throw error;
        }
      },
      onRemove() {
        order.push("remove");
      },
    },
  );
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.commitDigest(
    0,
    "quota-guard",
    { timestamp: 2, text: "new" },
    async () => {
      order.push("validate");
      return true;
    },
  );

  assert.equal(result.success, true);
  assert.deepEqual(order, [
    "validate",
    "set",
    "validate",
    "remove",
    "validate",
    "set",
  ]);
});

test("commitDigest bounds an initial epoch read rejection and recovers", async () => {
  let failEpochRead = true;
  const storage = createStorage(
    { [STORAGE_KEYS.resetEpoch]: 0 },
    {
      onGet(query) {
        if (query === STORAGE_KEYS.resetEpoch && failEpochRead) {
          failEpochRead = false;
          throw new Error("secret epoch read payload");
        }
      },
    },
  );
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.commitDigest(0, "epoch-read", {
    timestamp: 1,
  });

  assert.deepEqual(result, {
    success: false,
    code: "STORAGE_READ_FAILED",
    stage: "read_epoch",
    retryable: true,
    evictedKeys: [],
  });
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.deepEqual(await coordinator.commit(0, async () => "recovered"), {
    success: true,
    value: "recovered",
  });
});

test("commitDigest bounds a cache snapshot rejection and recovers", async () => {
  let failCacheRead = true;
  const storage = createStorage(
    { [STORAGE_KEYS.resetEpoch]: 0 },
    {
      onGet(query) {
        if (query === null && failCacheRead) {
          failCacheRead = false;
          throw new Error("secret cache snapshot payload");
        }
      },
    },
  );
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.commitDigest(0, "cache-read", {
    timestamp: 1,
  });

  assert.deepEqual(result, {
    success: false,
    code: "STORAGE_READ_FAILED",
    stage: "read_cache",
    retryable: true,
    evictedKeys: [],
  });
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.deepEqual(await coordinator.commit(0, async () => "recovered"), {
    success: true,
    value: "recovered",
  });
});

test("commitDigest returns a typed failure for an unmeasurable new value", async () => {
  const cyclic = { timestamp: 1, label: "secret cyclic value" };
  cyclic.self = cyclic;
  const storage = createStorage({ [STORAGE_KEYS.resetEpoch]: 0 });
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.commitDigest(0, "cyclic-new", cyclic);

  assert.deepEqual(result, {
    success: false,
    code: "DIGEST_ESTIMATE_FAILED",
    stage: "new_value",
    retryable: false,
    evictedKeys: [],
  });
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("commitDigest bounds fallback measurement failure for stored cache", async () => {
  const cyclic = { timestamp: 1, label: "secret stored value" };
  cyclic.self = cyclic;
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_cyclic: cyclic,
    },
    {
      onGetBytesInUse() {
        throw new Error("force fallback");
      },
    },
  );
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.commitDigest(0, "stored-new", {
    timestamp: 2,
  });

  assert.deepEqual(result, {
    success: false,
    code: "DIGEST_ESTIMATE_FAILED",
    stage: "stored_cache",
    retryable: false,
    evictedKeys: [],
  });
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("getBytesInUse measurements override a smaller JSON estimate", async () => {
  const apiMeasuredBytes = 7 * 1024 * 1024;
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      "digest_api-sized": { timestamp: 1, text: "tiny-json" },
    },
    {
      onGetBytesInUse(keys) {
        assert.ok(keys.length > 0);
        return keys.includes("digest_api-sized") ? apiMeasuredBytes : 0;
      },
    },
  );
  assert.ok(
    entryBytes("digest_api-sized", storage.state["digest_api-sized"]) <
      apiMeasuredBytes,
  );
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.commitDigest(0, "api-new", {
    timestamp: 2,
    text: "n".repeat(2 * 1024 * 1024),
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.evictedKeys, ["digest_api-sized"]);
  assert.ok(storage.byteQueries.length > 0);
  assert.ok(storage.byteQueries.every((keys) => keys.length > 0));
});

test("getBytesInUse measurements run with bounded parallelism", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const digests = Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [
      `digest_parallel-${String(index).padStart(2, "0")}`,
      { timestamp: index, text: "small" },
    ]),
  );
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      ...digests,
    },
    {
      async onGetBytesInUse(keys, target) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
        return keys.reduce(
          (total, key) => total + entryBytes(key, target.state[key]),
          0,
        );
      },
    },
  );
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.commitDigest(0, "parallel-new", {
    timestamp: 30,
    text: "small",
  });

  assert.equal(result.success, true);
  assert.ok(maxInFlight > 1, `Expected parallel reads, saw ${maxInFlight}`);
  assert.ok(maxInFlight <= 16, `Expected bounded reads, saw ${maxInFlight}`);
});

test("pre-eviction remove failure is typed without claiming an eviction", async () => {
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      "digest_remove-old": { timestamp: 1, text: "tiny-json" },
    },
    {
      onGetBytesInUse(keys) {
        return keys.includes("digest_remove-old") ? 7 * 1024 * 1024 : 0;
      },
      onRemove() {
        throw new Error("secret pre-eviction payload");
      },
    },
  );
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.commitDigest(0, "remove-new", {
    timestamp: 2,
    text: "n".repeat(2 * 1024 * 1024),
  });

  assert.deepEqual(result, {
    success: false,
    code: "STORAGE_WRITE_FAILED",
    retryable: true,
    evictedKeys: [],
  });
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(Object.hasOwn(storage.state, "digest_remove-old"), true);
  assert.deepEqual(await coordinator.commit(0, async () => "recovered"), {
    success: true,
    value: "recovered",
  });
});

test("pre-eviction no-op is verified and blocks the over-budget write", async () => {
  let digestWrites = 0;
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      "digest_noop-old": { timestamp: 1, text: "tiny-json" },
    },
    {
      onGetBytesInUse(keys) {
        return keys.includes("digest_noop-old") ? 7 * 1024 * 1024 : 0;
      },
      onRemove() {
        return true;
      },
      onSet(items) {
        if (Object.keys(items).some((key) => key.startsWith(DIGEST_PREFIX))) {
          digestWrites += 1;
        }
      },
    },
  );
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.commitDigest(0, "noop-new", {
    timestamp: 2,
    text: "n".repeat(2 * 1024 * 1024),
  });

  assert.deepEqual(result, {
    success: false,
    code: "DIGEST_EVICTION_FAILED",
    retryable: true,
    evictedKeys: [],
  });
  assert.equal(digestWrites, 0);
  assert.equal(Object.hasOwn(storage.state, "digest_noop-old"), true);
  assert.equal(Object.hasOwn(storage.state, "digest_noop-new"), false);
});

test("partial pre-eviction reports only deleted keys and blocks the write", async () => {
  let digestWrites = 0;
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      "digest_partial-a": { timestamp: 1, text: "a" },
      "digest_partial-b": { timestamp: 2, text: "b" },
      "digest_partial-c": { timestamp: 3, text: "c" },
    },
    {
      onGetBytesInUse(keys) {
        return keys.some((key) => key.startsWith(DIGEST_PREFIX))
          ? 3 * 1024 * 1024
          : 0;
      },
      onRemove(keys, target) {
        delete target.state[keys[0]];
        return true;
      },
      onSet(items) {
        if (Object.keys(items).some((key) => key.startsWith(DIGEST_PREFIX))) {
          digestWrites += 1;
        }
      },
    },
  );
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.commitDigest(0, "partial-new", {
    timestamp: 4,
    text: "n".repeat(3 * 1024 * 1024),
  });

  assert.deepEqual(result, {
    success: false,
    code: "DIGEST_EVICTION_FAILED",
    retryable: true,
    evictedKeys: ["digest_partial-a"],
  });
  assert.equal(digestWrites, 0);
  assert.equal(Object.hasOwn(storage.state, "digest_partial-a"), false);
  assert.equal(Object.hasOwn(storage.state, "digest_partial-b"), true);
  assert.equal(Object.hasOwn(storage.state, "digest_partial-new"), false);
});

test("rejected getBytesInUse falls back to UTF-8 cache sizing", async () => {
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      "digest_api-reject": {
        timestamp: 1,
        text: "a".repeat(7 * 1024 * 1024),
      },
    },
    {
      onGetBytesInUse() {
        throw new Error("bytes API unavailable");
      },
    },
  );
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.commitDigest(0, "reject-new", {
    timestamp: 2,
    text: "译".repeat(600_000),
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.evictedKeys, ["digest_api-reject"]);
  assert.ok(storage.byteQueries.length > 0);
});

test("invalid getBytesInUse values fall back to UTF-8 cache sizing", async () => {
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      "digest_api-invalid": {
        timestamp: 1,
        text: "a".repeat(7 * 1024 * 1024),
      },
    },
    {
      onGetBytesInUse() {
        return Number.NaN;
      },
    },
  );
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.commitDigest(0, "invalid-new", {
    timestamp: 2,
    text: "译".repeat(600_000),
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.evictedKeys, ["digest_api-invalid"]);
  assert.ok(storage.byteQueries.length > 0);
});

test("UTF-8 fallback counts multibyte cache content before writing", async () => {
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_ascii: {
        timestamp: 1,
        text: "a".repeat(7 * 1024 * 1024),
      },
    },
    { withGetBytesInUse: false },
  );
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.commitDigest(0, "utf8-new", {
    timestamp: 2,
    text: "译".repeat(600_000),
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.evictedKeys, ["digest_ascii"]);
  assert.equal(Object.hasOwn(storage.state, "digest_utf8-new"), true);
});

test("oldest-first cache eviction has a stable lexical timestamp tie-breaker", async () => {
  const chunk = "x".repeat(3 * 1024 * 1024);
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_zulu: { timestamp: 1, text: chunk },
      digest_alpha: { timestamp: 1, text: chunk },
      digest_later: { timestamp: 2, text: chunk },
    },
    { withGetBytesInUse: false },
  );
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.commitDigest(0, "newest", {
    timestamp: 3,
    text: chunk,
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.evictedKeys, ["digest_alpha", "digest_zulu"]);
  assert.equal(Object.hasOwn(storage.state, "digest_later"), true);
  assert.equal(Object.hasOwn(storage.state, "digest_newest"), true);
});

test("replacement byte accounting subtracts the previous value", async () => {
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_target: {
        timestamp: 1,
        text: "a".repeat(5 * 1024 * 1024),
      },
      digest_keep: {
        timestamp: 2,
        text: "b".repeat(2 * 1024 * 1024),
      },
    },
    { withGetBytesInUse: false },
  );
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.commitDigest(0, "target", {
    timestamp: 3,
    text: "c".repeat(4 * 1024 * 1024),
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.evictedKeys, []);
  assert.equal(Object.hasOwn(storage.state, "digest_keep"), true);
});

test("a digest larger than the entire budget is rejected without evicting caches", async () => {
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_keep: { timestamp: 1, text: "keep" },
    },
    { withGetBytesInUse: false },
  );
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.commitDigest(0, "too-large", {
    timestamp: 2,
    text: "x".repeat(DIGEST_BUDGET_BYTES + 1),
  });

  assert.deepEqual(result, {
    success: false,
    code: "DIGEST_CACHE_TOO_LARGE",
    retryable: false,
  });
  assert.equal(Object.hasOwn(storage.state, "digest_keep"), true);
  assert.equal(Object.hasOwn(storage.state, "digest_too-large"), false);
});

test("quota failure evicts one additional oldest digest and retries once", async () => {
  let attempts = 0;
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_oldest: { timestamp: 1, text: "old" },
      digest_newer: { timestamp: 2, text: "newer" },
      [STORAGE_KEYS.notes]: [{ id: "never-evict" }],
    },
    {
      async onSet(items) {
        if (!Object.keys(items).some((key) => key.startsWith(DIGEST_PREFIX))) return;
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("QUOTA_BYTES limit exceeded");
          error.name = "QuotaExceededError";
          throw error;
        }
      },
    },
  );
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.commitDigest(0, "quota-ok", {
    timestamp: 3,
    text: "result",
  });

  assert.equal(result.success, true);
  assert.equal(result.retriedAfterQuota, true);
  assert.equal(attempts, 2);
  assert.deepEqual(result.evictedKeys, ["digest_oldest"]);
  assert.equal(Object.hasOwn(storage.state, "digest_newer"), true);
  assert.equal(Object.hasOwn(storage.state, STORAGE_KEYS.notes), true);
});

test("replacement quota retry evicts another digest and never the target", async () => {
  let attempts = 0;
  const originalTarget = { timestamp: 1, text: "original target" };
  const replacement = { timestamp: 3, text: "replacement" };
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_replace: originalTarget,
      "digest_replace-other": { timestamp: 2, text: "other" },
    },
    {
      onSet(items) {
        if (!Object.hasOwn(items, "digest_replace")) return;
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("QUOTA_BYTES exceeded");
          error.name = "QuotaExceededError";
          throw error;
        }
      },
    },
  );
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.commitDigest(0, "replace", replacement);

  assert.equal(result.success, true);
  assert.equal(attempts, 2);
  assert.deepEqual(result.evictedKeys, ["digest_replace-other"]);
  assert.equal(result.evictedKeys.includes(result.key), false);
  assert.equal(result.key, "digest_replace");
  assert.deepEqual(storage.state.digest_replace, replacement);
});

test("replacement second quota failure preserves the old target", async () => {
  let attempts = 0;
  const originalTarget = { timestamp: 1, text: "original target" };
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_replace: originalTarget,
      "digest_replace-other": { timestamp: 2, text: "other" },
    },
    {
      onSet(items) {
        if (!Object.hasOwn(items, "digest_replace")) return;
        attempts += 1;
        const error = new Error("QUOTA_BYTES exceeded");
        error.name = "QuotaExceededError";
        throw error;
      },
    },
  );
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.commitDigest(0, "replace", {
    timestamp: 3,
    text: "replacement",
  });

  assert.deepEqual(result, {
    success: false,
    code: "STORAGE_QUOTA_EXCEEDED",
    retryable: true,
    evictedKeys: ["digest_replace-other"],
  });
  assert.equal(attempts, 2);
  assert.deepEqual(storage.state.digest_replace, originalTarget);
  assert.equal(Object.hasOwn(storage.state, "digest_replace-other"), false);
});

test("replacement quota failure without another digest preserves the target", async () => {
  let attempts = 0;
  let removeCalls = 0;
  const originalTarget = { timestamp: 1, text: "original target" };
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_replace: originalTarget,
    },
    {
      onSet(items) {
        if (!Object.hasOwn(items, "digest_replace")) return;
        attempts += 1;
        const error = new Error("QUOTA_BYTES exceeded");
        error.name = "QuotaExceededError";
        throw error;
      },
      onRemove() {
        removeCalls += 1;
      },
    },
  );
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.commitDigest(0, "replace", {
    timestamp: 2,
    text: "replacement",
  });

  assert.deepEqual(result, {
    success: false,
    code: "STORAGE_QUOTA_EXCEEDED",
    retryable: true,
    evictedKeys: [],
  });
  assert.equal(attempts, 1);
  assert.equal(removeCalls, 0);
  assert.deepEqual(storage.state.digest_replace, originalTarget);
});

test("quota failure without an eviction candidate does not retry the same write", async () => {
  let attempts = 0;
  const storage = createStorage(
    { [STORAGE_KEYS.resetEpoch]: 0 },
    {
      onSet(items) {
        if (!Object.keys(items).some((key) => key.startsWith(DIGEST_PREFIX))) return;
        attempts += 1;
        const error = new Error("QUOTA_BYTES exceeded");
        error.name = "QuotaExceededError";
        throw error;
      },
    },
  );
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.commitDigest(0, "quota-empty", {
    timestamp: 1,
    text: "value",
  });

  assert.deepEqual(result, {
    success: false,
    code: "STORAGE_QUOTA_EXCEEDED",
    retryable: true,
    evictedKeys: [],
  });
  assert.equal(attempts, 1);
  assert.equal(storage.events.some((event) => event.type === "remove"), false);
});

test("quota retry requires the selected digest to be verifiably evicted", async () => {
  let attempts = 0;
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_stubborn: { timestamp: 1, text: "old" },
    },
    {
      onSet(items) {
        if (!Object.keys(items).some((key) => key.startsWith(DIGEST_PREFIX))) return;
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("QUOTA_BYTES exceeded");
          error.name = "QuotaExceededError";
          throw error;
        }
      },
      onRemove() {
        return true;
      },
    },
  );
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.commitDigest(0, "quota-check", {
    timestamp: 2,
    text: "new",
  });

  assert.deepEqual(result, {
    success: false,
    code: "STORAGE_QUOTA_EXCEEDED",
    retryable: true,
    evictedKeys: [],
  });
  assert.equal(attempts, 1);
  assert.equal(Object.hasOwn(storage.state, "digest_stubborn"), true);
});

test("a second quota failure returns a bounded typed error without a third attempt", async () => {
  let attempts = 0;
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_oldest: { timestamp: 1, text: "old" },
      digest_newer: { timestamp: 2, text: "newer" },
      legacy_non_digest: { keep: true },
    },
    {
      async onSet(items) {
        if (!Object.keys(items).some((key) => key.startsWith(DIGEST_PREFIX))) return;
        attempts += 1;
        const error = new Error(`quota secret payload attempt ${attempts}`);
        error.name = "QuotaExceededError";
        throw error;
      },
    },
  );
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.commitDigest(0, "quota-fail", {
    timestamp: 3,
    text: "result",
  });

  assert.deepEqual(result, {
    success: false,
    code: "STORAGE_QUOTA_EXCEEDED",
    retryable: true,
    evictedKeys: ["digest_oldest"],
  });
  assert.equal(attempts, 2);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(Object.hasOwn(storage.state, "legacy_non_digest"), true);
});

test("non-quota write errors are not retried and the queue still recovers", async () => {
  let attempts = 0;
  const storage = createStorage(
    { [STORAGE_KEYS.resetEpoch]: 0 },
    {
      async onSet(items) {
        if (!Object.keys(items).some((key) => key.startsWith(DIGEST_PREFIX))) return;
        attempts += 1;
        throw new Error("quota telemetry endpoint unavailable");
      },
    },
  );
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.commitDigest(0, "write-fail", {
    timestamp: 1,
    text: "value",
  });
  assert.deepEqual(result, {
    success: false,
    code: "STORAGE_WRITE_FAILED",
    retryable: true,
    evictedKeys: [],
  });
  assert.equal(JSON.stringify(result).includes("telemetry"), false);
  assert.equal(attempts, 1);

  const recovered = await coordinator.commit(0, async () => "ok");
  assert.deepEqual(recovered, { success: true, value: "ok" });
});

test("a non-quota retry failure is typed after one successful quota eviction", async () => {
  let attempts = 0;
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      "digest_retry-old": { timestamp: 1, text: "old" },
    },
    {
      onSet(items) {
        if (!Object.keys(items).some((key) => key.startsWith(DIGEST_PREFIX))) return;
        attempts += 1;
        if (attempts === 1) {
          const quota = new Error("QUOTA_BYTES exceeded");
          quota.name = "QuotaExceededError";
          throw quota;
        }
        throw new Error("secret disk payload");
      },
    },
  );
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.commitDigest(0, "retry-new", {
    timestamp: 2,
    text: "new",
  });

  assert.deepEqual(result, {
    success: false,
    code: "STORAGE_WRITE_FAILED",
    retryable: true,
    evictedKeys: ["digest_retry-old"],
  });
  assert.equal(attempts, 2);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("failure envelopes cap actual evictions at 100 in stable oldest order", async () => {
  const bulkDigests = Object.fromEntries(
    Array.from({ length: 150 }, (_, index) => {
      const suffix = String(index).padStart(3, "0");
      return [
        `digest_bulk-${suffix}`,
        { timestamp: index, text: `cache-${suffix}` },
      ];
    }),
  );
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      ...bulkDigests,
    },
    {
      onGetBytesInUse() {
        return 100 * 1024;
      },
      onSet(items) {
        if (Object.keys(items).some((key) => key.startsWith(DIGEST_PREFIX))) {
          throw new Error("bounded secret payload");
        }
      },
    },
  );
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.commitDigest(0, "bulk-new", {
    timestamp: 200,
    text: "n".repeat(4 * 1024 * 1024),
  });

  const removed = storage.events.find((event) => event.type === "remove").keys;
  assert.ok(removed.length > 100);
  assert.deepEqual(result, {
    success: false,
    code: "STORAGE_WRITE_FAILED",
    retryable: true,
    evictedKeys: removed.slice(0, 100),
  });
  assert.equal(result.evictedKeys.length, 100);
  assert.deepEqual(
    result.evictedKeys,
    Array.from(
      { length: 100 },
      (_, index) => `digest_bulk-${String(index).padStart(3, "0")}`,
    ),
  );
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("success envelopes cap actual evictions at 100 in stable oldest order", async () => {
  const bulkDigests = Object.fromEntries(
    Array.from({ length: 150 }, (_, index) => {
      const suffix = String(index).padStart(3, "0");
      return [
        `digest_success-${suffix}`,
        { timestamp: index, text: `cache-${suffix}` },
      ];
    }),
  );
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      ...bulkDigests,
    },
    {
      onGetBytesInUse() {
        return 100 * 1024;
      },
    },
  );
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.commitDigest(0, "success-new", {
    timestamp: 200,
    text: "n".repeat(4 * 1024 * 1024),
  });

  const removed = storage.events.find((event) => event.type === "remove").keys;
  assert.ok(removed.length > 100);
  assert.equal(result.success, true);
  assert.equal(result.evictedKeys.length, 100);
  assert.deepEqual(result.evictedKeys, removed.slice(0, 100));
  assert.deepEqual(
    result.evictedKeys,
    Array.from(
      { length: 100 },
      (_, index) => `digest_success-${String(index).padStart(3, "0")}`,
    ),
  );
});

test("exports durable overview transaction constants and coordinator methods", () => {
  assert.equal(OVERVIEW_ATTEMPT_PREFIX, "ytd_overview_attempt_v1_");
  assert.equal(OVERVIEW_ATTEMPT_TTL_MS, 30 * 24 * 60 * 60 * 1000);
  assert.equal(OVERVIEW_CLAIM_LEASE_MS, 180_000);

  const coordinator = createMutationCoordinator(
    createStorage({ [STORAGE_KEYS.resetEpoch]: 0 }),
  );
  assert.equal(typeof coordinator.claimBasicOverview, "function");
  assert.equal(typeof coordinator.settleBasicOverview, "function");
});

test("concurrent automatic overview claims have one durable winner", async () => {
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: overviewDigest(),
  });
  const coordinator = createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  });

  const [first, second] = await Promise.all([
    coordinator.claimBasicOverview(0, overviewClaim("automatic", {
      attemptId: "overview-auto-a",
    })),
    coordinator.claimBasicOverview(0, overviewClaim("automatic", {
      attemptId: "overview-auto-b",
    })),
  ]);

  assert.deepEqual(
    [first.disposition, second.disposition].sort(),
    ["claimed", "inflight"],
  );
  const record = storage.state[overviewAttemptKey()];
  assert.equal(record.currentAttempt.status, "claimed");
  assert.ok(["overview-auto-a", "overview-auto-b"].includes(
    record.currentAttempt.id,
  ));
  assert.equal(record.firstClaimedAt, OVERVIEW_NOW);
  assert.equal(record.expiresAt, OVERVIEW_NOW + OVERVIEW_ATTEMPT_TTL_MS);
  assert.equal(
    record.currentAttempt.leaseUntil,
    OVERVIEW_NOW + OVERVIEW_CLAIM_LEASE_MS,
  );
});

test("a worker restart observes the durable automatic claim", async () => {
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: overviewDigest(),
  });
  const firstWorker = createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  });
  await firstWorker.claimBasicOverview(
    0,
    overviewClaim("automatic", { attemptId: "overview-before-restart" }),
  );

  const restartedWorker = createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW + 1,
  });
  const result = await restartedWorker.claimBasicOverview(
    0,
    overviewClaim("automatic", { attemptId: "overview-after-restart" }),
  );

  assert.equal(result.success, true);
  assert.equal(result.disposition, "inflight");
  assert.equal(
    storage.state[overviewAttemptKey()].currentAttempt.id,
    "overview-before-restart",
  );
});

test("automatic failure stays terminal while one manual retry takes ownership", async () => {
  let now = OVERVIEW_NOW;
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: overviewDigest(),
  });
  const coordinator = createMutationCoordinator(storage, { now: () => now });
  const automatic = overviewClaim("automatic", {
    attemptId: "overview-auto-failed",
  });
  const automaticClaim = await coordinator.claimBasicOverview(0, automatic);
  now += 1_000;
  const failed = await coordinator.settleBasicOverview(0, {
    ...automatic,
    attemptRevision: automaticClaim.attemptRevision,
    outcome: {
      type: "failure",
      failure: {
        code: "RATE_LIMITED",
        provider: "deepseek",
        stage: "overview",
        retryable: true,
        primaryAction: "retry_later",
        mayHaveConsumedCredit: true,
      },
    },
  });
  assert.equal(failed.disposition, "failed");

  const blocked = await coordinator.claimBasicOverview(
    0,
    overviewClaim("automatic", { attemptId: "overview-auto-duplicate" }),
  );
  assert.equal(blocked.disposition, "failed");

  const originalExpiresAt = storage.state[overviewAttemptKey()].expiresAt;
  now += 1_000;
  const [manualA, manualB] = await Promise.all([
    coordinator.claimBasicOverview(0, overviewClaim("manual_retry", {
      attemptId: "overview-manual-a",
    })),
    coordinator.claimBasicOverview(0, overviewClaim("manual_retry", {
      attemptId: "overview-manual-b",
    })),
  ]);
  assert.deepEqual(
    [manualA.disposition, manualB.disposition].sort(),
    ["claimed", "inflight"],
  );
  assert.equal(storage.state[overviewAttemptKey()].expiresAt, originalExpiresAt);
});

test("manual retry waits for an active lease and can replace an orphan claim", async () => {
  let now = OVERVIEW_NOW;
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: overviewDigest(),
  });
  const coordinator = createMutationCoordinator(storage, { now: () => now });
  const oldClaim = overviewClaim("automatic", {
    attemptId: "overview-orphan-old",
  });
  const oldClaimResult = await coordinator.claimBasicOverview(0, oldClaim);

  const active = await coordinator.claimBasicOverview(
    0,
    overviewClaim("manual_retry", { attemptId: "overview-too-early" }),
  );
  assert.equal(active.disposition, "inflight");

  now += OVERVIEW_CLAIM_LEASE_MS + 1;
  const automaticAfterLease = await coordinator.claimBasicOverview(
    0,
    overviewClaim("automatic", { attemptId: "overview-auto-after-lease" }),
  );
  assert.equal(automaticAfterLease.disposition, "interrupted");
  assert.equal(
    storage.state[overviewAttemptKey()].currentAttempt.id,
    "overview-orphan-old",
  );
  const replacement = overviewClaim("manual_retry", {
    attemptId: "overview-orphan-replacement",
  });
  const claimed = await coordinator.claimBasicOverview(0, replacement);
  assert.equal(claimed.disposition, "claimed");

  const late = await coordinator.settleBasicOverview(0, {
    ...oldClaim,
    attemptRevision: oldClaimResult.attemptRevision,
    outcome: { type: "success", overview: basicOverview() },
  });
  assert.equal(late.success, false);
  assert.equal(late.code, "OVERVIEW_ATTEMPT_MISMATCH");
  assert.equal(Object.hasOwn(storage.state.digest_abc123, "basicOverview"), false);
});

test("an unbounded claimed lease is corrupt instead of blocking recovery", async () => {
  let now = OVERVIEW_NOW;
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: overviewDigest(),
  });
  const coordinator = createMutationCoordinator(storage, { now: () => now });
  await coordinator.claimBasicOverview(
    0,
    overviewClaim("automatic", { attemptId: "overview-malformed-lease" }),
  );
  const record = storage.state[overviewAttemptKey()];
  record.currentAttempt.leaseUntil =
    record.currentAttempt.claimedAt + OVERVIEW_ATTEMPT_TTL_MS;
  now += OVERVIEW_CLAIM_LEASE_MS + 1;

  const result = await coordinator.claimBasicOverview(
    0,
    overviewClaim("manual_retry", { attemptId: "overview-recovery-blocked" }),
  );

  assert.deepEqual(result, {
    success: false,
    code: "OVERVIEW_ATTEMPT_CORRUPT",
    retryable: false,
  });
  assert.equal(record.currentAttempt.id, "overview-malformed-lease");
});

test("claim fails closed on an unexpired ledger from another reset epoch", async () => {
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: overviewDigest(),
  });
  const coordinator = createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  });
  const claimed = await coordinator.claimBasicOverview(
    0,
    overviewClaim("automatic", { attemptId: "overview-wrong-ledger-epoch" }),
  );
  const record = storage.state[overviewAttemptKey()];
  record.currentAttempt.resetEpoch = 1;
  record.firstClaimedAt += 100;
  record.expiresAt = record.firstClaimedAt + OVERVIEW_ATTEMPT_TTL_MS;
  record.currentAttempt.claimedAt += 100;
  record.currentAttempt.leaseUntil =
    record.currentAttempt.claimedAt + OVERVIEW_CLAIM_LEASE_MS;
  const before = structuredClone(record);

  const result = await coordinator.claimBasicOverview(
    0,
    overviewClaim("manual_retry", { attemptId: "overview-new-current-epoch" }),
  );

  assert.deepEqual(result, {
    success: false,
    code: "OVERVIEW_ATTEMPT_CORRUPT",
    retryable: false,
  });
  assert.deepEqual(storage.state[overviewAttemptKey()], before);

  const settlement = await coordinator.settleBasicOverview(0, {
    ...overviewClaim("automatic", {
      attemptId: "overview-wrong-ledger-epoch",
    }),
    attemptRevision: claimed.attemptRevision,
    outcome: { type: "failure", failure: { code: "RATE_LIMITED" } },
  });
  assert.deepEqual(settlement, {
    success: false,
    code: "OVERVIEW_ATTEMPT_CORRUPT",
    retryable: false,
  });
});

test("a matching cached overview bypasses the attempt ledger", async () => {
  const overview = basicOverview();
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: overviewDigest({ basicOverview: overview }),
  });
  const coordinator = createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  });

  const result = await coordinator.claimBasicOverview(
    0,
    overviewClaim("automatic"),
  );

  assert.equal(result.success, true);
  assert.equal(result.disposition, "cached");
  assert.deepEqual(result.overview, overview);
  assert.equal(Object.hasOwn(storage.state, overviewAttemptKey()), false);
});

test("a succeeded ledger without its result blocks automatic but permits manual recovery", async () => {
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: overviewDigest(),
  });
  const coordinator = createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  });
  const first = overviewClaim("automatic", { attemptId: "overview-result-lost" });
  const firstClaim = await coordinator.claimBasicOverview(0, first);
  await coordinator.settleBasicOverview(0, {
    ...first,
    attemptRevision: firstClaim.attemptRevision,
    outcome: { type: "success", overview: basicOverview() },
  });
  delete storage.state.digest_abc123.basicOverview;

  const automatic = await coordinator.claimBasicOverview(
    0,
    overviewClaim("automatic", { attemptId: "overview-result-auto" }),
  );
  assert.equal(automatic.disposition, "result_missing");

  const manual = await coordinator.claimBasicOverview(
    0,
    overviewClaim("manual_retry", { attemptId: "overview-result-manual" }),
  );
  assert.equal(manual.disposition, "claimed");
});

test("malformed unexpired overview ledgers fail closed", async () => {
  const key = overviewAttemptKey();
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: overviewDigest(),
    [key]: {
      schemaVersion: 999,
      expiresAt: OVERVIEW_NOW + OVERVIEW_ATTEMPT_TTL_MS,
      rawSecret: "must-not-leak",
    },
  });
  const coordinator = createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  });

  for (const intent of ["automatic", "manual_retry"]) {
    const result = await coordinator.claimBasicOverview(
      0,
      overviewClaim(intent, { attemptId: `overview-corrupt-${intent}` }),
    );
    assert.deepEqual(result, {
      success: false,
      code: "OVERVIEW_ATTEMPT_CORRUPT",
      retryable: false,
    });
    assert.equal(JSON.stringify(result).includes("secret"), false);
  }
  assert.deepEqual(storage.state[key].rawSecret, "must-not-leak");
});

test("overview ledgers with missing or invalid expiry fail closed", async () => {
  for (const [name, expiresAt] of [
    ["missing", undefined],
    ["nan", Number.NaN],
    ["string", String(OVERVIEW_NOW + OVERVIEW_ATTEMPT_TTL_MS)],
  ]) {
    const key = overviewAttemptKey();
    const record = { schemaVersion: 1, marker: name };
    if (expiresAt !== undefined) record.expiresAt = expiresAt;
    const storage = createStorage({
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_abc123: overviewDigest(),
      [key]: record,
    });
    const coordinator = createMutationCoordinator(storage, {
      now: () => OVERVIEW_NOW,
    });

    const result = await coordinator.claimBasicOverview(
      0,
      overviewClaim("automatic", { attemptId: `overview-${name}` }),
    );
    assert.equal(result.code, "OVERVIEW_ATTEMPT_CORRUPT", name);
    assert.deepEqual(storage.state[key], record, name);
  }
});

test("an expired ledger starts a new fixed thirty-day window", async () => {
  let now = OVERVIEW_NOW;
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: overviewDigest(),
  });
  const coordinator = createMutationCoordinator(storage, { now: () => now });
  await coordinator.claimBasicOverview(
    0,
    overviewClaim("automatic", { attemptId: "overview-window-one" }),
  );

  now += OVERVIEW_ATTEMPT_TTL_MS + 1;
  storage.state.digest_abc123.timestamp = now;
  const result = await coordinator.claimBasicOverview(
    0,
    overviewClaim("automatic", { attemptId: "overview-window-two" }),
  );

  assert.equal(result.disposition, "claimed");
  assert.equal(result.attemptRevision, 2);
  const record = storage.state[overviewAttemptKey()];
  assert.equal(record.firstClaimedAt, now);
  assert.equal(record.expiresAt, now + OVERVIEW_ATTEMPT_TTL_MS);
  assert.equal(record.currentAttempt.id, "overview-window-two");
  assert.equal(record.currentAttempt.revision, 2);
});

test("an expired malformed ledger preserves revision lineage before recovery", async () => {
  const key = overviewAttemptKey();
  const reusedClaim = overviewClaim("automatic", {
    attemptId: "overview-expired-malformed-reused",
  });
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: overviewDigest(),
    [key]: {
      schemaVersion: 999,
      expiresAt: OVERVIEW_NOW - 1,
      currentAttempt: {
        id: reusedClaim.attemptId,
        revision: 1,
        leaseUntil: OVERVIEW_NOW - 1,
      },
      rawSecret: "discard-on-recovery",
    },
  });
  const coordinator = createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  });

  const recovered = await coordinator.claimBasicOverview(0, reusedClaim);

  assert.equal(recovered.success, true);
  assert.equal(recovered.disposition, "claimed");
  assert.equal(recovered.attemptRevision, 2);
  assert.equal(storage.state[key].currentAttempt.revision, 2);
  assert.equal(JSON.stringify(storage.state[key]).includes("rawSecret"), false);
  const late = await coordinator.settleBasicOverview(0, {
    ...reusedClaim,
    attemptRevision: 1,
    outcome: { type: "success", overview: basicOverview() },
  });
  assert.equal(late.code, "OVERVIEW_ATTEMPT_MISMATCH");
  assert.equal(Object.hasOwn(storage.state.digest_abc123, "basicOverview"), false);
});

test("an expired malformed ledger without safe revision lineage fails closed", async () => {
  for (const [name, revision, expectedCode] of [
    ["missing", undefined, "OVERVIEW_ATTEMPT_CORRUPT"],
    ["zero", 0, "OVERVIEW_ATTEMPT_CORRUPT"],
    ["string", "7", "OVERVIEW_ATTEMPT_CORRUPT"],
    [
      "exhausted",
      Number.MAX_SAFE_INTEGER,
      "OVERVIEW_ATTEMPT_REVISION_EXHAUSTED",
    ],
  ]) {
    const key = overviewAttemptKey();
    const currentAttempt = { leaseUntil: OVERVIEW_NOW - 1 };
    if (revision !== undefined) currentAttempt.revision = revision;
    const rawRecord = {
      schemaVersion: 999,
      expiresAt: OVERVIEW_NOW - 1,
      currentAttempt,
      marker: name,
    };
    const storage = createStorage({
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_abc123: overviewDigest(),
      [key]: rawRecord,
    });
    const coordinator = createMutationCoordinator(storage, {
      now: () => OVERVIEW_NOW,
    });

    const result = await coordinator.claimBasicOverview(
      0,
      overviewClaim("automatic", {
        attemptId: `overview-expired-malformed-${name}`,
      }),
    );

    assert.deepEqual(
      result,
      { success: false, code: expectedCode, retryable: false },
      name,
    );
    assert.deepEqual(storage.state[key], rawRecord, name);
  }
});

test("terminal overview ledgers fail closed on impossible chronology", async () => {
  const makeFixture = () => {
    const storage = createStorage({
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_abc123: overviewDigest(),
    });
    return {
      storage,
      coordinator: createMutationCoordinator(storage, {
        now: () => OVERVIEW_NOW,
      }),
    };
  };

  const failed = makeFixture();
  const failureClaim = overviewClaim("automatic", {
    attemptId: "overview-impossible-failure-time",
  });
  const failureClaimed = await failed.coordinator.claimBasicOverview(
    0,
    failureClaim,
  );
  await failed.coordinator.settleBasicOverview(0, {
    ...failureClaim,
    attemptRevision: failureClaimed.attemptRevision,
    outcome: { type: "failure", failure: { code: "RATE_LIMITED" } },
  });
  const failedAttempt =
    failed.storage.state[overviewAttemptKey()].currentAttempt;
  failedAttempt.finishedAt = failedAttempt.claimedAt - 1;
  const badFailure = await failed.coordinator.claimBasicOverview(
    0,
    overviewClaim("automatic", { attemptId: "overview-after-bad-failure" }),
  );
  assert.equal(badFailure.code, "OVERVIEW_ATTEMPT_CORRUPT");

  const succeeded = makeFixture();
  const successClaim = overviewClaim("automatic", {
    attemptId: "overview-impossible-generated-time",
  });
  const successClaimed = await succeeded.coordinator.claimBasicOverview(
    0,
    successClaim,
  );
  await succeeded.coordinator.settleBasicOverview(0, {
    ...successClaim,
    attemptRevision: successClaimed.attemptRevision,
    outcome: { type: "success", overview: basicOverview() },
  });
  const succeededAttempt =
    succeeded.storage.state[overviewAttemptKey()].currentAttempt;
  succeededAttempt.generatedAt = succeededAttempt.finishedAt + 1;
  delete succeeded.storage.state.digest_abc123.basicOverview;
  const badSuccess = await succeeded.coordinator.claimBasicOverview(
    0,
    overviewClaim("automatic", { attemptId: "overview-after-bad-success" }),
  );
  assert.equal(badSuccess.code, "OVERVIEW_ATTEMPT_CORRUPT");
});

test("overview attempt revision exhaustion fails closed without replacing the ledger", async () => {
  for (const mode of ["manual-orphan", "new-window"]) {
    let now = OVERVIEW_NOW;
    const storage = createStorage({
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_abc123: overviewDigest(),
    });
    const coordinator = createMutationCoordinator(storage, { now: () => now });
    await coordinator.claimBasicOverview(
      0,
      overviewClaim("automatic", { attemptId: `overview-max-${mode}` }),
    );
    const record = storage.state[overviewAttemptKey()];
    record.currentAttempt.revision = Number.MAX_SAFE_INTEGER;
    const before = structuredClone(record);

    if (mode === "manual-orphan") {
      now += OVERVIEW_CLAIM_LEASE_MS + 1;
    } else {
      now += OVERVIEW_ATTEMPT_TTL_MS + 1;
      storage.state.digest_abc123.timestamp = now;
    }
    const result = await coordinator.claimBasicOverview(
      0,
      overviewClaim(mode === "manual-orphan" ? "manual_retry" : "automatic", {
        attemptId: `overview-after-max-${mode}`,
      }),
    );

    assert.deepEqual(
      result,
      {
        success: false,
        code: "OVERVIEW_ATTEMPT_REVISION_EXHAUSTED",
        retryable: false,
      },
      mode,
    );
    assert.deepEqual(storage.state[overviewAttemptKey()], before, mode);
  }
});

test("failure settlement stores only a bounded canonical envelope", async () => {
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: overviewDigest(),
  });
  const coordinator = createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  });
  const claim = overviewClaim("automatic", { attemptId: "overview-canonical" });
  const claimed = await coordinator.claimBasicOverview(0, claim);

  const result = await coordinator.settleBasicOverview(0, {
    ...claim,
    attemptRevision: claimed.attemptRevision,
    outcome: {
      type: "failure",
      failure: {
        code: "RATE_LIMITED",
        provider: "evil-provider",
        stage: "evil-stage",
        retryable: true,
        primaryAction: "retry_later",
        mayHaveConsumedCredit: true,
        error: "secret provider payload",
        responseBody: "secret response body",
      },
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.disposition, "failed");
  assert.deepEqual(result.failure, {
    code: "RATE_LIMITED",
    provider: "deepseek",
    stage: "overview",
    retryable: true,
    primaryAction: "retry_later",
    mayHaveConsumedCredit: true,
  });
  const stored = storage.state[overviewAttemptKey()].currentAttempt.failure;
  assert.deepEqual(stored, result.failure);
  assert.equal(JSON.stringify(storage.state[overviewAttemptKey()]).includes("secret"), false);
});

test("failure settlement keeps only provider-canonical codes and actions", async () => {
  for (const [name, input, expected] of [
    [
      "canonical-unknown",
      {
        code: "UNKNOWN_PROVIDER_ERROR",
        retryable: false,
        primaryAction: "none",
        mayHaveConsumedCredit: true,
      },
      {
        code: "UNKNOWN_PROVIDER_ERROR",
        provider: "deepseek",
        stage: "overview",
        retryable: false,
        primaryAction: "none",
        mayHaveConsumedCredit: true,
      },
    ],
    [
      "arbitrary-code",
      {
        code: "CALLER_INVENTED_SEMANTICS",
        retryable: true,
        primaryAction: "open_billing",
        mayHaveConsumedCredit: true,
      },
      {
        code: "UNKNOWN_PROVIDER_ERROR",
        provider: "deepseek",
        stage: "overview",
        retryable: false,
        primaryAction: "none",
        mayHaveConsumedCredit: true,
      },
    ],
    [
      "contradictory-known-code",
      {
        code: "INVALID_KEY",
        retryable: true,
        primaryAction: "retry",
        mayHaveConsumedCredit: false,
      },
      {
        code: "INVALID_KEY",
        provider: "deepseek",
        stage: "overview",
        retryable: false,
        primaryAction: "open_settings",
        mayHaveConsumedCredit: false,
      },
    ],
  ]) {
    const storage = createStorage({
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_abc123: overviewDigest(),
    });
    const coordinator = createMutationCoordinator(storage, {
      now: () => OVERVIEW_NOW,
    });
    const claim = overviewClaim("automatic", {
      attemptId: `overview-failure-${name}`,
    });
    const claimed = await coordinator.claimBasicOverview(0, claim);

    const result = await coordinator.settleBasicOverview(0, {
      ...claim,
      attemptRevision: claimed.attemptRevision,
      outcome: { type: "failure", failure: input },
    });

    assert.deepEqual(result.failure, expected, name);
    assert.deepEqual(
      storage.state[overviewAttemptKey()].currentAttempt.failure,
      expected,
      name,
    );
  }
});

test("attempt revision rejects a late result after an ID is reused", async () => {
  let now = OVERVIEW_NOW;
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: overviewDigest(),
  });
  const coordinator = createMutationCoordinator(storage, { now: () => now });
  const reused = overviewClaim("automatic", { attemptId: "overview-reused-id" });
  const firstClaim = await coordinator.claimBasicOverview(0, reused);
  assert.equal(firstClaim.attemptRevision, 1);
  await coordinator.settleBasicOverview(0, {
    ...reused,
    attemptRevision: firstClaim.attemptRevision,
    outcome: { type: "failure", failure: { code: "RATE_LIMITED" } },
  });

  now += 1;
  const retryClaim = await coordinator.claimBasicOverview(0, {
    ...reused,
    intent: "manual_retry",
  });
  assert.equal(retryClaim.disposition, "claimed");
  assert.equal(retryClaim.attemptRevision, 2);

  const late = await coordinator.settleBasicOverview(0, {
    ...reused,
    attemptRevision: firstClaim.attemptRevision,
    outcome: { type: "success", overview: basicOverview() },
  });
  assert.equal(late.success, false);
  assert.equal(late.code, "OVERVIEW_ATTEMPT_MISMATCH");
  assert.equal(Object.hasOwn(storage.state.digest_abc123, "basicOverview"), false);

  const current = await coordinator.settleBasicOverview(0, {
    ...reused,
    attemptRevision: retryClaim.attemptRevision,
    outcome: {
      type: "success",
      overview: { ...basicOverview(), generatedAt: now },
    },
  });
  assert.equal(current.disposition, "stored");
});

test("a terminal attempt rejects a contradictory repeated settlement", async () => {
  const makeFixture = async (attemptId) => {
    const storage = createStorage({
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_abc123: overviewDigest(),
    });
    const coordinator = createMutationCoordinator(storage, {
      now: () => OVERVIEW_NOW,
    });
    const claim = overviewClaim("automatic", { attemptId });
    const claimed = await coordinator.claimBasicOverview(0, claim);
    return {
      storage,
      coordinator,
      claim,
      attemptRevision: claimed.attemptRevision,
    };
  };

  const failed = await makeFixture("overview-terminal-failed");
  await failed.coordinator.settleBasicOverview(0, {
    ...failed.claim,
    attemptRevision: failed.attemptRevision,
    outcome: {
      type: "failure",
      failure: { code: "RATE_LIMITED" },
    },
  });
  const failureThenSuccess = await failed.coordinator.settleBasicOverview(0, {
    ...failed.claim,
    attemptRevision: failed.attemptRevision,
    outcome: { type: "success", overview: basicOverview() },
  });
  assert.equal(failureThenSuccess.code, "OVERVIEW_ATTEMPT_NOT_CLAIMED");
  assert.equal(
    Object.hasOwn(failed.storage.state.digest_abc123, "basicOverview"),
    false,
  );

  const succeeded = await makeFixture("overview-terminal-succeeded");
  await succeeded.coordinator.settleBasicOverview(0, {
    ...succeeded.claim,
    attemptRevision: succeeded.attemptRevision,
    outcome: { type: "success", overview: basicOverview() },
  });
  const successThenFailure = await succeeded.coordinator.settleBasicOverview(0, {
    ...succeeded.claim,
    attemptRevision: succeeded.attemptRevision,
    outcome: {
      type: "failure",
      failure: { code: "RATE_LIMITED" },
    },
  });
  assert.equal(successThenFailure.code, "OVERVIEW_ATTEMPT_NOT_CLAIMED");
  assert.deepEqual(
    succeeded.storage.state.digest_abc123.basicOverview,
    basicOverview(),
  );
});

test("idempotent success settlement still requires a current matching digest", async () => {
  for (const mode of [
    "fingerprint-changed",
    "digest-expired",
    "attempt-expired",
  ]) {
    let now = OVERVIEW_NOW;
    const storage = createStorage({
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_abc123: overviewDigest(),
    });
    const coordinator = createMutationCoordinator(storage, { now: () => now });
    const claim = overviewClaim("automatic", {
      attemptId: `overview-idempotent-${mode}`,
    });
    const claimed = await coordinator.claimBasicOverview(0, claim);
    const settlement = {
      ...claim,
      attemptRevision: claimed.attemptRevision,
      outcome: { type: "success", overview: basicOverview() },
    };
    assert.equal(
      (await coordinator.settleBasicOverview(0, settlement)).disposition,
      "stored",
    );

    if (mode === "fingerprint-changed") {
      storage.state.digest_abc123.transcriptFingerprint =
        OTHER_OVERVIEW_FINGERPRINT;
    } else if (mode === "digest-expired") {
      now += OVERVIEW_ATTEMPT_TTL_MS - 1_000;
    } else {
      now += OVERVIEW_ATTEMPT_TTL_MS + 1;
    }
    const repeated = await coordinator.settleBasicOverview(0, settlement);

    assert.deepEqual(
      repeated,
      {
        success: false,
        code:
          mode === "attempt-expired"
            ? "OVERVIEW_ATTEMPT_EXPIRED"
            : "OVERVIEW_DIGEST_CONTEXT_MISMATCH",
        retryable: false,
      },
      mode,
    );
  }
});

test("claim refuses missing or mismatched digest context without writing a ledger", async () => {
  for (const [name, digest] of [
    ["missing", undefined],
    ["mismatched", overviewDigest({ fingerprint: OTHER_OVERVIEW_FINGERPRINT })],
  ]) {
    const initial = { [STORAGE_KEYS.resetEpoch]: 0 };
    if (digest) initial.digest_abc123 = digest;
    const storage = createStorage(initial);
    const coordinator = createMutationCoordinator(storage, {
      now: () => OVERVIEW_NOW,
    });

    const result = await coordinator.claimBasicOverview(
      0,
      overviewClaim("automatic", { attemptId: `overview-context-${name}` }),
    );
    assert.equal(result.code, "OVERVIEW_DIGEST_CONTEXT_MISSING", name);
    assert.equal(Object.hasOwn(storage.state, overviewAttemptKey()), false, name);
  }
});

test("overview transactions require an authoritative digest v2 context", async (t) => {
  for (const [name, digestSchemaVersion] of [
    ["missing schema", undefined],
    ["wrong schema", 1],
  ]) {
    await t.test(`${name} claim cannot trust a cached overview`, async () => {
      const digest = overviewDigest({
        digestSchemaVersion,
        basicOverview: basicOverview(),
      });
      const storage = createStorage({
        [STORAGE_KEYS.resetEpoch]: 0,
        digest_abc123: digest,
      });
      const coordinator = createMutationCoordinator(storage, {
        now: () => OVERVIEW_NOW,
      });

      const result = await coordinator.claimBasicOverview(
        0,
        overviewClaim("automatic", {
          attemptId: `overview-v2-claim-${digestSchemaVersion ?? "missing"}`,
        }),
      );

      assert.deepEqual(result, {
        success: false,
        code: "OVERVIEW_DIGEST_CONTEXT_MISSING",
        retryable: false,
      });
      assert.equal(Object.hasOwn(storage.state, overviewAttemptKey()), false);
    });

    await t.test(`${name} rejects an initial success settlement`, async () => {
      const storage = createStorage({
        [STORAGE_KEYS.resetEpoch]: 0,
        digest_abc123: overviewDigest(),
      });
      const coordinator = createMutationCoordinator(storage, {
        now: () => OVERVIEW_NOW,
      });
      const claim = overviewClaim("automatic", {
        attemptId: `overview-v2-settle-${digestSchemaVersion ?? "missing"}`,
      });
      const claimed = await coordinator.claimBasicOverview(0, claim);
      const beforeLedger = structuredClone(storage.state[overviewAttemptKey()]);
      if (digestSchemaVersion === undefined) {
        delete storage.state.digest_abc123.digestSchemaVersion;
      } else {
        storage.state.digest_abc123.digestSchemaVersion = digestSchemaVersion;
      }

      const result = await coordinator.settleBasicOverview(0, {
        ...claim,
        attemptRevision: claimed.attemptRevision,
        outcome: { type: "success", overview: basicOverview() },
      });

      assert.deepEqual(result, {
        success: false,
        code: "OVERVIEW_DIGEST_CONTEXT_MISMATCH",
        retryable: false,
      });
      assert.equal(storage.state.digest_abc123.basicOverview, undefined);
      assert.deepEqual(storage.state[overviewAttemptKey()], beforeLedger);
    });

    await t.test(`${name} rejects terminal idempotent cached settlement`, async () => {
      const storage = createStorage({
        [STORAGE_KEYS.resetEpoch]: 0,
        digest_abc123: overviewDigest(),
      });
      const coordinator = createMutationCoordinator(storage, {
        now: () => OVERVIEW_NOW,
      });
      const claim = overviewClaim("automatic", {
        attemptId: `overview-v2-idempotent-${digestSchemaVersion ?? "missing"}`,
      });
      const claimed = await coordinator.claimBasicOverview(0, claim);
      const settlement = {
        ...claim,
        attemptRevision: claimed.attemptRevision,
        outcome: { type: "success", overview: basicOverview() },
      };
      assert.equal(
        (await coordinator.settleBasicOverview(0, settlement)).disposition,
        "stored",
      );
      if (digestSchemaVersion === undefined) {
        delete storage.state.digest_abc123.digestSchemaVersion;
      } else {
        storage.state.digest_abc123.digestSchemaVersion = digestSchemaVersion;
      }

      assert.deepEqual(
        await coordinator.settleBasicOverview(0, settlement),
        {
          success: false,
          code: "OVERVIEW_DIGEST_CONTEXT_MISMATCH",
          retryable: false,
        },
      );
    });
  }
});

test("overview digest context accepts 29 days but rejects exactly 30 days and the future", async () => {
  for (const [name, timestamp, expectedDisposition] of [
    ["twenty-nine-days", OVERVIEW_NOW - 29 * 24 * 60 * 60 * 1000, "claimed"],
    ["exactly-thirty-days", OVERVIEW_NOW - OVERVIEW_ATTEMPT_TTL_MS, null],
    ["future", OVERVIEW_NOW + 1, null],
  ]) {
    const storage = createStorage({
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_abc123: overviewDigest({ timestamp }),
    });
    const coordinator = createMutationCoordinator(storage, {
      now: () => OVERVIEW_NOW,
    });

    const result = await coordinator.claimBasicOverview(
      0,
      overviewClaim("automatic", { attemptId: `overview-age-${name}` }),
    );

    if (expectedDisposition) {
      assert.equal(result.success, true, name);
      assert.equal(result.disposition, expectedDisposition, name);
      assert.equal(Object.hasOwn(storage.state, overviewAttemptKey()), true, name);
    } else {
      assert.deepEqual(
        result,
        {
          success: false,
          code: "OVERVIEW_DIGEST_CONTEXT_MISSING",
          retryable: false,
        },
        name,
      );
      assert.equal(Object.hasOwn(storage.state, overviewAttemptKey()), false, name);
    }
  }
});

test("success settlement atomically merges only basicOverview into the latest digest", async () => {
  const original = overviewDigest();
  Object.defineProperty(original, "__proto__", {
    value: { futureField: "preserve-without-prototype-mutation" },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: original,
  });
  const coordinator = createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  });
  const claim = overviewClaim("automatic", { attemptId: "overview-merge" });
  const claimed = await coordinator.claimBasicOverview(0, claim);

  storage.state.digest_abc123.concurrentFutureField = { added: "after-claim" };
  const overview = basicOverview();
  const result = await coordinator.settleBasicOverview(0, {
    ...claim,
    attemptRevision: claimed.attemptRevision,
    outcome: { type: "success", overview },
  });

  assert.equal(result.success, true);
  assert.equal(result.disposition, "stored");
  assert.deepEqual(storage.state.digest_abc123, {
    ...original,
    concurrentFutureField: { added: "after-claim" },
    basicOverview: overview,
  });
  assert.equal(Object.hasOwn(storage.state.digest_abc123, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(storage.state.digest_abc123), Object.prototype);
  assert.equal(
    storage.state[overviewAttemptKey()].currentAttempt.status,
    "succeeded",
  );
  const combinedWrite = storage.events.find(
    (event) =>
      event.type === "set" &&
      event.keys.includes("digest_abc123") &&
      event.keys.includes(overviewAttemptKey()),
  );
  assert.ok(combinedWrite, "digest result and succeeded ledger commit together");
});

test("success ledger distinguishes local generation time from final persistence time", async () => {
  let now = OVERVIEW_NOW;
  let advanceDuringCacheRead = false;
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_abc123: overviewDigest(),
    },
    {
      onGet(query) {
        if (advanceDuringCacheRead && query === null) now += 10;
      },
    },
  );
  const coordinator = createMutationCoordinator(storage, { now: () => now });
  const claim = overviewClaim("automatic", {
    attemptId: "overview-generation-persistence-gap",
  });
  const claimed = await coordinator.claimBasicOverview(0, claim);
  const overview = basicOverview();
  now += 5;
  advanceDuringCacheRead = true;

  const result = await coordinator.settleBasicOverview(0, {
    ...claim,
    attemptRevision: claimed.attemptRevision,
    outcome: { type: "success", overview },
  });

  assert.equal(result.success, true);
  const attempt = storage.state[overviewAttemptKey()].currentAttempt;
  assert.equal(attempt.generatedAt, overview.generatedAt);
  assert.equal(attempt.finishedAt, OVERVIEW_NOW + 15);
  assert.ok(attempt.generatedAt < attempt.finishedAt);
  assert.equal(
    storage.state.digest_abc123.basicOverview.generatedAt,
    overview.generatedAt,
  );
});

test("success settlement rejects generated times outside its claim clock", async () => {
  for (const [mode, generatedAt, expectedCode] of [
    ["before-claim", OVERVIEW_NOW - 1, "OVERVIEW_GENERATED_AT_INVALID"],
    ["future", OVERVIEW_NOW + 1, "OVERVIEW_CLOCK_INVALID"],
  ]) {
    const storage = createStorage({
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_abc123: overviewDigest(),
    });
    const coordinator = createMutationCoordinator(storage, {
      now: () => OVERVIEW_NOW,
    });
    const claim = overviewClaim("automatic", {
      attemptId: `overview-generated-${mode}`,
    });
    const claimed = await coordinator.claimBasicOverview(0, claim);
    const beforeDigest = structuredClone(storage.state.digest_abc123);
    const beforeLedger = structuredClone(storage.state[overviewAttemptKey()]);
    const overview = basicOverview();
    overview.generatedAt = generatedAt;

    const result = await coordinator.settleBasicOverview(0, {
      ...claim,
      attemptRevision: claimed.attemptRevision,
      outcome: { type: "success", overview },
    });

    assert.deepEqual(
      result,
      { success: false, code: expectedCode, retryable: false },
      mode,
    );
    assert.deepEqual(storage.state.digest_abc123, beforeDigest, mode);
    assert.deepEqual(
      storage.state[overviewAttemptKey()],
      beforeLedger,
      mode,
    );
  }
});

test("settlement requires exact epoch, attempt, fingerprint, and digest context", async () => {
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: overviewDigest(),
  });
  const coordinator = createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  });
  const claim = overviewClaim("automatic", { attemptId: "overview-exact" });
  const claimed = await coordinator.claimBasicOverview(0, claim);

  const wrongAttempt = await coordinator.settleBasicOverview(0, {
    ...claim,
    attemptId: "overview-wrong-attempt",
    attemptRevision: claimed.attemptRevision,
    outcome: { type: "success", overview: basicOverview() },
  });
  assert.equal(wrongAttempt.code, "OVERVIEW_ATTEMPT_MISMATCH");

  const wrongFingerprint = await coordinator.settleBasicOverview(0, {
    ...claim,
    attemptRevision: claimed.attemptRevision,
    transcriptFingerprint: OTHER_OVERVIEW_FINGERPRINT,
    outcome: {
      type: "success",
      overview: basicOverview(OTHER_OVERVIEW_FINGERPRINT),
    },
  });
  assert.equal(wrongFingerprint.code, "OVERVIEW_ATTEMPT_MISSING");

  storage.state.digest_abc123.transcriptFingerprint = OTHER_OVERVIEW_FINGERPRINT;
  const changedDigest = await coordinator.settleBasicOverview(0, {
    ...claim,
    attemptRevision: claimed.attemptRevision,
    outcome: { type: "success", overview: basicOverview() },
  });
  assert.equal(changedDigest.code, "OVERVIEW_DIGEST_CONTEXT_MISMATCH");

  storage.state[STORAGE_KEYS.resetEpoch] = 1;
  const oldEpoch = await coordinator.settleBasicOverview(0, {
    ...claim,
    attemptRevision: claimed.attemptRevision,
    outcome: { type: "success", overview: basicOverview() },
  });
  assert.equal(oldEpoch.code, "RESET_DURING_REQUEST");
  assert.equal(Object.hasOwn(storage.state.digest_abc123, "basicOverview"), false);
});

test("overview transactions fail closed when the clock rolls behind a durable claim", async () => {
  for (const operation of ["claim", "failure-settle", "success-settle"]) {
    let now = OVERVIEW_NOW;
    const storage = createStorage({
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_abc123: overviewDigest(),
    });
    const coordinator = createMutationCoordinator(storage, { now: () => now });
    const claim = overviewClaim("automatic", {
      attemptId: `overview-clock-rollback-${operation}`,
    });
    const claimed = await coordinator.claimBasicOverview(0, claim);
    const beforeDigest = structuredClone(storage.state.digest_abc123);
    const beforeLedger = structuredClone(storage.state[overviewAttemptKey()]);
    now -= 1;

    const result =
      operation === "claim"
        ? await coordinator.claimBasicOverview(
            0,
            overviewClaim("manual_retry", {
              attemptId: "overview-clock-rollback-retry",
            }),
          )
        : await coordinator.settleBasicOverview(0, {
            ...claim,
            attemptRevision: claimed.attemptRevision,
            outcome:
              operation === "failure-settle"
                ? { type: "failure", failure: { code: "RATE_LIMITED" } }
                : { type: "success", overview: basicOverview() },
          });

    assert.deepEqual(
      result,
      {
        success: false,
        code: "OVERVIEW_CLOCK_INVALID",
        retryable: false,
      },
      operation,
    );
    assert.deepEqual(storage.state.digest_abc123, beforeDigest, operation);
    assert.deepEqual(
      storage.state[overviewAttemptKey()],
      beforeLedger,
      operation,
    );
  }
});

test("settlement cannot commit an attempt after its fixed ledger window expires", async () => {
  for (const outcomeType of ["success", "failure"]) {
    let now = OVERVIEW_NOW;
    const originalDigest = overviewDigest();
    const storage = createStorage({
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_abc123: originalDigest,
    });
    const coordinator = createMutationCoordinator(storage, { now: () => now });
    const claim = overviewClaim("automatic", {
      attemptId: `overview-expired-settle-${outcomeType}`,
    });
    const claimed = await coordinator.claimBasicOverview(0, claim);
    const beforeLedger = structuredClone(storage.state[overviewAttemptKey()]);
    now += OVERVIEW_ATTEMPT_TTL_MS;
    storage.state.digest_abc123.timestamp = now;
    const refreshedDigest = structuredClone(storage.state.digest_abc123);

    const result = await coordinator.settleBasicOverview(0, {
      ...claim,
      attemptRevision: claimed.attemptRevision,
      outcome:
        outcomeType === "success"
          ? { type: "success", overview: basicOverview() }
          : { type: "failure", failure: { code: "RATE_LIMITED" } },
    });

    assert.deepEqual(
      result,
      {
        success: false,
        code: "OVERVIEW_ATTEMPT_EXPIRED",
        retryable: false,
      },
      outcomeType,
    );
    assert.deepEqual(storage.state.digest_abc123, refreshedDigest, outcomeType);
    assert.deepEqual(
      storage.state[overviewAttemptKey()],
      beforeLedger,
      outcomeType,
    );
  }
});

test("settlement may finish across the ledger boundary while its lease is active", async () => {
  let now = OVERVIEW_NOW;
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: overviewDigest(),
  });
  const coordinator = createMutationCoordinator(storage, { now: () => now });
  const automatic = overviewClaim("automatic", {
    attemptId: "overview-near-boundary-initial",
  });
  const initialClaim = await coordinator.claimBasicOverview(0, automatic);
  await coordinator.settleBasicOverview(0, {
    ...automatic,
    attemptRevision: initialClaim.attemptRevision,
    outcome: { type: "failure", failure: { code: "RATE_LIMITED" } },
  });

  const expiry = storage.state[overviewAttemptKey()].expiresAt;
  now = expiry - 1_000;
  storage.state.digest_abc123.timestamp = now;
  const retry = overviewClaim("manual_retry", {
    attemptId: "overview-near-boundary-retry",
  });
  const retryClaim = await coordinator.claimBasicOverview(0, retry);
  assert.ok(retryClaim.leaseUntil > expiry);
  now = expiry + 1;
  storage.state.digest_abc123.timestamp = now;

  const result = await coordinator.settleBasicOverview(0, {
    ...retry,
    attemptRevision: retryClaim.attemptRevision,
    outcome: {
      type: "success",
      overview: { ...basicOverview(), generatedAt: now },
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.disposition, "stored");
  assert.equal(
    storage.state[overviewAttemptKey()].currentAttempt.status,
    "succeeded",
  );
});

test("clear and reset prevent late overview settlement from recreating data", async () => {
  const makeFixture = () => {
    const storage = createStorage({
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_abc123: overviewDigest(),
    });
    return {
      storage,
      coordinator: createMutationCoordinator(storage, {
        now: () => OVERVIEW_NOW,
      }),
      claim: overviewClaim("automatic", { attemptId: "overview-late" }),
    };
  };

  const cleared = makeFixture();
  const clearedClaim = await cleared.coordinator.claimBasicOverview(
    0,
    cleared.claim,
  );
  await cleared.coordinator.commitCurrent(async (store) => {
    await store.remove(["digest_abc123", overviewAttemptKey()]);
  });
  const afterClear = await cleared.coordinator.settleBasicOverview(0, {
    ...cleared.claim,
    attemptRevision: clearedClaim.attemptRevision,
    outcome: { type: "success", overview: basicOverview() },
  });
  assert.equal(afterClear.code, "OVERVIEW_ATTEMPT_MISSING");
  assert.equal(Object.hasOwn(cleared.storage.state, "digest_abc123"), false);

  const reset = makeFixture();
  const resetClaim = await reset.coordinator.claimBasicOverview(0, reset.claim);
  await reset.coordinator.resetExtensionData();
  const afterReset = await reset.coordinator.settleBasicOverview(0, {
    ...reset.claim,
    attemptRevision: resetClaim.attemptRevision,
    outcome: { type: "success", overview: basicOverview() },
  });
  assert.equal(afterReset.code, "RESET_DURING_REQUEST");
  assert.deepEqual(Object.keys(reset.storage.state), [STORAGE_KEYS.resetEpoch]);
});

test("claim validation runs immediately before its durable mutation", async () => {
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: overviewDigest(),
  });
  const coordinator = createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  });
  let calls = 0;

  const result = await coordinator.claimBasicOverview(
    0,
    overviewClaim("automatic"),
    async () => {
      calls += 1;
      return false;
    },
  );

  assert.deepEqual(result, {
    success: false,
    code: "SESSION_STALE",
    retryable: false,
  });
  assert.equal(calls, 1);
  assert.equal(Object.hasOwn(storage.state, overviewAttemptKey()), false);
});

test("claim and digest validators reject synchronous coordinator reentry without deadlock", async () => {
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: overviewDigest(),
  });
  const coordinator = createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  });

  const claimOutcome = await settleWithin(
    coordinator.claimBasicOverview(
      0,
      overviewClaim("automatic", { attemptId: "overview-validator-reentry" }),
      () => coordinator.captureEpoch().then(() => true),
    ),
  );
  assert.equal(claimOutcome.kind, "resolved");
  assert.deepEqual(claimOutcome.value, {
    success: false,
    code: "SESSION_STALE",
    retryable: false,
  });

  const digestOutcome = await settleWithin(
    coordinator.commitDigest(
      0,
      "abc123",
      overviewDigest(),
      () => coordinator.captureEpoch().then(() => true),
    ),
  );
  assert.equal(digestOutcome.kind, "resolved");
  assert.equal(digestOutcome.value.code, "SESSION_STALE");

  assert.deepEqual(await coordinator.captureEpoch(), 0);
});

test("claim rechecks time and digest context after an asynchronous validator", async () => {
  let now = OVERVIEW_NOW;
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: overviewDigest({
      timestamp: OVERVIEW_NOW - 29 * 24 * 60 * 60 * 1000,
    }),
  });
  const coordinator = createMutationCoordinator(storage, { now: () => now });

  const result = await coordinator.claimBasicOverview(
    0,
    overviewClaim("automatic", { attemptId: "overview-validator-expired" }),
    async () => {
      now += 2 * 24 * 60 * 60 * 1000;
      return true;
    },
  );

  assert.deepEqual(result, {
    success: false,
    code: "OVERVIEW_DIGEST_CONTEXT_MISSING",
    retryable: false,
  });
  assert.equal(Object.hasOwn(storage.state, overviewAttemptKey()), false);
});

test("claim revalidates session authority after its final storage read", async () => {
  let claimReads = 0;
  let sessionValid = true;
  let validatorCalls = 0;
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_abc123: overviewDigest(),
    },
    {
      onGet(query) {
        if (!Array.isArray(query)) return;
        claimReads += 1;
        if (claimReads === 2) sessionValid = false;
      },
    },
  );
  const coordinator = createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  });

  const result = await coordinator.claimBasicOverview(
    0,
    overviewClaim("automatic", { attemptId: "overview-authority-race" }),
    async () => {
      validatorCalls += 1;
      return sessionValid;
    },
  );

  assert.deepEqual(result, {
    success: false,
    code: "SESSION_STALE",
    retryable: false,
  });
  assert.equal(validatorCalls, 2);
  assert.equal(Object.hasOwn(storage.state, overviewAttemptKey()), false);
});

test("success settlement rechecks digest age after cache reads before mutation", async () => {
  let now = OVERVIEW_NOW;
  let expireDuringCacheRead = false;
  const originalDigest = overviewDigest({
    timestamp: OVERVIEW_NOW - 29 * 24 * 60 * 60 * 1000,
  });
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_abc123: originalDigest,
    },
    {
      onGet(query) {
        if (expireDuringCacheRead && query === null) {
          now += 2 * 24 * 60 * 60 * 1000;
        }
      },
    },
  );
  const coordinator = createMutationCoordinator(storage, { now: () => now });
  const claim = overviewClaim("automatic", {
    attemptId: "overview-settle-expired",
  });
  const claimed = await coordinator.claimBasicOverview(0, claim);
  const beforeLedger = structuredClone(storage.state[overviewAttemptKey()]);
  expireDuringCacheRead = true;

  const result = await coordinator.settleBasicOverview(0, {
    ...claim,
    attemptRevision: claimed.attemptRevision,
    outcome: { type: "success", overview: basicOverview() },
  });

  assert.deepEqual(result, {
    success: false,
    code: "OVERVIEW_DIGEST_CONTEXT_MISMATCH",
    retryable: false,
  });
  assert.deepEqual(storage.state.digest_abc123, originalDigest);
  assert.deepEqual(storage.state[overviewAttemptKey()], beforeLedger);
  assert.equal(storage.events.some((event) => event.type === "remove"), false);
});

test("success settlement rechecks its attempt window at each cache mutation boundary", async () => {
  let now = OVERVIEW_NOW;
  let crossBoundaryDuringCacheRead = false;
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_abc123: overviewDigest(),
    },
    {
      onGet(query) {
        if (crossBoundaryDuringCacheRead && query === null) now += 2;
      },
    },
  );
  const coordinator = createMutationCoordinator(storage, { now: () => now });
  const claim = overviewClaim("automatic", {
    attemptId: "overview-window-crosses-during-cache",
  });
  const claimed = await coordinator.claimBasicOverview(0, claim);
  const record = storage.state[overviewAttemptKey()];
  now = record.expiresAt - 1;
  storage.state.digest_abc123.timestamp = now;
  const beforeDigest = structuredClone(storage.state.digest_abc123);
  const beforeLedger = structuredClone(record);
  crossBoundaryDuringCacheRead = true;

  const result = await coordinator.settleBasicOverview(0, {
    ...claim,
    attemptRevision: claimed.attemptRevision,
    outcome: { type: "success", overview: basicOverview() },
  });

  assert.deepEqual(result, {
    success: false,
    code: "OVERVIEW_ATTEMPT_EXPIRED",
    retryable: false,
  });
  assert.deepEqual(storage.state.digest_abc123, beforeDigest);
  assert.deepEqual(storage.state[overviewAttemptKey()], beforeLedger);
  assert.equal(storage.events.some((event) => event.type === "remove"), false);
});

test("overview settlement rechecks the durable epoch at every final mutation boundary", async (t) => {
  await t.test("normal success write", async () => {
    let settlementActive = false;
    let cacheReads = 0;
    const storage = createStorage(
      {
        [STORAGE_KEYS.resetEpoch]: 0,
        digest_abc123: overviewDigest(),
      },
      {
        afterGet(query, currentStorage) {
          if (!settlementActive || query !== null) return;
          cacheReads += 1;
          if (cacheReads !== 1) return;
          currentStorage.state[STORAGE_KEYS.resetEpoch] = 1;
          delete currentStorage.state.digest_abc123;
          delete currentStorage.state[overviewAttemptKey()];
        },
      },
    );
    const coordinator = createMutationCoordinator(storage, {
      now: () => OVERVIEW_NOW,
    });
    const claim = overviewClaim("automatic", {
      attemptId: "overview-external-epoch-normal",
    });
    const claimed = await coordinator.claimBasicOverview(0, claim);
    settlementActive = true;

    const result = await coordinator.settleBasicOverview(0, {
      ...claim,
      attemptRevision: claimed.attemptRevision,
      outcome: { type: "success", overview: basicOverview() },
    });

    assert.deepEqual(result, {
      success: false,
      code: "RESET_DURING_REQUEST",
    });
    assert.equal(storage.state[STORAGE_KEYS.resetEpoch], 1);
    assert.equal(Object.hasOwn(storage.state, "digest_abc123"), false);
    assert.equal(Object.hasOwn(storage.state, overviewAttemptKey()), false);
  });

  await t.test("quota retry write", async () => {
    let settlementActive = false;
    let cacheReads = 0;
    let cacheWriteAttempts = 0;
    const storage = createStorage(
      {
        [STORAGE_KEYS.resetEpoch]: 0,
        digest_oldest: { timestamp: 1, text: "keep after reset" },
        digest_abc123: overviewDigest(),
      },
      {
        afterGet(query, currentStorage) {
          if (!settlementActive || query !== null) return;
          cacheReads += 1;
          if (cacheReads !== 2) return;
          currentStorage.state[STORAGE_KEYS.resetEpoch] = 1;
          delete currentStorage.state.digest_abc123;
          delete currentStorage.state[overviewAttemptKey()];
        },
        onSet(items) {
          if (!settlementActive || !Object.hasOwn(items, "digest_abc123")) {
            return;
          }
          cacheWriteAttempts += 1;
          if (cacheWriteAttempts === 1) {
            const error = new Error("secret QUOTA_BYTES payload");
            error.name = "QuotaExceededError";
            throw error;
          }
        },
      },
    );
    const coordinator = createMutationCoordinator(storage, {
      now: () => OVERVIEW_NOW,
    });
    const claim = overviewClaim("automatic", {
      attemptId: "overview-external-epoch-quota",
    });
    const claimed = await coordinator.claimBasicOverview(0, claim);
    settlementActive = true;

    const result = await coordinator.settleBasicOverview(0, {
      ...claim,
      attemptRevision: claimed.attemptRevision,
      outcome: { type: "success", overview: basicOverview() },
    });

    assert.deepEqual(result, {
      success: false,
      code: "RESET_DURING_REQUEST",
    });
    assert.equal(cacheWriteAttempts, 1);
    assert.equal(storage.state[STORAGE_KEYS.resetEpoch], 1);
    assert.equal(Object.hasOwn(storage.state, "digest_abc123"), false);
    assert.equal(Object.hasOwn(storage.state, overviewAttemptKey()), false);
    assert.equal(Object.hasOwn(storage.state, "digest_oldest"), true);
  });

  await t.test("failure ledger write", async () => {
    let settlementActive = false;
    let changedEpoch = false;
    const storage = createStorage(
      {
        [STORAGE_KEYS.resetEpoch]: 0,
        digest_abc123: overviewDigest(),
      },
      {
        afterGet(query, currentStorage) {
          if (
            !settlementActive ||
            changedEpoch ||
            !Array.isArray(query) ||
            !query.includes("digest_abc123") ||
            !query.includes(overviewAttemptKey())
          ) return;
          changedEpoch = true;
          currentStorage.state[STORAGE_KEYS.resetEpoch] = 1;
          delete currentStorage.state.digest_abc123;
          delete currentStorage.state[overviewAttemptKey()];
        },
      },
    );
    const coordinator = createMutationCoordinator(storage, {
      now: () => OVERVIEW_NOW,
    });
    const claim = overviewClaim("automatic", {
      attemptId: "overview-external-epoch-failure",
    });
    const claimed = await coordinator.claimBasicOverview(0, claim);
    settlementActive = true;

    const result = await coordinator.settleBasicOverview(0, {
      ...claim,
      attemptRevision: claimed.attemptRevision,
      outcome: {
        type: "failure",
        failure: { code: "NETWORK_ERROR" },
      },
    });

    assert.deepEqual(result, {
      success: false,
      code: "RESET_DURING_REQUEST",
    });
    assert.equal(storage.state[STORAGE_KEYS.resetEpoch], 1);
    assert.equal(Object.hasOwn(storage.state, "digest_abc123"), false);
    assert.equal(Object.hasOwn(storage.state, overviewAttemptKey()), false);
  });
});

test("overview transactions reject final storage writes that cross an external epoch reset", async (t) => {
  await t.test("claim final set", async () => {
    let resetDuringClaim = true;
    const storage = createStorage(
      {
        [STORAGE_KEYS.resetEpoch]: 0,
        digest_abc123: overviewDigest(),
      },
      {
        onSet(items, currentStorage) {
          if (
            !resetDuringClaim ||
            !Object.hasOwn(items, overviewAttemptKey())
          ) return;
          resetDuringClaim = false;
          currentStorage.state[STORAGE_KEYS.resetEpoch] = 1;
          delete currentStorage.state.digest_abc123;
          delete currentStorage.state[overviewAttemptKey()];
        },
      },
    );
    const coordinator = createMutationCoordinator(storage, {
      now: () => OVERVIEW_NOW,
    });

    const result = await coordinator.claimBasicOverview(
      0,
      overviewClaim("automatic", { attemptId: "overview-final-set-claim" }),
    );

    assert.deepEqual(result, {
      success: false,
      code: "RESET_DURING_REQUEST",
    });
    assert.equal(storage.state[STORAGE_KEYS.resetEpoch], 1);
    assert.equal(Object.hasOwn(storage.state, "digest_abc123"), false);
    assert.equal(Object.hasOwn(storage.state, overviewAttemptKey()), false);
  });

  await t.test("success final set", async () => {
    let settlementActive = false;
    let resetOnce = false;
    const storage = createStorage(
      {
        [STORAGE_KEYS.resetEpoch]: 0,
        digest_abc123: overviewDigest(),
      },
      {
        onSet(items, currentStorage) {
          if (
            !settlementActive ||
            resetOnce ||
            !Object.hasOwn(items, "digest_abc123")
          ) return;
          resetOnce = true;
          currentStorage.state[STORAGE_KEYS.resetEpoch] = 1;
          delete currentStorage.state.digest_abc123;
          delete currentStorage.state[overviewAttemptKey()];
        },
      },
    );
    const coordinator = createMutationCoordinator(storage, {
      now: () => OVERVIEW_NOW,
    });
    const claim = overviewClaim("automatic", {
      attemptId: "overview-final-set-success",
    });
    const claimed = await coordinator.claimBasicOverview(0, claim);
    settlementActive = true;

    const result = await coordinator.settleBasicOverview(0, {
      ...claim,
      attemptRevision: claimed.attemptRevision,
      outcome: { type: "success", overview: basicOverview() },
    });

    assert.deepEqual(result, {
      success: false,
      code: "RESET_DURING_REQUEST",
    });
    assert.equal(storage.state[STORAGE_KEYS.resetEpoch], 1);
    assert.equal(Object.hasOwn(storage.state, "digest_abc123"), false);
    assert.equal(Object.hasOwn(storage.state, overviewAttemptKey()), false);
  });

  await t.test("failure final set", async () => {
    let settlementActive = false;
    let resetOnce = false;
    const storage = createStorage(
      {
        [STORAGE_KEYS.resetEpoch]: 0,
        digest_abc123: overviewDigest(),
      },
      {
        onSet(items, currentStorage) {
          if (
            !settlementActive ||
            resetOnce ||
            !Object.hasOwn(items, overviewAttemptKey())
          ) return;
          resetOnce = true;
          currentStorage.state[STORAGE_KEYS.resetEpoch] = 1;
          delete currentStorage.state.digest_abc123;
          delete currentStorage.state[overviewAttemptKey()];
        },
      },
    );
    const coordinator = createMutationCoordinator(storage, {
      now: () => OVERVIEW_NOW,
    });
    const claim = overviewClaim("automatic", {
      attemptId: "overview-final-set-failure",
    });
    const claimed = await coordinator.claimBasicOverview(0, claim);
    settlementActive = true;

    const result = await coordinator.settleBasicOverview(0, {
      ...claim,
      attemptRevision: claimed.attemptRevision,
      outcome: {
        type: "failure",
        failure: { code: "NETWORK_ERROR" },
      },
    });

    assert.deepEqual(result, {
      success: false,
      code: "RESET_DURING_REQUEST",
    });
    assert.equal(storage.state[STORAGE_KEYS.resetEpoch], 1);
    assert.equal(Object.hasOwn(storage.state, "digest_abc123"), false);
    assert.equal(Object.hasOwn(storage.state, overviewAttemptKey()), false);
  });

  await t.test("quota retry final set", async () => {
    let settlementActive = false;
    let cacheWriteAttempts = 0;
    const storage = createStorage(
      {
        [STORAGE_KEYS.resetEpoch]: 0,
        digest_oldest: { timestamp: 1, text: "eviction candidate" },
        digest_abc123: overviewDigest(),
      },
      {
        onSet(items, currentStorage) {
          if (!settlementActive || !Object.hasOwn(items, "digest_abc123")) {
            return;
          }
          cacheWriteAttempts += 1;
          if (cacheWriteAttempts === 1) {
            const error = new Error("secret quota detail");
            error.name = "QuotaExceededError";
            throw error;
          }
          if (cacheWriteAttempts === 2) {
            currentStorage.state[STORAGE_KEYS.resetEpoch] = 1;
            delete currentStorage.state.digest_abc123;
            delete currentStorage.state[overviewAttemptKey()];
          }
        },
      },
    );
    const coordinator = createMutationCoordinator(storage, {
      now: () => OVERVIEW_NOW,
    });
    const claim = overviewClaim("automatic", {
      attemptId: "overview-final-set-quota",
    });
    const claimed = await coordinator.claimBasicOverview(0, claim);
    settlementActive = true;

    const result = await coordinator.settleBasicOverview(0, {
      ...claim,
      attemptRevision: claimed.attemptRevision,
      outcome: { type: "success", overview: basicOverview() },
    });

    assert.deepEqual(result, {
      success: false,
      code: "RESET_DURING_REQUEST",
    });
    assert.equal(cacheWriteAttempts, 2);
    assert.equal(storage.state[STORAGE_KEYS.resetEpoch], 1);
    assert.equal(Object.hasOwn(storage.state, "digest_abc123"), false);
    assert.equal(Object.hasOwn(storage.state, overviewAttemptKey()), false);
  });

  await t.test("cleanup preserves newer same-name generation values", async () => {
    let settlementActive = false;
    let resetOnce = false;
    let installNewGeneration = false;
    const nextDigest = overviewDigest({
      timestamp: OVERVIEW_NOW,
      futureField: { generation: 1 },
    });
    const nextRecord = {
      schemaVersion: 1,
      videoId: "abc123",
      transcriptFingerprint: OVERVIEW_FINGERPRINT,
      firstClaimedAt: OVERVIEW_NOW,
      expiresAt: OVERVIEW_NOW + OVERVIEW_ATTEMPT_TTL_MS,
      currentAttempt: {
        id: "overview-new-generation",
        revision: 1,
        intent: "automatic",
        status: "claimed",
        resetEpoch: 1,
        claimedAt: OVERVIEW_NOW,
        leaseUntil: OVERVIEW_NOW + OVERVIEW_CLAIM_LEASE_MS,
      },
    };
    const storage = createStorage(
      {
        [STORAGE_KEYS.resetEpoch]: 0,
        digest_abc123: overviewDigest(),
      },
      {
        onSet(items, currentStorage) {
          if (
            !settlementActive ||
            resetOnce ||
            !Object.hasOwn(items, "digest_abc123")
          ) return;
          resetOnce = true;
          installNewGeneration = true;
          currentStorage.state[STORAGE_KEYS.resetEpoch] = 1;
          delete currentStorage.state.digest_abc123;
          delete currentStorage.state[overviewAttemptKey()];
        },
        onGet(query, currentStorage) {
          if (
            !installNewGeneration ||
            !Array.isArray(query) ||
            !query.includes(STORAGE_KEYS.resetEpoch) ||
            !query.includes("digest_abc123") ||
            !query.includes(overviewAttemptKey())
          ) return;
          installNewGeneration = false;
          currentStorage.state.digest_abc123 = structuredClone(nextDigest);
          currentStorage.state[overviewAttemptKey()] = structuredClone(nextRecord);
        },
      },
    );
    const coordinator = createMutationCoordinator(storage, {
      now: () => OVERVIEW_NOW,
    });
    const claim = overviewClaim("automatic", {
      attemptId: "overview-preserve-new-generation",
    });
    const claimed = await coordinator.claimBasicOverview(0, claim);
    settlementActive = true;

    const result = await coordinator.settleBasicOverview(0, {
      ...claim,
      attemptRevision: claimed.attemptRevision,
      outcome: { type: "success", overview: basicOverview() },
    });

    assert.deepEqual(result, {
      success: false,
      code: "RESET_DURING_REQUEST",
    });
    assert.deepEqual(storage.state.digest_abc123, nextDigest);
    assert.deepEqual(storage.state[overviewAttemptKey()], nextRecord);
  });
});

test("overview reset compensation verifies and finitely retries stale storage cleanup", async (t) => {
  async function settleAcrossReset(onRemove) {
    let settlementActive = false;
    let resetOnce = false;
    const storage = createStorage(
      {
        [STORAGE_KEYS.resetEpoch]: 0,
        digest_abc123: overviewDigest(),
      },
      {
        onSet(items, currentStorage) {
          if (
            !settlementActive ||
            resetOnce ||
            !Object.hasOwn(items, "digest_abc123")
          ) return;
          resetOnce = true;
          currentStorage.state[STORAGE_KEYS.resetEpoch] = 1;
          delete currentStorage.state.digest_abc123;
          delete currentStorage.state[overviewAttemptKey()];
        },
        onRemove,
      },
    );
    const coordinator = createMutationCoordinator(storage, {
      now: () => OVERVIEW_NOW,
    });
    const claim = overviewClaim("automatic", {
      attemptId: "overview-cleanup-verification",
    });
    const claimed = await coordinator.claimBasicOverview(0, claim);
    settlementActive = true;
    const result = await coordinator.settleBasicOverview(0, {
      ...claim,
      attemptRevision: claimed.attemptRevision,
      outcome: { type: "success", overview: basicOverview() },
    });
    return { result, storage };
  }

  await t.test("partial delete followed by throw is verified and retried", async () => {
    let removeCalls = 0;
    const { result, storage } = await settleAcrossReset(
      (keys, currentStorage) => {
        removeCalls += 1;
        if (removeCalls !== 1) return false;
        delete currentStorage.state[keys[0]];
        throw new Error("secret partial cleanup failure");
      },
    );

    assert.deepEqual(result, {
      success: false,
      code: "RESET_DURING_REQUEST",
    });
    assert.equal(removeCalls, 2);
    assert.equal(Object.hasOwn(storage.state, "digest_abc123"), false);
    assert.equal(Object.hasOwn(storage.state, overviewAttemptKey()), false);
    assert.equal(JSON.stringify(result).includes("secret"), false);
  });

  await t.test("a resolved no-op cleanup is verified and retried", async () => {
    let removeCalls = 0;
    const { result, storage } = await settleAcrossReset(() => {
      removeCalls += 1;
      return removeCalls === 1;
    });

    assert.deepEqual(result, {
      success: false,
      code: "RESET_DURING_REQUEST",
    });
    assert.equal(removeCalls, 2);
    assert.equal(Object.hasOwn(storage.state, "digest_abc123"), false);
    assert.equal(Object.hasOwn(storage.state, overviewAttemptKey()), false);
  });

  await t.test("persistent no-op cleanup is an explicit bounded failure", async () => {
    let removeCalls = 0;
    const { result, storage } = await settleAcrossReset(() => {
      removeCalls += 1;
      return true;
    });

    assert.deepEqual(result, {
      success: false,
      code: "RESET_DURING_REQUEST",
      cleanupComplete: false,
      storageCode: "STORAGE_WRITE_FAILED",
    });
    assert.equal(removeCalls, 2);
    assert.equal(Object.hasOwn(storage.state, "digest_abc123"), true);
    assert.equal(Object.hasOwn(storage.state, overviewAttemptKey()), true);
    assert.equal(JSON.stringify(result).length < 256, true);
  });
});

test("overview post-write epoch verification retries transient storage reads", async (t) => {
  await t.test("claim", async () => {
    let resetDuringClaim = true;
    let failVerificationReads = 1;
    let verificationReadFailures = 0;
    const storage = createStorage(
      {
        [STORAGE_KEYS.resetEpoch]: 0,
        digest_abc123: overviewDigest(),
      },
      {
        onSet(items, currentStorage) {
          if (
            !resetDuringClaim ||
            !Object.hasOwn(items, overviewAttemptKey())
          ) return;
          resetDuringClaim = false;
          currentStorage.state[STORAGE_KEYS.resetEpoch] = 1;
          delete currentStorage.state.digest_abc123;
          delete currentStorage.state[overviewAttemptKey()];
        },
        onGet(query) {
          if (
            resetDuringClaim ||
            failVerificationReads <= 0 ||
            !Array.isArray(query) ||
            !query.includes(STORAGE_KEYS.resetEpoch) ||
            !query.includes(overviewAttemptKey())
          ) return;
          failVerificationReads -= 1;
          verificationReadFailures += 1;
          throw new Error("secret transient verification read");
        },
      },
    );
    const coordinator = createMutationCoordinator(storage, {
      now: () => OVERVIEW_NOW,
    });

    const result = await coordinator.claimBasicOverview(
      0,
      overviewClaim("automatic", {
        attemptId: "overview-transient-verify-claim",
      }),
    );

    assert.deepEqual(result, {
      success: false,
      code: "RESET_DURING_REQUEST",
    });
    assert.equal(verificationReadFailures, 1);
    assert.equal(Object.hasOwn(storage.state, "digest_abc123"), false);
    assert.equal(Object.hasOwn(storage.state, overviewAttemptKey()), false);
  });

  async function settleWithVerificationReadFailure(mode, persistent = false) {
    let settlementActive = false;
    let resetOnce = false;
    let verificationActive = false;
    let verificationReadFailures = 0;
    let cacheWriteAttempts = 0;
    const storage = createStorage(
      {
        [STORAGE_KEYS.resetEpoch]: 0,
        ...(mode === "quota"
          ? { digest_oldest: { timestamp: 1, text: "eviction candidate" } }
          : {}),
        digest_abc123: overviewDigest(),
      },
      {
        onSet(items, currentStorage) {
          const writesDigest = Object.hasOwn(items, "digest_abc123");
          const writesAttempt = Object.hasOwn(items, overviewAttemptKey());
          if (!settlementActive || (!writesDigest && !writesAttempt)) return;
          if (mode === "quota" && writesDigest) {
            cacheWriteAttempts += 1;
            if (cacheWriteAttempts === 1) {
              const error = new Error("secret quota detail");
              error.name = "QuotaExceededError";
              throw error;
            }
          }
          if (resetOnce) return;
          resetOnce = true;
          verificationActive = true;
          currentStorage.state[STORAGE_KEYS.resetEpoch] = 1;
          delete currentStorage.state.digest_abc123;
          delete currentStorage.state[overviewAttemptKey()];
        },
        onGet(query) {
          if (
            !verificationActive ||
            (!persistent && verificationReadFailures >= 1) ||
            !Array.isArray(query) ||
            !query.includes(STORAGE_KEYS.resetEpoch) ||
            !query.includes(overviewAttemptKey())
          ) return;
          verificationReadFailures += 1;
          throw new Error("secret post-write verification read");
        },
      },
    );
    const coordinator = createMutationCoordinator(storage, {
      now: () => OVERVIEW_NOW,
    });
    const claim = overviewClaim("automatic", {
      attemptId: `overview-transient-verify-${mode}`,
    });
    const claimed = await coordinator.claimBasicOverview(0, claim);
    settlementActive = true;
    const outcome = mode === "failure"
      ? { type: "failure", failure: { code: "NETWORK_ERROR" } }
      : { type: "success", overview: basicOverview() };
    const result = await coordinator.settleBasicOverview(0, {
      ...claim,
      attemptRevision: claimed.attemptRevision,
      outcome,
    });
    return {
      result,
      storage,
      verificationReadFailures,
      cacheWriteAttempts,
    };
  }

  for (const mode of ["success", "failure", "quota"]) {
    await t.test(mode, async () => {
      const fixture = await settleWithVerificationReadFailure(mode);
      assert.deepEqual(fixture.result, {
        success: false,
        code: "RESET_DURING_REQUEST",
      });
      assert.equal(fixture.verificationReadFailures, 1);
      if (mode === "quota") assert.equal(fixture.cacheWriteAttempts, 2);
      assert.equal(Object.hasOwn(fixture.storage.state, "digest_abc123"), false);
      assert.equal(
        Object.hasOwn(fixture.storage.state, overviewAttemptKey()),
        false,
      );
    });
  }

  await t.test("persistent unreadable verification is explicitly unsafe", async () => {
    const fixture = await settleWithVerificationReadFailure("success", true);
    assert.deepEqual(fixture.result, {
      success: false,
      code: "OVERVIEW_CACHE_WRITE_FAILED",
      storageCode: "STORAGE_READ_FAILED",
      provider: "deepseek",
      stage: "overview_cache",
      providerSucceeded: true,
      mayHaveConsumedCredit: true,
      primaryAction: "retry_cache_write",
      retryable: true,
      cleanupComplete: false,
      overview: basicOverview(),
      evictedKeys: [],
    });
    assert.equal(fixture.verificationReadFailures, 2);
    assert.equal(Object.hasOwn(fixture.storage.state, "digest_abc123"), true);
    assert.equal(
      Object.hasOwn(fixture.storage.state, overviewAttemptKey()),
      true,
    );
    assert.equal(JSON.stringify(fixture.result).includes("secret"), false);
  });
});

test("overview post-write verification requires every expected item at the current epoch", async (t) => {
  await t.test("claim persistent no-op", async () => {
    let claimSetAttempts = 0;
    const storage = createStorage(
      {
        [STORAGE_KEYS.resetEpoch]: 0,
        digest_abc123: overviewDigest(),
      },
      {
        onSet(items) {
          if (!Object.hasOwn(items, overviewAttemptKey())) return false;
          claimSetAttempts += 1;
          return true;
        },
      },
    );
    const coordinator = createMutationCoordinator(storage, {
      now: () => OVERVIEW_NOW,
    });

    const result = await coordinator.claimBasicOverview(
      0,
      overviewClaim("automatic", {
        attemptId: "overview-current-epoch-claim-noop",
      }),
    );

    assert.deepEqual(result, {
      success: false,
      code: "STORAGE_WRITE_VERIFICATION_FAILED",
      retryable: true,
      cleanupComplete: false,
    });
    assert.equal(claimSetAttempts, 1);
    assert.equal(Object.hasOwn(storage.state, overviewAttemptKey()), false);
  });

  async function settleWithIncompleteFinalWrite(mode) {
    let settlementActive = false;
    let finalSetAttempts = 0;
    const storage = createStorage(
      {
        [STORAGE_KEYS.resetEpoch]: 0,
        ...(mode === "quota"
          ? { digest_oldest: { timestamp: 1, text: "eviction candidate" } }
          : {}),
        digest_abc123: overviewDigest(),
      },
      {
        onSet(items, currentStorage) {
          if (!settlementActive) return false;
          const writesDigest = Object.hasOwn(items, "digest_abc123");
          const writesAttempt = Object.hasOwn(items, overviewAttemptKey());
          if (!writesDigest && !writesAttempt) return false;
          finalSetAttempts += 1;
          if (mode === "quota" && finalSetAttempts === 1) {
            const error = new Error("secret quota detail");
            error.name = "QuotaExceededError";
            throw error;
          }
          if (writesDigest) {
            currentStorage.state.digest_abc123 = structuredClone(
              items.digest_abc123,
            );
          }
          return true;
        },
      },
    );
    const coordinator = createMutationCoordinator(storage, {
      now: () => OVERVIEW_NOW,
    });
    const claim = overviewClaim("automatic", {
      attemptId: `overview-current-epoch-${mode}`,
    });
    const claimed = await coordinator.claimBasicOverview(0, claim);
    settlementActive = true;
    const result = await coordinator.settleBasicOverview(0, {
      ...claim,
      attemptRevision: claimed.attemptRevision,
      outcome: mode === "failure"
        ? { type: "failure", failure: { code: "NETWORK_ERROR" } }
        : { type: "success", overview: basicOverview() },
    });
    return { result, storage, finalSetAttempts };
  }

  for (const mode of ["success", "failure", "quota"]) {
    await t.test(`${mode} persistent partial write`, async () => {
      const fixture = await settleWithIncompleteFinalWrite(mode);
      if (mode === "failure") {
        assert.deepEqual(fixture.result, {
          success: false,
          code: "STORAGE_WRITE_VERIFICATION_FAILED",
          retryable: true,
          cleanupComplete: false,
        });
      } else {
        assert.deepEqual(fixture.result, {
          success: false,
          code: "OVERVIEW_CACHE_WRITE_FAILED",
          storageCode: "STORAGE_WRITE_VERIFICATION_FAILED",
          provider: "deepseek",
          stage: "overview_cache",
          providerSucceeded: true,
          mayHaveConsumedCredit: true,
          primaryAction: "retry_cache_write",
          retryable: true,
          cleanupComplete: false,
          overview: basicOverview(),
          evictedKeys: [],
        });
      }
      assert.equal(
        fixture.finalSetAttempts,
        mode === "quota" ? 3 : mode === "failure" ? 1 : 2,
      );
      assert.equal(
        fixture.storage.state[overviewAttemptKey()].currentAttempt.status,
        "claimed",
      );
      assert.equal(JSON.stringify(fixture.result).includes("secret"), false);
    });
  }
});

test("terminal succeeded overview settlements repair only their exact missing cache", async (t) => {
  async function createLedgerOnlyFixture(mode, attemptId) {
    let forceLedgerOnly = true;
    let partialWriteCount = 0;
    const storage = createStorage(
      {
        [STORAGE_KEYS.resetEpoch]: 0,
        ...(mode === "quota"
          ? { digest_oldest: { timestamp: 1, text: "eviction candidate" } }
          : {}),
        digest_abc123: overviewDigest(),
      },
      {
        onSet(items, currentStorage) {
          if (
            !forceLedgerOnly ||
            !items.digest_abc123?.basicOverview ||
            items[overviewAttemptKey()]?.currentAttempt?.status !== "succeeded"
          ) return false;

          partialWriteCount += 1;
          currentStorage.state[overviewAttemptKey()] = structuredClone(
            items[overviewAttemptKey()],
          );
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
      },
    );
    const coordinator = createMutationCoordinator(storage, {
      now: () => OVERVIEW_NOW,
    });
    const claim = overviewClaim("automatic", { attemptId });
    const claimed = await coordinator.claimBasicOverview(0, claim);
    const settlement = {
      ...claim,
      attemptRevision: claimed.attemptRevision,
      outcome: { type: "success", overview: basicOverview() },
    };
    const first = await coordinator.settleBasicOverview(0, settlement);
    forceLedgerOnly = false;
    return {
      coordinator,
      first,
      get partialWriteCount() { return partialWriteCount; },
      settlement,
      storage,
    };
  }

  for (const mode of ["resolved", "rejected", "quota"]) {
    await t.test(`${mode} ledger-only write`, async () => {
      const fixture = await createLedgerOnlyFixture(
        mode,
        `overview-terminal-repair-${mode}`,
      );

      assert.equal(fixture.first.code, "OVERVIEW_CACHE_WRITE_FAILED");
      assert.equal(fixture.first.providerSucceeded, true);
      assert.equal(
        fixture.storage.state[overviewAttemptKey()].currentAttempt.status,
        "succeeded",
      );
      assert.equal(
        Object.hasOwn(fixture.storage.state.digest_abc123, "basicOverview"),
        false,
      );
      assert.equal(
        fixture.partialWriteCount,
        mode === "resolved" ? 2 : mode === "quota" ? 3 : 1,
      );

      const recovered = await fixture.coordinator.settleBasicOverview(
        0,
        fixture.settlement,
      );
      assert.equal(recovered.success, true);
      assert.equal(recovered.disposition, "stored");
      assert.deepEqual(
        fixture.storage.state.digest_abc123.basicOverview,
        basicOverview(),
      );

      const repeated = await fixture.coordinator.settleBasicOverview(
        0,
        fixture.settlement,
      );
      assert.equal(repeated.success, true);
      assert.equal(repeated.disposition, "stored");
      assert.deepEqual(repeated.overview, basicOverview());
    });
  }

  await t.test("different generatedAt cannot repair the terminal cache", async () => {
    const fixture = await createLedgerOnlyFixture(
      "resolved",
      "overview-terminal-generated-at",
    );
    const mismatchedOverview = basicOverview();
    mismatchedOverview.generatedAt -= 1;

    const result = await fixture.coordinator.settleBasicOverview(0, {
      ...fixture.settlement,
      outcome: { type: "success", overview: mismatchedOverview },
    });

    assert.deepEqual(result, {
      success: false,
      code: "OVERVIEW_GENERATED_AT_INVALID",
      retryable: false,
    });
    assert.equal(
      Object.hasOwn(fixture.storage.state.digest_abc123, "basicOverview"),
      false,
    );
  });

  await t.test("a different valid cached overview is preserved", async () => {
    const fixture = await createLedgerOnlyFixture(
      "resolved",
      "overview-terminal-preserve-cache",
    );
    const newerCachedOverview = {
      ...basicOverview(),
      oneSentenceZh: "保留已经持久化的不同概览。",
    };
    fixture.storage.state.digest_abc123.basicOverview = newerCachedOverview;

    const result = await fixture.coordinator.settleBasicOverview(
      0,
      fixture.settlement,
    );

    assert.equal(result.success, true);
    assert.deepEqual(result.overview, newerCachedOverview);
    assert.deepEqual(
      fixture.storage.state.digest_abc123.basicOverview,
      newerCachedOverview,
    );
  });

  await t.test("a malformed cached overview is never overwritten", async () => {
    const fixture = await createLedgerOnlyFixture(
      "resolved",
      "overview-terminal-malformed-cache",
    );
    const malformedCachedOverview = {
      schemaVersion: 1,
      transcriptFingerprint: OVERVIEW_FINGERPRINT,
    };
    fixture.storage.state.digest_abc123.basicOverview = malformedCachedOverview;

    const result = await fixture.coordinator.settleBasicOverview(
      0,
      fixture.settlement,
    );

    assert.deepEqual(result, {
      success: false,
      code: "OVERVIEW_DIGEST_CONTEXT_MISMATCH",
      retryable: false,
    });
    assert.deepEqual(
      fixture.storage.state.digest_abc123.basicOverview,
      malformedCachedOverview,
    );
  });

  await t.test("a different fingerprint is rejected before terminal repair", async () => {
    const fixture = await createLedgerOnlyFixture(
      "resolved",
      "overview-terminal-fingerprint",
    );

    await assert.rejects(
      fixture.coordinator.settleBasicOverview(0, {
        ...fixture.settlement,
        outcome: {
          type: "success",
          overview: basicOverview(OTHER_OVERVIEW_FINGERPRINT),
        },
      }),
      /overview fingerprint/i,
    );
    assert.equal(
      Object.hasOwn(fixture.storage.state.digest_abc123, "basicOverview"),
      false,
    );
  });
});

test("overview verifies ambiguous storage rejections before choosing a disposition", async (t) => {
  await t.test("claim reset interleave", async () => {
    const storage = createStorage(
      {
        [STORAGE_KEYS.resetEpoch]: 0,
        digest_abc123: overviewDigest(),
      },
      {
        onSet(items, currentStorage) {
          if (!Object.hasOwn(items, overviewAttemptKey())) return false;
          currentStorage.state[STORAGE_KEYS.resetEpoch] = 1;
          delete currentStorage.state.digest_abc123;
          delete currentStorage.state[overviewAttemptKey()];
          Object.assign(currentStorage.state, structuredClone(items));
          throw new Error("secret reject after claim write");
        },
      },
    );
    const coordinator = createMutationCoordinator(storage, {
      now: () => OVERVIEW_NOW,
    });

    const result = await coordinator.claimBasicOverview(
      0,
      overviewClaim("automatic", {
        attemptId: "overview-ambiguous-reset-claim",
      }),
    );

    assert.deepEqual(result, {
      success: false,
      code: "RESET_DURING_REQUEST",
    });
    assert.equal(Object.hasOwn(storage.state, "digest_abc123"), false);
    assert.equal(Object.hasOwn(storage.state, overviewAttemptKey()), false);
    assert.equal(JSON.stringify(result).includes("secret"), false);
  });

  async function settleWithAmbiguousReset(mode) {
    let settlementActive = false;
    let finalSetAttempts = 0;
    const storage = createStorage(
      {
        [STORAGE_KEYS.resetEpoch]: 0,
        ...(mode.startsWith("quota")
          ? { digest_oldest: { timestamp: 1, text: "eviction candidate" } }
          : {}),
        digest_abc123: overviewDigest(),
      },
      {
        onSet(items, currentStorage) {
          if (!settlementActive) return false;
          const writesDigest = Object.hasOwn(items, "digest_abc123");
          const writesAttempt = Object.hasOwn(items, overviewAttemptKey());
          if (!writesDigest && !writesAttempt) return false;
          finalSetAttempts += 1;
          if (mode === "quota-retry" && finalSetAttempts === 1) {
            const first = new Error("secret initial quota failure");
            first.name = "QuotaExceededError";
            throw first;
          }
          currentStorage.state[STORAGE_KEYS.resetEpoch] = 1;
          delete currentStorage.state.digest_abc123;
          delete currentStorage.state[overviewAttemptKey()];
          Object.assign(currentStorage.state, structuredClone(items));
          const error = new Error("secret reject after stale write");
          if (mode.startsWith("quota")) error.name = "QuotaExceededError";
          throw error;
        },
      },
    );
    const coordinator = createMutationCoordinator(storage, {
      now: () => OVERVIEW_NOW,
    });
    const claim = overviewClaim("automatic", {
      attemptId: `overview-ambiguous-reset-${mode}`,
    });
    const claimed = await coordinator.claimBasicOverview(0, claim);
    settlementActive = true;
    const result = await coordinator.settleBasicOverview(0, {
      ...claim,
      attemptRevision: claimed.attemptRevision,
      outcome: mode === "failure"
        ? { type: "failure", failure: { code: "NETWORK_ERROR" } }
        : { type: "success", overview: basicOverview() },
    });
    return { result, storage, finalSetAttempts };
  }

  for (const mode of ["success", "failure", "quota-first", "quota-retry"]) {
    await t.test(`${mode} reset interleave`, async () => {
      const fixture = await settleWithAmbiguousReset(mode);
      assert.deepEqual(fixture.result, {
        success: false,
        code: "RESET_DURING_REQUEST",
      });
      assert.equal(
        fixture.finalSetAttempts,
        mode === "quota-retry" ? 2 : 1,
      );
      assert.equal(Object.hasOwn(fixture.storage.state, "digest_abc123"), false);
      assert.equal(
        Object.hasOwn(fixture.storage.state, overviewAttemptKey()),
        false,
      );
      assert.equal(JSON.stringify(fixture.result).includes("secret"), false);
    });
  }

  await t.test("same-epoch exact claim write is accepted", async () => {
    const storage = createStorage(
      {
        [STORAGE_KEYS.resetEpoch]: 0,
        digest_abc123: overviewDigest(),
      },
      {
        onSet(items, currentStorage) {
          if (!Object.hasOwn(items, overviewAttemptKey())) return false;
          Object.assign(currentStorage.state, structuredClone(items));
          throw new Error("secret ambiguous claim commit");
        },
      },
    );
    const coordinator = createMutationCoordinator(storage, {
      now: () => OVERVIEW_NOW,
    });

    const result = await coordinator.claimBasicOverview(
      0,
      overviewClaim("automatic", {
        attemptId: "overview-ambiguous-exact-claim",
      }),
    );

    assert.equal(result.success, true);
    assert.equal(result.disposition, "claimed");
    assert.equal(
      storage.state[overviewAttemptKey()].currentAttempt.id,
      "overview-ambiguous-exact-claim",
    );
  });

  for (const mode of ["success", "failure"]) {
    await t.test(`same-epoch exact ${mode} write is accepted`, async () => {
      let settlementActive = false;
      const storage = createStorage(
        {
          [STORAGE_KEYS.resetEpoch]: 0,
          digest_abc123: overviewDigest(),
        },
        {
          onSet(items, currentStorage) {
            if (!settlementActive) return false;
            Object.assign(currentStorage.state, structuredClone(items));
            throw new Error("secret ambiguous settlement commit");
          },
        },
      );
      const coordinator = createMutationCoordinator(storage, {
        now: () => OVERVIEW_NOW,
      });
      const claim = overviewClaim("automatic", {
        attemptId: `overview-ambiguous-exact-${mode}`,
      });
      const claimed = await coordinator.claimBasicOverview(0, claim);
      settlementActive = true;

      const result = await coordinator.settleBasicOverview(0, {
        ...claim,
        attemptRevision: claimed.attemptRevision,
        outcome: mode === "failure"
          ? { type: "failure", failure: { code: "NETWORK_ERROR" } }
          : { type: "success", overview: basicOverview() },
      });

      assert.equal(result.success, true);
      assert.equal(result.disposition, mode === "failure" ? "failed" : "stored");
      assert.equal(
        storage.state[overviewAttemptKey()].currentAttempt.status,
        mode === "failure" ? "failed" : "succeeded",
      );
    });
  }
});

test("legitimate newer overview mutations remain behind reset cleanup in one coordinator FIFO", async () => {
  const removeStarted = deferred();
  const removeGate = deferred();
  let settlementActive = false;
  let resetOnce = false;
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_abc123: overviewDigest(),
    },
    {
      onSet(items, currentStorage) {
        if (
          !settlementActive ||
          resetOnce ||
          !Object.hasOwn(items, "digest_abc123")
        ) return;
        resetOnce = true;
        currentStorage.state[STORAGE_KEYS.resetEpoch] = 1;
        delete currentStorage.state.digest_abc123;
        delete currentStorage.state[overviewAttemptKey()];
      },
      async onRemove() {
        removeStarted.resolve();
        await removeGate.promise;
        return false;
      },
    },
  );
  const coordinator = createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  });
  const claim = overviewClaim("automatic", {
    attemptId: "overview-fifo-old-generation",
  });
  const claimed = await coordinator.claimBasicOverview(0, claim);
  settlementActive = true;
  const oldSettlement = coordinator.settleBasicOverview(0, {
    ...claim,
    attemptRevision: claimed.attemptRevision,
    outcome: { type: "success", overview: basicOverview() },
  });
  await removeStarted.promise;

  const newerBase = coordinator.commitDigestBase(
    1,
    "abc123",
    digestBase({ videoTitle: "New generation" }),
  );
  assert.equal((await settleWithin(newerBase, 10)).kind, "timeout");
  removeGate.resolve();

  assert.deepEqual(await oldSettlement, {
    success: false,
    code: "RESET_DURING_REQUEST",
  });
  const newerResult = await newerBase;
  assert.equal(newerResult.success, true);
  assert.equal(storage.state.digest_abc123.videoTitle, "New generation");
  assert.equal(storage.state.digest_abc123.basicOverview, undefined);
  assert.equal(Object.hasOwn(storage.state, overviewAttemptKey()), false);
});

test("overview merge keeps the ledger outside the 8 MiB digest budget", async () => {
  const chunk = "x".repeat(1024 * 1024);
  const unrelatedLedgerKey = overviewAttemptKey(
    "other1",
    OTHER_OVERVIEW_FINGERPRINT,
  );
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_oldest: { timestamp: 1, text: chunk.repeat(5) },
      digest_abc123: overviewDigest({
        timestamp: OVERVIEW_NOW - 1,
        text: chunk.repeat(4),
      }),
      [unrelatedLedgerKey]: {
        schemaVersion: 1,
        expiresAt: OVERVIEW_NOW + OVERVIEW_ATTEMPT_TTL_MS,
        marker: "never-evict",
      },
      [STORAGE_KEYS.notes]: [{ id: "keep" }],
    },
    { withGetBytesInUse: false },
  );
  const coordinator = createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  });
  const claim = overviewClaim("automatic", { attemptId: "overview-budget" });
  const claimed = await coordinator.claimBasicOverview(0, claim);

  const result = await coordinator.settleBasicOverview(0, {
    ...claim,
    attemptRevision: claimed.attemptRevision,
    outcome: { type: "success", overview: basicOverview() },
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.evictedKeys, ["digest_oldest"]);
  assert.equal(Object.hasOwn(storage.state, "digest_abc123"), true);
  assert.equal(storage.state[unrelatedLedgerKey].marker, "never-evict");
  assert.equal(Object.hasOwn(storage.state, STORAGE_KEYS.notes), true);
});

test("overview quota recovery evicts one oldest non-target digest and retries once", async () => {
  let attempts = 0;
  const originalTarget = overviewDigest();
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_oldest: { timestamp: 1, text: "old" },
      digest_abc123: originalTarget,
      [STORAGE_KEYS.settings]: { keep: true },
    },
    {
      onSet(items) {
        if (!Object.hasOwn(items, "digest_abc123")) return;
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("secret QUOTA_BYTES payload");
          error.name = "QuotaExceededError";
          throw error;
        }
      },
    },
  );
  const coordinator = createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  });
  const claim = overviewClaim("automatic", { attemptId: "overview-quota" });
  const claimed = await coordinator.claimBasicOverview(0, claim);

  const result = await coordinator.settleBasicOverview(0, {
    ...claim,
    attemptRevision: claimed.attemptRevision,
    outcome: { type: "success", overview: basicOverview() },
  });

  assert.equal(result.success, true);
  assert.equal(result.retriedAfterQuota, true);
  assert.equal(attempts, 2);
  assert.deepEqual(result.evictedKeys, ["digest_oldest"]);
  assert.deepEqual(storage.state.digest_abc123, {
    ...originalTarget,
    basicOverview: basicOverview(),
  });
  assert.equal(Object.hasOwn(storage.state, STORAGE_KEYS.settings), true);
});

test("overview cache failure is typed, visible, bounded, and preserves the target", async () => {
  let attempts = 0;
  let rejectCacheWrites = true;
  const originalTarget = overviewDigest();
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_oldest: { timestamp: 1, text: "old" },
      digest_abc123: originalTarget,
    },
    {
      onSet(items) {
        if (!Object.hasOwn(items, "digest_abc123")) return;
        attempts += 1;
        if (!rejectCacheWrites) return;
        const error = new Error(`secret quota attempt ${attempts}`);
        error.name = "QuotaExceededError";
        throw error;
      },
    },
  );
  const coordinator = createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  });
  const claim = overviewClaim("automatic", {
    attemptId: "overview-quota-failure",
  });
  const claimed = await coordinator.claimBasicOverview(0, claim);
  const overview = basicOverview();

  const result = await coordinator.settleBasicOverview(0, {
    ...claim,
    attemptRevision: claimed.attemptRevision,
    outcome: { type: "success", overview },
  });

  assert.equal(result.success, false);
  assert.equal(result.code, "OVERVIEW_CACHE_WRITE_FAILED");
  assert.equal(result.storageCode, "STORAGE_QUOTA_EXCEEDED");
  assert.equal(result.provider, "deepseek");
  assert.equal(result.stage, "overview_cache");
  assert.equal(result.providerSucceeded, true);
  assert.equal(result.mayHaveConsumedCredit, true);
  assert.equal(result.primaryAction, "retry_cache_write");
  assert.equal(result.retryable, true);
  assert.deepEqual(result.overview, overview);
  assert.equal(attempts, 2);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.deepEqual(storage.state.digest_abc123, originalTarget);
  assert.equal(
    storage.state[overviewAttemptKey()].currentAttempt.status,
    "claimed",
  );

  rejectCacheWrites = false;
  const cacheRetry = await coordinator.settleBasicOverview(0, {
    ...claim,
    attemptRevision: claimed.attemptRevision,
    outcome: { type: "success", overview },
  });
  assert.equal(cacheRetry.success, true);
  assert.equal(cacheRetry.disposition, "stored");
  assert.equal(attempts, 3);
  assert.deepEqual(storage.state.digest_abc123, {
    ...originalTarget,
    basicOverview: overview,
  });
  assert.equal(storage.state.digest_abc123.timestamp, originalTarget.timestamp);
  assert.deepEqual(
    storage.state.digest_abc123.futureField,
    originalTarget.futureField,
  );
  assert.equal(
    storage.state[overviewAttemptKey()].currentAttempt.status,
    "succeeded",
  );
});

test("an oversized overview merge cannot evict its target or unrelated data", async () => {
  const originalTarget = overviewDigest({
    text: "x".repeat(DIGEST_BUDGET_BYTES),
  });
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_abc123: originalTarget,
      digest_other: { timestamp: 1, text: "other" },
      [STORAGE_KEYS.vocabulary]: { entries: [{ id: "keep" }] },
    },
    { withGetBytesInUse: false },
  );
  const coordinator = createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  });
  const claim = overviewClaim("automatic", { attemptId: "overview-too-large" });
  const claimed = await coordinator.claimBasicOverview(0, claim);

  const result = await coordinator.settleBasicOverview(0, {
    ...claim,
    attemptRevision: claimed.attemptRevision,
    outcome: { type: "success", overview: basicOverview() },
  });

  assert.equal(result.code, "OVERVIEW_CACHE_WRITE_FAILED");
  assert.equal(result.storageCode, "DIGEST_CACHE_TOO_LARGE");
  assert.equal(result.provider, "deepseek");
  assert.equal(result.stage, "overview_cache");
  assert.equal(result.providerSucceeded, true);
  assert.equal(result.mayHaveConsumedCredit, true);
  assert.equal(result.primaryAction, "retry_cache_write");
  assert.equal(result.retryable, true);
  assert.deepEqual(storage.state.digest_abc123, originalTarget);
  assert.equal(Object.hasOwn(storage.state, "digest_other"), true);
  assert.equal(Object.hasOwn(storage.state, STORAGE_KEYS.vocabulary), true);
  assert.equal(storage.events.some((event) => event.type === "remove"), false);
});

test("overview transactions reject unsafe inputs before storage access", async () => {
  const storage = createStorage({ [STORAGE_KEYS.resetEpoch]: 0 });
  const coordinator = createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  });

  await assert.rejects(
    coordinator.claimBasicOverview(0, overviewClaim("automatic", {
      transcriptFingerprint: "not-a-fingerprint",
    })),
    /transcript fingerprint/i,
  );
  await assert.rejects(
    coordinator.claimBasicOverview(0, overviewClaim("unexpected")),
    /intent/i,
  );
  await assert.rejects(
    coordinator.settleBasicOverview(0, {
      ...overviewClaim("automatic"),
      attemptRevision: 1,
      outcome: { type: "success", overview: basicOverview(OTHER_OVERVIEW_FINGERPRINT) },
    }),
    /overview fingerprint/i,
  );
  for (const generatedAt of [undefined, "1800000000000", Number.NaN]) {
    const overview = basicOverview();
    if (generatedAt === undefined) delete overview.generatedAt;
    else overview.generatedAt = generatedAt;
    await assert.rejects(
      coordinator.settleBasicOverview(0, {
        ...overviewClaim("automatic"),
        attemptRevision: 1,
        outcome: { type: "success", overview },
      }),
      /generatedAt/i,
    );
  }
  assert.deepEqual(storage.events, []);
});

test("unsafe video IDs are rejected before any storage operation", async () => {
  const storage = createStorage({ [STORAGE_KEYS.resetEpoch]: 0 });
  const coordinator = createMutationCoordinator(storage);

  for (const videoId of [
    "",
    42,
    "../escape",
    "abc/def",
    "x".repeat(21),
  ]) {
    await assert.rejects(
      coordinator.commitDigest(0, videoId, { timestamp: 1 }),
      /Invalid YouTube video ID/,
    );
  }

  assert.deepEqual(storage.events, []);
});

test("coordinator exposes scoped cache clearing and overview ledger pruning", () => {
  const coordinator = createMutationCoordinator(
    createStorage({ [STORAGE_KEYS.resetEpoch]: 0 }),
  );

  assert.equal(typeof coordinator.clearDigestCache, "function");
  assert.equal(typeof coordinator.pruneExpiredOverviewAttempts, "function");
});

test("scoped cache clear fences first, removes both cache families, and preserves unrelated stores", async () => {
  const attemptA = overviewAttemptKey("abc123", OVERVIEW_FINGERPRINT);
  const attemptB = overviewAttemptKey("def456", OTHER_OVERVIEW_FINGERPRINT);
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 7,
    [STORAGE_KEYS.settings]: { keep: "settings" },
    [STORAGE_KEYS.providerStatus]: { keep: "status" },
    [STORAGE_KEYS.notes]: [{ id: "note" }],
    [STORAGE_KEYS.vocabulary]: { entries: [{ id: "word" }] },
    [STORAGE_KEYS.language]: "zh-CN",
    digest_abc123: { timestamp: 1 },
    digest_def456: { timestamp: 2 },
    [attemptA]: { marker: "attempt-a" },
    [attemptB]: { marker: "attempt-b" },
    future_unknown_store: { keep: true },
  });
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.clearDigestCache();

  assert.deepEqual(result, {
    success: true,
    resetEpoch: 8,
    removedCount: 2,
    removedAttemptCount: 2,
  });
  assert.deepEqual(storage.state, {
    [STORAGE_KEYS.resetEpoch]: 8,
    [STORAGE_KEYS.settings]: { keep: "settings" },
    [STORAGE_KEYS.providerStatus]: { keep: "status" },
    [STORAGE_KEYS.notes]: [{ id: "note" }],
    [STORAGE_KEYS.vocabulary]: { entries: [{ id: "word" }] },
    [STORAGE_KEYS.language]: "zh-CN",
    future_unknown_store: { keep: true },
  });
  const epochWrite = storage.events.findIndex(
    (event) =>
      event.type === "set" && event.keys.includes(STORAGE_KEYS.resetEpoch),
  );
  const cacheRemove = storage.events.findIndex((event) => event.type === "remove");
  assert.ok(epochWrite >= 0);
  assert.ok(cacheRemove > epochWrite);
});

test("scoped cache clear advances the generation even when no cache keys exist", async () => {
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 3,
    [STORAGE_KEYS.settings]: { keep: true },
  });

  const result = await createMutationCoordinator(storage).clearDigestCache();

  assert.deepEqual(result, {
    success: true,
    resetEpoch: 4,
    removedCount: 0,
    removedAttemptCount: 0,
  });
  assert.equal(storage.state[STORAGE_KEYS.resetEpoch], 4);
  assert.deepEqual(storage.state[STORAGE_KEYS.settings], { keep: true });
  assert.equal(storage.events.some((event) => event.type === "remove"), false);
});

test("scoped cache clear never removes data when the generation fence write fails", async () => {
  let removeCalls = 0;
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 2,
      digest_abc123: { timestamp: 1 },
      [overviewAttemptKey()]: { keep: true },
    },
    {
      onSet() {
        throw new Error("secret epoch failure");
      },
      onRemove() {
        removeCalls += 1;
      },
    },
  );

  const result = await createMutationCoordinator(storage).clearDigestCache();

  assert.deepEqual(result, {
    success: false,
    code: "STORAGE_WRITE_FAILED",
    stage: "write_epoch",
  });
  assert.equal(removeCalls, 0);
  assert.equal(storage.state[STORAGE_KEYS.resetEpoch], 2);
  assert.equal(Object.hasOwn(storage.state, "digest_abc123"), true);
  assert.equal(Object.hasOwn(storage.state, overviewAttemptKey()), true);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("scoped cache clear reports a persisted generation fence when removal verification fails", async () => {
  const attemptKey = overviewAttemptKey();
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 2,
      digest_abc123: { timestamp: 1 },
      [attemptKey]: { marker: "must-remain-for-verification" },
    },
    { onRemove: async () => true },
  );
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.clearDigestCache();

  assert.deepEqual(result, {
    success: false,
    code: "CLEAR_VERIFICATION_FAILED",
    resetEpoch: 3,
    removedCount: 0,
    removedAttemptCount: 0,
    remainingCount: 2,
    remainingKeys: ["digest_abc123", attemptKey].sort(),
  });
  assert.equal(storage.state[STORAGE_KEYS.resetEpoch], 3);
});

test("scoped cache clear verifies the generation fence itself", async () => {
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 4,
      digest_abc123: { timestamp: 1 },
    },
    {
      onSet(items) {
        delete items[STORAGE_KEYS.resetEpoch];
      },
    },
  );
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.clearDigestCache();

  assert.deepEqual(result, {
    success: false,
    code: "CLEAR_VERIFICATION_FAILED",
    resetEpoch: 5,
    removedCount: 1,
    removedAttemptCount: 0,
    remainingCount: 1,
    remainingKeys: [STORAGE_KEYS.resetEpoch],
  });
});

test("scoped cache clear prevents an old settlement from matching a recreated ID and revision", async () => {
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: overviewDigest(),
  });
  const coordinator = createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  });
  const reused = overviewClaim("automatic", {
    attemptId: "overview-clear-aba",
  });
  const oldClaim = await coordinator.claimBasicOverview(0, reused);

  assert.equal((await coordinator.clearDigestCache()).resetEpoch, 1);
  storage.state.digest_abc123 = overviewDigest();
  const newClaim = await coordinator.claimBasicOverview(1, reused);
  assert.equal(newClaim.attemptRevision, 1);

  const late = await coordinator.settleBasicOverview(0, {
    ...reused,
    attemptRevision: oldClaim.attemptRevision,
    outcome: { type: "success", overview: basicOverview() },
  });

  assert.deepEqual(late, { success: false, code: "RESET_DURING_REQUEST" });
  assert.equal(Object.hasOwn(storage.state.digest_abc123, "basicOverview"), false);
  assert.equal(
    storage.state[overviewAttemptKey()].currentAttempt.status,
    "claimed",
  );
});

test("overview pruning removes only identity-valid records after both window and lease expire", async () => {
  const record = ({
    videoId,
    fingerprint = OVERVIEW_FINGERPRINT,
    firstClaimedAt,
    claimedAt = firstClaimedAt,
  }) => ({
    schemaVersion: 1,
    videoId,
    transcriptFingerprint: fingerprint,
    firstClaimedAt,
    expiresAt: firstClaimedAt + OVERVIEW_ATTEMPT_TTL_MS,
    currentAttempt: {
      id: `overview-prune-${videoId}`,
      revision: 1,
      intent: "automatic",
      status: "claimed",
      resetEpoch: 0,
      claimedAt,
      leaseUntil: claimedAt + OVERVIEW_CLAIM_LEASE_MS,
    },
  });
  const expiredKey = overviewAttemptKey("expire1");
  const futureKey = overviewAttemptKey("future1");
  const activeLeaseKey = overviewAttemptKey("active1");
  const missingExpiryKey = overviewAttemptKey("missing1");
  const identityMismatchKey = overviewAttemptKey("wrong01");
  const malformedKey = `${OVERVIEW_ATTEMPT_PREFIX}not-a-ledger`;
  const expired = record({
    videoId: "expire1",
    firstClaimedAt: OVERVIEW_NOW - OVERVIEW_ATTEMPT_TTL_MS,
  });
  const future = record({
    videoId: "future1",
    firstClaimedAt: OVERVIEW_NOW - OVERVIEW_ATTEMPT_TTL_MS + 1,
  });
  const activeLease = record({
    videoId: "active1",
    firstClaimedAt: OVERVIEW_NOW - OVERVIEW_ATTEMPT_TTL_MS,
    claimedAt: OVERVIEW_NOW - 1_000,
  });
  const missingExpiry = record({
    videoId: "missing1",
    firstClaimedAt: OVERVIEW_NOW - OVERVIEW_ATTEMPT_TTL_MS,
  });
  delete missingExpiry.expiresAt;
  const identityMismatch = record({
    videoId: "other01",
    firstClaimedAt: OVERVIEW_NOW - OVERVIEW_ATTEMPT_TTL_MS,
  });
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    [expiredKey]: expired,
    [futureKey]: future,
    [activeLeaseKey]: activeLease,
    [missingExpiryKey]: missingExpiry,
    [identityMismatchKey]: identityMismatch,
    [malformedKey]: { expiresAt: 0, currentAttempt: { leaseUntil: 0 } },
    digest_abc123: { timestamp: 1 },
  });
  const coordinator = createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  });

  const result = await coordinator.pruneExpiredOverviewAttempts();

  assert.deepEqual(result, { success: true, removedAttemptCount: 1 });
  assert.equal(Object.hasOwn(storage.state, expiredKey), false);
  for (const key of [
    futureKey,
    activeLeaseKey,
    missingExpiryKey,
    identityMismatchKey,
    malformedKey,
  ]) {
    assert.equal(Object.hasOwn(storage.state, key), true, key);
  }
  assert.equal(Object.hasOwn(storage.state, "digest_abc123"), true);
});

test("overview pruning removes valid succeeded and failed terminal ledgers", async () => {
  let now = OVERVIEW_NOW;
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: overviewDigest(),
    digest_def456: overviewDigest(),
  });
  const coordinator = createMutationCoordinator(storage, { now: () => now });
  const succeeded = overviewClaim("automatic", {
    videoId: "abc123",
    attemptId: "overview-prune-succeeded",
  });
  const failed = overviewClaim("automatic", {
    videoId: "def456",
    attemptId: "overview-prune-failed",
  });
  const succeededClaim = await coordinator.claimBasicOverview(0, succeeded);
  const failedClaim = await coordinator.claimBasicOverview(0, failed);
  await coordinator.settleBasicOverview(0, {
    ...succeeded,
    attemptRevision: succeededClaim.attemptRevision,
    outcome: { type: "success", overview: basicOverview() },
  });
  await coordinator.settleBasicOverview(0, {
    ...failed,
    attemptRevision: failedClaim.attemptRevision,
    outcome: { type: "failure", failure: { code: "RATE_LIMITED" } },
  });
  assert.equal(
    storage.state[overviewAttemptKey("abc123")].currentAttempt.status,
    "succeeded",
  );
  assert.equal(
    storage.state[overviewAttemptKey("def456")].currentAttempt.status,
    "failed",
  );

  now += OVERVIEW_ATTEMPT_TTL_MS;
  const result = await coordinator.pruneExpiredOverviewAttempts();

  assert.deepEqual(result, { success: true, removedAttemptCount: 2 });
  assert.equal(Object.hasOwn(storage.state, overviewAttemptKey("abc123")), false);
  assert.equal(Object.hasOwn(storage.state, overviewAttemptKey("def456")), false);
});

test("overview pruning verifies removals and remains serialized with later mutations", async () => {
  const expiredKey = overviewAttemptKey();
  const expiredRecord = {
    schemaVersion: 1,
    videoId: "abc123",
    transcriptFingerprint: OVERVIEW_FINGERPRINT,
    firstClaimedAt: OVERVIEW_NOW - OVERVIEW_ATTEMPT_TTL_MS,
    expiresAt: OVERVIEW_NOW,
    currentAttempt: {
      id: "overview-prune-verify",
      revision: 1,
      intent: "automatic",
      status: "claimed",
      resetEpoch: 0,
      claimedAt: OVERVIEW_NOW - OVERVIEW_ATTEMPT_TTL_MS,
      leaseUntil:
        OVERVIEW_NOW - OVERVIEW_ATTEMPT_TTL_MS + OVERVIEW_CLAIM_LEASE_MS,
    },
  };
  const ignored = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      [expiredKey]: expiredRecord,
    },
    { onRemove: async () => true },
  );
  const ignoredCoordinator = createMutationCoordinator(ignored, {
    now: () => OVERVIEW_NOW,
  });
  assert.deepEqual(
    await ignoredCoordinator.pruneExpiredOverviewAttempts(),
    {
      success: false,
      code: "PRUNE_VERIFICATION_FAILED",
      removedAttemptCount: 0,
      remainingCount: 1,
      remainingKeys: [expiredKey],
    },
  );

  const readGate = deferred();
  const readStarted = deferred();
  let blocked = false;
  const serialized = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      [expiredKey]: expiredRecord,
    },
    {
      async onGet(query) {
        if (query === null && !blocked) {
          blocked = true;
          readStarted.resolve();
          await readGate.promise;
        }
      },
    },
  );
  const serializedCoordinator = createMutationCoordinator(serialized, {
    now: () => OVERVIEW_NOW,
  });
  const pruning = serializedCoordinator.pruneExpiredOverviewAttempts();
  await readStarted.promise;
  const laterMutation = serializedCoordinator.commitCurrent((storage) =>
    storage.set({ after_prune: true }),
  );
  await Promise.resolve();
  assert.equal(Object.hasOwn(serialized.state, "after_prune"), false);
  readGate.resolve();

  assert.equal((await pruning).success, true);
  assert.equal((await laterMutation).success, true);
  assert.equal(serialized.state.after_prune, true);
});

test("scoped cache clear verifies and reports a partial delete after remove rejects", async () => {
  const attemptKey = overviewAttemptKey();
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 9,
      digest_abc123: { timestamp: 1 },
      [attemptKey]: { marker: "remaining-attempt" },
    },
    {
      onRemove(keys, currentStorage) {
        delete currentStorage.state[keys[0]];
        throw new Error("secret partial remove failure");
      },
    },
  );
  const coordinator = createMutationCoordinator(storage);

  const result = await coordinator.clearDigestCache();

  assert.deepEqual(result, {
    success: false,
    code: "STORAGE_WRITE_FAILED",
    stage: "remove_cache",
    resetEpoch: 10,
    removedCount: 1,
    removedAttemptCount: 0,
    remainingCount: 1,
    remainingKeys: [attemptKey],
  });
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(storage.state[STORAGE_KEYS.resetEpoch], 10);
  assert.equal((await coordinator.captureEpoch()), 10);
});

test("scoped cache clear bounds a large residual verification report", async () => {
  const residual = Object.fromEntries([
    ...Array.from({ length: 105 }, (_, index) => [
      `digest_residual-${String(index).padStart(3, "0")}`,
      { timestamp: index },
    ]),
    ...Array.from({ length: 105 }, (_, index) => [
      `${OVERVIEW_ATTEMPT_PREFIX}residual-${String(index).padStart(3, "0")}`,
      { malformed: true },
    ]),
  ]);
  const storage = createStorage(
    { [STORAGE_KEYS.resetEpoch]: 0, ...residual },
    { onRemove: async () => true },
  );

  const result = await createMutationCoordinator(storage).clearDigestCache();

  assert.equal(result.success, false);
  assert.equal(result.code, "CLEAR_VERIFICATION_FAILED");
  assert.equal(result.remainingCount, 100);
  assert.equal(result.remainingKeys.length, 100);
  assert.deepEqual(
    result.remainingKeys,
    Object.keys(residual).sort().slice(0, 100),
  );
});

test("overview pruning verifies and reports a partial delete after remove rejects", async () => {
  const makeExpired = (videoId) => ({
    schemaVersion: 1,
    videoId,
    transcriptFingerprint: OVERVIEW_FINGERPRINT,
    firstClaimedAt: OVERVIEW_NOW - OVERVIEW_ATTEMPT_TTL_MS,
    expiresAt: OVERVIEW_NOW,
    currentAttempt: {
      id: `overview-partial-prune-${videoId}`,
      revision: 1,
      intent: "automatic",
      status: "claimed",
      resetEpoch: 0,
      claimedAt: OVERVIEW_NOW - OVERVIEW_ATTEMPT_TTL_MS,
      leaseUntil:
        OVERVIEW_NOW - OVERVIEW_ATTEMPT_TTL_MS + OVERVIEW_CLAIM_LEASE_MS,
    },
  });
  const firstKey = overviewAttemptKey("abc123");
  const secondKey = overviewAttemptKey("def456");
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      [firstKey]: makeExpired("abc123"),
      [secondKey]: makeExpired("def456"),
    },
    {
      onRemove(keys, currentStorage) {
        delete currentStorage.state[keys[0]];
        throw new Error("secret partial prune failure");
      },
    },
  );
  const coordinator = createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  });

  const result = await coordinator.pruneExpiredOverviewAttempts();

  assert.deepEqual(result, {
    success: false,
    code: "STORAGE_WRITE_FAILED",
    stage: "remove_expired_attempts",
    removedAttemptCount: 1,
    remainingCount: 1,
    remainingKeys: [secondKey],
  });
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal((await coordinator.captureEpoch()), 0);
});

test("cache clear and pruning fail closed on exhausted epoch and invalid clocks", async () => {
  const exhausted = createStorage({
    [STORAGE_KEYS.resetEpoch]: Number.MAX_SAFE_INTEGER,
    digest_abc123: { timestamp: 1 },
  });
  assert.deepEqual(
    await createMutationCoordinator(exhausted).clearDigestCache(),
    { success: false, code: "RESET_EPOCH_EXHAUSTED" },
  );
  assert.equal(Object.hasOwn(exhausted.state, "digest_abc123"), true);
  assert.equal(exhausted.events.some((event) => event.type === "remove"), false);

  const invalidClock = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    [overviewAttemptKey()]: { marker: "preserve" },
  });
  const invalidClockResult = await createMutationCoordinator(invalidClock, {
    now: () => Number.NaN,
  }).pruneExpiredOverviewAttempts();
  assert.deepEqual(invalidClockResult, {
    success: false,
    code: "OVERVIEW_CLOCK_INVALID",
    retryable: false,
  });
  assert.equal(Object.hasOwn(invalidClock.state, overviewAttemptKey()), true);
});

test("overview pruning parses valid video IDs containing underscores", async () => {
  const videoId = "abc_123";
  const key = overviewAttemptKey(videoId);
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    [key]: {
      schemaVersion: 1,
      videoId,
      transcriptFingerprint: OVERVIEW_FINGERPRINT,
      firstClaimedAt: OVERVIEW_NOW - OVERVIEW_ATTEMPT_TTL_MS,
      expiresAt: OVERVIEW_NOW,
      currentAttempt: {
        id: "overview-underscore-prune",
        revision: 1,
        intent: "automatic",
        status: "claimed",
        resetEpoch: 0,
        claimedAt: OVERVIEW_NOW - OVERVIEW_ATTEMPT_TTL_MS,
        leaseUntil:
          OVERVIEW_NOW - OVERVIEW_ATTEMPT_TTL_MS + OVERVIEW_CLAIM_LEASE_MS,
      },
    },
  });

  const result = await createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  }).pruneExpiredOverviewAttempts();

  assert.deepEqual(result, { success: true, removedAttemptCount: 1 });
  assert.equal(Object.hasOwn(storage.state, key), false);
});

test("coordinator exposes digest-v2 base and patch mutations", () => {
  const coordinator = createMutationCoordinator(
    createStorage({ [STORAGE_KEYS.resetEpoch]: 0 }),
  );

  assert.equal(typeof coordinator.commitDigestBase, "function");
  assert.equal(typeof coordinator.patchDigest, "function");
});

test("digest base writes an exact coordinator-owned whitelist and ignores panel-derived fields", async () => {
  let forbiddenGetterCalls = 0;
  const panelOverview = basicOverview();
  const input = digestBase({
    digestSchemaVersion: 999,
    timestamp: OVERVIEW_NOW + 99_000,
    basicOverview: panelOverview,
    deepAnalysis: completeDeepAnalysis("panel-deep"),
    unknownFuture: { shouldNotPersist: true },
  });
  Object.defineProperty(input, "ignoredAccessor", {
    enumerable: true,
    get() {
      forbiddenGetterCalls += 1;
      throw new Error("must not execute unknown getter");
    },
  });
  Object.defineProperty(input, "__proto__", {
    enumerable: true,
    value: { polluted: true },
  });
  const storage = createStorage({ [STORAGE_KEYS.resetEpoch]: 0 });
  const coordinator = createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  });

  const result = await coordinator.commitDigestBase(0, "abc123", input);

  assert.equal(result.success, true);
  assert.equal(
    result.timestamp,
    OVERVIEW_NOW,
    "success must echo the committed lifecycle timestamp",
  );
  assert.equal(forbiddenGetterCalls, 0);
  assert.deepEqual(storage.state.digest_abc123, {
    digestSchemaVersion: 2,
    transcript: input.transcript,
    transcriptText: "source",
    transcriptTimestamped: "[0:00] source",
    transcriptLanguage: "en",
    transcriptFingerprint: OVERVIEW_FINGERPRINT,
    videoTitle: "Title",
    channelName: "Channel",
    timestamp: OVERVIEW_NOW,
  });
  assert.equal(Object.getPrototypeOf(storage.state.digest_abc123), Object.prototype);
  assert.equal(Object.hasOwn(storage.state.digest_abc123, "basicOverview"), false);
  assert.equal(Object.hasOwn(storage.state.digest_abc123, "deepAnalysis"), false);
  assert.equal(Object.hasOwn(storage.state.digest_abc123, "unknownFuture"), false);
  assert.equal(Object.hasOwn(storage.state.digest_abc123, "__proto__"), false);
});

test("digest base cannot seed derived state from caller-owned full snapshots", async () => {
  const paragraphKey = `abc123:${OVERVIEW_FINGERPRINT}:zh:semantic:segment-0-0`;
  const storage = createStorage({ [STORAGE_KEYS.resetEpoch]: 0 });
  const result = await createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  }).commitDigestBase(0, "abc123", digestBase({
    analysis: completeDeepAnalysis("caller-analysis"),
    deepAnalysis: completeDeepAnalysis("caller-v2-analysis"),
    paragraphCache: { [paragraphKey]: "caller translation" },
  }));

  assert.equal(result.success, true);
  assert.equal(Object.hasOwn(storage.state.digest_abc123, "deepAnalysis"), false);
  assert.equal(Object.hasOwn(storage.state.digest_abc123, "paragraphCache"), false);
});

test("legacy missing-fingerprint migration requires exact raw caption proof", async (t) => {
  const source = { text: "source", start: 0, duration: 2, language: "en" };
  const cases = [
    {
      name: "whitespace",
      stored: [{ ...source, text: "source   words" }],
      incoming: [{ ...source, text: "source words" }],
    },
    {
      name: "Chinese punctuation",
      stored: [{ ...source, text: "你好 ，世界" }],
      incoming: [{ ...source, text: "你好，世界" }],
    },
    {
      name: "empty caption",
      stored: [source, { text: "", start: 2, duration: 1, language: "en" }],
      incoming: [source],
    },
    {
      name: "missing start",
      stored: [{ text: "source", duration: 2, language: "en" }],
      incoming: [source],
    },
    {
      name: "invalid duration",
      stored: [{ ...source, duration: "2" }],
      incoming: [source],
    },
    {
      name: "caption language",
      stored: [{ ...source, language: "fr" }],
      incoming: [source],
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const legacy = {
        ...digestBase({ transcript: fixture.stored }),
        timestamp: OVERVIEW_NOW - 1_000,
        analysis: completeDeepAnalysis("unproven legacy"),
        paragraphCache: {
          "abc123:zh:semantic:segment-0-0": "unproven translation",
        },
      };
      delete legacy.transcriptFingerprint;
      const storage = createStorage({
        [STORAGE_KEYS.resetEpoch]: 0,
        digest_abc123: legacy,
      });

      const result = await createMutationCoordinator(storage, {
        now: () => OVERVIEW_NOW,
      }).commitDigestBase(
        0,
        "abc123",
        digestBase({ transcript: fixture.incoming }),
        undefined,
        { canonicalSegmentIds: ["segment-0-0"] },
      );

      assert.equal(result.success, true);
      assert.deepEqual(storage.state.digest_abc123.transcript, fixture.incoming);
      assert.equal(
        Object.hasOwn(storage.state.digest_abc123, "deepAnalysis"),
        false,
      );
      assert.equal(
        Object.hasOwn(storage.state.digest_abc123, "paragraphCache"),
        false,
      );
    });
  }
});

test("legacy raw proof ignores key order and unknown fields without invoking accessors", async () => {
  let getterCalls = 0;
  const storedEntry = {};
  Object.defineProperties(storedEntry, {
    duration: { value: 2, enumerable: true },
    unknownData: { value: { ignored: true }, enumerable: true },
    unknownAccessor: {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "must not run";
      },
    },
    language: { value: " en ", enumerable: true },
    text: { value: "source", enumerable: true },
    start: { value: 0, enumerable: true },
  });
  const legacy = {
    ...digestBase({ transcript: [storedEntry] }),
    timestamp: OVERVIEW_NOW - 1_000,
    analysis: completeDeepAnalysis("paid legacy"),
    paragraphCache: {
      "abc123:zh:semantic:segment-0-0": "paid translation",
    },
  };
  delete legacy.transcriptFingerprint;
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: legacy,
  }, {
    onGetBytesInUse: () => 100,
  });

  const result = await createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  }).commitDigestBase(
    0,
    "abc123",
    digestBase({
      transcript: [{ text: "source", start: 0, duration: 2, language: "en" }],
    }),
    undefined,
    { canonicalSegmentIds: ["segment-0-0"] },
  );

  assert.equal(result.success, true);
  assert.equal(getterCalls, 0);
  assert.deepEqual(
    storage.state.digest_abc123.deepAnalysis,
    completeDeepAnalysis("paid legacy"),
  );
  assert.deepEqual(storage.state.digest_abc123.paragraphCache, {
    [`abc123:${OVERVIEW_FINGERPRINT}:zh:semantic:segment-0-0`]:
      "paid translation",
  });
});

test("legacy raw proof rejects known-field accessors without invoking them", async () => {
  let getterCalls = 0;
  const storedEntry = { start: 0, duration: 2, language: "en" };
  Object.defineProperty(storedEntry, "text", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "source";
    },
  });
  const legacy = {
    ...digestBase({ transcript: [storedEntry] }),
    timestamp: OVERVIEW_NOW - 1_000,
    analysis: completeDeepAnalysis("unproven"),
  };
  delete legacy.transcriptFingerprint;
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: legacy,
  }, {
    onGetBytesInUse: () => 100,
  });

  const result = await createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  }).commitDigestBase(
    0,
    "abc123",
    digestBase({
      transcript: [{ text: "source", start: 0, duration: 2, language: "en" }],
    }),
    undefined,
    { canonicalSegmentIds: ["segment-0-0"] },
  );

  assert.equal(result.success, true);
  assert.equal(getterCalls, 0);
  assert.equal(Object.hasOwn(storage.state.digest_abc123, "deepAnalysis"), false);
});

test("legacy migration proof is bounded, dense, unique, and data-only", async (t) => {
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, "canonicalSegmentIds", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return ["segment-0-0"];
    },
  });
  const sparseIds = new Array(2);
  sparseIds[0] = "segment-0-0";
  const oversizedIds = Array.from({ length: 14_000 }, (_, index) =>
    `segment-${String(index).padStart(6, "0")}-${"x".repeat(140)}`,
  );
  const cases = [
    ["duplicate", { canonicalSegmentIds: ["segment-0-0", "segment-0-0"] }],
    ["sparse", { canonicalSegmentIds: sparseIds }],
    ["accessor", accessor],
    ["malformed", { canonicalSegmentIds: ["segment/0"] }],
    ["over two MiB", { canonicalSegmentIds: oversizedIds }],
  ];

  for (const [name, migrationContext] of cases) {
    await t.test(name, async () => {
      const storage = createStorage({ [STORAGE_KEYS.resetEpoch]: 0 });
      const coordinator = createMutationCoordinator(storage, {
        now: () => OVERVIEW_NOW,
      });

      await assert.rejects(
        coordinator.commitDigestBase(
          0,
          "abc123",
          digestBase(),
          undefined,
          migrationContext,
        ),
        TypeError,
      );
      assert.deepEqual(storage.state, { [STORAGE_KEYS.resetEpoch]: 0 });
      assert.deepEqual(storage.events, []);
    });
  }
  assert.equal(getterCalls, 0);
});

test("legacy missing-fingerprint base migration atomically preserves stored deep and proven paragraph IDs", async () => {
  const legacy = {
    ...digestBase(),
    timestamp: OVERVIEW_NOW - 1_000,
    analysis: completeDeepAnalysis("stored legacy"),
    paragraphCache: {
      "abc123:zh:semantic:segment-0-0": "可迁译文",
      "abc123:zh:semantic:segment-9-9": "不可迁译文",
      attacker: "drop",
    },
  };
  delete legacy.transcriptFingerprint;
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: legacy,
  });

  const result = await createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  }).commitDigestBase(
    0,
    "abc123",
    digestBase(),
    undefined,
    { canonicalSegmentIds: ["segment-0-0"] },
  );

  assert.equal(result.success, true);
  assert.equal(result.timestamp, OVERVIEW_NOW - 1_000);
  assert.equal(storage.state.digest_abc123.digestSchemaVersion, 2);
  assert.deepEqual(
    storage.state.digest_abc123.deepAnalysis,
    completeDeepAnalysis("stored legacy"),
  );
  assert.deepEqual(storage.state.digest_abc123.paragraphCache, {
    [`abc123:${OVERVIEW_FINGERPRINT}:zh:semantic:segment-0-0`]: "可迁译文",
  });
  assert.equal(Object.hasOwn(storage.state.digest_abc123, "analysis"), false);
});

test("proven exact-fingerprint legacy migration also rewrites legacy paragraph keys", async () => {
  const legacy = {
    ...digestBase(),
    timestamp: OVERVIEW_NOW - 1_000,
    paragraphCache: {
      "abc123:zh:semantic:segment-0-0": "旧格式译文",
    },
  };
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: legacy,
  });

  const result = await createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  }).commitDigestBase(
    0,
    "abc123",
    digestBase(),
    undefined,
    { canonicalSegmentIds: ["segment-0-0"] },
  );

  assert.equal(result.success, true);
  assert.deepEqual(storage.state.digest_abc123.paragraphCache, {
    [`abc123:${OVERVIEW_FINGERPRINT}:zh:semantic:segment-0-0`]: "旧格式译文",
  });
});

test("legacy source language falls back to caption language during atomic migration", async () => {
  const transcript = [{
    text: "source",
    start: 0,
    duration: 2,
    language: " en ",
  }];
  const legacy = {
    ...digestBase({ transcript }),
    timestamp: OVERVIEW_NOW - 1_000,
    analysis: completeDeepAnalysis("language fallback"),
    paragraphCache: {
      "abc123:zh:semantic:segment-0-0": "语言回退译文",
    },
  };
  delete legacy.transcriptFingerprint;
  delete legacy.transcriptLanguage;
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: legacy,
  });

  const result = await createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  }).commitDigestBase(
    0,
    "abc123",
    digestBase({ transcript, transcriptLanguage: "en" }),
    undefined,
    { canonicalSegmentIds: ["segment-0-0"] },
  );

  assert.equal(result.success, true);
  assert.deepEqual(
    storage.state.digest_abc123.deepAnalysis,
    completeDeepAnalysis("language fallback"),
  );
  assert.deepEqual(storage.state.digest_abc123.paragraphCache, {
    [`abc123:${OVERVIEW_FINGERPRINT}:zh:semantic:segment-0-0`]: "语言回退译文",
  });
});

test("bounded long-video migration proof can preserve a translated tail segment", async () => {
  const canonicalSegmentIds = Array.from(
    { length: 5_001 },
    (_, index) => `segment-${index}-${index}`,
  );
  const tailId = canonicalSegmentIds.at(-1);
  const legacy = {
    ...digestBase(),
    timestamp: OVERVIEW_NOW - 1_000,
    paragraphCache: {
      [`abc123:zh:semantic:${tailId}`]: "尾段译文",
    },
  };
  delete legacy.transcriptFingerprint;
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: legacy,
  });

  const result = await createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  }).commitDigestBase(
    0,
    "abc123",
    digestBase(),
    undefined,
    { canonicalSegmentIds },
  );

  assert.equal(result.success, true);
  assert.deepEqual(storage.state.digest_abc123.paragraphCache, {
    [`abc123:${OVERVIEW_FINGERPRINT}:zh:semantic:${tailId}`]: "尾段译文",
  });
});

test("legacy explicit fingerprint mismatch never migrates derived state", async () => {
  const legacy = {
    ...digestBase({ fingerprint: OTHER_OVERVIEW_FINGERPRINT }),
    timestamp: OVERVIEW_NOW - 1_000,
    analysis: completeDeepAnalysis("wrong source"),
    paragraphCache: {
      "abc123:zh:semantic:segment-0-0": "wrong source translation",
    },
  };
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: legacy,
  });

  const result = await createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  }).commitDigestBase(
    0,
    "abc123",
    digestBase(),
    undefined,
    { canonicalSegmentIds: ["segment-0-0"] },
  );

  assert.equal(result.success, true);
  assert.equal(Object.hasOwn(storage.state.digest_abc123, "deepAnalysis"), false);
  assert.equal(Object.hasOwn(storage.state.digest_abc123, "paragraphCache"), false);
});

test("failed atomic legacy migration leaves the old digest unchanged", async () => {
  const legacy = {
    ...digestBase(),
    timestamp: OVERVIEW_NOW - 1_000,
    analysis: completeDeepAnalysis("paid legacy"),
    paragraphCache: {
      "abc123:zh:semantic:segment-0-0": "paid translation",
    },
  };
  delete legacy.transcriptFingerprint;
  const before = structuredClone(legacy);
  const quotaError = Object.assign(new Error("quota"), {
    name: "QuotaExceededError",
  });
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_abc123: legacy,
    },
    {
      onSet() {
        throw quotaError;
      },
    },
  );

  const result = await createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  }).commitDigestBase(
    0,
    "abc123",
    digestBase(),
    undefined,
    { canonicalSegmentIds: ["segment-0-0"] },
  );

  assert.equal(result.success, false);
  assert.deepEqual(storage.state.digest_abc123, before);
});

test("digest base rejects nested accessors and cycles without touching storage", async () => {
  for (const [name, transcript] of [
    [
      "nested-accessor",
      [
        Object.defineProperty({}, "text", {
          enumerable: true,
          get() {
            throw new Error("must not execute nested getter");
          },
        }),
      ],
    ],
    ["cycle", (() => { const value = []; value.push(value); return value; })()],
  ]) {
    const storage = createStorage({ [STORAGE_KEYS.resetEpoch]: 0 });
    const coordinator = createMutationCoordinator(storage, {
      now: () => OVERVIEW_NOW,
    });

    await assert.rejects(
      coordinator.commitDigestBase(
        0,
        "abc123",
        digestBase({ transcript }),
      ),
      /digest base/i,
      name,
    );
    assert.deepEqual(storage.events, [], name);
  }
});

test("digest base accepts a bounded four-hour-scale raw caption list", async () => {
  const transcript = Array.from({ length: 5_001 }, (_, index) => ({
    text: `caption ${index}`,
    start: index * 2,
    duration: 2,
  }));
  assert.ok(utf8Bytes(transcript) < 2 * 1024 * 1024);
  const storage = createStorage({ [STORAGE_KEYS.resetEpoch]: 0 });

  const result = await createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  }).commitDigestBase(0, "abc123", digestBase({ transcript }));

  assert.equal(result.success, true);
  assert.equal(storage.state.digest_abc123.transcript.length, 5_001);
});

test("digest base retains a hard aggregate property bound", async () => {
  const transcript = Array.from({ length: 25_001 }, (_, index) => ({
    text: "x",
    start: index,
    duration: 1,
  }));
  assert.ok(utf8Bytes(transcript) < 2 * 1024 * 1024);
  const storage = createStorage({ [STORAGE_KEYS.resetEpoch]: 0 });

  await assert.rejects(
    createMutationCoordinator(storage, {
      now: () => OVERVIEW_NOW,
    }).commitDigestBase(0, "abc123", digestBase({ transcript })),
    /digest base/i,
  );
  assert.deepEqual(storage.events, []);
});

test("same-fingerprint base keeps coordinator-derived state and ignores caller snapshots", async () => {
  const paragraphPrefix = `abc123:${OVERVIEW_FINGERPRINT}:`;
  const storedOverview = basicOverview();
  const storedDeep = completeDeepAnalysis("stored-deep");
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: digestV2({
      basicOverview: storedOverview,
      deepAnalysis: storedDeep,
      paragraphCache: { [`${paragraphPrefix}old`]: "旧译文" },
      futureUnknown: "drop-on-rebuild",
    }),
  });
  const coordinator = createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  });
  const input = digestBase({
    transcriptText: "new source",
    videoTitle: "New title",
    basicOverview: basicOverview(OTHER_OVERVIEW_FINGERPRINT),
    deepAnalysis: completeDeepAnalysis("late-panel-deep"),
    analysis: completeDeepAnalysis("late-legacy-analysis"),
    paragraphCache: { [`${paragraphPrefix}new`]: "新译文" },
  });

  const result = await coordinator.commitDigestBase(0, "abc123", input);

  assert.equal(result.success, true);
  assert.equal(
    result.timestamp,
    OVERVIEW_NOW - 1_000,
    "response must echo the preserved fixed-lifetime timestamp",
  );
  assert.deepEqual(storage.state.digest_abc123.basicOverview, storedOverview);
  assert.deepEqual(storage.state.digest_abc123.deepAnalysis, storedDeep);
  assert.deepEqual(storage.state.digest_abc123.paragraphCache, {
    [`${paragraphPrefix}old`]: "旧译文",
  });
  assert.equal(storage.state.digest_abc123.timestamp, OVERVIEW_NOW - 1_000);
  assert.equal(storage.state.digest_abc123.transcriptText, "new source");
  assert.equal(storage.state.digest_abc123.videoTitle, "New title");
  assert.equal(Object.hasOwn(storage.state.digest_abc123, "analysis"), false);
  assert.equal(Object.hasOwn(storage.state.digest_abc123, "futureUnknown"), false);
});

test("legacy deep migration honors stored own deepAnalysis including null", async () => {
  const storedAnalysis = completeDeepAnalysis("stored-analysis");
  const incomingAnalysis = completeDeepAnalysis("incoming-analysis");
  const lateAnalysis = completeDeepAnalysis("late-analysis");

  for (const [name, storedDerived, expected] of [
    [
      "own-null-wins",
      { deepAnalysis: null, analysis: storedAnalysis },
      null,
    ],
    ["legacy-analysis-fallback", { analysis: storedAnalysis }, storedAnalysis],
    ["caller-cannot-seed", {}, undefined],
  ]) {
    const storage = createStorage({
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_abc123: {
        ...digestBase(),
        timestamp: OVERVIEW_NOW - 1_000,
        ...storedDerived,
      },
    });
    const coordinator = createMutationCoordinator(storage, {
      now: () => OVERVIEW_NOW,
    });

    await coordinator.commitDigestBase(
      0,
      "abc123",
      digestBase({ analysis: incomingAnalysis }),
    );
    assert.deepEqual(storage.state.digest_abc123.deepAnalysis, expected, name);

    await coordinator.commitDigestBase(
      0,
      "abc123",
      digestBase({ analysis: lateAnalysis, transcriptText: "later base" }),
    );
    assert.deepEqual(storage.state.digest_abc123.deepAnalysis, expected, name);
  }
});

test("digest base enforces fingerprint and fixed-lifetime replacement rules", async () => {
  const paragraphPrefix = `abc123:${OVERVIEW_FINGERPRINT}:`;
  const derived = {
    basicOverview: basicOverview(),
    deepAnalysis: completeDeepAnalysis("preserved-expired"),
    paragraphCache: { [`${paragraphPrefix}one`]: "译文" },
  };

  const freshConflict = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: digestV2(derived),
  });
  const conflictBefore = structuredClone(freshConflict.state.digest_abc123);
  const conflict = await createMutationCoordinator(freshConflict, {
    now: () => OVERVIEW_NOW,
  }).commitDigestBase(
    0,
    "abc123",
    digestBase({ fingerprint: OTHER_OVERVIEW_FINGERPRINT }),
  );
  assert.deepEqual(conflict, {
    success: false,
    code: "DIGEST_FINGERPRINT_CONFLICT",
    retryable: false,
  });
  assert.deepEqual(freshConflict.state.digest_abc123, conflictBefore);

  for (const [name, stored, incomingFingerprint, keepsDerived] of [
    [
      "expired-same",
      digestV2({
        timestamp: OVERVIEW_NOW - OVERVIEW_ATTEMPT_TTL_MS,
        ...derived,
      }),
      OVERVIEW_FINGERPRINT,
      true,
    ],
    [
      "expired-different",
      digestV2({
        timestamp: OVERVIEW_NOW - OVERVIEW_ATTEMPT_TTL_MS,
        ...derived,
      }),
      OTHER_OVERVIEW_FINGERPRINT,
      false,
    ],
    [
      "future-same",
      digestV2({ timestamp: OVERVIEW_NOW + 1, ...derived }),
      OVERVIEW_FINGERPRINT,
      false,
    ],
    [
      "invalid-same",
      digestV2({ timestamp: "invalid", ...derived }),
      OVERVIEW_FINGERPRINT,
      false,
    ],
  ]) {
    const storage = createStorage({
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_abc123: stored,
    });
    const coordinator = createMutationCoordinator(storage, {
      now: () => OVERVIEW_NOW,
    });
    const result = await coordinator.commitDigestBase(
      0,
      "abc123",
      digestBase({ fingerprint: incomingFingerprint }),
    );

    assert.equal(result.success, true, name);
    assert.equal(storage.state.digest_abc123.timestamp, OVERVIEW_NOW, name);
    assert.equal(
      Object.hasOwn(storage.state.digest_abc123, "basicOverview"),
      keepsDerived,
      name,
    );
    assert.equal(
      Object.hasOwn(storage.state.digest_abc123, "deepAnalysis"),
      keepsDerived,
      name,
    );
    assert.equal(
      Object.hasOwn(storage.state.digest_abc123, "paragraphCache"),
      keepsDerived,
      name,
    );
  }
});

test("expired same-source migration keeps only an exact time-valid Basic Overview schema", async () => {
  const validWithUnknowns = {
    ...basicOverview(),
    unknownTopLevel: "drop",
    conclusions: [
      {
        id: "conclusion-1",
        titleZh: "结论",
        explanationZh: "解释",
        evidenceLevel: "strong",
        evidenceSegmentIds: ["segment-0-0"],
        unknownNested: "drop",
      },
    ],
    chapters: [
      {
        titleZh: "章节",
        summaryZh: "摘要",
        startSegmentId: "segment-0-0",
        timestampSeconds: 0,
        unknownNested: "drop",
      },
    ],
  };
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: digestV2({
      timestamp: OVERVIEW_NOW - OVERVIEW_ATTEMPT_TTL_MS,
      basicOverview: validWithUnknowns,
    }),
  });
  const coordinator = createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  });

  await coordinator.commitDigestBase(0, "abc123", digestBase());

  assert.deepEqual(storage.state.digest_abc123.basicOverview, {
    schemaVersion: 1,
    transcriptFingerprint: OVERVIEW_FINGERPRINT,
    generatedAt: OVERVIEW_NOW,
    oneSentenceZh: "可靠的基础概览。",
    conclusions: [
      {
        id: "conclusion-1",
        titleZh: "结论",
        explanationZh: "解释",
        evidenceLevel: "strong",
        evidenceSegmentIds: ["segment-0-0"],
      },
    ],
    chapters: [
      {
        titleZh: "章节",
        summaryZh: "摘要",
        startSegmentId: "segment-0-0",
        timestampSeconds: 0,
      },
    ],
    complete: false,
  });

  storage.state.digest_abc123.timestamp =
    OVERVIEW_NOW - OVERVIEW_ATTEMPT_TTL_MS;
  storage.state.digest_abc123.basicOverview = {
    ...basicOverview(),
    generatedAt: OVERVIEW_NOW + 1,
  };
  await coordinator.commitDigestBase(0, "abc123", digestBase());
  assert.equal(
    Object.hasOwn(storage.state.digest_abc123, "basicOverview"),
    false,
  );
});

test("digest base enforces one aggregate input bound before storage access", async () => {
  const storage = createStorage({ [STORAGE_KEYS.resetEpoch]: 0 });
  const coordinator = createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  });
  const oversized = digestBase({
    transcriptText: "x".repeat(2 * 1024 * 1024 + 1),
  });

  await assert.rejects(
    coordinator.commitDigestBase(0, "abc123", oversized),
    /digest base/i,
  );
  assert.deepEqual(storage.events, []);
});

test("trusted v2 source proof uses the authoritative fingerprint instead of raw caption shape", async () => {
  const storedDeep = completeDeepAnalysis("keep");
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: digestV2({
      transcript: [{ text: "stored", start: 0, duration: 2 }],
      deepAnalysis: storedDeep,
    }),
  });
  const coordinator = createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  });

  const result = await coordinator.commitDigestBase(
    0,
    "abc123",
    digestBase({
      transcript: [{ text: "different", start: 0, duration: 2 }],
    }),
  );

  assert.equal(result.success, true);
  assert.deepEqual(storage.state.digest_abc123.deepAnalysis, storedDeep);
  assert.equal(storage.state.digest_abc123.timestamp, OVERVIEW_NOW - 1_000);
  assert.deepEqual(storage.state.digest_abc123.transcript, [
    { text: "different", start: 0, duration: 2 },
  ]);
});

test("canonical transcript equality ignores object property insertion order", async () => {
  const storedDeep = { partial: "preserve" };
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: digestV2({
      transcript: [
        { start: 0, duration: 2, text: "source", ignoredLegacyField: true },
      ],
      transcriptLanguage: " en ",
      deepAnalysis: storedDeep,
    }),
  });
  const result = await createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  }).commitDigestBase(
    0,
    "abc123",
    digestBase({
      transcript: [{ text: "source", start: 0, duration: 2 }],
      transcriptText: "same source",
    }),
  );

  assert.equal(result.success, true);
  assert.deepEqual(storage.state.digest_abc123.deepAnalysis, storedDeep);
  assert.equal(storage.state.digest_abc123.timestamp, OVERVIEW_NOW - 1_000);
});

test("canonical transcript equality follows shared segment grouping across caption boundaries", async () => {
  const storedDeep = { partial: "preserve-across-equivalent-chunks" };
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: digestV2({
      transcript: [
        { text: "Hello ", start: 0, duration: 1 },
        { text: "world.", start: 1, duration: 1 },
      ],
      deepAnalysis: storedDeep,
    }),
  });

  const result = await createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  }).commitDigestBase(
    0,
    "abc123",
    digestBase({
      transcript: [{ text: "Hello world.", start: 0, duration: 2 }],
      transcriptText: "Hello world.",
      transcriptTimestamped: "[0:00] Hello world.",
    }),
  );

  assert.equal(result.success, true);
  assert.deepEqual(storage.state.digest_abc123.deepAnalysis, storedDeep);
  assert.equal(storage.state.digest_abc123.timestamp, OVERVIEW_NOW - 1_000);
});

test("digest base proves transcript and source language before migrating derived state", async () => {
  const prefix = `abc123:${OVERVIEW_FINGERPRINT}:`;
  const derived = {
    basicOverview: basicOverview(),
    deepAnalysis: { partial: "must-not-cross-source" },
    paragraphCache: { [`${prefix}old`]: "旧译文" },
  };

  const freshLanguageConflict = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: digestV2({ transcriptLanguage: "zh", ...derived }),
  });
  const freshBefore = structuredClone(freshLanguageConflict.state.digest_abc123);
  const freshResult = await createMutationCoordinator(freshLanguageConflict, {
    now: () => OVERVIEW_NOW,
  }).commitDigestBase(0, "abc123", digestBase({ transcriptLanguage: "en" }));
  assert.deepEqual(freshResult, {
    success: false,
    code: "DIGEST_TRANSCRIPT_CONFLICT",
    retryable: false,
  });
  assert.deepEqual(freshLanguageConflict.state.digest_abc123, freshBefore);

  const expiredTrustedV2 = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: digestV2({
      timestamp: OVERVIEW_NOW - OVERVIEW_ATTEMPT_TTL_MS,
      transcript: [{ text: "different", start: 0, duration: 2 }],
      ...derived,
    }),
  });
  const expiredResult = await createMutationCoordinator(expiredTrustedV2, {
    now: () => OVERVIEW_NOW,
  }).commitDigestBase(0, "abc123", digestBase());
  assert.equal(expiredResult.success, true);
  assert.equal(expiredTrustedV2.state.digest_abc123.timestamp, OVERVIEW_NOW);
  assert.equal(
    Object.hasOwn(expiredTrustedV2.state.digest_abc123, "basicOverview"),
    true,
  );
  assert.equal(
    Object.hasOwn(expiredTrustedV2.state.digest_abc123, "deepAnalysis"),
    true,
  );
  assert.equal(
    Object.hasOwn(expiredTrustedV2.state.digest_abc123, "paragraphCache"),
    true,
  );

  for (const [name, stored] of [
    [
      "legacy-transcript-mismatch",
      {
        ...digestBase(),
        timestamp: OVERVIEW_NOW - 1_000,
        transcript: [{ text: "different", start: 0, duration: 2 }],
        ...derived,
      },
    ],
    [
      "legacy-language-mismatch",
      {
        ...digestBase({ transcriptLanguage: "zh" }),
        timestamp: OVERVIEW_NOW - 1_000,
        ...derived,
      },
    ],
  ]) {
    const storage = createStorage({
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_abc123: stored,
    });
    const result = await createMutationCoordinator(storage, {
      now: () => OVERVIEW_NOW,
    }).commitDigestBase(0, "abc123", digestBase());

    assert.equal(result.success, true, name);
    assert.equal(storage.state.digest_abc123.timestamp, OVERVIEW_NOW, name);
    assert.equal(Object.hasOwn(storage.state.digest_abc123, "basicOverview"), false, name);
    assert.equal(Object.hasOwn(storage.state.digest_abc123, "deepAnalysis"), false, name);
    assert.equal(Object.hasOwn(storage.state.digest_abc123, "paragraphCache"), false, name);
  }
});

test("own partial deepAnalysis wins over legacy analysis during base migration", async () => {
  const partial = { schemaVersion: 2, reportComplete: false, partial: "latest" };
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: {
      ...digestBase(),
      timestamp: OVERVIEW_NOW - 1_000,
      deepAnalysis: partial,
      analysis: completeDeepAnalysis("stale-legacy"),
    },
  });

  const result = await createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  }).commitDigestBase(0, "abc123", digestBase());

  assert.equal(result.success, true);
  assert.deepEqual(storage.state.digest_abc123.deepAnalysis, partial);
});

test("malformed stored paragraph data is discarded without blocking a fresh base", async () => {
  const prefix = `abc123:${OVERVIEW_FINGERPRINT}:`;
  const oversizedStored = Object.fromEntries(
    Array.from({ length: 2_001 }, (_, index) => [
      `${prefix}${index}`,
      "旧译文",
    ]),
  );
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: digestV2({ paragraphCache: oversizedStored }),
  });

  const result = await createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  }).commitDigestBase(0, "abc123", digestBase());

  assert.equal(result.success, true);
  assert.equal(Object.hasOwn(storage.state.digest_abc123, "paragraphCache"), false);
});

test("same-source migration preserves recursively safe legacy and partial deep reports", async () => {
  for (const [name, deep] of [
    ["legacy", { legacySummary: "still readable" }],
    [
      "partial-v2",
      {
        schemaVersion: 2,
        reportComplete: false,
        summary: { oneSentenceZh: "partial" },
      },
    ],
  ]) {
    const storage = createStorage({
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_abc123: {
        ...digestBase(),
        timestamp: OVERVIEW_NOW - 1_000,
        analysis: deep,
      },
    });
    const coordinator = createMutationCoordinator(storage, {
      now: () => OVERVIEW_NOW,
    });

    const result = await coordinator.commitDigestBase(
      0,
      "abc123",
      digestBase(),
    );

    assert.equal(result.success, true, name);
    assert.deepEqual(storage.state.digest_abc123.deepAnalysis, deep, name);
  }
});

test("digest patches serialize deep and paragraph deltas without losing derived fields", async () => {
  const prefix = `abc123:${OVERVIEW_FINGERPRINT}:`;
  const overview = basicOverview();
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: digestV2({
      basicOverview: overview,
      deepAnalysis: completeDeepAnalysis("old-deep"),
      paragraphCache: { [`${prefix}existing`]: "已有" },
      futureUnknown: "drop",
    }),
  });
  const coordinator = createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  });
  const nextDeep = { schemaVersion: 2, reportComplete: false, partial: "keep" };

  const [deepResult, firstParagraphResult, secondParagraphResult] =
    await Promise.all([
      coordinator.patchDigest(
        0,
        "abc123",
        OVERVIEW_FINGERPRINT,
        { deepAnalysis: nextDeep },
      ),
      coordinator.patchDigest(
        0,
        "abc123",
        OVERVIEW_FINGERPRINT,
        { paragraphCache: { [`${prefix}one`]: "一" } },
      ),
      coordinator.patchDigest(
        0,
        "abc123",
        OVERVIEW_FINGERPRINT,
        { paragraphCache: { [`${prefix}two`]: "二" } },
      ),
    ]);

  assert.equal(deepResult.success, true);
  assert.equal(firstParagraphResult.success, true);
  assert.equal(secondParagraphResult.success, true);
  assert.deepEqual(storage.state.digest_abc123.deepAnalysis, nextDeep);
  assert.deepEqual(storage.state.digest_abc123.basicOverview, overview);
  assert.deepEqual(storage.state.digest_abc123.paragraphCache, {
    [`${prefix}existing`]: "已有",
    [`${prefix}one`]: "一",
    [`${prefix}two`]: "二",
  });
  assert.equal(storage.state.digest_abc123.timestamp, OVERVIEW_NOW - 1_000);
  assert.equal(Object.hasOwn(storage.state.digest_abc123, "futureUnknown"), false);
});

test("digest patch owns explicit null clearing while later stale base snapshots cannot revert translations", async () => {
  const prefix = `abc123:${OVERVIEW_FINGERPRINT}:`;
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: digestV2({
      deepAnalysis: completeDeepAnalysis("clear-me"),
      paragraphCache: { [`${prefix}same`]: "最新译文" },
    }),
  });
  const coordinator = createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  });

  const cleared = await coordinator.patchDigest(
    0,
    "abc123",
    OVERVIEW_FINGERPRINT,
    { deepAnalysis: null },
  );
  assert.equal(cleared.success, true);
  assert.equal(storage.state.digest_abc123.deepAnalysis, null);

  const base = await coordinator.commitDigestBase(
    0,
    "abc123",
    digestBase({
      paragraphCache: {
        [`${prefix}same`]: "过期快照",
        [`${prefix}missing`]: "可补充",
      },
      analysis: completeDeepAnalysis("must-not-revive"),
    }),
  );
  assert.equal(base.success, true);
  assert.equal(storage.state.digest_abc123.deepAnalysis, null);
  assert.deepEqual(storage.state.digest_abc123.paragraphCache, {
    [`${prefix}same`]: "最新译文",
  });
});

test("digest patch requires a current non-expired v2 digest with exact fingerprint and epoch", async () => {
  const prefix = `abc123:${OVERVIEW_FINGERPRINT}:`;
  for (const [name, epoch, stored, fingerprint, expected] of [
    [
      "missing",
      0,
      undefined,
      OVERVIEW_FINGERPRINT,
      "DIGEST_NOT_FOUND",
    ],
    [
      "legacy",
      0,
      { ...digestBase(), timestamp: OVERVIEW_NOW - 1_000 },
      OVERVIEW_FINGERPRINT,
      "DIGEST_SCHEMA_MISMATCH",
    ],
    [
      "wrong-fingerprint",
      0,
      digestV2(),
      OTHER_OVERVIEW_FINGERPRINT,
      "DIGEST_FINGERPRINT_MISMATCH",
    ],
    [
      "expired",
      0,
      digestV2({ timestamp: OVERVIEW_NOW - OVERVIEW_ATTEMPT_TTL_MS }),
      OVERVIEW_FINGERPRINT,
      "DIGEST_EXPIRED",
    ],
    [
      "future",
      0,
      digestV2({ timestamp: OVERVIEW_NOW + 1 }),
      OVERVIEW_FINGERPRINT,
      "DIGEST_EXPIRED",
    ],
    [
      "old-epoch",
      1,
      digestV2(),
      OVERVIEW_FINGERPRINT,
      "RESET_DURING_REQUEST",
    ],
  ]) {
    const initial = { [STORAGE_KEYS.resetEpoch]: epoch };
    if (stored) initial.digest_abc123 = stored;
    const storage = createStorage(initial);
    const before = stored ? structuredClone(stored) : undefined;
    const coordinator = createMutationCoordinator(storage, {
      now: () => OVERVIEW_NOW,
    });

    const result = await coordinator.patchDigest(
      0,
      "abc123",
      fingerprint,
      {
        paragraphCache: {
          [`abc123:${fingerprint}:new`]: "新译文",
        },
      },
    );

    assert.equal(result.success, false, name);
    assert.equal(result.code, expected, name);
    assert.deepEqual(storage.state.digest_abc123, before, name);
  }
});

test("digest patch rejects the whole hostile or malformed delta before storage", async () => {
  const prefix = `abc123:${OVERVIEW_FINGERPRINT}:`;
  const cyclic = {};
  cyclic.self = cyclic;
  const nestedAccessor = Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      throw new Error("must not execute deep getter");
    },
  });
  const tooManyParagraphs = Object.fromEntries(
    Array.from({ length: 2_001 }, (_, index) => [
      `${prefix}${index}`,
      "译文",
    ]),
  );
  for (const [name, patch] of [
    ["empty", {}],
    ["unknown", { unknown: true }],
    ["undefined-deep", { deepAnalysis: undefined }],
    ["wrong-prefix", { paragraphCache: { "other:key": "译文" } }],
    ["empty-value", { paragraphCache: { [`${prefix}empty`]: "   " } }],
    ["empty-paragraphs", { paragraphCache: {} }],
    ["too-many-paragraphs", { paragraphCache: tooManyParagraphs }],
    [
      "long-value",
      { paragraphCache: { [`${prefix}long`]: "译".repeat(20_001) } },
    ],
    ["cyclic-deep", { deepAnalysis: cyclic }],
    ["nested-accessor", { deepAnalysis: nestedAccessor }],
  ]) {
    const storage = createStorage({ [STORAGE_KEYS.resetEpoch]: 0 });
    const coordinator = createMutationCoordinator(storage, {
      now: () => OVERVIEW_NOW,
    });
    await assert.rejects(
      coordinator.patchDigest(
        0,
        "abc123",
        OVERVIEW_FINGERPRINT,
        patch,
      ),
      /digest patch/i,
      name,
    );
    assert.deepEqual(storage.events, [], name);
  }
});

test("digest patch enforces one aggregate bound across deep and paragraph data", async () => {
  const prefix = `abc123:${OVERVIEW_FINGERPRINT}:`;
  const paragraphs = Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => [
      `${prefix}${index}`,
      "译".repeat(8_000),
    ]),
  );
  const storage = createStorage({ [STORAGE_KEYS.resetEpoch]: 0 });
  const coordinator = createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  });

  await assert.rejects(
    coordinator.patchDigest(
      0,
      "abc123",
      OVERVIEW_FINGERPRINT,
      {
        deepAnalysis: { payload: "x".repeat(1_200_000) },
        paragraphCache: paragraphs,
      },
    ),
    /digest patch/i,
  );
  assert.deepEqual(storage.events, []);
});

test("patch rejects an over-limit paragraph union without changing the target", async () => {
  const prefix = `abc123:${OVERVIEW_FINGERPRINT}:`;
  const storedParagraphs = Object.fromEntries(
    Array.from({ length: 1_500 }, (_, index) => [
      `${prefix}stored-${index}`,
      "旧",
    ]),
  );
  const incomingParagraphs = Object.fromEntries(
    Array.from({ length: 600 }, (_, index) => [
      `${prefix}incoming-${index}`,
      "新",
    ]),
  );

  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_abc123: digestV2({ paragraphCache: storedParagraphs }),
  });
  const before = structuredClone(storage.state.digest_abc123);
  const coordinator = createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  });
  const result = await coordinator.patchDigest(
    0,
    "abc123",
    OVERVIEW_FINGERPRINT,
    { paragraphCache: incomingParagraphs },
  );

  assert.deepEqual(result, {
    success: false,
    code: "DIGEST_MERGE_TOO_LARGE",
    retryable: false,
  });
  assert.deepEqual(storage.state.digest_abc123, before);
  assert.equal(storage.events.some((event) => event.type === "set"), false);
});

test("patch rechecks TTL and clock after asynchronous cache reads", async () => {
  for (const [name, moveClock, expectedCode] of [
    ["exact-expiry", (value) => value + 1, "DIGEST_EXPIRED"],
    ["rollback", (value) => value - 1, "DIGEST_CLOCK_INVALID"],
  ]) {
    let now = OVERVIEW_NOW;
    let allReads = 0;
    const timestamp =
      name === "exact-expiry"
        ? OVERVIEW_NOW - OVERVIEW_ATTEMPT_TTL_MS + 1
        : OVERVIEW_NOW - 1_000;
    const storage = createStorage(
      {
        [STORAGE_KEYS.resetEpoch]: 0,
        digest_abc123: digestV2({ timestamp }),
      },
      {
        onGet(query) {
          if (query !== null) return;
          allReads += 1;
          if (allReads === 1) now = moveClock(now);
        },
      },
    );
    const before = structuredClone(storage.state.digest_abc123);
    const result = await createMutationCoordinator(storage, {
      now: () => now,
    }).patchDigest(0, "abc123", OVERVIEW_FINGERPRINT, {
      deepAnalysis: { partial: name },
    });

    assert.deepEqual(
      result,
      { success: false, code: expectedCode, retryable: false },
      name,
    );
    assert.deepEqual(storage.state.digest_abc123, before, name);
    assert.equal(
      storage.events.some((event) => event.type === "set"),
      false,
      name,
    );
  }
});

test("base fails for retry when a preserved lifetime expires before its final write", async () => {
  let now = OVERVIEW_NOW;
  let allReads = 0;
  const storage = createStorage(
    {
      [STORAGE_KEYS.resetEpoch]: 0,
      digest_abc123: digestV2({
        timestamp: OVERVIEW_NOW - OVERVIEW_ATTEMPT_TTL_MS + 1,
        deepAnalysis: { partial: "preserve-on-retry" },
      }),
    },
    {
      onGet(query) {
        if (query === null) {
          allReads += 1;
          if (allReads === 1) now += 1;
        }
      },
    },
  );
  const before = structuredClone(storage.state.digest_abc123);
  const coordinator = createMutationCoordinator(storage, { now: () => now });

  const crossed = await coordinator.commitDigestBase(
    0,
    "abc123",
    digestBase({ transcriptText: "first-attempt" }),
  );
  assert.deepEqual(crossed, {
    success: false,
    code: "DIGEST_EXPIRED",
    retryable: false,
  });
  assert.deepEqual(storage.state.digest_abc123, before);

  const retried = await coordinator.commitDigestBase(
    0,
    "abc123",
    digestBase({ transcriptText: "retry" }),
  );
  assert.equal(retried.success, true);
  assert.equal(storage.state.digest_abc123.timestamp, now);
  assert.equal(storage.state.digest_abc123.transcriptText, "retry");
  assert.deepEqual(storage.state.digest_abc123.deepAnalysis, {
    partial: "preserve-on-retry",
  });
});

test("base rejects a clock rollback before writing a future local timestamp", async () => {
  let now = OVERVIEW_NOW;
  const storage = createStorage(
    { [STORAGE_KEYS.resetEpoch]: 0 },
    {
      onGet(query) {
        if (query === null) now -= 1;
      },
    },
  );
  const result = await createMutationCoordinator(storage, {
    now: () => now,
  }).commitDigestBase(0, "abc123", digestBase());

  assert.deepEqual(result, {
    success: false,
    code: "DIGEST_CLOCK_INVALID",
    retryable: false,
  });
  assert.equal(Object.hasOwn(storage.state, "digest_abc123"), false);
  assert.equal(storage.events.some((event) => event.type === "set"), false);
});

test("digest base budget eviction never removes ledgers or unrelated stores", async () => {
  const attemptKey = overviewAttemptKey("keep-ledger");
  const storage = createStorage({
    [STORAGE_KEYS.resetEpoch]: 0,
    digest_oldest: {
      timestamp: 1,
      payload: "x".repeat(7 * 1024 * 1024),
    },
    [attemptKey]: { malformedButOutsideDigestBudget: true },
    [STORAGE_KEYS.notes]: [{ id: "keep-note" }],
    unrelated: { keep: true },
  });
  const result = await createMutationCoordinator(storage, {
    now: () => OVERVIEW_NOW,
  }).commitDigestBase(
    0,
    "abc123",
    digestBase({ transcriptText: "n".repeat(1_500_000) }),
  );

  assert.equal(result.success, true);
  assert.deepEqual(result.evictedKeys, ["digest_oldest"]);
  assert.equal(Object.hasOwn(storage.state, attemptKey), true);
  assert.equal(Object.hasOwn(storage.state, STORAGE_KEYS.notes), true);
  assert.equal(Object.hasOwn(storage.state, "unrelated"), true);
});

test("digest patch quota recovery retries once and preserves the target on terminal failure", async () => {
  for (const [name, failAttempts, expectedSuccess] of [
    ["recover", 1, true],
    ["terminal-failure", 2, false],
  ]) {
    let attempts = 0;
    const originalTarget = digestV2({ deepAnalysis: { partial: "old" } });
    const storage = createStorage(
      {
        [STORAGE_KEYS.resetEpoch]: 0,
        digest_abc123: originalTarget,
        digest_oldest: { timestamp: 1, payload: "old" },
        [overviewAttemptKey("keep-ledger")]: { keep: true },
        unrelated: { keep: true },
      },
      {
        onSet(items) {
          if (!Object.hasOwn(items, "digest_abc123")) return;
          attempts += 1;
          if (attempts <= failAttempts) {
            const error = new Error(`secret quota ${name}`);
            error.name = "QuotaExceededError";
            throw error;
          }
        },
      },
    );
    const result = await createMutationCoordinator(storage, {
      now: () => OVERVIEW_NOW,
    }).patchDigest(0, "abc123", OVERVIEW_FINGERPRINT, {
      deepAnalysis: { partial: "new" },
    });

    assert.equal(result.success, expectedSuccess, name);
    assert.equal(attempts, expectedSuccess ? 2 : 2, name);
    assert.deepEqual(result.evictedKeys, ["digest_oldest"], name);
    if (expectedSuccess) {
      assert.deepEqual(storage.state.digest_abc123.deepAnalysis, {
        partial: "new",
      });
      assert.equal(result.retriedAfterQuota, true);
    } else {
      assert.equal(result.code, "STORAGE_QUOTA_EXCEEDED");
      assert.deepEqual(storage.state.digest_abc123, originalTarget);
    }
    assert.equal(
      Object.hasOwn(storage.state, overviewAttemptKey("keep-ledger")),
      true,
      name,
    );
    assert.equal(Object.hasOwn(storage.state, "unrelated"), true, name);
    assert.equal(JSON.stringify(result).includes("secret"), false, name);
  }
});
