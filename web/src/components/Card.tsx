import type { ReactNode } from 'react'

export function Card({
  k,
  v,
  accent,
  small,
  tone,
}: {
  k: string
  v: ReactNode
  accent?: boolean
  small?: boolean
  tone?: 'ok' | 'bad'
}) {
  const valueClass = ['v', accent ? 'accent' : '', tone ? `slack-${tone}` : '']
    .filter(Boolean)
    .join(' ')
  return (
    <div className="card">
      <div className="k">{k}</div>
      <div
        className={valueClass}
        style={small ? { fontSize: 15, fontFamily: 'var(--mono)' } : undefined}
      >
        {v}
      </div>
    </div>
  )
}
