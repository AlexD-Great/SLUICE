import { authenticateUser } from '@/lib/sluice/auth'
import { handler, json, readJsonBody, requireString } from '@/lib/sluice/http'
import { ensureUser, issueWalletNonce, linkWallet, operatorAddress } from '@/lib/sluice/users'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/v1/account/wallet
 *
 * Step one of linking: issue a challenge for the user to sign.
 *
 * Signing costs no gas and authorises nothing — it only proves control of the
 * address. Spending rights are a separate, explicit on-chain grant.
 */
export const POST = handler(async (request) => {
  const identity = await authenticateUser(request)
  await ensureUser(identity)

  const body = await readJsonBody(request)
  const address = requireString(body, 'address')

  const { message, nonce } = await issueWalletNonce(identity.uid, address)
  return json({ message, nonce, operatorAddress: operatorAddress() })
})

/**
 * PUT /api/v1/account/wallet
 *
 * Step two: verify the signature and bind the address to the account.
 */
export const PUT = handler(async (request) => {
  const identity = await authenticateUser(request)

  const body = await readJsonBody(request)
  const address = requireString(body, 'address')
  const signature = requireString(body, 'signature')

  const user = await linkWallet({ uid: identity.uid, address, signature })

  return json({
    user: {
      uid: user.uid,
      walletAddress: user.walletAddress,
      walletLinkedAt: user.walletLinkedAt,
      operatorApproval: user.operatorApproval,
    },
    operatorAddress: operatorAddress(),
    ready: user.operatorApproval?.approved === true,
  })
})
