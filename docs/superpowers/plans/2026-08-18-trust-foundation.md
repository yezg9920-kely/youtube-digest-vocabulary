# Trust Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every video-bound result, provider failure, and local-data mutation deterministic before automatic Overview work is introduced.

**Architecture:** Add small pure modules for provider failures and persistence, route reset-sensitive writes through one background mutation coordinator, and give the side panel an immutable video-session token. Keep the existing Manifest V3/no-bundler architecture and preserve current storage keys.

**Tech Stack:** Chrome Manifest V3, classic JavaScript, `chrome.storage.local`, `chrome.runtime` messaging, Node.js built-in test runner, VM test sandboxes.

---

## File structure

- Create `providers.js`: canonical provider failure envelopes and observable provider status records.
- Create `persistence.js`: storage-key catalogue, reset summaries, FIFO mutation coordinator, reset epoch, digest byte budgeting.
- Create `tests/provider-errors.test.js`: pure status/error mappings.
- Create `tests/persistence.test.js`: FIFO, reset, stale-epoch, summary, and quota behavior.
- Create `tests/session-lifecycle.test.js`: A-to-B/A-to-B-to-A session isolation and explicit tab routing.
- Create `tests/transcript-provider.test.js`: bounded Supadata sync/async behavior.
- Modify `settings.js`: independent provider settings and `autoBasicOverview` consent default.
- Modify `background.js`: import the modules, centralize mutations, type provider results, target explicit tabs.
- Modify `sidepanel.js`: own `VideoSession`, clear video-bound UI atomically, route digest persistence through background.
- Modify `sidepanel.html`: add typed-error cost/secondary-action surfaces required by the foundation.
- Modify `scripts/check-release.sh` and `tests/release.test.js`: allow and verify the new runtime modules.

## Task 1: Canonical provider failures and status

**Files:**
- Create: `providers.js`
- Create: `tests/provider-errors.test.js`
- Modify: `scripts/check-release.sh`
- Modify: `tests/release.test.js`

- [ ] **Step 1: Write failing mapping tests**

Test the exact public contract:

```js
const providers = require("../providers.js");

test("Supadata 206 is a possibly billed no-transcript failure", () => {
  assert.deepEqual(
    providers.mapHttpFailure({
      provider: "supadata",
      stage: "transcript",
      status: 206,
      payload: {},
      dispatched: true,
    }),
    {
      code: "NO_TRANSCRIPT",
      provider: "supadata",
      stage: "transcript",
      retryable: false,
      mayHaveConsumedCredit: true,
      primaryAction: "choose_video",
    },
  );
});

test("real success records an injected verification time", () => {
  assert.deepEqual(providers.statusAfterSuccess(1234), {
    state: "connected",
    lastCheckedAt: 1234,
    lastFailureCode: "",
  });
});
```

Also cover 401, 403, 429, documented quota payloads, `AbortError`, fetch `TypeError`, empty/malformed/oversized response, missing key before dispatch, and stale epoch.

- [ ] **Step 2: Run the focused test and confirm red**

Run: `node --test tests/provider-errors.test.js`

Expected: FAIL with `Cannot find module '../providers.js'`.

- [ ] **Step 3: Implement the pure module**

Create one global/module export with stable enums and envelopes:

