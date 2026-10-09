/**
 * What didrun reads from GitHub, and how. Every request is a GET to the GitHub REST API
 * (`api.github.com`, or `GITHUB_API_URL` inside a GitHub Enterprise runner); nothing goes anywhere
 * else. Endpoints, from GitHub's REST reference (read 9 Oct 2026):
 *
 *   GET /repos/{owner}/{repo}                                    visibility, default branch, last push
 *   GET /repos/{owner}/{repo}/actions/workflows                  each workflow's `state`
 *   GET /repos/{owner}/{repo}/contents/{path}?ref={branch}       the file, for its `on.schedule`
 *   GET /repos/{owner}/{repo}/commits?path={path}&per_page=1     when the file last changed
 *   GET /repos/{owner}/{repo}/actions/workflows/{id}/runs?event=schedule&created=>=…
 *
 * Public repos read without a token (60 requests an hour); private ones need the `repo` scope on a
 * classic token, or Actions and Contents read on a fine-grained one. The token comes from
 * `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token`, in that order. It is sent only in the
 * Authorization header of these requests, and never printed, logged or written anywhere.
 */
import { execFile } from "node:child_process";
import { CliError } from "./errors.js";
import { version } from "./version.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RepoInfo {
  full_name: string;
  private: boolean;
  default_branch: string;
  pushed_at: string;
  archived: boolean;
  fork: boolean;
  html_url: string;
}

export interface WorkflowInfo {
  id: number;
  name: string;
  path: string;
  state: string;
  html_url: string;
  updated_at?: string;
}

export interface RunInfo {
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
export interface Source {
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
export function parseRepo(text: string): string | null {
  const t = text
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  const patterns = [
    /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/,
    /^(?:https?:\/\/|git:\/\/)(?:[^@/]+@)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/,
    /^(?:ssh:\/\/)?git@github\.com[:/]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/,
  ];
  for (const p of patterns) {
    const m = p.exec(t);
    if (m) return `${m[1]}/${m[2]}`;
  }
  return null;
}

/** Run a command and return its trimmed stdout, or null if it is missing, fails or takes too long. */
export type Exec = (cmd: string, args: string[], cwd: string) => Promise<string | null>;

export const execQuiet: Exec = (cmd, args, cwd) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 5_000, windowsHide: true }, (err, stdout) =>
      resolve(err ? null : String(stdout).trim() || null),
    );
  });

/** The repo the current checkout's `origin` points at, if it is on github.com. */
export async function repoFromGit(cwd: string, exec: Exec = execQuiet): Promise<string | null> {
  const url = await exec("git", ["remote", "get-url", "origin"], cwd);
  return url ? parseRepo(url) : null;
}

/**
 * The user's own token, without printing it: `GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth
 * token` (the GitHub CLI's stored login). Null when there is none, which reads public repos only.
 */
export async function findToken(
  env: Record<string, string | undefined>,
  cwd: string,
  exec: Exec = execQuiet,
): Promise<string | null> {
  for (const k of ["GITHUB_TOKEN", "GH_TOKEN"]) {
    const v = env[k]?.trim();
    if (v) return v;
  }
  return exec("gh", ["auth", "token"], cwd);
}

const MAX_RUN_PAGES = 10; // 1,000 runs: the most GitHub returns for a filtered list
const MAX_WORKFLOW_PAGES = 3;

export interface GitHubOptions {
  repo: string;
  token: string | null;
  fetch?: FetchLike;
  apiUrl?: string;
}

export class GitHubSource implements Source {
  readonly auth: string;
  private readonly base: string;
  private readonly repoPath: string;
  private readonly fetchImpl: FetchLike;
  private readonly token: string | null;
  /** requests made, for the report's footer */
  requests = 0;

  constructor(opts: GitHubOptions) {
    this.base = (opts.apiUrl || "https://api.github.com").replace(/\/+$/, "");
    this.repoPath = `/repos/${opts.repo}`;
    this.token = opts.token;
    this.auth = opts.token ? "token" : "anonymous";
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
  }

