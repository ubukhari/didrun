/**
 * The check: which runs a repo's schedules promised over the window, and which came. Pure over a
 * {@link Source}, so the CLI, the MCP tool, the Action and the tests share it.
 *
 * Matching a run to the time it was due. GitHub's run list does not say which scheduled time a run
 * answered, so a run belongs to the latest scheduled time at or before it was created (a minute's
 * clock skew allowed). When two runs land between the same two scheduled times, the later one
 * answers its own time and the earlier one is counted as a late run of the nearest earlier time
 * that has none. A time with no run is missed once it is more than the late threshold old, and
 * pending until then. For schedules more frequent than GitHub's delay, a late run and a missed one
 * cannot be told apart from the record; the counts of runs that never came are right either way.
 *
 * "Green but did nothing": a run whose conclusion is `skipped`, or a success shorter than a fifth
 * of the workflow's usual (median) successful run, with at least three successes to compare.
 */
import { CronError, checkTimeZone, fireTimes, nextFire, parseCron, type CronSpec } from "./cron.js";
import { HANDOFF_LINE, HANDOFF_URL } from "./handoff.js";
import type { Problem } from "./errors.js";
import type { RepoInfo, RunInfo, Source, WorkflowInfo } from "./github.js";
import { version } from "./version.js";
import { schedulesOf } from "./workflow.js";

const MINUTE = 60_000;
const DAY = 86_400_000;
const SKEW = MINUTE;

/** GitHub's rule for public repos (events page, read 9 Oct 2026). */
export const INACTIVITY_DAYS = 60;
/** The text report warns when this few days are left. */
export const INACTIVITY_WARN_DAYS = 14;
export const DEFAULT_DAYS = 7;
export const MAX_DAYS = 30;
export const DEFAULT_LATE_MINUTES = 30;
/** A success shorter than this fraction of the usual one counts as having done nothing. */
export const SHORT_FRACTION = 0.2;
export const MIN_SUCCESSES_FOR_USUAL = 3;

export interface CheckOptions {
  days?: number;
  lateMinutes?: number;
  now?: Date;
  /** a workflow's file name, path or name; others are left out */
  workflow?: string;
}

export type Outcome = "success" | "did_nothing" | "failed" | "cancelled" | "running" | "other";
export type FindingKind = "missed" | "late" | "pending" | "failed" | "cancelled" | "did_nothing";

export interface RunSummary {
  id: number;
  created_at: string;
  delay_minutes: number;
  status: string;
  conclusion: string | null;
  outcome: Outcome;
  duration_seconds: number | null;
  html_url: string;
}

export interface Finding {
  kind: FindingKind;
  due: string;
  /** what happened, in one sentence */
  text: string;
  run?: RunSummary;
}

export interface ScheduleLine {
  cron: string;
  timezone?: string;
  /** set when GitHub's cron cannot fire this line as written */
  error?: string;
}

export interface Counts {
  due: number;
  ran: number;
  on_time: number;
  late: number;
  missed: number;
  pending: number;
  failed: number;
  cancelled: number;
  did_nothing: number;
}

export interface WorkflowReport {
  name: string;
  path: string;
  html_url: string;
  state: string;
  /** set when GitHub will not run this workflow's schedule at all */
  disabled?: string;
  schedules: ScheduleLine[];
  /** the window, or later when the file changed inside it */
  evaluated_from: string;
  file_changed_at: string | null;
  counts: Counts;
  usual_success_seconds: number | null;
  last_run: RunSummary | null;
  next_due: string | null;
  /** the findings worth a look: missed, late, pending, failed, cancelled, did nothing */
  findings: Finding[];
  problems: number;
  fix: string[];
}

export interface Inactivity {
  /** days since the last push to any branch */
  days_since_push: number;
  /** pushed_at + 60 days, if nothing else counts as activity */
  disables_on: string;
  days_left: number;
}

export interface Report {
  tool: "didrun";
  version: string;
  repo: string;
  checked_at: string;
  window: { days: number; from: string; to: string };
  late_after_minutes: number;
  read_with: string;
  repository: {
    html_url: string;
    private: boolean;
    default_branch: string;
    pushed_at: string;
    archived: boolean;
    fork: boolean;
  };
  /** public repos only: GitHub disables their schedules after 60 days without activity */
  inactivity: Inactivity | null;
  workflows: WorkflowReport[];
  /** workflows with no schedule on the default branch */
  unscheduled: string[];
  /** workflow files GitHub lists that are not on the default branch, where no schedule runs */
  not_on_default_branch: string[];
  summary: Counts & { scheduled_workflows: number; disabled: number; problems: number };
  verdict: "ok" | "problems" | "nothing-scheduled";
  handoff: { text: string; url: string };
  warnings: Problem[];
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.000Z$/, "Z");
const ms = (s: string) => Date.parse(s);

