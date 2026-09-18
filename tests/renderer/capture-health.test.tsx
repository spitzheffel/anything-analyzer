import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CaptureHealthSnapshot } from '../../src/shared/capture-protocol'
import CaptureHealthPanel from '../../src/renderer/components/CaptureHealthPanel'
import StatusBar from '../../src/renderer/components/StatusBar'
import { reconcileCaptureHealth } from '../../src/renderer/hooks/useCapture'
import { LocaleProvider } from '../../src/renderer/i18n'

function createHealth(overrides: Partial<CaptureHealthSnapshot> = {}): CaptureHealthSnapshot {
  return {
    sessionId: 'session-current',
    runId: 'run-current',
    revision: 4,
    state: 'healthy',
    network: 'running',
    workerCoverage: 'unknown',
    realms: [],
    gaps: [],
    persistenceError: null,
    ...overrides,
  }
}

const historicalGap = {
  runId: 'run-current',
  realmId: 'worker-first',
  startedAt: 1,
  endedAt: 2,
  reason: 'producer-overflow',
  certainty: 'known-loss' as const,
  droppedEvents: 5,
}

describe('capture health reconciliation', () => {
  it('rejects another session and older or duplicate revisions within a run', () => {
    const current = createHealth()
    expect(reconcileCaptureHealth(current, createHealth({ sessionId: 'session-other', revision: 99 }), current.sessionId)).toBe(current)
    expect(reconcileCaptureHealth(current, createHealth({ revision: 3, state: 'degraded' }), current.sessionId)).toBe(current)
    expect(reconcileCaptureHealth(current, createHealth({ revision: 4, state: 'degraded' }), current.sessionId)).toBe(current)
  })

  it('accepts a new run whose revision restarted but rejects callbacks from retired runs', () => {
    const previous = createHealth({ gaps: [historicalGap] })
    const next = reconcileCaptureHealth(previous, createHealth({ runId: 'run-next', revision: 1 }), previous.sessionId)
    expect(next?.runId).toBe('run-next')
    expect(next?.gaps).toEqual([historicalGap])
    expect(reconcileCaptureHealth(next, createHealth({ revision: 100 }), previous.sessionId, new Set(['run-current']))).toBe(next)
  })

  it('retains historical loss after recovery and never reopens a closed gap from an incomplete snapshot', () => {
    const previous = createHealth({ state: 'degraded', gaps: [historicalGap] })
    const recovered = reconcileCaptureHealth(previous, createHealth({ revision: 5 }), previous.sessionId)
    expect(recovered?.state).toBe('healthy')
    expect(recovered?.gaps).toEqual([historicalGap])
    const incomplete = reconcileCaptureHealth(recovered, createHealth({ revision: 6, gaps: [{ ...historicalGap, endedAt: null, droppedEvents: null }] }), previous.sessionId)
    expect(incomplete?.gaps).toEqual([historicalGap])
  })

  it('does not downgrade a current run to a legacy no-run snapshot', () => {
    const current = createHealth()
    expect(reconcileCaptureHealth(current, createHealth({ runId: null, revision: 100, state: 'unknown' }), current.sessionId)).toBe(current)
  })
})

describe('capture health presentation', () => {
  it('uses the Chinese locale for coverage warnings and diagnostics actions', () => {
    const markup = renderToStaticMarkup(
      <LocaleProvider locale="zh">
        <CaptureHealthPanel sessionId="session-current" captureHealth={createHealth({ workerCoverage: 'unavailable' })} />
      </LocaleProvider>,
    )
    expect(markup).toContain('\u6293\u53d6\u5065\u5eb7')
    expect(markup).toContain('\u5f53\u524d\u5065\u5eb7\u4e0d\u4ee3\u8868\u5386\u53f2\u65e0\u4e22\u5931')
    expect(markup).toContain('Worker \u63d2\u6869\u4e0d\u53ef\u7528')
    expect(markup).toContain('\u5bfc\u51fa\u8bca\u65ad JSON')
  })

  it('shows missing historical health as unknown instead of healthy', () => {
    const markup = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <CaptureHealthPanel sessionId="session-current" />
      </LocaleProvider>,
    )
    expect(markup).toContain('Deep: Unknown')
    expect(markup).toContain('historical coverage is unknown, not healthy')
    expect(markup).toContain('early Worker coverage is not verified')
    expect(markup).not.toContain('Deep: Healthy now')
  })

  it('shows independent network and Deep health with retained historical gaps', () => {
    const markup = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <StatusBar status="running" requestCount={3} hookCount={2} captureHealth={createHealth({ state: 'degraded', gaps: [historicalGap] })} />
      </LocaleProvider>,
    )
    expect(markup).toContain('Network')
    expect(markup).toContain('Degraded')
    expect(markup).toContain('Historical gaps')
    expect(markup).toContain('does not mean no historical loss')
  })

  it('renders Worker unavailability, installation, transport, pending records, reasons and certainty counts', () => {
    const health = createHealth({
      workerCoverage: 'unavailable',
      gaps: [historicalGap],
      realms: [{
        realmId: 'worker-first',
        kind: 'worker',
        targetId: 'target-worker',
        frameId: null,
        tabId: null,
        earlyInjection: false,
        runId: 'run-current',
        producerId: 'producer-worker',
        state: 'degraded',
        transport: 'poll',
        installed: { fetch: 'installed', crypto: 'failed' },
        pendingEvents: 3,
        pendingBytes: 64,
        droppedEvents: 5,
        lastConfirmedAt: null,
        reason: 'poll-timeout',
      }],
    })
    const markup = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <CaptureHealthPanel sessionId={health.sessionId} captureHealth={health} />
      </LocaleProvider>,
    )
    expect(markup).toContain('Worker instrumentation is not available')
    expect(markup).toContain('worker: worker-first')
    expect(markup).toContain('fetch: installed, crypto: failed')
    expect(markup).toContain('Transport: poll')
    expect(markup).toContain('Pending: 3 events / 64 bytes')
    expect(markup).toContain('Never confirmed')
    expect(markup).toContain('poll-timeout')
    expect(markup).toContain('Known loss: 1')
    expect(markup).toContain('Delivery delay (not confirmed loss): 0')
    expect(markup).toContain('Current health does not prove that no historical data was lost')
  })

  it('does not display a previous session snapshot in the next session panel', () => {
    const markup = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <CaptureHealthPanel sessionId="session-other" captureHealth={createHealth({ gaps: [historicalGap] })} />
      </LocaleProvider>,
    )
    expect(markup).toContain('Deep: Unknown')
    expect(markup).not.toContain('producer-overflow')
  })
})
