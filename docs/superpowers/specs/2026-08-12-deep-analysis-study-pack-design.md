# Deep Analysis and Study Pack Design

Date: 2026-08-12

## Goal

Turn a useful YouTube transcript into two durable learning artifacts:

1. a cleaned, timestamped transcript that can be downloaded without an AI call;
2. a Chinese deep-analysis report that explains the content, reconstructs its argument, tests its weaknesses, and supports later review.

The complete report and cleaned transcript can also be exported together as one Markdown study pack.

## Scope

This iteration supports YouTube videos and podcasts that already flow through the extension's transcript pipeline. It does not automatically scrape arbitrary blog pages or request broad webpage-reading permissions. A future manual text-import entry can reuse the report schema and exporters without changing this release's privacy boundary.

## Existing Capability and Gap

The extension already has:

- a plain-text transcript export;
- an Overview request that returns chapters and key quotes;
- local per-video caching.

The gap is that the transcript is not organized into readable timestamped paragraphs, the Overview is too shallow for study, and there is no complete downloadable learning report.

## Product Design

### Transcript downloads

The Transcript tab keeps Copy and raw TXT export, and adds a **Clean MD** export. Clean Markdown:

- includes title, channel, source URL, and description;
- groups fragmented captions into semantic paragraphs with timestamps;
- links each timestamp back to the matching video position;
- preserves the speaker's words rather than asking AI to rewrite them.

### Deep-analysis report

Opening Overview lazily requests one structured analysis. The report contains:

- one-sentence takeaway;
- executive summary;
- core thesis and why the content matters;
- full-timeline chapter map;
- key insights tied to transcript evidence and timestamps;
- argument map with claim, support, and caveat;
- strengths, limitations, hidden assumptions, and open questions;
- actionable takeaways;
- active-recall questions with answers;
- original key quotes with timestamps.

Analysis prose is Simplified Chinese while exact source quotes remain in the source language. Technical terms may retain their English form where useful.

### Report exports

Overview provides two local downloads after analysis succeeds:

- **Report MD**: the structured analysis only;
- **Study Pack**: metadata, full analysis, and cleaned timestamped transcript in one Markdown file.

Export buttons remain disabled until a version-2 deep analysis is available. An older cached Overview is upgraded when the user next opens Overview.

## Data Model

The normalized analysis object uses `schemaVersion: 2` and retains the existing `chapters`, `keyQuotes`, and `keyMoments` fields. New fields are:

```text
summary: {
  oneSentenceZh,
  executiveSummaryZh,
  coreThesisZh,
  whyItMattersZh
}
keyInsights: [{ titleZh, explanationZh, evidenceZh, timestampSeconds, timestamp }]
argumentMap: [{ claimZh, supportZh, caveatZh }]
criticalThinking: {
  strengthsZh[],
  limitationsZh[],
  assumptionsZh[],
  openQuestionsZh[]
}
actionItemsZh[]
reviewQuestions: [{ questionZh, answerZh }]
```

Every model-supplied string and array is length-bounded. Timestamps are rebuilt from validated numeric seconds. Missing optional sections become empty values instead of reaching the DOM unchecked.

## Data Flow

```text
Supadata transcript
  -> existing local transcript cache
  -> semantic paragraph organizer
  -> Clean Markdown export

timestamped transcript + video metadata
  -> DeepSeek JSON request
  -> strict schema normalization
  -> Overview rendering + local cache
  -> Report Markdown / complete Study Pack
```

## Error and Compatibility Behavior

- Transcript exports remain available without an AI key.
- Overview explains missing/invalid/rate-limited AI configuration through the existing error path.
- Export controls do not download incomplete placeholder reports.
- A malformed model section is dropped independently; it cannot inject HTML.
- Old cached chapter-only objects render safely and are regenerated on Overview activation.
- Empty transcript state prevents downloads and shows status feedback.

## Privacy and Permissions

No new Chrome permissions or host permissions are required. Clean transcript and Markdown exports are generated locally. Deep analysis sends the existing timestamped transcript and bounded video metadata to the configured DeepSeek endpoint only after the learner opens Overview or requests analysis.

## Success Criteria

1. Raw TXT transcript export still works.
2. Clean Markdown contains metadata, semantic paragraphs, timestamps, and video links.
3. Deep analysis renders every requested section without using untrusted HTML.
4. Version-1 cached analyses are automatically upgraded on Overview activation.
5. Report-only and full Study Pack Markdown exports are deterministic and readable.
6. Analysis normalization rejects invalid timestamps and bounds every field.
7. No new browser permission is introduced.
8. Focused tests, full tests, release checks, independent review, and ZIP inspection pass.

## Non-goals

- Automatic arbitrary-blog scraping.
- Cloud sync or server-side storage.
- PDF/DOCX generation.
- AI rewriting that silently changes the original transcript.
- A second analysis API call for each export.

## Self-review

- No placeholders remain.
- The UI, prompt, normalized schema, cache version, and export structure use the same field names.
- Old-cache behavior and missing-key behavior are explicit.
- The feature stays inside the current YouTube permission boundary.
