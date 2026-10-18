#!/usr/bin/env node
// Safe Ainabler CLI — sanitize data before it reaches an AI, restore it afterwards.
import { existsSync, readFileSync } from "node:fs";
import {
  ENTITY_TYPES,
  guessEntity,
  sanitize,
  restoreText,
  restoreRows,
  countLabels,
  creditsFor,
  encryptMapping,
  decryptMapping,
  SMALL_PROMPT,
} from "./engine.mjs";
import {
  readRows,
  writeRows,
  readText,
  writeText,
  extOf,
  baseName,
  isSheetExt,
} from "./sheet.mjs";

const VERSION = "1.0.0";

const SHORT = { o: "out", m: "mapping", p: "passphrase", h: "help", v: "version" };

function parseArgs(argv) {
  const opts = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        opts[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        opts[a.slice(2)] = next && !next.startsWith("-") ? argv[++i] : true;
      }
    } else if (a.startsWith("-") && a.length > 1) {
      const key = SHORT[a.slice(1)] || a.slice(1);
      const next = argv[i + 1];
      opts[key] = next && !next.startsWith("-") ? argv[++i] : true;
    } else {
      pos.push(a);
    }
  }
  return { opts, pos };
}

function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function out(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

function str(v) {
  return v && v !== true ? String(v) : null;
}

function getPassphrase(opts) {
  if (opts["passphrase-stdin"]) {
    const v = readFileSync(0, "utf8").replace(/\r?\n$/, "");
    if (v) return v;
  }
  const inline = str(opts.passphrase);
  if (inline) return inline;
  const envName = str(opts["passphrase-env"]);
  if (envName && process.env[envName]) return process.env[envName];
  if (process.env.SAFE_AINABLER_PASSPHRASE) return process.env.SAFE_AINABLER_PASSPHRASE;
  return null;
}

async function cmdSanitize(pos, opts) {
  const input = pos[0];
  if (!input) fail('Usage: sa sanitize <input.csv|xlsx> [--columns "Name=person,Email=email"] [--auto] -p <passphrase>');
  if (!existsSync(input)) fail(`Input not found: ${input}`);
  const ext = extOf(input);
  if (!isSheetExt(ext)) fail(`sanitize expects .csv/.tsv/.xlsx/.xls (got "${ext || "none"}").`);

  const passphrase = getPassphrase(opts);
  if (!passphrase) {
    fail("Missing passphrase. Use --passphrase-stdin (recommended: run scripts/sanitize-user.sh yourself), --passphrase-env <VAR>, or --passphrase <text>.");
  }

  const rows = await readRows(input);
  if (!rows.length) fail("Input appears to be empty.");
  const header = (rows[0] ?? []).map(String);

  const selections = [];
  const columnsArg = str(opts.columns);
  if (columnsArg) {
    for (const part of columnsArg.split(",")) {
      const [col, ent] = part.split("=").map((s) => s.trim());
      if (!col || !ent) continue;
      if (!ENTITY_TYPES.includes(ent)) fail(`Unknown entity "${ent}". Valid: ${ENTITY_TYPES.join(", ")}.`);
      if (!header.includes(col)) fail(`Column "${col}" not found. Headers: ${header.join(", ")}.`);
      selections.push({ column: col, entity: ent });
    }
  } else {
    for (const h of header) {
      const e = guessEntity(h);
      if (e) selections.push({ column: h, entity: e });
    }
  }

  if (!selections.length) {
    fail(`No columns selected. Headers: ${header.join(", ")}. Pass --columns "Name=person,Email=email".`);
  }

  const { rows: outRows, mapping, cellsProcessed } = sanitize(rows, selections);

  const outPath = str(opts.out) ?? `${baseName(input)}_sanitized${ext}`;
  const mapPath = str(opts.mapping) ?? `${baseName(input)}_mapping.safe-ainabler`;

  await writeRows(outPath, outRows);
  writeText(mapPath, await encryptMapping(mapping, passphrase));

  out({
    ok: true,
    command: "sanitize",
    input,
    sanitized: outPath,
    mapping: mapPath,
    columns: Object.fromEntries(selections.map((s) => [s.column, s.entity])),
    uniqueValues: Object.keys(mapping).length,
    cellsProcessed,
    credits: creditsFor(cellsProcessed),
  });
}

async function cmdRestore(pos, opts) {
  const input = pos[0];
  if (!input) fail("Usage: sa restore <ai-output.csv|txt> --mapping <file> -p <passphrase>");
  if (!existsSync(input)) fail(`Input not found: ${input}`);

  const mapPath = str(opts.mapping);
  if (!mapPath) fail("Missing --mapping <encrypted mapping file>.");
  if (!existsSync(mapPath)) fail(`Mapping not found: ${mapPath}`);

  const passphrase = getPassphrase(opts);
  if (!passphrase) {
    fail("Missing passphrase. Use --passphrase-stdin (recommended: run scripts/sanitize-user.sh yourself), --passphrase-env <VAR>, or --passphrase <text>.");
  }

  let mapping;
  try {
    mapping = await decryptMapping(readText(mapPath), passphrase);
  } catch {
    fail("Could not decrypt the mapping. Wrong passphrase or corrupted file?");
  }

  const ext = extOf(input);
  let outPath;
  let replaced = 0;

  if (isSheetExt(ext)) {
    const rows = await readRows(input);
    for (const row of rows) {
      for (const cell of row) replaced += countLabels(String(cell ?? ""), mapping);
    }
    outPath = str(opts.out) ?? `${baseName(input)}_restored${ext}`;
    await writeRows(outPath, restoreRows(rows, mapping));
  } else {
    const text = readText(input);
    replaced = countLabels(text, mapping);
    const outExt = ext || ".txt";
    outPath = str(opts.out) ?? `${baseName(input)}_restored${outExt}`;
    writeText(outPath, restoreText(text, mapping));
  }

  out({
    ok: true,
    command: "restore",
    input,
    mapping: mapPath,
    restored: outPath,
    labelsInMapping: Object.keys(mapping).length,
    replacements: replaced,
  });
}

async function cmdInspect(pos) {
  const input = pos[0];
  if (!input) fail("Usage: sa inspect <input.csv|xlsx>");
  if (!existsSync(input)) fail(`Input not found: ${input}`);
  const ext = extOf(input);
  if (!isSheetExt(ext)) fail(`inspect expects .csv/.tsv/.xlsx/.xls (got "${ext || "none"}").`);

  const rows = await readRows(input);
  const header = (rows[0] ?? []).map(String);
  out({
    ok: true,
    command: "inspect",
    input,
    format: ext,
    columns: header.map((name) => ({ name, guessedEntity: guessEntity(name) })),
    dataRows: Math.max(0, rows.length - 1),
  });
}

function cmdPrompt() {
  console.log(SMALL_PROMPT);
}

function help() {
  console.log(`safe-ainabler ${VERSION} — sanitize data before AI, restore it after.

Usage:
  sa inspect  <file>                                   List columns + guessed entities (no data shown)
  sa sanitize <file> [options]                         Write <base>_sanitized + <base>_mapping.safe-ainabler
  sa restore  <file> --mapping <file> [options]         Write <base>_restored
  sa prompt                                            Print the instruction to give the AI

Sanitize options:
  --columns "Name=person,Email=email,Phone=phone"      Explicit columns (else --auto)
  --auto                                               Auto-detect sensitive columns from headers
  -o, --out <file>                                     Output path (default <base>_sanitized<ext>)
  -m, --mapping <file>                                 Mapping path (default <base>_mapping.safe-ainabler)

Restore options:
  -m, --mapping <file>                                 Encrypted mapping file (required)
  -o, --out <file>                                     Output path (default <base>_restored<ext>)

Passphrase (required for sanitize/restore):
      --passphrase-stdin                               Read the passphrase from stdin (never argv, never shown)
  -p, --passphrase <text>                              NOT recommended (visible in shell history)
      --passphrase-env <VAR>                           Read passphrase from an env var
  (env SAFE_AINABLER_PASSPHRASE is also read)

Entities: person, company, email, phone, address, custom
Formats:  .csv .tsv .xlsx .xls (sheets), .txt .md (text, restore only)
`);
}

const [, , cmd, ...rest] = process.argv;
const { opts, pos } = parseArgs(rest);

try {
  switch (cmd) {
    case "sanitize":
      if (opts.help) help();
      else await cmdSanitize(pos, opts);
      break;
    case "restore":
      if (opts.help) help();
      else await cmdRestore(pos, opts);
      break;
    case "inspect":
      if (opts.help) help();
      else await cmdInspect(pos);
      break;
    case "prompt":
      cmdPrompt();
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      help();
      break;
    case "version":
    case "--version":
    case "-v":
      console.log(VERSION);
      break;
    default:
      fail(`Unknown command "${cmd}". Run "sa help".`);
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
