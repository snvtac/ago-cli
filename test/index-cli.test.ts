import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fsp from "node:fs/promises";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  buildLaunchArgs,
  buildResumeArgs,
  buildToolMenuChoices,
  filterProjectsByNameQuery,
  getRecommendedTool,
  normalizeArgv,
  parseCommandPromptOption,
  parseToolSelection,
  resolvePinTarget,
} from "../src/index.js";
import { TOOL_CODEX, TOOL_CLAUDE } from "../src/project-index.js";

const execFileAsync = promisify(execFile);

async function runCli(args: string[], homeDir: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const cliPath = path.resolve("src/cli.ts");
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", cliPath, ...args],
      { env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir } }
    );
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: typeof failure.code === "number" ? failure.code : 1 };
  }
}

async function withTempHome(fn: (homeDir: string) => Promise<void>): Promise<void> {
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ago-cli-home-"));
  try {
    await fn(homeDir);
  } finally {
    await fsp.rm(homeDir, { recursive: true, force: true });
  }
}

test("normalizeArgv maps -al to --all", () => {
  const argv = ["node", "dist/cli.js", "-al"];
  assert.deepEqual(normalizeArgv(argv), ["node", "dist/cli.js", "--all"]);
});

test("normalizeArgv keeps -n and still maps -al", () => {
  const argv = ["node", "dist/cli.js", "-al", "-n", "sample"];
  assert.deepEqual(normalizeArgv(argv), ["node", "dist/cli.js", "--all", "-n", "sample"]);
});

test("normalizeArgv keeps -c and still maps -al", () => {
  const argv = ["node", "dist/cli.js", "-al", "-n", "sample", "-c", "inspect repo"];
  assert.deepEqual(normalizeArgv(argv), ["node", "dist/cli.js", "--all", "-n", "sample", "-c", "inspect repo"]);
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

test("parseCommandPromptOption returns empty string when option is omitted", () => {
  assert.equal(parseCommandPromptOption(undefined), "");
});

test("parseCommandPromptOption trims valid content", () => {
  assert.equal(parseCommandPromptOption("  inspect repo  "), "inspect repo");
});

test("parseCommandPromptOption rejects whitespace-only content", () => {
  assert.throws(() => parseCommandPromptOption("   "), /non-empty content/i);
});

test("buildLaunchArgs returns empty args when no command content is provided", () => {
  assert.deepEqual(buildLaunchArgs(TOOL_CODEX, ""), []);
});

test("buildLaunchArgs passes initial content to codex", () => {
  assert.deepEqual(buildLaunchArgs(TOOL_CODEX, "inspect repo"), ["inspect repo"]);
});

test("buildLaunchArgs passes initial content to claude", () => {
  assert.deepEqual(buildLaunchArgs(TOOL_CLAUDE, "inspect repo"), ["inspect repo"]);
});

test("normalizeArgv maps a leading - to --last", () => {
  assert.deepEqual(normalizeArgv(["node", "dist/cli.js", "-"]), ["node", "dist/cli.js", "--last"]);
});

test("normalizeArgv leaves - alone when it is a -c value", () => {
  assert.deepEqual(
    normalizeArgv(["node", "dist/cli.js", "-c", "-"]),
    ["node", "dist/cli.js", "-c", "-"]
  );
});

test("buildResumeArgs builds codex and claude resume args", () => {
  assert.deepEqual(buildResumeArgs(TOOL_CODEX, "s1"), ["resume", "s1"]);
  assert.deepEqual(buildResumeArgs(TOOL_CLAUDE, "s1"), ["--resume", "s1"]);
  assert.deepEqual(buildResumeArgs(TOOL_CODEX, ""), []);
});

test("parseToolSelection decodes menu values", () => {
  assert.deepEqual(parseToolSelection("new:codex"), { tool: TOOL_CODEX, resume: false });
  assert.deepEqual(parseToolSelection("resume:claude"), { tool: TOOL_CLAUDE, resume: true });
  assert.equal(parseToolSelection("__back__"), null);
  assert.equal(parseToolSelection("garbage"), null);
});

test("buildToolMenuChoices shows continue only for tools with a last session", () => {
  const project = { lastSessionIdByTool: { claude: "c1" } } as never;
  const choices = buildToolMenuChoices(project, TOOL_CLAUDE, { dim: (value: string) => value });
  const values = choices.map((choice) => choice.value);

  assert.ok(values.includes("resume:claude"));
  assert.ok(values.includes("new:claude"));
  assert.ok(values.includes("new:codex"));
  assert.ok(!values.includes("resume:codex"));
  assert.equal(values[values.length - 1], "__back__");
});

test("ago config show on empty home prints default config JSON with formatVersion", async () => {
  await withTempHome(async (homeDir) => {
    const result = await runCli(["config", "show"], homeDir);
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.formatVersion, "1.0");
    assert.equal(parsed.exists, false);
    assert.deepEqual(parsed.value, { roots: [], claudeCommand: "claude", preferredTool: "auto" });
  });
});

test("ago config show on invalid config exits 1 with validJson false", async () => {
  await withTempHome(async (homeDir) => {
    const agoDir = path.join(homeDir, ".ago");
    await fsp.mkdir(agoDir, { recursive: true });
    await fsp.writeFile(path.join(agoDir, "config.json"), "{bad}", "utf8");
    const result = await runCli(["config", "show"], homeDir);
    assert.equal(result.code, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.validJson, false);
  });
});

test("bare ago config prints help and exits 0", async () => {
  await withTempHome(async (homeDir) => {
    const result = await runCli(["config"], homeDir);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /show/);
  });
});

