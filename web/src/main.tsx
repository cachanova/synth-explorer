import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ThemeProvider } from './lib/theme.tsx'
import { loadWorkspace } from './lib/workspaceStorage.ts'
import { StoreProvider } from './store.tsx'

async function renderApp() {
  const initialWorkspace = await loadWorkspace()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ThemeProvider>
        <StoreProvider initialWorkspace={initialWorkspace}>
          <App />
        </StoreProvider>
      </ThemeProvider>
    </StrictMode>,
  )
}

void renderApp()
