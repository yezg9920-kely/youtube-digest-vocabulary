const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

function segments() {
  return [
    { id: "segment-0-0", start: 0, text: "Same source text." },
    { id: "segment-1-12500", start: 12.5, text: "Middle <script>text</script>." },
    { id: "segment-2-30000", start: 30, text: "Same source text." },
  ];
}

function conclusion(ids = segments().map((segment) => segment.id)) {
  return {
    id: "conclusion-1",
    titleZh: "本地可核验结论",
    explanationZh: "这是 AI 的解释，不是原文。",
    evidenceLevel: "strong",
    evidenceSegmentIds: ids,
  };
}

test("evidence view is available in classic-script and CommonJS runtimes", () => {
  const common = require("../overview-core.js");
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("overview-core.js"), sandbox, {
    filename: "overview-core.js",
  });

  assert.equal(typeof common.buildEvidenceView, "function");
  assert.equal(typeof sandbox.YTD_OVERVIEW.buildEvidenceView, "function");
});

test("evidence view uses exact local ID, text, timestamp, and one neighbor each", () => {
  const { buildEvidenceView } = require("../overview-core.js");
  const source = segments();
  const view = buildEvidenceView(source, conclusion(), source[1].id);

  assert.deepEqual(plain(view), {
    sufficient: true,
    reason: "verified",
    segmentId: source[1].id,
    timestampSeconds: 12.5,
    exactText: "Middle <script>text</script>.",
    previous: {
      segmentId: source[0].id,
      timestampSeconds: 0,
      text: "Same source text.",
    },
    next: {
      segmentId: source[2].id,
      timestampSeconds: 30,
      text: "Same source text.",
    },
    conclusionTitleZh: "本地可核验结论",
    explanationZh: "这是 AI 的解释，不是原文。",
    evidenceLevel: "strong",
  });
  assert.notEqual(view.exactText, view.explanationZh);
  assert.equal(Object.isFrozen(view), true);
});

test("same-text segments remain distinct by ID and local start", () => {
  const { buildEvidenceView } = require("../overview-core.js");
  const source = segments();
  const first = buildEvidenceView(source, conclusion(), source[0].id);
  const last = buildEvidenceView(source, conclusion(), source[2].id);

  assert.equal(first.exactText, last.exactText);
  assert.equal(first.segmentId, source[0].id);
  assert.equal(first.timestampSeconds, 0);
  assert.equal(first.previous, null);
  assert.equal(first.next.segmentId, source[1].id);
  assert.equal(last.segmentId, source[2].id);
  assert.equal(last.timestampSeconds, 30);
  assert.equal(last.previous.segmentId, source[1].id);
  assert.equal(last.next, null);
});

test("unknown and non-cited IDs stay explicitly insufficient without fuzzy fallback", () => {
  const { buildEvidenceView } = require("../overview-core.js");
  const source = segments();
  const uncited = buildEvidenceView(
    source,
    conclusion([source[0].id]),
    source[2].id,
  );
  const unknown = buildEvidenceView(source, conclusion(), "invented-segment");

  assert.deepEqual(plain(uncited), {
    sufficient: false,
    reason: "not_cited",
    segmentId: source[2].id,
    timestampSeconds: null,
    exactText: "",
    previous: null,
    next: null,
    conclusionTitleZh: "本地可核验结论",
    explanationZh: "这是 AI 的解释，不是原文。",
    evidenceLevel: "strong",
  });
  assert.equal(unknown.sufficient, false);
  assert.equal(unknown.reason, "segment_missing");
  assert.equal(unknown.exactText, "");
  assert.equal(unknown.timestampSeconds, null);

  const declaredInsufficient = buildEvidenceView(
    source,
    conclusion([source[0].id]),
    source[0].id,
  );
  const insufficientConclusion = {
    ...conclusion([source[0].id]),
    evidenceLevel: "insufficient",
  };
  const insufficient = buildEvidenceView(
    source,
    insufficientConclusion,
    source[0].id,
  );
  assert.equal(declaredInsufficient.sufficient, true);
  assert.equal(insufficient.sufficient, false);
  assert.equal(insufficient.reason, "evidence_insufficient");
});

test("evidence dialog is labelled and only evidence controls are interactive", () => {
  const html = read("sidepanel.html");
  const script = read("sidepanel.js");

  assert.match(html, /<dialog[^>]+id="evidenceDialog"[^>]+aria-modal="true"/);
  assert.match(html, /aria-labelledby="evidenceDialogTitle"/);
  assert.match(html, /aria-describedby="evidenceDialogDescription"/);
  assert.match(html, /id="evidenceExactText"/);
  assert.match(html, /id="evidenceAiExplanation"/);
  assert.match(script, /overview-evidence-btn/);
  assert.doesNotMatch(script, /overview-conclusion-card[^\n]*addEventListener/);
});
