/** The library behind the CLI: read a repo's schedules and runs, and say which runs came. */
export {
  DEFAULT_DAYS,
  DEFAULT_LATE_MINUTES,
  INACTIVITY_DAYS,
  MAX_DAYS,
  check,
  failed,
  matchRuns,
  span,
} from "./analyze.js";
export type {
  CheckOptions,
  Counts,
  FailOn,
  Finding,
  FindingKind,
  Outcome,
  Report,
  RunSummary,
  WorkflowReport,
} from "./analyze.js";
export { CronError, fireTimes, matches, nextFire, parseCron } from "./cron.js";
export type { CronSpec } from "./cron.js";
export { DEMO_NOW, DEMO_REPO, DemoSource } from "./demo.js";
export { CliError, type Problem } from "./errors.js";
export { GitHubSource, findToken, parseRepo, repoFromGit } from "./github.js";
export type { RepoInfo, RunInfo, Source, WorkflowInfo } from "./github.js";
export { HANDOFF_LINE, HANDOFF_URL, PAGES_URL } from "./handoff.js";
export { main } from "./main.js";
export { TOOLS } from "./mcp.js";
export { headline, renderJson, renderText } from "./render.js";
export { schedulesOf, type Schedule } from "./workflow.js";

/** The day the README sample was recorded on (scripts/sample.mjs): the demo's own clock. */
export const SAMPLE_DATE = "2026-10-09";
