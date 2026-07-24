/**
 * Server-side environment access.
 *
 * Every read goes through here so a missing variable fails loudly at the point
 * of use rather than surfacing later as an opaque RPC or Firebase error.
 */

/**
 * A deployment is misconfigured.
 *
 * Distinct from a runtime failure so the API can answer 503 with the actual
 * cause. These messages name environment variables, never their values, so
 * showing them is safe and saves whoever deployed this from guessing.
 */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigurationError'
  }
}

function required(name: string): string {
  const value = process.env[name]
  if (value == null || value === '') {
    throw new ConfigurationError(
      `Missing required environment variable ${name}. See .env.example for the full list and copy it to .env.local.`
    )
  }
  return value
}

function optional(name: string, fallback: string): string {
  const value = process.env[name]
  return value == null || value === '' ? fallback : value
}

export const env = {
  /** Hex private key (0x-prefixed) of the Calibration wallet Sluice brokers for. */
  get walletPrivateKey(): `0x${string}` {
    const key = required('SLUICE_WALLET_PRIVATE_KEY')
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
      throw new ConfigurationError('SLUICE_WALLET_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string.')
    }
    return key as `0x${string}`
  },

  /** Calibration RPC endpoint. Defaults to the public Glif gateway. */
  get rpcUrl(): string {
    return optional('SLUICE_RPC_URL', 'https://api.calibration.node.glif.io/rpc/v1')
  },

  /** Default per-request auto-approval ceiling, in whole USDFC. */
  get defaultCapUsdfc(): string {
    return optional('SLUICE_DEFAULT_CAP_USDFC', '1')
  },

  /** How long an over-cap request waits for a human before expiring, in minutes. */
  get approvalTtlMinutes(): number {
    const parsed = Number(optional('SLUICE_APPROVAL_TTL_MINUTES', '60'))
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 60
  },

  /** Firebase service account, as the JSON blob downloaded from the console. */
  get firebaseServiceAccount(): { projectId: string; clientEmail: string; privateKey: string } {
    const raw = required('FIREBASE_SERVICE_ACCOUNT_KEY')
    let parsed: Record<string, string>
    try {
      // Vercel's env UI mangles literal newlines, so accept base64 as well as raw JSON.
      const json = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')
      parsed = JSON.parse(json)
    } catch {
      throw new ConfigurationError(
        'FIREBASE_SERVICE_ACCOUNT_KEY must be the service account JSON, either verbatim or base64-encoded.'
      )
    }
    const projectId = parsed.project_id ?? parsed.projectId
    const clientEmail = parsed.client_email ?? parsed.clientEmail
    const privateKey = (parsed.private_key ?? parsed.privateKey ?? '').replace(/\\n/g, '\n')
    if (!projectId || !clientEmail || !privateKey) {
      throw new ConfigurationError('FIREBASE_SERVICE_ACCOUNT_KEY is missing project_id, client_email or private_key.')
    }
    return { projectId, clientEmail, privateKey }
  },

  /**
   * Firebase Auth uids allowed to approve or reject payments.
   *
   * Comma-separated. An empty list means nobody can approve, which fails closed
   * — deliberately, so a misconfigured deploy cannot release funds.
   */
  get operatorUids(): string[] {
    return optional('SLUICE_OPERATOR_UIDS', '')
      .split(',')
      .map((uid) => uid.trim())
      .filter(Boolean)
  },

  /** Email addresses allowed to approve, as an alternative to listing uids. */
  get operatorEmails(): string[] {
    return optional('SLUICE_OPERATOR_EMAILS', '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  },

  /**
   * Public showcase mode.
   *
   * Lets anyone who reaches the deployment act as an approver and mint a
   * low-limit API key, so a visitor can drive the whole flow without an
   * account being provisioned for them first.
   *
   * This deliberately removes the identity half of the guardrail — the spend
   * cap and per-key budgets still apply, but *who* may approve no longer does.
   * Acceptable because this build is pinned to Calibration and spends testnet
   * funds only. Off unless explicitly switched on.
   *
   * Read from a NEXT_PUBLIC_ variable so the browser and the server cannot
   * disagree about which mode the deployment is in.
   */
  get demoMode(): boolean {
    return optional('NEXT_PUBLIC_SLUICE_DEMO_MODE', 'false').toLowerCase() === 'true'
  },

  /** Per-request cap on keys minted by the demo endpoint, in whole USDFC. */
  get demoKeyCapUsdfc(): string {
    return optional('SLUICE_DEMO_KEY_CAP_USDFC', '0.5')
  },

  /** Rolling 24h budget on demo keys, so a visitor cannot drain the faucet-funded wallet. */
  get demoKeyDailyUsdfc(): string {
    return optional('SLUICE_DEMO_KEY_DAILY_USDFC', '2')
  },
}
