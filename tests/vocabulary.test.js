const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const providers = require("../providers.js");
const persistence = require("../persistence.js");

function loadSidepanelHelpers() {
  const listeners = { addListener() {} };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval() {},
    clearInterval() {},
    IntersectionObserver: class {},
    CSS: { escape: (value) => value },
    window: { getSelection: () => null, close() {} },
    document: {
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
      createElement: () => {
        let value = "";
        return {
          set textContent(text) {
            value = String(text);
          },
          get innerHTML() {
            return value
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;")
              .replaceAll('"', "&quot;");
          },
        };
      },
    },
    chrome: {
      runtime: { onMessage: listeners, sendMessage: async () => ({}) },
      windows: { getCurrent: async () => ({ id: 1 }) },
      tabs: { onUpdated: listeners, onActivated: listeners },
    },
    YTD_SETTINGS: {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("transcript-core.js"), sandbox);
  vm.runInNewContext(read("sidepanel.js"), sandbox);
  return sandbox.__YTD_TRANSCRIPT_TESTING__;
}

function loadBackgroundHelpers(options = {}) {
  const listeners = { addListener() {} };
  const runtimeMessageListeners = [];
  const clone = (value) => structuredClone(value);
  const storageState = {
    ytd_settings: {
      provider: "deepseek",
      aiApiKey: "test-key",
      aiBaseUrl: "https://api.deepseek.com",
      aiModel: "deepseek-v4-flash",
    },
  };
  if (options.initialVocabulary) {
    storageState.ytd_vocabulary = clone(options.initialVocabulary);
  }
  const storageOperations = [];
  let activeWrites = 0;
  let maxConcurrentWrites = 0;
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    fetch,
    AbortController,
    setTimeout: () => 0,
    clearTimeout() {},
    importScripts() {},
    chrome: {
      storage: {
        local: {
          setAccessLevel: async () => {},
          get: async (key) => {
            storageOperations.push(`get:${String(key)}`);
            const snapshot = clone(storageState);
            await Promise.resolve();
            if (typeof key === "string") {
              return Object.hasOwn(snapshot, key)
                ? { [key]: snapshot[key] }
                : {};
            }
            return snapshot;
          },
          set: async (value) => {
            storageOperations.push("set:start");
            activeWrites += 1;
            maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites);
            await Promise.resolve();
            Object.assign(storageState, clone(value));
            activeWrites -= 1;
            storageOperations.push("set:end");
          },
          remove: async (keys) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              delete storageState[key];
            }
          },
        },
      },
      action: { onClicked: listeners },
      sidePanel: {
        setPanelBehavior() {},
        setOptions: async () => {},
      },
      runtime: {
        onInstalled: listeners,
        onMessage: {
          addListener(listener) {
            runtimeMessageListeners.push(listener);
          },
        },
        openOptionsPage() {},
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
        sendMessage: async () => {},
      },
      tabs: { onUpdated: listeners, onActivated: listeners },
    },
    YTD_SETTINGS: {
      STORAGE_KEY: "ytd_settings",
      normalize: (value) => value,
      canonicalYouTubeUrl: (videoId) =>
        `https://www.youtube.com/watch?v=${videoId}`,
      chatCompletionsUrl: () =>
        "https://api.deepseek.com/chat/completions",
    },
    YTD_PROVIDERS: providers,
    YTD_PERSISTENCE: persistence,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("transcript-core.js"), sandbox, {
    filename: "transcript-core.js",
  });
  vm.runInNewContext(read("overview-core.js"), sandbox, {
    filename: "overview-core.js",
  });
  vm.runInNewContext(read("background.js"), sandbox);
  const helpers = sandbox.__YTD_VOCABULARY_TESTING__;
  helpers.__getStorageState = () => clone(storageState);
  helpers.__getStorageOperations = () => [...storageOperations];
  helpers.__getMaxConcurrentWrites = () => maxConcurrentWrites;
  helpers.__sendMessage = (message) =>
    new Promise((resolve, reject) => {
      const listener = runtimeMessageListeners[0];
      if (!listener) {
        reject(new Error("Background message listener was not registered"));
        return;
      }
      const keptOpen = listener(message, {}, resolve);
      if (keptOpen !== true) {
        reject(new Error(`Message was not handled: ${message.action}`));
      }
    });
  return helpers;
}

