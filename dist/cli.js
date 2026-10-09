#!/usr/bin/env node

// src/main.ts
import { parseArgs } from "util";

// src/cron.ts
var CronError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "CronError";
  }
};
var MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
var DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
var FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, nameBase: 1 },
  // 7 is accepted as Sunday and folded to 0 below
  { name: "day of week", min: 0, max: 7, names: DAYS, nameBase: 0 }
];
function value(raw, f) {
  const upper = raw.toUpperCase();
  const named = f.names?.indexOf(upper) ?? -1;
  if (named >= 0) return named + (f.nameBase ?? 0);
  if (!/^\d+$/.test(raw)) throw new CronError(`"${raw}" is not a valid ${f.name}`);
  const n = Number(raw);
  if (n < f.min || n > f.max)
    throw new CronError(
      `${f.name} ${n} is outside ${f.min}-${f.name === "day of week" ? 6 : f.max}`
    );
  return n;
}
function parseField(text, f) {
  const out = /* @__PURE__ */ new Set();
  for (const part of text.split(",")) {
    if (part === "") throw new CronError(`empty item in the ${f.name} field "${text}"`);
    const [range, stepText, extra] = part.split("/");
    if (extra !== void 0) throw new CronError(`"${part}" has two steps`);
    let step = 1;
    if (stepText !== void 0) {
      if (!/^\d+$/.test(stepText) || Number(stepText) === 0)
        throw new CronError(`step "${stepText}" in "${part}" must be a whole number above 0`);
      step = Number(stepText);
    }
    let lo;
    let hi;
    if (range === "*") {
      lo = f.min;
      hi = f.name === "day of week" ? 6 : f.max;
    } else if (range.includes("-")) {
      const [a, b, more] = range.split("-");
      if (more !== void 0 || !a || !b) throw new CronError(`"${range}" is not a range`);
      lo = value(a, f);
      hi = value(b, f);
      if (hi < lo) throw new CronError(`range "${range}" runs backwards`);
    } else {
      lo = value(range, f);
      hi = stepText !== void 0 ? f.name === "day of week" ? 6 : f.max : lo;
    }
    for (let v = lo; v <= hi; v += step) out.add(f.name === "day of week" && v === 7 ? 0 : v);
  }
  return out;
}
function parseCron(expr) {
  const fields = expr.trim().split(/\s+/);
  if (fields.length === 1 && fields[0].startsWith("@"))
    throw new CronError(
      `"${fields[0]}" is a shorthand GitHub's cron does not document; write the five fields`
    );
  if (fields.length !== 5)
    throw new CronError(
      `GitHub's cron has five fields (minute hour day-of-month month day-of-week); this has ${fields.length}`
    );
  const sets = fields.map((t, i) => parseField(t, FIELDS[i]));
  return {
    source: fields.join(" "),
    minute: sets[0],
    hour: sets[1],
    dom: sets[2],
    month: sets[3],
    dow: sets[4],
    domStar: fields[2].startsWith("*"),
    dowStar: fields[4].startsWith("*")
  };
}
function matches(spec, t) {
  if (!spec.minute.has(t.minute) || !spec.hour.has(t.hour) || !spec.month.has(t.month))
    return false;
  const dom = spec.dom.has(t.day);
  const dow = spec.dow.has(t.weekday);
  if (spec.domStar || spec.dowStar) return dom && dow;
  return dom || dow;
}
function checkTimeZone(tz) {
  new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(0);
}
var MINUTE = 6e4;
var BLOCK = 15 * MINUTE;
var formatters = /* @__PURE__ */ new Map();
function offsetAt(tz, utcMs) {
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
      second: "numeric"
    });
    formatters.set(tz, fmt);
  }
  const p = {};
  for (const part of fmt.formatToParts(utcMs))
    if (part.type !== "literal") p[part.type] = Number(part.value);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(utcMs / 1e3) * 1e3;
}
function localOf(wallMs) {
  const d = new Date(wallMs);
  return {
    minute: d.getUTCMinutes(),
    hour: d.getUTCHours(),
    day: d.getUTCDate(),
    month: d.getUTCMonth() + 1,
    weekday: d.getUTCDay()
  };
}
function fireTimes(spec, tz, fromMs, toMs) {
  const out = [];
  const start = Math.ceil(fromMs / MINUTE) * MINUTE;
  const zone = tz && tz !== "UTC" && tz !== "Etc/UTC" ? tz : void 0;
  let blockStart = -Infinity;
  let offset = 0;
  let seenLocal = -Infinity;
  for (let t = start; t < toMs; t += MINUTE) {
    if (zone && t >= blockStart + BLOCK) {
      blockStart = Math.floor(t / BLOCK) * BLOCK;
      offset = offsetAt(zone, t);
    }
    const local = t + offset;
    if (local <= seenLocal) continue;
    let fired = false;
    if (seenLocal !== -Infinity && local - seenLocal > MINUTE) {
      for (let m = seenLocal + MINUTE; m < local && !fired; m += MINUTE)
        if (matches(spec, localOf(m))) fired = true;
    }
    if (fired || matches(spec, localOf(local))) out.push(t);
    seenLocal = local;
  }
  return out;
}
function nextFire(spec, tz, fromMs, horizonDays = 400) {
  const DAY3 = 864e5;
  for (let d = 0; d < horizonDays; d++) {
    const from = fromMs + d * DAY3;
    const hit = fireTimes(spec, tz, from, from + DAY3);
    if (hit.length) return hit[0];
  }
  return null;
}

// src/handoff.ts
var SITE = "https://agentwares-agentcheck.vercel.app";
var REF = "didrun";
var PAGES_URL = `${SITE}/didrun`;
var HANDOFF_URL = `${PAGES_URL}?ref=${REF}#watch`;
var HANDOFF_LINE = "An hourly watch for scheduled runs is not built.";

// src/version.ts
import { readFileSync } from "fs";
var cached;
function version() {
  if (cached !== void 0) return cached;
  try {
    cached = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    cached = "0.0.0";
  }
  return cached;
}

