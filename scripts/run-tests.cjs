#!/usr/bin/env node

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const testDir = path.join(repoRoot, "dist", "test");
const args = process.argv.slice(2);
const coverage = args.includes("--coverage");
const coverageArgs = coverage
  ? [
      "--experimental-test-coverage",
      ...args.flatMap((arg) => {
        if (arg.startsWith("--coverage-lines=")) {
          return [`--test-coverage-lines=${arg.slice("--coverage-lines=".length)}`];
        }
        if (arg.startsWith("--coverage-include=")) {
          return [`--test-coverage-include=${arg.slice("--coverage-include=".length)}`];
        }
        return [];
      })
    ]
  : [];

const testFiles = fs
  .readdirSync(testDir)
  .filter((file) => file.endsWith(".test.js"))
  .sort()
  .map((file) => path.join(testDir, file));

for (const testFile of testFiles) {
  const result = childProcess.spawnSync(process.execPath, [...coverageArgs, "--test", testFile], {
    cwd: repoRoot,
    stdio: "inherit",
    windowsHide: false
  });
  if (result.status !== 0) {
    process.exit(typeof result.status === "number" ? result.status : 1);
  }
}
