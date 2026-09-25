import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ResponderScope } from '../src/commands/responder-config'
import {
  CAJA_FUERTE_HOME,
  cajaFuerteFor,
  inspectResponderSettings,
  RESPONDER_DENY,
  responderSettings,
} from '../src/commands/setup-responder'

// Never the real home: every path here is a made-up string, so nothing in this file can read
// or write under the person's own `~`.
const home = '/Users/ana'
const identityHome = '/Users/ana/.agentbridge'
const profileHome = '/Users/ana/.agentbridge-responder'
// Outside the home on purpose: the `~/**` rules cannot reach it, so only the anchored shared-folder
// rules protect its key files.
const shareDir = '/srv/compartido'
const paths = { shareDir, identityHome, profileHome, home, platform: 'darwin' as const }
const SHARE_KEY_RULES = ['**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx'].map((tail) => `Read(//srv/compartido/${tail})`)

const FOLDER: ResponderScope = { kind: 'folder' }
const FOLDERS: ResponderScope = { kind: 'folders', extra: ['/Users/ana/Proyectos', '/Volumes/Datos/notas'] }
const HOME: ResponderScope = { kind: 'home' }

// The rule's path, i.e. what sits between `Read(` and the closing `)`.
function readPath(rule: string): string | null {
  const m = /^Read\((.*)\)$/.exec(rule)
  return m ? m[1]! : null
}

describe('responderSettings, mode 1 (one folder)', () => {
  // Byte for byte what 0.3 writes, captured from the 0.3 code before this change. Every 0.3
  // install has exactly this file on disk; if mode 1 produced anything else, `setupResponder`
  // would rewrite it and tell every existing user their permissions "changed" when they did not.
  it('is byte-identical to the settings.json 0.3 writes', () => {
    const today =
      '{\n  "permissions": {\n    "allow": [\n      "mcp__plugin_agentbridge_agentbridge__reply"\n    ],\n    "deny": [\n      "Bash",\n      "Edit",\n      "Write",\n      "NotebookEdit",\n      "WebFetch",\n      "WebSearch",\n      "Agent",\n      "Read(**/.env)",\n      "Read(**/.env.*)"\n    ],\n    "blockReadsOutsideWorkingDirectories": true\n  }\n}\n'
    expect(`${JSON.stringify(responderSettings(FOLDER, paths), null, 2)}\n`).toBe(today)
  })
})

