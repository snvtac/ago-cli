# ago-cli Launcher Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ago` see the entire Claude history again, rank projects by frecency, reopen the last launch with `ago -`, and resume the exact last session per tool — all with zero new runtime dependencies.

**Architecture:** Data layer (`src/project-index.ts`) gains: a `sessionId` on observations, a frecency score + `lastSessionIdByTool` on index items, a 3-source Claude collector (history.jsonl → newest-transcript scan → legacy index) deduped by sessionId, and a `lastLaunch` field in state. UI layer (`src/index.ts`) gains: pure menu/argv/resume helpers, a `--last`/`-` quick-reopen path, and a shared `performLaunch` that records `lastLaunch`.

**Tech Stack:** TypeScript (ESM, NodeNext), Node ≥18, `node:test` + `tsx`, commander, @inquirer/prompts, chalk. No new deps.

**Branch:** `feat/launcher-improvements` (already checked out).

**Commit rule:** Every commit message must end with the trailer:
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
(shown as a second `-m` in each commit step below).

---

## File Structure

- `src/project-index.ts` (modify) — types, parsers, merge/frecency, state. All data logic.
- `src/index.ts` (modify) — argv, menus, launch/resume wiring. All interactive logic.
- `test/project-index.test.ts` (modify) — data-layer unit/integration tests.
- `test/index-cli.test.ts` (modify) — CLI helper unit tests.
- `README.md` (modify) — document new flags, sort, resume, data sources.

No new files. Pure functions are exported so they can be unit-tested; the interactive flow is verified via build + existing suite + a `--help` smoke test (matching the project's current testing boundary, which does not unit-test `runInteractive`).

---

## Task 1: Observation `sessionId` + robust epoch parsing

**Files:**
- Modify: `src/project-index.ts` (interface `ProjectObservation`, function `toEpochMs`)
- Test: `test/project-index.test.ts`

- [ ] **Step 1: Add the failing tests**

Add these imports to the existing import block in `test/project-index.test.ts` (extend the existing `from "../src/project-index.js"` import to also include `toEpochMs`):

```ts
import {
  TOOL_CLAUDE,
  TOOL_CODEX,
  filterProjectsByRoots,
  mergeProjectObservations,
  parseClaudeSessionsIndexFile,
  parseCodexSessionFile,
  pickDefaultTool,
  toEpochMs,
} from "../src/project-index.js";
```

Append these tests to the end of `test/project-index.test.ts`:

```ts
test("toEpochMs parses epoch-millisecond strings", () => {
  assert.equal(toEpochMs("1780554836375"), 1780554836375);
});

test("toEpochMs upgrades epoch-second strings to milliseconds", () => {
  assert.equal(toEpochMs("1776852802"), 1776852802000);
});

test("toEpochMs still parses ISO date strings", () => {
  assert.equal(toEpochMs("2026-03-18T12:00:00.000Z"), Date.parse("2026-03-18T12:00:00.000Z"));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: the two epoch-string tests FAIL (the second currently returns `0` because `Date.parse("1780554836375")` is `NaN`).

- [ ] **Step 3: Implement**

In `src/project-index.ts`, add `sessionId` to the observation interface:

```ts
export interface ProjectObservation {
  path: string;
  tool: ToolName;
  lastSeenAt: number;
  sessionId?: string;
}
```

Replace the existing `toEpochMs` with:

```ts
export function toEpochMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return 0;
    }

    if (/^\d+$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (!Number.isFinite(numeric)) {
        return 0;
      }
      return numeric < 1e12 ? numeric * 1000 : numeric;
    }

    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return 0;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS (all existing tests still green; new toEpochMs tests pass).

- [ ] **Step 5: Commit**

