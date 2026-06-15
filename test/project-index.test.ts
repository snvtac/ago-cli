import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  TOOL_CLAUDE,
  TOOL_CODEX,
  addPinnedPath,
  collectClaudeFromTranscripts,
  collectClaudeObservations,
  filterProjectsByRoots,
  frecencyWeight,
  getClaudeHistoryPath,
  getClaudeProjectsDir,
  getCodexSessionsDir,
  inspectConfig,
  inspectJsonFile,
  inspectState,
  loadState,
  mergeProjectObservations,
  normalizeState,
  parseClaudeHistoryFile,
  parseClaudeSessionsIndexFile,
  parseCodexSessionFile,
  pickDefaultTool,
  removePinnedPath,
  resolveConfiguredRoot,
  saveState,
  toEpochMs,
} from "../src/project-index.js";

async function withTempDir(fn: (tempDir: string) => Promise<void>): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ago-cli-test-"));
  try {
    await fn(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("parseCodexSessionFile extracts cwd and timestamp", async () => {
  await withTempDir(async (tempDir) => {
    const sessionPath = path.join(tempDir, "rollout.jsonl");
    const sessionJson = {
      timestamp: "2026-03-18T12:00:00.000Z",
      payload: {
        cwd: "/tmp/demo-project",
      },
    };

    await fs.writeFile(sessionPath, `${JSON.stringify(sessionJson)}\n{"ignored":true}\n`, "utf8");

    const parsed = await parseCodexSessionFile(sessionPath);

    assert.ok(parsed);
    assert.equal(parsed.tool, TOOL_CODEX);
    assert.equal(parsed.path, path.resolve("/tmp/demo-project"));
    assert.equal(parsed.lastSeenAt, Date.parse(sessionJson.timestamp));
  });
});

test("parseCodexSessionFile ignores invalid json", async () => {
  await withTempDir(async (tempDir) => {
    const sessionPath = path.join(tempDir, "invalid.jsonl");
    await fs.writeFile(sessionPath, "{not-json}\n", "utf8");

    const parsed = await parseCodexSessionFile(sessionPath);
    assert.equal(parsed, null);
  });
});

test("parseClaudeSessionsIndexFile extracts projectPath from entries", async () => {
  await withTempDir(async (tempDir) => {
    const indexPath = path.join(tempDir, "sessions-index.json");
    const payload = {
      entries: [
        {
          projectPath: "/tmp/claude-a",
          modified: "2026-03-18T10:00:00.000Z",
        },
        {
          projectPath: "/tmp/claude-b",
          fileMtime: 1760000000000,
        },
      ],
    };

    await fs.writeFile(indexPath, JSON.stringify(payload), "utf8");
    const parsed = await parseClaudeSessionsIndexFile(indexPath);

    assert.equal(parsed.length, 2);
    assert.equal(parsed[0]?.tool, TOOL_CLAUDE);
    assert.equal(parsed[0]?.path, path.resolve("/tmp/claude-a"));
    assert.equal(parsed[0]?.lastSeenAt, Date.parse("2026-03-18T10:00:00.000Z"));
    assert.equal(parsed[1]?.path, path.resolve("/tmp/claude-b"));
  });
});

test("parseClaudeSessionsIndexFile falls back to originalPath when entries are empty", async () => {
  await withTempDir(async (tempDir) => {
    const indexPath = path.join(tempDir, "sessions-index.json");
    await fs.writeFile(indexPath, JSON.stringify({ entries: [], originalPath: "/tmp/claude-original" }), "utf8");

    const parsed = await parseClaudeSessionsIndexFile(indexPath);

    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.path, path.resolve("/tmp/claude-original"));
    assert.equal(parsed[0]?.tool, TOOL_CLAUDE);
  });
});

test("mergeProjectObservations merges same path into both sources", () => {
  const merged = mergeProjectObservations([
    { path: "/tmp/one", tool: TOOL_CODEX, lastSeenAt: 10 },
    { path: "/tmp/one", tool: TOOL_CLAUDE, lastSeenAt: 30 },
    { path: "/tmp/two", tool: TOOL_CODEX, lastSeenAt: 20 },
  ]);

  assert.equal(merged.length, 2);
  assert.equal(merged[0]?.path, path.resolve("/tmp/one"));
  assert.equal(merged[0]?.sourceLabel, "both");
  assert.deepEqual(merged[0]?.sources, ["claude", "codex"]);
  assert.equal(merged[0]?.lastSeenAtByTool.codex, 10);
  assert.equal(merged[0]?.lastSeenAtByTool.claude, 30);
});

test("pickDefaultTool uses state first, then history, then preferredTool", () => {
  const project = {
    path: "/tmp/project-a",
    sourceLabel: "both" as const,
    lastSeenAtByTool: {
      codex: 100,
      claude: 200,
    },
  };

  const fromState = pickDefaultTool(
    project,
    { lastLaunchedByPath: { [path.resolve("/tmp/project-a")]: TOOL_CODEX } },
    { roots: [], claudeCommand: "claude", preferredTool: "claude" }
  );
  assert.equal(fromState, TOOL_CODEX);

  const fromHistory = pickDefaultTool(
    project,
    { lastLaunchedByPath: {} },
    { roots: [], claudeCommand: "claude", preferredTool: "codex" }
  );
  assert.equal(fromHistory, TOOL_CLAUDE);

  const fromPreferred = pickDefaultTool(
    {
      ...project,
      lastSeenAtByTool: { codex: 0, claude: 0 },
    },
    { lastLaunchedByPath: {} },
    { roots: [], claudeCommand: "claude", preferredTool: "codex" }
  );
  assert.equal(fromPreferred, TOOL_CODEX);
});

test("filterProjectsByRoots only keeps projects under configured roots", () => {
  const projects = [
    { path: "/workspace/a" },
    { path: "/workspace/b" },
    { path: "/other/c" },
  ];

  const filtered = filterProjectsByRoots(projects as never[], ["/workspace"]);
  assert.deepEqual(
    filtered.map((item) => item.path),
    ["/workspace/a", "/workspace/b"]
  );
});

test("toEpochMs parses epoch-millisecond strings", () => {
  assert.equal(toEpochMs("1780554836375"), 1780554836375);
});

test("toEpochMs upgrades epoch-second strings to milliseconds", () => {
  assert.equal(toEpochMs("1776852802"), 1776852802000);
});

test("toEpochMs still parses ISO date strings", () => {
  assert.equal(toEpochMs("2026-03-18T12:00:00.000Z"), Date.parse("2026-03-18T12:00:00.000Z"));
});

test("frecencyWeight buckets by age", () => {
  const hour = 3600_000;
  assert.equal(frecencyWeight(0), 4);
  assert.equal(frecencyWeight(2 * hour), 2);
  assert.equal(frecencyWeight(3 * 24 * hour), 0.5);
  assert.equal(frecencyWeight(30 * 24 * hour), 0.25);
});

test("mergeProjectObservations ranks frequent projects above a single recent one", () => {
  const now = 1_000_000_000_000;
  const hour = 3600_000;

  const observations = [
    { path: "/recent-once", tool: TOOL_CODEX, lastSeenAt: now - hour / 2 }, // weight 4
  ];
  for (let i = 0; i < 12; i += 1) {
    observations.push({ path: "/frequent", tool: TOOL_CODEX, lastSeenAt: now - 3 * 24 * hour }); // 12 * 0.5 = 6
  }

  const merged = mergeProjectObservations(observations, now);
  assert.equal(merged[0]?.path, path.resolve("/frequent"));
  assert.equal(merged[1]?.path, path.resolve("/recent-once"));
});

test("mergeProjectObservations records the newest sessionId per tool", () => {
  const merged = mergeProjectObservations(
    [
      { path: "/x", tool: TOOL_CODEX, lastSeenAt: 100, sessionId: "codex-old" },
      { path: "/x", tool: TOOL_CODEX, lastSeenAt: 300, sessionId: "codex-new" },
      { path: "/x", tool: TOOL_CLAUDE, lastSeenAt: 200, sessionId: "claude-1" },
    ],
    400
  );

  assert.equal(merged[0]?.lastSessionIdByTool.codex, "codex-new");
  assert.equal(merged[0]?.lastSessionIdByTool.claude, "claude-1");
});

test("parseCodexSessionFile extracts sessionId from payload.id", async () => {
  await withTempDir(async (tempDir) => {
    const sessionPath = path.join(tempDir, "rollout.jsonl");
    const sessionJson = {
      timestamp: "2026-03-18T12:00:00.000Z",
      payload: { id: "codex-session-1", cwd: "/tmp/demo-project" },
    };
    await fs.writeFile(sessionPath, `${JSON.stringify(sessionJson)}\n`, "utf8");

    const parsed = await parseCodexSessionFile(sessionPath);
    assert.equal(parsed?.sessionId, "codex-session-1");
  });
});

test("parseClaudeHistoryFile groups prompts by sessionId and keeps the latest time", async () => {
  await withTempDir(async (tempDir) => {
    const historyPath = path.join(tempDir, "history.jsonl");
    const lines = [
      { project: "/tmp/p1", timestamp: "1700000000000", sessionId: "s1" },
      { project: "/tmp/p1", timestamp: "1700000005000", sessionId: "s1" },
      { project: "/tmp/p2", timestamp: "1700000002000", sessionId: "s2" },
      "{not-json}",
    ]
      .map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)))
      .join("\n");
    await fs.writeFile(historyPath, `${lines}\n`, "utf8");

    const observations = await parseClaudeHistoryFile(historyPath);

    assert.equal(observations.length, 2);
    const s1 = observations.find((obs) => obs.sessionId === "s1");
    assert.equal(s1?.path, path.resolve("/tmp/p1"));
    assert.equal(s1?.tool, TOOL_CLAUDE);
    assert.equal(s1?.lastSeenAt, 1700000005000);
  });
});

