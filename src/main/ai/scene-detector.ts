import type { FilteredRequest, SceneHint } from '@shared/types'

/**
 * SceneDetector — Detects business scenarios from captured requests using rule-based heuristics.
 *
 * 职责：在数据送给 AI 之前，基于规则对捕获的请求数据做一轮场景预判，
 * 输出 SceneHint[] 供 PromptBuilder 使用。规则是辅助而非决策，最终场景判断仍由 AI 完成。
 */
export class SceneDetector {
  /**
   * Detects all applicable scenes from a list of requests.
   * 检测场景：一次分析可命中多个场景（如登录 + AI对话）
   *
   * 优化：单次遍历所有请求，为每个请求生成所有匹配的场景，避免 O(11N) 复杂度
   */
  detect(requests: FilteredRequest[]): SceneHint[] {
    const scenesMap = new Map<string, { hint: SceneHint; count: number }>()
    const trackScenes: SceneHint[] = []

    // 单次遍历所有请求
    for (const req of requests) {
      // AI Chat - SSE 响应
      if (this.isSSEResponse(req) && this.matchesAiApiPattern(req)) {
        this.addSceneHint(scenesMap, 'ai-chat', 'high', 'SSE 响应检测到 text/event-stream', req.seq)
      }

      // AI Chat - API 路径特征
      if (this.matchesAiApiPattern(req)) {
        this.addSceneHint(scenesMap, 'ai-chat', 'high', 'API 特征路径检测', req.seq)
      }

      // AI Chat - 请求体特征
      if (this.hasAiPayloadFields(req)) {
        this.addSceneHint(scenesMap, 'ai-chat', 'medium', 'AI 典型字段', req.seq)
      }

      // OAuth 场景
      if (this.matchesOAuthPattern(req)) {
        this.addSceneHint(scenesMap, 'auth-oauth', 'high', '/oauth 路径或 redirect_uri 参数', req.seq)
      }

      // Token 鉴权
      if (this.hasTokenInResponse(req) || this.hasBearerAuth(req)) {
        this.addSceneHint(scenesMap, 'auth-token', 'high', 'Token 鉴权', req.seq)
      }

      // Session 鉴权
      if (this.hasSessionCookie(req)) {
        this.addSceneHint(scenesMap, 'auth-session', 'medium', 'Set-Cookie 响应', req.seq)
      }

      // 注册场景
      if (this.matchesRegistrationPattern(req)) {
        this.addSceneHint(scenesMap, 'registration', 'high', '/register|/signup 路径和 email/password 字段', req.seq)
      }

      // 登录场景
      if (this.matchesLoginPattern(req)) {
        this.addSceneHint(scenesMap, 'login', 'high', '/login|/signin 路径和 password 字段', req.seq)
      }

      // WebSocket 场景
      if (this.isWebSocketRequest(req)) {
        this.addSceneHint(scenesMap, 'websocket', 'high', 'Upgrade: websocket 请求头', req.seq)
      }

      // SSE 流场景 - 仅在非 AI Chat 时标记为 sse-stream
      if (this.isSSEResponse(req) && !this.matchesAiApiPattern(req)) {
        this.addSceneHint(scenesMap, 'sse-stream', 'high', 'SSE 流响应', req.seq)
      }

      // 通用 API 场景
      if (this.isJsonResponse(req)) {
        this.addSceneHint(scenesMap, 'api-general', 'low', 'JSON API 请求/响应', req.seq)
      }

      // 加密操作场景
      if (this.hasCryptoHooks(req)) {
        this.addSceneHint(scenesMap, 'crypto-encryption', 'high', '检测到加密/签名/哈希操作 Hook', req.seq)
      }

      // 签名请求头场景
      if (this.hasSignatureHeaders(req)) {
        this.addSceneHint(scenesMap, 'crypto-encryption', 'medium', '请求包含签名/加密相关 Header', req.seq)
      }
    }

    return Array.from(scenesMap.values()).map(entry => entry.hint)
  }

  /**
   * 辅助方法：添加或更新场景
   */
  private addSceneHint(
    scenesMap: Map<string, { hint: SceneHint; count: number }>,
    scene: string,
    confidence: 'high' | 'medium' | 'low',
    evidence: string,
    requestSeq: number
  ): void {
    const key = `${scene}:${confidence}`
    const existing = scenesMap.get(key)

    if (existing) {
      existing.count++
      if (!existing.hint.relatedRequestIds.includes(`#${requestSeq}`)) {
        existing.hint.relatedRequestIds.push(`#${requestSeq}`)
      }
    } else {
      scenesMap.set(key, {
        hint: {
          scene,
          confidence,
          evidence,
          relatedRequestIds: [`#${requestSeq}`]
        },
        count: 1
      })
    }
  }

  /**
   * 检查请求是否为 SSE 响应
   */
  private isSSEResponse(req: FilteredRequest): boolean {
    const contentType = req.responseHeaders?.['content-type']?.toLowerCase() || ''
    return contentType.includes('text/event-stream')
  }

  /**
   * 检查请求是否匹配 AI API 路径特征
   */
  private matchesAiApiPattern(req: FilteredRequest): boolean {
    const aiPatterns = [
      '/chat/completions',
      '/v1/messages',
      '/v1/chat/completions',
      '/api/chat',
      '/api/completions',
      '/openai/v1',
      '/claude/messages',
      '/generate'
    ]
    return aiPatterns.some(pattern => req.url.toLowerCase().includes(pattern.toLowerCase()))
  }

