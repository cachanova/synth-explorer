import { useEffect, useState } from 'react'
import { isLocalLauncher } from '../lib/localLauncher'
import type { VivadoBridgeStatus } from '../types'

const RELEASE_BASE = 'https://github.com/cachanova/synth-explorer/releases/latest/download'
const LINUX_DOWNLOAD = `${RELEASE_BASE}/synth-explorer-vivado-bridge-linux-x86_64`
const WINDOWS_DOWNLOAD = `${RELEASE_BASE}/synth-explorer-vivado-bridge-windows-x86_64.exe`

type HostPlatform = 'linux' | 'windows' | 'macos' | 'other'

function hostPlatform(): HostPlatform {
  const agent = navigator.userAgent.toLowerCase()
  if (agent.includes('windows')) return 'windows'
  if (agent.includes('macintosh') || agent.includes('mac os')) return 'macos'
  if (agent.includes('linux')) return 'linux'
  return 'other'
}

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
  onConnect: () => Promise<boolean>
  onDisconnect: () => void
}) {
  const [platform] = useState(hostPlatform)
  const [localLauncher] = useState(isLocalLauncher)
  const localMac = localLauncher && platform === 'macos'
  const [submitting, setSubmitting] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!open) return
    setFailed(false)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, open])

  if (!open) return null

  const connect = async () => {
    if (submitting) return
    setSubmitting(true)
    setFailed(false)
    const connected = await onConnect()
    setSubmitting(false)
    if (connected) onClose()
    else setFailed(true)
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
            <p>Your RTL goes directly from this browser to Vivado. It is not sent to Synth Explorer servers.</p>
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
              ) : localLauncher ? (
                <li>
                  <strong>The connector is built into this launcher.</strong>
                  <span>It detects Vivado when Synth Explorer starts. If Vivado was not found, restart the launcher after loading AMD's environment or pass <code>--vivado /path/to/Vivado/bin/vivado</code>.</span>
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
                  : localLauncher
                  ? 'Could not reach Vivado. Check the launcher window, then restart it with Vivado configured.'
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
