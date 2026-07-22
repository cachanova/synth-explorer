import { useEffect, useId, useRef, useState } from 'react'
import { hostPlatform, type HostPlatform } from '../lib/hostPlatform'
import {
  localChecksumUrl,
  localDownloadsFor,
  localDownloadUrl,
} from '../lib/localDownload'

const RELEASE_URL = 'https://github.com/cachanova/synth-explorer/releases/latest'

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  )
}

function PlatformInstructions({ platform }: { platform: HostPlatform }) {
  if (platform === 'windows') {
    return (
      <ol className="download-launcher-steps">
        <li>Download the Windows ZIP and choose <strong>Extract all</strong>.</li>
        <li>Open the extracted <code>synth-explorer-local</code> folder.</li>
        <li>Run <code>synth-explorer.exe</code> and keep its window open.</li>
      </ol>
    )
  }
  if (platform === 'linux') {
    return (
      <ol className="download-launcher-steps">
        <li>Download and extract the Linux archive.</li>
        <li>Open the extracted <code>synth-explorer-local</code> directory.</li>
        <li>Run <code>./synth-explorer</code> and keep its terminal open.</li>
      </ol>
    )
  }
  if (platform === 'macos') {
    return (
      <ol className="download-launcher-steps">
        <li>Download and extract the Apple silicon or Intel archive.</li>
        <li>Try to open <code>synth-explorer</code> once. Current builds are not signed or notarized.</li>
        <li>Open <strong>System Settings → Privacy &amp; Security</strong>, choose <strong>Open Anyway</strong>, then confirm <strong>Open</strong>.</li>
        <li>Keep the terminal window open while using Synth Explorer.</li>
      </ol>
    )
  }
  return (
    <ol className="download-launcher-steps">
      <li>Choose the archive matching the computer that will run Synth Explorer.</li>
      <li>Extract the complete archive; the executable must remain beside its <code>web</code> directory.</li>
      <li>Run <code>synth-explorer</code> and keep its window open.</li>
    </ol>
  )
}

function VivadoNote({ platform }: { platform: HostPlatform }) {
  if (platform === 'macos') {
    return (
      <p>
        Vivado does not run natively on macOS. Start the released connector on a licensed Linux or Windows host, then run
        {' '}<code>ssh -N -L 32125:127.0.0.1:32123 user@vivado-host</code> on the Mac.
      </p>
    )
  }
  return (
    <p>
      On Windows and Linux, the launcher includes the Vivado connector and detects a local Vivado installation at startup.
      Yosys and GHDL work without Vivado.
    </p>
  )
}

export function DownloadLauncher() {
  const [open, setOpen] = useState(false)
  const [platform] = useState(hostPlatform)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const dialogRef = useRef<HTMLElement | null>(null)
  const titleId = useId()

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      } else if (event.key === 'Tab') {
        const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled])',
        )
        if (!focusable?.length) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const close = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }
  const downloads = localDownloadsFor(platform)

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="download-launcher-trigger"
        aria-label="Download local Synth Explorer"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Download local application"
        onClick={() => setOpen(true)}
      >
        <DownloadIcon />
      </button>
      {open && (
        <div
          className="app-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close()
          }}
        >
          <section
            ref={dialogRef}
            className="app-modal-dialog download-launcher-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
          >
            <div className="app-modal-heading">
              <div>
                <h2 id={titleId}>Run Synth Explorer locally</h2>
                <p>The same private, browser-local application—packaged for offline use in a dedicated Chrome window.</p>
              </div>
              <button ref={closeRef} type="button" className="app-modal-close" onClick={close} aria-label="Close download instructions">×</button>
            </div>

            <div className="download-launcher-options">
              {downloads.map((download) => (
                <div className="download-launcher-option" key={download.asset}>
                  <a className="download-launcher-primary" href={localDownloadUrl(download.asset)}>
                    <DownloadIcon />
                    <span>Download {download.label}</span>
                  </a>
                  <a
                    className="download-launcher-checksum"
                    href={localChecksumUrl(download.asset)}
                    aria-label={`Download SHA-256 checksum for ${download.label}`}
                  >
                    SHA-256
                  </a>
                </div>
              ))}
            </div>

            <PlatformInstructions platform={platform} />
            <div className="download-launcher-note">
              <strong>Chrome or Chromium is required.</strong>
              <span>Keep the complete extracted folder together. The launcher serves only on your computer and never uploads RTL.</span>
            </div>
            <div className="download-launcher-vivado">
              <strong>Using Vivado</strong>
              <VivadoNote platform={platform} />
            </div>
            <a className="download-launcher-all" href={RELEASE_URL} target="_blank" rel="noopener noreferrer">
              View every download and release note
            </a>
          </section>
        </div>
      )}
    </>
  )
}