// src/workflow.ts
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}
function unquote(raw) {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'"))
    return v.slice(1, -1).replace(/''/g, "'");
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"'))
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  return v;
}
var indentOf = (line) => line.length - line.trimStart().length;
var blank = (line) => stripComment(line).trim() === "";
function fromFlow(text) {
  const out = [];
  for (const obj of text.matchAll(/\{([^{}]*)\}/g)) {
    const body = obj[1];
    const pick = (key) => {
      const m = new RegExp(
        `(?:^|[,\\s])${key}\\s*:\\s*('(?:[^']|'')*'|"(?:[^"\\\\]|\\\\.)*"|[^,}]+)`
      ).exec(body);
      return m ? unquote(m[1]) : void 0;
    };
    const cron = pick("cron");
    if (cron === void 0) continue;
    const timezone = pick("timezone");
    out.push(timezone ? { cron, timezone } : { cron });
  }
  return out;
}
function keyValue(text) {
  const m = /^(?:'([^']*)'|"([^"]*)"|([A-Za-z0-9_-]+))\s*:(?:\s+(.*)|\s*)$/.exec(text.trim());
  if (!m) return null;
  return [m[1] ?? m[2] ?? m[3], (m[4] ?? "").trim()];
}
function schedulesOf(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map(stripComment);
  const onAt = lines.findIndex((l) => indentOf(l) === 0 && /^(?:on|"on"|'on')\s*:/.test(l));
  if (onAt < 0) return [];
  const inline = lines[onAt].replace(/^[^:]*:/, "").trim();
  if (inline) return /\bschedule\b/.test(inline) ? fromFlow(inline) : [];
  let end = onAt + 1;
  while (end < lines.length && (blank(lines[end]) || indentOf(lines[end]) > 0)) end++;
  const block = lines.slice(onAt + 1, end);
  const childIndent = Math.min(
    ...block.filter((l) => !blank(l)).map(indentOf),
    Number.POSITIVE_INFINITY
  );
  const at = block.findIndex((l) => indentOf(l) === childIndent && keyValue(l)?.[0] === "schedule");
  if (at < 0) return [];
  const value2 = keyValue(block[at])[1];
  if (value2) return fromFlow(value2);
  const out = [];
  let item = null;
  let dashIndent = -1;
  const flush = () => {
    if (item && item.cron !== void 0)
      out.push(item.timezone ? { cron: item.cron, timezone: item.timezone } : { cron: item.cron });
    item = null;
  };
  for (let i = at + 1; i < block.length; i++) {
    const line = block[i];
    if (blank(line)) continue;
    if (indentOf(line) <= childIndent) break;
    const dash = /^(\s*)-\s*(.*)$/.exec(line);
    if (dash && (dashIndent < 0 || dash[1].length === dashIndent)) {
      flush();
      dashIndent = dash[1].length;
      item = {};
      const rest = dash[2].trim();
      if (rest.startsWith("{")) {
        out.push(...fromFlow(rest));
        item = null;
        continue;
      }
      const kv2 = rest ? keyValue(rest) : null;
      if (kv2) item[kv2[0]] = unquote(kv2[1]);
      continue;
    }
    const kv = keyValue(line);
    if (item && kv) item[kv[0]] = unquote(kv[1]);
  }
  flush();
  return out;
}

// src/analyze.ts
var MINUTE2 = 6e4;
var DAY = 864e5;
var SKEW = MINUTE2;
var INACTIVITY_DAYS = 60;
var INACTIVITY_WARN_DAYS = 14;
var DEFAULT_DAYS = 7;
var MAX_DAYS = 30;
var DEFAULT_LATE_MINUTES = 30;
var SHORT_FRACTION = 0.2;
var MIN_SUCCESSES_FOR_USUAL = 3;
var iso = (ms2) => new Date(ms2).toISOString().replace(/\.000Z$/, "Z");
var ms = (s) => Date.parse(s);
function durationSeconds(r) {
  if (r.status !== "completed") return null;
  const start = ms(r.run_started_at ?? r.created_at);
  const end = ms(r.updated_at);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.round((end - start) / 1e3) : null;
}
function median(xs) {
  if (xs.length < MIN_SUCCESSES_FOR_USUAL) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}
