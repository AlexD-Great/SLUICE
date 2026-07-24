import { handler, json } from '@/lib/sluice/http'
import { verifyPiece } from '@/lib/sluice/verify'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/v1/verify/:pieceCid
 *
 * Plain JSON PDP proof status. Unauthenticated on purpose: it is a read-only
 * chain query that spends nothing, and the whole point is that any script can
 * call it without a wallet, an SDK or a key.
 *
 * Optional `?client=0x...` verifies pieces held in another address's data sets;
 * defaults to Sluice's own wallet.
 */
export const GET = handler(async (request, context: { params: Promise<{ pieceCid: string }> }) => {
  const { pieceCid } = await context.params
  const client = new URL(request.url).searchParams.get('client') ?? undefined

  const result = await verifyPiece(decodeURIComponent(pieceCid), client ?? undefined)

  return json(result, {
    headers: {
      // Proofs move on the order of a proving period; a few seconds of caching
      // protects the RPC without making the answer misleading.
      'cache-control': 'public, max-age=15, stale-while-revalidate=60',
    },
  })
})
