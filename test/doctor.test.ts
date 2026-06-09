import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { aggregateChecks, buildConfigShowReport, buildDoctorReport, parseNodeMajor, type DoctorCheck } from "../src/doctor.js";

async function withTempDir(fn: (tempDir: string) => Promise<void>): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ago-doctor-test-"));
  try {
    await fn(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("aggregateChecks reports ok when all checks pass", () => {
  const checks: DoctorCheck[] = [{ id: "a", category: "config", status: "ok", message: "ok" }];
  assert.deepEqual(aggregateChecks(checks), { status: "ok", errorCount: 0, warningCount: 0 });
});

test("aggregateChecks reports warning when a warning is present and no error", () => {
  const checks: DoctorCheck[] = [
    { id: "a", category: "config", status: "ok", message: "ok" },
    { id: "b", category: "state", status: "warning", message: "warn" },
  ];
  assert.deepEqual(aggregateChecks(checks), { status: "warning", errorCount: 0, warningCount: 1 });
});

test("aggregateChecks reports error when any error is present", () => {
  const checks: DoctorCheck[] = [
    { id: "a", category: "config", status: "warning", message: "warn" },
    { id: "b", category: "config", status: "error", message: "err" },
  ];
  assert.deepEqual(aggregateChecks(checks), { status: "error", errorCount: 1, warningCount: 1 });
});

test("parseNodeMajor extracts the major version", () => {
  assert.equal(parseNodeMajor("v22.22.2"), 22);
  assert.equal(parseNodeMajor("18.0.0"), 18);
  assert.equal(parseNodeMajor("garbage"), 0);
});

test("buildConfigShowReport on missing config returns defaults with formatVersion", async () => {
  await withTempDir(async (tempDir) => {
    const configPath = path.join(tempDir, "config.json");
    const report = await buildConfigShowReport(configPath);
    assert.equal(report.formatVersion, "1.0");
    assert.equal(report.exists, false);
    assert.equal(report.validJson, true);
    assert.equal(report.error, undefined);
    assert.deepEqual(report.sources, { roots: "default", claudeCommand: "default", preferredTool: "default" });
  });
});

test("buildConfigShowReport on invalid JSON sets validJson false and carries error", async () => {
  await withTempDir(async (tempDir) => {
    const configPath = path.join(tempDir, "config.json");
    await fs.writeFile(configPath, "{bad}", "utf8");
    const report = await buildConfigShowReport(configPath);
    assert.equal(report.validJson, false);
    assert.equal(typeof report.error, "string");
  });
});

const baseInput = (tempDir: string) => ({
  homeDir: tempDir,
  now: 1_700_000_000_000,
  version: "0.1.0",
  nodeVersion: "v22.22.2",
  platform: "linux",
  minNodeMajor: 18,
  isCommandAvailable: () => true,
});

test("buildDoctorReport on empty home is warning, not error, and parseable", async () => {
  await withTempDir(async (tempDir) => {
    const report = await buildDoctorReport(baseInput(tempDir));
    assert.equal(report.formatVersion, "1.0");
    assert.equal(report.status, "warning");
    assert.equal(report.errorCount, 0);
    assert.equal(report.checkedAt, new Date(1_700_000_000_000).toISOString());
    assert.equal(report.projects.total, 0);
    assert.ok(report.checks.length > 0);
    assert.equal(report.paths.config, path.join(tempDir, ".ago", "config.json"));
  });
});

test("buildDoctorReport errors when a Claude command is missing but observations exist", async () => {
  await withTempDir(async (tempDir) => {
    const claudeDir = path.join(tempDir, ".claude");
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeDir, "history.jsonl"),
      `${JSON.stringify({ project: "/tmp/seen", sessionId: "s1", timestamp: 1_699_000_000_000 })}\n`,
      "utf8"
    );
    const agoDir = path.join(tempDir, ".ago");
    await fs.mkdir(agoDir, { recursive: true });
    await fs.writeFile(path.join(agoDir, "config.json"), JSON.stringify({ claudeCommand: "ago-not-a-real-cmd-zzz" }), "utf8");

    const report = await buildDoctorReport({
      ...baseInput(tempDir),
      isCommandAvailable: (command: string) => command === "codex",
    });

    const claudeCheck = report.checks.find((check) => check.id === "commands.claude_available");
    assert.equal(claudeCheck?.status, "error");
    assert.equal(report.status, "error");
    assert.ok(report.errorCount >= 1);
  });
});

test("buildDoctorReport flags an outdated Node version as error", async () => {
  await withTempDir(async (tempDir) => {
    const report = await buildDoctorReport({ ...baseInput(tempDir), nodeVersion: "v16.0.0" });
    const nodeCheck = report.checks.find((check) => check.id === "runtime.node_version");
    assert.equal(nodeCheck?.status, "error");
    assert.equal(report.status, "error");
  });
});
