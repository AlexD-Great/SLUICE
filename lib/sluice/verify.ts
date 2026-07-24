import type { Address } from 'viem'

import { getPieces, getVerifications } from '@/lib/firebase/admin'
import { errors } from '@/lib/sluice/http'
import { synapse, walletAddress } from '@/lib/sluice/synapse'
import type { PieceRecord, VerificationResult } from '@/lib/sluice/types'

/**
 * PieceCID sanity check.
 *
 * PDP addresses pieces by PieceCID (`bafkzcib...`), not the IPFS CID people
 * usually paste. Rejecting early gives a clear message instead of an opaque
 * failure several RPC calls later.
 */
export function assertPieceCid(value: string): string {
  const trimmed = value.trim()
  if (!trimmed.startsWith('bafkzc')) {
    throw errors.badRequest(
      `"${trimmed}" is not a PieceCID. PDP proofs are addressed by PieceCID (starts with "bafkzc"), not an IPFS CID. ` +
        'The PieceCID is returned by POST /pay/authorize with kind "store".'
    )
  }
  return trimmed
}

/**
 * Resolve which data set holds a piece.
 *
 * There is no global CID -> provider index on Filecoin, so this leans on the
 * mapping cached at upload time and falls back to scanning the data sets owned
 * by `client` — which is why a third-party lookup needs `?client=0x...`.
 */
async function resolveDataSetId(pieceCid: string, client: Address): Promise<string | null> {
  const cached = await getPieces().doc(pieceCid).get()
  if (cached.exists) {
    const record = cached.data() as PieceRecord
    if (record.dataSetId != null) return record.dataSetId
  }

  const dataSets = await synapse().storage.findDataSets({ address: client })
  for (const dataSet of dataSets) {
    if (!dataSet.isLive) continue
    try {
      const context = await synapse().storage.createContext({ dataSetId: dataSet.pdpVerifierDataSetId })
      const status = await context.pieceStatus({ pieceCid })
      if (status != null) {
        const dataSetId = dataSet.pdpVerifierDataSetId.toString()
        // Cache so the next lookup is a single read rather than another scan.
        await getPieces()
          .doc(pieceCid)
          .set(
            {
              pieceCid,
              dataSetId,
              providerId: null,
              sizeBytes: 0,
              label: null,
              uploadedAt: Date.now(),
              authorizationId: null,
            },
            { merge: true }
          )
          .catch(() => {})
        return dataSetId
      }
    } catch {
      // A data set we cannot open is not a failure of the lookup itself.
      continue
    }
  }
  return null
}

/**
 * Live PDP proof status for a piece.
 *
 * Proofs are submitted per data set, not per piece, so the timestamps here
 * describe the data set that contains the piece.
 */
export async function verifyPiece(pieceCidInput: string, clientAddress?: string): Promise<VerificationResult> {
  const pieceCid = assertPieceCid(pieceCidInput)

  if (clientAddress != null && !/^0x[0-9a-fA-F]{40}$/.test(clientAddress)) {
    throw errors.badRequest('Query parameter "client" must be a 0x-prefixed address.')
  }
  const client = (clientAddress ?? walletAddress()) as Address

  const dataSetId = await resolveDataSetId(pieceCid, client)

  const base: VerificationResult = {
    pieceCid,
    dataSetId,
    healthy: false,
    status: 'unknown',
    dataSetLastProven: null,
    dataSetNextProofDue: null,
    inChallengeWindow: false,
    hoursUntilChallengeWindow: 0,
    isProofOverdue: false,
    retrievalUrl: null,
    pieceId: null,
    checkedAt: Date.now(),
  }

  if (dataSetId == null) {
    await recordVerification(base)
    return base
  }

  let status
  try {
    const context = await synapse().storage.createContext({ dataSetId: BigInt(dataSetId) })
    status = await context.pieceStatus({ pieceCid })
  } catch (error) {
    throw errors.upstream('Could not read proof status from the Warm Storage contract.', {
      cause: error instanceof Error ? error.message : String(error),
    })
  }

  if (status == null) {
    await recordVerification(base)
    return base
  }

  const isProofOverdue = status.isProofOverdue ?? false
  const result: VerificationResult = {
    ...base,
    healthy: !isProofOverdue,
    status: isProofOverdue ? 'stale' : 'healthy',
    dataSetLastProven: status.dataSetLastProven?.toISOString() ?? null,
    dataSetNextProofDue: status.dataSetNextProofDue?.toISOString() ?? null,
    inChallengeWindow: status.inChallengeWindow ?? false,
    hoursUntilChallengeWindow: status.hoursUntilChallengeWindow ?? 0,
    isProofOverdue,
    retrievalUrl: status.retrievalUrl,
    pieceId: status.pieceId?.toString() ?? null,
  }

  await recordVerification(result)
  return result
}

/** Append to the verification feed the dashboard renders. Best effort. */
async function recordVerification(result: VerificationResult): Promise<void> {
  try {
    await getVerifications().add(result)
  } catch (error) {
    console.error('[sluice] failed to record verification', error)
  }
}