function validRequest(overrides = {}) {
  return {
    word: "Running",
    sentence: "We are running a careful experiment.",
    context: "The team prepared the lab. We are running a careful experiment.",
    videoId: "abc123",
    videoTitle: "A Lab Experiment",
    channelName: "Science Class",
    timestampSeconds: 42.8,
    ...overrides,
  };
}

function completeLearningPlan(overrides = {}) {
  return {
    contextAnchor: {
      explanationZh: "原句中的 running 强调团队正在把实验真正做起来。",
      collocationUseZh: "把 run an experiment 当作整体记：开展一项实验。",
    },
    morphology: {
      available: true,
      breakdown: "running = run + -ing（双写 n）",
      explanationZh: "-ing 表示正在进行；双写 n 后再加 -ing。",
    },
    soundBridge: {
      cueZh: "记忆提示：想成“让实验室一直 run（跑）起来”。",
      safeguardZh: "这是辅助联想，不是 IPA、词源或标准发音说明。",
    },
    visualScene: {
      hookZh: "跑步者启动实验机器",
      sceneEn: "A runner powers a huge lab machine with every stride.",
      sceneZh: "想象跑步者每迈一步，就把巨大的实验机器踩得轰隆运转。",
      recallPathZh: "跑步者 → 机器运转 → run an experiment = 开展实验。",
    },
    contrast: {
      relatedWordEn: "conduct",
      distinctionZh: "run 更口语、强调实际执行；conduct 更正式，常用于研究或调查。",
      miniContrastEn: "The team ran a test, while the university conducted a formal study.",
    },
    retrieval: {
      clozePrompt: "We are _____ a careful experiment.",
      meaningToWordPrompt: "“开展一项实验”在这里用哪个英语动词？",
      productionPrompt: "Use run to say that a team is conducting a test.",
      selfExplainPrompt: "Explain why run means conduct here, not move quickly.",
    },
    generation: {
      exampleEn: "The researchers ran three tests yesterday.",
      exampleZh: "研究人员昨天进行了三项测试。",
    },
    migrationNoteZh: "",
    ...overrides,
  };
}

function completeModelCard(overrides = {}) {
  return {
    lemma: "run",
    ipa: "/rʌn/",
    partOfSpeech: "verb",
    definitionEn: "to operate or carry out something",
    meaningZh: "运行；执行",
    contextualMeaningEn: "Here, running means carrying out an experiment.",
    contextualMeaningZh: "这里指正在进行一项实验。",
    collocations: ["run an experiment", "run a test"],
    learningPlan: completeLearningPlan(),
    ...overrides,
  };
}

