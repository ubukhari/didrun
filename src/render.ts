/** What a check prints: text for a person, `--json` for a program. */
import { INACTIVITY_DAYS, INACTIVITY_WARN_DAYS, type Finding, type Report } from "./analyze.js";
import type { Problem } from "./errors.js";
import { HANDOFF_LINE, HANDOFF_URL } from "./handoff.js";

const WHEN = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});
const DAY = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** "Sun 4 Oct 03:00 UTC" */
export function when(isoTime: string): string {
  return `${WHEN.format(new Date(isoTime)).replace(",", "").replace("Sept", "Sep")} UTC`;
}

/** "20 Oct 2026" */
export function day(isoTime: string): string {
  return DAY.format(new Date(isoTime)).replace("Sept", "Sep");
}

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

const READ_WITH: Record<string, string> = {
  token: "read with your GitHub token",
  anonymous: "read without a token (public repos only)",
  fixtures: "recorded synthetic fixtures",
};

const LABEL: Record<Finding["kind"], string> = {
  missed: "missed",
  late: "late",
  pending: "pending",
  failed: "failed",
  cancelled: "cancelled",
  did_nothing: "did nothing",
};

const PAD_WIDTH = 15;
const PAD = " ".repeat(PAD_WIDTH);

/** Wrap `text` at `width`, continuing lines under `indent`; the first line starts after `lead`. */
export function wrap(text: string, lead: string, indent = PAD_WIDTH, width = 100): string {
  const words = text.split(" ");
  const lines: string[] = [];
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
  return lead + lines.join(`\n${" ".repeat(indent)}`);
}

/** Findings shown per workflow before "and N more". */
const SHOWN = 10;

