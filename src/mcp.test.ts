import { describe, expect, it } from "vitest";
import { DEMO_NOW, DEMO_REPO, DemoSource } from "./demo.js";
import { HANDOFF_LINE } from "./handoff.js";
import { TOOLS, callTool, handleMessage, type McpContext } from "./mcp.js";
import { fakeGitHub } from "./testing.js";

const SECRET = "ghp_never_in_a_result_0123456789";

function ctx(over: Partial<McpContext> = {}): McpContext & { requests: { authorized: boolean }[] } {
  const { fetch, requests } = fakeGitHub(new DemoSource(), DEMO_REPO);
  return {
    env: { GITHUB_TOKEN: SECRET },
    cwd: "/nowhere",
    exec: async () => null,
    fetch,
    now: () => DEMO_NOW,
    requests,
    ...over,
  };
}

const rpc = (method: string, params?: unknown, id: number | string = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params === undefined ? {} : { params }),
});

describe("the tool definition", () => {
  const tool = TOOLS[0]!;

  it("is namespaced, described and strict", () => {
    expect(TOOLS).toHaveLength(1);
    expect(tool.name).toBe("didrun_check_schedules");
    expect(tool.description.length).toBeGreaterThan(200);
    expect(tool.description).toContain(HANDOFF_LINE);
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.inputSchema.required ?? []).toEqual([]);
    for (const [name, prop] of Object.entries(tool.inputSchema.properties))
      expect(String(prop.description ?? "").length, name).toBeGreaterThan(30);
  });

  it("sets all four annotation hints explicitly: a read that calls GitHub", () => {
    expect(tool.annotations).toEqual({
      title: "Did the scheduled workflows run",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"])
      expect(typeof (tool.annotations as Record<string, unknown>)[hint], hint).toBe("boolean");
  });
});

describe("the protocol", () => {
  it("initialize answers the version asked for when it knows it, else its newest", async () => {
    const known = (await handleMessage(
      rpc("initialize", { protocolVersion: "2025-06-18" }),
      ctx(),
    )) as {
      result: { protocolVersion: string; serverInfo: { name: string } };
    };
    expect(known.result.protocolVersion).toBe("2025-06-18");
    expect(known.result.serverInfo.name).toBe("didrun");
    const other = (await handleMessage(
      rpc("initialize", { protocolVersion: "1999-01-01" }),
      ctx(),
    )) as {
      result: { protocolVersion: string };
    };
    expect(other.result.protocolVersion).toBe("2025-11-25");
  });

  it("tools/list, ping, notifications, unknown methods and bad requests", async () => {
    const list = (await handleMessage(rpc("tools/list"), ctx())) as {
      result: { tools: unknown[] };
    };
    expect(list.result.tools).toEqual(TOOLS);
    expect(await handleMessage(rpc("ping"), ctx())).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(
      await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx()),
    ).toBeUndefined();
    expect(await handleMessage(rpc("resources/list"), ctx())).toMatchObject({
      error: { code: -32601 },
    });
    expect(await handleMessage({ id: 3 }, ctx())).toMatchObject({ error: { code: -32600 } });
    expect(await handleMessage(rpc("tools/call", { name: "nope" }), ctx())).toMatchObject({
      error: { code: -32602 },
    });
  });
});

describe("tools/call", () => {
  it("returns the report as structured content, read with the user's token, never echoing it", async () => {
    const c = ctx();
    const res = (await handleMessage(
      rpc("tools/call", {
        name: "didrun_check_schedules",
        arguments: { repo: DEMO_REPO, days: 7 },
      }),
      c,
    )) as {
      result: {
        isError: boolean;
        structuredContent: Record<string, unknown>;
        content: { text: string }[];
      };
    };
    expect(res.result.isError).toBe(false);
    expect(res.result.structuredContent).toMatchObject({
      tool: "didrun",
      repo: DEMO_REPO,
      read_with: "token",
    });
    expect(JSON.parse(res.result.content[0]!.text)).toEqual(res.result.structuredContent);
    expect(JSON.stringify(res)).not.toContain(SECRET);
    expect(c.requests.length).toBeGreaterThan(5);
    expect(c.requests.every((r) => r.authorized)).toBe(true);
  });

  it("one workflow, a late threshold, and the checkout's origin when repo is omitted", async () => {
    const c = ctx({
      exec: async (cmd) => (cmd === "git" ? `https://github.com/${DEMO_REPO}.git` : null),
    });
    const out = await callTool(
      "didrun_check_schedules",
      { workflow: "backup.yml", late_minutes: 300 },
      c,
    );
    expect(out.isError).toBe(false);
    const workflows = out.structured.workflows as { name: string; counts: { late: number } }[];
    expect(workflows.map((w) => w.name)).toEqual(["Nightly backup"]);
    expect(workflows[0]!.counts.late).toBe(0);
  });

  it.each([
    [{ repo: "not-a-repo" }, "BAD_ARGUMENTS"],
    [{ days: 0 }, "INVALID_INPUT"],
    [{ days: 2.5 }, "INVALID_INPUT"],
    [{ late_minutes: "30" }, "INVALID_INPUT"],
    [{ token: "x" }, "INVALID_INPUT"],
    [[], "INVALID_INPUT"],
  ])("%j is an error result with code, cause, fix and retryable", async (args, code) => {
    const out = await callTool("didrun_check_schedules", args, ctx());
    expect(out.isError).toBe(true);
    expect(out.structured.code).toBe(code);
    expect(Object.keys(out.structured).sort()).toEqual(["cause", "code", "fix", "retryable"]);
  });

  it("no repo and no checkout: NO_REPO", async () => {
    const out = await callTool("didrun_check_schedules", {}, ctx());
    expect(out).toMatchObject({ isError: true, structured: { code: "NO_REPO" } });
  });
});
