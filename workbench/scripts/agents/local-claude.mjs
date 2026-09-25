import { accessSync, constants, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

// Without --claude, the Claude Code already installed on this machine is used: on PATH, in its usual install
// locations, or bundled with the VS Code extension (newest version first, since the path changes on every update).
// It keeps its own login and ~/.claude/settings.json, so no key has to be stored in the Control Plane.
export function localClaude() {
  const home = homedir()
  const candidates = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map((directory) => join(directory, 'claude')), join(home, '.local/bin/claude'), join(home, '.claude/local/claude')]
  for (const editor of ['.vscode', '.vscode-insiders', '.cursor']) {
    const extensions = join(home, editor, 'extensions')
    let names = []
    try { names = readdirSync(extensions).filter((name) => name.startsWith('anthropic.claude-code-')) } catch { continue }
    names.sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
    candidates.push(...names.map((name) => join(extensions, name, 'resources/native-binary/claude')))
  }
  return candidates.find((path) => { try { accessSync(path, constants.X_OK); return true } catch { return false } })
}
