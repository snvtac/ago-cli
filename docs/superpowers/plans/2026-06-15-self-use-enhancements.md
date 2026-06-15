# ago-cli 自用增强(项目置顶 + 历史会话选择器)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add project pinning (`ago pin/unpin`) and a historical-session picker (project → tool → select session) to the `ago` launcher, without new runtime deps.

**Architecture:** Pins live in `~/.ago/state.json#pinnedPaths` (state is the only tool-written file; config stays read-only). The Codex session list is built for free during the existing index scan; the Claude session list is scanned lazily from the project's transcript directory only when the picker opens (history.jsonl alone misses ~60% of sessions). Pinned-first ordering is a separate pure function in the index layer, leaving `mergeProjectObservations` neutral for `doctor.ts` reuse.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`, `verbatimModuleSyntax`), Node `>=18`, commander v12, `@inquirer/prompts`, chalk. Tests: `node:test` + `node:assert/strict`, run via `node --import tsx --test test/*.test.ts`.

**Spec:** `docs/superpowers/specs/2026-06-15-ago-cli-self-use-enhancements-design.md`

**Conventions for every task:**
- TDD: write the failing test first, watch it fail, implement minimally, watch it pass, commit.
- Run the **whole** suite before each commit: `npm test`. Then `npm run build` must also pass (it type-checks `src/`).
- `verbatimModuleSyntax` is on: import types with `import type { ... }`.
- Every commit message ends with this trailer (own paragraph):
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```
- Test invocation for a single file while iterating: `node --import tsx --test test/project-index.test.ts`.

---

## File Structure

- `src/project-index.ts` (modify) — data + file IO:
  - `SessionRef` type; `AgoState.pinnedPaths`; `DEFAULT_STATE.pinnedPaths`.
  - `normalizeState` carries/validates `pinnedPaths`.
  - `addPinnedPath` / `removePinnedPath` (pure state-array helpers).
  - `ProjectIndexItem` gains `pinned`, `sessionsByTool: { codex: SessionRef[] }`, `sessionCountByTool: { codex; claude }`, `claudeTranscriptDir?`.
  - `mergeProjectObservations` builds `sessionsByTool.codex` (deduped, newest-first), sets `pinned:false`, `sessionCountByTool.codex`.
  - `sortWithPins(items, pinnedPaths)` (pure, pinned-first).
  - `collectClaudeProjectDirs(homeDir)` → `ClaudeDirInfo[]`; `buildProjectIndex` annotates `claudeTranscriptDir` + `sessionCountByTool.claude`.
  - `collectClaudeSessionsForDir(dir)` → `SessionRef[]` (lazy, with preview).
- `src/index.ts` (modify) — CLI + interaction:
  - `resolvePinTarget(input)`; `pin` / `unpin` subcommands.
  - `sortWithPins` call + `★` marker in `getColumnWidths` / `buildProjectChoice`.
  - `ToolSelection` → `{ tool; action }`; `parseToolSelection` adds `pick:`.
  - `buildToolMenuChoices` adds "选择历史会话…"; `buildSessionChoices` (pure); `chooseSessionForTool`; `chooseToolForProject` inner loop; resume/pick branch.
- `src/doctor.ts` (modify) — `report.state.pinnedCount` + `state.pinned_paths_exist` check.
- `test/project-index.test.ts`, `test/index-cli.test.ts`, `test/doctor.test.ts` (modify).
- `README.md` (modify).

---

## Task 1: State — persist `pinnedPaths` (the "silently dropped" trap)

**Files:**
- Modify: `src/project-index.ts` (`AgoState` ~`:21-28`, `DEFAULT_STATE` ~`:61-63`, `normalizeState` ~`:758-792`)
- Test: `test/project-index.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/project-index.test.ts` (it already imports `normalizeState`; add `loadState`, `saveState`, `getDefaultStatePath` to the import block from `../src/project-index.js`):

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test test/project-index.test.ts`
Expected: FAIL — `pinnedPaths` is `undefined` (not `[]`) and is dropped on round-trip.

- [ ] **Step 3: Implement**

In `src/project-index.ts`, extend the `AgoState` interface:

```ts
export interface AgoState {
  lastLaunchedByPath: Record<string, ToolName>;
  lastLaunch?: {
    path: string;
    tool: ToolName;
    ts: number;
  };
  pinnedPaths: string[];
}
```

Extend `DEFAULT_STATE`:

```ts
export const DEFAULT_STATE: Readonly<AgoState> = Object.freeze({
  lastLaunchedByPath: {},
  pinnedPaths: [],
});
```

In `normalizeState`, initialize `out` with `pinnedPaths` and populate it before `return out;`:

```ts
  const out: AgoState = {
    lastLaunchedByPath: {},
    pinnedPaths: [],
  };
```

Then, just before `return out;`, add:

```ts
  if (Array.isArray(rawState?.pinnedPaths)) {
    const seen = new Set<string>();
    for (const candidate of rawState.pinnedPaths as unknown[]) {
      if (typeof candidate !== "string") {
        continue;
      }
      const normalized = normalizeProjectPath(candidate);
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      out.pinnedPaths.push(normalized);
    }
  }
```

> Note: `saveState` already calls `normalizeState(state)` before writing (`:944`), so once `normalizeState` carries `pinnedPaths`, the round-trip is safe. `inspectState` builds on `normalizeState`, so `inspectState(...).value.pinnedPaths` is now populated too — relied on in Task 13.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test test/project-index.test.ts` then `npm run build`
Expected: PASS; build clean. (The existing `inspectState` "missing file returns defaults" test asserts `result.value` deepEqual `{ lastLaunchedByPath: {} }` — update that one literal to `{ lastLaunchedByPath: {}, pinnedPaths: [] }`.)

- [ ] **Step 5: Commit**

```bash
git add src/project-index.ts test/project-index.test.ts
git commit -m "feat: persist pinnedPaths in ago state"
```

---

## Task 2: Pure pin-array helpers `addPinnedPath` / `removePinnedPath`

**Files:**
- Modify: `src/project-index.ts`
- Test: `test/project-index.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
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
```

Add `addPinnedPath, removePinnedPath` to the import block.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test test/project-index.test.ts`
Expected: FAIL — `addPinnedPath is not a function`.

