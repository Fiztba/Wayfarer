import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { PopoutMap } from './components/PopoutMap'
import './styles.css'

const popoutMatch = /^#popout\/(.+)$/.exec(window.location.hash)

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {popoutMatch ? <PopoutMap sessionId={popoutMatch[1]} /> : <App />}
  </React.StrictMode>
)
