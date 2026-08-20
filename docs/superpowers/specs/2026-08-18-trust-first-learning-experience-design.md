# Trust-First Learning Experience Design

Date: 2026-08-18
Status: Approved for implementation

## Product Decision

YouTube Digest will be optimized as a **trust-first learning assistant for long interviews and courses**. The primary audience is the owner and a small circle of users who need a polished Chinese-first experience, reliable recovery from common failures, and results that can be checked against the source.

The default behavior is:

1. bind the side panel to the current YouTube video;
2. acquire and render the transcript;
3. automatically generate a concise basic overview;
4. let the learner verify important claims against exact transcript evidence and timestamps;
5. generate the more expensive deep analysis only after an explicit action.

The selected information structure is **conclusion first, evidence immediately available, chapters second**. It replaces a feature-first mental model with one learning path.

## Why This Change Is Needed

The current fork already has valuable capabilities: transcripts, bilingual translation, playback following, AI overview, deep analysis, notes, vocabulary memory cards, and Markdown exports. Its automated baseline is healthy at 98 passing tests.

The audit nevertheless found product-level risks that the current tests do not prevent:

- changing videos while Overview is active can leave the previous video's report visible under the new title;
- a late transcript response for video A can overwrite the state for video B;
- settings reset deletes vocabulary without telling the user and in-flight work can recreate cleared data;
- concurrent note mutations can lose an update;
- transcript and analysis failures collapse into generic messages that give the wrong recovery action;
- the visible transcript language can disagree with Copy/TXT/Clean MD output;
- deep-analysis loading and failure feedback are fragmented across small labels while stale content remains visible;
- onboarding says keys are saved even when they have not been verified, and the two providers cannot be configured independently;
- several core interactions are mouse-only, use inaccessible disabled-state explanations, or do not fit a narrow side panel;
- the extension is materially different from upstream but still reports version 1.1.5.

These defects are especially damaging to a trust-first product. A polished summary is not useful if it can belong to the wrong video, silently lose notes, or present an AI rewrite as a quote.

## Goals

### G1. Source-bound correctness

Every asynchronous result must be accepted only when it belongs to the active video session. The title, transcript, overview, deep analysis, notes, translations, playback state, and exports shown together must share one verified video identity.

### G2. Fast first value

After the transcript is available, the extension automatically generates a lightweight basic overview. The learner sees explicit stages rather than an indefinite spinner:

```text
Identifying video -> Fetching transcript -> Building overview -> Ready
```

Deep analysis remains manual and never starts merely because the panel opened.

Automatic overview generation is an explicit saved preference named `autoBasicOverview`. A new or migrated profile defaults it to `false`; saving the analysis-service setup with the visible checkbox enabled records consent. Each transcript fingerprint may trigger at most one automatic overview request during the 30-day cache lifetime. A cached matching overview is reused without a provider call. With no AI key, no consent, offline mode, or a provider failure, Overview remains a normal usable destination that explains the unavailable stage while Transcript, local exports, notes, and saved vocabulary continue to work.

### G3. Verifiable understanding

The basic overview leads with:

- one-sentence takeaway;
- three to five core conclusions;
- evidence sufficiency for each conclusion;
- one or more timestamp links to supporting transcript passages;
- chapter timeline below the conclusions.

A timestamp opens an evidence view containing the exact source text, limited surrounding context, an explanation of why it supports the conclusion, a seek-to-video action, and a copy-original action.

AI-compressed text is called a summary, insight, or paraphrase. Only text copied exactly from the normalized transcript is called a quote.

### Basic overview contract

Basic overview and deep analysis are separate cache objects. The existing `analysis` cache field remains a readable alias for `deepAnalysis` during migration; it is never overwritten by a basic overview.

```text
basicOverview: {
  schemaVersion: 1,
  transcriptFingerprint: string,
  generatedAt: number,
  oneSentenceZh: string,                    // required, max 300 chars
  conclusions: [{                           // 3-5 when complete, max 5
    id: string,
    titleZh: string,                        // max 240 chars
    explanationZh: string,                  // max 1200 chars
    evidenceLevel: "strong" | "partial" | "insufficient",
    evidenceSegmentIds: string[]            // max 3, locally validated
  }],
  chapters: [{                              // max 40
    titleZh: string,
    summaryZh: string,
    startSegmentId: string,
    timestampSeconds: number
  }],
  complete: boolean
}
```

