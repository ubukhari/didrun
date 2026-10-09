#!/usr/bin/env node
/**
 * Print the README's recorded sample: `didrun demo` over the synthetic repo, on the demo's own
 * clock. Build first (`pnpm build`); then paste the output into the README's sample block.
 * src/distribution.test.ts fails while the two differ, and writes agentcheck's copy for /didrun.
 */
import { main } from "../dist/index.js";

await main(["demo"], {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
});
