const test = require("node:test");
const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");

const core = require("../transcript-core.js");

const sampleEntries = () => [
  { start: 0, duration: 5, text: "First complete thought." },
  { start: 5, duration: 5, text: "第二个完整想法。" },
];
const sampleSegments = () =>
  core.groupTranscriptEntries(sampleEntries(), {
    minChars: 1,
    idealChars: 100,
    maxChars: 320,
    maxSeconds: 20,
  });

test("classic transcript core exposes the complete deterministic surface", () => {
  for (const name of [
    "normalizeCaptionText",
    "resolveTranscriptLanguage",
    "splitOversizedThought",
    "groupTranscriptEntries",
    "assertSecureFingerprintAvailable",
    "fingerprintSegments",
    "formatTimestamp",
    "buildOverviewTranscriptInput",
  ]) {
    assert.equal(typeof core[name], "function", name);
  }
});

test("canonical transcript language prefers top-level metadata then chunk evidence", () => {
  assert.equal(
    core.resolveTranscriptLanguage(" fr ", [{ language: "en" }]),
    "fr",
  );
  assert.equal(
    core.resolveTranscriptLanguage("", [
      { language: "" },
      { language: " en " },
      { language: "fr" },
    ]),
    "en",
  );
  assert.equal(core.resolveTranscriptLanguage(null, [{ text: "No language" }]), null);
});

test("semantic grouping is deterministic and rebuilds old cached IDs", () => {
  const limits = { minChars: 1, idealChars: 100, maxChars: 320, maxSeconds: 20 };
  const first = core.groupTranscriptEntries(sampleEntries(), limits);
  const second = core.groupTranscriptEntries(structuredClone(sampleEntries()), limits);
  const oldCache = sampleEntries().map((entry, index) => ({
    ...entry,
    ...(index ? { id: "stale-cache-id" } : {}),
  }));

  assert.deepEqual(first, second);
  assert.deepEqual(core.groupTranscriptEntries(oldCache, limits), first);
  assert.equal(first[0].id, "segment-0-0");
  assert.equal(first[1].id, "segment-1-5000");
  assert.deepEqual(first[0].texts, [first[0].text]);
});

test("semantic grouping preserves caption, Chinese, gap, and size guardrails", () => {
  const rebuilt = core.groupTranscriptEntries(
    [
      { start: 0, text: "Caption boundaries should" },
      { start: 2, text: "not break a complete sentence." },
      { start: 5, text: "这是一个被字幕切开的" },
      { start: 7, text: "完整句子。" },
      { start: 180, text: "A much later unfinished thought" },
    ],
    { minChars: 1, idealChars: 100, maxChars: 320, maxSeconds: 20 },
  );
  assert.equal(
    rebuilt[0].text,
    "Caption boundaries should not break a complete sentence.",
  );
  assert.equal(rebuilt[1].text, "这是一个被字幕切开的完整句子。");
  assert.equal(rebuilt.at(-1).start, 180);

  const huge = Array.from({ length: 900 }, (_, index) => `word${index}`).join(" ");
  const bounded = core.groupTranscriptEntries([
    { start: 12, duration: 90, text: huge },
  ]);
  assert.ok(bounded.length > 8);
  assert.ok(bounded.every((segment) => segment.text.length <= 384));
  assert.ok(bounded.at(-1).start > bounded[0].start);
});

test("oversized emoji captions preserve every Unicode scalar across hard splits", () => {
  const source = `a${"😀".repeat(200)}`;
  const grouped = core.groupTranscriptEntries([{ start: 0, text: source }]);
  const hasLoneSurrogate = (text) => {
    for (let index = 0; index < text.length; index += 1) {
      const unit = text.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = text.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
        index += 1;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        return true;
      }
    }
    return false;
  };

  assert.equal(grouped.map((segment) => segment.text).join(""), source);
  assert.ok(grouped.every((segment) => !hasLoneSurrogate(segment.text)));
});

test("SHA-256 fingerprint is versioned and stable over canonical UTF-8", async () => {
  const segments = sampleSegments();
  const first = await core.fingerprintSegments(segments, {
    sourceLanguage: "en",
    crypto: webcrypto,
  });
  const second = await core.fingerprintSegments(structuredClone(segments), {
    sourceLanguage: "en",
    crypto: webcrypto,
  });

  assert.equal(first, second);
  assert.equal(
    first,
    "sha256-v1-0d90abb89bb6735f6f6225144ef4e851de3372c91ae047ca96fe34c38322be6f",
  );
});

