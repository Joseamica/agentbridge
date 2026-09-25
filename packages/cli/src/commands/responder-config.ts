// The shape of the dedicated profile's saved configuration, its filename, and the two value
// checks it needs — split out of `responder.ts` so that it and `setup-responder.ts` can both
// import from here instead of from each other. An earlier version had `responder.ts` import
// `ALLOWED_EFFORTS`/`SAFE_MODEL_PATTERN` from `setup-responder.ts` while `setup-responder.ts`
// imported `RESPONDER_CONFIG_FILE`/`ResponderConfig` back from `responder.ts`. It worked —
// verified: `tsc` clean, the bundle runs, every test passes — only because neither module reads
// the other's bindings during module evaluation. That is fragile: one top-level `const` that
// reads the other side's export would turn it into a TDZ crash that only shows up at runtime in
// the bundle, not in a type-check. A third, dependency-free module removes the cycle entirely.

import { isAbsolute } from 'node:path'
import { isSameOrWithin } from '../fs-paths'

export const RESPONDER_CONFIG_FILE = 'responder.json'

// What the answering agent may read, chosen once for every contact (D1). `folder` is the only
// thing 0.3 knew; `folders` adds more working directories beside the shared one; `home` adds the
// person's whole personal folder minus the caja fuerte. None of them turns the read fence off —
// they widen the set of directories it lets through.
export type ResponderScope =
  | { kind: 'folder' }
  // Absolute, resolved, non-empty, none inside another or inside the shared folder, none holding
  // the identity home or the profile — see scopeProblem below.
  | { kind: 'folders'; extra: string[] }
  | { kind: 'home' }

// What `start.sh` used to carry inside a bash script. Kept as data, in the dedicated profile,
// at 0600: the answering session is fenced out of this folder, so nothing it reads can rewrite
// which folder it serves or which settings file locks it down. Version 2 adds `scope`; a
// version-1 file (every 0.3 install) is read as `{ kind: 'folder' }`, which is exactly what it
// meant when it was written.
export type ResponderConfig = {
  version: 2
  shareDir: string
  identityHome: string
  model: string
  effort: string
  scope: ResponderScope
}

// One check for a scope's folders, used at write time (setupResponder, against real paths) and on
// every read (readResponderConfig, against the stored strings), so the two can never disagree
// about what is allowed. Returns the Spanish reason, or null. Each refusal is a way the key, the
// database or the profile's own settings would end up inside a directory the answering session
// can read: the fence only keeps them out while no readable directory contains them.
export function scopeProblem(
  scope: ResponderScope,
  o: { shareDir: string; identityHome: string; profileHome: string },
): string | null {
  if (scope.kind !== 'folders') return null
  if (scope.extra.length === 0) return 'el alcance "varias carpetas" no tiene ninguna carpeta extra'
  for (const [i, dir] of scope.extra.entries()) {
    if (!isAbsolute(dir)) return 'una de las carpetas extra no es una ruta absoluta'
    if (isSameOrWithin(dir, o.shareDir)) return `${dir} es la carpeta compartida o está dentro de ella`
    for (const [j, other] of scope.extra.entries()) {
      if (i !== j && isSameOrWithin(dir, other)) return `${dir} está repetida o dentro de otra carpeta extra`
    }
    if (isSameOrWithin(o.identityHome, dir)) return `${dir} contiene tu carpeta de identidad (tu llave secreta)`
    if (isSameOrWithin(o.profileHome, dir)) return `${dir} contiene el perfil dedicado del respondedor`
  }
  return null
}

// The one-line name of a mode, said the same way by `setup` (its summary), `responder` (before it
// hands over the terminal) and `doctor` (its information line). Kept here, in the module with no
// dependencies, so none of the three has to import another command to say it. "menos la caja
// fuerte", never "menos tus secretos": the caja fuerte closes the best-known places, not every
// secret a person has (task 2 review, I2).
export function scopeSummary(scope: ResponderScope): string {
  if (scope.kind === 'folder') return 'Tu agente puede ver: solo la carpeta compartida.'
  if (scope.kind === 'home') return 'Tu agente puede ver: toda tu carpeta personal, menos la caja fuerte.'
  const more = scope.extra.length === 1 ? 'una carpeta más' : `${scope.extra.length} carpetas más`
  return `Tu agente puede ver: la carpeta compartida y ${more}.`
}

// These values used to land inside a hand-rolled bash script (`start.sh`), where an unvalidated
// --model/--effort (typed by hand, or passed through automation) could break out of the line it
// was interpolated into. They now live in responder.json instead and reach `claude` as one
// element of an argv array — spawned without a shell, so there is no line to break out of. Both
// are still validated at write time (setupResponder) and again on every read
// (readResponderConfig, in responder.ts), because the file sits on disk between runs and nothing
// stops it from being hand-edited in between.
//
// --effort has a small, fixed set of valid values, so it is an allowlist.
export const ALLOWED_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

// --model does not: a full model id such as "claude-haiku-4-5-20251001" is just as valid as
// the short aliases, so an allowlist would reject legitimate values. This validates the shape
// (letters, digits, dot, underscore, hyphen) instead, which is enough to keep a stored value
// from ever looking like a second flag once it reaches `claude`'s own argv.
export const SAFE_MODEL_PATTERN = /^[A-Za-z0-9._-]+$/
