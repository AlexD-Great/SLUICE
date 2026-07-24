import { calibration, Synapse } from '@filoz/synapse-sdk'
import { http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { env } from '@/lib/sluice/env'

/** USDFC has 18 decimals on Calibration, same as FIL. */
export const USDFC_DECIMALS = 18

let cached: Synapse | null = null

/**
 * Synapse client for the wallet Sluice brokers for.
 *
 * Testnet only: pinned to Calibration so a stray env var cannot point a funded
 * mainnet key at these endpoints.
 */
export function synapse(): Synapse {
  if (cached == null) {
    cached = Synapse.create({
      chain: calibration,
      transport: http(env.rpcUrl),
      account: privateKeyToAccount(env.walletPrivateKey),
      // Attribution tag the SDK stamps on data sets it creates.
      source: 'sluice',
    })
  }
  return cached
}

export function walletAddress(): `0x${string}` {
  return synapse().client.account.address
}

/** Explorer link for a transaction, used by the dashboard. */
export function explorerTxUrl(txHash: string): string {
  return `https://calibration.filfox.info/en/message/${txHash}`
}

/**
 * Parse a decimal USDFC string into base units without going through `Number`.
 *
 * `parseUnits` from viem would do this, but rolling it here lets us reject the
 * malformed input a REST caller can send with a precise error message rather
 * than a thrown `SyntaxError`.
 */
export function parseUsdfc(value: string, field = 'amount'): bigint {
  const trimmed = value.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`${field} must be a non-negative decimal string, e.g. "0.5" — got ${JSON.stringify(value)}`)
  }
  const [whole, fraction = ''] = trimmed.split('.')
  if (fraction.length > USDFC_DECIMALS) {
    throw new Error(`${field} has more than ${USDFC_DECIMALS} decimal places`)
  }
  const padded = fraction.padEnd(USDFC_DECIMALS, '0')
  return BigInt(whole) * 10n ** BigInt(USDFC_DECIMALS) + BigInt(padded === '' ? '0' : padded)
}

/** Format base units back to a trimmed decimal string. */
export function formatUsdfc(value: bigint): string {
  const negative = value < 0n
  const abs = negative ? -value : value
  const divisor = 10n ** BigInt(USDFC_DECIMALS)
  const whole = abs / divisor
  const fraction = (abs % divisor).toString().padStart(USDFC_DECIMALS, '0').replace(/0+$/, '')
  const formatted = fraction === '' ? whole.toString() : `${whole}.${fraction}`
  return negative ? `-${formatted}` : formatted
}

/** Compare two whole-USDFC decimal strings without floating point. */
export function compareUsdfc(a: string, b: string): number {
  const left = parseUsdfc(a, 'value')
  const right = parseUsdfc(b, 'value')
  return left < right ? -1 : left > right ? 1 : 0
}

/** JSON.stringify replacer — bigints become decimal strings rather than throwing. */
export function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, val) => (typeof val === 'bigint' ? val.toString() : val)))
}