Transcript normalization assigns a deterministic ID to every source segment using its ordered index and normalized start time. Old cached transcripts receive the same IDs during load. The prompt receives these IDs and asks the model to cite only them. The normalizer drops unknown IDs, derives timestamps and quote text locally, downgrades mixed valid/unknown evidence to `partial`, and marks zero-valid-ID evidence `insufficient`; duplicate valid IDs alone do not cause a downgrade. Multiple adjacent cited segments may form one evidence excerpt; repeated sentences are disambiguated by segment ID. The model never supplies the text displayed as an exact quote.

A complete basic overview requires a non-empty one-sentence takeaway, at least three locally validated conclusions, and at least one chapter. A locally validated conclusion has a title, explanation, at least one locally valid evidence segment ID, and a non-`insufficient` evidence level. Chapters are validated and deduplicated before their limit is applied, then ordered by the local transcript segment order. A usable takeaway with fewer validated sections is `partial`; no usable takeaway is an error. Basic overview uses at most one AI request, a maximum output budget of 3,072 tokens, the existing 50-second idle deadline and 120-second hard deadline, and no more than 320,000 transcript characters. The UI enters each local stage within 100 ms; provider latency is reported, not hidden behind a guaranteed completion-time claim.

### G4. Recoverable failure

Errors are typed and action-oriented:

| Failure | User message | Primary action |
| --- | --- | --- |
| no captions | This video has no usable transcript | Choose another video / retry source |
| Supadata 401/403 | Transcript key was rejected | Open transcript settings |
| DeepSeek 401/403 | Analysis key was rejected | Open analysis settings |
| 429 | Provider is temporarily rate-limiting requests | Retry later |
| balance/quota | Provider credit is insufficient | Open provider billing/help |
| network/timeout | Connection was interrupted | Retry failed step |
| malformed/empty response | Provider returned no usable content | Retry without discarding completed work |
| basic-overview input over 320,000 characters | Transcript is over the local overview limit; nothing was sent | View transcript / choose a shorter video |

The UI states whether a failure may have consumed provider credit. Retrying a later stage must reuse a valid cached transcript instead of automatically repurchasing it.

### G5. Safe local data

Reset, cache clearing, note deletion, and vocabulary deletion are explicit and scoped. Full reset must list every affected category, including vocabulary, show available counts, recommend export first, cancel or invalidate in-flight writes, and verify completion before announcing success.

Notes and vocabulary use serialized mutation paths. IDs are collision-resistant. Cache management accounts for byte size and retries once after pre-eviction when quota is reached.

All extension-context mutations route through one background persistence coordinator; side panel and options send intent messages rather than performing independent read-modify-write sequences. The durable reset protocol uses `ytd_reset_epoch`:

1. every digest, translation, note, and vocabulary mutation captures the current epoch before asynchronous work;
2. full reset is serialized through the same coordinator and writes the previous integer epoch plus one before removing any data;
3. storage-change listeners invalidate active panel sessions immediately;
4. reset removes settings, provider status, digests, translations, notes, and vocabulary while preserving only the interface language and the new epoch;
5. each queued mutation compares its captured epoch inside the coordinator immediately before commit and refuses the write if it changed;
6. reset verifies the targeted keys are absent before reporting success.

An already dispatched provider request may still finish and may still incur provider cost; reset guarantees that its result is ignored and not persisted, not that the remote request can be recalled.

Only `digest_*` objects are cache-eviction candidates. Settings, reset epoch, notes, and vocabulary are never evicted. Digest cache targets at most 8 MiB using `chrome.storage.local.getBytesInUse` where available and deterministic JSON byte estimation otherwise. The oldest digest is evicted before an over-budget write. A storage-quota failure causes one additional oldest-first eviction and one retry, then a visible error rather than silent loss.

### G6. Small-group ready onboarding

The options page uses a three-step local setup:

