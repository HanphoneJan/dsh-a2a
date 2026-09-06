/**
 * Protocol layer unit tests: task-state machine, parts-to-text projection,
 * and the canonical method/error-code constants (A2A v1.0.1).
 * @module dsh-a2a/tests/unit/protocol.spec
 */

import { describe, expect, it } from 'vitest'
import {
  A2A_ERROR_CODES,
  A2A_METHODS,
  PROTOCOL_VERSION,
  Role,
  TaskState,
  isTerminal,
  partsToText,
} from '../../src/protocol.ts'

describe('TaskState machine (JSON = SCREAMING_SNAKE_CASE per ADR-001)', () => {
  it('serializes states with the TASK_STATE_ prefix', () => {
    expect(TaskState.COMPLETED).toBe('TASK_STATE_COMPLETED')
    expect(TaskState.FAILED).toBe('TASK_STATE_FAILED')
    expect(TaskState.SUBMITTED).toBe('TASK_STATE_SUBMITTED')
  })

  it('settles only terminal states', () => {
    expect(isTerminal(TaskState.SUBMITTED)).toBe(false)
    expect(isTerminal(TaskState.WORKING)).toBe(false)
    expect(isTerminal(TaskState.INPUT_REQUIRED)).toBe(false)
    expect(isTerminal(TaskState.COMPLETED)).toBe(true)
    expect(isTerminal(TaskState.FAILED)).toBe(true)
    expect(isTerminal(TaskState.CANCELED)).toBe(true)
    expect(isTerminal(TaskState.REJECTED)).toBe(true)
  })

  it('serializes roles with the ROLE_ prefix', () => {
    expect(Role.USER).toBe('ROLE_USER')
    expect(Role.AGENT).toBe('ROLE_AGENT')
  })
})

describe('partsToText', () => {
  it('joins text parts with newlines', () => {
    expect(partsToText([{ text: 'a' }, { text: 'b' }])).toBe('a\nb')
  })

  it('renders data parts as JSON and file parts from url or a placeholder', () => {
    expect(partsToText([{ data: { n: 1 } }])).toBe('{"n":1}')
    expect(partsToText([{ url: 'https://x/y.png' }])).toBe('https://x/y.png')
    expect(partsToText([{ filename: 'blob' }])).toBe('[file blob]')
  })

  it('returns the empty string for undefined or empty input', () => {
    expect(partsToText(undefined)).toBe('')
    expect(partsToText([])).toBe('')
  })
})

describe('protocol constants', () => {
  it('implements A2A protocol version 1.0', () => {
    expect(PROTOCOL_VERSION).toBe('1.0')
  })

  it('exposes the full A2A v1.0.1 JSON-RPC method surface', () => {
    expect(A2A_METHODS).toMatchObject({
      sendMessage: 'SendMessage',
      sendStreamingMessage: 'SendStreamingMessage',
      getTask: 'GetTask',
      listTasks: 'ListTasks',
      cancelTask: 'CancelTask',
      subscribeToTask: 'SubscribeToTask',
      createTaskPushNotificationConfig: 'CreateTaskPushNotificationConfig',
      getTaskPushNotificationConfig: 'GetTaskPushNotificationConfig',
      listTaskPushNotificationConfigs: 'ListTaskPushNotificationConfigs',
      deleteTaskPushNotificationConfig: 'DeleteTaskPushNotificationConfig',
      getExtendedAgentCard: 'GetExtendedAgentCard',
    })
  })

  it('keeps the JSON-RPC 2.0 reserved codes distinct from A2A codes', () => {
    expect(A2A_ERROR_CODES.INVALID_REQUEST).toBe(-32600)
    expect(A2A_ERROR_CODES.TASK_NOT_FOUND).toBe(-32001)
    expect(A2A_ERROR_CODES.PUSH_NOTIFICATION_NOT_SUPPORTED).toBe(-32003)
    expect(A2A_ERROR_CODES.VERSION_NOT_SUPPORTED).toBe(-32007)
  })
})