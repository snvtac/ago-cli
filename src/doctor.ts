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
