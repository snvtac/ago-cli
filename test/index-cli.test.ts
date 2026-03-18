import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { filterProjectsByNameQuery, getRecommendedTool, normalizeArgv } from "../src/index.js";
import { TOOL_CODEX, TOOL_CLAUDE } from "../src/project-index.js";

test("normalizeArgv maps -al to --all", () => {
  const argv = ["node", "dist/cli.js", "-al"];
  assert.deepEqual(normalizeArgv(argv), ["node", "dist/cli.js", "--all"]);
});

test("normalizeArgv keeps -n and still maps -al", () => {
  const argv = ["node", "dist/cli.js", "-al", "-n", "sample"];
  assert.deepEqual(normalizeArgv(argv), ["node", "dist/cli.js", "--all", "-n", "sample"]);
});

test("filterProjectsByNameQuery fuzzy matches name and path", () => {
  const projects = [
    {
      name: "sample-website",
      path: "/Users/a/sample-website",
      sourceLabel: "both" as const,
      exists: true,
      lastSeenAt: 1,
      lastSeenAtByTool: { codex: 1, claude: 1 },
      sources: ["codex", "claude"] as ("codex" | "claude")[],
    },
    {
      name: "ago-cli",
      path: "/Users/a/ago-cli",
      sourceLabel: "codex" as const,
      exists: true,
      lastSeenAt: 1,
      lastSeenAtByTool: { codex: 1, claude: 0 },
      sources: ["codex"] as ("codex" | "claude")[],
    },
  ];

  const byName = filterProjectsByNameQuery(projects, "sample");
  const byPath = filterProjectsByNameQuery(projects, "ago-cli");

  assert.equal(byName.length, 1);
  assert.equal(byName[0]?.name, "sample-website");
  assert.equal(byPath.length, 1);
  assert.equal(byPath[0]?.name, "ago-cli");
});

test("getRecommendedTool uses state first", () => {
  const projectPath = path.resolve("/tmp/demo");
  const recommended = getRecommendedTool(
    {
      path: projectPath,
      name: "demo",
      sourceLabel: "both",
      exists: true,
      lastSeenAt: 200,
      sources: ["codex", "claude"],
      lastSeenAtByTool: { codex: 100, claude: 200 },
    },
    { lastLaunchedByPath: { [projectPath]: TOOL_CODEX } },
    { roots: [], claudeCommand: "claude", preferredTool: "claude" }
  );

  assert.equal(recommended, TOOL_CODEX);
});

test("getRecommendedTool falls back to most recent historical tool", () => {
  const recommended = getRecommendedTool(
    {
      path: "/tmp/demo-2",
      name: "demo-2",
      sourceLabel: "both",
      exists: true,
      lastSeenAt: 200,
      sources: ["codex", "claude"],
      lastSeenAtByTool: { codex: 100, claude: 200 },
    },
    { lastLaunchedByPath: {} },
    { roots: [], claudeCommand: "claude", preferredTool: "codex" }
  );

  assert.equal(recommended, TOOL_CLAUDE);
});

test("getRecommendedTool prefers single observed tool when only one exists", () => {
  const codexOnly = getRecommendedTool(
    {
      path: "/tmp/codex-only",
      name: "codex-only",
      sourceLabel: "codex",
      exists: true,
      lastSeenAt: 50,
      sources: ["codex"],
      lastSeenAtByTool: { codex: 50, claude: 0 },
    },
    { lastLaunchedByPath: {} },
    { roots: [], claudeCommand: "claude", preferredTool: "claude" }
  );

  const claudeOnly = getRecommendedTool(
    {
      path: "/tmp/claude-only",
      name: "claude-only",
      sourceLabel: "claude",
      exists: true,
      lastSeenAt: 60,
      sources: ["claude"],
      lastSeenAtByTool: { codex: 0, claude: 60 },
    },
    { lastLaunchedByPath: {} },
    { roots: [], claudeCommand: "claude", preferredTool: "codex" }
  );

  assert.equal(codexOnly, TOOL_CODEX);
  assert.equal(claudeOnly, TOOL_CLAUDE);
});
