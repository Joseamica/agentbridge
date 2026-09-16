import { execFile } from 'node:child_process'
import { mkdtemp, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { IDENTITY_FILE, UserFacingError, decodeLink, encodeLink, loadIdentity, loadOrCreateIdentity } from '@agentbridge/core'

const run = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, '../../..')
const newHome = async () => join(await mkdtemp(join(tmpdir(), 'ab-identity-')), 'home')

describe('local identity', () => {
  it('creates a private identity file inside a private folder and reads the same key back', async () => {
    const home = await newHome()
    const { identity, created } = await loadOrCreateIdentity(home)
    expect(created).toBe(true)
    expect(identity.publicKey).toMatch(/^[0-9a-f]{64}$/)
    expect((await stat(home)).mode & 0o777).toBe(0o700)
    expect((await stat(join(home, IDENTITY_FILE))).mode & 0o777).toBe(0o600)
    const again = await loadIdentity(home)
    expect(again?.publicKey).toBe(identity.publicKey)
    expect(Buffer.from(again!.secretKey).equals(Buffer.from(identity.secretKey))).toBe(true)
  })

  it('returns the existing identity instead of creating a second one', async () => {
    const home = await newHome()
    const first = await loadOrCreateIdentity(home)
    const second = await loadOrCreateIdentity(home)
    expect(second.created).toBe(false)
    expect(second.identity.publicKey).toBe(first.identity.publicKey)
  })

  it('returns null when no identity exists yet', async () => {
    expect(await loadIdentity(await newHome())).toBeNull()
  })

  it('never produces two identities when several callers race in one process, and leaves no temp files', async () => {
    const home = await newHome()
    const results = await Promise.all(Array.from({ length: 6 }, () => loadOrCreateIdentity(home)))
    expect(new Set(results.map((r) => r.identity.publicKey)).size).toBe(1)
    expect(results.filter((r) => r.created)).toHaveLength(1)
    expect((await readdir(home)).sort()).toEqual([IDENTITY_FILE])
  })

  it('never produces two identities when separate processes race', async () => {
    const home = await newHome()
    const script = `import { loadOrCreateIdentity } from ${JSON.stringify(join(repoRoot, 'packages/core/src/identity.ts'))}
const r = await loadOrCreateIdentity(${JSON.stringify(home)})
process.stdout.write(JSON.stringify({ publicKey: r.identity.publicKey, created: r.created }))`
    const outputs = await Promise.all(
      Array.from({ length: 4 }, () =>
        run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: repoRoot }),
      ),
    )
    const parsed = outputs.map((o) => JSON.parse(o.stdout) as { publicKey: string; created: boolean })
    expect(new Set(parsed.map((p) => p.publicKey)).size).toBe(1)
    expect(parsed.filter((p) => p.created)).toHaveLength(1)
    expect((await readdir(home)).sort()).toEqual([IDENTITY_FILE])
  })

  it('reports a damaged identity file in Spanish without echoing its contents', async () => {
    const home = await newHome()
    await loadOrCreateIdentity(home)
    await writeFile(join(home, IDENTITY_FILE), '{"version":1,"secretKey":"not-hex-and-secret-looking"}')
    const err = await loadIdentity(home).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UserFacingError)
    expect((err as Error).message).toContain('dañado')
    expect((err as Error).message).not.toContain('secret-looking')
  })
})

describe('agentbridge: links', () => {
  const pubkey = 'e9451985e285d64afb4594cf538593e53e9fedfbec8bdaec8e9399df40ea41b8'

  it('round-trips the public key and relays', () => {
    const link = encodeLink(pubkey, ['wss://relay.primal.net', 'wss://nos.lol'])
    expect(link.startsWith('agentbridge:nprofile1')).toBe(true)
    expect(decodeLink(link)).toEqual({ publicKey: pubkey, relays: ['wss://relay.primal.net', 'wss://nos.lol'] })
  })

  it('never puts more than five relays in a link', () => {
    const relays = Array.from({ length: 7 }, (_, i) => `wss://r${i}.example.com`)
    expect(decodeLink(encodeLink(pubkey, relays)).relays).toHaveLength(5)
  })

  it('accepts a bare nprofile and surrounding whitespace', () => {
    const bare = encodeLink(pubkey, []).slice('agentbridge:'.length)
    expect(decodeLink(`  ${bare}\n`)).toEqual({ publicKey: pubkey, relays: [] })
  })

  it.each(['', 'hola', 'agentbridge:', 'agentbridge:npub1abc', 'nprofile1qqqqqq', `agentbridge:${'nprofile1'.padEnd(3000, 'q')}`])(
    'rejects %j with a Spanish error',
    (input) => {
      expect(() => decodeLink(input)).toThrow(UserFacingError)
      expect(() => decodeLink(input)).toThrow(/enlace de AgentBridge no es válido/)
    },
  )

  it('refuses to encode a malformed public key', () => {
    expect(() => encodeLink('ABC', [])).toThrow()
  })
})
