const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const providers = require("../providers.js");
const persistence = require("../persistence.js");

function loadBackgroundAnalysisHelpers({
  fetchImpl = fetch,
  setTimeoutImpl = () => 0,
  clearTimeoutImpl = () => {},
  storedSettings = {
    provider: "deepseek",
    aiApiKey: "test-key",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
  },
} = {}) {
  const listeners = { addListener() {} };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    AbortController,
    fetch: fetchImpl,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    importScripts() {},
    chrome: {
      storage: {
        local: {
          setAccessLevel: async () => {},
          get: async () => ({ ytd_settings: storedSettings }),
          set: async () => {},
          remove: async () => {},
        },
      },
      action: { onClicked: listeners },
      sidePanel: {
        setPanelBehavior() {},
        setOptions: async () => {},
      },
      runtime: {
        onInstalled: listeners,
        onMessage: listeners,
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
  return sandbox.__YTD_ANALYSIS_TESTING__;
}

function deepSeekResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

function promptAwareFetch(providerFetch) {
  return async (url, init) => {
    if (String(url).startsWith("chrome-extension://test/prompts/")) {
      return {
        ok: true,
        status: 200,
        async text() {
          return read("prompts/analysis.md");
        },
      };
    }
    return providerFetch(url, init);
  };
}

function createTimerRecorder() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay, active: true });
      return id;
    },
    clearTimeout(id) {
      const timer = timers.get(id);
      if (timer) timer.active = false;
    },
    createdCount(delay) {
      return [...timers.values()].filter((timer) => timer.delay === delay).length;
    },
    activeCount(delay) {
      return [...timers.values()].filter(
        (timer) => timer.active && (delay === undefined || timer.delay === delay),
      ).length;
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function assertCanonicalAnalysisFailure(actual, expected) {
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), {
    success: false,
    ...expected,
  });
  assert.equal(Object.hasOwn(actual, "error"), false);
  assert.equal(Object.hasOwn(actual, "message"), false);
}

