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
- Claude: `~/.claude/projects/*/sessions-index.json`
  - Extracts `entries[].projectPath` plus `modified` / `fileMtime`.

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
  }
}
```

This stores the last CLI used per project path.

## Notes

- `ago list` is removed and intentionally unsupported.
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
