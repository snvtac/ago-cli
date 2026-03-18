import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const TOOL_CODEX = "codex" as const;
export const TOOL_CLAUDE = "claude" as const;

type ToolName = typeof TOOL_CODEX | typeof TOOL_CLAUDE;

type PreferredTool = ToolName | "auto";

type RawJson = Record<string, unknown>;

export interface AgoConfig {
  roots: string[];
  claudeCommand: string;
  preferredTool: PreferredTool;
}

export interface AgoState {
  lastLaunchedByPath: Record<string, ToolName>;
}

export interface ProjectObservation {
  path: string;
  tool: ToolName;
  lastSeenAt: number;
}

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
}

export const DEFAULT_CONFIG: Readonly<AgoConfig> = Object.freeze({
  roots: [],
  claudeCommand: "claude",
  preferredTool: "auto",
});

export const DEFAULT_STATE: Readonly<AgoState> = Object.freeze({
  lastLaunchedByPath: {},
});

function getAgoDir(homeDir = os.homedir()): string {
  return path.join(homeDir, ".ago");
}

export function getDefaultConfigPath(homeDir = os.homedir()): string {
  return path.join(getAgoDir(homeDir), "config.json");
}

export function getDefaultStatePath(homeDir = os.homedir()): string {
  return path.join(getAgoDir(homeDir), "state.json");
}

function expandHome(inputPath: unknown, homeDir = os.homedir()): string {
  if (typeof inputPath !== "string") {
    return "";
  }

  if (inputPath === "~") {
    return homeDir;
  }

  if (inputPath.startsWith("~/")) {
    return path.join(homeDir, inputPath.slice(2));
  }

  return inputPath;
}

function normalizeProjectPath(inputPath: unknown): string {
  if (typeof inputPath !== "string") {
    return "";
  }

  const trimmed = inputPath.trim();
  if (!trimmed) {
    return "";
  }

  return path.resolve(trimmed);
}

export function toEpochMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return 0;
}

async function readFirstLine(filePath: string): Promise<string> {
  return new Promise((resolve) => {
    let resolved = false;
    let buffer = "";

    const finish = (line: string): void => {
      if (resolved) {
        return;
      }

      resolved = true;
      resolve(line);
    };

    const stream = fs.createReadStream(filePath, {
      encoding: "utf8",
      highWaterMark: 64 * 1024,
    });

    stream.on("error", () => finish(""));

    stream.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");

      if (newlineIndex === -1) {
        return;
      }

      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      finish(line);
      stream.destroy();
    });

    stream.on("end", () => {
      finish(buffer.replace(/\r$/, ""));
    });
  });
}

