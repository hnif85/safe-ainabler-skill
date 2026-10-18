---
name: safe-ainabler
description: Sanitize sensitive values (names, companies, emails, phones, addresses) in Excel/CSV/text before sending them to an AI model, then restore the real values afterward from an encrypted mapping file. Use when the user wants to anonymize, mask, pseudonymize, or de-identify a spreadsheet or document before pasting it into ChatGPT/Claude/any LLM, or to turn placeholder labels such as PERSON_001 back into the originals. Works three ways — the user runs a shell wrapper, you run the local CLI, or you call the bundled local HTTP API (sa serve) when you cannot read files yourself. Triggers: sanitize data, anonymize file, mask PII, pseudonymize, de-identify, clean data before AI, safe ainabler, restore placeholders, restore anonymized data, sanitize API, local API for PII, serve sanitize endpoint.
license: MIT
---

# Safe Ainabler

Replaces sensitive values with neutral labels (`PERSON_001`, `EMAIL_001`, `PHONE_001`, `COMPANY_001`, `ADDRESS_001`, `CUSTOM_001`) and writes an **encrypted mapping** so the originals can be restored later. Everything runs locally.

## Read this first: you are the risk

If you read the raw file yourself, the data is in your context and sanitizing it afterwards is pointless. **Your job is to run a local tool and never look at the originals.** Treat the raw file as radioactive: it goes in, sanitized output comes out, you only ever handle the sanitized side.

## THE ONE RULE

**Never open, print, dump, or search the raw input file.** No `Read`, `cat`, `head`, `tail`, `less`, `more`, `grep`, `rg`, `awk`, `sed`, `cut`, `od`, `strings`, `python -c`, or any equivalent. The *only* command you may point at the raw file is:

```bash
node src/sa.mjs inspect "<raw-file>"   # prints column NAMES only, never cells
```

If you need to know which columns hold sensitive data, **ask the user** — do not open the file to find out. If the user hasn't named the columns, ask; then use `--columns`.

## FORBIDDEN

- Reading the raw file with any tool, for any reason (including "just to check the header" or "to decide what to mask").
- Generating, choosing, or inventing a passphrase yourself.
- Printing, echoing, logging, or putting a passphrase into a command line, an env dump, or your output. `echo "$SAFE_AINABLER_PASSPHRASE"` is a leak.
- Reading or printing the mapping file.
- Copying the mapping file into any shared, synced, export, or output directory.
- Running `restore` on data and then showing the restored (real) values.
- Asking the user for their passphrase, or sending one to the local API. The API holds it; you never supply it.

## Which mode to use

Pick the **safest mode the situation allows** — never take more access than you need.

| Mode | Use when | What you touch | Passphrase |
| --- | --- | --- | --- |
| **A. User-run wrappers** (default) | Always — the user is at their terminal | the sanitized file only | the user types it; you never see it |
| **B. You run the CLI** | Only when the user explicitly asks you to | the sanitized file only | handed to you via stdin/env — never generate one |
| **C. Local API** | Your harness can make HTTP calls but cannot (or must not) read files | HTTP responses only (`preview`, `mappingEncrypted`) | loaded once inside the server; never sent per request |

All three produce the same artifacts (`<base>_sanitized.<ext>` + `<base>_mapping.safe-ainabler`), and the mapping files are interchangeable. Prefer **A**; fall back to **C** when you have no filesystem access; reach for **B** only on request.

## Passphrase policy

The passphrase belongs to the user, not to you. The safest path is that **you never touch it**: ask the user to run the wrapper themselves.

```bash
# user runs this in their own terminal; you only receive the resulting paths
scripts/sanitize-user.sh "<raw-file>" --auto
# ... agent works on <raw>_sanitized.<ext> ...
scripts/restore-user.sh "<ai-output>" --mapping "<raw>_mapping.safe-ainabler"
```

The wrappers read the passphrase with a hidden prompt and pipe it over stdin (`--passphrase-stdin`) — it never appears in argv, in the environment, or in any transcript.

