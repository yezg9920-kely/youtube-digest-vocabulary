const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const providersPath = path.join(root, "providers.js");

function loadProviders() {
  return require(providersPath);
}

function assertFailure(actual, expected) {
  assert.deepEqual(Object.keys(actual), [
    "code",
    "provider",
    "stage",
    "retryable",
    "mayHaveConsumedCredit",
    "primaryAction",
  ]);
  assert.deepEqual(actual, expected);
}

test("provider runtime exposes the canonical public API through CommonJS", () => {
  const providers = loadProviders();

  assert.deepEqual(providers.STATUS, {
    UNSAVED: "unsaved",
    SAVED_UNTESTED: "saved_untested",
    CONNECTED: "connected",
    REJECTED: "rejected",
    RATE_LIMITED: "rate_limited",
    UNAVAILABLE: "unavailable",
  });
  assert.deepEqual(providers.ERROR_CODES, {
    MISSING_KEY: "MISSING_KEY",
    INVALID_KEY: "INVALID_KEY",
    NO_TRANSCRIPT: "NO_TRANSCRIPT",
    RATE_LIMITED: "RATE_LIMITED",
    INSUFFICIENT_CREDIT: "INSUFFICIENT_CREDIT",
    NETWORK_ERROR: "NETWORK_ERROR",
    REQUEST_TIMEOUT: "REQUEST_TIMEOUT",
    EMPTY_RESPONSE: "EMPTY_RESPONSE",
    MALFORMED_RESPONSE: "MALFORMED_RESPONSE",
    INPUT_TOO_LARGE: "INPUT_TOO_LARGE",
    RESPONSE_TOO_LARGE: "RESPONSE_TOO_LARGE",
    SESSION_STALE: "SESSION_STALE",
    RESET_DURING_REQUEST: "RESET_DURING_REQUEST",
    UNKNOWN_PROVIDER_ERROR: "UNKNOWN_PROVIDER_ERROR",
  });
  for (const name of [
    "mapHttpFailure",
    "mapThrownFailure",
    "normalizeStatusRecord",
    "statusAfterSuccess",
    "statusAfterFailure",
  ]) {
    assert.equal(typeof providers[name], "function", name);
  }
});

test("provider runtime exposes YTD_PROVIDERS when loaded as a classic script", () => {
  const source = fs.readFileSync(providersPath, "utf8");
  const sandbox = {};
  vm.runInNewContext(source, sandbox, { filename: providersPath });

  assert.equal(sandbox.YTD_PROVIDERS.STATUS.CONNECTED, "connected");
  assert.equal(
    sandbox.YTD_PROVIDERS.ERROR_CODES.UNKNOWN_PROVIDER_ERROR,
    "UNKNOWN_PROVIDER_ERROR",
  );
  assert.equal(typeof sandbox.YTD_PROVIDERS.mapHttpFailure, "function");
});

test("Supadata 206 and 404 map to a nonretryable transcript failure", () => {
  const { mapHttpFailure } = loadProviders();

  assertFailure(
    mapHttpFailure({
      provider: "supadata",
      stage: "transcript",
      status: 206,
      payload: { message: "raw provider text must not escape" },
      dispatched: false,
    }),
    {
      code: "NO_TRANSCRIPT",
      provider: "supadata",
      stage: "transcript",
      retryable: false,
      mayHaveConsumedCredit: false,
      primaryAction: "choose_video",
    },
  );

  assertFailure(
    mapHttpFailure({
      provider: "supadata",
      stage: "transcript",
      status: 404,
      payload: { transcript: "private provider payload" },
      dispatched: true,
    }),
    {
      code: "NO_TRANSCRIPT",
      provider: "supadata",
      stage: "transcript",
      retryable: false,
      mayHaveConsumedCredit: true,
      primaryAction: "choose_video",
    },
  );
});

