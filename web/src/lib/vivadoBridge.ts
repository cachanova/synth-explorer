import type {
  DesignFile,
  VivadoBridgeStatus,
} from '../types'

const BRIDGE_ORIGIN = 'http://127.0.0.1:32123'
export const VIVADO_BRIDGE_PROTOCOL = 1

let pairingCode = ''

interface LoopbackRequestInit extends RequestInit {
  targetAddressSpace?: 'loopback'
}

interface BridgeSynthesisResponse {
  top: string
  target: string
  netlist: string
  log: string
}

export class VivadoBridgeError extends Error {
  readonly status: number
  readonly log?: string

  constructor(message: string, status = 0, log?: string) {
    super(message)
    this.name = 'VivadoBridgeError'
    this.status = status
    this.log = log
  }
}

export async function connectVivadoBridge(code: string): Promise<VivadoBridgeStatus> {
  const normalized = code.trim().toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(normalized)) {
    throw new VivadoBridgeError('Pairing code must be 32 hexadecimal characters')
  }
  const status = await request<VivadoBridgeStatus>('/v1/status', normalized)
  if (status.protocol_version !== VIVADO_BRIDGE_PROTOCOL) {
    throw new VivadoBridgeError(
      `Bridge protocol ${status.protocol_version} is not supported by this website`,
    )
  }
  if (!status.parts.length) {
    throw new VivadoBridgeError('Vivado did not report any installed target devices')
  }
  pairingCode = normalized
  return status
}

export function disconnectVivadoBridge(): void {
  pairingCode = ''
}

export async function synthesizeWithVivadoBridge(
  input: {
    files: DesignFile[]
    top: string
    target: string
    extraArgs: string[]
  },
  signal?: AbortSignal,
): Promise<BridgeSynthesisResponse> {
  if (!pairingCode) throw new VivadoBridgeError('Connect the local Vivado bridge first')
  return request<BridgeSynthesisResponse>('/v1/synthesize', pairingCode, {
    method: 'POST',
    signal,
    body: JSON.stringify({
      files: input.files,
      top: input.top,
      target: input.target,
      extra_args: input.extraArgs.length ? input.extraArgs.join(' ') : undefined,
    }),
  })
}

async function request<T>(
  path: string,
  code: string,
  init: RequestInit = {},
): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${BRIDGE_ORIGIN}${path}`, {
      ...init,
      mode: 'cors',
      targetAddressSpace: 'loopback',
      headers: {
        'Content-Type': 'application/json',
        'X-Synth-Explorer-Token': code,
        ...init.headers,
      },
    } as LoopbackRequestInit)
  } catch (error) {
    throw new VivadoBridgeError(
      'Could not reach the local Vivado bridge. Start it, then allow loopback access in your browser.',
      0,
      error instanceof Error ? error.message : String(error),
    )
  }
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`
    let log: string | undefined
    try {
      const body = await response.json() as { error?: unknown; log?: unknown }
      if (typeof body.error === 'string') message = body.error
      if (typeof body.log === 'string') log = body.log
    } catch {
      // Keep the HTTP status when the bridge returned a non-JSON error.
    }
    throw new VivadoBridgeError(message, response.status, log)
  }
  return await response.json() as T
}
