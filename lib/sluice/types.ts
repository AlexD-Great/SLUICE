/**
 * Core domain types for Sluice.
 *
 * Every value that crosses the REST boundary is plain JSON — bigints are
 * serialised as decimal strings so that Python/curl callers never have to know
 * about token decimals or JS number precision.
 */

/**
 * The Filecoin Pay operations an agent can request over REST.
 *
 * These are exactly the operations Sluice can perform **as an approved operator
 * on a user's account**. Filecoin Pay gates the rest:
 *
 *   - `withdraw` reverts with CallerNotPayer
 *   - `settleRail` reverts with CallerNotPayerOrPayee
 *   - `deposit` spends the caller's own tokens, so it cannot be done for someone else
 *   - `setOperatorApproval` is the grant itself, and must come from the payer
 *
 * Those are browser actions, signed by the user's own wallet — see
 * {@link WALLET_ACTIONS}. Keeping them off this list is not a policy choice;
 * the contract would reject them.
 *
 * There is deliberately no raw USDFC ERC-20 transfer: that would be a token
 * send dressed up as Filecoin Pay.
 */
export const PAYMENT_KINDS = ['pay', 'modify_rate', 'terminate_rail', 'store'] as const

export type PaymentKind = (typeof PAYMENT_KINDS)[number]

/**
 * Operations that must be signed by the user's own wallet in the browser.
 *
 * Listed here so the UI and the docs cannot drift from what the contract
 * actually permits.
 */
export const WALLET_ACTIONS = [
  'deposit',
  'withdraw',
  'approve_operator',
  'revoke_operator',
  'approve_service',
  'settle',
] as const

export type WalletAction = (typeof WALLET_ACTIONS)[number]

/**
 * Lifecycle of an authorization.
 *
 * Under-cap requests go            pending -> executing -> executed
 * Over-cap requests go   pending_approval -> approved -> executing -> executed
 * with `rejected`, `failed` and `expired` as terminal off-ramps.
 */
export const AUTH_STATUSES = [
  'pending',
  'pending_approval',
  'approved',
  'executing',
  'executed',
  'rejected',
  'failed',
  'expired',
] as const

export type AuthStatus = (typeof AUTH_STATUSES)[number]

/** Statuses from which no further transition is possible. */
export const TERMINAL_STATUSES: readonly AuthStatus[] = ['executed', 'rejected', 'failed', 'expired']

/** Per-kind request parameters, as supplied by the caller. */
export interface PayParams {
  /** Recipient address. */
  to: string
  /** USDFC amount in whole tokens, e.g. "0.5". */
  amount: string
  /**
   * Reuse an existing rail instead of creating one.
   *
   * Creating a rail costs an extra transaction, so an agent paying the same
   * recipient repeatedly should hold on to the rail id from its first payment.
   */
  railId?: string
}

export interface ModifyRateParams {
  railId: string
  /** New streaming rate per epoch, in whole USDFC. */
  ratePerEpoch: string
}

export interface TerminateRailParams {
  railId: string
}

export interface StoreParams {
  /** Base64-encoded payload to store. */
  dataBase64: string
  /** Optional human label, recorded in piece metadata. */
  label?: string
}

export type PaymentParams =
  | ({ kind: 'pay' } & PayParams)
  | ({ kind: 'modify_rate' } & ModifyRateParams)
  | ({ kind: 'terminate_rail' } & TerminateRailParams)
  | ({ kind: 'store' } & StoreParams)

/**
 * The amount a request is judged against, resolved before anything is signed.
 *
 * For `deposit`/`withdraw` this is the stated amount. For `approve_service` it
 * is the lockup allowance (the true ceiling of exposure). For `settle` and
 * `store` it is an on-chain preview/estimate, because the caller does not get
 * to state a price — the network does.
 */
export interface ResolvedAmount {
  /** Base-unit amount (USDFC has 18 decimals), as a decimal string. */
  raw: string
  /** Same value formatted in whole USDFC, for display and cap comparison. */
  usdfc: string
  /** How the figure was arrived at — surfaced to the approver so they know what they are signing off. */
  basis: 'stated' | 'rate_change' | 'upload_estimate' | 'none'
  /** Free-text detail, e.g. the settlement note returned by the contract. */
  note?: string
}

/**
 * A Sluice account.
 *
 * Identity comes from Firebase (Google sign-in); spending authority comes from
 * the linked wallet's on-chain operator grant. The two are deliberately
 * separate — signing in proves who you are, the grant proves what Sluice may do.
 */
