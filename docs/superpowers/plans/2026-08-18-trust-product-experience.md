# Trust Product Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the trust-first learning flow safe and understandable for small-group installation through independent setup, truthful reset, clearer notes/vocabulary, keyboard support, narrow-panel polish, and reproducible release artifacts.

**Architecture:** Options becomes a three-step bilingual setup that observes real provider status without probe calls. Destructive data operations go through the Gate 1 coordinator. The side panel receives a focused semantic/accessibility pass without changing framework or permissions, and release packaging becomes versioned and reproducible.

**Tech Stack:** HTML/CSS, classic JavaScript, Chrome extension options/side panel APIs, local storage coordinator, Node.js test runner, shell release scripts.

---

## File structure

- Create `tests/options-settings.test.js`: independent saves, preview secret cleanup, readiness and wizard DOM.
- Create `tests/sidepanel-accessibility.test.js`: tabs, dialogs, interaction semantics, reduced motion, narrow layout.
- Create `tests/note-management.test.js`: source-excerpt migration and FIFO note behavior.
- Create `scripts/check-reproducible-package.sh`: two-build SHA-256 gate.
- Create `docs/manual-smoke-checklist.md`: real Chrome flows and 320 CSS-pixel checklist.
- Modify `options.html`, `options.js`, `options.css`: setup wizard, status, reset dialog, preview guard.
- Modify `background.js`: setup-state/provider-status recording and destructive-data actions.
- Modify `sidepanel.html`, `sidepanel.js`, `sidepanel.css`: typed config guidance, tab semantics, notes/vocabulary/dialog/narrow-panel UX.
- Modify `content.js`: remove the conflicting bare-N shortcut and preserve keyboard-visible Note action.
- Modify `README.md`, `README.zh-CN.md`, `PRIVACY.md`, `SECURITY.md`: exact new cost/privacy/reset behavior.
- Modify `manifest.json`, `package.json`, release scripts/tests: version 1.2.0 and deterministic artifact.

## Task 1: Preview-safe independent provider setup

**Files:**
- Modify: `options.html`
- Modify: `options.js`
- Modify: `options.css`
- Modify: `background.js`
- Create: `tests/options-settings.test.js`
- Modify: `tests/options-language.test.js`
- Modify: `tests/settings.test.js`

- [ ] **Step 1: Write failing adapter and independent-save tests**

Seed ordinary localStorage with `youtubeDigestPreview:ytd_settings` containing fake keys, initialize preview mode, and assert it is removed. Assert fallback persistence permits only `ytd_options_language`; secret settings are neither returned by `get(null)` nor written by `set`.

Send `saveProviderSettings` twice and assert:

```js
await save("supadata", "supadata-new");
assert.equal(state.ytd_settings.supadataApiKey, "supadata-new");
assert.equal(state.ytd_settings.aiApiKey, "deepseek-old");

await save("deepseek", "deepseek-new", { autoBasicOverview: true });
assert.equal(state.ytd_settings.supadataApiKey, "supadata-new");
assert.equal(state.ytd_settings.aiApiKey, "deepseek-new");
assert.equal(state.ytd_settings.autoBasicOverview, true);
assert.equal(fetchCalls, 0);
```

Cover removing either key, saved-untested state, Supadata-only readiness, DeepSeek-only readiness, and `navigator.language` defaulting to Chinese when no preference exists.

- [ ] **Step 2: Add failing wizard DOM/i18n tests**

Require IDs for transcript step/form/status/disclosures, analysis step/form/status/consent/disclosures, readiness step, return button, and preview notice. Check every `data-i18n` key exists in English and Chinese and placeholders change with language.

Run: `node --test tests/options-settings.test.js tests/options-language.test.js tests/settings.test.js`

Expected: FAIL because settings currently requires both keys and preview stores full settings.

- [ ] **Step 3: Restrict preview adapter**

`isExtensionContext(root)` requires both `chrome.runtime.id` and `chrome.storage.local`. `purgeLegacyPreviewSecrets` removes exactly `${PREVIEW_STORAGE_PREFIX}${YTD_SETTINGS.STORAGE_KEY}`. Fallback `set` persists language only; other values remain unpersisted. Preview renders `#previewModeNotice`, disables Save/Remove controls, and leaves password fields editable for visual preview.

- [ ] **Step 4: Build three setup sections**

Keep `#supadataApiKey` and `#aiApiKey`. Add the approved IDs, separate forms and Save/Remove buttons, `#autoBasicOverview`, status outputs with live regions, data/cost disclosures, and readiness summary. Do not add Test Connection buttons.

