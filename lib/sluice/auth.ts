import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import { adminAuth, getApiKeys, getAuthorizations } from '@/lib/firebase/admin'
import { env } from '@/lib/sluice/env'
import { errors, type SluiceError } from '@/lib/sluice/http'
import { compareUsdfc, formatUsdfc, parseUsdfc } from '@/lib/sluice/synapse'
import type { ApiKey } from '@/lib/sluice/types'

const KEY_PREFIX = 'sluice_sk_'

/** Per-request cap applied to a freshly minted key when the user names none. */
export const DEFAULT_KEY_CAP_USDFC = '1'

/** Hash a plaintext key. Keys are high-entropy random, so a plain SHA-256 is appropriate here. */
export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex')
}

/** Mint a new plaintext API key. Shown to the operator once, then only its hash is retained. */
export function generateApiKey(): string {
  return KEY_PREFIX + randomBytes(24).toString('base64url')
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Authenticate a caller from the `Authorization: Bearer` header.
 *
 * The lookup is by hash, so a stolen database dump does not yield usable keys.
 */
export async function authenticate(request: Request): Promise<ApiKey> {
  const header = request.headers.get('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (match == null) {
    throw errors.unauthorized('Provide your key as "Authorization: Bearer sluice_sk_...".')
  }

  const hash = hashApiKey(match[1].trim())
  const snapshot = await getApiKeys().where('hash', '==', hash).limit(1).get()
  if (snapshot.empty) throw errors.unauthorized()

  const doc = snapshot.docs[0]
  const key = { id: doc.id, ...doc.data() } as ApiKey

  // Defence in depth: the query already matched on hash, but compare again in
  // constant time so the code does not rely solely on Firestore's equality.
  if (!constantTimeEqual(key.hash, hash)) throw errors.unauthorized()
  if (key.revoked) throw errors.forbidden('This API key has been revoked.')

  // Fire-and-forget; a failed telemetry write must not fail the request.
  doc.ref.update({ lastUsedAt: Date.now() }).catch(() => {})

  return key
}

/** The per-request cap this key is judged against, falling back to the global default. */
export function capForKey(key: ApiKey): string {
  return key.capUsdfc && key.capUsdfc.trim() !== '' ? key.capUsdfc : env.defaultCapUsdfc
}

/**
 * Enforce the rolling 24h budget for a key.
 *
 * Counts every authorization that has moved money or is committed to moving it,
 * so an in-flight request cannot be raced past the budget by a parallel caller.
 */
export async function assertWithinDailyBudget(key: ApiKey, incomingRaw: bigint): Promise<void> {
  if (key.dailyBudgetUsdfc == null || key.dailyBudgetUsdfc.trim() === '') return

  const since = Date.now() - 24 * 60 * 60 * 1000
  const snapshot = await getAuthorizations()
    .where('apiKeyId', '==', key.id)
    .where('createdAt', '>=', since)
    .get()

  const counted = new Set(['executed', 'executing', 'approved', 'pending', 'pending_approval'])
  let spent = 0n
  for (const doc of snapshot.docs) {
    const data = doc.data() as { status?: string; amount?: { raw?: string } }
    if (data.status != null && counted.has(data.status) && data.amount?.raw != null) {
      spent += BigInt(data.amount.raw)
    }
  }

  const budget = parseUsdfc(key.dailyBudgetUsdfc, 'dailyBudgetUsdfc')
  if (spent + incomingRaw > budget) {
    throw errors.tooManyRequests(
      `Daily budget exceeded for this key: ${formatUsdfc(spent)} USDFC committed in the last 24h, ` +
        `${formatUsdfc(incomingRaw)} USDFC requested, budget ${key.dailyBudgetUsdfc} USDFC.`
    )
  }
}

/** True when the resolved amount clears the key's cap and may execute without a human. */
export function isUnderCap(amountUsdfc: string, capUsdfc: string): boolean {
  return compareUsdfc(amountUsdfc, capUsdfc) <= 0
}

export interface Operator {
  uid: string
  email: string | null
  displayName: string | null
}

/**
 * Verify a Firebase Auth ID token.
 *
 * Establishes *who* the caller is. It does not by itself grant the right to
 * spend — that comes from the on-chain operator grant on the user's own
 * account, and from owning the authorization being approved.
 */
export async function authenticateUser(request: Request): Promise<Operator> {
  const header = request.headers.get('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (match == null) {
    throw errors.unauthorized('This endpoint requires a Firebase ID token in the Authorization header.')
  }

  const token = match[1].trim()

  // Resolve the Admin SDK outside the try: a broken service account throws
  // here, and folding that into the catch below would report a configuration
  // problem as "invalid token" — which is what sent us hunting the wrong bug.
  const auth = adminAuth()

  let decoded: { uid: string; email?: string; name?: string }
  try {
    decoded = await auth.verifyIdToken(token, true)
  } catch (error) {
    throw explainTokenFailure(token, error)
  }

  return {
    uid: decoded.uid,
    email: decoded.email?.toLowerCase() ?? null,
    displayName: decoded.name ?? null,
  }
}

/** Read a JWT's claims without verifying it. Only ever used to explain *why* verification failed. */
function peekClaims(token: string): { aud?: string; iss?: string; exp?: number } | null {
  try {
    const payload = token.split('.')[1]
    if (payload == null) return null
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

/**
 * Turn a Firebase verification failure into something actionable.
 *
 * "Invalid or expired" is true of every failure here and useless for all of
 * them — the two that actually happen in a fresh deployment are a project
 * mismatch and clock skew, and neither is guessable from that message.
 */
function explainTokenFailure(token: string, error: unknown): SluiceError {
  const code = (error as { code?: string }).code ?? ''
  const message = error instanceof Error ? error.message : String(error)
  console.error('[sluice] verifyIdToken failed', { code, message })

  const claims = peekClaims(token)

  // The single most common misconfiguration: the browser's NEXT_PUBLIC_FIREBASE_*
  // config and the server's FIREBASE_SERVICE_ACCOUNT_KEY come from different
  // Firebase projects, so the token's audience never matches.
  if (claims?.aud != null) {
    let serverProject: string | null = null
    try {
      serverProject = env.firebaseServiceAccount.projectId
    } catch {
      serverProject = null
    }
    if (serverProject != null && claims.aud !== serverProject) {
      return errors.unauthorized(
        `This token was issued for Firebase project "${claims.aud}" but the server is configured for ` +
          `"${serverProject}". NEXT_PUBLIC_FIREBASE_PROJECT_ID and FIREBASE_SERVICE_ACCOUNT_KEY must ` +
          'come from the same project.'
      )
    }
  }

  if (code.includes('id-token-expired')) {
    return errors.unauthorized('Firebase ID token has expired. Sign in again.')
  }
  if (code.includes('id-token-revoked')) {
    return errors.unauthorized('This session was revoked. Sign in again.')
  }
  if (/used too early|clock/i.test(message)) {
    return errors.unauthorized(
      'Firebase rejected the token as issued in the future — the server clock is skewed. Check the host time.'
    )
  }
  if (code.includes('invalid-credential') || /Credential implementation/i.test(message)) {
    return errors.unauthorized(
      'The server could not authenticate to Firebase. Check FIREBASE_SERVICE_ACCOUNT_KEY is a valid, current service account key.'
    )
  }

  return errors.unauthorized(`Firebase rejected the ID token${code === '' ? '' : ` (${code})`}: ${message}`)
}

/**
 * Verify the caller may approve a specific held payment.
 *
 * In the multi-tenant model the approver is simply the account whose funds are
 * at stake — nobody else's opinion is relevant, and no allowlist is needed.
 * `SLUICE_OPERATOR_*` still applies as an override for single-tenant
 * deployments where one team runs the gateway on a shared wallet.
 */
export async function authenticateApprover(
  request: Request,
  authorization: { ownerUid: string }
): Promise<Operator> {
  const user = await authenticateUser(request)

  if (user.uid === authorization.ownerUid) return user

  // Escape hatch for a shared-wallet deployment: a named operator may approve
  // on behalf of the account that owns the key.
  const uids = env.operatorUids
  const emails = env.operatorEmails
  const override = uids.includes(user.uid) || (user.email != null && emails.includes(user.email))
  if (override) return user

  throw errors.forbidden('Only the account that owns this request can approve it.')
}
