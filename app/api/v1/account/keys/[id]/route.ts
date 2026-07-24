import { getApiKeys } from '@/lib/firebase/admin'
import { authenticateUser } from '@/lib/sluice/auth'
import { errors, handler, json } from '@/lib/sluice/http'
import type { ApiKey } from '@/lib/sluice/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * DELETE /api/v1/account/keys/:id
 *
 * Revokes rather than deletes: the key's authorizations stay in the audit trail
 * and remain attributable.
 */
export const DELETE = handler(async (request, context: { params: Promise<{ id: string }> }) => {
  const identity = await authenticateUser(request)
  const { id } = await context.params

  const ref = getApiKeys().doc(id)
  const snapshot = await ref.get()
  if (!snapshot.exists) throw errors.notFound('No such key.')

  const key = snapshot.data() as ApiKey
  if (key.ownerUid !== identity.uid) {
    // Do not confirm the key exists to someone who does not own it.
    throw errors.notFound('No such key.')
  }

  await ref.update({ revoked: true })
  return json({ id, revoked: true })
})
