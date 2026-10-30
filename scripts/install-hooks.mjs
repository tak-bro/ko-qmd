#!/usr/bin/env node
// Self-installing git hooks for qmd
// Called from the package.json "prepare" script after install
import { chmodSync, copyFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
let gitCommonDir;
try {
  gitCommonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim();
} catch {
  console.log("Not a git repository, skipping hook install");
  process.exit(0);
}
const hooksDir = join(resolve(root, gitCommonDir), "hooks");

if (!existsSync(hooksDir)) {
  console.log("Not a git repository, skipping hook install");
  process.exit(0);
}

copyFileSync(join(root, "scripts", "pre-push"), join(hooksDir, "pre-push"));
chmodSync(join(hooksDir, "pre-push"), 0o755);
console.log("Installed git hooks: pre-push");