function outcomeOf(r, usual) {
  if (r.status !== "completed") return "running";
  switch (r.conclusion) {
    case "success": {
      const d = durationSeconds(r);
      return usual !== null && d !== null && d < usual * SHORT_FRACTION ? "did_nothing" : "success";
    }
    case "skipped":
      return "did_nothing";
    case "failure":
    case "timed_out":
    case "startup_failure":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "other";
  }
}
function summarize(r, due, usual) {
  return {
    id: r.id,
    created_at: r.created_at,
    delay_minutes: due === null ? 0 : Math.max(0, Math.round((ms(r.created_at) - due) / MINUTE2)),
    status: r.status,
    conclusion: r.conclusion,
    outcome: outcomeOf(r, usual),
    duration_seconds: durationSeconds(r),
    html_url: r.html_url
  };
}
function span(seconds) {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 600)
    return `${Math.floor(seconds / 60)} min${seconds % 60 ? ` ${seconds % 60} s` : ""}`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h < 48) return rest ? `${h} h ${rest} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}
var CONCLUSION_WORDS = {
  failure: "failed",
  timed_out: "timed out",
  startup_failure: "failed to start",
  cancelled: "was cancelled",
  skipped: "was skipped"
};
function matchRuns(due, runs) {
  const out = due.map((slot) => ({ slot, run: null }));
  if (!due.length) return out;
  const sorted = runs.slice().sort((a, b) => ms(a.created_at) - ms(b.created_at));
  const groups = [];
  for (let i = 0; i < due.length; i++) {
    const last = groups[groups.length - 1];
    if (last && due[last[0]] === due[i]) last.push(i);
    else groups.push([i]);
  }
  const buckets = groups.map(() => []);
  let g = -1;
  for (const r of sorted) {
    const t = ms(r.created_at) + SKEW;
    while (g + 1 < groups.length && due[groups[g + 1][0]] <= t) g++;
    if (g >= 0) buckets[g].push(r);
  }
  for (let k = 0; k < groups.length; k++) {
    const slots = groups[k];
    const runsHere = buckets[k];
    const own = runsHere.slice(Math.max(0, runsHere.length - slots.length));
    const extras = runsHere.slice(0, Math.max(0, runsHere.length - slots.length));
    own.forEach((r, i) => out[slots[i]].run = r);
    for (const r of extras.reverse()) {
      let j = slots[0] - 1;
      while (j >= 0 && out[j].run) j--;
      if (j >= 0) out[j].run = r;
    }
  }
  return out;
}
var emptyCounts = () => ({
  due: 0,
  ran: 0,
  on_time: 0,
  late: 0,
  missed: 0,
  pending: 0,
  failed: 0,
  cancelled: 0,
  did_nothing: 0
});
function disabledReason(state, repo) {
  if (repo.archived) return "the repository is archived, so GitHub runs none of its workflows";
  switch (state) {
    case "disabled_inactivity":
      return `disabled by GitHub: no repository activity in ${INACTIVITY_DAYS} days (public repositories only)`;
    case "disabled_manually":
      return "disabled by hand, in the Actions tab or through the API";
    case "disabled_fork":
      return "disabled because this is a fork: GitHub turns off scheduled workflows in forks";
    default:
      return state === "active" ? void 0 : `state "${state}"`;
  }
}
function fileName(path) {
  return path.split("/").pop() ?? path;
}
function selected(w, filter) {
  if (!filter) return true;
  const f = filter.toLowerCase();
  return [w.path, fileName(w.path), w.name].some((x) => x.toLowerCase() === f);
}
async function check(source, repoName, opts = {}) {
  const now = (opts.now ?? /* @__PURE__ */ new Date()).getTime();
  const days = opts.days ?? DEFAULT_DAYS;
  const lateMs = (opts.lateMinutes ?? DEFAULT_LATE_MINUTES) * MINUTE2;
  const from = now - days * DAY;
  const warnings = [];
  const repo = await source.repo();
  const all = (await source.workflows()).filter((w) => w.state !== "deleted");
  const branch = repo.default_branch;
  const workflows = [];
  const unscheduled = [];
  const notOnDefault = [];
  for (const w of all) {
    if (!w.path.startsWith(".github/workflows/")) continue;
    if (!selected(w, opts.workflow)) continue;
    const text = await source.file(w.path, branch);
    if (text === null) {
      notOnDefault.push(w.path);
      continue;
    }
    const lines = schedulesOf(text).map((s) => ({ ...s }));
    if (!lines.length) {
      unscheduled.push(w.path);
      continue;
    }
    const specs = [];
    for (const line of lines) {
      try {
        const spec = parseCron(line.cron);
        if (line.timezone) {
          try {
            checkTimeZone(line.timezone);
          } catch {
            throw new CronError(`"${line.timezone}" is not an IANA time zone name`);
          }
        }
        specs.push({ line, spec });
      } catch (e) {
        line.error = e instanceof Error ? e.message : String(e);
      }
    }
    const disabled = disabledReason(w.state, repo);
    const changed = await source.lastChange(w.path, branch);
    const evalFrom = Math.max(from, changed ? ms(changed) : from);
    const runs = (await source.runs(w.id, iso(from))).filter((r) => r.event === "schedule");
    const durations = runs.filter((r) => r.status === "completed" && r.conclusion === "success").map(durationSeconds).filter((d) => d !== null);
    const usual = median(durations);
    const counts = emptyCounts();
    const findings = [];
    const fix = [];
    const newest = runs.slice().sort((a, b) => ms(b.created_at) - ms(a.created_at))[0];
    const lastRun = newest ? summarize(newest, null, usual) : disabled ? await lastRunEver(source, w.id, usual) : null;
    if (!disabled) {
      const due = specs.flatMap(({ line, spec }) => fireTimes(spec, line.timezone, evalFrom, now)).sort((a, b) => a - b);
      const matched = matchRuns(
        due,
        runs.filter((r) => ms(r.created_at) + SKEW >= evalFrom)
      );
      for (const { slot, run: run3 } of matched) {
        counts.due++;
        const dueIso = iso(slot);
        if (!run3) {
          if (now - slot <= lateMs) {
            counts.pending++;
            findings.push({ kind: "pending", due: dueIso, text: "no run yet; not late yet" });
          } else {
            counts.missed++;
            findings.push({
              kind: "missed",
              due: dueIso,
              text: "no run was created"
            });
          }
          continue;
        }
        counts.ran++;
        const s = summarize(run3, slot, usual);
        const late = s.delay_minutes * MINUTE2 > lateMs;
        if (late) {
          counts.late++;
          findings.push({
            kind: "late",
            due: dueIso,
            text: `the run was created ${span(s.delay_minutes * 60)} late`,
            run: s
          });
        } else counts.on_time++;
        if (s.outcome === "failed" || s.outcome === "cancelled") {
          counts[s.outcome]++;
          findings.push({
            kind: s.outcome,
            due: dueIso,
            text: `the run ${CONCLUSION_WORDS[run3.conclusion ?? ""] ?? run3.conclusion}${s.duration_seconds !== null ? ` after ${span(s.duration_seconds)}` : ""}`,
            run: s
          });
        } else if (s.outcome === "did_nothing") {
          counts.did_nothing++;
          findings.push({
            kind: "did_nothing",
            due: dueIso,
            text: run3.conclusion === "skipped" ? "the run concluded skipped: every job was skipped" : `green in ${span(s.duration_seconds ?? 0)}; its usual success takes ${span(usual ?? 0)}`,
            run: s
          });
        }
      }
      const minuteZero = specs.some(({ spec }) => spec.minute.has(0));
      if ((counts.missed || counts.late) && minuteZero)
        fix.push(
          "GitHub delays and drops scheduled runs under high load, which includes the start of every hour: move the minute off :00 (e.g. 17 instead of 0)"
        );
      if (counts.did_nothing)
        fix.push(
          "open the green runs that were short: usually every job or step was skipped by an `if:`, or the job found nothing to do and exited 0"
        );
    } else if (w.state.startsWith("disabled") && !repo.archived) {
      fix.push(`gh workflow enable ${fileName(w.path)} -R ${repoName}`);
      if (w.state === "disabled_inactivity")
        fix.push(
          `then keep the repo active: GitHub disables a public repo's scheduled workflows again after ${INACTIVITY_DAYS} days without activity`
        );
    }
    for (const line of lines)
      if (line.error) fix.push(`fix the schedule line "${line.cron}": ${line.error}`);
    const next = disabled ? null : specs.map(({ line, spec }) => nextFire(spec, line.timezone, now)).filter((x) => x !== null).sort((a, b) => a - b)[0];
    const problems = counts.missed + counts.late + counts.failed + counts.cancelled + counts.did_nothing + (disabled ? 1 : 0) + lines.filter((l) => l.error).length;
    workflows.push({
      name: w.name,
      path: w.path,
      html_url: w.html_url,
      state: repo.archived ? "archived" : w.state,
      ...disabled ? { disabled } : {},
      schedules: lines,
      evaluated_from: iso(evalFrom),
      file_changed_at: changed,
      counts,
      usual_success_seconds: usual,
      last_run: lastRun,
      next_due: next ? iso(next) : null,
      findings,
      problems,
      fix
    });
  }
  if (opts.workflow && !workflows.length && !unscheduled.length)
    warnings.push({
      code: "WORKFLOW_NOT_FOUND",
      cause: `no workflow named "${opts.workflow}" on ${branch}`,
      fix: "pass the file name (nightly.yml), its path or the workflow's name; omit --workflow for all",
      retryable: false
    });
  let inactivity = null;
  if (!repo.private && !repo.archived && Number.isFinite(ms(repo.pushed_at))) {
    const since = Math.floor((now - ms(repo.pushed_at)) / DAY);
    const disablesOn = ms(repo.pushed_at) + INACTIVITY_DAYS * DAY;
    inactivity = {
      days_since_push: since,
      disables_on: iso(disablesOn).slice(0, 10),
      days_left: INACTIVITY_DAYS - since
    };
  }
  const summary = workflows.reduce(
    (acc, w) => {
      for (const k of Object.keys(acc.counts)) acc.counts[k] += w.counts[k];
      if (w.disabled) acc.disabled++;
      acc.problems += w.problems;
      return acc;
    },
    { counts: emptyCounts(), disabled: 0, problems: 0 }
  );
  return {
    tool: "didrun",
    version: version(),
    repo: repoName,
    checked_at: iso(now),
    window: { days, from: iso(from), to: iso(now) },
    late_after_minutes: lateMs / MINUTE2,
    read_with: source.auth,
    repository: {
      html_url: repo.html_url,
      private: repo.private,
      default_branch: branch,
      pushed_at: repo.pushed_at,
      archived: repo.archived,
      fork: repo.fork
    },
    inactivity,
    workflows,
    unscheduled,
    not_on_default_branch: notOnDefault,
    summary: {
      ...summary.counts,
      scheduled_workflows: workflows.length,
      disabled: summary.disabled,
      problems: summary.problems
    },
    verdict: workflows.length === 0 ? "nothing-scheduled" : summary.problems ? "problems" : "ok",
    handoff: { text: HANDOFF_LINE, url: HANDOFF_URL },
    warnings
  };
}
async function lastRunEver(source, workflowId, usual) {
  const newest = await source.latestRun(workflowId);
  return newest ? summarize(newest, null, usual) : null;
}
function failed(report, mode) {
  if (mode === "never") return false;
  if (mode === "missed") return report.summary.missed > 0 || report.summary.disabled > 0;
  return report.summary.problems > 0;
}

