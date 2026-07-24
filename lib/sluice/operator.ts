import * as Pay from '@filoz/synapse-core/pay'
import type { Address, Hash } from 'viem'
import { parseEventLogs } from 'viem'
import { simulateContract, waitForTransactionReceipt, writeContract } from 'viem/actions'

import { errors } from '@/lib/sluice/http'
import { formatUsdfc, parseUsdfc, synapse, walletAddress } from '@/lib/sluice/synapse'
import type { OperatorApproval } from '@/lib/sluice/types'

/**
 * Acting as an approved operator on a user's Filecoin Pay account.
 *
 * The user grants this with `setOperatorApproval(USDFC, sluiceWallet, true,
 * rateAllowance, lockupAllowance, maxLockupPeriod)` from their own wallet.
 * Sluice then signs with its own key on the user's behalf, and the contract
 * enforces the ceilings — `OperatorRateAllowanceExceeded`,
 * `OperatorLockupAllowanceExceeded`, `LockupPeriodExceedsOperatorMaximum`.
 *
 * What an operator deliberately cannot do: `withdraw` and `withdrawTo` revert
 * with `CallerNotPayer`. Sluice can direct a user's funds through rails but can
 * never pull them out to itself.
 *
 * These calls go straight to the contract because the SDK's PaymentsService
 * only wraps the payer-side operations, not the operator-side ones.
 */

function payContract() {
  const chain = synapse().chain
  return chain.contracts.filecoinPay
}

function usdfcAddress(): Address {
  return synapse().chain.contracts.usdfc.address
}

/** Read the user's live grant to Sluice. Never trust the browser for this. */
export async function readOperatorApproval(payer: Address): Promise<OperatorApproval> {
  const result = await Pay.operatorApprovals(synapse().client, {
    address: payer,
    operator: walletAddress(),
  })

  return {
    approved: result.isApproved,
    rateAllowanceUsdfc: formatUsdfc(result.rateAllowance),
    lockupAllowanceUsdfc: formatUsdfc(result.lockupAllowance),
    rateUsageUsdfc: formatUsdfc(result.rateUsage),
    lockupUsageUsdfc: formatUsdfc(result.lockupUsage),
    maxLockupPeriod: result.maxLockupPeriod.toString(),
    checkedAt: Date.now(),
  }
}

/**
 * Confirm Sluice may still spend `amount` on this account.
 *
 * The contract enforces this anyway, but checking first turns a reverted
 * transaction and a wasted gas fee into a clear 403 the caller can act on.
 */
export async function assertOperatorCanSpend(payer: Address, amountRaw: bigint): Promise<OperatorApproval> {
  const approval = await readOperatorApproval(payer)

  if (!approval.approved) {
    throw errors.forbidden(
      'Sluice is not an approved operator on this account. Connect your wallet and grant operator access before an agent can spend.'
    )
  }

  const remaining = parseUsdfc(approval.lockupAllowanceUsdfc) - parseUsdfc(approval.lockupUsageUsdfc)
  if (remaining < amountRaw) {
    throw errors.forbidden(
      `This payment needs ${formatUsdfc(amountRaw)} USDFC of lockup allowance but only ` +
        `${formatUsdfc(remaining)} USDFC remains of the ${approval.lockupAllowanceUsdfc} USDFC granted. ` +
        'Raise the operator allowance from the dashboard.'
    )
  }

  return approval
}

/**
 * Open a payment channel from the user to a recipient.
 *
 * Rails are the unit Filecoin Pay works in — there is no bare transfer. An
 * agent paying the same recipient repeatedly should keep the rail id and reuse
 * it rather than paying for a new one each time.
 */