test("ago doctor on empty home prints parseable JSON, status not error", async () => {
  await withTempHome(async (homeDir) => {
    const result = await runCli(["doctor"], homeDir);
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.formatVersion, "1.0");
    assert.ok(["ok", "warning"].includes(parsed.status));
    assert.ok(Array.isArray(parsed.checks));
    assert.equal(parsed.errorCount, 0);
  });
});

test("ago doctor exits 1 when a Claude command is missing but observations exist", async () => {
  await withTempHome(async (homeDir) => {
    const claudeDir = path.join(homeDir, ".claude");
    await fsp.mkdir(claudeDir, { recursive: true });
    await fsp.writeFile(
      path.join(claudeDir, "history.jsonl"),
      `${JSON.stringify({ project: "/tmp/seen", sessionId: "s1", timestamp: 1_699_000_000_000 })}\n`,
      "utf8"
    );
    const agoDir = path.join(homeDir, ".ago");
    await fsp.mkdir(agoDir, { recursive: true });
    await fsp.writeFile(path.join(agoDir, "config.json"), JSON.stringify({ claudeCommand: "ago-not-a-real-cmd-zzz" }), "utf8");

    const result = await runCli(["doctor"], homeDir);
    assert.equal(result.code, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.status, "error");
  });
});

test("ago --help lists the doctor and config subcommands", async () => {
  await withTempHome(async (homeDir) => {
    const result = await runCli(["--help"], homeDir);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /doctor/);
    assert.match(result.stdout, /config/);
  });
});

test("ago -al on empty home still runs the default action", async () => {
  await withTempHome(async (homeDir) => {
    const result = await runCli(["-al"], homeDir);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /No projects found/);
  });
});

test("resolvePinTarget uses cwd when name is omitted", () => {
  const result = resolvePinTarget({ name: undefined, cwd: "/tmp/here", projects: [], homeDir: "/home/u" });
  assert.deepEqual(result, { kind: "resolved", path: path.resolve("/tmp/here") });
});

test("resolvePinTarget resolves an existing directory before fuzzy", async () => {
  await withTempHome(async (home) => {
    const result = resolvePinTarget({ name: home, cwd: "/tmp/here", projects: [], homeDir: home });
    assert.deepEqual(result, { kind: "resolved", path: path.resolve(home) });
  });
});

test("resolvePinTarget fuzzy-matches a unique project", () => {
  const projects = [
    { name: "alpha", path: "/x/alpha", sourceLabel: "codex" },
    { name: "beta", path: "/x/beta", sourceLabel: "codex" },
  ] as never[];
  const result = resolvePinTarget({ name: "alph", cwd: "/tmp", projects, homeDir: "/home/u" });
  assert.deepEqual(result, { kind: "resolved", path: "/x/alpha" });
});

test("resolvePinTarget reports ambiguity and not-found", () => {
  const projects = [
    { name: "shared-a", path: "/x/shared-a", sourceLabel: "codex" },
    { name: "shared-b", path: "/x/shared-b", sourceLabel: "codex" },
  ] as never[];
  const ambiguous = resolvePinTarget({ name: "shared", cwd: "/tmp", projects, homeDir: "/home/u" });
  assert.equal(ambiguous.kind, "ambiguous");
  const notFound = resolvePinTarget({ name: "zzz-nope", cwd: "/tmp", projects, homeDir: "/home/u" });
  assert.equal(notFound.kind, "not_found");
});

async function readPinned(homeDir: string): Promise<string[]> {
  try {
    const raw = await fsp.readFile(path.join(homeDir, ".ago", "state.json"), "utf8");
    return JSON.parse(raw).pinnedPaths ?? [];
  } catch {
    return [];
  }
}

test("ago pin <dir> stores the pin idempotently; ago unpin removes it", async () => {
  await withTempHome(async (home) => {
    const proj = path.join(home, "proj");
    await fsp.mkdir(proj, { recursive: true });

    const first = await runCli(["pin", proj], home);
    assert.equal(first.code, 0);
    assert.deepEqual(await readPinned(home), [path.resolve(proj)]);

    await runCli(["pin", proj], home); // idempotent
    assert.deepEqual(await readPinned(home), [path.resolve(proj)]);

    const unpinned = await runCli(["unpin", proj], home);
    assert.equal(unpinned.code, 0);
    assert.deepEqual(await readPinned(home), []);
  });
});

test("ago unpin a not-pinned path is a no-op exit 0", async () => {
  await withTempHome(async (home) => {
    const result = await runCli(["unpin", home], home);
    assert.equal(result.code, 0);
    assert.deepEqual(await readPinned(home), []);
  });
});

test("ago pin with an ambiguous fuzzy name exits 1", async () => {
  await withTempHome(async (home) => {
    const claudeDir = path.join(home, ".claude");
    await fsp.mkdir(claudeDir, { recursive: true });
    await fsp.writeFile(
      path.join(claudeDir, "history.jsonl"),
      [
        JSON.stringify({ project: "/tmp/shared-alpha", sessionId: "s1", timestamp: 1_699_000_000_000 }),
        JSON.stringify({ project: "/tmp/shared-beta", sessionId: "s2", timestamp: 1_699_000_000_001 }),
      ].join("\n") + "\n",
      "utf8"
    );
    const result = await runCli(["pin", "shared"], home);
    assert.equal(result.code, 1);
    assert.deepEqual(await readPinned(home), []);
  });
});
