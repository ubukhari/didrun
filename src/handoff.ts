/**
 * The hand-off, worded as not built (brief DOOR-12). agentcheck's hourly watch checks MCP servers
 * only; nothing of ours takes a heartbeat from a job yet. So every run and every page ends with the
 * same sentence and a link to the /didrun page's waitlist button, whose click is the count. No
 * price is named until one is decided and its checkout works.
 */
export const SITE = "https://agentwares-agentcheck.vercel.app";

/** The `?ref=` the CLI's links carry, recorded by the /didrun pages' beacon. */
export const REF = "didrun";

/** Every didrun page: the landing page and one per searched failure. */
export const PAGES_URL = `${SITE}/didrun`;

/** Where a run's hand-off line points: the landing page's watch section. */
export const HANDOFF_URL = `${PAGES_URL}?ref=${REF}#watch`;

/** The hand-off, word for word, at the end of every run and in the watch section of every page. */
export const HANDOFF_LINE = "An hourly watch for scheduled runs is not built.";

/** What it would do, and what agentcheck's free watch covers today. */
export const HANDOFF_DETAIL =
  "It would email you when a scheduled run is late, missed, or green with nothing done, checked " +
  "from outside GitHub's scheduler, with no change to your repo. agentcheck's free hourly watch " +
  "covers MCP servers only today. If you would pay for this one, say so with one click:";
