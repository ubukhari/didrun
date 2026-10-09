/**
 * The files that put didrun where people already are: the package manifest, the README and its
 * recorded sample, this package's CHANGELOG, the GitHub Action, and the repo-root files the sync
 * copies from `distribution/root` (action.yml and the Claude Code plugin marketplace). The public
 * repo has those at its root, so their checks run in the monorepo only; `scripts/sync-oss-repos.sh`
 * re-validates them.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HANDOFF_LINE, HANDOFF_URL } from "./handoff.js";
import { ACTION, INSTALL, ON_NPM, PUBLISHED, REPO, RUN } from "./install.js";
import { main } from "./main.js";

const here = (rel: string): URL => new URL(`../${rel}`, import.meta.url);
const read = (rel: string): string => readFileSync(here(rel), "utf8");
const json = <T>(rel: string): T => JSON.parse(read(rel)) as T;
const pkg = json<{
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  files: string[];
  bin: Record<string, string>;
}>("package.json");

async function demoOutput(): Promise<string> {
  let out = "";
  await main(["demo"], { stdout: (s) => (out += s), stderr: () => undefined });
  return out;
}

describe("package", () => {
  it("is didrun with no runtime dependencies", () => {
    expect(pkg.name).toBe("didrun");
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.bin).toEqual({ didrun: "./dist/cli.js" });
    expect(pkg.files).toEqual(expect.arrayContaining(["dist", "README.md", "CHANGELOG.md"]));
  });

  it("CHANGELOG has a section for this version", () => {
    expect(read("CHANGELOG.md")).toMatch(
      new RegExp(`^## ${pkg.version.replace(/\./g, "\\.")} `, "m"),
    );
  });
});

describe("README", () => {
  const readme = read("README.md");

  it("leads with the one-line use", () => {
    expect(readme).toContain("```sh\n" + INSTALL + "\n```");
  });

  it("the recorded sample is the CLI's real output on the synthetic repo (`node scripts/sample.mjs`)", async () => {
    const out = await demoOutput();
    expect(readme).toContain("**synthetic**");
    expect(readme).toContain("```text\n" + out.trimEnd() + "\n```");
  });

  it("says what it reads and where the token goes, and names the Action and the MCP tool", () => {
    expect(readme).toContain("GITHUB_API_URL");
    expect(readme).toContain("never printed");
    expect(readme).toContain(`uses: ${ACTION}`);
    expect(readme).toContain(`${RUN} mcp`);
    expect(readme).toContain("didrun_check_schedules");
  });

  it("the hand-off is the heading of its section, worded as not built", () => {
    expect(readme).toContain(`## ${HANDOFF_LINE.replace(/\.$/, "")}\n`);
    expect(readme).toContain(HANDOFF_URL);
    expect(readme).toContain("It does not exist yet");
  });
});

const root = "distribution/root";
const frontmatter = (text: string): Record<string, string> =>
  Object.fromEntries(
    (text.split("---")[1] ?? "")
      .split("\n")
      .map((l) => /^([a-z-]+):\s*(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1]!, m[2]!.replace(/^"|"$/g, "")]),
  );

describe.skipIf(!existsSync(here(root)))("repo-root files (distribution/root)", () => {
  it("the marketplace's plugin resolves, and versions match this package", () => {
    const marketplace = json<{
      name: string;
      owner: { name: string };
      plugins: { name: string; source: string }[];
    }>(`${root}/.claude-plugin/marketplace.json`);
    // okgate's marketplace is "agentwares"; the same name here would clash
    expect(marketplace.name).toBe("didrun");
    expect(marketplace.owner.name).toBe("agentwares");
    expect(marketplace.plugins).toHaveLength(1);
    for (const entry of marketplace.plugins) {
      expect(entry.source.startsWith("./")).toBe(true);
      const plugin = json<{ name: string; version: string }>(
        `${root}/${entry.source.slice(2)}/.claude-plugin/plugin.json`,
      );
      expect(plugin.name).toBe(entry.name);
      expect(plugin.version).toBe(pkg.version);
    }
  });

  it("plugin.json carries the links a directory listing needs", () => {
    const plugin = json<Record<string, unknown>>(
      `${root}/plugins/didrun/.claude-plugin/plugin.json`,
    );
    for (const key of [
      "homepage",
      "documentationUrl",
      "repository",
      "privacyPolicyUrl",
      "termsOfServiceUrl",
      "supportUrl",
    ])
      expect(String(plugin[key])).toMatch(/^https:\/\//);
  });

  it("the skill runs the published CLI", () => {
    const skills = readdirSync(here(`${root}/plugins/didrun/skills`));
    expect(skills).toEqual(["didrun"]);
    const text = read(`${root}/plugins/didrun/skills/didrun/SKILL.md`);
    const front = frontmatter(text);
    expect(front.name).toBe("didrun");
    expect(front.description!.length).toBeGreaterThan(80);
    expect(front.description!.length).toBeLessThanOrEqual(1024);
    expect(text).toContain(`${RUN} $ARGUMENTS --json`);
  });

  it("nothing pre-approves a tool: Claude Code asks before every command", () => {
    const walk = (dir: string): string[] =>
      readdirSync(here(dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`],
      );
    const files = walk(root);
    for (const f of files.filter((x) => x.endsWith(".md"))) {
      const text = read(f);
      const front = text.startsWith("---") ? (text.split("---")[1] ?? "") : "";
      expect(front, f).not.toMatch(/^\s*(allowed-tools|allowedTools)\s*:/m);
    }
    for (const f of files.filter((x) => x.endsWith(".json")))
      expect(read(f), f).not.toMatch(/allowed-?tools/i);
  });

  it("the listing icon is a 1024 px PNG drawn from distribution/icon.svg (`pnpm icon`)", () => {
    const plugin = json<{ icon?: string }>(`${root}/plugins/didrun/.claude-plugin/plugin.json`);
    expect(plugin.icon).toBe("./.claude-plugin/icon.png");
    const file = `${root}/plugins/didrun/${plugin.icon!.slice(2)}`;
    const png = readFileSync(here(file));
    expect(statSync(here(file)).size).toBeLessThan(2 * 1024 * 1024);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.readUInt32BE(16)).toBe(1024);
    expect(png.readUInt32BE(20)).toBe(1024);
    const key = "didrun-icon-source-sha256\0";
    const at = png.indexOf(key, 0, "latin1");
    expect(at, "icon.png carries no source hash: run `pnpm icon`").toBeGreaterThan(0);
    const drawnFrom = png.subarray(at + key.length, at + key.length + 64).toString("latin1");
    const svg = createHash("sha256").update(read("distribution/icon.svg")).digest("hex");
    expect(drawnFrom, "distribution/icon.svg changed: run `pnpm icon`").toBe(svg);
  });

  it("the plugin folder has the README the directory lists it by, naming what it runs", () => {
    const readme = read(`${root}/plugins/didrun/README.md`);
    expect(readme).toContain(`${RUN} --json`);
    expect(readme).toContain("pre-approve nothing");
    expect(readme).not.toMatch(/`[^`]*\.png[^`]*`/);
  });

  it("the example workflow uses the Action with read-only permissions", () => {
    const wf = read("examples/github-workflow.yml");
    expect(wf).toContain(`uses: ${ACTION}`);
    expect(wf).toMatch(/permissions:\n {2}actions: read\n {2}contents: read\n/);
    expect(wf).toMatch(/push:/);
  });
});

/**
 * The GitHub Action, run here as a runner would: bash, the committed dist/ under
 * $GITHUB_ACTION_PATH, the summary and outputs files. Needs a build (`pnpm build`). `demo` stands
 * in for the repo, so it runs on the synthetic fixtures with no network.
 */
