/** Every error and warning carries what went wrong, why, how to fix it, and whether a retry helps. */
interface Problem {
    code: string;
    cause: string;
    fix: string;
    retryable: boolean;
}
declare class CliError extends Error implements Problem {
    readonly code: string;
    readonly cause: string;
    readonly fix: string;
    readonly retryable: boolean;
    /** 2 for a usage mistake, 1 for anything else */
    readonly exitCode: number;
    constructor(p: Problem, exitCode?: number);
    toJSON(): Problem;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
interface RepoInfo {
    full_name: string;
    private: boolean;
    default_branch: string;
    pushed_at: string;
    archived: boolean;
    fork: boolean;
    html_url: string;
}
interface WorkflowInfo {
    id: number;
    name: string;
    path: string;
    state: string;
    html_url: string;
    updated_at?: string;
}
interface RunInfo {
    id: number;
    created_at: string;
    run_started_at?: string | null;
    updated_at: string;
    status: string;
    conclusion: string | null;
    event: string;
    html_url: string;
    run_attempt?: number;
}
/** Where a check reads from: GitHub's API, or the recorded fixtures `demo` uses. */
interface Source {
    /** "token", "anonymous" or "fixtures" */
    readonly auth: string;
    repo(): Promise<RepoInfo>;
    workflows(): Promise<WorkflowInfo[]>;
    /** the file's text on `ref`, or null when it is not there */
    file(path: string, ref: string): Promise<string | null>;
    /** when the file last changed on `ref`, ISO; null when unknown */
    lastChange(path: string, ref: string): Promise<string | null>;
    /** the workflow's `event=schedule` runs created at or after `sinceIso`, newest first */
    runs(workflowId: number, sinceIso: string): Promise<RunInfo[]>;
    /** the workflow's newest `event=schedule` run of all time, or null */
    latestRun(workflowId: number): Promise<RunInfo | null>;
}
/** `owner/repo`, from an argument or a git remote URL. */
declare function parseRepo(text: string): string | null;
/** Run a command and return its trimmed stdout, or null if it is missing, fails or takes too long. */
type Exec = (cmd: string, args: string[], cwd: string) => Promise<string | null>;
/** The repo the current checkout's `origin` points at, if it is on github.com. */
declare function repoFromGit(cwd: string, exec?: Exec): Promise<string | null>;
/**
 * The user's own token, without printing it: `GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth
 * token` (the GitHub CLI's stored login). Null when there is none, which reads public repos only.
 */
declare function findToken(env: Record<string, string | undefined>, cwd: string, exec?: Exec): Promise<string | null>;
interface GitHubOptions {
    repo: string;
    token: string | null;
    fetch?: FetchLike;
    apiUrl?: string;
}
declare class GitHubSource implements Source {
    readonly auth: string;
    private readonly base;
    private readonly repoPath;
    private readonly fetchImpl;
    private readonly token;
    /** requests made, for the report's footer */
    requests: number;
    constructor(opts: GitHubOptions);
    private get;
    private json;
    repo(): Promise<RepoInfo>;
    workflows(): Promise<WorkflowInfo[]>;
    file(path: string, ref: string): Promise<string | null>;
    lastChange(path: string, ref: string): Promise<string | null>;
    runs(workflowId: number, sinceIso: string): Promise<RunInfo[]>;
    latestRun(workflowId: number): Promise<RunInfo | null>;
}

/** GitHub's rule for public repos (events page, read 9 Oct 2026). */
declare const INACTIVITY_DAYS = 60;
declare const DEFAULT_DAYS = 7;
declare const MAX_DAYS = 30;
declare const DEFAULT_LATE_MINUTES = 30;
interface CheckOptions {
    days?: number;
    lateMinutes?: number;
    now?: Date;
    /** a workflow's file name, path or name; others are left out */
    workflow?: string;
}
type Outcome = "success" | "did_nothing" | "failed" | "cancelled" | "running" | "other";
type FindingKind = "missed" | "late" | "pending" | "failed" | "cancelled" | "did_nothing";
interface RunSummary {
    id: number;
    created_at: string;
    delay_minutes: number;
    status: string;
    conclusion: string | null;
    outcome: Outcome;
    duration_seconds: number | null;
    html_url: string;
}
interface Finding {
    kind: FindingKind;
    due: string;
    /** what happened, in one sentence */
    text: string;
    run?: RunSummary;
}
interface ScheduleLine {
    cron: string;
    timezone?: string;
    /** set when GitHub's cron cannot fire this line as written */
    error?: string;
}
interface Counts {
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
interface WorkflowReport {
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
interface Inactivity {
    /** days since the last push to any branch */
    days_since_push: number;
    /** pushed_at + 60 days, if nothing else counts as activity */
    disables_on: string;
    days_left: number;
}
interface Report {
    tool: "didrun";
    version: string;
    repo: string;
    checked_at: string;
    window: {
        days: number;
        from: string;
        to: string;
    };
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
    summary: Counts & {
        scheduled_workflows: number;
        disabled: number;
        problems: number;
    };
    verdict: "ok" | "problems" | "nothing-scheduled";
    handoff: {
        text: string;
        url: string;
    };
    warnings: Problem[];
}
/** "2 h 14 min", "47 min", "6 s". */
declare function span(seconds: number): string;
/** Match runs to the times they were due. Exported for the tests. */
declare function matchRuns(due: readonly number[], runs: readonly RunInfo[]): {
    slot: number;
    run: RunInfo | null;
}[];
declare function check(source: Source, repoName: string, opts?: CheckOptions): Promise<Report>;
type FailOn = "missed" | "problem" | "never";
/** The exit code `--fail-on` asks for: missed counts a run that never came, or a disabled schedule. */
declare function failed(report: Report, mode: FailOn): boolean;

/**
 * GitHub's `on.schedule` cron: five POSIX fields, evaluated in UTC or in the line's `timezone`.
 *
 * What GitHub documents (workflow syntax and events pages, read 9 Oct 2026):
 *
 * - five fields: minute 0-59, hour 0-23, day of month 1-31, month 1-12 or JAN-DEC, day of week
 *   0-6 or SUN-SAT; `*`, lists, ranges and steps;
 * - UTC unless the line sets `timezone` to an IANA name;
 * - "during DST spring-forward transitions, scheduled workflows in skipped hours advance to the
 *   next valid time";
 * - the shortest interval is once every 5 minutes.
 *
 * Where GitHub says nothing, this follows Vixie cron, the reference for POSIX cron: when both day
 * fields are restricted a day matches either one, a field written with a leading `*` counts as
 * unrestricted, and 7 is also Sunday. A local time repeated when clocks go back fires once, so a
 * second run in that hour is never counted against anyone.
 */
interface CronSpec {
    /** the five fields as written, single-spaced */
    source: string;
    minute: ReadonlySet<number>;
    hour: ReadonlySet<number>;
    dom: ReadonlySet<number>;
    month: ReadonlySet<number>;
    dow: ReadonlySet<number>;
    domStar: boolean;
    dowStar: boolean;
}
declare class CronError extends Error {
    constructor(message: string);
}
/** Parse the five fields; throws {@link CronError} with a sentence a person can act on. */
declare function parseCron(expr: string): CronSpec;
/** Wall-clock fields of a local minute. */
interface Local {
    minute: number;
    hour: number;
    day: number;
    month: number;
    weekday: number;
}
declare function matches(spec: CronSpec, t: Local): boolean;
/**
 * Every time the line fires in [fromMs, toMs), as UTC milliseconds, ascending. `tz` undefined or
 * "UTC" evaluates in UTC. A local time skipped by a spring-forward fires once, at the first minute
 * after the gap; a local time repeated by a fall-back fires once, the first time.
 */
declare function fireTimes(spec: CronSpec, tz: string | undefined, fromMs: number, toMs: number): number[];
/** The first fire at or after `fromMs`, looking up to `horizonDays` ahead; null if none. */
declare function nextFire(spec: CronSpec, tz: string | undefined, fromMs: number, horizonDays?: number): number | null;

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

declare const DEMO_REPO = "synthetic-org/nightly-jobs";
declare const DEMO_NOW: Date;
declare class DemoSource implements Source {
    readonly auth = "fixtures";
    repo(): Promise<RepoInfo>;
    workflows(): Promise<WorkflowInfo[]>;
    file(path: string): Promise<string | null>;
    lastChange(path: string): Promise<string | null>;
    runs(workflowId: number, sinceIso: string): Promise<RunInfo[]>;
    latestRun(workflowId: number): Promise<RunInfo | null>;
}

/** Every didrun page: the landing page and one per searched failure. */
declare const PAGES_URL = "https://agentwares-agentcheck.vercel.app/didrun";
/** Where a run's hand-off line points: the landing page's watch section. */
declare const HANDOFF_URL = "https://agentwares-agentcheck.vercel.app/didrun?ref=didrun#watch";
/** The hand-off, word for word, at the end of every run and in the watch section of every page. */
declare const HANDOFF_LINE = "An hourly watch for scheduled runs is not built.";

interface Deps {
    stdout: (s: string) => void;
    stderr: (s: string) => void;
    fetch?: FetchLike;
    now?: () => Date;
    cwd?: string;
    env?: Record<string, string | undefined>;
    exec?: Exec;
}
declare function main(argv: string[], deps?: Deps): Promise<number>;

interface ToolDefinition {
    name: string;
    title: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: Record<string, Record<string, unknown>>;
        required?: string[];
        additionalProperties: false;
    };
    annotations: {
        title: string;
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
        openWorldHint: boolean;
    };
}
declare const TOOLS: readonly ToolDefinition[];

/** What a check prints: text for a person, `--json` for a program. */

/** The one-line summary: what was due and what came of it. */
declare function headline(r: Report): string;
declare function renderText(r: Report): string;
declare function renderJson(r: Report): string;

/**
 * The `on.schedule` lines of a workflow file, read without a YAML library (the package has no
 * runtime dependencies). It reads the forms GitHub's docs and real workflows use:
 *
 *   on:                                  on: { schedule: [ { cron: "0 3 * * *" } ] }
 *     schedule:
 *       - cron: '0 3 * * *'              "on":
 *       - cron: "30 5 * * 1-5"             schedule: [{ cron: '*\/15 * * * *', timezone: UTC }]
 *         timezone: "America/New_York"
 *
 * Keys in any order inside a list item, quoted or bare values, trailing comments, `"on"` and `'on'`
 * as the key. Anything it cannot read as a schedule is left out, never guessed at.
 */
interface Schedule {
    cron: string;
    /** the line's IANA `timezone`, when it sets one */
    timezone?: string;
}
/** Every schedule line in the workflow file's text, in file order. */
declare function schedulesOf(text: string): Schedule[];

/** The library behind the CLI: read a repo's schedules and runs, and say which runs came. */

/** The day the README sample was recorded on (scripts/sample.mjs): the demo's own clock. */
declare const SAMPLE_DATE = "2026-10-09";

export { type CheckOptions, CliError, type Counts, CronError, type CronSpec, DEFAULT_DAYS, DEFAULT_LATE_MINUTES, DEMO_NOW, DEMO_REPO, DemoSource, type FailOn, type Finding, type FindingKind, GitHubSource, HANDOFF_LINE, HANDOFF_URL, INACTIVITY_DAYS, MAX_DAYS, type Outcome, PAGES_URL, type Problem, type RepoInfo, type Report, type RunInfo, type RunSummary, SAMPLE_DATE, type Schedule, type Source, TOOLS, type WorkflowInfo, type WorkflowReport, check, failed, findToken, fireTimes, headline, main, matchRuns, matches, nextFire, parseCron, parseRepo, renderJson, renderText, repoFromGit, schedulesOf, span };
