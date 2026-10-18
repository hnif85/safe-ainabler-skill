import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/server.mjs";

const PASSPHRASE = "api-test-pass";
const dir = mkdtempSync(join(tmpdir(), "sa-api-test-"));

const input = join(dir, "data.csv");
const aiOutput = join(dir, "ai_output.csv");
const restored = join(dir, "ai_output_restored.csv");
const sanitized = join(dir, "data_sanitized.csv");
const mapping = join(dir, "data_mapping.safe-ainabler");

const original = [
  "Customer Name,Email,Phone,Note",
  "Budi Contoh,user@example.com,0800-0000-0001,keep this",
  "Dewi Contoh,admin@example.com,0800-0000-0002,and this",
].join("\n");

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  }
}

writeFileSync(input, original, "utf8");
writeFileSync(aiOutput, "Customer Name,Email,Note\nPERSON_001,EMAIL_001,keep this\n", "utf8");

const server = createApiServer({ passphrase: PASSPHRASE, version: "test", quiet: true });
await new Promise((listening) => server.listen(0, "127.0.0.1", listening));
const base = `http://127.0.0.1:${server.address().port}`;
const auth = { authorization: `Bearer ${server.token}` };
const json = (body) => ({ "content-type": "application/json", ...auth });

try {
  const health = await fetch(`${base}/health`);
  const healthBody = await health.json();
  assert(health.status === 200 && healthBody.ok === true, "health responds ok");
  assert(healthBody.passphraseLoaded === true, "health reports the passphrase is loaded");

  const noToken = await fetch(`${base}/sanitize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: input }),
  });
  assert(noToken.status === 401, `sanitize without a token must be 401 (got ${noToken.status})`);

  const badToken = await fetch(`${base}/sanitize`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer nope" },
    body: JSON.stringify({ path: input }),
  });
  assert(badToken.status === 401, "sanitize with a wrong token must be 401");

  const san = await fetch(`${base}/sanitize`, {
    method: "POST",
    headers: json(),
    body: JSON.stringify({ path: input, columns: "Customer Name=person,Email=email,Phone=phone" }),
  });
  const sanBody = await san.json();
  assert(san.status === 200 && sanBody.ok === true, `sanitize by path ok (${san.status}: ${sanBody.error || ""})`);
  assert(existsSync(sanitized), "sanitized file written to the default path");
  assert(existsSync(mapping), "mapping file written");

  const sanText = readFileSync(sanitized, "utf8");
  assert(!sanText.includes("Budi Contoh"), "sanitized file has no real names");
  assert(!sanText.includes("user@example.com"), "sanitized file has no real emails");
  assert(sanText.includes("PERSON_001"), "sanitized file has labels");
  assert(sanText.includes("keep this"), "non-sensitive columns are untouched");

  assert(Array.isArray(sanBody.preview) && sanBody.preview.length === 3, "response includes a row preview");
  assert(sanBody.preview[1][0] === "PERSON_001", "preview is sanitized");
  assert(typeof sanBody.mappingEncrypted === "string", "response returns the encrypted mapping envelope");
  const env = JSON.parse(sanBody.mappingEncrypted);
  assert(env.v === 1 && env.salt && env.iv && env.data, "envelope has the expected shape");
  assert(!sanBody.mappingEncrypted.includes("Budi Contoh"), "mapping envelope is opaque");
  assert(sanBody.summary.cellsProcessed === 6, `expected 6 cells processed, got ${sanBody.summary.cellsProcessed}`);

  const form = new FormData();
  form.set("file", new Blob([readFileSync(input)], { type: "text/csv" }), "uploaded.csv");
  form.set("columns", "Customer Name=person");
  form.set("out", join(dir, "uploaded_sanitized.csv"));
  const uploaded = await fetch(`${base}/sanitize`, { method: "POST", headers: auth, body: form });
  const uploadedBody = await uploaded.json();
  assert(uploaded.status === 200 && uploadedBody.ok === true, `multipart sanitize ok (${uploaded.status}: ${uploadedBody.error || ""})`);
  const uploadedText = readFileSync(join(dir, "uploaded_sanitized.csv"), "utf8");
  assert(uploadedText.includes("PERSON_001") && !uploadedText.includes("Budi Contoh"), "multipart upload was sanitized");
  assert(uploadedText.includes("user@example.com"), "only the selected column was sanitized");

  const res = await fetch(`${base}/restore`, {
    method: "POST",
    headers: json(),
    body: JSON.stringify({ path: aiOutput, mappingPath: mapping, out: restored }),
  });
  const resBody = await res.json();
  assert(res.status === 200 && resBody.ok === true, `restore ok (${res.status}: ${resBody.error || ""})`);
  assert(existsSync(restored), "restored file written");
  const restoredText = readFileSync(restored, "utf8");
  assert(restoredText.includes("Budi Contoh"), "restored file has the real values back");
  assert(resBody.replacements === 2, `expected 2 replacements, got ${resBody.replacements}`);

  const resJson = JSON.stringify(resBody);
  assert(!resJson.includes("Budi Contoh"), "restore response must NOT contain restored values");
  assert(!resJson.includes("user@example.com"), "restore response must NOT contain real emails");

  const wrongPass = createApiServer({ passphrase: "other-pass", version: "test", quiet: true });
  await new Promise((listening) => wrongPass.listen(0, "127.0.0.1", listening));
  const wrongBase = `http://127.0.0.1:${wrongPass.address().port}`;
  const wrongRes = await fetch(`${wrongBase}/restore`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${wrongPass.token}` },
    body: JSON.stringify({ path: aiOutput, mappingPath: mapping, out: join(dir, "never.csv") }),
  });
  assert(wrongRes.status === 400, `wrong passphrase must be rejected with 400 (got ${wrongRes.status})`);
  assert(!existsSync(join(dir, "never.csv")), "nothing is written when the passphrase is wrong");
  await new Promise((done) => wrongPass.close(done));

  console.log("PASS: local API — health, auth, sanitize (path + multipart), restore, no restored values in responses.");
} finally {
  await new Promise((done) => server.close(done));
  rmSync(dir, { recursive: true, force: true });
}
