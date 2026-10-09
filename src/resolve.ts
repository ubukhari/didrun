/** Which repo a check reads: the argument, the Action's own repo, or the checkout's origin. */
import { CliError, usage } from "./errors.js";
import { parseRepo, repoFromGit, type Exec } from "./github.js";
import { INSTALL } from "./install.js";

export interface ResolveInput {
  arg: string | undefined;
  env: Record<string, string | undefined>;
  cwd: string;
  exec: Exec;
}

/** The repo to check: the argument, the Action's own repo, or the checkout's origin. */
export async function resolveRepo({ arg, env, cwd, exec }: ResolveInput): Promise<string> {
  if (arg !== undefined) {
    const repo = parseRepo(arg);
    if (!repo)
      throw usage(
        `"${arg}" is not owner/repo or a github.com URL`,
        `e.g. \`${INSTALL} octo-org/nightly-jobs\``,
      );
    return repo;
  }
  if (env["GITHUB_ACTIONS"] === "true" && env["GITHUB_REPOSITORY"]) {
    const repo = parseRepo(env["GITHUB_REPOSITORY"]);
    if (repo) return repo;
  }
  const fromGit = await repoFromGit(cwd, exec);
  if (fromGit) return fromGit;
  throw new CliError(
    {
      code: "NO_REPO",
      cause:
        "no owner/repo given, and this directory is not a checkout whose origin is on github.com",
      fix: `pass the repo: \`${INSTALL} owner/repo\`, or run it inside a clone; \`${INSTALL} demo\` shows the report`,
      retryable: false,
    },
    2,
  );
}