1. transcript service: optional Supadata key, saved and status-tracked independently;
2. analysis service: optional DeepSeek key, saved and status-tracked independently;
3. readiness summary: which features work locally, which require a provider, and a button to return to YouTube.

Each key has visible states: unsaved, saved but untested, connected, rejected, rate-limited, or unavailable. Keys are saved independently; one empty key never blocks saving the other. This iteration does not make a potentially billable probe request solely to validate a key. `connected` means the most recent real feature request succeeded and includes `lastCheckedAt`; changing a key returns it to saved-but-untested. Sensitive keys cannot be saved to ordinary webpage `localStorage` when the options page is not running in a Chrome extension context. On preview startup, the adapter deletes any legacy `youtubeDigestPreview:ytd_settings` value created by older versions, disables secret-saving controls, and keeps typed secrets in the DOM only for that page lifetime.

The setup explains, immediately next to each action:

- what content is sent;
- which provider receives it;
- when an API call can cost money;
- that local Chrome storage is convenient storage, not a password vault;
- that transcript-only, local vocabulary, and local exports remain useful without a DeepSeek key.

### G7. Accessible narrow-panel operation

The main side-panel flow works at narrow widths and by keyboard:

- tabs expose tablist/tab/tabpanel semantics, `aria-selected`, and arrow-key navigation;
- clickable non-button elements become buttons or links;
- modal dialogs have a label, focus trap, Escape handling, and focus restoration;
- hundreds of transcript words are not all permanent tab stops;
- notes and vocabulary actions remain visible on touch and keyboard, not only hover;
- focus indicators meet contrast requirements;
- primary text/button colors meet WCAG AA for normal text;
- animations respect `prefers-reduced-motion`;
- the document language follows the active interface language.

## Information Architecture

The four user-facing destinations remain recognizable but are ordered around the learning task:

```text
Overview -> Transcript -> Notes -> Vocabulary
```

### Overview

Overview is the default destination for a new video once transcript acquisition begins. It owns one coherent content state: empty, loading, partial, ready, or error. Old report DOM is never allowed to remain visible during a new session.

Ready state order:

1. video identity and freshness;
2. one-sentence takeaway;
3. core conclusions with evidence links;
4. chapter timeline;
5. explicit Deep Analysis card;
6. report exports.

### Transcript

Transcript remains the authoritative source view. Original, Chinese, and bilingual modes are explicit. Copy, TXT, and Clean Markdown actions name the mode they export and export the visible mode unless the user chooses another one. Playback following activates only while Transcript is the active tab.

### Notes

The interface distinguishes:

- **saved source excerpt**: exact transcript text plus timestamp;
- **AI-cleaned note**: an explicitly labeled transformation;
- **personal note**: user-authored text.

The `N` shortcut is removed so it does not intercept YouTube's own next-video shortcut. Destructive note actions require confirmation and expose busy/error states.

This release stores new captures as exact `source_excerpt` notes and does not silently call AI during Save. The note schema adds `kind`, `sourceSegmentIds`, `rawText`, and `transformedByAi`. Existing records migrate on read: matching `text` and `rawText` becomes `source_excerpt`; differing values become `ai_cleaned`. A personal-note composer is outside this iteration. Serialized mutations have FIFO commit order; a delete queued after a save observes and can delete that saved record, while a save queued after a delete remains present.

### Vocabulary

Vocabulary remains global rather than pretending to belong only to the current video. Word discovery is visible without hover. Individual transcript words do not become hundreds of tab stops. Keyboard users select text inside a focusable transcript row and use a single contextual “Explain or save word” action; pointer users may still click visibly marked words. The memory-card modal starts with the word, meaning, source, and a sticky Save action; advanced memory methods are collapsed by default. Existing local study and export behavior remains available without provider keys.

## Session and Data Architecture

Introduce a small `VideoSession` lifecycle owned by the side panel:

```text
VideoSession {
  sessionId,
  generation,
  videoId,
  tabId,
  windowId,
  abortController
}
```

