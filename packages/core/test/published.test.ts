import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLI_ARGV, CLI_COMMAND, PUBLISHED_PACKAGE } from '@agentbridge/core'

const repoRoot = join(import.meta.dirname, '../../..')

describe('published package name', () => {
  // 0.1.0 shipped `npx -y agentbridge@latest mcp` in setup: a hand-typed copy of the name left
  // behind when the package moved under a scope. That name is not ours on npm, so the MCP server
  // never started — and anyone who registered it would have run code on the asker's machine.
  it('is the name scripts/pack.mjs actually publishes under', async () => {
    const pack = await readFile(join(repoRoot, 'scripts/pack.mjs'), 'utf8')
    expect(pack).toContain(`name: '${PUBLISHED_PACKAGE}'`)
  })

  it('is scoped, so an unscoped squatter can never be what npx resolves', () => {
    expect(PUBLISHED_PACKAGE).toMatch(/^@[a-z0-9-]+\/agentbridge$/)
  })

  it('runs through npx in the exact shape the README documents', async () => {
    expect(CLI_ARGV).toEqual(['npx', '-y', `${PUBLISHED_PACKAGE}@latest`])
    expect(CLI_COMMAND).toBe(CLI_ARGV.join(' '))
    const readme = await readFile(join(repoRoot, 'README.md'), 'utf8')
    expect(readme).toContain(`${CLI_COMMAND} setup`)
  })

  it('requires the Node version that ships node:sqlite without a flag, in both manifests', async () => {
    const root = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
    expect(root.engines.node).toBe('>=22.13')
    const pack = await readFile(join(repoRoot, 'scripts/pack.mjs'), 'utf8')
    expect(pack).toContain("engines: { node: '>=22.13' }")
  })

  it('no longer ships the self-hosted relay or its database scripts', async () => {
    const root = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
    expect(root.workspaces).toEqual(['packages/core', 'packages/channel', 'packages/cli'])
    expect(root.scripts['db:up']).toBeUndefined()
    expect(root.scripts['db:down']).toBeUndefined()
    await expect(readFile(join(repoRoot, 'render.yaml'), 'utf8')).rejects.toThrow()
  })
})
