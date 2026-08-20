# Vocabulary Memory Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add click-to-generate bilingual vocabulary memory cards, a deduplicated local word library, and CSV/Markdown/Anki TSV exports to YouTube Digest.

**Architecture:** Keep the extension serverless and use its existing side-panel-to-service-worker message boundary. Add pure, VM-testable vocabulary helpers to the existing large scripts, a stable structured DeepSeek prompt, a Vocabulary tab/dialog in the side panel, and a versioned `chrome.storage.local` record.

**Tech Stack:** Chrome Manifest V3, native HTML/CSS/JavaScript, DeepSeek chat completions, `chrome.storage.local`, Node.js built-in test runner and VM harnesses.

---

## File structure

- Create `prompts/vocabulary.md`: stable structured prompt for bilingual memory cards.
- Create `tests/vocabulary.test.js`: pure helper, AI validation, merge, filter, and export tests.
- Modify `background.js`: message actions, request validation, model response normalization, persistence and merge logic.
- Modify `sidepanel.js`: transcript word tokenization, dialog rendering, library UI, search, delete, export and test exports.
- Modify `sidepanel.html`: Vocabulary tab, library controls, empty state and list host.
- Modify `sidepanel.css`: accessible word controls, memory card dialog, library and responsive states.
- Modify `scripts/check-release.sh`: include the new prompt in the public allowlist.
- Modify `README.md`, `README.zh-CN.md`, `PRIVACY.md`: feature usage and privacy documentation.
- Modify `tests/release.test.js`: public surface and documentation assertions.

### Task 1: Pure transcript tokenization and source occurrence helpers

**Files:**
- Create: `tests/vocabulary.test.js`
- Modify: `sidepanel.js`

- [ ] **Step 1: Write failing tests for English word tokenization**

Load `sidepanel.js` in the same VM pattern as `tests/translation.test.js`, then assert the wished-for helper contract:

```js
test("tokenizeVocabularyText preserves visible text and recognizes compounds", () => {
  const { tokenizeVocabularyText } = loadSidepanelHelpers();
  const tokens = tokenizeVocabularyText("Don't re-run version 2.0 — naïve.");
  assert.equal(tokens.map((token) => token.text).join(""), "Don't re-run version 2.0 — naïve.");
  assert.deepEqual(
    tokens.filter((token) => token.type === "word").map((token) => token.text),
    ["Don't", "re-run", "naïve"],
  );
});

test("renderVocabularyText escapes source text and emits accessible word buttons", () => {
  const { renderVocabularyText } = loadSidepanelHelpers();
  const html = renderVocabularyText('<script>run & "jump"</script>');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /class="vocab-word"/);
  assert.match(html, /data-word="run"/);
  assert.match(html, /aria-label="Learn word: run"/);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/vocabulary.test.js`

Expected: FAIL because `tokenizeVocabularyText` and `renderVocabularyText` are not exported.

- [ ] **Step 3: Implement minimal tokenization and rendering helpers**

Add pure functions near transcript rendering:

```js
function tokenizeVocabularyText(text) {
  const source = String(text || "");
  const pattern = /[A-Za-zÀ-ÖØ-öø-ÿ]+(?:[’'][A-Za-zÀ-ÖØ-öø-ÿ]+)*(?:-[A-Za-zÀ-ÖØ-öø-ÿ]+(?:[’'][A-Za-zÀ-ÖØ-öø-ÿ]+)*)*/g;
  const tokens = [];
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > cursor) tokens.push({ type: "text", text: source.slice(cursor, match.index) });
    tokens.push({ type: "word", text: match[0] });
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) tokens.push({ type: "text", text: source.slice(cursor) });
  return tokens;
}

function renderVocabularyText(text) {
  return tokenizeVocabularyText(text).map((token) => {
    if (token.type === "text") return escapeHtml(token.text);
    const safe = escapeHtml(token.text);
    return `<button class="vocab-word" type="button" data-word="${safe}" aria-label="Learn word: ${safe}">${safe}</button>`;
  }).join("");
}
```

Expose both through `__YTD_TRANSCRIPT_TESTING__`.