- [ ] **Step 3: Implement**

Add to `src/project-index.ts` (near `normalizeState`):

```ts
export function addPinnedPath(pinnedPaths: string[], inputPath: string): string[] {
  const normalized = normalizeProjectPath(inputPath);
  if (!normalized) {
    return pinnedPaths;
  }
  if (pinnedPaths.includes(normalized)) {
    return pinnedPaths;
  }
  return [...pinnedPaths, normalized];
}

export function removePinnedPath(pinnedPaths: string[], inputPath: string): string[] {
  const normalized = normalizeProjectPath(inputPath);
  if (!normalized) {
    return pinnedPaths;
  }
  return pinnedPaths.filter((entry) => entry !== normalized);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test test/project-index.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/project-index.ts test/project-index.test.ts
git commit -m "feat: add pure addPinnedPath/removePinnedPath helpers"
```

---

## Task 3: `SessionRef` + Codex session list in `mergeProjectObservations`

**Files:**
- Modify: `src/project-index.ts` (`ProjectIndexItem` ~`:37-53`, `MergedMapItem` ~`:623-630`, `mergeProjectObservations` ~`:632-707`)
- Test: `test/project-index.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test("mergeProjectObservations builds deduped newest-first codex sessions", () => {
  const merged = mergeProjectObservations([
    { path: "/x", tool: TOOL_CODEX, lastSeenAt: 100, sessionId: "a" },
    { path: "/x", tool: TOOL_CODEX, lastSeenAt: 300, sessionId: "b" },
    { path: "/x", tool: TOOL_CODEX, lastSeenAt: 300, sessionId: "a" }, // dupe of a, higher ts
  ]);
  const item = merged[0];
  assert.deepEqual(item?.sessionsByTool.codex.map((s) => s.sessionId), ["b", "a"]);
  assert.equal(item?.sessionsByTool.codex[0]?.lastSeenAt, 300);
  assert.equal(item?.sessionCountByTool.codex, 2);
  assert.equal(item?.pinned, false);
});

test("mergeProjectObservations leaves claude session count at 0 (filled lazily later)", () => {
  const merged = mergeProjectObservations([{ path: "/y", tool: TOOL_CLAUDE, lastSeenAt: 1, sessionId: "c" }]);
  assert.equal(merged[0]?.sessionCountByTool.claude, 0);
  assert.deepEqual(merged[0]?.sessionsByTool.codex, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test test/project-index.test.ts`
Expected: FAIL — `sessionsByTool` undefined.

- [ ] **Step 3: Implement**

Add the type near `ProjectObservation`:

```ts
export interface SessionRef {
  sessionId: string;
  lastSeenAt: number;
  preview?: string;
}
```

Extend `ProjectIndexItem` with:

```ts
  pinned: boolean;
  sessionsByTool: { codex: SessionRef[] };
  sessionCountByTool: { codex: number; claude: number };
  claudeTranscriptDir?: string;
```

Extend `MergedMapItem` with a codex-session accumulator:

```ts
  codexSessions: Map<string, SessionRef>;
```

When creating a new `MergedMapItem` (in the `if (!existing)` block), add `codexSessions: new Map()`.

Inside the observation loop, after the existing `lastSeenAtByTool`/`lastSessionIdByTool` update block, accumulate codex sessions:

```ts
    if (tool === TOOL_CODEX && sessionId) {
      const prev = existing.codexSessions.get(sessionId);
      if (!prev || lastSeenAt >= prev.lastSeenAt) {
        existing.codexSessions.set(sessionId, { sessionId, lastSeenAt });
      }
    }
```

In the `.map()` projection that builds each `ProjectIndexItem`, compute the sorted codex list and add the four new fields to the returned object:

```ts
      const codexSessions = [...item.codexSessions.values()].sort(
        (left, right) => right.lastSeenAt - left.lastSeenAt || left.sessionId.localeCompare(right.sessionId)
      );
```

```ts
        pinned: false,
        sessionsByTool: { codex: codexSessions },
        sessionCountByTool: { codex: codexSessions.length, claude: 0 },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test test/project-index.test.ts` then `npm run build`
Expected: PASS; build clean. (Existing merge/frecency tests still pass — they assert only a subset of fields.)

- [ ] **Step 5: Commit**

```bash
git add src/project-index.ts test/project-index.test.ts
git commit -m "feat: collect deduped codex sessions during merge"
```

---

## Task 4: `sortWithPins` (pinned-first, pure)

**Files:**
- Modify: `src/project-index.ts`
- Test: `test/project-index.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test("sortWithPins moves pinned projects first while keeping group order", () => {
  const items = [
    { path: path.resolve("/a"), pinned: false },
    { path: path.resolve("/b"), pinned: false },
    { path: path.resolve("/c"), pinned: false },
  ] as never[];
  const sorted = sortWithPins(items, [path.resolve("/c")]);
  assert.deepEqual(sorted.map((i) => i.path), [path.resolve("/c"), path.resolve("/a"), path.resolve("/b")]);
  assert.equal(sorted[0]?.pinned, true);
  assert.equal(sorted[1]?.pinned, false);
});

test("sortWithPins is a stable no-op order when no pins (and ignores unknown pins)", () => {
  const items = [{ path: path.resolve("/a"), pinned: false }, { path: path.resolve("/b"), pinned: false }] as never[];
  const sorted = sortWithPins(items, [path.resolve("/zzz-not-present")]);
  assert.deepEqual(sorted.map((i) => i.path), [path.resolve("/a"), path.resolve("/b")]);
  assert.equal(sorted[0]?.pinned, false);
});
```

