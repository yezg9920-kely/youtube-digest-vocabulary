/**
 * Durable, reset-safe local persistence helpers.
 *
 * Every read-modify-write operation is serialized through one coordinator.
 * This file has no DOM dependency and can run as a classic MV3 worker script.
 */
var YTD_PERSISTENCE = (() => {
  const STORAGE_KEYS = Object.freeze({
    settings: "ytd_settings",
    providerStatus: "ytd_provider_status",
    notes: "ytd_notes",
    vocabulary: "ytd_vocabulary",
    language: "ytd_options_language",
    resetEpoch: "ytd_reset_epoch",
  });
  const DIGEST_PREFIX = "digest_";
  const DIGEST_BUDGET_BYTES = 8 * 1024 * 1024;
  const OVERVIEW_ATTEMPT_PREFIX = "ytd_overview_attempt_v1_";
  const OVERVIEW_ATTEMPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const OVERVIEW_CLAIM_LEASE_MS = 180_000;
  const OVERVIEW_WRITE_VERIFICATION_ATTEMPTS = 2;
  const DIGEST_SCHEMA_VERSION = 2;
  const DIGEST_DATA_MAX_DEPTH = 32;
  const DIGEST_DATA_MAX_PROPERTIES = 100_000;
  const DIGEST_DATA_MAX_BYTES = 2 * 1024 * 1024;
  const PARAGRAPH_CACHE_MAX_ENTRIES = 2_000;
  const PARAGRAPH_CACHE_MAX_KEY_CHARS = 512;
  const PARAGRAPH_CACHE_MAX_VALUE_CHARS = 20_000;
  const MAX_VERIFICATION_KEYS = 100;
  const MAX_FAILURE_KEYS = 100;
  const BYTE_MEASUREMENT_CONCURRENCY = 16;
  const OVERVIEW_FAILURE_DEFAULTS = Object.freeze({
    MISSING_KEY: Object.freeze({
      retryable: false,
      primaryAction: "open_settings",
    }),
    INVALID_KEY: Object.freeze({
      retryable: false,
      primaryAction: "open_settings",
    }),
    NO_TRANSCRIPT: Object.freeze({
      retryable: false,
      primaryAction: "choose_video",
    }),
    RATE_LIMITED: Object.freeze({
      retryable: true,
      primaryAction: "retry_later",
    }),
    INSUFFICIENT_CREDIT: Object.freeze({
      retryable: false,
      primaryAction: "open_billing",
    }),
    NETWORK_ERROR: Object.freeze({ retryable: true, primaryAction: "retry" }),
    REQUEST_TIMEOUT: Object.freeze({ retryable: true, primaryAction: "retry" }),
    EMPTY_RESPONSE: Object.freeze({ retryable: true, primaryAction: "retry" }),
    MALFORMED_RESPONSE: Object.freeze({
      retryable: true,
      primaryAction: "retry",
    }),
    INPUT_TOO_LARGE: Object.freeze({
      retryable: false,
      primaryAction: "reduce_request",
    }),
    RESPONSE_TOO_LARGE: Object.freeze({
      retryable: false,
      primaryAction: "reduce_request",
    }),
    SESSION_STALE: Object.freeze({ retryable: true, primaryAction: "retry" }),
    RESET_DURING_REQUEST: Object.freeze({
      retryable: true,
      primaryAction: "retry",
    }),
    UNKNOWN_PROVIDER_ERROR: Object.freeze({
      retryable: false,
      primaryAction: "none",
    }),
  });
  const OVERVIEW_FAILURE_CODES = new Set(
    Object.keys(OVERVIEW_FAILURE_DEFAULTS),
  );

  function normalizeEpoch(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  function safeOwnKeys(value) {
    if (!value || typeof value !== "object") return [];
    try {
      return Object.keys(value);
    } catch {
      return [];
    }
  }

  function hasOwnKey(value, key) {
    if (!value || typeof value !== "object") return false;
    try {
      return Object.hasOwn(value, key);
    } catch {
      return false;
    }
  }

  function copyOwnDataProperties(value) {
    const copy = {};
    for (const key of safeOwnKeys(value)) {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor && Object.hasOwn(descriptor, "value")) {
          Object.defineProperty(copy, key, {
            value: descriptor.value,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
      } catch {
        // Hostile accessors and proxies are never executed while merging cache.
      }
    }
    return copy;
  }

  function safeOwnValue(value, key) {
    if (!value || typeof value !== "object") return undefined;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && Object.hasOwn(descriptor, "value")
        ? descriptor.value
        : undefined;
    } catch {
      return undefined;
    }
  }

  function safeArrayLength(value) {
    try {
      if (!Array.isArray(value)) return 0;
      const length = safeOwnValue(value, "length");
      return Number.isSafeInteger(length) && length >= 0
        ? length
        : 0;
    } catch {
      return 0;
    }
  }

  function summarizeStoredData(all) {
    const summary = {
      settings: hasOwnKey(all, STORAGE_KEYS.settings) ? 1 : 0,
      providerStatus: hasOwnKey(all, STORAGE_KEYS.providerStatus) ? 1 : 0,
      digests: 0,
      translations: 0,
      notes: 0,
      vocabulary: 0,
    };
    const keys = safeOwnKeys(all);

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (!key.startsWith(DIGEST_PREFIX)) continue;
      summary.digests += 1;
      const digest = safeOwnValue(all, key);
      const paragraphCache = safeOwnValue(digest, "paragraphCache");
      summary.translations += safeOwnKeys(paragraphCache).length;
    }

    summary.notes = safeArrayLength(safeOwnValue(all, STORAGE_KEYS.notes));
    const vocabulary = safeOwnValue(all, STORAGE_KEYS.vocabulary);
    summary.vocabulary = safeArrayLength(safeOwnValue(vocabulary, "entries"));
    return summary;
  }

  function listResettableKeys(all) {
    return safeOwnKeys(all)
      .filter(
        (key) =>
          key !== STORAGE_KEYS.language && key !== STORAGE_KEYS.resetEpoch,
      )
      .sort();
  }

  function isExpectedEpoch(value) {
    return value === normalizeEpoch(value);
  }

  function staleResetResult() {
    return { success: false, code: "RESET_DURING_REQUEST" };
  }

  function nextEpoch(current) {
    return current === Number.MAX_SAFE_INTEGER ? null : current + 1;
  }

  function boundedResultKeys(keys) {
    return keys.slice(0, MAX_FAILURE_KEYS);
  }

  function digestWriteFailure(evictedKeys) {
    return {
      success: false,
      code: "STORAGE_WRITE_FAILED",
      retryable: true,
      evictedKeys: boundedResultKeys(evictedKeys),
    };
  }

  function digestQuotaFailure(evictedKeys) {
    return {
      success: false,
      code: "STORAGE_QUOTA_EXCEEDED",
      retryable: true,
      evictedKeys: boundedResultKeys(evictedKeys),
    };
  }

  function digestEvictionFailure(evictedKeys) {
    return {
      success: false,
      code: "DIGEST_EVICTION_FAILED",
      retryable: true,
      evictedKeys: boundedResultKeys(evictedKeys),
    };
  }

  function digestReadFailure(stage, evictedKeys = []) {
    return {
      success: false,
      code: "STORAGE_READ_FAILED",
      stage,
      retryable: true,
      evictedKeys: boundedResultKeys(evictedKeys),
    };
  }

  function digestEstimateFailure(stage, evictedKeys = []) {
    return {
      success: false,
      code: "DIGEST_ESTIMATE_FAILED",
      stage,
      retryable: false,
      evictedKeys: boundedResultKeys(evictedKeys),
    };
  }

  function digestSessionStaleFailure(evictedKeys = []) {
    return {
      success: false,
      code: "SESSION_STALE",
      retryable: false,
      evictedKeys: boundedResultKeys(evictedKeys),
    };
  }

  function estimateEntryBytes(key, value) {
    let serialized;
    try {
      serialized = JSON.stringify(value);
    } catch {
      throw new TypeError("Digest cache value must be JSON-serializable.");
    }
    if (typeof serialized !== "string") {
      throw new TypeError("Digest cache value must be JSON-serializable.");
    }
    const encoder = new TextEncoder();
    return (
      encoder.encode(key).byteLength + encoder.encode(serialized).byteLength
    );
  }

  function digestTimestamp(value) {
    for (const field of ["timestamp", "updatedAt", "createdAt"]) {
      const candidate = safeOwnValue(value, field);
      if (Number.isFinite(candidate) && candidate >= 0) return candidate;
    }
    return 0;
  }

  function compareKeys(left, right) {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }

  function orderedDigestEntries(all) {
    return safeOwnKeys(all)
      .filter((key) => key.startsWith(DIGEST_PREFIX))
      .map((key) => ({
        key,
        value: safeOwnValue(all, key),
        timestamp: digestTimestamp(safeOwnValue(all, key)),
      }))
      .sort(
        (left, right) =>
          left.timestamp - right.timestamp || compareKeys(left.key, right.key),
      );
  }

  function makeDigestKey(videoId) {
    const normalized = typeof videoId === "string" ? videoId.trim() : "";
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(normalized)) {
      throw new TypeError("Invalid YouTube video ID.");
    }
    return `${DIGEST_PREFIX}${normalized}`;
  }

  function normalizeOverviewFingerprint(value) {
    const fingerprint = typeof value === "string" ? value.trim() : "";
    if (!/^sha256-v1-[a-f0-9]{64}$/.test(fingerprint)) {
      throw new TypeError("Invalid overview transcript fingerprint.");
    }
    return fingerprint;
  }

  function normalizeOverviewAttemptId(value) {
    const attemptId = typeof value === "string" ? value.trim() : "";
    if (!/^[A-Za-z0-9:_-]{1,160}$/.test(attemptId)) {
      throw new TypeError("Invalid overview attempt ID.");
    }
    return attemptId;
  }

  function normalizeOverviewAttemptRevision(value) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError("Invalid overview attempt revision.");
    }
    return value;
  }

  function normalizeOverviewIntent(value) {
    if (value !== "automatic" && value !== "manual_retry") {
      throw new TypeError("Invalid overview claim intent.");
    }
    return value;
  }

  function makeOverviewAttemptKey(videoId, transcriptFingerprint) {
    const digestKey = makeDigestKey(videoId);
    const normalizedVideoId = digestKey.slice(DIGEST_PREFIX.length);
    const fingerprint = normalizeOverviewFingerprint(transcriptFingerprint);
    return `${OVERVIEW_ATTEMPT_PREFIX}${normalizedVideoId}_${fingerprint}`;
  }

  function parseOverviewAttemptKey(key) {
    if (typeof key !== "string" || !key.startsWith(OVERVIEW_ATTEMPT_PREFIX)) {
      return null;
    }
    const suffix = key.slice(OVERVIEW_ATTEMPT_PREFIX.length);
    const separator = suffix.lastIndexOf("_sha256-v1-");
    if (separator < 1) return null;
    const videoId = suffix.slice(0, separator);
    const transcriptFingerprint = suffix.slice(separator + 1);
    try {
      if (makeOverviewAttemptKey(videoId, transcriptFingerprint) !== key) {
        return null;
      }
      return { videoId, transcriptFingerprint };
    } catch {
      return null;
    }
  }

  function normalizeOverviewIdentity(
    value,
    { requireIntent = false, requireRevision = false } = {},
  ) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Overview transaction identity is required.");
    }
    const digestKey = makeDigestKey(safeOwnValue(value, "videoId"));
    const videoId = digestKey.slice(DIGEST_PREFIX.length);
    const transcriptFingerprint = normalizeOverviewFingerprint(
      safeOwnValue(value, "transcriptFingerprint"),
    );
    const attemptId = normalizeOverviewAttemptId(
      safeOwnValue(value, "attemptId"),
    );
    const identity = {
      videoId,
      digestKey,
      transcriptFingerprint,
      attemptId,
      attemptKey: makeOverviewAttemptKey(videoId, transcriptFingerprint),
    };
    if (requireIntent) {
      identity.intent = normalizeOverviewIntent(safeOwnValue(value, "intent"));
    }
    if (requireRevision) {
      identity.attemptRevision = normalizeOverviewAttemptRevision(
        safeOwnValue(value, "attemptRevision"),
      );
    }
    return identity;
  }

  function safeTimestamp(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  function ownDataDescriptor(value, key) {
    if (!value || typeof value !== "object") return null;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && Object.hasOwn(descriptor, "value")
        ? descriptor
        : null;
    } catch {
      return null;
    }
  }

  function snapshotDigestData(value, label = "digest data") {
    const seen = new WeakSet();
    let propertyCount = 0;

    const copy = (current, depth) => {
      if (
        current === null ||
        typeof current === "string" ||
        typeof current === "boolean"
      ) {
        return current;
      }
      if (typeof current === "number" && Number.isFinite(current)) {
        return current;
      }
      if (!current || typeof current !== "object") {
        throw new TypeError(`Invalid ${label}.`);
      }
      if (depth > DIGEST_DATA_MAX_DEPTH || seen.has(current)) {
        throw new TypeError(`Invalid ${label}.`);
      }
      seen.add(current);
      let isArray;
      let prototype;
      try {
        isArray = Array.isArray(current);
        prototype = Object.getPrototypeOf(current);
      } catch {
        throw new TypeError(`Invalid ${label}.`);
      }
      if (
        (!isArray && prototype !== Object.prototype && prototype !== null) ||
        (isArray && prototype !== Array.prototype)
      ) {
        throw new TypeError(`Invalid ${label}.`);
      }

      if (isArray) {
        const lengthDescriptor = ownDataDescriptor(current, "length");
        const length = lengthDescriptor?.value;
        if (!Number.isSafeInteger(length) || length < 0) {
          throw new TypeError(`Invalid ${label}.`);
        }
        propertyCount += length;
        if (propertyCount > DIGEST_DATA_MAX_PROPERTIES) {
          throw new TypeError(`Invalid ${label}.`);
        }
        const result = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = ownDataDescriptor(current, String(index));
          if (!descriptor) throw new TypeError(`Invalid ${label}.`);
          result.push(copy(descriptor.value, depth + 1));
        }
        seen.delete(current);
        return result;
      }

      let keys;
      try {
        keys = Object.keys(current);
      } catch {
        throw new TypeError(`Invalid ${label}.`);
      }
      propertyCount += keys.length;
      if (propertyCount > DIGEST_DATA_MAX_PROPERTIES) {
        throw new TypeError(`Invalid ${label}.`);
      }
      const result = {};
      for (const key of keys) {
        if (key === "__proto__" || key === "prototype" || key === "constructor") {
          throw new TypeError(`Invalid ${label}.`);
        }
        const descriptor = ownDataDescriptor(current, key);
        if (!descriptor) throw new TypeError(`Invalid ${label}.`);
        Object.defineProperty(result, key, {
          value: copy(descriptor.value, depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      seen.delete(current);
      return result;
    };

    const snapshot = copy(value, 0);
    let serialized;
    try {
      serialized = JSON.stringify(snapshot);
    } catch {
      throw new TypeError(`Invalid ${label}.`);
    }
    if (
      typeof serialized !== "string" ||
      new TextEncoder().encode(serialized).byteLength > DIGEST_DATA_MAX_BYTES
    ) {
      throw new TypeError(`Invalid ${label}.`);
    }
    return snapshot;
  }

  function requiredDigestBaseValue(value, key) {
    const descriptor = ownDataDescriptor(value, key);
    if (!descriptor) throw new TypeError(`Invalid digest base ${key}.`);
    return descriptor.value;
  }

  function normalizeParagraphCache(
    value,
    videoId,
    transcriptFingerprint,
    { strict = true, allowEmpty = true } = {},
  ) {
    const normalized = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      if (strict) throw new TypeError("Invalid digest paragraph cache.");
      return normalized;
    }
    let keys;
    try {
      keys = Object.keys(value);
    } catch {
      if (strict) throw new TypeError("Invalid digest paragraph cache.");
      return normalized;
    }
    if (keys.length > PARAGRAPH_CACHE_MAX_ENTRIES) {
      if (strict) throw new TypeError("Invalid digest paragraph cache.");
      return normalized;
    }
    if (!allowEmpty && keys.length === 0) {
      throw new TypeError("Invalid digest paragraph cache.");
    }
    const prefix = `${videoId}:${transcriptFingerprint}:`;
    for (const key of keys) {
      const descriptor = ownDataDescriptor(value, key);
      const candidate = descriptor?.value;
      const valid =
        descriptor &&
        key.startsWith(prefix) &&
        key.length <= PARAGRAPH_CACHE_MAX_KEY_CHARS &&
        typeof candidate === "string" &&
        candidate.trim() &&
        candidate.length <= PARAGRAPH_CACHE_MAX_VALUE_CHARS;
      if (!valid) {
        if (strict) throw new TypeError("Invalid digest paragraph cache.");
        continue;
      }
      Object.defineProperty(normalized, key, {
        value: candidate,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    try {
      snapshotDigestData(normalized, "digest paragraph cache");
    } catch (error) {
      if (strict) throw error;
      return {};
    }
    return normalized;
  }

  function normalizeLegacyMigrationContext(value) {
    if (value === undefined) return { canonicalSegmentIds: [] };
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Invalid digest legacy migration context.");
    }
    let keys;
    try {
      keys = Object.keys(value);
    } catch {
      throw new TypeError("Invalid digest legacy migration context.");
    }
    if (keys.length !== 1 || keys[0] !== "canonicalSegmentIds") {
      throw new TypeError("Invalid digest legacy migration context.");
    }
    const idsDescriptor = ownDataDescriptor(value, "canonicalSegmentIds");
    const ids = idsDescriptor?.value;
    if (!Array.isArray(ids)) {
      throw new TypeError("Invalid digest legacy migration context.");
    }
    const lengthDescriptor = ownDataDescriptor(ids, "length");
    const length = lengthDescriptor?.value;
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > DIGEST_DATA_MAX_PROPERTIES
    ) {
      throw new TypeError("Invalid digest legacy migration context.");
    }
    const unique = new Set();
    const canonicalSegmentIds = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = ownDataDescriptor(ids, String(index));
      const id = descriptor?.value;
      if (
        typeof id !== "string" ||
        !/^[A-Za-z0-9_-]{1,160}$/.test(id) ||
        unique.has(id)
      ) {
        throw new TypeError("Invalid digest legacy migration context.");
      }
      unique.add(id);
      canonicalSegmentIds.push(id);
    }
    let serialized;
    try {
      serialized = JSON.stringify(canonicalSegmentIds);
    } catch {
      throw new TypeError("Invalid digest legacy migration context.");
    }
    if (
      typeof serialized !== "string" ||
      new TextEncoder().encode(serialized).byteLength > DIGEST_DATA_MAX_BYTES
    ) {
      throw new TypeError("Invalid digest legacy migration context.");
    }
    return { canonicalSegmentIds };
  }

  function migrateLegacyParagraphCache(
    value,
    videoId,
    transcriptFingerprint,
    canonicalSegmentIds,
  ) {
    const migrated = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return migrated;
    }
    let keys;
    try {
      keys = Object.keys(value);
    } catch {
      return migrated;
    }
    if (keys.length > PARAGRAPH_CACHE_MAX_ENTRIES) return migrated;
    const canonicalIds = new Set(canonicalSegmentIds);
    const legacyPrefix = `${videoId}:zh:semantic:`;
    for (const legacyKey of keys) {
      if (!legacyKey.startsWith(legacyPrefix)) continue;
      const segmentId = legacyKey.slice(legacyPrefix.length);
      if (!canonicalIds.has(segmentId)) continue;
      const currentKey =
        `${videoId}:${transcriptFingerprint}:zh:semantic:${segmentId}`;
      const candidate = ownDataDescriptor(value, legacyKey)?.value;
      if (
        typeof candidate !== "string" ||
        !candidate.trim() ||
        candidate.length > PARAGRAPH_CACHE_MAX_VALUE_CHARS ||
        currentKey.length > PARAGRAPH_CACHE_MAX_KEY_CHARS
      ) continue;
      Object.defineProperty(migrated, currentKey, {
        value: candidate,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    try {
      return normalizeParagraphCache(
        migrated,
        videoId,
        transcriptFingerprint,
      );
    } catch {
      return {};
    }
  }

  function resolveStoredDigestLanguage(value) {
    const topLevel = safeOwnValue(value, "transcriptLanguage");
    const normalizedTop =
      typeof topLevel === "string" ? topLevel.trim() : "";
    if (normalizedTop) return normalizedTop;
    const transcript = safeOwnValue(value, "transcript");
    if (!Array.isArray(transcript)) return null;
    const length = safeOwnValue(transcript, "length");
    if (!Number.isSafeInteger(length) || length < 0) return null;
    for (let index = 0; index < length; index += 1) {
      const entry = safeOwnValue(transcript, String(index));
      const language = safeOwnValue(entry, "language");
      const normalized =
        typeof language === "string" ? language.trim() : "";
      if (normalized) return normalized;
    }
    return null;
  }

  function boundedDigestString(value, maxChars, { empty = false } = {}) {
    return typeof value === "string" &&
      value.length <= maxChars &&
      (empty || value.trim())
      ? value
      : null;
  }

  function normalizeDigestLanguage(value) {
    if (value === null) return null;
    if (typeof value !== "string") {
      throw new TypeError("Invalid digest base transcriptLanguage.");
    }
    return value.trim() || null;
  }

  function snapshotBasicOverview(value, fingerprint, now) {
    let snapshot;
    try {
      snapshot = snapshotDigestData(value, "basic overview cache");
    } catch {
      return null;
    }
    const generatedAt = safeTimestamp(safeOwnValue(snapshot, "generatedAt"));
    const oneSentenceZh = boundedDigestString(
      safeOwnValue(snapshot, "oneSentenceZh"),
      300,
    );
    const conclusions = safeOwnValue(snapshot, "conclusions");
    const chapters = safeOwnValue(snapshot, "chapters");
    const complete = safeOwnValue(snapshot, "complete");
    if (
      safeOwnValue(snapshot, "schemaVersion") !== 1 ||
      safeOwnValue(snapshot, "transcriptFingerprint") !== fingerprint ||
      generatedAt === null ||
      generatedAt > now ||
      !oneSentenceZh ||
      !Array.isArray(conclusions) ||
      conclusions.length > 5 ||
      !Array.isArray(chapters) ||
      chapters.length > 40 ||
      typeof complete !== "boolean"
    ) {
      return null;
    }
    const normalizedConclusions = [];
    for (const conclusion of conclusions) {
      const id = boundedDigestString(safeOwnValue(conclusion, "id"), 160);
      const titleZh = boundedDigestString(
        safeOwnValue(conclusion, "titleZh"),
        240,
      );
      const explanationZh = boundedDigestString(
        safeOwnValue(conclusion, "explanationZh"),
        1_200,
      );
      const evidenceLevel = safeOwnValue(conclusion, "evidenceLevel");
      const evidenceSegmentIds = safeOwnValue(
        conclusion,
        "evidenceSegmentIds",
      );
      if (
        !id ||
        !titleZh ||
        !explanationZh ||
        !["strong", "partial", "insufficient"].includes(evidenceLevel) ||
        !Array.isArray(evidenceSegmentIds) ||
        evidenceSegmentIds.length > 3
      ) {
        return null;
      }
      const normalizedIds = [];
      for (const segmentId of evidenceSegmentIds) {
        const normalizedId = boundedDigestString(segmentId, 160);
        if (!normalizedId) return null;
        normalizedIds.push(normalizedId);
      }
      normalizedConclusions.push({
        id,
        titleZh,
        explanationZh,
        evidenceLevel,
        evidenceSegmentIds: normalizedIds,
      });
    }
    const normalizedChapters = [];
    for (const chapter of chapters) {
      const titleZh = boundedDigestString(
        safeOwnValue(chapter, "titleZh"),
        240,
      );
      const summaryZh = boundedDigestString(
        safeOwnValue(chapter, "summaryZh"),
        1_000,
        { empty: true },
      );
      const startSegmentId = boundedDigestString(
        safeOwnValue(chapter, "startSegmentId"),
        160,
      );
      const timestampSeconds = safeOwnValue(chapter, "timestampSeconds");
      if (
        !titleZh ||
        summaryZh === null ||
        !startSegmentId ||
        !Number.isFinite(timestampSeconds) ||
        timestampSeconds < 0
      ) {
        return null;
      }
      normalizedChapters.push({
        titleZh,
        summaryZh,
        startSegmentId,
        timestampSeconds,
      });
    }
    return {
      schemaVersion: 1,
      transcriptFingerprint: fingerprint,
      generatedAt,
      oneSentenceZh,
      conclusions: normalizedConclusions,
      chapters: normalizedChapters,
      complete,
    };
  }

  function snapshotDeepAnalysis(value) {
    if (value === null) return { valid: true, value: null };
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { valid: false };
    }
    let snapshot;
    try {
      snapshot = snapshotDigestData(value, "deep analysis cache");
    } catch {
      return { valid: false };
    }
    return { valid: true, value: snapshot };
  }

  function normalizeDigestBaseInput(value, videoId) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Invalid digest base value.");
    }
    const transcriptFingerprint = normalizeOverviewFingerprint(
      requiredDigestBaseValue(value, "transcriptFingerprint"),
    );
    const transcript = snapshotDigestData(
      requiredDigestBaseValue(value, "transcript"),
      "digest base transcript",
    );
    if (!Array.isArray(transcript)) {
      throw new TypeError("Invalid digest base transcript.");
    }
    const stringFields = [
      "transcriptText",
      "transcriptTimestamped",
      "videoTitle",
      "channelName",
    ];
    const normalized = { transcript, transcriptFingerprint };
    for (const key of stringFields) {
      const candidate = requiredDigestBaseValue(value, key);
      if (typeof candidate !== "string") {
        throw new TypeError(`Invalid digest base ${key}.`);
      }
      normalized[key] = candidate;
    }
    const transcriptLanguage = requiredDigestBaseValue(
      value,
      "transcriptLanguage",
    );
    normalized.transcriptLanguage = normalizeDigestLanguage(
      transcriptLanguage,
    );

    snapshotDigestData(
      {
        transcript: normalized.transcript,
        transcriptText: normalized.transcriptText,
        transcriptTimestamped: normalized.transcriptTimestamped,
        transcriptLanguage: normalized.transcriptLanguage,
        transcriptFingerprint: normalized.transcriptFingerprint,
        videoTitle: normalized.videoTitle,
        channelName: normalized.channelName,
      },
      "digest base input",
    );
    return normalized;
  }

  function normalizeDigestPatchInput(
    value,
    videoId,
    transcriptFingerprint,
  ) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Invalid digest patch value.");
    }
    let keys;
    try {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("Invalid digest patch value.");
      }
      keys = Object.keys(value);
    } catch {
      throw new TypeError("Invalid digest patch value.");
    }
    if (
      !keys.length ||
      keys.some(
        (key) => key !== "deepAnalysis" && key !== "paragraphCache",
      )
    ) {
      throw new TypeError("Invalid digest patch fields.");
    }

    const normalized = {
      hasDeepAnalysis: false,
      deepAnalysis: undefined,
      paragraphDelta: null,
    };
    if (keys.includes("deepAnalysis")) {
      const descriptor = ownDataDescriptor(value, "deepAnalysis");
      if (!descriptor || descriptor.value === undefined) {
        throw new TypeError("Invalid digest patch deep analysis.");
      }
      const deep = snapshotDeepAnalysis(descriptor.value);
      if (!deep.valid) {
        throw new TypeError("Invalid digest patch deep analysis.");
      }
      normalized.hasDeepAnalysis = true;
      normalized.deepAnalysis = deep.value;
    }
    if (keys.includes("paragraphCache")) {
      const descriptor = ownDataDescriptor(value, "paragraphCache");
      if (!descriptor) {
        throw new TypeError("Invalid digest patch paragraph cache.");
      }
      try {
        normalized.paragraphDelta = normalizeParagraphCache(
          descriptor.value,
          videoId,
          transcriptFingerprint,
          { allowEmpty: false },
        );
      } catch {
        throw new TypeError("Invalid digest patch paragraph cache.");
      }
    }

    const aggregate = {};
    if (normalized.hasDeepAnalysis) {
      aggregate.deepAnalysis = normalized.deepAnalysis;
    }
    if (normalized.paragraphDelta) {
      aggregate.paragraphCache = normalized.paragraphDelta;
    }
    snapshotDigestData(aggregate, "digest patch input");
    return normalized;
  }

  function snapshotStoredDigestBase(value, videoId) {
    const base = {};
    for (const key of [
      "transcript",
      "transcriptText",
      "transcriptTimestamped",
      "transcriptLanguage",
      "transcriptFingerprint",
      "videoTitle",
      "channelName",
    ]) {
      const descriptor = ownDataDescriptor(value, key);
      if (!descriptor) return null;
      Object.defineProperty(base, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    try {
      return normalizeDigestBaseInput(base, videoId);
    } catch {
      return null;
    }
  }

  function digestDataEqual(left, right) {
    const canonicalLanguage = (value) => {
      if (value === undefined || value === null) return null;
      if (typeof value !== "string") {
        throw new TypeError("Invalid caption language.");
      }
      return value.trim() || null;
    };
    const exactEntries = (value, label) => {
      if (!Array.isArray(value)) throw new TypeError(`Invalid ${label}.`);
      const lengthDescriptor = ownDataDescriptor(value, "length");
      const length = lengthDescriptor?.value;
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > DIGEST_DATA_MAX_PROPERTIES
      ) {
        throw new TypeError(`Invalid ${label}.`);
      }
      const entries = [];
      let inputUnits = 0;
      for (let index = 0; index < length; index += 1) {
        const entryDescriptor = ownDataDescriptor(value, String(index));
        const entry = entryDescriptor?.value;
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          throw new TypeError(`Invalid ${label}.`);
        }
        const textDescriptor = ownDataDescriptor(entry, "text");
        const startDescriptor = ownDataDescriptor(entry, "start");
        const durationDescriptor = ownDataDescriptor(entry, "duration");
        const hasLanguage = hasOwnKey(entry, "language");
        const languageDescriptor = ownDataDescriptor(entry, "language");
        if (
          !textDescriptor ||
          !startDescriptor ||
          !durationDescriptor ||
          (hasLanguage && !languageDescriptor)
        ) {
          throw new TypeError(`Invalid ${label}.`);
        }
        const rawText = textDescriptor.value;
        if (typeof rawText !== "string") {
          throw new TypeError(`Invalid ${label}.`);
        }
        const rawStart = startDescriptor.value;
        const rawDuration = durationDescriptor.value;
        if (
          typeof rawStart !== "number" ||
          !Number.isFinite(rawStart) ||
          rawStart < 0 ||
          typeof rawDuration !== "number" ||
          !Number.isFinite(rawDuration) ||
          rawDuration < 0
        ) {
          throw new TypeError(`Invalid ${label}.`);
        }
        const language = canonicalLanguage(languageDescriptor?.value);
        inputUnits += rawText.length + (language?.length || 0);
        if (inputUnits > DIGEST_DATA_MAX_BYTES) {
          throw new TypeError(`Invalid ${label}.`);
        }
        entries.push({
          text: rawText,
          start: rawStart,
          duration: rawDuration,
          language,
        });
      }
      return entries;
    };
    try {
      const leftEntries = exactEntries(
        left,
        "stored digest transcript",
      );
      const rightEntries = exactEntries(
        right,
        "incoming digest transcript",
      );
      return Boolean(
        leftEntries.length === rightEntries.length &&
          leftEntries.every((entry, index) => {
            const other = rightEntries[index];
            return Boolean(
              entry.text === other.text &&
                entry.start === other.start &&
                entry.duration === other.duration &&
                entry.language === other.language,
            );
          })
      );
    } catch {
      return false;
    }
  }

  function canonicalOverviewFailure(value) {
    const rawCode = safeOwnValue(value, "code");
    const code = OVERVIEW_FAILURE_CODES.has(rawCode)
      ? rawCode
      : "UNKNOWN_PROVIDER_ERROR";
    const defaults = OVERVIEW_FAILURE_DEFAULTS[code];
    return {
      code,
      provider: "deepseek",
      stage: "overview",
      retryable: defaults.retryable,
      primaryAction: defaults.primaryAction,
      mayHaveConsumedCredit:
        safeOwnValue(value, "mayHaveConsumedCredit") === true,
    };
  }

  function isCanonicalOverviewFailure(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const normalized = canonicalOverviewFailure(value);
    return (
      safeOwnValue(value, "code") === normalized.code &&
      safeOwnValue(value, "provider") === normalized.provider &&
      safeOwnValue(value, "stage") === normalized.stage &&
      safeOwnValue(value, "retryable") === normalized.retryable &&
      safeOwnValue(value, "primaryAction") === normalized.primaryAction &&
      safeOwnValue(value, "mayHaveConsumedCredit") ===
        normalized.mayHaveConsumedCredit
    );
  }

  function parseOverviewAttemptRecord(value, identity) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const firstClaimedAt = safeTimestamp(
      safeOwnValue(value, "firstClaimedAt"),
    );
    const expiresAt = safeTimestamp(safeOwnValue(value, "expiresAt"));
    const currentAttempt = safeOwnValue(value, "currentAttempt");
    if (
      safeOwnValue(value, "schemaVersion") !== 1 ||
      safeOwnValue(value, "videoId") !== identity.videoId ||
      safeOwnValue(value, "transcriptFingerprint") !==
        identity.transcriptFingerprint ||
      firstClaimedAt === null ||
      expiresAt === null ||
      expiresAt !== firstClaimedAt + OVERVIEW_ATTEMPT_TTL_MS ||
      !currentAttempt ||
      typeof currentAttempt !== "object" ||
      Array.isArray(currentAttempt)
    ) {
      return null;
    }

    let id;
    let intent;
    try {
      id = normalizeOverviewAttemptId(safeOwnValue(currentAttempt, "id"));
      intent = normalizeOverviewIntent(safeOwnValue(currentAttempt, "intent"));
    } catch {
      return null;
    }
    const status = safeOwnValue(currentAttempt, "status");
    const revision = safeOwnValue(currentAttempt, "revision");
    const resetEpoch = safeOwnValue(currentAttempt, "resetEpoch");
    const claimedAt = safeTimestamp(safeOwnValue(currentAttempt, "claimedAt"));
    const leaseUntil = safeTimestamp(safeOwnValue(currentAttempt, "leaseUntil"));
    if (
      !["claimed", "succeeded", "failed"].includes(status) ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      !isExpectedEpoch(resetEpoch) ||
      claimedAt === null ||
      leaseUntil === null ||
      leaseUntil !== claimedAt + OVERVIEW_CLAIM_LEASE_MS ||
      claimedAt < firstClaimedAt ||
      claimedAt >= expiresAt
    ) {
      return null;
    }

    const parsedAttempt = {
      id,
      revision,
      intent,
      status,
      resetEpoch,
      claimedAt,
      leaseUntil,
    };
    if (status !== "claimed") {
      const finishedAt = safeTimestamp(
        safeOwnValue(currentAttempt, "finishedAt"),
      );
      if (finishedAt === null || finishedAt < claimedAt) return null;
      parsedAttempt.finishedAt = finishedAt;
    }
    if (status === "succeeded") {
      const generatedAt = safeTimestamp(
        safeOwnValue(currentAttempt, "generatedAt"),
      );
      if (
        generatedAt === null ||
        generatedAt < claimedAt ||
        generatedAt > parsedAttempt.finishedAt
      ) {
        return null;
      }
      parsedAttempt.generatedAt = generatedAt;
    }
    if (status === "failed") {
      const failure = safeOwnValue(currentAttempt, "failure");
      if (!isCanonicalOverviewFailure(failure)) return null;
      parsedAttempt.failure = canonicalOverviewFailure(failure);
    }

    return {
      schemaVersion: 1,
      videoId: identity.videoId,
      transcriptFingerprint: identity.transcriptFingerprint,
      firstClaimedAt,
      expiresAt,
      currentAttempt: parsedAttempt,
    };
  }

  function corruptOverviewRecordIsActive(value, now) {
    const expiresAt = safeTimestamp(safeOwnValue(value, "expiresAt"));
    const currentAttempt = safeOwnValue(value, "currentAttempt");
    const leaseUntil = safeTimestamp(safeOwnValue(currentAttempt, "leaseUntil"));
    return (
      expiresAt === null ||
      expiresAt > now ||
      (leaseUntil !== null && leaseUntil > now)
    );
  }

  function digestMatchesOverviewContext(value, fingerprint, now) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    if (
      safeOwnValue(value, "digestSchemaVersion") !== DIGEST_SCHEMA_VERSION
    ) return false;
    if (safeOwnValue(value, "transcriptFingerprint") !== fingerprint) return false;
    const timestamp = safeTimestamp(safeOwnValue(value, "timestamp"));
    return (
      timestamp !== null &&
      timestamp <= now &&
      now - timestamp < OVERVIEW_ATTEMPT_TTL_MS
    );
  }

  function inspectOverviewClaim(
    stored,
    identity,
    expectedEpoch,
    transactionNow,
  ) {
    const digest = safeOwnValue(stored, identity.digestKey);
    const digestMatches = digestMatchesOverviewContext(
      digest,
      identity.transcriptFingerprint,
      transactionNow,
    );
    const cachedOverview = digestMatches
      ? snapshotBasicOverview(
          safeOwnValue(digest, "basicOverview"),
          identity.transcriptFingerprint,
          transactionNow,
        )
      : null;
    if (
      digestMatches &&
      cachedOverview
    ) {
      return {
        result: {
          success: true,
          disposition: "cached",
          overview: cachedOverview,
        },
      };
    }

    const recordExists = hasOwnKey(stored, identity.attemptKey);
    const rawRecord = safeOwnValue(stored, identity.attemptKey);
    const parsedRecord = recordExists
      ? parseOverviewAttemptRecord(rawRecord, identity)
      : null;
    if (
      recordExists &&
      !parsedRecord &&
      corruptOverviewRecordIsActive(rawRecord, transactionNow)
    ) {
      return {
        result: {
          success: false,
          code: "OVERVIEW_ATTEMPT_CORRUPT",
          retryable: false,
        },
      };
    }
    let recoverableMalformedRevision = 0;
    if (recordExists && !parsedRecord) {
      const rawAttempt = safeOwnValue(rawRecord, "currentAttempt");
      const rawRevision = safeOwnValue(rawAttempt, "revision");
      if (!Number.isSafeInteger(rawRevision) || rawRevision < 1) {
        return {
          result: {
            success: false,
            code: "OVERVIEW_ATTEMPT_CORRUPT",
            retryable: false,
          },
        };
      }
      recoverableMalformedRevision = rawRevision;
    }

    const parsedRecordHasActiveLease = Boolean(
      parsedRecord?.currentAttempt.status === "claimed" &&
        parsedRecord.currentAttempt.leaseUntil > transactionNow,
    );
    const parsedRecordWithinWindow = Boolean(
      parsedRecord?.expiresAt > transactionNow,
    );
    const epochMismatch = Boolean(
      parsedRecord && parsedRecord.currentAttempt.resetEpoch !== expectedEpoch,
    );
    if (
      epochMismatch &&
      (parsedRecordWithinWindow || parsedRecordHasActiveLease)
    ) {
      return {
        result: {
          success: false,
          code: "OVERVIEW_ATTEMPT_CORRUPT",
          retryable: false,
        },
      };
    }
    if (
      parsedRecord &&
      (transactionNow < parsedRecord.firstClaimedAt ||
        transactionNow < parsedRecord.currentAttempt.claimedAt)
    ) {
      return {
        result: {
          success: false,
          code: "OVERVIEW_CLOCK_INVALID",
          retryable: false,
        },
      };
    }
    const usableRecord = epochMismatch ? null : parsedRecord;
    const hasActiveLease = epochMismatch
      ? false
      : parsedRecordHasActiveLease;
    const withinWindow = epochMismatch
      ? false
      : parsedRecordWithinWindow;
    if (usableRecord && (withinWindow || hasActiveLease)) {
      const attempt = usableRecord.currentAttempt;
      const attemptIdentity = {
        attemptId: attempt.id,
        attemptRevision: attempt.revision,
      };
      if (attempt.status === "claimed") {
        if (hasActiveLease) {
          return {
            result: {
              success: true,
              disposition: "inflight",
              ...attemptIdentity,
              retryAfterMs: Math.max(
                0,
                Math.min(
                  OVERVIEW_CLAIM_LEASE_MS,
                  attempt.leaseUntil - transactionNow,
                ),
              ),
            },
          };
        }
        if (identity.intent === "automatic") {
          return {
            result: {
              success: true,
              disposition: "interrupted",
              ...attemptIdentity,
            },
          };
        }
      } else if (attempt.status === "failed") {
        if (identity.intent === "automatic") {
          return {
            result: {
              success: true,
              disposition: "failed",
              ...attemptIdentity,
              failure: attempt.failure,
            },
          };
        }
      } else if (identity.intent === "automatic") {
        return {
          result: {
            success: true,
            disposition: "result_missing",
            ...attemptIdentity,
          },
        };
      }
    }

    if (!digestMatches) {
      return {
        result: {
          success: false,
          code: "OVERVIEW_DIGEST_CONTEXT_MISSING",
          retryable: false,
        },
      };
    }

    return {
      record: withinWindow ? usableRecord : null,
      priorRevision:
        parsedRecord?.currentAttempt.revision ?? recoverableMalformedRevision,
    };
  }

  function isQuotaError(error) {
    if (!error || (typeof error !== "object" && typeof error !== "string")) {
      return false;
    }
    try {
      const text = [
        typeof error === "string" ? error : "",
        error.name,
        error.code,
        error.message,
      ]
        .filter((value) => typeof value === "string")
        .join(" ")
        .slice(0, 512);
      return (
        /(?:QuotaExceededError|QUOTA_BYTES(?:_PER_ITEM)?|MAX_(?:WRITE|SUSTAINED_WRITE|ITEMS))/i.test(
          text,
        ) ||
        /\bquota\b.{0,48}\b(?:exceed\w*|exhaust\w*|limit(?:ed)?|full)\b/i.test(
          text,
        ) ||
        /\b(?:exceed\w*|exhaust\w*)\b.{0,48}\bquota\b/i.test(text) ||
        /\bstorage\s+(?:is\s+)?full\b/i.test(text)
      );
    } catch {
      return false;
    }
  }

  async function measureDigestEntries(storage, entries) {
    if (typeof storage.getBytesInUse === "function") {
      try {
        const measured = new Map();
        for (
          let offset = 0;
          offset < entries.length;
          offset += BYTE_MEASUREMENT_CONCURRENCY
        ) {
          const batch = entries.slice(
            offset,
            offset + BYTE_MEASUREMENT_CONCURRENCY,
          );
          const results = await Promise.all(
            batch.map(async (entry) => ({
              key: entry.key,
              bytes: await storage.getBytesInUse([entry.key]),
            })),
          );
          for (const result of results) {
            if (!Number.isSafeInteger(result.bytes) || result.bytes < 0) {
              throw new TypeError("Invalid storage byte measurement.");
            }
            measured.set(result.key, result.bytes);
          }
        }
        return measured;
      } catch {
        // Some extension contexts omit or reject getBytesInUse. The fallback is
        // deterministic and counts UTF-8 bytes, not JavaScript code units.
      }
    }

    return new Map(
      entries.map((entry) => [
        entry.key,
        estimateEntryBytes(entry.key, entry.value),
      ]),
    );
  }

  /**
   * Creates one FIFO mutation coordinator for the background worker.
   *
   * Integration contract: create exactly one top-level instance; route every
   * extension mutation through it; mutation callbacks may use only the passed
   * storage object, must return/await every storage promise, and must never call
   * this coordinator. commitCurrent claims one queue slot for both its durable
   * epoch read and operation, so a later request cannot enter between them.
   * Browser MV3 has no AsyncContext, so runtime enforcement
   * reliably rejects reentry during the callback's synchronous dynamic extent
   * (including an async callback before its first suspension). Reentry after a
   * later await remains forbidden by contract so normal external concurrency can
   * continue to queue instead of being falsely rejected.
   *
   * A scoped digest clear must use this same FIFO, advance the durable reset
   * epoch, remove both the digest and every matching overview-attempt ledger,
   * and verify both removals before reporting success. The epoch advance is what
   * prevents a late settlement from matching a revision recreated after clear.
   * Overview callers must pass the coordinator-issued attemptRevision back with
   * attemptId when settling; UI or panel input must never choose that revision.
   * Claim validators are authority checks: they must be idempotent because a
   * candidate claim can invoke them twice around its final durable state read.
   */
  function createMutationCoordinator(storage, { now = Date.now } = {}) {
    if (
      !storage ||
      typeof storage.get !== "function" ||
      typeof storage.set !== "function" ||
      typeof storage.remove !== "function"
    ) {
      throw new TypeError("A Chrome-compatible local storage area is required.");
    }
    if (typeof now !== "function") {
      throw new TypeError("Overview transaction clock must be a function.");
    }

    let mutationQueue = Promise.resolve();
    let invokingOperation = false;
    const internalValidationFailureToken = Symbol("overviewValidationFailure");

    function currentTime() {
      const value = now();
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError("Overview transaction clock returned an invalid time.");
      }
      return value;
    }

    function enqueue(operation) {
      const result = mutationQueue.then(operation, operation);
      mutationQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    }

    function invokeGuardedCallback(callback, ...args) {
      invokingOperation = true;
      try {
        return callback(...args);
      } finally {
        invokingOperation = false;
      }
    }

    function internalValidationFailure(code) {
      return { [internalValidationFailureToken]: code };
    }

    function reentrancyRejection() {
      if (!invokingOperation) return null;
      const error = new Error(
        "A mutation operation must not call its coordinator.",
      );
      error.code = "COORDINATOR_REENTRANCY_FORBIDDEN";
      return Promise.reject(error);
    }

    async function readEpoch() {
      const stored = await storage.get(STORAGE_KEYS.resetEpoch);
      return normalizeEpoch(safeOwnValue(stored, STORAGE_KEYS.resetEpoch));
    }

    function captureEpoch() {
      const rejection = reentrancyRejection();
      if (rejection) return rejection;
      return enqueue(readEpoch);
    }

    function commitCurrent(operation) {
      const rejection = reentrancyRejection();
      if (rejection) return rejection;
      if (typeof operation !== "function") {
        return Promise.reject(new TypeError("Mutation operation is required."));
      }
      return enqueue(async () => {
        await readEpoch();
        const pendingValue = invokeGuardedCallback(operation, storage);
        const value = await pendingValue;
        return { success: true, value };
      });
    }

    function commit(expectedEpoch, operation) {
      const rejection = reentrancyRejection();
      if (rejection) return rejection;
      if (typeof operation !== "function") {
        return Promise.reject(new TypeError("Mutation operation is required."));
      }
      return enqueue(async () => {
        const currentEpoch = await readEpoch();
        if (!isExpectedEpoch(expectedEpoch) || currentEpoch !== expectedEpoch) {
          return staleResetResult();
        }
        const pendingValue = invokeGuardedCallback(operation, storage);
        const value = await pendingValue;
        return { success: true, value };
      });
    }

    function resetExtensionData() {
      const rejection = reentrancyRejection();
      if (rejection) return rejection;
      return enqueue(async () => {
        let before;
        try {
          before = await storage.get(null);
        } catch {
          return {
            success: false,
            code: "RESET_STORAGE_FAILED",
            stage: "read_before",
          };
        }
        const summary = summarizeStoredData(before);
        const currentEpoch = normalizeEpoch(
          safeOwnValue(before, STORAGE_KEYS.resetEpoch),
        );
        const resetEpoch = nextEpoch(currentEpoch);
        if (resetEpoch === null) {
          return { success: false, code: "RESET_EPOCH_EXHAUSTED" };
        }
        const resettableKeys = listResettableKeys(before);

        try {
          await storage.set({ [STORAGE_KEYS.resetEpoch]: resetEpoch });
        } catch {
          return {
            success: false,
            code: "RESET_STORAGE_FAILED",
            stage: "write_epoch",
          };
        }
        if (resettableKeys.length) {
          try {
            await storage.remove(resettableKeys);
          } catch {
            return {
              success: false,
              code: "RESET_STORAGE_FAILED",
              stage: "remove_data",
              resetEpoch,
            };
          }
        }

        let after;
        try {
          after = await storage.get(null);
        } catch {
          return {
            success: false,
            code: "RESET_VERIFICATION_FAILED",
            stage: "verify",
            resetEpoch,
            remainingKeys: [],
          };
        }
        const remainingKeys = listResettableKeys(after);
        const persistedEpoch = safeOwnValue(after, STORAGE_KEYS.resetEpoch);
        if (
          !hasOwnKey(after, STORAGE_KEYS.resetEpoch) ||
          persistedEpoch !== resetEpoch ||
          remainingKeys.length
        ) {
          const verificationKeys = remainingKeys.slice();
          if (persistedEpoch !== resetEpoch) {
            verificationKeys.push(STORAGE_KEYS.resetEpoch);
          }
          verificationKeys.sort();
          return {
            success: false,
            code: "RESET_VERIFICATION_FAILED",
            resetEpoch,
            remainingKeys: verificationKeys.slice(0, MAX_VERIFICATION_KEYS),
          };
        }

        return { success: true, resetEpoch, summary };
      });
    }

    function clearDigestCache() {
      const rejection = reentrancyRejection();
      if (rejection) return rejection;
      return enqueue(async () => {
        let before;
        try {
          before = await storage.get(null);
        } catch {
          return { success: false, code: "STORAGE_READ_FAILED" };
        }
        const currentEpoch = normalizeEpoch(
          safeOwnValue(before, STORAGE_KEYS.resetEpoch),
        );
        const resetEpoch = nextEpoch(currentEpoch);
        if (resetEpoch === null) {
          return { success: false, code: "RESET_EPOCH_EXHAUSTED" };
        }
        const digestKeys = safeOwnKeys(before)
          .filter((key) => key.startsWith(DIGEST_PREFIX))
          .sort();
        const attemptKeys = safeOwnKeys(before)
          .filter((key) => key.startsWith(OVERVIEW_ATTEMPT_PREFIX))
          .sort();
        const targetKeys = [...digestKeys, ...attemptKeys].sort();

        try {
          await storage.set({ [STORAGE_KEYS.resetEpoch]: resetEpoch });
        } catch {
          return {
            success: false,
            code: "STORAGE_WRITE_FAILED",
            stage: "write_epoch",
          };
        }
        let removeFailed = false;
        if (targetKeys.length) {
          try {
            await storage.remove(targetKeys);
          } catch {
            removeFailed = true;
          }
        }

        let after;
        try {
          after = await storage.get(null);
        } catch {
          return {
            success: false,
            code: "STORAGE_READ_FAILED",
            stage: removeFailed ? "verify_after_remove_failure" : "verify",
            resetEpoch,
          };
        }
        const remainingKeys = safeOwnKeys(after)
          .filter(
            (key) =>
              key.startsWith(DIGEST_PREFIX) ||
              key.startsWith(OVERVIEW_ATTEMPT_PREFIX),
          )
          .sort();
        const persistedEpoch = safeOwnValue(after, STORAGE_KEYS.resetEpoch);
        const verificationKeys = remainingKeys.slice();
        if (persistedEpoch !== resetEpoch) {
          verificationKeys.push(STORAGE_KEYS.resetEpoch);
          verificationKeys.sort();
        }
        const remainingSet = new Set(remainingKeys);
        const removedCount = digestKeys.filter(
          (key) => !remainingSet.has(key),
        ).length;
        const removedAttemptCount = attemptKeys.filter(
          (key) => !remainingSet.has(key),
        ).length;
        if (removeFailed) {
          return {
            success: false,
            code: "STORAGE_WRITE_FAILED",
            stage: "remove_cache",
            resetEpoch,
            removedCount,
            removedAttemptCount,
            remainingCount: Math.min(
              verificationKeys.length,
              MAX_VERIFICATION_KEYS,
            ),
            remainingKeys: verificationKeys.slice(0, MAX_VERIFICATION_KEYS),
          };
        }
        if (
          persistedEpoch !== resetEpoch ||
          remainingKeys.length
        ) {
          return {
            success: false,
            code: "CLEAR_VERIFICATION_FAILED",
            resetEpoch,
            removedCount,
            removedAttemptCount,
            remainingCount: Math.min(
              verificationKeys.length,
              MAX_VERIFICATION_KEYS,
            ),
            remainingKeys: verificationKeys.slice(0, MAX_VERIFICATION_KEYS),
          };
        }
        return {
          success: true,
          resetEpoch,
          removedCount,
          removedAttemptCount,
        };
      });
    }

    function pruneExpiredOverviewAttempts() {
      const rejection = reentrancyRejection();
      if (rejection) return rejection;
      return enqueue(async () => {
        let all;
        try {
          all = await storage.get(null);
        } catch {
          return { success: false, code: "STORAGE_READ_FAILED" };
        }
        let transactionNow;
        try {
          transactionNow = currentTime();
        } catch {
          return overviewTransactionFailure("OVERVIEW_CLOCK_INVALID");
        }
        const expiredKeys = [];
        for (const key of safeOwnKeys(all)) {
          const identity = parseOverviewAttemptKey(key);
          if (!identity) continue;
          const record = parseOverviewAttemptRecord(
            safeOwnValue(all, key),
            identity,
          );
          if (
            record &&
            record.expiresAt <= transactionNow &&
            record.currentAttempt.leaseUntil <= transactionNow
          ) {
            expiredKeys.push(key);
          }
        }
        expiredKeys.sort();
        if (!expiredKeys.length) {
          return { success: true, removedAttemptCount: 0 };
        }
        let removeFailed = false;
        try {
          await storage.remove(expiredKeys);
        } catch {
          removeFailed = true;
        }
        let remaining;
        try {
          remaining = await storage.get(expiredKeys);
        } catch {
          return {
            success: false,
            code: "STORAGE_READ_FAILED",
            stage: removeFailed
              ? "verify_after_remove_failure"
              : "verify_expired_attempts",
          };
        }
        const remainingKeys = safeOwnKeys(remaining).sort();
        const removedAttemptCount =
          expiredKeys.length - remainingKeys.length;
        if (removeFailed) {
          return {
            success: false,
            code: "STORAGE_WRITE_FAILED",
            stage: "remove_expired_attempts",
            removedAttemptCount,
            remainingCount: Math.min(
              remainingKeys.length,
              MAX_VERIFICATION_KEYS,
            ),
            remainingKeys: remainingKeys.slice(0, MAX_VERIFICATION_KEYS),
          };
        }
        if (remainingKeys.length) {
          return {
            success: false,
            code: "PRUNE_VERIFICATION_FAILED",
            removedAttemptCount,
            remainingCount: Math.min(
              remainingKeys.length,
              MAX_VERIFICATION_KEYS,
            ),
            remainingKeys: remainingKeys.slice(0, MAX_VERIFICATION_KEYS),
          };
        }
        return {
          success: true,
          removedAttemptCount: expiredKeys.length,
        };
      });
    }

    async function writeDigestValueInCurrentQueue(
      digestKey,
      value,
      validateMutation,
      extraItems = {},
      verifyStoredMutation,
    ) {
      const validateBeforeMutation = async (evictedKeys = []) => {
        if (!validateMutation) return null;
        try {
          const validation = await invokeGuardedCallback(validateMutation);
          if (validation === true) return null;
          const internalCode = validation?.[internalValidationFailureToken];
          if (internalCode === "RESET_DURING_REQUEST") {
            return {
              ...staleResetResult(),
              ...(evictedKeys.length
                ? { evictedKeys: boundedResultKeys(evictedKeys) }
                : {}),
            };
          }
          if (internalCode === "STORAGE_READ_FAILED") {
            return {
              success: false,
              code: internalCode,
              retryable: true,
              ...(evictedKeys.length
                ? { evictedKeys: boundedResultKeys(evictedKeys) }
                : {}),
            };
          }
          if (
            internalCode === "OVERVIEW_DIGEST_CONTEXT_MISMATCH" ||
            internalCode === "OVERVIEW_CLOCK_INVALID" ||
            internalCode === "OVERVIEW_ATTEMPT_EXPIRED" ||
            internalCode === "DIGEST_EXPIRED" ||
            internalCode === "DIGEST_CLOCK_INVALID"
          ) {
            return {
              success: false,
              code: internalCode,
              retryable: false,
              ...(evictedKeys.length
                ? { evictedKeys: boundedResultKeys(evictedKeys) }
                : {}),
            };
          }
        } catch {
          // Validation failures are bounded and fail closed.
        }
        return digestSessionStaleFailure(evictedKeys);
      };
      const storageItems = () => ({
        ...copyOwnDataProperties(extraItems),
        [digestKey]: value,
      });
      const successfulWriteResult = (retriedAfterQuota, evictedKeys) => ({
        success: true,
        key: digestKey,
        evictedKeys: boundedResultKeys(evictedKeys),
        retriedAfterQuota,
      });
      let newBytes;
      try {
        newBytes = estimateEntryBytes(digestKey, value);
      } catch {
        return digestEstimateFailure("new_value");
      }
      if (newBytes > DIGEST_BUDGET_BYTES) {
        return {
          success: false,
          code: "DIGEST_CACHE_TOO_LARGE",
          retryable: false,
        };
      }

      let all;
      try {
        all = await storage.get(null);
      } catch {
        return digestReadFailure("read_cache");
      }
      const entries = orderedDigestEntries(all);
      let sizes;
      try {
        sizes = await measureDigestEntries(storage, entries);
      } catch {
        return digestEstimateFailure("stored_cache");
      }
      const currentBytes = entries.reduce(
        (total, entry) => total + (sizes.get(entry.key) || 0),
        0,
      );
      let predictedBytes =
        currentBytes - (sizes.get(digestKey) || 0) + newBytes;
      const plannedEvictions = [];
      const evictedKeys = [];

      for (const entry of entries) {
        if (predictedBytes <= DIGEST_BUDGET_BYTES) break;
        if (entry.key === digestKey) continue;
        plannedEvictions.push(entry.key);
        predictedBytes -= sizes.get(entry.key) || 0;
      }

      if (predictedBytes > DIGEST_BUDGET_BYTES) {
        return {
          success: false,
          code: "DIGEST_CACHE_TOO_LARGE",
          retryable: false,
        };
      }

      if (plannedEvictions.length) {
        const stale = await validateBeforeMutation(evictedKeys);
        if (stale) return stale;
        try {
          await storage.remove(plannedEvictions);
        } catch {
          return digestWriteFailure(evictedKeys);
        }

        let evictionCheck;
        try {
          evictionCheck = await storage.get(plannedEvictions);
        } catch {
          return digestEvictionFailure(evictedKeys);
        }
        for (const key of plannedEvictions) {
          if (!hasOwnKey(evictionCheck, key)) evictedKeys.push(key);
        }
        if (evictedKeys.length !== plannedEvictions.length) {
          return digestEvictionFailure(evictedKeys);
        }
      }

      const staleBeforeWrite = await validateBeforeMutation(evictedKeys);
      if (staleBeforeWrite) return staleBeforeWrite;
      const firstItems = storageItems();
      let firstError = null;
      try {
        await storage.set(firstItems);
      } catch (error) {
        firstError = error;
      }
      if (verifyStoredMutation) {
        const verificationFailure = await verifyStoredMutation(firstItems, {
          repairIncomplete: firstError === null,
          beforeRepair: () => validateBeforeMutation(evictedKeys),
        });
        if (!verificationFailure) {
          return successfulWriteResult(false, evictedKeys);
        }
        if (
          firstError === null ||
          !isQuotaError(firstError) ||
          verificationFailure.code !== "STORAGE_WRITE_VERIFICATION_FAILED"
        ) {
          return verificationFailure;
        }
      } else if (firstError === null) {
        return successfulWriteResult(false, evictedKeys);
      }
      if (!isQuotaError(firstError)) return digestWriteFailure(evictedKeys);

      let afterFailure;
      try {
        afterFailure = await storage.get(null);
      } catch {
        return digestReadFailure("quota_cache", evictedKeys);
      }
      const additionalCandidate = orderedDigestEntries(afterFailure).find(
        (entry) => entry.key !== digestKey,
      );
      if (!additionalCandidate) return digestQuotaFailure(evictedKeys);

      const staleBeforeQuotaEviction = await validateBeforeMutation(evictedKeys);
      if (staleBeforeQuotaEviction) return staleBeforeQuotaEviction;
      try {
        await storage.remove(additionalCandidate.key);
      } catch {
        return digestWriteFailure(evictedKeys);
      }

      let evictionCheck;
      try {
        evictionCheck = await storage.get(additionalCandidate.key);
      } catch {
        return digestWriteFailure(evictedKeys);
      }
      if (hasOwnKey(evictionCheck, additionalCandidate.key)) {
        return digestQuotaFailure(evictedKeys);
      }
      if (!evictedKeys.includes(additionalCandidate.key)) {
        evictedKeys.push(additionalCandidate.key);
      }

      const staleBeforeRetry = await validateBeforeMutation(evictedKeys);
      if (staleBeforeRetry) return staleBeforeRetry;
      const retryItems = storageItems();
      let retryError = null;
      try {
        await storage.set(retryItems);
      } catch (error) {
        retryError = error;
      }
      if (verifyStoredMutation) {
        const verificationFailure = await verifyStoredMutation(retryItems, {
          repairIncomplete: retryError === null,
          beforeRepair: () => validateBeforeMutation(evictedKeys),
        });
        if (!verificationFailure) {
          return successfulWriteResult(true, evictedKeys);
        }
        if (
          retryError &&
          verificationFailure.code === "STORAGE_WRITE_VERIFICATION_FAILED"
        ) {
          return isQuotaError(retryError)
            ? digestQuotaFailure(evictedKeys)
            : digestWriteFailure(evictedKeys);
        }
        return verificationFailure;
      }
      if (retryError === null) return successfulWriteResult(true, evictedKeys);
      if (!isQuotaError(retryError)) return digestWriteFailure(evictedKeys);
      return digestQuotaFailure(evictedKeys);
    }

    function commitDigest(expectedEpoch, videoId, value, validateMutation) {
      const rejection = reentrancyRejection();
      if (rejection) return rejection;
      if (
        validateMutation !== undefined &&
        typeof validateMutation !== "function"
      ) {
        return Promise.reject(
          new TypeError("Digest validator must be a function."),
        );
      }
      let digestKey;
      try {
        digestKey = makeDigestKey(videoId);
      } catch (error) {
        return Promise.reject(error);
      }

      return enqueue(async () => {
        let currentEpoch;
        try {
          currentEpoch = await readEpoch();
        } catch {
          return digestReadFailure("read_epoch");
        }
        if (!isExpectedEpoch(expectedEpoch) || currentEpoch !== expectedEpoch) {
          return staleResetResult();
        }
        return writeDigestValueInCurrentQueue(
          digestKey,
          value,
          validateMutation,
        );
      });
    }

    function commitDigestBase(
      expectedEpoch,
      videoId,
      value,
      validateMutation,
      legacyMigrationContext,
    ) {
      const rejection = reentrancyRejection();
      if (rejection) return rejection;
      if (
        validateMutation !== undefined &&
        typeof validateMutation !== "function"
      ) {
        return Promise.reject(
          new TypeError("Digest base validator must be a function."),
        );
      }
      let digestKey;
      let normalizedInput;
      let normalizedMigrationContext;
      try {
        digestKey = makeDigestKey(videoId);
        normalizedInput = normalizeDigestBaseInput(value, videoId);
        normalizedMigrationContext = normalizeLegacyMigrationContext(
          legacyMigrationContext,
        );
      } catch (error) {
        return Promise.reject(error);
      }

      return enqueue(async () => {
        let currentEpoch;
        try {
          currentEpoch = await readEpoch();
        } catch {
          return digestReadFailure("read_epoch");
        }
        if (!isExpectedEpoch(expectedEpoch) || currentEpoch !== expectedEpoch) {
          return staleResetResult();
        }
        let stored;
        try {
          stored = await storage.get(digestKey);
        } catch {
          return digestReadFailure("read_target");
        }
        let transactionNow;
        try {
          transactionNow = currentTime();
        } catch {
          return {
            success: false,
            code: "DIGEST_CLOCK_INVALID",
            retryable: false,
          };
        }
        const current = safeOwnValue(stored, digestKey);
        const currentIsObject = Boolean(
          current && typeof current === "object" && !Array.isArray(current),
        );
        const currentIsV2 =
          currentIsObject &&
          safeOwnValue(current, "digestSchemaVersion") ===
            DIGEST_SCHEMA_VERSION;
        const currentTimestamp = currentIsObject
          ? safeTimestamp(safeOwnValue(current, "timestamp"))
          : null;
        const currentTimestampTrusted = Boolean(
          currentTimestamp !== null && currentTimestamp <= transactionNow,
        );
        const currentFresh = Boolean(
          currentTimestampTrusted &&
            transactionNow - currentTimestamp < OVERVIEW_ATTEMPT_TTL_MS,
        );
        const currentFingerprint = currentIsObject
          ? safeOwnValue(current, "transcriptFingerprint")
          : undefined;
        let currentLanguageMatches = false;
        if (currentIsObject) {
          try {
            currentLanguageMatches =
              resolveStoredDigestLanguage(current) ===
              normalizedInput.transcriptLanguage;
          } catch {
            currentLanguageMatches = false;
          }
        }
        const fingerprintAndLanguageMatch = Boolean(
          currentIsObject &&
            currentFingerprint === normalizedInput.transcriptFingerprint &&
            currentLanguageMatches,
        );
        const currentHasFingerprint =
          currentIsObject && hasOwnKey(current, "transcriptFingerprint");
        const legacyRawSourceMatches = Boolean(
          currentIsObject &&
            !currentIsV2 &&
            currentLanguageMatches &&
            digestDataEqual(
              safeOwnValue(current, "transcript"),
              normalizedInput.transcript,
            ),
        );
        const legacyMissingFingerprintMigration = Boolean(
          legacyRawSourceMatches &&
            !currentHasFingerprint &&
            normalizedMigrationContext.canonicalSegmentIds.length > 0,
        );
        const currentSourceMatches = Boolean(
          (currentIsV2 && fingerprintAndLanguageMatch) ||
            (!currentIsV2 &&
              ((currentHasFingerprint &&
                fingerprintAndLanguageMatch &&
                legacyRawSourceMatches) ||
                legacyMissingFingerprintMigration)),
        );
        if (
          currentIsV2 &&
          currentFresh &&
          currentFingerprint !== normalizedInput.transcriptFingerprint
        ) {
          return {
            success: false,
            code: "DIGEST_FINGERPRINT_CONFLICT",
            retryable: false,
          };
        }
        if (
          currentIsV2 &&
          currentFresh &&
          currentFingerprint === normalizedInput.transcriptFingerprint &&
          !currentSourceMatches
        ) {
          return {
            success: false,
            code: "DIGEST_TRANSCRIPT_CONFLICT",
            retryable: false,
          };
        }

        const provenanceMatches = Boolean(
          currentTimestampTrusted &&
            currentSourceMatches,
        );
        const nextDigest = {
          digestSchemaVersion: DIGEST_SCHEMA_VERSION,
          transcript: normalizedInput.transcript,
          transcriptText: normalizedInput.transcriptText,
          transcriptTimestamped: normalizedInput.transcriptTimestamped,
          transcriptLanguage: normalizedInput.transcriptLanguage,
          transcriptFingerprint: normalizedInput.transcriptFingerprint,
          videoTitle: normalizedInput.videoTitle,
          channelName: normalizedInput.channelName,
          timestamp:
            provenanceMatches && currentFresh
              ? currentTimestamp
              : transactionNow,
        };

        const storedHasDeepAnalysis =
          currentIsObject && hasOwnKey(current, "deepAnalysis");
        const storedHasLegacyAnalysis =
          currentIsObject && hasOwnKey(current, "analysis");
        if (provenanceMatches) {
          const basicOverview = snapshotBasicOverview(
            safeOwnValue(current, "basicOverview"),
            normalizedInput.transcriptFingerprint,
            transactionNow,
          );
          if (basicOverview) nextDigest.basicOverview = basicOverview;

          let storedDeep;
          if (storedHasDeepAnalysis) {
            storedDeep = snapshotDeepAnalysis(
              safeOwnValue(current, "deepAnalysis"),
            );
          } else if (storedHasLegacyAnalysis) {
            const legacyValue = safeOwnValue(current, "analysis");
            storedDeep =
              legacyValue === null
                ? { valid: false }
                : snapshotDeepAnalysis(legacyValue);
          }
          if (storedDeep?.valid) {
            nextDigest.deepAnalysis = storedDeep.value;
          }

          const storedParagraphs = normalizeParagraphCache(
            safeOwnValue(current, "paragraphCache"),
            videoId,
            normalizedInput.transcriptFingerprint,
            { strict: false },
          );
          if (
            !currentIsV2 &&
            currentSourceMatches &&
            normalizedMigrationContext.canonicalSegmentIds.length
          ) {
            const migratedLegacyParagraphs = migrateLegacyParagraphCache(
              safeOwnValue(current, "paragraphCache"),
              videoId,
              normalizedInput.transcriptFingerprint,
              normalizedMigrationContext.canonicalSegmentIds,
            );
            for (const key of safeOwnKeys(migratedLegacyParagraphs)) {
              if (!hasOwnKey(storedParagraphs, key)) {
                Object.defineProperty(storedParagraphs, key, {
                  value: safeOwnValue(migratedLegacyParagraphs, key),
                  enumerable: true,
                  configurable: true,
                  writable: true,
                });
              }
            }
          }
          if (safeOwnKeys(storedParagraphs).length) {
            nextDigest.paragraphCache = storedParagraphs;
          }
        }

        const lifecycleTimestamp = nextDigest.timestamp;
        const validateBaseAtMutation = () => {
          let observedTime;
          try {
            observedTime = currentTime();
          } catch {
            return internalValidationFailure("DIGEST_CLOCK_INVALID");
          }
          if (
            observedTime < transactionNow ||
            observedTime < lifecycleTimestamp
          ) {
            return internalValidationFailure("DIGEST_CLOCK_INVALID");
          }
          if (
            observedTime - lifecycleTimestamp >= OVERVIEW_ATTEMPT_TTL_MS
          ) {
            return internalValidationFailure("DIGEST_EXPIRED");
          }
          if (!validateMutation) return true;
          let pendingValidation;
          try {
            pendingValidation = validateMutation();
          } catch {
            return false;
          }
          return Promise.resolve(pendingValidation).then(
            (valid) => {
              if (valid !== true) return false;
              let finalTime;
              try {
                finalTime = currentTime();
              } catch {
                return internalValidationFailure("DIGEST_CLOCK_INVALID");
              }
              if (
                finalTime < observedTime ||
                finalTime < lifecycleTimestamp
              ) {
                return internalValidationFailure("DIGEST_CLOCK_INVALID");
              }
              if (
                finalTime - lifecycleTimestamp >= OVERVIEW_ATTEMPT_TTL_MS
              ) {
                return internalValidationFailure("DIGEST_EXPIRED");
              }
              return true;
            },
            () => false,
          );
        };

        const writeResult = await writeDigestValueInCurrentQueue(
          digestKey,
          nextDigest,
          validateBaseAtMutation,
        );
        if (writeResult?.success !== true) return writeResult;
        return {
          ...writeResult,
          timestamp: lifecycleTimestamp,
        };
      });
    }

    function patchDigest(
      expectedEpoch,
      videoId,
      transcriptFingerprint,
      patch,
      validateMutation,
    ) {
      const rejection = reentrancyRejection();
      if (rejection) return rejection;
      if (
        validateMutation !== undefined &&
        typeof validateMutation !== "function"
      ) {
        return Promise.reject(
          new TypeError("Digest patch validator must be a function."),
        );
      }
      let digestKey;
      let normalizedFingerprint;
      let normalizedPatch;
      try {
        digestKey = makeDigestKey(videoId);
        normalizedFingerprint = normalizeOverviewFingerprint(
          transcriptFingerprint,
        );
        normalizedPatch = normalizeDigestPatchInput(
          patch,
          videoId,
          normalizedFingerprint,
        );
      } catch (error) {
        return Promise.reject(error);
      }

      return enqueue(async () => {
        let currentEpoch;
        try {
          currentEpoch = await readEpoch();
        } catch {
          return digestReadFailure("read_epoch");
        }
        if (!isExpectedEpoch(expectedEpoch) || currentEpoch !== expectedEpoch) {
          return staleResetResult();
        }

        let stored;
        try {
          stored = await storage.get(digestKey);
        } catch {
          return digestReadFailure("read_target");
        }
        const current = safeOwnValue(stored, digestKey);
        if (!current || typeof current !== "object" || Array.isArray(current)) {
          return {
            success: false,
            code: "DIGEST_NOT_FOUND",
            retryable: false,
          };
        }
        if (
          safeOwnValue(current, "digestSchemaVersion") !==
          DIGEST_SCHEMA_VERSION
        ) {
          return {
            success: false,
            code: "DIGEST_SCHEMA_MISMATCH",
            retryable: false,
          };
        }
        if (
          safeOwnValue(current, "transcriptFingerprint") !==
          normalizedFingerprint
        ) {
          return {
            success: false,
            code: "DIGEST_FINGERPRINT_MISMATCH",
            retryable: false,
          };
        }

        let transactionNow;
        try {
          transactionNow = currentTime();
        } catch {
          return {
            success: false,
            code: "DIGEST_CLOCK_INVALID",
            retryable: false,
          };
        }
        const currentTimestamp = safeTimestamp(
          safeOwnValue(current, "timestamp"),
        );
        if (
          currentTimestamp === null ||
          currentTimestamp > transactionNow ||
          transactionNow - currentTimestamp >= OVERVIEW_ATTEMPT_TTL_MS
        ) {
          return {
            success: false,
            code: "DIGEST_EXPIRED",
            retryable: false,
          };
        }

        const currentBase = snapshotStoredDigestBase(current, videoId);
        if (
          !currentBase ||
          currentBase.transcriptFingerprint !== normalizedFingerprint
        ) {
          return {
            success: false,
            code: "DIGEST_SCHEMA_MISMATCH",
            retryable: false,
          };
        }
        const nextDigest = {
          digestSchemaVersion: DIGEST_SCHEMA_VERSION,
          transcript: currentBase.transcript,
          transcriptText: currentBase.transcriptText,
          transcriptTimestamped: currentBase.transcriptTimestamped,
          transcriptLanguage: currentBase.transcriptLanguage,
          transcriptFingerprint: currentBase.transcriptFingerprint,
          videoTitle: currentBase.videoTitle,
          channelName: currentBase.channelName,
          timestamp: currentTimestamp,
        };

        if (hasOwnKey(current, "basicOverview")) {
          const basicOverview = snapshotBasicOverview(
            safeOwnValue(current, "basicOverview"),
            normalizedFingerprint,
            transactionNow,
          );
          if (!basicOverview) {
            return {
              success: false,
              code: "DIGEST_SCHEMA_MISMATCH",
              retryable: false,
            };
          }
          nextDigest.basicOverview = basicOverview;
        }

        if (hasOwnKey(current, "deepAnalysis")) {
          const deep = snapshotDeepAnalysis(
            safeOwnValue(current, "deepAnalysis"),
          );
          if (!deep.valid) {
            return {
              success: false,
              code: "DIGEST_SCHEMA_MISMATCH",
              retryable: false,
            };
          }
          nextDigest.deepAnalysis = deep.value;
        }

        let mergedParagraphs = {};
        if (hasOwnKey(current, "paragraphCache")) {
          try {
            mergedParagraphs = normalizeParagraphCache(
              safeOwnValue(current, "paragraphCache"),
              videoId,
              normalizedFingerprint,
            );
          } catch {
            return {
              success: false,
              code: "DIGEST_SCHEMA_MISMATCH",
              retryable: false,
            };
          }
        }
        if (normalizedPatch.paragraphDelta) {
          for (const key of safeOwnKeys(normalizedPatch.paragraphDelta)) {
            Object.defineProperty(mergedParagraphs, key, {
              value: safeOwnValue(normalizedPatch.paragraphDelta, key),
              enumerable: true,
              configurable: true,
              writable: true,
            });
          }
          try {
            mergedParagraphs = normalizeParagraphCache(
              mergedParagraphs,
              videoId,
              normalizedFingerprint,
            );
          } catch {
            return {
              success: false,
              code: "DIGEST_MERGE_TOO_LARGE",
              retryable: false,
            };
          }
        }
        if (safeOwnKeys(mergedParagraphs).length) {
          nextDigest.paragraphCache = mergedParagraphs;
        }
        if (normalizedPatch.hasDeepAnalysis) {
          nextDigest.deepAnalysis = normalizedPatch.deepAnalysis;
        }

        const validateAtMutation = () => {
          let observedTime;
          try {
            observedTime = currentTime();
          } catch {
            return internalValidationFailure("DIGEST_CLOCK_INVALID");
          }
          if (
            observedTime < transactionNow ||
            observedTime < currentTimestamp
          ) {
            return internalValidationFailure("DIGEST_CLOCK_INVALID");
          }
          if (
            observedTime - currentTimestamp >= OVERVIEW_ATTEMPT_TTL_MS
          ) {
            return internalValidationFailure("DIGEST_EXPIRED");
          }
          if (!validateMutation) return true;
          let pendingValidation;
          try {
            pendingValidation = validateMutation();
          } catch {
            return false;
          }
          return Promise.resolve(pendingValidation).then(
            (valid) => {
              if (valid !== true) return false;
              let finalTime;
              try {
                finalTime = currentTime();
              } catch {
                return internalValidationFailure("DIGEST_CLOCK_INVALID");
              }
              if (finalTime < observedTime || finalTime < currentTimestamp) {
                return internalValidationFailure("DIGEST_CLOCK_INVALID");
              }
              if (
                finalTime - currentTimestamp >= OVERVIEW_ATTEMPT_TTL_MS
              ) {
                return internalValidationFailure("DIGEST_EXPIRED");
              }
              return true;
            },
            () => false,
          );
        };

        return writeDigestValueInCurrentQueue(
          digestKey,
          nextDigest,
          validateAtMutation,
        );
      });
    }

    function overviewTransactionFailure(code, retryable = false) {
      return { success: false, code, retryable };
    }

    function overviewResetCleanupFailure(storageCode) {
      return {
        ...staleResetResult(),
        cleanupComplete: false,
        storageCode:
          storageCode === "STORAGE_READ_FAILED"
            ? "STORAGE_READ_FAILED"
            : "STORAGE_WRITE_FAILED",
      };
    }

    function overviewWriteVerificationFailure() {
      return {
        success: false,
        code: "STORAGE_WRITE_VERIFICATION_FAILED",
        retryable: true,
        cleanupComplete: false,
      };
    }

    function overviewMutationValueMatches(stored, key, expectedValue) {
      if (!hasOwnKey(stored, key)) return false;
      let actualSerialized;
      let expectedSerialized;
      try {
        actualSerialized = JSON.stringify(safeOwnValue(stored, key));
        expectedSerialized = JSON.stringify(expectedValue);
      } catch {
        return false;
      }
      return (
        typeof actualSerialized === "string" &&
        actualSerialized === expectedSerialized
      );
    }

    async function verifyOverviewWriteEpoch(
      expectedEpoch,
      expectedItems,
      { repairIncomplete = true, beforeRepair } = {},
    ) {
      const keys = safeOwnKeys(expectedItems).sort();
      let repairAttempted = false;
      while (true) {
        let observed;
        let observedSuccessfully = false;
        for (
          let attempt = 0;
          attempt < OVERVIEW_WRITE_VERIFICATION_ATTEMPTS;
          attempt += 1
        ) {
          try {
            observed = await storage.get([STORAGE_KEYS.resetEpoch, ...keys]);
            observedSuccessfully = true;
            break;
          } catch {
            // A transient read must not strand a stale final write after reset.
          }
        }
        if (!observedSuccessfully) {
          return {
            ...overviewTransactionFailure("STORAGE_READ_FAILED", true),
            cleanupComplete: false,
          };
        }
        if (
          normalizeEpoch(safeOwnValue(observed, STORAGE_KEYS.resetEpoch)) ===
          expectedEpoch
        ) {
          const complete = keys.every((key) =>
            overviewMutationValueMatches(
              observed,
              key,
              safeOwnValue(expectedItems, key),
            ),
          );
          if (complete) return null;
          if (!repairIncomplete || repairAttempted) {
            return overviewWriteVerificationFailure();
          }
          if (beforeRepair) {
            let repairRejection;
            try {
              repairRejection = await beforeRepair();
            } catch {
              return overviewWriteVerificationFailure();
            }
            if (repairRejection) return repairRejection;
          }
          repairAttempted = true;
          try {
            await storage.set(copyOwnDataProperties(expectedItems));
          } catch {
            // A rejected write is ambiguous; the next read decides its state.
          }
          continue;
        }

        let staleKeys = keys.filter((key) =>
          overviewMutationValueMatches(
            observed,
            key,
            safeOwnValue(expectedItems, key),
          ),
        );
        if (!staleKeys.length) return staleResetResult();

        // StorageArea has no conditional remove. Every legitimate digest and
        // overview writer is serialized by this coordinator, so a successor
        // generation cannot enter between these checks and remove. The only
        // out-of-FIFO actor in this threat model is the reset that already moved
        // the epoch. Re-read before removal, verify after it, and retry once so a
        // partial/no-op storage cleanup can never be reported as complete.
        let lastStorageCode = "STORAGE_WRITE_FAILED";
        for (
          let attempt = 0;
          attempt < OVERVIEW_WRITE_VERIFICATION_ATTEMPTS;
          attempt += 1
        ) {
          let rechecked;
          try {
            rechecked = await storage.get(staleKeys);
          } catch {
            lastStorageCode = "STORAGE_READ_FAILED";
            continue;
          }
          staleKeys = staleKeys.filter((key) =>
            overviewMutationValueMatches(
              rechecked,
              key,
              safeOwnValue(expectedItems, key),
            ),
          );
          if (!staleKeys.length) return staleResetResult();

          try {
            await storage.remove(staleKeys);
            lastStorageCode = "STORAGE_WRITE_FAILED";
          } catch {
            lastStorageCode = "STORAGE_WRITE_FAILED";
          }

          let afterCleanup;
          try {
            afterCleanup = await storage.get(staleKeys);
          } catch {
            lastStorageCode = "STORAGE_READ_FAILED";
            continue;
          }
          staleKeys = staleKeys.filter((key) =>
            overviewMutationValueMatches(
              afterCleanup,
              key,
              safeOwnValue(expectedItems, key),
            ),
          );
          if (!staleKeys.length) return staleResetResult();
          lastStorageCode = "STORAGE_WRITE_FAILED";
        }
        return overviewResetCleanupFailure(lastStorageCode);
      }
    }

    function claimBasicOverview(
      expectedEpoch,
      request,
      validateMutation,
    ) {
      const rejection = reentrancyRejection();
      if (rejection) return rejection;
      if (
        validateMutation !== undefined &&
        typeof validateMutation !== "function"
      ) {
        return Promise.reject(
          new TypeError("Overview claim validator must be a function."),
        );
      }
      let identity;
      try {
        identity = normalizeOverviewIdentity(request, { requireIntent: true });
      } catch (error) {
        return Promise.reject(error);
      }

      return enqueue(async () => {
        let currentEpoch;
        try {
          currentEpoch = await readEpoch();
        } catch {
          return overviewTransactionFailure("STORAGE_READ_FAILED", true);
        }
        if (!isExpectedEpoch(expectedEpoch) || currentEpoch !== expectedEpoch) {
          return staleResetResult();
        }

        let stored;
        try {
          stored = await storage.get([identity.digestKey, identity.attemptKey]);
        } catch {
          return overviewTransactionFailure("STORAGE_READ_FAILED", true);
        }
        let transactionNow;
        try {
          transactionNow = currentTime();
        } catch {
          return overviewTransactionFailure("OVERVIEW_CLOCK_INVALID");
        }
        let inspection = inspectOverviewClaim(
          stored,
          identity,
          expectedEpoch,
          transactionNow,
        );
        if (inspection.result) return inspection.result;

        if (validateMutation) {
          try {
            if (
              (await invokeGuardedCallback(validateMutation)) !== true
            ) {
              return overviewTransactionFailure("SESSION_STALE");
            }
          } catch {
            return overviewTransactionFailure("SESSION_STALE");
          }

          let recheckedEpoch;
          try {
            recheckedEpoch = await readEpoch();
          } catch {
            return overviewTransactionFailure("STORAGE_READ_FAILED", true);
          }
          if (recheckedEpoch !== expectedEpoch) return staleResetResult();
          try {
            stored = await storage.get([
              identity.digestKey,
              identity.attemptKey,
            ]);
          } catch {
            return overviewTransactionFailure("STORAGE_READ_FAILED", true);
          }
          let recheckedNow;
          try {
            recheckedNow = currentTime();
          } catch {
            return overviewTransactionFailure("OVERVIEW_CLOCK_INVALID");
          }
          if (recheckedNow < transactionNow) {
            return overviewTransactionFailure("OVERVIEW_CLOCK_INVALID");
          }
          transactionNow = recheckedNow;
          inspection = inspectOverviewClaim(
            stored,
            identity,
            expectedEpoch,
            transactionNow,
          );
          if (inspection.result) return inspection.result;

          try {
            if (
              (await invokeGuardedCallback(validateMutation)) !== true
            ) {
              return overviewTransactionFailure("SESSION_STALE");
            }
          } catch {
            return overviewTransactionFailure("SESSION_STALE");
          }
          let finalNow;
          try {
            finalNow = currentTime();
          } catch {
            return overviewTransactionFailure("OVERVIEW_CLOCK_INVALID");
          }
          if (finalNow < transactionNow) {
            return overviewTransactionFailure("OVERVIEW_CLOCK_INVALID");
          }
          transactionNow = finalNow;
          inspection = inspectOverviewClaim(
            stored,
            identity,
            expectedEpoch,
            transactionNow,
          );
          if (inspection.result) return inspection.result;
        }

        const nextRevision = inspection.priorRevision + 1;
        if (!Number.isSafeInteger(nextRevision)) {
          return overviewTransactionFailure(
            "OVERVIEW_ATTEMPT_REVISION_EXHAUSTED",
          );
        }
        const firstClaimedAt =
          inspection.record?.firstClaimedAt ?? transactionNow;
        const expiresAt =
          inspection.record?.expiresAt ??
          firstClaimedAt + OVERVIEW_ATTEMPT_TTL_MS;
        const leaseUntil = transactionNow + OVERVIEW_CLAIM_LEASE_MS;
        if (
          !Number.isSafeInteger(expiresAt) ||
          !Number.isSafeInteger(leaseUntil)
        ) {
          return overviewTransactionFailure("OVERVIEW_CLOCK_INVALID");
        }
        const nextRecord = {
          schemaVersion: 1,
          videoId: identity.videoId,
          transcriptFingerprint: identity.transcriptFingerprint,
          firstClaimedAt,
          expiresAt,
          currentAttempt: {
            id: identity.attemptId,
            revision: nextRevision,
            intent: identity.intent,
            status: "claimed",
            resetEpoch: expectedEpoch,
            claimedAt: transactionNow,
            leaseUntil,
          },
        };
        try {
          await storage.set({ [identity.attemptKey]: nextRecord });
        } catch {
          // The post-write read distinguishes a rejected commit from no write.
        }
        const epochFailure = await verifyOverviewWriteEpoch(
          expectedEpoch,
          { [identity.attemptKey]: nextRecord },
          { repairIncomplete: false },
        );
        if (epochFailure) return epochFailure;
        return {
          success: true,
          disposition: "claimed",
          attemptId: identity.attemptId,
          attemptRevision: nextRevision,
          expiresAt,
          leaseUntil,
        };
      });
    }

    function settleBasicOverview(expectedEpoch, settlement) {
      const rejection = reentrancyRejection();
      if (rejection) return rejection;
      let identity;
      let outcome;
      let overviewGeneratedAt = null;
      try {
        identity = normalizeOverviewIdentity(settlement, {
          requireRevision: true,
        });
        outcome = safeOwnValue(settlement, "outcome");
        if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) {
          throw new TypeError("Overview settlement outcome is required.");
        }
        const outcomeType = safeOwnValue(outcome, "type");
        if (outcomeType !== "success" && outcomeType !== "failure") {
          throw new TypeError("Invalid overview settlement outcome.");
        }
        if (outcomeType === "success") {
          const overview = safeOwnValue(outcome, "overview");
          if (
            !overview ||
            typeof overview !== "object" ||
            Array.isArray(overview) ||
            safeOwnValue(overview, "transcriptFingerprint") !==
              identity.transcriptFingerprint
          ) {
            throw new TypeError("Invalid overview fingerprint in settlement.");
          }
          overviewGeneratedAt = safeTimestamp(
            safeOwnValue(overview, "generatedAt"),
          );
          if (overviewGeneratedAt === null) {
            throw new TypeError("Invalid overview generatedAt in settlement.");
          }
        }
      } catch (error) {
        return Promise.reject(error);
      }

      return enqueue(async () => {
        let currentEpoch;
        try {
          currentEpoch = await readEpoch();
        } catch {
          return overviewTransactionFailure("STORAGE_READ_FAILED", true);
        }
        if (!isExpectedEpoch(expectedEpoch) || currentEpoch !== expectedEpoch) {
          return staleResetResult();
        }

        let stored;
        try {
          stored = await storage.get([identity.digestKey, identity.attemptKey]);
        } catch {
          return overviewTransactionFailure("STORAGE_READ_FAILED", true);
        }
        let transactionNow;
        try {
          transactionNow = currentTime();
        } catch {
          return overviewTransactionFailure("OVERVIEW_CLOCK_INVALID");
        }
        if (!hasOwnKey(stored, identity.attemptKey)) {
          return overviewTransactionFailure("OVERVIEW_ATTEMPT_MISSING");
        }
        const record = parseOverviewAttemptRecord(
          safeOwnValue(stored, identity.attemptKey),
          identity,
        );
        if (!record) {
          return overviewTransactionFailure("OVERVIEW_ATTEMPT_CORRUPT");
        }
        const attempt = record.currentAttempt;
        if (attempt.resetEpoch !== expectedEpoch) {
          return overviewTransactionFailure("OVERVIEW_ATTEMPT_CORRUPT");
        }
        if (
          transactionNow < record.firstClaimedAt ||
          transactionNow < attempt.claimedAt
        ) {
          return overviewTransactionFailure("OVERVIEW_CLOCK_INVALID");
        }
        if (
          attempt.id !== identity.attemptId ||
          attempt.revision !== identity.attemptRevision
        ) {
          return overviewTransactionFailure("OVERVIEW_ATTEMPT_MISMATCH");
        }
        if (
          transactionNow >= record.expiresAt &&
          transactionNow >= attempt.leaseUntil
        ) {
          return overviewTransactionFailure("OVERVIEW_ATTEMPT_EXPIRED");
        }

        const outcomeType = safeOwnValue(outcome, "type");
        const finishOverviewCacheWrite = (writeResult, overview) => {
          if (!writeResult.success) {
            if (
              writeResult.code === "OVERVIEW_DIGEST_CONTEXT_MISMATCH" ||
              writeResult.code === "OVERVIEW_CLOCK_INVALID" ||
              writeResult.code === "OVERVIEW_ATTEMPT_EXPIRED" ||
              writeResult.code === "RESET_DURING_REQUEST"
            ) {
              return writeResult;
            }
            const storageCode =
              typeof writeResult.code === "string"
                ? writeResult.code.slice(0, 64)
                : "STORAGE_WRITE_FAILED";
            return {
              success: false,
              code: "OVERVIEW_CACHE_WRITE_FAILED",
              storageCode,
              provider: "deepseek",
              stage: "overview_cache",
              providerSucceeded: true,
              mayHaveConsumedCredit: true,
              primaryAction: "retry_cache_write",
              retryable: true,
              ...(writeResult.cleanupComplete === false
                ? { cleanupComplete: false }
                : {}),
              overview,
              evictedKeys: boundedResultKeys(
                Array.isArray(writeResult.evictedKeys)
                  ? writeResult.evictedKeys
                  : [],
              ),
            };
          }
          return {
            success: true,
            disposition: "stored",
            attemptId: attempt.id,
            attemptRevision: attempt.revision,
            overview,
            key: writeResult.key,
            evictedKeys: writeResult.evictedKeys,
            retriedAfterQuota: writeResult.retriedAfterQuota,
          };
        };
        if (attempt.status !== "claimed") {
          if (attempt.status === "failed" && outcomeType === "failure") {
            return {
              success: true,
              disposition: "failed",
              attemptId: attempt.id,
              attemptRevision: attempt.revision,
              failure: attempt.failure,
            };
          }
          if (attempt.status === "succeeded" && outcomeType === "success") {
            const digest = safeOwnValue(stored, identity.digestKey);
            if (
              !digestMatchesOverviewContext(
                digest,
                identity.transcriptFingerprint,
                transactionNow,
              )
            ) {
              return overviewTransactionFailure(
                "OVERVIEW_DIGEST_CONTEXT_MISMATCH",
              );
            }
            const cachedOverview = snapshotBasicOverview(
              safeOwnValue(digest, "basicOverview"),
              identity.transcriptFingerprint,
              transactionNow,
            );
            if (cachedOverview) {
              return {
                success: true,
                disposition: "stored",
                attemptId: attempt.id,
                attemptRevision: attempt.revision,
                overview: cachedOverview,
                evictedKeys: [],
                retriedAfterQuota: false,
              };
            }
            if (hasOwnKey(digest, "basicOverview")) {
              return overviewTransactionFailure(
                "OVERVIEW_DIGEST_CONTEXT_MISMATCH",
              );
            }
            if (overviewGeneratedAt !== attempt.generatedAt) {
              return overviewTransactionFailure(
                "OVERVIEW_GENERATED_AT_INVALID",
              );
            }

            const overview = safeOwnValue(outcome, "overview");
            const mergedDigest = {
              ...copyOwnDataProperties(digest),
              basicOverview: overview,
            };
            let lastObservedTime = transactionNow;
            const validateTerminalRepairContext = async () => {
              let durable;
              try {
                durable = await storage.get([
                  STORAGE_KEYS.resetEpoch,
                  identity.digestKey,
                  identity.attemptKey,
                ]);
              } catch {
                return internalValidationFailure("STORAGE_READ_FAILED");
              }
              if (
                normalizeEpoch(
                  safeOwnValue(durable, STORAGE_KEYS.resetEpoch),
                ) !== expectedEpoch
              ) {
                return internalValidationFailure("RESET_DURING_REQUEST");
              }
              let observedTime;
              try {
                observedTime = currentTime();
              } catch {
                return internalValidationFailure("OVERVIEW_CLOCK_INVALID");
              }
              if (observedTime < lastObservedTime) {
                return internalValidationFailure("OVERVIEW_CLOCK_INVALID");
              }
              lastObservedTime = observedTime;
              if (
                observedTime >= record.expiresAt &&
                observedTime >= attempt.leaseUntil
              ) {
                return internalValidationFailure("OVERVIEW_ATTEMPT_EXPIRED");
              }
              if (overviewGeneratedAt > observedTime) {
                return internalValidationFailure("OVERVIEW_CLOCK_INVALID");
              }

              const durableDigest = safeOwnValue(
                durable,
                identity.digestKey,
              );
              const durableRecord = parseOverviewAttemptRecord(
                safeOwnValue(durable, identity.attemptKey),
                identity,
              );
              if (
                !digestMatchesOverviewContext(
                  durableDigest,
                  identity.transcriptFingerprint,
                  observedTime,
                ) ||
                hasOwnKey(durableDigest, "basicOverview") ||
                !overviewMutationValueMatches(
                  { digest: durableDigest },
                  "digest",
                  digest,
                ) ||
                !overviewMutationValueMatches(
                  { record: durableRecord },
                  "record",
                  record,
                )
              ) {
                return internalValidationFailure(
                  "OVERVIEW_DIGEST_CONTEXT_MISMATCH",
                );
              }
              return true;
            };
            const writeResult = await writeDigestValueInCurrentQueue(
              identity.digestKey,
              mergedDigest,
              validateTerminalRepairContext,
              {},
              (items, options) =>
                verifyOverviewWriteEpoch(expectedEpoch, items, options),
            );
            return finishOverviewCacheWrite(writeResult, overview);
          }
          return overviewTransactionFailure(
            "OVERVIEW_ATTEMPT_NOT_CLAIMED",
          );
        }

        if (outcomeType === "failure") {
          const failure = canonicalOverviewFailure(
            safeOwnValue(outcome, "failure"),
          );
          const failedRecord = {
            ...record,
            currentAttempt: {
              ...attempt,
              status: "failed",
              finishedAt: transactionNow,
              failure,
            },
          };
          let finalEpoch;
          try {
            finalEpoch = await readEpoch();
          } catch {
            return overviewTransactionFailure("STORAGE_READ_FAILED", true);
          }
          if (finalEpoch !== expectedEpoch) return staleResetResult();
          try {
            await storage.set({ [identity.attemptKey]: failedRecord });
          } catch {
            // The post-write read distinguishes a rejected commit from no write.
          }
          const epochFailure = await verifyOverviewWriteEpoch(
            expectedEpoch,
            { [identity.attemptKey]: failedRecord },
            { repairIncomplete: false },
          );
          if (epochFailure) return epochFailure;
          return {
            success: true,
            disposition: "failed",
            attemptId: attempt.id,
            attemptRevision: attempt.revision,
            failure,
          };
        }

        const digest = safeOwnValue(stored, identity.digestKey);
        if (
          !digestMatchesOverviewContext(
            digest,
            identity.transcriptFingerprint,
            transactionNow,
          )
        ) {
          return overviewTransactionFailure(
            "OVERVIEW_DIGEST_CONTEXT_MISMATCH",
          );
        }
        const overview = safeOwnValue(outcome, "overview");
        if (overviewGeneratedAt < attempt.claimedAt) {
          return overviewTransactionFailure(
            "OVERVIEW_GENERATED_AT_INVALID",
          );
        }
        if (overviewGeneratedAt > transactionNow) {
          return overviewTransactionFailure("OVERVIEW_CLOCK_INVALID");
        }
        const mergedDigest = {
          ...copyOwnDataProperties(digest),
          basicOverview: overview,
        };
        const succeededRecord = {
          ...record,
          currentAttempt: {
            ...attempt,
            status: "succeeded",
            finishedAt: transactionNow,
            generatedAt: overviewGeneratedAt,
          },
        };
        let lastObservedTime = transactionNow;
        const validateOverviewContext = async () => {
          let durableEpoch;
          try {
            durableEpoch = await readEpoch();
          } catch {
            return internalValidationFailure("STORAGE_READ_FAILED");
          }
          if (durableEpoch !== expectedEpoch) {
            return internalValidationFailure("RESET_DURING_REQUEST");
          }
          let observedTime;
          try {
            observedTime = currentTime();
          } catch {
            return internalValidationFailure("OVERVIEW_CLOCK_INVALID");
          }
          if (observedTime < lastObservedTime) {
            return internalValidationFailure("OVERVIEW_CLOCK_INVALID");
          }
          lastObservedTime = observedTime;
          if (
            observedTime >= record.expiresAt &&
            observedTime >= attempt.leaseUntil
          ) {
            return internalValidationFailure("OVERVIEW_ATTEMPT_EXPIRED");
          }
          if (overviewGeneratedAt > observedTime) {
            return internalValidationFailure("OVERVIEW_CLOCK_INVALID");
          }
          if (
            !digestMatchesOverviewContext(
              digest,
              identity.transcriptFingerprint,
              observedTime,
            )
          ) {
            return internalValidationFailure(
              "OVERVIEW_DIGEST_CONTEXT_MISMATCH",
            );
          }
          succeededRecord.currentAttempt.finishedAt = observedTime;
          return true;
        };
        const writeResult = await writeDigestValueInCurrentQueue(
          identity.digestKey,
          mergedDigest,
          validateOverviewContext,
          { [identity.attemptKey]: succeededRecord },
          (items, options) =>
            verifyOverviewWriteEpoch(expectedEpoch, items, options),
        );
        return finishOverviewCacheWrite(writeResult, overview);
      });
    }

    return {
      captureEpoch,
      commitCurrent,
      commit,
      resetExtensionData,
      clearDigestCache,
      pruneExpiredOverviewAttempts,
      commitDigest,
      commitDigestBase,
      patchDigest,
      claimBasicOverview,
      settleBasicOverview,
    };
  }

  return {
    STORAGE_KEYS,
    DIGEST_PREFIX,
    DIGEST_BUDGET_BYTES,
    OVERVIEW_ATTEMPT_PREFIX,
    OVERVIEW_ATTEMPT_TTL_MS,
    OVERVIEW_CLAIM_LEASE_MS,
    normalizeEpoch,
    summarizeStoredData,
    listResettableKeys,
    createMutationCoordinator,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_PERSISTENCE;
}