- [ ] **Step 5: Implement setup messages and real-request status**

Options reads `getSetupState`, saves each provider independently, and renders `unsaved`, `saved_untested`, `connected`, `rejected`, `rate_limited`, or `unavailable` with text plus icon, not color alone. `connected` includes the last real success time.

In background, successful real Supadata/DeepSeek HTTP results record connected status at an injected/current timestamp; 401/403 and 429 record rejected/rate-limited. Cache hits do not update status. Changing a key resets only that provider to saved-untested.

- [ ] **Step 6: Style setup, busy, status, and contrast**

Use numbered step markers, status chips with text, 44px primary actions, visible focus, and `--accent: #a84f3b` or a measured darker equivalent so white normal text reaches 4.5:1. Local capabilities remain visibly ready even when provider keys are absent.

- [ ] **Step 7: Run focused/full tests and commit**

Run:

```bash
node --test tests/options-settings.test.js tests/options-language.test.js tests/settings.test.js tests/provider-errors.test.js
npm test
```

Expected: PASS.

```bash
git add options.html options.js options.css background.js tests/options-settings.test.js tests/options-language.test.js tests/settings.test.js
git commit -m "feat: guide independent provider setup safely"
```

## Task 2: Truthful local-data actions and reset dialog

**Files:**
- Modify: `options.html`
- Modify: `options.js`
- Modify: `options.css`
- Modify: `background.js`
- Modify: `sidepanel.js`
- Modify: `tests/options-settings.test.js`
- Modify: `tests/persistence.test.js`

- [ ] **Step 1: Write failing reset-dialog tests**

Seed settings, provider status, one digest with two translated paragraphs, two notes, and three vocabulary entries. Require rendered counts and explicit vocabulary copy. Confirming reset must preserve language/new epoch, wait for background verification, and only then announce success. Simulate a surviving key and require visible failure.

Add a sidepanel test that changes `ytd_reset_epoch` while transcript/translation/analysis work is pending and asserts every old session commit is ignored.

- [ ] **Step 2: Run focused tests and confirm red**

Run: `node --test tests/options-settings.test.js tests/persistence.test.js tests/session-lifecycle.test.js`

Expected: FAIL because current reset calls `storage.clear()` with incomplete copy.

- [ ] **Step 3: Build accessible reset dialog**

Add a labelled native dialog with actual counts for settings, provider status, digests, translations, notes, vocabulary, an export reminder, Cancel, and destructive Confirm. `#resetBtn` opens only; clear cache and delete notes each get their own confirmation/busy/error state.

- [ ] **Step 4: Route all actions through background**

Options calls `getLocalDataSummary`, `resetExtensionData`, `clearDigestCache`, and `deleteAllNotes`. It never calls extension storage `clear` directly. Buttons set `disabled` and `aria-busy` during requests and restore after both success and failure.

- [ ] **Step 5: Invalidate the live side panel on reset epoch**

Listen to `chrome.storage.onChanged`. `invalidateWorkForReset` aborts/invalidate sessions, deep/basic coordinators, translation generation/queue/observer, playback, transcript/analysis memory, and paragraph cache, then reloads config and remaining vocabulary. It explains that already dispatched remote work may still cost money but will not be saved.

- [ ] **Step 6: Run focused/full tests and commit**

Run: `node --test tests/options-settings.test.js tests/persistence.test.js tests/session-lifecycle.test.js && npm test`

Expected: PASS with no `storage.clear()` in options runtime.

```bash
git add options.html options.js options.css background.js sidepanel.js tests/options-settings.test.js tests/persistence.test.js tests/session-lifecycle.test.js
git commit -m "fix: make local data deletion explicit and stable"
```

## Task 3: Trustworthy notes and calmer vocabulary cards

**Files:**
- Modify: `background.js`
- Modify: `sidepanel.html`
- Modify: `sidepanel.js`
- Modify: `sidepanel.css`
- Modify: `content.js`
- Create: `tests/note-management.test.js`
- Modify: `tests/vocabulary.test.js`
- Modify: `tests/digest-button.test.js`

- [ ] **Step 1: Write failing note migration/FIFO tests**

Assert legacy `text === rawText` migrates to `source_excerpt`, differing values migrate to `ai_cleaned`, and new Save captures exact normalized text without an AI request. Concurrent save/save retains both; queued save/delete and delete/save have the approved order. Delete requires confirmation and communicates failure.

- [ ] **Step 2: Write failing vocabulary-structure tests**

