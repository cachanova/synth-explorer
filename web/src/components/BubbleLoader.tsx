interface BubbleLoaderProps {
  /** Rendered height in px; width follows the mark's aspect ratio. */
  size?: number
  label?: string
  /**
   * 'brand' (default) tints the mark with theme tokens — teal body, --text eye.
   * 'mono' draws the whole mark in `currentColor`, for placement on a colored
   * ground (e.g. the teal primary button) where the accent would disappear.
   */
  tone?: 'brand' | 'mono'
}

interface SynthIconProps {
  size?: number
  tone?: 'brand' | 'mono'
  bubbles?: boolean
}

function SynthMarkGraphic({
  size,
  tone,
  bubbles,
}: Required<SynthIconProps> & { bubbles: boolean }) {
  const body = tone === 'mono' ? 'currentColor' : 'var(--accent)'
  const eye = tone === 'mono' ? 'currentColor' : 'var(--text)'
  return (
    <svg
      viewBox="20 16 184 162"
      height={size}
      width={size * 1.14}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <g stroke={body}>
        <path strokeWidth="6" d="M60 40 Q136 44 170 100 Q136 156 60 160 Q100 100 60 40 Z" />
        <path strokeWidth="6" d="M46 40 Q86 100 46 160" />
      </g>
      <circle stroke={eye} strokeWidth="3.2" cx="122" cy="100" r="24" />
      <circle fill={eye} cx="122" cy="100" r="10.4" />
      {bubbles && (
        <g stroke={body} fill="none">
          <circle className="bub b1" strokeWidth="6" cx="181" cy="100" r="8" />
          <circle className="bub b2" strokeWidth="3.4" cx="181" cy="100" r="5" />
          <circle className="bub b3" strokeWidth="2.6" cx="181" cy="100" r="3.4" />
        </g>
      )}
    </svg>
  )
}

/** Static Synth Explorer mark for non-loading states. */
export function SynthIcon({
  size = 16,
  tone = 'brand',
  bubbles = false,
}: SynthIconProps) {
  return (
    <span className="synth-icon" aria-hidden="true">
      <SynthMarkGraphic size={size} tone={tone} bubbles={bubbles} />
    </span>
  )
}

/**
 * The Synth Explorer mark (XNOR gate / fish) with its bubble trail animated:
 * bubbles stream up off the snout while work is in flight. Static, on-brand
 * fallback under prefers-reduced-motion (see `.bubble-loader` in index.css).
 *
 * Colors follow theme tokens — body/bubbles use --accent, the eye uses --text —
 * so it stays in sync with the app instead of baking hexes like the <img> logo.
 */
export function BubbleLoader({
  size = 16,
  label = 'Synthesizing',
  tone = 'brand',
}: BubbleLoaderProps) {
  return (
    <span className="bubble-loader" role="status" aria-label={label}>
      <SynthMarkGraphic size={size} tone={tone} bubbles />
    </span>
  )
}
