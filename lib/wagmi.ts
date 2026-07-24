'use client'

import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import { calibration } from '@filoz/synapse-core/chains'
import type { Chain } from 'viem'

/**
 * Wallet configuration, pinned to Filecoin Calibration.
 *
 * Only the testnet is listed, so a wallet sitting on Ethereum prompts to switch
 * rather than silently signing against the wrong network — where the Filecoin
 * Pay contract does not exist and the failure would be baffling.
 */
export const calibrationChain = calibration as Chain

/**
 * WalletConnect needs a project id from https://cloud.reown.com. Without one,
 * injected wallets (MetaMask and friends) still work; only the QR-code flow for
 * mobile wallets is unavailable.
 */
const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? 'sluice-local-development'

export const wagmiConfig = getDefaultConfig({
  appName: 'Sluice',
  projectId,
  chains: [calibrationChain],
  ssr: true,
})
