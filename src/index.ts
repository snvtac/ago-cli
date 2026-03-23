import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Command } from "commander";
import {
  DEFAULT_CONFIG,
  TOOL_CLAUDE,
  TOOL_CODEX,
  buildProjectIndex,
  getDefaultConfigPath,
  getDefaultStatePath,
  loadConfig,
  loadState,
  saveState,
  type AgoConfig,
  type AgoState,
  type ProjectIndexItem,
} from "./project-index.js";

type ToolName = typeof TOOL_CODEX | typeof TOOL_CLAUDE;

interface CliOptions {
  all?: boolean;
  name?: string;
  command?: string;
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

function buildProjectChoice(
  project: ProjectIndexItem,
  chalk: UiDependencies["chalk"],
  columnWidths: ReturnType<typeof getColumnWidths>,
  options: { showStatus: boolean }
): ProjectChoice {
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
      ? `${nameText}  ${dateLabel}  ${sourceLabel}  ${existsLabel}`
      : `${nameText}  ${dateLabel}  ${sourceLabel}`,
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

export async function chooseToolForProject(
  project: ProjectIndexItem,
  recommendedTool: ToolName,
  prompts: UiDependencies["prompts"],
  chalk: UiDependencies["chalk"]
): Promise<ToolName | null> {
  const preferredTool = recommendedTool === TOOL_CLAUDE ? TOOL_CLAUDE : TOOL_CODEX;
  const fallbackTool = preferredTool === TOOL_CODEX ? TOOL_CLAUDE : TOOL_CODEX;

  const choices = [
    {
      name: `${preferredTool} ${chalk.dim("(recommended)")}`,
      value: preferredTool,
    },
    {
      name: fallbackTool,
      value: fallbackTool,
    },
    {
      name: chalk.dim("Back to project list"),
      value: "__back__",
    },
  ];

  try {
    const selectedTool = await prompts.select({
      message: `Choose CLI for ${project.name}\nPath: ${project.path}`,
      pageSize: 10,
      choices,
    });

    if (selectedTool === "__back__") {
      return null;
    }

    return selectedTool as ToolName;
  } catch (error) {
    if (isPromptCancelError(error)) {
      return null;
    }

    throw error;
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
  return argv.map((arg) => (arg === "-al" ? "--all" : arg));
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

export async function runInteractive(options: RunInteractiveOptions): Promise<void> {
  const { prompts, chalk } = await loadUiDependencies();

  const configPath = getDefaultConfigPath();
  const statePath = getDefaultStatePath();

  const config = await loadConfig(configPath);
  const state = await loadState(statePath);

  const allProjects = await buildProjectIndex({ config, homeDir: os.homedir() });
  const projects = options.showAll ? allProjects : allProjects.filter((project) => project.exists);
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
    const selectedTool = await chooseToolForProject(project, recommendedTool, prompts, chalk);
    if (!selectedTool) {
      if (singleMatchFlow) {
        return;
      }
      continue;
    }

    const command = resolveCommand(selectedTool, config);

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

    state.lastLaunchedByPath[project.path] = selectedTool;
    await saveState(state, statePath);

    console.log(chalk.dim(`Launching ${selectedTool} in ${project.path}`));

    const result = await spawnInteractiveCommand(command, buildLaunchArgs(selectedTool, options.commandPrompt), project.path);

    if (typeof result.code === "number" && result.code !== 0) {
      console.error(chalk.yellow(`${command} exited with code ${result.code}.`));
    }

    if (result.signal) {
      console.error(chalk.yellow(`${command} was terminated by signal ${result.signal}.`));
    }

    return;
  }
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const program = new Command();

  program
    .name("ago")
    .description("Open projects from Codex and Claude history")
    .option("-a, --all", "Show all records (including missing projects)")
    .option("-n, --name <name>", "Fuzzy-match projects by name/path")
    .option("-c, --command <content>", "Launch selected CLI with initial content")
    .allowExcessArguments(false)
    .showHelpAfterError();

  program.action(async (options: CliOptions) => {
    await runInteractive({
      showAll: Boolean(options.all),
      nameQuery: normalizeQuery(options.name || ""),
      commandPrompt: parseCommandPromptOption(options.command),
    });
  });

  await program.parseAsync(normalizeArgv(argv));
}
