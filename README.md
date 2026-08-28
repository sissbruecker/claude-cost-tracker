# Claude Cost Tracker

Collects and visualizes the costs of Claude Code GitHub workflow runs (code
reviews and comment-triggered runs) across Vaadin repositories.

**Dashboard:** served via GitHub Pages from [`docs/`](docs/) — total, average,
median, and p90 cost per run, weekly or monthly, filterable per repository.

## How it works

- [`scripts/collect.js`](scripts/collect.js) lists workflow runs for the
  (repo, workflow) pairs in [`config.json`](config.json), downloads the job logs
  of each run, and extracts the cost:
  - `"total_cost_usd": 1.234` — the result JSON logged by `claude-code-action`
    (exact value)
  - `... ($1.23).` — the summary line logged by the code-review workflow
    (rounded to cents)
- Records are stored as NDJSON files in [`docs/data/`](docs/data/), one file per
  repository, committed to this repo. Git is the database — volume is a few
  hundred records per month.
- [`.github/workflows/collect.yml`](.github/workflows/collect.yml) runs the
  collector daily and commits new records. The default `GITHUB_TOKEN` is enough
  since the tracked repos are public — no secrets needed.
- The dashboard ([`docs/index.html`](docs/index.html)) is a static page that
  reads the NDJSON files. Chart.js is vendored in
  [`docs/vendor/`](docs/vendor/), so the page has no external dependencies.

### Why job logs?

GitHub exposes no API for the run summary shown in the Actions UI, and the
execution artifacts uploaded by the workflows expire after 7 days (and are
opt-in). Job logs are retained for 90 days (the repo default) and contain the
cost in both workflow types, so the collector uses those. The daily schedule
keeps collection well within the retention window; history beyond 90 days lives
in the committed data files.

## Running locally

```bash
GITHUB_TOKEN=$(gh auth token) node scripts/collect.js
```

Incremental by default (re-scans a 3-day overlap window past the newest stored
record per repo/workflow). For a backfill:

```bash
GITHUB_TOKEN=$(gh auth token) node scripts/collect.js --since 2026-07-01
```

View the dashboard:

```bash
npx serve docs
```

## Adding a repository or workflow

Add an entry to `config.json`. Workflows that don't exist in a repo (yet) are
skipped gracefully, so `vaadin/flow` already lists `code-review.yml` for
whenever it gets enabled there.

## Record format

One JSON object per line in `docs/data/<owner>-<repo>.ndjson`:

| Field | Description |
| --- | --- |
| `run_id`, `url`, `created_at`, `event`, `conclusion` | Workflow run metadata |
| `repo`, `workflow` | Source repo and workflow (`code-review` / `claude`) |
| `actor`, `pr`, `title` | Who/what triggered the run |
| `duration_s` | Duration of the Claude job |
| `cost_usd` | Extracted cost |
| `precise` | `true` if from `total_cost_usd`, `false` if from the rounded summary line |
| `num_turns` | Number of agent turns, when present in the log |
