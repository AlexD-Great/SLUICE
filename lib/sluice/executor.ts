import type { Address, Hash } from 'viem'
import { getTransactionReceipt } from 'viem/actions'

import { getPayloads, getPieces } from '@/lib/firebase/admin'
import { errors } from '@/lib/sluice/http'
import { withWalletLock } from '@/lib/sluice/lock'
import {
  assertOperatorCanSpend,
  createRail,
  modifyRailRate,
  payOnRail,
  setRailLockup,
  terminateRail,
} from '@/lib/sluice/operator'
import { explorerTxUrl, formatUsdfc, parseUsdfc, synapse, walletAddress } from '@/lib/sluice/synapse'
import { assertAddress } from '@/lib/sluice/users'
import type { Authorization, PaymentKind, ResolvedAmount } from '@/lib/sluice/types'

/**
 * Cap on inline payloads.
 *
 * Held uploads park their bytes in a Firestore document until a human decides,
 * and a document is capped at 1 MiB — base64 inflates by a third, so 512 KiB of
 * payload is the largest that reliably fits alongside the rest of the record.
 */
export const MAX_STORE_BYTES = 512 * 1024

/**
 * Floor on inline payloads.
 *
 * PDP providers reject pieces below 127 bytes, and that rejection only surfaces
 * mid-upload as an opaque 502. Checking here turns it into a clear 400 before
 * anything is priced or signed.
 */
export const MIN_STORE_BYTES = 127

/**
 * A validated, priced request — everything needed to decide whether a human
 * must approve, resolved before a single byte is signed.
 */
export interface ResolvedRequest {
  kind: PaymentKind
  /** Normalised parameters, safe to persist and show to an approver. */
  params: Record<string, unknown>
  amount: ResolvedAmount
  /** Payload held out of Firestore; only `store` uses it. */
  payload?: Uint8Array
}

function bigintFromString(value: string, field: string): bigint {
  if (!/^\d+$/.test(value.trim())) {
    throw errors.badRequest(`Field "${field}" must be a non-negative integer string.`)
  }
  return BigInt(value.trim())
}

function amountFromRaw(raw: bigint, basis: ResolvedAmount['basis'], note?: string): ResolvedAmount {
  return { raw: raw.toString(), usdfc: formatUsdfc(raw), basis, note }
}

/**
 * Validate and price a request against the payer's account.
 *
 * Nothing is signed here. The on-chain allowance check runs at this point too,
 * so a caller learns it is out of allowance before a human is asked to approve
 * something that would revert.
 */
export async function resolveRequest(
  kind: PaymentKind,
  body: Record<string, unknown>,
  payer: Address
): Promise<ResolvedRequest> {
  const client = synapse()

  switch (kind) {
    case 'pay': {
      const to = assertAddress(String(body.to ?? ''))
      const amount = requireAmount(body, 'amount')
      const railId = body.railId == null ? undefined : bigintFromString(String(body.railId), 'railId')

      // Fail early and clearly rather than letting the contract revert with
      // OperatorLockupAllowanceExceeded after gas has been spent.
      const approval = await assertOperatorCanSpend(payer, amount)

      return {
        kind,
        params: {
          to,
          amount: formatUsdfc(amount),
          railId: railId?.toString(),
          payer,
        },
        amount: amountFromRaw(
          amount,
          'stated',
          `Pays ${formatUsdfc(amount)} USDFC to ${to} from ${payer}. ` +
            `${approval.lockupUsageUsdfc} of ${approval.lockupAllowanceUsdfc} USDFC allowance in use.`
        ),
      }
    }

    case 'modify_rate': {
      const railId = bigintFromString(String(body.railId ?? ''), 'railId')
      const ratePerEpoch = requireAmount(body, 'ratePerEpoch', { allowZero: true })

      return {
        kind,
        params: { railId: railId.toString(), ratePerEpoch: formatUsdfc(ratePerEpoch), payer },
        // A rate is a commitment per epoch, not a one-off transfer. Judge it on
        // the rate itself; the lockup allowance bounds the total exposure.
        amount: amountFromRaw(
          ratePerEpoch,
          'rate_change',
          `Sets rail ${railId} to stream ${formatUsdfc(ratePerEpoch)} USDFC per epoch.`
        ),
      }
    }

    case 'terminate_rail': {
      const railId = bigintFromString(String(body.railId ?? ''), 'railId')
      return {
        kind,
        params: { railId: railId.toString(), payer },
        // Closing a rail stops future spend; there is nothing to cap.
        amount: amountFromRaw(0n, 'none', `Terminates rail ${railId}.`),
      }
    }

    case 'store': {
      if (typeof body.dataBase64 !== 'string' || body.dataBase64.trim() === '') {
        throw errors.badRequest('Field "dataBase64" is required and must be base64-encoded data.')
      }
      let payload: Uint8Array
      try {
        payload = new Uint8Array(Buffer.from(body.dataBase64, 'base64'))
      } catch {
        throw errors.badRequest('Field "dataBase64" is not valid base64.')
      }
      if (payload.byteLength === 0) {
        throw errors.badRequest('Field "dataBase64" decoded to zero bytes.')
      }
      if (payload.byteLength < MIN_STORE_BYTES) {
        throw errors.badRequest(
          `Payload is ${payload.byteLength} bytes; PDP providers require at least ${MIN_STORE_BYTES}. Pad the data before storing.`
        )
      }
      if (payload.byteLength > MAX_STORE_BYTES) {
        throw errors.badRequest(
          `Payload is ${payload.byteLength} bytes; the limit is ${MAX_STORE_BYTES}. Upload larger data with the Synapse SDK directly.`
        )
      }
      const label = body.label == null ? undefined : String(body.label).slice(0, 200)

      let costs
      try {
        costs = await client.storage.getUploadCosts({ dataSize: BigInt(payload.byteLength) })
      } catch (error) {
        throw errors.upstream('Could not estimate storage cost.', {
          cause: error instanceof Error ? error.message : String(error),
        })
      }

      return {
        kind,
        params: {
          sizeBytes: payload.byteLength,
          label,
          ratePerEpoch: costs.rates.perEpoch.toString(),
          ratePerMonth: costs.rates.perMonth.toString(),
          depositNeeded: costs.depositNeeded.toString(),
          ready: costs.ready,
          // Storage runs on the gateway's own Warm Storage account — see the
          // note on `execute`. Recorded so the dashboard does not imply
          // otherwise.
          payer: walletAddress(),
          onGatewayAccount: true,
        },
        payload,
        amount: amountFromRaw(
          costs.lockups.total,
          'upload_estimate',
          `Storing ${payload.byteLength} bytes locks ${formatUsdfc(costs.lockups.total)} USDFC and streams ${formatUsdfc(costs.rates.perMonth)} USDFC/month.`
        ),
      }
    }

    default: {
      throw errors.badRequest(`Unsupported payment kind "${kind}".`)
    }
  }
}

