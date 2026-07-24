import { NextResponse } from 'next/server'

import { ConfigurationError } from '@/lib/sluice/env'

/**
 * An error carrying the HTTP status and a stable machine-readable code, so
 * non-JS callers can branch on `error.code` rather than parsing prose.
 */
export class SluiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'SluiceError'
  }
}

export const errors = {
  badRequest: (message: string, detail?: Record<string, unknown>) =>
    new SluiceError(400, 'bad_request', message, detail),
  unauthorized: (message = 'Missing or invalid API key.') => new SluiceError(401, 'unauthorized', message),
  forbidden: (message: string) => new SluiceError(403, 'forbidden', message),
  notFound: (message: string) => new SluiceError(404, 'not_found', message),
  conflict: (message: string, detail?: Record<string, unknown>) => new SluiceError(409, 'conflict', message, detail),
  tooManyRequests: (message: string) => new SluiceError(429, 'too_many_requests', message),
  upstream: (message: string, detail?: Record<string, unknown>) =>
    new SluiceError(502, 'upstream_error', message, detail),
}

export function json(body: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(body as Record<string, unknown>, init)
}

/**
 * Wrap a route handler so thrown errors become consistent JSON.
 *
 * Unexpected errors are logged in full but returned generically — an error
 * string from the RPC layer can contain the wallet address and calldata.
 */
export function handler<Args extends unknown[]>(
  fn: (request: Request, ...args: Args) => Promise<NextResponse>
): (request: Request, ...args: Args) => Promise<NextResponse> {
  return async (request, ...args) => {
    try {
      return await fn(request, ...args)
    } catch (error) {
      if (error instanceof SluiceError) {
        return json(
          { error: { code: error.code, message: error.message, ...(error.detail ?? {}) } },
          { status: error.status }
        )
      }
      // A misconfigured deployment is worth naming: the message identifies an
      // environment variable, never its value, and "Internal error" would leave
      // whoever deployed this guessing.
      if (error instanceof ConfigurationError) {
        console.error('[sluice] configuration error', error.message)
        return json({ error: { code: 'not_configured', message: error.message } }, { status: 503 })
      }
      console.error('[sluice] unhandled error', error)
      return json({ error: { code: 'internal_error', message: 'Internal error.' } }, { status: 500 })
    }
  }
}

/** Parse a JSON body, rejecting anything that is not a plain object. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = await request.json()
  } catch {
    throw errors.badRequest('Request body must be valid JSON.')
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw errors.badRequest('Request body must be a JSON object.')
  }
  return parsed as Record<string, unknown>
}

export function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw errors.badRequest(`Field "${field}" is required and must be a non-empty string.`)
  }
  return value.trim()
}

export function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field]
  if (value == null) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw errors.badRequest(`Field "${field}" must be a non-empty string when present.`)
  }
  return value.trim()
}