test("401 uses credit markers before explicit payload failure codes", () => {
  const { mapHttpFailure } = loadProviders();

  assertFailure(
    mapHttpFailure({
      provider: "deepseek",
      stage: "analysis",
      status: 401,
      payload: { error: { code: "EMPTY_RESPONSE" } },
      dispatched: true,
    }),
    {
      code: "INVALID_KEY",
      provider: "deepseek",
      stage: "analysis",
      retryable: false,
      mayHaveConsumedCredit: true,
      primaryAction: "open_settings",
    },
  );

  assertFailure(
    mapHttpFailure({
      provider: "deepseek",
      stage: "analysis",
      status: 401,
      payload: {
        error: { code: "EMPTY_RESPONSE" },
        billing: { reason: "insufficient_balance" },
      },
      dispatched: true,
    }),
    {
      code: "INSUFFICIENT_CREDIT",
      provider: "deepseek",
      stage: "analysis",
      retryable: false,
      mayHaveConsumedCredit: true,
      primaryAction: "open_billing",
    },
  );
});

test("403 uses credit markers before explicit payload failure codes", () => {
  const { mapHttpFailure } = loadProviders();

  assertFailure(
    mapHttpFailure({
      provider: "deepseek",
      stage: "analysis",
      status: 403,
      payload: { error: { code: "SESSION_STALE" } },
      dispatched: true,
    }),
    {
      code: "INVALID_KEY",
      provider: "deepseek",
      stage: "analysis",
      retryable: false,
      mayHaveConsumedCredit: true,
      primaryAction: "open_settings",
    },
  );

  assertFailure(
    mapHttpFailure({
      provider: "deepseek",
      stage: "analysis",
      status: 403,
      payload: {
        error: { code: "SESSION_STALE" },
        quota: { reason: "quota_exceeded" },
      },
      dispatched: true,
    }),
    {
      code: "INSUFFICIENT_CREDIT",
      provider: "deepseek",
      stage: "analysis",
      retryable: false,
      mayHaveConsumedCredit: true,
      primaryAction: "open_billing",
    },
  );
});

test("429 is retryable later and unknown HTTP failures preserve 5xx retryability", () => {
  const { mapHttpFailure } = loadProviders();

  assertFailure(
    mapHttpFailure({
      provider: "deepseek",
      stage: "translation",
      status: 429,
      payload: { error: { code: "rate_limit" } },
      dispatched: true,
    }),
    {
      code: "RATE_LIMITED",
      provider: "deepseek",
      stage: "translation",
      retryable: true,
      mayHaveConsumedCredit: true,
      primaryAction: "retry_later",
    },
  );

  for (const [status, retryable, primaryAction] of [
    [503, true, "retry"],
    [418, false, "none"],
  ]) {
    assertFailure(
      mapHttpFailure({
        provider: "deepseek",
        stage: "analysis",
        status,
        payload: { message: "raw failure details" },
        dispatched: false,
      }),
      {
        code: "UNKNOWN_PROVIDER_ERROR",
        provider: "deepseek",
        stage: "analysis",
        retryable,
        mayHaveConsumedCredit: false,
        primaryAction,
      },
    );
  }
});

test("missing keys, aborts, timeout markers, and network errors normalize safely", () => {
  const { mapThrownFailure } = loadProviders();
  const cases = [
    {
      error: { code: "MISSING_KEY", message: "secret key hint" },
      dispatched: false,
      code: "MISSING_KEY",
      retryable: false,
      billed: false,
      action: "open_settings",
    },
    {
      error: { name: "AbortError", message: "operation aborted" },
      dispatched: true,
      code: "REQUEST_TIMEOUT",
      retryable: true,
      billed: true,
      action: "retry",
    },
    {
      error: { code: "AI_HARD_TIMEOUT", message: "120 second limit" },
      dispatched: true,
      code: "REQUEST_TIMEOUT",
      retryable: true,
      billed: true,
      action: "retry",
    },
    {
      // This is deliberately not an instanceof TypeError in this realm.
      error: { name: "TypeError", message: "Failed to fetch https://secret" },
      dispatched: false,
      code: "NETWORK_ERROR",
      retryable: true,
      billed: false,
      action: "retry",
    },
    {
      error: { code: "ECONNRESET", message: "socket reset" },
      dispatched: true,
      code: "NETWORK_ERROR",
      retryable: true,
      billed: true,
      action: "retry",
    },
  ];

  for (const item of cases) {
    assertFailure(
      mapThrownFailure({
        provider: "deepseek",
        stage: "analysis",
        error: item.error,
        dispatched: item.dispatched,
      }),
      {
        code: item.code,
        provider: "deepseek",
        stage: "analysis",
        retryable: item.retryable,
        mayHaveConsumedCredit: item.billed,
        primaryAction: item.action,
      },
    );
  }
});

