import { describe, expect, it } from "vitest";
import { check, failed, matchRuns, span } from "./analyze.js";
import { DEMO_NOW, DEMO_REPO, DemoSource } from "./demo.js";
import type { RepoInfo, RunInfo, Source, WorkflowInfo } from "./github.js";

const at = (s: string) => Date.parse(s);

let id = 1;
function run(created: string, seconds = 60, conclusion: string | null = "success"): RunInfo {
  const c = at(created);
  return {
    id: id++,
    created_at: created,
    run_started_at: new Date(c + 10_000).toISOString(),
    updated_at: new Date(c + 10_000 + seconds * 1000).toISOString(),
    status: conclusion === null ? "in_progress" : "completed",
    conclusion,
    event: "schedule",
    html_url: `https://github.com/o/r/actions/runs/${id}`,
  };
}

interface Memory {
  repo?: Partial<RepoInfo>;
  workflows: (Partial<WorkflowInfo> & { path: string; text?: string; runs?: RunInfo[] })[];
  changed?: Record<string, string>;
  latest?: Record<number, RunInfo>;
}

function memory(m: Memory): Source & { calls: string[] } {
  const calls: string[] = [];
  const wfs = m.workflows.map((w, i) => ({
    id: i + 1,
    name: w.name ?? w.path.split("/").pop()!,
    state: w.state ?? "active",
    html_url: "",
    ...w,
  }));
  return {
    auth: "fixtures",
    calls,
    async repo() {
      calls.push("repo");
      return {
        full_name: "o/r",
        private: false,
        default_branch: "main",
        pushed_at: "2026-10-08T00:00:00Z",
        archived: false,
        fork: false,
        html_url: "https://github.com/o/r",
        ...m.repo,
      };
    },
    async workflows() {
      calls.push("workflows");
      return wfs.map(({ text: _t, runs: _r, ...w }) => w as WorkflowInfo);
    },
    async file(path) {
      calls.push(`file ${path}`);
      return wfs.find((w) => w.path === path)?.text ?? null;
    },
    async lastChange(path) {
      calls.push(`lastChange ${path}`);
      return m.changed?.[path] ?? null;
    },
    async runs(wid, since) {
      calls.push(`runs ${wid}`);
      return (wfs.find((w) => w.id === wid)?.runs ?? []).filter(
        (r) => at(r.created_at) >= at(since),
      );
    },
    async latestRun(wid) {
      calls.push(`latestRun ${wid}`);
      return m.latest?.[wid] ?? null;
    },
  };
}

const daily = `on:\n  schedule:\n    - cron: "0 3 * * *"\n`;
const NOW = new Date("2026-10-09T13:00:00Z");

describe("span", () => {
  it.each([
    [6, "6 s"],
    [90, "1 min 30 s"],
    [248, "4 min 8 s"],
    [600, "10 min"],
    [2820, "47 min"],
    [8220, "2 h 17 min"],
    [7200, "2 h"],
    [5 * 86400, "5 days"],
  ])("%i s is %s", (s, text) => expect(span(s)).toBe(text));
});

describe("matchRuns", () => {
  const due = ["2026-10-01T03:00:00Z", "2026-10-02T03:00:00Z", "2026-10-03T03:00:00Z"].map(at);

  it("each run answers the latest time due at or before it; a time with none is unanswered", () => {
    const r1 = run("2026-10-01T03:05:00Z");
    const r3 = run("2026-10-03T03:02:00Z");
    const m = matchRuns(due, [r3, r1]);
    expect(m.map((x) => x.run?.id ?? null)).toEqual([r1.id, null, r3.id]);
  });

  it("two runs between the same two times: the earlier is a late run of the time before", () => {
    const late = run("2026-10-03T01:00:00Z"); // the 2 Oct run, 22 h late
    const own = run("2026-10-03T03:04:00Z");
    // and the 1 Oct run came the next day, still before 3 Oct
    const m = matchRuns(due, [own, late]);
    expect(m.map((x) => x.run?.id ?? null)).toEqual([null, late.id, own.id]);
    const two = matchRuns(due, [run("2026-10-02T03:01:00Z"), run("2026-10-02T09:00:00Z")]);
    expect(two.map((x) => x.run !== null)).toEqual([true, true, false]);
  });

  it("a run a few seconds before its time still answers it (clock skew)", () => {
    const r = run("2026-10-02T02:59:30Z");
    expect(matchRuns(due, [r]).map((x) => x.run?.id ?? null)).toEqual([null, r.id, null]);
  });

  it("two lines due the same minute expect two runs", () => {
    const t = at("2026-10-01T03:00:00Z");
    const a = run("2026-10-01T03:01:00Z");
    const m = matchRuns([t, t], [a]);
    expect(m.map((x) => x.run?.id ?? null)).toEqual([a.id, null]);
  });
});

