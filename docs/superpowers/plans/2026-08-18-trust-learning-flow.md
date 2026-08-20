# Trust-First Learning Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver an automatic lightweight Overview whose conclusions are locally traceable to transcript segments, while keeping full Deep Analysis manual and transcript exports mode-consistent.

**Architecture:** Extract deterministic transcript segmentation into a shared classic-script module, normalize the basic-overview schema locally, and render evidence from transcript data rather than model-supplied quote text. Store `basicOverview` and `deepAnalysis` independently in each digest cache entry and guard all work with Gate 1's video-session token.

**Tech Stack:** Chrome Manifest V3, classic JavaScript globals/importScripts, DeepSeek JSON mode, local transcript cache, Node.js built-in test runner, DOM/VM test doubles.

---

## File structure

- Create `transcript-core.js`: deterministic segment IDs, grouping, fingerprinting, transcript-mode snapshots.
- Create `overview-core.js`: basic-overview normalization and locally derived completeness.
- Create `prompts/overview.md`: bounded Chinese summary contract that cites segment IDs only.
- Create `tests/transcript-core.test.js`: stable segmentation/fingerprint and snapshot behavior.
- Create `tests/basic-overview.test.js`: schema, prompt isolation, manual provider action, and failure states.
- Create `tests/evidence-view.test.js`: exact local text, context, seek, dialog behavior.
- Create `tests/transcript-export-mode.test.js`: Original/Chinese/bilingual snapshot consistency.
- Modify `background.js`: basic-overview action and prompt request.
- Modify `sidepanel.html`: Overview-first navigation, coherent Overview states, evidence dialog, manual Deep Analysis card.
- Modify `sidepanel.js`: automatic basic overview, evidence rendering, manual deep analysis, mode-aware exports.
- Modify `sidepanel.css`: conclusion/evidence/deep-state visual hierarchy.
- Modify release allowlist/tests/docs for new runtime and prompt files.

## Task 1: Canonical transcript segments and fingerprints

**Files:**
- Create: `transcript-core.js`
- Create: `tests/transcript-core.test.js`
- Modify: `sidepanel.html`
- Modify: `sidepanel.js`
- Modify: `background.js`
- Modify: `scripts/check-release.sh`
- Modify: `tests/background-persistence.test.js`
- Modify: `tests/deep-analysis.test.js`
- Modify: `tests/release.test.js`
- Modify: `tests/session-lifecycle.test.js`
- Modify: `tests/transcript-provider.test.js`
- Modify: `tests/translation.test.js`
- Modify: `tests/vocabulary.test.js`

- [ ] **Step 1: Write failing deterministic-segment tests**

```js
const transcriptCore = require("../transcript-core.js");
const raw = [
  { start: 0, duration: 5, text: "First complete thought." },
  { start: 5, duration: 5, text: "Second complete thought." },
];
const first = transcriptCore.groupTranscriptEntries(raw);
const second = transcriptCore.groupTranscriptEntries(structuredClone(raw));
assert.deepEqual(first, second);
assert.match(first[0].id, /^segment-0-0$/);
const { webcrypto } = require("node:crypto");
assert.equal(
  await transcriptCore.fingerprintSegments(first, {
    sourceLanguage: "en",
    crypto: webcrypto,
  }),
  await transcriptCore.fingerprintSegments(second, {
    sourceLanguage: "en",
    crypto: webcrypto,
  }),
);
```

Cover old cached entries without IDs, changed language/ID/start/text/order producing a changed fingerprint, chunk-language fallback, bounded semantic groups, surrogate-pair-safe emoji splitting, canonical source text with markup preserved as text, stable UTF-8 emoji hashing, explicit missing-Web-Crypto failure, and 320,000-character overview input rejection.

- [ ] **Step 2: Run focused test and confirm red**

Run: `node --test tests/transcript-core.test.js`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Move pure grouping without changing behavior**

Create a classic-script/module wrapper exporting `normalizeCaptionText`, `resolveTranscriptLanguage`, `splitOversizedThought`, `groupTranscriptEntries`, `assertSecureFingerprintAvailable`, async `fingerprintSegments`, `formatTimestamp`, and `buildOverviewTranscriptInput`. Preserve existing grouping constants and ID format `segment-${index}-${Math.round(start * 1000)}`.

