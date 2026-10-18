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
| `prompt` | Prints the instruction to give the AI so it keeps labels verbatim. |
| `help` | Full option list. |

Options: `-o/--out`, `-m/--mapping`, `-p/--passphrase`, `--passphrase-env <VAR>` (env `SAFE_AINABLER_PASSPHRASE` is also read), `--columns "Name=person,Email=email"`, `--auto`.

Entities: `person, company, email, phone, address, custom`.
Formats: `.csv .tsv .xlsx .xls` (sheets), `.txt .md` (text, restore only).

## How it protects the agent's context
The point is that the model never sees the originals:

```
raw file ──sanitize──▶ sanitized file (labels) ──▶ AI ──▶ output ──restore──▶ real values
      └─▶ encrypted mapping (stays on disk, never sent)
```

So the agent should **never read the raw file** — only the sanitized one. The skill's instructions enforce this.

## Test
```bash
npm test
```
Runs a sanitize → restore round-trip and checks that a wrong passphrase is rejected.

## Security notes
- Mapping is encrypted with PBKDF2-SHA256 (210,000 iterations) → AES-GCM-256.
- The passphrase is never stored. Lose it and the mapping is unrecoverable.
- No network calls at any point.

## License
MIT. Bundles SheetJS (`xlsx`, Apache-2.0) for spreadsheet support when installed.
