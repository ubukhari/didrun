/**
 * GitHub's `on.schedule` cron: five POSIX fields, evaluated in UTC or in the line's `timezone`.
 *
 * What GitHub documents (workflow syntax and events pages, read 9 Oct 2026):
 *
 * - five fields: minute 0-59, hour 0-23, day of month 1-31, month 1-12 or JAN-DEC, day of week
 *   0-6 or SUN-SAT; `*`, lists, ranges and steps;
 * - UTC unless the line sets `timezone` to an IANA name;
 * - "during DST spring-forward transitions, scheduled workflows in skipped hours advance to the
 *   next valid time";
 * - the shortest interval is once every 5 minutes.
 *
 * Where GitHub says nothing, this follows Vixie cron, the reference for POSIX cron: when both day
 * fields are restricted a day matches either one, a field written with a leading `*` counts as
 * unrestricted, and 7 is also Sunday. A local time repeated when clocks go back fires once, so a
 * second run in that hour is never counted against anyone.
 */

export interface CronSpec {
  /** the five fields as written, single-spaced */
  source: string;
  minute: ReadonlySet<number>;
  hour: ReadonlySet<number>;
  dom: ReadonlySet<number>;
  month: ReadonlySet<number>;
  dow: ReadonlySet<number>;
  domStar: boolean;
  dowStar: boolean;
}

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

interface FieldDef {
  name: string;
  min: number;
  max: number;
  names?: string[];
  /** the value a name at index 0 stands for */
  nameBase?: number;
}

const FIELDS: readonly FieldDef[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, nameBase: 1 },
  // 7 is accepted as Sunday and folded to 0 below
  { name: "day of week", min: 0, max: 7, names: DAYS, nameBase: 0 },
];

function value(raw: string, f: FieldDef): number {
  const upper = raw.toUpperCase();
  const named = f.names?.indexOf(upper) ?? -1;
  if (named >= 0) return named + (f.nameBase ?? 0);
  if (!/^\d+$/.test(raw)) throw new CronError(`"${raw}" is not a valid ${f.name}`);
  const n = Number(raw);
  if (n < f.min || n > f.max)
    throw new CronError(
      `${f.name} ${n} is outside ${f.min}-${f.name === "day of week" ? 6 : f.max}`,
    );
  return n;
}

function parseField(text: string, f: FieldDef): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    if (part === "") throw new CronError(`empty item in the ${f.name} field "${text}"`);
    const [range, stepText, extra] = part.split("/");
    if (extra !== undefined) throw new CronError(`"${part}" has two steps`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) === 0)
        throw new CronError(`step "${stepText}" in "${part}" must be a whole number above 0`);
      step = Number(stepText);
    }
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = f.min;
      hi = f.name === "day of week" ? 6 : f.max;
    } else if (range!.includes("-")) {
      const [a, b, more] = range!.split("-");
      if (more !== undefined || !a || !b) throw new CronError(`"${range}" is not a range`);
      lo = value(a, f);
      hi = value(b, f);
      if (hi < lo) throw new CronError(`range "${range}" runs backwards`);
    } else {
      lo = value(range!, f);
      // `5/15` means from 5 to the end, every 15
      hi = stepText !== undefined ? (f.name === "day of week" ? 6 : f.max) : lo;
    }
    for (let v = lo; v <= hi; v += step) out.add(f.name === "day of week" && v === 7 ? 0 : v);
  }
  return out;
}

/** Parse the five fields; throws {@link CronError} with a sentence a person can act on. */
export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length === 1 && fields[0]!.startsWith("@"))
    throw new CronError(
      `"${fields[0]}" is a shorthand GitHub's cron does not document; write the five fields`,
    );
  if (fields.length !== 5)
    throw new CronError(
      `GitHub's cron has five fields (minute hour day-of-month month day-of-week); this has ${fields.length}`,
    );
  const sets = fields.map((t, i) => parseField(t, FIELDS[i]!));
  return {
    source: fields.join(" "),
    minute: sets[0]!,
    hour: sets[1]!,
    dom: sets[2]!,
    month: sets[3]!,
    dow: sets[4]!,
    domStar: fields[2]!.startsWith("*"),
    dowStar: fields[4]!.startsWith("*"),
  };
}