Every video-bound request carries an immutable `{ sessionId, generation, videoId, tabId }` token to the background worker and receives the token back. Before changing DOM or state, the panel verifies every field. Before a background storage commit, the handler validates the video ID against the bound/sender tab when a tab exists and validates the durable reset epoch. Starting a new video session aborts fetches that expose an AbortSignal, increments generation, clears video-bound DOM, resets the active destination to Overview, and stops playback tracking. Chrome runtime messages themselves cannot be cancelled, so late results are explicitly ignored. A new session ID distinguishes A-to-B-to-A navigation, two panels in separate windows, panel reloads, and a restarted service worker.

Metadata and playback relay messages target the bound `tabId`; they do not choose an arbitrary active or recently used YouTube tab.

Provider work is isolated behind focused helpers. The Supadata client enforces:

- request timeout;
- wall-clock polling deadline;
- bounded response bodies;
- identical transcript normalization for synchronous and asynchronous results;
- rejection of empty successful results;
- normalized typed errors.

Supadata's initial request has a 30-second hard deadline and a 5 MiB response limit. Each polling request has a 15-second deadline and the entire async job has a 90-second wall-clock deadline. DeepSeek retains a 50-second idle deadline, a 120-second hard deadline, and a 2 MiB response limit. Canonical error codes are:

```text
MISSING_KEY, INVALID_KEY, NO_TRANSCRIPT, RATE_LIMITED,
INSUFFICIENT_CREDIT, NETWORK_ERROR, REQUEST_TIMEOUT,
EMPTY_RESPONSE, MALFORMED_RESPONSE, INPUT_TOO_LARGE, RESPONSE_TOO_LARGE,
SESSION_STALE, RESET_DURING_REQUEST, UNKNOWN_PROVIDER_ERROR
```

401/403 map to `INVALID_KEY` unless a documented response payload specifically identifies balance or quota; 429 maps to `RATE_LIMITED`; timeout and offline failures remain distinct. `INPUT_TOO_LARGE` is a local, nonretryable pre-dispatch failure with `reduce_request`; it is distinct from an oversized provider response. “May have used provider credit” is conservatively true after a provider request is dispatched, including native-caption 206 responses, and false for cache hits or failures before dispatch.

Notes receive the same serialized mutation discipline already used by vocabulary. Reset uses a reset generation/epoch so work started before the reset cannot repopulate cleared stores.

This release performs targeted extraction only. It does not migrate the extension to a new framework or bundler.

## Loading, Partial, and Error States

The extension never relies on a small status line while leaving unrelated old content in place.

- **Loading transcript:** skeleton plus named stage and cancel-safe session binding.
- **Transcript ready / overview loading:** transcript is usable; overview area explains that analysis is still running.
- **Overview partial:** available sections render while missing optional sections are named.
- **Overview error:** completed transcript stays usable; the overview container shows the typed failure and scoped action.
- **Deep analysis loading:** the card becomes a dedicated progress panel, reports completed stages, and disables duplicate submission.
- **Deep analysis error:** basic overview remains intact and retry resumes from the failed stage.

Buttons use visible busy text and `aria-busy`; missing provider configuration appears as inline guidance plus a settings action, not only a tooltip on a disabled control.

## Privacy and Security Boundary

No new host permissions are required. Provider calls remain restricted to Supadata and DeepSeek. There is no analytics service, custom backend, or arbitrary remote-code execution.

Untrusted provider and transcript content continues to reach the DOM only through text-safe rendering and bounded normalized schemas. Message actions are sender- and tab-scoped where applicable. Selection and metadata payloads have explicit size limits.

The non-extension preview path may persist interface language only. It must never persist Supadata or DeepSeek keys to ordinary local storage and must remove legacy preview-key remnants.

Options supports English and Simplified Chinese, initially following the saved preference and then `navigator.language` when no preference exists. The side panel is Chinese-first for this release, sets `documentElement.lang` to `zh-CN`, and keeps product and technical names in English where useful. A complete side-panel locale catalogue is a later iteration; new strings are nevertheless centralized by feature rather than scattered through error branches.

## Release and Migration

The first trust-first release receives a new semantic version in `manifest.json` and `package.json`. Release checks assert version consistency, a unique output artifact, and allowed files. Packaging uses a sorted file list with fixed timestamps, permissions, and compression parameters; two clean builds of the same tree must produce the same SHA-256. The packaged ZIP is inspected, not only the source tree.

