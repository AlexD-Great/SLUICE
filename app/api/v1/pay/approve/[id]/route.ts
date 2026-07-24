import { authenticateApprover } from '@/lib/sluice/auth'
import { decide, getAuthorization, toPublic } from '@/lib/sluice/authorizations'
import { errors, handler, json, readJsonBody } from '@/lib/sluice/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
/** Approving kicks off the on-chain work, so allow the same budget as /authorize. */
export const maxDuration = 300

/**
 * POST /api/v1/pay/approve/:id
 *
 * The human side of the gate. Requires the Firebase ID token of the account
 * whose funds are at stake — an API key is deliberately not enough, otherwise
 * the agent being gated could release its own payment.
 */
export const POST = handler(async (request, context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params

  // Load first: who may approve depends on who owns the request.
  const authorization = await getAuthorization(id)
  const operator = await authenticateApprover(request, authorization)

  const body = await readJsonBody(request).catch(() => ({}) as Record<string, unknown>)
  const decision = body.decision ?? 'approve'
  if (decision !== 'approve' && decision !== 'reject') {
    throw errors.badRequest('Field "decision" must be "approve" or "reject".')
  }

  const decided = await decide(id, operator, decision)
  return json({ authorization: toPublic(decided) })
})
