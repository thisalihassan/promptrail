import * as esbuild from "esbuild";

const args = process.argv.slice(2);
const watch = args.includes("--watch");
const target = args.find((a) => !a.startsWith("-")) || "all";

const shared = {
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
  minify: !watch,
};

const targets = {
  ext: {
    ...shared,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    external: ["vscode"],
  },
  cli: {
    ...shared,
    entryPoints: ["src/cli/index.ts"],
    outfile: "dist/cli.js",
    banner: { js: "#!/usr/bin/env node" },
  },
  test: {
    ...shared,
    entryPoints: ["tests/index.ts"],
    outdir: "dist-tests",
    minify: false,
    splitting: false,
    alias: { vscode: "./tests/mocks/vscode.ts" },
  },
};

const selected =
  target === "all"
    ? Object.values(targets)
    : targets[target]
      ? [targets[target]]
      : (console.error(`Unknown target: ${target}. Use: ext, cli, or all`),
        process.exit(1));

const contexts = await Promise.all(selected.map((t) => esbuild.context(t)));

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
  console.log(`Watching ${target}...`);
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
