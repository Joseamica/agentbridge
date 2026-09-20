// The name AgentBridge is published under on npm (scripts/pack.mjs sets it; a test pins the two
// together). Every command this codebase registers with Claude Code or prints for a person to
// run goes through these. A hand-typed copy is how 0.1.0 shipped `npx -y agentbridge@latest`:
// a name that is not ours, so the MCP server never started and anyone could have claimed it.
export const PUBLISHED_PACKAGE = '@joseamica/agentbridge'

// People run AgentBridge through npx, so no `agentbridge` binary is on their PATH: a printed
// `agentbridge doctor` is a step they cannot actually run.
export const CLI_ARGV = ['npx', '-y', `${PUBLISHED_PACKAGE}@latest`] as const
export const CLI_COMMAND = CLI_ARGV.join(' ')