// src/demo.ts
var DEMO_REPO = "synthetic-org/nightly-jobs";
var DEMO_NOW = /* @__PURE__ */ new Date("2026-10-09T13:00:00Z");
var URL_BASE = `https://github.com/${DEMO_REPO}`;
var REPO = {
  full_name: DEMO_REPO,
  private: false,
  default_branch: "main",
  pushed_at: "2026-08-21T16:42:00Z",
  archived: false,
  fork: false,
  html_url: URL_BASE
};
var wf = (id, name, path, state = "active") => ({
  id,
  name,
  path,
  state,
  html_url: `${URL_BASE}/blob/main/${path}`
});
var WORKFLOWS = [
  wf(101, "Nightly backup", ".github/workflows/backup.yml"),
  wf(102, "Sync prices", ".github/workflows/sync.yml"),
  wf(103, "Weekly report", ".github/workflows/report.yml"),
  wf(104, "Close stale issues", ".github/workflows/stale.yml", "disabled_inactivity"),
  wf(105, "CI", ".github/workflows/ci.yml"),
  wf(106, "CodeQL", "dynamic/github-code-scanning/codeql")
];
var FILES = {
  ".github/workflows/backup.yml": `name: Nightly backup
on:
  schedule:
    - cron: "0 3 * * *" # 03:00 UTC
  workflow_dispatch:
jobs:
  backup:
    runs-on: ubuntu-latest
    steps:
      - run: ./scripts/backup.sh
`,
  ".github/workflows/sync.yml": `name: Sync prices
on:
  schedule:
    - cron: '0 */6 * * *'
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - run: ./scripts/sync.sh
`,
  ".github/workflows/report.yml": `name: Weekly report
on:
  schedule:
    - cron: "30 8 * * 1"
      timezone: "America/New_York"
jobs:
  report:
    runs-on: ubuntu-latest
    steps:
      - run: ./scripts/report.sh
`,
  ".github/workflows/stale.yml": `name: Close stale issues
on:
  schedule:
    - cron: "0 0 * * *"
jobs:
  stale:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/stale@v9
`,
  ".github/workflows/ci.yml": `name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`
};
var CHANGED = {
  ".github/workflows/backup.yml": "2026-06-02T10:15:00Z",
  ".github/workflows/sync.yml": "2026-05-19T08:01:00Z",
  ".github/workflows/report.yml": "2026-07-14T14:30:00Z",
  ".github/workflows/stale.yml": "2026-03-03T09:00:00Z"
};
var nextId = 91e5;
function run(created, seconds, conclusion = "success") {
  const c = Date.parse(created);
  const iso2 = (ms2) => new Date(ms2).toISOString().replace(/\.000Z$/, "Z");
  const id = nextId++;
  return {
    id,
    created_at: iso2(c),
    run_started_at: iso2(c + 2e4),
    updated_at: iso2(c + 2e4 + seconds * 1e3),
    status: "completed",
    conclusion,
    event: "schedule",
    html_url: `${URL_BASE}/actions/runs/${id}`,
    run_attempt: 1
  };
}
function backupRuns() {
  return [
    run("2026-10-03T03:04:12Z", 250),
    // 4 Oct: no run
    run("2026-10-05T03:06:40Z", 6),
    run("2026-10-06T05:17:03Z", 242),
    run("2026-10-07T03:05:30Z", 255),
    run("2026-10-08T03:09:05Z", 90, "failure"),
    run("2026-10-09T03:04:50Z", 248)
  ];
}
function syncRuns() {
  const out = [];
  const start = Date.parse("2026-10-02T18:00:00Z");
  const end = Date.parse("2026-10-09T13:00:00Z");
  let i = 0;
  for (let t = start; t < end; t += 6 * 36e5, i++) {
    const due = new Date(t).toISOString();
    if (due.startsWith("2026-10-04T06:00")) continue;
    const delayMin = due.startsWith("2026-10-07T18:00") ? 47 : 3 + i * 7 % 9;
    out.push(run(new Date(t + delayMin * 6e4 + 17e3).toISOString(), 40 + i % 5 * 3));
  }
  return out;
}
var RUNS = {
  101: backupRuns(),
  102: syncRuns(),
  103: [run("2026-10-05T12:41:20Z", 95)],
  104: [],
  105: []
};
var LATEST = {
  104: run("2026-08-09T00:07:31Z", 31)
};
var DemoSource = class {
  auth = "fixtures";
  async repo() {
    return REPO;
  }
  async workflows() {
    return WORKFLOWS;
  }
  async file(path) {
    return FILES[path] ?? null;
  }
  async lastChange(path) {
    return CHANGED[path] ?? null;
  }
  async runs(workflowId, sinceIso) {
    const since = Date.parse(sinceIso);
    return (RUNS[workflowId] ?? []).filter((r) => Date.parse(r.created_at) >= since).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  }
  async latestRun(workflowId) {
    const runs = await this.runs(workflowId, "1970-01-01T00:00:00Z");
    return runs[0] ?? LATEST[workflowId] ?? null;
  }
};

