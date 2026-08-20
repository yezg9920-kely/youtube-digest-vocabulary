# YouTube Digest Vocabulary Memory Cards Design

## Goal

Extend YouTube Digest into a context-aware vocabulary capture tool for an English learner. A learner clicks an English word in the transcript, receives a vivid bilingual AI memory card, and can save the normalized word to a local vocabulary library for later export.

The first release deliberately stops before implementing an in-extension review scheduler. It stores review-ready fields and exports Anki-compatible data so spaced retrieval can be added later without migrating the core record format.

## Success criteria

- Every English word in original and bilingual transcript text is keyboard-focusable and clickable without breaking timestamp seeking or text selection.
- Clicking a word opens a card immediately, then asks the existing configured DeepSeek model to generate a structured bilingual learning card using the surrounding transcript and video metadata.
- Inflected forms such as `running`, `ran`, and `runs` resolve to a lemma such as `run`; the library keeps one canonical card while preserving every source occurrence.
- The learner explicitly saves a generated card. Re-saving the same lemma updates the card and appends a deduplicated source occurrence instead of creating a duplicate.
- The Vocabulary tab lists locally saved cards, supports search and deletion, and exports all matching cards as CSV, Markdown, or Anki TSV.
- API keys remain only in trusted extension storage. No new server, account, analytics, or broad browser permission is added.
- Automated tests cover word tokenization, response validation, deduplication, export escaping, UI wiring, and the existing regression suite.
- `npm test`, `npm run check`, and `npm run package` pass.

## Current project decomposition

YouTube Digest is a Manifest V3 Chrome extension made from native HTML, CSS, and JavaScript:

- `content.js` runs inside YouTube. It reads video metadata, seeks playback, and injects the Digest and Note buttons.
- `sidepanel.html`, `sidepanel.css`, and `sidepanel.js` render Transcript, Overview, and Notes. Transcript rows are reconstructed into semantic segments, can follow playback, and can show lazy AI translations.
- `background.js` is the trusted service worker. It retrieves native captions from Supadata, calls DeepSeek, manages notes, and relays messages.
- `settings.js` normalizes locally stored API settings.
- `prompts/*.md` keeps stable AI instructions outside the service worker.
- `chrome.storage.local` holds settings, recent digest caches, translations, and notes.
- Node's built-in test runner executes VM-based unit and release tests. There is no build step or production dependency.

The existing selection-based Explain path proves that transcript context can be sent safely to the service worker, but its free-form 1–3 sentence response and modal are too narrow for a durable learning card.

## Learning-method rationale

The feature separates initial encoding from long-term retention:

1. **Contextual meaning:** Save the authentic sentence and video timestamp so the word is tied to the situation in which it was encountered.
2. **Elaborative encoding:** Generate a concise visual scene and a sound, morphology, or meaning hook. The prompt labels sound associations as memory aids, never as etymology.
3. **Dual cues:** Use English for precise meaning and usage, and Chinese for an accessible explanation and vivid associative scene.
4. **Active-recall preparation:** Generate a cloze prompt and a simple English production prompt instead of only giving material to reread.
5. **Spaced retrieval outside v1:** Anki TSV export provides question and answer fields. In-extension scheduling remains a later feature.

This ordering reflects the strongest evidence: practice testing and distributed practice are broadly high-utility learning techniques, whereas imagery and keyword mnemonics are useful conditional encoding aids rather than substitutes for retrieval. The AI card therefore does not claim that a colorful mnemonic alone creates long-term memory.

## Approaches considered

### 1. Reuse Explain and save its text

This is the smallest patch, but the output is unstructured, the UI cannot reliably render or export individual learning fields, and duplicate inflections cannot be merged safely. It is rejected.

### 2. Add a bounded vocabulary domain inside the existing extension (selected)

This introduces a structured prompt and validator in `background.js`, reusable word/token/export helpers in `sidepanel.js`, one new Vocabulary tab, and a dedicated `ytd_vocabulary` storage key. It preserves the project's serverless architecture and existing coding style while creating clean boundaries for later review functionality.

### 3. Build a separate vocabulary web app with sync and accounts

