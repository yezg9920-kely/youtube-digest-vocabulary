/**
 * Deterministic transcript segmentation and identity helpers shared by the
 * side panel and the MV3 service worker. This file has no DOM dependency and
 * can run both as a classic extension script and as a CommonJS test module.
 */
var YTD_TRANSCRIPT_CORE = (() => {
  const TRANSCRIPT_SEGMENT_LIMITS = Object.freeze({
    minChars: 60,
    idealChars: 180,
    maxChars: 320,
    maxSeconds: 20,
  });
  const FINGERPRINT_SCHEMA = "youtube-digest-transcript-fingerprint-v1";
  const FINGERPRINT_PREFIX = "sha256-v1-";
  const OVERVIEW_TRANSCRIPT_MAX_CHARS = 320_000;

  function normalizeCaptionText(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, "$1$2")
      .replace(/([，。；：！？])\s+(?=[\u3400-\u9fff])/g, "$1")
      .replace(/\s+([,.;:!?，。；：！？])/g, "$1")
      .trim();
  }

  function resolveTranscriptLanguage(topLevelLanguage, entries = []) {
    const topLevel =
      typeof topLevelLanguage === "string" ? topLevelLanguage.trim() : "";
    if (topLevel) return topLevel;
    for (const entry of Array.isArray(entries) ? entries : []) {
      const language =
        typeof entry?.language === "string" ? entry.language.trim() : "";
      if (language) return language;
    }
    return null;
  }

  /**
   * Splits one oversized thought at the strongest nearby punctuation. Word
   * boundaries are the final safety valve for captions with no punctuation.
   */
  function splitOversizedThought(text, maxChars) {
    const parts = [];
    let rest = normalizeCaptionText(text);

    const preserveSurrogatePair = (value, cut) => {
      if (cut <= 0 || cut >= value.length) return cut;
      const previous = value.charCodeAt(cut - 1);
      const next = value.charCodeAt(cut);
      const splitsPair =
        previous >= 0xd800 &&
        previous <= 0xdbff &&
        next >= 0xdc00 &&
        next <= 0xdfff;
      if (!splitsPair) return cut;
      return cut > 1 ? cut - 1 : Math.min(value.length, cut + 1);
    };

    while (rest.length > maxChars) {
      const windowText = rest.slice(0, maxChars + 1);
      const lowerBound = Math.floor(maxChars * 0.55);
      let cut = -1;

      for (const pattern of [/[;:；：]\s*/g, /[,，]\s*/g, /\s/g]) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(windowText))) {
          if (match.index >= lowerBound) cut = match.index + match[0].length;
        }
        if (cut > 0) break;
      }

      if (cut <= 0) cut = maxChars;
      cut = preserveSurrogatePair(rest, cut);
      parts.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }

    if (rest) parts.push(rest);
    return parts;
  }

  /**
   * Reconstructs complete sentences across raw caption boundaries. Each
   * segment keeps the timestamp of the first contributing caption.
   */
  function groupTranscriptEntries(entries, limits = TRANSCRIPT_SEGMENT_LIMITS) {
    if (!Array.isArray(entries) || entries.length === 0) return [];

    const pieces = [];
    entries.forEach((entry, entryIndex) => {
      const text = normalizeCaptionText(entry?.text);
      if (!text) return;
      const start = Number.isFinite(Number(entry.start)) ? Number(entry.start) : 0;
      const duration = Math.max(0, Number(entry.duration) || 0);
      const sentenceParts =
        text.match(/[^.!?;:,。！？；：，]+(?:[.!?;:,。！？；：，]+["')\]”’）】」』]*|$)/g) ||
        [text];
      let consumedChars = 0;

      sentenceParts.forEach((sentencePart) => {
        const cleanPart = normalizeCaptionText(sentencePart);
        if (!cleanPart) return;
        const oversizedParts = splitOversizedThought(cleanPart, limits.maxChars);
        oversizedParts.forEach((part, partIndex) => {
          const ratio = text.length ? Math.min(1, consumedChars / text.length) : 0;
          pieces.push({
            text: part,
            start: start + duration * ratio,
            semanticEnd:
              /[.!?。！？]["')\]”’）】」』]*$/.test(part) ||
              oversizedParts.length > 1,
            clauseEnd: /[;:,；：，]["')\]”’）】」』]*$/.test(part),
            sourceOrder: `${entryIndex}:${partIndex}`,
          });
          consumedChars += part.length + 1;
        });
      });
    });

    const grouped = [];
    let current = null;

    const flush = () => {
      if (!current || !current.text.trim()) return;
      const index = grouped.length;
      const text = normalizeCaptionText(current.text);
      grouped.push({
        id: `segment-${index}-${Math.round(current.start * 1000)}`,
        start: current.start,
        text,
        texts: [text],
      });
      current = null;
    };

    pieces.forEach((piece) => {
      const gapFromPreviousPiece = current
        ? Math.max(0, piece.start - current.lastPieceStart)
        : 0;
      if (current && gapFromPreviousPiece > limits.maxSeconds) flush();
      if (!current) {
        current = { start: piece.start, lastPieceStart: piece.start, text: "" };
      }
      current.text = normalizeCaptionText(`${current.text} ${piece.text}`);
      current.lastPieceStart = piece.start;
      const elapsed = Math.max(0, piece.start - current.start);
      const comfortablySized = current.text.length >= limits.minChars;
      const reachedIdeal = current.text.length >= limits.idealChars;
      const atNaturalBoundary =
        piece.semanticEnd ||
        (piece.clauseEnd &&
          (reachedIdeal ||
            current.text.length >= limits.maxChars ||
            elapsed >= limits.maxSeconds));
      const reachedGuardrail =
        atNaturalBoundary &&
        (current.text.length >= limits.maxChars || elapsed >= limits.maxSeconds);
      const reachedHardGuardrail =
        current.text.length >= Math.round(limits.maxChars * 1.2) ||
        elapsed >= limits.maxSeconds + 5;

      if (
        (atNaturalBoundary && (comfortablySized || elapsed >= 8)) ||
        (atNaturalBoundary && reachedIdeal) ||
        reachedGuardrail ||
        reachedHardGuardrail
      ) {
        flush();
      }
    });
    flush();

    return grouped;
  }

  function transcriptFingerprintError() {
    const error = new Error(
      "Secure local transcript fingerprinting is unavailable.",
    );
    error.name = "TranscriptFingerprintError";
    error.code = "TRANSCRIPT_FINGERPRINT_UNAVAILABLE";
    error.scope = "local";
    error.retryable = false;
    return error;
  }

  function canonicalFingerprintInput(segments, sourceLanguage) {
    return JSON.stringify({
      schema: FINGERPRINT_SCHEMA,
      sourceLanguage: String(sourceLanguage || "").trim(),
      segments: (Array.isArray(segments) ? segments : []).map((segment) => ({
        id: String(segment?.id || ""),
        start: Number.isFinite(Number(segment?.start)) ? Number(segment.start) : 0,
        text: String(segment?.text || ""),
      })),
    });
  }

  function secureFingerprintRuntime(options = {}) {
    const cryptoRuntime = Object.hasOwn(options, "crypto")
      ? options.crypto
      : globalThis.crypto;
    if (
      !cryptoRuntime?.subtle ||
      typeof cryptoRuntime.subtle.digest !== "function" ||
      typeof globalThis.TextEncoder !== "function"
    ) {
      throw transcriptFingerprintError();
    }
    return cryptoRuntime;
  }

  function assertSecureFingerprintAvailable(options = {}) {
    secureFingerprintRuntime(options);
    return true;
  }

  async function fingerprintSegments(segments, options = {}) {
    const sourceLanguage = options.sourceLanguage || "";
    const cryptoRuntime = secureFingerprintRuntime(options);

    try {
      const canonical = canonicalFingerprintInput(segments, sourceLanguage);
      const bytes = new TextEncoder().encode(canonical);
      const digest = await cryptoRuntime.subtle.digest("SHA-256", bytes);
      const hex = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      return `${FINGERPRINT_PREFIX}${hex}`;
    } catch (error) {
      if (error?.code === "TRANSCRIPT_FINGERPRINT_UNAVAILABLE") throw error;
      throw transcriptFingerprintError();
    }
  }

  function formatTimestamp(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const minutes = Math.floor(total / 60);
    const remainder = total % 60;
    return `${minutes}:${String(remainder).padStart(2, "0")}`;
  }

  function buildOverviewTranscriptInput(segments) {
    const input = (Array.isArray(segments) ? segments : [])
      .map((segment) => {
        const id = String(segment?.id || "");
        const timestamp = formatTimestamp(segment?.start);
        return `[${id}] [${timestamp}] ${normalizeCaptionText(segment?.text)}`;
      })
      .join("\n");
    if (input.length > OVERVIEW_TRANSCRIPT_MAX_CHARS) {
      const error = new RangeError(
        `Overview transcript exceeds ${OVERVIEW_TRANSCRIPT_MAX_CHARS} characters.`,
      );
      error.code = "OVERVIEW_TRANSCRIPT_TOO_LARGE";
      error.limit = OVERVIEW_TRANSCRIPT_MAX_CHARS;
      throw error;
    }
    return input;
  }

  function transcriptModeTranslation(lookup, id) {
    let value;
    try {
      if (lookup && typeof lookup.get === "function") value = lookup.get(id);
      else if (lookup && typeof lookup === "object") {
        const descriptor = Object.getOwnPropertyDescriptor(lookup, id);
        if (descriptor && Object.hasOwn(descriptor, "value")) {
          value = descriptor.value;
        }
      }
    } catch {
      return "";
    }
    return typeof value === "string" ? value.trim() : "";
  }

  /**
   * Captures the exact transcript mode a learner sees. Translated modes are
   * complete only when every canonical segment has an aligned translation;
   * incomplete snapshots intentionally expose no fallback plain text.
   */
  function buildTranscriptModeSnapshot({
    segments,
    mode = "original",
    translationLookup = null,
  } = {}) {
    const normalizedMode = ["original", "zh", "bilingual"].includes(mode)
      ? mode
      : "original";
    const rows = [];
    const missingSegmentIds = [];
    const seenIds = new Set();
    for (const segment of Array.isArray(segments) ? segments : []) {
      const id = typeof segment?.id === "string" ? segment.id.trim() : "";
      const start = segment?.start;
      const sourceText = typeof segment?.text === "string"
        ? segment.text
        : "";
      if (
        !id ||
        seenIds.has(id) ||
        !Number.isFinite(start) ||
        start < 0 ||
        !sourceText.trim()
      ) continue;
      seenIds.add(id);
      const translatedText = normalizedMode === "original"
        ? ""
        : transcriptModeTranslation(translationLookup, id);
      if (normalizedMode !== "original" && !translatedText) {
        missingSegmentIds.push(id);
      }
      rows.push(Object.freeze({ id, start, sourceText, translatedText }));
    }
    const complete = rows.length > 0 && (
      normalizedMode === "original" || missingSegmentIds.length === 0
    );
    const label = normalizedMode === "zh"
      ? "简体中文"
      : normalizedMode === "bilingual"
        ? "Original + 简体中文"
        : "Original";
    const plainText = !complete
      ? ""
      : rows.map((row) =>
          normalizedMode === "zh"
            ? row.translatedText
            : normalizedMode === "bilingual"
              ? `${row.sourceText}\n${row.translatedText}`
              : row.sourceText,
        ).join("\n\n");
    return Object.freeze({
      mode: normalizedMode,
      label,
      complete,
      missingSegmentIds: Object.freeze([...missingSegmentIds]),
      rows: Object.freeze(rows),
      plainText,
    });
  }

  return {
    normalizeCaptionText,
    resolveTranscriptLanguage,
    splitOversizedThought,
    groupTranscriptEntries,
    assertSecureFingerprintAvailable,
    fingerprintSegments,
    formatTimestamp,
    buildOverviewTranscriptInput,
    buildTranscriptModeSnapshot,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_TRANSCRIPT_CORE;
}
