import { lstat, readlink, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'

// realpath()'s own loop detection (ELOOP) only fires once every segment on the way to the
// target exists; it does not protect the manual readlink-and-recurse fallback below, which has
// no such built-in bound. A self-referential or mutually-referential dangling symlink (a -> a,
// or a -> b -> a — realistic if a sync client or a `git pull` drops one into the shared folder,
// which doctor.ts explicitly treats as untrusted input) never produces a path realpath() can
// resolve, so without a cap the fallback would call readlink on the same handful of paths
// forever. Capped at a conventional symlink-loop depth (matching common OS SYMLOOP_MAX values);
// past it, stop trying to follow the link and fall through to the plain walk-up branch instead
// — the same answer the pre-dangling-symlink-aware version of this function gave, restoring a
// bounded (if arbitrary) result for a cycle while keeping the correct one for a genuine,
// non-cyclic dangling symlink.
const MAX_SYMLINK_FOLLOWS = 40

// realpath() requires every path segment to exist, so it cannot resolve a dangling symlink's
// target, or a path a caller is about to create but doesn't exist yet (e.g. `--home` before
// setup-responder has made it). Two different reasons realpath() can fail need two different
// recoveries:
// - The path (or an ancestor of it) simply does not exist yet: walk up until an ancestor does,
//   realpath that ancestor (which also resolves anything like macOS's /tmp -> /private/tmp in
//   its prefix), then reattach the nonexistent suffix.
// - The path itself exists but IS a symlink whose target does not (a dangling symlink): its own
//   name must NOT be reattached to its parent's real path — that would silently point at the
//   link itself instead of at what it actually points to. Follow the link's own raw text
//   instead, resolved against the directory the link lives in, exactly the way `readlink`
//   documents it (a dangling `--home` symlink whose target sits inside `--share` slipped past
//   an earlier version of this function undetected because of this exact distinction) — but
//   only up to MAX_SYMLINK_FOLLOWS hops; see the comment above it for why.
export async function resolveNonExisting(path: string, depth = 0): Promise<string> {
  const real = await realpath(path).catch(() => null)
  if (real) return real
  if (depth < MAX_SYMLINK_FOLLOWS) {
    const info = await lstat(path).catch(() => null)
    if (info?.isSymbolicLink()) {
      const raw = await readlink(path)
      return resolveNonExisting(resolve(dirname(path), raw), depth + 1)
    }
  }
  const parent = dirname(path)
  if (parent === path) return path
  return join(await resolveNonExisting(parent, depth), basename(path))
}

// Turns a raw --flag value (relative, with a trailing slash, or naming a symlink) into a path
// that can be compared for equality/containment against another such value with
// `===`/`startsWith`. Deliberately does NOT expand a leading `~`: setupResponder and doctor
// build the paths they actually read and write with plain `resolve()` (a shell normally expands
// `~` itself before argv ever reaches this process, and neither command has ever tried to do
// that expansion itself), so this must resolve a `~`-prefixed value exactly the same inert way
// they do — anything fancier here would let the guard's opinion of where `--home` is disagree
// with where the rest of the code actually puts it, which is worse than not expanding `~` at
// all (round 2 found exactly that divergence: a quoted `~/foo` value that this function
// expanded to the real home directory while `resolve()` elsewhere left it as a literal `~`
// subfolder of the current directory).
export async function resolveComparablePath(input: string): Promise<string> {
  return resolveNonExisting(resolve(input))
}

// True when `path` is exactly `dir`, or lives anywhere underneath it. Both arguments must
// already be resolved (resolveComparablePath, or realpath) for this to mean anything.
// `dir` is only ever appended a separator if it does not already end in one — dir === '/' (the
// filesystem root) already ends with `sep`, and appending a second one would turn the prefix
// into '//', which no real absolute path starts with, making `isSameOrWithin(anything, '/')`
// always false instead of always true.
export function isSameOrWithin(path: string, dir: string): boolean {
  if (path === dir) return true
  const prefix = dir.endsWith(sep) ? dir : dir + sep
  return path.startsWith(prefix)
}
