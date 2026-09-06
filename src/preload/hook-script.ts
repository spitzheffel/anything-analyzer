/**
 * Hook script injected into the target browser page context.
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

  // ---- Proxy-based instrumentation ----

  type AnyFn = (...args: any[]) => any

  /** Wrap a function in a call-intercepting Proxy that stays disguised as its target. */
  function hookFn<T extends AnyFn>(
    original: T,
    onApply: (thisArg: unknown, args: unknown[]) => void,
    onResult?: (thisArg: unknown, args: unknown[], result: unknown) => void,
  ): T {
    return new Proxy(original, {
      apply(target, thisArg, args): unknown {
        try { onApply(thisArg, args) } catch { /* never let logging break the call */ }
        const result = Reflect.apply(target as AnyFn, thisArg, args)
        if (onResult) {
          try { onResult(thisArg, args, result) } catch { /* ignore */ }
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

  function sendHookData(hookType: string, functionName: string, args: unknown, result: unknown, callStack: string | null): void {
    try {
      window.postMessage({ type: HOOK_MSG_TYPE, hookType, functionName, arguments: JSON.stringify(args), result: result != null ? JSON.stringify(result) : null, callStack, timestamp: Date.now() }, '*')
    } catch { /* ignore serialization errors */ }
  }

  function getCallStack(): string {
    return new Error().stack?.split('\n').slice(2).join('\n') || ''
  }

  function arrayBufferToHex(buffer: ArrayBufferLike): string {
    return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('')
  }

  // Hook: window.fetch
  const originalFetch = window.fetch
  const hookedFetch = hookFn(
    originalFetch,
    (_thisArg, args) => {
      const [input, init] = args as [RequestInfo | URL, RequestInit | undefined]
      const stack = getCallStack()
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
      const method = init?.method || (input instanceof Request ? input.method : 'GET')
      sendHookData('fetch', 'window.fetch', { url, method, body: init?.body?.toString() }, null, stack)
    },
  )
  // Report the response status when it settles, matching the previous behavior.
  const hookedFetchWithResponse = new Proxy(originalFetch, {
    apply(target, thisArg, args): Promise<Response> {
      const [input, init] = args as [RequestInfo | URL, RequestInit | undefined]
      const stack = getCallStack()
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
      const method = init?.method || (input instanceof Request ? input.method : 'GET')
      sendHookData('fetch', 'window.fetch', { url, method, body: init?.body?.toString() }, null, stack)
      return (Reflect.apply(target, thisArg, args) as Promise<Response>).then(response => {
        sendHookData('fetch', 'window.fetch.response', { url, method }, { status: response.status, statusText: response.statusText }, null)
        return response
      })
    },
  })
  void hookedFetch
  replaceProperty(window, 'fetch', hookedFetchWithResponse)

  // Hook: XMLHttpRequest
  const XHRProto = XMLHttpRequest.prototype
  const originalOpen = XHRProto.open
  const originalSend = XHRProto.send
  const originalSetHeader = XHRProto.setRequestHeader

  replaceProperty(XHRProto, 'open', hookFn(originalOpen, function (thisArg, args) {
    const xhr = thisArg as any
    const [method, url] = args as [string, string | URL]
    xhr._arMethod = method
    xhr._arUrl = typeof url === 'string' ? url : url.href
    xhr._arHeaders = {}
  }))

  replaceProperty(XHRProto, 'setRequestHeader', hookFn(originalSetHeader, function (thisArg, args) {
    const xhr = thisArg as any
    const [name, value] = args as [string, string]
    if (xhr._arHeaders) xhr._arHeaders[name] = value
  }))

  replaceProperty(XHRProto, 'send', hookFn(originalSend, function (thisArg, args) {
    const xhr = thisArg as any
    const [body] = args as [Document | XMLHttpRequestBodyInit | null | undefined]
    const stack = getCallStack()
    sendHookData('xhr', 'XMLHttpRequest.send', { method: xhr._arMethod, url: xhr._arUrl, headers: xhr._arHeaders, body: body?.toString() || null }, null, stack)
    xhr.addEventListener('load', function (this: XMLHttpRequest) {
      sendHookData('xhr', 'XMLHttpRequest.response', { method: xhr._arMethod, url: xhr._arUrl }, { status: this.status, statusText: this.statusText }, null)
    })
  }))

  // Hook: crypto.subtle (patched on the prototype so the instance stays pristine)
  if (window.crypto?.subtle) {
    const subtleProto = Object.getPrototypeOf(window.crypto.subtle) as Record<string, unknown>
    for (const methodName of ['sign', 'digest', 'encrypt', 'decrypt'] as const) {
      const original = subtleProto[methodName] as AnyFn | undefined
      if (typeof original !== 'function') continue
      const hooked = new Proxy(original, {
        apply(target, thisArg, args): Promise<unknown> {
          const stack = getCallStack()
          const serializedArgs = args.map(arg => {
            if (arg instanceof ArrayBuffer) return arrayBufferToHex(arg)
            if (ArrayBuffer.isView(arg)) return arrayBufferToHex(arg.buffer)
            return arg
          })
          sendHookData('crypto', `crypto.subtle.${methodName}`, serializedArgs, null, stack)
          return (Reflect.apply(target, thisArg, args) as Promise<unknown>).then(result => {
            sendHookData('crypto', `crypto.subtle.${methodName}.result`, serializedArgs, result instanceof ArrayBuffer ? arrayBufferToHex(result) : result, null)
            return result
          })
        },
      })
      replaceProperty(subtleProto, methodName, hooked)
    }
  }

  // ---- Third-party crypto library hooks ----

  function truncateArg(val: unknown): string {
    const s = typeof val === 'string' ? val : JSON.stringify(val)
    return s && s.length > 500 ? s.substring(0, 500) + '...' : (s || '')
  }

  function wrapMethod(obj: any, methodName: string, libLabel: string): void {
    if (typeof obj[methodName] !== 'function') return
    obj[methodName] = hookFn(
      obj[methodName] as AnyFn,
      (_thisArg, args) => {
        sendHookData('crypto_lib', `${libLabel}.${methodName}`, args.map(a => truncateArg(a)), null, getCallStack())
      },
      (_thisArg, args, result) => {
        if (result && typeof result === 'object' && typeof (result as { toString?: unknown }).toString === 'function') {
          sendHookData('crypto_lib', `${libLabel}.${methodName}.result`, args.map(a => truncateArg(a)), truncateArg((result as { toString(): string }).toString()), null)
        }
      },
    )
  }

  function wrapFactory(obj: any, name: string, libLabel: string): void {
    if (typeof obj[name] !== 'function') return
    obj[name] = hookFn(
      obj[name] as AnyFn,
      (_thisArg, args) => {
        sendHookData('crypto_lib', `${libLabel}.${name}`, args.map(a => truncateArg(a)), null, getCallStack())
      },
      (_thisArg, _args, result) => {
        sendHookData('crypto_lib', `${libLabel}.${name}.result`, [], truncateArg((result as { toString?: () => string })?.toString?.()), null)
      },
    )
  }

  function hookCryptoJS(CryptoJS: any): void {
    if (!CryptoJS || CryptoJS._arHooked) return
    CryptoJS._arHooked = true

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
    if (!JSEncryptClass || JSEncryptClass._arHooked) return
    JSEncryptClass._arHooked = true
    const proto = JSEncryptClass.prototype
    if (proto) {
      for (const method of ['encrypt', 'decrypt', 'sign', 'verify', 'setPublicKey', 'setPrivateKey']) {
        wrapMethod(proto, method, 'JSEncrypt')
      }
    }
  }

  function hookForge(forge: any): void {
    if (!forge || forge._arHooked) return
    forge._arHooked = true
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

  function hookSmCrypto(name: string, obj: any): void {
    if (!obj || obj._arHooked) return
    obj._arHooked = true
    for (const method of ['doEncrypt', 'doDecrypt', 'doSignature', 'doVerifySignature', 'encrypt', 'decrypt']) {
      wrapMethod(obj, method, name)
    }
  }

  // Trap library globals: fires when library is assigned to window.
  // The accessor is non-enumerable so `Object.keys(window)` / `for...in` do
  // not reveal a CryptoJS/forge slot on a page that never loaded them.
  function trapGlobal(name: string, hookFnForLib: (lib: any) => void): void {
    if ((window as any)[name]) {
      try { hookFnForLib((window as any)[name]) } catch { /* ignore */ }
      return
    }
    let _val: any = undefined
    try {
      Object.defineProperty(window, name, {
        get() { return _val },
        set(v) {
          _val = v
          if (v) { try { hookFnForLib(v) } catch { /* ignore */ } }
        },
        configurable: true,
        enumerable: false,
      })
    } catch { /* CSP or frozen global */ }
  }

  trapGlobal('CryptoJS', hookCryptoJS)
  trapGlobal('JSEncrypt', hookJSEncrypt)
  trapGlobal('forge', hookForge)
  trapGlobal('sm2', (obj) => hookSmCrypto('sm2', obj))
  trapGlobal('sm3', (obj) => hookSmCrypto('sm3', obj))
  trapGlobal('sm4', (obj) => hookSmCrypto('sm4', obj))

  // Hook native btoa/atob
  replaceProperty(window, 'btoa', hookFn(window.btoa, (_thisArg, args) => {
    sendHookData('crypto_lib', 'btoa', { data: truncateArg((args as [string])[0]) }, null, getCallStack())
  }))
  replaceProperty(window, 'atob', hookFn(window.atob, (_thisArg, args) => {
    sendHookData('crypto_lib', 'atob', { data: truncateArg((args as [string])[0]) }, null, getCallStack())
  }))

  // Hook: document.cookie setter. Stays on Document.prototype as a configurable
  // accessor, exactly where the platform defines it, so `document` gains no own
  // property and Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')
  // still reports get/set/configurable as stock Chrome does. Both accessors are
  // Proxies of the native get/set so their toString stays native cross-realm.
  const cookieDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')
  if (cookieDesc?.get && cookieDesc.set) {
    const hookedGet = new Proxy(cookieDesc.get, {
      apply(target, thisArg): unknown {
        return Reflect.apply(target, thisArg, [])
      },
    })
    const hookedSet = hookFn(cookieDesc.set, (_thisArg, args) => {
      sendHookData('cookie_set', 'document.cookie.set', { value: (args as [string])[0] }, null, getCallStack())
    })
    try {
      Object.defineProperty(Document.prototype, 'cookie', {
        get: hookedGet,
        set: hookedSet,
        enumerable: cookieDesc.enumerable,
        configurable: true,
      })
    } catch { /* CSP or already locked */ }
  }
})()
