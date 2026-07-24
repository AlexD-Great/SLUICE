import { env } from '@/lib/sluice/env'
import { handler, json } from '@/lib/sluice/http'
import { formatUsdfc, synapse, walletAddress } from '@/lib/sluice/synapse'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/v1/health
 *
 * Wallet and escrow balances on Calibration. Unauthenticated: it exposes only
 * an address and balances that are already public on-chain, and being able to
 * check "is the gateway funded?" without a key is the point.
 */
export const GET = handler(async () => {
  const client = synapse()

  const [escrow, wallet, fil] = await Promise.all([
    client.payments.balance().catch(() => null),
    client.payments.walletBalance({ token: 'USDFC' }).catch(() => null),
    client.payments.walletBalance({ token: 'FIL' }).catch(() => null),
  ])

  const funded = (fil ?? 0n) > 0n && ((wallet ?? 0n) > 0n || (escrow ?? 0n) > 0n)

  // Both project ids, side by side. A token is rejected whenever these differ,
  // and comparing them by hand across two dashboards is needlessly painful.
  let serverProject: string | null = null
  let serverProjectError: string | null = null
  try {
    serverProject = env.firebaseServiceAccount.projectId
  } catch (error) {
    serverProjectError = error instanceof Error ? error.message : String(error)
  }
  const browserProject = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? null

  return json({
    ok: true,
    network: 'filecoin-calibration',
    chainId: client.chain.id,
    wallet: walletAddress(),
    firebase: {
      serverProjectId: serverProject,
      browserProjectId: browserProject,
      /** False means every ID token will be rejected on an audience mismatch. */
      projectsMatch: serverProject != null && browserProject != null && serverProject === browserProject,
      error: serverProjectError,
    },
    balances: {
      escrowUsdfc: escrow == null ? null : formatUsdfc(escrow),
      walletUsdfc: wallet == null ? null : formatUsdfc(wallet),
      walletFil: fil == null ? null : formatUsdfc(fil),
    },
    funded,
    hint: funded
      ? undefined
      : 'Wallet needs tFIL for gas and tUSDFC for payments. See https://faucet.calibnet.chainsafe-fil.io and the USDFC faucet.',
  })
})