test("thrown failures with HTTP status use HTTP mapping before embedded codes", () => {
  const { mapThrownFailure } = loadProviders();
  const cases = [
    {
      error: { status: 401, code: "EMPTY_RESPONSE" },
      expected: {
        code: "INVALID_KEY",
        retryable: false,
        primaryAction: "open_settings",
      },
    },
    {
      error: {
        status: 403,
        code: "SESSION_STALE",
        quota: { reason: "quota_exceeded" },
      },
      expected: {
        code: "INSUFFICIENT_CREDIT",
        retryable: false,
        primaryAction: "open_billing",
      },
    },
    {
      error: { status: 429, code: "INVALID_KEY" },
      expected: {
        code: "RATE_LIMITED",
        retryable: true,
        primaryAction: "retry_later",
      },
    },
  ];

  for (const { error, expected } of cases) {
    assertFailure(
      mapThrownFailure({
        provider: "deepseek",
        stage: "analysis",
        error,
        dispatched: true,
      }),
      {
        ...expected,
        provider: "deepseek",
        stage: "analysis",
        mayHaveConsumedCredit: true,
      },
    );
  }
});

test("a dispatched missing-key failure conservatively reports possible credit use", () => {
  const { mapThrownFailure } = loadProviders();

  assertFailure(
    mapThrownFailure({
      provider: "deepseek",
      stage: "analysis",
      error: { code: "MISSING_KEY" },
      dispatched: true,
    }),
    {
      code: "MISSING_KEY",
      provider: "deepseek",
      stage: "analysis",
      retryable: false,
      mayHaveConsumedCredit: true,
      primaryAction: "open_settings",
    },
  );
});

test("explicit bounded failure codes survive thrown and HTTP mapping", () => {
  const { mapHttpFailure, mapThrownFailure } = loadProviders();
  const cases = [
    ["EMPTY_RESPONSE", true, "retry"],
    ["MALFORMED_RESPONSE", true, "retry"],
    ["INPUT_TOO_LARGE", false, "reduce_request"],
    ["RESPONSE_TOO_LARGE", false, "reduce_request"],
    ["SESSION_STALE", true, "retry"],
    ["RESET_DURING_REQUEST", true, "retry"],
  ];

  for (const [code, retryable, primaryAction] of cases) {
    for (const actual of [
      mapThrownFailure({
        provider: "deepseek",
        stage: "analysis",
        error: { code, message: `private ${code} details` },
        dispatched: true,
      }),
      mapHttpFailure({
        provider: "deepseek",
        stage: "analysis",
        status: 400,
        payload: { error: { code, message: `private ${code} payload` } },
        dispatched: true,
      }),
    ]) {
      assertFailure(actual, {
        code,
        provider: "deepseek",
        stage: "analysis",
        retryable,
        mayHaveConsumedCredit: true,
        primaryAction,
      });
    }
  }
});

test("failure envelopes bound labels and never retain arbitrary error data", () => {
  const { mapThrownFailure } = loadProviders();
  const raw = "provider-secret-response";
  const failure = mapThrownFailure({
    provider: `deepseek-${"p".repeat(200)}`,
    stage: `analysis-${"s".repeat(200)}`,
    error: { message: raw, payload: { raw } },
    dispatched: true,
  });

  assert.equal(failure.code, "UNKNOWN_PROVIDER_ERROR");
  assert.equal(failure.retryable, false);
  assert.equal(failure.primaryAction, "none");
  assert.ok(failure.provider.length <= 64);
  assert.ok(failure.stage.length <= 64);
  assert.doesNotMatch(JSON.stringify(failure), new RegExp(raw));
});