export async function createRail(options: { payer: Address; payee: Address }): Promise<{
  txHash: Hash
  railId: bigint
}> {
  const client = synapse().client
  const contract = payContract()

  const { request, result } = await simulateContract(client, {
    address: contract.address,
    abi: contract.abi,
    functionName: 'createRail',
    args: [
      usdfcAddress(),
      options.payer,
      options.payee,
      // No validator: this is a direct agent-to-recipient payment, not a
      // service rail where delivery has to be attested before funds release.
      '0x0000000000000000000000000000000000000000',
      0n,
      '0x0000000000000000000000000000000000000000',
    ],
    account: client.account,
  })

  const txHash = await writeContract(client, request)

  // createRail returns the id, but only a mined receipt proves it. Wait here —
  // the caller cannot use a rail id that might not exist.
  const receipt = await waitForTransactionReceipt(client, { hash: txHash })
  if (receipt.status !== 'success') {
    throw errors.upstream('Rail creation reverted on-chain.')
  }

  return { txHash, railId: result as bigint }
}

/**
 * Pay `amountRaw` immediately on an existing rail.
 *
 * `oneTimePayment` is the only immediate-transfer primitive Filecoin Pay has,
 * and it is operator-gated — which is exactly the delegation Sluice holds.
 */
export async function payOnRail(options: {
  railId: bigint
  amountRaw: bigint
  ratePerEpoch?: bigint
}): Promise<Hash> {
  const client = synapse().client
  const contract = payContract()

  const { request } = await simulateContract(client, {
    address: contract.address,
    abi: contract.abi,
    functionName: 'modifyRailPayment',
    args: [options.railId, options.ratePerEpoch ?? 0n, options.amountRaw],
    account: client.account,
  })

  return writeContract(client, request)
}

/**
 * Fund a rail's fixed lockup.
 *
 * Filecoin Pay pays a one-time amount out of the rail's *lockup*, not straight
 * from the payer's balance. A freshly created rail has none, so going directly
 * to `modifyRailPayment` reverts with `OneTimePaymentExceedsLockup` however much
 * USDFC the account holds — which is why this has to happen first, and has to be
 * mined before the payment is simulated.
 *
 * The lockup is drawn against the operator's lockup allowance, so the user's
 * on-chain grant still bounds it: too large and the contract rejects this call
 * with `OperatorLockupAllowanceExceeded`.
 */
export async function setRailLockup(options: {
  railId: bigint
  lockupFixed: bigint
  period?: bigint
}): Promise<Hash> {
  const client = synapse().client
  const contract = payContract()

  const { request } = await simulateContract(client, {
    address: contract.address,
    abi: contract.abi,
    functionName: 'modifyRailLockup',
    // Period 0: a one-time payment rail streams nothing, so there is no
    // per-epoch obligation to keep collateral against.
    args: [options.railId, options.period ?? 0n, options.lockupFixed],
    account: client.account,
  })

  const txHash = await writeContract(client, request)

  // The payment below is simulated against on-chain state, so it would still
  // see a zero lockup if this were left in flight.
  const receipt = await waitForTransactionReceipt(client, { hash: txHash })
  if (receipt.status !== 'success') {
    throw errors.upstream('Funding the rail lockup reverted on-chain.')
  }

  return txHash
}

/** Change a rail's streaming rate without moving a lump sum. */
export async function modifyRailRate(options: { railId: bigint; ratePerEpoch: bigint }): Promise<Hash> {
  const client = synapse().client
  const contract = payContract()

  const { request } = await simulateContract(client, {
    address: contract.address,
    abi: contract.abi,
    functionName: 'modifyRailPayment',
    args: [options.railId, options.ratePerEpoch, 0n],
    account: client.account,
  })

  return writeContract(client, request)
}

/** Close a rail. Remaining lockup unwinds according to the rail's terms. */
export async function terminateRail(options: { railId: bigint }): Promise<Hash> {
  const client = synapse().client
  const contract = payContract()

  const { request } = await simulateContract(client, {
    address: contract.address,
    abi: contract.abi,
    functionName: 'terminateRail',
    args: [options.railId],
    account: client.account,
  })

  return writeContract(client, request)
}

/** Rails where this user is the payer, so the dashboard can show what is open. */
export async function railsForPayer(payer: Address) {
  return Pay.getRailsForPayerAndToken(synapse().client, {
    payer,
    token: usdfcAddress(),
    offset: 0n,
    limit: 100n,
  })
}

export { parseEventLogs }