Use Web Crypto SHA-256 over versioned canonical UTF-8 JSON containing the schema marker, canonical source language, and every segment's `id`, numeric `start`, and exact `text`. Prefix the lowercase digest with `sha256-v1-`. Node tests inject `crypto.webcrypto`; production must never silently fall back to a weak hash. Missing or failing secure crypto returns a typed local `TRANSCRIPT_FINGERPRINT_UNAVAILABLE` error.

- [ ] **Step 4: Wire both extension contexts**

Load `transcript-core.js` before `sidepanel.js` in HTML and through the background worker's ordered `importScripts` call. Replace sidepanel's local pure helper definitions with aliases to `YTD_TRANSCRIPT_CORE`; load the core in every sidepanel/background VM harness and include every import in release scanning.

Create one frozen canonical segment snapshot per video session. Resolve source language from a valid top-level language or the first valid transcript entry language, then await SHA-256 before publishing the fingerprint; after every await, re-check the video-session token so a late hash cannot hydrate or persist another video. Preflight secure fingerprint availability before any paid transcript dispatch. If hashing fails after a fresh transcript was returned, retain the in-memory transcript and make Retry recompute only its fingerprint, never refetch it. A cached transcript may remain locally viewable without crypto, but new fingerprint-bound paid analysis is blocked with an explicit local message.

Key `paragraphCache` entries by video ID plus the complete transcript fingerprint. Migrate legacy keys only when the cached transcript in the same digest can be re-segmented and hashed to prove the current fingerprint; a changed or unavailable fingerprint must not reuse, read, write, or persist an empty/unproven key.

- [ ] **Step 5: Add the file to release validation and run regression tests**

Run:

```bash
node --test tests/transcript-core.test.js tests/translation.test.js tests/deep-analysis.test.js tests/vocabulary.test.js tests/session-lifecycle.test.js tests/background-persistence.test.js tests/transcript-provider.test.js tests/release.test.js
npm run check
```

Expected: PASS and the existing grouping/translation assertions remain unchanged.

- [ ] **Step 6: Commit**

```bash
git add transcript-core.js sidepanel.html sidepanel.js background.js scripts/check-release.sh docs/superpowers/plans/2026-08-18-trust-learning-flow.md tests/background-persistence.test.js tests/deep-analysis.test.js tests/release.test.js tests/session-lifecycle.test.js tests/transcript-core.test.js tests/transcript-provider.test.js tests/translation.test.js tests/vocabulary.test.js
git commit -m "refactor: share deterministic transcript segments"
```

## Task 2: Basic Overview schema, prompt, and provider action

**Files:**
- Create: `overview-core.js`
- Create: `prompts/overview.md`
- Create: `tests/basic-overview.test.js`
- Modify: `background.js`
- Modify: `providers.js`
- Modify: `sidepanel.html`
- Modify: `sidepanel.js`
- Modify: `scripts/check-release.sh`
- Modify: `docs/superpowers/specs/2026-08-18-trust-first-learning-experience-design.md`
- Modify: `tests/background-persistence.test.js`
- Modify: `tests/deep-analysis.test.js`
- Modify: `tests/provider-errors.test.js`
- Modify: `tests/release.test.js`
- Modify: `tests/session-lifecycle.test.js`
- Modify: `tests/transcript-provider.test.js`
- Modify: `tests/translation.test.js`
- Modify: `tests/vocabulary.test.js`

- [ ] **Step 1: Write failing normalizer tests**

Use locally generated source segments and hostile model payloads. Assert the normalizer rebuilds only the approved fields: `schemaVersion`, `transcriptFingerprint`, `generatedAt`, `oneSentenceZh`, `conclusions`, `chapters`, and `complete`. Do not persist UI state or model explanations such as `state` or `evidenceWhyZh`.