This could support cross-device review but would require authentication, a backend, privacy policy changes, network permissions, deployment, and recurring maintenance. It is out of scope for a personal first release.

## Interaction design

### Transcript capture

- Original English text in Original and Bilingual modes is rendered as text interleaved with `<button class="vocab-word">` elements.
- Punctuation and whitespace remain plain text. English contractions and hyphenated compounds remain one click target.
- Clicking a word prevents the parent transcript row from seeking. Clicking elsewhere in the row continues to seek.
- Drag-selecting text continues to expose the existing Explain control.
- A word button has an accessible label, visible hover/focus treatment, and no artificial highlighting at rest.

### Memory-card dialog

The dialog opens immediately so the click feels acknowledged. Its header shows the clicked form and source timestamp while the content is loading. A successful response displays:

- lemma, clicked form, IPA, and part of speech;
- concise English definition and Chinese meaning in this context;
- the authentic source sentence with the target emphasized;
- common collocations;
- a morphology note when reliable;
- a vivid bilingual memory scene and explicit recall path;
- one fresh English example;
- an English cloze challenge and an English production prompt;
- `Add to vocabulary` or `Update vocabulary` action.

The user must explicitly add the card. This prevents accidental clicks from polluting the library or storage. After saving, the action confirms success and the Vocabulary tab updates.

### Vocabulary library

- Add a fourth top-level tab named `Vocabulary`.
- Show a count, a case-insensitive search box, export menu/buttons, and card list.
- Search covers lemma, clicked forms, English/Chinese meanings, source sentence, collocations, and video title.
- Each item is collapsed by default to keep scanning fast. Expanding shows the mnemonic, source sentence, learning prompts, and all known source occurrences.
- Source timestamps seek in the current video or open the timestamped YouTube URL for another video.
- Deletion requires a second explicit confirmation within the card to avoid accidental loss.
- Export applies to the current search results; an empty search exports the whole library.

## Data model

The storage key is `ytd_vocabulary`. Its value is an object with a schema version and entries:

```js
{
  schemaVersion: 1,
  entries: [
    {
      id: "vocab_run",
      lemma: "run",
      forms: ["running"],
      ipa: "/rʌn/",
      partOfSpeech: "verb",
      definitionEn: "...",
      meaningZh: "...",
      contextualMeaningEn: "...",
      contextualMeaningZh: "...",
      morphology: "...",
      collocations: ["run a test"],
      mnemonic: {
        hook: "...",
        sceneEn: "...",
        sceneZh: "...",
        recallPath: "..."
      },
      exampleEn: "...",
      clozePrompt: "...",
      productionPrompt: "...",
      occurrences: [
        {
          form: "running",
          sentence: "...",
          context: "...",
          videoId: "...",
          videoTitle: "...",
          channelName: "...",
          timestampSeconds: 42,
          timestamp: "0:42",
          url: "https://youtube.com/watch?v=...&t=42s",
          capturedAt: 0
        }
      ],
      createdAt: 0,
      updatedAt: 0
    }
  ]
}
```

All strings and arrays are size-bounded during normalization. `lemma` is the primary deduplication key after Unicode normalization and lowercase conversion. An occurrence is considered duplicated when video ID, timestamp, normalized form, and sentence match. The newest card content replaces the older generated explanation when explicitly updated, while `createdAt` and earlier occurrences remain.

## AI contract

`prompts/vocabulary.md` contains a stable system prompt and a variable user prompt. The service worker sends only:

- clicked word;
- source sentence and a bounded surrounding context;
- video title and channel;
- interface requirement for bilingual output.

The model must return one JSON object matching the named fields. Rules explicitly require:

- lemma and actual context-specific part of speech;
- short, accurate definitions before any mnemonic;
- mnemonics that are concrete, interactive, unusual, and easy to visualize;
- a preference order of transparent morphology, sound/keyword bridge, then semantic scene;
- no fabricated roots or etymology;
- marking any pronunciation-based Chinese association as an approximate memory cue;
- a cloze made from the source sentence when practical;
- no Markdown or unrequested fields.

`background.js` parses loose JSON, validates and bounds every field, then returns normalized data. Invalid responses fail closed with a retryable error; raw model HTML is never rendered.