describe('responderSettings, mode 2 (several folders)', () => {
  const s = responderSettings(FOLDERS, paths)

  it('adds exactly the extra folders as additional directories, and keeps the fence on', () => {
    expect(s.permissions.additionalDirectories).toEqual(['/Users/ana/Proyectos', '/Volumes/Datos/notas'])
    expect(s.permissions.blockReadsOutsideWorkingDirectories).toBe(true)
    expect(s.permissions.allow).toEqual(['mcp__plugin_agentbridge_agentbridge__reply'])
  })

  it('denies the secret files inside every extra folder, anchored to that folder', () => {
    for (const f of ['//Users/ana/Proyectos', '//Volumes/Datos/notas']) {
      for (const tail of ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx']) {
        expect(s.permissions.deny).toContain(`Read(${f}/${tail})`)
      }
    }
  })

  it('denies the identity home and the dedicated profile as absolute paths', () => {
    expect(s.permissions.deny).toContain('Read(//Users/ana/.agentbridge/**)')
    expect(s.permissions.deny).toContain('Read(//Users/ana/.agentbridge-responder/**)')
  })

  it('keeps every mode-1 deny rule', () => {
    for (const rule of RESPONDER_DENY) expect(s.permissions.deny).toContain(rule)
  })

  // The owner ruled that nobody opens the caja fuerte through setup. Without these rules in mode 2,
  // choosing `~/.ssh` or `~/.claude` as an extra folder would open it, so mode 2 carries the list.
  it('denies every caja fuerte rule too, so an extra folder such as ~/.ssh stays closed', () => {
    for (const rule of CAJA_FUERTE_HOME) expect(s.permissions.deny).toContain(rule)
    const ssh = responderSettings({ kind: 'folders', extra: ['/Users/ana/.ssh'] }, paths)
    expect(ssh.permissions.deny).toContain('Read(~/.ssh/**)')
  })

  it('denies the key files in the shared folder, anchored to it', () => {
    for (const rule of SHARE_KEY_RULES) expect(s.permissions.deny).toContain(rule)
  })

  // Not verified on the real binary: how Claude Code anchors `C:\…` in a rule. Guessing a form
  // that silently matches nothing would be the V6 failure again — a rule that looks like
  // protection and covers nothing — so mode 2 is refused there instead.
  // Windows-shaped paths all under the home, so no other refusal (a path outside the home) can
  // fire first and make this pass for the wrong reason — which is exactly what an earlier version
  // of this test did when the mode-2 refusal was removed on purpose.
  it('is refused on Windows, offering the other two modes', () => {
    const win = {
      shareDir: 'C:\\Users\\ana\\compartido',
      identityHome: 'C:\\Users\\ana\\.agentbridge',
      profileHome: 'C:\\Users\\ana\\.agentbridge-responder',
      home: 'C:\\Users\\ana',
      platform: 'win32' as const,
    }
    const scope: ResponderScope = { kind: 'folders', extra: ['C:\\Users\\ana\\Proyectos'] }
    expect(() => responderSettings(scope, win)).toThrow(/varias carpetas/)
    expect(() => responderSettings(scope, win)).toThrow(/opción 1.*opción 3/)
  })

  // A glob character in a folder name turns the anchored path into a pattern: `//a/proj[1]/**`
  // is a character class and does not match the real folder `proj[1]` — protection on paper only.
  it('refuses a folder whose name contains a glob character rather than writing a rule that cannot match it', () => {
    expect(() => responderSettings({ kind: 'folders', extra: ['/Users/ana/proj[1]'] }, paths)).toThrow(/carácter/)
    expect(() => responderSettings({ kind: 'folders', extra: ['/Users/ana/a*b'] }, paths)).toThrow(/carácter/)
  })
})

