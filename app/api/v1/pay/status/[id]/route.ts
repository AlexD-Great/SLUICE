import { getAuthorization, refreshAuthorization, toPublic } from '@/lib/sluice/authorizations'
import { authenticate } from '@/lib/sluice/auth'
import { errors, handler, json } from '@/lib/sluice/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/v1/pay/status/:id
 *
 * The polling endpoint an agent waits on. Also where a broadcast transaction
 * gets confirmed and a stale approval request gets expired — the caller's own
 * poll loop drives that work, so no background worker is needed.
 */
export const GET = handler(async (request, context: { params: Promise<{ id: string }> }) => {
  const apiKey = await authenticate(request)
  const { id } = await context.params

  const authorization = await getAuthorization(id)

  // A key may only see its own requests; ids are opaque but not secret.
  if (authorization.apiKeyId !== apiKey.id) {
    throw errors.notFound(`No authorization with id "${id}".`)
  }

  const refreshed = await refreshAuthorization(authorization)
  return json({ authorization: toPublic(refreshed) })
})
