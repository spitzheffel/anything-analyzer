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
  private domStorageEnabled = false

  async start(sessionId: string, target: BrowserTarget): Promise<void> {
    if (this.lease || this.stopPromise) await this.stop()
    if (target.isClosed()) throw new Error('Cannot collect storage from a closed browser target')

    const transport = await target.getCdpTransport()
    const lease = await transport.acquire(`capture:storage:${sessionId}:${target.tabId}`)
    this.stopping = false
    this.sessionId = sessionId
    this.target = target
    this.lease = lease
    this.domStorageEnabled = false
    try {
      this.unsubscribeDisconnect = lease.onDisconnect(() => {
        if (this.lease !== lease) return
        if (this.timer) clearInterval(this.timer)
        this.timer = null
        void this.stop().catch(error => {
          console.warn('[StorageCollector] Failed to release disconnected lease:', (error as Error).message)
        })
      })

      // Prefer reading DOM storage over the CDP DOMStorage domain (browser-side,
      // no page script execution). page.evaluate would inject observable script
      // into the page context, which anti-bot systems flag.
      try {
        await lease.send('DOMStorage.enable')
        this.domStorageEnabled = true
      } catch {
        this.domStorageEnabled = false
      }

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
        if (this.domStorageEnabled) {
          await lease.send('DOMStorage.disable').catch(() => undefined)
        }
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
    this.domStorageEnabled = false
  }

  private async collectAll(force = false): Promise<void> {
    if (this.collectionInFlight) return this.collectionInFlight
    if (this.stopping && !force) return
    const target = this.target
    const lease = this.lease
    const sessionId = this.sessionId
    if (!target || !lease || !sessionId || target.isClosed() || !lease.connected) return

    const domain = this.getCurrentDomain(target)
    const origin = this.getCurrentOrigin(target)
    const timestamp = Date.now()
    this.collectionInFlight = Promise.allSettled([
      this.collectCookies(target, lease, domain, timestamp),
      this.collectDomStorage(lease, domain, origin, timestamp, true),
      this.collectDomStorage(lease, domain, origin, timestamp, false)
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

  private async collectDomStorage(
    lease: CdpLease,
    domain: string,
    origin: string | null,
    timestamp: number,
    isLocalStorage: boolean
  ): Promise<void> {
    const storageType = isLocalStorage ? 'localStorage' : 'sessionStorage'
    // Preferred path: read the storage area straight from the browser process,
    // so nothing is injected into the page. Needs a real (non-null) origin.
    if (this.domStorageEnabled && origin) {
      try {
        const result = await lease.send<{ entries?: Array<[string, string]> }>(
          'DOMStorage.getDOMStorageItems',
          { storageId: { securityOrigin: origin, isLocalStorage } }
        )
        const data: Record<string, string> = {}
        for (const entry of result.entries ?? []) {
          if (Array.isArray(entry) && typeof entry[0] === 'string') {
            data[entry[0]] = typeof entry[1] === 'string' ? entry[1] : ''
          }
        }
        this.emit('storage-collected', {
          domain,
          storageType,
          data: JSON.stringify(data),
          timestamp,
        })
        return
      } catch (err) {
        // Fall through to the page-script fallback below (e.g. opaque origin).
        console.warn(`[StorageCollector] DOMStorage read (${storageType}) failed:`, (err as Error).message)
      }
    }

    // Fallback: only used when the DOMStorage domain is unavailable or the
    // origin is opaque. Still functional, but visible to the page.
    try {
      const expression = isLocalStorage
        ? 'JSON.stringify(localStorage)'
        : 'JSON.stringify(sessionStorage)'
      const result = await lease.send<{ result?: { value?: string } }>('Runtime.evaluate', {
        expression,
        returnByValue: true,
      })
      this.emit('storage-collected', {
        domain,
        storageType,
        data: result.result?.value || '{}',
        timestamp,
      })
    } catch (err) {
      console.warn(`[StorageCollector] collect ${storageType} failed:`, (err as Error).message)
    }
  }

  private getCurrentDomain(target: BrowserTarget): string {
    try { return new URL(target.url).hostname || 'unknown' } catch { return 'unknown' }
  }

  private getCurrentOrigin(target: BrowserTarget): string | null {
    try {
      const origin = new URL(target.url).origin
      return origin && origin !== 'null' ? origin : null
    } catch {
      return null
    }
  }
}
