# ago doctor / config show Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two read-only CLI entry points — `ago doctor` (JSON diagnostic report) and `ago config show` (normalized config with per-key source) — without writing files or adding runtime deps.

**Architecture:** File-reading/inspection helpers live in `src/project-index.ts`; pure diagnostic aggregation lives in a new `src/doctor.ts` (dependency-injected `now`/`homeDir`/`isCommandAvailable` for testability); `src/index.ts` only wires commander subcommands, serializes JSON to stdout, and sets `process.exitCode`. Spec: `docs/superpowers/specs/2026-06-07-ago-cli-doctor-config-design.md`.

**Tech Stack:** TypeScript (NodeNext, `verbatimModuleSyntax`), commander v12, `node:test` + tsx. No new dependencies.

---

## File Structure

- `src/project-index.ts` (modify) — add path getters, `resolveConfiguredRoot`, `inspectJsonFile`, `inspectConfig`, `inspectState`; refactor 3 collectors onto the new getters.
- `src/doctor.ts` (create) — `DoctorCheck`/`DoctorReport`/`ConfigShowReport` types, `aggregateChecks`, `parseNodeMajor`, `buildConfigShowReport`, `buildDoctorReport`.
- `src/index.ts` (modify) — wire `doctor`, `config show`, bare `config` (help) subcommands; add `readPackageMeta`.
- `test/project-index.test.ts` (modify) — tests for getters + `inspect*` helpers.
- `test/doctor.test.ts` (create) — tests for `aggregateChecks`, `buildConfigShowReport`, `buildDoctorReport`.
- `test/index-cli.test.ts` (modify) — spawn-based CLI integration tests.
- `README.md` (modify) — document the two commands.

**Conventions to honor (verbatimModuleSyntax):** type-only imports must use the inline `type` qualifier, e.g. `import { foo, type Bar } from "./x.js";`. All cross-file imports use the `.js` extension.

---

## Task 1: project-index path getters + root resolver

**Files:**
- Modify: `src/project-index.ts`
- Test: `test/project-index.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these imports to the existing import block at the top of `test/project-index.test.ts` (extend the existing `from "../src/project-index.js"` list):

```ts
import {
  getClaudeHistoryPath,
  getClaudeProjectsDir,
  getCodexSessionsDir,
  resolveConfiguredRoot,
} from "../src/project-index.js";
```

Append to `test/project-index.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `getCodexSessionsDir`/`resolveConfiguredRoot` are not exported.

- [ ] **Step 3: Add the helpers to `src/project-index.ts`**

Insert after `getDefaultStatePath` (currently ends near line 75):

```ts
export function getCodexSessionsDir(homeDir = os.homedir()): string {
  return path.join(homeDir, ".codex", "sessions");
}

export function getClaudeHistoryPath(homeDir = os.homedir()): string {
  return path.join(homeDir, ".claude", "history.jsonl");
}

export function getClaudeProjectsDir(homeDir = os.homedir()): string {
  return path.join(homeDir, ".claude", "projects");
}
```

Insert after `normalizeProjectPath` (currently ends near line 104), so it can call `expandHome`/`normalizeProjectPath`:

```ts
export function resolveConfiguredRoot(root: string, homeDir = os.homedir()): string {
  return normalizeProjectPath(expandHome(root, homeDir));
}
```

- [ ] **Step 4: Refactor the 3 collectors onto the getters**

In `collectCodexObservations`, replace:
```ts
  const sessionsDir = path.join(homeDir, ".codex", "sessions");
```
with:
```ts
  const sessionsDir = getCodexSessionsDir(homeDir);
```

In `collectClaudeFromTranscripts`, replace:
```ts
  const projectsDir = path.join(homeDir, ".claude", "projects");
```
with:
```ts
  const projectsDir = getClaudeProjectsDir(homeDir);
```

In `collectClaudeFromSessionsIndex`, replace:
```ts
  const projectsDir = path.join(homeDir, ".claude", "projects");
```
with:
```ts
  const projectsDir = getClaudeProjectsDir(homeDir);
```

In `collectClaudeObservations`, replace:
```ts
  const historyPath = path.join(homeDir, ".claude", "history.jsonl");
```
with:
```ts
  const historyPath = getClaudeHistoryPath(homeDir);
```

- [ ] **Step 5: Run the tests to verify they pass (and no regression)**

Run: `npm test`
Expected: PASS — new getter tests pass, all existing collector tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/project-index.ts test/project-index.test.ts
git commit -m "refactor: add ago source path getters and root resolver"
```

---

## Task 2: `inspectJsonFile` helper

**Files:**
- Modify: `src/project-index.ts`
- Test: `test/project-index.test.ts`

- [ ] **Step 1: Write the failing tests**

Extend the `from "../src/project-index.js"` import list in `test/project-index.test.ts` with `inspectJsonFile`. Append:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `inspectJsonFile` is not exported.

- [ ] **Step 3: Add `inspectJsonFile` to `src/project-index.ts`**

Insert after the existing private `readJsonFile` (near line 785):

```ts
export interface JsonFileInspection {
  path: string;
  exists: boolean;
  validJson: boolean;
  raw?: RawJson;
  error?: string;
}