function libraryEntry(overrides = {}) {
  return {
    id: "vocab_run",
    lemma: "run",
    forms: ["ran", "running"],
    ipa: "/rʌn/",
    partOfSpeech: "verb",
    definitionEn: "to operate or carry out something",
    meaningZh: "运行；执行",
    contextualMeaningEn: "carry out an experiment",
    contextualMeaningZh: "进行一项实验",
    morphology: "run + -ing",
    collocations: ["run a test"],
    mnemonic: {
      hook: "runner powers a machine",
      sceneEn: "A runner powers a lab machine.",
      sceneZh: "跑步者驱动实验机器。",
      recallPath: "runner -> operating -> run",
    },
    exampleEn: "They ran a test.",
    clozePrompt: "They _____ a test.",
    productionPrompt: "Use run to describe a test.",
    occurrences: [
      {
        form: "running",
        sentence: "We are running a careful experiment.",
        videoId: "abc123",
        videoTitle: "Lab lesson",
        channelName: "Science Class",
        timestampSeconds: 42,
        timestamp: "0:42",
        url: "https://www.youtube.com/watch?v=abc123&t=42s",
      },
    ],
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

test("tokenizeVocabularyText preserves visible text and recognizes compounds", () => {
  const { tokenizeVocabularyText } = loadSidepanelHelpers();
  const source = "Don't re-run version 2.0 — naïve.";
  const tokens = tokenizeVocabularyText(source);

  assert.equal(tokens.map((token) => token.text).join(""), source);
  assert.deepEqual(
    Array.from(
      tokens
        .filter((token) => token.type === "word")
        .map((token) => token.text),
    ),
    ["Don't", "re-run", "version", "naïve"],
  );
});

test("renderVocabularyText escapes source text and emits accessible word buttons", () => {
  const { renderVocabularyText } = loadSidepanelHelpers();
  const html = renderVocabularyText('<script>run & "jump"</script>');

  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;/);
  assert.match(html, /class="vocab-word"/);
  assert.match(html, /data-word="run"/);
  assert.match(html, /aria-label="Learn word: run"/);
});

test("renderVocabularyText preserves only allowlisted subtitle formatting", () => {
  const { renderVocabularyText } = loadSidepanelHelpers();
  const html = renderVocabularyText("<i>run fast</i> <img src=x onerror=alert(1)>");

  assert.match(html, /^<i><button/);
  assert.match(html, /<\/i>/);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /data-word="(?:img|src|onerror|alert)"/);
  assert.match(html, /&lt;/);
});

test("validateVocabularyRequest bounds and normalizes transcript context", () => {
  const { validateVocabularyRequest } = loadBackgroundHelpers();
  const result = validateVocabularyRequest(
    validRequest({ context: "x".repeat(2000) }),
  );

  assert.equal(result.word, "Running");
  assert.equal(result.timestampSeconds, 42);
  assert.ok(result.context.length <= 1200);
  assert.equal(
    result.url,
    "https://www.youtube.com/watch?v=abc123&t=42s",
  );
});

test("validateVocabularyRequest rejects non-word click targets", () => {
  const { validateVocabularyRequest } = loadBackgroundHelpers();
  assert.throws(
    () => validateVocabularyRequest(validRequest({ word: "42..." })),
    /English word/i,
  );
});

test("normalizeVocabularyCard accepts a complete bilingual JSON card", () => {
  const { validateVocabularyRequest, normalizeVocabularyCard } =
    loadBackgroundHelpers();
  const request = validateVocabularyRequest(validRequest());
  const card = normalizeVocabularyCard(completeModelCard(), request, 1000);

  assert.equal(card.lemma, "run");
  assert.equal(card.meaningZh, "运行；执行");
  assert.equal(card.mnemonic.sceneEn.length > 0, true);
  assert.equal(card.occurrences[0].form, "running");
  assert.equal(card.occurrences[0].timestamp, "0:42");
  assert.equal(card.createdAt, 1000);
});

test("normalizeVocabularyCard requires the complete evidence-informed learning plan", () => {
  const { validateVocabularyRequest, normalizeVocabularyCard } =
    loadBackgroundHelpers();
  const card = normalizeVocabularyCard(
    completeModelCard(),
    validateVocabularyRequest(validRequest()),
    1000,
  );

  assert.equal(card.learningPlan.contextAnchor.explanationZh.length > 0, true);
  assert.equal(card.learningPlan.morphology.available, true);
  assert.equal(card.learningPlan.retrieval.meaningToWordPrompt.length > 0, true);
  assert.equal(card.learningPlan.generation.exampleZh.length > 0, true);
});

test("normalizeVocabularyCard rejects an incomplete evidence-informed learning plan", () => {
  const { validateVocabularyRequest, normalizeVocabularyCard } =
    loadBackgroundHelpers();

  assert.throws(
    () =>
      normalizeVocabularyCard(
        completeModelCard({
          learningPlan: completeLearningPlan({
            retrieval: { clozePrompt: "We are ____ an experiment." },
          }),
        }),
        validateVocabularyRequest(validRequest()),
      ),
    /meaningToWordPrompt/,
  );
});

