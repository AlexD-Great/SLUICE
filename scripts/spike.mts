/**
 * End-to-end check against Filecoin Calibration.
 *
 *   pnpm spike
 *   pnpm spike -- --payer 0xUserAddress   # inspect a user's grant to Sluice
 *   pnpm spike -- --upload                # store a piece and read its proof status
 *
 * Run this before trusting the API. It exercises the same SDK calls the
 * executor makes, so a failure here points at the wallet, the faucet or the RPC
 * rather than at Sluice. Read-only unless you pass --upload.
 */
import 'dotenv/config'

import type { Address } from 'viem'

import { readOperatorApproval, railsForPayer } from '@/lib/sluice/operator'
import { formatUsdfc, synapse, walletAddress } from '@/lib/sluice/synapse'

const has = (flag: string) => process.argv.includes(`--${flag}`)

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 || index === process.argv.length - 1 ? undefined : process.argv[index + 1]
}

function step(title: string) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`)
}

async function main() {
  const client = synapse()

  step('Operator wallet')
  console.log(`  address   ${walletAddress()}`)
  console.log(`  chain     ${client.chain.name} (${client.chain.id})`)
  console.log('  This key signs for users. It needs tFIL for gas and holds no user funds.')

  step('Balances')
  const [fil, usdfc] = await Promise.all([
    client.payments.walletBalance({ token: 'FIL' }),
    client.payments.walletBalance({ token: 'USDFC' }),
  ])
  console.log(`  tFIL      ${formatUsdfc(fil)}   (gas)`)
  console.log(`  tUSDFC    ${formatUsdfc(usdfc)}   (only needed for gateway-owned storage)`)

  if (fil === 0n) {
    console.log('\n  No tFIL — every transaction will fail. Fund from https://faucet.calibnet.chainsafe-fil.io')
    return
  }

  step('Contracts')
  console.log(`  filecoinPay   ${client.chain.contracts.filecoinPay.address}`)
  console.log(`  usdfc         ${client.chain.contracts.usdfc.address}`)
  console.log(`  warmStorage   ${client.chain.contracts.fwss.address}`)

  const payer = arg('payer')
  if (payer != null) {
    step(`Operator grant from ${payer}`)
    const approval = await readOperatorApproval(payer as Address)
    console.log(`  approved          ${approval.approved}`)
    console.log(`  rate allowance    ${approval.rateAllowanceUsdfc} USDFC/epoch (using ${approval.rateUsageUsdfc})`)
    console.log(`  lockup allowance  ${approval.lockupAllowanceUsdfc} USDFC (using ${approval.lockupUsageUsdfc})`)
    console.log(`  max lockup        ${approval.maxLockupPeriod} epochs`)
    if (!approval.approved) {
      console.log('\n  Not approved — the user grants this from the dashboard. Nothing can be spent until they do.')
    }

    step('Rails where this user is the payer')
    const rails = await railsForPayer(payer as Address)
    if (rails.results.length === 0) console.log('  none yet')
    for (const rail of rails.results) {
      console.log(`  rail ${rail.railId}  terminated=${rail.isTerminated}  endEpoch=${rail.endEpoch}`)
    }
  } else {
    console.log('\n  Pass --payer 0x... to inspect a user grant and their rails.')
  }

  step('Storage pricing')
  const info = await client.storage.getStorageInfo()
  console.log(`  per TiB/month  ${formatUsdfc(info.pricing.noCDN.perTiBPerMonth)} USDFC`)

  step('Data sets owned by the gateway wallet')
  const dataSets = await client.storage.findDataSets({})
  if (dataSets.length === 0) console.log('  none yet — run with --upload to create one')
  for (const dataSet of dataSets) {
    console.log(
      `  #${dataSet.pdpVerifierDataSetId}  live=${dataSet.isLive}  pieces=${dataSet.activePieceCount}  managed=${dataSet.isManaged}`
    )
  }

  if (has('upload')) {
    step('Upload a test piece (gateway account)')
    const payload = new TextEncoder().encode(`sluice spike ${new Date().toISOString()}`)
    const costs = await client.storage.getUploadCosts({ dataSize: BigInt(payload.byteLength) })
    console.log(`  lockup    ${formatUsdfc(costs.lockups.total)} USDFC`)
    console.log(`  ready     ${costs.ready}`)

    const uploaded = await client.storage.upload(payload)
    console.log(`  pieceCid  ${uploaded.pieceCid}`)
    console.log(`  complete  ${uploaded.complete}`)

    const copy = uploaded.copies[0]
    if (copy != null) {
      step('PDP proof status')
      const context = await client.storage.createContext({ dataSetId: copy.dataSetId })
      const status = await context.pieceStatus({ pieceCid: uploaded.pieceCid })
      console.log(`  lastProven    ${status?.dataSetLastProven?.toISOString() ?? 'not yet proven'}`)
      console.log(`  nextProofDue  ${status?.dataSetNextProofDue?.toISOString() ?? 'unknown'}`)
      console.log(`  overdue       ${status?.isProofOverdue ?? false}`)
      console.log(`\n  Verify over REST:  GET /api/v1/verify/${uploaded.pieceCid}`)
    }
  }

  console.log('')
}

main().catch((error) => {
  console.error('\nSpike failed:\n', error)
  process.exit(1)
})
