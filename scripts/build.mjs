import { chmod } from 'node:fs/promises'
import { build } from 'esbuild'

const requireShim = "import { createRequire as __agentbridgeCreateRequire } from 'node:module'; const require = __agentbridgeCreateRequire(import.meta.url);"

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'info',
  legalComments: 'none',
}

await build({
  ...common,
  entryPoints: ['packages/channel/src/main.ts'],
  outfile: 'plugins/agentbridge/dist/server.js',
  banner: { js: requireShim },
})

await build({
  ...common,
  entryPoints: ['packages/cli/src/main.ts'],
  outfile: 'packages/cli/dist/main.js',
  banner: { js: `#!/usr/bin/env node\n${requireShim}` },
})
await chmod('packages/cli/dist/main.js', 0o755)
