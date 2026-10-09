/**
 * `didrun demo`: a synthetic repository, `synthetic-org/nightly-jobs`, served in the shape GitHub's
 * API returns, so the demo runs the real check with no network. Not anyone's repo or runs.
 *
 * It holds one of everything the check reports, as of {@link DEMO_NOW}:
 *
 * - a nightly backup at 03:00 UTC with one missed run, one 2-hour-late run, one failure and one
 *   green run that took 6 seconds against a usual 4 minutes;
 * - a sync every 6 hours with one missed run and one late one;
 * - a Monday report in America/New_York time, on time;
 * - a stale-issue sweep GitHub disabled for inactivity on 9 Aug;
 * - a CI workflow with no schedule, and a GitHub-managed CodeQL workflow with no file;
 * - a public repo whose last push was 21 Aug 2026, so its schedules are 12 days from the 60-day rule.
 */
import type { RepoInfo, RunInfo, Source, WorkflowInfo } from "./github.js";

export const DEMO_REPO = "synthetic-org/nightly-jobs";
export const DEMO_NOW = new Date("2026-10-09T13:00:00Z");

const URL_BASE = `https://github.com/${DEMO_REPO}`;

const REPO: RepoInfo = {
  full_name: DEMO_REPO,
  private: false,
  default_branch: "main",
  pushed_at: "2026-08-21T16:42:00Z",
  archived: false,
  fork: false,
  html_url: URL_BASE,
};

const wf = (id: number, name: string, path: string, state = "active"): WorkflowInfo => ({
  id,
  name,
  path,
  state,
  html_url: `${URL_BASE}/blob/main/${path}`,
});

const WORKFLOWS: WorkflowInfo[] = [
  wf(101, "Nightly backup", ".github/workflows/backup.yml"),
  wf(102, "Sync prices", ".github/workflows/sync.yml"),
  wf(103, "Weekly report", ".github/workflows/report.yml"),
  wf(104, "Close stale issues", ".github/workflows/stale.yml", "disabled_inactivity"),
  wf(105, "CI", ".github/workflows/ci.yml"),
  wf(106, "CodeQL", "dynamic/github-code-scanning/codeql"),
];

const FILES: Record<string, string> = {
  ".github/workflows/backup.yml": `name: Nightly backup
on:
  schedule:
    - cron: "0 3 * * *" # 03:00 UTC
  workflow_dispatch:
jobs:
  backup:
    runs-on: ubuntu-latest
    steps:
      - run: ./scripts/backup.sh
`,
  ".github/workflows/sync.yml": `name: Sync prices
on:
  schedule:
    - cron: '0 */6 * * *'
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - run: ./scripts/sync.sh
`,
  ".github/workflows/report.yml": `name: Weekly report
on:
  schedule:
    - cron: "30 8 * * 1"
      timezone: "America/New_York"
jobs:
  report:
    runs-on: ubuntu-latest
    steps:
      - run: ./scripts/report.sh
`,
  ".github/workflows/stale.yml": `name: Close stale issues
on:
  schedule:
    - cron: "0 0 * * *"
jobs:
  stale:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/stale@v9
`,
  ".github/workflows/ci.yml": `name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`,
};

const CHANGED: Record<string, string> = {
  ".github/workflows/backup.yml": "2026-06-02T10:15:00Z",
  ".github/workflows/sync.yml": "2026-05-19T08:01:00Z",
  ".github/workflows/report.yml": "2026-07-14T14:30:00Z",
  ".github/workflows/stale.yml": "2026-03-03T09:00:00Z",
};

let nextId = 9_100_000;

/** A completed scheduled run created at `created`, starting 20 s later and lasting `seconds`. */
function run(created: string, seconds: number, conclusion = "success"): RunInfo {
  const c = Date.parse(created);
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.000Z$/, "Z");
  const id = nextId++;
  return {
    id,
    created_at: iso(c),
    run_started_at: iso(c + 20_000),
    updated_at: iso(c + 20_000 + seconds * 1000),
    status: "completed",
    conclusion,
    event: "schedule",
    html_url: `${URL_BASE}/actions/runs/${id}`,
    run_attempt: 1,
  };
}

function backupRuns(): RunInfo[] {
  return [
    run("2026-10-03T03:04:12Z", 250),
    // 4 Oct: no run
    run("2026-10-05T03:06:40Z", 6),
    run("2026-10-06T05:17:03Z", 242),
    run("2026-10-07T03:05:30Z", 255),
    run("2026-10-08T03:09:05Z", 90, "failure"),
    run("2026-10-09T03:04:50Z", 248),
  ];
}

function syncRuns(): RunInfo[] {
  const out: RunInfo[] = [];
  const start = Date.parse("2026-10-02T18:00:00Z");
  const end = Date.parse("2026-10-09T13:00:00Z");
  let i = 0;
  for (let t = start; t < end; t += 6 * 3_600_000, i++) {
    const due = new Date(t).toISOString();
    if (due.startsWith("2026-10-04T06:00")) continue; // missed
    const delayMin = due.startsWith("2026-10-07T18:00") ? 47 : 3 + ((i * 7) % 9);
    out.push(run(new Date(t + delayMin * 60_000 + 17_000).toISOString(), 40 + (i % 5) * 3));
  }
  return out;
}

const RUNS: Record<number, RunInfo[]> = {
  101: backupRuns(),
  102: syncRuns(),
  103: [run("2026-10-05T12:41:20Z", 95)],
  104: [],
  105: [],
};

const LATEST: Record<number, RunInfo> = {
  104: run("2026-08-09T00:07:31Z", 31),
};

export class DemoSource implements Source {
  readonly auth = "fixtures";
  async repo() {
    return REPO;
  }
  async workflows() {
    return WORKFLOWS;
  }
  async file(path: string) {
    return FILES[path] ?? null;
  }
  async lastChange(path: string) {
    return CHANGED[path] ?? null;
  }
  async runs(workflowId: number, sinceIso: string) {
    const since = Date.parse(sinceIso);
    return (RUNS[workflowId] ?? [])
      .filter((r) => Date.parse(r.created_at) >= since)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  }
  async latestRun(workflowId: number) {
    const runs = await this.runs(workflowId, "1970-01-01T00:00:00Z");
    return runs[0] ?? LATEST[workflowId] ?? null;
  }
}
