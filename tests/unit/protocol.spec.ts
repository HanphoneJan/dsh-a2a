/**
 * Protocol layer unit tests: task-state machine, parts-to-text projection,
 * and the canonical method/error-code constants.
 * @module dsh-a2a/tests/unit/protocol.spec
 */

import { describe, expect, it } from 'vitest'
import {
  A2A_ERROR_CODES,
  A2A_METHODS,
  TaskState,
  isTerminal,
  partsToText,
} from '../../src/protocol.ts'

describe('TaskState machine', () => {
  it('settles only terminal states', () => {
    expect(isTerminal(TaskState.SUBMITTED)).toBe(false)
    expect(isTerminal(TaskState.WORKING)).toBe(false)
    expect(isTerminal(TaskState.INPUT_REQUIRED)).toBe(false)
    expect(isTerminal(TaskState.COMPLETED)).toBe(true)
    expect(isTerminal(TaskState.FAILED)).toBe(true)
    expect(isTerminal(TaskState.CANCELED)).toBe(true)
    expect(isTerminal(TaskState.REJECTED)).toBe(true)
  })
})

describe('partsToText', () => {
  it('joins text parts with newlines', () => {
    expect(partsToText([{ text: 'a' }, { text: 'b' }])).toBe('a\nb')
  })

  it('renders data parts as JSON and file parts from uri or a placeholder', () => {
    expect(partsToText([{ data: { n: 1 } }])).toBe('{"n":1}')
    expect(partsToText([{ file: { uri: 'https://x/y.png' } }])).toBe('https://x/y.png')
    expect(partsToText([{ file: { name: 'blob' } }])).toBe('[file blob]')
  })

  it('returns the empty string for undefined or empty input', () => {
    expect(partsToText(undefined)).toBe('')
    expect(partsToText([])).toBe('')
  })
})

describe('protocol constants', () => {
  it('exposes the full A2A v1.0 method surface', () => {
    expect(A2A_METHODS).toMatchObject({
      sendMessage: 'SendMessage',
      sendStreamingMessage: 'SendStreamingMessage',
      getTask: 'GetTask',
      listTasks: 'ListTasks',
      cancelTask: 'CancelTask',
      subscribeToTask: 'SubscribeToTask',
      getExtendedAgentCard: 'GetExtendedAgentCard',
    })
  })

  it('keeps the reserved JSON-RPC 2.0 error codes distinct from A2A codes', () => {
    expect(A2A_ERROR_CODES.INVALID_REQUEST).toBe(-32600)
    expect(A2A_ERROR_CODES.UNAUTHORIZED).toBe(-32000)
    expect(A2A_ERROR_CODES.TASK_NOT_FOUND).toBe(-32001)
  })
})
