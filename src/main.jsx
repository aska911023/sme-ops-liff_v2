import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from './contexts/AuthContext'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import './index.css'
import { applyFontScale, getFontScale } from './lib/fontScale.js'

// 套用使用者偏好的字體大小（從 localStorage）
applyFontScale(getFontScale())

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>
)
