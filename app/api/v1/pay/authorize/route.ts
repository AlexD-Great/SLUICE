import { audit } from '@/lib/firebase/admin'
import {
  createAuthorizationWithId,
  getAuthorization,
  reserveAuthorizationId,
  runAuthorization,
  toPublic,
} from '@/lib/sluice/authorizations'
import { assertWithinDailyBudget, authenticate, capForKey, isUnderCap } from '@/lib/sluice/auth'
import { env } from '@/lib/sluice/env'
import { resolveRequest, stashPayload } from '@/lib/sluice/executor'
import { claimIdempotencyKey, fingerprint, readIdempotencyKey, releaseIdempotencyKey } from '@/lib/sluice/idempotency'
import { errors, handler, json, readJsonBody } from '@/lib/sluice/http'
import { requirePayer } from '@/lib/sluice/users'
import type { Authorization, PaymentKind } from '@/lib/sluice/types'
import { PAYMENT_KINDS, WALLET_ACTIONS } from '@/lib/sluice/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
/** Uploads talk to a storage provider and then to the chain; give them room. */
export const maxDuration = 300

/**
 * POST /api/v1/pay/authorize
 *
 * The gate. Prices the request against the key owner's Filecoin Pay account,
 * compares it to the key's cap, and either executes it immediately or parks it
 * for the account owner to approve.
 *
 * Sluice signs as an approved operator on that account — it never holds the
 * user's key, and the contract independently enforces the allowances the user
 * granted.
 */
export const POST = handler(async (request) => {
  const apiKey = await authenticate(request)
  const body = await readJsonBody(request)

  const kind = body.kind
  if (typeof kind !== 'string' || !PAYMENT_KINDS.includes(kind as PaymentKind)) {
    // Point the caller at the browser when they ask for something only the
    // payer's own wallet can sign, rather than a bare "unsupported kind".
    if (typeof kind === 'string' && (WALLET_ACTIONS as readonly string[]).includes(kind)) {
      throw errors.badRequest(
        `"${kind}" must be signed by your own wallet — Filecoin Pay restricts it to the account holder. ` +
          'Do it from the dashboard.'
      )
    }
    throw errors.badRequest(`Field "kind" must be one of: ${PAYMENT_KINDS.join(', ')}.`)
  }

  // The account behind the key. Re-read rather than trusting the key's cached
  // copy, so a re-linked wallet takes effect immediately.
  const payer = await requirePayer(apiKey.ownerUid)

  const idempotencyKey = readIdempotencyKey(request)
  const requestHash = fingerprint(body)
  const authorizationId = reserveAuthorizationId()

  // Claim the idempotency key before doing any work, so two concurrent retries
  // cannot both get past this point.
  if (idempotencyKey != null) {
    const claim = await claimIdempotencyKey({
      apiKeyId: apiKey.id,
      idempotencyKey,
      requestHash,
      authorizationId,
    })
    if (claim.replayed) {
      const existing = await getAuthorization(claim.authorizationId)
      return json({ authorization: toPublic(existing), replayed: true })
    }
  }

  try {
    const resolved = await resolveRequest(kind as PaymentKind, body, payer)

    const capUsdfc = capForKey(apiKey)
    const underCap = isUnderCap(resolved.amount.usdfc, capUsdfc)

    await assertWithinDailyBudget(apiKey, BigInt(resolved.amount.raw))

    const now = Date.now()
    const record: Omit<Authorization, 'id'> = {
      kind: resolved.kind,
      status: underCap ? 'pending' : 'pending_approval',
      params: resolved.params,
      amount: resolved.amount,
      capUsdfc,
      autoApproved: underCap,
      apiKeyId: apiKey.id,
      apiKeyLabel: apiKey.label,
      ownerUid: apiKey.ownerUid,
      payerAddress: resolved.kind === 'store' ? String(resolved.params.payer) : payer,
      idempotencyKey,
      txHash: null,
      explorerUrl: null,
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      decidedAt: null,
      decidedBy: null,
      decidedByEmail: null,
      expiresAt: now + env.approvalTtlMinutes * 60 * 1000,
    }

    // Park the bytes before the record exists, so an approver can never see a
    // held upload whose payload was lost.
    if (resolved.payload != null && !underCap) {
      await stashPayload(authorizationId, resolved.payload)
    }

    const authorization = await createAuthorizationWithId(authorizationId, record)
    await audit({
      action: underCap ? 'authorization.auto_approved' : 'authorization.held',
      actor: apiKey.label,
      authorizationId,
      detail: { kind: resolved.kind, amountUsdfc: resolved.amount.usdfc, capUsdfc, payer },
    })

    if (!underCap) {
      // 202: accepted, but nothing has moved. The caller polls /pay/status/:id.
      return json(
        {
          authorization: toPublic(authorization),
          message:
            `Amount ${resolved.amount.usdfc} USDFC exceeds this key's cap of ${capUsdfc} USDFC. ` +
            `Held for approval by the account owner — poll /api/v1/pay/status/${authorizationId}.`,
        },
        { status: 202 }
      )
    }

    const executed = await runAuthorization(authorization, resolved.payload)
    return json({ authorization: toPublic(executed) }, { status: executed.status === 'failed' ? 502 : 200 })
  } catch (error) {
    // Free the key so a corrected retry is not blocked by a request that never
    // produced an authorization.
    if (idempotencyKey != null) await releaseIdempotencyKey(apiKey.id, idempotencyKey)
    throw error
  }
})