test("collectClaudeFromTranscripts reads cwd from the newest transcript per dir", async () => {
  await withTempDir(async (home) => {
    const dir = path.join(home, ".claude", "projects", "-tmp-proj");
    await fs.mkdir(dir, { recursive: true });

    const olderFile = path.join(dir, "older.jsonl");
    await fs.writeFile(
      olderFile,
      `${JSON.stringify({ type: "user", cwd: "/tmp/proj", sessionId: "older", timestamp: "2026-01-01T00:00:00.000Z" })}\n`,
      "utf8"
    );

    const newerFile = path.join(dir, "newer.jsonl");
    const newerContent = [
      JSON.stringify({ type: "file-history-snapshot" }),
      JSON.stringify({ type: "permission-mode" }),
      JSON.stringify({ type: "user", cwd: "/tmp/proj", sessionId: "newer", timestamp: "2026-02-01T00:00:00.000Z" }),
    ].join("\n");
    await fs.writeFile(newerFile, `${newerContent}\n`, "utf8");

    const future = new Date(Date.now() + 60_000);
    await fs.utimes(newerFile, future, future);

    const observations = await collectClaudeFromTranscripts(home);

    assert.equal(observations.length, 1);
    assert.equal(observations[0]?.path, path.resolve("/tmp/proj"));
    assert.equal(observations[0]?.tool, TOOL_CLAUDE);
    assert.equal(observations[0]?.sessionId, "newer");
  });
});

