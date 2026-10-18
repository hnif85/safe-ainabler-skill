# Safe Ainabler — agent skill

An [agent skill](https://opencode.ai/docs/skills) + CLI that lets an AI agent **sanitize sensitive data before it reaches a model, then restore the real values afterwards**.

Names, companies, emails, phones, and addresses are replaced with neutral labels (`PERSON_001`, `EMAIL_001`, …) and the originals are stored in an **encrypted mapping file** (`*.safe-ainabler`, PBKDF2 + AES-GCM). After the AI answers, the mapping turns the labels back into the real values. Everything runs locally — no server, no telemetry.

Format-compatible with the Safe Ainabler web app.

## Install

### Option A — ask your agent to install it
Paste this into Claude Code, opencode, Cursor, Codex, or any agent that can run shell commands:

```text
Install the "safe-ainabler" skill for me.

1. Find my agent's skills directory and create the folder "safe-ainabler" inside it:
   - Claude Code:      ~/.claude/skills/safe-ainabler
   - opencode:         ~/.config/opencode/skills/safe-ainabler
   - other harnesses:  ~/.agents/skills/safe-ainabler
   If you're unsure which applies, ask me first.
2. Download the skill into that folder:
   git clone https://github.com/hnif85/safe-ainabler-skill.git "<that folder>"
3. Install the spreadsheet dependency (enables .xlsx/.xls):
   cd "<that folder>" && npm install
4. Verify it works: run `node src/sa.mjs help` inside the folder and show me the output.
5. Confirm the skill is available and tell me one example command.
```

### Option B — install manually
```bash
git clone https://github.com/hnif85/safe-ainabler-skill.git ~/.claude/skills/safe-ainabler
cd ~/.claude/skills/safe-ainabler
npm install        # only needed for .xlsx/.xls files
node src/sa.mjs help
```

Requirements: Node.js >= 18 (or Bun). `.csv`/`.tsv` work with no dependencies.

## Usage

```bash
node src/sa.mjs inspect  data.xlsx
node src/sa.mjs sanitize data.xlsx --auto -p "my passphrase"
node src/sa.mjs prompt
node src/sa.mjs restore  ai_output.xlsx --mapping data_mapping.safe-ainabler -p "my passphrase"
```

`sanitize` writes `data_sanitized.xlsx` + `data_mapping.safe-ainabler`. `restore` writes `ai_output_restored.xlsx`.

| Command | What it does |
| --- | --- |
| `inspect <file>` | Lists column names + guessed entity types. No cell data. |
| `sanitize <file>` | Writes the sanitized file + encrypted mapping. |
| `restore <file> --mapping <file>` | Decrypts the mapping and restores real values. |
| `serve` | Runs the local HTTP API for agents (see below). |
| `prompt` | Prints the instruction to give the AI so it keeps labels verbatim. |
| `help` | Full option list. |

Options: `-o/--out`, `-m/--mapping`, `-p/--passphrase`, `--passphrase-env <VAR>` (env `SAFE_AINABLER_PASSPHRASE` is also read), `--columns "Name=person,Email=email"`, `--auto`.

Entities: `person, company, email, phone, address, custom`.
Formats: `.csv .tsv .xlsx .xls` (sheets), `.txt .md` (text, restore only).

## Local API (for agents that can't read files)

Some harnesses can make HTTP calls but must not read the file themselves. Let the user start the local API — it holds the passphrase and reads the raw file on the agent's behalf:

```bash
scripts/serve-user.sh --port 8787     # the user runs this; they type the passphrase once, hidden
```

It prints a URL and a bearer token, and writes `.safe-ainabler/serve.json`:

```json
{ "url": "http://127.0.0.1:8787", "token": "…" }
```

```bash
TOKEN=…

# Sanitize by path — the server reads the file, so the raw bytes never reach the agent
curl -s -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
     -d '{"path":"data.xlsx","columns":"Name=person,Email=email"}' \
     http://127.0.0.1:8787/sanitize

# Restore — writes the real values to disk and returns only a summary
curl -s -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
     -d '{"path":"ai_output.xlsx","mappingPath":"data_mapping.safe-ainabler","out":"ai_output_restored.xlsx"}' \
     http://127.0.0.1:8787/restore
```

`GET /health` needs no token; everything else needs `Authorization: Bearer <token>` (or `X-Safe-Token`).

| Endpoint | Body | Returns |
| --- | --- | --- |
| `GET /health` | — | status, version, whether a passphrase is loaded |
| `POST /sanitize` | `{ path }` or a multipart `file`; optional `columns`, `out`, `mappingOut`, `inlineText`, `previewRows` | sanitized file on disk, `preview` (sanitized rows), `mappingEncrypted` (opaque) |
| `POST /restore` | `{ path }` / `{ text, format }` / multipart `file`, plus `mappingPath` or `mapping`, and `out` | the restored file **on disk** — a path and a summary, never the values |

What keeps the promise intact:

- **Passphrase once, at startup, by the user.** The API never accepts a passphrase per request, never logs it, and never returns it.
- **`path` beats upload.** The server reads the file; the raw bytes stay out of the agent's context.
- **`/restore` never echoes real values.** They can only be written to `out`, so an agent cannot pull them into a conversation by accident.
- **Token-guarded and localhost-only.** Binds `127.0.0.1`, requires a random bearer token so other local processes can't drive it, and never logs request bodies.

## How it protects the agent's context

The point is that the model never sees the originals:

```
raw file ──sanitize──▶ sanitized file (labels) ──▶ AI ──▶ output ──restore──▶ real values
      └─▶ encrypted mapping (stays on disk, never sent)
```

An agent will happily read the raw file anyway unless something stops it, so the skill layers four defences:

1. **Instructions (soft).** `SKILL.md` forbids reading the raw file and allows only `sa inspect`, which prints column *names* and never any cell data.
2. **Permission guard (hard).** Block the agent's access outside the model, so it cannot talk its way past it:
   ```bash
   node guard/install-claude-guard.mjs ./raw --bash
   ```
   Merges `deny` rules into `.claude/settings.json` that block `Read` of the raw folder (and, with `--bash`, the file-dumping commands). See `guard/claude-settings.example.json`.
3. **User-run wrappers (strongest).** Let the user own both the passphrase and the raw file, so neither ever reaches the agent:
   ```bash
   scripts/sanitize-user.sh data.xlsx --auto
   scripts/restore-user.sh  ai_output.csv --mapping data_mapping.safe-ainabler
   ```
   The passphrase is read with a hidden prompt and piped over stdin (`--passphrase-stdin`) — never in argv, never in the environment, never echoed.
4. **Local API (zero file access).** When the agent can't be trusted with the filesystem at all, the user runs `scripts/serve-user.sh` and the agent only ever talks HTTP to it. The server reads the file on the agent's behalf and `/restore` writes real values to disk instead of returning them — see [Local API](#local-api-for-agents-that-cant-read-files).

For genuinely sensitive data the cleanest option is to keep the sanitize step **outside** the agent entirely (run the wrapper or use the web app at <https://safe.ainabler.my.id/>) and hand the agent only the sanitized file.

## Repository layout
```
SKILL.md                        agent instructions (what to do, what is forbidden)
src/sa.mjs                      CLI: inspect | sanitize | restore | serve | prompt
src/server.mjs                  local HTTP API (sanitize/restore) for agents
src/engine.mjs                  sanitize/restore + PBKDF2→AES-GCM encryption
scripts/sanitize-user.sh        user-run wrapper (hidden passphrase prompt)
scripts/restore-user.sh         user-run wrapper
scripts/serve-user.sh           user-run wrapper that starts the local API
guard/install-claude-guard.mjs  merge deny rules into .claude/settings.json
guard/claude-settings.example.json
test/roundtrip.mjs              CLI sanitize → restore round-trip
test/api.mjs                    local API: auth, sanitize, restore, no leaks
vendor/xlsx.mjs                 bundled SheetJS (Apache-2.0) for .xlsx support
```


## Test
```bash
npm test
```
Runs a CLI sanitize → restore round-trip (and checks a wrong passphrase is rejected), then the local API: health, token enforcement, sanitize by path and by upload, restore, and that no response ever carries the real values.

## Security notes
- Mapping is encrypted with PBKDF2-SHA256 (210,000 iterations) → AES-GCM-256.
- The passphrase is never stored. Lose it and the mapping is unrecoverable.
- No outbound network calls at any point. `sa serve` only listens on `127.0.0.1`.

## License
MIT. Bundles SheetJS (`xlsx`, Apache-2.0) for spreadsheet support when installed.