```bash
git add src/project-index.ts test/project-index.test.ts
git commit -m "feat: add sessionId to observations and robust epoch parsing" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Frecency score, newest-session id, and frecency sort

**Files:**
- Modify: `src/project-index.ts` (interface `ProjectIndexItem`, new `frecencyWeight`, rewrite `mergeProjectObservations`)
- Test: `test/project-index.test.ts`

- [ ] **Step 1: Add the failing tests**

Extend the `test/project-index.test.ts` import to also include `frecencyWeight`:

```ts
import {
  TOOL_CLAUDE,
  TOOL_CODEX,
  filterProjectsByRoots,
  frecencyWeight,
  mergeProjectObservations,
  parseClaudeSessionsIndexFile,
  parseCodexSessionFile,
  pickDefaultTool,
  toEpochMs,
} from "../src/project-index.js";
```

Append:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `frecencyWeight` is not exported; `lastSessionIdByTool` does not exist.

- [ ] **Step 3: Implement**

In `src/project-index.ts`, extend the index item interface:

```ts
export interface ProjectIndexItem {
  path: string;
  name: string;
  sources: ToolName[];
  sourceLabel: ToolName | "both";
  lastSeenAtByTool: {
    codex: number;
    claude: number;
  };
  lastSeenAt: number;
  exists: boolean;
  frecencyScore: number;
  lastSessionIdByTool: {
    codex?: string;
    claude?: string;
  };
}
```

Add the weight function (place it just above `mergeProjectObservations`):

```ts
export function frecencyWeight(ageMs: number): number {
  const HOUR = 3600_000;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;

  if (ageMs <= HOUR) {
    return 4;
  }
  if (ageMs <= DAY) {
    return 2;
  }
  if (ageMs <= WEEK) {
    return 0.5;
  }
  return 0.25;
}
```

Replace the whole `MergedMapItem` interface and `mergeProjectObservations` function with:

```ts
interface MergedMapItem {
  path: string;
  name: string;
  sources: Set<ToolName>;
  lastSeenAtByTool: Partial<Record<ToolName, number>>;
  frecencyScore: number;
  lastSessionIdByTool: Partial<Record<ToolName, string>>;
}

export function mergeProjectObservations(
  observations: ProjectObservation[],
  now: number = Date.now()
): ProjectIndexItem[] {
  const map = new Map<string, MergedMapItem>();

  for (const observation of observations) {
    const normalizedPath = normalizeProjectPath(observation?.path);
    const tool = observation?.tool;

    if (!normalizedPath || (tool !== TOOL_CODEX && tool !== TOOL_CLAUDE)) {
      continue;
    }

    const lastSeenAt = Math.max(0, toEpochMs(observation?.lastSeenAt));
    const sessionId = typeof observation?.sessionId === "string" ? observation.sessionId : undefined;
    let existing = map.get(normalizedPath);

    if (!existing) {
      existing = {
        path: normalizedPath,
        name: path.basename(normalizedPath) || normalizedPath,
        sources: new Set<ToolName>(),
        lastSeenAtByTool: {},
        frecencyScore: 0,
        lastSessionIdByTool: {},
      };
      map.set(normalizedPath, existing);
    }

    existing.sources.add(tool);
    existing.frecencyScore += frecencyWeight(now - lastSeenAt);

    const previousLastSeenAt = existing.lastSeenAtByTool[tool] || 0;
    if (lastSeenAt >= previousLastSeenAt) {
      existing.lastSeenAtByTool[tool] = lastSeenAt;
      existing.lastSessionIdByTool[tool] = sessionId;
    }
  }

  return [...map.values()]
    .map((item) => {
      const codexLastSeenAt = item.lastSeenAtByTool[TOOL_CODEX] || 0;
      const claudeLastSeenAt = item.lastSeenAtByTool[TOOL_CLAUDE] || 0;
      const sources = [...item.sources].sort() as ToolName[];
      const sourceLabel: ProjectIndexItem["sourceLabel"] =
        sources.length > 1 ? "both" : (sources[0] as ToolName);

      return {
        path: item.path,
        name: item.name,
        sources,
        sourceLabel,
        lastSeenAtByTool: {
          codex: codexLastSeenAt,
          claude: claudeLastSeenAt,
        },
        lastSeenAt: Math.max(codexLastSeenAt, claudeLastSeenAt),
        exists: fs.existsSync(item.path),
        frecencyScore: item.frecencyScore,
        lastSessionIdByTool: {
          codex: item.lastSessionIdByTool[TOOL_CODEX],
          claude: item.lastSessionIdByTool[TOOL_CLAUDE],
        },
      };
    })
    .sort((left, right) => {
      if (right.frecencyScore !== left.frecencyScore) {
        return right.frecencyScore - left.frecencyScore;
      }
      if (right.lastSeenAt !== left.lastSeenAt) {
        return right.lastSeenAt - left.lastSeenAt;
      }
      return left.path.localeCompare(right.path);
    });
}
```

> Note: `lastSeenAt >= previousLastSeenAt` (not `>`) so that when the only/first observation for a tool carries a sessionId, that id is captured even if a later observation has an equal timestamp.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS (including the pre-existing "merges same path into both sources" test, which still gets `merged[0].path === /tmp/one` because two ancient observations score 0.5 vs one at 0.25).

- [ ] **Step 5: Commit**

```bash
git add src/project-index.ts test/project-index.test.ts
git commit -m "feat: rank projects by frecency and track newest session id" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Capture Codex sessionId