test("collectClaudeObservations merges history + transcripts without double counting", async () => {
  await withTempDir(async (home) => {
    const claudeDir = path.join(home, ".claude");
    await fs.mkdir(claudeDir, { recursive: true });

    // history.jsonl has session s1 in /tmp/p1
    await fs.writeFile(
      path.join(claudeDir, "history.jsonl"),
      `${JSON.stringify({ project: "/tmp/p1", timestamp: "1700000000000", sessionId: "s1" })}\n`,
      "utf8"
    );

    // transcript dir for /tmp/p1 repeats s1 (must be deduped)
    const d1 = path.join(claudeDir, "projects", "-tmp-p1");
    await fs.mkdir(d1, { recursive: true });
    await fs.writeFile(
      path.join(d1, "s1.jsonl"),
      `${JSON.stringify({ type: "user", cwd: "/tmp/p1", sessionId: "s1", timestamp: "2026-01-01T00:00:00.000Z" })}\n`,
      "utf8"
    );

    // transcript dir for /tmp/p2 introduces a new session s2 (must be covered)
    const d2 = path.join(claudeDir, "projects", "-tmp-p2");
    await fs.mkdir(d2, { recursive: true });
    await fs.writeFile(
      path.join(d2, "s2.jsonl"),
      `${JSON.stringify({ type: "user", cwd: "/tmp/p2", sessionId: "s2", timestamp: "2026-01-01T00:00:00.000Z" })}\n`,
      "utf8"
    );

    const observations = await collectClaudeObservations(home);

    assert.deepEqual(observations.map((obs) => obs.sessionId).sort(), ["s1", "s2"]);
    assert.deepEqual(
      [...new Set(observations.map((obs) => obs.path))].sort(),
      [path.resolve("/tmp/p1"), path.resolve("/tmp/p2")]
    );
  });
});

