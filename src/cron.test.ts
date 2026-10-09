import { describe, expect, it } from "vitest";
import { CronError, fireTimes, matches, nextFire, offsetAt, parseCron } from "./cron.js";

const at = (s: string) => Date.parse(s);
const isoAll = (xs: number[]) => xs.map((x) => new Date(x).toISOString().slice(0, 16) + "Z");

describe("parseCron", () => {
  it("reads lists, ranges, steps and names, and folds 7 into Sunday", () => {
    const s = parseCron("5,10-12 */6 1 JAN-MAR mon-fri,7");
    expect([...s.minute]).toEqual([5, 10, 11, 12]);
    expect([...s.hour]).toEqual([0, 6, 12, 18]);
    expect([...s.dom]).toEqual([1]);
    expect([...s.month]).toEqual([1, 2, 3]);
    expect([...s.dow].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(s.domStar).toBe(false);
    expect(s.source).toBe("5,10-12 */6 1 JAN-MAR mon-fri,7");
  });

  it("a start with a step runs to the end of the field", () => {
    expect([...parseCron("50/5 * * * *").minute]).toEqual([50, 55]);
  });

  it.each([
    ["60 * * * *", /minute 60 is outside 0-59/],
    ["* * * *", /five fields/],
    ["* * * * * *", /five fields.*has 6/],
    ["@daily", /shorthand/],
    ["*/0 * * * *", /above 0/],
    ["5-1 * * * *", /backwards/],
    ["* * * FOO *", /not a valid month/],
    ["* * 0 * *", /day of month 0 is outside 1-31/],
    ["1,,2 * * * *", /empty item/],
  ])("refuses %s with a sentence", (expr, msg) => {
    expect(() => parseCron(expr)).toThrow(CronError);
    expect(() => parseCron(expr)).toThrow(msg);
  });
});

describe("matches", () => {
  const t = (minute: number, hour: number, day: number, month: number, weekday: number) => ({
    minute,
    hour,
    day,
    month,
    weekday,
  });

  it("both day fields restricted: either one matches (POSIX)", () => {
    const s = parseCron("0 0 1 * 1");
    expect(matches(s, t(0, 0, 1, 10, 4))).toBe(true); // the 1st, a Thursday
    expect(matches(s, t(0, 0, 5, 10, 1))).toBe(true); // a Monday, the 5th
    expect(matches(s, t(0, 0, 6, 10, 2))).toBe(false);
  });

  it("a day field written with a leading * is unrestricted: both must match", () => {
    const s = parseCron("0 0 */2 * 1");
    expect(matches(s, t(0, 0, 5, 10, 1))).toBe(true);
    expect(matches(s, t(0, 0, 12, 10, 1))).toBe(false);
    expect(matches(s, t(0, 0, 7, 10, 3))).toBe(false);
  });
});

describe("fireTimes", () => {
  it("UTC: a daily line fires once a day, inside [from, to)", () => {
    const s = parseCron("0 3 * * *");
    const out = fireTimes(s, undefined, at("2026-10-02T13:00:00Z"), at("2026-10-09T03:00:00Z"));
    expect(isoAll(out)).toEqual([
      "2026-10-03T03:00Z",
      "2026-10-04T03:00Z",
      "2026-10-05T03:00Z",
      "2026-10-06T03:00Z",
      "2026-10-07T03:00Z",
      "2026-10-08T03:00Z",
    ]);
  });

  it("both day fields: the 1st and every Monday of October 2026", () => {
    const s = parseCron("0 0 1 * 1");
    const out = fireTimes(s, "UTC", at("2026-10-01T00:00:00Z"), at("2026-11-01T00:00:00Z"));
    expect(isoAll(out).map((x) => x.slice(8, 10))).toEqual(["01", "05", "12", "19", "26"]);
  });

  it("a time zone moves the UTC time when its clocks change", () => {
    const s = parseCron("30 8 * * 1");
    const out = fireTimes(
      s,
      "America/New_York",
      at("2026-10-01T00:00:00Z"),
      at("2026-11-10T00:00:00Z"),
    );
    expect(isoAll(out)).toEqual([
      "2026-10-05T12:30Z",
      "2026-10-12T12:30Z",
      "2026-10-19T12:30Z",
      "2026-10-26T12:30Z",
      "2026-11-02T13:30Z", // EST from 1 Nov
      "2026-11-09T13:30Z",
    ]);
  });

  it("spring forward: a time in the skipped hour fires at the next valid time (GitHub's rule)", () => {
    const s = parseCron("30 2 * * *");
    const out = fireTimes(
      s,
      "America/New_York",
      at("2026-03-07T00:00:00Z"),
      at("2026-03-10T00:00:00Z"),
    );
    // 7 Mar 02:30 EST; 8 Mar has no 02:30, so 03:00 EDT; 9 Mar 02:30 EDT
    expect(isoAll(out)).toEqual(["2026-03-07T07:30Z", "2026-03-08T07:00Z", "2026-03-09T06:30Z"]);
  });

  it("fall back: a repeated local time fires once", () => {
    const s = parseCron("30 1 * * *");
    const out = fireTimes(
      s,
      "America/New_York",
      at("2026-11-01T00:00:00Z"),
      at("2026-11-02T00:00:00Z"),
    );
    expect(isoAll(out)).toEqual(["2026-11-01T05:30Z"]);
  });

  it("a half-hour zone (Asia/Kolkata, +5:30)", () => {
    const s = parseCron("0 9 * * *");
    const out = fireTimes(
      s,
      "Asia/Kolkata",
      at("2026-10-05T00:00:00Z"),
      at("2026-10-06T00:00:00Z"),
    );
    expect(isoAll(out)).toEqual(["2026-10-05T03:30Z"]);
    expect(offsetAt("Asia/Kolkata", at("2026-10-05T00:00:00Z"))).toBe(5.5 * 3_600_000);
  });

  it("every 5 minutes over 30 days stays quick", () => {
    const s = parseCron("*/5 * * * *");
    const t0 = Date.now();
    const out = fireTimes(
      s,
      "Europe/Berlin",
      at("2026-09-09T00:00:00Z"),
      at("2026-10-09T00:00:00Z"),
    );
    expect(out).toHaveLength(30 * 288);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
});

describe("nextFire", () => {
  it("finds the next time, even a year ahead", () => {
    expect(
      new Date(
        nextFire(parseCron("0 3 * * *"), undefined, at("2026-10-09T13:00:00Z"))!,
      ).toISOString(),
    ).toBe("2026-10-10T03:00:00.000Z");
    expect(
      new Date(
        nextFire(parseCron("0 0 1 1 *"), undefined, at("2026-10-09T13:00:00Z"))!,
      ).toISOString(),
    ).toBe("2027-01-01T00:00:00.000Z");
    expect(nextFire(parseCron("0 0 30 2 *"), undefined, at("2026-10-09T13:00:00Z"))).toBeNull();
  });
});