function joinParts(parts: string[]): string {
  return parts.length <= 1
    ? parts.join("")
    : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** The one-line summary: what was due and what came of it. */
export function headline(r: Report): string {
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
  const bad: string[] = [];
  if (s.failed) bad.push(`${s.failed} failed`);
  if (s.cancelled) bad.push(`${s.cancelled} cancelled`);
  if (s.did_nothing) bad.push(`${s.did_nothing} green but did nothing`);
  if (s.disabled) bad.push(`${plural(s.disabled, "workflow")} disabled`);
  return `${plural(s.scheduled_workflows, "scheduled workflow")}: ${parts.join(", ")}${bad.length ? `; ${joinParts(bad)}` : ""}.`;
}

function scheduleText(w: Report["workflows"][number]): string {
  return w.schedules
    .map((s) => `${s.cron} (${s.timezone ?? "UTC"})${s.error ? `  ← ${s.error}` : ""}`)
    .join(`\n${PAD}`);
}

function countsText(w: Report["workflows"][number]): string {
  const c = w.counts;
  if (!c.due) return "none in this window";
  const parts = [`${c.due}`];
  const detail: string[] = [];
  if (c.ran === c.due && !c.late) detail.push(c.due === 1 ? "on time" : "all on time");
  else {
    detail.push(`${c.ran} ran`);
    if (c.late) detail.push(`${c.late} late`);
    if (c.missed) detail.push(`${c.missed} missed`);
    if (c.pending) detail.push(`${c.pending} pending`);
  }
  const outcomes: string[] = [];
  if (c.failed) outcomes.push(`${c.failed} failed`);
  if (c.cancelled) outcomes.push(`${c.cancelled} cancelled`);
  if (c.did_nothing) outcomes.push(`${c.did_nothing} did nothing`);
  return `${parts[0]}: ${detail.join(", ")}${outcomes.length ? `; ${outcomes.join(", ")}` : ""}`;
}

function workflowText(r: Report, w: Report["workflows"][number]): string {
  const out = [`${w.name}  ·  ${w.path}`];
  out.push(`  schedule     ${scheduleText(w)}`);
  if (w.disabled) out.push(wrap(w.disabled, "  state        "));
  else {
    const since =
      w.evaluated_from !== r.window.from
        ? ` (since the file changed, ${when(w.evaluated_from)})`
        : "";
    out.push(`  runs due     ${countsText(w)}${since}`);
    for (const f of w.findings.slice(0, SHOWN))
      out.push(`  ${LABEL[f.kind].padEnd(12)} ${when(f.due)}  ${f.text}`);
    if (w.findings.length > SHOWN)
      out.push(`${PAD}and ${w.findings.length - SHOWN} more (--json lists them all)`);
  }
  if (w.last_run) {
    const ago = Math.floor(
      (Date.parse(r.checked_at) - Date.parse(w.last_run.created_at)) / 86_400_000,
    );
    out.push(
      `  last run     ${when(w.last_run.created_at)}, ${w.last_run.status === "completed" ? (w.last_run.conclusion ?? "no conclusion") : w.last_run.status}${ago >= 2 ? ` (${ago} days ago)` : ""}`,
    );
  } else if (w.disabled) out.push("  last run     none on record");
  if (w.next_due) out.push(`  next due     ${when(w.next_due)}`);
  w.fix.forEach((f, i) => out.push(wrap(f, i === 0 ? "  fix          " : PAD)));
  return out.join("\n");
}

export function renderText(r: Report): string {
  const head = `didrun ${r.version} · ${r.repo} · ${when(r.window.from)} to ${when(r.window.to)} (${plural(r.window.days, "day")}) · ${READ_WITH[r.read_with] ?? r.read_with}`;
  const out = [head, ""];
  for (const w of r.warnings) out.push(`warning ${w.code}: ${w.cause}`, `  fix: ${w.fix}`, "");
  out.push(wrap(headline(r), "", 0), "");
  // the workflows with something to look at first, then the clean ones
  const sorted = r.workflows
    .map((w, i) => ({ w, i }))
    .sort((a, b) => Number(b.w.problems > 0) - Number(a.w.problems > 0) || a.i - b.i)
    .map(({ w }) => w);
  for (const w of sorted) out.push(workflowText(r, w), "");
  if (r.unscheduled.length)
    out.push(
      wrap(
        `Not scheduled: ${plural(r.unscheduled.length, "workflow")} (${r.unscheduled.map((p) => p.split("/").pop()).join(", ")}).`,
        "",
        0,
      ),
    );
  if (r.not_on_default_branch.length)
    out.push(
      wrap(
        `Not on ${r.repository.default_branch}: ${r.not_on_default_branch.join(", ")}. GitHub runs a schedule only from the default branch.`,
        "",
        0,
      ),
    );
  if (r.unscheduled.length || r.not_on_default_branch.length) out.push("");
  const ia = r.inactivity;
  if (ia && ia.days_left <= INACTIVITY_WARN_DAYS) {
    out.push(
      ia.days_left > 0
        ? wrap(
            `This repository is public and its last push was ${plural(ia.days_since_push, "day")} ago. GitHub disables a public repo's scheduled workflows after ${INACTIVITY_DAYS} days without activity: around ${day(ia.disables_on)} (in ${plural(ia.days_left, "day")}), unless there is activity first.`,
            "",
            0,
          )
        : wrap(
            `This repository is public and its last push was ${plural(ia.days_since_push, "day")} ago, past GitHub's ${INACTIVITY_DAYS}-day limit: unless something else counted as activity, GitHub can disable its scheduled workflows at any time.`,
            "",
            0,
          ),
      "",
    );
  }
  out.push(
    HANDOFF_LINE,
    "Would you pay for one that emails you when a run is late, missed or did nothing? One click counts:",
    `  ${HANDOFF_URL}`,
  );
  return out.join("\n") + "\n";
}

export function renderJson(r: Report): string {
  return JSON.stringify(r, null, 2) + "\n";
}

export function renderError(e: Problem, json: boolean): string {
  if (json) return JSON.stringify({ error: e }, null, 2) + "\n";
  return `didrun: ${e.code}: ${e.cause}\n  fix: ${e.fix}\n`;
}