test("normalizeState keeps a valid lastLaunch", () => {
  const state = normalizeState({
    lastLaunchedByPath: {},
    lastLaunch: { path: "/tmp/proj", tool: "codex", ts: 123 },
  });
  assert.equal(state.lastLaunch?.path, path.resolve("/tmp/proj"));
  assert.equal(state.lastLaunch?.tool, "codex");
  assert.equal(state.lastLaunch?.ts, 123);
});

test("normalizeState drops an invalid lastLaunch", () => {
  const state = normalizeState({ lastLaunchedByPath: {}, lastLaunch: { path: "/tmp/proj", tool: "bogus" } });
  assert.equal(state.lastLaunch, undefined);
});

test("normalizeState keeps lastLaunch even when lastLaunchedByPath is absent", () => {
  const state = normalizeState({ lastLaunch: { path: "/tmp/proj", tool: "codex", ts: 5 } });
  assert.equal(state.lastLaunch?.path, path.resolve("/tmp/proj"));
  assert.equal(state.lastLaunch?.tool, "codex");
});

test("path getters build the expected source locations under a home dir", () => {
  const home = path.resolve("/tmp/ago-home");
  assert.equal(getCodexSessionsDir(home), path.join(home, ".codex", "sessions"));
  assert.equal(getClaudeHistoryPath(home), path.join(home, ".claude", "history.jsonl"));
  assert.equal(getClaudeProjectsDir(home), path.join(home, ".claude", "projects"));
});

test("resolveConfiguredRoot expands ~ and resolves to absolute", () => {
  const home = path.resolve("/tmp/ago-home");
  assert.equal(resolveConfiguredRoot("~/git", home), path.join(home, "git"));
  assert.equal(resolveConfiguredRoot("/abs/path", home), path.resolve("/abs/path"));
  assert.equal(resolveConfiguredRoot("", home), "");
});

test("inspectJsonFile reports missing file as exists=false, validJson=true", async () => {
  await withTempDir(async (tempDir) => {
    const filePath = path.join(tempDir, "nope.json");
    const result = await inspectJsonFile(filePath);
    assert.equal(result.path, filePath);
    assert.equal(result.exists, false);
    assert.equal(result.validJson, true);
    assert.equal(result.raw, undefined);
  });
});

test("inspectJsonFile parses a valid JSON object", async () => {
  await withTempDir(async (tempDir) => {
    const filePath = path.join(tempDir, "ok.json");
    await fs.writeFile(filePath, JSON.stringify({ a: 1 }), "utf8");
    const result = await inspectJsonFile(filePath);
    assert.equal(result.exists, true);
    assert.equal(result.validJson, true);
    assert.deepEqual(result.raw, { a: 1 });
  });
});

