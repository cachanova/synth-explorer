import { useCallback, useEffect, useState, type RefObject } from 'react'
import {
  connectVivadoBridge,
  probeVivadoBridge,
  selectVivadoTarget,
  VivadoBridgeError,
} from '../lib/vivadoBridge'
import type { SynthTool, VivadoBridgeStatus } from '../types'
import type { StoreError } from './synthesisSlice'

interface VivadoSliceRefs {
  synthTool: RefObject<SynthTool>
  status: RefObject<VivadoBridgeStatus | null>
  target: RefObject<string>
  extraArgs: RefObject<string>
}

export function useVivadoSlice({
  initialSynthTool,
  initialTarget,
  initialExtraArgs,
  refs,
  markInputChanged,
  setError,
}: {
  initialSynthTool: SynthTool
  initialTarget: string
  initialExtraArgs: string
  refs: VivadoSliceRefs
  markInputChanged: () => void
  setError: (error: StoreError | null) => void
}) {
  const [synthTool, setSynthToolState] = useState<SynthTool>('yosys')
  // The tool the user last chose, which is what the workspace stores. The
  // active tool above stays on Yosys until a bridge answers, so a refresh
  // taken while the bridge happens to be down must not erase the choice.
  const [rememberedSynthTool, setRememberedSynthTool] = useState<SynthTool>(
    initialSynthTool,
  )
  const [vivadoStatus, setVivadoStatus] = useState<VivadoBridgeStatus | null>(null)
  const [vivadoTarget, setVivadoTargetState] = useState(initialTarget)
  const [vivadoExtraArgs, setVivadoExtraArgsState] = useState(initialExtraArgs)

  refs.synthTool.current = synthTool
  refs.status.current = vivadoStatus
  refs.target.current = vivadoTarget
  refs.extraArgs.current = vivadoExtraArgs

  const setSynthTool = useCallback(
    (value: SynthTool) => {
      if (value === 'vivado' && !refs.status.current) return
      setRememberedSynthTool(value)
      if (refs.synthTool.current === value) return
      refs.synthTool.current = value
      markInputChanged()
      setSynthToolState(value)
    },
    [markInputChanged, refs],
  )

  const clearVivadoConnection = useCallback(
    (options: { markChanged?: boolean } = {}) => {
      refs.status.current = null
      setVivadoStatus(null)
      if (refs.synthTool.current === 'vivado') {
        refs.synthTool.current = 'yosys'
        setSynthToolState('yosys')
        if (options.markChanged !== false) markInputChanged()
      }
    },
    [markInputChanged, refs],
  )

  const adoptVivadoStatus = useCallback(
    (status: VivadoBridgeStatus) => {
      const target = selectVivadoTarget(status.parts, refs.target.current)
      refs.status.current = status
      refs.target.current = target
      setVivadoStatus(status)
      setVivadoTargetState(target)
    },
    [refs],
  )

  const connectVivado = useCallback(
    async (vivadoPath?: string) => {
      try {
        adoptVivadoStatus(await connectVivadoBridge(vivadoPath))
        setError(null)
        return { connected: true }
      } catch (error) {
        const bridgeError = error as VivadoBridgeError
        if (bridgeError.pathRequired) {
          setError(null)
        } else {
          setError({
            message: bridgeError.message,
            log: bridgeError.log,
            kind: 'bridge',
            status: bridgeError.status || undefined,
          })
        }
        return {
          connected: false,
          error: bridgeError.message,
          pathRequired: bridgeError.pathRequired,
        }
      }
    },
    [adoptVivadoStatus, setError],
  )

  const disconnectVivado = useCallback(() => {
    setRememberedSynthTool('yosys')
    clearVivadoConnection()
  }, [clearVivadoConnection])

  const setVivadoTarget = useCallback(
    (value: string) => {
      if (!refs.status.current?.parts.some((part) => part.name === value)) return
      if (refs.target.current === value) return
      refs.target.current = value
      markInputChanged()
      setVivadoTargetState(value)
    },
    [markInputChanged, refs],
  )

  const setVivadoExtraArgs = useCallback(
    (value: string) => {
      if (refs.extraArgs.current === value) return
      refs.extraArgs.current = value
      markInputChanged()
      setVivadoExtraArgsState(value)
    },
    [markInputChanged, refs],
  )

  return {
    synthTool,
    rememberedSynthTool,
    vivadoStatus,
    vivadoTarget,
    vivadoExtraArgs,
    setSynthTool,
    clearVivadoConnection,
    adoptVivadoStatus,
    connectVivado,
    disconnectVivado,
    setVivadoTarget,
    setVivadoExtraArgs,
    setRememberedSynthTool,
  }
}

export function useVivadoRestore({
  initialSynthTool,
  adoptVivadoStatus,
  setSynthTool,
  setRememberedSynthTool,
}: {
  initialSynthTool: SynthTool
  adoptVivadoStatus: (status: VivadoBridgeStatus) => void
  setSynthTool: (tool: SynthTool) => void
  setRememberedSynthTool: (tool: SynthTool) => void
}) {
  // Restoring a remembered Vivado selection asks an already-running bridge for
  // its status. A user who never chose Vivado never reaches the bridge. When no
  // bridge answers the session stays on Yosys and forgets the choice.
  useEffect(() => {
    if (initialSynthTool !== 'vivado') return
    let cancelled = false
    void probeVivadoBridge().then(
      (status) => {
        if (cancelled) return
        adoptVivadoStatus(status)
        setSynthTool('vivado')
      },
      () => {
        if (!cancelled) setRememberedSynthTool('yosys')
      },
    )
    return () => {
      cancelled = true
    }
    // Restores once per mount from the workspace that seeded this store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
