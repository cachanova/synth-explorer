interface BrandMarkProps {
  className?: string
}

/**
 * The Synth Explorer wordmark logo — the XNOR-gate-as-fish with its bubble
 * trail. Inlined (not an <img>) so body/bubbles follow --accent and the eye
 * follows --text, which lets it adapt to every palette and to light mode. The
 * standalone brand-mark.svg keeps baked colors for external/OG use.
 */
export function BrandMark({ className }: BrandMarkProps) {
  return (
    <svg
      className={className}
      viewBox="20 16 184 162"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label="Synth Explorer"
    >
      <g stroke="var(--accent)">
        <path strokeWidth="6" d="M60 40 Q136 44 170 100 Q136 156 60 160 Q100 100 60 40 Z" />
        <path strokeWidth="6" d="M46 40 Q86 100 46 160" />
        <circle strokeWidth="6" cx="181" cy="100" r="9" />
        <circle strokeWidth="3.2" cx="185" cy="80" r="5" />
        <circle strokeWidth="2.6" cx="194" cy="63" r="3.4" />
      </g>
      <circle stroke="var(--text)" strokeWidth="3.2" cx="122" cy="100" r="24" />
      <circle fill="var(--text)" cx="122" cy="100" r="10.4" />
    </svg>
  )
}
