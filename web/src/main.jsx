import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import * as Sentry from '@sentry/react'
import './index.css'
import App from './App.jsx'

Sentry.init({
  dsn: 'https://39227cf5c32da9021aeec27894287888@o4511246689304576.ingest.us.sentry.io/4511246705623040',
  integrations: [
    Sentry.browserTracingIntegration(),
    Sentry.replayIntegration({
      maskAllText: false,
      blockAllMedia: false,
    }),
  ],
  tracesSampleRate: 0.1,       // 10% 请求追踪，节省配额
  replaysSessionSampleRate: 0, // 不录制正常会话
  replaysOnErrorSampleRate: 1, // 出错时录制回放，方便复现
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