- [ ] **Step 4: Run focused and regression tests**

Run: `node --test tests/vocabulary.test.js tests/translation.test.js tests/transcript-selection.test.js`

Expected: all tests PASS.

- [ ] **Step 5: Commit the tokenization slice**

```bash
git add sidepanel.js tests/vocabulary.test.js
git commit -m "feat: tokenize transcript words for vocabulary capture"
```

### Task 2: Structured AI vocabulary contract

**Files:**
- Create: `prompts/vocabulary.md`
- Modify: `background.js`
- Modify: `tests/vocabulary.test.js`
- Modify: `scripts/check-release.sh`

- [ ] **Step 1: Write failing tests for request and response validation**

Extend the VM harness to obtain `__YTD_VOCABULARY_TESTING__`, then test:

```js
test("validateVocabularyRequest bounds and normalizes transcript context", () => {
  const { validateVocabularyRequest } = loadBackgroundHelpers();
  const result = validateVocabularyRequest({
    word: " Running ",
    sentence: "We are running a careful experiment.",
    context: "x".repeat(2000),
    timestampSeconds: 42.8,
    videoId: "abc123",
  });
  assert.equal(result.word, "Running");
  assert.equal(result.timestampSeconds, 42);
  assert.ok(result.context.length <= 1200);
});

test("normalizeVocabularyCard accepts a complete bilingual JSON card", () => {
  const { normalizeVocabularyCard } = loadBackgroundHelpers();
  const card = normalizeVocabularyCard(completeModelCard(), validRequest());
  assert.equal(card.lemma, "run");
  assert.equal(card.meaningZh, "跑；运行");
  assert.equal(card.mnemonic.sceneEn.length > 0, true);
  assert.equal(card.occurrences[0].form, "running");
});

test("normalizeVocabularyCard rejects missing learning fields", () => {
  const { normalizeVocabularyCard } = loadBackgroundHelpers();
  assert.throws(() => normalizeVocabularyCard({ lemma: "run" }, validRequest()), /definitionEn/);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/vocabulary.test.js`

Expected: FAIL because the validation helpers and test export do not exist.

- [ ] **Step 3: Implement validation, normalization and generation handler**

Add constants and pure helpers that normalize strings, string arrays and required fields. Build an occurrence from the validated request. Add `handleGenerateVocabularyCard(payload)` that loads `vocabulary.md`, calls `requestAiCompletion` with JSON mode, retries once without JSON mode only for an empty response, passes the result through `parseLooseJson`, and returns `{ success: true, card }`.

The handler call must use bounded values:

```js
const { text } = await requestAiCompletion({
  temperature: 0.45,
  maxTokens: 1800,
  responseFormat: { type: "json_object" },
  messages: [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ],
});
```

Add an asynchronous `generateVocabularyCard` branch to the runtime message listener. Expose only pure validators and merge helpers through `__YTD_VOCABULARY_TESTING__`.

- [ ] **Step 4: Add the stable prompt and release allowlist entry**

Create `prompts/vocabulary.md` with exact required JSON field names and rules: accurate contextual meaning first, bilingual output, lemma normalization, honest morphology, visual and interactive mnemonic scene, labeled approximate sound cues, a source cloze, a production prompt, no Markdown, and no fabricated etymology. Add `prompts/vocabulary.md` beside the other prompts in `public_allowlist`.

- [ ] **Step 5: Run focused tests and syntax checks**

Run: `node --test tests/vocabulary.test.js tests/translation.test.js && node --check background.js`

Expected: all tests PASS and syntax check exits 0.

- [ ] **Step 6: Commit the AI contract slice**

```bash
git add background.js prompts/vocabulary.md scripts/check-release.sh tests/vocabulary.test.js
git commit -m "feat: generate structured bilingual vocabulary cards"
```

### Task 3: Versioned local library and lemma merge

**Files:**
- Modify: `background.js`
- Modify: `tests/vocabulary.test.js`

- [ ] **Step 1: Write failing merge tests**

