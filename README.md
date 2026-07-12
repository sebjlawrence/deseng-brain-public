# Second Brain Agent

An Obsidian plugin that turns an `Inbox/` folder into a self-organizing,
LLM-curated knowledge base. Drop in notes (or raw PDF/DOCX/OneNote HTML
imports), and it files, tags, concept-links, and cites them — pausing to ask
only when filing is genuinely ambiguous.

## One-time setup

1. Copy this folder into `<your vault>/.obsidian/plugins/second-brain-agent/`,
   then enable it in Obsidian → Settings → Community plugins.
2. Open its settings tab and paste a Claude API key (from
   [console.anthropic.com](https://console.anthropic.com)). The **Modules**
   list is empty by default — add your own (one per line, e.g. "Mathematics",
   "History", "Cooking") on first run. It's the same list the
   ambiguous-filing dialog offers as a dropdown, and updates automatically
   whenever you accept a new module through that dialog.
3. If you want git snapshot/push after each batch, set a **Remote URL** in
   settings and confirm `git push` auth already works from this machine
   (the plugin shells out to your local `git`). Leave it blank to skip git
   entirely — the plugin still snapshots locally via git init/commit, it
   just won't push anywhere.
4. **Only needed for PDF/DOCX/image extraction:** open a terminal in this
   plugin folder and run `npm install`. This pulls in `pdf-parse`,
   `mammoth`, `pdfjs-dist` and `nodemailer` locally so the plugin can
   `require()` them at runtime — they're deliberately kept out of `main.js`
   itself to keep it small and to make sure a missing dependency only
   disables *that* feature rather than crashing the whole plugin.
   `.md`/`.txt`/`.html` text import works without this step.
5. **Only needed for email alerts:** in the settings tab, under "Email
   alerts", set the SMTP user/password (e.g. a Gmail address with an
   [App Password](https://myaccount.google.com/apppasswords), not your
   normal password) and a notify address. Leave user/password blank to
   disable alerts entirely — everything still gets logged as an in-app
   Notice either way.

## What it does

Drop a file into `Inbox/` — a clean `.md` note, or a raw import (`.pdf`,
`.docx`, `.html`/`.htm` OneNote export, `.txt`) — and run **"Process Inbox
now"** from the command palette (or enable auto-watch in settings to have it
trigger automatically a few seconds after you save).

For each file:

1. **Snapshot** — commits the current vault state first (`before <change>`),
   so any batch is instantly revertable with `git restore .`
2. **Analyze** — Claude assigns 1–3 concept tags and exactly one module. Raw
   imports also get condensed: OCR/export noise stripped, equations repaired
   to MathJax, reformatted with headings — without aggressively summarizing
   away content.
3. **Extract images** (raw imports only) — embedded images (not whole-page
   rasters) are pulled out of PDFs, DOCX files, and HTML, deduped by content
   hash, saved to `attachments/`, and appended to the note under its own
   `## Images` section.
4. **Grow the taxonomy** — tags aren't limited to what already exists: the
   model is explicitly encouraged to mint a new, precise tag rather than
   force-fitting into a loosely related one, and is shown which existing
   tags are near the split threshold so it avoids piling onto them.
   `Maps/_Taxonomy.md` is regenerated every batch as a living index
   (tag → usage count → notes).
5. **Link vault-wide** — Claude judges genuine conceptual relevance against
   all existing notes (professor pass + LLM self-review pass — see below),
   not tag overlap, capped at 6 links (configurable). Links are added
   **bidirectionally**: the new note gets a `## Related` section, and each
   linked existing note gets the new note appended to its own `## Related`
   section too.
6. **Cite** — Claude (with web search) finds real external references for
   the note's content and adds a `## References` section.
7. **File** — moves/creates the note flat into `Modules/<Module>/`.
8. **Regenerate** — rebuilds `Maps/<Module>.md`, `Home.md`, and
   `Maps/_Taxonomy.md` from frontmatter (never hand-edited).
9. **Commit + push** — one commit per batch, timestamped, listing which
   notes were added/refreshed and how many links were made, then pushed to
   the configured remote/branch (if one is set).

Every "Process Inbox now" run then also checks the **entire existing
vault** for edits and refreshes links/citations for anything changed — see
"Vault-wide change detection" below.

If Claude can't confidently pick a module — either it's unsure between two
existing modules, or the note genuinely belongs to a new subject none of the
existing modules cover — the pipeline pauses and opens an **in-app dialog**
instead of guessing:

- Shows the reason, and Claude's suggested new module name if it has one.
- Lets you pick an existing module from a dropdown, **or** type a new module
  name.
- **"File note"** files this note into whatever you chose; if you typed a
  new module name, it's added to the settings module list immediately.
- **"Skip for now (leave in Inbox)"** leaves the file untouched, logs it to
  `Inbox/_needs-review.md`, and sends an email alert if configured.

**Note:** `Inbox/_needs-review.md` (and any other underscore-prefixed file
the agent writes into `Inbox/`) is never picked back up as a processable
note — auto-watch skips it entirely.

## Raw imports (PDF / DOCX / OneNote HTML / txt)

- The full raw extracted text is always saved to
  `attachments/<name>-raw-import.md` *before* any truncation or
  condensation, so nothing is ever lost even if the model's output gets cut
  off on a very large source.
- **Embedded images ARE extracted** (PDF via `pdfjs-dist`'s operator list —
  only actual figures/diagrams, not full-page screenshots; DOCX via
  `mammoth`'s image hook; HTML via inline base64 `<img>` tags and
  best-effort matching of relative-path `<img>` references against sibling
  files already in `Inbox/`). Saved deduped by content hash, embedded under
  a `## Images` section. **Caveat:** the PDF path relies on `pdf.js`
  internals that have shifted subtly across versions — it fails safely (note
  still gets created, just without images, logged to console) if something
  doesn't match on your installed version.
- Very large sources are capped at ~30,000 characters per LLM call; the note
  documents when it was truncated, and the full text remains in the
  raw-import backup regardless.

## Concept-based linking (professor pass + LLM self-review)

Notes are linked by genuine conceptual relevance, not tag overlap. Every
note's `## Related` section is set by asking Claude to act as a subject
expert curating cross-references: it links notes whose **key concepts**
genuinely relate, and explicitly excludes "noise" links — two notes just
sharing a generic tag, or both having an "introduction" section, earns
nothing. A second pass, in the same call, re-examines the full candidate
list from an LLM-reasoning angle — "would this pairing genuinely help
recall or understanding?" — and adds anything that clears that bar even if
it wasn't an obvious first-pass pairing. Links are bidirectional and
self-healing: if a relink pass decides a previously-added link no longer
earns its place, the reverse link is removed from the other note too.

## Web citations

Every note — new ones filed from Inbox, and existing ones picked up by the
vault-wide change check — gets a `## References` section built by asking
Claude (with Anthropic's server-side web search tool) to find up to 5
genuinely relevant external sources for what's actually written in the
note. If nothing suitable turns up, or the lookup fails, the note is left
without a References section rather than padded with tangential links.

## Vault-wide change detection

Every "Process Inbox now" run also checks **every existing note in
`Modules/`** — not just what's sitting in `Inbox/` — for edits since the
last check, and reruns concept-linking + citations only for notes that have
actually changed. This is done by hashing each note's own prose
(frontmatter and the agent-generated `## Related`/`## References` sections
are excluded from the hash), so the agent's own writes never look like a
user edit on the next run. The first run after this feature ships has no
stored hash for any note yet, so it naturally treats the whole vault as
"changed" and performs a one-time full relink + citation pass; every run
after that only touches what you've actually edited.

### Cost

This feature makes real Claude API calls, so it isn't free. Using Claude
Sonnet pricing ($3/$15 per million input/output tokens) and Anthropic's web
search tool ($10 per 1,000 searches):

- **Concept-linking a single note**: roughly **$0.01**.
- **Citing a single note** (with web search, up to 5 searches): roughly
  **$0.04–0.05**.
- **A full-vault pass** (first run, or after "Force full vault refresh"):
  roughly **$0.05–0.06 × however many notes are in `Modules/`** — e.g. a
  100-note vault is roughly $5–6.

These are estimates — actual cost depends on note length and how many web
searches Claude uses. Check
[Anthropic's pricing page](https://platform.claude.com/docs/en/about-claude/pricing)
for current rates. Steady-state cost after the first full pass is small —
proportional to how many notes you edit between runs, not vault size.

## Concept-tag taxonomy

The taxonomy isn't fixed — it's meant to grow as the vault grows. Both
prompts show the model the full current taxonomy with usage counts, and
explicitly instruct it to prefer minting a new, precise tag over stretching
an existing one to fit, especially once a tag nears the configurable split
threshold (default 20). `Maps/_Taxonomy.md` is regenerated every batch and
flags any tag that's crossed the threshold.

## Email alerts

If something goes wrong — text couldn't be extracted, condensation/tagging
failed, a filing was too ambiguous to resolve, or a git commit/push failed —
the plugin sends a short email to the configured address (in addition to
the in-app Notice, which always fires regardless). No SMTP credentials
means no emails; nothing else is affected.

## Commands

- **Process Inbox now** — runs the full pipeline over everything in
  `Inbox/`, then checks the whole vault for edited notes.
- **Process current note as new inbox item** — runs it on whatever note you
  have open.
- **Regenerate Maps/, Home.md and the taxonomy index** — rebuild derived
  files without touching Inbox.
- **Ask the vault a question** — opens a dialog to ask anything about your
  notes. See below.
- **Force full vault refresh** — clears the change-tracking hash for every
  note, so the next "Process Inbox now" redoes every note's links and
  citations from scratch.

## Ask the vault

Type a question and the plugin scores every note by keyword overlap against
its title, tags, and summary (tags weighted highest, since they're curated
concept labels) — no embeddings or external index needed. The top matches
(up to 8 notes, ~12,000 chars combined) are read in full and sent to Claude
as context.

Your notes are treated as the **primary source**: if they answer the
question, Claude answers from them alone and cites the specific notes with
`[[wikilinks]]`. If your notes only partially cover it, or don't cover it at
all, Claude is allowed to supplement with general knowledge to give a
complete answer — but it's instructed to keep the two visibly separate
rather than blending outside knowledge in as if it came from the vault.

If nothing in the vault matches the question's keywords, Claude says so
before falling back to general knowledge.

## Expected vault structure

The plugin assumes:

- `Inbox/` — where you drop new notes/imports.
- `Modules/<Module>/` — filed notes live here, flat (no sub-folders).
- `Maps/<Module>.md` — a Map of Content per module, regenerated every batch.
- `attachments/` — extracted images and raw-import backups.

These folder names are all configurable in settings.

## Rebuilding from source

```
npm install
npm run build   # writes main.js
```

Edit `main.ts`, then rebuild. `main.js` is what Obsidian actually loads.

## Privacy

Your Claude API key and any SMTP credentials are stored locally in the
vault's `.obsidian/plugins/second-brain-agent/data.json` — this file is
gitignored by default and should never be committed. Note content is sent
to Anthropic's API for analysis, tagging, linking, and citation lookups;
review [Anthropic's usage policies](https://www.anthropic.com/legal/aup) if
that's a concern for sensitive material.