**Files:**
- Modify: `src/project-index.ts` (`parseCodexSessionFile`)
- Test: `test/project-index.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `test/project-index.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `parsed.sessionId` is `undefined`.

- [ ] **Step 3: Implement**

In `parseCodexSessionFile`, after computing `lastSeenAt` and before the `return`, add the sessionId and include it in the returned object:

```ts
  const sessionId = typeof payload.id === "string" ? payload.id : undefined;

  return {
    path: cwd,
    tool: TOOL_CODEX,
    lastSeenAt,
    sessionId,
  };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/project-index.ts test/project-index.test.ts
git commit -m "feat: capture codex sessionId from session_meta payload" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Parse Claude `history.jsonl`

**Files:**
- Modify: `src/project-index.ts` (new `parseClaudeHistoryFile`)
- Test: `test/project-index.test.ts`

- [ ] **Step 1: Add the failing test**

Extend the `test/project-index.test.ts` import to include `parseClaudeHistoryFile`, then append:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `parseClaudeHistoryFile` is not exported.

- [ ] **Step 3: Implement**

Add to `src/project-index.ts` (near the other Claude parsers):

```ts
export async function parseClaudeHistoryFile(filePath: string): Promise<ProjectObservation[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch {
    return [];
  }

  const bySession = new Map<string, ProjectObservation>();

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let json: RawJson;
    try {
      json = JSON.parse(trimmed) as RawJson;
    } catch {
      continue;
    }

    const projectPath = normalizeProjectPath(json.project);
    const sessionId = typeof json.sessionId === "string" ? json.sessionId : "";
    if (!projectPath || !sessionId) {
      continue;
    }

    const lastSeenAt = toEpochMs(json.timestamp);
    const existing = bySession.get(sessionId);
    if (!existing || lastSeenAt > existing.lastSeenAt) {
      bySession.set(sessionId, {
        path: projectPath,
        tool: TOOL_CLAUDE,
        lastSeenAt,
        sessionId,
      });
    }
  }

  return [...bySession.values()];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/project-index.ts test/project-index.test.ts
git commit -m "feat: parse claude history.jsonl into per-session observations" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Scan newest Claude transcript per project dir

**Files:**
- Modify: `src/project-index.ts` (new `readLeadingLines`, `parseClaudeTranscriptFile`, `collectClaudeFromTranscripts`)
- Test: `test/project-index.test.ts`

- [ ] **Step 1: Add the failing test**

Extend the import to include `collectClaudeFromTranscripts`, then append:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `collectClaudeFromTranscripts` is not exported.

- [ ] **Step 3: Implement**

Add to `src/project-index.ts`:

```ts
async function readLeadingLines(filePath: string, maxLines: number): Promise<string[]> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    let buffer = "";
    let done = false;

    const finish = (): void => {
      if (!done) {
        done = true;
        resolve(lines);
      }
    };

    const stream = fs.createReadStream(filePath, { encoding: "utf8", highWaterMark: 64 * 1024 });
    stream.on("error", finish);

    stream.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        lines.push(buffer.slice(0, newlineIndex).replace(/\r$/, ""));
        buffer = buffer.slice(newlineIndex + 1);
        if (lines.length >= maxLines) {
          stream.destroy();
          finish();
          return;
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });

    stream.on("end", () => {
      if (buffer) {
        lines.push(buffer.replace(/\r$/, ""));
      }
      finish();
    });
  });
}

export async function parseClaudeTranscriptFile(filePath: string): Promise<ProjectObservation | null> {
  const lines = await readLeadingLines(filePath, 50);

  let mtime = 0;
  try {
    mtime = (await fsp.stat(filePath)).mtimeMs;
  } catch {
    mtime = 0;
  }

  for (const line of lines) {
    if (!line) {
      continue;
    }

    let json: RawJson;
    try {
      json = JSON.parse(line) as RawJson;
    } catch {
      continue;
    }

    const cwd = normalizeProjectPath(json.cwd);
    if (!cwd) {
      continue;
    }

    const sessionId = typeof json.sessionId === "string" ? json.sessionId : undefined;
    return {
      path: cwd,
      tool: TOOL_CLAUDE,
      lastSeenAt: mtime || toEpochMs(json.timestamp),
      sessionId,
    };
  }

  return null;
}

export async function collectClaudeFromTranscripts(homeDir = os.homedir()): Promise<ProjectObservation[]> {
  const projectsDir = path.join(homeDir, ".claude", "projects");
  if (!fs.existsSync(projectsDir)) {
    return [];
  }

  let dirEntries: fs.Dirent[] = [];
  try {
    dirEntries = await fsp.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const observations: ProjectObservation[] = [];

  for (const dirEntry of dirEntries) {
    if (!dirEntry.isDirectory()) {
      continue;
    }

    const dirPath = path.join(projectsDir, dirEntry.name);
    let fileEntries: fs.Dirent[] = [];
    try {
      fileEntries = await fsp.readdir(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }

    let newest: { path: string; mtime: number } | null = null;
    for (const fileEntry of fileEntries) {
      if (!fileEntry.isFile() || !fileEntry.name.endsWith(".jsonl")) {
        continue;
      }
      const fullPath = path.join(dirPath, fileEntry.name);
      let mtime = 0;
      try {
        mtime = (await fsp.stat(fullPath)).mtimeMs;
      } catch {
        continue;
      }
      if (!newest || mtime > newest.mtime) {
        newest = { path: fullPath, mtime };
      }
    }

    if (!newest) {
      continue;
    }

    const observation = await parseClaudeTranscriptFile(newest.path);
    if (observation) {
      observations.push(observation);
    }
  }

  return observations;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/project-index.ts test/project-index.test.ts
git commit -m "feat: scan newest claude transcript per dir for cwd and sessionId" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: 3-source Claude collector with sessionId de-duplication

**Files:**
- Modify: `src/project-index.ts` (rename existing `collectClaudeObservations` body to `collectClaudeFromSessionsIndex`; write new orchestrator `collectClaudeObservations`)
- Test: `test/project-index.test.ts`

- [ ] **Step 1: Add the failing test**

Extend the import to include `collectClaudeObservations`, then append:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — current `collectClaudeObservations` only reads `sessions-index.json`, so it returns `[]` and the assertions fail.

- [ ] **Step 3: Implement**

In `src/project-index.ts`, rename the existing `collectClaudeObservations` function to `collectClaudeFromSessionsIndex` (keep its body exactly as-is). Then add the new orchestrator:

```ts
export async function collectClaudeObservations(homeDir = os.homedir()): Promise<ProjectObservation[]> {
  const historyPath = path.join(homeDir, ".claude", "history.jsonl");

  const [fromHistory, fromTranscripts, fromLegacy] = await Promise.all([
    parseClaudeHistoryFile(historyPath),
    collectClaudeFromTranscripts(homeDir),
    collectClaudeFromSessionsIndex(homeDir),
  ]);

  const seenSessionIds = new Set<string>();
  const seenPaths = new Set<string>();
  const result: ProjectObservation[] = [];

  const addSessioned = (observations: ProjectObservation[]): void => {
    for (const observation of observations) {
      if (!observation.sessionId) {
        continue;
      }
      if (seenSessionIds.has(observation.sessionId)) {
        continue;
      }
      seenSessionIds.add(observation.sessionId);
      seenPaths.add(observation.path);
      result.push(observation);
    }
  };

  const addPathOnly = (observations: ProjectObservation[]): void => {
    for (const observation of observations) {
      if (seenPaths.has(observation.path)) {
        continue;
      }
      seenPaths.add(observation.path);
      result.push(observation);
    }
  };

  addSessioned(fromHistory);
  addSessioned(fromTranscripts);
  addPathOnly(fromLegacy);

  return result;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS. (The existing `parseClaudeSessionsIndexFile` tests still pass — that function is unchanged and still used by `collectClaudeFromSessionsIndex`.)

- [ ] **Step 5: Commit**

```bash
git add src/project-index.ts test/project-index.test.ts
git commit -m "feat: rebuild claude collector from 3 sources deduped by sessionId" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `lastLaunch` in state

**Files:**
- Modify: `src/project-index.ts` (interface `AgoState`, `normalizeState`)
- Test: `test/project-index.test.ts`

- [ ] **Step 1: Add the failing tests**

Extend the import to include `normalizeState`, then append:

```ts
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
  const state = normalizeState({ lastLaunch: { path: "/tmp/proj", tool: "bogus" } });
  assert.equal(state.lastLaunch, undefined);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `lastLaunch` is not on `AgoState` / not preserved by `normalizeState`.

- [ ] **Step 3: Implement**

Extend the `AgoState` interface:

```ts
export interface AgoState {
  lastLaunchedByPath: Record<string, ToolName>;
  lastLaunch?: {
    path: string;
    tool: ToolName;
    ts: number;
  };
}
```

In `normalizeState`, after the existing `for` loop populates `out.lastLaunchedByPath` and before `return out;`, add:

```ts
  const rawLastLaunch = rawState?.lastLaunch;
  if (rawLastLaunch && typeof rawLastLaunch === "object" && !Array.isArray(rawLastLaunch)) {
    const candidate = rawLastLaunch as RawJson;
    const launchPath = normalizeProjectPath(candidate.path);
    const launchTool = candidate.tool;
    if (launchPath && (launchTool === TOOL_CODEX || launchTool === TOOL_CLAUDE)) {
      out.lastLaunch = {
        path: launchPath,
        tool: launchTool,
        ts: toEpochMs(candidate.ts),
      };
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS. (`saveState` already calls `normalizeState`, so `lastLaunch` round-trips through disk automatically.)

- [ ] **Step 5: Commit**

```bash
git add src/project-index.ts test/project-index.test.ts
git commit -m "feat: persist lastLaunch in ago state" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Pure CLI helpers — argv `-`, resume args, menu values

**Files:**
- Modify: `src/index.ts` (new `ToolSelection`, `buildResumeArgs`, `parseToolSelection`, `buildToolMenuChoices`; update `normalizeArgv`)
- Test: `test/index-cli.test.ts`

- [ ] **Step 1: Add the failing tests**

Extend the `test/index-cli.test.ts` import from `../src/index.js` to also include `buildResumeArgs`, `parseToolSelection`, and `buildToolMenuChoices`:

```ts
import {
  buildLaunchArgs,
  buildResumeArgs,
  buildToolMenuChoices,
  filterProjectsByNameQuery,
  getRecommendedTool,
  normalizeArgv,
  parseCommandPromptOption,
  parseToolSelection,
} from "../src/index.js";
```

Append:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — the new helpers are not exported; `normalizeArgv` does not map `-`.

- [ ] **Step 3: Implement**

In `src/index.ts`, replace `normalizeArgv` with:

```ts
export function normalizeArgv(argv: string[] = process.argv): string[] {
  const mapped = argv.map((arg) => (arg === "-al" ? "--all" : arg));
  if (mapped[2] === "-") {
    mapped[2] = "--last";
  }
  return mapped;
}
```

Add a `ToolSelection` type near the other interfaces (e.g. just below `interface ProjectChoice`):

```ts
interface ToolSelection {
  tool: ToolName;
  resume: boolean;
}
```

Add these exported helpers (place them next to `buildLaunchArgs`):

```ts
export function buildResumeArgs(tool: ToolName, sessionId: string): string[] {
  if (!sessionId) {
    return [];
  }

  switch (tool) {
    case TOOL_CODEX:
      return ["resume", sessionId];
    case TOOL_CLAUDE:
      return ["--resume", sessionId];
  }
}

export function parseToolSelection(value: string): ToolSelection | null {
  if (value.startsWith("resume:")) {
    const tool = value.slice("resume:".length);
    if (tool === TOOL_CODEX || tool === TOOL_CLAUDE) {
      return { tool, resume: true };
    }
  }

  if (value.startsWith("new:")) {
    const tool = value.slice("new:".length);
    if (tool === TOOL_CODEX || tool === TOOL_CLAUDE) {
      return { tool, resume: false };
    }
  }

  return null;
}

export function buildToolMenuChoices(
  project: ProjectIndexItem,
  recommendedTool: ToolName,
  chalk: { dim: (value: string) => string }
): Array<{ name: string; value: string }> {
  const preferred = recommendedTool === TOOL_CLAUDE ? TOOL_CLAUDE : TOOL_CODEX;
  const fallback = preferred === TOOL_CODEX ? TOOL_CLAUDE : TOOL_CODEX;

  const choices: Array<{ name: string; value: string }> = [];

  for (const tool of [preferred, fallback] as ToolName[]) {
    const hasSession = Boolean(project.lastSessionIdByTool?.[tool]);
    const recommendedTag = tool === preferred ? ` ${chalk.dim("(recommended)")}` : "";

    if (hasSession) {
      choices.push({ name: `${tool} — continue last session${recommendedTag}`, value: `resume:${tool}` });
      choices.push({ name: `${tool} — new session`, value: `new:${tool}` });
    } else {
      choices.push({ name: `${tool}${recommendedTag}`, value: `new:${tool}` });
    }
  }

  choices.push({ name: chalk.dim("Back to project list"), value: "__back__" });
  return choices;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/index-cli.test.ts
git commit -m "feat: add pure helpers for last-launch argv, resume args, and tool menu" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Wire resume + shared launch into the interactive flow

**Files:**
- Modify: `src/index.ts` (new `performLaunch`; rewrite `chooseToolForProject`; update the launch tail of `runInteractive`)

No new unit test (this is interactive wiring at the project's existing test boundary). Verification is build + full suite + `--help` smoke.

- [ ] **Step 1: Replace `chooseToolForProject`**

Replace the entire existing `chooseToolForProject` function with:

```ts
export async function chooseToolForProject(
  project: ProjectIndexItem,
  recommendedTool: ToolName,
  prompts: UiDependencies["prompts"],
  chalk: UiDependencies["chalk"]
): Promise<ToolSelection | null> {
  const choices = buildToolMenuChoices(project, recommendedTool, chalk);

  try {
    const selectedValue = await prompts.select({
      message: `Choose CLI for ${project.name}\nPath: ${project.path}`,
      pageSize: 10,
      choices,
    });

    return parseToolSelection(selectedValue);
  } catch (error) {
    if (isPromptCancelError(error)) {
      return null;
    }

    throw error;
  }
}
```

- [ ] **Step 2: Add `performLaunch`**

Add this helper just above `runInteractive`:

```ts
async function performLaunch(params: {
  tool: ToolName;
  command: string;
  cwd: string;
  args: string[];
  state: AgoState;
  statePath: string;
  chalk: UiDependencies["chalk"];
}): Promise<void> {
  const { tool, command, cwd, args, state, statePath, chalk } = params;

  state.lastLaunchedByPath[cwd] = tool;
  state.lastLaunch = { path: cwd, tool, ts: Date.now() };
  await saveState(state, statePath);

  console.log(chalk.dim(`Launching ${tool} in ${cwd}`));

  const result = await spawnInteractiveCommand(command, args, cwd);

  if (typeof result.code === "number" && result.code !== 0) {
    console.error(chalk.yellow(`${command} exited with code ${result.code}.`));
  }

  if (result.signal) {
    console.error(chalk.yellow(`${command} was terminated by signal ${result.signal}.`));
  }
}
```

- [ ] **Step 3: Rewrite the launch tail of `runInteractive`**

In `runInteractive`, replace everything from `const recommendedTool = getRecommendedTool(...)` down to the final `return;` inside the `while (true)` loop with:

```ts
    const recommendedTool = getRecommendedTool(project, state, config);
    const selection = await chooseToolForProject(project, recommendedTool, prompts, chalk);
    if (!selection) {
      if (singleMatchFlow) {
        return;
      }
      continue;
    }

    const { tool, resume } = selection;
    const command = resolveCommand(tool, config);

    if (!isCommandAvailable(command)) {
      console.error(chalk.red(`Command not found: ${command}. Install it or update ~/.ago/config.json`));
      if (singleMatchFlow) {
        return;
      }
      continue;
    }

    if (!project.exists) {
      console.error(chalk.red(`Project path not found: ${project.path}`));
      if (singleMatchFlow) {
        return;
      }
      continue;
    }

    let launchArgs: string[];
    if (resume) {
      const sessionId = project.lastSessionIdByTool[tool] || "";
      launchArgs = buildResumeArgs(tool, sessionId);
      if (options.commandPrompt) {
        console.log(chalk.dim("Ignoring -c content when resuming a session."));
      }
    } else {
      launchArgs = buildLaunchArgs(tool, options.commandPrompt);
    }

    await performLaunch({ tool, command, cwd: project.path, args: launchArgs, state, statePath, chalk });
    return;
```

- [ ] **Step 4: Build and test**

Run: `npm run build`
Expected: tsc completes with no errors.

Run: `npm test`
Expected: PASS (all existing + new tests).

- [ ] **Step 5: Smoke test the help output**

Run: `node dist/cli.js --help`
Expected: usage prints without error (the `--last` option is added in Task 10, so it need not appear yet).

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: support continue-last-session and share a launch path" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: `ago -` / `--last` quick reopen

**Files:**
- Modify: `src/index.ts` (interface `CliOptions`; new `runLastLaunch`; `main` option + dispatch)

- [ ] **Step 1: Add the `--last` option and dispatch**

In `src/index.ts`, extend `CliOptions`:

```ts
interface CliOptions {
  all?: boolean;
  name?: string;
  command?: string;
  last?: boolean;
}
```

In `main`, add the option after the `-c, --command` option line:

```ts
    .option("-l, --last", "Reopen the last launched project and CLI")
```

Replace the `program.action(...)` body with:

```ts
  program.action(async (options: CliOptions) => {
    const commandPrompt = parseCommandPromptOption(options.command);

    if (options.last) {
      await runLastLaunch({ commandPrompt });
      return;
    }

    await runInteractive({
      showAll: Boolean(options.all),
      nameQuery: normalizeQuery(options.name || ""),
      commandPrompt,
    });
  });
```

- [ ] **Step 2: Add `runLastLaunch`**

Add just above `main`:

```ts
export async function runLastLaunch(options: { commandPrompt: string }): Promise<void> {
  const { chalk } = await loadUiDependencies();

  const statePath = getDefaultStatePath();
  const config = await loadConfig(getDefaultConfigPath());
  const state = await loadState(statePath);
  const last = state.lastLaunch;

  const fallback = async (reason: string): Promise<void> => {
    console.log(chalk.yellow(`${reason} Falling back to project list.`));
    await runInteractive({ showAll: false, nameQuery: "", commandPrompt: options.commandPrompt });
  };

  if (!last) {
    await fallback("No previous launch recorded.");
    return;
  }

  const command = resolveCommand(last.tool, config);
  if (!isCommandAvailable(command)) {
    await fallback(`Command not found: ${command}.`);
    return;
  }

  if (!fs.existsSync(last.path)) {
    await fallback(`Last project path not found: ${last.path}.`);
    return;
  }

  await performLaunch({
    tool: last.tool,
    command,
    cwd: last.path,
    args: buildLaunchArgs(last.tool, options.commandPrompt),
    state,
    statePath,
    chalk,
  });
}
```

- [ ] **Step 3: Build and test**

Run: `npm run build`
Expected: tsc completes with no errors.

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Smoke test**

Run: `node dist/cli.js --help`
Expected: output now lists `-l, --last`.

Run: `node dist/cli.js - 2>&1 | head -5`
Expected: since no `lastLaunch` exists yet on a fresh state, it prints the yellow "No previous launch recorded. Falling back to project list." message (then enters the project list — press Ctrl+C to exit). This confirms the `-` → `--last` mapping and fallback path.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: add ago - / --last to reopen the last launched project" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update Features and Options**

In `README.md`, under `## Features`, add bullets:

```markdown
- Projects are ranked by frecency (frequency × recency), so daily projects stay on top.
- `ago -` (or `ago --last`) instantly reopens the last launched project + CLI.
- For tools with a recorded session, the CLI menu offers "continue last session" (resumes the exact session id).
```

Under `### Options`, add:

```markdown
- `-l, --last`: reopen the last launched project + CLI (alias: bare `ago -`).
```

- [ ] **Step 2: Update Data Sources**

Replace the `## Data Sources` Claude bullet with:

```markdown
- Claude (in priority order, deduplicated by session id):
  - `~/.claude/history.jsonl` — entries provide `project`, `timestamp`, `sessionId`.
  - `~/.claude/projects/<encoded-path>/<session-uuid>.jsonl` — the newest transcript per project dir supplies the true `cwd` (paths are never decoded from the directory name).
  - `~/.claude/projects/*/sessions-index.json` — legacy fallback for older Claude versions.
```

- [ ] **Step 3: Update State file doc**

Under `### State file`, replace the JSON example with:

```json
{
  "lastLaunchedByPath": {
    "/absolute/project/path": "codex"
  },
  "lastLaunch": {
    "path": "/absolute/project/path",
    "tool": "codex",
    "ts": 1780554836375
  }
}
```

And add below it:

```markdown
`lastLaunch` records the most recent launch and powers `ago -` / `ago --last`.
```

- [ ] **Step 4: Verify build + tests once more**

Run: `npm run build && npm test`
Expected: build clean, all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document frecency sort, ago --last, resume, and claude data sources" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Plan Self-Review

**Spec coverage:**
- §1 Fix Claude data source → Tasks 4, 5, 6 (history.jsonl, transcript scan, deduped orchestrator); plus §2.2 epoch parsing in Task 1.
- §2 Data model (`sessionId`, `frecencyScore`, `lastSessionIdByTool`) → Tasks 1, 2, 3.
- §2.1 frecency weight buckets → Task 2.
- §3.2 frecency default sort → Task 2 (sort comparator).
- §3.3 `ago -` / `--last`, `lastLaunch` state, graceful fallback → Tasks 7, 8 (argv), 10.
- §3.4 continue-last-session (precise sessionId, menu, ignore `-c`) → Tasks 8 (helpers), 9 (wiring).
- §4 edge cases → covered: missing history (Task 6 Promise.all tolerates `[]`), no-cwd leading lines (Task 5 test), missing sessionId (Task 6 skips for dedup), old state without lastLaunch (Task 7), epoch s/ms (Task 1).
- §5 testing → unit/integration tests in every data task; build + smoke for wiring tasks.
- Docs → Task 11.

**Placeholder scan:** none — every code step shows complete code; every run step shows the command and expected result.

**Type consistency:** `ProjectObservation.sessionId?` (T1) used in T2/T3/T4/T5/T6; `ProjectIndexItem.frecencyScore` + `lastSessionIdByTool` (T2) used in T8/T9; `ToolSelection` (T8) returned by `chooseToolForProject` (T9) and produced by `parseToolSelection` (T8); `buildResumeArgs`/`buildToolMenuChoices`/`parseToolSelection` names consistent across T8/T9; `performLaunch` (T9) reused by `runLastLaunch` (T10); `AgoState.lastLaunch` (T7) written by `performLaunch` (T9) and read by `runLastLaunch` (T10). Consistent.
