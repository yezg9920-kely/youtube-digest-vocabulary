const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

const segments = [
  { id: "segment-0-0", start: 0, text: "First source sentence." },
  { id: "segment-1-12500", start: 12.5, text: "Second source sentence." },
];

test("transcript mode snapshots are exposed in classic and CommonJS runtimes", () => {
  const common = require("../transcript-core.js");
  const sandbox = { TextEncoder };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("transcript-core.js"), sandbox, {
    filename: "transcript-core.js",
  });

  assert.equal(typeof common.buildTranscriptModeSnapshot, "function");
  assert.equal(
    typeof sandbox.YTD_TRANSCRIPT_CORE.buildTranscriptModeSnapshot,
    "function",
  );
});

test("Original, Chinese, and bilingual snapshots preserve aligned source order", () => {
  const { buildTranscriptModeSnapshot } = require("../transcript-core.js");
  const translations = new Map([
    [segments[0].id, "第一句。"],
    [segments[1].id, "第二句。"],
  ]);
  const original = buildTranscriptModeSnapshot({
    segments,
    mode: "original",
    translationLookup: translations,
  });
  const chinese = buildTranscriptModeSnapshot({
    segments,
    mode: "zh",
    translationLookup: translations,
  });
  const bilingual = buildTranscriptModeSnapshot({
    segments,
    mode: "bilingual",
    translationLookup: translations,
  });

  assert.deepEqual(plain(original), {
    mode: "original",
    label: "Original",
    complete: true,
    missingSegmentIds: [],
    rows: [
      {
        id: segments[0].id,
        start: 0,
        sourceText: segments[0].text,
        translatedText: "",
      },
      {
        id: segments[1].id,
        start: 12.5,
        sourceText: segments[1].text,
        translatedText: "",
      },
    ],
    plainText: "First source sentence.\n\nSecond source sentence.",
  });
  assert.equal(chinese.label, "简体中文");
  assert.equal(chinese.complete, true);
  assert.equal(chinese.plainText, "第一句。\n\n第二句。");
  assert.equal(bilingual.label, "Original + 简体中文");
  assert.equal(
    bilingual.plainText,
    "First source sentence.\n第一句。\n\nSecond source sentence.\n第二句。",
  );
  assert.equal(Object.isFrozen(bilingual), true);
  assert.equal(Object.isFrozen(bilingual.rows[0]), true);
});

test("translated snapshots expose every missing stable ID and never fall back", () => {
  const { buildTranscriptModeSnapshot } = require("../transcript-core.js");
  const snapshot = buildTranscriptModeSnapshot({
    segments,
    mode: "zh",
    translationLookup: new Map([[segments[0].id, "第一句。"]]),
  });

  assert.equal(snapshot.complete, false);
  assert.deepEqual(plain(snapshot.missingSegmentIds), [segments[1].id]);
  assert.equal(snapshot.rows[1].translatedText, "");
  assert.equal(snapshot.plainText, "");
  assert.equal(snapshot.plainText.includes(segments[1].text), false);
});

test("empty snapshots are incomplete in every mode and expose no export text", () => {
  const { buildTranscriptModeSnapshot } = require("../transcript-core.js");
  for (const mode of ["original", "zh", "bilingual"]) {
    const snapshot = buildTranscriptModeSnapshot({ segments: [], mode });
    assert.equal(snapshot.complete, false);
    assert.equal(snapshot.plainText, "");
    assert.deepEqual(plain(snapshot.rows), []);
  }
});

test("panel export paths capture one current-mode snapshot and use explicit translation labels", () => {
  const source = read("sidepanel.js");
  const html = read("sidepanel.html");

  assert.match(source, /function captureTranscriptModeSnapshot/);
  assert.match(source, /async function prepareTranscriptModeExport/);
  assert.match(source, /updateTranscriptExportControls/);
  assert.match(source, /transcriptParagraphCache\.get\(key\)/);
  assert.match(source, /翻译并复制中文/);
  assert.match(source, /翻译并导出 TXT/);
  assert.match(source, /翻译并导出 Clean MD/);
  assert.match(html, /id="copyTranscriptBtn"[^>]*aria-label=/);
  assert.match(html, /id="exportTranscriptBtn"[^>]*aria-label=/);
  assert.match(html, /id="exportCleanTranscriptBtn"[^>]*aria-label=/);
});