test("inspectJsonFile reports invalid JSON with an error", async () => {
  await withTempDir(async (tempDir) => {
    const filePath = path.join(tempDir, "bad.json");
    await fs.writeFile(filePath, "{not json}", "utf8");
    const result = await inspectJsonFile(filePath);
    assert.equal(result.exists, true);
    assert.equal(result.validJson, false);
    assert.equal(typeof result.error, "string");
    assert.equal(result.raw, undefined);
  });
});

test("inspectJsonFile treats non-object JSON as valid with no raw", async () => {
  await withTempDir(async (tempDir) => {
    const filePath = path.join(tempDir, "scalar.json");
    await fs.writeFile(filePath, "5", "utf8");
    const result = await inspectJsonFile(filePath);
    assert.equal(result.exists, true);
    assert.equal(result.validJson, true);
    assert.equal(result.raw, undefined);
  });
});

test("inspectConfig on missing file returns defaults with all sources default", async () => {
  await withTempDir(async (tempDir) => {
    const configPath = path.join(tempDir, "config.json");
    const result = await inspectConfig(configPath);
    assert.equal(result.exists, false);
    assert.equal(result.validJson, true);
    assert.deepEqual(result.value, { roots: [], claudeCommand: "claude", preferredTool: "auto" });
    assert.deepEqual(result.sources, { roots: "default", claudeCommand: "default", preferredTool: "default" });
    assert.deepEqual(result.invalidKeys, []);
  });
});

test("inspectConfig marks present valid keys as file and absent keys as default", async () => {
  await withTempDir(async (tempDir) => {
    const configPath = path.join(tempDir, "config.json");
    await fs.writeFile(configPath, JSON.stringify({ roots: ["/Users/x/git"] }), "utf8");
    const result = await inspectConfig(configPath);
    assert.equal(result.exists, true);
    assert.equal(result.value.roots.length, 1);
    assert.equal(result.sources.roots, "file");
    assert.equal(result.sources.claudeCommand, "default");
    assert.equal(result.sources.preferredTool, "default");
    assert.deepEqual(result.invalidKeys, []);
  });
});

test("inspectConfig treats explicitly-written default values as file (regression for source rule)", async () => {
  await withTempDir(async (tempDir) => {
    const configPath = path.join(tempDir, "config.json");
    await fs.writeFile(configPath, JSON.stringify({ roots: [], claudeCommand: "claude", preferredTool: "auto" }), "utf8");
    const result = await inspectConfig(configPath);
    assert.deepEqual(result.sources, { roots: "file", claudeCommand: "file", preferredTool: "file" });
    assert.deepEqual(result.invalidKeys, []);
  });
});

test("inspectConfig records present-but-invalid keys and falls back to defaults", async () => {
  await withTempDir(async (tempDir) => {
    const configPath = path.join(tempDir, "config.json");
    await fs.writeFile(configPath, JSON.stringify({ roots: "nope", claudeCommand: 123, preferredTool: "banana" }), "utf8");
    const result = await inspectConfig(configPath);
    assert.deepEqual(result.value, { roots: [], claudeCommand: "claude", preferredTool: "auto" });
    assert.deepEqual(result.sources, { roots: "default", claudeCommand: "default", preferredTool: "default" });
    assert.deepEqual([...result.invalidKeys].sort(), ["claudeCommand", "preferredTool", "roots"]);
  });
});

test("inspectState on missing file returns defaults", async () => {
  await withTempDir(async (tempDir) => {
    const statePath = path.join(tempDir, "state.json");
    const result = await inspectState(statePath);
    assert.equal(result.exists, false);
    assert.equal(result.validJson, true);
    assert.equal(result.hasLastLaunch, false);
    assert.equal(result.lastLaunchPathExists, false);
    assert.equal(result.lastLaunchToolSupported, false);
    assert.deepEqual(result.value, { lastLaunchedByPath: {}, pinnedPaths: [] });
  });
});

