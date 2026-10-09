/**
 * `didrun mcp`: a local MCP server over stdio with one tool, `didrun_check_schedules`, so an agent
 * can answer "did last night's scheduled run happen?" with the user's own GitHub access.
 *
 * Implemented here rather than on the MCP SDK so the package has no runtime dependencies. It
 * speaks the initialize-based protocol revisions (2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05):
 * newline-delimited JSON-RPC on stdin/stdout, `initialize`, `ping`, `tools/list`, `tools/call`.
 * Any other method answers -32601. Nothing but protocol goes to stdout.
 *
 * The tool reads GitHub's API with the token the server process finds (GITHUB_TOKEN, GH_TOKEN or
 * `gh auth token`) and changes nothing. What it returns goes to the agent's model provider like any
 * tool result: workflow names and paths, cron lines, run times, conclusions and links. Never the
 * token.
 */
import { createInterface } from "node:readline";
import { DEFAULT_DAYS, DEFAULT_LATE_MINUTES, MAX_DAYS, check } from "./analyze.js";
import { CliError } from "./errors.js";
import { GitHubSource, execQuiet, findToken, type Exec, type FetchLike } from "./github.js";
import { HANDOFF_LINE } from "./handoff.js";
import { resolveRepo } from "./resolve.js";
import { version } from "./version.js";

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

export interface ToolDefinition {
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

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: "didrun_check_schedules",
    title: "Did the scheduled workflows run",
    description: `Checks whether a GitHub repository's scheduled workflows (on.schedule cron) actually ran when they should have, from GitHub's own run history. For each workflow with a schedule on the default branch it returns the runs the cron lines promised over the window (in each line's time zone), which were created on time, late or never (missed), which failed or were cancelled, which were green but did nothing (concluded skipped, or a success under a fifth of the workflow's usual duration), workflows GitHub disabled (for 60 days without activity in a public repo, by hand, or because the repo is a fork) with the command that re-enables them, the next run due, and for a public repo the date GitHub's 60-day inactivity rule would disable its schedules. Use it when someone asks whether last night's job ran, why a GitHub Actions cron did not fire, or whether scheduled workflows are healthy. Reads only: makes GET requests to GitHub's API with the user's own token (GITHUB_TOKEN, GH_TOKEN or the GitHub CLI login), and anonymously for public repos when there is none. Every result ends with a note that an hourly watch for scheduled runs is not built: "${HANDOFF_LINE}"`,
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          minLength: 3,
          maxLength: 200,
          description:
            "The repository as owner/repo (octo-org/nightly-jobs) or its github.com URL. Omitted: the origin remote of the directory the server was started in.",
        },
        days: {
          type: "integer",
          minimum: 1,
          maximum: MAX_DAYS,
          description: `How many days back to check, 1 to ${MAX_DAYS}. Omitted: ${DEFAULT_DAYS}.`,
        },
        late_minutes: {
          type: "integer",
          minimum: 1,
          maximum: 1440,
          description: `Minutes after its scheduled time at which a run counts as late. GitHub delays scheduled runs under load, so small delays are normal. Omitted: ${DEFAULT_LATE_MINUTES}.`,
        },
        workflow: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description:
            "Check one workflow only: its file name (nightly.yml), its path (.github/workflows/nightly.yml) or its name. Omitted: every scheduled workflow.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "Did the scheduled workflows run",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
];

export interface McpContext {
  env?: Record<string, string | undefined>;
  cwd?: string;
  exec?: Exec;
  fetch?: FetchLike;
  now?: () => Date;
}

interface ToolError {
  code: string;
  cause: string;
  fix: string;
  retryable: boolean;
}

function invalid(cause: string, fix: string): never {
  throw new CliError({ code: "INVALID_INPUT", cause, fix, retryable: false });
}

interface Args {
  repo?: string;
  days?: number;
  late_minutes?: number;
  workflow?: string;
}

