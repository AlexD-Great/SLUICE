import { randomUUID } from 'node:crypto'

import { COLLECTIONS, db } from '@/lib/firebase/admin'
import { errors } from '@/lib/sluice/http'

/**
 * Serialises on-chain writes across concurrent serverless invocations.
 *
 * Every transaction from Sluice's wallet uses the same nonce sequence, so two
 * invocations signing at once produce a collision and one of them reverts.
 * Vercel gives no cross-invocation memory, so the mutex lives in Firestore and
 * is acquired inside a transaction to make check-and-set atomic.
 */

const LOCK_ID = 'wallet-tx'

/** Long enough for a slow Calibration confirmation, short enough that a crashed holder frees up quickly. */
const DEFAULT_TTL_MS = 120_000
const ACQUIRE_TIMEOUT_MS = 25_000
const RETRY_DELAY_MS = 400

function lockRef() {
  return db().collection(COLLECTIONS.locks).doc(LOCK_ID)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function tryAcquire(holder: string, ttlMs: number): Promise<boolean> {
  const ref = lockRef()
  return db().runTransaction(async (tx) => {
    const snapshot = await tx.get(ref)
    const now = Date.now()
    const current = snapshot.exists ? (snapshot.data() as { holder: string; expiresAt: number }) : null

    // A live lock held by someone else blocks us; an expired one is reclaimable
    // so a crashed invocation cannot wedge the wallet permanently.
    if (current != null && current.expiresAt > now && current.holder !== holder) {
      return false
    }

    tx.set(ref, { holder, acquiredAt: now, expiresAt: now + ttlMs })
    return true
  })
}

/**
 * Run `fn` while holding the wallet lock.
 *
 * The lock is always released, including on failure — otherwise one reverted
 * transaction would stall every subsequent payment until the TTL elapsed.
 */
export async function withWalletLock<T>(fn: () => Promise<T>, ttlMs: number = DEFAULT_TTL_MS): Promise<T> {
  const holder = randomUUID()
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS

  let acquired = false
  while (!acquired) {
    acquired = await tryAcquire(holder, ttlMs)
    if (acquired) break
    if (Date.now() >= deadline) {
      throw errors.tooManyRequests(
        'Another payment is currently being signed. Retry in a few seconds — Sluice signs one transaction at a time to avoid nonce collisions.'
      )
    }
    await sleep(RETRY_DELAY_MS)
  }

  try {
    return await fn()
  } finally {
    try {
      await db().runTransaction(async (tx) => {
        const snapshot = await tx.get(lockRef())
        // Only release our own lock: if the TTL expired and someone else took
        // over, deleting here would let a third invocation in alongside them.
        if (snapshot.exists && (snapshot.data() as { holder: string }).holder === holder) {
          tx.delete(lockRef())
        }
      })
    } catch (error) {
      console.error('[sluice] failed to release wallet lock', error)
    }
  }
}