```js
var YTD_PROVIDERS = (() => {
  const STATUS = Object.freeze({
    UNSAVED: "unsaved",
    SAVED_UNTESTED: "saved_untested",
    CONNECTED: "connected",
    REJECTED: "rejected",
    RATE_LIMITED: "rate_limited",
    UNAVAILABLE: "unavailable",
  });
  const ERROR_CODES = Object.freeze({
    MISSING_KEY: "MISSING_KEY",
    INVALID_KEY: "INVALID_KEY",
    NO_TRANSCRIPT: "NO_TRANSCRIPT",
    RATE_LIMITED: "RATE_LIMITED",
    INSUFFICIENT_CREDIT: "INSUFFICIENT_CREDIT",
    NETWORK_ERROR: "NETWORK_ERROR",
    REQUEST_TIMEOUT: "REQUEST_TIMEOUT",
    EMPTY_RESPONSE: "EMPTY_RESPONSE",
    MALFORMED_RESPONSE: "MALFORMED_RESPONSE",
    RESPONSE_TOO_LARGE: "RESPONSE_TOO_LARGE",
    SESSION_STALE: "SESSION_STALE",
    RESET_DURING_REQUEST: "RESET_DURING_REQUEST",
    UNKNOWN_PROVIDER_ERROR: "UNKNOWN_PROVIDER_ERROR",
  });

  function failure(code, provider, stage, dispatched, overrides = {}) {
    return {
      code,
      provider,
      stage,
      retryable: false,
      mayHaveConsumedCredit: Boolean(dispatched),
      primaryAction: "retry",
      ...overrides,
    };
  }

  function mapHttpFailure({ provider, stage, status, payload, dispatched }) {
    const message = JSON.stringify(payload || {}).toLowerCase();
    if (status === 206 || status === 404) {
      return failure(ERROR_CODES.NO_TRANSCRIPT, provider, stage, dispatched,
        { primaryAction: "choose_video" });
    }
    if (/balance|insufficient credit|quota exceeded/.test(message)) {
      return failure(ERROR_CODES.INSUFFICIENT_CREDIT, provider, stage, dispatched,
        { primaryAction: "open_billing" });
    }
    if (status === 401 || status === 403) {
      return failure(ERROR_CODES.INVALID_KEY, provider, stage, dispatched,
        { primaryAction: "open_settings" });
    }
    if (status === 429) {
      return failure(ERROR_CODES.RATE_LIMITED, provider, stage, dispatched,
        { retryable: true, primaryAction: "retry_later" });
    }
    return failure(ERROR_CODES.UNKNOWN_PROVIDER_ERROR, provider, stage,
      dispatched, { retryable: status >= 500 });
  }

  function mapThrownFailure({ provider, stage, error, dispatched }) {
    if (error?.code === ERROR_CODES.RESPONSE_TOO_LARGE) {
      return failure(ERROR_CODES.RESPONSE_TOO_LARGE, provider, stage, dispatched);
    }
    if (error?.name === "AbortError" || /timeout/i.test(error?.message || "")) {
      return failure(ERROR_CODES.REQUEST_TIMEOUT, provider, stage, dispatched,
        { retryable: true });
    }
    if (error instanceof TypeError) {
      return failure(ERROR_CODES.NETWORK_ERROR, provider, stage, dispatched,
        { retryable: true });
    }
    return failure(ERROR_CODES.UNKNOWN_PROVIDER_ERROR, provider, stage,
      dispatched, { retryable: true });
  }

  function statusAfterSuccess(lastCheckedAt) {
    return { state: STATUS.CONNECTED, lastCheckedAt, lastFailureCode: "" };
  }
  function statusAfterFailure(value, lastCheckedAt = null) {
    const state = value.code === ERROR_CODES.INVALID_KEY
      ? STATUS.REJECTED
      : value.code === ERROR_CODES.RATE_LIMITED
        ? STATUS.RATE_LIMITED
        : STATUS.UNAVAILABLE;
    return { state, lastCheckedAt, lastFailureCode: value.code };
  }
  function normalizeStatusRecord(record, hasKey) {
    if (!hasKey) return { state: STATUS.UNSAVED, lastCheckedAt: null,
      lastFailureCode: "" };
    if (!Object.values(STATUS).includes(record?.state)) {
      return { state: STATUS.SAVED_UNTESTED, lastCheckedAt: null,
        lastFailureCode: "" };
    }
    return {
      state: record.state,
      lastCheckedAt: Number.isFinite(Number(record.lastCheckedAt))
        ? Number(record.lastCheckedAt) : null,
      lastFailureCode: String(record.lastFailureCode || "").slice(0, 80),
    };
  }
  return { STATUS, ERROR_CODES, mapHttpFailure, mapThrownFailure,
    normalizeStatusRecord, statusAfterSuccess, statusAfterFailure };
})();
```

401/403 return `INVALID_KEY/open_settings`, 429 returns `RATE_LIMITED/retry_later`, 206 returns `NO_TRANSCRIPT/choose_video`, and only a payload containing a documented balance/quota marker returns `INSUFFICIENT_CREDIT/open_billing`.

- [ ] **Step 4: Add the runtime file to the release allowlist and tests**

