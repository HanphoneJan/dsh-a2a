/**
 * The `/a2a` command surface: status, server enable/disable, card, agents,
 * and task control — the P0 operations surface (the settings panel is P1).
 * @module dsh-a2a/commands
 */

import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { A2AServiceImpl } from './service.ts'

/** Build the `/a2a` command definition over the service facade. */
export function buildA2aCommand(impl: A2AServiceImpl): CommandDefinition {
  return {
    name: 'a2a',
    description: 'Manage the A2A plugin: status, server, agents, tasks, card.',
    handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
      const [verb, ...rest] = invocation.rawInput.trim().split(/\s+/)
      switch (verb ?? '') {
        case '': {
          const status = impl.status() as { server?: unknown; client?: unknown }
          return success(`A2A status\n${JSON.stringify(status, null, 2)}`)
        }
        case 'status':
          return success(JSON.stringify(impl.status(), null, 2))
        case 'enable':
          return outcome(await impl.enableServer(true))
        case 'disable':
          return outcome(await impl.enableServer(false))
        case 'card':
          return success(JSON.stringify(impl.listTasks(), null, 2).slice(0, 4000))
        case 'agents':
          return success(JSON.stringify(impl.agents(), null, 2))
        case 'agent': {
          const [action, ...args] = rest
          switch (action ?? '') {
            case 'add': {
              const url = args[0]
              if (!url) return error('usage: /a2a agent add <agentCardUrl> [name]')
              const name = args[1] ?? url
              return outcome(await impl.addAgent({ name, agentCardUrl: url }))
            }
            case 'remove': {
              const id = args[0]
              if (!id) return error('usage: /a2a agent remove <id>')
              return outcome(await impl.removeAgent(id))
            }
            case 'enable': {
              const id = args[0]
              if (!id) return error('usage: /a2a agent enable <id>')
              return outcome(await impl.setAgentEnabled(id, true))
            }
            case 'disable': {
              const id = args[0]
              if (!id) return error('usage: /a2a agent disable <id>')
              return outcome(await impl.setAgentEnabled(id, false))
            }
            case 'refresh': {
              const id = args[0]
              if (!id) return error('usage: /a2a agent refresh <id>')
              return outcome(await impl.refreshAgentCard(id))
            }
            default:
              return error('usage: /a2a agent add|remove|enable|disable|refresh ...')
          }
        }
        case 'tasks':
          return success(JSON.stringify(impl.listTasks(), null, 2))
        case 'task': {
          const [action, id] = rest
          if (action === 'get' && id) return success(JSON.stringify(impl.getTask(id), null, 2))
          if (action === 'cancel' && id) return outcome(await impl.cancelTask(id))
          return error('usage: /a2a task get|cancel <taskId>')
        }
        case 'help':
          return success('a2a commands: status | enable | disable | card | agents | agent add/remove/enable/disable/refresh | tasks | task get/cancel <id> | help')
        default:
          return error(`unknown a2a verb "${verb}" (try /a2a help)`)
      }
    },
  }
}

function success(text: string): CommandResult {
  return { kind: 'success', text }
}

function error(text: string): CommandResult {
  return { kind: 'error', text }
}

function outcome(result: { readonly ok: boolean; readonly message: string }): CommandResult {
  return result.ok ? success(result.message) : error(result.message)
}