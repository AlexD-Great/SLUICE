import { getAuthorizations } from '@/lib/firebase/admin'
import { refreshAuthorization, toPublic } from '@/lib/sluice/authorizations'
import { authenticate } from '@/lib/sluice/auth'
import { handler, json } from '@/lib/sluice/http'
import type { Authorization, AuthStatus } from '@/lib/sluice/types'
import { AUTH_STATUSES } from '@/lib/sluice/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/v1/pay/list?status=&limit=
 *
 * The calling key's own history. The dashboard does not use this — it reads
 * Firestore directly for realtime updates — but a script polling from Python does.
 */
export const GET = handler(async (request) => {
  const apiKey = await authenticate(request)
  const url = new URL(request.url)

  const statusFilter = url.searchParams.get('status')
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? '25') || 25, 1), 100)

  let query = getAuthorizations().where('apiKeyId', '==', apiKey.id).orderBy('createdAt', 'desc').limit(limit)
  if (statusFilter != null && AUTH_STATUSES.includes(statusFilter as AuthStatus)) {
    query = getAuthorizations()
      .where('apiKeyId', '==', apiKey.id)
      .where('status', '==', statusFilter)
      .orderBy('createdAt', 'desc')
      .limit(limit)
  }

  const snapshot = await query.get()
  const authorizations = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Authorization)

  // Confirm anything still in flight so a list poll is as useful as a status poll.
  const refreshed = await Promise.all(
    authorizations.map((authorization) =>
      authorization.status === 'executing' || authorization.status === 'pending_approval'
        ? refreshAuthorization(authorization)
        : Promise.resolve(authorization)
    )
  )

  return json({ authorizations: refreshed.map(toPublic), count: refreshed.length })
})
