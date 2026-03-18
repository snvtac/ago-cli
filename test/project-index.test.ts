import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  TOOL_CLAUDE,
  TOOL_CODEX,
  filterProjectsByRoots,
  mergeProjectObservations,
  parseClaudeSessionsIndexFile,
  parseCodexSessionFile,
  pickDefaultTool,
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