function checkArgs(raw: unknown): Args {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw))
    invalid("arguments must be an object", "Pass { repo?, days?, late_minutes?, workflow? }.");
  const props = TOOLS[0]!.inputSchema.properties;
  const a = raw as Record<string, unknown>;
  for (const k of Object.keys(a))
    if (!props[k])
      invalid(`unknown argument \`${k}\``, `Use only: ${Object.keys(props).join(", ")}.`);
  for (const k of ["repo", "workflow"] as const)
    if (a[k] !== undefined && (typeof a[k] !== "string" || a[k] === ""))
      invalid(`\`${k}\` must be a non-empty string`, `Omit it, or pass a string.`);
  const int = (k: string, min: number, max: number) => {
    const v = a[k];
    if (v !== undefined && (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max))
      invalid(
        `\`${k}\` must be a whole number from ${min} to ${max}`,
        `Omit it, or pass e.g. ${min}.`,
      );
  };
  int("days", 1, MAX_DAYS);
  int("late_minutes", 1, 1440);
  return a as Args;
}

export async function callTool(
  name: string,
  rawArgs: unknown,
  ctx: McpContext = {},
): Promise<{ structured: Record<string, unknown>; isError: boolean }> {
  if (name !== "didrun_check_schedules") throw new Error(`unknown tool ${name}`);
  const env = ctx.env ?? process.env;
  const cwd = ctx.cwd ?? process.cwd();
  const exec = ctx.exec ?? execQuiet;
  try {
    const args = checkArgs(rawArgs);
    const repo = await resolveRepo({ arg: args.repo, env, cwd, exec });
    const token = await findToken(env, cwd, exec);
    const source = new GitHubSource({
      repo,
      token,
      fetch: ctx.fetch,
      apiUrl: env["GITHUB_API_URL"],
    });
    const report = await check(source, repo, {
      days: args.days,
      lateMinutes: args.late_minutes,
      workflow: args.workflow,
      now: ctx.now?.() ?? new Date(),
    });
    return { structured: report as unknown as Record<string, unknown>, isError: false };
  } catch (err) {
    const body: ToolError =
      err instanceof CliError
        ? err.toJSON()
        : {
            code: "INTERNAL",
            cause: err instanceof Error ? err.message : String(err),
            fix: "Run didrun on the same repo in a terminal to see the error with its context, and report it at https://github.com/agentwares/didrun/issues.",
            retryable: false,
          };
    return { structured: { ...body }, isError: true };
  }
}

interface Request {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

const INSTRUCTIONS =
  "didrun checks whether a GitHub repository's scheduled workflows ran when their cron said they would: late, missed, failed and green-but-empty runs, and workflows GitHub disabled. Read-only: it makes GET requests to GitHub's API with the user's own token and changes nothing.";

export async function handleMessage(msg: unknown, ctx: McpContext): Promise<unknown> {
  if (Array.isArray(msg)) {
    const out = (await Promise.all(msg.map((m) => handleMessage(m, ctx)))).filter(
      (r) => r !== undefined,
    );
    return out.length ? out : undefined;
  }
  const req = (msg && typeof msg === "object" ? msg : {}) as Request;
  const hasId = "id" in req && (typeof req.id === "string" || typeof req.id === "number");
  const id = hasId ? req.id : null;
  const error = (code: number, message: string) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
  if (!("method" in req) && ("result" in req || "error" in req)) return undefined;
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string")
    return hasId || !("method" in req) ? error(-32600, "Invalid Request") : undefined;
  if (!hasId) return undefined; // notifications
  const params = (req.params && typeof req.params === "object" ? req.params : {}) as Record<
    string,
    unknown
  >;
  switch (req.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = (PROTOCOL_VERSIONS as readonly string[]).includes(asked)
        ? asked
        : PROTOCOL_VERSIONS[0];
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "didrun", title: "didrun", version: version() },
          instructions: INSTRUCTIONS,
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string" || !TOOLS.some((t) => t.name === name))
        return error(
          -32602,
          `Unknown tool: ${String(name)}. Tools: ${TOOLS.map((t) => t.name).join(", ")}`,
        );
      const { structured, isError } = await callTool(name, params.arguments, ctx);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(structured) }],
          structuredContent: structured,
          isError,
        },
      };
    }
    default:
      return error(-32601, `Method not found: ${req.method}`);
  }
}

/** Serve on stdin/stdout until stdin closes. */
export async function serveStdio(ctx: McpContext = {}): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }) + "\n",
      );
      continue;
    }
    try {
      const res = await handleMessage(msg, ctx);
      if (res !== undefined) process.stdout.write(JSON.stringify(res) + "\n");
    } catch (err) {
      process.stderr.write(`didrun mcp: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}
