#!/usr/bin/env node
// Self-installing git hooks for qmd
// Called from the package.json "prepare" script after install
import { chmodSync, copyFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const dotGit = join(root, ".git");

// Plain repo (and packaged/test fixtures): .git is a directory, hooks live
// right under it. Worktree checkout: .git is a file pointing elsewhere, so
// ask git for the shared hooks dir instead of guessing.
let hooksDir;
if (existsSync(dotGit) && statSync(dotGit).isDirectory()) {
  hooksDir = join(dotGit, "hooks");
} else if (existsSync(dotGit)) {
  let gitCommonDir;
  try {
    gitCommonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    console.log("Not a git repository, skipping hook install");
    process.exit(0);
  }
  hooksDir = join(resolve(root, gitCommonDir), "hooks");
} else {
  console.log("Not a git repository, skipping hook install");
  process.exit(0);
}

if (!existsSync(hooksDir)) {
  console.log("Not a git repository, skipping hook install");
  process.exit(0);
}

const hook = join(hooksDir, "pre-push");
// copyFileSync follows a symlink at the destination, and an old install may have left one
// pointing into a removed worktree.
rmSync(hook, { force: true });
copyFileSync(join(root, "scripts", "pre-push"), hook);
chmodSync(hook, 0o755);
console.log("Installed git hooks: pre-push");
