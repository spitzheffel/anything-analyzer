import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createContext, runInContext, type Context } from 'node:vm'
import { transpileModule, ScriptTarget, ModuleKind } from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type CaptureStream = 'hook' | 'interaction' | 'control'
type Payload = Record<string, unknown>

function compileHook(filename: string): string {
  const source = readFileSync(resolve(__dirname, '../../../src/preload', filename), 'utf8')
  return transpileModule(source, {
    compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.None },
  }).outputText
}

const hookScript = compileHook('hook-script.ts')
const interactionScript = compileHook('interaction-hook.ts')

function createCaptureHarness() {
  let recording = true
  let runId = 'run-1'
  const messages: Array<{ stream: CaptureStream; payload: Payload }> = []
  const hooks = new Map<string, { readInstalled: () => boolean; applicable: boolean }>()
  const flushCallbacks: Array<() => void> = []
  const bridge = {
    get recording() { return recording },
    get runId() { return runId },
    enqueue: vi.fn((stream: CaptureStream, payload: Payload) => {
      messages.push({ stream, payload })
    }),
    registerHook(name: string, readInstalled = () => false, applicable = true) {
      hooks.set(name, { readInstalled, applicable })
    },
    registerFlush(callback: () => void) {
      flushCallbacks.push(callback)
    },
  }
  return {
    bridge, messages, hooks, flushCallbacks,
    setRecording(value: boolean) { recording = value },
    setRunId(value: string) { runId = value },
    stop() {
      for (const callback of flushCallbacks) callback()
      recording = false
    },
  }
}

const workerFixture = `
  globalThis.self = globalThis;
  globalThis.fetchCalls = [];
  globalThis.fetchResponse = { status: 201, statusText: 'Created' };
  globalThis.fetch = function (...argumentsList) {
    fetchCalls.push({ receiver: this, argumentsList });
    globalThis.fetchPromise = Promise.resolve(fetchResponse);
    return fetchPromise;
  };
  class SyntheticSubtle {
    digest(...argumentsList) {
      if (this !== crypto.subtle) throw new TypeError('Invalid receiver');
      this.argumentsList = argumentsList;
      this.promise = Promise.resolve(new Uint8Array([10, 11]).buffer);
      return this.promise;
    }
    sign(...argumentsList) { return this.digest(...argumentsList); }
    encrypt(...argumentsList) { return this.digest(...argumentsList); }
    decrypt(...argumentsList) { return this.digest(...argumentsList); }
  }
  globalThis.crypto = { subtle: new SyntheticSubtle() };
  globalThis.btoa = function (value) { return 'encoded:' + value; };
  globalThis.atob = function (value) { return value.replace(/^encoded:/, ''); };
`

function createWorkerHarness(setup = '') {
  const capture = createCaptureHarness()
  const context = createContext({ __aaReliableCapture: capture.bridge })
  runInContext(workerFixture + setup, context)
  return { capture, context }
}

function installScripts(context: Context): void {
  runInContext(hookScript, context)
  runInContext(interactionScript, context)
}

function findHookPayloads(capture: ReturnType<typeof createCaptureHarness>, functionName: string): Payload[] {
  return capture.messages.filter(message => message.payload.functionName === functionName).map(message => message.payload)
}

