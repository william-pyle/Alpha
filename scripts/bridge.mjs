import { build } from "esbuild";
await build({
  entryPoints: ["integration/alpha-tools.mjs"],
  outfile: "integration/alpha-tools.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  minify: true,
});