describe('responderSettings, mode 3 (the whole personal folder)', () => {
  const s = responderSettings(HOME, paths)

  it('adds exactly the home as an additional directory, and keeps the fence on', () => {
    expect(s.permissions.additionalDirectories).toEqual([home])
    expect(s.permissions.blockReadsOutsideWorkingDirectories).toBe(true)
  })

  it('denies every caja fuerte rule', () => {
    for (const rule of CAJA_FUERTE_HOME) expect(s.permissions.deny).toContain(rule)
  })

  // `~/**/*.pem` does not reach a shared folder that lies outside the home.
  it('denies the key files in the shared folder, anchored to it', () => {
    for (const rule of SHARE_KEY_RULES) expect(s.permissions.deny).toContain(rule)
  })

  it('denies the identity home and the profile as absolute paths, wherever they live', () => {
    const custom = responderSettings(HOME, { ...paths, identityHome: '/srv/ab/identidad', profileHome: '/Users/ana/otros/perfil' })
    expect(custom.permissions.deny).toContain('Read(//srv/ab/identidad/**)')
    expect(custom.permissions.deny).toContain('Read(//Users/ana/otros/perfil/**)')
  })

  // The literal list the owner approved, pinned independently of the constant: dropping one
  // entry from CAJA_FUERTE_HOME must fail here even though every other assertion compares
  // against the same, now-shorter, constant.
  it('covers exactly the approved caja fuerte', () => {
    expect([...CAJA_FUERTE_HOME]).toEqual([
      'Read(~/.claude/**)',
      'Read(~/.claude.json*)',
      'Read(~/Library/Application Support/Claude/**)',
      'Read(~/.ssh/**)',
      'Read(~/.gnupg/**)',
      'Read(~/.aws/**)',
      'Read(~/.azure/**)',
      'Read(~/.config/gcloud/**)',
      'Read(~/.kube/**)',
      'Read(~/.docker/**)',
      'Read(~/.config/gh/**)',
      'Read(~/.npmrc)',
      'Read(~/.pypirc)',
      'Read(~/.netrc)',
      'Read(~/.git-credentials)',
      'Read(~/.cargo/credentials*)',
      'Read(~/.terraform.d/**)',
      'Read(~/.config/op/**)',
      'Read(~/.zsh_history)',
      'Read(~/.bash_history)',
      'Read(~/.local/share/fish/**)',
      'Read(~/.python_history)',
      'Read(~/.node_repl_history)',
      'Read(~/.psql_history)',
      'Read(~/.mysql_history)',
      'Read(~/.sqlite_history)',
      'Read(~/Library/Keychains/**)',
      'Read(~/Library/Cookies/**)',
      'Read(~/Library/Application Support/Google/Chrome/**)',
      'Read(~/Library/Application Support/Firefox/**)',
      'Read(~/Library/Safari/**)',
      'Read(~/Library/Application Support/BraveSoftware/**)',
      'Read(~/Library/Application Support/Microsoft Edge/**)',
      'Read(~/Library/Application Support/Arc/**)',
      'Read(~/.mozilla/**)',
      'Read(~/.config/google-chrome/**)',
      'Read(~/.config/chromium/**)',
      'Read(~/.config/BraveSoftware/**)',
      'Read(~/.config/microsoft-edge/**)',
      'Read(~/.local/share/keyrings/**)',
      'Read(~/AppData/**)',
      'Read(~/**/.env)',
      'Read(~/**/.env.*)',
      'Read(~/**/*.pem)',
      'Read(~/**/*.key)',
      'Read(~/**/*.p12)',
      'Read(~/**/*.pfx)',
    ])
  })

  // On Windows the `//<absolute>` form is unverified, but `~/…` is the form the whole mode already
  // rests on — so the identity home and profile, which live under the home by default, are
  // anchored with `~` there rather than with a guessed drive-letter syntax.
  it('anchors the identity home and profile with ~ on Windows', () => {
    const win = responderSettings(HOME, {
      shareDir: 'C:\\Users\\ana\\compartido',
      identityHome: 'C:\\Users\\ana\\.agentbridge',
      profileHome: 'C:\\Users\\ana\\.agentbridge-responder',
      home: 'C:\\Users\\ana',
      platform: 'win32',
    })
    expect(win.permissions.deny).toContain('Read(~/.agentbridge/**)')
    expect(win.permissions.deny).toContain('Read(~/.agentbridge-responder/**)')
  })

  it('refuses on Windows when the identity home lives outside the personal folder, instead of guessing a path form', () => {
    expect(() =>
      responderSettings(HOME, {
        shareDir: 'C:\\Users\\ana\\compartido',
        identityHome: 'D:\\ab\\identidad',
        profileHome: 'C:\\Users\\ana\\.agentbridge-responder',
        home: 'C:\\Users\\ana',
        platform: 'win32',
      }),
    ).toThrow(/Windows/)
  })

  it('refuses on Windows when the shared folder lives outside the personal folder', () => {
    expect(() =>
      responderSettings(HOME, {
        shareDir: 'D:\\compartido',
        identityHome: 'C:\\Users\\ana\\.agentbridge',
        profileHome: 'C:\\Users\\ana\\.agentbridge-responder',
        home: 'C:\\Users\\ana',
        platform: 'win32',
      }),
    ).toThrow(/D:\\compartido/)
  })
})

