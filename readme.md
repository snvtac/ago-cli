# ago-cli

`ago-cli` is an interactive launcher for projects used in Codex and Claude.
It reads local history, shows a project picker, then opens the selected project with `codex` or `claude`.

## Features

- Read project history from both Codex and Claude local data.
- Merge duplicated paths across platforms (`codex`, `claude`, `codex/claude`).
- Fast fuzzy filtering with `-n <name>`.
- Default mode only shows existing projects.
- `-al` mode shows all records, including missing paths.
- After selecting a project, always enter CLI choice (`codex` / `claude`) and show the project path.
- Recommended CLI logic:
  - If both CLIs were used, recommend the most recently used one.
  - If only one CLI was used, recommend that one.

## Tech Stack

- Language: TypeScript
- Runtime: Node.js (>=18)
- Build output: `dist/` (compiled JavaScript)

## Install

```bash
npm install
npm link
```

After linking, run with:

```bash
ago
```

## Usage

```bash
ago [options]
```

### Options

- `-a, --all`: show all records (including missing paths).
- `-al`: alias of `--all`.
- `-n, --name <name>`: fuzzy match by project name/path/platform text.

### Examples

```bash
# Only existing projects (default)
ago

# All records, include missing paths
ago -al

# Fuzzy match in existing projects
ago -n demo

# Fuzzy match in all records
ago -al -n demo
```

## Interactive Behavior

### Project list columns

- Default (`ago`): `Name | Date | Platform`
- All mode (`ago -al`): `Name | Date | Platform | Status`

Date format is `YY/MM/DD`.

### Name matching behavior

- If `-n` matches exactly 1 project, skip project list and go directly to CLI selection.
- If `-n` matches multiple projects, show filtered project list and let user pick one.
- If no match, print a message and exit.

### CLI selection behavior

- Always shown after a project is resolved.
- Choices are fixed: `codex` and `claude`.
- Shows selected project path in the prompt.
- Includes a `Back to project list` option.

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
  - `readme.md`
  - `LICENSE`
