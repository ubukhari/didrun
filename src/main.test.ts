import { describe, expect, it } from "vitest";
import { DEMO_NOW, DEMO_REPO, DemoSource } from "./demo.js";
import type { Exec, FetchLike } from "./github.js";
import { HANDOFF_LINE, HANDOFF_URL } from "./handoff.js";
import { INSTALL } from "./install.js";
import { HELP, main } from "./main.js";
import { fakeGitHub } from "./testing.js";

/** A token-shaped value that must never appear in any output. */
const SECRET = "ghp_never_printed_0123456789";

interface RunOpts {
  fetch?: FetchLike;
  env?: Record<string, string | undefined>;
  exec?: Exec;
}

async function run(argv: string[], opts: RunOpts = {}) {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    fetch:
      opts.fetch ??
      (async () => {
        throw new Error("no network in tests");
      }),
    now: () => DEMO_NOW,
    cwd: "/nowhere",
    env: opts.env ?? {},
    exec: opts.exec ?? (async () => null),
  });
  return { code, stdout, stderr };
}

describe("help and arguments", () => {
  it("--help names the install constant, the token order and where requests go", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(HELP);
    expect(HELP).toContain(`${INSTALL} [owner/repo]`);
    expect(HELP).toContain("GITHUB_TOKEN, then GH_TOKEN, then `gh auth token`");
    expect(HELP).toContain("never printed or stored");
  });

  it.each([
    [["a/b", "c/d"], /at most one repo/],
    [["--days", "0"], /--days must be a whole number from 1 to 30/],
    [["--days", "31"], /--days must/],
    [["--late", "x"], /--late must/],
    [["--fail-on", "sometimes"], /--fail-on must be missed, problem, never/],
    [["not-a-repo"], /is not owner\/repo/],
    [["--bogus"], /Unknown option/],
  ])("%j is a usage error (exit 2)", async (argv, msg) => {
    const r = await run(argv as string[]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(msg);
    expect(r.stderr).toMatch(/BAD_ARGUMENTS/);
  });

  it("no repo and no checkout: NO_REPO with the fix, as JSON under --json", async () => {
    const r = await run(["--json"]);
    expect(r.code).toBe(2);
    const body = JSON.parse(r.stdout);
    expect(body.error).toMatchObject({ code: "NO_REPO", retryable: false });
    expect(body.error.fix).toContain(`${INSTALL} owner/repo`);
  });
});

describe("demo", () => {
  it("prints the labelled synthetic report and the hand-off, with no network", async () => {
    const r = await run(["demo"]);
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith("Synthetic repo, written for this demo")).toBe(true);
    expect(r.stdout).toContain(
      "4 scheduled workflows: 36 runs due, 34 ran (32 on time, 2 late), 2 missed; 1 failed, 1 green",
    );
    expect(r.stdout).toContain("missed       Sun 4 Oct 03:00 UTC  no run was created");
    expect(r.stdout).toContain(
      "did nothing  Mon 5 Oct 03:00 UTC  green in 6 s; its usual success takes 4 min 8 s",
    );
    expect(r.stdout).toContain("30 8 * * 1 (America/New_York)");
    expect(r.stdout).toContain("gh workflow enable stale.yml -R synthetic-org/nightly-jobs");
    expect(r.stdout).toMatch(/around 20 Oct 2026 \(in 12 days\)/);
    expect(r.stdout.trimEnd().split("\n").slice(-3)).toEqual([
      HANDOFF_LINE,
      "Would you pay for one that emails you when a run is late, missed or did nothing? One click counts:",
      `  ${HANDOFF_URL}`,
    ]);
    for (const line of r.stdout.split("\n")) expect(line.length, line).toBeLessThanOrEqual(130);
  });

  it("--json is the report, with the hand-off", async () => {
    const r = await run(["demo", "--json"]);
    const body = JSON.parse(r.stdout);
    expect(body).toMatchObject({
      tool: "didrun",
      repo: DEMO_REPO,
      read_with: "fixtures",
      verdict: "problems",
      handoff: { text: HANDOFF_LINE, url: HANDOFF_URL },
    });
  });

  it("--fail-on sets the exit code", async () => {
    expect((await run(["demo", "--fail-on", "missed"])).code).toBe(1);
    expect((await run(["demo", "--fail-on", "never"])).code).toBe(0);
    expect((await run(["demo", "--workflow", "report.yml", "--fail-on", "problem"])).code).toBe(0);
  });
});

describe("a real check, against GitHub's API shape", () => {
  const api = () => fakeGitHub(new DemoSource(), DEMO_REPO);

  it("uses GITHUB_TOKEN, sends it only to api.github.com, and never prints it", async () => {
    const { fetch, requests } = api();
    const r = await run([DEMO_REPO], { fetch, env: { GITHUB_TOKEN: SECRET } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("read with your GitHub token");
    expect(requests.every((q) => q.authorized && q.url.startsWith("https://api.github.com/"))).toBe(
      true,
    );
    const json = await run([DEMO_REPO, "--json"], { fetch, env: { GITHUB_TOKEN: SECRET } });
    for (const out of [r.stdout, r.stderr, json.stdout, json.stderr])
      expect(out).not.toContain(SECRET);
  });

  it("falls back to `gh auth token`, and --anonymous asks for no token at all", async () => {
    const asked: string[] = [];
    const exec: Exec = async (cmd, args) => {
      asked.push([cmd, ...args].join(" "));
      return cmd === "gh" ? SECRET : null;
    };
    const { fetch, requests } = api();
    await run([DEMO_REPO], { fetch, exec });
    expect(asked).toEqual(["gh auth token"]);
    expect(requests.every((q) => q.authorized)).toBe(true);

    asked.length = 0;
    const anon = api();
    const r = await run([DEMO_REPO, "--anonymous"], { fetch: anon.fetch, exec });
    expect(asked).toEqual([]);
    expect(anon.requests.every((q) => !q.authorized)).toBe(true);
    expect(r.stdout).toContain("read without a token (public repos only)");
  });

  it("with no argument: the Action's own repo, or the checkout's origin", async () => {
    const { fetch } = api();
    const inAction = await run(["--json"], {
      fetch,
      env: { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: DEMO_REPO },
    });
    expect(JSON.parse(inAction.stdout).repo).toBe(DEMO_REPO);
    const fromGit = await run(["--json"], {
      fetch,
      exec: async (cmd, args) =>
        cmd === "git" && args.join(" ") === "remote get-url origin"
          ? `git@github.com:${DEMO_REPO}.git`
          : null,
    });
    expect(JSON.parse(fromGit.stdout).repo).toBe(DEMO_REPO);
  });

  it("a GitHub error is the CLI's error: code, cause, fix, retryable", async () => {
    const { fetch } = fakeGitHub(new DemoSource(), DEMO_REPO, {
      status: () => ({ status: 403, headers: { "x-ratelimit-remaining": "0" } }),
    });
    const r = await run([DEMO_REPO, "--json"], { fetch });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error).toMatchObject({ code: "RATE_LIMITED", retryable: true });
  });
});
