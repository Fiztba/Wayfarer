import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { PopoutMap } from './components/PopoutMap'
import { setClientVersion } from './ansi'
import './styles.css'

// Hand the real build version to the ANSI/MXP layer before any session can
// negotiate MXP and be asked for it.
setClientVersion(window.mud.version)

const popoutMatch = /^#popout\/(.+)$/.exec(window.location.hash)

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {popoutMatch ? <PopoutMap sessionId={popoutMatch[1]} /> : <App />}
  </React.StrictMode>
)
