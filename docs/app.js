/* global Chart */

const REPOS = [
  { id: 'vaadin/flow-components', label: 'flow-components', cssVar: '--series-flow-components' },
  { id: 'vaadin/web-components', label: 'web-components', cssVar: '--series-web-components' },
  { id: 'vaadin/flow', label: 'flow', cssVar: '--series-flow' },
];

const WORKFLOW_LABELS = { 'code-review': 'Code review', claude: 'Claude Code' };
const WORKFLOW_OPTIONS = { 'code-review': 'Code review', claude: 'Claude Code (comments)' };

const state = { repo: '', workflow: '', range: '30', granularity: 'week' };
let allRecords = [];
let costChart = null;
let avgChart = null;

const $ = (sel) => document.querySelector(sel);

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usdCompact = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
});
const fmtCost = (v) => (v >= 10000 ? usdCompact.format(v) : usd.format(v));
const fmtDuration = (s) => (s == null ? '—' : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);

function tokens() {
  const style = getComputedStyle(document.documentElement);
  const get = (name) => style.getPropertyValue(name).trim();
  return {
    surface: get('--surface'),
    grid: get('--grid'),
    baseline: get('--baseline'),
    textSecondary: get('--text-secondary'),
    textMuted: get('--text-muted'),
    textPrimary: get('--text-primary'),
    border: get('--border'),
    series: Object.fromEntries(REPOS.map((r) => [r.id, get(r.cssVar)])),
  };
}

// ---- data loading ----

async function loadData() {
  const manifest = await (await fetch('data/manifest.json')).json();
  const files = await Promise.all(
    manifest.repos.map(async (r) => {
      const text = await (await fetch(`data/${r.file}`)).text();
      return text
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
    })
  );
  allRecords = files.flat();
  const updated = new Date(manifest.generated_at);
  $('#updated').textContent =
    `${allRecords.length.toLocaleString('en-US')} runs collected · last updated ${updated.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}`;
}

// ---- filtering & aggregation ----

function filteredRecords() {
  let cutoff = null;
  if (state.range !== 'all') {
    // Snap the window start forward to the next period boundary, so the first
    // bucket is always a complete week/month rather than a misleading partial
    const start = new Date(Date.now() - Number(state.range) * 86400000).toISOString();
    const key = nextPeriod(periodKey(start));
    cutoff = state.granularity === 'month' ? `${key}-01` : key;
  }
  return allRecords.filter(
    (r) =>
      (!state.repo || r.repo === state.repo) &&
      (!state.workflow || r.workflow === state.workflow) &&
      (!cutoff || r.created_at >= cutoff)
  );
}

