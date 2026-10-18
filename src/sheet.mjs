// File I/O for CSV/TSV/XLSX and text. Spreadsheets go through SheetJS when present;
// otherwise it falls back to the vendored copy, then a plain-CSV path.
import { readFileSync, writeFileSync } from "node:fs";
import { parseCsv, toCsv } from "./csv.mjs";

export function extOf(p) {
  const i = String(p).lastIndexOf(".");
  return i > 0 ? String(p).slice(i).toLowerCase() : "";
}

export function baseName(p) {
  const i = String(p).lastIndexOf(".");
  return i > 0 ? String(p).slice(0, i) : String(p);
}

const SHEET_EXTS = new Set([".csv", ".tsv", ".xlsx", ".xls"]);
export const isSheetExt = (e) => SHEET_EXTS.has(e);
export const isTextExt = (e) => e === ".txt" || e === ".md" || e === ".text" || e === "";

let _xlsx = null;

async function xlsxLib() {
  if (_xlsx) return _xlsx;
  for (const spec of ["xlsx", "../vendor/xlsx.mjs"]) {
    try {
      const mod = await import(spec);
      _xlsx = mod.default ?? mod;
      return _xlsx;
    } catch {
      // try next source
    }
  }
  throw new Error(
    "Spreadsheet support needs SheetJS. Run `npm install` (or `bun install`) in the skill folder, or use .csv/.tsv files."
  );
}

// Buffer-based variants: used by the local API so the server can take a file from a
// request body without ever writing the raw bytes to a temporary file first.
export async function rowsFromBuffer(buf, ext) {
  if (ext === ".csv" || ext === ".tsv") {
    return parseCsv(buf.toString("utf8"));
  }
  const XLSX = await xlsxLib();
  const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
  return rows.map((r) => r.map((c) => (c == null ? "" : String(c))));
}

export async function rowsToBuffer(rows, ext) {
  if (ext === ".csv") return Buffer.from(toCsv(rows), "utf8");
  if (ext === ".tsv") return Buffer.from(rows.map((r) => r.join("\t")).join("\n"), "utf8");
  const XLSX = await xlsxLib();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const bookType = ext === ".xls" ? "xls" : "xlsx";
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType }));
}

export async function readRows(path) {
  return rowsFromBuffer(readFileSync(path), extOf(path));
}

export async function writeRows(path, rows) {
  writeFileSync(path, await rowsToBuffer(rows, extOf(path)));
}

export function readText(path) {
  return readFileSync(path, "utf8");
}

export function writeText(path, text) {
  writeFileSync(path, text, "utf8");
}
