import { randomBytes } from 'node:crypto'

import type { Address } from 'viem'
import { getAddress, verifyMessage } from 'viem'

import { COLLECTIONS, db } from '@/lib/firebase/admin'
import { errors } from '@/lib/sluice/http'
import { readOperatorApproval } from '@/lib/sluice/operator'
import { walletAddress } from '@/lib/sluice/synapse'
import type { SluiceUser, WalletNonce } from '@/lib/sluice/types'

/** Challenges are single-use and short-lived; a stale one is a replay risk. */
const NONCE_TTL_MS = 10 * 60 * 1000

function users() {
  return db().collection(COLLECTIONS.users)
}

function nonces() {
  return db().collection(COLLECTIONS.walletNonces)
}

export async function getUser(uid: string): Promise<SluiceUser | null> {
  const snapshot = await users().doc(uid).get()
  return snapshot.exists ? ({ uid: snapshot.id, ...snapshot.data() } as SluiceUser) : null
}

/** Create the account record on first sign-in, or return the existing one. */
export async function ensureUser(profile: {
  uid: string
  email: string | null
  displayName: string | null
}): Promise<SluiceUser> {
  const ref = users().doc(profile.uid)
  const snapshot = await ref.get()

  if (snapshot.exists) {
    const existing = { uid: snapshot.id, ...snapshot.data() } as SluiceUser
    // Keep the profile fresh without disturbing wallet state.
    if (existing.email !== profile.email || existing.displayName !== profile.displayName) {
      await ref.update({ email: profile.email, displayName: profile.displayName })
      return { ...existing, email: profile.email, displayName: profile.displayName }
    }
    return existing
  }

  const record: SluiceUser = {
    uid: profile.uid,
    email: profile.email,
    displayName: profile.displayName,
    walletAddress: null,
    walletLinkedAt: null,
    createdAt: Date.now(),
    operatorApproval: null,
  }
  await ref.set(record)
  return record
}

/**
 * Issue a signing challenge.
 *
 * The message names the app, the account and the address so a signature
 * captured here cannot be replayed against a different site or a different
 * Sluice account.
 */
export async function issueWalletNonce(uid: string, address: string): Promise<{ nonce: string; message: string }> {
  const checksummed = assertAddress(address)
  const nonce = randomBytes(16).toString('hex')
  const now = Date.now()

  const record: WalletNonce = { uid, nonce, createdAt: now, expiresAt: now + NONCE_TTL_MS }
  await nonces().doc(uid).set(record)

  return { nonce, message: buildMessage({ address: checksummed, uid, nonce }) }
}

function buildMessage(options: { address: string; uid: string; nonce: string }): string {
  return [
    'Sluice — link this wallet',
    '',
    'Signing this proves you control the address. It authorises nothing on its own',
    'and costs no gas. Spending rights are granted separately, on-chain.',
    '',
    `Address: ${options.address}`,
    `Account: ${options.uid}`,
    `Nonce:   ${options.nonce}`,
  ].join('\n')
}

export function assertAddress(value: string): Address {
  try {
    return getAddress(value.trim())
  } catch {
    throw errors.badRequest(`"${value}" is not a valid Ethereum-style address.`)
  }
}

/**
 * Verify the challenge signature and bind the address to the account.
 *
 * The nonce is consumed inside a transaction so a captured signature cannot be
 * submitted twice, and an address may only ever be bound to one account —
 * otherwise two users could both claim to spend from the same funds.
 */
export async function linkWallet(options: {
  uid: string
  address: string
  signature: string
}): Promise<SluiceUser> {
  const address = assertAddress(options.address)

  const nonceRef = nonces().doc(options.uid)
  const snapshot = await nonceRef.get()
  if (!snapshot.exists) {
    throw errors.badRequest('No pending link request. Request a challenge first.')
  }

  const challenge = snapshot.data() as WalletNonce
  if (Date.now() > challenge.expiresAt) {
    await nonceRef.delete().catch(() => {})
    throw errors.badRequest('This link request expired. Start again.')
  }

  const message = buildMessage({ address, uid: options.uid, nonce: challenge.nonce })
  const valid = await verifyMessage({
    address,
    message,
    signature: options.signature as `0x${string}`,
  }).catch(() => false)

  if (!valid) {
    throw errors.forbidden('Signature does not match this address.')
  }

  const lowered = address.toLowerCase()
  const taken = await users().where('walletAddressLower', '==', lowered).limit(1).get()
  if (!taken.empty && taken.docs[0].id !== options.uid) {
    throw errors.conflict('That address is already linked to another Sluice account.')
  }

  // Read the grant straight from the chain rather than trusting anything the
  // browser told us about it.
  const approval = await readOperatorApproval(address).catch(() => null)

  const fields = {
    walletAddress: address,
    walletAddressLower: lowered,
    walletLinkedAt: Date.now(),
    operatorApproval: approval,
  }

  await users().doc(options.uid).set(fields, { merge: true })
  await nonceRef.delete().catch(() => {})

  const updated = await getUser(options.uid)
  if (updated == null) throw errors.notFound('Account disappeared while linking.')
  return updated
}

/** Re-read the on-chain grant and cache it on the user record. */
export async function refreshOperatorApproval(uid: string): Promise<SluiceUser> {
  const user = await getUser(uid)
  if (user == null) throw errors.notFound('No such account.')
  if (user.walletAddress == null) {
    throw errors.badRequest('Link a wallet before checking operator access.')
  }

  const approval = await readOperatorApproval(user.walletAddress as Address)
  await users().doc(uid).update({ operatorApproval: approval })
  return { ...user, operatorApproval: approval }
}

/** The address a caller's payments will be drawn from, or a clear error. */
export async function requirePayer(uid: string): Promise<Address> {
  const user = await getUser(uid)
  if (user?.walletAddress == null) {
    throw errors.forbidden('This account has no linked wallet. Connect one in the dashboard.')
  }
  return user.walletAddress as Address
}

/** Address the user must approve as operator — Sluice's own signing key. */
export function operatorAddress(): Address {
  return walletAddress()
}
