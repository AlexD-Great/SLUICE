'use client'

import { ConnectButton } from '@rainbow-me/rainbowkit'
import * as Pay from '@filoz/synapse-core/pay'
import { useCallback, useMemo, useState } from 'react'
import { parseUnits } from 'viem'
import { usePublicClient, useAccount as useWagmiAccount, useSignMessage, useWalletClient } from 'wagmi'

import type { AccountHook } from '@/hooks/use-account'
import { calibrationChain } from '@/lib/wagmi'

type Busy = null | 'link' | 'approve' | 'deposit'

/**
 * Wallet onboarding.
 *
 * Three steps, each doing something genuinely different:
 *   1. Link   — sign a message. No gas, authorises nothing, proves the address.
 *   2. Grant  — the on-chain operator approval. This is what lets an agent spend.
 *   3. Fund   — deposit USDFC into your own Filecoin Pay account.
 *
 * Steps 2 and 3 are signed by the user's own wallet because Filecoin Pay
 * restricts them to the account holder — Sluice could not do them on the user's
 * behalf even if it wanted to.
 */
export function WalletSetup({ account }: { account: AccountHook }) {
  const { address, isConnected, chainId } = useWagmiAccount()
  const { signMessageAsync } = useSignMessage()
  const { data: walletClient } = useWalletClient()
  // The wallet client only signs; reading a receipt needs a public client.
  const publicClient = usePublicClient()

  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [rateAllowance, setRateAllowance] = useState('0.01')
  const [lockupAllowance, setLockupAllowance] = useState('5')
  const [depositAmount, setDepositAmount] = useState('1')

  const linked = account.account?.walletAddress != null
  const linkedMatches =
    linked && address != null && account.account?.walletAddress?.toLowerCase() === address.toLowerCase()
  const approval = account.account?.operatorApproval ?? null
  const wrongChain = isConnected && chainId !== calibrationChain.id

  const step = useMemo(() => {
    if (!isConnected) return 1
    if (!linkedMatches) return 1
    if (approval?.approved !== true) return 2
    return 3
  }, [isConnected, linkedMatches, approval])

  const run = useCallback(
    async (which: Busy, fn: () => Promise<string | null>) => {
      setBusy(which)
      setError(null)
      setNotice(null)
      try {
        const message = await fn()
        if (message != null) setNotice(message)
      } catch (caught) {
        const raw = caught instanceof Error ? caught.message : String(caught)
        // Wallet rejections are a normal choice, not a failure worth shouting about.
        setError(/user rejected|denied|rejected the request/i.test(raw) ? 'Cancelled in your wallet.' : raw)
      } finally {
        setBusy(null)
      }
    },
    []
  )

  /** Step 1 — prove control of the address. */
  const link = () =>
    run('link', async () => {
      if (address == null) throw new Error('Connect a wallet first.')
      const challenge = (await account.api('/api/v1/account/wallet', {
        method: 'POST',
        body: JSON.stringify({ address }),
      })) as { message: string }

      const signature = await signMessageAsync({ message: challenge.message })

      await account.api('/api/v1/account/wallet', {
        method: 'PUT',
        body: JSON.stringify({ address, signature }),
      })
      await account.refresh()
      return 'Wallet linked.'
    })

  /** Step 2 — the grant that actually lets an agent spend. */
  const grant = () =>
    run('approve', async () => {
      if (walletClient == null) throw new Error('Connect a wallet first.')
      if (account.operatorAddress == null) throw new Error('Sluice operator address unavailable.')

      const hash = await Pay.setOperatorApproval(walletClient, {
        operator: account.operatorAddress as `0x${string}`,
        approve: true,
        rateAllowance: parseUnits(rateAllowance, 18),
        lockupAllowance: parseUnits(lockupAllowance, 18),
      })

      // Calibration blocks are ~30s, so tell the user to expect a wait rather
      // than leaving the button looking stuck.
      setNotice(`Submitted ${hash.slice(0, 10)}… waiting for confirmation (~30s).`)
      await publicClient?.waitForTransactionReceipt({ hash }).catch(() => null)
      await account.refresh()
      return 'Operator access granted. Agents can now spend within these limits.'
    })

  /** Step 3 — fund your own Filecoin Pay account. */
  const fund = () =>
    run('deposit', async () => {
      if (walletClient == null) throw new Error('Connect a wallet first.')
      const hash = await Pay.deposit(walletClient, { amount: parseUnits(depositAmount, 18) })
      setNotice(`Submitted ${hash.slice(0, 10)}… waiting for confirmation (~30s).`)
      await publicClient?.waitForTransactionReceipt({ hash }).catch(() => null)
      await account.refresh()
      return `Deposited ${depositAmount} USDFC into your Filecoin Pay account.`
    })

  const revoke = () =>
    run('approve', async () => {
      if (walletClient == null) throw new Error('Connect a wallet first.')
      if (account.operatorAddress == null) throw new Error('Sluice operator address unavailable.')
      const hash = await Pay.setOperatorApproval(walletClient, {
        operator: account.operatorAddress as `0x${string}`,
        approve: false,
      })
      setNotice(`Submitted ${hash.slice(0, 10)}… waiting for confirmation (~30s).`)
      await publicClient?.waitForTransactionReceipt({ hash }).catch(() => null)
      await account.refresh()
      return 'Operator access revoked. Agents can no longer spend from this account.'
    })

  return (
    <section className="border border-white/10">
      <header className="px-6 py-5 border-b border-white/10 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-xl">Your wallet</h2>
          <p className="text-sm text-white/45 mt-1">
            Sluice never holds your key. It spends as an operator, within limits you set on-chain.
          </p>
        </div>
        <ConnectButton showBalance={false} chainStatus="icon" />
      </header>

      {wrongChain && (
        <p className="mx-6 mt-5 border border-amber-300/30 bg-amber-300/[0.04] text-amber-200/80 text-xs px-4 py-3">
          Your wallet is on the wrong network. Switch to Filecoin Calibration ({calibrationChain.id}).
        </p>
      )}

      <div className="divide-y divide-white/10">
        <Step
          index={1}
          title="Link this address"
          done={Boolean(linkedMatches)}
          active={step === 1}
          detail="Signs a message. No gas, and it authorises nothing on its own."
        >
          {linked && !linkedMatches && (
            <p className="text-xs text-amber-300 mb-3">
              This account is linked to {account.account?.walletAddress}. Connect that wallet, or link the
              current one to replace it.
            </p>
          )}
          <button
            onClick={link}
            disabled={!isConnected || busy != null}
            className="bg-white text-black text-sm px-5 py-2 hover:bg-white/90 disabled:opacity-40"
          >
            {busy === 'link' ? 'Waiting for signature…' : linkedMatches ? 'Re-link' : 'Sign to link'}
          </button>
        </Step>

        <Step
          index={2}
          title="Grant operator access"
          done={approval?.approved === true}
          active={step === 2}
          detail="An on-chain approval letting Sluice move funds through payment rails on your behalf — up to these limits, and never out to itself."
        >
          {approval?.approved === true ? (
            <div className="space-y-3">
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 font-mono text-[11px] text-white/50">
                <Row label="lockup allowance" value={`${approval.lockupAllowanceUsdfc} USDFC`} />
                <Row label="in use" value={`${approval.lockupUsageUsdfc} USDFC`} />
                <Row label="rate allowance" value={`${approval.rateAllowanceUsdfc} USDFC/epoch`} />
                <Row label="rate in use" value={`${approval.rateUsageUsdfc} USDFC/epoch`} />
              </dl>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={grant}
                  disabled={busy != null}
                  className="border border-white/20 text-white/80 text-xs px-4 py-2 hover:border-white/50 disabled:opacity-40"
                >
                  Change limits
                </button>
                <button
                  onClick={revoke}
                  disabled={busy != null}
                  className="border border-red-400/30 text-red-300 text-xs px-4 py-2 hover:border-red-400/60 disabled:opacity-40"
                >
                  {busy === 'approve' ? '…' : 'Revoke'}
                </button>
              </div>
            </div>
          ) : null}

          {(approval?.approved !== true || busy === 'approve') && (
            <div className="flex flex-wrap items-end gap-3 mt-3">
              <Field
                label="max total (USDFC)"
                value={lockupAllowance}
                onChange={setLockupAllowance}
                hint="the ceiling of what agents can ever commit"
              />
              <Field
                label="max rate (USDFC/epoch)"
                value={rateAllowance}
                onChange={setRateAllowance}
                hint="how fast it can drain"
              />
              <button
                onClick={grant}
                disabled={!linkedMatches || busy != null}
                className="bg-white text-black text-sm px-5 py-2 hover:bg-white/90 disabled:opacity-40"
              >
                {busy === 'approve' ? 'Confirming…' : 'Grant'}
              </button>
            </div>
          )}
        </Step>

        <Step
          index={3}
          title="Fund your Filecoin Pay account"
          done={false}
          active={step === 3}
          detail="Moves USDFC from your wallet into your own escrow. Only you can withdraw it."
        >
          <div className="flex flex-wrap items-end gap-3">
            <Field label="amount (USDFC)" value={depositAmount} onChange={setDepositAmount} />
            <button
              onClick={fund}
              disabled={!linkedMatches || busy != null}
              className="bg-white text-black text-sm px-5 py-2 hover:bg-white/90 disabled:opacity-40"
            >
              {busy === 'deposit' ? 'Confirming…' : 'Deposit'}
            </button>
          </div>
        </Step>
      </div>

      {(error != null || notice != null) && (
        <p
          className={`px-6 py-4 text-xs border-t border-white/10 ${
            error != null ? 'text-red-400' : 'text-emerald-300'
          }`}
        >
          {error ?? notice}
        </p>
      )}
    </section>
  )
}

function Step({
  index,
  title,
  detail,
  done,
  active,
  children,
}: {
  index: number
  title: string
  detail: string
  done: boolean
  active: boolean
  children: React.ReactNode
}) {
  return (
    <div className={`px-6 py-5 ${active ? 'bg-white/[0.02]' : ''}`}>
      <div className="flex items-start gap-4">
        <span
          className={`font-mono text-[10px] w-6 h-6 shrink-0 flex items-center justify-center border ${
            done ? 'border-emerald-300/40 text-emerald-300' : 'border-white/20 text-white/40'
          }`}
        >
          {done ? '✓' : index}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm text-white">{title}</h3>
          <p className="text-xs text-white/40 mt-1 mb-4 leading-relaxed max-w-xl">{detail}</p>
          {children}
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  hint,
}: {
  label: string
  value: string
  onChange: (next: string) => void
  hint?: string
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10px] text-white/35">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        inputMode="decimal"
        className="bg-transparent border border-white/15 px-3 py-2 text-sm text-white w-44 outline-none focus:border-white/40"
      />
      {hint != null && <span className="font-mono text-[10px] text-white/25">{hint}</span>}
    </label>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt>{label}</dt>
      <dd className="text-white/70">{value}</dd>
    </div>
  )
}
