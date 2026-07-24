import { createHash } from 'node:crypto'

import { COLLECTIONS, db } from '@/lib/firebase/admin'
import { errors } from '@/lib/sluice/http'

/**
 * Idempotency for /pay/authorize.
 *
 * Agents retry on timeout, and a retried payment is a double spend. A caller
 * supplying `Idempotency-Key` gets the original authorization back instead of a
 * second one.
 */

interface IdempotencyRecord {
  apiKeyId: string
  requestHash: string
  authorizationId: string
  createdAt: number
}

/** Scope keys per API key so two agents cannot collide on the same key string. */
function recordId(apiKeyId: string, idempotencyKey: string): string {
  return createHash('sha256').update(`${apiKeyId}:${idempotencyKey}`, 'utf8').digest('hex')
}

/** Fingerprint of the request body, to detect a key reused with different parameters. */
export function fingerprint(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null), 'utf8').digest('hex')
}

export function readIdempotencyKey(request: Request): string | null {
  const value = request.headers.get('idempotency-key')
  return value != null && value.trim() !== '' ? value.trim() : null
}

/**
 * Claim an idempotency key.
 *
 * Returns the existing authorization id when this is a replay. Throws 409 when
 * the same key is reused with a different body — silently returning the old
 * result there would hide a real bug in the caller.
 */
export async function claimIdempotencyKey(options: {
  apiKeyId: string
  idempotencyKey: string
  requestHash: string
  authorizationId: string
}): Promise<{ replayed: true; authorizationId: string } | { replayed: false }> {
  const ref = db().collection(COLLECTIONS.idempotency).doc(recordId(options.apiKeyId, options.idempotencyKey))

  return db().runTransaction(async (tx) => {
    const snapshot = await tx.get(ref)
    if (snapshot.exists) {
      const existing = snapshot.data() as IdempotencyRecord
      if (existing.requestHash !== options.requestHash) {
        throw errors.conflict(
          'This Idempotency-Key was already used with different request parameters. Use a fresh key for a different request.',
          { authorizationId: existing.authorizationId }
        )
      }
      return { replayed: true as const, authorizationId: existing.authorizationId }
    }

    const record: IdempotencyRecord = {
      apiKeyId: options.apiKeyId,
      requestHash: options.requestHash,
      authorizationId: options.authorizationId,
      createdAt: Date.now(),
    }
    tx.set(ref, record)
    return { replayed: false as const }
  })
}

/** Drop a claim when the authorization never made it to storage, so the caller can retry cleanly. */
export async function releaseIdempotencyKey(apiKeyId: string, idempotencyKey: string): Promise<void> {
  try {
    await db().collection(COLLECTIONS.idempotency).doc(recordId(apiKeyId, idempotencyKey)).delete()
  } catch (error) {
    console.error('[sluice] failed to release idempotency key', error)
  }
}
