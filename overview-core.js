/**
 * Bounded normalization for the lightweight, transcript-grounded Overview.
 * Model output is rebuilt field by field; source identity and timestamps come
 * only from locally generated transcript segments and trusted metadata.
 */
var YTD_OVERVIEW = (() => {
  const LIMITS = Object.freeze({
    oneSentence: 300,
    conclusionTitle: 240,
    conclusionExplanation: 1200,
    conclusions: 5,
    evidenceIds: 3,
    chapterTitle: 240,
    chapterSummary: 1000,
    chapters: 40,
  });

  function boundedText(value, limit) {
    if (typeof value !== "string") return "";
    const source = value.trim();
    if (source.length <= limit) return source;
    let bounded = source.slice(0, limit);
    const finalUnit = bounded.charCodeAt(bounded.length - 1);
    const nextUnit = source.charCodeAt(bounded.length);
    if (
      finalUnit >= 0xd800 &&
      finalUnit <= 0xdbff &&
      nextUnit >= 0xdc00 &&
      nextUnit <= 0xdfff
    ) {
      bounded = bounded.slice(0, -1);
    }
    return bounded;
  }

  function sourceSegmentsById(sourceSegments) {
    const byId = new Map();
    const segments = Array.isArray(sourceSegments) ? sourceSegments : [];
    for (let order = 0; order < segments.length; order += 1) {
      const segment = segments[order];
      const id = typeof segment?.id === "string" ? segment.id.trim() : "";
      const start = Number(segment?.start);
      if (!id || byId.has(id) || !Number.isFinite(start) || start < 0) continue;
      byId.set(id, { id, start, order });
    }
    return byId;
  }

  function normalizeBasicOverview(raw, sourceSegments, metadata = {}) {
    const model = raw && typeof raw === "object" && !Array.isArray(raw)
      ? raw
      : {};
    const byId = sourceSegmentsById(sourceSegments);
    const conclusions = [];

    for (const item of Array.isArray(model.conclusions)
      ? model.conclusions
      : []) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const titleZh = boundedText(item.titleZh, LIMITS.conclusionTitle);
      const explanationZh = boundedText(
        item.explanationZh,
        LIMITS.conclusionExplanation,
      );
      if (!titleZh || !explanationZh) continue;

      const evidenceSegmentIds = [];
      const seenEvidence = new Set();
      let hasUnsupportedEvidence = false;
      for (const value of Array.isArray(item.evidenceSegmentIds)
        ? item.evidenceSegmentIds
        : []) {
        if (typeof value !== "string") {
          hasUnsupportedEvidence = true;
          continue;
        }
        if (seenEvidence.has(value)) continue;
        if (!byId.has(value)) {
          hasUnsupportedEvidence = true;
          continue;
        }
        seenEvidence.add(value);
        if (evidenceSegmentIds.length < LIMITS.evidenceIds) {
          evidenceSegmentIds.push(value);
        }
      }

      const evidenceLevel = !evidenceSegmentIds.length ||
        item.evidenceLevel === "insufficient"
        ? "insufficient"
        : item.evidenceLevel === "strong" && !hasUnsupportedEvidence
          ? "strong"
          : "partial";
      conclusions.push({
        id: `conclusion-${conclusions.length + 1}`,
        titleZh,
        explanationZh,
        evidenceLevel,
        evidenceSegmentIds,
      });
      if (conclusions.length === LIMITS.conclusions) break;
    }

    const chapterCandidates = [];
    const seenChapterStarts = new Set();
    for (const item of Array.isArray(model.chapters) ? model.chapters : []) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const source = byId.get(item.startSegmentId);
      const titleZh = boundedText(item.titleZh, LIMITS.chapterTitle);
      if (!source || !titleZh || seenChapterStarts.has(source.id)) continue;
      seenChapterStarts.add(source.id);
      chapterCandidates.push({
        titleZh,
        summaryZh: boundedText(item.summaryZh, LIMITS.chapterSummary),
        startSegmentId: source.id,
        timestampSeconds: source.start,
        sourceOrder: source.order,
      });
    }
    chapterCandidates.sort((left, right) => left.sourceOrder - right.sourceOrder);
    const chapters = chapterCandidates
      .slice(0, LIMITS.chapters)
      .map(({ sourceOrder: _sourceOrder, ...chapter }) => chapter);

    const oneSentenceZh = boundedText(model.oneSentenceZh, LIMITS.oneSentence);
    const generatedAt = Number.isSafeInteger(metadata.generatedAt) &&
      metadata.generatedAt >= 0
      ? metadata.generatedAt
      : 0;
    const transcriptFingerprint =
      typeof metadata.transcriptFingerprint === "string"
        ? metadata.transcriptFingerprint.trim()
        : "";

    const groundedConclusions = conclusions.filter(
      (item) =>
        item.titleZh &&
        item.explanationZh &&
        item.evidenceSegmentIds.length > 0 &&
        item.evidenceLevel !== "insufficient",
    ).length;

    return {
      schemaVersion: 1,
      transcriptFingerprint,
      generatedAt,
      oneSentenceZh,
      conclusions,
      chapters,
      complete: Boolean(
        oneSentenceZh && groundedConclusions >= 3 && chapters.length >= 1,
      ),
    };
  }

  function evidenceSegmentSnapshot(segment) {
    if (!segment || typeof segment !== "object" || Array.isArray(segment)) {
      return null;
    }
    const id = typeof segment.id === "string" ? segment.id.trim() : "";
    const start = segment.start;
    const text = typeof segment.text === "string" ? segment.text : "";
    if (!id || !Number.isFinite(start) || start < 0 || !text.trim()) return null;
    return Object.freeze({ id, start, text });
  }

  function evidenceContext(segment) {
    if (!segment) return null;
    return Object.freeze({
      segmentId: segment.id,
      timestampSeconds: segment.start,
      text: segment.text,
    });
  }

  function insufficientEvidenceView(
    reason,
    segmentId,
    conclusionTitleZh,
    explanationZh,
    evidenceLevel,
  ) {
    return Object.freeze({
      sufficient: false,
      reason,
      segmentId,
      timestampSeconds: null,
      exactText: "",
      previous: null,
      next: null,
      conclusionTitleZh,
      explanationZh,
      evidenceLevel,
    });
  }

  /**
   * Builds a transcript-grounded evidence view without model-authored quotes.
   * Exact text, timestamp, and neighboring context are copied only from the
   * current canonical segment list and resolved by stable local segment ID.
   */
  function buildEvidenceView(sourceSegments, conclusion, requestedSegmentId) {
    const model = conclusion && typeof conclusion === "object" &&
      !Array.isArray(conclusion)
      ? conclusion
      : {};
    const conclusionTitleZh = boundedText(
      model.titleZh,
      LIMITS.conclusionTitle,
    );
    const explanationZh = boundedText(
      model.explanationZh,
      LIMITS.conclusionExplanation,
    );
    const evidenceLevel = ["strong", "partial", "insufficient"].includes(
      model.evidenceLevel,
    )
      ? model.evidenceLevel
      : "insufficient";
    const segmentId = typeof requestedSegmentId === "string"
      ? requestedSegmentId.trim()
      : "";
    const citedIds = new Set(
      (Array.isArray(model.evidenceSegmentIds)
        ? model.evidenceSegmentIds
        : [])
        .filter((value) => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    );
    const ordered = [];
    const byId = new Map();
    for (const raw of Array.isArray(sourceSegments) ? sourceSegments : []) {
      const segment = evidenceSegmentSnapshot(raw);
      if (!segment || byId.has(segment.id)) continue;
      byId.set(segment.id, ordered.length);
      ordered.push(segment);
    }
    const index = byId.get(segmentId);
    if (!Number.isInteger(index)) {
      return insufficientEvidenceView(
        "segment_missing",
        segmentId,
        conclusionTitleZh,
        explanationZh,
        evidenceLevel,
      );
    }
    if (!citedIds.has(segmentId)) {
      return insufficientEvidenceView(
        "not_cited",
        segmentId,
        conclusionTitleZh,
        explanationZh,
        evidenceLevel,
      );
    }
    if (evidenceLevel === "insufficient") {
      return insufficientEvidenceView(
        "evidence_insufficient",
        segmentId,
        conclusionTitleZh,
        explanationZh,
        evidenceLevel,
      );
    }
    const source = ordered[index];
    return Object.freeze({
      sufficient: true,
      reason: "verified",
      segmentId: source.id,
      timestampSeconds: source.start,
      exactText: source.text,
      previous: evidenceContext(ordered[index - 1]),
      next: evidenceContext(ordered[index + 1]),
      conclusionTitleZh,
      explanationZh,
      evidenceLevel,
    });
  }

  return { normalizeBasicOverview, buildEvidenceView };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_OVERVIEW;
}
