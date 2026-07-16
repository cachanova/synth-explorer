interface BubbleLoaderProps {
  /** Rendered height in px; width follows the mark's aspect ratio. */
  size?: number
  label?: string
}

/**
 * The Synth Explorer mark (XNOR gate / fish) with its bubble trail animated:
 * bubbles stream up off the snout while work is in flight. Static, on-brand
 * fallback under prefers-reduced-motion (see `.bubble-loader` in index.css).
 *
 * Colors follow theme tokens — body/bubbles use --accent, the eye uses --text —
 * so it stays in sync with the app instead of baking hexes like the <img> logo.
 */
export function BubbleLoader({ size = 16, label = 'Synthesizing' }: BubbleLoaderProps) {
  return (
    <span className="bubble-loader" role="status" aria-label={label}>
      <svg
        viewBox="20 16 184 162"
        height={size}
        width={size * 1.14}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {/* static fish body */}
        <g stroke="var(--accent)">
          <path strokeWidth="6" d="M60 40 Q136 44 170 100 Q136 156 60 160 Q100 100 60 40 Z" />
          <path strokeWidth="6" d="M46 40 Q86 100 46 160" />
        </g>
        {/* eye */}
        <circle stroke="var(--text)" strokeWidth="4" cx="122" cy="100" r="30" />
        <circle fill="var(--text)" cx="122" cy="100" r="13" />
        {/* bubbles streaming from the snout */}
        <g stroke="var(--accent)" fill="none">
          <circle className="bub b1" strokeWidth="6" cx="181" cy="100" r="8" />
          <circle className="bub b2" strokeWidth="3.4" cx="181" cy="100" r="5" />
          <circle className="bub b3" strokeWidth="2.6" cx="181" cy="100" r="3.4" />
        </g>
      </svg>
    </span>
  )
}