  private async get(path: string, accept = "application/vnd.github+json"): Promise<Response> {
    const headers: Record<string, string> = {
      accept,
      "x-github-api-version": "2022-11-28",
      "user-agent": `didrun/${version()} (+https://github.com/agentwares/didrun)`,
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    this.requests++;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        headers,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new CliError({
        code: "GITHUB_UNREACHABLE",
        cause: `could not reach ${this.base}: ${e instanceof Error ? e.message : String(e)}`,
        fix: "check the network and try again",
        retryable: true,
      });
    }
    if (res.ok || res.status === 404) return res;
    const remaining = res.headers.get("x-ratelimit-remaining");
    if ((res.status === 403 || res.status === 429) && (remaining === "0" || res.status === 429)) {
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const at = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null;
      throw new CliError({
        code: "RATE_LIMITED",
        cause: `GitHub's API rate limit is spent${this.token ? "" : " (60 requests an hour without a token)"}${at ? `; it resets at ${at}` : ""}`,
        fix: this.token
          ? "wait for the reset and run it again"
          : "sign in with `gh auth login`, or set GITHUB_TOKEN, for 5,000 requests an hour; or wait for the reset",
        retryable: true,
      });
    }
    if (res.status === 401)
      throw new CliError({
        code: "BAD_CREDENTIALS",
        cause: "GitHub refused the token (401 Bad credentials)",
        fix: "refresh it with `gh auth login` or set a valid GITHUB_TOKEN; `--anonymous` reads a public repo with none",
        retryable: false,
      });
    if (res.status === 403)
      throw new CliError({
        code: "FORBIDDEN",
        cause: `GitHub answered 403 for ${path}`,
        fix: "the token needs read access to Actions and Contents on this repo (classic tokens: the repo scope)",
        retryable: false,
      });
    throw new CliError({
      code: "GITHUB_ERROR",
      cause: `GitHub answered ${res.status} for ${path}`,
      fix: "try again in a minute; if it persists, check https://www.githubstatus.com",
      retryable: res.status >= 500,
    });
  }

  private async json<T>(path: string): Promise<T | null> {
    const res = await this.get(path);
    if (res.status === 404) return null;
    return (await res.json()) as T;
  }

  async repo(): Promise<RepoInfo> {
    const r = await this.json<RepoInfo>(this.repoPath);
    if (!r)
      throw new CliError({
        code: "REPO_NOT_FOUND",
        cause: `GitHub has no repository ${this.repoPath.slice(7)} that ${this.token ? "this token can read" : "can be read without a token"}`,
        fix: this.token
          ? "check the owner/repo spelling, and that the token can read this repo"
          : "check the spelling; a private repo needs your token (`gh auth login`, or GITHUB_TOKEN)",
        retryable: false,
      });
    return r;
  }

  async workflows(): Promise<WorkflowInfo[]> {
    const out: WorkflowInfo[] = [];
    for (let page = 1; page <= MAX_WORKFLOW_PAGES; page++) {
      const body = await this.json<{ total_count: number; workflows: WorkflowInfo[] }>(
        `${this.repoPath}/actions/workflows?per_page=100&page=${page}`,
      );
      if (!body) break;
      out.push(...body.workflows);
      if (out.length >= body.total_count || body.workflows.length < 100) break;
    }
    return out;
  }

  async file(path: string, ref: string): Promise<string | null> {
    const res = await this.get(
      `${this.repoPath}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
      "application/vnd.github.raw+json",
    );
    if (res.status === 404) return null;
    return res.text();
  }

  async lastChange(path: string, ref: string): Promise<string | null> {
    const body = await this.json<{ commit?: { committer?: { date?: string } } }[]>(
      `${this.repoPath}/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(ref)}&per_page=1`,
    );
    return body?.[0]?.commit?.committer?.date ?? null;
  }

  async runs(workflowId: number, sinceIso: string): Promise<RunInfo[]> {
    const out: RunInfo[] = [];
    const created = encodeURIComponent(`>=${sinceIso.replace(/\.\d{3}Z$/, "Z")}`);
    for (let page = 1; page <= MAX_RUN_PAGES; page++) {
      const body = await this.json<{ total_count: number; workflow_runs: RunInfo[] }>(
        `${this.repoPath}/actions/workflows/${workflowId}/runs?event=schedule&created=${created}&per_page=100&page=${page}`,
      );
      if (!body) break;
      out.push(...body.workflow_runs);
      if (out.length >= body.total_count || body.workflow_runs.length < 100) break;
    }
    return out;
  }

  async latestRun(workflowId: number): Promise<RunInfo | null> {
    const body = await this.json<{ workflow_runs: RunInfo[] }>(
      `${this.repoPath}/actions/workflows/${workflowId}/runs?event=schedule&per_page=1`,
    );
    return body?.workflow_runs[0] ?? null;
  }
}
