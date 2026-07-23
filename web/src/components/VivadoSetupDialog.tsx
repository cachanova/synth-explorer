import { useCallback, useEffect, useRef, useState } from 'react'
import { hostPlatform, type HostPlatform } from '../lib/hostPlatform'
import { isLocalLauncher } from '../lib/localLauncher'
import type { VivadoBridgeStatus } from '../types'
import { BubbleLoader } from './BubbleLoader'

const RELEASE_BASE = 'https://github.com/cachanova/synth-explorer/releases/latest/download'
const LINUX_DOWNLOAD = `${RELEASE_BASE}/synth-explorer-vivado-bridge-linux-x86_64`
const WINDOWS_DOWNLOAD = `${RELEASE_BASE}/synth-explorer-vivado-bridge-windows-x86_64.exe`

function PlatformDownload({ platform }: { platform: HostPlatform }) {
  const note = platform === 'windows'
    ? 'Run the Windows executable and leave its window open.'
    : platform === 'macos'
      ? 'Vivado does not run natively on macOS. Use a Linux or Windows Vivado host with the remote instructions below.'
      : 'On Linux, the one-line launcher downloads the connector, verifies it, finds Vivado, and starts it.'

  const primary = platform === 'windows' ? WINDOWS_DOWNLOAD : LINUX_DOWNLOAD
  const secondary = platform === 'windows' ? LINUX_DOWNLOAD : WINDOWS_DOWNLOAD
  const primaryLabel = platform === 'windows' ? 'Download for Windows x64' : 'Download for Linux x86-64'
  const secondaryLabel = platform === 'windows' ? 'Download Linux host binary' : 'Download Windows host binary'

  return (
    <div className="vivado-download-panel">
      <p className="vivado-platform-note">{note}</p>
      <div className="vivado-download-actions">
        <a className="vivado-download primary" href={primary}>{primaryLabel}</a>
        <a className="vivado-download" href={secondary}>{secondaryLabel}</a>
      </div>
      {platform !== 'windows' && (
        <>
          <span>Linux one-liner:</span>
          <code>curl -fsSL https://synthexplorer.dev/vivado | sh</code>
        </>
      )}
    </div>
  )
}

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
  onConnect: (vivadoPath?: string) => Promise<{
    connected: boolean
    error?: string
    pathRequired?: boolean
  }>
  onDisconnect: () => void
}) {
  const [platform] = useState(hostPlatform)
  const [localLauncher] = useState(isLocalLauncher)
  const localMac = localLauncher && platform === 'macos'
  const [submitting, setSubmitting] = useState(false)
  const [failed, setFailed] = useState(false)
  const [failureMessage, setFailureMessage] = useState('')
  const [pathRequired, setPathRequired] = useState(false)
  const [vivadoPath, setVivadoPath] = useState('')
  const autoStarted = useRef(false)
  const submittingRef = useRef(false)

  const connect = useCallback(async (path?: string) => {
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    setFailed(false)
    setFailureMessage('')
    setPathRequired(false)
    const result = await onConnect(path)
    submittingRef.current = false
    setSubmitting(false)
    if (result.connected) onClose()
    else {
      setFailed(true)
      setFailureMessage(result.error ?? 'Vivado was not found or could not start.')
      setPathRequired(result.pathRequired === true)
    }
  }, [onClose, onConnect])

  useEffect(() => {
    if (!open) {
      autoStarted.current = false
      return
    }
    if (localLauncher && !localMac && !status && !autoStarted.current) {
      autoStarted.current = true
      void connect()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [connect, localLauncher, localMac, onClose, open, status])

  if (!open) return null

  return (
    <div className="app-modal-backdrop" role="presentation">
      <section
        className="app-modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vivado-setup-title"
      >
        <div className="app-modal-heading">
          <div>
            <h2 id="vivado-setup-title">Use Vivado on this computer</h2>
            <p>RTL goes directly to local Vivado instance. Everything stays local.</p>
          </div>
          <button type="button" className="app-modal-close" onClick={onClose} aria-label="Close">×</button>
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
        ) : localLauncher && !localMac ? (
          <div className="vivado-local-start">
            {submitting || !failed ? (
              <div className="vivado-starting" aria-live="polite">
                <BubbleLoader size={30} label="Starting Vivado" />
                <div>
                  <strong>Starting Vivado</strong>
                  <span>Checking this computer for Vivado and starting its private local connector. This may take a moment.</span>
                </div>
              </div>
            ) : (
              <>
                <div className="vivado-not-found" role="alert">
                  <strong>{pathRequired ? 'Vivado was not found' : 'Vivado could not start'}</strong>
                  <span>{failureMessage}</span>
                </div>
                <label className="vivado-path-field">
                  <span>Vivado executable path</span>
                  <input
                    type="text"
                    value={vivadoPath}
                    onChange={(event) => setVivadoPath(event.target.value)}
                    placeholder={platform === 'windows'
                      ? 'C:\\Xilinx\\Vivado\\2025.2\\bin\\vivado.bat'
                      : '/opt/Xilinx/Vivado/2025.2/bin/vivado'}
                    autoFocus
                  />
                </label>
                <button
                  className="primary vivado-connect-button"
                  type="button"
                  disabled={!vivadoPath.trim()}
                  onClick={() => void connect(vivadoPath)}
                >
                  Start Vivado
                </button>
              </>
            )}
          </div>
        ) : (
          <>
            <ol className="vivado-steps">
              <li>
                <strong>{localMac ? 'Run Vivado on a Linux or Windows host.' : 'Install Vivado locally.'}</strong>
                <span>{localMac
                  ? 'Vivado does not run natively on macOS. Start the released Synth Explorer connector on a licensed Vivado machine.'
                  : 'Vivado must be installed and licensed on the machine that will run synthesis. A free AMD license is enough for supported devices.'}</span>
              </li>
              {localMac ? (
                <li>
                  <strong>Tunnel the remote connector to this Mac.</strong>
                  <code>ssh -N -L 32125:127.0.0.1:32123 user@vivado-host</code>
                  <span>Keep the connector and SSH tunnel running while Synth Explorer uses Vivado.</span>
                </li>
              ) : (
                <li>
                  <strong>Start the local connector.</strong>
                  <PlatformDownload platform={platform} />
                  <details>
                    <summary>Vivado is not detected automatically</summary>
                    <span>Load AMD's environment before starting the connector:</span>
                    <code>source "/path/to/Vivado/settings64.sh" &amp;&amp; curl -fsSL https://synthexplorer.dev/vivado | sh</code>
                    <span>Or provide the exact executable:</span>
                    <code>curl -fsSL https://synthexplorer.dev/vivado | env VIVADO_BIN="/path/to/Vivado/bin/vivado" sh</code>
                  </details>
                </li>
              )}
              <li>
                <strong>Connect this browser.</strong>
                <span>{localMac
                  ? 'Connect below after the SSH tunnel is ready.'
                  : localLauncher
                  ? 'Connect below. Keep the launcher window open while Vivado is in use.'
                  : 'Leave the connector running, then connect below. Allow loopback-network access if your browser asks.'}</span>
              </li>
            </ol>

            <button className="primary vivado-connect-button" type="button" disabled={submitting} onClick={() => void connect()}>
              {submitting ? 'Connecting...' : 'Connect local Vivado'}
            </button>
            {failed && (
              <p className="vivado-connect-error" role="alert">
                {localMac
                  ? 'Could not reach Vivado through the SSH tunnel. Check the remote connector and tunnel, then try again.'
                  : 'Could not reach Vivado. Start the connector, then allow loopback access in your browser.'}
              </p>
            )}

            {!localLauncher && <details className="vivado-remote-instructions">
              <summary>Vivado runs on another computer</summary>
              <p>Start the connector on the licensed Linux or Windows Vivado host. It stays private on that machine's loopback interface.</p>
              <div className="vivado-remote-step">
                <span>1. On the Vivado host</span>
                <code>source "/path/to/Vivado/settings64.sh" &amp;&amp; curl -fsSL https://synthexplorer.dev/vivado | sh</code>
              </div>
              <div className="vivado-remote-step">
                <span>2. On this laptop: Linux, macOS, or Windows PowerShell</span>
                <code>ssh -N -L 32123:127.0.0.1:32123 user@vivado-host</code>
              </div>
              <p>Keep both terminals open, then click <strong>Connect local Vivado</strong>. The SSH tunnel keeps Vivado off the public network.</p>
              <details>
                <summary>The remote Vivado host runs Windows</summary>
                <p>Download and run the Windows connector on that host, enable Windows OpenSSH Server, then use the same SSH tunnel command from the laptop.</p>
              </details>
            </details>}
          </>
        )}
      </section>
    </div>
  )
}
