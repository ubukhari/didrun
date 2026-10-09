/**
 * The `on.schedule` lines of a workflow file, read without a YAML library (the package has no
 * runtime dependencies). It reads the forms GitHub's docs and real workflows use:
 *
 *   on:                                  on: { schedule: [ { cron: "0 3 * * *" } ] }
 *     schedule:
 *       - cron: '0 3 * * *'              "on":
 *       - cron: "30 5 * * 1-5"             schedule: [{ cron: '*\/15 * * * *', timezone: UTC }]
 *         timezone: "America/New_York"
 *
 * Keys in any order inside a list item, quoted or bare values, trailing comments, `"on"` and `'on'`
 * as the key. Anything it cannot read as a schedule is left out, never guessed at.
 */

export interface Schedule {
  cron: string;
  /** the line's IANA `timezone`, when it sets one */
  timezone?: string;
}

/** Strip a trailing ` # comment` that is not inside quotes. */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
}

function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'"))
    return v.slice(1, -1).replace(/''/g, "'");
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"'))
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  return v;
}

const indentOf = (line: string) => line.length - line.trimStart().length;
const blank = (line: string) => stripComment(line).trim() === "";

/** `{ cron: "...", timezone: ... }` objects anywhere in a flow-style value. */
function fromFlow(text: string): Schedule[] {
  const out: Schedule[] = [];
  for (const obj of text.matchAll(/\{([^{}]*)\}/g)) {
    const body = obj[1]!;
    const pick = (key: string) => {
      const m = new RegExp(
        `(?:^|[,\\s])${key}\\s*:\\s*('(?:[^']|'')*'|"(?:[^"\\\\]|\\\\.)*"|[^,}]+)`,
      ).exec(body);
      return m ? unquote(m[1]!) : undefined;
    };
    const cron = pick("cron");
    if (cron === undefined) continue;
    const timezone = pick("timezone");
    out.push(timezone ? { cron, timezone } : { cron });
  }
  return out;
}

/** `key: value` on one line, the key bare or quoted. */
function keyValue(text: string): [string, string] | null {
  const m = /^(?:'([^']*)'|"([^"]*)"|([A-Za-z0-9_-]+))\s*:(?:\s+(.*)|\s*)$/.exec(text.trim());
  if (!m) return null;
  return [m[1] ?? m[2] ?? m[3]!, (m[4] ?? "").trim()];
}

/** Every schedule line in the workflow file's text, in file order. */
export function schedulesOf(text: string): Schedule[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map(stripComment);
  // the top-level `on` key: YAML 1.1 readers turn a bare `on` into `true`, GitHub reads it as `on`
  const onAt = lines.findIndex((l) => indentOf(l) === 0 && /^(?:on|"on"|'on')\s*:/.test(l));
  if (onAt < 0) return [];
  const inline = lines[onAt]!.replace(/^[^:]*:/, "").trim();
  if (inline) return /\bschedule\b/.test(inline) ? fromFlow(inline) : [];

  // the block under `on:` ends at the next top-level key
  let end = onAt + 1;
  while (end < lines.length && (blank(lines[end]!) || indentOf(lines[end]!) > 0)) end++;
  const block = lines.slice(onAt + 1, end);
  const childIndent = Math.min(
    ...block.filter((l) => !blank(l)).map(indentOf),
    Number.POSITIVE_INFINITY,
  );
  const at = block.findIndex((l) => indentOf(l) === childIndent && keyValue(l)?.[0] === "schedule");
  if (at < 0) return [];
  const value = keyValue(block[at]!)![1];
  if (value) return fromFlow(value);

  const out: Schedule[] = [];
  let item: Record<string, string> | null = null;
  let dashIndent = -1;
  const flush = () => {
    if (item && item.cron !== undefined)
      out.push(item.timezone ? { cron: item.cron, timezone: item.timezone } : { cron: item.cron });
    item = null;
  };
  for (let i = at + 1; i < block.length; i++) {
    const line = block[i]!;
    if (blank(line)) continue;
    if (indentOf(line) <= childIndent) break;
    const dash = /^(\s*)-\s*(.*)$/.exec(line);
    if (dash && (dashIndent < 0 || dash[1]!.length === dashIndent)) {
      flush();
      dashIndent = dash[1]!.length;
      item = {};
      const rest = dash[2]!.trim();
      if (rest.startsWith("{")) {
        out.push(...fromFlow(rest));
        item = null;
        continue;
      }
      const kv = rest ? keyValue(rest) : null;
      if (kv) item[kv[0]] = unquote(kv[1]);
      continue;
    }
    const kv = keyValue(line);
    if (item && kv) item[kv[0]] = unquote(kv[1]);
  }
  flush();
  return out;
}