// V6, on Claude Code 2.1.282: with the home added as an additional directory, `Read(**/.env)`
// did NOT stop a direct Read of `~/proj/.env` — it returned `API_KEY=ENV-SECRETO-888`. An
// unanchored pattern is relative to the working directory, so outside it it protects nothing
// while looking exactly like protection. `Read(~/**/.env)` did stop it. Everything the wider
// modes add must therefore be anchored.
describe('anchoring (the V6 finding)', () => {
  for (const [name, scope] of [
    ['mode 2', FOLDERS],
    ['mode 3', HOME],
  ] as const) {
    // By position, not by filtering out anything equal to a base rule: `Read(**/.env)` IS a base
    // rule, so a filter would silently drop exactly the unanchored form V6 is about.
    it(`${name}: every rule beyond the mode-1 base is anchored to ~ or to an absolute path`, () => {
      const deny = responderSettings(scope, paths).permissions.deny
      expect(deny.slice(0, RESPONDER_DENY.length)).toEqual([...RESPONDER_DENY])
      const added = deny.slice(RESPONDER_DENY.length)
      // Both wider modes carry the whole fixed list and the shared folder's key files (I2, M8);
      // they are checked here so the anchoring below is known to cover them.
      for (const rule of [...CAJA_FUERTE_HOME, ...SHARE_KEY_RULES]) expect(added).toContain(rule)
      for (const rule of added) {
        const p = readPath(rule)
        expect(p, rule).not.toBeNull()
        expect(p!.startsWith('~/') || p!.startsWith('//'), rule).toBe(true)
        expect(p!.startsWith('**'), rule).toBe(false)
      }
    })

    it(`${name}: cajaFuerteFor is anchored the same way`, () => {
      for (const rule of cajaFuerteFor(scope, paths)) {
        const p = readPath(rule)!
        expect(p.startsWith('~/') || p.startsWith('//'), rule).toBe(true)
      }
    })
  }

  it('mode 1 adds no caja fuerte: its only readable folder is the working directory, where the base rules hold', () => {
    expect(cajaFuerteFor(FOLDER, paths)).toEqual([])
  })
})

