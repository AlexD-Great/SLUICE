import { audit, db, getAuthorizations } from '@/lib/firebase/admin'
import type { Operator } from '@/lib/sluice/auth'
import { confirmIfMined, discardPayload, execute } from '@/lib/sluice/executor'
import { errors } from '@/lib/sluice/http'
import type { Authorization, AuthStatus } from '@/lib/sluice/types'
import { TERMINAL_STATUSES } from '@/lib/sluice/types'

export async function getAuthorization(id: string): Promise<Authorization> {
  const snapshot = await getAuthorizations().doc(id).get()
  if (!snapshot.exists) throw errors.notFound(`No authorization with id "${id}".`)
  return { id: snapshot.id, ...snapshot.data() } as Authorization
}

/** Reserve a document id up front, so the payload stash and idempotency claim can reference it. */
export function reserveAuthorizationId(): string {
  return getAuthorizations().doc().id
}

export async function createAuthorizationWithId(id: string, record: Omit<Authorization, 'id'>): Promise<Authorization> {
  await getAuthorizations().doc(id).set(record)
  return { id, ...record }
}

async function patch(id: string, fields: Partial<Authorization>): Promise<void> {
  await getAuthorizations()
    .doc(id)
    .update({ ...fields, updatedAt: Date.now() })
}

/**
 * Run the on-chain work for an authorization and record the outcome.
 *
 * The status moves to `executing` before anything is signed so a crash mid-flight
 * leaves a visible in-progress record rather than a request that silently vanished.
 */
export async function runAuthorization(
  authorization: Authorization,
  payload?: Uint8Array
): Promise<Authorization> {
  await patch(authorization.id, { status: 'executing' })

  try {
    const outcome = await execute(authorization, payload)

    // `store` completes through the storage flow rather than a single
    // transaction, so it is already final once execute() returns.
    const status: AuthStatus = authorization.kind === 'store' ? 'executed' : 'executing'

    const fields: Partial<Authorization> = {
      status,
      txHash: outcome.txHash === '' ? null : outcome.txHash,
      explorerUrl: outcome.explorerUrl === '' ? null : outcome.explorerUrl,
      result: outcome.result,
      error: null,
    }
    await patch(authorization.id, fields)
    await discardPayload(authorization.id)
    await audit({ action: 'authorization.executed', actor: 'sluice', authorizationId: authorization.id })

    return { ...authorization, ...fields, updatedAt: Date.now() } as Authorization
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await patch(authorization.id, { status: 'failed', error: message })
    await discardPayload(authorization.id)
    await audit({
      action: 'authorization.failed',
      actor: 'sluice',
      authorizationId: authorization.id,
      detail: { message },
    })
    return { ...authorization, status: 'failed', error: message } as Authorization
  }
}

/**
 * Bring an authorization up to date before returning it.
 *
 * Confirms broadcast transactions and expires stale approval requests, so the
 * polling endpoints do this work without a background job.
 */
export async function refreshAuthorization(authorization: Authorization): Promise<Authorization> {
  if (authorization.status === 'executing' && authorization.txHash != null) {
    const receipt = await confirmIfMined(authorization.txHash)
    if (receipt.mined) {
      const fields: Partial<Authorization> = receipt.success
        ? { status: 'executed', error: null }
        : { status: 'failed', error: receipt.reason ?? 'Transaction reverted.' }
      await patch(authorization.id, fields)
      return { ...authorization, ...fields } as Authorization
    }
    return authorization
  }

  if (authorization.status === 'pending_approval' && Date.now() > authorization.expiresAt) {
    await patch(authorization.id, { status: 'expired', error: 'Expired before a human approved it.' })
    await discardPayload(authorization.id)
    return { ...authorization, status: 'expired', error: 'Expired before a human approved it.' } as Authorization
  }

  return authorization
}

/**
 * Record a human decision.
 *
 * The read and the write happen in one Firestore transaction: two operators
 * clicking Approve at the same moment must not both succeed and release funds twice.
 */
export async function decide(
  id: string,
  operator: Operator,
  decision: 'approve' | 'reject'
): Promise<Authorization> {
  const ref = getAuthorizations().doc(id)

  const authorization = await db().runTransaction(async (tx) => {
    const snapshot = await tx.get(ref)
    if (!snapshot.exists) throw errors.notFound(`No authorization with id "${id}".`)

    const current = { id: snapshot.id, ...snapshot.data() } as Authorization

    if (current.status !== 'pending_approval') {
      if (TERMINAL_STATUSES.includes(current.status)) {
        throw errors.conflict(`This request is already ${current.status} and cannot be changed.`, {
          status: current.status,
        })
      }
      throw errors.conflict(`This request is ${current.status}, not awaiting approval.`, { status: current.status })
    }

    if (Date.now() > current.expiresAt) {
      tx.update(ref, { status: 'expired', error: 'Expired before a human approved it.', updatedAt: Date.now() })
      throw errors.conflict('This request expired before it was approved.')
    }

    const fields = {
      status: decision === 'approve' ? ('approved' as const) : ('rejected' as const),
      decidedAt: Date.now(),
      decidedBy: operator.uid,
      decidedByEmail: operator.email,
      updatedAt: Date.now(),
    }
    tx.update(ref, fields)
    return { ...current, ...fields } as Authorization
  })

  await audit({
    action: decision === 'approve' ? 'authorization.approved' : 'authorization.rejected',
    actor: operator.email ?? operator.uid,
    authorizationId: id,
    detail: { amountUsdfc: authorization.amount.usdfc, kind: authorization.kind },
  })

  if (decision === 'reject') {
    await discardPayload(id)
    return authorization
  }

  return runAuthorization(authorization)
}

/** Public shape returned to API callers — internal bookkeeping stays out of it. */
export function toPublic(authorization: Authorization) {
  return {
    id: authorization.id,
    kind: authorization.kind,
    status: authorization.status,
    amount: authorization.amount,
    capUsdfc: authorization.capUsdfc,
    autoApproved: authorization.autoApproved,
    params: authorization.params,
    txHash: authorization.txHash,
    explorerUrl: authorization.explorerUrl,
    result: authorization.result,
    error: authorization.error,
    createdAt: new Date(authorization.createdAt).toISOString(),
    updatedAt: new Date(authorization.updatedAt).toISOString(),
    decidedAt: authorization.decidedAt == null ? null : new Date(authorization.decidedAt).toISOString(),
    expiresAt: new Date(authorization.expiresAt).toISOString(),
    /** True while the caller should keep polling /pay/status/:id. */
    pending: !TERMINAL_STATUSES.includes(authorization.status),
  }
}