Add `sortWithPins` to the import block.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test test/project-index.test.ts`
Expected: FAIL — `sortWithPins is not a function`.

- [ ] **Step 3: Implement**

Add to `src/project-index.ts`:

```ts
export function sortWithPins(items: ProjectIndexItem[], pinnedPaths: string[]): ProjectIndexItem[] {
  const pinnedSet = new Set(pinnedPaths);
  const marked = items.map((item) => ({ ...item, pinned: pinnedSet.has(item.path) }));
  const pinned = marked.filter((item) => item.pinned);
  const rest = marked.filter((item) => !item.pinned);
  return [...pinned, ...rest];
}
```

> `items` arrive already frecency-sorted from `mergeProjectObservations`; `filter` preserves that relative order within each group.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test test/project-index.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/project-index.ts test/project-index.test.ts
git commit -m "feat: add sortWithPins pinned-first ordering"
```

---

## Task 5: Annotate `claudeTranscriptDir` + claude session count in `buildProjectIndex`

**Files:**
- Modify: `src/project-index.ts` (`collectClaudeFromTranscripts` ~`:471-527`, `buildProjectIndex` ~`:998-1014`)
- Test: `test/project-index.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("buildProjectIndex annotates claudeTranscriptDir and session counts", async () => {
  await withTempDir(async (home) => {
    const projPath = path.join(home, "work", "demo");
    await fs.mkdir(projPath, { recursive: true });

    // Two Claude transcripts in one dir -> claude count 2, dir set.
    const dir = path.join(home, ".claude", "projects", "-work-demo");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "s1.jsonl"),
      `${JSON.stringify({ type: "user", cwd: projPath, sessionId: "s1", timestamp: "2026-01-01T00:00:00.000Z" })}\n`,
      "utf8"
    );
    await fs.writeFile(
      path.join(dir, "s2.jsonl"),
      `${JSON.stringify({ type: "user", cwd: projPath, sessionId: "s2", timestamp: "2026-02-01T00:00:00.000Z" })}\n`,
      "utf8"
    );

    // Two Codex sessions for the same path -> codex count 2.
    const codexDir = path.join(home, ".codex", "sessions", "2026", "01");
    await fs.mkdir(codexDir, { recursive: true });
    await fs.writeFile(
      path.join(codexDir, "c1.jsonl"),
      `${JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", payload: { id: "c1", cwd: projPath } })}\n`,
      "utf8"
    );
    await fs.writeFile(
      path.join(codexDir, "c2.jsonl"),
      `${JSON.stringify({ timestamp: "2026-01-02T00:00:00.000Z", payload: { id: "c2", cwd: projPath } })}\n`,
      "utf8"
    );

    const [item] = await buildProjectIndex({ homeDir: home });
    assert.equal(item?.path, projPath);
    assert.equal(item?.claudeTranscriptDir, dir);
    assert.equal(item?.sessionCountByTool.claude, 2);
    assert.equal(item?.sessionCountByTool.codex, 2);
  });
});
```

Add `buildProjectIndex` to the import block.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/project-index.test.ts`
Expected: FAIL — `claudeTranscriptDir` undefined, `sessionCountByTool.claude` is 0.

- [ ] **Step 3: Implement**

Add the type and a directory collector to `src/project-index.ts`:

```ts
export interface ClaudeDirInfo {
  path: string;
  dir: string;
  sessionCount: number;
}

export async function collectClaudeProjectDirs(homeDir = os.homedir()): Promise<ClaudeDirInfo[]> {
  const projectsDir = getClaudeProjectsDir(homeDir);
  if (!fs.existsSync(projectsDir)) {
    return [];
  }

  let dirEntries: fs.Dirent[] = [];
  try {
    dirEntries = await fsp.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const infos: ClaudeDirInfo[] = [];
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

    const transcripts = fileEntries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
    if (transcripts.length === 0) {
      continue;
    }

    let newest: { path: string; mtime: number } | null = null;
    for (const entry of transcripts) {
      const fullPath = path.join(dirPath, entry.name);
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
    if (!observation) {
      continue;
    }
    infos.push({ path: observation.path, dir: dirPath, sessionCount: transcripts.length });
  }

  return infos;
}
```

In `buildProjectIndex`, collect dir info alongside observations and annotate the merged items before the roots filter:

```ts
  const [codexObservations, claudeObservations, claudeDirs] = await Promise.all([
    collectCodexObservations(homeDir),
    collectClaudeObservations(homeDir),
    collectClaudeProjectDirs(homeDir),
  ]);

  const dirByPath = new Map(claudeDirs.map((info) => [info.path, info]));
  const merged = mergeProjectObservations([...codexObservations, ...claudeObservations]);
  for (const item of merged) {
    const info = dirByPath.get(item.path);
    if (info) {
      item.claudeTranscriptDir = info.dir;
      item.sessionCountByTool.claude = info.sessionCount;
    }
  }

  return filterProjectsByRoots(merged, normalizedConfig.roots, homeDir);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/project-index.test.ts` then `npm run build`
Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add src/project-index.ts test/project-index.test.ts
git commit -m "feat: annotate claude transcript dir and session counts"
```

---

## Task 6: Lazy Claude session list `collectClaudeSessionsForDir`

**Files:**
- Modify: `src/project-index.ts`
- Test: `test/project-index.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("collectClaudeSessionsForDir lists sessions newest-first with a first-user-message preview", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, "older.jsonl"),
      `${JSON.stringify({ type: "user", sessionId: "older", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "fix the older bug" } })}\n`,
      "utf8"
    );
    const newer = [
      JSON.stringify({ type: "file-history-snapshot" }),
      JSON.stringify({ type: "user", sessionId: "newer", timestamp: "2026-02-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "add the newer feature" }] } }),
    ].join("\n");
    await fs.writeFile(path.join(dir, "newer.jsonl"), `${newer}\n`, "utf8");

    const sessions = await collectClaudeSessionsForDir(dir);
    assert.deepEqual(sessions.map((s) => s.sessionId), ["newer", "older"]);
    assert.equal(sessions[0]?.preview, "add the newer feature");
    assert.equal(sessions[1]?.preview, "fix the older bug");
  });
});
```

Add `collectClaudeSessionsForDir` to the import block.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/project-index.test.ts`
Expected: FAIL — `collectClaudeSessionsForDir is not a function`.

