import { useCallback, useRef, useState } from 'react'
import { BrandMark } from './components/BrandMark'
import { LeftPane } from './components/LeftPane'
import { RightPane } from './components/RightPane'
import { SettingsMenu } from './components/SettingsMenu'

const REPOSITORY_URL = 'https://github.com/cachanova/synth-explorer'

function GitHubMark() {
  return (
    <svg
      aria-hidden="true"
      className="repo-mark"
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <path d="M12 2C6.48 2 2 6.59 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49 0-.24-.01-1.05-.01-1.9-2.78.62-3.37-1.21-3.37-1.21-.45-1.18-1.11-1.49-1.11-1.49-.91-.64.07-.63.07-.63 1 .08 1.53 1.06 1.53 1.06.89 1.57 2.34 1.12 2.91.85.09-.67.35-1.12.63-1.38-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05A9.34 9.34 0 0 1 12 6.12c.85 0 1.7.12 2.5.35 1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.8-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.59.69.49A10.27 10.27 0 0 0 22 12.25C22 6.59 17.52 2 12 2Z" />
    </svg>
  )
}

function App() {
  const [leftWidth, setLeftWidth] = useState(46) // percent
  const dragging = useRef(false)

  const onDown = useCallback(() => {
    dragging.current = true
    document.body.style.userSelect = 'none'
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return
      const pct = (e.clientX / window.innerWidth) * 100
      setLeftWidth(Math.min(70, Math.max(24, pct)))
    }
    const onUp = () => {
      dragging.current = false
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  return (
    <div className="app">
      <header className="app-header">
        <span className="logo">
          <BrandMark className="brand-mark" />
          <span>
            Synth <span className="accent">Explorer</span>
          </span>
        </span>
        <a
          className="repo-link"
          href={REPOSITORY_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="View source on GitHub (opens in a new tab)"
        >
          <GitHubMark />
          <span>GitHub</span>
        </a>
        <SettingsMenu />
      </header>
      <div className="split">
        <div
          style={{
            width: `${leftWidth}%`,
            display: 'flex',
            minWidth: 340,
            // Hold the set width; the analysis pane (min-width:0) absorbs the
            // shrink. Otherwise a wide analysis toolbar steals editor width via
            // proportional flex-shrink.
            flexShrink: 0,
          }}
        >
          <LeftPane />
        </div>
        <div className="divider" onMouseDown={onDown} title="Drag to resize" />
        <RightPane />
      </div>
    </div>
  )
}

export default App
