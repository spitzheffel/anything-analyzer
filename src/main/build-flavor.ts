declare const __AA_BUILD_CHANNEL__: 'public' | 'internal'

export type BuildChannel = 'public' | 'internal'

/** This value is compiled into the bundle and cannot be widened at runtime. */
export const BUILD_CHANNEL: BuildChannel =
  typeof __AA_BUILD_CHANNEL__ === 'undefined' ? 'public' : __AA_BUILD_CHANNEL__
export const CLOAK_BACKEND_AVAILABLE = BUILD_CHANNEL === 'internal'
