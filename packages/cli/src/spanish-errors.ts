import { describeError } from '@agentbridge/core'
import type { z } from 'zod'

// Node's filesystem errors carry a short machine code (err.code) plus an English message built
// from it ("EACCES: permission denied, mkdir '...'"). `setup`'s folder-answer step can hit any
// of these while creating the shared folder or the responder's dedicated profile directory — an
// existing plain file where a folder was expected, a parent directory with no write permission,
// a read-only filesystem, a full disk — and every one of those used to escape as that raw
// English text at exit 2 instead of a Spanish CliError at exit 1. Covers the common codes by
// name; an errno this doesn't recognize still gets Spanish framing around the raw message
// instead of nothing at all, since the alternative is letting an unrecognized failure through
// completely untranslated.
export function describeFsError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return 'no tienes permiso para escribir ahí'
    case 'ENOTDIR':
      return 'una parte de esa ruta no es una carpeta'
    case 'EEXIST':
      return 'ya existe algo con ese nombre que no es una carpeta'
    case 'ENOENT':
      return 'la ruta no existe, o un enlace roto apunta a algo que no existe'
    case 'EROFS':
      return 'el disco está en modo solo lectura ahí'
    case 'ENOSPC':
      return 'no queda espacio en el disco'
    default:
      // Never the error's own message: it can carry a path this text must not carry.
      return `no se pudo completar la operación (${describeError(err)})`
  }
}

// zod's own issue messages are English ("Too big: expected string to have <=4000
// characters", "Invalid input: expected string, received undefined"). Never surface them
// on a user-facing Spanish channel: report only which fields were invalid, never zod's own
// wording — the same shape already used by the channel package's reply tool (Task 12).
export function zodFieldsMessage(err: z.ZodError): string {
  const fields = Array.from(new Set(err.issues.map((i) => (i.path.length ? i.path.join('.') : 'cuerpo'))))
  return `Argumentos inválidos en: ${fields.join(', ')}`
}