async function listFilesRecursive(
  rootDir: string,
  filePredicate: (fullPath: string, name: string) => boolean
): Promise<string[]> {
  const files: string[] = [];
  const stack: string[] = [rootDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) {
      continue;
    }

    let entries: fs.Dirent[] = [];

    try {
      entries = await fsp.readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && filePredicate(fullPath, entry.name)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

export async function parseCodexSessionFile(filePath: string): Promise<ProjectObservation | null> {
  const firstLine = await readFirstLine(filePath);
  if (!firstLine) {
    return null;
  }

  let json: RawJson;
  try {
    json = JSON.parse(firstLine) as RawJson;
  } catch {
    return null;
  }

  const payload = (json.payload as RawJson | undefined) ?? {};
  const cwd = normalizeProjectPath(payload.cwd);
  if (!cwd) {
    return null;
  }

  let lastSeenAt = toEpochMs(json.timestamp) || toEpochMs(payload.timestamp);

  if (!lastSeenAt) {
    try {
      const stat = await fsp.stat(filePath);
      lastSeenAt = stat.mtimeMs;
    } catch {
      lastSeenAt = 0;
    }
  }

  return {
    path: cwd,
    tool: TOOL_CODEX,
    lastSeenAt,
  };
}

export async function collectCodexObservations(homeDir = os.homedir()): Promise<ProjectObservation[]> {
  const sessionsDir = path.join(homeDir, ".codex", "sessions");

  if (!fs.existsSync(sessionsDir)) {
    return [];
  }

  const files = await listFilesRecursive(sessionsDir, (_fullPath, name) => name.endsWith(".jsonl"));
  const observations: ProjectObservation[] = [];

  for (const filePath of files) {
    const parsed = await parseCodexSessionFile(filePath);
    if (parsed) {
      observations.push(parsed);
    }
  }

  return observations;
}

export function parseClaudeEntry(entry: RawJson | undefined, fallbackLastSeenAt: number): ProjectObservation | null {
  const projectPath = normalizeProjectPath(entry?.projectPath);
  if (!projectPath) {
    return null;
  }

  const lastSeenAt =
    toEpochMs(entry?.modified) || toEpochMs(entry?.fileMtime) || toEpochMs(entry?.created) || fallbackLastSeenAt;

  return {
    path: projectPath,
    tool: TOOL_CLAUDE,
    lastSeenAt,
  };
}

export async function parseClaudeSessionsIndexFile(filePath: string): Promise<ProjectObservation[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch {
    return [];
  }

  let json: RawJson;
  try {
    json = JSON.parse(raw) as RawJson;
  } catch {
    return [];
  }

  let fallbackLastSeenAt = 0;
  try {
    const stat = await fsp.stat(filePath);
    fallbackLastSeenAt = stat.mtimeMs;
  } catch {
    fallbackLastSeenAt = 0;
  }

  const observations: ProjectObservation[] = [];
  const entries = Array.isArray(json.entries) ? (json.entries as RawJson[]) : [];

  for (const entry of entries) {
    const parsed = parseClaudeEntry(entry, fallbackLastSeenAt);
    if (parsed) {
      observations.push(parsed);
    }
  }

  if (observations.length === 0) {
    const originalPath = normalizeProjectPath(json.originalPath);
    if (originalPath) {
      observations.push({
        path: originalPath,
        tool: TOOL_CLAUDE,
        lastSeenAt: fallbackLastSeenAt,
      });
    }
  }

  return observations;
}

export async function collectClaudeObservations(homeDir = os.homedir()): Promise<ProjectObservation[]> {
  const projectsDir = path.join(homeDir, ".claude", "projects");

  if (!fs.existsSync(projectsDir)) {
    return [];
  }

  let entries: fs.Dirent[] = [];
  try {
    entries = await fsp.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const observations: ProjectObservation[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const indexPath = path.join(projectsDir, entry.name, "sessions-index.json");
    if (!fs.existsSync(indexPath)) {
      continue;
    }

    const parsedList = await parseClaudeSessionsIndexFile(indexPath);
    observations.push(...parsedList);
  }

  return observations;
}

interface MergedMapItem {
  path: string;
  name: string;
  sources: Set<ToolName>;
  lastSeenAtByTool: Partial<Record<ToolName, number>>;
}

export function mergeProjectObservations(observations: ProjectObservation[]): ProjectIndexItem[] {
  const map = new Map<string, MergedMapItem>();

  for (const observation of observations) {
    const normalizedPath = normalizeProjectPath(observation?.path);
    const tool = observation?.tool;

    if (!normalizedPath || (tool !== TOOL_CODEX && tool !== TOOL_CLAUDE)) {
      continue;
    }

    const lastSeenAt = Math.max(0, toEpochMs(observation?.lastSeenAt));
    const existing = map.get(normalizedPath);

    if (!existing) {
      map.set(normalizedPath, {
        path: normalizedPath,
        name: path.basename(normalizedPath) || normalizedPath,
        sources: new Set([tool]),
        lastSeenAtByTool: {
          [tool]: lastSeenAt,
        },
      });
      continue;
    }

    existing.sources.add(tool);
    const previousLastSeenAt = existing.lastSeenAtByTool[tool] || 0;
    if (lastSeenAt > previousLastSeenAt) {
      existing.lastSeenAtByTool[tool] = lastSeenAt;
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
      };
    })
    .sort((left, right) => {
      if (right.lastSeenAt !== left.lastSeenAt) {
        return right.lastSeenAt - left.lastSeenAt;
      }

      return left.path.localeCompare(right.path);
    });
}

function isPathUnderRoot(projectPath: string, rootPath: string): boolean {
  if (!projectPath || !rootPath) {
    return false;
  }

  const relative = path.relative(rootPath, projectPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function filterProjectsByRoots(projects: ProjectIndexItem[], roots: string[], homeDir = os.homedir()): ProjectIndexItem[] {
  if (!Array.isArray(roots) || roots.length === 0) {
    return projects;
  }

  const normalizedRoots = roots
    .map((root) => normalizeProjectPath(expandHome(root, homeDir)))
    .filter(Boolean);

  if (normalizedRoots.length === 0) {
    return projects;
  }

  return projects.filter((project) => normalizedRoots.some((root) => isPathUnderRoot(project.path, root)));
}

export function normalizeConfig(rawConfig: RawJson = {}): AgoConfig {
  const roots = Array.isArray(rawConfig?.roots)
    ? (rawConfig.roots as unknown[]).filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0
      )
    : [];

  const claudeCommand =
    typeof rawConfig?.claudeCommand === "string" && rawConfig.claudeCommand.trim()
      ? rawConfig.claudeCommand.trim()
      : DEFAULT_CONFIG.claudeCommand;

  const preferredTool: PreferredTool =
    rawConfig?.preferredTool === TOOL_CODEX || rawConfig?.preferredTool === TOOL_CLAUDE
      ? (rawConfig.preferredTool as PreferredTool)
      : DEFAULT_CONFIG.preferredTool;

  return {
    roots,
    claudeCommand,
    preferredTool,
  };
}

export function normalizeState(rawState: RawJson = {}): AgoState {
  const out: AgoState = {
    lastLaunchedByPath: {},
  };

  const sourceMap = rawState?.lastLaunchedByPath;
  if (!sourceMap || typeof sourceMap !== "object" || Array.isArray(sourceMap)) {
    return out;
  }

  for (const [projectPath, tool] of Object.entries(sourceMap as Record<string, unknown>)) {
    const normalizedPath = normalizeProjectPath(projectPath);
    if (!normalizedPath) {
      continue;
    }

    if (tool === TOOL_CODEX || tool === TOOL_CLAUDE) {
      out.lastLaunchedByPath[normalizedPath] = tool;
    }
  }

  return out;
}

async function readJsonFile(filePath: string): Promise<RawJson | null> {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    return JSON.parse(raw) as RawJson;
  } catch {
    return null;
  }
}

export async function loadConfig(configPath = getDefaultConfigPath()): Promise<AgoConfig> {
  const raw = await readJsonFile(configPath);
  return normalizeConfig(raw || {});
}

export async function loadState(statePath = getDefaultStatePath()): Promise<AgoState> {
  const raw = await readJsonFile(statePath);
  return normalizeState(raw || {});
}

export async function saveState(state: AgoState, statePath = getDefaultStatePath()): Promise<void> {
  const normalizedState = normalizeState(state as unknown as RawJson);
  const dirPath = path.dirname(statePath);

  await fsp.mkdir(dirPath, { recursive: true });
  await fsp.writeFile(statePath, `${JSON.stringify(normalizedState, null, 2)}\n`, "utf8");
}

export function getMostRecentTool(project: Partial<ProjectIndexItem>): ToolName | null {
  const codexLastSeenAt = project?.lastSeenAtByTool?.codex || 0;
  const claudeLastSeenAt = project?.lastSeenAtByTool?.claude || 0;

  if (codexLastSeenAt === 0 && claudeLastSeenAt === 0) {
    return null;
  }

  if (codexLastSeenAt === claudeLastSeenAt) {
    return null;
  }

  return codexLastSeenAt > claudeLastSeenAt ? TOOL_CODEX : TOOL_CLAUDE;
}

export function pickDefaultTool(
  project: Partial<ProjectIndexItem>,
  state: AgoState = DEFAULT_STATE,
  config: AgoConfig = DEFAULT_CONFIG
): ToolName {
  if (project?.sourceLabel === TOOL_CODEX) {
    return TOOL_CODEX;
  }

  if (project?.sourceLabel === TOOL_CLAUDE) {
    return TOOL_CLAUDE;
  }

  const normalizedPath = normalizeProjectPath(project?.path);
  const toolFromState = normalizedPath ? state?.lastLaunchedByPath?.[normalizedPath] : null;

  if (toolFromState === TOOL_CODEX || toolFromState === TOOL_CLAUDE) {
    return toolFromState;
  }

  const toolFromHistory = getMostRecentTool(project);
  if (toolFromHistory) {
    return toolFromHistory;
  }

  if (config?.preferredTool === TOOL_CODEX || config?.preferredTool === TOOL_CLAUDE) {
    return config.preferredTool;
  }

  return TOOL_CODEX;
}

export async function buildProjectIndex({
  config = DEFAULT_CONFIG,
  homeDir = os.homedir(),
}: {
  config?: AgoConfig;
  homeDir?: string;
} = {}): Promise<ProjectIndexItem[]> {
  const normalizedConfig = normalizeConfig(config as unknown as RawJson);

  const [codexObservations, claudeObservations] = await Promise.all([
    collectCodexObservations(homeDir),
    collectClaudeObservations(homeDir),
  ]);

  const merged = mergeProjectObservations([...codexObservations, ...claudeObservations]);
  return filterProjectsByRoots(merged, normalizedConfig.roots, homeDir);
}