```js
test("mergeVocabularyEntry combines inflected forms and source occurrences", () => {
  const { mergeVocabularyEntry } = loadBackgroundHelpers();
  const first = normalizedCard({ lemma: "run", form: "running", timestampSeconds: 42 });
  const second = normalizedCard({ lemma: "run", form: "ran", timestampSeconds: 88 });
  const merged = mergeVocabularyEntry(first, second, 2000);
  assert.deepEqual(merged.forms, ["ran", "running"]);
  assert.equal(merged.occurrences.length, 2);
  assert.equal(merged.createdAt, first.createdAt);
  assert.equal(merged.updatedAt, 2000);
});

test("mergeVocabularyEntry does not duplicate the same occurrence", () => {
  const { mergeVocabularyEntry } = loadBackgroundHelpers();
  const first = normalizedCard({ lemma: "run", form: "running", timestampSeconds: 42 });
  assert.equal(mergeVocabularyEntry(first, first, 2000).occurrences.length, 1);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/vocabulary.test.js`

Expected: FAIL because `mergeVocabularyEntry` is missing.

- [ ] **Step 3: Implement storage repository handlers**

Use `VOCABULARY_STORAGE_KEY = "ytd_vocabulary"` and `VOCABULARY_SCHEMA_VERSION = 1`. Add:

- `readVocabularyLibrary()` returning `{ schemaVersion: 1, entries: [] }` for absent/invalid storage;
- `mergeVocabularyEntry(existing, incoming, now)` using normalized lemma as identity and a stable occurrence signature;
- `handleSaveVocabularyCard(card)` validating again before storage, merging or inserting, sorting newest first, and returning `{ success: true, entry, count }`;
- `handleGetVocabulary()` returning normalized newest-first entries;
- `handleDeleteVocabularyCard(id)` deleting exactly one matching ID.

Add `saveVocabularyCard`, `getVocabulary`, and `deleteVocabularyCard` runtime actions. Broadcast `{ action: "vocabularyChanged" }` after mutations.

- [ ] **Step 4: Run tests**

Run: `node --test tests/vocabulary.test.js && node --check background.js`

Expected: PASS.

- [ ] **Step 5: Commit the storage slice**

```bash
git add background.js tests/vocabulary.test.js
git commit -m "feat: persist a deduplicated local vocabulary library"
```

### Task 4: Click-to-learn transcript interaction and memory-card dialog

**Files:**
- Modify: `sidepanel.js`
- Modify: `sidepanel.css`
- Modify: `tests/vocabulary.test.js`
- Modify: `tests/transcript-selection.test.js`

- [ ] **Step 1: Write failing source and behavior tests**

Assert both original and bilingual render paths call `renderVocabularyText` for original text, translation text remains plain `renderSubtitleInlineMarkup`, and delegated word clicks call `preventDefault` plus `stopPropagation` before opening the vocabulary dialog.

```js
test("original and bilingual transcripts make only English source words learnable", () => {
  const source = read("sidepanel.js");
  assert.match(source, /renderVocabularyText\(group\.text\)/);
  assert.match(source, /mode === "bilingual"[\s\S]*renderVocabularyText\(segment\.text\)/);
  assert.match(source, /renderSubtitleInlineMarkup\(translated\)/);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/vocabulary.test.js tests/transcript-selection.test.js`

Expected: FAIL because transcript paths and click handler are not wired.

- [ ] **Step 3: Wire token rendering and delegated click handling**

Replace original transcript inline rendering with `renderVocabularyText`. Add one delegated listener to `#transcriptList` during `setupEventListeners`; if `event.target.closest(".vocab-word")` exists, stop row seeking, find its `.transcript-entry`, resolve the semantic segment and timestamp, and call `showVocabularyCard({ word, sentence, context, ...video metadata })`.

- [ ] **Step 4: Implement a safe, retryable dialog**

Create the modal with DOM-safe templates, a loading state, close action, and a generation request. Render the normalized card fields with `escapeHtml`. `Retry` reuses the same bounded occurrence payload. `Add to vocabulary` sends `saveVocabularyCard`; successful save changes the button label and triggers `loadVocabulary()`.

- [ ] **Step 5: Add accessible dialog and word styles**