function periodKey(iso) {
  const d = new Date(iso);
  if (state.granularity === 'month') {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  // Week starting Monday (UTC)
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

function nextPeriod(key) {
  if (state.granularity === 'month') {
    const [y, m] = key.split('-').map(Number);
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  }
  const d = new Date(key);
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0, 10);
}

function periodLabel(key) {
  if (state.granularity === 'month') {
    const [y, m] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  }
  return new Date(key).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function periodRange(records) {
  if (records.length === 0) return [];
  const keys = records.map((r) => periodKey(r.created_at)).sort();
  const out = [];
  for (let k = keys[0]; k <= keys[keys.length - 1]; k = nextPeriod(k)) out.push(k);
  return out;
}

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
}

function stats(records) {
  const costs = records.map((r) => r.cost_usd).sort((a, b) => a - b);
  const total = costs.reduce((a, b) => a + b, 0);
  return {
    count: costs.length,
    total,
    avg: costs.length ? total / costs.length : 0,
    median: quantile(costs, 0.5),
    p90: quantile(costs, 0.9),
    max: costs.length ? costs[costs.length - 1] : 0,
  };
}

function activeRepos() {
  return state.repo ? REPOS.filter((r) => r.id === state.repo) : REPOS;
}

// ---- rendering ----

function renderTiles(records) {
  const s = stats(records);
  const tiles = [
    { label: 'Total cost', value: fmtCost(s.total) },
    { label: 'Runs', value: s.count.toLocaleString('en-US') },
    { label: 'Average per run', value: fmtCost(s.avg) },
    { label: 'Median per run', value: fmtCost(s.median) },
    { label: 'p90 per run', value: fmtCost(s.p90), sub: '90% of runs cost less' },
    { label: 'Most expensive run', value: fmtCost(s.max) },
  ];
  $('#tiles').innerHTML = tiles
    .map(
      (t) => `<div class="tile"><div class="label">${t.label}</div><div class="value">${t.value}</div>${t.sub ? `<div class="sub">${t.sub}</div>` : ''}</div>`
    )
    .join('');
}

function renderLegend(el, repos, t) {
  el.innerHTML =
    repos.length < 2
      ? ''
      : repos.map((r) => `<span><i style="background:${t.series[r.id]}"></i>${r.label}</span>`).join('');
}

function baseScales(t, periods) {
  return {
    x: {
      stacked: true,
      grid: { display: false },
      border: { color: t.baseline },
      ticks: { color: t.textMuted, font: { size: 11 }, maxRotation: 0, autoSkip: true },
    },
    y: {
      stacked: true,
      beginAtZero: true,
      grid: { color: t.grid, lineWidth: 1 },
      border: { display: false },
      ticks: {
        color: t.textMuted,
        font: { size: 11 },
        callback: (v) => '$' + Number(v).toLocaleString('en-US'),
      },
    },
  };
}

function tooltipOptions(t, valueFmt) {
  return {
    backgroundColor: t.surface,
    titleColor: t.textPrimary,
    bodyColor: t.textSecondary,
    borderColor: t.border,
    borderWidth: 1,
    cornerRadius: 8,
    padding: 10,
    boxWidth: 8,
    boxHeight: 8,
    boxPadding: 4,
    usePointStyle: false,
    callbacks: {
      label: (ctx) => ` ${ctx.dataset.label}: ${valueFmt(ctx.parsed.y)}`,
    },
  };
}

function renderCostChart(records, t) {
  const periods = periodRange(records);
  const repos = activeRepos();
  const byKey = new Map(periods.map((p) => [p, new Map()]));
  for (const r of records) {
    const m = byKey.get(periodKey(r.created_at));
    m.set(r.repo, (m.get(r.repo) ?? 0) + r.cost_usd);
  }
  const data = repos.map((repo) => periods.map((p) => byKey.get(p).get(repo.id) ?? 0));

  // Topmost non-zero dataset per column gets the rounded data-end; segments
  // below get a 2px surface gap on top.
  const topDataset = periods.map((_, i) => {
    for (let d = repos.length - 1; d >= 0; d--) if (data[d][i] > 0) return d;
    return -1;
  });

  const datasets = repos.map((repo, d) => ({
    label: repo.label,
    data: data[d],
    backgroundColor: t.series[repo.id],
    maxBarThickness: 24,
    borderColor: t.surface,
    borderSkipped: false,
    borderWidth: (ctx) => (topDataset[ctx.dataIndex] === d ? 0 : { top: 2 }),
    borderRadius: (ctx) => (topDataset[ctx.dataIndex] === d ? { topLeft: 4, topRight: 4 } : 0),
  }));

  costChart?.destroy();
  costChart = new Chart($('#costChart'), {
    type: 'bar',
    data: { labels: periods.map(periodLabel), datasets },
    options: {
      maintainAspectRatio: false,
      animation: false,
      scales: baseScales(t, periods),
      plugins: {
        legend: { display: false },
        tooltip: { ...tooltipOptions(t, fmtCost), mode: 'index', intersect: false },
      },
    },
  });
  renderLegend($('#costLegend'), repos, t);
  $('#costChartTitle').textContent = `Total cost per ${state.granularity}`;
}

function renderAvgChart(records, t) {
  const periods = periodRange(records);
  const repos = activeRepos();
  const byKey = new Map(periods.map((p) => [p, new Map()]));
  for (const r of records) {
    const m = byKey.get(periodKey(r.created_at));
    if (!m.has(r.repo)) m.set(r.repo, []);
    m.get(r.repo).push(r.cost_usd);
  }
  const datasets = repos.map((repo) => ({
    label: repo.label,
    data: periods.map((p) => {
      const costs = byKey.get(p).get(repo.id);
      return costs ? costs.reduce((a, b) => a + b, 0) / costs.length : null;
    }),
    borderColor: t.series[repo.id],
    backgroundColor: t.series[repo.id],
    borderWidth: 2,
    tension: 0,
    spanGaps: true,
    pointRadius: 0,
    pointHoverRadius: 5,
    pointHoverBorderColor: t.surface,
    pointHoverBorderWidth: 2,
  }));

  const scales = baseScales(t, periods);
  scales.x.stacked = false;
  scales.y.stacked = false;

  avgChart?.destroy();
  avgChart = new Chart($('#avgChart'), {
    type: 'line',
    data: { labels: periods.map(periodLabel), datasets },
    options: {
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      scales,
      plugins: {
        legend: { display: false },
        tooltip: tooltipOptions(t, fmtCost),
      },
    },
  });
  renderLegend($('#avgLegend'), repos, t);
}

function renderTopRuns(records, t) {
  const top = [...records].sort((a, b) => b.cost_usd - a.cost_usd).slice(0, 10);
  $('#topRuns tbody').innerHTML = top
    .map((r) => {
      const repo = REPOS.find((x) => x.id === r.repo);
      const date = new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const title = r.title ? escapeHtml(r.title) : `Run ${r.run_id}`;
      return `<tr>
        <td class="muted" style="white-space:nowrap">${date}</td>
        <td><span class="repo-key"><i style="background:${t.series[r.repo]}"></i>${repo?.label ?? r.repo}</span></td>
        <td class="muted">${WORKFLOW_LABELS[r.workflow] ?? r.workflow}</td>
        <td class="title-cell"><a href="${r.url}" target="_blank" rel="noopener" title="${title}">${title}</a></td>
        <td class="num muted">${fmtDuration(r.duration_s)}</td>
        <td class="num">${usd.format(r.cost_usd)}</td>
      </tr>`;
    })
    .join('');
}

function renderDataTable(records, t) {
  const periods = periodRange(records);
  const repos = activeRepos();
  const rows = [];
  for (const p of [...periods].reverse()) {
    const present = repos.filter((repo) =>
      records.some((r) => r.repo === repo.id && periodKey(r.created_at) === p)
    );
    for (const [i, repo] of present.entries()) {
      const recs = records.filter((r) => r.repo === repo.id && periodKey(r.created_at) === p);
      const s = stats(recs);
      // Render the period label once per group, spanning its rows
      const periodCell = i === 0 ? `<td style="white-space:nowrap" rowspan="${present.length}">${periodLabel(p)}</td>` : '';
      rows.push(`<tr>
        ${periodCell}
        <td><span class="repo-key"><i style="background:${t.series[repo.id]}"></i>${repo.label}</span></td>
        <td class="num">${s.count}</td>
        <td class="num">${usd.format(s.total)}</td>
        <td class="num">${usd.format(s.avg)}</td>
        <td class="num">${usd.format(s.median)}</td>
        <td class="num">${usd.format(s.p90)}</td>
      </tr>`);
    }
  }
  $('#dataTable tbody').innerHTML = rows.join('');
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function render() {
  const t = tokens();
  const records = filteredRecords();
  renderTiles(records);
  renderCostChart(records, t);
  renderAvgChart(records, t);
  renderTopRuns(records, t);
  renderDataTable(records, t);
}

// ---- controls ----

function initControls() {
  const repoSel = $('#repoFilter');
  repoSel.innerHTML =
    '<option value="">All repositories</option>' +
    REPOS.map((r) => `<option value="${r.id}">${r.label}</option>`).join('');
  repoSel.addEventListener('change', () => { state.repo = repoSel.value; render(); });

  const wfSel = $('#workflowFilter');
  const workflows = [...new Set(allRecords.map((r) => r.workflow))].sort();
  wfSel.innerHTML =
    '<option value="">All workflows</option>' +
    workflows.map((w) => `<option value="${w}">${WORKFLOW_OPTIONS[w] ?? w}</option>`).join('');
  wfSel.addEventListener('change', () => { state.workflow = wfSel.value; render(); });

  const rangeSel = $('#rangeFilter');
  rangeSel.addEventListener('change', () => { state.range = rangeSel.value; render(); });

  $('#granularity').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    state.granularity = btn.dataset.value;
    for (const b of $('#granularity').querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(b === btn));
    }
    render();
  });

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);
}

loadData()
  .then(() => {
    $('#app').hidden = false;
    initControls();
    render();
  })
  .catch((err) => {
    const el = $('#error');
    el.style.display = 'block';
    el.textContent = `Could not load data: ${err.message}. If you opened this file directly, serve the docs/ directory over HTTP instead (e.g. npx serve docs).`;
  });
