/**
 * Collects costs of Claude Code workflow runs from GitHub Actions job logs.
 *
 * For each configured (repo, workflow) pair, lists workflow runs, downloads the
 * logs of the job that ran Claude, and extracts the cost:
 *   - `"total_cost_usd": 1.234` — result JSON logged by claude-code-action (precise)
 *   - `... ($1.23).` — summary line logged by the code-review workflow (rounded)
 *
 * Records are appended to one NDJSON file per repo in the data dir, deduplicated
 * by run id. Incremental by default (re-scans a small overlap window); use
 * --since YYYY-MM-DD for a backfill.
 *
 * Usage: GITHUB_TOKEN=... node scripts/collect.js [--since YYYY-MM-DD]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(rootDir, 'config.json'), 'utf8'));
const dataDir = join(rootDir, config.dataDir);

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error('GITHUB_TOKEN environment variable is required');
  process.exit(1);
}

const sinceArg = process.argv.indexOf('--since');
const overrideSince = sinceArg > -1 ? process.argv[sinceArg + 1] : null;

const API = 'https://api.github.com';
const CONCURRENCY = 6;
// Re-scan window so runs that were in progress during the last collection get picked up
const OVERLAP_MS = 3 * 24 * 60 * 60 * 1000;

async function ghFetch(url, { asText = false } = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
    });
    if (res.status === 404 || res.status === 410) return null;
    if (res.ok) return asText ? res.text() : res.json();
    // Rate limit: wait until reset, then retry
    const remaining = res.headers.get('x-ratelimit-remaining');
    if ((res.status === 403 || res.status === 429) && remaining === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
      const waitMs = Math.max(5000, reset - Date.now() + 2000);
      console.warn(`Rate limited, waiting ${Math.round(waitMs / 1000)}s...`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (attempt < 3 && res.status >= 500) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    throw new Error(`GitHub API ${res.status} for ${url}: ${await res.text()}`);
  }
}

// The runs listing caps at 1000 results per query, so when a window fills up,
// narrow it to end at the oldest date received and query again.
async function* listRuns(repo, workflow, sinceIso) {
  const seen = new Set();
  let until = null;
  for (;;) {
    const created = encodeURIComponent(until ? `${sinceIso}..${until}` : `>=${sinceIso}`);
    let count = 0;
    let oldest = null;
    let lastPageFull = true;
    for (let page = 1; page <= 10 && lastPageFull; page++) {
      const data = await ghFetch(
        `${API}/repos/${repo}/actions/workflows/${workflow}/runs?created=${created}&per_page=100&page=${page}`
      );
      if (!data) return; // workflow doesn't exist in this repo (yet)
      for (const run of data.workflow_runs) {
        count++;
        oldest = run.created_at; // runs are listed newest-first
        if (!seen.has(run.id)) {
          seen.add(run.id);
          yield run;
        }
      }
      lastPageFull = data.workflow_runs.length === 100;
    }
    if (count < 1000) return;
    const nextUntil = oldest.slice(0, 10);
    if (nextUntil === until) {
      console.warn(`${repo} ${workflow}: more than 1000 runs on ${until}, cannot list them all`);
      return;
    }
    until = nextUntil;
  }
}

const COST_JSON_RE = /"total_cost_usd":\s*([0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/;
const COST_SUMMARY_RE = /\(\$([0-9]+(?:\.[0-9]+)?)\)/g;
const NUM_TURNS_RE = /"num_turns":\s*([0-9]+)/;

function parseCost(log) {
  const json = log.match(COST_JSON_RE);
  if (json) return { cost: Number(json[1]), precise: true };
  const summaries = [...log.matchAll(COST_SUMMARY_RE)];
  if (summaries.length > 0) {
    return { cost: Number(summaries[summaries.length - 1][1]), precise: false };
  }
  return null;
}

async function collectRun(repo, workflowFile, run) {
  const jobsData = await ghFetch(`${API}/repos/${repo}/actions/runs/${run.id}/jobs?per_page=50`);
  if (!jobsData) return null;
  // The Claude job is the long-running one; try jobs by duration, longest first
  const candidates = jobsData.jobs
    .filter((j) => j.conclusion && j.conclusion !== 'skipped' && j.started_at && j.completed_at)
    .sort(
      (a, b) =>
        new Date(b.completed_at) - new Date(b.started_at) - (new Date(a.completed_at) - new Date(a.started_at))
    );
  for (const job of candidates) {
    const log = await ghFetch(`${API}/repos/${repo}/actions/jobs/${job.id}/logs`, { asText: true });
    if (!log) continue;
    const parsed = parseCost(log);
    if (!parsed) continue;
    const turns = log.match(NUM_TURNS_RE);
    return {
      run_id: run.id,
      repo,
      workflow: workflowFile.replace(/\.ya?ml$/, ''),
      url: run.html_url,
      created_at: run.created_at,
      event: run.event,
      conclusion: run.conclusion,
      actor: run.actor?.login ?? null,
      pr: run.pull_requests?.[0]?.number ?? null,
      title: run.display_title ?? null,
      duration_s: Math.round((new Date(job.completed_at) - new Date(job.started_at)) / 1000),
      cost_usd: parsed.cost,
      precise: parsed.precise,
      num_turns: turns ? Number(turns[1]) : null,
    };
  }
  return null;
}

function repoFile(repo) {
  return join(dataDir, `${repo.replace('/', '-')}.ndjson`);
}

function loadRecords(repo) {
  const file = repoFile(repo);
  if (!existsSync(file)) return new Map();
  const records = new Map();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    records.set(rec.run_id, rec);
  }
  return records;
}

function saveRecords(repo, records) {
  const sorted = [...records.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  writeFileSync(repoFile(repo), sorted.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return sorted;
}

async function pool(items, worker) {
  const results = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < items.length) {
        const item = items[next++];
        results.push(await worker(item));
      }
    })
  );
  return results;
}

mkdirSync(dataDir, { recursive: true });
const manifest = { generated_at: new Date().toISOString(), repos: [] };

for (const source of config.sources) {
  const records = loadRecords(source.repo);
  let added = 0;

  for (const workflow of source.workflows) {
    const existing = [...records.values()].filter((r) => r.workflow === workflow.replace(/\.ya?ml$/, ''));
    let since;
    if (overrideSince) {
      since = overrideSince;
    } else if (existing.length > 0) {
      const latest = existing.reduce((max, r) => (r.created_at > max ? r.created_at : max), '');
      since = new Date(new Date(latest).getTime() - OVERLAP_MS).toISOString().slice(0, 10);
    } else {
      since = new Date(Date.now() - config.defaultBackfillDays * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
    }

    const toCollect = [];
    let listed = 0;
    for await (const run of listRuns(source.repo, workflow, since)) {
      listed++;
      if (run.status !== 'completed') continue;
      if (run.conclusion === 'skipped') continue;
      if (records.has(run.id)) continue;
      toCollect.push(run);
    }
    console.log(`${source.repo} ${workflow}: ${listed} runs since ${since}, ${toCollect.length} new to check`);

    const collected = await pool(toCollect, (run) => collectRun(source.repo, workflow, run));
    for (const rec of collected) {
      if (!rec) continue;
      records.set(rec.run_id, rec);
      added++;
    }
  }

  const sorted = saveRecords(source.repo, records);
  console.log(`${source.repo}: ${added} new records, ${sorted.length} total`);
  manifest.repos.push({
    repo: source.repo,
    file: `${source.repo.replace('/', '-')}.ndjson`,
    records: sorted.length,
    from: sorted[0]?.created_at ?? null,
    to: sorted[sorted.length - 1]?.created_at ?? null,
  });
}

writeFileSync(join(dataDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('Done.');
