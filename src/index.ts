import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Command } from "commander";
import {
  DEFAULT_CONFIG,
  TOOL_CLAUDE,
  TOOL_CODEX,
  addPinnedPath,
  buildProjectIndex,
  collectClaudeSessionsForDir,
  getDefaultConfigPath,
  getDefaultStatePath,
  loadConfig,
  loadState,
  removePinnedPath,
  resolveConfiguredRoot,
  saveState,
  sortWithPins,
  type AgoConfig,
  type AgoState,
  type ProjectIndexItem,
  type SessionRef,
} from "./project-index.js";
import { buildConfigShowReport, buildDoctorReport } from "./doctor.js";

type ToolName = typeof TOOL_CODEX | typeof TOOL_CLAUDE;

interface CliOptions {
  all?: boolean;
  name?: string;
  command?: string;
  last?: boolean;
}

interface RunInteractiveOptions {
  showAll: boolean;
  nameQuery: string;
  commandPrompt: string;
}

interface ProjectChoice {
  name: string;
  value: string;
  project: ProjectIndexItem;
  disabled?: boolean;
}

interface ToolSelection {
  tool: ToolName;
  action: "resume" | "new" | "pick";
  sessionId?: string;
}

interface UiDependencies {
  prompts: {
    search?: (options: unknown) => Promise<string>;
    select: (options: unknown) => Promise<string>;
  };
  chalk: {
    dim: (value: string) => string;
    cyan: (value: string) => string;
    blue: (value: string) => string;
    magenta: (value: string) => string;
    green: (value: string) => string;
    red: (value: string) => string;
    yellow: (value: string) => string;
  };
}

function createNoColor(): UiDependencies["chalk"] {
  const passthrough = (value: string): string => String(value);
  return {
    dim: passthrough,
    cyan: passthrough,
    blue: passthrough,
    magenta: passthrough,
    green: passthrough,
    red: passthrough,
    yellow: passthrough,
  };
}

async function loadUiDependencies(): Promise<UiDependencies> {
  let prompts;
  try {
    prompts = await import("@inquirer/prompts");
  } catch {
    throw new Error("Missing dependency '@inquirer/prompts'. Run: npm install");
  }

  let chalk: UiDependencies["chalk"] = createNoColor();
  try {
    const chalkModule = await import("chalk");
    chalk = (chalkModule.default as unknown as UiDependencies["chalk"]) || chalk;
  } catch {
    chalk = createNoColor();
  }

  return { prompts: prompts as UiDependencies["prompts"], chalk: chalk as UiDependencies["chalk"] };
}

