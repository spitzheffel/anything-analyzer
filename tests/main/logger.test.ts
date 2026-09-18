import { afterEach, describe, expect, it, vi } from 'vitest'

const logging = vi.hoisted(() => ({
  initialize: vi.fn(),
  info: vi.fn(),
  functions: { warn: vi.fn(), error: vi.fn() },
  hooks: [] as Array<(message: { data: unknown[] }) => { data: unknown[] }>,
  transports: { file: {}, console: {} },
}))

vi.mock('electron-log/main', () => ({ default: logging }))
vi.mock('electron', () => ({
  app: { getPath: () => 'test-user-data', getVersion: () => 'test' },
}))

import { initLogger } from '../../src/main/logger'

const originalConsole = { warn: console.warn, error: console.error }

afterEach(() => {
  Object.assign(console, originalConsole)
  logging.hooks.length = 0
  vi.clearAllMocks()
})

describe('main-process logging', () => {
  it('routes console warnings to electron-log and preserves redacted error causes', () => {
    initLogger()
    const cause = new Error('Execution context destroyed; token=private-value')
    const failure = new Error('Failed to attach binding', { cause })
    console.warn('binding failed', failure)
    console.error('body failed', cause)

    expect(logging.functions.warn).toHaveBeenCalledWith('binding failed', failure)
    expect(logging.functions.error).toHaveBeenCalledWith('body failed', cause)
    const sanitized = logging.hooks[0]({ data: [failure] })
    expect(sanitized.data[0]).toMatchObject({
      message: 'Failed to attach binding',
      cause: { message: 'Execution context destroyed; token=[REDACTED]' },
    })
    expect(JSON.stringify(sanitized)).not.toContain('private-value')
  })

  it('does not recurse forever on circular error causes', () => {
    initLogger()
    const failure = new Error('circular')
    failure.cause = failure
    expect(logging.hooks[0]({ data: [failure] }).data[0]).toMatchObject({
      cause: '[Circular]',
    })
  })
})
