import { cert, getApp, getApps, initializeApp, type App } from 'firebase-admin/app'
import { getAuth, type Auth } from 'firebase-admin/auth'
import { FieldValue, getFirestore, type Firestore } from 'firebase-admin/firestore'

import { env } from '@/lib/sluice/env'

const APP_NAME = 'sluice-admin'

/**
 * Admin SDK singleton.
 *
 * Serverless invocations reuse a warm module scope, so guard against
 * re-initialising the app on every request.
 */
function adminApp(): App {
  const existing = getApps().find((app) => app.name === APP_NAME)
  if (existing != null) return existing

  const { projectId, clientEmail, privateKey } = env.firebaseServiceAccount
  return initializeApp({ credential: cert({ projectId, clientEmail, privateKey }), projectId }, APP_NAME)
}

let firestoreInstance: Firestore | null = null

export function db(): Firestore {
  if (firestoreInstance == null) {
    firestoreInstance = getFirestore(adminApp())
    // Firestore rejects `undefined` by default, which turns an optional request
    // field into a 500. Treat it as "leave the field off" instead.
    firestoreInstance.settings({ ignoreUndefinedProperties: true })
  }
  return firestoreInstance
}

export function adminAuth(): Auth {
  return getAuth(adminApp())
}

export { FieldValue }

/** Collection names, centralised so the rules file and the code cannot drift apart. */
export const COLLECTIONS = {
  users: 'users',
  /** Single-use wallet-link challenges, keyed by uid. */
  walletNonces: 'walletNonces',
  apiKeys: 'apiKeys',
  authorizations: 'authorizations',
  pieces: 'pieces',
  verifications: 'verifications',
  auditLog: 'auditLog',
  locks: 'locks',
  idempotency: 'idempotency',
  stats: 'stats',
  /** Bytes for held uploads. Never readable by a browser — see firestore.rules. */
  payloads: 'payloads',
} as const

export function getApiKeys() {
  return db().collection(COLLECTIONS.apiKeys)
}

export function getAuthorizations() {
  return db().collection(COLLECTIONS.authorizations)
}

export function getPieces() {
  return db().collection(COLLECTIONS.pieces)
}

export function getVerifications() {
  return db().collection(COLLECTIONS.verifications)
}

export function getAuditLog() {
  return db().collection(COLLECTIONS.auditLog)
}

export function getPayloads() {
  return db().collection(COLLECTIONS.payloads)
}

/** Best-effort audit trail. Never allowed to fail a request. */
export async function audit(entry: {
  action: string
  actor: string
  authorizationId?: string
  detail?: Record<string, unknown>
}): Promise<void> {
  try {
    await getAuditLog().add({ ...entry, at: Date.now() })
  } catch (error) {
    console.error('[sluice] audit write failed', error)
  }
}

export { getApp }