test("inspectState reports invalid JSON", async () => {
  await withTempDir(async (tempDir) => {
    const statePath = path.join(tempDir, "state.json");
    await fs.writeFile(statePath, "{bad}", "utf8");
    const result = await inspectState(statePath);
    assert.equal(result.exists, true);
    assert.equal(result.validJson, false);
  });
});

test("inspectState flags a lastLaunch.path that no longer exists", async () => {
  await withTempDir(async (tempDir) => {
    const statePath = path.join(tempDir, "state.json");
    const missingProject = path.join(tempDir, "gone");
    await fs.writeFile(
      statePath,
      JSON.stringify({ lastLaunchedByPath: {}, lastLaunch: { path: missingProject, tool: "codex", ts: 1 } }),
      "utf8"
    );
    const result = await inspectState(statePath);
    assert.equal(result.hasLastLaunch, true);
    assert.equal(result.lastLaunchToolSupported, true);
    assert.equal(result.lastLaunchPathExists, false);
    assert.ok(result.value.lastLaunch);
  });
});

test("inspectState flags an unsupported lastLaunch.tool (dropped by normalization)", async () => {
  await withTempDir(async (tempDir) => {
    const statePath = path.join(tempDir, "state.json");
    await fs.writeFile(
      statePath,
      JSON.stringify({ lastLaunchedByPath: {}, lastLaunch: { path: tempDir, tool: "gemini", ts: 1 } }),
      "utf8"
    );
    const result = await inspectState(statePath);
    assert.equal(result.hasLastLaunch, true);
    assert.equal(result.lastLaunchToolSupported, false);
    assert.equal(result.value.lastLaunch, undefined);
  });
});

test("normalizeState defaults pinnedPaths to [] when absent", () => {
  const state = normalizeState({ lastLaunchedByPath: {} });
  assert.deepEqual(state.pinnedPaths, []);
});

test("normalizeState validates, normalizes, and dedupes pinnedPaths", () => {
  const state = normalizeState({
    lastLaunchedByPath: {},
    pinnedPaths: ["/tmp/a", "/tmp/a", "  ", 42, "/tmp/b/"],
  });
  assert.deepEqual(state.pinnedPaths, [path.resolve("/tmp/a"), path.resolve("/tmp/b")]);
});

test("normalizeState drops a non-array pinnedPaths", () => {
  const state = normalizeState({ lastLaunchedByPath: {}, pinnedPaths: "nope" });
  assert.deepEqual(state.pinnedPaths, []);
});

test("saveState/loadState round-trip preserves pinnedPaths AND lastLaunch", async () => {
  await withTempDir(async (tempDir) => {
    const statePath = path.join(tempDir, "state.json");
    await saveState(
      {
        lastLaunchedByPath: { [path.resolve("/tmp/p")]: "codex" },
        lastLaunch: { path: path.resolve("/tmp/p"), tool: "codex", ts: 7 },
        pinnedPaths: [path.resolve("/tmp/a")],
      } as never,
      statePath
    );
    const loaded = await loadState(statePath);
    assert.deepEqual(loaded.pinnedPaths, [path.resolve("/tmp/a")]);
    assert.equal(loaded.lastLaunch?.ts, 7);
    assert.equal(loaded.lastLaunchedByPath[path.resolve("/tmp/p")], "codex");
  });
});

test("addPinnedPath appends normalized path and is idempotent", () => {
  const once = addPinnedPath([], "/tmp/a/");
  assert.deepEqual(once, [path.resolve("/tmp/a")]);
  const twice = addPinnedPath(once, "/tmp/a");
  assert.deepEqual(twice, [path.resolve("/tmp/a")]);
});

test("removePinnedPath removes a normalized path and is a no-op when absent", () => {
  const start = [path.resolve("/tmp/a"), path.resolve("/tmp/b")];
  assert.deepEqual(removePinnedPath(start, "/tmp/a"), [path.resolve("/tmp/b")]);
  assert.deepEqual(removePinnedPath(start, "/tmp/zzz"), start);
});