Require the generated card's word, meaning, source, and sticky Save action before learning methods. Require advanced method cards to be native collapsed disclosures by default and source links before the long plan in the library. Confirm local vocabulary remains available with no key.

Run: `node --test tests/note-management.test.js tests/vocabulary.test.js tests/digest-button.test.js`

Expected: FAIL for automatic note cleanup and fully expanded memory methods.

- [ ] **Step 3: Store exact source excerpts**

New note fields are:

```js
{
  kind: "source_excerpt",
  sourceSegmentIds: [matchedSegment.id],
  rawText: matchedSegment.text,
  text: matchedSegment.text,
  transformedByAi: false,
}
```

Stop calling `cleanupNoteText` during ordinary Save. Keep legacy read migration and label AI-cleaned legacy notes. Quote-save passes exact quote text/source IDs instead of asking background to rediscover and rewrite it.

- [ ] **Step 4: Clarify note controls and remove shortcut conflict**

Note timestamp/delete controls become buttons. Delete uses a second explicit confirmation state. Replace “Note” labels with “保存字幕原文” or “AI 润色笔记” according to `kind`. Remove bare `N` interception from `content.js`; keep the on-video Note button keyboard-focusable and visible on focus.

- [ ] **Step 5: Collapse and reorder vocabulary detail**

Use a sticky modal footer for Add/Cancel. Render meaning/source first. Wrap each advanced learning method in `<details>` closed by default; keep the first concise memory cue visible. In the library, place occurrence/source links before the full learning plan.

- [ ] **Step 6: Run focused/full tests and commit**

Run: `node --test tests/note-management.test.js tests/vocabulary.test.js tests/digest-button.test.js && npm test`

Expected: PASS and no provider request on ordinary note save.

```bash
git add background.js sidepanel.html sidepanel.js sidepanel.css content.js tests/note-management.test.js tests/vocabulary.test.js tests/digest-button.test.js
git commit -m "feat: preserve source notes and simplify vocabulary study"
```

## Task 4: Keyboard semantics, language, reduced motion, and 320px layout

**Files:**
- Modify: `sidepanel.html`
- Modify: `sidepanel.js`
- Modify: `sidepanel.css`
- Modify: `options.css`
- Create: `tests/sidepanel-accessibility.test.js`
- Modify: `tests/transcript-selection.test.js`
- Modify: `tests/vocabulary.test.js`
- Create: `docs/manual-smoke-checklist.md`

- [ ] **Step 1: Write failing semantic/static tests**

Require `role=tablist`, four `role=tab` controls with stable IDs/`aria-controls`, four labelled tabpanels, exactly one selected/tabbable tab, ArrowLeft/Right/Home/End logic, button semantics for seekable chapter/quote/note/timestamp controls, and live/busy state attributes.

Require Evidence and Explain dialogs to trap focus, close on Escape, and restore the trigger. Render a long transcript and assert individual words do not create hundreds of permanent tab stops; the selected-text contextual action is the keyboard path.

- [ ] **Step 2: Write failing CSS contract tests**

Require measured normal-text color pairs at least 4.5:1, `@media (max-width: 360px)` wrapping/grid rules, minimum 44px primary controls, dialog viewport bounds, and `@media (prefers-reduced-motion: reduce)` disabling transitions/animations/smooth behavior.

Run: `node --test tests/sidepanel-accessibility.test.js tests/transcript-selection.test.js tests/vocabulary.test.js`

Expected: FAIL against current tabs/clickable containers/colors.

- [ ] **Step 3: Implement the tab model**

`activateTab(name, { focus })` updates active classes, `aria-selected`, `tabindex`, panel `hidden`, playback tracking, and optional focus. `handleTabKeydown` supports ArrowLeft/Right/Home/End in visual order and skips truly disabled tabs. Overview remains navigable without an AI key; it shows inline setup guidance.

- [ ] **Step 4: Replace implicit click targets**

Chapters, quote seek, transcript timestamp, note timestamp, and occurrence seek use real `<button type="button">` or links. Transcript word spans use no permanent `tabindex`; keyboard selection exposes one contextual action button. Explain reuses the tested focus-dialog lifecycle.

- [ ] **Step 5: Apply language and responsive CSS**

Set sidepanel HTML/default runtime language to `zh-CN`; options follows saved language then `navigator.language`. At 360px and below, tabs use a 2x2 grid, horizontal padding is 12px, transcript/notes/export actions wrap, dialogs fit `calc(100dvh - 16px)`, and Follow Playback cannot cover bottom actions. JavaScript scroll behavior uses `auto` when reduced motion is requested.

