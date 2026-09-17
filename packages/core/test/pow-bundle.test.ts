import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'

// Same banner scripts/build.mjs prepends to both bundles it produces.
const REQUIRE_SHIM = "import { createRequire as __agentbridgeCreateRequire } from 'node:module'; const require = __agentbridgeCreateRequire(import.meta.url);"

const POW_PATH = resolve(import.meta.dirname, '../src/envelope/pow.ts')

describe('proof-of-work bundle smoke test', () => {
  // mineEvent runs an eval'd worker source string; nothing calls it through a bundle yet, and a
  // worker that only breaks once bundled would surface as a hang in plans 2/3, not a clean failure.
  it('mines proof of work from inside a standalone esbuild bundle with no repository dependencies at runtime', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ab-pow-bundle-'))
    const entry = join(dir, 'entry.ts')
    const outfile = join(dir, 'out.mjs')
    await writeFile(
      entry,
      `import { mineEvent, leadingZeroBits } from ${JSON.stringify(POW_PATH)}\n` +
        `const { id, tags } = await mineEvent({ pubkey: 'a'.repeat(64), created_at: 1, kind: 1059, tags: [], content: 'bundle' }, 8)\n` +
        `console.log(JSON.stringify({ id, bits: leadingZeroBits(id), nonce: tags.at(-1) }))\n`,
    )

    await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      legalComments: 'none',
      logLevel: 'silent',
      banner: { js: REQUIRE_SHIM },
    })

    const stdout = execFileSync('node', [outfile], { cwd: dir, encoding: 'utf8' })
    const result = JSON.parse(stdout) as { id: string; bits: number; nonce: string[] }

    expect(result.bits).toBeGreaterThanOrEqual(8)
    expect(result.nonce[0]).toBe('nonce')
    expect(result.nonce[2]).toBe('8')
  })
})
