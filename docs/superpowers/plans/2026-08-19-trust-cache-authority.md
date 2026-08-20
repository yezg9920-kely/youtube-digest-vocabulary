# Trust Cache Authority Implementation Plan

> **For agentic workers:** implement this plan with strict red-green TDD. Each
> subsection is a separate commit and must pass focused tests, the full suite,
> release checks, and independent review before the next subsection starts.

**Goal:** Make transcript, translation, Basic Overview, and Deep Analysis cache
writes safe across panels, worker restarts, resets, clears, and out-of-order
completion. Automatic Basic Overview must dispatch at most once per video and
transcript fingerprint during a fixed 30-day window.

**Architecture:** The background worker is the only mutation authority. A
single persistence FIFO owns reset generations, digest-v2 base writes, derived
field patches, the independent Overview-attempt ledger, and expiry pruning.
Panel code sends intents and never performs read-modify-write storage updates.

## Completed prerequisite: durable Overview attempt transactions

Commit `b44a4b9` added an independent
`ytd_overview_attempt_v1_<videoId>_<fingerprint>` ledger and coordinator
`claimBasicOverview` / `settleBasicOverview` operations.

The fixed contract is:

- ledger TTL is 30 days; a claimed attempt has a 180-second lease;
- only one automatic claim can win across panels or worker restarts;
- manual retry may replace failed, result-missing, or orphaned attempts, but
  never an active lease;
- settlement requires exact reset epoch, video, transcript fingerprint,
  attempt ID, and monotonic attempt revision;
- a successful provider result may settle after its panel closes or switches,
  because the durable attempt is the authority after provider dispatch;
- success merges only `basicOverview` into a current matching digest and does
  not extend the digest lifetime;
- failure stores only a bounded canonical provider envelope;
- a provider-success/cache-failure response exposes the overview and offers
  cache-only retry; it must never invoke the provider again;
- attempt ledgers are independent of the 8 MiB digest budget and are never
  evicted as digest-cache entries.

## Task 3B1: Scoped clear, digest-v2 primitives, and ledger pruning

**Files:**

- Modify: `persistence.js`
- Modify: `background.js`
- Modify: `options.js`
- Modify: `tests/persistence.test.js`
- Modify: `tests/background-persistence.test.js`
- Create: `tests/options-cache-clear.test.js`

### Persistence API

Add these methods to the existing singleton coordinator:

- `clearDigestCache()`
- `pruneExpiredOverviewAttempts()`
- `commitDigestBase(expectedEpoch, videoId, value, validateMutation)`
- `patchDigest(expectedEpoch, videoId, transcriptFingerprint, patch, validateMutation)`

Use `digestSchemaVersion: 2` as the top-level digest marker. Do not use the
generic field `schemaVersion`; that name belongs to nested Overview and Deep
Analysis objects.

`clearDigestCache()` owns one FIFO slot and performs, in order:

1. read all storage and compute the next safe reset epoch;
2. persist the new `ytd_reset_epoch` before deleting anything;
3. delete every `digest_*` and `ytd_overview_attempt_v1_*` key;
4. reread and verify the epoch and both key families;
5. return bounded counts for removed digests and attempt records.

It preserves settings, provider status, notes, vocabulary, language, and
unknown unrelated stores. A partial remove or verification failure must still
return the already-persisted reset epoch; it must not pretend the generation
fence was rolled back.

`pruneExpiredOverviewAttempts()` runs in the same FIFO. It deletes a ledger
only when the key matches its validated video/fingerprint identity, the full
record parses, `expiresAt <= now`, and `leaseUntil <= now`. It preserves active,
future, missing-expiry, identity-mismatched, and malformed records. Deletion is
verified and all failures are typed and bounded. The background worker invokes
it once, opportunistically, after constructing the coordinator; pruning must
not delay message-listener registration.

`commitDigestBase` rebuilds an exact, recursively data-only whitelist:

```text
digestSchemaVersion
transcript
transcriptText
transcriptTimestamped
transcriptLanguage
transcriptFingerprint
videoTitle
channelName
basicOverview (coordinator-preserved only)
deepAnalysis
paragraphCache
timestamp
```

Panel base input cannot write either `basicOverview` or `deepAnalysis`; the
coordinator preserves or migrates derived fields only from its latest stored
digest. A non-expired same-fingerprint base
mutation preserves the latest Basic Overview and Deep Analysis, deep-merges
proven paragraph translations, and preserves the original timestamp. A
non-expired v2 fingerprint conflict fails closed. A valid-but-expired digest
starts a fresh lifetime at the local clock: matching-fingerprint derived data
may survive only after strict provenance validation, while a changed
fingerprint clears all derived data. Invalid or future timestamps are
untrusted: a fresh base may replace them, but no stored derived data survives.
A legacy same-source digest may migrate; unproven or changed provenance
discards all derived data. Unknown properties, accessors, proxies, and
prototype keys are never copied or executed.

For legacy Deep Analysis, an own stored `deepAnalysis` property wins even when
its value is `null`. Only a complete absence of that property permits fallback
to stored legacy `analysis`. The temporary `persistDigestCache` adapter may
seed a non-null incoming legacy analysis only when the latest stored digest has
neither own field; after that it never overwrites or clears the stored value.
Explicit `patchDigest({ deepAnalysis: null })` is the only null-clear intent.

`patchDigest` accepts only own `deepAnalysis` and/or `paragraphCache` fields.
It requires a non-expired v2 digest with an exact fingerprint. Paragraph
entries must have the full `<videoId>:<fingerprint>:` prefix and non-empty
string values. Entry count, key length, value length, nesting, and aggregate
input are hard bounded; an invalid member rejects the complete patch. Nested
accessors, proxies, cycles, and prototype setters are never executed. Each
valid delta is merged into the latest queued state; it never replaces the whole
paragraph map or erases Basic Overview. Neither base nor patch mutations extend
the original 30-day timestamp. Both reuse the existing 8 MiB, stable-oldest
eviction, target-preservation, and one-quota-retry helper.

### Background and Options routing

Add `persistDigestBase` and `patchDigestCache` runtime actions with the same
initial session validation, reset epoch, mutation-time validation, and session
token echo as existing cache messages. Keep `persistDigestCache` temporarily as
a compatibility adapter to `commitDigestBase`; it must no longer overwrite a
whole digest.

Before any base commit, the background worker rebuilds canonical segments and
source language from the supplied transcript, recomputes SHA-256 with
`YTD_TRANSCRIPT_CORE`, and compares it with the claimed fingerprint. Panel
fingerprints are never trusted as provenance. Hash completion is followed by a
fresh session/reset check before mutation.

On receipt of `clearDigestCache`, synchronously increment `activeResetCount`,
bump the background reset revision, and invalidate all panel sessions before
awaiting the persistence FIFO. Decrement the counter in `finally`.

In the real extension, the Options clear button sends only
`{ action: "clearDigestCache" }` to the background worker and performs zero
direct storage removes. A non-extension preview adapter may delete both cache
prefixes locally, but must return `previewOnly: true` and must not claim reset
or concurrency guarantees.

The same subsection also removes the two dangerous Options shortcuts:
`clearNotes` sends the existing `deleteAllNotes` action, and `resetAllData`
sends `resetExtensionData`. Extension failures never fall back to
`storage.remove()` or `storage.clear()`. The preserved language preference does
not need to be rewritten after reset. Provider-setting and language mutation
migration remains a later product-settings task.

### Required red-green tests

- epoch is written before removal; scoped stores are preserved;
- clear removes digest and attempt keys and verifies residuals;
- clear versus old settle, old panel save, and same ID/revision recreation is
  fenced by the new epoch;
- pruning removes only fully validated double-expired records and stays in the
  single FIFO;