Cover text bounds, five conclusions, forty chapters, surrogate-safe truncation, duplicate evidence removal, locally derived chapter timestamps, invalid IDs, and trusted fingerprint/time metadata. Filter invalid records before applying collection limits. Deduplicate chapters, order them by local source-segment order, then cap them. A `strong` claim containing both valid and unknown IDs becomes `partial`; duplicate valid IDs alone stay `strong`; zero valid IDs becomes `insufficient`. `complete` requires a takeaway, a chapter, and at least three conclusions that each have title, explanation, a locally valid evidence ID, and a non-`insufficient` level.

- [ ] **Step 2: Write failing prompt/action tests**

Assert `prompts/overview.md` requests Simplified Chinese, 3-5 conclusions, `evidenceSegmentIds`, no model quote/evidence explanation/timestamp fields, no invented IDs, and a full timeline. Metadata and transcript are JSON-serialized untrusted data. Placeholder-looking captions, titles, section markers, and code fences must remain parseable source strings after one non-recursive interpolation pass.

VM-test the manual `generateBasicOverview` action with exactly one DeepSeek JSON-mode request, `maxTokens: 3072`, thinking disabled, `sessionToken` echo, and local normalization. The handler accepts canonical segments plus a SHA-256 transcript fingerprint and must ignore arbitrary caller-provided flattened transcript text.

Run: `node --test tests/basic-overview.test.js`

Expected: FAIL for missing module/prompt/action.

- [ ] **Step 3: Implement overview-core**

Export `normalizeBasicOverview` from a classic-script/CommonJS wrapper named `YTD_OVERVIEW`. The normalizer must rebuild every supported field rather than spreading raw model data. Evidence view models, UI state, cache usability, and persistence belong to later tasks.

- [ ] **Step 4: Implement prompt and action**

Add manual `generateBasicOverview`. Validate the fingerprint and canonical segment snapshot before prompt/provider work. Build the prompt transcript only through `YTD_TRANSCRIPT_CORE.buildOverviewTranscriptInput`. Explicitly translate local `OVERVIEW_TRANSCRIPT_TOO_LARGE` to canonical `INPUT_TOO_LARGE`; do not confuse input size with `RESPONSE_TOO_LARGE` or `UNKNOWN_PROVIDER_ERROR`.

Load the two prompt sections, call DeepSeek once with JSON mode and 3,072 output tokens, normalize against the supplied segments, and return `{ success, overview, sessionToken }` or a canonical failure envelope. Empty/invalid/oversized/missing-key/stale requests dispatch zero provider calls. Malformed HTTP 200 JSON is billed `MALFORMED_RESPONSE`; a valid envelope with empty content is billed `EMPTY_RESPONSE`. `INPUT_TOO_LARGE` is nonretryable, reports no credit consumption, and uses `reduce_request`.

Route the action through `runPanelVideoRequest` so missing tokens, message/token video mismatches, prompt-time video changes, and reset races remain typed and never dispatch stale work. This task adds the manual worker action only: no automatic call, cache write, Overview UI entry, or persistent state/evidence explanation.

- [ ] **Step 5: Wire loaders, errors, and release files**

Load `overview-core.js` after `transcript-core.js` and before each consumer in side-panel HTML, the worker import list, and background VM harnesses. Add `overview-core.js` and `prompts/overview.md` to both release allowlists and make release scanning prove the worker import and prompt reference.

Add canonical `INPUT_TOO_LARGE` to `providers.js` as nonretryable with `reduce_request`. Map Overview-stage provider failures to bounded Chinese “基础概览” copy; missing/invalid keys open settings, timeout retries Overview, and oversized local input shows the transcript without suggesting a blind retry.

- [ ] **Step 6: Pass focused and release tests**

Run:

```bash
node --test tests/basic-overview.test.js tests/provider-errors.test.js tests/session-lifecycle.test.js tests/background-persistence.test.js tests/deep-analysis.test.js tests/translation.test.js tests/vocabulary.test.js tests/transcript-provider.test.js tests/release.test.js
npm run check
```

Expected: PASS; exact worker/HTML order and release inclusion are proven.

- [ ] **Step 7: Commit**