- [ ] **Step 6: Create a concrete manual checklist**

Document exact Chrome steps for 320 CSS-pixel side panel, keyboard-only tabs/dialogs, focus visibility, Original/Chinese/bilingual export, video A-to-B switch, reset during analysis, no-key degradation, and screen-reader labels. Every row has expected observable behavior and pass/fail space; do not use generic “looks good” criteria.

- [ ] **Step 7: Run focused/full tests and commit**

Run:

```bash
node --test tests/sidepanel-accessibility.test.js tests/transcript-selection.test.js tests/vocabulary.test.js
npm test
```

Expected: PASS.

```bash
git add sidepanel.html sidepanel.js sidepanel.css options.css tests/sidepanel-accessibility.test.js tests/transcript-selection.test.js tests/vocabulary.test.js docs/manual-smoke-checklist.md
git commit -m "feat: make the learning flow keyboard and narrow-panel ready"
```

## Task 5: Documentation, semantic version, and reproducible package

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `PRIVACY.md`
- Modify: `SECURITY.md`
- Modify: `manifest.json`
- Modify: `package.json`
- Modify: `scripts/check-release.sh`
- Modify: `scripts/package-extension.sh`
- Create: `scripts/check-reproducible-package.sh`
- Modify: `tests/release.test.js`

- [ ] **Step 1: Write failing release assertions**

Require manifest/package version `1.2.0`, exact unchanged permission arrays, every new runtime/prompt file in the allowlist, docs describing automatic basic/manual deep consent and cost, independent key status, evidence sourcing, preview secret cleanup, vocabulary-inclusive reset, and possible cost of dispatched-but-discarded requests.

Require package script to sort files, normalize staging mtimes/permissions, reject a pre-existing different artifact for the same version, and print SHA-256.

- [ ] **Step 2: Run release test and confirm red**

Run: `node --test tests/release.test.js`

Expected: FAIL on version and documentation assertions.

- [ ] **Step 3: Update product/security documentation**

English and Chinese docs must agree on:

- basic Overview auto-runs only after visible consent and a saved DeepSeek key;
- Deep Analysis is manual;
- evidence text comes from local transcript segments;
- translated exports may trigger explicit additional AI work;
- Connected means the last real request succeeded, not a permanent guarantee;
- preview never persists secrets and removes the old preview settings key;
- full reset includes vocabulary, preserves language/epoch, and blocks stale writes;
- already dispatched provider calls may still cost money after reset/session change.

- [ ] **Step 4: Make packaging reproducible**

Stage the sorted allowlist into a temporary directory, set all file mtimes to a fixed UTC value and permissions to 0644, and run `zip -X` with the sorted relative paths. `check-reproducible-package.sh` packages twice into isolated temp destinations and fails unless both SHA-256 values match. It cleans only its validated temp directories.

- [ ] **Step 5: Bump version and run all release gates**

Set both versions to `1.2.0`. Run:

```bash
npm test
npm run check
npm run package
bash scripts/check-reproducible-package.sh
unzip -t dist/youtube-digest-v1.2.0.zip
unzip -Z1 dist/youtube-digest-v1.2.0.zip
```

Expected: 0 test failures, release check success, equal reproducibility hashes, valid ZIP, and only allowlisted files.

- [ ] **Step 6: Commit**

```bash
git add README.md README.zh-CN.md PRIVACY.md SECURITY.md manifest.json package.json scripts/check-release.sh scripts/package-extension.sh scripts/check-reproducible-package.sh tests/release.test.js
git commit -m "release: prepare trust-first YouTube Digest 1.2.0"
```

## Gate 3 and final verification

- [ ] Run `npm test`; record total/pass/fail.
- [ ] Run `npm run check`; record allowlisted file count.
- [ ] Run `npm run package` and the reproducibility script; record artifact path and SHA-256.
- [ ] Run `git diff --check`.
- [ ] Inspect `git status --short`; only intentional files may remain.
- [ ] Review `git diff 6dcafb8...HEAD` against all 14 design success criteria.
- [ ] Have an independent reviewer inspect session isolation, reset/persistence, provider errors, evidence derivation, key handling, accessibility, and release scripts.
- [ ] Execute every row of `docs/manual-smoke-checklist.md` in real Chrome or explicitly report the rows that could not be run.
- [ ] Confirm no API key appears in source, tests, logs, screenshots, or packaged artifact.
- [ ] Confirm no new permission, host permission, analytics endpoint, or custom backend exists.
