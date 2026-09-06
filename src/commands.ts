/**
 * The `/a2a` command surface: status, inbound/outbound server CRUD +
 * enable/disable, and task control — a text backup to the GUI (the settings
 * panel is the primary surface). All operations delegate to the same
 * `A2AServiceImpl` facade as the dashboard API.
 * @module dsh-a2a/commands
 */

import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { A2AServiceImpl } from './service.ts'

/** Build the `/a2a` command definition over the service facade. */
export function buildA2aCommand(impl: A2AServiceImpl): CommandDefinition {
  return {
    name: 'a2a',
    description: 'Manage the A2A plugin: status, inbound/outbound servers, tasks.',
    handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
      const [verb, ...rest] = invocation.rawInput.trim().split(/\s+/)
      switch (verb ?? '') {
        case '':
        case 'status':
          return success(JSON.stringify(impl.status(), null, 2))
        case 'presets':
          return success(JSON.stringify(await impl.presets(), null, 2))
        case 'inbound': {
          const [action, id, ...args] = rest
          switch (action ?? '') {
            case 'list':
              return success(JSON.stringify(impl.listInboundServers(), null, 2))
            case 'create': {
              const name = args[0]
              if (!name) return error('usage: /a2a inbound create <name> [preset] [description]')
              const preset = args[1]
              return outcome(await impl.createInboundServer({
                name,
                description: args[2] ?? 'An A2A inbound server',
                version: '1.0.0',
                ...(preset && preset !== 'default' ? { preset } : {}),
              }))
            }
            case 'remove':
              return id ? outcome(await impl.removeInboundServer(id)) : error('usage: /a2a inbound remove <id>')
            case 'enable':
              return id ? outcome(await impl.setInboundServerEnabled(id, true)) : error('usage: /a2a inbound enable <id>')
            case 'disable':
              return id ? outcome(await impl.setInboundServerEnabled(id, false)) : error('usage: /a2a inbound disable <id>')
            default:
              return error('usage: /a2a inbound list|create|remove|enable|disable ...')
          }
        }
        case 'outbound': {
          const [action, id, ...args] = rest
          switch (action ?? '') {
            case 'list':
              return success(JSON.stringify(impl.listOutboundServers(), null, 2))
            case 'create': {
              const url = args[0]
              if (!url) return error('usage: /a2a outbound create <agentCardUrl> [name] [preset]')
              const name = args[1] ?? url
              const preset = args[2]
              return outcome(await impl.createOutboundServer({
                name,
                agentCardUrl: url,
                ...(preset && preset !== 'default' ? { preset } : {}),
              }))
            }
            case 'remove':
              return id ? outcome(await impl.removeOutboundServer(id)) : error('usage: /a2a outbound remove <id>')
            case 'enable':
              return id ? outcome(await impl.setOutboundServerEnabled(id, true)) : error('usage: /a2a outbound enable <id>')
            case 'disable':
              return id ? outcome(await impl.setOutboundServerEnabled(id, false)) : error('usage: /a2a outbound disable <id>')
            case 'refresh':
              return id ? outcome(await impl.refreshOutboundServer(id)) : error('usage: /a2a outbound refresh <id>')
            default:
              return error('usage: /a2a outbound list|create|remove|enable|disable|refresh ...')
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
        case 'peers':
          return success(JSON.stringify(impl.inbounds(), null, 2))
        case 'help':
          return success('a2a: status | presets | inbound list/create/remove/enable/disable | outbound list/create/remove/enable/disable/refresh | tasks | task get/cancel <id> | peers | help')
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