test("normalizeVocabularyCard reserves migration notes for legacy cards", () => {
  const { validateVocabularyRequest, normalizeVocabularyCard } =
    loadBackgroundHelpers();
  const card = normalizeVocabularyCard(
    completeModelCard({
      learningPlan: completeLearningPlan({ migrationNoteZh: "假装这是旧版卡片。" }),
    }),
    validateVocabularyRequest(validRequest()),
  );

  assert.equal(card.learningPlan.migrationNoteZh, "");
});

test("normalizeVocabularyCard rejects missing learning fields", () => {
  const { validateVocabularyRequest, normalizeVocabularyCard } =
    loadBackgroundHelpers();
  const request = validateVocabularyRequest(validRequest());

  assert.throws(
    () =>
      normalizeVocabularyCard(
        { ...completeModelCard(), definitionEn: "" },
        request,
      ),
    /definitionEn/,
  );
});

test("vocabulary prompt requires retrieval, contrast, generation, and safeguards", () => {
  const prompt = read("prompts/vocabulary.md");

  assert.match(prompt, /meaningToWordPrompt/);
  assert.match(prompt, /selfExplainPrompt/);
  assert.match(prompt, /relatedWordEn/);
  assert.match(prompt, /Do not force a sound cue/i);
  assert.match(prompt, /not.*etymology/i);
});

test("mergeVocabularyEntry combines inflected forms and source occurrences", () => {
  const {
    validateVocabularyRequest,
    normalizeVocabularyCard,
    mergeVocabularyEntry,
  } = loadBackgroundHelpers();
  const first = normalizeVocabularyCard(
    completeModelCard(),
    validateVocabularyRequest(validRequest()),
    1000,
  );
  const second = normalizeVocabularyCard(
    completeModelCard({
      learningPlan: completeLearningPlan({
        generation: {
          exampleEn: "She ran the simulation twice.",
          exampleZh: "她运行了两次模拟。",
        },
      }),
    }),
    validateVocabularyRequest(
      validRequest({
        word: "ran",
        sentence: "She ran the simulation twice.",
        timestampSeconds: 88,
      }),
    ),
    1500,
  );

  const merged = mergeVocabularyEntry(first, second, 2000);

  assert.deepEqual(Array.from(merged.forms), ["ran", "running"]);
  assert.equal(merged.occurrences.length, 2);
  assert.equal(merged.createdAt, 1000);
  assert.equal(merged.updatedAt, 2000);
  assert.equal(merged.exampleEn, "She ran the simulation twice.");
});

test("mergeVocabularyEntry does not duplicate the same occurrence", () => {
  const {
    validateVocabularyRequest,
    normalizeVocabularyCard,
    mergeVocabularyEntry,
  } = loadBackgroundHelpers();
  const card = normalizeVocabularyCard(
    completeModelCard(),
    validateVocabularyRequest(validRequest()),
    1000,
  );

  const merged = mergeVocabularyEntry(card, card, 2000);

  assert.equal(merged.occurrences.length, 1);
  assert.equal(merged.createdAt, 1000);
});

test("normalizeVocabularyLibrary drops malformed entries and keeps the schema", () => {
  const {
    validateVocabularyRequest,
    normalizeVocabularyCard,
    normalizeVocabularyLibrary,
  } = loadBackgroundHelpers();
  const card = normalizeVocabularyCard(
    completeModelCard(),
    validateVocabularyRequest(validRequest()),
    1000,
  );

  const library = normalizeVocabularyLibrary({
    schemaVersion: 99,
    entries: [card, { lemma: "broken" }],
  });

  assert.equal(library.schemaVersion, 2);
  assert.equal(library.entries.length, 1);
  assert.equal(library.entries[0].lemma, "run");
});

test("normalizeVocabularyLibrary migrates a v1 entry into a safe v2 learning plan", () => {
  const { normalizeVocabularyLibrary } = loadBackgroundHelpers();
  const library = normalizeVocabularyLibrary({
    schemaVersion: 1,
    entries: [libraryEntry()],
  });

  assert.equal(library.schemaVersion, 2);
  assert.match(library.entries[0].learningPlan.migrationNoteZh, /旧版/);
  assert.match(library.entries[0].learningPlan.soundBridge.cueZh, /未生成/);
});