## Component and data flow

1. `renderTranscript` or bilingual rendering tokenizes only original English text and embeds safe word buttons.
2. The delegated transcript click handler identifies the word and semantic segment, prevents seeking, and opens the loading dialog.
3. `sidepanel.js` constructs a bounded occurrence payload and sends `generateVocabularyCard`.
4. `background.js` validates the request, loads the vocabulary prompt, calls the existing DeepSeek completion helper, normalizes JSON, and returns a structured draft.
5. The side panel renders every field with escaped text and local DOM APIs.
6. On explicit save, the side panel sends `saveVocabularyCard`; the service worker merges it into `ytd_vocabulary` and broadcasts `vocabularyChanged`.
7. The Vocabulary tab loads via `getVocabulary`, filters locally, and requests deletion through `deleteVocabularyCard`.
8. CSV, Markdown, and Anki TSV are built locally from normalized entries and downloaded without a network request.

## Error handling and limits

- Missing DeepSeek key directs the learner to Settings.
- Timeouts, rate limits, malformed JSON, empty responses, and unsupported tokens show a retry action while keeping the dialog open.
- Only words containing ASCII English letters are interactive in v1. URLs, numbers, emoji, and pure punctuation are not.
- Requests bound word length, sentence/context length, and metadata to protect token usage.
- AI results are never automatically saved.
- Storage errors preserve the generated draft and display a save error.
- Export filenames are sanitized and include no volatile prompt content.
- The existing DeepSeek timeout and 2 MiB response cap still apply.

## Export formats

- **CSV:** one row per lemma with core meanings, mnemonic, source sentence, source URL, and timestamps. All spreadsheet-special characters are quoted correctly.
- **Markdown:** one readable section per word with bilingual definitions, memory scene, usage, recall prompts, and source links.
- **Anki TSV:** two columns named Front and Back. Front contains the cloze and production cue; Back contains lemma, meanings, source sentence, mnemonic, collocations, and source URL. Tabs and line breaks are converted to safe HTML breaks so importing does not corrupt columns.

No `.apkg` file is generated because doing so would add a packaging dependency and provide little benefit over Anki's supported tab-separated import.

## Testing strategy

### Unit tests

- tokenize punctuation, contractions, apostrophes, and hyphenated words without changing visible text;
- reject non-English click targets and oversized requests;
- normalize valid AI JSON and reject missing required fields;
- create a new library entry, merge a second inflected form, deduplicate occurrences, and preserve creation time;
- escape commas, quotes, tabs, newlines, HTML, and Markdown-relevant content during export;
- filter across bilingual and source fields;
- assert transcript modes render click targets only around original English content;
- assert message actions and Vocabulary tab controls are wired.

### Regression and release tests

- run the repository's entire Node suite;
- run the release checker so the prompt and new files are packaged and no secret is present;
- build the unpacked release ZIP;
- inspect the final diff against every success criterion.

### Manual acceptance still requiring the learner's API keys

After loading the local folder as an unpacked extension and reloading YouTube:

1. Open an English-captioned standard YouTube video.
2. Click a transcript word and confirm the row does not seek.
3. Confirm the generated bilingual card is accurate and visually memorable.
4. Save it, click an inflected form of the same lemma, and confirm one library item has two occurrences.
5. Export each format and import the TSV into Anki.

Automated work will not use, request, or print the learner's private API keys.

## Non-goals for v1

- in-extension spaced-repetition scheduling or review grading;
- speech synthesis, recorded pronunciation, or AI-generated images;
- cloud sync, login, sharing, or mobile support;
- automatic difficulty detection or automatic saving;
- full dictionary coverage, authoritative etymology, or offline AI generation;
- changes to the upstream project's Supadata caption pipeline.

## Privacy and documentation changes

The README files will explain the click-to-learn flow, local library, exports, and the fact that clicked context is sent to DeepSeek only when requested. `PRIVACY.md` will list vocabulary drafts and saved entries in local storage and explain the bounded request payload. `SECURITY.md` will continue to prohibit committing keys. The manifest requires no new host or runtime permissions.