function loadSidepanelHelpers() {
  const listeners = { addListener() {} };
  const sandbox = {
    console,
    URL,
    Blob,
    TextDecoder,
    TextEncoder,
    AbortController,
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

function completeAnalysis(overrides = {}) {
  return {
    summary: {
      oneSentenceZh: "这段内容说明刻意练习必须配合及时反馈。",
      executiveSummaryZh: "作者从练习、反馈和修正三个环节展开。",
      coreThesisZh: "重复本身不等于有效练习。",
      whyItMattersZh: "学生可以据此重新设计学习流程。",
    },
    chapters: [
      {
        title: "为什么重复无效",
        summary: "区分机械重复与有反馈的练习。",
        timestampSeconds: 0,
      },
      {
        title: "建立反馈循环",
        summary: "展示可执行的反馈步骤。",
        timestampSeconds: 150,
      },
    ],
    keyInsights: [
      {
        titleZh: "反馈缩短错误存活时间",
        explanationZh: "越早看到偏差，越少重复错误动作。",
        evidenceZh: "讲者用练习钢琴的例子说明即时反馈。",
        timestampSeconds: 65,
      },
      {
        titleZh: "错误日志让反馈可见",
        explanationZh: "记录错误能帮助学习者观察重复出现的偏差。",
        evidenceZh: "讲者建议在每轮练习后写下具体错误。",
        timestampSeconds: 80,
      },
      {
        titleZh: "修正必须紧跟反馈",
        explanationZh: "延迟修正会让反馈失去指导下一次尝试的价值。",
        evidenceZh: "讲者把反馈和下一次尝试放在连续步骤中。",
        timestampSeconds: 100,
      },
      {
        titleZh: "练习质量比次数重要",
        explanationZh: "有意识的修正使每次重复产生新的信息。",
        evidenceZh: "讲者对比了机械重复和有反馈的练习。",
        timestampSeconds: 120,
      },
      {
        titleZh: "反馈循环可以迁移",
        explanationZh: "同一循环可以用于不同类型的学习任务。",
        evidenceZh: "结尾把方法扩展到学生的日常学习流程。",
        timestampSeconds: 145,
      },
    ],
    argumentMap: [
      {
        claimZh: "有效练习需要反馈。",
        supportZh: "没有反馈时，错误会被重复强化。",
        caveatZh: "反馈质量也会影响结果。",
      },
    ],
    criticalThinking: {
      strengthsZh: ["将抽象原则落到具体练习流程。"],
      limitationsZh: ["没有比较不同反馈频率。"],
      assumptionsZh: ["学习者能够获得可靠反馈。"],
      openQuestionsZh: ["低成本反馈可以如何设计？"],
    },
    actionItemsZh: ["每次学习后记录一个错误并立即修正。"],
    reviewQuestions: [
      {
        questionZh: "为什么单纯重复可能无效？",
        answerZh: "因为缺少反馈会强化未被发现的错误。",
      },
    ],
    keyQuotes: [
      {
        quote: "Practice without feedback is just repetition.",
        timestampSeconds: 65,
      },
      {
        quote: "Write down the error while it is still visible.",
        timestampSeconds: 100,
      },
      {
        quote: "Use the next attempt to test the correction.",
        timestampSeconds: 145,
      },
    ],
    keyMoments: [0, 65, 100, 145, 150],
    ...overrides,
  };
}

async function runAnalysisRequest(helpers) {
  assert.equal(typeof helpers?.handleAnalyzeTranscript, "function");
  return helpers.handleAnalyzeTranscript(
    "[0:00] Practice needs feedback.",
    "Practice",
    "Teacher",
    "A lesson about feedback.",
    180,
    async () => true,
  );
}

async function runAnalysisRequestWithGuard(helpers, beforeDispatch) {
  assert.equal(typeof helpers?.handleAnalyzeTranscript, "function");
  return helpers.handleAnalyzeTranscript(
    "[0:00] Practice needs feedback.",
    "Practice",
    "Teacher",
    "A lesson about feedback.",
    180,
    beforeDispatch,
  );
}

test("missing DeepSeek key is canonical and cannot consume credit", async () => {
  let fetchCalls = 0;
  const helpers = loadBackgroundAnalysisHelpers({
    storedSettings: {
      provider: "deepseek",
      aiApiKey: "",
      aiBaseUrl: "https://api.deepseek.com",
      aiModel: "deepseek-v4-flash",
    },
    fetchImpl: async () => { fetchCalls += 1; },
  });

  const result = await runAnalysisRequest(helpers);

  assertCanonicalAnalysisFailure(result, {
    code: "MISSING_KEY",
    provider: "deepseek",
    stage: "analysis",
    retryable: false,
    mayHaveConsumedCredit: false,
    primaryAction: "open_settings",
  });
  assert.equal(fetchCalls, 0);
});

test("DeepSeek quota and network failures use canonical integration envelopes", async (t) => {
  await t.test("documented quota marker", async () => {
    const helpers = loadBackgroundAnalysisHelpers({
      fetchImpl: promptAwareFetch(async () =>
        deepSeekResponse(403, {
          error: { message: "insufficient_balance" },
        }),
      ),
    });
    const result = await runAnalysisRequest(helpers);
    assertCanonicalAnalysisFailure(result, {
      code: "INSUFFICIENT_CREDIT",
      provider: "deepseek",
      stage: "analysis",
      retryable: false,
      mayHaveConsumedCredit: true,
      primaryAction: "open_billing",
    });
  });

  await t.test("network error after dispatch", async () => {
    const helpers = loadBackgroundAnalysisHelpers({
      fetchImpl: promptAwareFetch(async () => {
        throw new TypeError("Failed to fetch deepseek-secret");
      }),
    });
    const result = await runAnalysisRequest(helpers);
    assertCanonicalAnalysisFailure(result, {
      code: "NETWORK_ERROR",
      provider: "deepseek",
      stage: "analysis",
      retryable: true,
      mayHaveConsumedCredit: true,
      primaryAction: "retry",
    });
    assert.doesNotMatch(JSON.stringify(result), /deepseek-secret/);
  });
});

test("DeepSeek HTTP status wins when an error body is blank or malformed", async (t) => {
  const cases = [
    [401, "INVALID_KEY", false, "open_settings"],
    [403, "INVALID_KEY", false, "open_settings"],
    [429, "RATE_LIMITED", true, "retry_later"],
  ];

  for (const [status, code, retryable, primaryAction] of cases) {
    await t.test(String(status), async () => {
      const helpers = loadBackgroundAnalysisHelpers({
        fetchImpl: promptAwareFetch(async () => ({
          ok: false,
          status,
          async text() { return status === 401 ? "" : "not-json"; },
        })),
      });

      const result = await runAnalysisRequest(helpers);

      assertCanonicalAnalysisFailure(result, {
        code,
        provider: "deepseek",
        stage: "analysis",
        retryable,
        mayHaveConsumedCredit: true,
        primaryAction,
      });
      assert.doesNotMatch(JSON.stringify(result), /not-json/);
    });
  }
});

test("DeepSeek successful transport rejects null and non-object JSON as malformed", async (t) => {
  for (const payload of [null, [], "not-an-object"]) {
    await t.test(JSON.stringify(payload), async () => {
      const helpers = loadBackgroundAnalysisHelpers({
        fetchImpl: promptAwareFetch(async () => deepSeekResponse(200, payload)),
      });

      const result = await runAnalysisRequest(helpers);

      assertCanonicalAnalysisFailure(result, {
        code: "MALFORMED_RESPONSE",
        provider: "deepseek",
        stage: "analysis",
        retryable: true,
        mayHaveConsumedCredit: true,
        primaryAction: "retry",
      });
    });
  }
});

test("DeepSeek provider timers do not start while the dispatch guard is pending or stale", async () => {
  const timers = createTimerRecorder();
  const guardEntered = deferred();
  const guardResult = deferred();
  let providerFetchCalls = 0;
  const helpers = loadBackgroundAnalysisHelpers({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    fetchImpl: promptAwareFetch(async () => {
      providerFetchCalls += 1;
      throw new Error("provider fetch must not run");
    }),
  });
  const pending = runAnalysisRequestWithGuard(helpers, async () => {
    guardEntered.resolve();
    return guardResult.promise;
  });

  await guardEntered.promise;
  assert.equal(timers.createdCount(50_000), 0);
  assert.equal(timers.createdCount(120_000), 0);
  assert.equal(providerFetchCalls, 0);

  guardResult.resolve("SESSION_STALE");
  const result = await pending;
  assert.equal(result.code, "SESSION_STALE");
  assert.equal(result.mayHaveConsumedCredit, false);
  assert.equal(timers.createdCount(50_000), 0);
  assert.equal(timers.createdCount(120_000), 0);
  assert.equal(providerFetchCalls, 0);
});

test("DeepSeek provider timers start after a successful guard and clear after fetch", async () => {
  const timers = createTimerRecorder();
  const providerResult = deferred();
  let providerFetchCalls = 0;
  let providerSignal;
  const helpers = loadBackgroundAnalysisHelpers({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    fetchImpl: promptAwareFetch(async (_url, init) => {
      providerFetchCalls += 1;
      providerSignal = init.signal;
      return providerResult.promise;
    }),
  });
  const pending = runAnalysisRequestWithGuard(helpers, async () => true);

  for (let turn = 0; turn < 10 && providerFetchCalls === 0; turn += 1) {
    await nextTurn();
  }
  assert.equal(providerFetchCalls, 1);
  assert.equal(providerSignal.aborted, false);
  assert.equal(timers.createdCount(50_000), 1);
  assert.equal(timers.createdCount(120_000), 1);
  assert.equal(timers.activeCount(50_000), 1);
  assert.equal(timers.activeCount(120_000), 1);

  providerResult.resolve(
    deepSeekResponse(200, {
      choices: [{ message: { content: "{}" } }],
    }),
  );
  const result = await pending;
  assert.equal(result.code, "MALFORMED_RESPONSE");
  assert.equal(timers.activeCount(), 0);
});

test("malformed DeepSeek transport and model content are typed", async (t) => {
  await t.test("transport JSON", async () => {
    const helpers = loadBackgroundAnalysisHelpers({
      fetchImpl: promptAwareFetch(async () => ({
        ok: true,
        status: 200,
        async text() { return "not-json"; },
      })),
    });
    const result = await runAnalysisRequest(helpers);
    assertCanonicalAnalysisFailure(result, {
      code: "MALFORMED_RESPONSE",
      provider: "deepseek",
      stage: "analysis",
      retryable: true,
      mayHaveConsumedCredit: true,
      primaryAction: "retry",
    });
  });

  await t.test("model content", async () => {
    const helpers = loadBackgroundAnalysisHelpers({
      fetchImpl: promptAwareFetch(async () =>
        deepSeekResponse(200, {
          choices: [{ message: { content: "not-json" } }],
        }),
      ),
    });
    const result = await runAnalysisRequest(helpers);
    assert.equal(result.code, "MALFORMED_RESPONSE");
    assert.equal(result.mayHaveConsumedCredit, true);
    assert.equal(Object.hasOwn(result, "error"), false);
  });

  await t.test("incomplete normalized report", async () => {
    const helpers = loadBackgroundAnalysisHelpers({
      fetchImpl: promptAwareFetch(async () =>
        deepSeekResponse(200, {
          choices: [{ message: { content: "{}" } }],
        }),
      ),
    });
    const result = await runAnalysisRequest(helpers);
    assert.equal(result.code, "MALFORMED_RESPONSE");
    assert.equal(result.mayHaveConsumedCredit, true);
  });
});

test("deep analysis normalizer returns a bounded version-2 schema", () => {
  const { validateAndFixTimestamps } = loadBackgroundAnalysisHelpers();
  const analysis = completeAnalysis({
    summary: {
      ...completeAnalysis().summary,
      oneSentenceZh: "重".repeat(500),
    },
    actionItemsZh: Array.from({ length: 20 }, (_, index) => `行动 ${index}`),
  });

  const normalized = validateAndFixTimestamps(analysis, 180);

  assert.equal(normalized.schemaVersion, 2);
  assert.equal(normalized.summary.oneSentenceZh.length, 300);
  assert.equal(normalized.actionItemsZh.length, 12);
  assert.equal(normalized.keyInsights[0].timestamp, "1:05");
  assert.equal(normalized.chapters[1].timestamp, "2:30");
  assert.equal(normalized.keyQuotes[0].quote.startsWith("Practice"), true);
  assert.equal(normalized.reportComplete, true);
});

test("deep analysis normalizer drops invalid records and supplies safe defaults", () => {
  const { validateAndFixTimestamps } = loadBackgroundAnalysisHelpers();
  const normalized = validateAndFixTimestamps(
    {
      summary: null,
      chapters: [
        { title: "Outside video", timestampSeconds: 999 },
        { title: "Valid", timestampSeconds: 10 },
      ],
      keyInsights: [
        {
          titleZh: "No evidence",
          explanationZh: "Explanation",
          evidenceZh: "",
          timestampSeconds: 10,
        },
        {
          titleZh: "Outside video",
          explanationZh: "Explanation",
          evidenceZh: "Evidence",
          timestampSeconds: 999,
        },
      ],
      argumentMap: [{ claimZh: "Claim only" }],
      criticalThinking: { strengthsZh: "not an array" },
      reviewQuestions: [{ questionZh: "Question without answer" }],
    },
    120,
  );

  assert.deepEqual(
    JSON.parse(JSON.stringify(normalized.summary)),
    {
      oneSentenceZh: "",
      executiveSummaryZh: "",
      coreThesisZh: "",
      whyItMattersZh: "",
    },
  );
  assert.equal(normalized.chapters.length, 1);
  assert.equal(normalized.keyInsights.length, 0);
  assert.equal(normalized.argumentMap.length, 0);
  assert.equal(normalized.reviewQuestions.length, 0);
  assert.deepEqual(Array.from(normalized.actionItemsZh), []);
  assert.deepEqual(
    JSON.parse(JSON.stringify(normalized.criticalThinking)),
    {
      strengthsZh: [],
      limitationsZh: [],
      assumptionsZh: [],
      openQuestionsZh: [],
    },
  );
});

test("deep analysis normalizer treats zero as a real timestamp ceiling", () => {
  const { validateAndFixTimestamps } = loadBackgroundAnalysisHelpers();
  const normalized = validateAndFixTimestamps(
    completeAnalysis({
      chapters: [
        { title: "At the start", summary: "Valid", timestampSeconds: 0 },
        { title: "Hallucinated", summary: "Invalid", timestampSeconds: 999 },
      ],
      keyMoments: [0, 999],
    }),
    0,
  );

  assert.deepEqual(
    Array.from(normalized.chapters, (chapter) => chapter.timestampSeconds),
    [0],
  );
  assert.deepEqual(Array.from(normalized.keyMoments), [0]);
});

test("analysis prompt requests the complete Chinese study report contract", () => {
  const prompt = read("prompts/analysis.md");

  for (const field of [
    "oneSentenceZh",
    "executiveSummaryZh",
    "coreThesisZh",
    "whyItMattersZh",
    "keyInsights",
    "argumentMap",
    "criticalThinking",
    "actionItemsZh",
    "reviewQuestions",
  ]) {
    assert.match(prompt, new RegExp(`\\b${field}\\b`));
  }
  assert.match(prompt, /Simplified Chinese/i);
  assert.match(prompt, /do not invent evidence/i);
});

test("clean transcript Markdown organizes captions into linked paragraphs", () => {
  const { buildCleanTranscriptMarkdown } = loadSidepanelHelpers();
  const markdown = buildCleanTranscriptMarkdown({
    transcript: [
      {
        start: 0,
        duration: 7,
        text: "Practice is not the same as repeating an action without thinking.",
      },
      {
        start: 7,
        duration: 7,
        text: "Useful practice needs feedback, correction, and another attempt.",
      },
      {
        start: 65,
        duration: 8,
        text: "That feedback loop makes each repetition more informative.",
      },
    ],
    videoId: "abc123",
    videoTitle: "Practice [with] #feedback",
    channelName: "Learning *Lab*",
    videoDescription: "A practical guide to feedback.",
  });

  assert.equal(markdown.split("\n")[0], "# Practice \\[with\\] \\#feedback");
  assert.ok(markdown.includes("**Channel:** Learning \\*Lab\\*"));
  assert.match(
    markdown,
    /\*\*Source:\*\* \[YouTube video\]\(https:\/\/www\.youtube\.com\/watch\?v=abc123\)/,
  );
  assert.match(
    markdown,
    /\[0:00\]\(https:\/\/www\.youtube\.com\/watch\?v=abc123&t=0s\)/,
  );
  assert.match(
    markdown,
    /\[1:05\]\(https:\/\/www\.youtube\.com\/watch\?v=abc123&t=65s\)/,
  );
  assert.match(markdown, /^## Clean transcript$/m);
  assert.match(markdown, /Useful practice needs feedback/);
});

test("clean transcript Markdown returns empty text without transcript entries", () => {
  const { buildCleanTranscriptMarkdown } = loadSidepanelHelpers();
  assert.equal(
    buildCleanTranscriptMarkdown({
      transcript: [],
      videoId: "abc123",
      videoTitle: "Empty",
    }),
    "",
  );
});

test("clean transcript Markdown preserves Chinese and bilingual visible modes", () => {
  const { buildCleanTranscriptMarkdown } = loadSidepanelHelpers();
  const rows = [
    Object.freeze({
      id: "segment-0-0",
      start: 0,
      sourceText: "Use <feedback> deliberately.",
      translatedText: "有意识地使用反馈。",
    }),
  ];
  const chinese = buildCleanTranscriptMarkdown({
    modeSnapshot: { mode: "zh", label: "简体中文", complete: true, rows },
    videoId: "abc123",
    videoTitle: "Chinese export",
    channelName: "Learning Lab",
  });
  const bilingual = buildCleanTranscriptMarkdown({
    modeSnapshot: {
      mode: "bilingual",
      label: "Original + 简体中文",
      complete: true,
      rows,
    },
    videoId: "abc123",
    videoTitle: "Bilingual export",
    channelName: "Learning Lab",
  });

  assert.match(chinese, /\*\*Transcript mode:\*\* 简体中文/);
  assert.match(chinese, /有意识地使用反馈。/);
  assert.doesNotMatch(chinese, /Use \\<feedback\\> deliberately/);
  assert.match(bilingual, /Use \\<feedback\\> deliberately\./);
  assert.match(bilingual, /> \*\*简体中文：\*\* 有意识地使用反馈。/);
});

test("semantic transcript grouping flushes before a large caption gap", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const grouped = groupTranscriptEntries([
    { start: 0, duration: 2, text: "A short unfinished thought" },
    { start: 180, duration: 2, text: "A much later unfinished thought" },
  ]);

  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].start, 0);
  assert.equal(grouped[1].start, 180);
  assert.doesNotMatch(grouped[0].text, /much later/);
});