test("provider failure inspection degrades throwing payloads and proxies", () => {
  const { mapHttpFailure, mapThrownFailure } = loadProviders();
  const throwingPayload = {};
  Object.defineProperty(throwingPayload, "code", {
    enumerable: true,
    get() {
      throw new Error("payload getter must not escape");
    },
  });
  const throwingProxy = new Proxy(
    {},
    {
      get() {
        throw new Error("proxy getter must not escape");
      },
      getOwnPropertyDescriptor() {
        throw new Error("proxy descriptor must not escape");
      },
      ownKeys() {
        throw new Error("proxy keys must not escape");
      },
    },
  );

  for (const failure of [
    mapHttpFailure({
      provider: "deepseek",
      stage: "analysis",
      status: 400,
      payload: throwingPayload,
      dispatched: true,
    }),
    mapThrownFailure({
      provider: "deepseek",
      stage: "analysis",
      error: throwingProxy,
      dispatched: true,
    }),
  ]) {
    assertFailure(failure, {
      code: "UNKNOWN_PROVIDER_ERROR",
      provider: "deepseek",
      stage: "analysis",
      retryable: false,
      mayHaveConsumedCredit: true,
      primaryAction: "none",
    });
  }
});

test("credit marker inspection triggers only a bounded number of own getters", () => {
  const { mapHttpFailure } = loadProviders();
  const payload = {};
  let reads = 0;
  for (let index = 0; index < 40; index += 1) {
    Object.defineProperty(payload, `field${index}`, {
      enumerable: true,
      get() {
        reads += 1;
        return "ordinary provider detail";
      },
    });
  }

  const failure = mapHttpFailure({
    provider: "deepseek",
    stage: "analysis",
    status: 402,
    payload,
    dispatched: true,
  });

  assert.equal(failure.code, "UNKNOWN_PROVIDER_ERROR");
  assert.ok(reads <= 24, `expected at most 24 getter reads, received ${reads}`);
});

test("success and failure status helpers use the injected clock value", () => {
  const { statusAfterFailure, statusAfterSuccess } = loadProviders();
  const checkedAt = 1_776_543_210_123;

  assert.deepEqual(statusAfterSuccess(checkedAt), {
    state: "connected",
    lastCheckedAt: checkedAt,
    lastFailureCode: "",
  });
  assert.deepEqual(
    statusAfterFailure({ code: "INVALID_KEY", message: "raw rejection" }, checkedAt),
    {
      state: "rejected",
      lastCheckedAt: checkedAt,
      lastFailureCode: "INVALID_KEY",
    },
  );
  assert.deepEqual(statusAfterFailure({ code: "NO_TRANSCRIPT" }), {
    state: "unavailable",
    lastCheckedAt: null,
    lastFailureCode: "NO_TRANSCRIPT",
  });
});

test("status timestamps accept only nonnegative safe-integer epochs", () => {
  const { statusAfterFailure, statusAfterSuccess } = loadProviders();

  for (const invalidClock of [
    undefined,
    null,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    "2026-08-18T12:34:56.000Z",
  ]) {
    assert.deepEqual(statusAfterSuccess(invalidClock), {
      state: "saved_untested",
      lastCheckedAt: null,
      lastFailureCode: "",
    });
  }

  assert.deepEqual(
    statusAfterFailure({ code: "RATE_LIMITED" }, "2026-08-18T12:34:56.000Z"),
    {
      state: "rate_limited",
      lastCheckedAt: null,
      lastFailureCode: "RATE_LIMITED",
    },
  );
});

test("connected to failure transition retains an explicit last-checked epoch", () => {
  const { statusAfterFailure, statusAfterSuccess } = loadProviders();
  const connected = statusAfterSuccess(1_776_543_210_123);

  assert.deepEqual(
    statusAfterFailure({ code: "NETWORK_ERROR" }, connected.lastCheckedAt),
    {
      state: "unavailable",
      lastCheckedAt: connected.lastCheckedAt,
      lastFailureCode: "NETWORK_ERROR",
    },
  );
});

