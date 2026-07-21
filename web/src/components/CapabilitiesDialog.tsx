import { useEffect, useId, useRef } from 'react'
import {
  capabilitySectionsFor,
  type CapabilitiesDialogMode,
} from '../lib/capabilities'

export function CapabilitiesDialog({
  mode,
  seenVersion,
  showNewBadges,
  onClose,
}: {
  mode: CapabilitiesDialogMode
  seenVersion: number
  showNewBadges: boolean
  onClose: () => void
}) {
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const sections = capabilitySectionsFor(mode, seenVersion)

  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="capabilities-backdrop" role="presentation">
      <section
        className="capabilities-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="capabilities-heading">
          <h2 id={titleId}>Available Tools</h2>
          {mode === 'updates' && <span className="capabilities-new-tag">New</span>}
        </div>

        <div className="capabilities-card-grid">
          {sections.map((section) => (
            <article className="capabilities-card" key={section.id}>
              <h3>{section.title}</h3>
              <ul>
                {section.capabilities.map((capability) => (
                  <li key={capability.title}>
                    <div className="capabilities-item-title">
                      <span>{capability.title}</span>
                      {showNewBadges && capability.version > seenVersion && (
                        <span className="capabilities-new-tag">New</span>
                      )}
                    </div>
                    <p>{capability.description}</p>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>

        <div className="capabilities-actions">
          <button ref={closeRef} type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </section>
    </div>
  )
}