Only if the user explicitly insists that you run it, use `--passphrase-stdin` or `--passphrase-env <VAR>`, and never print the value.

## Mode A — user-in-the-loop (default)

1. Ask the user for the raw file path and which columns are sensitive (do **not** open the file).
2. Ask the user to run `scripts/sanitize-user.sh "<raw>" --columns "…"` (or `--auto`) in their own terminal.
3. The user gives you only the **sanitized** file. Work on that. Never ask for the mapping or the passphrase.
4. Produce your output using the labels verbatim (paste the text from `node src/sa.mjs prompt` into your own reasoning/instructions as needed).
5. Ask the user to run `scripts/restore-user.sh "<your-output>" --mapping "…"` to recover the real values.

## Mode B — you run the CLI (only if the user explicitly allows it)

1. `node src/sa.mjs inspect "<raw>"` → learn columns (names only).
2. `node src/sa.mjs sanitize "<raw>" --columns "…"` with a passphrase the user provided via stdin/env. Do not generate one.
3. Read the **sanitized** file only. Do the work. Keep labels verbatim.
4. `node src/sa.mjs restore "<output>" --mapping "…"` — and do not display the restored values unless the user asks.

## Mode C — local API (for harnesses that cannot read files)

Ask the user to start it **in their own terminal**:

```bash
scripts/serve-user.sh            # the user runs this; they type the passphrase once, hidden
```

It prints a URL and a bearer token, and writes `.safe-ainabler/serve.json` with `{ "url": ..., "token": ... }`. Reading that small file is fine — it is not raw data. Then:

```bash
# sanitize: the SERVER reads the file, so its bytes never enter your context
curl -s -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
     -d '{"path":"data.xlsx","columns":"Name=person,Email=email"}' \
     http://127.0.0.1:8787/sanitize

# restore: writes the real values to a file and returns only a summary
curl -s -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
     -d '{"path":"ai_output.xlsx","mappingPath":"data_mapping.safe-ainabler","out":"ai_output_restored.xlsx"}' \
     http://127.0.0.1:8787/restore
```

Rules for this mode:

- Prefer `"path"` over uploading bytes. The server reads the file on your behalf; send the file's *contents* only if the user explicitly asks.
- The response already contains only sanitized material: `preview` (sanitized rows), `text` (when you ask for `inlineText`), and `mappingEncrypted` (opaque ciphertext). Those are safe to look at.
- `/restore` never returns the real values — it writes them to `out`. Do not read or display that file.
- Never send a passphrase: the API does not accept one. The user's passphrase stays inside the server process.

## Commands

The CLI lives at `src/sa.mjs` inside this skill folder.

```bash
node src/sa.mjs inspect  <file>                                   # columns + guessed entities (no cell data)
node src/sa.mjs sanitize <file> --auto -o <out> -m <mapping>      # passphrase via stdin/env
node src/sa.mjs restore  <file> --mapping <file> -o <out>
node src/sa.mjs serve    --port 8787                              # local HTTP API (the user starts this, not you)
node src/sa.mjs prompt                                            # instruction to give the AI
```

Entities: `person, company, email, phone, address, custom`.
Formats: `.csv .tsv .xlsx .xls` (sheets), `.txt .md` (text, restore only).

## Hardening the harness (recommended)

Instructions are only a soft guarantee. To stop the agent from reading the raw folder *at all*, install the permission guard so the check happens outside the model:

```bash
node guard/install-claude-guard.mjs ./raw --bash
```

This merges `deny` rules into `.claude/settings.json` (Claude Code) blocking `Read` of the raw folder and the file-dumping commands. See `guard/claude-settings.example.json`.

## Notes

- Labels are unique per value per entity and stable, so identical originals always map to the same label.
- If the AI paraphrases a label, restore cannot match it — hence `sa prompt`.
- No outbound network access, no telemetry. Nothing leaves the machine. `sa serve` only listens on `127.0.0.1`, and only while the user runs it.
- The same mapping file works with the CLI, the local API, and the web app at <https://safe.ainabler.my.id/> — mix them freely.
