import { defineConfig } from "tsup";

/**
 * No runtime dependencies: npx installs one package. Its only requests are GETs to GitHub's API
 * (src/github.ts); `demo` reads fixtures bundled into dist.
 */
export default defineConfig({
  entry: { cli: "src/cli.ts", index: "src/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  dts: { entry: { index: "src/index.ts" } },
  sourcemap: true,
  clean: true,
  splitting: false,
});