function requireAmount(
  body: Record<string, unknown>,
  field: string,
  options: { allowZero?: boolean } = {}
): bigint {
  const value = body[field]
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw errors.badRequest(`Field "${field}" is required (a decimal USDFC string such as "0.5").`)
  }
  let parsed: bigint
  try {
    parsed = parseUsdfc(String(value), field)
  } catch (error) {
    throw errors.badRequest(error instanceof Error ? error.message : `Field "${field}" is invalid.`)
  }
  if (parsed < 0n || (parsed === 0n && options.allowZero !== true)) {
    throw errors.badRequest(`Field "${field}" must be greater than zero.`)
  }
  return parsed
}

export interface ExecutionOutcome {
  txHash: string
  explorerUrl: string
  result: Record<string, unknown>
}

/**
 * Broadcast the transaction for an authorization.
 *
 * Sluice signs with its own key throughout, acting as an approved operator on
 * the payer's Filecoin Pay account. The funds are the user's; the signature is
 * Sluice's; the ceilings are enforced by the contract.
 *
 * Returns as soon as the transaction is sent. Calibration produces a block
 * roughly every 30 seconds, which is longer than a serverless invocation should
 * sit blocked, so confirmation is picked up later by `confirmIfMined`.
 */
export async function execute(
  authorization: Pick<Authorization, 'id' | 'kind' | 'params' | 'amount' | 'payerAddress'>,
  payload?: Uint8Array
): Promise<ExecutionOutcome> {
  return withWalletLock(async () => {
    const client = synapse()
    const params = authorization.params
    const payer = authorization.payerAddress as Address

    switch (authorization.kind) {
      case 'pay': {
        const amountRaw = BigInt(authorization.amount.raw)

        // Re-check at execution time: an approval may have sat pending for an
        // hour, and the user could have lowered or revoked the grant since.
        await assertOperatorCanSpend(payer, amountRaw)

        let railId: bigint
        let railTxHash: string | null = null

        if (params.railId != null) {
          railId = BigInt(String(params.railId))
        } else {
          const created = await createRail({ payer, payee: String(params.to) as Address })
          railId = created.railId
          railTxHash = created.txHash
        }

        // Cover the payment with fixed lockup first. A new rail has none, and a
        // reused one spent its last payment's lockup, so this applies either way.
        const lockupTxHash = await setRailLockup({ railId, lockupFixed: amountRaw })

        const txHash = await payOnRail({ railId, amountRaw })

        return {
          txHash,
          explorerUrl: explorerTxUrl(txHash),
          result: {
            kind: 'pay',
            railId: railId.toString(),
            to: params.to,
            payer,
            amountUsdfc: authorization.amount.usdfc,
            // Surfaced so a repeat caller can skip rail creation next time.
            railCreatedTx: railTxHash,
            railLockupTx: lockupTxHash,
            reusableRailId: railId.toString(),
          },
        }
      }

      case 'modify_rate': {
        const txHash = await modifyRailRate({
          railId: BigInt(String(params.railId)),
          ratePerEpoch: parseUsdfc(String(params.ratePerEpoch), 'ratePerEpoch'),
        })
        return {
          txHash,
          explorerUrl: explorerTxUrl(txHash),
          result: { kind: 'modify_rate', railId: params.railId, ratePerEpoch: params.ratePerEpoch, payer },
        }
      }

      case 'terminate_rail': {
        const txHash = await terminateRail({ railId: BigInt(String(params.railId)) })
        return {
          txHash,
          explorerUrl: explorerTxUrl(txHash),
          result: { kind: 'terminate_rail', railId: params.railId, payer },
        }
      }

      case 'store': {
        const bytes = payload ?? (await loadPayload(authorization.id))
        if (bytes == null) {
          throw errors.notFound('The payload for this store request is no longer available. Re-submit the upload.')
        }

        // Storage runs on the gateway's own Warm Storage account rather than the
        // user's. Uploading as another party needs a session key, and the SDK's
        // session-key permissions (CreateDataSet, AddPieces,
        // SchedulePieceRemovals, TerminateService) are storage-only and separate
        // from the payments grant — so this stays gateway-owned for now.
        const uploaded = await client.storage.upload(bytes, {
          pieceMetadata: params.label == null ? undefined : { label: String(params.label) },
        })
        const pieceCid = uploaded.pieceCid.toString()
        const primary = uploaded.copies[0] ?? null

        if (primary != null) {
          await getPieces()
            .doc(pieceCid)
            .set({
              pieceCid,
              dataSetId: primary.dataSetId.toString(),
              providerId: primary.providerId.toString(),
              sizeBytes: uploaded.size,
              label: params.label == null ? null : String(params.label),
              uploadedAt: Date.now(),
              authorizationId: authorization.id,
            })
            .catch((error) => console.error('[sluice] failed to cache piece mapping', error))
        }

        return {
          txHash: '',
          explorerUrl: '',
          result: {
            kind: 'store',
            pieceCid,
            size: uploaded.size,
            complete: uploaded.complete,
            copies: uploaded.copies.map((copy) => ({
              providerId: copy.providerId.toString(),
              dataSetId: copy.dataSetId.toString(),
              pieceId: copy.pieceId.toString(),
              retrievalUrl: copy.retrievalUrl,
            })),
            verifyUrl: `/api/v1/verify/${pieceCid}`,
          },
        }
      }

      default: {
        throw errors.badRequest(`Unsupported payment kind "${authorization.kind}".`)
      }
    }
  })
}