test("Transcript tab exposes raw TXT and clean Markdown downloads", () => {
  const html = read("sidepanel.html");
  const source = read("sidepanel.js");

  assert.match(html, /id="exportTranscriptBtn"[\s\S]*?>[\s\S]*?TXT/);
  assert.match(html, /id="exportCleanTranscriptBtn"[\s\S]*?>[\s\S]*?Clean MD/);
  assert.match(
    source,
    /getElementById\("exportCleanTranscriptBtn"\)[\s\S]*?exportCleanTranscript/,
  );
  assert.match(source, /text\/markdown;charset=utf-8/);
});

test("hasDeepAnalysis distinguishes version-2 reports from old Overview caches", () => {
  const { validateAndFixTimestamps } = loadBackgroundAnalysisHelpers();
  const { hasDeepAnalysis } = loadSidepanelHelpers();
  const complete = validateAndFixTimestamps(completeAnalysis(), 180);

  assert.equal(hasDeepAnalysis(complete), true);
  assert.equal(
    hasDeepAnalysis({ ...complete, keyMoments: [0, 65, 145] }),
    true,
  );
  for (const malformed of [[0, -1], [0, Number.NaN], [0, "65"], [0, null]]) {
    assert.equal(
      hasDeepAnalysis({ ...complete, keyMoments: malformed }),
      false,
    );
  }
  assert.equal(hasDeepAnalysis({ ...complete, schemaVersion: "2" }), false);
  assert.equal(hasDeepAnalysis({ ...complete, chapters: [{}] }), false);
  assert.equal(
    hasDeepAnalysis({
      ...complete,
      keyInsights: Array.from({ length: 5 }, () => ({})),
    }),
    false,
  );
  assert.equal(hasDeepAnalysis({ ...complete, actionItemsZh: [""] }), false);
  assert.equal(
    hasDeepAnalysis({
      ...complete,
      criticalThinking: {
        ...complete.criticalThinking,
        strengthsZh: [""],
      },
    }),
    false,
  );
  for (const key of ["chapters", "keyInsights", "keyQuotes"]) {
    const records = complete[key].map((record, index) =>
      index === 0 ? { ...record, timestamp: "" } : record,
    );
    assert.equal(hasDeepAnalysis({ ...complete, [key]: records }), false);
  }
  assert.equal(
    hasDeepAnalysis({
      ...complete,
      keyInsights: complete.keyInsights.map((item, index) =>
        index === 0 ? { ...item, timestamp: "99:99" } : item,
      ),
    }),
    false,
  );
  assert.equal(
    hasDeepAnalysis({
      chapters: completeAnalysis().chapters,
      keyQuotes: completeAnalysis().keyQuotes,
    }),
    false,
  );
  assert.equal(
    hasDeepAnalysis(
      validateAndFixTimestamps(
        completeAnalysis({
          summary: { ...completeAnalysis().summary, coreThesisZh: "" },
        }),
        180,
      ),
    ),
    false,
  );
});