```bash
git add overview-core.js prompts/overview.md background.js providers.js sidepanel.html sidepanel.js scripts/check-release.sh docs/superpowers/plans/2026-08-18-trust-learning-flow.md docs/superpowers/specs/2026-08-18-trust-first-learning-experience-design.md tests/basic-overview.test.js tests/background-persistence.test.js tests/deep-analysis.test.js tests/provider-errors.test.js tests/release.test.js tests/session-lifecycle.test.js tests/transcript-provider.test.js tests/translation.test.js tests/vocabulary.test.js
git commit -m "feat: add a grounded basic overview contract"
```

## Task 3: Overview-first UI and explicit Deep Analysis

**Files:**
- Modify: `sidepanel.html`
- Modify: `sidepanel.js`
- Modify: `sidepanel.css`
- Modify: `tests/basic-overview.test.js`
- Modify: `tests/deep-analysis.test.js`
- Modify: `tests/session-lifecycle.test.js`

- [ ] **Step 1: Add failing structure, state, and interaction tests**

Assert the HTML default order is Overview, Transcript, Notes, Vocabulary, with Overview active before JavaScript runs. Add coherent `tablist`/`tab`/`tabpanel` relationships, keyboard navigation, `lang="zh-CN"`, live loading/error regions, and a full-card Deep Analysis busy state. VM-drive transcript readiness and require the existing Task 3B3 boundary to send exactly one `requestBasicOverview` message after the digest-base acknowledgement when consent/key exist, zero `analyzeTranscript` messages, and no duplicate request on tab changes or a matching cache hit.

Cover ready and usable-partial cached overviews, no-consent/missing-key/offline inline guidance, provider failure, durable failure, and provider-success/cache-write-failure. The latter must keep the trusted Overview visible and route its action only through `retryBasicOverviewCacheWrite`; it must not make another provider request. Preserve bounded `disposition`/`retryAfterMs` information needed to distinguish in-flight, failed, interrupted, and result-missing attempts.

Reverse the old test that opening Overview starts Deep Analysis. Require `analyzeTranscript` only after `#deepAnalysisActionBtn` activation. Coalesce duplicate activation both while the digest-base acknowledgement is pending and while the provider request is pending. Cached Deep Analysis remains visible without a current AI key.

Add A-to-B and reset tests: a late A request or `finally` block cannot clear or overwrite B's loading/ready state, and reset clears every new video-bound state while making Overview active without starting Deep Analysis. Malicious provider strings must render as text.

- [ ] **Step 2: Run focused tests and confirm red**

Run: `node --test tests/basic-overview.test.js tests/deep-analysis.test.js`

Expected: FAIL because Transcript is the static default, Basic Overview has no renderer, and `switchTab("overview")` starts Deep Analysis.

- [ ] **Step 3: Build coherent Overview state DOM**

Add stable containers:

```text
#overviewState
  #overviewLoadingState[role=status][aria-live=polite]
  #overviewErrorState
  #overviewReadyState
    #overviewOneSentence
    #overviewConclusions
    #overviewChapterList
  #deepAnalysisCard
    #deepAnalysisActionBtn
    #deepAnalysisState
    #deepAnalysisResults
```

Move the existing deep report/export elements under `#deepAnalysisResults`; preserve their IDs and give Basic chapters the distinct `#overviewChapterList` ID. Do not expose evidence buttons yet: this commit may show non-interactive evidence sufficiency/counts, while Task 4 adds the verified interaction. Do not remove or rewrite markup without a failing structural test.

- [ ] **Step 4: Render the existing Task 3B3 state machine**

Reuse `currentBasicOverview`, `currentBasicOverviewFailure`, `currentConfigStatus`, `basicOverviewRequestSession`, `requestBasicOverview("automatic" | "manual_retry")`, `maybeRequestAutomaticBasicOverview`, and `retryBasicOverviewCacheWrite`. Do not add a parallel request state machine or a second automatic trigger. Add only a session-fenced presentation state around those primitives, with preparing, loading, partial, ready, guidance, error, and ready-plus-cache-warning states. A new session activates Overview immediately. Transcript readiness renders the transcript, shows “字幕已就绪，正在生成基础概览”, persists the transcript base, and then uses the already-implemented automatic boundary.

