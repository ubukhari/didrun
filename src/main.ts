/**
 * `didrun` — did your scheduled GitHub workflows run when they should have?
 *
 *   didrun [owner/repo] [--days 7] [--late 30] [--workflow file.yml] [--json] [--fail-on never]
 *   didrun demo [--json]
 *   didrun mcp
 *
 * Reads GitHub's own record of the repo's workflows and their scheduled runs, with your token if
 * you have one (GITHUB_TOKEN, GH_TOKEN or `gh auth token`). Every request goes to GitHub's API;
 * nothing goes anywhere else. No account, no telemetry, no LLM calls.
 */
import { parseArgs } from "node:util";
import {
  DEFAULT_DAYS,
  DEFAULT_LATE_MINUTES,
  MAX_DAYS,
  check,
  failed,
  type FailOn,
} from "./analyze.js";
import { DEMO_NOW, DEMO_REPO, DemoSource } from "./demo.js";
import { CliError, usage } from "./errors.js";
import { GitHubSource, execQuiet, findToken, type Exec, type FetchLike } from "./github.js";
import { PAGES_URL } from "./handoff.js";
import { INSTALL } from "./install.js";
import { serveStdio } from "./mcp.js";
import { renderError, renderJson, renderText } from "./render.js";
import { resolveRepo } from "./resolve.js";
import { version } from "./version.js";

export const HELP = `didrun ${version()} — did your scheduled GitHub workflows run when they should have?

Usage
  ${INSTALL} [owner/repo]
      every workflow with an on.schedule on the default branch, over the last 7 days: the runs
      its cron lines promised (in their time zone), which came on time, late or never, which
      failed, which were green but did nothing (skipped, or far shorter than usual), workflows
      GitHub disabled, and a public repo's days left before the 60-day inactivity rule.
      Without owner/repo it reads the origin remote of the current checkout.
  ${INSTALL} demo
      the same check on a synthetic repo shipped with this package: no network, no token

Options
  --days N          how far back to look, 1-${MAX_DAYS} (default ${DEFAULT_DAYS})
  --late N          minutes after which a run counts as late (default ${DEFAULT_LATE_MINUTES})
  --workflow NAME   one workflow: its file name, path or name
  --json            the report as JSON
  --fail-on MODE    exit 1 when there is a problem: missed (a run never came, or a schedule is
                    disabled), problem (anything above), never (default)
  --anonymous       use no token: public repos only, 60 GitHub requests an hour
  mcp               serve the check as an MCP tool over stdio (didrun_check_schedules)

Token: GITHUB_TOKEN, then GH_TOKEN, then \`gh auth token\`. It is sent only to GitHub's API
(api.github.com, or GITHUB_API_URL on GitHub Enterprise), never printed or stored. Private repos
need Actions and Contents read. No account, no telemetry; no code change in your repo.

Why scheduled runs go missing, one page per cause: ${PAGES_URL}
`;

export interface Deps {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  fetch?: FetchLike;
  now?: () => Date;
  cwd?: string;
  env?: Record<string, string | undefined>;
  exec?: Exec;
}

const defaultDeps: Deps = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
};

export async function main(argv: string[], deps: Deps = defaultDeps): Promise<number> {
  const json = argv.includes("--json");
  try {
    return await run(argv, deps);
  } catch (e) {
    if (e instanceof CliError) {
      (json ? deps.stdout : deps.stderr)(renderError(e.toJSON(), json));
      return e.exitCode;
    }
    throw e;
  }
}

const FAIL_ON: readonly FailOn[] = ["missed", "problem", "never"];

function intOption(
  raw: string | undefined,
  name: string,
  min: number,
  max: number,
  fallback: number,
) {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max)
    throw usage(
      `--${name} must be a whole number from ${min} to ${max}, got "${raw}"`,
      `e.g. --${name} ${fallback}`,
    );
  return Number(raw);
}

async function run(argv: string[], deps: Deps): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        days: { type: "string" },
        late: { type: "string" },
        workflow: { type: "string" },
        json: { type: "boolean" },
        "fail-on": { type: "string" },
        anonymous: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (e) {
    throw usage(
      e instanceof Error ? e.message : String(e),
      `run \`${INSTALL} --help\` for the options`,
    );
  }
  const { values, positionals } = parsed;
  if (values.version) {
    deps.stdout(`${version()}\n`);
    return 0;
  }
  const [first, ...rest] = positionals;
  if (values.help || first === "help") {
    deps.stdout(HELP);
    return 0;
  }
  if (rest.length)
    throw usage(
      `expected at most one repo, got ${positionals.length} arguments`,
      `run \`${INSTALL} owner/repo\``,
    );

  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const exec = deps.exec ?? execQuiet;

  if (first === "mcp") {
    await serveStdio({ env, cwd, exec, fetch: deps.fetch, now: deps.now });
    return 0;
  }

  const days = intOption(values.days, "days", 1, MAX_DAYS, DEFAULT_DAYS);
  const lateMinutes = intOption(values.late, "late", 1, 1440, DEFAULT_LATE_MINUTES);
  const failOn = (values["fail-on"] ?? "never") as FailOn;
  if (!FAIL_ON.includes(failOn))
    throw usage(
      `--fail-on must be ${FAIL_ON.join(", ")}; got "${values["fail-on"]}"`,
      "e.g. --fail-on missed",
    );

  let report;
  if (first === "demo") {
    if (!values.json)
      deps.stdout(`Synthetic repo, written for this demo: not anyone's repo or runs.\n\n`);
    report = await check(new DemoSource(), DEMO_REPO, {
      days,
      lateMinutes,
      now: DEMO_NOW,
      workflow: values.workflow,
    });
  } else {
    const repo = await resolveRepo({ arg: first, env, cwd, exec });
    const token = values.anonymous ? null : await findToken(env, cwd, exec);
    const source = new GitHubSource({
      repo,
      token,
      fetch: deps.fetch,
      apiUrl: env["GITHUB_API_URL"],
    });
    report = await check(source, repo, {
      days,
      lateMinutes,
      now: deps.now?.() ?? new Date(),
      workflow: values.workflow,
    });
  }
  deps.stdout(values.json ? renderJson(report) : renderText(report));
  return failed(report, failOn) ? 1 : 0;
}