test("fingerprint changes with language, ID, start, text, or segment order", async () => {
  const segments = sampleSegments();
  const fingerprint = (value, sourceLanguage = "en") =>
    core.fingerprintSegments(value, { sourceLanguage, crypto: webcrypto });
  const baseline = await fingerprint(segments);
  const changedId = structuredClone(segments);
  changedId[0].id = "segment-99-0";
  const changedStart = structuredClone(segments);
  changedStart[0].start = 0.25;
  const changedText = structuredClone(segments);
  changedText[0].text = "A changed complete thought.";

  for (const changed of [
    await fingerprint(segments, "zh"),
    await fingerprint(changedId),
    await fingerprint(changedStart),
    await fingerprint(changedText),
    await fingerprint([...segments].reverse()),
  ]) {
    assert.notEqual(changed, baseline);
  }
});

test("SHA-256 fingerprint locks canonical UTF-8 emoji bytes", async () => {
  const fingerprint = await core.fingerprintSegments(
    [{ id: "emoji", start: 1.25, text: `a${"😀".repeat(200)}` }],
    { sourceLanguage: "en", crypto: webcrypto },
  );
  assert.equal(
    fingerprint,
    "sha256-v1-fc2533ccc5276a679b688ae2b59b60ddaa4efbad6deea75af4f52622a377e6f9",
  );
});

test("fingerprinting fails explicitly when secure local crypto is unavailable", async () => {
  assert.equal(
    core.assertSecureFingerprintAvailable({ crypto: webcrypto }),
    true,
  );
  assert.throws(
    () => core.assertSecureFingerprintAvailable({ crypto: null }),
    (error) => {
      assert.equal(error.code, "TRANSCRIPT_FINGERPRINT_UNAVAILABLE");
      assert.equal(error.scope, "local");
      return true;
    },
  );
  await assert.rejects(
    core.fingerprintSegments(core.groupTranscriptEntries(sampleEntries()), {
      sourceLanguage: "en",
      crypto: null,
    }),
    (error) => {
      assert.equal(error.name, "TranscriptFingerprintError");
      assert.equal(error.code, "TRANSCRIPT_FINGERPRINT_UNAVAILABLE");
      assert.equal(error.scope, "local");
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test("overview transcript input preserves canonical source text without executing markup", () => {
  const segments = [
    {
      id: "segment-0-0",
      start: 0,
      text: '<img src=x onerror="boom"> First <i>thought</i>.',
    },
    { id: "segment-1-3661000", start: 3661, text: "Second thought." },
  ];
  const input = core.buildOverviewTranscriptInput(segments);

  assert.equal(core.formatTimestamp(0), "0:00");
  assert.equal(core.formatTimestamp(65), "1:05");
  assert.equal(core.formatTimestamp(3661), "61:01");
  assert.equal(
    input,
    '[segment-0-0] [0:00] <img src=x onerror="boom"> First <i>thought</i>.\n' +
      "[segment-1-3661000] [61:01] Second thought.",
  );
  assert.match(input, /<img src=x onerror="boom">/);
  assert.match(input, /<i>thought<\/i>/);
});

test("overview input accepts exactly 320000 characters and rejects one more", () => {
  const prefix = "[segment-0-0] [0:00] ";
  const exact = [{ id: "segment-0-0", start: 0, text: "x".repeat(320_000 - prefix.length) }];
  assert.equal(core.buildOverviewTranscriptInput(exact).length, 320_000);

  const tooLarge = [{ id: "segment-0-0", start: 0, text: "x".repeat(320_001 - prefix.length) }];
  assert.throws(
    () => core.buildOverviewTranscriptInput(tooLarge),
    (error) => {
      assert.equal(error.name, "RangeError");
      assert.equal(error.code, "OVERVIEW_TRANSCRIPT_TOO_LARGE");
      assert.equal(error.limit, 320_000);
      return true;
    },
  );
  assert.equal(core.buildOverviewTranscriptInput([]), "");
});
