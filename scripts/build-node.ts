// Bundles the Node server (src/entry/node.ts and everything it imports, the Hypha SDK
// packages included) into dist/server.js, so the Docker image needs nothing but Node:
// no node_modules, no sibling Hypha checkout.

import { build } from "esbuild";

await build({
  entryPoints: [new URL("../src/entry/node.ts", import.meta.url).pathname],
  outfile: new URL("../dist/server.js", import.meta.url).pathname,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // `import.meta.main` decides whether the entry starts the server: true for the bundle.
  define: { "import.meta.main": "true" },
  legalComments: "none",
  sourcemap: true,
});
console.log("wrote dist/server.js");
