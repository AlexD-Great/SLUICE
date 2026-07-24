import { getApiKeys } from '@/lib/firebase/admin'
import { DEFAULT_KEY_CAP_USDFC, authenticateUser, generateApiKey, hashApiKey } from '@/lib/sluice/auth'
import { errors, handler, json, optionalString, readJsonBody } from '@/lib/sluice/http'
import { parseUsdfc } from '@/lib/sluice/synapse'
import { requirePayer } from '@/lib/sluice/users'
import type { ApiKey } from '@/lib/sluice/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Never leak the hash to the browser — the plaintext is shown once, at creation. */
function publicKey(key: ApiKey) {
  return {
    id: key.id,
    label: key.label,
    capUsdfc: key.capUsdfc,
    dailyBudgetUsdfc: key.dailyBudgetUsdfc,
    payerAddress: key.payerAddress,
    revoked: key.revoked,
    createdAt: new Date(key.createdAt).toISOString(),
    lastUsedAt: key.lastUsedAt == null ? null : new Date(key.lastUsedAt).toISOString(),
  }
}

/** GET /api/v1/account/keys — the signed-in user's keys. */
export const GET = handler(async (request) => {
  const identity = await authenticateUser(request)

  const snapshot = await getApiKeys().where('ownerUid', '==', identity.uid).get()
  const keys = snapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }) as ApiKey)
    .sort((a, b) => b.createdAt - a.createdAt)

  return json({ keys: keys.map(publicKey) })
})

/**
 * POST /api/v1/account/keys — mint a key.
 *
 * Requires a linked wallet: a key with no payer account behind it could never
 * spend anything, and failing here is clearer than failing at first use.
 */
export const POST = handler(async (request) => {
  const identity = await authenticateUser(request)
  const payerAddress = await requirePayer(identity.uid)

  const body = await readJsonBody(request).catch(() => ({}) as Record<string, unknown>)
  const label = optionalString(body, 'label') ?? 'agent key'
  const capUsdfc = optionalString(body, 'capUsdfc') ?? DEFAULT_KEY_CAP_USDFC
  const dailyBudgetUsdfc = optionalString(body, 'dailyBudgetUsdfc') ?? null

  // Validate now so a malformed cap cannot silently disable the gate later.
  try {
    parseUsdfc(capUsdfc, 'capUsdfc')
    if (dailyBudgetUsdfc != null) parseUsdfc(dailyBudgetUsdfc, 'dailyBudgetUsdfc')
  } catch (error) {
    throw errors.badRequest(error instanceof Error ? error.message : 'Invalid cap.')
  }

  const plaintext = generateApiKey()
  const record: Omit<ApiKey, 'id'> = {
    label: label.slice(0, 80),
    hash: hashApiKey(plaintext),
    ownerUid: identity.uid,
    payerAddress,
    capUsdfc,
    dailyBudgetUsdfc,
    revoked: false,
    createdAt: Date.now(),
    lastUsedAt: null,
  }

  const ref = await getApiKeys().add(record)

  return json(
    {
      // The only time the plaintext exists outside the caller's hands.
      key: plaintext,
      apiKey: publicKey({ id: ref.id, ...record }),
      note: 'Copy this key now — only its hash is stored, so it cannot be shown again.',
    },
    { status: 201 }
  )
})
