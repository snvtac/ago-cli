import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { aggregateChecks, buildConfigShowReport, parseNodeMajor, type DoctorCheck } from "../src/doctor.js";

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
