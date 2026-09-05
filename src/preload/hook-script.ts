/**
 * Hook script injected into the target browser page context.
 * Intercepts fetch, XMLHttpRequest, crypto.subtle, and document.cookie.
 */
;(function () {
  const HOOK_MSG_TYPE = 'ar-hook'

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
  const hookedFetch = function(this: typeof globalThis, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const stack = getCallStack()
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    const method = init?.method || (input instanceof Request ? input.method : 'GET')
    sendHookData('fetch', 'window.fetch', { url, method, body: init?.body?.toString() }, null, stack)
    return originalFetch.call(this, input, init).then(response => {
      sendHookData('fetch', 'window.fetch.response', { url, method }, { status: response.status, statusText: response.statusText }, null)
      return response
    })
  }
  try { Object.defineProperty(window, 'fetch', { value: hookedFetch, writable: false, configurable: false }) } catch { (window as any).fetch = hookedFetch }

  // Hook: XMLHttpRequest
  const XHRProto = XMLHttpRequest.prototype
  const originalOpen = XHRProto.open
  const originalSend = XHRProto.send
  const originalSetHeader = XHRProto.setRequestHeader

  XHRProto.open = function(method: string, url: string | URL, ...args: any[]) {
    (this as any)._arMethod = method;
    (this as any)._arUrl = typeof url === 'string' ? url : url.href;
    (this as any)._arHeaders = {}
    return (originalOpen as Function).call(this, method, url, ...args)
  }

  XHRProto.setRequestHeader = function(name: string, value: string) {
    if ((this as any)._arHeaders) (this as any)._arHeaders[name] = value
    return originalSetHeader.call(this, name, value)
  }

  XHRProto.send = function(body?: Document | XMLHttpRequestBodyInit | null) {
    const xhr = this as any
    const stack = getCallStack()
    sendHookData('xhr', 'XMLHttpRequest.send', { method: xhr._arMethod, url: xhr._arUrl, headers: xhr._arHeaders, body: body?.toString() || null }, null, stack)
    this.addEventListener('load', function() {
      sendHookData('xhr', 'XMLHttpRequest.response', { method: xhr._arMethod, url: xhr._arUrl }, { status: this.status, statusText: this.statusText }, null)
    })
    return originalSend.call(this, body)
  }

  // Hook: crypto.subtle
  if (window.crypto?.subtle) {
    const subtle = window.crypto.subtle
    for (const methodName of ['sign', 'digest', 'encrypt', 'decrypt'] as const) {
      const original = subtle[methodName].bind(subtle)
      ;(subtle as any)[methodName] = async function(...args: any[]) {
        const stack = getCallStack()
        const serializedArgs = args.map(arg => {
          if (arg instanceof ArrayBuffer) return arrayBufferToHex(arg)
          if (ArrayBuffer.isView(arg)) return arrayBufferToHex(arg.buffer)
          return arg
        })
        sendHookData('crypto', `crypto.subtle.${methodName}`, serializedArgs, null, stack)
        const result = await (original as Function)(...args)
        sendHookData('crypto', `crypto.subtle.${methodName}.result`, serializedArgs, result instanceof ArrayBuffer ? arrayBufferToHex(result) : result, null)
        return result
      }
    }
  }

  // ---- Third-party crypto library hooks ----

  function truncateArg(val: unknown): string {
    const s = typeof val === 'string' ? val : JSON.stringify(val)
    return s && s.length > 500 ? s.substring(0, 500) + '...' : (s || '')
  }

  function wrapMethod(obj: any, methodName: string, libLabel: string): void {
    if (typeof obj[methodName] !== 'function') return
    const original = obj[methodName]
    obj[methodName] = function(this: any, ...args: any[]) {
      const stack = getCallStack()
      const truncatedArgs = args.map(a => truncateArg(a))
      sendHookData('crypto_lib', `${libLabel}.${methodName}`, truncatedArgs, null, stack)
      try {
        const result = original.apply(this, args)
        if (result && typeof result === 'object' && typeof result.toString === 'function') {
          sendHookData('crypto_lib', `${libLabel}.${methodName}.result`, truncatedArgs, truncateArg(result.toString()), null)
        }
        return result
      } catch (e) {
        throw e
      }
    }
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

    // Hash functions
    for (const hash of ['MD5', 'SHA1', 'SHA256', 'SHA512', 'SHA3', 'RIPEMD160']) {
      if (typeof CryptoJS[hash] === 'function') {
        const original = CryptoJS[hash]
        CryptoJS[hash] = function(...args: any[]) {
          const stack = getCallStack()
          sendHookData('crypto_lib', `CryptoJS.${hash}`, args.map(a => truncateArg(a)), null, stack)
          const result = original.apply(this, args)
          sendHookData('crypto_lib', `CryptoJS.${hash}.result`, [], truncateArg(result?.toString()), null)
          return result
        }
      }
    }

    // HMAC functions
    for (const hmac of ['HmacSHA1', 'HmacSHA256', 'HmacSHA512', 'HmacMD5']) {
      if (typeof CryptoJS[hmac] === 'function') {
        const original = CryptoJS[hmac]
        CryptoJS[hmac] = function(...args: any[]) {
          const stack = getCallStack()
          sendHookData('crypto_lib', `CryptoJS.${hmac}`, args.map(a => truncateArg(a)), null, stack)
          const result = original.apply(this, args)
          sendHookData('crypto_lib', `CryptoJS.${hmac}.result`, [], truncateArg(result?.toString()), null)
          return result
        }
      }
    }

    // PBKDF2
    if (typeof CryptoJS.PBKDF2 === 'function') {
      const original = CryptoJS.PBKDF2
      CryptoJS.PBKDF2 = function(...args: any[]) {
        const stack = getCallStack()
        sendHookData('crypto_lib', 'CryptoJS.PBKDF2', args.map(a => truncateArg(a)), null, stack)
        const result = original.apply(this, args)
        sendHookData('crypto_lib', 'CryptoJS.PBKDF2.result', [], truncateArg(result?.toString()), null)
        return result
      }
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

  // Trap library globals: fires when library is assigned to window
  function trapGlobal(name: string, hookFn: (lib: any) => void): void {
    // If already present, hook immediately
    if ((window as any)[name]) {
      try { hookFn((window as any)[name]) } catch { /* ignore */ }
      return
    }
    // Set a defineProperty trap for lazy loading
    let _val: any = undefined
    try {
      Object.defineProperty(window, name, {
        get() { return _val },
        set(v) {
          _val = v
          if (v) { try { hookFn(v) } catch { /* ignore */ } }
        },
        configurable: true,
        enumerable: true,
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
  const originalBtoa = window.btoa
  const originalAtob = window.atob
  window.btoa = function(data: string): string {
    sendHookData('crypto_lib', 'btoa', { data: truncateArg(data) }, null, getCallStack())
    return originalBtoa.call(window, data)
  }
  window.atob = function(data: string): string {
    sendHookData('crypto_lib', 'atob', { data: truncateArg(data) }, null, getCallStack())
    return originalAtob.call(window, data)
  }

  // Hook: document.cookie setter
  const cookieDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')
  if (cookieDesc) {
    try {
      Object.defineProperty(document, 'cookie', {
        get: function() { return cookieDesc.get?.call(this) },
        set: function(value: string) { sendHookData('cookie_set', 'document.cookie.set', { value }, null, getCallStack()); return cookieDesc.set?.call(this, value) },
        configurable: false
      })
    } catch { /* CSP or already locked */ }
  }
})()