Add `providers.js` to `public_allowlist`, `required_public_files`, and the release-test expected prompt/runtime surface. Do not change host permissions.

- [ ] **Step 5: Run focused and release tests**

Run: `node --test tests/provider-errors.test.js tests/release.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add providers.js tests/provider-errors.test.js scripts/check-release.sh tests/release.test.js
git commit -m "feat: normalize provider failures and status"
```

## Task 2: Durable persistence coordinator and reset epoch

**Files:**
- Create: `persistence.js`
- Create: `tests/persistence.test.js`
- Modify: `scripts/check-release.sh`
- Modify: `tests/release.test.js`

- [ ] **Step 1: Write failing persistence tests**

Build an in-memory async storage double and assert:

```js
const coordinator = persistence.createMutationCoordinator(storage);
const oldEpoch = await coordinator.captureEpoch();
const reset = await coordinator.resetExtensionData();
const late = await coordinator.commit(oldEpoch, async (store) => {
  await store.set({ ytd_vocabulary: [{ id: "late" }] });
});

assert.equal(reset.success, true);
assert.equal(late.success, false);
assert.equal(late.code, "RESET_DURING_REQUEST");
assert.deepEqual(Object.keys(storage.state).sort(), [
  "ytd_options_language",
  "ytd_reset_epoch",
]);
```

Also assert exact category counts, FIFO save/delete order, reset verification failure, a mutation committed before reset being cleared, digest-only eviction, 8 MiB pre-eviction, and exactly one retry after simulated quota failure.

- [ ] **Step 2: Run the focused test and confirm red**

Run: `node --test tests/persistence.test.js`

Expected: FAIL with the missing module.

- [ ] **Step 3: Implement storage keys and summary helpers**

Create:

```js
const STORAGE_KEYS = Object.freeze({
  settings: "ytd_settings",
  providerStatus: "ytd_provider_status",
  notes: "ytd_notes",
  vocabulary: "ytd_vocabulary",
  language: "ytd_options_language",
  resetEpoch: "ytd_reset_epoch",
});
const DIGEST_PREFIX = "digest_";
const DIGEST_BUDGET_BYTES = 8 * 1024 * 1024;
```

`summarizeStoredData(all)` counts settings/status presence, digest objects, paragraph-cache translation entries, note rows, and vocabulary entries. `listResettableKeys(all)` excludes only language and reset epoch.

- [ ] **Step 4: Implement one FIFO coordinator**

`createMutationCoordinator(storage)` owns one promise queue. `commit(expectedEpoch, operation)` enqueues the epoch reread and operation without a yield point that another coordinator operation can enter. `resetExtensionData()` enqueues summary, writes `oldEpoch + 1`, removes resettable keys, rereads storage, and returns `RESET_VERIFICATION_FAILED` if any target remains.

Add `commitDigest(expectedEpoch, videoId, value)` which pre-evicts only `digest_*` keys oldest first, uses `getBytesInUse` or UTF-8 JSON estimation, and retries one quota failure after another oldest-first eviction.

- [ ] **Step 5: Add to release surface and pass tests**

Run: `node --test tests/persistence.test.js tests/release.test.js`

Expected: PASS with no non-digest eviction.

- [ ] **Step 6: Commit**

```bash
git add persistence.js tests/persistence.test.js scripts/check-release.sh tests/release.test.js
git commit -m "feat: serialize local data mutations and reset"
```

## Task 3: Independent settings and centralized background writes

**Files:**
- Modify: `settings.js`
- Modify: `background.js`
- Modify: `tests/settings.test.js`
- Create: `tests/background-persistence.test.js`

- [ ] **Step 1: Add failing settings tests**

Assert that legacy settings normalize to `autoBasicOverview: false`, and that provider updates do not touch the other provider:

```js
const start = settings.normalize({
  supadataApiKey: "supadata-old",
  aiApiKey: "deepseek-old",
});
assert.deepEqual(
  settings.mergeProviderSettings(start, "supadata", "supadata-new"),
  { ...start, supadataApiKey: "supadata-new" },
);
assert.equal(settings.normalize({ aiApiKey: "key" }).autoBasicOverview, false);
```

- [ ] **Step 2: Add failing message-level mutation tests**

