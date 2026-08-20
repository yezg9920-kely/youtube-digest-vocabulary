const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function releaseShellArray(name) {
  const releaseCheck = read("scripts/check-release.sh");
  const match = releaseCheck.match(new RegExp(`${name}=\\(([\\s\\S]*?)\\n\\)`));
  assert.ok(match, `Expected ${name} in release check`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

test("manifest uses minimized install-time permissions", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const packageJson = JSON.parse(read("package.json"));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, "116");
  assert.equal(packageJson.version, manifest.version);
  assert.equal(manifest.options_ui.page, "options.html");
  assert.ok(!manifest.permissions.includes("activeTab"));
  assert.ok(manifest.host_permissions.includes("https://api.deepseek.com/*"));
  assert.equal(Object.hasOwn(manifest, "optional_host_permissions"), false);
  assert.equal(manifest.version, "1.1.5");
});

test("shared transcript core loads before both extension consumers and is publishable", () => {
  const html = read("sidepanel.html");
  const sidepanel = read("sidepanel.js");
  const background = read("background.js");
  const releaseCheck = read("scripts/check-release.sh");
  const coreIndex = html.indexOf('<script src="transcript-core.js"></script>');
  const panelIndex = html.indexOf('<script src="sidepanel.js"></script>');

  assert.ok(coreIndex >= 0 && coreIndex < panelIndex);
  assert.match(
    background,
    /importScripts\([\s\S]*?"transcript-core\.js"[\s\S]*?\);/,
  );
  assert.doesNotMatch(sidepanel, /function groupTranscriptEntries\s*\(/);
  assert.doesNotMatch(sidepanel, /function splitOversizedThought\s*\(/);
  assert.match(
    sidepanel,
    /const\s*\{[\s\S]*?groupTranscriptEntries[\s\S]*?\}\s*=\s*YTD_TRANSCRIPT_CORE/,
  );
  assert.ok(releaseShellArray("public_allowlist").includes("transcript-core.js"));
  assert.ok(releaseShellArray("required_public_files").includes("transcript-core.js"));
  assert.match(
    releaseCheck,
    /const importScriptCalls = source\.matchAll\([\s\S]*?for \(const importScriptCall of importScriptCalls\)[\s\S]*?importScriptCall\[1\]\.matchAll/,
  );
});

test("basic overview core and prompt load in order and are publishable", () => {
  const html = read("sidepanel.html");
  const background = read("background.js");
  const transcriptIndex = html.indexOf(
    '<script src="transcript-core.js"></script>',
  );
  const overviewIndex = html.indexOf('<script src="overview-core.js"></script>');
  const panelIndex = html.indexOf('<script src="sidepanel.js"></script>');

  assert.ok(
    transcriptIndex >= 0 &&
      transcriptIndex < overviewIndex &&
      overviewIndex < panelIndex,
  );
  assert.match(
    background,
    /importScripts\([\s\S]*?"transcript-core\.js"[\s\S]*?"overview-core\.js"[\s\S]*?\);/,
  );
  assert.match(
    background,
    /loadPromptSection\s*\(\s*"overview\.md",\s*"System prompt"/,
  );
  for (const file of ["overview-core.js", "prompts/overview.md"]) {
    assert.ok(releaseShellArray("public_allowlist").includes(file));
    assert.ok(releaseShellArray("required_public_files").includes(file));
  }
});

test("release copy documents current scope without em dashes", () => {
  const readme = read("README.md");
  const chineseReadme = read("README.zh-CN.md");
  const manifest = JSON.parse(read("manifest.json"));
  const packageJson = JSON.parse(read("package.json"));

  assert.doesNotMatch(readme, /—/);
  assert.doesNotMatch(chineseReadme, /—/);
  assert.doesNotMatch(manifest.description, /—/);
  assert.doesNotMatch(packageJson.description, /—/);

  assert.equal(manifest.name, "YouTube Digest Vocabulary");
  assert.equal(packageJson.name, "youtube-digest-vocabulary");
  assert.match(
    read("scripts/package-extension.sh"),
    /youtube-digest-vocabulary-v\$version\.zip/,
  );
  assert.doesNotMatch(
    [readme, chineseReadme, read("PRIVACY.md"), read("SECURITY.md")].join("\n"),
    /\bYT Digest\b/,
  );
  assert.match(readme, /^# YouTube Digest Vocabulary$/m);
  assert.match(
    readme,
    /Turn every YouTube video into a resource for deep learning\./,
  );
  assert.doesNotMatch(readme, /before deciding how much of it to watch/i);
  assert.match(readme, /^## Install with your coding agent$/m);
  assert.match(
    readme,
    /permanent folder I choose[\s\S]*tell me its exact full path[\s\S]*If I need a suggestion during this first installation[\s\S]*`~\/Documents\/youtube-digest`[\s\S]*`%USERPROFILE%\\Documents\\youtube-digest`[\s\S]*do not assume either path/,
  );
  assert.match(
    readme,
    /Moving or deleting the source folder breaks the unpacked extension until you load it again from the new location\./,
  );
  assert.match(
    readme,
    /selecting the exact project folder you chose in Chrome with \*\*Load unpacked\*\*/,
  );
  assert.match(
    readme,
    /Select the exact project folder you chose, which must contain `manifest\.json`/,
  );
  assert.match(readme, /upstream issues and pull requests are not accepted/i);
  assert.doesNotMatch(readme, /^## Contributing$/m);
  assert.match(chineseReadme, /^# YouTube Digest Vocabulary$/m);
  assert.match(chineseReadme, /把每个 YouTube 视频变成一份可以深入学习的资料/);
  assert.match(chineseReadme, /^## 让你的编程 Agent 帮你安装$/m);
  assert.match(
    chineseReadme,
    /我选择的长期保留文件夹[\s\S]*告诉我准确的完整路径[\s\S]*第一次安装时需要位置建议[\s\S]*`~\/Documents\/youtube-digest`[\s\S]*`%USERPROFILE%\\Documents\\youtube-digest`[\s\S]*不要假设我一定使用这些路径/,
  );
  assert.match(
    chineseReadme,
    /如果移动或删除源代码文件夹，Chrome 中加载的扩展会失效，需要从新的位置重新加载。/,
  );
  assert.match(
    chineseReadme,
    /“加载已解压的扩展程序”选择你刚才确定的那个准确项目文件夹/,
  );
  assert.match(
    chineseReadme,
    /选择你刚才确定的那个准确项目文件夹，其中必须包含 `manifest\.json`/,
  );
  assert.match(chineseReadme, /不接受上游 Issue 或 Pull Request/);
  assert.match(chineseReadme, /增加更多翻译语言/);

  assert.match(readme, /100 credits per month/i);
  assert.match(readme, /native transcript request uses \*\*1 credit\*\*/i);
  assert.match(readme, /generated transcript costs \*\*2 credits per video minute\*\*/i);
  assert.match(readme, /HTTP `206` still uses \*\*1 credit\*\*/i);
  assert.match(readme, /forces `mode=native`/i);
  assert.match(readme, /roughly 100 transcript lookups per month/i);
  assert.match(readme, /supadata\.ai\/pricing/i);
  assert.match(readme, /docs\.supadata\.ai\/get-transcript/i);
  assert.match(readme, /dash\.supadata\.ai\/auth\/sign-up/i);
  assert.match(readme, /platform\.deepseek\.com\/api_keys/i);
  assert.match(readme, /api-docs\.deepseek\.com/i);
  assert.match(readme, /api-docs\.deepseek\.com\/quick_start\/pricing/i);
  assert.match(readme, /api-docs\.deepseek\.com\/quick_start\/token_usage/i);
  assert.match(readme, /api-docs\.deepseek\.com\/guides\/kv_cache/i);
  assert.match(readme, /\$0\.0028[\s\S]*\$0\.14[\s\S]*\$0\.28/);
  assert.match(readme, /2,935 spoken English words/i);
  assert.match(readme, /about 32,600 input tokens/i);
  assert.match(readme, /\$0\.002[^\n]*\$0\.006 USD/i);
  assert.match(chineseReadme, /api-docs\.deepseek\.com\/quick_start\/pricing/i);
  assert.match(chineseReadme, /api-docs\.deepseek\.com\/quick_start\/token_usage/i);
  assert.match(chineseReadme, /api-docs\.deepseek\.com\/guides\/kv_cache/i);
  assert.match(chineseReadme, /\u00a50\.02[\s\S]*\u00a51[\s\S]*\u00a52/);
  assert.match(chineseReadme, /2,935 \u4e2a\u82f1\u6587\u53e3\u8bed\u8bcd/);
  assert.match(chineseReadme, /\u7ea6 32,600 \u4e2a\u8f93\u5165 token/);
  assert.match(chineseReadme, /\$0\.002[^\n]*\$0\.006 USD/);
  assert.match(chineseReadme, /dash\.supadata\.ai\/auth\/sign-up/i);
  assert.match(chineseReadme, /platform\.deepseek\.com\/api_keys/i);
  assert.match(readme, /^### The Digest button is missing on a YouTube video$/m);
  assert.match(
    chineseReadme,
    /^### YouTube 视频页面没有显示 Digest 按钮$/m,
  );

  const optionsPage = read("options.html");
  const optionsStyles = read("options.css");
  const optionsScript = read("options.js");
  assert.match(optionsPage, /dash\.supadata\.ai\/auth\/sign-up/i);
  assert.match(optionsPage, /platform\.deepseek\.com\/api_keys/i);
  assert.doesNotMatch(optionsPage, /<select\b/i);
  assert.doesNotMatch(optionsPage, /id="(?:provider|aiBaseUrl|aiModel)"/);
  const detailsTag = optionsPage.match(
    /<details\b[^>]*class="card customization-card"[^>]*>/,
  );
  assert.ok(detailsTag, "Expected a native Local remix details disclosure");
  assert.doesNotMatch(detailsTag[0], /\sopen(?:\s|=|>)/i);
  assert.match(
    optionsPage,
    /<summary class="customization-summary">[\s\S]*Want to use another AI model\?[\s\S]*Edit and copy a safe prompt for your coding agent[\s\S]*<\/summary>/,
  );
  assert.match(
    optionsPage,
    /class="customization-steps"[\s\S]*Open the extracted YouTube Digest Vocabulary project folder in your coding[\s\S]*Replace \[PROVIDER\] and \[MODEL\][\s\S]*Never include API keys[\s\S]*<\/ol>/,
  );
  assert.match(
    optionsPage,
    /class="prompt-reminder"[\s\S]*Before copying, replace \[PROVIDER\] and \[MODEL\]/,
  );
  assert.doesNotMatch(optionsPage, /~\/Documents\/youtube-digest/);
  assert.doesNotMatch(optionsPage, /%USERPROFILE%\\Documents\\youtube-digest/);
  assert.match(optionsPage, /id="copyCustomizationPromptBtn"/);
  assert.match(optionsStyles, /\.customization-summary:hover\s*\{/);
  assert.match(optionsStyles, /\.customization-summary:focus-visible\s*\{/);
  assert.match(optionsStyles, /\.data-card\s*\{[^}]*margin-top:\s*36px;/);
  assert.match(optionsScript, /clipboard\.writeText/);
  assert.match(optionsScript, /Edited prompt copied\./);
  assert.match(optionsScript, /migration\.migrated[\s\S]*storage\.set/);

  const customizationPrompt = `Customize this local YouTube Digest Vocabulary workspace to use [PROVIDER] with [MODEL]. Work only in the current workspace. Before editing, verify that it contains manifest.json and that the manifest name is YouTube Digest Vocabulary. If verification fails, stop and ask me to open the extracted YouTube Digest Vocabulary project folder in my coding agent. Do not search other folders, edit a guessed copy, assume an installation path, or claim Chrome can reveal the absolute OS source path. Update the provider's API endpoint, request format, and minimum Chrome host permissions. Preserve bring-your-own-key and local Chrome storage. Never put API keys in source code, commits, logs, screenshots, this prompt, or chat; after the code is ready, tell me where to enter the key myself. Keep DeepSeek-only request fields and retry behavior isolated to DeepSeek. Handle provider-specific rules separately so one provider does not affect another. Update README.md, README.zh-CN.md, PRIVACY.md, SECURITY.md, and tests. Run npm test, npm run check, and npm run package. Then explain how to reload the unpacked extension and test it on a real YouTube video.`;
  assert.ok(optionsPage.includes(`>${customizationPrompt}</textarea>`));
  assert.doesNotMatch(customizationPrompt, /Documents|USERPROFILE/);

  assert.match(readme, /^## Remix it with your coding agent$/m);
  assert.match(readme, /more translation languages/i);
  assert.match(readme, /customized summary templates/i);
  assert.match(readme, /vocabulary notebook/i);
  assert.match(
    readme,
    /first open the exact YouTube Digest Vocabulary project folder that Chrome loaded through \*\*Load unpacked\*\* in your coding agent/,
  );
  assert.match(
    chineseReadme,
    /先在编程 Agent 中打开 Chrome 通过“加载已解压的扩展程序”使用的那个准确的 YouTube Digest Vocabulary 项目文件夹/,
  );

  const publishedDocs = [
    readme,
    chineseReadme,
    read("PRIVACY.md"),
    read("SECURITY.md"),
  ].join("\n");
  assert.doesNotMatch(publishedDocs, /custom OpenAI-compatible/i);
  assert.doesNotMatch(publishedDocs, /optional custom-origin/i);
  assert.doesNotMatch(publishedDocs, /chosen AI provider/i);
  assert.doesNotMatch(publishedDocs, /configure a different OpenAI-compatible/i);
  assert.match(readme, /published version supports DeepSeek V4 Flash as its only AI provider/i);
  assert.match(chineseReadme, /发布版本只支持 DeepSeek V4 Flash/);
});

test("release credits the original project and labels this repository as a derivative", () => {
  const readme = read("README.md");
  const chineseReadme = read("README.zh-CN.md");
  const notice = read("NOTICE.md");
  const license = read("LICENSE");
  const upstreamUrl = "https://github.com/zarazhangrui/youtube-digest";

  assert.match(readme, /^## Attribution and derivative-work notice$/m);
  assert.ok(readme.includes(upstreamUrl));
  assert.match(readme, /original project/i);
  assert.match(readme, /derivative work|remix/i);
  assert.match(readme, /thank you to Zara Zhang/i);
  assert.match(readme, /not the official upstream repository/i);

  assert.match(chineseReadme, /^## 原项目与二次创作说明$/m);
  assert.ok(chineseReadme.includes(upstreamUrl));
  assert.match(chineseReadme, /原创来源/);
  assert.match(chineseReadme, /二次创作/);
  assert.match(chineseReadme, /感谢 Zara Zhang/);
  assert.match(chineseReadme, /并非原项目的官方仓库/);

  assert.ok(notice.includes(upstreamUrl));
  assert.match(notice, /Original project: YouTube Digest/);
  assert.match(notice, /Original author and copyright holder: Zara Zhang/);
  assert.match(notice, /derivative work \(remix\)/i);
  assert.match(notice, /感谢 Zara Zhang/);
  assert.match(notice, /Copyright \(c\) 2026 Zara Zhang/);
  assert.match(license, /Copyright \(c\) 2026 Zara Zhang/);

  for (const file of ["NOTICE.md", "LICENSE"]) {
    assert.ok(releaseShellArray("public_allowlist").includes(file));
    assert.ok(releaseShellArray("required_public_files").includes(file));
  }
});

test("release workflow refreshes assets and repeats the original-project credit", () => {
  const workflow = read(".github/workflows/release.yml");

  assert.match(workflow, /gh release upload[\s\S]*--clobber/);
  assert.match(workflow, /gh release edit[\s\S]*--notes-file/);
  assert.match(
    workflow,
    /https:\/\/github\.com\/zarazhangrui\/youtube-digest/,
  );
  assert.match(workflow, /二次创作/);
  assert.match(workflow, /感谢 Zara Zhang/);
  assert.match(workflow, /Thank you to Zara Zhang/);
  assert.match(workflow, /Attribution and derivative-work notice/);
  assert.match(workflow, /What's included \/ 本次版本亮点/);
  assert.match(workflow, /Installation \/ 安装/);
  assert.match(workflow, /Checksum \/ 校验值/);
  assert.match(workflow, /并非原项目的官方仓库/);
});

test("package file enumeration keeps test reporter output off stdout", () => {
  const releaseCheck = read("scripts/check-release.sh");

  assert.match(
    releaseCheck,
    /if \[\[ "\$mode" == "--print-files" \]\]; then[\s\S]*node --test tests\/\*\.test\.js >&2[\s\S]*else[\s\S]*node --test tests\/\*\.test\.js/,
  );
});

test("notes filters preserve selected contrast and expose pressed state", () => {
  const html = read("sidepanel.html");
  const css = read("sidepanel.css");
  const js = read("sidepanel.js");

  assert.match(
    html,
    /id="notesFilterThis"[\s\S]*?aria-pressed="true"[\s\S]*?>[\s\S]*?This Video/,
  );
  assert.match(
    html,
    /id="notesFilterAll"[\s\S]*?aria-pressed="false"[\s\S]*?>[\s\S]*?All Notes/,
  );
  assert.match(
    css,
    /\.notes-filter \.enhance-btn\.active:hover:not\(:disabled\)\s*\{[^}]*background:\s*var\(--accent-hover\);[^}]*color:\s*white;/,
  );
  assert.match(
    css,
    /\.notes-filter \.enhance-btn:hover:not\(:disabled\)\s*\{[^}]*background:\s*transparent;[^}]*color:\s*var\(--text-secondary\);/,
  );
  assert.match(css, /\.notes-filter \.enhance-btn:focus-visible\s*\{[^}]*outline:/);
  assert.match(js, /setNotesFilter\(false\)/);
  assert.match(js, /setNotesFilter\(true\)/);
  assert.match(js, /setAttribute\("aria-pressed", String\(!showAll\)\)/);
  assert.match(js, /setAttribute\("aria-pressed", String\(showAll\)\)/);
});

test("runtime has no source-file credential dependency or retired model", () => {
  const runtimeFiles = [
    "background.js",
    "content.js",
    "persistence.js",
    "providers.js",
    "transcript-core.js",
    "overview-core.js",
    "sidepanel.js",
    "options.js",
    "settings.js",
  ];
  const runtime = runtimeFiles.map(read).join("\n");
  const releaseCheck = read("scripts/check-release.sh");
  const shellArray = (name) => {
    const match = releaseCheck.match(new RegExp(`${name}=\\(([\\s\\S]*?)\\n\\)`));
    assert.ok(match, `Expected ${name} in release check`);
    return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
  };

  assert.doesNotMatch(runtime, /\bCONFIG\./);
  assert.doesNotMatch(runtime, /importScripts\(["']config\.js/);
  assert.doesNotMatch(runtime, /\bdeepseek-chat\b/);
  assert.match(runtime, /deepseek-v4-flash/);
  assert.ok(shellArray("public_allowlist").includes("providers.js"));
  assert.ok(shellArray("required_public_files").includes("providers.js"));
  assert.ok(shellArray("public_allowlist").includes("persistence.js"));
  assert.ok(shellArray("required_public_files").includes("persistence.js"));
  assert.match(
    releaseCheck,
    /credential_scan_files=\("\$\{release_files\[@\]\}"\)/,
  );
});

test("retired Remix and reader files are absent", () => {
  for (const file of [
    "reader.html",
    "reader.js",
    "remix-prompts.js",
    "config.example.js",
  ]) {
    assert.equal(fs.existsSync(path.join(root, file)), false, file);
  }
});

test("published prompt files contain runtime sections", () => {
  const expectedSections = {
    "prompts/analysis.md": ["System prompt", "User prompt"],
    "prompts/explain.md": ["System prompt", "User prompt"],
    "prompts/note-cleanup.md": ["System prompt", "User prompt"],
    "prompts/translation.md": [
      "Shared base rules",
      "Chinese rules",
      "Transcript batch translation",
    ],
    "prompts/vocabulary.md": ["System prompt", "User prompt"],
  };

  for (const [file, sections] of Object.entries(expectedSections)) {
    const markdown = read(file);
    for (const section of sections) {
      assert.match(markdown, new RegExp(`^## ${section}$`, "m"));
    }
  }
});

test("release docs explain vocabulary capture, export, limits, and privacy", () => {
  const readme = read("README.md");
  const chineseReadme = read("README.zh-CN.md");
  const privacy = read("PRIVACY.md");

  assert.match(readme, /click an English word/i);
  assert.match(readme, /explicitly choose.*Add to vocabulary/i);
  assert.match(readme, /CSV, Markdown, and Anki TSV/);
  assert.match(readme, /mnemonic.*not.*etymology/i);
  assert.match(chineseReadme, /点击英文单词/);
  assert.match(chineseReadme, /明确点击.*加入生词库/);
  assert.match(chineseReadme, /CSV、Markdown 和 Anki TSV/);
  assert.match(chineseReadme, /记忆线索.*词源/);
  assert.match(privacy, /clicked word/i);
  assert.match(privacy, /saved vocabulary cards/i);
  assert.match(privacy, /not saved automatically/i);
  assert.match(privacy, /exports are generated locally/i);
});

test("release docs explain transcript downloads and deep-analysis study packs", () => {
  const readme = read("README.md");
  const chineseReadme = read("README.zh-CN.md");
  const privacy = read("PRIVACY.md");
  const manifest = JSON.parse(read("manifest.json"));

  assert.match(readme, /raw TXT/i);
  assert.match(readme, /Clean MD/);
  assert.match(readme, /Report MD/);
  assert.match(readme, /Study Pack/);
  assert.match(readme, /only when you open Overview or choose Regenerate/i);
  assert.match(readme, /older cached Overview.*rebuilt/i);
  assert.match(readme, /transcript and report downloads are generated locally/i);

  assert.match(chineseReadme, /原始 TXT/);
  assert.match(chineseReadme, /Clean MD/);
  assert.match(chineseReadme, /Report MD/);
  assert.match(chineseReadme, /Study Pack/);
  assert.match(chineseReadme, /打开 Overview 或点击 Regenerate 时才/);
  assert.match(chineseReadme, /旧版.*缓存.*重新生成/);
  assert.match(chineseReadme, /逐字稿和报告下载文件.*本地生成/);

  assert.match(
    privacy,
    /complete timestamped transcript.*video metadata.*when you open Overview or explicitly regenerate/i,
  );
  assert.match(
    privacy,
    /raw transcript, cleaned transcript, deep-analysis report, and complete study-pack exports are generated locally/i,
  );
  assert.deepEqual(manifest.permissions, [
    "sidePanel",
    "storage",
    "tabs",
    "scripting",
  ]);
  assert.deepEqual(manifest.host_permissions, [
    "https://www.youtube.com/*",
    "https://api.supadata.ai/*",
    "https://api.deepseek.com/*",
  ]);
});
