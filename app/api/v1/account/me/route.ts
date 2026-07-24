import { authenticateUser } from '@/lib/sluice/auth'
import { handler, json } from '@/lib/sluice/http'
import { ensureUser, getUser, operatorAddress, refreshOperatorApproval } from '@/lib/sluice/users'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/v1/account/me
 *
 * The dashboard's bootstrap call: creates the account record on first sign-in
 * and reports the live on-chain operator grant.
 */
export const GET = handler(async (request) => {
  const identity = await authenticateUser(request)
  const user = await ensureUser(identity)

  // Read the grant from the chain when a wallet is linked, so a revoke made
  // directly in the user's wallet shows up here rather than going unnoticed.
  let current = user
  if (user.walletAddress != null) {
    current = await refreshOperatorApproval(identity.uid).catch(() => user)
  }

  return json({
    user: {
      uid: current.uid,
      email: current.email,
      displayName: current.displayName,
      walletAddress: current.walletAddress,
      walletLinkedAt: current.walletLinkedAt,
      operatorApproval: current.operatorApproval,
    },
    /** The address the user must approve as operator on Filecoin Pay. */
    operatorAddress: operatorAddress(),
    ready: current.walletAddress != null && current.operatorApproval?.approved === true,
  })
})

/** POST refreshes the cached grant without waiting for a page load. */
export const POST = handler(async (request) => {
  const identity = await authenticateUser(request)
  const existing = await getUser(identity.uid)
  if (existing?.walletAddress == null) {
    return json({ user: existing, operatorAddress: operatorAddress(), ready: false })
  }
  const user = await refreshOperatorApproval(identity.uid)
  return json({
    user,
    operatorAddress: operatorAddress(),
    ready: user.operatorApproval?.approved === true,
  })
})