describe.skipIf(!existsSync(here("dist/cli.js")) || !existsSync(here(`${root}/action.yml`)))(
  "the GitHub Action",
  () => {
    // vitest runs a skipped block's body while collecting, so read only where the file exists
    const action = existsSync(here(`${root}/action.yml`)) ? read(`${root}/action.yml`) : "run: |\n";
    const script = /run: \|\n([\s\S]*)$/.exec(action)![1]!.replace(/^ {8}/gm, "");

    function runAction(failOn: string) {
      const dir = mkdtempSync(path.join(tmpdir(), "didrun-action-"));
      const summary = path.join(dir, "summary.md");
      const outputs = path.join(dir, "outputs.txt");
      writeFileSync(summary, "");
      writeFileSync(outputs, "");
      let status = 0;
      let stdout: string;
      try {
        stdout = execFileSync("bash", ["-c", script], {
          env: {
            PATH: process.env["PATH"],
            GITHUB_ACTION_PATH: here(".").pathname,
            RUNNER_TEMP: dir,
            GITHUB_STEP_SUMMARY: summary,
            GITHUB_OUTPUT: outputs,
            DIDRUN_REPO: "demo",
            DIDRUN_DAYS: "7",
            DIDRUN_LATE: "30",
            DIDRUN_FAIL_ON: failOn,
          },
          encoding: "utf8",
        });
      } catch (e) {
        status = (e as { status: number }).status;
        stdout = String((e as { stdout: unknown }).stdout ?? "");
      }
      return {
        status,
        stdout,
        summary: readFileSync(summary, "utf8"),
        outputs: readFileSync(outputs, "utf8"),
      };
    }

    it("runs dist/cli.js with no install, the job's token in the environment", () => {
      expect(action).toContain(
        'node "$GITHUB_ACTION_PATH/dist/cli.js" "$DIDRUN_REPO" --days "$DIDRUN_DAYS" --late "$DIDRUN_LATE" --json',
      );
      expect(action).toContain("GITHUB_TOKEN: ${{ inputs.token }}");
      expect(action).toContain("default: ${{ github.token }}");
      expect(action).toContain("default: ${{ github.repository }}");
    });

    it("writes the report to the summary and the counts to the outputs", () => {
      const r = runAction("never");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("4 scheduled workflows: 36 runs due");
      expect(r.summary.startsWith("```\ndidrun ")).toBe(true);
      expect(r.summary).toContain(HANDOFF_LINE);
      expect(r.outputs).toMatch(/^missed=2\nlate=2\nproblems=7\nreport=.*didrun\.json\n$/);
    });

    it("fail-on: missed fails the job; a value it does not know is a usage error", () => {
      expect(runAction("missed").status).toBe(1);
      expect(runAction("problem").status).toBe(1);
      const bad = runAction("sometimes");
      expect(bad.status).toBe(2);
      expect(bad.stdout).toMatch(/fail-on must be missed, problem or never/);
    });
  },
);