// src/errors.ts
var CliError = class extends Error {
  code;
  cause;
  fix;
  retryable;
  /** 2 for a usage mistake, 1 for anything else */
  exitCode;
  constructor(p, exitCode = 1) {
    super(`${p.code}: ${p.cause}`);
    this.name = "CliError";
    this.code = p.code;
    this.cause = p.cause;
    this.fix = p.fix;
    this.retryable = p.retryable;
    this.exitCode = exitCode;
  }
  toJSON() {
    return { code: this.code, cause: this.cause, fix: this.fix, retryable: this.retryable };
  }
};
function usage(cause, fix) {
  return new CliError({ code: "BAD_ARGUMENTS", cause, fix, retryable: false }, 2);
}

// src/github.ts
import { execFile } from "child_process";
function parseRepo(text) {
  const t = text.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const patterns = [
    /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/,
    /^(?:https?:\/\/|git:\/\/)(?:[^@/]+@)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/,
    /^(?:ssh:\/\/)?git@github\.com[:/]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/
  ];
  for (const p of patterns) {
    const m = p.exec(t);
    if (m) return `${m[1]}/${m[2]}`;
  }
  return null;
}
var execQuiet = (cmd, args, cwd) => new Promise((resolve) => {
  execFile(
    cmd,
    args,
    { cwd, timeout: 5e3, windowsHide: true },
    (err, stdout) => resolve(err ? null : String(stdout).trim() || null)
  );
});
async function repoFromGit(cwd, exec = execQuiet) {
  const url = await exec("git", ["remote", "get-url", "origin"], cwd);
  return url ? parseRepo(url) : null;
}
async function findToken(env, cwd, exec = execQuiet) {
  for (const k of ["GITHUB_TOKEN", "GH_TOKEN"]) {
    const v = env[k]?.trim();
    if (v) return v;
  }
  return exec("gh", ["auth", "token"], cwd);
}
var MAX_RUN_PAGES = 10;
var MAX_WORKFLOW_PAGES = 3;
var GitHubSource = class {
  auth;
  base;
  repoPath;
  fetchImpl;
  token;
  /** requests made, for the report's footer */
  requests = 0;
  constructor(opts) {
    this.base = (opts.apiUrl || "https://api.github.com").replace(/\/+$/, "");
    this.repoPath = `/repos/${opts.repo}`;
    this.token = opts.token;
    this.auth = opts.token ? "token" : "anonymous";
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
  }
  async get(path, accept = "application/vnd.github+json") {
    const headers = {
      accept,
      "x-github-api-version": "2022-11-28",
      "user-agent": `didrun/${version()} (+https://github.com/agentwares/didrun)`
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    this.requests++;
    let res;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        headers,
        signal: AbortSignal.timeout(2e4)
      });
    } catch (e) {
      throw new CliError({
        code: "GITHUB_UNREACHABLE",
        cause: `could not reach ${this.base}: ${e instanceof Error ? e.message : String(e)}`,
        fix: "check the network and try again",
        retryable: true
      });
    }
    if (res.ok || res.status === 404) return res;
    const remaining = res.headers.get("x-ratelimit-remaining");
    if ((res.status === 403 || res.status === 429) && (remaining === "0" || res.status === 429)) {
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const at = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1e3).toISOString() : null;
      throw new CliError({
        code: "RATE_LIMITED",
        cause: `GitHub's API rate limit is spent${this.token ? "" : " (60 requests an hour without a token)"}${at ? `; it resets at ${at}` : ""}`,
        fix: this.token ? "wait for the reset and run it again" : "sign in with `gh auth login`, or set GITHUB_TOKEN, for 5,000 requests an hour; or wait for the reset",
        retryable: true
      });
    }
    if (res.status === 401)
      throw new CliError({
        code: "BAD_CREDENTIALS",
        cause: "GitHub refused the token (401 Bad credentials)",
        fix: "refresh it with `gh auth login` or set a valid GITHUB_TOKEN; `--anonymous` reads a public repo with none",
        retryable: false
      });
    if (res.status === 403)
      throw new CliError({
        code: "FORBIDDEN",
        cause: `GitHub answered 403 for ${path}`,
        fix: "the token needs read access to Actions and Contents on this repo (classic tokens: the repo scope)",
        retryable: false
      });
    throw new CliError({
      code: "GITHUB_ERROR",
      cause: `GitHub answered ${res.status} for ${path}`,
      fix: "try again in a minute; if it persists, check https://www.githubstatus.com",
      retryable: res.status >= 500
    });
  }
  async json(path) {
    const res = await this.get(path);
    if (res.status === 404) return null;
    return await res.json();
  }
  async repo() {
    const r = await this.json(this.repoPath);
    if (!r)
      throw new CliError({
        code: "REPO_NOT_FOUND",
        cause: `GitHub has no repository ${this.repoPath.slice(7)} that ${this.token ? "this token can read" : "can be read without a token"}`,
        fix: this.token ? "check the owner/repo spelling, and that the token can read this repo" : "check the spelling; a private repo needs your token (`gh auth login`, or GITHUB_TOKEN)",
        retryable: false
      });
    return r;
  }
  async workflows() {
    const out = [];
    for (let page = 1; page <= MAX_WORKFLOW_PAGES; page++) {
      const body = await this.json(
        `${this.repoPath}/actions/workflows?per_page=100&page=${page}`
      );
      if (!body) break;
      out.push(...body.workflows);
      if (out.length >= body.total_count || body.workflows.length < 100) break;
    }
    return out;
  }
  async file(path, ref) {
    const res = await this.get(
      `${this.repoPath}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
      "application/vnd.github.raw+json"
    );
    if (res.status === 404) return null;
    return res.text();
  }
  async lastChange(path, ref) {
    const body = await this.json(
      `${this.repoPath}/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(ref)}&per_page=1`
    );
    return body?.[0]?.commit?.committer?.date ?? null;
  }
  async runs(workflowId, sinceIso) {
    const out = [];
    const created = encodeURIComponent(`>=${sinceIso.replace(/\.\d{3}Z$/, "Z")}`);
    for (let page = 1; page <= MAX_RUN_PAGES; page++) {
      const body = await this.json(
        `${this.repoPath}/actions/workflows/${workflowId}/runs?event=schedule&created=${created}&per_page=100&page=${page}`
      );
      if (!body) break;
      out.push(...body.workflow_runs);
      if (out.length >= body.total_count || body.workflow_runs.length < 100) break;
    }
    return out;
  }
  async latestRun(workflowId) {
    const body = await this.json(
      `${this.repoPath}/actions/workflows/${workflowId}/runs?event=schedule&per_page=1`
    );
    return body?.workflow_runs[0] ?? null;
  }
};

// src/install.ts
var ON_NPM = false;
var NAME = "didrun";
var REPO2 = `https://github.com/agentwares/${NAME}`;
var INSTALL = ON_NPM ? `npx ${NAME}` : `npx --allow-git=root github:agentwares/${NAME}`;
var RUN = ON_NPM ? `npx -y ${NAME}@latest` : `npx -y --allow-git=root github:agentwares/${NAME}`;
var ACTION = `agentwares/${NAME}@main`;

// src/mcp.ts
import { createInterface } from "readline";

// src/resolve.ts
async function resolveRepo({ arg, env, cwd, exec }) {
  if (arg !== void 0) {
    const repo = parseRepo(arg);
    if (!repo)
      throw usage(
        `"${arg}" is not owner/repo or a github.com URL`,
        `e.g. \`${INSTALL} octo-org/nightly-jobs\``
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
      cause: "no owner/repo given, and this directory is not a checkout whose origin is on github.com",
      fix: `pass the repo: \`${INSTALL} owner/repo\`, or run it inside a clone; \`${INSTALL} demo\` shows the report`,
      retryable: false
    },
    2
  );
}

// src/mcp.ts
var PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
var TOOLS = [
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
          description: "The repository as owner/repo (octo-org/nightly-jobs) or its github.com URL. Omitted: the origin remote of the directory the server was started in."
        },
        days: {
          type: "integer",
          minimum: 1,
          maximum: MAX_DAYS,
          description: `How many days back to check, 1 to ${MAX_DAYS}. Omitted: ${DEFAULT_DAYS}.`
        },
        late_minutes: {
          type: "integer",
          minimum: 1,
          maximum: 1440,
          description: `Minutes after its scheduled time at which a run counts as late. GitHub delays scheduled runs under load, so small delays are normal. Omitted: ${DEFAULT_LATE_MINUTES}.`
        },
        workflow: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Check one workflow only: its file name (nightly.yml), its path (.github/workflows/nightly.yml) or its name. Omitted: every scheduled workflow."
        }
      },
      additionalProperties: false
    },
    annotations: {
      title: "Did the scheduled workflows run",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    }
  }
];
function invalid(cause, fix) {
  throw new CliError({ code: "INVALID_INPUT", cause, fix, retryable: false });
}
function checkArgs(raw) {
  if (raw === void 0 || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw))
    invalid("arguments must be an object", "Pass { repo?, days?, late_minutes?, workflow? }.");
  const props = TOOLS[0].inputSchema.properties;
  const a = raw;
  for (const k of Object.keys(a))
    if (!props[k])
      invalid(`unknown argument \`${k}\``, `Use only: ${Object.keys(props).join(", ")}.`);
  for (const k of ["repo", "workflow"])
    if (a[k] !== void 0 && (typeof a[k] !== "string" || a[k] === ""))
      invalid(`\`${k}\` must be a non-empty string`, `Omit it, or pass a string.`);
  const int = (k, min, max) => {
    const v = a[k];
    if (v !== void 0 && (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max))
      invalid(
        `\`${k}\` must be a whole number from ${min} to ${max}`,
        `Omit it, or pass e.g. ${min}.`
      );
  };
  int("days", 1, MAX_DAYS);
  int("late_minutes", 1, 1440);
  return a;
}
async function callTool(name, rawArgs, ctx = {}) {
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
      apiUrl: env["GITHUB_API_URL"]
    });
    const report = await check(source, repo, {
      days: args.days,
      lateMinutes: args.late_minutes,
      workflow: args.workflow,
      now: ctx.now?.() ?? /* @__PURE__ */ new Date()
    });
    return { structured: report, isError: false };
  } catch (err) {
    const body = err instanceof CliError ? err.toJSON() : {
      code: "INTERNAL",
      cause: err instanceof Error ? err.message : String(err),
      fix: "Run didrun on the same repo in a terminal to see the error with its context, and report it at https://github.com/agentwares/didrun/issues.",
      retryable: false
    };
    return { structured: { ...body }, isError: true };
  }
}
var INSTRUCTIONS = "didrun checks whether a GitHub repository's scheduled workflows ran when their cron said they would: late, missed, failed and green-but-empty runs, and workflows GitHub disabled. Read-only: it makes GET requests to GitHub's API with the user's own token and changes nothing.";
async function handleMessage(msg, ctx) {
  if (Array.isArray(msg)) {
    const out = (await Promise.all(msg.map((m) => handleMessage(m, ctx)))).filter(
      (r) => r !== void 0
    );
    return out.length ? out : void 0;
  }
  const req = msg && typeof msg === "object" ? msg : {};
  const hasId = "id" in req && (typeof req.id === "string" || typeof req.id === "number");
  const id = hasId ? req.id : null;
  const error = (code, message) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message }
  });
  if (!("method" in req) && ("result" in req || "error" in req)) return void 0;
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string")
    return hasId || !("method" in req) ? error(-32600, "Invalid Request") : void 0;
  if (!hasId) return void 0;
  const params = req.params && typeof req.params === "object" ? req.params : {};
  switch (req.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "didrun", title: "didrun", version: version() },
          instructions: INSTRUCTIONS
        }
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
          `Unknown tool: ${String(name)}. Tools: ${TOOLS.map((t) => t.name).join(", ")}`
        );
      const { structured, isError } = await callTool(name, params.arguments, ctx);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(structured) }],
          structuredContent: structured,
          isError
        }
      };
    }
    default:
      return error(-32601, `Method not found: ${req.method}`);
  }
}
async function serveStdio(ctx = {}) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" }
        }) + "\n"
      );
      continue;
    }
    try {
      const res = await handleMessage(msg, ctx);
      if (res !== void 0) process.stdout.write(JSON.stringify(res) + "\n");
    } catch (err) {
      process.stderr.write(`didrun mcp: ${err instanceof Error ? err.message : String(err)}
`);
    }
  }
}

