import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sa = join(here, "..", "src", "sa.mjs");
const dir = mkdtempSync(join(tmpdir(), "sa-test-"));
const PASSPHRASE = "test-pass-123";

const input = join(dir, "input.csv");
const sanitized = join(dir, "sanitized.csv");
const mapping = join(dir, "map.safe-ainabler");
const restored = join(dir, "restored.csv");

const original = [
  "Customer Name,Email,Phone,Revenue",
  "Budi Contoh,user@example.com,0800-0000-0001,1000",
  "Dewi Contoh,admin@example.com,0800-0000-0002,2500",
  "Budi Contoh,user@example.com,0800-0000-0001,3000",
].join("\n");

const run = (args) => execFileSync(process.execPath, [sa, ...args], { encoding: "utf8" });

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  }
}

try {
  writeFileSync(input, original, "utf8");

  const s = JSON.parse(run(["sanitize", input, "--auto", "-p", PASSPHRASE, "-o", sanitized, "-m", mapping]));
  assert(s.ok === true, "sanitize ok");
  assert(s.uniqueValues === 6, `expected 6 unique values, got ${s.uniqueValues}`);
  assert(existsSync(mapping), "mapping written");

  const sanText = readFileSync(sanitized, "utf8");
  assert(!sanText.includes("Budi Contoh"), "no real name in sanitized output");
  assert(!sanText.includes("user@example.com"), "no real email in sanitized output");
  assert(sanText.includes("PERSON_001"), "person labels present");
  assert(sanText.includes("EMAIL_001"), "email labels present");

  const r = JSON.parse(run(["restore", sanitized, "--mapping", mapping, "-p", PASSPHRASE, "-o", restored]));
  assert(r.ok === true, "restore ok");
  assert(r.replacements > 0, "something was restored");

  const restoredText = readFileSync(restored, "utf8").trim();
  assert(restoredText === original.trim(), `round-trip mismatch:\n--- got ---\n${restoredText}`);

  let wrongPassRejected = false;
  try {
    run(["restore", sanitized, "--mapping", mapping, "-p", "wrong", "-o", restored]);
  } catch {
    wrongPassRejected = true;
  }
  assert(wrongPassRejected, "wrong passphrase must fail");

  console.log("PASS: sanitize -> restore round-trip is exact, wrong passphrase rejected.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
