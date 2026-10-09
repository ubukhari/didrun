import { describe, expect, it } from "vitest";
import { schedulesOf } from "./workflow.js";

describe("schedulesOf", () => {
  it("block style, with a time zone and a trailing comment", () => {
    const text = `name: x
on:
  schedule:
    - cron: '30 5 * * 1-5'   # weekdays
    - cron: "0 3 * * *"
      timezone: "America/New_York"
  workflow_dispatch:
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo "cron: '0 0 * * *'"
`;
    expect(schedulesOf(text)).toEqual([
      { cron: "30 5 * * 1-5" },
      { cron: "0 3 * * *", timezone: "America/New_York" },
    ]);
  });

  it("keys in either order, bare values, CRLF line ends and a quoted on", () => {
    const text = `"on":\r\n  push:\r\n  schedule:\r\n    - timezone: Asia/Tokyo\r\n      cron: 0 9 * * *\r\n`;
    expect(schedulesOf(text)).toEqual([{ cron: "0 9 * * *", timezone: "Asia/Tokyo" }]);
  });

  it("flow style on the on: line and on the schedule: line", () => {
    expect(
      schedulesOf(
        `on: { schedule: [ { cron: "0 3 * * *" }, {cron: '*/15 * * * *', timezone: UTC} ] }\n`,
      ),
    ).toEqual([{ cron: "0 3 * * *" }, { cron: "*/15 * * * *", timezone: "UTC" }]);
    expect(schedulesOf(`on:\n  schedule: [{ cron: '17 4 * * 0' }]\n  push: {}\n`)).toEqual([
      { cron: "17 4 * * 0" },
    ]);
    expect(schedulesOf(`on:\n  schedule:\n    - { cron: '17 4 * * 0' }\n`)).toEqual([
      { cron: "17 4 * * 0" },
    ]);
  });

  it("no schedule: none", () => {
    expect(schedulesOf("on: [push, pull_request]\n")).toEqual([]);
    expect(schedulesOf("on: push\n")).toEqual([]);
    expect(schedulesOf("name: no trigger\njobs: {}\n")).toEqual([]);
    expect(schedulesOf("on:\n  push:\n    branches: [main]\n")).toEqual([]);
  });

  it("a schedule key that belongs to something else is not a trigger", () => {
    const text = `on:
  workflow_dispatch:
    inputs:
      schedule:
        description: not a trigger
jobs: {}
`;
    expect(schedulesOf(text)).toEqual([]);
  });
});