function durationSeconds(r: RunInfo): number | null {
  if (r.status !== "completed") return null;
  const start = ms(r.run_started_at ?? r.created_at);
  const end = ms(r.updated_at);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? Math.round((end - start) / 1000)
    : null;
}

function median(xs: number[]): number | null {
  if (xs.length < MIN_SUCCESSES_FOR_USUAL) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

function outcomeOf(r: RunInfo, usual: number | null): Outcome {
  if (r.status !== "completed") return "running";
  switch (r.conclusion) {
    case "success": {
      const d = durationSeconds(r);
      return usual !== null && d !== null && d < usual * SHORT_FRACTION ? "did_nothing" : "success";
    }
    case "skipped":
      return "did_nothing";
    case "failure":
    case "timed_out":
    case "startup_failure":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "other";
  }
}

function summarize(r: RunInfo, due: number | null, usual: number | null): RunSummary {
  return {
    id: r.id,
    created_at: r.created_at,
    delay_minutes: due === null ? 0 : Math.max(0, Math.round((ms(r.created_at) - due) / MINUTE)),
    status: r.status,
    conclusion: r.conclusion,
    outcome: outcomeOf(r, usual),
    duration_seconds: durationSeconds(r),
    html_url: r.html_url,
  };
}

/** "2 h 14 min", "47 min", "6 s". */
export function span(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 600)
    return `${Math.floor(seconds / 60)} min${seconds % 60 ? ` ${seconds % 60} s` : ""}`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h < 48) return rest ? `${h} h ${rest} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}

const CONCLUSION_WORDS: Record<string, string> = {
  failure: "failed",
  timed_out: "timed out",
  startup_failure: "failed to start",
  cancelled: "was cancelled",
  skipped: "was skipped",
};

/** Match runs to the times they were due. Exported for the tests. */
export function matchRuns(
  due: readonly number[],
  runs: readonly RunInfo[],
): { slot: number; run: RunInfo | null }[] {
  const out = due.map((slot) => ({ slot, run: null as RunInfo | null }));
  if (!due.length) return out;
  const sorted = runs.slice().sort((a, b) => ms(a.created_at) - ms(b.created_at));
  // group slot indexes by time: two lines due the same minute expect two runs
  const groups: number[][] = [];
  for (let i = 0; i < due.length; i++) {
    const last = groups[groups.length - 1];
    if (last && due[last[0]!] === due[i]) last.push(i);
    else groups.push([i]);
  }
  const buckets: RunInfo[][] = groups.map(() => []);
  let g = -1;
  for (const r of sorted) {
    const t = ms(r.created_at) + SKEW;
    while (g + 1 < groups.length && due[groups[g + 1]![0]!]! <= t) g++;
    if (g >= 0) buckets[g]!.push(r);
  }
  for (let k = 0; k < groups.length; k++) {
    const slots = groups[k]!;
    const runsHere = buckets[k]!;
    // the later runs answer this time; earlier extras are late runs of earlier unanswered times
    const own = runsHere.slice(Math.max(0, runsHere.length - slots.length));
    const extras = runsHere.slice(0, Math.max(0, runsHere.length - slots.length));
    own.forEach((r, i) => (out[slots[i]!]!.run = r));
    for (const r of extras.reverse()) {
      let j = slots[0]! - 1;
      while (j >= 0 && out[j]!.run) j--;
      if (j >= 0) out[j]!.run = r;
    }
  }
  return out;
}

const emptyCounts = (): Counts => ({
  due: 0,
  ran: 0,
  on_time: 0,
  late: 0,
  missed: 0,
  pending: 0,
  failed: 0,
  cancelled: 0,
  did_nothing: 0,
});

function disabledReason(state: string, repo: RepoInfo): string | undefined {
  if (repo.archived) return "the repository is archived, so GitHub runs none of its workflows";
  switch (state) {
    case "disabled_inactivity":
      return `disabled by GitHub: no repository activity in ${INACTIVITY_DAYS} days (public repositories only)`;
    case "disabled_manually":
      return "disabled by hand, in the Actions tab or through the API";
    case "disabled_fork":
      return "disabled because this is a fork: GitHub turns off scheduled workflows in forks";
    default:
      return state === "active" ? undefined : `state "${state}"`;
  }
}

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

function selected(w: WorkflowInfo, filter: string | undefined): boolean {
  if (!filter) return true;
  const f = filter.toLowerCase();
  return [w.path, fileName(w.path), w.name].some((x) => x.toLowerCase() === f);
}

export async function check(
  source: Source,
  repoName: string,
  opts: CheckOptions = {},
): Promise<Report> {
  const now = (opts.now ?? new Date()).getTime();
  const days = opts.days ?? DEFAULT_DAYS;
  const lateMs = (opts.lateMinutes ?? DEFAULT_LATE_MINUTES) * MINUTE;
  const from = now - days * DAY;
  const warnings: Problem[] = [];

  const repo = await source.repo();
  const all = (await source.workflows()).filter((w) => w.state !== "deleted");
  const branch = repo.default_branch;

  const workflows: WorkflowReport[] = [];
  const unscheduled: string[] = [];
  const notOnDefault: string[] = [];

  for (const w of all) {
    // GitHub-managed workflows (CodeQL default setup, Pages, Dependabot) have no file to read
    if (!w.path.startsWith(".github/workflows/")) continue;
    if (!selected(w, opts.workflow)) continue;
    const text = await source.file(w.path, branch);
    if (text === null) {
      notOnDefault.push(w.path);
      continue;
    }
    const lines: ScheduleLine[] = schedulesOf(text).map((s) => ({ ...s }));
    if (!lines.length) {
      unscheduled.push(w.path);
      continue;
    }
    const specs: { line: ScheduleLine; spec: CronSpec }[] = [];
    for (const line of lines) {
      try {
        const spec = parseCron(line.cron);
        if (line.timezone) {
          try {
            checkTimeZone(line.timezone);
          } catch {
            throw new CronError(`"${line.timezone}" is not an IANA time zone name`);
          }
        }
        specs.push({ line, spec });
      } catch (e) {
        line.error = e instanceof Error ? e.message : String(e);
      }
    }

    const disabled = disabledReason(w.state, repo);
    const changed = await source.lastChange(w.path, branch);
    const evalFrom = Math.max(from, changed ? ms(changed) : from);

    const runs = (await source.runs(w.id, iso(from))).filter((r) => r.event === "schedule");
    const durations = runs
      .filter((r) => r.status === "completed" && r.conclusion === "success")
      .map(durationSeconds)
      .filter((d): d is number => d !== null);
    const usual = median(durations);

    const counts = emptyCounts();
    const findings: Finding[] = [];
    const fix: string[] = [];

    const newest = runs.slice().sort((a, b) => ms(b.created_at) - ms(a.created_at))[0];
    const lastRun = newest
      ? summarize(newest, null, usual)
      : disabled
        ? await lastRunEver(source, w.id, usual)
        : null;

    if (!disabled) {
      const due = specs
        .flatMap(({ line, spec }) => fireTimes(spec, line.timezone, evalFrom, now))
        .sort((a, b) => a - b);
      const matched = matchRuns(
        due,
        runs.filter((r) => ms(r.created_at) + SKEW >= evalFrom),
      );
      for (const { slot, run } of matched) {
        counts.due++;
        const dueIso = iso(slot);
        if (!run) {
          if (now - slot <= lateMs) {
            counts.pending++;
            findings.push({ kind: "pending", due: dueIso, text: "no run yet; not late yet" });
          } else {
            counts.missed++;
            findings.push({
              kind: "missed",
              due: dueIso,
              text: "no run was created",
            });
          }
          continue;
        }
        counts.ran++;
        const s = summarize(run, slot, usual);
        const late = s.delay_minutes * MINUTE > lateMs;
        if (late) {
          counts.late++;
          findings.push({
            kind: "late",
            due: dueIso,
            text: `the run was created ${span(s.delay_minutes * 60)} late`,
            run: s,
          });
        } else counts.on_time++;
        if (s.outcome === "failed" || s.outcome === "cancelled") {
          counts[s.outcome]++;
          findings.push({
            kind: s.outcome,
            due: dueIso,
            text: `the run ${CONCLUSION_WORDS[run.conclusion ?? ""] ?? run.conclusion}${s.duration_seconds !== null ? ` after ${span(s.duration_seconds)}` : ""}`,
            run: s,
          });
        } else if (s.outcome === "did_nothing") {
          counts.did_nothing++;
          findings.push({
            kind: "did_nothing",
            due: dueIso,
            text:
              run.conclusion === "skipped"
                ? "the run concluded skipped: every job was skipped"
                : `green in ${span(s.duration_seconds ?? 0)}; its usual success takes ${span(usual ?? 0)}`,
            run: s,
          });
        }
      }
      const minuteZero = specs.some(({ spec }) => spec.minute.has(0));
      if ((counts.missed || counts.late) && minuteZero)
        fix.push(
          "GitHub delays and drops scheduled runs under high load, which includes the start of every hour: move the minute off :00 (e.g. 17 instead of 0)",
        );
      if (counts.did_nothing)
        fix.push(
          "open the green runs that were short: usually every job or step was skipped by an `if:`, or the job found nothing to do and exited 0",
        );
    } else if (w.state.startsWith("disabled") && !repo.archived) {
      fix.push(`gh workflow enable ${fileName(w.path)} -R ${repoName}`);
      if (w.state === "disabled_inactivity")
        fix.push(
          `then keep the repo active: GitHub disables a public repo's scheduled workflows again after ${INACTIVITY_DAYS} days without activity`,
        );
    }
    for (const line of lines)
      if (line.error) fix.push(`fix the schedule line "${line.cron}": ${line.error}`);

    const next = disabled
      ? null
      : specs
          .map(({ line, spec }) => nextFire(spec, line.timezone, now))
          .filter((x): x is number => x !== null)
          .sort((a, b) => a - b)[0];

    const problems =
      counts.missed +
      counts.late +
      counts.failed +
      counts.cancelled +
      counts.did_nothing +
      (disabled ? 1 : 0) +
      lines.filter((l) => l.error).length;

    workflows.push({
      name: w.name,
      path: w.path,
      html_url: w.html_url,
      state: repo.archived ? "archived" : w.state,
      ...(disabled ? { disabled } : {}),
      schedules: lines,
      evaluated_from: iso(evalFrom),
      file_changed_at: changed,
      counts,
      usual_success_seconds: usual,
      last_run: lastRun,
      next_due: next ? iso(next) : null,
      findings,
      problems,
      fix,
    });
  }

  if (opts.workflow && !workflows.length && !unscheduled.length)
    warnings.push({
      code: "WORKFLOW_NOT_FOUND",
      cause: `no workflow named "${opts.workflow}" on ${branch}`,
      fix: "pass the file name (nightly.yml), its path or the workflow's name; omit --workflow for all",
      retryable: false,
    });

  let inactivity: Inactivity | null = null;
  if (!repo.private && !repo.archived && Number.isFinite(ms(repo.pushed_at))) {
    const since = Math.floor((now - ms(repo.pushed_at)) / DAY);
    const disablesOn = ms(repo.pushed_at) + INACTIVITY_DAYS * DAY;
    inactivity = {
      days_since_push: since,
      disables_on: iso(disablesOn).slice(0, 10),
      days_left: INACTIVITY_DAYS - since,
    };
  }

  const summary = workflows.reduce(
    (acc, w) => {
      for (const k of Object.keys(acc.counts) as (keyof Counts)[]) acc.counts[k] += w.counts[k];
      if (w.disabled) acc.disabled++;
      acc.problems += w.problems;
      return acc;
    },
    { counts: emptyCounts(), disabled: 0, problems: 0 },
  );

  return {
    tool: "didrun",
    version: version(),
    repo: repoName,
    checked_at: iso(now),
    window: { days, from: iso(from), to: iso(now) },
    late_after_minutes: lateMs / MINUTE,
    read_with: source.auth,
    repository: {
      html_url: repo.html_url,
      private: repo.private,
      default_branch: branch,
      pushed_at: repo.pushed_at,
      archived: repo.archived,
      fork: repo.fork,
    },
    inactivity,
    workflows,
    unscheduled,
    not_on_default_branch: notOnDefault,
    summary: {
      ...summary.counts,
      scheduled_workflows: workflows.length,
      disabled: summary.disabled,
      problems: summary.problems,
    },
    verdict: workflows.length === 0 ? "nothing-scheduled" : summary.problems ? "problems" : "ok",
    handoff: { text: HANDOFF_LINE, url: HANDOFF_URL },
    warnings,
  };
}

/** A disabled workflow's newest scheduled run of all time, for "last ran". */
async function lastRunEver(
  source: Source,
  workflowId: number,
  usual: number | null,
): Promise<RunSummary | null> {
  const newest = await source.latestRun(workflowId);
  return newest ? summarize(newest, null, usual) : null;
}

export type FailOn = "missed" | "problem" | "never";

/** The exit code `--fail-on` asks for: missed counts a run that never came, or a disabled schedule. */
export function failed(report: Report, mode: FailOn): boolean {
  if (mode === "never") return false;
  if (mode === "missed") return report.summary.missed > 0 || report.summary.disabled > 0;
  return report.summary.problems > 0;
}
