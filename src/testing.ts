/**
 * For the tests: GitHub's REST API, faked over any {@link Source}, so the real `GitHubSource`
 * (URLs, headers, pagination, errors) runs against recorded data with no network. Not part of the
 * CLI or the library's exports.
 */
import type { FetchLike, Source } from "./github.js";

export interface FakeRequest {
  url: string;
  accept: string | null;
  /** whether an Authorization header was sent; its value is never kept */
  authorized: boolean;
}

export function fakeGitHub(
  source: Source,
  repo: string,
  opts: {
    status?: (path: string) => { status: number; headers?: Record<string, string> } | null;
  } = {},
): { fetch: FetchLike; requests: FakeRequest[] } {
  const requests: FakeRequest[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch: FetchLike = async (raw, init) => {
    const headers = new Headers(init?.headers);
    requests.push({
      url: raw,
      accept: headers.get("accept"),
      authorized: headers.has("authorization"),
    });
    const u = new URL(raw);
    const forced = opts.status?.(u.pathname);
    if (forced) return new Response("{}", { status: forced.status, headers: forced.headers });
    const base = `/repos/${repo}`;
    if (u.pathname === base) return json(await source.repo());
    if (u.pathname === `${base}/actions/workflows`) {
      const all = await source.workflows();
      const page = Number(u.searchParams.get("page") ?? 1);
      const per = Number(u.searchParams.get("per_page") ?? 30);
      return json({ total_count: all.length, workflows: all.slice((page - 1) * per, page * per) });
    }
    if (u.pathname.startsWith(`${base}/contents/`)) {
      const path = decodeURIComponent(u.pathname.slice(`${base}/contents/`.length));
      const text = await source.file(path, u.searchParams.get("ref") ?? "");
      return text === null ? json({ message: "Not Found" }, 404) : new Response(text);
    }
    if (u.pathname === `${base}/commits`) {
      const date = await source.lastChange(
        u.searchParams.get("path") ?? "",
        u.searchParams.get("sha") ?? "",
      );
      return json(date ? [{ commit: { committer: { date } } }] : []);
    }
    const runs = new RegExp(`^${base}/actions/workflows/(\\d+)/runs$`).exec(u.pathname);
    if (runs) {
      const id = Number(runs[1]);
      const created = u.searchParams.get("created");
      if (!created) {
        const latest = await source.latestRun(id);
        return json({ total_count: latest ? 1 : 0, workflow_runs: latest ? [latest] : [] });
      }
      const all = await source.runs(id, created.replace(/^>=/, ""));
      const page = Number(u.searchParams.get("page") ?? 1);
      const per = Number(u.searchParams.get("per_page") ?? 30);
      return json({
        total_count: all.length,
        workflow_runs: all.slice((page - 1) * per, page * per),
      });
    }
    return json({ message: "Not Found" }, 404);
  };
  return { fetch, requests };
}
