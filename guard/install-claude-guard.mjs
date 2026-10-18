#!/usr/bin/env node
// Merge Safe Ainabler deny rules into a project's .claude/settings.json so the
// agent cannot read the raw data folder — enforcement the model cannot override.
//
// Usage:
//   node guard/install-claude-guard.mjs <raw-dir> [more-dirs...] [--bash] [--project <dir>]
//
// Always adds Read(...) denies for each raw dir. With --bash it also adds
// broad "dump a file" command denies (cat/head/grep/...); these are heavier
// handed and may get in the way of other work, so they are opt-in.
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const bash = argv.includes("--bash");
const projIdx = argv.indexOf("--project");
const project = projIdx !== -1 ? resolve(argv[projIdx + 1]) : process.cwd();

const dirs = argv.filter((a, i) => !a.startsWith("-") && i !== projIdx + 1);

if (dirs.length === 0) {
  console.error("Usage: node guard/install-claude-guard.mjs <raw-dir> [more-dirs...] [--bash] [--project <dir>]");
  console.error('Example: node guard/install-claude-guard.mjs ./raw --bash');
  process.exit(2);
}

const norm = (d) => {
  let p = d.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!p.startsWith("/") && !p.startsWith("./") && !p.startsWith("~")) p = "./" + p;
  return p;
};

const BOILERPLATE = ["cat", "head", "tail", "less", "more", "grep", "rg", "awk", "sed", "cut", "od", "strings"];

const rules = [
  ...dirs.map((d) => `Read(${norm(d)}/**)`),
  ...(bash ? BOILERPLATE.map((c) => `Bash(${c}:*)`) : []),
];

const claudeDir = join(project, ".claude");
const file = join(claudeDir, "settings.json");
mkdirSync(claudeDir, { recursive: true });

let settings = {};
if (existsSync(file)) {
  try {
    settings = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    console.error(`Existing ${file} is not valid JSON. Fix it first; nothing was changed.`);
    process.exit(1);
  }
  copyFileSync(file, `${file}.bak`);
}

settings.permissions ??= {};
const deny = new Set(settings.permissions.deny ?? []);
const added = [];
for (const r of rules) {
  if (!deny.has(r)) {
    deny.add(r);
    added.push(r);
  }
}
settings.permissions.deny = [...deny];

writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");

console.log(`Updated ${file}\n`);
if (added.length === 0) {
  console.log("All rules were already present.");
} else {
  console.log("Added deny rules:");
  for (const r of added) console.log("  " + r);
}
if (!bash) console.log("\nTip: add --bash to also block cat/head/grep/... (broad).");