/** Wall-clock fields of a local minute. */
export interface Local {
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
}

export function matches(spec: CronSpec, t: Local): boolean {
  if (!spec.minute.has(t.minute) || !spec.hour.has(t.hour) || !spec.month.has(t.month))
    return false;
  const dom = spec.dom.has(t.day);
  const dow = spec.dow.has(t.weekday);
  if (spec.domStar || spec.dowStar) return dom && dow;
  return dom || dow;
}

/** Throws a RangeError for a name the runtime's time-zone database does not know. */
export function checkTimeZone(tz: string): void {
  new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(0);
}

const MINUTE = 60_000;
/** Offsets change on a quarter hour at the finest (Lord Howe's 30-minute DST, Nepal's +5:45). */
const BLOCK = 15 * MINUTE;

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Milliseconds to add to a UTC instant to get the wall clock in `tz` at that instant. */
export function offsetAt(tz: string, utcMs: number): number {
  let fmt = formatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(tz, fmt);
  }
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(utcMs))
    if (part.type !== "literal") p[part.type] = Number(part.value);
  const wall = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return wall - Math.floor(utcMs / 1000) * 1000;
}

function localOf(wallMs: number): Local {
  const d = new Date(wallMs);
  return {
    minute: d.getUTCMinutes(),
    hour: d.getUTCHours(),
    day: d.getUTCDate(),
    month: d.getUTCMonth() + 1,
    weekday: d.getUTCDay(),
  };
}

/**
 * Every time the line fires in [fromMs, toMs), as UTC milliseconds, ascending. `tz` undefined or
 * "UTC" evaluates in UTC. A local time skipped by a spring-forward fires once, at the first minute
 * after the gap; a local time repeated by a fall-back fires once, the first time.
 */
export function fireTimes(spec: CronSpec, tz: string | undefined, fromMs: number, toMs: number) {
  const out: number[] = [];
  const start = Math.ceil(fromMs / MINUTE) * MINUTE;
  const zone = tz && tz !== "UTC" && tz !== "Etc/UTC" ? tz : undefined;
  let blockStart = -Infinity;
  let offset = 0;
  /** the latest local minute already evaluated, so a repeated hour fires once */
  let seenLocal = -Infinity;
  for (let t = start; t < toMs; t += MINUTE) {
    if (zone && t >= blockStart + BLOCK) {
      blockStart = Math.floor(t / BLOCK) * BLOCK;
      offset = offsetAt(zone, t);
    }
    const local = t + offset;
    if (local <= seenLocal) continue; // the repeated hour after clocks go back
    let fired = false;
    // the local minutes a spring-forward skipped, which fire now
    if (seenLocal !== -Infinity && local - seenLocal > MINUTE) {
      for (let m = seenLocal + MINUTE; m < local && !fired; m += MINUTE)
        if (matches(spec, localOf(m))) fired = true;
    }
    if (fired || matches(spec, localOf(local))) out.push(t);
    seenLocal = local;
  }
  return out;
}

/** The first fire at or after `fromMs`, looking up to `horizonDays` ahead; null if none. */
export function nextFire(
  spec: CronSpec,
  tz: string | undefined,
  fromMs: number,
  horizonDays = 400,
): number | null {
  // a day at a time, so a yearly line does not walk 400 days of minutes in one go
  const DAY = 86_400_000;
  for (let d = 0; d < horizonDays; d++) {
    const from = fromMs + d * DAY;
    const hit = fireTimes(spec, tz, from, from + DAY);
    if (hit.length) return hit[0]!;
  }
  return null;
}