/**
 * One install command (src/install.ts), everywhere it is shown. Any form of it found elsewhere must
 * be INSTALL, or RUN where an agent runs it unattended; code and agentcheck's pages import it rather
 * than spell it. After flipping ON_NPM, rewrite the files that cannot import it:
 *
 *   DIDRUN_WRITE_INSTALL=1 pnpm --filter didrun exec vitest run src/distribution
 *
 * which also rewrites the mirror agentcheck's pages import.
 */
const COMMAND =
  /npx (?:-{1,2}[\w-]+(?:=[\w-]+)? )*(?:github:agentwares\/)?didrun(?:@latest)?(?![\w./-])/g;
const WRITE = Boolean(process.env["DIDRUN_WRITE_INSTALL"]);
const forms = (text: string): string[] => [...text.matchAll(COMMAND)].map((m) => m[0]);
const walk = (rel: string): string[] =>
  !existsSync(here(rel))
    ? []
    : statSync(here(rel)).isFile()
      ? [rel]
      : readdirSync(here(rel), { withFileTypes: true })
          .filter((e) => !["node_modules", "dist", ".next"].includes(e.name))
          .flatMap((e) => walk(`${rel}/${e.name}`));

/** Re-pad the `# comments` of a shell block that names the command, so its columns line up. */
function realign(text: string): string {
  return text.replace(/```sh\n([\s\S]*?)```/g, (block, body: string) => {
    if (forms(body).length === 0) return block;
    const rows = body.split("\n").map((l) => /^(\S.*?\S)\s{2,}(# .*)$/.exec(l));
    const width = Math.max(0, ...rows.map((m) => (m ? m[1]!.length : 0))) + 2;
    const lines = body.split("\n").map((l, i) => {
      const m = rows[i];
      return m ? m[1]!.padEnd(width) + m[2]! : l;
    });
    return "```sh\n" + lines.join("\n") + "```";
  });
}

describe("the install command", () => {
  it(`is ${INSTALL} while ON_NPM is ${String(ON_NPM)}`, () => {
    expect(INSTALL).toBe(`npx ${ON_NPM ? "" : "--allow-git=root github:agentwares/"}${pkg.name}`);
    expect(RUN).toBe(
      ON_NPM
        ? `npx -y ${pkg.name}@latest`
        : `npx -y --allow-git=root github:agentwares/${pkg.name}`,
    );
    expect(REPO).toBe(`https://github.com/agentwares/${pkg.name}`);
    expect(ACTION).toBe(`agentwares/${pkg.name}@main`);
  });

  // README, CHANGELOG and the plugin files in the monorepo; the same files at the root of the
  // public repo, where distribution/root has become the repo root
  const docs = [
    "README.md",
    "CHANGELOG.md",
    ...walk("distribution"),
    ...walk(".claude-plugin"),
    ...walk("plugins"),
    ...walk("examples"),
  ].filter((f) => /\.(md|json|ya?ml)$/.test(f));

  it.each(docs)("%s names only INSTALL or RUN", (file) => {
    const text = read(file);
    if (WRITE) {
      const next = realign(
        text.replace(COMMAND, (m) => (/ (?:-y|--yes) /.test(m) ? RUN : INSTALL)),
      );
      if (next !== text) writeFileSync(here(file), next);
    }
    for (const form of forms(read(file))) expect([INSTALL, RUN], file).toContain(form);
  });

  it("code, scripts and tests import it rather than spell it", () => {
    const files = [...walk("src"), ...walk("scripts")].filter((f) => f !== "src/install.ts");
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) expect(forms(read(file)), file).toEqual([]);
  });
});

/**
 * agentcheck's /didrun pages import a mirror of the CLI's constants and of its demo output, both
 * written here; nothing there spells the command.
 *
 *   DIDRUN_WRITE_INSTALL=1 pnpm --filter didrun exec vitest run src/distribution
 *   pnpm exec prettier --write apps/agentcheck/src/app/didrun/_cli.ts
 */
const AGENTCHECK = "../agentcheck/src";
const MIRROR = `${AGENTCHECK}/app/didrun/_cli.ts`;
describe.skipIf(!existsSync(here(`${AGENTCHECK}/app/didrun`)))(
  "the /didrun pages on agentcheck",
  () => {
    it("the mirror they import is the CLI's constants and its demo output", async () => {
      const lines = (await demoOutput()).trimEnd().split("\n");
      const text = [
        "/**",
        " * What the /didrun pages show of the CLI, mirrored from apps/didrun-cli: the install constant",
        " * (src/install.ts), the hand-off (src/handoff.ts) and the real output of its `demo` on the",
        " * synthetic repo. Written by apps/didrun-cli/src/distribution.test.ts, which fails when they",
        " * differ. While PUBLISHED is false the pages show neither INSTALL nor ACTION nor the repo,",
        " * only the check by hand with `gh` or the Actions tab.",
        " */",
        `export const ON_NPM: boolean = ${String(ON_NPM)};`,
        `export const PUBLISHED: boolean = ${String(PUBLISHED)};`,
        `export const INSTALL = ${JSON.stringify(INSTALL)};`,
        `export const ACTION = ${JSON.stringify(ACTION)};`,
        `export const REPO = ${JSON.stringify(REPO)};`,
        `export const HANDOFF_LINE = ${JSON.stringify(HANDOFF_LINE)};`,
        `export const SAMPLE_LINES: readonly string[] = ${JSON.stringify(lines)};`,
        "",
      ].join("\n");
      if (WRITE) writeFileSync(here(MIRROR), text);
      // compared without whitespace, so prettier's line breaks in the written file do not matter
      const squash = (s: string) => s.replace(/\s+/g, "").replace(/,([\]}])/g, "$1");
      expect(squash(read(MIRROR))).toBe(squash(text));
    });

    it("no other agentcheck file spells the command", () => {
      const files = walk(AGENTCHECK).filter((f) => f !== MIRROR && /\.(tsx?|md|txt|json)$/.test(f));
      expect(files.length).toBeGreaterThan(10);
      for (const file of files) expect(forms(read(file)), file).toEqual([]);
    });

    it("the pages' watch section carries the hand-off line from the mirror", () => {
      const ui = read(`${AGENTCHECK}/app/didrun/_ui.tsx`);
      expect(ui).toContain("HANDOFF_LINE");
      expect(ui).toMatch(/import \{[^}]*HANDOFF_LINE[^}]*\} from "\.\/_cli"/);
    });
  },
);