describe('inspectResponderSettings', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ab-scope-'))
  })
  const write = (value: unknown) => writeFile(join(dir, 'settings.json'), typeof value === 'string' ? value : JSON.stringify(value))
  const inspect = (scope: ResponderScope) => inspectResponderSettings(dir, scope, paths)
  // The inspector denies the profile it is actually inspecting, so the settings under test are
  // built for that same directory.
  const settingsFor = (scope: ResponderScope) => responderSettings(scope, { ...paths, profileHome: dir })

  for (const [name, scope] of [
    ['mode 1', FOLDER],
    ['mode 2', FOLDERS],
    ['mode 3', HOME],
  ] as const) {
    it(`${name}: the settings responderSettings writes have no problems`, async () => {
      await write(settingsFor(scope))
      expect((await inspect(scope)).problems).toEqual([])
    })
  }

  it('reports a missing file', async () => {
    expect((await inspect(HOME)).problems.join(' ')).toMatch(/no existe/)
  })

  it('reports a file that is not JSON', async () => {
    await write('{ no')
    expect((await inspect(HOME)).problems.join(' ')).toMatch(/JSON/)
  })

  it('reports the fence when it is not true inside permissions', async () => {
    const s = settingsFor(HOME) as { permissions: Record<string, unknown> } & Record<string, unknown>
    delete s.permissions.blockReadsOutsideWorkingDirectories
    s.blockReadsOutsideWorkingDirectories = true
    await write(s)
    expect((await inspect(HOME)).problems.join(' ')).toContain('blockReadsOutsideWorkingDirectories')
  })

  it('reports a missing base deny rule', async () => {
    const s = settingsFor(HOME)
    s.permissions.deny = s.permissions.deny.filter((r) => r !== 'Bash')
    await write(s)
    expect((await inspect(HOME)).problems.join(' ')).toContain('Bash')
  })

  it('reports a missing caja fuerte rule', async () => {
    const s = settingsFor(HOME)
    s.permissions.deny = s.permissions.deny.filter((r) => r !== 'Read(~/.ssh/**)')
    await write(s)
    expect((await inspect(HOME)).problems.join(' ')).toContain('Read(~/.ssh/**)')
  })

  // The unanchored form is exactly what V6 showed to be empty protection: present, and useless.
  it('does not accept the unanchored form of a caja fuerte rule in place of the anchored one', async () => {
    const s = settingsFor(HOME)
    s.permissions.deny = s.permissions.deny.map((r) => (r === 'Read(~/**/.env)' ? 'Read(**/.env)' : r))
    await write(s)
    expect((await inspect(HOME)).problems.join(' ')).toContain('Read(~/**/.env)')
  })

  it('reports a missing identity-home rule in mode 2', async () => {
    const s = settingsFor(FOLDERS)
    s.permissions.deny = s.permissions.deny.filter((r) => r !== 'Read(//Users/ana/.agentbridge/**)')
    await write(s)
    expect((await inspect(FOLDERS)).problems.join(' ')).toContain('.agentbridge/**')
  })

  it('reports an additional directory the scope does not call for', async () => {
    const s = settingsFor(FOLDERS)
    s.permissions.additionalDirectories = [...s.permissions.additionalDirectories!, '/etc']
    await write(s)
    expect((await inspect(FOLDERS)).problems.join(' ')).toContain('/etc')
  })

  it('reports a required additional directory that is missing', async () => {
    const s = settingsFor(FOLDERS)
    s.permissions.additionalDirectories = ['/Users/ana/Proyectos']
    await write(s)
    expect((await inspect(FOLDERS)).problems.join(' ')).toContain('/Volumes/Datos/notas')
  })

  // D2's hazard, the reason setupResponder now always rewrites the file: someone switched from
  // mode 3 back to mode 1, and the old `additionalDirectories: [home]` stayed behind. The base
  // deny list is all there and the fence is on, so a check that only looked for what mode 1
  // needs would call this profile fine while the whole home is readable.
  it('reports a leftover home directory in a mode-1 profile', async () => {
    await write(settingsFor(HOME))
    const problems = (await inspect(FOLDER)).problems.join(' ')
    expect(problems).toContain(home)
  })

  it('reports any allow beyond the reply tool', async () => {
    const s = settingsFor(HOME)
    s.permissions.allow = [...s.permissions.allow, 'Bash']
    await write(s)
    expect((await inspect(HOME)).problems.join(' ')).toMatch(/permisos de más: Bash/)
  })

  // Pinned to mode 2's own sentence: with a looser /Windows/ this passed even with the mode-2
  // refusal removed, because the outside-the-home refusal fired instead and also says Windows.
  it('reports a mode-2 profile on Windows as a problem instead of throwing', async () => {
    await write(settingsFor(FOLDER))
    const scope: ResponderScope = { kind: 'folders', extra: ['C:\\Users\\ana\\Proyectos'] }
    const report = await inspectResponderSettings(dir, scope, {
      shareDir: 'C:\\Users\\ana\\compartido',
      identityHome: 'C:\\Users\\ana\\.agentbridge',
      home: 'C:\\Users\\ana',
      platform: 'win32',
    })
    expect(report.problems.join(' ')).toMatch(/varias carpetas/)
  })

  // A hand edit can put any JSON value where a list belongs; that used to crash the check with an
  // English `TypeError: deny.join is not a function`.
  for (const key of ['allow', 'deny', 'additionalDirectories'] as const) {
    it(`reports a permissions.${key} that is not a list, in Spanish, instead of throwing`, async () => {
      const s = settingsFor(HOME) as unknown as { permissions: Record<string, unknown> }
      s.permissions[key] = 'Bash'
      await write(s)
      const problems = (await inspect(HOME)).problems.join(' ')
      expect(problems).toContain(`permissions.${key} no es una lista`)
    })
  }

  it('reports a list holding something other than text', async () => {
    const s = settingsFor(HOME) as unknown as { permissions: Record<string, unknown> }
    s.permissions.deny = [...(s.permissions.deny as string[]), 7]
    await write(s)
    expect((await inspect(HOME)).problems.join(' ')).toContain('permissions.deny no es una lista')
  })

  it('reports a folder name with a glob character as a problem instead of throwing', async () => {
    const scope: ResponderScope = { kind: 'folders', extra: ['/Users/ana/proj[1]'] }
    await write(settingsFor(FOLDER))
    expect((await inspectResponderSettings(dir, scope, paths)).problems.join(' ')).toMatch(/comodín/)
  })
})
