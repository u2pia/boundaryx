import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import ErrorBoundary from './ErrorBoundary'
import App from './main'
import { WorkbenchProvider } from './store'
import { LocalControlPlaneProvider } from './local-control-plane-context'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <LocalControlPlaneProvider>
        <WorkbenchProvider>
          <App />
        </WorkbenchProvider>
      </LocalControlPlaneProvider>
    </ErrorBoundary>
  </StrictMode>,
)