- [ ] **Step 3: Implement**

Add to `src/project-index.ts` (reuses the existing `readLeadingLines`):

```ts
function extractClaudeUserPreview(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const content = (message as RawJson).content;
  if (typeof content === "string") {
    return content.replace(/\s+/g, " ").trim().slice(0, 120) || undefined;
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === "object" && typeof (part as RawJson).text === "string") {
        return ((part as RawJson).text as string).replace(/\s+/g, " ").trim().slice(0, 120) || undefined;
      }
    }
  }
  return undefined;
}

export async function collectClaudeSessionsForDir(dir: string): Promise<SessionRef[]> {
  let entries: fs.Dirent[] = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessions: SessionRef[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }
    const sessionId = entry.name.slice(0, -".jsonl".length);
    if (!sessionId) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);

    let mtime = 0;
    try {
      mtime = (await fsp.stat(fullPath)).mtimeMs;
    } catch {
      mtime = 0;
    }

    const lines = await readLeadingLines(fullPath, 50);
    let preview: string | undefined;
    let firstTimestamp = 0;
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
      if (json.type !== "user") {
        continue;
      }
      if (!firstTimestamp) {
        firstTimestamp = toEpochMs(json.timestamp);
      }
      preview = extractClaudeUserPreview(json.message);
      if (preview) {
        break;
      }
    }

    sessions.push({ sessionId, lastSeenAt: mtime || firstTimestamp, preview });
  }

  sessions.sort((left, right) => right.lastSeenAt - left.lastSeenAt || left.sessionId.localeCompare(right.sessionId));
  return sessions;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/project-index.test.ts` then `npm run build`
Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add src/project-index.ts test/project-index.test.ts
git commit -m "feat: lazily list claude sessions with preview from a transcript dir"
```

---

## Task 7: `resolvePinTarget` (cwd / existing-dir / fuzzy)

**Files:**
- Modify: `src/index.ts`
- Test: `test/index-cli.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `test/index-cli.test.ts` (add `resolvePinTarget` to the `../src/index.js` import; the file already imports `fsp`, `os`, `path`):

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test test/index-cli.test.ts`
Expected: FAIL — `resolvePinTarget is not a function`.

- [ ] **Step 3: Implement**

In `src/index.ts`, import the needed pieces (these names are already exported from `project-index.js`; extend the existing import or add `expandHome` — note `expandHome` is currently NOT exported, so export it from `project-index.ts` first, or reuse `resolveConfiguredRoot` which already expands `~` and resolves). Use `resolveConfiguredRoot` to avoid changing exports:

```ts
import {
  // ...existing...
  resolveConfiguredRoot,
} from "./project-index.js";
```

Add:

```ts
export type PinTarget =
  | { kind: "resolved"; path: string }
  | { kind: "ambiguous"; candidates: ProjectIndexItem[] }
  | { kind: "not_found" };