Load `background.js` in a VM with `YTD_PROVIDERS` and `YTD_PERSISTENCE`. Send concurrent save-note, delete-note, vocabulary-save, digest-persist, and reset actions. Assert FIFO results and that an old-epoch digest cannot reappear.

Run: `node --test tests/settings.test.js tests/background-persistence.test.js`

Expected: FAIL because provider merge and centralized actions do not exist.

- [ ] **Step 3: Extend settings without breaking legacy migration**

Add `autoBasicOverview: false` to defaults and normalized output. Implement:

```js
function mergeProviderSettings(current, provider, apiKey, options = {}) {
  const next = normalize(current);
  if (provider === "supadata") next.supadataApiKey = String(apiKey || "").trim();
  if (provider === "deepseek") {
    next.aiApiKey = String(apiKey || "").trim();
    if (typeof options.autoBasicOverview === "boolean") {
      next.autoBasicOverview = options.autoBasicOverview;
    }
  }
  return next;
}
```

- [ ] **Step 4: Centralize background persistence**

Load runtime modules in this order:

```js
importScripts("settings.js", "providers.js", "persistence.js");
const storageMutations =
  YTD_PERSISTENCE.createMutationCoordinator(chrome.storage.local);
```

Task 3 integration invariants:

- create exactly one top-level coordinator in `background.js`; do not create a
  coordinator in the side panel, options page, or inside a message handler;
- route every extension-context mutation through background messages and that
  one coordinator, leaving side panel and options code as intent senders;
- coordinator operation callbacks use only their passed `storage` argument,
  return or await every storage promise, and never call `storageMutations`
  recursively, including after an `await`;
- message-level tests must prove ordinary external concurrency still queues,
  synchronously detectable same-callback reentry fails fast, and no unawaited
  operation write can outlive a reset.

Add message handlers for `getResetEpoch`, `persistDigestCache`, `getLocalDataSummary`, `resetExtensionData`, `clearDigestCache`, `deleteAllNotes`, `saveProviderSettings`, and `removeProviderKey`. Provider key changes write `saved_untested` status without calling `fetch`.

Replace note and vocabulary read-modify-write paths with `storageMutations.commit(capturedEpoch, operation)`. Generate note IDs with `crypto.randomUUID()` and a bounded timestamp/random fallback.

- [ ] **Step 5: Run focused then full tests**

Run:

```bash
node --test tests/settings.test.js tests/background-persistence.test.js tests/vocabulary.test.js
npm test
```

Expected: all tests PASS; existing vocabulary request-order tests remain green.

- [ ] **Step 6: Commit**

```bash
git add settings.js background.js tests/settings.test.js tests/background-persistence.test.js tests/vocabulary.test.js
git commit -m "feat: centralize reset-safe extension storage"
```

## Task 4: VideoSession lifecycle and explicit tab routing

**Files:**
- Modify: `sidepanel.js`
- Modify: `background.js`
- Create: `tests/session-lifecycle.test.js`
- Modify: `tests/deep-analysis.test.js`

- [ ] **Step 1: Write deferred-response session tests**

Expose `createVideoSessionManager` for Node tests and assert:

```js
const manager = createVideoSessionManager(() => `session-${++id}`);
const a = manager.begin({ videoId: "AAAAAA", tabId: 11, windowId: 1, resetEpoch: 0 });
const b = manager.begin({ videoId: "BBBBBB", tabId: 12, windowId: 1, resetEpoch: 0 });
assert.equal(manager.isCurrent(a), false);
assert.equal(manager.isCurrent(b), true);
assert.equal(a.abortController.signal.aborted, true);
```

Use deferred metadata/transcript promises to prove B wins when A resolves last. Assert stale responses cannot call render, cache, notes, translation, playback, or export commits. Assert A-to-B-to-A gets a third unique token.

- [ ] **Step 2: Write explicit relay tests**

Send `relayToContent` with `tabId: 22` while the VM's active YouTube tab is 11. Assert `chrome.tabs.sendMessage` and `getPlayerVideoDetails` use 22 and `tabs.query` is never called.

Run: `node --test tests/session-lifecycle.test.js`

Expected: FAIL against current fallback routing and analysis-only coordinator.