Remove Deep Analysis triggering from `switchTab`. Keep the existing `triggerAnalysis` implementation surface, but set its in-flight guard before awaiting the digest base so pre-base double clicks cannot dispatch twice. Wire it only to `#deepAnalysisActionBtn` and the post-result Regenerate control. Basic loading/errors never hide Transcript; Deep loading/errors never hide Basic.

- [ ] **Step 5: Keep the committed cache and request contracts intact**

Task 3B2/B3 already persists `basicOverview` and `deepAnalysis`, migrates legacy `analysis`, validates Basic evidence/fingerprint, coalesces per-session requests, and implements opaque cache-only recovery. The panel must not persist Basic directly, send a full digest snapshot, expose attempt identities, restore the raw `generateBasicOverview` route, or infer a second automatic attempt. Preserve a usable cached partial Overview as a cache hit. Preserve a trusted Overview when only its cache write failed.

- [ ] **Step 6: Style ready/loading/error/deep states**

Use the existing calm terracotta visual language with a compact editorial-study hierarchy: takeaway, conclusion cards with non-interactive evidence sufficiency, chapters, then a visually separate Deep Analysis card. Loading/error hides stale ready DOM. Deep progress uses a full card with busy text/`aria-busy`, not only the small status line. Overview stays navigable without consent/key and shows inline guidance instead of being disabled. Add a reduced-motion fallback and keep the panel usable at 320px.

- [ ] **Step 7: Run focused and full tests**

Run:

```bash
node --test tests/basic-overview.test.js tests/deep-analysis.test.js tests/session-lifecycle.test.js
npm test
```

Expected: PASS; one auto basic call and zero automatic deep calls.

- [ ] **Step 8: Commit**

```bash
git add sidepanel.html sidepanel.js sidepanel.css tests/basic-overview.test.js tests/deep-analysis.test.js tests/session-lifecycle.test.js
git commit -m "feat: make grounded overview the default learning path"
```

## Task 4: Transcript-derived evidence dialog

**Files:**
- Modify: `sidepanel.html`
- Modify: `sidepanel.js`
- Modify: `sidepanel.css`
- Modify: `overview-core.js`
- Create: `tests/evidence-view.test.js`
- Modify: `tests/session-lifecycle.test.js`

- [ ] **Step 1: Write failing evidence model and dialog tests**

Add a pure evidence view model in `overview-core.js`. Require exact local source text, at most one canonical segment of context before and after, timestamp derived from the source segment, duplicate-text segments distinguished by ID/start, invalid ID as explicit insufficient evidence with no fuzzy fallback, exact-text-only copy, and seek routed to the captured session tab. Add static/DOM assertions for a labelled dialog, `aria-modal`, focus trap, Escape/native-cancel handling, initial focus, and safe focus restoration.

Critical assertion:

```js
assert.equal(view.exactText, sourceSegments[1].text);
assert.notEqual(view.exactText, conclusion.explanationZh);
```

- [ ] **Step 2: Run test and confirm red**

Run: `node --test tests/evidence-view.test.js`

Expected: FAIL because no evidence dialog exists.

- [ ] **Step 3: Add static dialog DOM**

Add `#evidenceDialog`, labelled title, sufficiency, exact-text, before/after context, the conclusion's AI explanation, timestamp, seek, copy, status, and close controls. Use a native `<dialog>` where supported and a tested open fallback; register lifecycle listeners once; assign all provider/source content through `textContent`. Label the model explanation as AI explanation/retelling and never present or copy it as exact source text.

- [ ] **Step 4: Render evidence actions per conclusion**

Each valid reference becomes `.overview-evidence-btn` with a timestamp derived locally. Unknown references render a non-clickable, non-focusable “证据不足” badge. The whole conclusion card is not an implicit click target. Opening the dialog captures an immutable session token and trigger.

- [ ] **Step 5: Implement dialog lifecycle**

