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

export async function readRows(path) {
  const ext = extOf(path);
  if (ext === ".csv" || ext === ".tsv") {
    return parseCsv(readFileSync(path, "utf8"));
  }
  const XLSX = await xlsxLib();
  const buf = new Uint8Array(readFileSync(path));
  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
  return rows.map((r) => r.map((c) => (c == null ? "" : String(c))));
}

export async function writeRows(path, rows) {
  const ext = extOf(path);
  if (ext === ".csv") {
    writeFileSync(path, toCsv(rows), "utf8");
    return;
  }
  if (ext === ".tsv") {
    writeFileSync(path, rows.map((r) => r.join("\t")).join("\n"), "utf8");
    return;
  }
  const XLSX = await xlsxLib();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const bookType = ext === ".xls" ? "xls" : "xlsx";
  writeFileSync(path, XLSX.write(wb, { type: "buffer", bookType }));
}

export function readText(path) {
  return readFileSync(path, "utf8");
}

export function writeText(path, text) {
  writeFileSync(path, text, "utf8");
}
