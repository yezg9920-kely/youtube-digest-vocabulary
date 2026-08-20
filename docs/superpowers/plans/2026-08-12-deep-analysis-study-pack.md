# Deep Analysis and Study Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade YouTube Digest from raw transcript plus shallow Overview into a downloadable cleaned transcript, structured Chinese deep analysis, and combined Markdown study pack.

**Architecture:** Extend the existing single lazy analysis call and local digest cache with a versioned, strictly normalized schema. Keep transcript organization and Markdown export as pure side-panel helpers, use existing safe DOM rendering patterns, and make all downloads local. Preserve the existing chapter, quote, and key-moment contract for backward compatibility.

**Tech Stack:** Chrome Manifest V3, vanilla JavaScript, HTML/CSS, DeepSeek JSON chat completion, Node.js built-in test runner, shell release packaging.

---

## File map

- `prompts/analysis.md`: structured deep-analysis instructions and exact JSON contract.
- `background.js`: analysis schema normalization, bounds, timestamp validation, version marker.
- `sidepanel.js`: old-cache upgrade detection, report UI rendering, cleaned transcript builder, report/study-pack Markdown builders, download actions.
- `sidepanel.html`: Overview report sections and export controls; Clean MD transcript control.
- `sidepanel.css`: report hierarchy, insight/argument cards, critical-thinking columns, responsive export controls.
- `tests/deep-analysis.test.js`: pure normalization, transcript organization, report export, compatibility, and UI wiring tests.
- `tests/release.test.js`: documentation, privacy, and permission regression assertions.
- `README.md`, `README.zh-CN.md`, `PRIVACY.md`: user workflow and data-handling documentation.

### Task 1: Versioned deep-analysis schema

**Files:**
- Modify: `prompts/analysis.md`
- Modify: `background.js`
- Create: `tests/deep-analysis.test.js`

- [ ] Write a failing test that loads `validateAndFixTimestamps`, supplies oversized/malformed model fields, and asserts `schemaVersion: 2`, bounded arrays/strings, valid timestamps, and safe empty defaults.
- [ ] Run `node --test tests/deep-analysis.test.js` and verify the missing exported helper/schema assertions fail.
- [ ] Extend the prompt JSON with `summary`, `keyInsights`, `argumentMap`, `criticalThinking`, `actionItemsZh`, and `reviewQuestions`, requiring Simplified Chinese analysis and source-language exact quotes.
- [ ] Extend `validateAndFixTimestamps(analysis, maxSeconds)` with reusable bounded-string/array normalizers, validate insight timestamps, and return both legacy and new fields with `schemaVersion: 2`.
- [ ] Export the validator through a test-only analysis helper object and rerun the focused test until it passes.
- [ ] Commit with `feat: generate structured deep transcript analysis`.

### Task 2: Clean timestamped transcript Markdown

**Files:**
- Modify: `sidepanel.js`
- Modify: `sidepanel.html`
- Test: `tests/deep-analysis.test.js`

- [ ] Write failing tests for `buildCleanTranscriptMarkdown`: metadata escaping, semantic paragraph timestamps, canonical video links, description inclusion, and empty-transcript behavior.
- [ ] Run the focused test and verify the builder is missing.
- [ ] Reuse `groupTranscriptEntries` to build readable paragraphs, implement Markdown text escaping and the pure transcript builder, and expose it only through the existing test helper.
- [ ] Add a `Clean MD` button beside Copy and raw Export; wire it to a local `text/markdown` download and explicit empty-state feedback.
- [ ] Rerun focused tests and commit with `feat: export cleaned timestamped transcripts`.

### Task 3: Deep report UI and cache upgrade

**Files:**
- Modify: `sidepanel.html`
- Modify: `sidepanel.css`
- Modify: `sidepanel.js`
- Test: `tests/deep-analysis.test.js`

- [ ] Write failing wiring tests asserting every report section exists, model values are passed through `escapeHtml`, and `hasDeepAnalysis` rejects old chapter-only cache objects.
- [ ] Run the focused test and verify failure.
- [ ] Add Overview blocks for takeaway, summary/thesis, insights, argument map, critical thinking, action items, review questions, chapters, and quotes.
- [ ] Implement `hasDeepAnalysis`, report rendering helpers, safe empty sections, and buttons for regenerate/report export/study pack export.
- [ ] Update Overview activation so an old cached analysis regenerates once rather than being treated as complete.
- [ ] Disable exports during loading/errors and enable them after a valid deep analysis; preserve chapter seeking and quote note/copy actions.
- [ ] Rerun focused tests and commit with `feat: add deep analysis learning report`.

### Task 4: Report and complete study-pack downloads

**Files:**
- Modify: `sidepanel.js`
- Test: `tests/deep-analysis.test.js`

- [ ] Write failing snapshot-style assertions for `buildDeepAnalysisMarkdown` and `buildStudyPackMarkdown`, including every new section, source links, timestamp links, answer disclosure, cleaned transcript, and stable heading order.
- [ ] Run focused tests and verify the export helpers are missing.
- [ ] Implement deterministic Markdown builders from normalized values only; make report export analysis-only and study-pack export append the cleaned transcript.
- [ ] Wire both buttons through `downloadTextFile` with sanitized filenames and visible status feedback.
- [ ] Rerun focused tests and commit with `feat: export deep analysis study packs`.

### Task 5: Documentation and release contract

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `PRIVACY.md`
- Modify: `tests/release.test.js`

- [ ] Write failing release assertions for raw TXT, Clean MD, Report MD, Study Pack, lazy AI analysis, local export, and unchanged manifest permissions.
- [ ] Run `node --test tests/release.test.js` and verify the documentation assertions fail.
- [ ] Document the exact workflow, report structure, old-cache upgrade, model limitations, and that transcript/report files are generated locally.
- [ ] Clarify that analysis sends transcript plus video metadata to DeepSeek only when Overview is opened/regenerated.
- [ ] Rerun the release tests and commit with `docs: explain deep analysis study packs`.

### Task 6: Review and release acceptance

**Files:**
- Review: all files changed since `60ddafa`
- Generate: `dist/youtube-digest-v1.1.5.zip`

- [ ] Run the smallest focused suite: `node --test tests/deep-analysis.test.js tests/release.test.js`.
- [ ] Inspect `git diff --check` and run `node --check background.js && node --check sidepanel.js`.
- [ ] Run the full suite with `npm test`.
- [ ] Request independent review against the design success criteria and fix every Critical/Important finding with a failing regression test first.
- [ ] Run `npm run check` and `npm run package`.
- [ ] Inspect the ZIP file list, verify `prompts/analysis.md` contains the version-2 schema, scan for AppleDouble/credentials, record SHA-256, and confirm a clean feature branch.

## Plan self-review

- Spec coverage: each of the eight success criteria maps to Tasks 1 through 6.
- Cache compatibility: `hasDeepAnalysis` explicitly forces old Overview data through the new request.
- Type consistency: prompt, validator, renderer, and exporters use the same version-2 field names.
- Scope: arbitrary blog scraping, PDF/DOCX, and additional permissions remain excluded.
- Test progression: every behavior-changing task starts red, implements minimally, then reruns focused tests before committing.
- Placeholder scan: no deferred steps or ambiguous implementation actions remain.
