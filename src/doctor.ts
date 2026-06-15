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
    pinnedCount: number;
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

  let configSummary: DoctorReport["config"] = {
    exists: false,
    validJson: true,
    value: { roots: [], claudeCommand: "claude", preferredTool: "auto" },
    sources: { roots: "default", claudeCommand: "default", preferredTool: "default" },
  };
  let stateSummary: DoctorReport["state"] = { exists: false, validJson: true, lastLaunchPathExists: false, pinnedCount: 0 };
  let commandsSummary: DoctorReport["commands"] = {
    codex: { available: false, command: "codex" },
    claude: { available: false, command: "claude" },
  };
  let sourcesSummary: DoctorReport["sources"] = {
    codex: { sessionsDirExists: false, observations: 0 },
    claude: { historyExists: false, projectsDirExists: false, observations: 0 },
  };
  let projectsSummary: DoctorReport["projects"] = { total: 0, existing: 0, missing: 0 };

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
    configSummary = {
      exists: configInspection.exists,
      validJson: configInspection.validJson,
      value: configInspection.value,
      sources: configInspection.sources,
    };
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
    const pinnedPaths = stateInspection.value.pinnedPaths;
    stateSummary = {
      exists: stateInspection.exists,
      validJson: stateInspection.validJson,
      lastLaunchPathExists: stateInspection.lastLaunchPathExists,
      pinnedCount: pinnedPaths.length,
    };
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
    const missingPinned = pinnedPaths.filter((pinnedPath) => !fs.existsSync(pinnedPath));
    checks.push(
      missingPinned.length > 0
        ? { id: "state.pinned_paths_exist", category: "state", status: "warning", message: `${missingPinned.length} pinned path(s) no longer exist`, details: { missingPinned } }
        : { id: "state.pinned_paths_exist", category: "state", status: "ok", message: "All pinned paths exist (or none pinned)" }
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
    commandsSummary = {
      codex: { available: codexAvailable, command: codexCommand },
      claude: { available: claudeAvailable, command: claudeCommand },
    };
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
    sourcesSummary = {
      codex: { sessionsDirExists: codexSessionsDirExists, observations: codexObservations.length },
      claude: { historyExists: claudeHistoryExists, projectsDirExists: claudeProjectsDirExists, observations: claudeObservations.length },
    };
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
    projectsSummary = { total: filtered.length, existing, missing };
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
      config: configSummary,
      state: stateSummary,
      commands: commandsSummary,
      sources: sourcesSummary,
      projects: projectsSummary,
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
      config: configSummary,
      state: stateSummary,
      commands: commandsSummary,
      sources: sourcesSummary,
      projects: projectsSummary,
      checks: allChecks,
    };
  }
}
