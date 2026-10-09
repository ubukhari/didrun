import { describe, expect, it } from "vitest";
import { check } from "./analyze.js";
import { DEMO_NOW, DEMO_REPO, DemoSource } from "./demo.js";
import type { CliError } from "./errors.js";
import { GitHubSource, findToken, parseRepo, repoFromGit, type Exec } from "./github.js";
import { fakeGitHub } from "./testing.js";

describe("parseRepo", () => {
  it.each([
    ["octo-org/nightly-jobs", "octo-org/nightly-jobs"],
    ["https://github.com/octo-org/nightly-jobs", "octo-org/nightly-jobs"],
    ["https://github.com/octo-org/nightly-jobs.git", "octo-org/nightly-jobs"],
    ["https://user@github.com/octo-org/nightly.jobs/", "octo-org/nightly.jobs"],
    ["git@github.com:octo-org/nightly-jobs.git", "octo-org/nightly-jobs"],
    ["ssh://git@github.com/octo-org/nightly-jobs.git", "octo-org/nightly-jobs"],
  ])("%s → %s", (input, repo) => expect(parseRepo(input)).toBe(repo));

  it.each(["nightly-jobs", "https://gitlab.com/a/b", "a/b/c", "../x"])(
    "%s is not a repo",
    (input) => expect(parseRepo(input)).toBeNull(),
  );
});

describe("finding the repo and the token", () => {
  const exec =
    (answers: Record<string, string | null>): Exec =>
    async (cmd, args) =>
      answers[[cmd, ...args].join(" ")] ?? null;

  it("the checkout's origin, when it is on github.com", async () => {
    expect(
      await repoFromGit("/x", exec({ "git remote get-url origin": "git@github.com:a/b.git" })),
    ).toBe("a/b");
    expect(
      await repoFromGit("/x", exec({ "git remote get-url origin": "https://gitlab.com/a/b" })),
    ).toBeNull();
    expect(await repoFromGit("/x", exec({}))).toBeNull();
  });

  it("GITHUB_TOKEN, then GH_TOKEN, then gh auth token; none is null", async () => {
    const gh = exec({ "gh auth token": "from-gh" });
    expect(await findToken({ GITHUB_TOKEN: "a", GH_TOKEN: "b" }, "/x", gh)).toBe("a");
    expect(await findToken({ GITHUB_TOKEN: " ", GH_TOKEN: "b" }, "/x", gh)).toBe("b");
    expect(await findToken({}, "/x", gh)).toBe("from-gh");
    expect(await findToken({}, "/x", exec({}))).toBeNull();
  });
});

describe("GitHubSource", () => {
  it("reads the demo through GitHub's API shape: the same report as the fixtures give", async () => {
    const { fetch, requests } = fakeGitHub(new DemoSource(), DEMO_REPO);
    const source = new GitHubSource({ repo: DEMO_REPO, token: "t", fetch });
    const viaApi = await check(source, DEMO_REPO, { now: DEMO_NOW });
    const direct = await check(new DemoSource(), DEMO_REPO, { now: DEMO_NOW });
    expect({ ...viaApi, read_with: "x" }).toEqual({ ...direct, read_with: "x" });
    expect(viaApi.read_with).toBe("token");
    // every request is a GET to api.github.com, with the token in the header and never in the URL
    for (const r of requests) {
      expect(new URL(r.url).origin).toBe("https://api.github.com");
      expect(r.authorized).toBe(true);
      expect(r.url).not.toContain("t@");
      expect(new URL(r.url).searchParams.has("access_token")).toBe(false);
    }
    // file contents come raw
    const contents = requests.filter((r) => r.url.includes("/contents/"));
    expect(contents.length).toBe(5);
    for (const r of contents) expect(r.accept).toBe("application/vnd.github.raw+json");
    // runs are asked for by event and date, never all of them
    const runs = requests.filter((r) => /\/runs\?/.test(r.url));
    for (const r of runs) expect(new URL(r.url).searchParams.get("event")).toBe("schedule");
    expect(source.requests).toBe(requests.length);
  });

  it("anonymous: no Authorization header at all", async () => {
    const { fetch, requests } = fakeGitHub(new DemoSource(), DEMO_REPO);
    const source = new GitHubSource({ repo: DEMO_REPO, token: null, fetch });
    expect(source.auth).toBe("anonymous");
    await source.repo();
    expect(requests.every((r) => !r.authorized)).toBe(true);
  });

  it("GITHUB_API_URL is honoured for GitHub Enterprise runners", async () => {
    const seen: string[] = [];
    const source = new GitHubSource({
      repo: "a/b",
      token: null,
      apiUrl: "https://ghe.example/api/v3/",
      fetch: async (url) => {
        seen.push(url);
        return new Response(JSON.stringify({ total_count: 0, workflows: [] }));
      },
    });
    await source.workflows();
    expect(seen[0]).toBe(
      "https://ghe.example/api/v3/repos/a/b/actions/workflows?per_page=100&page=1",
    );
  });

  const errorFor = async (
    status: number,
    headers: Record<string, string> = {},
    token: string | null = null,
  ) => {
    const { fetch } = fakeGitHub(new DemoSource(), DEMO_REPO, {
      status: () => ({ status, headers }),
    });
    try {
      await new GitHubSource({ repo: DEMO_REPO, token, fetch }).repo();
    } catch (e) {
      return e as CliError;
    }
    throw new Error("no error");
  };

  it("404 on the repo: REPO_NOT_FOUND, with the fix for a private repo", async () => {
    const e = await errorFor(404);
    expect(e.code).toBe("REPO_NOT_FOUND");
    expect(e.fix).toMatch(/gh auth login/);
  });

  it("rate limit: RATE_LIMITED, retryable, with the reset time", async () => {
    const e = await errorFor(403, {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": "1791547200",
    });
    expect(e).toMatchObject({ code: "RATE_LIMITED", retryable: true });
    expect(e.cause).toMatch(/60 requests an hour without a token\); it resets at 2026-10-09T/);
    expect((await errorFor(429, {}, "t")).fix).toMatch(/wait for the reset/);
  });

  it("401 and other 403s say what to change", async () => {
    expect((await errorFor(401, {}, "t")).code).toBe("BAD_CREDENTIALS");
    expect((await errorFor(403, { "x-ratelimit-remaining": "4000" }, "t")).code).toBe("FORBIDDEN");
    expect(await errorFor(502)).toMatchObject({ code: "GITHUB_ERROR", retryable: true });
  });

  it("a network failure is GITHUB_UNREACHABLE and retryable", async () => {
    const source = new GitHubSource({
      repo: "a/b",
      token: null,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(source.repo()).rejects.toMatchObject({
      code: "GITHUB_UNREACHABLE",
      retryable: true,
    });
  });

  it("pages through runs until GitHub has no more", async () => {
    const urls: string[] = [];
    const run = (n: number) => ({ id: n, created_at: "2026-10-01T00:00:00Z", event: "schedule" });
    const source = new GitHubSource({
      repo: "a/b",
      token: null,
      fetch: async (url) => {
        urls.push(url);
        const page = Number(new URL(url).searchParams.get("page"));
        const body = {
          total_count: 250,
          workflow_runs: Array.from({ length: page < 3 ? 100 : 50 }, (_, i) =>
            run(page * 1000 + i),
          ),
        };
        return new Response(JSON.stringify(body));
      },
    });
    expect(await source.runs(7, "2026-10-01T00:00:00.000Z")).toHaveLength(250);
    expect(urls).toHaveLength(3);
    expect(decodeURIComponent(urls[0]!)).toContain("created=>=2026-10-01T00:00:00Z");
  });
});
