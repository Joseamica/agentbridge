import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = new URL('../../', import.meta.url).pathname
// Plans and specs are a record of what was decided when they were written; rewriting history to
// satisfy a lint would destroy the reason they exist. Everything a person is meant to FOLLOW is
// covered.
const DOCS = ['README.md', 'CLAUDE.md', 'docs/inicio-rapido.md', 'docs/known-gaps.md', 'docs/runbooks/aceptacion-0.4.md']

describe('the docs do not ask a person to paste shell', () => {
  it('never mentions start.sh', async () => {
    for (const doc of DOCS) {
      expect(await readFile(join(ROOT, doc), 'utf8'), doc).not.toMatch(/start\.sh/)
    }
  })

  it('never shows an inline environment-variable assignment', async () => {
    // `VAR='x' comando` is bash. It is a syntax error in PowerShell, which is what the person on
    // Windows was handed. If a doc needs something in the environment, the program sets it.
    for (const doc of DOCS) {
      expect(await readFile(join(ROOT, doc), 'utf8'), doc).not.toMatch(/CLAUDE_CONFIG_DIR=\S/)
    }
  })

  it('tells people about the responder command', async () => {
    // The npx form, not a bare `agentbridge`: nothing installs a binary on PATH, so a printed
    // `agentbridge responder` is a step nobody can actually run. `CLI_COMMAND` is
    // `npx -y @joseamica/agentbridge@latest`, which is why this matches `@latest responder`.
    expect(await readFile(join(ROOT, 'docs/inicio-rapido.md'), 'utf8')).toMatch(/@latest responder/)
  })

  it('left no copy of an older acceptance runbook behind', async () => {
    const runbooks = await readdir(join(ROOT, 'docs/runbooks'))
    expect(runbooks).not.toContain('aceptacion-0.2.md')
    expect(runbooks).not.toContain('aceptacion-0.3.md')
  })

  it('keeps the runbook to the shell blocks it says it has', async () => {
    // The runbook promises that the only shell is in blocks marked ```bash, and says how many.
    // A fifth one slipped into a Windows-side step would still pass every other check here.
    const runbook = await readFile(join(ROOT, 'docs/runbooks/aceptacion-0.4.md'), 'utf8')
    expect(runbook).toContain('Hay cuatro, todos en la sección 1, en S6 y en la sección 9.')
    expect(runbook.match(/^```bash$/gm) ?? []).toHaveLength(4)
  })
})

describe('the docs say what the scopes do, and no more', () => {
  it('call the home directory "carpeta personal", the word setup uses', async () => {
    // Two names for one folder read as two folders (task 2 review, M1).
    for (const doc of DOCS) {
      expect(await readFile(join(ROOT, doc), 'utf8'), doc).not.toMatch(/carpeta de usuario/)
    }
  })

  it('never promise the caja fuerte closes every secret', async () => {
    // It closes the best-known places. "menos tus secretos" was the wording ruling 3 removed from
    // setup; a doc repeating it would put the overpromise back where people read it slowly.
    for (const doc of DOCS) {
      expect(await readFile(join(ROOT, doc), 'utf8'), doc).not.toMatch(/(menos|todos|cerrados) tus secretos/)
    }
    const guide = await readFile(join(ROOT, 'docs/inicio-rapido.md'), 'utf8')
    expect(guide).toContain('los lugares más conocidos donde se guardan contraseñas y llaves')
    expect(guide).toContain('La caja fuerte no lo cubre todo.')
    // Mode 3's one sentence a person must understand before choosing it.
    expect(guide).toMatch(/cualquier persona a la que le des permiso\s+de preguntarte puede preguntar por cualquier archivo de tu carpeta personal/)
  })

  it('re-checks the verified Claude Code behaviours the way that actually works', async () => {
    // Both lessons cost real attempts: without disableAllHooks a memory plugin fed earlier probes
    // back to the model and it refused; without a positive control a "not loaded" proves nothing.
    const runbook = await readFile(join(ROOT, 'docs/runbooks/aceptacion-0.4.md'), 'utf8')
    const section = runbook.slice(runbook.indexOf('## 8. '), runbook.indexOf('## 9. '))
    // The lesson, and the line the person actually copies into every probe's settings.
    expect(section).toContain('**Cada sonda lleva `"disableAllHooks": true` en su archivo de ajustes.**')
    expect(section).toMatch(/^  "disableAllHooks": true,$/m)
    expect(section).toContain('Cada "no" necesita su "sí".')
    expect(section).toContain('nombres neutros')
    for (const heading of ['### 8.2 Opción 1', '### 8.3 Opción 2', '### 8.4 Opción 3', '### 8.7 Limpieza']) {
      expect(section).toContain(heading)
    }
  })
})
