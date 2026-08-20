# Evidence-Informed Vocabulary Learning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade new vocabulary cards into detailed bilingual study plans that combine context, honest form/sound/imagery cues, contrast, retrieval, generation, and spaced review.

**Architecture:** Keep the extension local-first. `background.js` will validate a canonical `learningPlan` and migrate saved version-1 cards to version 2. `sidepanel.js` will render every method, derive a fixed six-session review routine, and keep it in all exports.

**Tech Stack:** Chrome Manifest V3, native JavaScript/CSS, existing AI completion boundary, `chrome.storage.local`, Node built-in test runner.

---

## Constraints derived from the research

- Retrieval practice and distributed practice are core. Keyword, imagery, and sound cues are conditional encoding aids, not substitutes for recall.
- Meaning in the source context appears before mnemonic content.
- Morphology must be reliable. Sound/keyword bridges are labelled as memory cues, not pronunciation or etymology; an unsuitable cue must be stated instead of forced.
- Reviews occur now, then after 1, 3, 7, 14, and 30 days. No scheduler, notification permission, account, backend, or sync is in scope.
- Version-1 saved words are migrated, not dropped.

## File responsibilities

- `background.js`: schema version, bounded normalizers, legacy migration, compatibility aliases.
- `prompts/vocabulary.md`: exact v2 model contract and anti-fabrication rules.
- `sidepanel.js`: learning-plan renderer, review helper, search text, and complete safe exports.
- `sidepanel.css`: scoped responsive method cards and review timeline.
- `tests/vocabulary.test.js`: contract, migration, schedule, renderer source, and export tests.
- `README.zh-CN.md` and `docs/vocabulary-memory-methods.md`: student use instructions and research links.

### Task 1: Version-2 model contract and data migration

**Files:**
- Modify: `tests/vocabulary.test.js`
- Modify: `background.js:23,1669-1951,2318-2324`

- [ ] **Step 1: Write failing tests and fixtures**

Add `completeLearningPlan()` to the test fixture. It must provide the following exact keys:

```js
{
  contextAnchor: { explanationZh, collocationUseZh },
  morphology: { available, breakdown, explanationZh },
  soundBridge: { cueZh, safeguardZh },
  visualScene: { hookZh, sceneEn, sceneZh, recallPathZh },
  contrast: { relatedWordEn, distinctionZh, miniContrastEn },
  retrieval: { clozePrompt, meaningToWordPrompt, productionPrompt, selfExplainPrompt },
  generation: { exampleEn, exampleZh },
  migrationNoteZh
}
```

Test that `normalizeVocabularyCard` retains nonempty context, retrieval, and generation fields. Test that normalizing a version-1 `libraryEntry()` returns schema version 2 and a `migrationNoteZh` containing `旧版`.

- [ ] **Step 2: Verify RED**

Run `node --test tests/vocabulary.test.js`; expect failure because version-1 cards have no `learningPlan`.

- [ ] **Step 3: Implement the smallest safe migration**

Set `VOCABULARY_SCHEMA_VERSION = 2`. Add `normalizeVocabularyLearningPlan(value)` using `vocabularyString` limits and a safe boolean for `morphology.available`. Add `createLegacyVocabularyLearningPlan(source)` that preserves old morphology/mnemonic/example/prompts and marks unavailable fields honestly (for example, `旧版未生成声音联想`). Use this plan in new and stored normalizers. Derive the old flat fields from the canonical plan so current code remains compatible during migration.

- [ ] **Step 4: Verify GREEN and commit**

Run `node --test tests/vocabulary.test.js && node --check background.js`; expect success. Commit with message `feat: add evidence-informed vocabulary card schema`.

### Task 2: Detailed bilingual AI instructions

**Files:**
- Modify: `prompts/vocabulary.md`
- Modify: `tests/vocabulary.test.js`

- [ ] **Step 1: Write a failing prompt regression test**

```js
test("vocabulary prompt requires retrieval, contrast, generation, and safeguards", () => {
  const prompt = read("prompts/vocabulary.md");
  assert.match(prompt, /meaningToWordPrompt/);
  assert.match(prompt, /selfExplainPrompt/);
  assert.match(prompt, /relatedWordEn/);
  assert.match(prompt, /Do not force a sound cue/i);
  assert.match(prompt, /not.*etymology/i);
});
```

- [ ] **Step 2: Verify RED**

Run `node --test tests/vocabulary.test.js --test-name-pattern="prompt requires"`; expect failure due to missing v2 fields.

- [ ] **Step 3: Replace the stable JSON contract**

Require the Task 1 `learningPlan` together with current core meanings/collocations. Require a Chinese context anchor, real morphology or `available: false`, labelled optional sound cue, unusual bilingual visual scene, nearby/confusable word contrast, source cloze, meaning-to-word, production, self-explanation, and a new English example with Chinese translation. Forbid Markdown, extra fields, invented roots, invented history, and invented pronunciation.

- [ ] **Step 4: Verify GREEN and commit**

Run `node --test tests/vocabulary.test.js && npm run check`; expect success. Commit with message `feat: prompt detailed bilingual memory methods`.