  /**
   * 检查请求体是否包含 AI 典型字段
   */
  private hasAiPayloadFields(req: FilteredRequest): boolean {
    if (!req.body) return false
    try {
      const bodyObj = JSON.parse(req.body)
      const bodyStr = JSON.stringify(bodyObj).toLowerCase()
      const aiPayloadPatterns = ['messages', 'model', 'stream', 'temperature', 'max_tokens', 'prompt']
      const matchCount = aiPayloadPatterns.filter(p => bodyStr.includes(p.toLowerCase())).length
      return matchCount >= 2
    } catch {
      return false
    }
  }

  /**
   * 检查请求是否匹配 OAuth 模式
   */
  private matchesOAuthPattern(req: FilteredRequest): boolean {
    const oauthPatterns = ['/oauth/authorize', '/oauth/token', '/oauth2/authorize', '/oauth2/token']
    const urlLower = req.url.toLowerCase()
    const hasOAuthPath = oauthPatterns.some(p => urlLower.includes(p.toLowerCase()))
    const hasRedirectUri = urlLower.includes('redirect_uri')
    return hasOAuthPath || hasRedirectUri
  }

  /**
   * 检查响应中是否有 Token（严格的 JSON 字段检查）
   */
  private hasTokenInResponse(req: FilteredRequest): boolean {
    if (!req.responseBody) return false
    try {
      const bodyObj = JSON.parse(req.responseBody)
      return !!(
        bodyObj?.access_token ||
        bodyObj?.refresh_token ||
        bodyObj?.token ||
        bodyObj?.auth_token ||
        bodyObj?.id_token
      )
    } catch {
      return false
    }
  }

  /**
   * 检查请求中是否有 Bearer Token（严格检查）
   */
  private hasBearerAuth(req: FilteredRequest): boolean {
    const authHeader = Object.entries(req.headers || {}).find(
      ([key]) => key.toLowerCase() === 'authorization'
    )?.[1] || ''
    return authHeader.toLowerCase().startsWith('bearer ') && authHeader.length > 10
  }

  /**
   * 检查是否是注册请求
   */
  private matchesRegistrationPattern(req: FilteredRequest): boolean {
    const regPatterns = ['/register', '/signup', '/sign-up', '/user/register', '/api/register']
    const urlLower = req.url.toLowerCase()
    const hasRegPath = regPatterns.some(p => urlLower.includes(p.toLowerCase()))

    if (!hasRegPath) return false

    if (req.method !== 'POST') return false

    // 检查请求体是否包含 email/password
    if (req.body) {
      const bodyLower = req.body.toLowerCase()
      return bodyLower.includes('email') || bodyLower.includes('password')
    }

    return false
  }

  /**
   * 检查是否是登录请求
   */
  private matchesLoginPattern(req: FilteredRequest): boolean {
    const loginPatterns = ['/login', '/signin', '/sign-in', '/user/login', '/api/login', '/auth/login']
    const urlLower = req.url.toLowerCase()
    const hasLoginPath = loginPatterns.some(p => urlLower.includes(p.toLowerCase()))

    if (!hasLoginPath) return false

    if (req.method !== 'POST') return false

    // 检查请求体是否包含 password
    if (req.body) {
      const bodyLower = req.body.toLowerCase()
      return bodyLower.includes('password') || bodyLower.includes('passwd')
    }

    return false
  }

  /**
   * 检查是否是 WebSocket 请求
   */
  private isWebSocketRequest(req: FilteredRequest): boolean {
    const upgrade = Object.entries(req.headers || {}).find(
      ([key]) => key.toLowerCase() === 'upgrade'
    )?.[1]
    return upgrade?.toLowerCase() === 'websocket'
  }

  /**
   * 检查是否有 Session Cookie
   */
  private hasSessionCookie(req: FilteredRequest): boolean {
    const cookie = Object.entries(req.headers || {}).find(
      ([key]) => key.toLowerCase() === 'cookie'
    )?.[1]
    return !!cookie
  }

  /**
   * 检查是否是 JSON 响应
   */
  private isJsonResponse(req: FilteredRequest): boolean {
    const contentType = req.responseHeaders?.['content-type']?.toLowerCase() || ''
    return contentType.includes('json') || Boolean(
      req.responseBody && this.isJsonString(req.responseBody)
    )
  }


  /**
   * 检查字符串是否为有效的 JSON
   */
  private isJsonString(str: string): boolean {
    try {
      JSON.parse(str)
      return true
    } catch {
      return false
    }
  }

  /**
   * 检查请求是否关联了加密类 Hook
   */
  private hasCryptoHooks(req: FilteredRequest): boolean {
    return req.hooks.some(h => h.hook_type === 'crypto' || h.hook_type === 'crypto_lib')
  }

  /**
   * 检查请求头中是否有签名/加密相关 Header
   */
  private hasSignatureHeaders(req: FilteredRequest): boolean {
    const signatureHeaders = ['x-signature', 'x-sign', 'x-timestamp', 'x-nonce', 'x-request-sign', 'signature']
    return Object.keys(req.headers || {}).some(
      key => signatureHeaders.includes(key.toLowerCase())
    )
  }
}
