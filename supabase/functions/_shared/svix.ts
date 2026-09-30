// Verifies a Svix-signed webhook request (what Resend uses). The signature is
// HMAC-SHA256 over "<svix-id>.<svix-timestamp>.<raw body>", keyed with the base64-decoded
// signing secret ("whsec_..."). The header may carry several space-separated "v1,<sig>" values.
export async function verifySvixSignature(
  secret: string,
  h: { id: string | null; timestamp: string | null; signature: string | null },
  rawBody: string,
  nowMs = Date.now(),
  toleranceSec = 300,
): Promise<boolean> {
  if (!h.id || !h.timestamp || !h.signature) return false
  const ts = Number(h.timestamp)
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > toleranceSec) return false

  const keyBytes = Uint8Array.from(atob(secret.startsWith('whsec_') ? secret.slice(6) : secret), c => c.charCodeAt(0))
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${h.id}.${h.timestamp}.${rawBody}`))
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)))

  let ok = false
  for (const part of h.signature.split(' ')) {
    const [version, sig] = part.split(',')
    if (version !== 'v1' || !sig || sig.length !== expected.length) continue
    let diff = 0
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i)
    if (diff === 0) ok = true
  }
  return ok
}
