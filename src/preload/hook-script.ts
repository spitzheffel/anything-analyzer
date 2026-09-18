/**
 * Hook script injected into a browser page or worker context.
 * Intercepts fetch, XMLHttpRequest, crypto.subtle, and document.cookie.
 *
 * Each replacement is a `Proxy` of the original function with an `apply` trap,
 * never a fresh JS closure. Function.prototype.toString on a callable Proxy
 * returns the target's source ("[native code]" for a native target) in every
 * realm, so the disguise survives even a cross-realm probe — grabbing a clean
 * Function.prototype.toString from an <iframe> and calling it on window.fetch.
 * The Proxy also forwards name/length and keeps the platform's own property
 * descriptor, defeating the descriptor checks anti-bot scripts run. A plain
 * reassignment or a closure wrapper fails all of these.
 */
;(function () {
  const HOOK_MSG_TYPE = 'ar-hook'
  interface CaptureBridge {
    enqueue(stream: 'hook' | 'interaction' | 'control', payload: Record<string, unknown>): void
    registerHook(name: string, readInstalled?: () => boolean, applicable?: boolean): void
    registerRepair?(name: string, repair: () => void): void
    recordLoss?(): void
    readonly recording: boolean
    readonly runId?: string
  }

  const realm = globalThis as typeof globalThis & { __aaReliableCapture?: CaptureBridge }
  const capture = realm.__aaReliableCapture

  function isRecording(): boolean {
    try { return capture ? capture.recording : true } catch { return false }
  }

  function registerHook(name: string, readInstalled: () => boolean, applicable = true): void {
    try { capture?.registerHook(name, readInstalled, applicable) } catch { /* reporting is best effort */ }
  }

  // ---- Proxy-based instrumentation ----

  type AnyFn = (...args: any[]) => any

  /** Wrap a function in a call-intercepting Proxy that stays disguised as its target. */
  function hookFn<T extends AnyFn>(
    original: T,
    onApply: (thisArg: unknown, args: unknown[]) => unknown,
    onResult?: (thisArg: unknown, args: unknown[], result: unknown, reportContext: unknown) => void,
  ): T {
    return new Proxy(original, {
      apply(target, thisArg, args): unknown {
        const reporting = isRecording()
        let reportContext: unknown
        if (reporting) {
          try { reportContext = onApply(thisArg, args) } catch { /* never let logging break the call */ }
        }
        const result = Reflect.apply(target as AnyFn, thisArg, args)
        if (reporting && isRecording() && onResult) {
          try { onResult(thisArg, args, result, reportContext) } catch { /* ignore */ }
        }
        return result
      },
    }) as T
  }

  /** Replace a data property while preserving its original descriptor flags. */
  function replaceProperty(target: object, key: string, wrapper: unknown): void {
    const descriptor = Object.getOwnPropertyDescriptor(target, key)
    try {
      Object.defineProperty(target, key, {
        value: wrapper,
        writable: descriptor?.writable ?? true,
        enumerable: descriptor?.enumerable ?? true,
        configurable: descriptor?.configurable ?? true,
      })
    } catch {
      try { (target as Record<string, unknown>)[key] = wrapper } catch { /* locked */ }
    }
  }

  /** Guard each installation separately, and measure the callable actually in use. */
  function installFunctionHook(
    name: string,
    readTarget: () => Record<string, any> | undefined,
    key: string,
    onApply: (thisArg: unknown, args: unknown[]) => unknown,
    onResult?: (thisArg: unknown, args: unknown[], result: unknown, reportContext: unknown) => void,
    reportMissing = true,
  ): void {
    let applicable = false
    let readInstalled = (): boolean => false
    try {
      const target = readTarget()
      const original = target?.[key]
      applicable = typeof original === 'function'
      if (target && applicable) {
        const wrapper = hookFn(original as AnyFn, onApply, onResult)
        replaceProperty(target, key, wrapper)
        readInstalled = () => {
          try { return readTarget()?.[key] === wrapper } catch { return false }
        }
      }
    } catch { /* an unavailable or locked hook must not block other hooks */ }
    if (applicable || reportMissing) registerHook(name, readInstalled, applicable)
    capture?.registerRepair?.(name, () => installFunctionHook(name, readTarget, key, onApply, onResult, reportMissing))
  }

  function sendHookData(hookType: string, functionName: string, args: unknown, result: unknown, callStack: string | null): void {
    if (!isRecording()) return
    try {
      const payload = { type: HOOK_MSG_TYPE, hookType, functionName, arguments: JSON.stringify(args), result: result != null ? JSON.stringify(result) : null, callStack, timestamp: Date.now() }
      if (capture) capture.enqueue('hook', payload)
      else if (typeof window !== 'undefined') window.postMessage(payload, '*')
    } catch { capture?.recordLoss?.() }
  }

  function getCallStack(): string {
    return new Error().stack?.split('\n').slice(2).join('\n') || ''
  }

  function arrayBufferToHex(buffer: ArrayBufferLike, byteOffset = 0, byteLength?: number): string {
    return Array.from(new Uint8Array(buffer, byteOffset, byteLength)).map(byte => byte.toString(16).padStart(2, '0')).join('')
  }

  function readFetchArguments(args: unknown[]): { url: string; method: string; body?: string } {
    const [input, init] = args as [RequestInfo | URL, RequestInit | undefined]
    const url = typeof input === 'string' ? input
      : typeof realm.URL === 'function' && input instanceof realm.URL ? input.href
      : (input as Request).url
    const method = init?.method || (typeof realm.Request === 'function' && input instanceof realm.Request ? input.method : 'GET')
    return { url, method, body: init?.body?.toString() }
  }

  /** Observe settlement without replacing the original promise or its rejection. */
  function observeResult(result: unknown, report: (value: any) => void): void {
    if (!result || typeof (result as Promise<unknown>).then !== 'function') return
    const originatingRunId = capture?.runId
    ;(result as Promise<unknown>).then(value => {
      if (!isRecording() || capture?.runId !== originatingRunId) return
      try { report(value) } catch { /* never reject the observer because logging failed */ }
    }, () => { /* leave rejection handling to the original caller */ })
  }

  // Keep the legacy payload names, including window.fetch, in every realm.
  installFunctionHook('fetch', () => realm, 'fetch', (_thisArg, args) => {
    const fetchArguments = readFetchArguments(args)
    sendHookData('fetch', 'window.fetch', fetchArguments, null, getCallStack())
    return fetchArguments
  }, (_thisArg, _args, result, reportContext) => {
    const fetchArguments = reportContext as ReturnType<typeof readFetchArguments> | undefined
    if (!fetchArguments) return
    const { url, method } = fetchArguments
    observeResult(result, response => {
      sendHookData('fetch', 'window.fetch.response', { url, method }, { status: response.status, statusText: response.statusText }, null)
    })
  })

  // Hook: XMLHttpRequest
  const xhrMetadata = new WeakMap<object, { method: string; url: string; headers: Record<string, string> }>()
  const readXHRPrototype = (): Record<string, any> | undefined => realm.XMLHttpRequest?.prototype

  installFunctionHook('XMLHttpRequest.open', readXHRPrototype, 'open', (thisArg, args) => {
    const [method, url] = args as [string, string | URL]
    xhrMetadata.set(thisArg as object, { method, url: typeof url === 'string' ? url : url.href, headers: {} })
  })

  installFunctionHook('XMLHttpRequest.setRequestHeader', readXHRPrototype, 'setRequestHeader', (thisArg, args) => {
    const [name, value] = args as [string, string]
    const metadata = xhrMetadata.get(thisArg as object)
    if (metadata) metadata.headers[name] = value
  })

  installFunctionHook('XMLHttpRequest.send', readXHRPrototype, 'send', (thisArg, args) => {
    const xhr = thisArg as XMLHttpRequest
    const metadata = xhrMetadata.get(xhr)
    const [body] = args as [Document | XMLHttpRequestBodyInit | null | undefined]
    sendHookData('xhr', 'XMLHttpRequest.send', { ...metadata, body: body?.toString() || null }, null, getCallStack())
    const originatingRunId = capture?.runId
    xhr.addEventListener('load', function (this: XMLHttpRequest) {
      if (!isRecording() || capture?.runId !== originatingRunId) return
      try {
        sendHookData('xhr', 'XMLHttpRequest.response', { method: metadata?.method, url: metadata?.url }, { status: this.status, statusText: this.statusText }, null)
      } catch { /* response inspection must not disrupt website listeners */ }
    }, { once: true })
  })

  // Hook: crypto.subtle (patched on the prototype so the instance stays pristine)
  function findPropertyOwner(target: object, key: string): Record<string, any> | undefined {
    let owner: Record<string, any> | null = target
    while (owner) {
      if (Object.prototype.hasOwnProperty.call(owner, key)) return owner
      owner = Object.getPrototypeOf(owner)
    }
    return undefined
  }

  function serializeCryptoArgument(argument: unknown): unknown {
    if (argument instanceof ArrayBuffer) return arrayBufferToHex(argument)
    if (ArrayBuffer.isView(argument)) return arrayBufferToHex(argument.buffer, argument.byteOffset, argument.byteLength)
    return argument
  }

  for (const methodName of ['sign', 'digest', 'encrypt', 'decrypt'] as const) {
    const name = `crypto.subtle.${methodName}`
    installFunctionHook(name, () => {
      const subtle = realm.crypto?.subtle
      return subtle && findPropertyOwner(subtle, methodName)
    }, methodName, (_thisArg, args) => {
      const serializedArguments = args.map(serializeCryptoArgument)
      sendHookData('crypto', name, serializedArguments, null, getCallStack())
      return serializedArguments
    }, (_thisArg, _args, result, reportContext) => {
      const serializedArguments = reportContext as unknown[] | undefined
      if (!serializedArguments) return
      observeResult(result, value => {
        sendHookData('crypto', `${name}.result`, serializedArguments, serializeCryptoArgument(value), null)
      })
    })
  }

  // ---- Third-party crypto library hooks ----

  function truncateArg(value: unknown): string {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value)
    return serialized && serialized.length > 500 ? serialized.substring(0, 500) + '...' : (serialized || '')
  }

  function wrapMethod(library: any, methodName: string, libraryLabel: string): void {
    installFunctionHook(
      `${libraryLabel}.${methodName}`, () => library, methodName,
      (_thisArg, args) => {
        sendHookData('crypto_lib', `${libraryLabel}.${methodName}`, args.map(truncateArg), null, getCallStack())
      },
      (_thisArg, args, result) => {
        if (!isRecording()) return
        if (result && typeof result === 'object' && typeof (result as { toString?: unknown }).toString === 'function') {
          sendHookData('crypto_lib', `${libraryLabel}.${methodName}.result`, args.map(truncateArg), truncateArg((result as { toString(): string }).toString()), null)
        }
      },
      false,
    )
  }

  function wrapFactory(library: any, name: string, libraryLabel: string): void {
    installFunctionHook(
      `${libraryLabel}.${name}`, () => library, name,
      (_thisArg, args) => {
        sendHookData('crypto_lib', `${libraryLabel}.${name}`, args.map(truncateArg), null, getCallStack())
      },
      (_thisArg, _args, result) => {
        if (!isRecording()) return
        sendHookData('crypto_lib', `${libraryLabel}.${name}.result`, [], truncateArg((result as { toString?: () => string })?.toString?.()), null)
      },
      false,
    )
  }

  const discoveredLibraries = new WeakSet<object>()

  function markLibraryDiscovered(library: unknown): boolean {
    if (!library || (typeof library !== 'object' && typeof library !== 'function')) return false
    if (discoveredLibraries.has(library)) return false
    discoveredLibraries.add(library)
    return true
  }

  function hookCryptoJS(CryptoJS: any): void {
    if (!markLibraryDiscovered(CryptoJS)) return

    // AES / DES / TripleDES / Rabbit / RC4
    for (const cipher of ['AES', 'DES', 'TripleDES', 'Rabbit', 'RC4']) {
      if (CryptoJS[cipher]) {
        wrapMethod(CryptoJS[cipher], 'encrypt', `CryptoJS.${cipher}`)
        wrapMethod(CryptoJS[cipher], 'decrypt', `CryptoJS.${cipher}`)
      }
    }

    // Hash / HMAC / KDF functions
    for (const fn of ['MD5', 'SHA1', 'SHA256', 'SHA512', 'SHA3', 'RIPEMD160',
      'HmacSHA1', 'HmacSHA256', 'HmacSHA512', 'HmacMD5', 'PBKDF2']) {
      wrapFactory(CryptoJS, fn, 'CryptoJS')
    }

    // enc.Base64 / enc.Hex
    if (CryptoJS.enc) {
      for (const enc of ['Base64', 'Hex', 'Utf8', 'Latin1']) {
        if (CryptoJS.enc[enc]) {
          wrapMethod(CryptoJS.enc[enc], 'stringify', `CryptoJS.enc.${enc}`)
          wrapMethod(CryptoJS.enc[enc], 'parse', `CryptoJS.enc.${enc}`)
        }
      }
    }
  }

  function hookJSEncrypt(JSEncryptClass: any): void {
    if (!markLibraryDiscovered(JSEncryptClass)) return
    const proto = JSEncryptClass.prototype
    if (proto) {
      for (const method of ['encrypt', 'decrypt', 'sign', 'verify', 'setPublicKey', 'setPrivateKey']) {
        wrapMethod(proto, method, 'JSEncrypt')
      }
    }
  }

  function hookForge(forge: any): void {
    if (!markLibraryDiscovered(forge)) return
    if (forge.pki) {
      wrapMethod(forge.pki, 'publicKeyFromPem', 'forge.pki')
      wrapMethod(forge.pki, 'privateKeyFromPem', 'forge.pki')
      wrapMethod(forge.pki, 'certificateFromPem', 'forge.pki')
    }
    if (forge.cipher) {
      wrapMethod(forge.cipher, 'createCipher', 'forge.cipher')
      wrapMethod(forge.cipher, 'createDecipher', 'forge.cipher')
    }
    if (forge.md) {
      for (const alg of ['sha256', 'sha1', 'sha512', 'md5']) {
        if (forge.md[alg]) wrapMethod(forge.md[alg], 'create', `forge.md.${alg}`)
      }
    }
    if (forge.util) {
      wrapMethod(forge.util, 'encode64', 'forge.util')
      wrapMethod(forge.util, 'decode64', 'forge.util')
    }
    if (forge.hmac) {
      wrapMethod(forge.hmac, 'create', 'forge.hmac')
    }
  }

  function hookSmCrypto(name: string, library: any): void {
    if (!markLibraryDiscovered(library)) return
    for (const method of ['doEncrypt', 'doDecrypt', 'doSignature', 'doVerifySignature', 'encrypt', 'decrypt']) {
      wrapMethod(library, method, name)
    }
  }

  // Discover global libraries only; private module exports are not covered.
  // Accessors stay non-enumerable on realms that never load the library.
  function trapGlobal(name: string, hookLibrary: (library: any) => void): void {
    try {
      const existing = (realm as any)[name]
      if (existing) {
        hookLibrary(existing)
        return
      }
      if (Object.getOwnPropertyDescriptor(realm, name)) return
      let libraryValue: unknown
      Object.defineProperty(realm, name, {
        get() { return libraryValue },
        set(value) {
          libraryValue = value
          if (value) { try { hookLibrary(value) } catch { /* ignore */ } }
        },
        configurable: true,
        enumerable: false,
      })
    } catch { /* CSP or frozen global */ }
  }

  trapGlobal('CryptoJS', hookCryptoJS)
  trapGlobal('JSEncrypt', hookJSEncrypt)
  trapGlobal('forge', hookForge)
  trapGlobal('sm2', library => hookSmCrypto('sm2', library))
  trapGlobal('sm3', library => hookSmCrypto('sm3', library))
  trapGlobal('sm4', library => hookSmCrypto('sm4', library))

  // Hook native btoa/atob
  for (const name of ['btoa', 'atob']) {
    installFunctionHook(name, () => realm, name, (_thisArg, args) => {
      sendHookData('crypto_lib', name, { data: truncateArg(args[0]) }, null, getCallStack())
    })
  }

  // Patch the cookie setter where the platform defines it. Keep its getter
  // and descriptor flags unchanged, without assuming Document exists.
  let cookieApplicable = false
  let readCookieInstalled = (): boolean => false
  try {
    const owner = realm.document && findPropertyOwner(realm.document, 'cookie')
    const descriptor = owner && Object.getOwnPropertyDescriptor(owner, 'cookie')
    cookieApplicable = typeof descriptor?.set === 'function'
    if (owner && descriptor?.set) {
      const hookedSet = hookFn(descriptor.set, (_thisArg, args) => {
        sendHookData('cookie_set', 'document.cookie.set', { value: args[0] }, null, getCallStack())
      })
      Object.defineProperty(owner, 'cookie', { ...descriptor, set: hookedSet })
      readCookieInstalled = () => {
        try {
          const currentOwner = realm.document && findPropertyOwner(realm.document, 'cookie')
          return Boolean(currentOwner && Object.getOwnPropertyDescriptor(currentOwner, 'cookie')?.set === hookedSet)
        } catch { return false }
      }
    }
  } catch { /* workers have no document; locked accessors stay untouched */ }
  registerHook('document.cookie.set', readCookieInstalled, cookieApplicable)
})()