describe('realm-safe function hooks', () => {
  it('does not relabel an old fetch settlement into a resumed capture epoch', async () => {
    const { capture, context } = createWorkerHarness(`
      globalThis.fetch = () => new Promise(resolve => { globalThis.settleFetch = resolve; });
    `)
    installScripts(context)
    const pending = runInContext(`fetch('/old-request')`, context)
    capture.stop()
    capture.setRunId('run-2')
    capture.setRecording(true)
    runInContext(`settleFetch({status:200,statusText:'OK'})`, context)
    await pending
    expect(findHookPayloads(capture, 'window.fetch')).toHaveLength(1)
    expect(findHookPayloads(capture, 'window.fetch.response')).toHaveLength(0)
  })

  it.each([
    { realmKind: 'DedicatedWorker', setup: `globalThis.postMessage = function () { throw new Error('Do not post'); };`, postMessageType: 'function' },
    { realmKind: 'SharedWorker', setup: 'globalThis.onconnect = null;', postMessageType: 'undefined' },
    { realmKind: 'ServiceWorker', setup: 'globalThis.clients = {};', postMessageType: 'undefined' },
  ])('enqueues directly in a synthetic $realmKind without DOM globals', async ({ setup, postMessageType }) => {
    const { capture, context } = createWorkerHarness(setup)
    expect(runInContext('[typeof window, typeof XMLHttpRequest, typeof Document]', context))
      .toEqual(['undefined', 'undefined', 'undefined'])
    expect(runInContext('typeof postMessage', context)).toBe(postMessageType)
    expect(() => installScripts(context)).not.toThrow()
    expect(capture.flushCallbacks).toHaveLength(0)

    const fetchResult = runInContext(`fetch.call(self, '/synthetic', { method: 'POST', body: 'body' })`, context)
    expect(fetchResult).toBe(runInContext('fetchPromise', context))
    expect(findHookPayloads(capture, 'window.fetch')).toHaveLength(1)
    expect(JSON.parse(findHookPayloads(capture, 'window.fetch')[0].arguments as string))
      .toEqual({ url: '/synthetic', method: 'POST', body: 'body' })
    await fetchResult
    expect(findHookPayloads(capture, 'window.fetch.response')[0].result).toBe('{"status":201,"statusText":"Created"}')
    expect(runInContext('fetchCalls[0].receiver === self', context)).toBe(true)

    const digestResult = runInContext(`
      globalThis.inputBytes = new Uint8Array([255, 1, 2, 254]);
      crypto.subtle.digest('SHA-256', inputBytes.subarray(1, 3));
    `, context)
    expect(digestResult).toBe(runInContext('crypto.subtle.promise', context))
    expect(JSON.parse(findHookPayloads(capture, 'crypto.subtle.digest')[0].arguments as string))
      .toEqual(['SHA-256', '0102'])
    expect(Array.from(new Uint8Array(await digestResult))).toEqual([10, 11])
    expect(findHookPayloads(capture, 'crypto.subtle.digest.result')[0].result).toBe('"0a0b"')

    expect(runInContext(`atob(btoa('plain'))`, context)).toBe('plain')
    expect(capture.messages.every(message => message.stream === 'hook' && message.payload.type === 'ar-hook')).toBe(true)
    for (const name of ['fetch', 'crypto.subtle.sign', 'crypto.subtle.digest', 'crypto.subtle.encrypt', 'crypto.subtle.decrypt', 'atob', 'btoa']) {
      expect(capture.hooks.get(name)?.readInstalled(), name).toBe(true)
    }
    for (const name of ['XMLHttpRequest.send', 'document.cookie.set']) {
      expect(capture.hooks.get(name)?.applicable, name).toBe(false)
      expect(capture.hooks.get(name)?.readInstalled(), name).toBe(false)
    }
  })

  it('survives a realm with none of the optional instrumented APIs', () => {
    const capture = createCaptureHarness()
    const context = createContext({ __aaReliableCapture: capture.bridge })
    expect(() => installScripts(context)).not.toThrow()
    expect([...capture.hooks.values()].every(hook => !hook.applicable && !hook.readInstalled())).toBe(true)
    expect(capture.messages).toEqual([])
  })

  it('reports locked hooks and detects later replacement of installed callables', async () => {
    const { capture, context } = createWorkerHarness(`
      Object.defineProperty(globalThis, 'fetch', { value: fetch, writable: false, configurable: false });
      Object.defineProperty(Object.getPrototypeOf(crypto.subtle), 'sign', { value: crypto.subtle.sign, writable: false, configurable: false });
    `)
    installScripts(context)
    expect(capture.hooks.get('fetch')?.applicable).toBe(true)
    expect(capture.hooks.get('fetch')?.readInstalled()).toBe(false)
    expect(capture.hooks.get('crypto.subtle.sign')?.readInstalled()).toBe(false)
    expect(capture.hooks.get('crypto.subtle.digest')?.readInstalled()).toBe(true)
    await runInContext(`crypto.subtle.digest('SHA-256', new Uint8Array([1]))`, context)
    runInContext(`crypto.subtle.digest = function () {}; atob = function () {};`, context)
    expect(capture.hooks.get('crypto.subtle.digest')?.readInstalled()).toBe(false)
    expect(capture.hooks.get('atob')?.readInstalled()).toBe(false)
    expect(capture.hooks.get('btoa')?.readInstalled()).toBe(true)
  })

  it('continues installing other hooks when a feature getter throws', () => {
    const { capture, context } = createWorkerHarness(`
      Object.defineProperty(globalThis, 'crypto', { get() { throw new Error('Unavailable'); } });
    `)
    expect(() => installScripts(context)).not.toThrow()
    expect(capture.hooks.get('fetch')?.readInstalled()).toBe(true)
    expect(capture.hooks.get('atob')?.readInstalled()).toBe(true)
    expect(runInContext(`btoa('plain')`, context)).toBe('encoded:plain')
  })

  it('checks recording before touching arguments or serializing them', async () => {
    const { capture, context } = createWorkerHarness(`
      globalThis.serializationCalls = 0;
      globalThis.body = { toString() { serializationCalls++; throw new Error('Do not inspect'); } };
      globalThis.algorithm = { toJSON() { serializationCalls++; throw new Error('Do not inspect'); } };
    `)
    installScripts(context)
    capture.setRecording(false)
    await runInContext(`fetch('/synthetic', { body })`, context)
    await runInContext(`crypto.subtle.digest(algorithm, new Uint8Array([1]))`, context)
    runInContext('btoa(algorithm)', context)
    expect(runInContext('serializationCalls', context)).toBe(0)
    expect(capture.messages).toEqual([])
  })

  it('does not let argument or response serialization failures change the calls', async () => {
    const { capture, context } = createWorkerHarness(`
      globalThis.body = { toString() { throw new Error('Cannot serialize'); } };
      globalThis.algorithm = {}; algorithm.cycle = algorithm;
      Object.defineProperty(fetchResponse, 'status', { get() { throw new Error('Cannot inspect status'); } });
    `)
    installScripts(context)
    const fetchResult = runInContext(`fetch('/synthetic', { body })`, context)
    expect(fetchResult).toBe(runInContext('fetchPromise', context))
    expect(await fetchResult).toBe(runInContext('fetchResponse', context))
    const digestResult = runInContext(`crypto.subtle.digest(algorithm, new Uint8Array([1]))`, context)
    expect(digestResult).toBe(runInContext('crypto.subtle.promise', context))
    expect(Array.from(new Uint8Array(await digestResult))).toEqual([10, 11])

    capture.bridge.enqueue.mockImplementation(() => { throw new Error('Bridge failure') })
    await expect(runInContext(`fetch('/synthetic')`, context)).resolves.toBe(runInContext('fetchResponse', context))
    await expect(runInContext(`crypto.subtle.encrypt('AES', {}, new Uint8Array([1]))`, context)).resolves.toBeDefined()
    expect(runInContext(`btoa('plain')`, context)).toBe('encoded:plain')
  })

  it('inspects fetch arguments once and retains crypto view bytes from call time', async () => {
    const { capture, context } = createWorkerHarness(`
      globalThis.bodyConversions = 0;
      globalThis.body = { toString() { bodyConversions++; return 'body'; } };
      globalThis.inputBytes = new Uint8Array([255, 1, 2, 254]);
    `)
    installScripts(context)
    await runInContext(`fetch('/synthetic', { body })`, context)
    expect(runInContext('bodyConversions', context)).toBe(1)
    const digestResult = runInContext(`
      globalThis.digestPromise = crypto.subtle.digest('SHA-256', new DataView(inputBytes.buffer, 1, 2));
      inputBytes.fill(9);
      digestPromise;
    `, context)
    await digestResult
    const reportedArguments = findHookPayloads(capture, 'crypto.subtle.digest')[0].arguments
    expect(reportedArguments).toBe('["SHA-256","0102"]')
    expect(findHookPayloads(capture, 'crypto.subtle.digest.result')[0].arguments).toBe(reportedArguments)
  })

  it('preserves synchronous throws and the original rejected promises', async () => {
    const { context } = createWorkerHarness(`
      globalThis.failure = new Error('Original failure');
      globalThis.throwSynchronously = true;
      globalThis.fetch = function () {
        if (throwSynchronously) throw failure;
        globalThis.rejectedFetchPromise = Promise.reject(failure);
        return rejectedFetchPromise;
      };
      crypto.subtle.sign = function () { throw failure; };
      crypto.subtle.decrypt = function () {
        globalThis.rejectedPromise = Promise.reject(failure);
        return rejectedPromise;
      };
    `)
    installScripts(context)
    const failure = runInContext('failure', context)
    expect(runInContext(`try { fetch('/synthetic'); } catch (error) { error === failure; }`, context)).toBe(true)
    expect(runInContext(`try { crypto.subtle.sign('algorithm'); } catch (error) { error === failure; }`, context)).toBe(true)
    const rejectedFetchResult = runInContext(`throwSynchronously = false; fetch('/synthetic');`, context)
    expect(rejectedFetchResult).toBe(runInContext('rejectedFetchPromise', context))
    await expect(rejectedFetchResult).rejects.toBe(failure)
    const rejectedResult = runInContext(`crypto.subtle.decrypt('algorithm')`, context)
    expect(rejectedResult).toBe(runInContext('rejectedPromise', context))
    await expect(rejectedResult).rejects.toBe(failure)
  })

  it('does not report asynchronous settlement after recording stops', async () => {
    const { capture, context } = createWorkerHarness(`
      globalThis.fetch = function () {
        return new Promise(resolve => { globalThis.resolveFetch = resolve; });
      };
    `)
    installScripts(context)
    const pendingResult = runInContext(`fetch('/synthetic')`, context)
    expect(capture.messages).toHaveLength(1)
    capture.setRecording(false)
    runInContext('resolveFetch(fetchResponse)', context)
    await pendingResult
    expect(capture.messages).toHaveLength(1)
  })

  it('registers only library wrappers actually discovered on globals', () => {
    const { capture, context } = createWorkerHarness()
    installScripts(context)
    expect([...capture.hooks.keys()].some(name => name.startsWith('CryptoJS') || name.startsWith('forge'))).toBe(false)
    runInContext(`
      globalThis.CryptoJS = { SHA256(value) { return { toString() { return 'hash:' + value; } }; } };
      globalThis.hashResult = CryptoJS.SHA256('plain');
    `, context)
    expect(runInContext('hashResult.toString()', context)).toBe('hash:plain')
    expect(capture.hooks.get('CryptoJS.SHA256')?.readInstalled()).toBe(true)
    expect(findHookPayloads(capture, 'CryptoJS.SHA256')[0].arguments).toBe('["plain"]')
    runInContext('CryptoJS.SHA256 = function () {};', context)
    expect(capture.hooks.get('CryptoJS.SHA256')?.readInstalled()).toBe(false)
    expect([...capture.hooks.keys()].some(name => name.startsWith('forge'))).toBe(false)
  })

  it('guards DOM-specific hooks and preserves cookie and XHR callable behavior', () => {
    const { capture, context } = createWorkerHarness(`
      class SyntheticDocument {
        get cookie() { return this.cookieValue || ''; }
        set cookie(value) { this.cookieValue = value; }
      }
      globalThis.Document = SyntheticDocument;
      globalThis.document = new Document();
      globalThis.originalCookieGetter = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie').get;
      class SyntheticXHR {
        open(method, url) { this.originalOpenArguments = [method, url]; }
        setRequestHeader(name, value) { this.originalHeaderArguments = [name, value]; }
        send(body) { this.originalBody = body; return 'sent'; }
        addEventListener(name, callback) { this.listener = callback; }
      }
      globalThis.XMLHttpRequest = SyntheticXHR;
    `)
    installScripts(context)
    expect(runInContext(`document.cookie = 'synthetic=value'; document.cookie`, context)).toBe('synthetic=value')
    expect(runInContext(`Object.getOwnPropertyDescriptor(Document.prototype, 'cookie').get === originalCookieGetter`, context)).toBe(true)
    expect(capture.hooks.get('document.cookie.set')?.readInstalled()).toBe(true)
    expect(runInContext(`
      globalThis.request = new XMLHttpRequest();
      request.open('POST', '/synthetic'); request.setRequestHeader('x-test', 'test'); request.send('body');
    `, context)).toBe('sent')
    expect(runInContext('request.originalBody', context)).toBe('body')
    expect(capture.hooks.get('XMLHttpRequest.send')?.readInstalled()).toBe(true)
    expect(JSON.parse(findHookPayloads(capture, 'XMLHttpRequest.send')[0].arguments as string))
      .toEqual({ method: 'POST', url: '/synthetic', headers: { 'x-test': 'test' }, body: 'body' })
    runInContext(`request.status = 204; request.statusText = 'No Content'; request.listener.call(request);`, context)
    expect(findHookPayloads(capture, 'XMLHttpRequest.response')[0].result).toBe('{"status":204,"statusText":"No Content"}')
  })

  it('keeps the Electron window.postMessage fallback without a bridge', async () => {
    const postMessage = vi.fn()
    const context = createContext({ postMessage })
    runInContext(workerFixture + 'globalThis.window = globalThis;', context)
    installScripts(context)
    await runInContext(`fetch('/synthetic')`, context)
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'ar-hook', functionName: 'window.fetch' }), '*')
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'ar-hook', functionName: 'window.fetch.response' }), '*')
  })
})

