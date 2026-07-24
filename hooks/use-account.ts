'use client'

import { useCallback, useEffect, useState } from 'react'

import type { SluiceAuth } from '@/hooks/use-sluice-auth'
import type { OperatorApproval } from '@/lib/sluice/types'

export interface AccountState {
  uid: string
  email: string | null
  displayName: string | null
  walletAddress: string | null
  walletLinkedAt: number | null
  operatorApproval: OperatorApproval | null
}

export interface AccountHook {
  account: AccountState | null
  /** Address the user must approve as operator on Filecoin Pay. */
  operatorAddress: string | null
  /** True once a wallet is linked and the operator grant is live. */
  ready: boolean
  loading: boolean
  error: string | null
  /** Re-read the on-chain grant. Call after the approval transaction confirms. */
  refresh: () => Promise<void>
  /** Authenticated fetch against the Sluice API. */
  api: (path: string, init?: RequestInit) => Promise<unknown>
}

export function useAccount(auth: SluiceAuth): AccountHook {
  const [account, setAccount] = useState<AccountState | null>(null)
  const [operatorAddress, setOperatorAddress] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const api = useCallback(
    async (path: string, init?: RequestInit) => {
      const token = await auth.token()
      const response = await fetch(path, {
        ...init,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          ...(init?.headers ?? {}),
        },
      })
      const body = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(body?.error?.message ?? `Request failed (${response.status}).`)
      }
      return body
    },
    [auth]
  )

  const load = useCallback(
    async (method: 'GET' | 'POST') => {
      try {
        const body = (await api('/api/v1/account/me', { method })) as {
          user: AccountState
          operatorAddress: string
          ready: boolean
        }
        setAccount(body.user)
        setOperatorAddress(body.operatorAddress)
        setReady(body.ready)
        setError(null)
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not load account.')
      } finally {
        setLoading(false)
      }
    },
    [api]
  )

  useEffect(() => {
    if (auth.user == null) {
      setAccount(null)
      setLoading(false)
      return
    }
    setLoading(true)
    void load('GET')
  }, [auth.user, load])

  // POST re-reads the grant from the chain rather than returning the cache.
  const refresh = useCallback(async () => {
    await load('POST')
  }, [load])

  return { account, operatorAddress, ready, loading, error, refresh, api }
}