/**
 * Check whether a broadcast transaction has landed.
 *
 * Called from the polling endpoints so an agent's own `/pay/status` loop drives
 * confirmation, with no background worker to keep alive on Vercel.
 */
export async function confirmIfMined(
  txHash: string
): Promise<{ mined: false } | { mined: true; success: boolean; reason?: string }> {
  if (txHash === '') return { mined: false }
  try {
    // A single lookup rather than `waitForTransactionReceipt`: this runs inside
    // a request, so it must return now, not block for the next ~30s block.
    const receipt = await getTransactionReceipt(synapse().client, { hash: txHash as Hash })
    return receipt.status === 'success'
      ? { mined: true, success: true }
      : { mined: true, success: false, reason: 'Transaction reverted on-chain.' }
  } catch {
    // Not yet mined, or the RPC is briefly unavailable — either way, keep waiting.
    return { mined: false }
  }
}

/** Park an over-cap upload's bytes until a human decides. Kept out of the authorization doc so the dashboard never downloads them. */
export async function stashPayload(authorizationId: string, payload: Uint8Array): Promise<void> {
  await getPayloads()
    .doc(authorizationId)
    .set({ dataBase64: Buffer.from(payload).toString('base64'), createdAt: Date.now() })
}

async function loadPayload(authorizationId: string): Promise<Uint8Array | null> {
  const snapshot = await getPayloads().doc(authorizationId).get()
  if (!snapshot.exists) return null
  const { dataBase64 } = snapshot.data() as { dataBase64?: string }
  if (dataBase64 == null) return null
  return new Uint8Array(Buffer.from(dataBase64, 'base64'))
}

/** Drop a stashed payload once the request reaches a terminal state. */
export async function discardPayload(authorizationId: string): Promise<void> {
  try {
    await getPayloads().doc(authorizationId).delete()
  } catch (error) {
    console.error('[sluice] failed to discard payload', error)
  }
}