// src/render.ts
var WHEN = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC"
});
var DAY2 = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC"
});
function when(isoTime) {
  return `${WHEN.format(new Date(isoTime)).replace(",", "").replace("Sept", "Sep")} UTC`;
}
function day(isoTime) {
  return DAY2.format(new Date(isoTime)).replace("Sept", "Sep");
}
var plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
var READ_WITH = {
  token: "read with your GitHub token",
  anonymous: "read without a token (public repos only)",
  fixtures: "recorded synthetic fixtures"
};
var LABEL = {
  missed: "missed",
  late: "late",
  pending: "pending",
  failed: "failed",
  cancelled: "cancelled",
  did_nothing: "did nothing"
};
var PAD_WIDTH = 15;
var PAD = " ".repeat(PAD_WIDTH);
function wrap(text, lead, indent = PAD_WIDTH, width = 100) {
  const words = text.split(" ");
  const lines = [];
  let cur = "";
  let room = width - lead.length;
  for (const word of words) {
    if (cur && cur.length + 1 + word.length > room) {
      lines.push(cur);
      cur = word;
      room = width - indent;
    } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) lines.push(cur);
  return lead + lines.join(`
${" ".repeat(indent)}`);
}
var SHOWN = 10;
function joinParts(parts) {
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}
function headline(r) {
  const s = r.summary;
  if (r.verdict === "nothing-scheduled")
    return `No workflow on ${r.repository.default_branch} has an on.schedule, so nothing was due.`;
  const parts = [`${plural(s.due, "run")} due`];
  if (s.due) {
    const ran = [`${s.on_time} on time`];
    if (s.late) ran.push(`${s.late} late`);
    parts[0] += `, ${s.ran} ran (${ran.join(", ")})`;
    if (s.missed) parts.push(`${s.missed} missed`);
    if (s.pending) parts.push(`${s.pending} not due long enough to call`);
  }
  const bad = [];
  if (s.failed) bad.push(`${s.failed} failed`);
  if (s.cancelled) bad.push(`${s.cancelled} cancelled`);
  if (s.did_nothing) bad.push(`${s.did_nothing} green but did nothing`);
  if (s.disabled) bad.push(`${plural(s.disabled, "workflow")} disabled`);
  return `${plural(s.scheduled_workflows, "scheduled workflow")}: ${parts.join(", ")}${bad.length ? `; ${joinParts(bad)}` : ""}.`;
}
function scheduleText(w) {
  return w.schedules.map((s) => `${s.cron} (${s.timezone ?? "UTC"})${s.error ? `  \u2190 ${s.error}` : ""}`).join(`
${PAD}`);
}
function countsText(w) {
  const c = w.counts;
  if (!c.due) return "none in this window";
  const parts = [`${c.due}`];
  const detail = [];
  if (c.ran === c.due && !c.late) detail.push(c.due === 1 ? "on time" : "all on time");
  else {
    detail.push(`${c.ran} ran`);
    if (c.late) detail.push(`${c.late} late`);
    if (c.missed) detail.push(`${c.missed} missed`);
    if (c.pending) detail.push(`${c.pending} pending`);
  }
  const outcomes = [];
  if (c.failed) outcomes.push(`${c.failed} failed`);
  if (c.cancelled) outcomes.push(`${c.cancelled} cancelled`);
  if (c.did_nothing) outcomes.push(`${c.did_nothing} did nothing`);
  return `${parts[0]}: ${detail.join(", ")}${outcomes.length ? `; ${outcomes.join(", ")}` : ""}`;
}
function workflowText(r, w) {
  const out = [`${w.name}  \xB7  ${w.path}`];
  out.push(`  schedule     ${scheduleText(w)}`);
  if (w.disabled) out.push(wrap(w.disabled, "  state        "));
  else {
    const since = w.evaluated_from !== r.window.from ? ` (since the file changed, ${when(w.evaluated_from)})` : "";
    out.push(`  runs due     ${countsText(w)}${since}`);
    for (const f of w.findings.slice(0, SHOWN))
      out.push(`  ${LABEL[f.kind].padEnd(12)} ${when(f.due)}  ${f.text}`);
    if (w.findings.length > SHOWN)
      out.push(`${PAD}and ${w.findings.length - SHOWN} more (--json lists them all)`);
  }
  if (w.last_run) {
    const ago = Math.floor(
      (Date.parse(r.checked_at) - Date.parse(w.last_run.created_at)) / 864e5
    );
    out.push(
      `  last run     ${when(w.last_run.created_at)}, ${w.last_run.status === "completed" ? w.last_run.conclusion ?? "no conclusion" : w.last_run.status}${ago >= 2 ? ` (${ago} days ago)` : ""}`
    );
  } else if (w.disabled) out.push("  last run     none on record");
  if (w.next_due) out.push(`  next due     ${when(w.next_due)}`);
  w.fix.forEach((f, i) => out.push(wrap(f, i === 0 ? "  fix          " : PAD)));
  return out.join("\n");
}
function renderText(r) {
  const head = `didrun ${r.version} \xB7 ${r.repo} \xB7 ${when(r.window.from)} to ${when(r.window.to)} (${plural(r.window.days, "day")}) \xB7 ${READ_WITH[r.read_with] ?? r.read_with}`;
  const out = [head, ""];
  for (const w of r.warnings) out.push(`warning ${w.code}: ${w.cause}`, `  fix: ${w.fix}`, "");
  out.push(wrap(headline(r), "", 0), "");
  const sorted = r.workflows.map((w, i) => ({ w, i })).sort((a, b) => Number(b.w.problems > 0) - Number(a.w.problems > 0) || a.i - b.i).map(({ w }) => w);
  for (const w of sorted) out.push(workflowText(r, w), "");
  if (r.unscheduled.length)
    out.push(
      wrap(
        `Not scheduled: ${plural(r.unscheduled.length, "workflow")} (${r.unscheduled.map((p) => p.split("/").pop()).join(", ")}).`,
        "",
        0
      )
    );
  if (r.not_on_default_branch.length)
    out.push(
      wrap(
        `Not on ${r.repository.default_branch}: ${r.not_on_default_branch.join(", ")}. GitHub runs a schedule only from the default branch.`,
        "",
        0
      )
    );
  if (r.unscheduled.length || r.not_on_default_branch.length) out.push("");
  const ia = r.inactivity;
  if (ia && ia.days_left <= INACTIVITY_WARN_DAYS) {
    out.push(
      ia.days_left > 0 ? wrap(
        `This repository is public and its last push was ${plural(ia.days_since_push, "day")} ago. GitHub disables a public repo's scheduled workflows after ${INACTIVITY_DAYS} days without activity: around ${day(ia.disables_on)} (in ${plural(ia.days_left, "day")}), unless there is activity first.`,
        "",
        0
      ) : wrap(
        `This repository is public and its last push was ${plural(ia.days_since_push, "day")} ago, past GitHub's ${INACTIVITY_DAYS}-day limit: unless something else counted as activity, GitHub can disable its scheduled workflows at any time.`,
        "",
        0
      ),
      ""
    );
  }
  out.push(
    HANDOFF_LINE,
    "Would you pay for one that emails you when a run is late, missed or did nothing? One click counts:",
    `  ${HANDOFF_URL}`
  );
  return out.join("\n") + "\n";
}
function renderJson(r) {
  return JSON.stringify(r, null, 2) + "\n";
}
function renderError(e, json) {
  if (json) return JSON.stringify({ error: e }, null, 2) + "\n";
  return `didrun: ${e.code}: ${e.cause}
  fix: ${e.fix}
`;
}

