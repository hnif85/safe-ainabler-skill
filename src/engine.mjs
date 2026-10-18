// Safe Ainabler — portable engine (sanitize / restore / encrypted mapping).
// Mirrors the browser app so mapping files are interchangeable:
//   PBKDF2-SHA256 (210,000 iterations) -> AES-GCM-256, envelope { v, salt, iv, data }.
import { webcrypto as nodeWebcrypto } from "node:crypto";

const enc = new TextEncoder();
const dec = new TextDecoder();

const PBKDF2_ITERATIONS = 210_000;

const webcrypto = globalThis.crypto ?? nodeWebcrypto;

export const ENTITY_PREFIX = {
  person: "PERSON",
  company: "COMPANY",
  email: "EMAIL",
  phone: "PHONE",
  address: "ADDRESS",
  custom: "CUSTOM",
};

export const ENTITY_TYPES = Object.keys(ENTITY_PREFIX);

const NAME_HINTS = ["name", "nama", "customer", "pelanggan", "contact", "kontak"];
const COMPANY_HINTS = ["company", "perusahaan", "supplier", "vendor", "client", "brand"];
const EMAIL_HINTS = ["email", "mail", "surel"];
const PHONE_HINTS = ["phone", "telepon", "telp", "mobile", "hp", "whatsapp", "wa"];
const ADDRESS_HINTS = ["address", "alamat", "street", "jalan", "city", "kota"];

export function guessEntity(columnName) {
  const name = String(columnName).toLowerCase();
  if (EMAIL_HINTS.some((h) => name.includes(h))) return "email";
  if (PHONE_HINTS.some((h) => name.includes(h))) return "phone";
  if (ADDRESS_HINTS.some((h) => name.includes(h))) return "address";
  if (COMPANY_HINTS.some((h) => name.includes(h))) return "company";
  if (NAME_HINTS.some((h) => name.includes(h))) return "person";
  return null;
}

export function sanitize(rows, selections) {
  const header = rows[0] ?? [];
  const colIndex = new Map();
  header.forEach((name, i) => colIndex.set(String(name), i));

  const counters = { person: 0, company: 0, email: 0, phone: 0, address: 0, custom: 0 };
  const mapping = {};
  const valueToLabel = new Map();
  const out = rows.map((row) => [...row]);

  for (const sel of selections) {
    const idx = colIndex.get(sel.column);
    if (idx === undefined) continue;
    const prefix = ENTITY_PREFIX[sel.entity];
    for (let r = 1; r < out.length; r++) {
      const raw = out[r][idx];
      if (raw === undefined || raw === null || raw === "") continue;
      const original = String(raw);
      const key = `${sel.entity}:${original}`;
      let label = valueToLabel.get(key);
      if (!label) {
        counters[sel.entity] += 1;
        label = `${prefix}_${String(counters[sel.entity]).padStart(3, "0")}`;
        valueToLabel.set(key, label);
        mapping[label] = original;
      }
      out[r][idx] = label;
    }
  }

  const cellsProcessed = selections.length * Math.max(0, rows.length - 1);
  return { rows: out, mapping, cellsProcessed };
}

export function restoreText(text, mapping) {
  const labels = Object.keys(mapping).sort((a, b) => b.length - a.length);
  let out = text;
  for (const label of labels) out = out.split(label).join(mapping[label]);
  return out;
}

export function restoreRows(rows, mapping) {
  return rows.map((row) =>
    row.map((cell) => (cell === "" ? cell : restoreText(String(cell), mapping)))
  );
}

export function countLabels(text, mapping) {
  let total = 0;
  for (const label of Object.keys(mapping)) {
    let i = 0;
    for (;;) {
      const at = text.indexOf(label, i);
      if (at === -1) break;
      total += 1;
      i = at + label.length;
    }
  }
  return total;
}

export const CREDITS_PER_CELLS = 10_000;

export function creditsFor(cells) {
  if (cells <= 0) return 0;
  return Math.ceil(cells / CREDITS_PER_CELLS);
}

export const SMALL_PROMPT = `Important instruction for handling this data: the values that look like PERSON_001, COMPANY_001, EMAIL_001, PHONE_001, ADDRESS_001, or CUSTOM_001 are anonymized placeholders. Keep them EXACTLY as they appear — do not paraphrase, rewrite, merge, or expand them. When your answer includes any of these values, reproduce them verbatim so they can be restored later.`;

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64ToBuf(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

async function deriveKey(passphrase, salt) {
  const baseKey = await webcrypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return webcrypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptMapping(mapping, passphrase) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const plaintext = enc.encode(JSON.stringify(mapping));
  const cipher = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return JSON.stringify({
    v: 1,
    salt: bufToB64(salt.buffer),
    iv: bufToB64(iv.buffer),
    data: bufToB64(cipher),
  });
}

export async function decryptMapping(envelopeText, passphrase) {
  const env = JSON.parse(envelopeText);
  const key = await deriveKey(passphrase, b64ToBuf(env.salt));
  const plain = await webcrypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBuf(env.iv) },
    key,
    b64ToBuf(env.data).buffer
  );
  return JSON.parse(dec.decode(plain));
}