- [ ] **Step 3: Implement the manager and atomic UI reset**

`begin()` creates `{ sessionId, generation, videoId, tabId, windowId, resetEpoch, abortController }`; `capture()` returns an immutable token; `isCurrent()` compares session ID, generation, video ID, and tab ID.

`resetVideoBoundUi()` stops playback, increments translation generation, disconnects observers, clears transcript/analysis/notes/status DOM, hides stale video metadata, resets memory fields, and activates Overview without starting deep analysis.

- [ ] **Step 4: Bind detection and requests to the panel window**

`checkCurrentTab()` queries only `{ active: true, windowId: panelWindowId }`. Remove the any-YouTube fallback. Begin the session before awaiting metadata. Pass the captured token through `startDigest`, `loadFromCache`, `fetchTranscript`, notes, translation, analysis, seek, playback, and persistence. Check `isCurrent()` after every await and immediately before UI/storage effects.

- [ ] **Step 5: Require explicit relay targets**

`relayToContent` rejects a missing/invalid `tabId`, validates the tab URL is YouTube, and sends only to that ID. Button-originated `startDigestFromButton` includes `sender.tab.id`.

- [ ] **Step 6: Run lifecycle and full tests**

Run:

```bash
node --test tests/session-lifecycle.test.js tests/deep-analysis.test.js
npm test
```

Expected: PASS, including the existing delayed deep-analysis generation test.

- [ ] **Step 7: Commit**

```bash
git add sidepanel.js background.js tests/session-lifecycle.test.js tests/deep-analysis.test.js
git commit -m "fix: isolate every video session and tab"
```

## Task 5: Bounded Supadata client and typed panel errors

**Files:**
- Modify: `background.js`
- Modify: `sidepanel.js`
- Modify: `sidepanel.html`
- Create: `tests/transcript-provider.test.js`
- Modify: `tests/session-lifecycle.test.js`

- [ ] **Step 1: Write fake-clock provider tests**

Inject `fetch`, clock, timers, and response bodies. Assert initial request abort at 30 seconds, each poll abort at 15 seconds, job deadline at 90 seconds, 5 MiB response rejection, async-completed empty content rejection, and identical `cleanText` use for sync/async timestamped output.

Run: `node --test tests/transcript-provider.test.js`

Expected: FAIL because current fetches have no timeout/body guard and async empty succeeds.

- [ ] **Step 2: Extract shared response normalization inside background**

Implement `normalizeSupadataTranscript(data)` once and use it for both the initial 200 body and completed 202 job. It returns `EMPTY_RESPONSE` when no cleaned entries remain.

- [ ] **Step 3: Add bounded fetch and wall-clock polling**

Implement `fetchWithDeadline(url, init, { timeoutMs, maxBytes })`, abort with `REQUEST_TIMEOUT`, count UTF-8/body stream bytes, and parse JSON into `MALFORMED_RESPONSE` on failure. Poll until injected `now()` exceeds the 90-second deadline, not a fixed number of attempts.

- [ ] **Step 4: Render typed failures**

Extend the existing error state with `#errorCostNote` and `#errorSecondaryBtn`. Replace generic “No transcript found” handling with a mapping from canonical failure code to Chinese title, explanation, primary action, secondary action, and conservative credit note. Keep completed transcript/overview content visible for analysis-stage errors.

- [ ] **Step 5: Run focused and full tests**

Run:

```bash
node --test tests/transcript-provider.test.js tests/session-lifecycle.test.js
npm test
npm run check
```

Expected: all PASS, release allowlist unchanged except the two approved runtime modules.

- [ ] **Step 6: Commit**

```bash
git add background.js sidepanel.js sidepanel.html tests/transcript-provider.test.js tests/session-lifecycle.test.js
git commit -m "fix: bound transcript requests and recover by failure type"
```

## Gate 1 verification

- [ ] Run `npm test` and require 0 failures.
- [ ] Run `npm run check` and require release checks to pass.
- [ ] Run `git diff --check` and require no whitespace errors.
- [ ] Review `git diff 6dcafb8...HEAD` against success criteria 1, 7, 8, 9, 10, and 14 in the approved design.
- [ ] Confirm `manifest.json` permissions and host permissions are byte-for-byte unchanged.
