import { EventEmitter } from 'events'
import type {
  BrowserTarget,
  CdpLease,
  Unsubscribe,
} from '../browser/contracts'

const COLLECTION_INTERVAL = 5000 // 5 seconds

/** Periodically collects browser storage through its own shared CDP lease. */
export class StorageCollector extends EventEmitter {
  private target: BrowserTarget | null = null
  private lease: CdpLease | null = null
  private sessionId: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private collectionInFlight: Promise<void> | null = null
  private unsubscribeDisconnect: Unsubscribe | null = null
  private stopPromise: Promise<void> | null = null
  private stopping = false

  async start(sessionId: string, target: BrowserTarget): Promise<void> {
    if (this.lease || this.stopPromise) await this.stop()
    if (target.isClosed()) throw new Error('Cannot collect storage from a closed browser target')

    const transport = await target.getCdpTransport()
    const lease = await transport.acquire(`capture:storage:${sessionId}:${target.tabId}`)
    this.stopping = false
    this.sessionId = sessionId
    this.target = target
    this.lease = lease
    try {
      this.unsubscribeDisconnect = lease.onDisconnect(() => {
        if (this.lease !== lease) return
        if (this.timer) clearInterval(this.timer)
        this.timer = null
        void this.stop().catch(error => {
          console.warn('[StorageCollector] Failed to release disconnected lease:', (error as Error).message)
        })
      })

      await this.collectAll()
      if (this.lease !== lease || lease.released || !lease.connected || this.stopping) return
      this.timer = setInterval(() => { void this.collectAll() }, COLLECTION_INTERVAL)
    } catch (error) {
      this.unsubscribeDisconnect?.()
      this.unsubscribeDisconnect = null
      if (!lease.released) await lease.release().catch(() => undefined)
      if (this.lease === lease) this.resetState()
      throw error
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    const lease = this.lease
    if (!lease) {
      this.resetState()
      return
    }
    this.stopping = true
    this.stopPromise = this.stopLease(lease)
    try {
      await this.stopPromise
    } finally {
      this.stopPromise = null
    }
  }

  triggerCollection(): void {
    if (!this.stopping) void this.collectAll()
  }

  private async stopLease(lease: CdpLease): Promise<void> {
    try {
      if (this.timer) clearInterval(this.timer)
      this.timer = null
      if (this.collectionInFlight) await this.collectionInFlight
      if (this.lease === lease && lease.connected && !lease.released) {
        await this.collectAll(true)
      }
      this.unsubscribeDisconnect?.()
      this.unsubscribeDisconnect = null
      if (!lease.released) await lease.release()
    } finally {
      if (this.lease === lease) this.resetState()
    }
  }

  private resetState(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.unsubscribeDisconnect?.()
    this.unsubscribeDisconnect = null
    this.collectionInFlight = null
    this.target = null
    this.lease = null
    this.sessionId = null
    this.stopping = false
  }

  private async collectAll(force = false): Promise<void> {
    if (this.collectionInFlight) return this.collectionInFlight
    if (this.stopping && !force) return
    const target = this.target
    const lease = this.lease
    const sessionId = this.sessionId
    if (!target || !lease || !sessionId || target.isClosed() || !lease.connected) return

    const domain = this.getCurrentDomain(target)
    const timestamp = Date.now()
    this.collectionInFlight = Promise.allSettled([
      this.collectCookies(target, lease, domain, timestamp),
      this.collectLocalStorage(lease, domain, timestamp),
      this.collectSessionStorage(lease, domain, timestamp)
    ]).then(() => undefined)
    try {
      await this.collectionInFlight
    } finally {
      this.collectionInFlight = null
    }
  }

  private async collectCookies(
    target: BrowserTarget,
    lease: CdpLease,
    domain: string,
    timestamp: number
  ): Promise<void> {
    try {
      const result = await lease.send<{ cookies?: Array<Record<string, unknown>> }>(
        'Network.getCookies',
        { urls: [target.url] }
      )
      this.emit('storage-collected', {
        domain,
        storageType: 'cookie',
        data: JSON.stringify(result.cookies || []),
        timestamp,
      })
    } catch (err) {
      console.warn('[StorageCollector] collectCookies failed:', (err as Error).message)
    }
  }

  private async collectLocalStorage(
    lease: CdpLease,
    domain: string,
    timestamp: number
  ): Promise<void> {
    try {
      const result = await lease.send<{ result?: { value?: string } }>('Runtime.evaluate', {
        expression: 'JSON.stringify(localStorage)',
        returnByValue: true,
      })
      this.emit('storage-collected', {
        domain,
        storageType: 'localStorage',
        data: result.result?.value || '{}',
        timestamp,
      })
    } catch (err) {
      console.warn('[StorageCollector] collectLocalStorage failed:', (err as Error).message)
    }
  }

  private async collectSessionStorage(
    lease: CdpLease,
    domain: string,
    timestamp: number
  ): Promise<void> {
    try {
      const result = await lease.send<{ result?: { value?: string } }>('Runtime.evaluate', {
        expression: 'JSON.stringify(sessionStorage)',
        returnByValue: true,
      })
      this.emit('storage-collected', {
        domain,
        storageType: 'sessionStorage',
        data: result.result?.value || '{}',
        timestamp,
      })
    } catch (err) {
      console.warn('[StorageCollector] collectSessionStorage failed:', (err as Error).message)
    }
  }

  private getCurrentDomain(target: BrowserTarget): string {
    try { return new URL(target.url).hostname || 'unknown' } catch { return 'unknown' }
  }
}