test("truncated or timeline-incomplete reports cannot be cached or exported", () => {
  const { validateAndFixTimestamps } = loadBackgroundAnalysisHelpers();
  const { hasDeepAnalysis, buildDeepAnalysisMarkdown } = loadSidepanelHelpers();
  const truncated = validateAndFixTimestamps(
    completeAnalysis({
      keyInsights: completeAnalysis().keyInsights.slice(0, 1),
      keyQuotes: completeAnalysis().keyQuotes.slice(0, 1),
    }),
    180,
  );
  const incompleteTimeline = validateAndFixTimestamps(
    completeAnalysis({
      chapters: [
        {
          title: "Only the beginning",
          summary: "The ending is missing.",
          timestampSeconds: 0,
        },
      ],
    }),
    180,
  );
  const missingOpening = validateAndFixTimestamps(
    completeAnalysis({
      chapters: [
        {
          title: "Starts too late",
          summary: "The opening is not represented.",
          timestampSeconds: 100,
        },
        {
          title: "Late chapter",
          summary: "The ending is represented.",
          timestampSeconds: 2800,
        },
      ],
    }),
    3600,
  );

  assert.equal(truncated.reportComplete, false);
  assert.equal(hasDeepAnalysis(truncated), false);
  assert.equal(buildDeepAnalysisMarkdown({ analysis: truncated }), "");
  assert.equal(incompleteTimeline.reportComplete, false);
  assert.equal(hasDeepAnalysis(incompleteTimeline), false);
  assert.equal(missingOpening.reportComplete, false);
});