class SyntheticElement {
  readonly tagName = 'INPUT'
  readonly nodeType = 1
  readonly parentElement = null
  readonly previousElementSibling = null
  readonly className = ''
  readonly textContent = ''
  value = ''
  type = 'text'
  readonly attributes = new Map<string, string>()

  constructor(readonly id: string) {
    this.attributes.set('id', id)
  }

  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  closest(): this { return this }
  getBoundingClientRect() { return { toJSON: () => ({ x: 0, y: 0, width: 100, height: 20 }) } }
}

function createPageHarness(withBridge = true) {
  const capture = createCaptureHarness()
  const documentListeners = new Map<string, Array<(event: Payload) => void>>()
  const controlListeners: Array<(event: Payload) => void> = []
  const postMessage = vi.fn()
  const context = createContext({
    ...(withBridge ? { __aaReliableCapture: capture.bridge } : {}),
    document: {
      title: 'Synthetic page',
      documentElement: new SyntheticElement('root'),
      querySelectorAll: () => [],
      addEventListener(name: string, callback: (event: Payload) => void) {
        const listeners = documentListeners.get(name) ?? []
        listeners.push(callback)
        documentListeners.set(name, listeners)
      },
    },
    addEventListener(name: string, callback: (event: Payload) => void) {
      if (name === 'message') controlListeners.push(callback)
    },
    Element: SyntheticElement,
    Node: { ELEMENT_NODE: 1 },
    CSS: { escape: (value: string) => value },
    location: { href: 'https://synthetic.invalid/' },
    scrollX: 0, scrollY: 0, innerWidth: 800, innerHeight: 600,
    Date, setTimeout, clearTimeout, postMessage,
  })
  runInContext('globalThis.window = globalThis;', context)
  runInContext(interactionScript, context)
  return {
    capture, context, postMessage,
    dispatch(name: string, event: Payload = {}) {
      for (const listener of documentListeners.get(name) ?? []) listener(event)
    },
    control(recording: boolean) {
      for (const listener of controlListeners) listener({ data: { type: 'ar-interaction-control', recording } })
    },
  }
}

