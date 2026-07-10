import { useCallback, useRef, useState } from 'react'
import { LeftPane } from './components/LeftPane'
import { RightPane } from './components/RightPane'

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
          <img className="brand-mark" src="/brand-mark.svg" alt="" aria-hidden="true" />
          <span>
            Synth <span className="accent">Explorer</span>
          </span>
        </span>
        <span className="tagline">Compiler Explorer for RTL — synthesize & explore the netlist</span>
      </header>
      <div className="split">
        <div style={{ width: `${leftWidth}%`, display: 'flex', minWidth: 340 }}>
          <LeftPane />
        </div>
        <div className="divider" onMouseDown={onDown} title="Drag to resize" />
        <RightPane />
      </div>
    </div>
  )
}

export default App
