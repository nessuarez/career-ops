# Feature: job-alerts local ingest plugin (formerly gmail-titles)

## Objective
Local plugin `plugins.local/job-alerts` (renamed from `gmail-titles` in T9; own processed-id cursor) that reads the same Gmail
label as the bundled `gmail` plugin but takes the job title printed just before each offer
link in the email (JobLeads first), so pipeline rows carry real titles instead of the
placeholder `Job lead (email)`. The bundled `gmail` plugin is disabled in the data-root
`config/plugins.yml`; the new plugin is enabled in its place.

## Problem / why
- `plugins/gmail/index.mjs:155` sets `title: seed?.role || 'Job lead (email)'`; the title can
  only come from the email subject (`parseRoleAtCompany`), and URLs are swept with a regex
  (`extractUrls`) that ignores the surrounding text.
- 12 JobLeads `/es/job/…` offers sit unchecked in the data-root `data/pipeline.md` with no
  title or company.
- `plugins/gmail` is a bundled seed: `update-system.mjs` overwrites local edits, and bundled
  plugins win an id collision with `plugins.local/`, so the replacement needs a different id.

## Scope / constraints
- Authorized: new files under `plugins.local/gmail-titles/`; edit the data-root
  `config/plugins.yml` to disable `gmail` and enable the new plugin; tests for the plugin;
  one read-only fetch of a JobLeads email to learn its markup (user approved 2026-10-26).