function formatDateShort(timestampMs: number): string {
  if (!timestampMs) {
    return "-";
  }

  try {
    const date = new Date(timestampMs);
    if (Number.isNaN(date.getTime())) {
      return "-";
    }

    const year = String(date.getFullYear()).slice(-2);
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}/${month}/${day}`;
  } catch {
    return "-";
  }
}

function toPlatformLabel(sourceLabel: ProjectIndexItem["sourceLabel"]): string {
  if (sourceLabel === "both") {
    return "codex/claude";
  }

  if (sourceLabel === TOOL_CLAUDE) {
    return "claude";
  }

  return "codex";
}

function formatSourceLabel(sourceLabel: string, chalk: UiDependencies["chalk"]): string {
  const label = sourceLabel === "codex/claude" || sourceLabel === "claude" ? sourceLabel : "codex";

  if (label === "codex/claude") {
    return chalk.cyan(label);
  }

  if (label === TOOL_CLAUDE) {
    return chalk.blue(label);
  }

  return chalk.magenta(label);
}

function formatExistsLabel(exists: boolean, chalk: UiDependencies["chalk"], textLabel: string): string {
  return exists ? chalk.green(textLabel) : chalk.red(textLabel);
}

function fitText(value: unknown, width: number): string {
  const text = String(value || "");

  if (text.length <= width) {
    return text.padEnd(width, " ");
  }

  if (width <= 3) {
    return text.slice(0, width);
  }

  return `${text.slice(0, width - 3)}...`;
}

function colorizeCell(value: string, width: number, colorize: (value: string) => string): string {
  const cell = fitText(value, width);
  const token = cell.trimEnd();
  const trailingSpaces = " ".repeat(cell.length - token.length);

  if (!token) {
    return trailingSpaces;
  }

  return `${colorize(token)}${trailingSpaces}`;
}

function getColumnWidths(projects: ProjectIndexItem[]) {
  const maxNameLength = projects.reduce((max, project) => {
    return Math.max(max, String(project?.name || "").length);
  }, 0);

  return {
    name: Math.min(36, Math.max(16, maxNameLength)),
    date: 8,
    platform: 12,
    status: 7,
  };
}

function pinMarkerCell(pinned: boolean, chalk: UiDependencies["chalk"]): string {
  return pinned ? `${chalk.yellow("★")} ` : "  ";
}

export function buildProjectChoice(
  project: ProjectIndexItem,
  chalk: UiDependencies["chalk"],
  columnWidths: ReturnType<typeof getColumnWidths>,
  options: { showStatus: boolean }
): ProjectChoice {
  const marker = pinMarkerCell(project.pinned, chalk);
  const nameText = fitText(project.name, columnWidths.name);
  const dateLabel = colorizeCell(formatDateShort(project.lastSeenAt), columnWidths.date, (value) => chalk.dim(value));
  const sourceLabel = colorizeCell(toPlatformLabel(project.sourceLabel), columnWidths.platform, (value) =>
    formatSourceLabel(value, chalk)
  );
  const existsLabel = colorizeCell(project.exists ? "exists" : "missing", columnWidths.status, (value) =>
    formatExistsLabel(project.exists, chalk, value)
  );

  return {
    name: options.showStatus
      ? `${marker}${nameText}  ${dateLabel}  ${sourceLabel}  ${existsLabel}`
      : `${marker}${nameText}  ${dateLabel}  ${sourceLabel}`,
    value: project.path,
    project,
  };
}

function normalizeQuery(input: unknown): string {
  if (typeof input !== "string") {
    return "";
  }

  return input.trim().toLowerCase();
}

function projectMatchesQuery(project: ProjectIndexItem, normalizedQuery: string): boolean {
  if (!normalizedQuery) {
    return true;
  }

  const haystack = `${project?.name || ""}\n${project?.path || ""}\n${project?.sourceLabel || ""}`.toLowerCase();
  return haystack.includes(normalizedQuery);
}

export function filterProjectsByNameQuery(projects: ProjectIndexItem[], query: string): ProjectIndexItem[] {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) {
    return projects;
  }

  return projects.filter((project) => projectMatchesQuery(project, normalizedQuery));
}

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

export type UnpinTarget =
  | { kind: "resolved"; path: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "not_pinned"; path: string };

export function resolveUnpinTarget(input: {
  name?: string;
  cwd: string;
  pinnedPaths: string[];
  homeDir: string;
}): UnpinTarget {
  const rawName = typeof input.name === "string" ? input.name.trim() : "";

  if (!rawName) {
    return { kind: "resolved", path: path.resolve(input.cwd) };
  }

  // unpin matches the stored pinnedPaths directly so a pin whose directory is
  // gone (or rolled off the history index) is still removable.
  const asPath = resolveConfiguredRoot(rawName, input.homeDir);
  if (asPath && input.pinnedPaths.includes(asPath)) {
    return { kind: "resolved", path: asPath };
  }

  const needle = rawName.toLowerCase();
  const matches = input.pinnedPaths.filter((pinned) => pinned.toLowerCase().includes(needle));
  if (matches.length === 1) {
    return { kind: "resolved", path: matches[0]! };
  }
  if (matches.length > 1) {
    return { kind: "ambiguous", candidates: matches };
  }
  return { kind: "not_pinned", path: asPath || path.resolve(input.cwd, rawName) };
}

function filterProjectChoices(choices: ProjectChoice[], query: string): ProjectChoice[] {
  const normalizedQuery = normalizeQuery(query);

  if (!normalizedQuery) {
    return choices;
  }

  return choices.filter((choice) => projectMatchesQuery(choice.project, normalizedQuery));
}

function isPromptCancelError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  if ((error as { name?: string }).name === "ExitPromptError") {
    return true;
  }

  const message = String((error as { message?: string }).message || "").toLowerCase();
  return message.includes("prompt") && message.includes("canceled");
}

async function chooseProject(
  choices: ProjectChoice[],
  prompts: UiDependencies["prompts"],
  chalk: UiDependencies["chalk"],
  options: { showStatus: boolean }
): Promise<ProjectIndexItem | null> {
  const searchPrompt = typeof prompts.search === "function" ? prompts.search : null;
  const message = options.showStatus
    ? "Select a project (Name | Date | Platform | Status)"
    : "Select a project (Name | Date | Platform)";

  if (searchPrompt) {
    try {
      const selectedPath = await searchPrompt({
        message,
        pageSize: 16,
        source: async (input: string) => {
          const filtered = filterProjectChoices(choices, input);
          if (filtered.length === 0) {
            return [
              {
                name: chalk.dim("No project matched your query"),
                value: "__no_match__",
                disabled: true,
              },
            ] as ProjectChoice[];
          }

          return filtered;
        },
      });

      return choices.find((choice) => choice.value === selectedPath)?.project || null;
    } catch (error) {
      if (isPromptCancelError(error)) {
        return null;
      }
      throw error;
    }
  }

  try {
    const selectedPath = await prompts.select({
      message,
      pageSize: 16,
      choices,
    });

    return choices.find((choice) => choice.value === selectedPath)?.project || null;
  } catch (error) {
    if (isPromptCancelError(error)) {
      return null;
    }
    throw error;
  }
}

export function buildSessionChoices(
  sessions: SessionRef[],
  chalk: { dim: (value: string) => string },
  options: { cap: number; backValue: string }
): Array<{ name: string; value: string; disabled?: boolean }> {
  const visible = sessions.slice(0, options.cap);
  const choices: Array<{ name: string; value: string; disabled?: boolean }> = visible.map((session) => {
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
    const selected = await prompts.select({
      message: `Select a ${tool} session for ${project.name}`,
      pageSize: 16,
      choices,
    });
    return selected === "__back__" ? null : selected;
  } catch (error) {
    if (isPromptCancelError(error)) {
      return null;
    }
    throw error;
  }
}

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
      return { tool: selection.tool, action: "pick", sessionId };
    }
    // picker returned -> redraw the tool menu (stay in this loop)
  }
}

export function isCommandAvailable(commandName: string): boolean {
  if (!commandName || typeof commandName !== "string") {
    return false;
  }

  const hasPathSeparator = commandName.includes(path.sep);

  if (hasPathSeparator) {
    try {
      fs.accessSync(commandName, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  const pathValue = process.env.PATH || "";
  const pathDirs = pathValue.split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];

  for (const dirPath of pathDirs) {
    for (const extension of extensions) {
      const candidate = path.join(dirPath, `${commandName}${extension}`);

      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        continue;
      }
    }
  }

  return false;
}

export function resolveCommand(tool: ToolName, config: AgoConfig): string {
  if (tool === TOOL_CODEX) {
    return TOOL_CODEX;
  }

  if (tool === TOOL_CLAUDE) {
    return config.claudeCommand || DEFAULT_CONFIG.claudeCommand;
  }

  return "";
}

export function getRecommendedTool(project: ProjectIndexItem, state: AgoState, config: AgoConfig): ToolName {
  const fromState = state?.lastLaunchedByPath?.[project.path];
  if (fromState === TOOL_CODEX || fromState === TOOL_CLAUDE) {
    return fromState;
  }

  const codexLastSeenAt = Number(project?.lastSeenAtByTool?.codex || 0);
  const claudeLastSeenAt = Number(project?.lastSeenAtByTool?.claude || 0);

  if (codexLastSeenAt > 0 && claudeLastSeenAt > 0) {
    return codexLastSeenAt >= claudeLastSeenAt ? TOOL_CODEX : TOOL_CLAUDE;
  }

  if (codexLastSeenAt > 0) {
    return TOOL_CODEX;
  }

  if (claudeLastSeenAt > 0) {
    return TOOL_CLAUDE;
  }

  if (config?.preferredTool === TOOL_CLAUDE) {
    return TOOL_CLAUDE;
  }

  return TOOL_CODEX;
}

export function normalizeArgv(argv: string[] = process.argv): string[] {
  const mapped = argv.map((arg) => (arg === "-al" ? "--all" : arg));
  if (mapped[2] === "-") {
    mapped[2] = "--last";
  }
  return mapped;
}

export function parseCommandPromptOption(input: unknown): string {
  if (typeof input !== "string") {
    return "";
  }

  const normalized = input.trim();
  if (!normalized) {
    throw new Error("Option -c, --command requires non-empty content.");
  }

  return normalized;
}

export function buildLaunchArgs(tool: ToolName, commandPrompt: string): string[] {
  if (!commandPrompt) {
    return [];
  }

  switch (tool) {
    case TOOL_CODEX:
    case TOOL_CLAUDE:
      return [commandPrompt];
  }
}

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

export function buildToolMenuChoices(
  project: Pick<ProjectIndexItem, "lastSessionIdByTool" | "sessionCountByTool">,
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

    if ((project.sessionCountByTool?.[tool] ?? 0) >= 2) {
      choices.push({ name: `${tool} — 选择历史会话…`, value: `pick:${tool}` });
    }
  }

  choices.push({ name: chalk.dim("Back to project list"), value: "__back__" });
  return choices;
}

async function spawnInteractiveCommand(
  command: string,
  args: string[],
  cwd: string
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: process.env,
    });

    child.once("error", (error) => {
      reject(error);
    });

    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
}

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

export async function runInteractive(options: RunInteractiveOptions): Promise<void> {
  const { prompts, chalk } = await loadUiDependencies();

  const configPath = getDefaultConfigPath();
  const statePath = getDefaultStatePath();

  const config = await loadConfig(configPath);
  const state = await loadState(statePath);

  const allProjects = await buildProjectIndex({ config, homeDir: os.homedir() });
  const pinnedProjects = sortWithPins(allProjects, state.pinnedPaths);
  const projects = options.showAll ? pinnedProjects : pinnedProjects.filter((project) => project.exists);
  const matchedProjects = filterProjectsByNameQuery(projects, options.nameQuery);

  if (projects.length === 0) {
    if (options.showAll) {
      console.log("No projects found in Codex/Claude history.");
      console.log("Checked ~/.codex/sessions and ~/.claude/projects.");
    } else {
      console.log("No existing projects found in Codex/Claude history.");
      console.log("Use `ago -al` to include missing records.");
    }
    return;
  }

  if (matchedProjects.length === 0) {
    console.log(`No projects matched name query: "${options.nameQuery}"`);
    if (!options.showAll) {
      console.log("Use `ago -al -n <name>` to include missing records.");
    }
    return;
  }

  const singleMatchFlow = matchedProjects.length === 1;

  while (true) {
    const columnWidths = getColumnWidths(matchedProjects);
    const choices = matchedProjects.map((project) =>
      buildProjectChoice(project, chalk, columnWidths, { showStatus: options.showAll })
    );

    const project = singleMatchFlow
      ? matchedProjects[0]
      : await chooseProject(choices, prompts, chalk, { showStatus: options.showAll });

    if (!project) {
      return;
    }

    const recommendedTool = getRecommendedTool(project, state, config);
    const selection = await chooseToolForProject(project, recommendedTool, prompts, chalk);
    if (!selection) {
      if (singleMatchFlow) {
        return;
      }
      continue;
    }

    const { tool, action } = selection;
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
    if (action === "resume" || action === "pick") {
      const sessionId = action === "pick" ? selection.sessionId ?? "" : project.lastSessionIdByTool[tool] || "";
      launchArgs = buildResumeArgs(tool, sessionId);
      if (options.commandPrompt) {
        console.log(chalk.dim("Ignoring -c content when resuming a session."));
      }
    } else {
      launchArgs = buildLaunchArgs(tool, options.commandPrompt);
    }

    await performLaunch({ tool, command, cwd: project.path, args: launchArgs, state, statePath, chalk });
    return;
  }
}

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

async function runPinCommand(action: "pin" | "unpin", name: string | undefined, homeDir: string): Promise<void> {
  const statePath = getDefaultStatePath();
  const state = await loadState(statePath);

  if (action === "unpin") {
    const target = resolveUnpinTarget({ name, cwd: process.cwd(), pinnedPaths: state.pinnedPaths, homeDir });
    if (target.kind === "ambiguous") {
      console.error(`Ambiguous name "${name}". Pinned matches:`);
      for (const candidate of target.candidates) {
        console.error(`  ${candidate}`);
      }
      process.exitCode = 1;
      return;
    }

    const before = state.pinnedPaths.length;
    state.pinnedPaths = removePinnedPath(state.pinnedPaths, target.path);
    await saveState(state, statePath);
    if (state.pinnedPaths.length < before) {
      console.log(`Unpinned ${target.path} (${state.pinnedPaths.length} pinned)`);
    } else {
      // For a name that matched nothing, echo what the user typed rather than a cwd-joined path.
      const label = target.kind === "not_pinned" ? name ?? target.path : target.path;
      console.log(`${label} was not pinned (${state.pinnedPaths.length} pinned)`);
    }
    return;
  }

  const config = await loadConfig(getDefaultConfigPath());
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

  state.pinnedPaths = addPinnedPath(state.pinnedPaths, target.path);
  await saveState(state, statePath);
  console.log(`Pinned ${target.path} (${state.pinnedPaths.length} pinned)`);
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const program = new Command();

  program
    .name("ago")
    .description("Open projects from Codex and Claude history")
    .option("-a, --all", "Show all records (including missing projects)")
    .option("-n, --name <name>", "Fuzzy-match projects by name/path")
    .option("-c, --command <content>", "Launch selected CLI with initial content")
    .option("-l, --last", "Reopen the last launched project and CLI")
    .allowExcessArguments(false)
    .showHelpAfterError();

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

  await program.parseAsync(normalizeArgv(argv));
}
