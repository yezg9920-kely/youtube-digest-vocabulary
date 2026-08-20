const test = require("node:test");
const assert = require("node:assert/strict");

const settings = require("../settings.js");

test("DeepSeek defaults use V4 Flash", () => {
  const normalized = settings.normalize({
    provider: "unexpected",
    aiApiKey: "  example-key  ",
    aiBaseUrl: "https://api.example.com/v1",
    aiModel: "example-model",
    supadataApiKey: "  example-supadata  ",
  });

  assert.equal(normalized.provider, "deepseek");
  assert.equal(normalized.aiBaseUrl, "https://api.deepseek.com");
  assert.equal(normalized.aiModel, "deepseek-v4-flash");
  assert.equal(normalized.aiApiKey, "example-key");
  assert.equal(normalized.supadataApiKey, "example-supadata");
  assert.equal(normalized.autoBasicOverview, false);
  assert.equal(
    settings.chatCompletionsUrl(),
    "https://api.deepseek.com/chat/completions",
  );
});

test("automatic basic overview requires strict, explicit boolean consent", () => {
  assert.equal(settings.normalize({ autoBasicOverview: true }).autoBasicOverview, true);
  for (const value of [false, 1, "true", null, undefined, {}, []]) {
    assert.equal(
      settings.normalize({ autoBasicOverview: value }).autoBasicOverview,
      false,
    );
  }
});

test("provider settings merge independently without losing canonical settings", () => {
  const start = settings.normalize({
    supadataApiKey: "supadata-old",
    aiApiKey: "deepseek-old",
    autoBasicOverview: false,
  });

  assert.deepEqual(
    settings.mergeProviderSettings(start, "supadata", " supadata-new "),
    { ...start, supadataApiKey: "supadata-new" },
  );
  assert.deepEqual(
    settings.mergeProviderSettings(start, "deepseek", " deepseek-new ", {
      autoBasicOverview: true,
    }),
    { ...start, aiApiKey: "deepseek-new", autoBasicOverview: true },
  );
  assert.deepEqual(
    settings.mergeProviderSettings(start, "deepseek", "next", {
      autoBasicOverview: "true",
    }),
    { ...start, aiApiKey: "next" },
  );
  assert.deepEqual(
    settings.mergeProviderSettings(start, "deepseek", "next", null),
    { ...start, aiApiKey: "next" },
  );
  assert.throws(
    () => settings.mergeProviderSettings(start, "unknown", "secret"),
    /provider/i,
  );
});

test("legacy custom migration clears only the AI key and is idempotent", () => {
  const legacy = {
    provider: "custom",
    aiApiKey: "custom-secret",
    aiBaseUrl: "https://api.example.com/v1",
    aiModel: "example-model",
    supadataApiKey: " supadata-secret ",
  };
  const first = settings.migrateLegacyCustom(legacy);

  assert.equal(first.migrated, true);
  assert.equal(first.settings.provider, "deepseek");
  assert.equal(first.settings.aiBaseUrl, settings.DEFAULTS.aiBaseUrl);
  assert.equal(first.settings.aiModel, settings.DEFAULTS.aiModel);
  assert.equal(first.settings.aiApiKey, "");
  assert.equal(first.settings.supadataApiKey, "supadata-secret");
  assert.equal(first.settings.autoBasicOverview, false);

  const second = settings.migrateLegacyCustom(first.settings);
  assert.equal(second.migrated, false);
  assert.deepEqual(second.settings, first.settings);

  const configuredDeepSeek = settings.normalize({
    ...first.settings,
    aiApiKey: "new-deepseek-key",
  });
  assert.equal(configuredDeepSeek.aiApiKey, "new-deepseek-key");
});

test("Supadata receives a canonical YouTube URL", () => {
  assert.equal(
    settings.canonicalYouTubeUrl("ydTeb_I0b94"),
    "https://www.youtube.com/watch?v=ydTeb_I0b94",
  );
  assert.throws(
    () => settings.canonicalYouTubeUrl('"><script>'),
    /Invalid YouTube video ID/,
  );
});
