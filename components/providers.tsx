'use client'

import '@rainbow-me/rainbowkit/styles.css'

import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { WagmiProvider } from 'wagmi'

import { wagmiConfig } from '@/lib/wagmi'

/**
 * Client providers for the wallet stack.
 *
 * The QueryClient is created in state rather than at module scope so each
 * server render gets its own cache — a shared one would leak one visitor's
 * chain reads into another's page.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient())

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={darkTheme({ accentColor: '#ffffff', accentColorForeground: '#000000' })}>
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
