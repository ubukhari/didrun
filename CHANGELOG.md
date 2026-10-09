# Changelog

## 0.1.0 (2026-10-09)

First release.

- `didrun [owner/repo]` reads GitHub's own record of a repo with the user's token (`GITHUB_TOKEN`,
  `GH_TOKEN` or `gh auth token`), or with none for a public repo:
  - each workflow's state;
  - the `on.schedule` cron lines and `timezone` of each workflow file on the default branch;
  - each workflow's `event=schedule` runs.
- It reports, per scheduled workflow:
  - the runs the lines promised over the last 7 days (`--days`, up to 30);
  - which were created on time, late (`--late`, default 30 minutes) or never;
  - which failed or were cancelled;
  - which were green but did nothing: skipped, or under a fifth of the usual success;
  - workflows GitHub disabled (60 days without activity, by hand, or in a fork), with the command
    that re-enables them;
  - for a public repo, the days left before the 60-day rule.
- Cron in UTC or the line's IANA time zone, with GitHub's rule for the hour clocks skip. A schedule
  is counted only from when its file last changed.
- `--json`, `--workflow`, `--fail-on missed|problem|never`, `--anonymous`, and `demo` on a synthetic
  repo with no network.
- A GitHub Action (`action.yml`) that runs the committed `dist/` and writes the report to the job
  summary.
- `didrun mcp`: one read-only MCP tool, `didrun_check_schedules`, over stdio.
- A Claude Code plugin with the `/didrun:didrun` skill.
- Errors carry `code`, `cause`, `fix` and `retryable`. No runtime dependencies, no account, no LLM
  calls.