export function resolvePinTarget(input: {
  name?: string;
  cwd: string;
  projects: ProjectIndexItem[];
  homeDir: string;
}): PinTarget {
  const rawName = typeof input.name === "string" ? input.name.trim() : "";

  if (!rawName) {
    return { kind: "resolved", path: path.resolve(input.cwd) };
  }

  const asPath = resolveConfiguredRoot(rawName, input.homeDir);
  if (asPath) {
    try {
      if (fs.statSync(asPath).isDirectory()) {
        return { kind: "resolved", path: asPath };
      }
    } catch {
      // not an existing directory; fall through to fuzzy match
    }
  }

  const matches = filterProjectsByNameQuery(input.projects, rawName);
  if (matches.length === 1) {
    return { kind: "resolved", path: matches[0]!.path };
  }
  if (matches.length > 1) {
    return { kind: "ambiguous", candidates: matches };
  }
  return { kind: "not_found" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test test/index-cli.test.ts` then `npm run build`
Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/index-cli.test.ts
git commit -m "feat: add resolvePinTarget (cwd/dir/fuzzy)"
```

---

## Task 8: `ago pin` / `ago unpin` commands

**Files:**
- Modify: `src/index.ts` (`main()` commander setup ~`:701-768`)
- Test: `test/index-cli.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test test/index-cli.test.ts`
Expected: FAIL — `pin`/`unpin` are unknown commands (non-zero exit / error output).

- [ ] **Step 3: Implement**

Add a shared command handler and register subcommands in `main()` (after the `doctor` command registration, before `program.action(...)`). Imports needed: `addPinnedPath`, `removePinnedPath`, `loadState`, `saveState`, `getDefaultStatePath` (most already imported).

```ts
async function runPinCommand(action: "pin" | "unpin", name: string | undefined, homeDir: string): Promise<void> {
  const config = await loadConfig(getDefaultConfigPath());
  const statePath = getDefaultStatePath();
  const state = await loadState(statePath);
  const projects = await buildProjectIndex({ config, homeDir });

  const target = resolvePinTarget({ name, cwd: process.cwd(), projects, homeDir });
  if (target.kind === "ambiguous") {
    console.error(`Ambiguous name "${name}". Matches:`);
    for (const candidate of target.candidates) {
      console.error(`  ${candidate.path}`);
    }
    process.exitCode = 1;
    return;
  }
  if (target.kind === "not_found") {
    console.error(`No project matched "${name}". Pass a directory path or a unique name.`);
    process.exitCode = 1;
    return;
  }

  if (action === "pin") {
    state.pinnedPaths = addPinnedPath(state.pinnedPaths, target.path);
    await saveState(state, statePath);
    console.log(`Pinned ${target.path} (${state.pinnedPaths.length} pinned)`);
    return;
  }

  const before = state.pinnedPaths.length;
  state.pinnedPaths = removePinnedPath(state.pinnedPaths, target.path);
  await saveState(state, statePath);
  console.log(
    state.pinnedPaths.length < before
      ? `Unpinned ${target.path} (${state.pinnedPaths.length} pinned)`
      : `${target.path} was not pinned (${state.pinnedPaths.length} pinned)`
  );
}
```

Register the commands (place near the `doctor` registration):

```ts
  program
    .command("pin")
    .description("Pin a project to the top of the list")
    .argument("[name]", "Directory path or fuzzy project name (defaults to current directory)")
    .allowExcessArguments(false)
    .action(async (name?: string) => {
      await runPinCommand("pin", name, os.homedir());
    });

  program
    .command("unpin")
    .description("Remove a project pin")
    .argument("[name]", "Directory path or fuzzy project name (defaults to current directory)")
    .allowExcessArguments(false)
    .action(async (name?: string) => {
      await runPinCommand("unpin", name, os.homedir());
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test test/index-cli.test.ts` then `npm run build`
Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/index-cli.test.ts
git commit -m "feat: add ago pin/unpin commands"
```

---

## Task 9: `★` marker + `sortWithPins` in the interactive list

**Files:**
- Modify: `src/index.ts` (`getColumnWidths` ~`:173-184`, `buildProjectChoice` ~`:186-208`, `runInteractive` ~`:557-647`)
- Test: `test/index-cli.test.ts`

- [ ] **Step 1: Write the failing test**

`buildProjectChoice` is currently module-private. Export it (add `export`) and test alignment with the no-color passthrough chalk:

```ts
test("buildProjectChoice reserves a fixed marker column so pinned/unpinned rows align", () => {
  const chalk = {
    dim: (v: string) => v, cyan: (v: string) => v, blue: (v: string) => v,
    magenta: (v: string) => v, green: (v: string) => v, red: (v: string) => v, yellow: (v: string) => v,
  };
  const base = { name: "demo", lastSeenAt: 0, sourceLabel: "codex", exists: true } as never;
  const widths = { name: 16, date: 8, platform: 12, status: 7 };

  const pinned = buildProjectChoice({ ...base, pinned: true }, chalk, widths, { showStatus: false });
  const plain = buildProjectChoice({ ...base, pinned: false }, chalk, widths, { showStatus: false });

  assert.ok(pinned.name.startsWith("★ "));
  assert.ok(plain.name.startsWith("  "));
  // Everything after the 2-char marker column is identical -> columns stay aligned.
  assert.equal(pinned.name.slice(2), plain.name.slice(2));
});
```

Add `buildProjectChoice` to the `../src/index.js` import block.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/index-cli.test.ts`
Expected: FAIL — `buildProjectChoice` not exported / no marker column.

- [ ] **Step 3: Implement**

Export `buildProjectChoice` and prepend a fixed 2-char marker cell. Add a helper:

```ts
function pinMarkerCell(pinned: boolean, chalk: UiDependencies["chalk"]): string {
  return pinned ? `${chalk.yellow("★")} ` : "  ";
}
```

In `buildProjectChoice`, build `const marker = pinMarkerCell(project.pinned, chalk);` and prefix it onto both `name` variants:

```ts
  return {
    name: options.showStatus
      ? `${marker}${nameText}  ${dateLabel}  ${sourceLabel}  ${existsLabel}`
      : `${marker}${nameText}  ${dateLabel}  ${sourceLabel}`,
    value: project.path,
    project,
  };
```

> The marker is a constant 2 visible columns for every row (`★ ` or two spaces), so the `.length`-based `fitText` columns after it stay aligned. The yellow color codes add no visible width.

In `runInteractive`, apply pins after building the project list. Find where `matchedProjects` is computed (after `filterProjectsByNameQuery`, ~`:568`) and wrap with pins:

```ts
  const allProjects = await buildProjectIndex({ config, homeDir: os.homedir() });
  const pinnedProjects = sortWithPins(allProjects, state.pinnedPaths);
  const projects = options.showAll ? pinnedProjects : pinnedProjects.filter((project) => project.exists);
  const matchedProjects = filterProjectsByNameQuery(projects, options.nameQuery);
```

Add `sortWithPins` to the `./project-index.js` import block.

> Default mode keeps the `exists` filter: a pinned-but-missing project does not appear unless `-al` is used (spec §3.5).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/index-cli.test.ts` then `npm run build`
Expected: PASS; build clean. Existing CLI tests (`-al on empty home`, etc.) still pass.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/index-cli.test.ts
git commit -m "feat: render pinned projects first with a star marker"
```

---

## Task 10: `ToolSelection` → `{ tool, action }` + `parseToolSelection` `pick:`

**Files:**
- Modify: `src/index.ts` (`ToolSelection` ~`:44-47`, `parseToolSelection` ~`:463-479`, `runInteractive` resume branch ~`:614/634`)
- Test: `test/index-cli.test.ts`

- [ ] **Step 1: Update the existing test + add cases**

Replace the existing `parseToolSelection decodes menu values` test with:

```ts
test("parseToolSelection decodes menu values into actions", () => {
  assert.deepEqual(parseToolSelection("new:codex"), { tool: TOOL_CODEX, action: "new" });
  assert.deepEqual(parseToolSelection("resume:claude"), { tool: TOOL_CLAUDE, action: "resume" });
  assert.deepEqual(parseToolSelection("pick:codex"), { tool: TOOL_CODEX, action: "pick" });
  assert.equal(parseToolSelection("__back__"), null);
  assert.equal(parseToolSelection("garbage"), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/index-cli.test.ts`
Expected: FAIL — current `parseToolSelection` returns `{ tool, resume }` and has no `pick`.

- [ ] **Step 3: Implement**

Change the `ToolSelection` interface:

```ts
interface ToolSelection {
  tool: ToolName;
  action: "resume" | "new" | "pick";
}
```

Rewrite `parseToolSelection`:

```ts
export function parseToolSelection(value: string): ToolSelection | null {
  const parsed = ([
    ["resume:", "resume"],
    ["new:", "new"],
    ["pick:", "pick"],
  ] as const).find(([prefix]) => value.startsWith(prefix));

  if (!parsed) {
    return null;
  }

  const tool = value.slice(parsed[0].length);
  if (tool === TOOL_CODEX || tool === TOOL_CLAUDE) {
    return { tool, action: parsed[1] };
  }
  return null;
}
```

In `runInteractive`, update the destructure and the resume branch (`pick` is added in Task 12; for now treat unknown actions as "new"):

```ts
    const { tool, action } = selection;
    const command = resolveCommand(tool, config);
```

```ts
    let launchArgs: string[];
    if (action === "resume") {
      const sessionId = project.lastSessionIdByTool[tool] || "";
      launchArgs = buildResumeArgs(tool, sessionId);
      if (options.commandPrompt) {
        console.log(chalk.dim("Ignoring -c content when resuming a session."));
      }
    } else {
      launchArgs = buildLaunchArgs(tool, options.commandPrompt);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/index-cli.test.ts` then `npm run build`
Expected: PASS; build clean. (`ago -` last-launch flow and existing menu still behave identically.)

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/index-cli.test.ts
git commit -m "refactor: model tool selection as resume/new/pick action"
```

---

## Task 11: "选择历史会话…" entry in `buildToolMenuChoices`

**Files:**
- Modify: `src/index.ts` (`buildToolMenuChoices` ~`:481-505`)
- Test: `test/index-cli.test.ts`

- [ ] **Step 1: Update the existing test + add a gating case**

The existing `buildToolMenuChoices shows continue only ...` test passes a project literal `{ lastSessionIdByTool: { claude: "c1" } }`. Add a `sessionCountByTool` to it and add a new test:

```ts
test("buildToolMenuChoices shows continue only for tools with a last session", () => {
  const project = { lastSessionIdByTool: { claude: "c1" }, sessionCountByTool: { codex: 0, claude: 1 } } as never;
  const choices = buildToolMenuChoices(project, TOOL_CLAUDE, { dim: (value: string) => value });
  const values = choices.map((choice) => choice.value);

  assert.ok(values.includes("resume:claude"));
  assert.ok(values.includes("new:claude"));
  assert.ok(values.includes("new:codex"));
  assert.ok(!values.includes("resume:codex"));
  assert.ok(!values.includes("pick:claude")); // only 1 session -> no picker
  assert.equal(values[values.length - 1], "__back__");
});

test("buildToolMenuChoices offers a session picker when a tool has >= 2 sessions", () => {
  const project = { lastSessionIdByTool: { claude: "c1" }, sessionCountByTool: { codex: 0, claude: 3 } } as never;
  const values = buildToolMenuChoices(project, TOOL_CLAUDE, { dim: (v: string) => v }).map((c) => c.value);
  assert.ok(values.includes("pick:claude"));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test test/index-cli.test.ts`
Expected: FAIL — no `pick:claude` produced.

- [ ] **Step 3: Implement**

In `buildToolMenuChoices`, inside the `for (const tool of [preferred, fallback])` loop, after pushing the resume/new choices for that tool, add the picker entry:

```ts
    if ((project.sessionCountByTool?.[tool] ?? 0) >= 2) {
      choices.push({ name: `${tool} — 选择历史会话…`, value: `pick:${tool}` });
    }
```

> Update the `buildToolMenuChoices` parameter type to include the fields it now reads, e.g. `project: Pick<ProjectIndexItem, "lastSessionIdByTool" | "sessionCountByTool">` (keep the existing `lastSessionIdByTool` usage).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test test/index-cli.test.ts` then `npm run build`
Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/index-cli.test.ts
git commit -m "feat: offer a session picker menu entry when >=2 sessions"
```

---

## Task 12: Session picker — `buildSessionChoices`, `chooseSessionForTool`, inner loop

**Files:**
- Modify: `src/index.ts` (`buildResumeArgs` consumer; `chooseToolForProject` ~`:316-339`; `runInteractive` ~`:606-645`)
- Test: `test/index-cli.test.ts`

- [ ] **Step 1: Write the failing test (pure choice builder)**

```ts
test("buildSessionChoices renders rows, caps at the limit, and notes the remainder", () => {
  const chalk = { dim: (v: string) => v };
  const sessions = Array.from({ length: 32 }, (_, i) => ({
    sessionId: `id-${i}`,
    lastSeenAt: 1_700_000_000_000 - i * 86_400_000,
    preview: i === 0 ? "newest work" : undefined,
  }));

  const choices = buildSessionChoices(sessions, chalk as never, { cap: 30, backValue: "__back__" });
  // 30 sessions + 1 truncation note + 1 back = 32 entries
  assert.equal(choices.length, 32);
  assert.equal(choices[0]?.value, "id-0");
  assert.match(choices[0]?.name ?? "", /newest work/);
  const truncation = choices.find((c) => c.disabled);
  assert.match(truncation?.name ?? "", /2 更早会话已隐藏/);
  assert.equal(choices[choices.length - 1]?.value, "__back__");
});

test("buildSessionChoices falls back to a short id when there is no preview", () => {
  const chalk = { dim: (v: string) => v };
  const choices = buildSessionChoices(
    [{ sessionId: "abcdef0123456789", lastSeenAt: 1_700_000_000_000 }],
    chalk as never,
    { cap: 30, backValue: "__back__" }
  );
  assert.match(choices[0]?.name ?? "", /abcdef01/);
});
```

Add `buildSessionChoices` to the `../src/index.js` import block.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test test/index-cli.test.ts`
Expected: FAIL — `buildSessionChoices is not a function`.

- [ ] **Step 3: Implement**

Add the pure builder and the prompt wrapper to `src/index.ts`. Add `collectClaudeSessionsForDir` and `type SessionRef` to the `./project-index.js` import.

```ts
export function buildSessionChoices(
  sessions: SessionRef[],
  chalk: { dim: (value: string) => string },
  options: { cap: number; backValue: string }
): Array<{ name: string; value: string; disabled?: boolean }> {
  const visible = sessions.slice(0, options.cap);
  const choices = visible.map((session) => {
    const date = formatDateShort(session.lastSeenAt);
    const label = session.preview ? session.preview : session.sessionId.slice(0, 8);
    return { name: `${date}  ${label}`, value: session.sessionId };
  });

  const hidden = sessions.length - visible.length;
  if (hidden > 0) {
    choices.push({ name: chalk.dim(`+${hidden} 更早会话已隐藏`), value: "__truncated__", disabled: true });
  }

  choices.push({ name: chalk.dim("← 返回"), value: options.backValue });
  return choices;
}

async function chooseSessionForTool(
  project: ProjectIndexItem,
  tool: ToolName,
  prompts: UiDependencies["prompts"],
  chalk: UiDependencies["chalk"]
): Promise<string | null> {
  const sessions =
    tool === TOOL_CODEX
      ? project.sessionsByTool.codex
      : project.claudeTranscriptDir
      ? await collectClaudeSessionsForDir(project.claudeTranscriptDir)
      : [];

  if (sessions.length === 0) {
    return null;
  }

  const choices = buildSessionChoices(sessions, chalk, { cap: 30, backValue: "__back__" });
  try {
    const selected = await prompts.select({ message: `Select a ${tool} session for ${project.name}`, pageSize: 16, choices });
    return selected === "__back__" ? null : selected;
  } catch (error) {
    if (isPromptCancelError(error)) {
      return null;
    }
    throw error;
  }
}
```

Wire `pick` into `chooseToolForProject` with an inner loop so "← 返回" redraws the tool menu instead of leaving to the project list:

```ts
export async function chooseToolForProject(
  project: ProjectIndexItem,
  recommendedTool: ToolName,
  prompts: UiDependencies["prompts"],
  chalk: UiDependencies["chalk"]
): Promise<ToolSelection | null> {
  const choices = buildToolMenuChoices(project, recommendedTool, chalk);

  while (true) {
    let selectedValue: string;
    try {
      selectedValue = await prompts.select({
        message: `Choose CLI for ${project.name}\nPath: ${project.path}`,
        pageSize: 10,
        choices,
      });
    } catch (error) {
      if (isPromptCancelError(error)) {
        return null;
      }
      throw error;
    }

    const selection = parseToolSelection(selectedValue);
    if (!selection) {
      return null; // __back__ / unknown -> back to project list (unchanged)
    }

    if (selection.action !== "pick") {
      return selection;
    }

    const sessionId = await chooseSessionForTool(project, selection.tool, prompts, chalk);
    if (sessionId) {
      return { tool: selection.tool, action: "pick", sessionId } as ToolSelection & { sessionId: string };
    }
    // picker returned -> redraw the tool menu (stay in this loop)
  }
}
```

Extend `ToolSelection` to optionally carry the picked id:

```ts
interface ToolSelection {
  tool: ToolName;
  action: "resume" | "new" | "pick";
  sessionId?: string;
}
```

In `runInteractive`, fold `pick` into the resume branch (it already shares resume args + the "Ignoring -c" message):

```ts
    let launchArgs: string[];
    if (action === "resume" || action === "pick") {
      const sessionId = action === "pick" ? selection.sessionId ?? "" : project.lastSessionIdByTool[tool] || "";
      launchArgs = buildResumeArgs(tool, sessionId);
      if (options.commandPrompt) {
        console.log(chalk.dim("Ignoring -c content when resuming a session."));
      }
    } else {
      launchArgs = buildLaunchArgs(tool, options.commandPrompt);
    }
```

> Destructure `selection` (not just `tool, action`) where `sessionId` is read, e.g. keep `const { tool, action } = selection;` and reference `selection.sessionId`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test test/index-cli.test.ts` then `npm run build`
Expected: PASS; build clean.

- [ ] **Step 5: Manual smoke (optional but recommended)**

In a real project that has ≥2 Claude sessions: run `ago -n <name>`, choose the tool, pick "选择历史会话…", confirm the list shows dated previews, choose "← 返回" and confirm it returns to the tool menu (not the project list).

- [ ] **Step 6: Commit**

```bash
git add src/index.ts test/index-cli.test.ts
git commit -m "feat: add historical session picker with back-to-tool-menu navigation"
```

---

## Task 13: Doctor — `state.pinnedCount` + `state.pinned_paths_exist`

**Files:**
- Modify: `src/doctor.ts` (`DoctorReport.state` ~`:113-117`, state checks ~`:208-233`, summary build ~`:329`)
- Test: `test/doctor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("buildDoctorReport reports pinnedCount and warns on a missing pinned path, exit stays 0", async () => {
  await withTempDir(async (tempDir) => {
    const agoDir = path.join(tempDir, ".ago");
    await fs.mkdir(agoDir, { recursive: true });
    const missing = path.join(tempDir, "gone-pin");
    await fs.writeFile(
      path.join(agoDir, "state.json"),
      JSON.stringify({ lastLaunchedByPath: {}, pinnedPaths: [missing] }),
      "utf8"
    );

    const report = await buildDoctorReport(baseInput(tempDir));
    assert.equal(report.state.pinnedCount, 1);
    const check = report.checks.find((c) => c.id === "state.pinned_paths_exist");
    assert.equal(check?.status, "warning");
    assert.deepEqual(check?.details?.missingPinned, [missing]);
    assert.equal(report.status, "warning");
    assert.equal(report.errorCount, 0); // warning must not flip the exit code
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/doctor.test.ts`
Expected: FAIL — `report.state.pinnedCount` is undefined; no such check.

- [ ] **Step 3: Implement**

In `src/doctor.ts`, extend the `state` shape in `DoctorReport`:

```ts
  state: {
    exists: boolean;
    validJson: boolean;
    lastLaunchPathExists: boolean;
    pinnedCount: number;
  };
```

Extend the default `stateSummary` initializer:

```ts
  let stateSummary: DoctorReport["state"] = { exists: false, validJson: true, lastLaunchPathExists: false, pinnedCount: 0 };
```

In the `// state` section, after `stateInspection` is computed, set the count and add the check. `inspectState(...).value.pinnedPaths` is populated (Task 1):

```ts
    const pinnedPaths = stateInspection.value.pinnedPaths;
    stateSummary = {
      exists: stateInspection.exists,
      validJson: stateInspection.validJson,
      lastLaunchPathExists: stateInspection.lastLaunchPathExists,
      pinnedCount: pinnedPaths.length,
    };
```

```ts
    const missingPinned = pinnedPaths.filter((pinnedPath) => !fs.existsSync(pinnedPath));
    checks.push(
      missingPinned.length > 0
        ? { id: "state.pinned_paths_exist", category: "state", status: "warning", message: `${missingPinned.length} pinned path(s) no longer exist`, details: { missingPinned } }
        : { id: "state.pinned_paths_exist", category: "state", status: "ok", message: "All pinned paths exist (or none pinned)" }
    );
```

> `state.pinned_paths_exist` is warning-only, so `errorCount` is unaffected and `index.ts` keeps exit 0. `FORMAT_VERSION` stays `"1.0"` (additive field). The catch-fallback `stateSummary` default already includes `pinnedCount: 0`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/doctor.test.ts` then `npm run build`
Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add src/doctor.ts test/doctor.test.ts
git commit -m "feat: surface pinnedCount and warn on missing pins in doctor"
```

---

## Task 14: Docs + full verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README**

Under **Features**, add bullets:

```markdown
- Pin frequently-used projects with `ago pin [name]` / `ago unpin [name]`; pinned projects sort to the top with a `★` marker.
- For tools with multiple recorded sessions, the CLI menu offers "选择历史会话…" to pick and resume a specific past session.
```

Under **Diagnostics → `ago doctor`**, add a sentence:

```markdown
The `state` block also reports `pinnedCount`, and a `state.pinned_paths_exist` check warns (without failing) when a pinned path no longer exists.
```

Add a **Pinning** subsection after **Usage → Examples**:

```markdown
### Pinning

```bash
# Pin the current directory
ago pin

# Pin by directory path or unique project name
ago pin ~/git/my-app
ago pin my-app

# Remove a pin (matches the pinned path, even if it no longer exists on disk)
ago unpin my-app
```

Pins are stored in `~/.ago/state.json` under `pinnedPaths`. `config.json` stays hand-edited and is never written by `ago`.
```

- [ ] **Step 2: Run the full verification suite**

Run:
```bash
npm test
npm run build
node --import tsx src/cli.ts doctor | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>JSON.parse(s)&&console.log("doctor JSON ok"))'
node --import tsx src/cli.ts pin --help
```
Expected: all tests pass; build clean; `doctor JSON ok`; `pin --help` prints usage with `[name]`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document ago pin/unpin and the session picker"
```

---

## Self-Review (completed during planning)

**Spec coverage** — every spec section maps to a task:
- §2.4 state `pinnedPaths` trap → Task 1. §2 helpers → Task 2.
- §2 `SessionRef`/`sessionsByTool.codex`/`sessionCountByTool`/`pinned:false` → Task 3. §2.3 `sortWithPins` → Task 4.
- §2.2 `claudeTranscriptDir` + claude count → Task 5. §1.1/§4.2 lazy Claude scan + preview → Task 6.
- §3.1 `resolvePinTarget` four branches → Task 7. §3.1–§3.3 `pin`/`unpin` commands → Task 8.
- §3.4/§3.5 `★` + `sortWithPins` integration + default `exists` filter → Task 9.
- §4.1 `ToolSelection {action}`/`parseToolSelection pick` → Task 10. §4.1 menu entry gate → Task 11.
- §4.2/§4.3/§4.4 picker + back-to-tool-menu + resume reuse → Task 12.
- §5 doctor `pinnedCount` + `state.pinned_paths_exist` (warning, exit 0, formatVersion 1.0) → Task 13.
- §7 docs → Task 14.

**Out-of-scope (spec §9) confirmed absent:** no Codex preview, no full-text search, no `prune`, no hotkey toggle, no `config set`, no extra CLIs, no index cache.

**Placeholder scan:** no TBD/TODO; every code step shows concrete code; every test step shows full test code and the expected fail/pass.

**Type consistency:** `SessionRef` shape, `ProjectIndexItem` new fields, `AgoState.pinnedPaths`, `ToolSelection {tool, action, sessionId?}`, `PinTarget` union, `ClaudeDirInfo` are used identically across Tasks 1–13. `buildSessionChoices`/`collectClaudeSessionsForDir`/`sortWithPins`/`resolvePinTarget` names match between definition and call sites.

**Known test-literal updates folded into tasks (not silent breakage):** `inspectState` defaults test (Task 1), `parseToolSelection` test (Task 10), `buildToolMenuChoices` test literal (Task 11).