- base writes use the exact whitelist and are hostile-object safe;
- background rejects a transcript/fingerprint mismatch before storage;
- same-fingerprint base preserves Basic Overview, Deep Analysis, translations,
  and timestamp;
- legacy precedence and provenance rules are exact;
- concurrent Deep Analysis and paragraph patches, and two paragraph deltas,
  produce a union with no lost field;
- wrong fingerprint, old epoch, clear race, budget, and quota paths remain
  typed and preserve the target;
- background actions validate and echo the exact session;
- the extension Options path sends one runtime intent and never mutates storage
  directly for cache, notes, or full reset; preview clears only both cache
  prefixes and never claims transactional authority.

Focused command:

```bash
node --test tests/persistence.test.js tests/background-persistence.test.js \
  tests/options-cache-clear.test.js tests/options-language.test.js
```

Commit message: `feat: add atomic digest v2 cache mutations`

## Task 3B2: Migrate panel cache reads and writes

**Files:** `sidepanel.js`, cache-related VM tests, and the background compatibility
route removal.

Add strict helpers for a v2 base payload, derived patches, legacy Deep Analysis
precedence, cached Basic Overview normalization, and a whitelisted cache view.
`loadFromCache` must reject missing, future, and exactly-30-day timestamps,
recompute the transcript fingerprint locally, and never return `{...cached}`.
The background note-preparation cache reader must use the same validated v2/TTL
view (or fetch a fresh transcript); it may not consume an arbitrary, future, or
expired `digest_*.transcript` directly.

Replace each full-cache call site independently:

- a fresh transcript sends one base intent;
- a proven legacy migration sends one base migration intent;
- Deep Analysis success sends only `{ deepAnalysis }`;
- each translation batch sends only its successful paragraph delta;
- remove the unused generic `updateCache` path.

After migration, runtime source must contain no `saveToCache` call and no
panel-originated `persistDigestCache` action. Panel code never sends
`basicOverview`, legacy `analysis`, or a full post-base snapshot.

Commit message: `refactor: migrate panel cache writes to digest v2`

## Task 3B3: Consent-aware Overview orchestration

Replace the public raw provider action with `requestBasicOverview`. Keep the
pure provider helper testable but unreachable as an unclaimed runtime action.
The background order is:

1. exact panel session/video validation;
2. local payload, key, consent, and prompt preflight;
3. worker-generated attempt ID and durable claim;
4. final pre-dispatch session and claim validation;
5. at most one DeepSeek request;
6. durable success or canonical failure settlement.

After provider dispatch, settlement does not re-check the panel. It uses only
the attempt CAS, reset epoch, video/fingerprint, and digest context so a paid A
result can still persist after the panel switches to B. Reset or scoped clear
must prevent late settlement and cache resurrection.

`checkConfig` returns strict booleans for `hasSupadataKey`, `hasAiKey`, and
`autoBasicOverview`; it never returns a secret. Panel logic adds per-session
in-flight coalescing and a session-scoped automatic-requested set, while the
durable ledger remains the cross-panel and cross-restart authority. Manual
retry bypasses consent but not key, offline, fingerprint, lease, or session
checks. It reuses the cached/in-memory transcript and never refetches it.

Commit message: `feat: orchestrate basic overview exactly once`

## Deferred until the following UI task

Do not add Overview DOM, evidence buttons/dialogs, automatic Deep Analysis UI,
or new styling in Tasks 3B1-3B3. The next task owns the Overview-first visual
state machine, evidence seek/copy interactions, Deep Analysis controls, and
accessible error/retry presentation.

## Gate for every subsection

Before committing:

1. inspect the diff against this plan and the trust-first design;
2. run the subsection's focused tests;
3. run `npm test`;
4. run `npm run check`;
5. run syntax and `git diff --check` checks;
6. obtain independent specification and quality reviews;
7. commit only the authorized subsection files; do not merge, push, or clean
   the worktree branch.
