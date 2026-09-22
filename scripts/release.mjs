// The publish sequence, so nobody has to remember it. Running `npm publish` from the repository
// root fails with "Cannot read properties of null (reading 'prerelease')" — the root package is
// private and has no version — and that error says nothing about what is actually wrong. What
// gets published is ./dist/pack, and only after the tests pass.
//
// This stops short of publishing on purpose: a version on npm cannot be replaced or removed once
// it goes out, and it goes out under a person's own credentials. Everything above the line is
// reversible and this script does all of it; the one irreversible step is printed, not run.
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'

// Windows has no bare `npm` executable on PATH — only `npm.cmd` — and `child_process.spawn`
// cannot run a `.cmd` file without either `shell: true` (never used here) or naming the `.cmd`
// file explicitly.
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const step = (args) => {
  console.log(`\n$ npm ${args.join(' ')}`)
  const result = spawnSync(npm, args, { stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`\nFalló: npm ${args.join(' ')}`)
    process.exit(result.status ?? 1)
  }
}

const manifest = JSON.parse(await readFile(new URL('../plugins/agentbridge/.claude-plugin/plugin.json', import.meta.url), 'utf8'))
const version = manifest.version

step(['test'])
step(['run', 'typecheck'])
step(['run', 'build'])
step(['run', 'pack'])

console.log(`\nTodo verde. Falta un paso, y es tuyo:\n`)
console.log(`  npm publish ./dist/pack`)
console.log(`\nDespués:\n`)
// The tag by name, never `--tags`: that pushes every local tag at once, and this repository has
// history that is deliberately kept local (the `archive/pre-oss` branch exists for that reason).
// A release should push exactly the one tag it is about.
console.log(`  git tag v${version} && git push origin main && git push origin v${version}`)
console.log(`  gh release create v${version} --title "AgentBridge ${version}" --notes-file <notas>`)