export async function inspectJsonFile(filePath: string): Promise<JsonFileInspection> {
  let contents: string;
  try {
    contents = await fsp.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { path: filePath, exists: false, validJson: true };
    }
    return { path: filePath, exists: true, validJson: false, error: (error as Error).message };
  }

  try {
    const parsed = JSON.parse(contents) as unknown;
    const isObject = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
    return {
      path: filePath,
      exists: true,
      validJson: true,
      raw: isObject ? (parsed as RawJson) : undefined,
    };
  } catch (error) {
    return { path: filePath, exists: true, validJson: false, error: (error as Error).message };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/project-index.ts test/project-index.test.ts
git commit -m "feat: add inspectJsonFile for missing/valid/invalid JSON inspection"
```

---

## Task 3: `inspectConfig` helper (unified source rule)

**Files:**
- Modify: `src/project-index.ts`
- Test: `test/project-index.test.ts`

- [ ] **Step 1: Write the failing tests**

Extend the import list with `inspectConfig`. Append:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `inspectConfig` is not exported.

- [ ] **Step 3: Add `inspectConfig` to `src/project-index.ts`**

Insert after `inspectJsonFile`:

```ts
export type ConfigSource = "file" | "default";

export interface ConfigInspection {
  path: string;
  exists: boolean;
  validJson: boolean;
  error?: string;
  value: AgoConfig;
  sources: Record<keyof AgoConfig, ConfigSource>;
  invalidKeys: Array<keyof AgoConfig>;
}

export async function inspectConfig(configPath = getDefaultConfigPath()): Promise<ConfigInspection> {
  const file = await inspectJsonFile(configPath);
  const raw = file.raw ?? {};
  const value = normalizeConfig(raw);

  const sources: Record<keyof AgoConfig, ConfigSource> = {
    roots: "default",
    claudeCommand: "default",
    preferredTool: "default",
  };
  const invalidKeys: Array<keyof AgoConfig> = [];

  if ("roots" in raw) {
    if (Array.isArray(raw.roots)) {
      sources.roots = "file";
    } else {
      invalidKeys.push("roots");
    }
  }

  if ("claudeCommand" in raw) {
    if (typeof raw.claudeCommand === "string" && raw.claudeCommand.trim().length > 0) {
      sources.claudeCommand = "file";
    } else {
      invalidKeys.push("claudeCommand");
    }
  }

  if ("preferredTool" in raw) {
    const candidate = raw.preferredTool;
    if (candidate === "auto" || candidate === TOOL_CODEX || candidate === TOOL_CLAUDE) {
      sources.preferredTool = "file";
    } else {
      invalidKeys.push("preferredTool");
    }
  }

  return {
    path: configPath,
    exists: file.exists,
    validJson: file.validJson,
    error: file.error,
    value,
    sources,
    invalidKeys,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/project-index.ts test/project-index.test.ts
git commit -m "feat: add inspectConfig with unified file/default source rule"
```

---

## Task 4: `inspectState` helper

**Files:**
- Modify: `src/project-index.ts`
- Test: `test/project-index.test.ts`

- [ ] **Step 1: Write the failing tests**

Extend the import list with `inspectState`. Append:

```ts
test("inspectState on missing file returns defaults", async () => {
  await withTempDir(async (tempDir) => {
    const statePath = path.join(tempDir, "state.json");
    const result = await inspectState(statePath);
    assert.equal(result.exists, false);
    assert.equal(result.validJson, true);
    assert.equal(result.hasLastLaunch, false);
    assert.equal(result.lastLaunchPathExists, false);
    assert.equal(result.lastLaunchToolSupported, false);
    assert.deepEqual(result.value, { lastLaunchedByPath: {} });
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `inspectState` is not exported.

- [ ] **Step 3: Add `inspectState` to `src/project-index.ts`**

Insert after `inspectConfig`:

```ts
export interface StateInspection {
  path: string;
  exists: boolean;
  validJson: boolean;
  error?: string;
  value: AgoState;
  hasLastLaunch: boolean;
  lastLaunchToolSupported: boolean;
  lastLaunchPathExists: boolean;
}

export async function inspectState(statePath = getDefaultStatePath()): Promise<StateInspection> {
  const file = await inspectJsonFile(statePath);
  const raw = file.raw ?? {};
  const value = normalizeState(raw);

  const rawLastLaunch =
    raw.lastLaunch && typeof raw.lastLaunch === "object" && !Array.isArray(raw.lastLaunch)
      ? (raw.lastLaunch as RawJson)
      : null;
  const hasLastLaunch = rawLastLaunch !== null;
  const rawTool = rawLastLaunch?.tool;
  const lastLaunchToolSupported = rawTool === TOOL_CODEX || rawTool === TOOL_CLAUDE;
  const lastLaunchPathExists = value.lastLaunch ? fs.existsSync(value.lastLaunch.path) : false;

  return {
    path: statePath,
    exists: file.exists,
    validJson: file.validJson,
    error: file.error,
    value,
    hasLastLaunch,
    lastLaunchToolSupported,
    lastLaunchPathExists,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/project-index.ts test/project-index.test.ts
git commit -m "feat: add inspectState with last-launch path/tool health"
```

---

## Task 5: `doctor.ts` — config show report + aggregation primitives

**Files:**
- Create: `src/doctor.ts`
- Test: `test/doctor.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/doctor.test.ts`:

```ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { aggregateChecks, buildConfigShowReport, parseNodeMajor, type DoctorCheck } from "../src/doctor.js";

async function withTempDir(fn: (tempDir: string) => Promise<void>): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ago-doctor-test-"));
  try {
    await fn(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("aggregateChecks reports ok when all checks pass", () => {
  const checks: DoctorCheck[] = [{ id: "a", category: "config", status: "ok", message: "ok" }];
  assert.deepEqual(aggregateChecks(checks), { status: "ok", errorCount: 0, warningCount: 0 });
});

test("aggregateChecks reports warning when a warning is present and no error", () => {
  const checks: DoctorCheck[] = [
    { id: "a", category: "config", status: "ok", message: "ok" },
    { id: "b", category: "state", status: "warning", message: "warn" },
  ];
  assert.deepEqual(aggregateChecks(checks), { status: "warning", errorCount: 0, warningCount: 1 });
});

test("aggregateChecks reports error when any error is present", () => {
  const checks: DoctorCheck[] = [
    { id: "a", category: "config", status: "warning", message: "warn" },
    { id: "b", category: "config", status: "error", message: "err" },
  ];
  assert.deepEqual(aggregateChecks(checks), { status: "error", errorCount: 1, warningCount: 1 });
});

test("parseNodeMajor extracts the major version", () => {
  assert.equal(parseNodeMajor("v22.22.2"), 22);
  assert.equal(parseNodeMajor("18.0.0"), 18);
  assert.equal(parseNodeMajor("garbage"), 0);
});

test("buildConfigShowReport on missing config returns defaults with formatVersion", async () => {
  await withTempDir(async (tempDir) => {
    const configPath = path.join(tempDir, "config.json");
    const report = await buildConfigShowReport(configPath);
    assert.equal(report.formatVersion, "1.0");
    assert.equal(report.exists, false);
    assert.equal(report.validJson, true);
    assert.equal(report.error, undefined);
    assert.deepEqual(report.sources, { roots: "default", claudeCommand: "default", preferredTool: "default" });
  });
});

test("buildConfigShowReport on invalid JSON sets validJson false and carries error", async () => {
  await withTempDir(async (tempDir) => {
    const configPath = path.join(tempDir, "config.json");
    await fs.writeFile(configPath, "{bad}", "utf8");
    const report = await buildConfigShowReport(configPath);
    assert.equal(report.validJson, false);
    assert.equal(typeof report.error, "string");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `../src/doctor.js` does not exist.

- [ ] **Step 3: Create `src/doctor.ts` with the config-show + aggregation pieces**

Create `src/doctor.ts` with exactly these contents (Task 6 will extend the import block and append `buildDoctorReport`):

```ts
import {
  getDefaultConfigPath,
  inspectConfig,
  type AgoConfig,
} from "./project-index.js";

export const FORMAT_VERSION = "1.0";

type ConfigSources = Record<keyof AgoConfig, "file" | "default">;

export interface DoctorCheck {
  id: string;
  category: "runtime" | "config" | "state" | "commands" | "sources" | "projects";
  status: "ok" | "warning" | "error";
  message: string;
  details?: Record<string, unknown>;
}

export interface ConfigShowReport {
  formatVersion: string;
  path: string;
  exists: boolean;
  validJson: boolean;
  error?: string;
  value: AgoConfig;
  sources: ConfigSources;
}

export function parseNodeMajor(version: string): number {
  const match = /^v?(\d+)/.exec(version.trim());
  return match ? Number(match[1]) : 0;
}

export function aggregateChecks(checks: DoctorCheck[]): {
  status: "ok" | "warning" | "error";
  errorCount: number;
  warningCount: number;
} {
  let errorCount = 0;
  let warningCount = 0;
  for (const check of checks) {
    if (check.status === "error") {
      errorCount += 1;
    } else if (check.status === "warning") {
      warningCount += 1;
    }
  }
  const status = errorCount > 0 ? "error" : warningCount > 0 ? "warning" : "ok";
  return { status, errorCount, warningCount };
}

export async function buildConfigShowReport(configPath = getDefaultConfigPath()): Promise<ConfigShowReport> {
  const inspection = await inspectConfig(configPath);
  const report: ConfigShowReport = {
    formatVersion: FORMAT_VERSION,
    path: inspection.path,
    exists: inspection.exists,
    validJson: inspection.validJson,
    value: inspection.value,
    sources: inspection.sources,
  };
  if (inspection.error !== undefined) {
    report.error = inspection.error;
  }
  return report;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/doctor.ts test/doctor.test.ts
git commit -m "feat: add doctor config-show report and check aggregation"
```

---

## Task 6: `doctor.ts` — full `buildDoctorReport`

**Files:**
- Modify: `src/doctor.ts`
- Test: `test/doctor.test.ts`

- [ ] **Step 1: Write the failing tests**

Extend the import in `test/doctor.test.ts` to add `buildDoctorReport`:

```ts
import { aggregateChecks, buildConfigShowReport, buildDoctorReport, parseNodeMajor, type DoctorCheck } from "../src/doctor.js";
```

Append:

```ts
const baseInput = (tempDir: string) => ({
  homeDir: tempDir,
  now: 1_700_000_000_000,
  version: "0.1.0",
  nodeVersion: "v22.22.2",
  platform: "linux",
  minNodeMajor: 18,
  isCommandAvailable: () => true,
});

test("buildDoctorReport on empty home is warning, not error, and parseable", async () => {
  await withTempDir(async (tempDir) => {
    const report = await buildDoctorReport(baseInput(tempDir));
    assert.equal(report.formatVersion, "1.0");
    assert.equal(report.status, "warning");
    assert.equal(report.errorCount, 0);
    assert.equal(report.checkedAt, new Date(1_700_000_000_000).toISOString());
    assert.equal(report.projects.total, 0);
    assert.ok(report.checks.length > 0);
    assert.equal(report.paths.config, path.join(tempDir, ".ago", "config.json"));
  });
});

test("buildDoctorReport errors when a Claude command is missing but observations exist", async () => {
  await withTempDir(async (tempDir) => {
    const claudeDir = path.join(tempDir, ".claude");
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeDir, "history.jsonl"),
      `${JSON.stringify({ project: "/tmp/seen", sessionId: "s1", timestamp: 1_699_000_000_000 })}\n`,
      "utf8"
    );
    const agoDir = path.join(tempDir, ".ago");
    await fs.mkdir(agoDir, { recursive: true });
    await fs.writeFile(path.join(agoDir, "config.json"), JSON.stringify({ claudeCommand: "ago-not-a-real-cmd-zzz" }), "utf8");

    const report = await buildDoctorReport({
      ...baseInput(tempDir),
      isCommandAvailable: (command: string) => command === "codex",
    });

    const claudeCheck = report.checks.find((check) => check.id === "commands.claude_available");
    assert.equal(claudeCheck?.status, "error");
    assert.equal(report.status, "error");
    assert.ok(report.errorCount >= 1);
  });
});

test("buildDoctorReport flags an outdated Node version as error", async () => {
  await withTempDir(async (tempDir) => {
    const report = await buildDoctorReport({ ...baseInput(tempDir), nodeVersion: "v16.0.0" });
    const nodeCheck = report.checks.find((check) => check.id === "runtime.node_version");
    assert.equal(nodeCheck?.status, "error");
    assert.equal(report.status, "error");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `buildDoctorReport` is not exported.

- [ ] **Step 3: Extend `src/doctor.ts`**

Update the import block at the top of `src/doctor.ts` to:

```ts
import fs from "node:fs";
import os from "node:os";
import {
  collectClaudeObservations,
  collectCodexObservations,
  filterProjectsByRoots,
  getClaudeHistoryPath,
  getClaudeProjectsDir,
  getCodexSessionsDir,
  getDefaultConfigPath,
  getDefaultStatePath,
  inspectConfig,
  inspectState,
  mergeProjectObservations,
  resolveConfiguredRoot,
  TOOL_CODEX,
  type AgoConfig,
} from "./project-index.js";
```

Append these types + function to `src/doctor.ts` (after `buildConfigShowReport`):

```ts
export interface DoctorReportInput {
  homeDir?: string;
  now: number;
  version: string;
  nodeVersion: string;
  platform: string;
  minNodeMajor?: number;
  isCommandAvailable: (command: string) => boolean;
}

export interface DoctorReport {
  formatVersion: string;
  status: "ok" | "warning" | "error";
  checkedAt: string;
  version: string;
  node: string;
  platform: string;
  errorCount: number;
  warningCount: number;
  paths: {
    config: string;
    state: string;
    codexSessions: string;
    claudeHistory: string;
    claudeProjects: string;
  };
  config: {
    exists: boolean;
    validJson: boolean;
    value: AgoConfig;
    sources: ConfigSources;
  };
  state: {
    exists: boolean;
    validJson: boolean;
    lastLaunchPathExists: boolean;
  };
  commands: {
    codex: { available: boolean; command: string };
    claude: { available: boolean; command: string };
  };
  sources: {
    codex: { sessionsDirExists: boolean; observations: number };
    claude: { historyExists: boolean; projectsDirExists: boolean; observations: number };
  };
  projects: { total: number; existing: number; missing: number };
  checks: DoctorCheck[];
}

export async function buildDoctorReport(input: DoctorReportInput): Promise<DoctorReport> {
  const homeDir = input.homeDir ?? os.homedir();
  const minNodeMajor = input.minNodeMajor ?? 18;
  const checkedAt = new Date(input.now).toISOString();
  const paths = {
    config: getDefaultConfigPath(homeDir),
    state: getDefaultStatePath(homeDir),
    codexSessions: getCodexSessionsDir(homeDir),
    claudeHistory: getClaudeHistoryPath(homeDir),
    claudeProjects: getClaudeProjectsDir(homeDir),
  };

  const checks: DoctorCheck[] = [];

  try {
    // runtime
    const nodeMajor = parseNodeMajor(input.nodeVersion);
    checks.push(
      nodeMajor < minNodeMajor
        ? {
            id: "runtime.node_version",
            category: "runtime",
            status: "error",
            message: `Node ${input.nodeVersion} is below required >=${minNodeMajor}`,
            details: { node: input.nodeVersion, required: `>=${minNodeMajor}` },
          }
        : { id: "runtime.node_version", category: "runtime", status: "ok", message: `Node ${input.nodeVersion} meets >=${minNodeMajor}` }
    );

    // config
    const configInspection = await inspectConfig(paths.config);
    const config = configInspection.value;
    checks.push(
      !configInspection.exists
        ? { id: "config.exists", category: "config", status: "warning", message: "Config file does not exist; using defaults", details: { path: paths.config } }
        : { id: "config.exists", category: "config", status: "ok", message: "Config file exists" }
    );
    checks.push(
      configInspection.exists && !configInspection.validJson
        ? { id: "config.valid_json", category: "config", status: "error", message: "Config file is not valid JSON", details: { error: configInspection.error } }
        : { id: "config.valid_json", category: "config", status: "ok", message: "Config file is valid JSON" }
    );
    checks.push(
      configInspection.invalidKeys.length > 0
        ? { id: "config.normalized", category: "config", status: "warning", message: "Some config keys are invalid and fell back to defaults", details: { invalidKeys: configInspection.invalidKeys } }
        : { id: "config.normalized", category: "config", status: "ok", message: "Config values normalized cleanly" }
    );
    const missingRoots = config.roots.filter((root) => !fs.existsSync(resolveConfiguredRoot(root, homeDir)));
    checks.push(
      config.roots.length > 0 && missingRoots.length > 0
        ? { id: "config.roots_exist", category: "config", status: "warning", message: "Some configured roots do not exist", details: { missingRoots } }
        : { id: "config.roots_exist", category: "config", status: "ok", message: "Configured roots exist (or none configured)" }
    );

    // state
    const stateInspection = await inspectState(paths.state);
    checks.push(
      !stateInspection.exists
        ? { id: "state.exists", category: "state", status: "warning", message: "State file does not exist (new user)", details: { path: paths.state } }
        : { id: "state.exists", category: "state", status: "ok", message: "State file exists" }
    );
    checks.push(
      stateInspection.exists && !stateInspection.validJson
        ? { id: "state.valid_json", category: "state", status: "warning", message: "State file is not valid JSON; ago falls back to empty state", details: { error: stateInspection.error } }
        : { id: "state.valid_json", category: "state", status: "ok", message: "State file is valid JSON" }
    );
    checks.push(
      stateInspection.value.lastLaunch && !stateInspection.lastLaunchPathExists
        ? { id: "state.last_launch_path", category: "state", status: "warning", message: "lastLaunch.path no longer exists", details: { path: stateInspection.value.lastLaunch.path } }
        : { id: "state.last_launch_path", category: "state", status: "ok", message: "lastLaunch.path exists (or no last launch)" }
    );
    checks.push(
      stateInspection.hasLastLaunch && !stateInspection.lastLaunchToolSupported
        ? { id: "state.last_launch_tool", category: "state", status: "warning", message: "lastLaunch.tool is no longer a supported tool", details: {} }
        : { id: "state.last_launch_tool", category: "state", status: "ok", message: "lastLaunch.tool is supported (or no last launch)" }
    );

    // observations (collected before command checks)
    const [codexObservations, claudeObservations] = await Promise.all([
      collectCodexObservations(homeDir),
      collectClaudeObservations(homeDir),
    ]);

    // commands
    const codexCommand = TOOL_CODEX;
    const claudeCommand = config.claudeCommand;
    const codexAvailable = input.isCommandAvailable(codexCommand);
    const claudeAvailable = input.isCommandAvailable(claudeCommand);
    checks.push(
      !codexAvailable
        ? { id: "commands.codex_available", category: "commands", status: codexObservations.length > 0 ? "error" : "warning", message: `codex command not found: ${codexCommand}`, details: { command: codexCommand, observations: codexObservations.length } }
        : { id: "commands.codex_available", category: "commands", status: "ok", message: "codex command available" }
    );
    checks.push(
      !claudeAvailable
        ? { id: "commands.claude_available", category: "commands", status: claudeObservations.length > 0 ? "error" : "warning", message: `claude command not found: ${claudeCommand}`, details: { command: claudeCommand, observations: claudeObservations.length } }
        : { id: "commands.claude_available", category: "commands", status: "ok", message: "claude command available" }
    );

    // sources
    const codexSessionsDirExists = fs.existsSync(paths.codexSessions);
    const claudeHistoryExists = fs.existsSync(paths.claudeHistory);
    const claudeProjectsDirExists = fs.existsSync(paths.claudeProjects);
    checks.push(
      !codexSessionsDirExists
        ? { id: "sources.codex_sessions_dir", category: "sources", status: "warning", message: "Codex sessions dir not found", details: { path: paths.codexSessions } }
        : { id: "sources.codex_sessions_dir", category: "sources", status: "ok", message: "Codex sessions dir found" }
    );
    checks.push(
      !claudeHistoryExists
        ? { id: "sources.claude_history", category: "sources", status: "warning", message: "Claude history not found", details: { path: paths.claudeHistory } }
        : { id: "sources.claude_history", category: "sources", status: "ok", message: "Claude history found" }
    );
    checks.push(
      !claudeProjectsDirExists
        ? { id: "sources.claude_projects_dir", category: "sources", status: "warning", message: "Claude projects dir not found", details: { path: paths.claudeProjects } }
        : { id: "sources.claude_projects_dir", category: "sources", status: "ok", message: "Claude projects dir found" }
    );
    const totalObservations = codexObservations.length + claudeObservations.length;
    checks.push(
      totalObservations === 0
        ? { id: "sources.observations_nonempty", category: "sources", status: "warning", message: "No Codex or Claude observations found", details: {} }
        : { id: "sources.observations_nonempty", category: "sources", status: "ok", message: `${totalObservations} observations found` }
    );

    // projects
    const mergedAll = mergeProjectObservations([...codexObservations, ...claudeObservations], input.now);
    const filtered = filterProjectsByRoots(mergedAll, config.roots, homeDir);
    const existing = filtered.filter((project) => project.exists).length;
    const missing = filtered.length - existing;
    checks.push(
      filtered.length === 0
        ? { id: "projects.any_indexed", category: "projects", status: "warning", message: "No projects indexed", details: {} }
        : { id: "projects.any_indexed", category: "projects", status: "ok", message: `${filtered.length} projects indexed` }
    );
    checks.push(
      existing === 0
        ? { id: "projects.any_existing", category: "projects", status: "warning", message: "No existing (openable) projects", details: {} }
        : { id: "projects.any_existing", category: "projects", status: "ok", message: `${existing} existing projects` }
    );
    checks.push(
      missing > 0
        ? { id: "projects.missing_paths", category: "projects", status: "warning", message: `${missing} indexed project paths no longer exist`, details: { missing } }
        : { id: "projects.missing_paths", category: "projects", status: "ok", message: "All indexed project paths exist" }
    );
    checks.push(
      config.roots.length > 0 && filtered.length === 0
        ? { id: "config.roots_filter_nonempty", category: "config", status: "warning", message: "roots configured but no projects matched", details: { roots: config.roots } }
        : { id: "config.roots_filter_nonempty", category: "config", status: "ok", message: "roots filter retains projects (or no roots configured)" }
    );

    const aggregate = aggregateChecks(checks);
    return {
      formatVersion: FORMAT_VERSION,
      status: aggregate.status,
      checkedAt,
      version: input.version,
      node: input.nodeVersion,
      platform: input.platform,
      errorCount: aggregate.errorCount,
      warningCount: aggregate.warningCount,
      paths,
      config: {
        exists: configInspection.exists,
        validJson: configInspection.validJson,
        value: configInspection.value,
        sources: configInspection.sources,
      },
      state: {
        exists: stateInspection.exists,
        validJson: stateInspection.validJson,
        lastLaunchPathExists: stateInspection.lastLaunchPathExists,
      },
      commands: {
        codex: { available: codexAvailable, command: codexCommand },
        claude: { available: claudeAvailable, command: claudeCommand },
      },
      sources: {
        codex: { sessionsDirExists: codexSessionsDirExists, observations: codexObservations.length },
        claude: { historyExists: claudeHistoryExists, projectsDirExists: claudeProjectsDirExists, observations: claudeObservations.length },
      },
      projects: { total: filtered.length, existing, missing },
      checks,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const allChecks: DoctorCheck[] = [
      ...checks,
      { id: "runtime.unexpected_error", category: "runtime", status: "error", message: "Doctor encountered an unexpected error", details: { error: message } },
    ];
    const aggregate = aggregateChecks(allChecks);
    return {
      formatVersion: FORMAT_VERSION,
      status: "error",
      checkedAt,
      version: input.version,
      node: input.nodeVersion,
      platform: input.platform,
      errorCount: aggregate.errorCount,
      warningCount: aggregate.warningCount,
      paths,
      config: { exists: false, validJson: true, value: { roots: [], claudeCommand: "claude", preferredTool: "auto" }, sources: { roots: "default", claudeCommand: "default", preferredTool: "default" } },
      state: { exists: false, validJson: true, lastLaunchPathExists: false },
      commands: { codex: { available: false, command: "codex" }, claude: { available: false, command: "claude" } },
      sources: { codex: { sessionsDirExists: false, observations: 0 }, claude: { historyExists: false, projectsDirExists: false, observations: 0 } },
      projects: { total: 0, existing: 0, missing: 0 },
      checks: allChecks,
    };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Verify the type-checker is clean**

Run: `npm run build`
Expected: compiles with no errors (build artifacts are throwaway here; this is a typecheck gate).

- [ ] **Step 6: Commit**

```bash
git add src/doctor.ts test/doctor.test.ts
git commit -m "feat: add buildDoctorReport aggregating runtime/config/state/commands/sources/projects checks"
```

---

## Task 7: Wire `config show` + bare `config` in the CLI

**Files:**
- Modify: `src/index.ts`
- Test: `test/index-cli.test.ts`

- [ ] **Step 1: Write the failing integration tests**

Add to the top of `test/index-cli.test.ts` (after the existing imports):

```ts
import fsp from "node:fs/promises";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
```

Append:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `config` subcommand is unknown (commander errors).

- [ ] **Step 3: Add `readPackageMeta` and wire the `config` command in `src/index.ts`**

Add the import near the other top imports:

```ts
import { buildConfigShowReport } from "./doctor.js";
```

Add this helper just above `export async function main(`:

```ts
function readPackageMeta(): { version: string; minNodeMajor: number } {
  try {
    const raw = fs.readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const pkg = JSON.parse(raw) as { version?: string; engines?: { node?: string } };
    const version = typeof pkg.version === "string" ? pkg.version : "0.0.0";
    const match = /(\d+)/.exec(pkg.engines?.node ?? "");
    return { version, minNodeMajor: match ? Number(match[1]) : 18 };
  } catch {
    return { version: "0.0.0", minNodeMajor: 18 };
  }
}
```

Inside `main`, after the `program.allowExcessArguments(false).showHelpAfterError();` setup and **before** `program.action(...)`, add:

```ts
  const configCommand = program
    .command("config")
    .description("Inspect ago configuration")
    .allowExcessArguments(false);

  configCommand
    .command("show")
    .description("Print normalized config with per-key source")
    .action(async () => {
      const report = await buildConfigShowReport(getDefaultConfigPath());
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (!report.validJson) {
        process.exitCode = 1;
      }
    });

  configCommand.action(() => {
    configCommand.help();
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all three config tests pass; existing tests unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/index-cli.test.ts
git commit -m "feat: add ago config show and bare ago config help"
```

---

## Task 8: Wire `doctor` in the CLI

**Files:**
- Modify: `src/index.ts`
- Test: `test/index-cli.test.ts`

- [ ] **Step 1: Write the failing integration tests**

Append to `test/index-cli.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `doctor` subcommand is unknown.

- [ ] **Step 3: Wire the `doctor` command in `src/index.ts`**

Add the import to the existing `from "./doctor.js"` line so it reads:

```ts
import { buildConfigShowReport, buildDoctorReport } from "./doctor.js";
```

Inside `main`, directly after the `configCommand.action(...)` block and **before** `program.action(...)`, add:

```ts
  program
    .command("doctor")
    .description("Print a JSON diagnostic report")
    .action(async () => {
      const meta = readPackageMeta();
      const report = await buildDoctorReport({
        now: Date.now(),
        version: meta.version,
        nodeVersion: process.version,
        platform: process.platform,
        minNodeMajor: meta.minNodeMajor,
        isCommandAvailable,
      });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (report.errorCount > 0) {
        process.exitCode = 1;
      }
    });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — doctor tests pass; `ago --help` and `ago -al` confirm the default action and help still work with subcommands present.

- [ ] **Step 5: Verify the manual smoke commands from the spec**

Run:
```bash
node --import tsx src/cli.ts doctor | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>JSON.parse(s)&&console.log("doctor JSON ok"))'
node --import tsx src/cli.ts config show | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>JSON.parse(s)&&console.log("config JSON ok"))'
```
Expected: prints `doctor JSON ok` and `config JSON ok` (uses your real home; exit code may be 0/1 depending on local env, JSON must parse).

- [ ] **Step 6: Commit**

```bash
git add src/index.ts test/index-cli.test.ts
git commit -m "feat: add ago doctor JSON diagnostic command"
```

---

## Task 9: Document the commands in README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a "Diagnostics" section**

Insert immediately after the existing "### State file" subsection (just before `## Notes`):

```markdown
## Diagnostics

### `ago doctor`

Prints a machine-readable JSON health report (runtime, config, state, commands, history sources, project index) to stdout. Read-only — it never writes config/state. Exit code is non-zero only when at least one check is an `error`; warnings keep it `0`.

```bash
ago doctor
```

Top-level fields include `formatVersion`, `status` (`ok`/`warning`/`error`), `errorCount`, `warningCount`, `paths` (absolute), and a `checks[]` array of `{ id, category, status, message, details? }`.

### `ago config show`

Prints the normalized config plus the `source` (`file` or `default`) of each key.

```bash
ago config show
```

If `~/.ago/config.json` is missing, it returns defaults and exits `0`. If the file exists but is not valid JSON, it returns an error payload with `validJson: false` and exits non-zero.
```

- [ ] **Step 2: Update the Notes section**

In `## Notes`, the existing first bullet reads:
```markdown
- `ago list` is removed and intentionally unsupported.
```
Add a bullet right after it:
```markdown
- `ago doctor` and `ago config show` are read-only and output JSON only (no `--fix`, no text mode in v1).
```

- [ ] **Step 3: Verify tests still pass and commit**

Run: `npm test`
Expected: PASS (docs-only change; no behavior impact).

```bash
git add README.md
git commit -m "docs: document ago doctor and ago config show"
```

---

## Self-Review

**1. Spec coverage:**
- §3.1 commander layout (default action + `doctor` + `config show` + bare `config` help) → Tasks 7, 8 (+ `--help`/`-al` regression tests).
- §3.2 doctor behavior / exit codes → Task 8.
- §3.3 config show behavior / exit codes → Task 7.
- §4.1 doctor JSON shape (incl. absolute `paths`, no `severity`) → Task 6.
- §4.2 status aggregation + check shape → Task 5 (`aggregateChecks`) + Task 6.
- §4.3 config show shape + `formatVersion` → Task 5.
- §4.4 absolute paths → Tasks 1 (getters) + 6 (paths block); asserted in Task 6 test.
- §5.1 runtime.node_version only → Task 6.
- §5.2 config checks incl. `config.normalized` via `invalidKeys`, no `config.preferred_tool` → Tasks 3, 6.
- §5.3 state checks incl. unsupported-tool detection → Tasks 4, 6.
- §5.4 commands checks with observations-driven error escalation (observations collected first) → Task 6.
- §5.5 sources checks → Task 6.
- §5.6 projects checks → Task 6.
- §6.2 `JsonFileInspection` → Task 2.
- §6.3 unified source rule (three-state present/invalid/absent) → Task 3 (incl. explicit-default regression test).
- §6.4 command availability via DI → Task 6 + Task 8 wiring.
- §6.5 aggregation order (observations before commands) → Task 6.
- §6.5 `runtime.unexpected_error` fallback → Task 6 catch block.
- §6.6 single full index build (no double collection) → Task 6 reuses `mergeProjectObservations`/`filterProjectsByRoots` directly.
- §8 testing strategy (pure unit + spawn-based CLI) → Tasks 2–8.

**2. Placeholder scan:** No `TBD`/`TODO`/"handle edge cases". The two "throwaway snippet" notes in Task 5 are explicitly explained, not placeholders. ✅

**3. Type consistency:** `FORMAT_VERSION` used in both reports; `ConfigSources` = `Record<keyof AgoConfig, "file"|"default">` matches `inspectConfig.sources`; `DoctorReportInput.isCommandAvailable` matches `index.ts`'s exported `isCommandAvailable: (commandName: string) => boolean`; `buildDoctorReport` uses injected `now` for both `checkedAt` and `mergeProjectObservations`; doctor.ts imports only from project-index.ts (no cycle). ✅