export interface SluiceUser {
  uid: string
  email: string | null
  displayName: string | null
  /** Checksummed address the user proved ownership of, lowercased for lookups. */
  walletAddress: string | null
  /** When the wallet signature was verified. */
  walletLinkedAt: number | null
  createdAt: number
  /**
   * Last known on-chain operator grant, refreshed from the chain rather than
   * trusted from the browser. Null when never granted or since revoked.
   */
  operatorApproval: OperatorApproval | null
}

/** The user's on-chain grant to Sluice, read back from Filecoin Pay. */
export interface OperatorApproval {
  /** True when Sluice is currently an approved operator on the user's account. */
  approved: boolean
  /** Max per-epoch rate Sluice may commit, in whole USDFC. */
  rateAllowanceUsdfc: string
  /** Max total lockup Sluice may hold, in whole USDFC. The real ceiling of exposure. */
  lockupAllowanceUsdfc: string
  /** How much of the rate allowance is already committed. */
  rateUsageUsdfc: string
  /** How much of the lockup allowance is already committed. */
  lockupUsageUsdfc: string
  /** Max lockup period in epochs. */
  maxLockupPeriod: string
  /** When this was last read from the chain. */
  checkedAt: number
}

/** A stored authorization record. Mirrors the `authorizations` Firestore collection. */
export interface Authorization {
  id: string
  kind: PaymentKind
  status: AuthStatus
  /** Request parameters exactly as received, minus any oversized payload. */
  params: Record<string, unknown>
  amount: ResolvedAmount
  /** Cap in whole USDFC that this request was judged against. */
  capUsdfc: string
  /** Whether the request cleared the cap without human involvement. */
  autoApproved: boolean
  apiKeyId: string
  apiKeyLabel: string
  /** Account that owns the key, and therefore the funds. */
  ownerUid: string
  /**
   * The Filecoin Pay account being spent from.
   *
   * Sluice signs as operator, but the money is the user's — this records whose.
   */
  payerAddress: string
  idempotencyKey: string | null
  /** Populated once broadcast. */
  txHash: string | null
  /** Explorer link for `txHash`, precomputed for the dashboard. */
  explorerUrl: string | null
  /** Kind-specific result payload, e.g. pieceCid for `store`. */
  result: Record<string, unknown> | null
  error: string | null
  createdAt: number
  updatedAt: number
  decidedAt: number | null
  /** Firebase Auth uid of the human who approved or rejected. */
  decidedBy: string | null
  decidedByEmail: string | null
  /** Epoch millis after which a pending_approval request is abandoned. */
  expiresAt: number
}

/** An API key record. The plaintext key is never stored. */
export interface ApiKey {
  id: string
  label: string
  /** SHA-256 of the plaintext key. */
  hash: string
  /** Account that minted the key. Requests spend this user's funds. */
  ownerUid: string
  /**
   * Payer address captured when the key was minted.
   *
   * Held here so authenticating a request does not need a second read, but the
   * live user record is the source of truth if the two ever disagree.
   */
  payerAddress: string
  /** Per-request auto-approval ceiling in whole USDFC. */
  capUsdfc: string
  /** Rolling 24h spend ceiling in whole USDFC. `null` disables the budget check. */
  dailyBudgetUsdfc: string | null
  revoked: boolean
  createdAt: number
  lastUsedAt: number | null
}

/** A pending wallet-link challenge. Single-use, short-lived. */
export interface WalletNonce {
  uid: string
  nonce: string
  createdAt: number
  expiresAt: number
}

/** Cached PieceCID -> data set mapping, written at upload time so /verify is a single lookup. */
export interface PieceRecord {
  pieceCid: string
  dataSetId: string
  providerId: string | null
  sizeBytes: number
  label: string | null
  uploadedAt: number
  /** Authorization that produced this piece. */
  authorizationId: string | null
}

/** Result of a /verify call, also persisted for the dashboard feed. */
export interface VerificationResult {
  pieceCid: string
  dataSetId: string | null
  /** Healthy when the data set is live and its proof is not overdue. */
  healthy: boolean
  status: 'healthy' | 'stale' | 'unknown'
  dataSetLastProven: string | null
  dataSetNextProofDue: string | null
  inChallengeWindow: boolean
  hoursUntilChallengeWindow: number
  isProofOverdue: boolean
  retrievalUrl: string | null
  pieceId: string | null
  checkedAt: number
}