- NOT authorized: editing bundled `plugins/gmail`; running the plugin for real (it writes
  `data/pipeline.md`; use `--dry-run`); backfilling titles of the 12 pending rows (follow-up,
  needs the user's go-ahead).
- Own cursor: `data/gmail-titles-state.json`; the old `data/gmail-state.json` is untouched.
- TDD: strict (user config "Strict TDD Mode: enabled"). Runner: `node:test`-style standalone
  test under `plugins.local/gmail-titles/test/`, following `plugins/_template/test/smoke.mjs`.
- Delivery: `plugins.local/`, `config/plugins.yml` and `plugins.lock` are gitignored
  (`.gitignore:120-123`, confirmed by the mapper), so there is no work-unit commit in this
  repo. Forecast ~300 authored lines, under the 400-line slice budget.

## Findings (T1 + T2)
- Email markup (JobLeads saved-search alert), plain-text part:
  `Title` / `- country` / `- remote|in_person` / `- salary` / `- full_time|part_time` /
  optional `- free text` / `Mostrar trabajo: URL`, blocks separated by a blank line. The HTML
  part only has a `Mostrar trabajo` CTA anchor; the title is in an earlier cell. Each offer
  URL appears twice (text + HTML), 5 distinct offers in the sampled email.
- Manifest: `id` = dirname, `apiVersion:1`, `hooks:["ingest"]`, `jobPostings:true`,
  `requiredEnv` GMAIL_*, `allowedHosts` oauth2/gmail googleapis, `humanInTheLoop:true`.
- Lock: any changed/added/removed file in a local plugin without a manifest `version` bump is
  `drift-nobump` (plugin skipped, 0 found) until `node plugins.mjs trust gmail-titles`.
  Tests inside the plugin dir are hashed too. No lock entry auto-pins on first load.
- Engine skips already-seen URLs silently (scan-history, pipeline incl. `[x]`, applications),
  with no title update. The first run of the new plugin (empty cursor) re-reads the whole
  `days_back` window but every already-ingested URL is "already seen".
- With `jobPostings:true` the admission gate applies `data/blacklist.md` and portals.yml
  `title_filter` / `location_filter`; real titles become filterable, so some offers may now
  be dropped at admission.
- Ingest hook has a 15 s timeout for the whole hook (not overridable by the plugin).
- `plugins.mjs enable <id> --confirm` rewrites `config/plugins.yml` with `yaml.dump`
  (comments lost). There is no `disable` subcommand: set `gmail.enabled: false` by hand.

## Design decisions
- id `gmail-titles`; reuse `isAuthenticEmail`, `isCleanUrl`, `extractUrls`,
  `parseRoleAtCompany`, `companyFromUrl`, `decodeQuotedPrintable` from the bundled
  `../../plugins/gmail/_helpers.mjs` (no copy of the DMARC logic).
- Title strategy: plain-text block (walk up from the URL line past `- ` bullets to the title
  line) first, HTML anchor text second (generic CTAs ignored), then subject seed, then the
  placeholder.
- `location` stays empty (a guessed location could be dropped by `location_filter`).
- Time budget `time_budget_ms` (default 12000) with bounded concurrency; messages not
  processed in time are NOT marked processed.

## Tasks
- [x] T1 — map plugin contract, trust/lock flow, config location, ctx API, test conventions
      (delegated read-only mapper; report received).
- [x] T2 — inspect the real JobLeads email markup (done with the user's approval; the sampled
      body was deleted from the scratchpad afterwards).
- [x] T3 — RED: 61 of 74 tests failing on stubs (all missing behavior), per the writer.
- [x] T4 — GREEN: `index.mjs`, `_helpers.mjs`, `manifest.json`, `skill.md`, `test/*`.
      Parent re-ran `node --test "plugins.local/gmail-titles/test/*.mjs"`: 74/74 pass;
      `git status` unchanged (plugins.local ignored); bundled `plugins/gmail` untouched.
- [x] T5 — config switch by hand in the data-root `config/plugins.yml` (backup kept in the
      scratchpad): `gmail.enabled: false`, new `gmail-titles` block (label job-leads-manual,
      days_back 7). `plugins.mjs list` shows gmail disabled, gmail-titles enabled.
- [x] T7 — FIX: first real dry-run (357 found, 17 new, 197 already seen, 96 title filter)
      showed Jobsora cards giving glued titles ("…PlatformSiemens Energy, MadridRecién
      publicado"): the HTML anchor holds [title][company, city][age] with no whitespace
      between elements. Fix: `anchorChunks` splits at glued tag boundaries (`<br>` always),
      the first chunk is the title; version 1.0.1. RED 10/86 failing (reproduced the glued
      strings exactly), GREEN 86/86. One existing test edited (its `<br>EU` tail contradicted
      the new rule); `<br>` now has its own test.
- [x] T6 — verified by the parent: `node --test "plugins.local/gmail-titles/test/*.mjs"`
      86/86; `plugins.lock` re-pinned silently at 1.0.1; dry-run (357 found, 17 new) now lists
      clean Jobsora titles ("AI Engineer – Agentic Development Platform", "AI Engineer",
      "Customer-Facing AI Engineer: Full-Stack & ML", …); git status unchanged; bundled
      `plugins/gmail` untouched. JobLeads titles on real data still unconfirmed (Open points).

- [x] T8 — backfill the title of the 12 pending JobLeads rows of the data-root
      `data/pipeline.md` (user approved 2026-10-26, "con vista previa antes de escribir nada").
      Plan: one-off scratchpad script re-reads the label's JobLeads emails read-only, reuses
      the plugin's `getMessageParts` + `extractTitledLinks`, matches rows by offer path (the
      hash after `/es/job/`), prints a preview, writes `backfill-plan.json` (line, old, new).
      Only after the user confirms the preview: back up `pipeline.md`, then replace the tail
      ` |  | Job lead (email)` of exactly those lines (CRLF preserved, each line re-verified
      before replacing). Rows are `[ ]` only; `[x]` rows, scan-history and the tracker stay.
      Preview done (read-only, 20 JobLeads emails scanned): 12 of 12 titles found, no
      conflicts, one title sanitized by the engine's `sanitizeMarkdownField` (`|` → `/`). This
      is the first confirmation of the JobLeads text parser on real mail. Four rows share the
      title "Sr. Full-Stack Software Engineer - Remote" but are different offers (different
      region/hash in the slug). Plan file in the scratchpad (`backfill-plan.json`).
      APPLIED after the user's confirmation, and after the pull they asked for first: the
      data repo (`career-ops-personal`, main) was already up to date (`git pull --ff-only`:
      "Already up to date"); the code repo is 0/0 with origin/main and was NOT pulled (it is
      650 commits behind `upstream/main`, which is the normal update-system flow). The apply
      script located each row by exact old content (not line number), backed up to
      `data/pipeline.md.pre-title-backfill.bak` (untracked in the data repo), preserved CRLF,
      and verified from disk: same line count, exactly the 12 planned lines changed
      (`git diff --stat`: 12 insertions, 12 deletions). Scratchpad scripts and plan deleted.
      Nothing committed in the data repo: `config/plugins.yml` and `data/pipeline.md` are
      modified, the `.bak` is untracked.

- [x] T9 — rename `gmail-titles` → `job-alerts` (user approved 2026-10-26, after the
      generalization discussion): copy the folder, new id/name/description, error prefixes,
      comments, `skill.md`, tests, cursor file `data/job-alerts-state.json`, `plugins.yml`
      key; then `plugins.mjs remove gmail-titles` (deletes its dir, drops its lock entry and
      rewrites `plugins.yml` with `yaml.dump`) and tidy the YAML by hand. The old cursor
      `data/gmail-titles-state.json` was never saved (only `--dry-run` runs), so there is
      nothing to migrate and no legacy fallback is added; `gmail-state.json` (bundled
      plugin) is untouched. TDD: tests first (RED on the new names), then the rename (GREEN).
      Route: inline (mechanical string rename plus one cursor-path test; already understood).
      DONE and verified by the parent: RED 11 of 87 failing (manifest id vs folder, cursor
      file name, message prefixes), GREEN 87/87 (86 + 1 new test that every thrown error, log
      line and spoof warning carries the `job-alerts:` prefix). Manifest name/description,
      index.mjs header and skill.md now describe a multi-platform alert reader, and skill.md
      gained an "Adding a platform" section. `plugins.mjs remove gmail-titles` deleted the old
      folder and its lock entry and left a disabled `gmail-titles` block in `plugins.yml`
      (also dropped my comments), which was tidied by hand. Final state: `plugins.local/`
      holds only `job-alerts`; lock = gmail, job-alerts; `plugins.yml` = gmail off, job-alerts
      on (label job-leads-manual, days_back 7). No cursor was lost: `gmail-titles-state.json`
      was never written (only dry-runs); `job-alerts-state.json` appears on the first real run.
      Temporary backup copy and diagnostic script deleted from the scratchpad.

- [ ] T10 — PROPOSED, not started (needs the user's go-ahead): canonicalize JobLeads and
      Jobsora offer URLs. Read-only investigation, 2026-10-26:
      * JobLeads offer = `/{lang}/job/{slug}`; identity is the path (20 of 20 rows: the
        `utm_content` job_id equals the slug's hash). Query params are tracking: kuuid, u, t
        (constant per user), saved_search_email_id, view, utm_*, search_id, job_rank, m (per
        email), vector_distance.
      * Jobsora offer = `/oferta-{id}`; query: source=8, user (constant per user), mail (per
        email), utm_*; 15 rows carry a corrupted `mail<U+FFFD>…` param from an older
        quoted-printable bug.
      * Without tokens the offer resolves: a cookieless GET of a Jobsora offer returns a page
        titled exactly like the email, with or without `source=8`; JobLeads in a real browser
        loads the offer page (title, company, salary; that one reads "han retirado esta
        vacante"); curl gets a Cloudflare 403 either way. Tokenized links were NOT requested
        (they carry personal tokens).
      * Today `pipeline.md` has 27 JobLeads offer rows (27 distinct) and 106 Jobsora rows (74
        distinct: 32 surplus, 17 offers repeated). Tokens live only in `pipeline.md` (125 rows
        with a query) plus 2 reports and 2 `batch/tracker-additions` files (Jobsora); the
        tracker mentions neither host.
      * Core `url-key.mjs` strips only utm_* and a few others on purpose (lines 7-26,
        "under-strip on purpose"), so this belongs in the plugin, which knows the resource.
      * Last dry-run: 357 links = 187 platform offer links (128 distinct offers once
        canonical) + 167 platform non-offer links (footers, search pages, nav) + 3 other. 92
        of the 187 are recognized as seen today; emitting canonical URLs without migrating
        `pipeline.md` would make them look new; after migrating, 115 would be recognized. Of
        the 18 "new": 1 already in the pipeline (row 1626, itself a withdrawn offer), 14
        genuinely new Jobsora offers, 2 search pages, 1 repeat.
      * Plan: (1) `canonicalOfferUrl` + a rules table in the plugin, with tests, version
        1.1.0; optionally drop non-offer links of the two platforms; (2) one-time migration
        of the 125 pipeline rows (backup, preview, exact-match apply; rows kept, only URLs
        rewritten); optionally the 2 reports and 2 additions; (3) a dry-run must show the
        duplicate gone; (4) then the real run.
      * Limits: tokenized links not requested; logged-in or email-click behavior (auto-login,
        click attribution) not evaluated; a slug that differs between languages could still
        give two URLs for one offer.

- [x] T11 — first REAL run of `job-alerts` (2026-10-27, user said: do not canonicalize yet,
      run it as is). Before: `pipeline.md` 1716 lines / 4 pending rows, `scan-history.tsv`
      3863 lines, no cursor; a dry-run right before gave 363 found, 24 new (165 already seen,
      130 title filter). `node plugins.mjs run job-alerts` appended 24 rows. Verified by
      diff against a snapshot: pending rows 4 → 28; rows went at the END of the file (lines
      1718–1741, after a blank separator line), not under `## Pending`; the appended lines are
      LF-only, so the file is now mixed CRLF/LF (git's autocrlf normalizes it on the next
      touch); `scan-history.tsv` +24 rows tagged `plugin:job-alerts`; cursor
      `data/job-alerts-state.json` created with 25 processed message ids. The 24 rows: 20 new
      offers (19 Jobsora, 1 JobLeads with its real title), 3 Jobsora search-page links titled
      "ai engineer, Madrid", and 1 repeat of an offer already in the same batch (Jobsora id
      54555465841, two `mail=` tokens). Nothing removed or edited in existing rows. The
      earlier duplicate of row 1626 did not come back: its email left the 7-day window.
      Undo, if ever needed: delete the last 25 lines of `pipeline.md`, the last 24 of
      `scan-history.tsv`, and `data/job-alerts-state.json`. Snapshot and reports deleted from
      the scratchpad afterwards. Committed in the data repo as `d8b75eb` and pushed to origin/main.

- [x] T12 — remove the 4 noise rows of the first real run from the data-root `pipeline.md`
      (user asked 2026-10-27, "con vista previa y copia de seguridad antes de escribir").
      Preview done, read-only, rows taken from commit `d8b75eb` itself so older search pages
      stay: REMOVE lines 1723, 1730, 1741 (Jobsora search pages titled "ai engineer, Madrid")
      and 1734 (repeat of Jobsora offer 54555465841, different `mail=` token); KEEP line 1728
      (first row of that offer). Pending rows 28 → 24. `scan-history.tsv` has all four URLs
      with status `added` (and the cursor keeps their source messages), so they will not be
      ingested again; scan-history is not touched. Apply plan: backup to
      `data/pipeline.md.pre-noise-removal.bak`, exact-content match per line, verify from
      disk. APPLIED after the user's confirmation (2026-10-27): 4 of 4 rows located by exact content,
      backup `data/pipeline.md.pre-noise-removal.bak` (untracked), pending rows 28 → 24,
      verified from disk (line count, content equal to the original minus the 4 lines, CR
      counts); `git diff --stat`: 4 deletions in `pipeline.md`, `scan-history.tsv` untouched.
      Committed in the data repo as `e212bf6` ("chore(pipeline): remove 4 noise rows from the
      first job-alerts run"; 1 file, 4 deletions; no attribution; the `.bak` files and the
      logo cache left out). Pushed to origin/main on 2026-10-27 (`d8b75eb..e212bf6`, plain push after a fetch and a
      guard: exactly one commit ahead, none behind; 0/0 afterwards). Scratchpad script and
      plan deleted.

## Route declaration
- T1: delegated (mapping trigger — contract spans 8+ files).
- T2: inline (user's data and an access decision).
- T3–T4 and T7: delegated, one writer (writer trigger — 3+ non-trivial files); T7 went to the
  same writer through SendMessage to keep its context.
- T5–T6: inline (config of the user's data root and parent verification).

## Progress
- 2026-10-26: user chose the local-plugin option and approved the email read. T1–T9 done and
  verified by the parent (plugin 87/87 tests; backfill of 12 rows applied; renamed to
  `job-alerts`). Open: the "0 found" anomaly below.

## Proposal (2026-10-26) — DECIDED: rename to job-alerts (T9), stay local
The user proposes widening the plugin from "gmail titles" to a plugin that reads job-alert
digests from several platforms (JobLeads and Jobsora today), and asks about renaming it and
about publishing. Verified facts so far:
- The plugin code is already sender-agnostic: platform names appear only in comments of
  `_helpers.mjs`; the parsing helpers are mail-provider-agnostic, and only `index.mjs` knows Gmail.
- The core knows neither host (no match in `*.mjs`, `lib/`, `providers/`, `plugins/`).
- Publishing path (`docs/PLUGINS.md:89-130`): a new plugin is its own public repo
  `career-ops-plugin-<name>` (min files: manifest, index, README, LICENSE, skill.md,
  test/smoke.mjs) + a registration issue + a registry PR pinned to a commit. The main repo
  takes no feature PRs against bundled plugins; `supersedesBundled` only applies to the same id.
- Overlap: the registry already has an approved `linkedin-alerts` (Gmail alert emails, LinkedIn).
- Real-data evidence for URL canonicalization: the same Jobsora offer arrived twice with
  different `mail=` tokens (distinct URLs, so not deduped); URLs also carry per-user tokens.
  The data repo is PRIVATE. Canonicalizing would break the match with rows already ingested.
- Recommendation given: feasible, keep it generic + per-platform real fixtures, stay local until
  ≥3 platforms are verified, rename to `job-alerts` (no id collision in the registry).

## Open points
- JobLeads titles on real mail are now confirmed: the T8 preview recovered 12 of 12 titles from
  20 real emails with the plugin's own `extractTitledLinks`. The dry-run alone could not show
  it (it lists only NEW rows). A real ingest run has since written a JobLeads row with its real title (T11).
- Search-page links (`jobsora.com/empleos?query=…`) are still ingested as before (now with
  the anchor text as title). Not in scope; the workflow doc says to discard them.
- CORRECTION: `data/scan-history.tsv` holds no JobLeads or Jobsora rows at all (0 of 3789 rows
  with a URL), so it never carried the placeholder titles; the earlier note saying it did was
  wrong. Dedup for these offers rests on `pipeline.md`.
- Four of the 12 rows share one title but are different offers (region/hash differ in the slug).
- RESOLVED (the "0 found" anomaly after T9): the Gmail label `job-leads-manual` no longer
  exists. The user reorganized the labels into a hierarchy (`job-offers` 1532 messages,
  `job-offers/@to-process-manually` 0, `job-offers/job-digest` 89) and pointed `plugins.yml` at
  `job-offers-@to-process-manually` (bundled `gmail`, enabled again) and `job-offers-job-digest`
  (`job-alerts`). Read-only counts: old label 0 (7d and 30d); job-digest 25 (7d) / 85 (30d), 24
  of those 30d already in `gmail-state.json`. `plugins.mjs run job-alerts --dry-run` with the new
  label: 357 found, 18 new, 197 already seen, 98 title filter, clean titles. Gmail search takes
  the nested label as `job-offers-job-digest` (slashes become hyphens). The earlier 0 came from
  querying a label that no longer exists, not from the rename. The `ingest` CLI hides hook
  failures (it only prints "N found"); use `runHook` to see them.
- Duplicate evidence: of the 18 "new" rows, "AI/ML Engineer (Remote)" has the same JobLeads
  offer path as pipeline row 1626 (already backfilled) but a different tracking URL, so a real
  run would append a duplicate. Same cause as the Jobsora `mail=` tokens; per-platform URL
  canonicalization would fix it (separate step, see the Proposal section).
- The user edited `plugins.yml`: `gmail` is enabled again (label `job-offers-@to-process-manually`,
  0 messages) while the comment above it still says it is off. Both plugins are enabled on
  different labels, so their cursors do not collide. Left as the user set it.
- The first real run was done on 2026-10-27 with the user's go-ahead (T11); every later run
  also writes `data/pipeline.md` and `data/scan-history.tsv`.
- `data/job-alerts-state.json` is now tracked in the data repo like the bundled plugin's
  `data/gmail-state.json` (commit `d8b75eb`), so another machine does not re-ingest.
- Until URLs are canonicalized (T10, declined for now), the same Jobsora offer arriving in
  several emails keeps coming back as separate rows (one repeat in the first real run).
- Data repo: the first real run is committed as `d8b75eb` ("feat(pipeline): ingest 24
  job-alert offers with real titles via job-alerts"; `pipeline.md`, `scan-history.tsv`,
  `job-alerts-state.json`; no attribution), pushed to origin/main on 2026-10-27 (`991e7e8..d8b75eb`, plain push, no force; origin and
  local verified at 0/0 afterwards). The
  user had already committed `config/plugins.yml` themself (`6179937`, 10-26 14:39), so it
  needed no commit; that committed file still carries my comment saying gmail is off while it
  is enabled. Left untracked on purpose: `data/pipeline.md.pre-title-backfill.bak` and a
  web-UI logo cache file not made by this work.

## Engram mirror — PENDING
Since T12 every Engram WRITE is blocked (reads such as `mem_search` still work; retried after
the `e212bf6` commit and still blocked): the PreToolUse hook (`engram hook claude-pre-tool-use`)
fails with `unknown command: hook`, because the `engram` binary at `C:\Users\nessu\go\bin\engram`
is a dev build (`engram dev`) that has no `hook` subcommand, and the hook is configured to block
on failure. The last successful mirror is the one taken after the push of `d8b75eb`; T12, its commit
`e212bf6` and the session summary are not mirrored. This file is the source of truth; resync the topic
`odd/gmail-title-plugin/tasks` once the hook works. Nothing was bypassed: no settings changed,
no CLI writes (`engram save` has no `topic_key`, so it would create a duplicate).

## Next step
Report the commit. Decisions left to the user: fixing the stale comment in
`config/plugins.yml`; T10 canonicalization later; deleting the two `.bak` files; fixing the
Engram hook so the mirror can be resynced.