test("status normalization derives unsaved and saved-untested from key state", () => {
  const { normalizeStatusRecord } = loadProviders();

  assert.deepEqual(
    normalizeStatusRecord(
      {
        state: "connected",
        lastCheckedAt: 123,
        lastFailureCode: "",
        message: "must be discarded",
      },
      false,
    ),
    {
      state: "unsaved",
      lastCheckedAt: null,
      lastFailureCode: "",
    },
  );

  for (const record of [
    undefined,
    null,
    [],
    { status: "connected" },
    { state: "connected" },
    {
      state: `unavailable-${"x".repeat(200)}`,
      lastCheckedAt: "not-a-clock",
      lastFailureCode: `RAW_${"y".repeat(200)}`,
      payload: "private response",
    },
  ]) {
    assert.deepEqual(normalizeStatusRecord(record, true), {
      state: "saved_untested",
      lastCheckedAt: null,
      lastFailureCode: "",
    });
  }
});

test("status normalization snapshots each accessor field once", () => {
  const { normalizeStatusRecord } = loadProviders();
  const reads = { state: 0, lastCheckedAt: 0, lastFailureCode: 0 };
  const record = {
    get state() {
      reads.state += 1;
      return reads.state === 1 ? "not_a_canonical_state" : "connected";
    },
    get lastCheckedAt() {
      reads.lastCheckedAt += 1;
      return 123;
    },
    get lastFailureCode() {
      reads.lastFailureCode += 1;
      return "INVALID_KEY";
    },
  };

  assert.deepEqual(normalizeStatusRecord(record, true), {
    state: "saved_untested",
    lastCheckedAt: null,
    lastFailureCode: "",
  });
  assert.deepEqual(reads, {
    state: 1,
    lastCheckedAt: 1,
    lastFailureCode: 1,
  });
});

test("status normalization degrades throwing accessors and proxies", () => {
  const { normalizeStatusRecord } = loadProviders();
  const throwingRecord = {
    get state() {
      throw new Error("status getter must not escape");
    },
  };
  const throwingProxy = new Proxy(
    {},
    {
      get() {
        throw new Error("status proxy must not escape");
      },
    },
  );

  for (const record of [throwingRecord, throwingProxy]) {
    assert.deepEqual(normalizeStatusRecord(record, true), {
      state: "saved_untested",
      lastCheckedAt: null,
      lastFailureCode: "",
    });
  }
});

test("status normalization preserves only bounded canonical persisted fields", () => {
  const { normalizeStatusRecord } = loadProviders();
  const records = [
    {
      input: {
        state: "connected",
        lastCheckedAt: 1_776_543_210_123,
        lastFailureCode: "RAW_PROVIDER_MESSAGE",
        payload: { response: "private" },
      },
      expected: {
        state: "connected",
        lastCheckedAt: 1_776_543_210_123,
        lastFailureCode: "",
      },
    },
    {
      input: {
        state: "rejected",
        lastCheckedAt: 1_776_543_210_123,
        lastFailureCode: "INVALID_KEY",
        message: "raw provider rejection",
      },
      expected: {
        state: "rejected",
        lastCheckedAt: 1_776_543_210_123,
        lastFailureCode: "INVALID_KEY",
      },
    },
    {
      input: {
        state: "unavailable",
        lastCheckedAt: null,
        lastFailureCode: `RAW_${"z".repeat(200)}`,
      },
      expected: {
        state: "unavailable",
        lastCheckedAt: null,
        lastFailureCode: "UNKNOWN_PROVIDER_ERROR",
      },
    },
  ];

  for (const { input, expected } of records) {
    const actual = normalizeStatusRecord(input, true);
    assert.deepEqual(Object.keys(actual), [
      "state",
      "lastCheckedAt",
      "lastFailureCode",
    ]);
    assert.deepEqual(actual, expected);
    assert.ok(actual.state.length <= 32);
    assert.ok(actual.lastFailureCode.length <= 64);
    assert.doesNotMatch(JSON.stringify(actual), /raw provider|private/i);
  }
});

test("non-authentication and non-rate-limit failures become unavailable", () => {
  const { ERROR_CODES, statusAfterFailure } = loadProviders();

  for (const code of Object.values(ERROR_CODES)) {
    const record = statusAfterFailure({ code }, 99);
    if (code === "INVALID_KEY") {
      assert.equal(record.state, "rejected");
    } else if (code === "RATE_LIMITED") {
      assert.equal(record.state, "rate_limited");
    } else {
      assert.equal(record.state, "unavailable", code);
    }
    assert.ok(record.lastFailureCode.length <= 64);
  }
});
