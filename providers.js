/**
 * Canonical, bounded provider failures and connection status helpers.
 *
 * This module intentionally contains no credentials or provider response data.
 */
var YTD_PROVIDERS = (() => {
  const STATUS = Object.freeze({
    UNSAVED: "unsaved",
    SAVED_UNTESTED: "saved_untested",
    CONNECTED: "connected",
    REJECTED: "rejected",
    RATE_LIMITED: "rate_limited",
    UNAVAILABLE: "unavailable",
  });

  const ERROR_CODES = Object.freeze({
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

  const MAX_CONTEXT_LENGTH = 64;
  const CANONICAL_ERROR_CODES = new Set(Object.values(ERROR_CODES));
  const ERROR_ALIASES = Object.freeze({
    NO_AI_KEY: ERROR_CODES.MISSING_KEY,
    NO_SUPADATA_KEY: ERROR_CODES.MISSING_KEY,
    INVALID_AI_KEY: ERROR_CODES.INVALID_KEY,
    INVALID_SUPADATA_KEY: ERROR_CODES.INVALID_KEY,
    EMPTY_AI_RESPONSE: ERROR_CODES.EMPTY_RESPONSE,
    AI_RESPONSE_TOO_LARGE: ERROR_CODES.RESPONSE_TOO_LARGE,
    AI_IDLE_TIMEOUT: ERROR_CODES.REQUEST_TIMEOUT,
    AI_HARD_TIMEOUT: ERROR_CODES.REQUEST_TIMEOUT,
  });
  const FAILURE_BEHAVIOR = Object.freeze({
    [ERROR_CODES.MISSING_KEY]: Object.freeze({
      retryable: false,
      primaryAction: "open_settings",
    }),
    [ERROR_CODES.INVALID_KEY]: Object.freeze({
      retryable: false,
      primaryAction: "open_settings",
    }),
    [ERROR_CODES.NO_TRANSCRIPT]: Object.freeze({
      retryable: false,
      primaryAction: "choose_video",
    }),
    [ERROR_CODES.RATE_LIMITED]: Object.freeze({
      retryable: true,
      primaryAction: "retry_later",
    }),
    [ERROR_CODES.INSUFFICIENT_CREDIT]: Object.freeze({
      retryable: false,
      primaryAction: "open_billing",
    }),
    [ERROR_CODES.NETWORK_ERROR]: Object.freeze({
      retryable: true,
      primaryAction: "retry",
    }),
    [ERROR_CODES.REQUEST_TIMEOUT]: Object.freeze({
      retryable: true,
      primaryAction: "retry",
    }),
    [ERROR_CODES.EMPTY_RESPONSE]: Object.freeze({
      retryable: true,
      primaryAction: "retry",
    }),
    [ERROR_CODES.MALFORMED_RESPONSE]: Object.freeze({
      retryable: true,
      primaryAction: "retry",
    }),
    [ERROR_CODES.INPUT_TOO_LARGE]: Object.freeze({
      retryable: false,
      primaryAction: "reduce_request",
    }),
    [ERROR_CODES.RESPONSE_TOO_LARGE]: Object.freeze({
      retryable: false,
      primaryAction: "reduce_request",
    }),
    [ERROR_CODES.SESSION_STALE]: Object.freeze({
      retryable: true,
      primaryAction: "retry",
    }),
    [ERROR_CODES.RESET_DURING_REQUEST]: Object.freeze({
      retryable: true,
      primaryAction: "retry",
    }),
    [ERROR_CODES.UNKNOWN_PROVIDER_ERROR]: Object.freeze({
      retryable: false,
      primaryAction: "none",
    }),
  });

  function boundedContext(value) {
    if (typeof value !== "string") return "unknown";
    const normalized = value.trim();
    return normalized ? normalized.slice(0, MAX_CONTEXT_LENGTH) : "unknown";
  }

  function normalizeCode(value) {
    if (typeof value !== "string") return "";
    const normalized = value
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, MAX_CONTEXT_LENGTH);
    if (CANONICAL_ERROR_CODES.has(normalized)) return normalized;
    return ERROR_ALIASES[normalized] || "";
  }

  function readOwnFields(value, fields) {
    if (!value || typeof value !== "object") return null;
    const snapshot = {};
    try {
      for (const field of fields) {
        const descriptor = Object.getOwnPropertyDescriptor(value, field);
        snapshot[field] = descriptor ? Reflect.get(value, field) : undefined;
      }
    } catch {
      return null;
    }
    return snapshot;
  }

  function codeFrom(value) {
    const direct = normalizeCode(value);
    if (direct) return direct;
    const root = readOwnFields(value, ["code", "type", "reason", "error"]);
    if (!root) return "";

    for (const candidate of [
      root.code,
      root.type,
      root.reason,
    ]) {
      const code = normalizeCode(candidate);
      if (code) return code;
    }

    const nested = readOwnFields(root.error, ["code", "type", "reason"]);
    if (!nested) return "";
    for (const candidate of [nested.code, nested.type, nested.reason]) {
      const code = normalizeCode(candidate);
      if (code) return code;
    }
    return "";
  }

  function limitedOwnValues(value) {
    try {
      const keys = Object.keys(value).slice(0, 24);
      const values = [];
      for (const key of keys) values.push(Reflect.get(value, key));
      return values;
    } catch {
      return null;
    }
  }

  function hasCreditMarker(payload) {
    const queue = [{ value: payload, depth: 0 }];
    const seen = new Set();
    let inspected = 0;

    while (queue.length && inspected < 48) {
      const item = queue.shift();
      const value = item.value;
      inspected += 1;

      if (typeof value === "string") {
        const marker = value
          .slice(0, 512)
          .toUpperCase()
          .replace(/[^A-Z0-9]+/g, "_");
        if (
          /(?:INSUFFICIENT_(?:BALANCE|CREDIT|CREDITS|QUOTA)|(?:BALANCE|CREDIT|CREDITS|QUOTA)_(?:EXCEEDED|EXHAUSTED|DEPLETED)|NOT_ENOUGH_(?:BALANCE|CREDIT|CREDITS|QUOTA))/.test(
            marker,
          )
        ) {
          return true;
        }
        continue;
      }

      if (!value || typeof value !== "object" || seen.has(value)) continue;
      seen.add(value);
      if (item.depth >= 4) continue;
      const children = limitedOwnValues(value);
      if (!children) return false;
      for (const child of children) {
        queue.push({ value: child, depth: item.depth + 1 });
      }
    }

    return false;
  }

  function failureEnvelope({
    code,
    provider,
    stage,
    dispatched,
    retryable,
    primaryAction,
  }) {
    const safeCode = CANONICAL_ERROR_CODES.has(code)
      ? code
      : ERROR_CODES.UNKNOWN_PROVIDER_ERROR;
    const behavior = FAILURE_BEHAVIOR[safeCode];
    return {
      code: safeCode,
      provider: boundedContext(provider),
      stage: boundedContext(stage),
      retryable:
        typeof retryable === "boolean" ? retryable : behavior.retryable,
      mayHaveConsumedCredit: Boolean(dispatched),
      primaryAction:
        typeof primaryAction === "string"
          ? primaryAction.slice(0, MAX_CONTEXT_LENGTH)
          : behavior.primaryAction,
    };
  }

  function mapHttpFailure({
    provider,
    stage,
    status,
    payload,
    dispatched,
  } = {}) {
    const numericStatus = Number(status);
    const providerName = boundedContext(provider);
    const normalizedProvider = providerName.toLowerCase();

    if (
      normalizedProvider === "supadata" &&
      (numericStatus === 206 || numericStatus === 404)
    ) {
      return failureEnvelope({
        code: ERROR_CODES.NO_TRANSCRIPT,
        provider: providerName,
        stage,
        dispatched,
      });
    }

    if (numericStatus === 429) {
      return failureEnvelope({
        code: ERROR_CODES.RATE_LIMITED,
        provider: providerName,
        stage,
        dispatched,
      });
    }

    if (numericStatus === 401 || numericStatus === 403) {
      const code = hasCreditMarker(payload)
        ? ERROR_CODES.INSUFFICIENT_CREDIT
        : ERROR_CODES.INVALID_KEY;
      return failureEnvelope({
        code,
        provider: providerName,
        stage,
        dispatched,
      });
    }

    const explicitCode = codeFrom(payload);
    if (explicitCode) {
      return failureEnvelope({
        code: explicitCode,
        provider: providerName,
        stage,
        dispatched,
      });
    }

    if (hasCreditMarker(payload)) {
      return failureEnvelope({
        code: ERROR_CODES.INSUFFICIENT_CREDIT,
        provider: providerName,
        stage,
        dispatched,
      });
    }

    const retryable = numericStatus >= 500 && numericStatus <= 599;
    return failureEnvelope({
      code: ERROR_CODES.UNKNOWN_PROVIDER_ERROR,
      provider: providerName,
      stage,
      dispatched,
      retryable,
      primaryAction: retryable ? "retry" : "none",
    });
  }

  function safeErrorSnapshot(error) {
    if (!error || typeof error !== "object") return null;
    try {
      return {
        name: error.name,
        timeout: error.timeout,
        code: error.code,
        message: error.message,
      };
    } catch {
      return null;
    }
  }

  function isTimeout(error) {
    if (!error) return false;
    if (error.name === "AbortError" || error.timeout === true) return true;
    const marker = String(error.code || error.name || "").toUpperCase();
    return (
      marker.includes("TIMEOUT") ||
      marker.includes("TIMED_OUT") ||
      marker === "ETIMEDOUT" ||
      /\b(?:timed? out|timeout)\b/i.test(String(error.message || "").slice(0, 256))
    );
  }

  function isNetworkError(error) {
    if (!error) return false;
    if (error.name === "TypeError" || error.name === "NetworkError") return true;
    const code = String(error.code || "").toUpperCase();
    if (
      /^(?:ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|UND_ERR_[A-Z_]+)$/.test(
        code,
      )
    ) {
      return true;
    }
    return /\b(?:failed to fetch|network error|load failed)\b/i.test(
      String(error.message || "").slice(0, 256),
    );
  }

  function httpStatusFrom(error) {
    if (!error || typeof error !== "object") return null;
    try {
      const numericStatus = Number(error.status);
      return Number.isInteger(numericStatus) &&
        numericStatus >= 100 &&
        numericStatus <= 599
        ? numericStatus
        : null;
    } catch {
      return null;
    }
  }

  function mapThrownFailure({ provider, stage, error, dispatched } = {}) {
    const numericStatus = httpStatusFrom(error);
    if (numericStatus !== null) {
      return mapHttpFailure({
        provider,
        stage,
        status: numericStatus,
        payload: error,
        dispatched,
      });
    }

    const explicitCode = codeFrom(error);
    if (explicitCode) {
      return failureEnvelope({
        code: explicitCode,
        provider,
        stage,
        dispatched,
      });
    }

    const errorSnapshot = safeErrorSnapshot(error);
    if (isTimeout(errorSnapshot)) {
      return failureEnvelope({
        code: ERROR_CODES.REQUEST_TIMEOUT,
        provider,
        stage,
        dispatched,
      });
    }

    if (isNetworkError(errorSnapshot)) {
      return failureEnvelope({
        code: ERROR_CODES.NETWORK_ERROR,
        provider,
        stage,
        dispatched,
      });
    }

    return failureEnvelope({
      code: ERROR_CODES.UNKNOWN_PROVIDER_ERROR,
      provider,
      stage,
      dispatched,
    });
  }

  function safeLastCheckedAt(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  function statusRecord(state, lastCheckedAt, lastFailureCode) {
    return {
      state,
      lastCheckedAt,
      lastFailureCode,
    };
  }

  function statusSnapshot(record) {
    try {
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        return null;
      }
      return {
        state: record.state,
        lastCheckedAt: record.lastCheckedAt,
        lastFailureCode: record.lastFailureCode,
      };
    } catch {
      return null;
    }
  }

  function normalizeStatusRecord(record, hasKey) {
    if (!hasKey) {
      return statusRecord(STATUS.UNSAVED, null, "");
    }
    const snapshot = statusSnapshot(record);
    if (!snapshot) {
      return statusRecord(STATUS.SAVED_UNTESTED, null, "");
    }

    const knownStatuses = new Set(Object.values(STATUS));
    const { state, lastCheckedAt: checkedAtValue, lastFailureCode: failureCodeValue } =
      snapshot;
    if (
      typeof state !== "string" ||
      state.length > 32 ||
      !knownStatuses.has(state) ||
      state === STATUS.UNSAVED ||
      state === STATUS.SAVED_UNTESTED
    ) {
      return statusRecord(STATUS.SAVED_UNTESTED, null, "");
    }

    const lastCheckedAt = safeLastCheckedAt(checkedAtValue);
    if (state === STATUS.CONNECTED) {
      if (lastCheckedAt === null) {
        return statusRecord(STATUS.SAVED_UNTESTED, null, "");
      }
      return statusRecord(STATUS.CONNECTED, lastCheckedAt, "");
    }

    let lastFailureCode = normalizeCode(failureCodeValue);
    if (state === STATUS.REJECTED) {
      lastFailureCode = ERROR_CODES.INVALID_KEY;
    } else if (state === STATUS.RATE_LIMITED) {
      lastFailureCode = ERROR_CODES.RATE_LIMITED;
    } else if (!lastFailureCode) {
      lastFailureCode = ERROR_CODES.UNKNOWN_PROVIDER_ERROR;
    }
    return statusRecord(state, lastCheckedAt, lastFailureCode);
  }

  function statusAfterSuccess(lastCheckedAt) {
    const checkedAt = safeLastCheckedAt(lastCheckedAt);
    return checkedAt === null
      ? statusRecord(STATUS.SAVED_UNTESTED, null, "")
      : statusRecord(STATUS.CONNECTED, checkedAt, "");
  }

  function statusAfterFailure(failure, lastCheckedAt) {
    const code = codeFrom(failure) || ERROR_CODES.UNKNOWN_PROVIDER_ERROR;
    let state = STATUS.UNAVAILABLE;
    if (code === ERROR_CODES.INVALID_KEY) {
      state = STATUS.REJECTED;
    } else if (code === ERROR_CODES.RATE_LIMITED) {
      state = STATUS.RATE_LIMITED;
    }
    return statusRecord(state, safeLastCheckedAt(lastCheckedAt), code);
  }

  return {
    STATUS,
    ERROR_CODES,
    mapHttpFailure,
    mapThrownFailure,
    normalizeStatusRecord,
    statusAfterSuccess,
    statusAfterFailure,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_PROVIDERS;
}