describe('realm-safe interaction hooks', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
  })
  afterEach(() => { vi.useRealTimers() })

  it('uses bridge recording immediately and never depends on posted controls', () => {
    const page = createPageHarness()
    const element = new SyntheticElement('action')
    page.dispatch('click', { target: element, pageX: 10, pageY: 20, clientX: 10, clientY: 20 })
    expect(page.capture.messages).toHaveLength(1)
    expect(page.capture.messages[0]).toMatchObject({ stream: 'interaction', payload: { type: 'ar-interaction', interactionType: 'click', selector: '#action' } })
    page.capture.setRecording(false)
    page.control(true)
    page.dispatch('click', { target: element })
    expect(page.capture.messages).toHaveLength(1)
    expect(page.postMessage).not.toHaveBeenCalled()
  })

  it('flushes all debounced inputs before stop and masks sensitive values and attributes', () => {
    const page = createPageHarness()
    const password = new SyntheticElement('password-field')
    password.type = 'password'
    password.value = 'synthetic-secret'
    password.attributes.set('value', 'synthetic-secret')
    const ordinary = new SyntheticElement('ordinary-field')
    ordinary.value = 'first'
    page.dispatch('input', { target: password })
    page.dispatch('input', { target: ordinary })
    ordinary.value = 'final'
    page.dispatch('input', { target: ordinary })
    expect(page.capture.messages).toHaveLength(0)
    expect(page.capture.flushCallbacks).toHaveLength(1)
    page.capture.stop()
    expect(page.capture.messages).toHaveLength(2)
    expect(page.capture.messages.map(message => message.payload.inputValue)).toEqual(['[MASKED]', 'final'])
    expect(page.capture.messages[0].payload.attributes).toMatchObject({ value: '[MASKED]' })
    expect(JSON.stringify(page.capture.messages)).not.toContain('synthetic-secret')
    expect(vi.getTimerCount()).toBe(0)
    ordinary.value = 'stopped-value'
    vi.advanceTimersByTime(1000)
    page.capture.setRecording(true)
    vi.advanceTimersByTime(1000)
    expect(page.capture.messages).toHaveLength(2)
    page.dispatch('input', { target: ordinary })
    vi.advanceTimersByTime(500)
    expect(page.capture.messages[2].payload.inputValue).toBe('stopped-value')
    expect(page.postMessage).not.toHaveBeenCalled()
  })

  it('drops delayed input if recording has already been disabled', () => {
    const page = createPageHarness()
    const element = new SyntheticElement('field')
    element.attributes.set('autocomplete', 'new-password')
    element.value = 'synthetic-secret'
    page.dispatch('input', { target: element })
    page.capture.setRecording(false)
    vi.advanceTimersByTime(500)
    expect(page.capture.messages).toEqual([])
    page.capture.setRecording(true)
    page.dispatch('input', { target: element })
    vi.advanceTimersByTime(500)
    expect(page.capture.messages[0].payload.inputValue).toBe('[MASKED]')
  })

  it('flushes trailing scroll and mouse buffers while the bridge is still recording', () => {
    const page = createPageHarness()
    const recordingDuringEnqueue: boolean[] = []
    page.capture.bridge.enqueue.mockImplementation((stream, payload) => {
      recordingDuringEnqueue.push(page.capture.bridge.recording)
      page.capture.messages.push({ stream, payload })
    })
    page.dispatch('scroll')
    vi.advanceTimersByTime(50)
    page.context.scrollY = 123
    page.dispatch('scroll')
    for (const coordinate of [10, 20, 30]) {
      page.dispatch('mousemove', { clientX: coordinate, clientY: coordinate })
      vi.advanceTimersByTime(50)
    }
    page.capture.stop()
    expect(page.capture.messages.map(message => message.payload.interactionType)).toEqual(['scroll', 'scroll', 'hover'])
    expect(page.capture.messages[1].payload.scrollY).toBe(123)
    expect(page.capture.messages[2].payload.path).toHaveLength(3)
    expect(recordingDuringEnqueue).toEqual([true, true, true])
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(3000)
    expect(page.capture.messages).toHaveLength(3)
  })

  it('cleans up very short mouse traces without a lingering flush timer', () => {
    const page = createPageHarness()
    page.dispatch('mousemove', { clientX: 10, clientY: 10 })
    expect(vi.getTimerCount()).toBe(1)
    page.capture.stop()
    expect(vi.getTimerCount()).toBe(0)
    expect(page.capture.messages).toEqual([])
  })

  it('preserves Electron controls and flushes legacy inputs on stop', () => {
    const page = createPageHarness(false)
    const element = new SyntheticElement('field')
    element.value = 'final'
    page.dispatch('input', { target: element })
    expect(vi.getTimerCount()).toBe(0)
    page.control(true)
    page.dispatch('input', { target: element })
    page.control(false)
    expect(page.postMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'ar-interaction', interactionType: 'input', inputValue: 'final' }), '*')
    expect(vi.getTimerCount()).toBe(0)
    page.control(true)
    vi.advanceTimersByTime(1000)
    expect(page.postMessage).toHaveBeenCalledTimes(1)
  })
})
