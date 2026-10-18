// Safe Ainabler — local HTTP API.
//
// Why an API at all: a harness that can only run `curl` can hand this server a *path*
// and receive the sanitized result, so the raw bytes never enter the model's context.
// The passphrase is supplied once, by the user, when the server starts — it is never
// sent per request, never logged, and never included in a response.
import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { toCsv } from "./csv.mjs";
import {
  ENTITY_TYPES,
  countLabels,
  creditsFor,
  decryptMapping,
  encryptMapping,
  guessEntity,
  restoreRows,
  restoreText,
  sanitize,
} from "./engine.mjs";
import {
  baseName,
  extOf,
  isSheetExt,
  readRows,
  readText,
  rowsFromBuffer,
  writeRows,
  writeText,
} from "./sheet.mjs";

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const PREVIEW_ROWS = 10;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (status, message) => new HttpError(status, message);

function send(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj, null, 2));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

function readBody(req, maxBytes) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(bad(413, `Request body exceeds the ${maxBytes}-byte limit.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function splitBuffer(buf, sep) {
  const parts = [];
  let from = 0;
  for (;;) {
    const at = buf.indexOf(sep, from);
    if (at === -1) {
      parts.push(buf.subarray(from));
      return parts;
    }
    parts.push(buf.subarray(from, at));
    from = at + sep.length;
  }
}

// Minimal, binary-safe multipart/form-data parser: enough for one file plus text fields.
function parseMultipart(body, boundary) {
  const sep = Buffer.from(`\r\n--${boundary}`);
  const normalized = Buffer.concat([Buffer.from("\r\n"), body]);
  const segments = splitBuffer(normalized, sep).slice(1);
  const fields = {};
  const files = {};
  for (const segment of segments) {
    const headerEnd = segment.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headers = segment.subarray(0, headerEnd).toString("utf8");
    const content = segment.subarray(headerEnd + 4);
    const name = /name="([^"]*)"/.exec(headers);
    if (!name) continue;
    const filename = /filename="([^"]*)"/.exec(headers);
    if (filename) {
      const type = /content-type:\s*([^\r\n]+)/i.exec(headers);
      files[name[1]] = {
        filename: filename[1],
        type: type ? type[1].trim() : "application/octet-stream",
        data: Buffer.from(content),
      };
    } else {
      fields[name[1]] = content.toString("utf8");
    }
  }
  return { fields, files };
}

async function parseRequest(req, maxBytes) {
  const contentType = String(req.headers["content-type"] || "");
  const body = await readBody(req, maxBytes);
  if (contentType.includes("multipart/form-data")) {
    const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
    const boundary = match && (match[1] || match[2]);
    if (!boundary) throw bad(400, "multipart/form-data without a boundary.");
    return parseMultipart(body, boundary.trim());
  }
  const text = body.toString("utf8").trim();
  if (!text) return { fields: {}, files: {} };
  if (contentType.includes("application/json") || text.startsWith("{")) {
    let fields;
    try {
      fields = JSON.parse(text);
    } catch {
      throw bad(400, "Body is not valid JSON.");
    }
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw bad(400, "Body must be a JSON object.");
    return { fields, files: {} };
  }
  throw bad(415, "Send application/json or multipart/form-data.");
}

function bearerOk(req, token) {
  const header = String(req.headers.authorization || "");
  const raw = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : typeof req.headers["x-safe-token"] === "string"
      ? req.headers["x-safe-token"]
      : "";
  if (!raw) return false;
  const given = createHash("sha256").update(raw).digest();
  const expected = createHash("sha256").update(token).digest();
  return timingSafeEqual(given, expected);
}

function selectionsFor(rows, fields) {
  const header = (rows[0] ?? []).map(String);
  const selections = [];
  const columnsArg = typeof fields.columns === "string" ? fields.columns.trim() : "";
  if (columnsArg) {
    for (const part of columnsArg.split(",")) {
      const [column, entity] = part.split("=").map((s) => s.trim());
      if (!column || !entity) continue;
      if (!ENTITY_TYPES.includes(entity)) {
        throw bad(400, `Unknown entity "${entity}". Valid: ${ENTITY_TYPES.join(", ")}.`);
      }
      if (!header.includes(column)) {
        throw bad(400, `Column "${column}" not found. Headers: ${header.join(", ")}.`);
      }
      selections.push({ column, entity });
    }
  } else {
    for (const name of header) {
      const entity = guessEntity(name);
      if (entity) selections.push({ column: name, entity });
    }
  }
  if (!selections.length) {
    throw bad(
      400,
      `No columns selected. Send "columns":"Name=person,Email=email". Headers: ${header.join(", ")}.`
    );
  }
  return selections;
}

async function describeInput(input, { allowText }) {
  const { fields, files } = input;
  const part = files.file || files.data || files.raw;
  if (part) {
    const format = extOf(part.filename) || ".csv";
    return { rows: await rowsFromBuffer(part.data, format), text: null, format, label: part.filename || "(uploaded file)" };
  }
  if (allowText && typeof fields.text === "string") {
    return { rows: null, text: fields.text, format: String(fields.format || ".txt"), label: "(inline text)" };
  }
  const path = typeof fields.path === "string" ? fields.path : "";
  if (!path) throw bad(400, 'Provide "path" (the server reads it), or a multipart "file" part.');
  if (!existsSync(path)) throw bad(400, `File not found: ${path}`);
  const format = extOf(path);
  if (isSheetExt(format)) return { rows: await readRows(path), text: null, format, label: path };
  if (!allowText) throw bad(400, `Unsupported format "${format}". Use .csv/.tsv/.xlsx/.xls.`);
  return { rows: null, text: readText(path), format, label: path };
}

async function doSanitize(input, ctx) {
  if (!ctx.passphrase) {
    throw bad(400, "Server started without a passphrase, so it cannot encrypt a mapping. Restart it with --passphrase-stdin.");
  }
  const { rows, format, label } = await describeInput(input, { allowText: false });
  if (!rows || !rows.length) throw bad(400, "Input appears to be empty.");

  const fields = input.fields;
  const selections = selectionsFor(rows, fields);
  const { rows: sanitizedRows, mapping, cellsProcessed } = sanitize(rows, selections);

  const outPath =
    typeof fields.out === "string" && fields.out ? fields.out : `${baseName(label)}_sanitized${format}`;
  const mappingPath =
    typeof fields.mappingOut === "string" && fields.mappingOut
      ? fields.mappingOut
      : `${baseName(label)}_mapping.safe-ainabler`;

  await writeRows(outPath, sanitizedRows);
  const mappingEncrypted = await encryptMapping(mapping, ctx.passphrase);
  writeText(mappingPath, mappingEncrypted);

  const previewRows =
    fields.previewRows === undefined
      ? PREVIEW_ROWS
      : Math.max(0, Math.min(1000, Number(fields.previewRows) || 0));

  const result = {
    ok: true,
    command: "sanitize",
    input: label,
    sanitized: {
      path: resolve(outPath),
      format,
      filename: outPath.split(/[\\/]/).pop(),
      bytes: statSync(outPath).size,
    },
    mappingEncrypted,
    mappingPath: resolve(mappingPath),
    preview: sanitizedRows.slice(0, previewRows),
    summary: {
      columns: Object.fromEntries(selections.map((s) => [s.column, s.entity])),
      uniqueValues: Object.keys(mapping).length,
      rows: Math.max(0, sanitizedRows.length - 1),
      cellsProcessed,
      credits: creditsFor(cellsProcessed),
    },
  };
  if (fields.inlineText === true || fields.inlineText === "true") {
    result.text =
      format === ".tsv" ? sanitizedRows.map((r) => r.join("\t")).join("\n") : toCsv(sanitizedRows);
  }
  return result;
}

async function doRestore(input, ctx) {
  if (!ctx.passphrase) {
    throw bad(400, "Server started without a passphrase, so it cannot decrypt a mapping. Restart it with --passphrase-stdin.");
  }
  const { fields, files } = input;

  let envelope = null;
  if (typeof fields.mapping === "string" && fields.mapping.trim()) envelope = fields.mapping;
  else if (typeof fields.mappingPath === "string" && fields.mappingPath) {
    if (!existsSync(fields.mappingPath)) throw bad(400, `Mapping not found: ${fields.mappingPath}`);
    envelope = readText(fields.mappingPath);
  } else if (files.mapping) envelope = files.mapping.data.toString("utf8");
  else throw bad(400, 'Provide "mappingPath", "mapping" (envelope text), or a multipart "mapping" part.');

  let mapping;
  try {
    mapping = await decryptMapping(envelope, ctx.passphrase);
  } catch {
    throw bad(400, "Could not decrypt the mapping (wrong passphrase, or corrupted file?).");
  }

  const { rows, text, format, label } = await describeInput(input, { allowText: true });
  const out = typeof fields.out === "string" ? fields.out.trim() : "";
  let restoredPath;
  let replacements = 0;

  if (rows) {
    for (const row of rows) for (const cell of row) replacements += countLabels(String(cell ?? ""), mapping);
    restoredPath = out || `${baseName(label)}_restored${isSheetExt(format) ? format : ".csv"}`;
    await writeRows(restoredPath, restoreRows(rows, mapping));
  } else {
    if (!out) throw bad(400, 'Provide "out": this API never returns restored values, it writes them to a file.');
    replacements = countLabels(text, mapping);
    restoredPath = out;
    writeText(restoredPath, restoreText(text, mapping));
  }

  return {
    ok: true,
    command: "restore",
    input: label,
    restored: { path: resolve(restoredPath), format, bytes: statSync(restoredPath).size },
    labelsInMapping: Object.keys(mapping).length,
    replacements,
    note: "Restored values are written to disk and intentionally NOT included in this response.",
  };
}

async function handle(req, res, route, ctx, maxBytes) {
  if (req.method === "GET" && (route === "/health" || route === "/")) {
    return send(res, 200, {
      ok: true,
      service: "safe-ainabler",
      version: ctx.version,
      passphraseLoaded: Boolean(ctx.passphrase),
      endpoints: ["GET /health", "POST /sanitize", "POST /restore"],
      accepts: ["application/json", "multipart/form-data"],
    });
  }
  if (route !== "/sanitize" && route !== "/restore") {
    return send(res, 404, { ok: false, error: "Not found. Try GET /health." });
  }
  if (req.method !== "POST") return send(res, 405, { ok: false, error: "Use POST." });
  if (!bearerOk(req, ctx.token)) {
    return send(res, 401, { ok: false, error: "Missing or invalid token. Send 'Authorization: Bearer <token>'." });
  }
  const input = await parseRequest(req, maxBytes);
  const result = route === "/sanitize" ? await doSanitize(input, ctx) : await doRestore(input, ctx);
  return send(res, 200, result);
}

export function createApiServer(options = {}) {
  const {
    version = "0.0.0",
    passphrase = null,
    quiet = false,
    maxBytes = DEFAULT_MAX_BYTES,
    token = randomBytes(24).toString("base64url"),
  } = options;

  const ctx = { version, passphrase, token, maxBytes };

  const server = createServer((req, res) => {
    const started = Date.now();
    const route = new URL(req.url || "/", "http://localhost").pathname;
    res.on("finish", () => {
      if (!quiet) {
        console.log(
          `${new Date().toISOString()} ${req.method} ${route} ${res.statusCode} ${Date.now() - started}ms`
        );
      }
    });
    handle(req, res, route, ctx, maxBytes).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error(`${req.method} ${route} failed:`, err);
      send(res, status, { ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  });

  server.token = token;
  return server;
}

export function writeStateFile(path, state) {
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
