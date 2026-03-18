import { Command } from 'commander'
import { initCommand } from './init.js'
import { indexCommand } from './index-cmd.js'
import { searchCommand } from './search.js'
import { serveCommand } from './serve.js'
import { statsCommand } from './stats.js'
import { graphCommand } from './graph.js'
import { conventionsCommand } from './conventions.js'
import { mcpCommand } from './mcp.js'
import { doctorCommand } from './doctor.js'
import { explainCommand } from './explain.js'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

function loadVersion(): string {
  try {
    return require('../../package.json').version
  } catch {
    try {
      return require('../package.json').version
    } catch {
      return '0.2.1'
    }
  }
}

const version = loadVersion()

export function createCLI(): Command {
  const program = new Command()

  program
    .name('reporecall')
    .description('Reporecall — local codebase memory for Claude Code and MCP')
    .version(version)

  program.addCommand(initCommand())
  program.addCommand(indexCommand())
  program.addCommand(searchCommand())
  program.addCommand(serveCommand())
  program.addCommand(statsCommand())
  program.addCommand(graphCommand())
  program.addCommand(conventionsCommand())
  program.addCommand(mcpCommand())
  program.addCommand(doctorCommand())
  program.addCommand(explainCommand())

  return program
}