test("Overview exposes every deep-report section and gated export controls", () => {
  const html = read("sidepanel.html");
  assert.match(html, /id="deepAnalysisCard"/);
  assert.match(html, /id="deepAnalysisActionBtn"/);
  assert.match(html, /id="deepAnalysisState"/);
  assert.match(html, /id="deepAnalysisResults"/);
  assert.match(
    html,
    /id="analysisStatus"[^>]*role="status"[^>]*aria-live="polite"/,
  );
  const stateStart = html.indexOf('id="deepAnalysisState"');
  const recoveryAction = html.indexOf('id="analysisRecoveryContextBtn"');
  const resultsStart = html.indexOf('id="deepAnalysisResults"');
  assert.ok(
    stateStart < recoveryAction && recoveryAction < resultsStart,
    "the inline Deep recovery action must remain visible outside hidden results",
  );
  for (const id of [
    "analysisStatus",
    "analysisOneSentence",
    "analysisExecutiveSummary",
    "analysisCoreThesis",
    "analysisWhyItMatters",
    "analysisInsights",
    "analysisArgumentMap",
    "analysisStrengths",
    "analysisLimitations",
    "analysisAssumptions",
    "analysisOpenQuestions",
    "analysisActionItems",
    "analysisReviewQuestions",
    "chapterList",
    "quotesList",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="analysisExportReportBtn"[^>]*disabled/);
  assert.match(html, /id="analysisExportStudyPackBtn"[^>]*disabled/);
  assert.match(html, /id="regenerateAnalysisBtn"/);
});

test("deep report rendering escapes model fields and wires timestamp seeking", () => {
  const source = read("sidepanel.js");

  assert.match(
    source,
    /function renderAnalysisResults[\s\S]*?renderAnalysisNarrative\(analysis\)/,
  );
  assert.match(
    source,
    /function renderAnalysisNarrative[\s\S]*?escapeHtml\(insight\.titleZh\)[\s\S]*?escapeHtml\(insight\.explanationZh\)[\s\S]*?escapeHtml\(insight\.evidenceZh\)/,
  );
  assert.match(
    source,
    /analysis-insight[\s\S]*?dataset\.seconds[\s\S]*?seekTo/,
  );
  const switchStart = source.indexOf("function switchTab");
  const switchEnd = source.indexOf("function restoreAnalysisAfterFailure", switchStart);
  const switchSource = source.slice(switchStart, switchEnd);
  assert.doesNotMatch(switchSource, /triggerAnalysis\s*\(/);
  assert.match(
    source,
    /getElementById\("deepAnalysisActionBtn"\)[\s\S]*?triggerAnalysis\(false\)/,
  );
  assert.match(
    source,
    /getElementById\("regenerateAnalysisBtn"\)[\s\S]*?triggerAnalysis\(true\)/,
  );
});

test("deep analysis locks its full card before awaiting digest durability", () => {
  const source = read("sidepanel.js");
  const start = source.indexOf("async function triggerAnalysis");
  const end = source.indexOf("// TIMESTAMP / SEEK", start);
  const lifecycle = source.slice(start, end);
  const guardIndex = lifecycle.indexOf("isAnalysisLoading = true");
  const baseAwaitIndex = lifecycle.indexOf("await ensureDigestBaseReady(token)");

  assert.ok(guardIndex >= 0, "the duplicate guard should be set");
  assert.ok(baseAwaitIndex >= 0, "the digest base should still be awaited");
  assert.ok(
    guardIndex < baseAwaitIndex,
    "duplicate activation must lock before the first await",
  );
  assert.match(lifecycle, /setAttribute\("aria-busy",\s*"true"\)/);
  assert.match(lifecycle, /setAttribute\("aria-busy",\s*"false"\)/);
});

test("deep analysis Markdown exports every report section in stable order", () => {
  const { validateAndFixTimestamps } = loadBackgroundAnalysisHelpers();
  const { buildDeepAnalysisMarkdown } = loadSidepanelHelpers();
  const analysis = validateAndFixTimestamps(
    completeAnalysis({
      summary: {
        ...completeAnalysis().summary,
        executiveSummaryZh: "总结中不能执行 <script>alert(1)</script>。",
      },
      reviewQuestions: [
        {
          questionZh: "为什么单纯重复可能无效？ </summary><script>alert(2)</script>",
          answerZh: "因为缺少反馈会强化未被发现的错误。",
        },
      ],
    }),
    180,
  );
  const markdown = buildDeepAnalysisMarkdown({
    analysis,
    videoId: "abc123",
    videoTitle: "Practice and Feedback",
    channelName: "Learning Lab",
  });

  const headings = [
    "## 一句话看懂",
    "## 内容概括",
    "## 核心论点",
    "## 为什么重要",
    "## 关键洞见与证据",
    "## 论证结构",
    "## 批判性拆解",
    "## 可执行启发",
    "## 主动回忆",
    "## 内容结构与章节",
    "## 关键原话",
  ];
  let previousIndex = -1;
  for (const heading of headings) {
    const index = markdown.indexOf(heading);
    assert.ok(index > previousIndex, `${heading} should be in stable order`);
    previousIndex = index;
  }
  assert.match(
    markdown,
    /\[1:05\]\(https:\/\/www\.youtube\.com\/watch\?v=abc123&t=65s\)/,
  );
  assert.match(markdown, /^### 1\. 为什么单纯重复可能无效？/m);
  assert.match(markdown, /^\*\*参考答案：\*\*/m);
  assert.match(markdown, /因为缺少反馈会强化未被发现的错误。/);
  assert.doesNotMatch(markdown, /<details>|<summary>|<\/summary>/);
  assert.doesNotMatch(markdown, /<script>/);
  assert.match(markdown, /\\<script\\>/);
});

test("cached deep reports stay accessible without an AI key", () => {
  const source = read("sidepanel.js");
  const start = source.indexOf("function renderAnalysisNarrative");
  const end = source.indexOf("function renderAnalysisResults", start);
  const renderNarrativeSource = source.slice(start, end);

  assert.match(
    renderNarrativeSource,
    /hasDeepAnalysis\(analysis\)[\s\S]*?\.tab\[data-tab="overview"\][\s\S]*?disabled = false/,
  );
});

test("failed regeneration restores an existing deep report", () => {
  const source = read("sidepanel.js");

  assert.match(
    source,
    /function restoreAnalysisAfterFailure[\s\S]*?hasDeepAnalysis\(currentAnalysis\)[\s\S]*?renderAnalysisResults\(currentAnalysis\)/,
  );
  assert.equal(
    (source.match(/restoreAnalysisAfterFailure\(/g) || []).length,
    3,
    "the helper should be defined and used by both failure paths",
  );
});

test("a delayed analysis response cannot cross a video session", async () => {
  const { createVideoSessionManager } = loadSidepanelHelpers();
  let id = 0;
  const coordinator = createVideoSessionManager(() => `analysis-${++id}`);
  const applied = [];
  let resolveFirst;
  const firstResponse = new Promise((resolve) => {
    resolveFirst = resolve;
  });

  const firstRequest = coordinator.begin({
    videoId: "video-a",
    tabId: 11,
    windowId: 1,
    resetEpoch: 0,
  });
  const firstWork = firstResponse.then((value) => {
    if (coordinator.isCurrent(firstRequest)) applied.push(value);
  });

  const secondRequest = coordinator.begin({
    videoId: "video-b",
    tabId: 12,
    windowId: 1,
    resetEpoch: 0,
  });
  const secondWork = Promise.resolve("report-b").then((value) => {
    if (coordinator.isCurrent(secondRequest)) applied.push(value);
  });
  resolveFirst("late-report-a");
  await Promise.all([firstWork, secondWork]);

  assert.deepEqual(applied, ["report-b"]);
});

test("analysis lifecycle guards response, cache, error, and final UI by generation", () => {
  const source = read("sidepanel.js");
  const start = source.indexOf("async function triggerAnalysis");
  const end = source.indexOf("// TIMESTAMP / SEEK", start);
  const lifecycle = source.slice(start, end);

  assert.match(
    lifecycle,
    /const token = captureVideoSession\(\)[\s\S]*?!isCurrentVideoSession\(token\)/,
  );
  assert.match(
    lifecycle,
    /await sendVideoSessionMessage[\s\S]*?}, token\);[\s\S]*?if \(!isCurrentSessionResponse\(token, analysisResult\)\) return;[\s\S]*?await patchDigestCache\(\{ deepAnalysis: currentAnalysis \}, token\);[\s\S]*?if \(!isCurrentVideoSession\(token\)\) return/,
  );
  assert.match(
    lifecycle,
    /catch \(error\)[\s\S]*?isCurrentVideoSession\(token\)[\s\S]*?finally[\s\S]*?isCurrentVideoSession\(token\)/,
  );
});

test("complete study pack appends the cleaned timestamped transcript", () => {
  const { validateAndFixTimestamps } = loadBackgroundAnalysisHelpers();
  const { buildStudyPackMarkdown } = loadSidepanelHelpers();
  const markdown = buildStudyPackMarkdown({
    analysis: validateAndFixTimestamps(completeAnalysis(), 180),
    transcript: [
      {
        start: 65,
        duration: 8,
        text: "Practice without feedback is just repetition.",
      },
    ],
    videoId: "abc123",
    videoTitle: "Practice and Feedback",
    channelName: "Learning Lab",
    videoDescription: "A guide.",
  });

  assert.match(markdown, /^# Practice and Feedback - Complete Study Pack/m);
  assert.match(markdown, /^## Deep analysis$/m);
  assert.match(markdown, /^## Clean transcript$/m);
  assert.match(markdown, /Practice without feedback is just repetition\./);
  assert.equal((markdown.match(/^\*\*Source:\*\*/gm) || []).length, 1);
});

test("analysis export buttons download only completed deep reports", () => {
  const source = read("sidepanel.js");

  assert.match(
    source,
    /getElementById\("analysisExportReportBtn"\)[\s\S]*?exportDeepAnalysis\("report"\)/,
  );
  assert.match(
    source,
    /getElementById\("analysisExportStudyPackBtn"\)[\s\S]*?exportDeepAnalysis\("study-pack"\)/,
  );
  assert.match(
    source,
    /function exportDeepAnalysis[\s\S]*?captureVideoSnapshot\(\)[\s\S]*?!hasDeepAnalysis\(snapshot\.analysis\)[\s\S]*?buildDeepAnalysisMarkdown[\s\S]*?buildStudyPackMarkdown[\s\S]*?isCurrentVideoSession\(snapshot\.token\)/,
  );
});