Style `.vocab-word` as transparent inline text at rest with dotted hover/focus underline, a 2px focus ring, and inherited reading typography. Style `.vocabulary-modal-*` with the existing palette and modal behavior, scrollable content, paired EN/ZH blocks, memory-scene callout and responsive actions.

- [ ] **Step 6: Run focused and regression tests**

Run: `node --test tests/vocabulary.test.js tests/transcript-selection.test.js tests/translation.test.js && node --check sidepanel.js`

Expected: PASS.

- [ ] **Step 7: Commit the capture UI slice**

```bash
git add sidepanel.js sidepanel.css tests/vocabulary.test.js tests/transcript-selection.test.js
git commit -m "feat: open memory cards from transcript words"
```

### Task 5: Vocabulary tab, filtering and deletion

**Files:**
- Modify: `sidepanel.html`
- Modify: `sidepanel.js`
- Modify: `sidepanel.css`
- Modify: `tests/vocabulary.test.js`

- [ ] **Step 1: Write failing UI and filter tests**

```js
test("filterVocabularyEntries searches bilingual and source fields", () => {
  const { filterVocabularyEntries } = loadSidepanelHelpers();
  const entries = [libraryEntry({ lemma: "run", meaningZh: "跑", videoTitle: "Lab test" })];
  assert.equal(filterVocabularyEntries(entries, "跑").length, 1);
  assert.equal(filterVocabularyEntries(entries, "lab").length, 1);
  assert.equal(filterVocabularyEntries(entries, "missing").length, 0);
});

test("side panel exposes a Vocabulary tab with search and exports", () => {
  const html = read("sidepanel.html");
  assert.match(html, /data-tab="vocabulary"/);
  assert.match(html, /id="vocabularySearch"/);
  assert.match(html, /data-vocabulary-export="anki"/);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/vocabulary.test.js`

Expected: FAIL because helper and markup are absent.

- [ ] **Step 3: Add tab markup and local UI state**

Add the fourth navigation button and a `data-panel="vocabulary"` panel containing count, search, three export buttons, empty copy and `#vocabularyList`. Add `currentVocabularyEntries` and `vocabularySearchQuery` state.

- [ ] **Step 4: Implement load, filter, render and confirmed deletion**

`loadVocabulary()` sends `getVocabulary`, then renders the current filter. Render collapsed `<details>` cards with lemma, IPA, part of speech, bilingual meanings, mnemonic, collocations, prompts and source occurrence buttons. First delete click changes to `Confirm delete`; second click within the same card sends `deleteVocabularyCard`. Re-render after mutation.

- [ ] **Step 5: Wire lifecycle events**

Load the library when the tab is selected, on `vocabularyChanged`, and after a successful card save. Search rerenders without a service-worker round trip. Occurrence clicks reuse `playNote`-style seek/open behavior.

- [ ] **Step 6: Add library styles and run tests**

Run: `node --test tests/vocabulary.test.js && node --check sidepanel.js`

Expected: PASS.

- [ ] **Step 7: Commit the library UI slice**

```bash
git add sidepanel.html sidepanel.js sidepanel.css tests/vocabulary.test.js
git commit -m "feat: add searchable vocabulary library"
```

### Task 6: CSV, Markdown and Anki TSV export

**Files:**
- Modify: `sidepanel.js`
- Modify: `tests/vocabulary.test.js`

- [ ] **Step 1: Write failing export escaping tests**

```js
test("CSV export quotes commas, quotes and line breaks", () => {
  const { buildVocabularyCsv } = loadSidepanelHelpers();
  const csv = buildVocabularyCsv([libraryEntry({ definitionEn: 'move, "quickly"\nnow' })]);
  assert.match(csv, /"move, ""quickly""\nnow"/);
});

test("Anki TSV keeps exactly two tab-separated columns per card", () => {
  const { buildVocabularyAnkiTsv } = loadSidepanelHelpers();
  const lines = buildVocabularyAnkiTsv([libraryEntry({ mnemonic: { hook: "a\tb", sceneEn: "line\none", sceneZh: "场景", recallPath: "path" } })]).trim().split("\n");
  assert.ok(lines.every((line) => line.split("\t").length === 2));
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/vocabulary.test.js`