test("message-level concurrent saves retain every vocabulary entry", async () => {
  const helpers = loadBackgroundHelpers();
  const walk = libraryEntry({
    id: "vocab_walk",
    lemma: "walk",
    forms: ["walking"],
    meaningZh: "走路",
  });
  const learn = libraryEntry({
    id: "vocab_learn",
    lemma: "learn",
    forms: ["learning"],
    meaningZh: "学习",
  });

  const results = await Promise.all([
    helpers.__sendMessage({ action: "saveVocabularyCard", card: walk }),
    helpers.__sendMessage({ action: "saveVocabularyCard", card: learn }),
  ]);
  const stored = helpers.__getStorageState().ytd_vocabulary;

  assert.equal(results.every((result) => result.success), true);
  assert.deepEqual(
    stored.entries.map((entry) => entry.lemma).sort(),
    ["learn", "walk"],
  );
  assert.equal(helpers.__getMaxConcurrentWrites(), 1);
});

test("message-level concurrent same-lemma saves retain both occurrences", async () => {
  const helpers = loadBackgroundHelpers();
  const first = libraryEntry();
  const second = libraryEntry({
    forms: ["ran"],
    occurrences: [
      {
        ...libraryEntry().occurrences[0],
        form: "ran",
        sentence: "They ran the test twice.",
        timestampSeconds: 84,
        timestamp: "1:24",
        url: "https://www.youtube.com/watch?v=abc123&t=84s",
      },
    ],
    updatedAt: 3000,
  });

  await Promise.all([
    helpers.__sendMessage({ action: "saveVocabularyCard", card: first }),
    helpers.__sendMessage({ action: "saveVocabularyCard", card: second }),
  ]);
  const [stored] = helpers.__getStorageState().ytd_vocabulary.entries;

  assert.equal(stored.lemma, "run");
  assert.deepEqual(Array.from(stored.forms), ["ran", "running"]);
  assert.equal(stored.occurrences.length, 2);
});

test("message-level save and delete overlap executes in request order", async () => {
  const initial = { schemaVersion: 1, entries: [libraryEntry()] };
  const helpers = loadBackgroundHelpers({ initialVocabulary: initial });
  const updated = libraryEntry({ exampleEn: "They ran another test." });

  await Promise.all([
    helpers.__sendMessage({ action: "saveVocabularyCard", card: updated }),
    helpers.__sendMessage({
      action: "deleteVocabularyCard",
      cardId: "vocab_run",
    }),
  ]);

  assert.equal(helpers.__getStorageState().ytd_vocabulary.entries.length, 0);
  assert.deepEqual(helpers.__getStorageOperations(), [
    "get:null",
    "get:ytd_reset_epoch",
    "get:ytd_reset_epoch",
    "get:ytd_reset_epoch",
    "get:ytd_vocabulary",
    "set:start",
    "set:end",
    "get:ytd_reset_epoch",
    "get:ytd_vocabulary",
    "set:start",
    "set:end",
  ]);
});

test("original and bilingual transcript paths make source words learnable", () => {
  const source = read("sidepanel.js");

  assert.match(source, /renderVocabularyText\(group\.text\)/);
  assert.match(
    source,
    /const original = renderVocabularyText\(segment\.text\)/,
  );
  assert.match(
    source,
    /const translationHtml = translated\s+\? renderSubtitleInlineMarkup\(translated\)/,
  );
});

test("delegated vocabulary clicks stop transcript seeking before opening a card", () => {
  const source = read("sidepanel.js");

  assert.match(
    source,
    /function handleVocabularyWordClick\(event\)[\s\S]*?closest\("\.vocab-word"\)[\s\S]*?event\.preventDefault\(\);[\s\S]*?event\.stopPropagation\(\);[\s\S]*?showVocabularyCard/,
  );
  assert.match(
    source,
    /getElementById\("transcriptList"\)[\s\S]*?addEventListener\("click", handleVocabularyWordClick\)/,
  );
});

