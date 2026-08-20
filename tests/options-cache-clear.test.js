const test = require("node:test");
const assert = require("node:assert/strict");

const {
  clearCachedDigestData,
  deleteAllNotesData,
  resetExtensionData,
} = require("../options.js");

function createStorage(initial = {}) {
  const state = structuredClone(initial);
  const calls = { get: 0, set: 0, remove: 0, clear: 0 };
  const select = (keys) => {
    if (keys === null) return structuredClone(state);
    const requested = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(
      requested
        .filter((key) => Object.hasOwn(state, key))
        .map((key) => [key, structuredClone(state[key])]),
    );
  };
  return {
    state,
    calls,
    async get(keys) {
      calls.get += 1;
      return select(keys);
    },
    async set(items) {
      calls.set += 1;
      Object.assign(state, structuredClone(items));
    },
    async remove(keys) {
      calls.remove += 1;
      for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
    },
    async clear() {
      calls.clear += 1;
      for (const key of Object.keys(state)) delete state[key];
    },
  };
}

test("extension data actions send one background intent and never mutate storage directly", async () => {
  const messages = [];
  const root = {
    chrome: {
      storage: { local: {} },
      runtime: {
        async sendMessage(message) {
          messages.push(structuredClone(message));
          if (message.action === "clearDigestCache") {
            return {
              success: true,
              resetEpoch: 4,
              removedCount: 2,
              removedAttemptCount: 1,
            };
          }
          if (message.action === "deleteAllNotes") {
            return { success: true, deletedCount: 3 };
          }
          return { success: true, resetEpoch: 5 };
        },
      },
    },
  };
  const storage = createStorage({ digest_abc123: { keepUntilBackground: true } });

  assert.deepEqual(await clearCachedDigestData(root, storage), {
    success: true,
    resetEpoch: 4,
    removedCount: 2,
    removedAttemptCount: 1,
  });
  assert.deepEqual(await deleteAllNotesData(root, storage), {
    success: true,
    deletedCount: 3,
  });
  assert.deepEqual(await resetExtensionData(root, storage, "zh-CN"), {
    success: true,
    resetEpoch: 5,
  });
  assert.deepEqual(messages, [
    { action: "clearDigestCache" },
    { action: "deleteAllNotes" },
    { action: "resetExtensionData" },
  ]);
  assert.deepEqual(storage.calls, { get: 0, set: 0, remove: 0, clear: 0 });
  assert.equal(Object.hasOwn(storage.state, "digest_abc123"), true);
});

test("extension mutation failures never fall back to direct storage writes", async () => {
  for (const [name, sendMessage, operation] of [
    [
      "rejected",
      async () => {
        throw new Error("secret runtime failure");
      },
      clearCachedDigestData,
    ],
    [
      "typed-failure",
      async () => ({ success: false, code: "STORAGE_WRITE_FAILED" }),
      deleteAllNotesData,
    ],
    ["missing-response", async () => undefined, resetExtensionData],
  ]) {
    const root = {
      chrome: { storage: { local: {} }, runtime: { sendMessage } },
    };
    const storage = createStorage({
      digest_abc123: { keep: true },
      ytd_notes: [{ id: "keep" }],
    });

    await assert.rejects(
      operation(root, storage, "en"),
      /background mutation failed/i,
      name,
    );
    assert.deepEqual(
      storage.calls,
      { get: 0, set: 0, remove: 0, clear: 0 },
      name,
    );
    assert.equal(Object.hasOwn(storage.state, "digest_abc123"), true, name);
    assert.equal(Object.hasOwn(storage.state, "ytd_notes"), true, name);
  }
});

test("extension mutation success envelopes require safe authority metadata", async () => {
  for (const [name, response, operation] of [
    [
      "cache-missing-attempt-count",
      { success: true, resetEpoch: 4, removedCount: 2 },
      clearCachedDigestData,
    ],
    [
      "cache-unsafe-epoch",
      {
        success: true,
        resetEpoch: Number.MAX_SAFE_INTEGER + 1,
        removedCount: 2,
        removedAttemptCount: 1,
      },
      clearCachedDigestData,
    ],
    [
      "cache-negative-count",
      {
        success: true,
        resetEpoch: 4,
        removedCount: -1,
        removedAttemptCount: 1,
      },
      clearCachedDigestData,
    ],
    ["reset-missing-epoch", { success: true }, resetExtensionData],
    [
      "reset-unsafe-epoch",
      { success: true, resetEpoch: Number.MAX_SAFE_INTEGER + 1 },
      resetExtensionData,
    ],
    [
      "notes-negative-count",
      { success: true, deletedCount: -1 },
      deleteAllNotesData,
    ],
  ]) {
    const root = {
      chrome: {
        storage: { local: {} },
        runtime: { async sendMessage() { return response; } },
      },
    };
    const storage = createStorage({
      digest_abc123: { keep: true },
      ytd_notes: [{ id: "keep" }],
    });

    await assert.rejects(
      operation(root, storage, "en"),
      /background mutation failed/i,
      name,
    );
    assert.deepEqual(
      storage.calls,
      { get: 0, set: 0, remove: 0, clear: 0 },
      name,
    );
  }
});

test("preview cache clearing removes both cache prefixes and reports preview-only authority", async () => {
  const attemptKey = `ytd_overview_attempt_v1_abc123_sha256-v1-${"a".repeat(64)}`;
  const storage = createStorage({
    digest_abc123: { timestamp: 1 },
    digest_def456: { timestamp: 2 },
    [attemptKey]: { attempt: true },
    ytd_notes: [{ id: "keep" }],
    ytd_settings: { keep: true },
  });

  const result = await clearCachedDigestData({}, storage);

  assert.deepEqual(result, {
    success: true,
    removedCount: 2,
    removedAttemptCount: 1,
    previewOnly: true,
  });
  assert.deepEqual(storage.calls, { get: 1, set: 0, remove: 1, clear: 0 });
  assert.deepEqual(storage.state, {
    ytd_notes: [{ id: "keep" }],
    ytd_settings: { keep: true },
  });
});

test("preview note deletion and reset remain local and preserve the selected language", async () => {
  const notesStorage = createStorage({
    ytd_notes: [{ id: "remove" }],
    digest_abc123: { keep: true },
  });
  assert.deepEqual(await deleteAllNotesData({}, notesStorage), {
    success: true,
    deletedCount: 1,
    previewOnly: true,
  });
  assert.equal(Object.hasOwn(notesStorage.state, "ytd_notes"), false);
  assert.equal(Object.hasOwn(notesStorage.state, "digest_abc123"), true);

  const resetStorage = createStorage({
    ytd_notes: [{ id: "remove" }],
    ytd_options_language: "en",
  });
  assert.deepEqual(await resetExtensionData({}, resetStorage, "zh-CN"), {
    success: true,
    previewOnly: true,
  });
  assert.deepEqual(resetStorage.state, { ytd_options_language: "zh-CN" });
});