describe("check", () => {
  it("the demo: every kind of finding, the disabled workflow and the 60-day countdown", async () => {
    const r = await check(new DemoSource(), DEMO_REPO, { now: DEMO_NOW });
    expect(r.summary).toEqual({
      due: 36,
      ran: 34,
      on_time: 32,
      late: 2,
      missed: 2,
      pending: 0,
      failed: 1,
      cancelled: 0,
      did_nothing: 1,
      scheduled_workflows: 4,
      disabled: 1,
      problems: 7,
    });
    expect(r.verdict).toBe("problems");
    expect(r.inactivity).toEqual({ days_since_push: 48, disables_on: "2026-10-20", days_left: 12 });
    expect(r.unscheduled).toEqual([".github/workflows/ci.yml"]);
    expect(r.not_on_default_branch).toEqual([]);
    const backup = r.workflows.find((w) => w.name === "Nightly backup")!;
    expect(backup.usual_success_seconds).toBe(248);
    expect(backup.findings.map((f) => [f.kind, f.due])).toEqual([
      ["missed", "2026-10-04T03:00:00Z"],
      ["did_nothing", "2026-10-05T03:00:00Z"],
      ["late", "2026-10-06T03:00:00Z"],
      ["failed", "2026-10-08T03:00:00Z"],
    ]);
    expect(backup.next_due).toBe("2026-10-10T03:00:00Z");
    const stale = r.workflows.find((w) => w.name === "Close stale issues")!;
    expect(stale.disabled).toMatch(/no repository activity in 60 days/);
    expect(stale.counts.due).toBe(0);
    expect(stale.last_run?.created_at).toBe("2026-08-09T00:07:31Z");
    expect(stale.fix[0]).toBe("gh workflow enable stale.yml -R synthetic-org/nightly-jobs");
    const report = r.workflows.find((w) => w.name === "Weekly report")!;
    expect(report.schedules).toEqual([{ cron: "30 8 * * 1", timezone: "America/New_York" }]);
    expect(report.counts).toMatchObject({ due: 1, on_time: 1 });
    expect(report.next_due).toBe("2026-10-12T12:30:00Z");
    expect(r.handoff.text).toBe("An hourly watch for scheduled runs is not built.");
  });

  it("counts only from when the file last changed inside the window", async () => {
    const src = memory({
      workflows: [
        { path: ".github/workflows/n.yml", text: daily, runs: [run("2026-10-09T03:02:00Z")] },
      ],
      changed: { ".github/workflows/n.yml": "2026-10-08T12:00:00Z" },
    });
    const r = await check(src, "o/r", { now: NOW });
    const w = r.workflows[0]!;
    expect(w.evaluated_from).toBe("2026-10-08T12:00:00Z");
    expect(w.counts).toMatchObject({ due: 1, ran: 1, on_time: 1, missed: 0 });
  });

  it("a run not yet late is pending, not missed; a late threshold is respected", async () => {
    const text = `on:\n  schedule:\n    - cron: "45 12 * * *"\n`;
    const src = memory({
      workflows: [{ path: ".github/workflows/n.yml", text }],
      changed: { ".github/workflows/n.yml": "2026-10-09T00:00:00Z" },
    });
    const r = await check(src, "o/r", { now: NOW, lateMinutes: 30 });
    expect(r.workflows[0]!.counts).toMatchObject({ due: 1, pending: 1, missed: 0 });
    const r2 = await check(src, "o/r", { now: NOW, lateMinutes: 10 });
    expect(r2.workflows[0]!.counts).toMatchObject({ due: 1, pending: 0, missed: 1 });
    expect(r2.summary.problems).toBe(1);
  });

  it("green but did nothing: a skipped conclusion, or a success under a fifth of the usual", async () => {
    const runs = [
      run("2026-10-03T03:01:00Z", 300),
      run("2026-10-04T03:01:00Z", 310),
      run("2026-10-05T03:01:00Z", 290),
      run("2026-10-06T03:01:00Z", 30), // a tenth of the usual
      run("2026-10-07T03:01:00Z", 4, "skipped"),
      run("2026-10-08T03:01:00Z", 61), // over a fifth of 290: not flagged
      run("2026-10-09T03:01:00Z", null as unknown as number, null), // still running
    ];
    const src = memory({ workflows: [{ path: ".github/workflows/n.yml", text: daily, runs }] });
    const w = (await check(src, "o/r", { now: NOW })).workflows[0]!;
    expect(w.usual_success_seconds).toBe(290);
    expect(w.findings.filter((f) => f.kind === "did_nothing").map((f) => f.due)).toEqual([
      "2026-10-06T03:00:00Z",
      "2026-10-07T03:00:00Z",
    ]);
    expect(w.findings.find((f) => f.due === "2026-10-07T03:00:00Z")?.text).toMatch(/skipped/);
    expect(w.counts).toMatchObject({ due: 7, ran: 7, did_nothing: 2, failed: 0 });
  });

  it("fewer than three successes: no usual duration, so no short-run verdicts", async () => {
    const runs = [run("2026-10-08T03:01:00Z", 300), run("2026-10-09T03:01:00Z", 3)];
    const src = memory({
      workflows: [{ path: ".github/workflows/n.yml", text: daily, runs }],
      changed: { ".github/workflows/n.yml": "2026-10-07T12:00:00Z" },
    });
    const w = (await check(src, "o/r", { now: NOW })).workflows[0]!;
    expect(w.usual_success_seconds).toBeNull();
    expect(w.counts.did_nothing).toBe(0);
  });

  it("disabled workflows: no runs are expected, the reason and the command are given", async () => {
    const src = memory({
      workflows: [
        { path: ".github/workflows/a.yml", text: daily, state: "disabled_manually" },
        { path: ".github/workflows/b.yml", text: daily, state: "disabled_fork" },
      ],
      latest: { 1: run("2026-09-01T03:02:00Z") },
    });
    const r = await check(src, "o/r", { now: NOW });
    expect(r.workflows.map((w) => [w.state, w.counts.due, w.problems])).toEqual([
      ["disabled_manually", 0, 1],
      ["disabled_fork", 0, 1],
    ]);
    expect(r.workflows[0]!.disabled).toMatch(/by hand/);
    expect(r.workflows[0]!.last_run?.created_at).toBe("2026-09-01T03:02:00Z");
    expect(r.workflows[1]!.disabled).toMatch(/fork/);
    expect(r.workflows[0]!.fix).toEqual(["gh workflow enable a.yml -R o/r"]);
    expect(src.calls).toContain("latestRun 1");
  });

  it("an archived repo runs nothing; a private repo has no 60-day rule", async () => {
    const archived = await check(
      memory({
        repo: { archived: true },
        workflows: [{ path: ".github/workflows/n.yml", text: daily }],
      }),
      "o/r",
      { now: NOW },
    );
    expect(archived.workflows[0]!.state).toBe("archived");
    expect(archived.workflows[0]!.disabled).toMatch(/archived/);
    expect(archived.inactivity).toBeNull();
    const priv = await check(
      memory({ repo: { private: true, pushed_at: "2026-01-01T00:00:00Z" }, workflows: [] }),
      "o/r",
      { now: NOW },
    );
    expect(priv.inactivity).toBeNull();
    expect(priv.verdict).toBe("nothing-scheduled");
  });

  it("past 60 days without a push: days_left goes negative", async () => {
    const r = await check(
      memory({ repo: { pushed_at: "2026-07-01T00:00:00Z" }, workflows: [] }),
      "o/r",
      { now: NOW },
    );
    expect(r.inactivity).toEqual({
      days_since_push: 100,
      disables_on: "2026-08-30",
      days_left: -40,
    });
  });

  it("a line GitHub cannot fire is a problem with its reason; others still count", async () => {
    const text = `on:\n  schedule:\n    - cron: "0 3 * *"\n    - cron: "0 4 * * *"\n      timezone: "Mars/Olympus"\n    - cron: "17 3 * * *"\n`;
    const src = memory({
      workflows: [{ path: ".github/workflows/n.yml", text, runs: [run("2026-10-09T03:20:00Z")] }],
      changed: { ".github/workflows/n.yml": "2026-10-08T12:00:00Z" },
    });
    const w = (await check(src, "o/r", { now: NOW })).workflows[0]!;
    expect(w.schedules.map((s) => s.error ?? null)).toEqual([
      expect.stringMatching(/five fields/),
      expect.stringMatching(/not an IANA time zone/),
      null,
    ]);
    expect(w.counts).toMatchObject({ due: 1, on_time: 1 });
    expect(w.problems).toBe(2);
    expect(w.fix).toHaveLength(2);
  });

  it("managed workflows are skipped; files missing on the default branch are listed", async () => {
    const src = memory({
      workflows: [
        { path: "dynamic/github-code-scanning/codeql" },
        { path: ".github/workflows/old.yml" },
        { path: ".github/workflows/n.yml", text: daily, state: "deleted" },
      ],
    });
    const r = await check(src, "o/r", { now: NOW });
    expect(r.workflows).toEqual([]);
    expect(r.not_on_default_branch).toEqual([".github/workflows/old.yml"]);
    expect(src.calls.filter((c) => c.startsWith("file"))).toEqual([
      "file .github/workflows/old.yml",
    ]);
  });

  it("--workflow picks one by file name, path or name, and warns when none matches", async () => {
    const src = memory({
      workflows: [
        { path: ".github/workflows/a.yml", name: "Alpha", text: daily },
        { path: ".github/workflows/b.yml", name: "Beta", text: daily },
      ],
    });
    for (const pick of ["b.yml", ".github/workflows/b.yml", "beta"]) {
      const r = await check(src, "o/r", { now: NOW, workflow: pick });
      expect(
        r.workflows.map((w) => w.name),
        pick,
      ).toEqual(["Beta"]);
    }
    const none = await check(src, "o/r", { now: NOW, workflow: "gamma" });
    expect(none.warnings.map((w) => w.code)).toEqual(["WORKFLOW_NOT_FOUND"]);
  });

  it("the :00 hint appears only for a minute-0 line with missed or late runs", async () => {
    const mk = (cron: string) =>
      memory({
        workflows: [
          { path: ".github/workflows/n.yml", text: `on:\n  schedule:\n    - cron: "${cron}"\n` },
        ],
        changed: { ".github/workflows/n.yml": "2026-10-08T00:00:00Z" },
      });
    const zero = (await check(mk("0 3 * * *"), "o/r", { now: NOW })).workflows[0]!;
    expect(zero.fix.join(" ")).toMatch(/start of every hour/);
    const off = (await check(mk("17 3 * * *"), "o/r", { now: NOW })).workflows[0]!;
    expect(off.counts.missed).toBe(2);
    expect(off.fix.join(" ")).not.toMatch(/start of every hour/);
  });
});

describe("failed (--fail-on)", () => {
  it("missed: a run that never came or a disabled schedule; problem: anything; never: nothing", async () => {
    const r = await check(new DemoSource(), DEMO_REPO, { now: DEMO_NOW });
    expect(failed(r, "missed")).toBe(true);
    expect(failed(r, "problem")).toBe(true);
    expect(failed(r, "never")).toBe(false);
    const clean = await check(new DemoSource(), DEMO_REPO, {
      now: DEMO_NOW,
      workflow: "report.yml",
    });
    expect(clean.summary.problems).toBe(0);
    expect(failed(clean, "problem")).toBe(false);
    const lateOnly = await check(new DemoSource(), DEMO_REPO, {
      now: DEMO_NOW,
      workflow: "report.yml",
      lateMinutes: 5,
    });
    expect(lateOnly.summary.late).toBe(1);
    expect(failed(lateOnly, "missed")).toBe(false);
    expect(failed(lateOnly, "problem")).toBe(true);
  });
});
