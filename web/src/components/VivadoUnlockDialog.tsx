import { useEffect, useRef, useState, type FormEvent } from 'react'

export function VivadoUnlockDialog({
  open,
  onClose,
  onUnlock,
}: {
  open: boolean
  onClose: () => void
  onUnlock: (accessKey: string) => Promise<boolean>
}) {
  const passwordRef = useRef<HTMLInputElement | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (open) passwordRef.current?.focus()
  }, [open])

  if (!open) return null

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const input = passwordRef.current
    if (!input || submitting) return
    setSubmitting(true)
    const unlocked = await onUnlock(input.value)
    input.value = ''
    setSubmitting(false)
    if (unlocked) onClose()
  }

  return (
    <div className="unlock-backdrop" role="presentation">
      <section
        className="unlock-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vivado-unlock-title"
      >
        <h2 id="vivado-unlock-title">Unlock Vivado</h2>
        <p>
          Enter the owner API key. It stays only in this browser tab&apos;s memory.
        </p>
        <form method="post" autoComplete="on" onSubmit={(event) => void submit(event)}>
          <label className="unlock-password">
            <span>API key</span>
            <input
              ref={passwordRef}
              type="password"
              name="password"
              autoComplete="current-password"
              minLength={64}
              maxLength={64}
              pattern="[0-9A-Fa-f]{64}"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
          </label>
          <div className="unlock-actions">
            <button type="button" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button className="primary" type="submit" disabled={submitting}>
              {submitting ? 'Unlocking…' : 'Unlock'}
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}
