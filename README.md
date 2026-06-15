# ago-cli

`ago-cli` is an interactive launcher for projects used in Codex and Claude.
It reads local history, resolves a project, then launches `codex` or `claude` in that project directory. With `-c`, it passes initial content directly to the selected CLI.

## Features

- Read project history from both Codex and Claude local data.
- Merge duplicated paths across platforms (`codex`, `claude`, `codex/claude`).
- Fast fuzzy filtering with `-n <name>`.
- Default mode only shows existing projects.
- `-al` mode shows all records, including missing paths.
- After resolving a project, choose `codex` or `claude`, and optionally start it with initial content via `-c`.
- Recommended CLI logic:
  - If both CLIs were used, recommend the most recently used one.
  - If only one CLI was used, recommend that one.
- Projects are ranked by frecency (frequency × recency), so daily projects stay on top.
- `ago -` (or `ago --last`) instantly reopens the last launched project + CLI.
- For tools with a recorded session, the CLI menu offers "continue last session" (resumes the exact session id).
- Pin frequently-used projects with `ago pin [name]` / `ago unpin [name]`; pinned projects sort to the top with a `★` marker.
- For tools with multiple recorded sessions, the CLI menu offers "选择历史会话…" to pick and resume a specific past session.

## Tech Stack

- Language: TypeScript
- Runtime: Node.js (>=18)
- Build output: `dist/` (compiled JavaScript)

## Install

Global install (recommended):

```bash
npm i -g ago-cli
```

Run:

```bash
ago
```

Without global install:

```bash
npx ago-cli
```

## Usage

```bash
ago [options]
```

### Options

- `-a, --all`: show all records (including missing paths).
- `-al`: alias of `--all`.
- `-n, --name <name>`: fuzzy match by project name/path/platform text.
- `-c, --command <content>`: launch the selected CLI with initial content.
- `-l, --last`: reopen the last launched project + CLI (alias: bare `ago -`).

### Examples

```bash
# Only existing projects (default)
ago

# All records, include missing paths
ago -al

# Fuzzy match in existing projects
ago -n project

# Fuzzy match in all records
ago -al -n project

# Open the matched project and start codex/claude with initial content
ago -n project_name -c "请帮我查询这个 repo"
```

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

## Interactive Behavior

### Project list columns

- Default (`ago`): `Name | Date | Platform`
- All mode (`ago -al`): `Name | Date | Platform | Status`

Date format is `YY/MM/DD`.

### Name matching behavior

- If `-n` matches exactly 1 project, skip project list and go directly to CLI selection.
- If `-n` matches multiple projects, show the filtered project list, let user pick one, then continue to CLI selection.
- If no match, print a message and exit.

### CLI selection behavior

- Always shown after a project is resolved.
- Choices are fixed: `codex` and `claude`.
- Shows selected project path in the prompt.
- Includes a `Back to project list` option.
- When `-c` is provided, `ago` launches either `codex "<content>"` or `claude "<content>"` in the selected project directory.

## Data Sources

- Codex: `~/.codex/sessions/**/*.jsonl`
  - Reads first line (`session_meta`) and extracts `payload.cwd` plus timestamp.
- Claude (in priority order, deduplicated by session id):
  - `~/.claude/history.jsonl` — entries provide `project`, `timestamp`, `sessionId`.
  - `~/.claude/projects/<encoded-path>/<session-uuid>.jsonl` — the newest transcript per project dir supplies the true `cwd` (paths are never decoded from the directory name).
  - `~/.claude/projects/*/sessions-index.json` — legacy fallback for older Claude versions.

## Config and State

### Config file

`~/.ago/config.json`

```json
{
  "roots": [],
  "claudeCommand": "claude",
  "preferredTool": "auto"
}
```

- `roots`: optional filter roots.
- `claudeCommand`: command name used for Claude launcher.
- `preferredTool`: fallback preference when history is unavailable (`auto`, `codex`, `claude`).

### State file

`~/.ago/state.json`

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

`lastLaunch` records the most recent launch and powers `ago -` / `ago --last`.

This stores the last CLI used per project path.

## Diagnostics

### `ago doctor`

Prints a machine-readable JSON health report (runtime, config, state, commands, history sources, project index) to stdout. Read-only — it never writes config/state. Exit code is non-zero only when at least one check is an `error`; warnings keep it `0`.

```bash
ago doctor
```

Top-level fields include `formatVersion`, `status` (`ok`/`warning`/`error`), `errorCount`, `warningCount`, `paths` (absolute), and a `checks[]` array of `{ id, category, status, message, details? }`.

The `state` block also reports `pinnedCount`, and a `state.pinned_paths_exist` check warns (without failing) when a pinned path no longer exists.

### `ago config show`

Prints the normalized config plus the `source` (`file` or `default`) of each key.

```bash
ago config show
```

If `~/.ago/config.json` is missing, it returns defaults and exits `0`. If the file exists but is not valid JSON, it returns an error payload with `validJson: false` and exits non-zero.

## Notes

- `ago list` is removed and intentionally unsupported.
- `ago doctor` and `ago config show` are read-only and output JSON only (no `--fix`, no text mode in v1).
- In default mode, missing paths are not shown.
- In `-al` mode, missing paths are shown and marked as `missing`.

## Development

```bash
npm test
npm run build
```

## Publish Strategy

- Only build artifacts are published.
- Package publish files are restricted to:
  - `dist/`
  - `README.md`
  - `LICENSE`
