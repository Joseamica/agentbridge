import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = new URL('../../', import.meta.url).pathname
// Plans and specs are a record of what was decided when they were written; rewriting history to
// satisfy a lint would destroy the reason they exist. Everything a person is meant to FOLLOW is
// covered.
const DOCS = ['README.md', 'CLAUDE.md', 'docs/inicio-rapido.md', 'docs/known-gaps.md', 'docs/runbooks/aceptacion-0.3.md']

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

  it('left no copy of the 0.2 acceptance runbook behind', async () => {
    const runbooks = await readdir(join(ROOT, 'docs/runbooks'))
    expect(runbooks).not.toContain('aceptacion-0.2.md')
  })
})