Expected: FAIL because export builders are missing.

- [ ] **Step 3: Implement pure export builders**

Add `csvCell`, `escapeAnkiHtml`, `buildVocabularyCsv`, `buildVocabularyMarkdown`, and `buildVocabularyAnkiTsv`. CSV begins with a stable header. Markdown uses source links and escaped content. Anki output has `Front<TAB>Back` and replaces embedded tabs/newlines with HTML-safe spaces or `<br>`.

- [ ] **Step 4: Wire export buttons to current filtered entries**

Map `data-vocabulary-export` to builder, MIME type and extension. Reject an empty filtered result with visible status text. Download through existing `downloadTextFile` using `youtube-digest-vocabulary.<extension>`.

- [ ] **Step 5: Run focused tests**

Run: `node --test tests/vocabulary.test.js && node --check sidepanel.js`

Expected: PASS.

- [ ] **Step 6: Commit the export slice**

```bash
git add sidepanel.js tests/vocabulary.test.js
git commit -m "feat: export vocabulary for study and Anki"
```

### Task 7: Documentation, privacy and release surface

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `PRIVACY.md`
- Modify: `tests/release.test.js`

- [ ] **Step 1: Write failing release documentation tests**

Assert both READMEs describe click-to-learn, local vocabulary storage, CSV/Markdown/Anki TSV export and explicit save. Assert Privacy documents the clicked word/context DeepSeek payload and `ytd_vocabulary` retention.

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/release.test.js`

Expected: FAIL because documentation does not mention the vocabulary feature.

- [ ] **Step 3: Update English and Chinese usage documentation**

Add the feature to the opening list, usage steps, supported scope, personalization examples and troubleshooting. State that AI may be wrong, mnemonics are learning cues rather than etymology, and learners should verify high-stakes definitions.

- [ ] **Step 4: Update privacy disclosure**

Document that a click sends the word, bounded sentence/context and video metadata to DeepSeek; drafts are not saved automatically; saved cards remain locally until deleted or extension data is cleared; exports are created locally.

- [ ] **Step 5: Run release tests**

Run: `node --test tests/release.test.js`

Expected: PASS.

- [ ] **Step 6: Commit documentation**

```bash
git add README.md README.zh-CN.md PRIVACY.md tests/release.test.js
git commit -m "docs: explain vocabulary learning and privacy"
```

### Task 8: Full review and verification

**Files:**
- Review all files changed since design commit.

- [ ] **Step 1: Inspect implementation coherence before expensive checks**

Run: `git diff 7ac2fcb..HEAD --stat && git diff 7ac2fcb..HEAD --check && node --check background.js && node --check sidepanel.js`

Expected: intended files only, no whitespace errors, JavaScript syntax exits 0.

- [ ] **Step 2: Run the complete test suite**

Run: `npm test`

Expected: all Node tests pass with 0 failures.

- [ ] **Step 3: Run release validation**

Run: `npm run check`

Expected: allowlist, manifest references, syntax, tests and credential scan pass.

- [ ] **Step 4: Package the extension**

Run: `npm run package`

Expected: creates `dist/youtube-digest-v1.1.5.zip` and prints a SHA-256 checksum.

- [ ] **Step 5: Inspect the archive and secret surface**

Run: `unzip -Z1 dist/youtube-digest-v1.1.5.zip | sort && git grep -En 'sk-[A-Za-z0-9_-]{20,}|sd_[A-Za-z0-9_-]{16,}' -- ':!docs/superpowers/**' || true`

Expected: `prompts/vocabulary.md` is present, no private paths are present, and no credential matches appear.

- [ ] **Step 6: Review the diff against success criteria**

Read the design success criteria and confirm each maps to code and a test. Record any live Chrome/API-key acceptance steps as not automated rather than claiming them verified.

- [ ] **Step 7: Commit final test or cleanup adjustments if needed**

```bash
git add -A
git commit -m "test: verify vocabulary memory card release"
```

Skip this commit if verification produced no file changes.