Populate exact/local versus AI/explanation regions, trap Tab/Shift+Tab, close on Escape or native cancel, and restore focus only when the captured session and trigger are still current. Copy writes only `exactText`; seek uses the locally derived `timestampSeconds` and captured session token. Video switch/reset closes and clears the dialog; stale copy/seek/focus-restore becomes a no-op. Evidence interactions must send zero provider/storage/cache messages.

- [ ] **Step 6: Run focused and full tests**

Run: `node --test tests/evidence-view.test.js tests/basic-overview.test.js tests/session-lifecycle.test.js && npm test`

Expected: PASS with provider text escaped.

- [ ] **Step 7: Commit**

```bash
git add overview-core.js sidepanel.html sidepanel.js sidepanel.css tests/evidence-view.test.js tests/basic-overview.test.js tests/session-lifecycle.test.js
git commit -m "feat: verify overview claims against transcript evidence"
```

## Task 5: Mode-consistent transcript exports

**Files:**
- Modify: `transcript-core.js`
- Modify: `sidepanel.js`
- Modify: `sidepanel.html`
- Create: `tests/transcript-export-mode.test.js`
- Modify: `tests/deep-analysis.test.js`
- Modify: `tests/translation.test.js`

- [ ] **Step 1: Write failing snapshot tests**

Assert a single captured snapshot drives Copy, TXT, and Clean MD:

```js
const bilingual = core.buildTranscriptModeSnapshot({
  segments,
  mode: "bilingual",
  translationLookup: new Map([
    [segments[0].id, "第一句。"],
    [segments[1].id, "第二句。"],
  ]),
});
assert.equal(bilingual.complete, true);
assert.deepEqual(bilingual.rows[0], {
  id: segments[0].id,
  start: segments[0].start,
  sourceText: segments[0].text,
  translatedText: "第一句。",
});
```

Cover Original source-only, Chinese translation-only, bilingual aligned order, missing IDs, dynamic labels/aria labels, mode/session change during pending export, and original Clean MD backward compatibility.

- [ ] **Step 2: Run focused test and confirm red**

Run: `node --test tests/transcript-export-mode.test.js`

Expected: FAIL because every export currently reads original globals.

- [ ] **Step 3: Implement shared snapshots**

`buildTranscriptModeSnapshot` returns `{ mode, label, complete, missingSegmentIds, rows, plainText }`. `copyTranscript`, `exportTranscript`, and `exportCleanTranscript` capture one current session/mode snapshot and serialize only it.

- [ ] **Step 4: Make incomplete translated exports explicit**

When Chinese/bilingual lacks translations, label actions `翻译并复制中文`, `翻译并导出 TXT`, and `翻译并导出 Clean MD`. The explicit action enqueues all missing segments, shows that DeepSeek may cost money, waits for queue idle, then rechecks session/mode before copying/downloading. Any failed segment leaves export blocked with the failed count; never fall back to Original.

- [ ] **Step 5: Update controls and Markdown serializer**

`updateTranscriptExportControls(mode)` updates text, `aria-label`, disabled, and `aria-busy`. `buildCleanTranscriptMarkdown` accepts the snapshot rows and emits the selected mode label in metadata while preserving original output format for Original mode.

- [ ] **Step 6: Run focused and full tests**

Run:

```bash
node --test tests/transcript-export-mode.test.js tests/translation.test.js tests/deep-analysis.test.js
npm test
```

Expected: PASS; all three export paths consume the same snapshot.

- [ ] **Step 7: Commit**

```bash
git add transcript-core.js sidepanel.js sidepanel.html tests/transcript-export-mode.test.js tests/translation.test.js tests/deep-analysis.test.js
git commit -m "fix: export the transcript mode the learner sees"
```

## Gate 2 verification

- [ ] Run `npm test` and require 0 failures.
- [ ] Run `npm run check` and require all runtime/prompt files to be allowlisted.
- [ ] Run `git diff --check`.
- [ ] Review the diff against success criteria 2-6 and 12 in the approved design.
- [ ] Manually simulate cached Overview, missing AI key, rejected AI key, basic retry, manual deep retry, and rapid video switching in the VM fixtures.
- [ ] Confirm no new Chrome permission or host permission appears.