Existing transcript, translation, analysis, note, and vocabulary data remain readable. Schema changes use normalization and migration rather than blind deletion. Full reset behavior is updated without changing the names of existing persisted stores until migration tests exist.

## Non-Goals

- public Chrome Web Store publishing or automated external distribution;
- cloud sync, user accounts, analytics, or a custom backend;
- replacing DeepSeek or Supadata with a new provider in this iteration;
- arbitrary webpage/PDF ingestion;
- rewriting the extension in React, TypeScript, or another framework;
- automatically generating deep analysis for every opened video;
- silently rewriting source transcript text.
- a new personal-note composer;
- hierarchical summarization for transcripts above the basic-overview input cap.

## Success Criteria

1. A delayed-response matrix proves that metadata, transcript, basic overview, deep analysis, translation, notes, playback, cache writes, and exports from session A cannot alter session B; A-to-B-to-A and two-window tokens are also distinct.
2. Overview becomes the default new-video destination and automatically begins only the basic overview after transcript readiness.
3. Every rendered core conclusion cites one to three locally existing segment IDs or displays `insufficient`; unknown IDs never reach the DOM.
4. Evidence view obtains exact normalized text from cited segments, includes bounded adjacent context, and its seek button sends the derived seconds to the session-bound tab ID.
5. Deep analysis starts only through an explicit action, has one coherent loading/error container, and prevents duplicate requests.
6. Transcript Copy/TXT/Clean MD labels and data match the selected original/Chinese/bilingual mode. Chinese or bilingual export is disabled with an explicit incomplete-translation message until every segment has translated or been deliberately marked failed; it never silently falls back to original-only output.
7. Concurrent note saves retain every note; delete/save races have deterministic behavior.
8. Full reset names and clears settings, provider status, digests, translations, notes, and vocabulary; preserves language and the new epoch; and tests that a write holding the old epoch is rejected after reset.
9. Ordinary webpage preview cannot store API keys and deletes a seeded legacy preview settings secret on initialization.
10. Tests prove the 30-second initial Supadata deadline, 15-second poll deadline, 90-second job deadline, async empty rejection, response-size bound, and canonical mapping for 401/403/429/network/quota failures.
11. Automated DOM/static assertions cover tab semantics, arrow-key logic, modal focus/Escape/restore, reduced-motion CSS, and no per-word tab stops. A 320 CSS-pixel manual smoke checklist verifies no horizontal clipping and reachable actions until a real Chrome visual test is added.
12. Existing local vocabulary, translation cache, cleaned transcript export, deep-analysis normalization, and study-pack behavior do not regress.
13. Focused tests, the full Node suite, release checks, diff review, packaged-artifact inspection, and two-build SHA-256 comparison pass.
14. Digest cache pre-eviction stays below 8 MiB, never evicts non-digest stores, and a simulated quota error retries exactly once after oldest-first eviction.

## Implementation Order

The work is divided into three verification gates:

1. **Correctness gate:** lifecycle matrix, fixed-tab routing, provider bounds, reset epoch, serialized notes, and byte-aware cache.
2. **Learning gate:** basic-overview schema and prompt, consented automatic generation, evidence view, manual deep analysis, cache migration, and export-mode alignment.
3. **Product gate:** independent setup states, destructive-data copy and feedback, note/vocabulary clarity, accessibility, narrow-panel behavior, documentation, versioning, and deterministic release.

Each gate starts with failing focused tests and passes the full existing suite before the next gate begins.

## Self-Review

- The design directly reflects the approved audience, automatic/basic versus manual/deep split, and evidence-first priority.
- Every high-impact audit finding has an explicit product rule and measurable success criterion.
- The scope preserves proven features and permissions rather than proposing a framework rewrite.
- Privacy, cost, error recovery, migration, accessibility, and release behavior are first-class rather than deferred polish.
- Ambiguous terms are separated: source excerpt, AI summary, AI-cleaned note, and personal note.
- The plan can be split into targeted tests and reversible implementation slices.
- The post-review additions make overview, evidence, reset, session, timeout, cache, consent, note migration, preview cleanup, and release semantics directly implementable.