test("text selection wins over click-to-learn", () => {
  const source = read("sidepanel.js");
  assert.match(
    source,
    /function handleVocabularyWordClick\(event\)[\s\S]*?if \(hasNonCollapsedTextSelection\(\)\) return;[\s\S]*?showVocabularyCard/,
  );
});

test("vocabulary modal traps focus, closes on Escape, and restores its trigger", () => {
  const source = read("sidepanel.js");

  assert.match(source, /function closeVocabularyModal[\s\S]*?\.focus\(\)/);
  assert.match(
    source,
    /function handleVocabularyModalKeydown[\s\S]*?event\.key === "Escape"[\s\S]*?event\.key !== "Tab"/,
  );
  assert.match(
    source,
    /function showVocabularyCard[\s\S]*?addEventListener\("keydown",[\s\S]*?\.focus\(\)/,
  );
});

test("vocabulary card timestamp and target highlighting are safe", () => {
  const {
    formatVocabularyDisplayTimestamp,
    renderHighlightedVocabularySentence,
  } = loadSidepanelHelpers();

  assert.equal(formatVocabularyDisplayTimestamp(65), "1:05");
  assert.equal(
    renderHighlightedVocabularySentence(
      "We are running <script>fast</script>.",
      "running",
    ),
    "We are <mark>running</mark> &lt;script&gt;fast&lt;/script&gt;.",
  );
});

test("local vocabulary initializes before API configuration is checked", () => {
  const source = read("sidepanel.js");
  const initialization = source.match(
    /document\.addEventListener\("DOMContentLoaded", async \(\) => \{([\s\S]*?)\n\}\);/,
  )?.[1] || "";

  assert.ok(initialization.indexOf("await loadVocabulary()") >= 0);
  assert.ok(
    initialization.indexOf("await loadVocabulary()") <
      initialization.indexOf('action: "checkConfig"'),
  );
  assert.match(
    initialization,
    /showVocabularyWithoutConfig\(currentConfigStatus\);[\s\S]*?return;/,
  );
  assert.match(initialization, /setFeatureAvailability\(currentConfigStatus\)/);
  assert.match(initialization, /if \(!currentConfigStatus\.hasSupadataKey\)/);
  assert.doesNotMatch(
    initialization,
    /if \(!currentConfigStatus\.hasSupadataKey \|\| !currentConfigStatus\.hasAiKey\)/,
  );
});

test("memory card UI saves only after an explicit learner action", () => {
  const source = read("sidepanel.js");

  assert.match(source, /action: "generateVocabularyCard"/);
  assert.match(source, /id="saveVocabularyCard"/);
  assert.match(source, /action: "saveVocabularyCard"/);
  assert.doesNotMatch(
    source,
    /generateVocabularyCard[\s\S]{0,500}saveVocabularyCard/,
  );
});

test("buildVocabularyReviewPlan creates six progressively active sessions", () => {
  const { buildVocabularyReviewPlan } = loadSidepanelHelpers();
  const sessions = buildVocabularyReviewPlan(
    libraryEntry({ learningPlan: completeLearningPlan() }),
  );

  assert.deepEqual(
    Array.from(sessions, (session) => session.day),
    ["现在", "1 天后", "3 天后", "7 天后", "14 天后", "30 天后"],
  );
  assert.match(sessions[2].taskZh, /不看答案/);
  assert.match(sessions[5].taskZh, /造句/);
});

test("vocabulary card source declares every learner-visible method", () => {
  const source = read("sidepanel.js");

  assert.match(source, /语境锚点/);
  assert.match(source, /声音.*关键词/);
  assert.match(source, /易混对比/);
  assert.match(source, /间隔复习/);
});

test("filterVocabularyEntries searches bilingual meanings and video sources", () => {
  const { filterVocabularyEntries } = loadSidepanelHelpers();
  const entries = [libraryEntry()];

  assert.equal(filterVocabularyEntries(entries, "运行").length, 1);
  assert.equal(filterVocabularyEntries(entries, "lab lesson").length, 1);
  assert.equal(filterVocabularyEntries(entries, "RUNNING").length, 1);
  assert.equal(filterVocabularyEntries(entries, "missing").length, 0);
});

test("side panel exposes a searchable Vocabulary tab and export controls", () => {
  const html = read("sidepanel.html");

  assert.match(html, /data-tab="vocabulary"/);
  assert.match(html, /data-panel="vocabulary"/);
  assert.match(html, /id="vocabularySearch"/);
  assert.match(html, /id="vocabularyList"/);
  assert.match(html, /data-vocabulary-export="csv"/);
  assert.match(html, /data-vocabulary-export="markdown"/);
  assert.match(html, /data-vocabulary-export="anki"/);
});

test("vocabulary deletion requires a second explicit click", () => {
  const source = read("sidepanel.js");

  assert.match(
    source,
    /function armVocabularyDelete[\s\S]*Confirm delete/,
  );
  assert.match(source, /function armVocabularyDelete[\s\S]*deleteVocabularyEntry/);
  assert.match(source, /action: "deleteVocabularyCard"/);
});

test("all exports retain detailed methods and spaced review", () => {
  const helpers = loadSidepanelHelpers();
  const entry = libraryEntry({ learningPlan: completeLearningPlan() });

  assert.match(helpers.buildVocabularyCsv([entry]), /声音.*关键词/);
  assert.match(helpers.buildVocabularyMarkdown([entry]), /间隔复习/);
  assert.match(helpers.buildVocabularyAnkiTsv([entry]), /Meaning → word/);
});

test("CSV export quotes punctuation and neutralizes spreadsheet formulas", () => {
  const { buildVocabularyCsv } = loadSidepanelHelpers();
  const csv = buildVocabularyCsv([
    libraryEntry({
      definitionEn: 'move, "quickly"\nnow',
      exampleEn: "=HYPERLINK(\"https://bad.example\")",
    }),
  ]);

  assert.match(csv, /"move, ""quickly""\nnow"/);
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/bad\.example""\)"/);
  assert.match(csv, /^\uFEFF"Lemma","Forms","IPA"/);
});

