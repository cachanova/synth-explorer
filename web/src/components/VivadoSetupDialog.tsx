import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { VivadoBridgeStatus } from '../types'

const RELEASES_URL = 'https://github.com/cachanova/synth-explorer/releases/latest'

export function VivadoSetupDialog({
  open,
  status,
  onClose,
  onConnect,
  onDisconnect,
}: {
  open: boolean
  status: VivadoBridgeStatus | null
  onClose: () => void
  onConnect: (pairingCode: string) => Promise<boolean>
  onDisconnect: () => void
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!open) return
    setFailed(false)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    requestAnimationFrame(() => inputRef.current?.focus())
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, open])

  if (!open) return null

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!inputRef.current || submitting) return
    setSubmitting(true)
    setFailed(false)
    const connected = await onConnect(inputRef.current.value)
    setSubmitting(false)
    if (connected) {
      inputRef.current.value = ''
      onClose()
    } else {
      setFailed(true)
    }
  }

  return (
    <div className="vivado-setup-backdrop" role="presentation">
      <section
        className="vivado-setup-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vivado-setup-title"
      >
        <div className="vivado-setup-heading">
          <div>
            <h2 id="vivado-setup-title">Use Vivado on this computer</h2>
            <p>Your RTL goes directly from this browser to your loopback bridge. It is not sent to Synth Explorer servers.</p>
          </div>
          <button type="button" className="vivado-setup-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {status ? (
          <div className="vivado-connected-card">
            <span className="vivado-status-dot" aria-hidden="true" />
            <div>
              <strong>Connected</strong>
              <span>{status.vivado_version} · {status.parts.length.toLocaleString()} installed parts</span>
            </div>
            <button type="button" onClick={onDisconnect}>Disconnect</button>
          </div>
        ) : (
          <>
            <ol className="vivado-steps">
              <li>
                <strong>Install Vivado locally.</strong>
                <span>Vivado Standard or Enterprise must be installed and licensed on this machine.</span>
              </li>
              <li>
                <strong>Download and start the bridge.</strong>
                <span>
                  Get the bridge for Windows or Linux from{' '}
                  <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer">GitHub Releases</a>,
                  then run it from a Vivado-enabled terminal.
                </span>
                <div className="vivado-command-grid">
                  <div>
                    <span>Linux</span>
                    <code>./synth-explorer-vivado-bridge-linux-x86_64 --vivado /opt/Xilinx/Vivado/2025.2/bin/vivado</code>
                  </div>
                  <div>
                    <span>Windows PowerShell</span>
                    <code>.\synth-explorer-vivado-bridge-windows-x86_64.exe --vivado vivado.bat</code>
                  </div>
                </div>
                <details>
                  <summary>Build from source instead</summary>
                  <code>cargo run --release -p synth-explorer-vivado-bridge</code>
                </details>
              </li>
              <li>
                <strong>Pair this tab.</strong>
                <span>In a current Chromium-based browser, paste the 32-character pairing code printed by the bridge. Allow loopback-network access when the browser asks.</span>
              </li>
            </ol>

            <form className="vivado-pair-form" onSubmit={(event) => void submit(event)}>
              <label>
                <span>Pairing code</span>
                <input
                  ref={inputRef}
                  name="pairing-code"
                  type="password"
                  autoComplete="off"
                  minLength={32}
                  maxLength={32}
                  pattern="[0-9A-Fa-f]{32}"
                  placeholder="Paste code from the bridge window"
                  spellCheck={false}
                  required
                />
              </label>
              <button className="primary" type="submit" disabled={submitting}>
                {submitting ? 'Connecting…' : 'Connect local Vivado'}
              </button>
            </form>
            {failed && (
              <p className="vivado-pair-error" role="alert">
                Connection failed. Check that the bridge is running, the code matches, and loopback access is allowed.
              </p>
            )}
          </>
        )}
      </section>
    </div>
  )
}
