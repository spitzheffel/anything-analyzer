/** A timeout abandons a command result; it does not claim to cancel Chromium. */
export async function withCaptureDeadline<Value>(operation: Promise<Value>, timeoutMs: number, label: string): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), timeoutMs)
  })
  try { return await Promise.race([operation, deadline]) }
  finally { if (timer) clearTimeout(timer) }
}
