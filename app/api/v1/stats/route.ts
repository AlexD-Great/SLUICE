import { getAuthorizations, getVerifications } from '@/lib/firebase/admin'
import { handler, json } from '@/lib/sluice/http'
import { formatUsdfc } from '@/lib/sluice/synapse'
import type { Authorization } from '@/lib/sluice/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/v1/stats
 *
 * Aggregate counters for the public landing page. Deliberately totals only —
 * no per-key figures, no request parameters, nothing that identifies a caller.
 */
export const GET = handler(async () => {
  const [authSnapshot, verifySnapshot] = await Promise.all([
    getAuthorizations().orderBy('createdAt', 'desc').limit(500).get(),
    getVerifications().orderBy('checkedAt', 'desc').limit(500).get(),
  ])

  const rows = authSnapshot.docs.map((doc) => doc.data() as Authorization)

  let releasedRaw = 0n
  let gated = 0
  let executed = 0
  for (const row of rows) {
    if (row.status === 'executed') {
      executed += 1
      releasedRaw += BigInt(row.amount?.raw ?? '0')
    }
    // "Gated" means a human was required — the number that makes the point.
    if (!row.autoApproved) gated += 1
  }

  const healthy = verifySnapshot.docs.filter((doc) => doc.data().status === 'healthy').length

  return json(
    {
      payments: { total: rows.length, executed, gated },
      releasedUsdfc: formatUsdfc(releasedRaw),
      proofChecks: { total: verifySnapshot.size, healthy },
      network: 'filecoin-calibration',
    },
    { headers: { 'cache-control': 'public, max-age=30, stale-while-revalidate=120' } }
  )
})
