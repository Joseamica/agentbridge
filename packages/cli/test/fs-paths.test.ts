import { mkdir, mkdtemp, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { isSameOrWithin, resolveNonExisting } from '../src/fs-paths'

describe('isSameOrWithin', () => {
  it('treats a path as within itself', () => {
    expect(isSameOrWithin('/a/b', '/a/b')).toBe(true)
  })

  it('treats a nested path as within its parent', () => {
    expect(isSameOrWithin('/a/b/c', '/a/b')).toBe(true)
  })

  it('does not treat a sibling with a shared prefix as within (a bare startsWith without the separator would get this wrong)', () => {
    expect(isSameOrWithin('/a/bee', '/a/b')).toBe(false)
  })

  // `dir + sep` on the filesystem root ('/') would be '//', which no real absolute path starts
  // with — making `--share /` bypass the containment guard entirely (round 2 review, minor 1).
  // Root already ends with the separator, so it must not get a second one appended.
  it('treats everything under the filesystem root as within it', () => {
    expect(isSameOrWithin('/etc/passwd', '/')).toBe(true)
    expect(isSameOrWithin('/', '/')).toBe(true)
  })
})

describe('resolveNonExisting', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ab-fs-paths-'))
  })

  it('walks up to the nearest real ancestor for a plain path that does not exist yet', async () => {
    const realRoot = await resolveNonExisting(root) // root itself already exists
    const target = join(root, 'not-yet', 'nested')
    expect(await resolveNonExisting(target)).toBe(join(realRoot, 'not-yet', 'nested'))
  })

  // Round 2 review, minor 2: a dangling symlink (its target does not exist) must resolve to
  // what it actually points AT, not have its own name reattached to its parent's real path.
  // Reattaching the link's own name is exactly the bug that let a dangling `--home` symlink,
  // whose target sits inside `--share`, slip past the containment guard undetected — the guard
  // would compare the symlink's own (outside) location while setup-responder's real file
  // operations follow the link to wherever it actually points.
  it('follows a dangling symlink to its own target, not to its own name reattached to its parent', async () => {
    const shareDir = join(root, 'share')
    await mkdir(shareDir, { recursive: true })
    const linkPath = join(root, 'dangling-home-link')
    const targetInsideShare = join(shareDir, 'not-created-yet')
    await symlink(targetInsideShare, linkPath)

    const resolved = await resolveNonExisting(linkPath)
    const shareReal = await resolveNonExisting(shareDir)
    const wrongAnswer = join(await resolveNonExisting(root), 'dangling-home-link')

    expect(resolved).toBe(join(shareReal, 'not-created-yet'))
    expect(resolved).not.toBe(wrongAnswer)
  })

  // A chained dangling symlink (A -> B -> nonexistent) must still resolve through to B's own
  // target, not stop at B's own (also dangling) name.
  it('follows a chain of dangling symlinks all the way to the final target', async () => {
    const shareDir = join(root, 'share')
    await mkdir(shareDir, { recursive: true })
    const finalTarget = join(shareDir, 'not-created-yet')
    const middleLink = join(root, 'middle-link')
    const outerLink = join(root, 'outer-link')
    await symlink(finalTarget, middleLink)
    await symlink(middleLink, outerLink)

    const resolved = await resolveNonExisting(outerLink)
    const shareReal = await resolveNonExisting(shareDir)
    expect(resolved).toBe(join(shareReal, 'not-created-yet'))
  })

  // Round 3 review: following a dangling symlink recursively (added above for round 2's minor
  // 2) had no depth bound of its own, so a symlink CYCLE — a -> a, or a -> b -> a — never
  // terminated: each hop is itself dangling, so realpath() keeps failing and readlink() keeps
  // handing back another link to follow, forever. This measures a REAL wall-clock bound, not
  // just "the promise eventually settles" — so a future change that reintroduces the unbounded
  // recursion fails this assertion outright instead of quietly tripping vitest's own 20s test
  // timeout, which would report an ambiguous timeout rather than pointing at this function.
  // Chosen generously (a small multiple of the ~40-hop cap, which should run in single-digit
  // milliseconds on real disks) while still being drastically tighter than the 40s/180s hangs
  // this reproduced against the pre-cap code.
  const CYCLE_TIME_BOUND_MS = 5000

  it('resolves a self-referential symlink (absolute link text) in bounded time instead of looping forever', async () => {
    const linkPath = join(root, 'self-link-absolute')
    await symlink(linkPath, linkPath)
    const start = Date.now()
    const resolved = await resolveNonExisting(linkPath)
    expect(Date.now() - start).toBeLessThan(CYCLE_TIME_BOUND_MS)
    expect(typeof resolved).toBe('string')
  })

  it('resolves a self-referential symlink (relative link text) in bounded time instead of looping forever', async () => {
    const linkPath = join(root, 'self-link-relative')
    await symlink('self-link-relative', linkPath)
    const start = Date.now()
    const resolved = await resolveNonExisting(linkPath)
    expect(Date.now() - start).toBeLessThan(CYCLE_TIME_BOUND_MS)
    expect(typeof resolved).toBe('string')
  })

  it('resolves a two-node symlink cycle (a -> b -> a) in bounded time instead of looping forever', async () => {
    const a = join(root, 'cycle-a')
    const b = join(root, 'cycle-b')
    await symlink(b, a)
    await symlink(a, b)
    const start = Date.now()
    const resolved = await resolveNonExisting(a)
    expect(Date.now() - start).toBeLessThan(CYCLE_TIME_BOUND_MS)
    expect(typeof resolved).toBe('string')
  })
})