### Task 3: Eight learner-visible methods and fixed review sessions

**Files:**
- Modify: `tests/vocabulary.test.js`
- Modify: `sidepanel.js:1848-1953,2259-2404,3377-3392`
- Modify: `sidepanel.css:1468-1680`

- [ ] **Step 1: Write failing review and rendering tests**

```js
test("buildVocabularyReviewPlan creates six progressively active sessions", () => {
  const { buildVocabularyReviewPlan } = loadSidepanelHelpers();
  const sessions = buildVocabularyReviewPlan(libraryEntry({ learningPlan: completeLearningPlan() }));
  assert.deepEqual(Array.from(sessions, (s) => s.day), ["现在", "1 天后", "3 天后", "7 天后", "14 天后", "30 天后"]);
  assert.match(sessions[2].taskZh, /不看答案/);
  assert.match(sessions[5].taskZh, /造句/);
});
```

Also assert source labels `语境锚点`, `声音`, `关键词`, `易混对比`, and `间隔复习` exist.

- [ ] **Step 2: Verify RED**

Run `node --test tests/vocabulary.test.js --test-name-pattern="review plan"`; expect failure because no helper exists.

- [ ] **Step 3: Render safely and visibly**

Add `buildVocabularyReviewPlan(entry)` returning fixed sessions. Add `renderVocabularyLearningPlan(card)` with escaped model values and Chinese sections: ①语境锚点, ②词形结构, ③声音/关键词桥, ④画面链, ⑤易混对比, ⑥主动提取, ⑦新例句生成, ⑧间隔复习. For unavailable morphology, say no shortcut is forced. Use this renderer in both modal and expanded library. Add scoped method-card and review-timeline CSS while retaining modal scrolling and keyboard focus.

- [ ] **Step 4: Verify GREEN and commit**

Run `node --test tests/vocabulary.test.js && node --check sidepanel.js`; expect success. Commit with message `feat: render multi-method vocabulary learning plans`.

### Task 4: Full exports and student documentation

**Files:**
- Modify: `tests/vocabulary.test.js`
- Modify: `sidepanel.js:2259-2404`
- Modify: `README.zh-CN.md`
- Create: `docs/vocabulary-memory-methods.md`

- [ ] **Step 1: Write a failing full-export test**

```js
test("all exports retain detailed methods and spaced review", () => {
  const helpers = loadSidepanelHelpers();
  const entry = libraryEntry({ learningPlan: completeLearningPlan() });
  assert.match(helpers.buildVocabularyCsv([entry]), /声音.*关键词/);
  assert.match(helpers.buildVocabularyMarkdown([entry]), /间隔复习/);
  assert.match(helpers.buildVocabularyAnkiTsv([entry]), /Meaning → word/);
});
```

- [ ] **Step 2: Verify RED**

Run `node --test tests/vocabulary.test.js --test-name-pattern="all exports"`; expect failure because v1 exports omit the plan.

- [ ] **Step 3: Export all study material safely**

Add plan columns to CSV, method sections and six sessions to Markdown, and all retrieval prompts/contrast/sound safeguard/bilingual example/review sessions to the Anki Back field while retaining exactly two TSV columns. Retain current CSV, Markdown, and Anki escaping. Extend the search haystack with v2 fields.

- [ ] **Step 4: Document real use and research limits**

In README describe: click word → understand/mentally enact plan → save → follow fixed dates or export to Anki. State there is no notification scheduler and AI cues must be checked against the source. In `docs/vocabulary-memory-methods.md`, link primary/review work on retrieval, spacing, keyword+retrieval, morphology, and multimedia glosses; clearly call core practices stronger than conditional mnemonic aids.

- [ ] **Step 5: Verify GREEN and commit**

Run `node --test tests/vocabulary.test.js && npm run check`; expect success. Commit with message `docs: explain evidence-informed vocabulary study workflow`.

### Task 5: Full release verification

**Files:**
- Verify: `tests/*.test.js`, `dist/youtube-digest-v1.1.5.zip`

- [ ] **Step 1: Inspect direction before costly tests**

Run `git diff --check && git diff --stat`; expect no whitespace errors and only planned vocabulary files.

- [ ] **Step 2: Test, check, and package**

Run `npm test && npm run check && npm run package`; expect all commands to pass and regenerate the ZIP.

- [ ] **Step 3: Inspect archive and success criteria**

Run `unzip -l dist/youtube-digest-v1.1.5.zip | rg "(prompts/vocabulary.md|background.js|sidepanel.js|README.zh-CN.md)"`; verify each path exists. Review v1 migration, eight methods, escaping, exports, and unchanged permissions/network surface before completion.

## Plan self-review

- Tasks cover migration, AI quality, learner-visible workflow, all export paths, research documentation, and package verification.
- The primary risks are controlled: old data remains readable; false word roots/sound claims are forbidden and visually labelled; the schedule is practical but does not imply notifications.
- Tests cover the JSON contract, migration, fixed schedule, UI labels, escaping-preserving exports, full suite, release checks, and ZIP contents.