// src/main.ts
var HELP = `didrun ${version()} \u2014 did your scheduled GitHub workflows run when they should have?

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
var defaultDeps = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s)
};
async function main(argv, deps = defaultDeps) {
  const json = argv.includes("--json");
  try {
    return await run2(argv, deps);
  } catch (e) {
    if (e instanceof CliError) {
      (json ? deps.stdout : deps.stderr)(renderError(e.toJSON(), json));
      return e.exitCode;
    }
    throw e;
  }
}
var FAIL_ON = ["missed", "problem", "never"];
function intOption(raw, name, min, max, fallback) {
  if (raw === void 0) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max)
    throw usage(
      `--${name} must be a whole number from ${min} to ${max}, got "${raw}"`,
      `e.g. --${name} ${fallback}`
    );
  return Number(raw);
}
async function run2(argv, deps) {
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
        version: { type: "boolean", short: "v" }
      }
    });
  } catch (e) {
    throw usage(
      e instanceof Error ? e.message : String(e),
      `run \`${INSTALL} --help\` for the options`
    );
  }
  const { values, positionals } = parsed;
  if (values.version) {
    deps.stdout(`${version()}
`);
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
      `run \`${INSTALL} owner/repo\``
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
  const failOn = values["fail-on"] ?? "never";
  if (!FAIL_ON.includes(failOn))
    throw usage(
      `--fail-on must be ${FAIL_ON.join(", ")}; got "${values["fail-on"]}"`,
      "e.g. --fail-on missed"
    );
  let report;
  if (first === "demo") {
    if (!values.json)
      deps.stdout(`Synthetic repo, written for this demo: not anyone's repo or runs.

`);
    report = await check(new DemoSource(), DEMO_REPO, {
      days,
      lateMinutes,
      now: DEMO_NOW,
      workflow: values.workflow
    });
  } else {
    const repo = await resolveRepo({ arg: first, env, cwd, exec });
    const token = values.anonymous ? null : await findToken(env, cwd, exec);
    const source = new GitHubSource({
      repo,
      token,
      fetch: deps.fetch,
      apiUrl: env["GITHUB_API_URL"]
    });
    report = await check(source, repo, {
      days,
      lateMinutes,
      now: deps.now?.() ?? /* @__PURE__ */ new Date(),
      workflow: values.workflow
    });
  }
  deps.stdout(values.json ? renderJson(report) : renderText(report));
  return failed(report, failOn) ? 1 : 0;
}

// src/cli.ts
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`didrun: ${err instanceof Error ? err.message : String(err)}
`);
    process.exitCode = 1;
  }
);
//# sourceMappingURL=cli.js.map