---
name: safe-ainabler
description: Sanitize sensitive values (names, companies, emails, phones, addresses) in Excel/CSV/text before sending them to an AI model, then restore the real values afterward from an encrypted mapping file. Use when the user wants to anonymize, mask, pseudonymize, or de-identify a spreadsheet or document before pasting it into ChatGPT/Claude/any LLM, or to turn placeholder labels such as PERSON_001 back into the originals. Triggers: sanitize data, anonymize file, mask PII, pseudonymize, de-identify, clean data before AI, safe ainabler, restore placeholders, restore anonymized data.
license: MIT
---

# Safe Ainabler (CLI)

Replaces sensitive values with neutral labels (`PERSON_001`, `EMAIL_001`, `PHONE_001`, `COMPANY_001`, `ADDRESS_001`, `CUSTOM_001`) and writes an **encrypted mapping** so the originals can be restored later. Runs entirely on this machine. Same mapping format as the Safe Ainabler web app, so files are interchangeable.

## Prerequisite
- Node.js >= 18 (or Bun). For `.xlsx`/`.xls` the `xlsx` package must be installed in the skill folder (`npm install` / `bun install`); `.csv`/`.tsv` work without it.

## THE ONE RULE
**Never read the raw input file into your own context.** Do not `cat`, read, or print the original file's contents — that would defeat the purpose. Only ever look at:
- the output of `inspect` (column names only), and
- the **sanitized** file (contains labels, not real data).

Keep the mapping file and passphrase out of your context. If you must echo a passphrase, get it from the user or from an environment variable, never hardcode it.

## Commands
The CLI lives at `src/sa.mjs` inside this skill folder. Run it with `node src/sa.mjs <command>` (or `bun src/sa.mjs`).

```bash
# 1. See columns and guessed entity types (no cell data is printed)
node src/sa.mjs inspect input.xlsx

# 2. Sanitize. Auto-detects sensitive columns from the header,
#    or pass --columns explicitly.
node src/sa.mjs sanitize input.xlsx --auto -p "USER_PASSPHRASE"
node src/sa.mjs sanitize input.xlsx --columns "Full Name=person,Email=email,Phone=phone" -p "USER_PASSPHRASE"
# -> writes input_sanitized.xlsx and input_mapping.safe-ainabler

# 3. Print the instruction to give the AI
node src/sa.mjs prompt

# 4. After the AI produces output, restore the real values
node src/sa.mjs restore ai_output.xlsx --mapping input_mapping.safe-ainabler -p "USER_PASSPHRASE"
# -> writes ai_output_restored.xlsx
```

Options: `-o/--out <file>`, `-m/--mapping <file>`, `-p/--passphrase <text>`, `--passphrase-env <VAR>` (env `SAFE_AINABLER_PASSPHRASE` is also read). Entities: `person, company, email, phone, address, custom`. Formats: `.csv .tsv .xlsx .xls` (sheets), `.txt .md` (text, restore only).

Every command prints a JSON summary (paths, column→entity map, counts, credits). No raw values are ever printed.

## Workflow
1. `inspect` the input to learn the columns.
2. Ask the user for a passphrase (once). Do not store it.
3. `sanitize` → get `<base>_sanitized.<ext>` and `<base>_mapping.safe-ainabler`.
4. Send the **sanitized** file (not the original) to the AI, together with the text from `sa prompt`. Only read the sanitized file's contents if you truly must — prefer handing the file to the AI as a whole.
5. Take the AI's output file, then `restore` it with the mapping + passphrase to recover the real values.
6. Delete the mapping file when the task is done, unless the user wants to keep it. Losing the mapping (or the passphrase) means the data cannot be restored.

## Notes
- Labels are unique per value per entity and stable, so the same original always maps to the same label.
- If the AI paraphrases a label, restore cannot match it. That is why `sa prompt` insists the labels are reproduced verbatim.
- No network access, no telemetry, no server. Nothing leaves the machine.