test("Anki TSV keeps exactly two columns and escapes model content", () => {
  const { buildVocabularyAnkiTsv } = loadSidepanelHelpers();
  const entry = libraryEntry({
    clozePrompt: "They\trun <fast>.",
    mnemonic: {
      hook: "a\tb",
      sceneEn: "line\none <unsafe>",
      sceneZh: "场景",
      recallPath: "path",
    },
  });
  const lines = buildVocabularyAnkiTsv([entry]).trim().split("\n");

  assert.equal(lines[0], "#separator:tab");
  assert.equal(lines[1], "#html:true");
  assert.equal(lines[2], "#columns:Front\tBack");
  assert.equal(lines.length, 4);
  assert.equal(lines[3].split("\t").length, 2);
  assert.match(lines[3], /&lt;fast&gt;/);
  assert.match(lines[3], /line<br>one &lt;unsafe&gt;/);
});

test("Markdown export includes bilingual memory and timestamped sources", () => {
  const { buildVocabularyMarkdown } = loadSidepanelHelpers();
  const markdown = buildVocabularyMarkdown([libraryEntry()]);

  assert.match(markdown, /^# YouTube Digest Vocabulary/m);
  assert.match(markdown, /## run/);
  assert.match(markdown, /运行；执行/);
  assert.match(markdown, /Memory scene/);
  assert.match(markdown, /https:\/\/www\.youtube\.com\/watch\?v=abc123&t=42s/);
});

test("Markdown export escapes raw HTML from v2 learning-plan fields", () => {
  const { buildVocabularyMarkdown } = loadSidepanelHelpers();
  const markdown = buildVocabularyMarkdown([
    libraryEntry({
      learningPlan: completeLearningPlan({
        soundBridge: {
          cueZh: '<img src=x onerror="alert(1)">',
          safeguardZh: "这是辅助联想，不是 IPA、词源或标准发音说明。",
        },
      }),
    }),
  ]);

  assert.doesNotMatch(markdown, /\n<img\s/i);
  assert.match(markdown, /\\<img src=x onerror="alert\(1\)"\\>/);
});
