'use client'

import { useCallback, useEffect, useState } from 'react'

import type { AccountHook } from '@/hooks/use-account'

interface KeyRow {
  id: string
  label: string
  capUsdfc: string
  dailyBudgetUsdfc: string | null
  payerAddress: string
  revoked: boolean
  createdAt: string
  lastUsedAt: string | null
}

/**
 * API key management.
 *
 * A key's cap is the software half of the gate: under it an agent executes
 * immediately, over it the request waits for the account owner. The on-chain
 * operator allowance is the other half, and the contract enforces that one.
 */
export function ApiKeys({ account }: { account: AccountHook }) {
  const [keys, setKeys] = useState<KeyRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const [label, setLabel] = useState('agent key')
  const [cap, setCap] = useState('1')
  const [daily, setDaily] = useState('25')

  /** Shown once, then gone — only the hash is stored. */
  const [freshKey, setFreshKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    try {
      const body = (await account.api('/api/v1/account/keys')) as { keys: KeyRow[] }
      setKeys(body.keys)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load keys.')
    } finally {
      setLoading(false)
    }
  }, [account])

  useEffect(() => {
    void load()
  }, [load])

  const create = async () => {
    setCreating(true)
    setError(null)
    try {
      const body = (await account.api('/api/v1/account/keys', {
        method: 'POST',
        body: JSON.stringify({
          label,
          capUsdfc: cap,
          dailyBudgetUsdfc: daily.trim() === '' ? null : daily,
        }),
      })) as { key: string }
      setFreshKey(body.key)
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create key.')
    } finally {
      setCreating(false)
    }
  }

  const revoke = async (id: string) => {
    try {
      await account.api(`/api/v1/account/keys/${id}`, { method: 'DELETE' })
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not revoke key.')
    }
  }

  const walletMissing = account.account?.walletAddress == null

  return (
    <section className="border border-white/10">
      <header className="px-6 py-5 border-b border-white/10">
        <h2 className="font-display text-xl">API keys</h2>
        <p className="text-sm text-white/45 mt-1">
          Give one to an agent. Requests under the cap execute immediately; anything above waits for you.
        </p>
      </header>

      {freshKey != null && (
        <div className="mx-6 mt-5 border border-emerald-300/30 bg-emerald-300/[0.04] p-4">
          <p className="text-xs text-emerald-200/80 mb-2">
            Copy this now — only its hash is stored, so it cannot be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="font-mono text-[12px] text-white break-all flex-1">{freshKey}</code>
            <button
              onClick={async () => {
                await navigator.clipboard.writeText(freshKey)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }}
              className="font-mono text-[10px] border border-white/20 px-3 py-1.5 hover:border-white/50 shrink-0"
            >
              {copied ? 'copied' : 'copy'}
            </button>
            <button
              onClick={() => setFreshKey(null)}
              className="font-mono text-[10px] text-white/40 hover:text-white px-2 shrink-0"
            >
              dismiss
            </button>
          </div>
        </div>
      )}

      <div className="px-6 py-5 border-b border-white/10">
        {walletMissing ? (
          <p className="text-xs text-white/40">Link a wallet first — a key with no account behind it cannot spend.</p>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <Field label="label" value={label} onChange={setLabel} width="w-52" />
            <Field label="cap (USDFC)" value={cap} onChange={setCap} hint="per request" />
            <Field label="daily (USDFC)" value={daily} onChange={setDaily} hint="blank = unlimited" />
            <button
              onClick={create}
              disabled={creating}
              className="bg-white text-black text-sm px-5 py-2 hover:bg-white/90 disabled:opacity-40"
            >
              {creating ? 'Creating…' : 'Create key'}
            </button>
          </div>
        )}
      </div>

      {error != null && <p className="px-6 py-3 text-xs text-red-400">{error}</p>}
      {loading && <p className="px-6 py-4 font-mono text-xs text-white/30">Loading…</p>}
      {!loading && keys.length === 0 && (
        <p className="px-6 py-6 font-mono text-xs text-white/30">No keys yet.</p>
      )}

      {keys.map((key) => (
        <div
          key={key.id}
          className="px-6 py-4 border-b border-white/10 flex flex-wrap items-center justify-between gap-4"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <span className={`text-sm ${key.revoked ? 'text-white/30 line-through' : 'text-white'}`}>
                {key.label}
              </span>
              {key.revoked && <span className="font-mono text-[10px] text-white/30">revoked</span>}
            </div>
            <p className="font-mono text-[10px] text-white/30 mt-1">
              cap {key.capUsdfc} · daily {key.dailyBudgetUsdfc ?? '∞'} ·{' '}
              {key.lastUsedAt == null ? 'never used' : `last used ${new Date(key.lastUsedAt).toLocaleString()}`}
            </p>
          </div>
          {!key.revoked && (
            <button
              onClick={() => revoke(key.id)}
              className="font-mono text-[10px] border border-white/15 text-white/50 px-3 py-1.5 hover:border-red-400/50 hover:text-red-300"
            >
              revoke
            </button>
          )}
        </div>
      ))}
    </section>
  )
}

function Field({
  label,
  value,
  onChange,
  hint,
  width = 'w-36',
}: {
  label: string
  value: string
  onChange: (next: string) => void
  hint?: string
  width?: string
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10px] text-white/35">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`bg-transparent border border-white/15 px-3 py-2 text-sm text-white ${width} outline-none focus:border-white/40`}
      />
      {hint != null && <span className="font-mono text-[10px] text-white/25">{hint}</span>}
    </label>
  )
}
