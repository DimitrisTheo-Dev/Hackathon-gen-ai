import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { checkSupabaseConnection, type ConnectionStatus } from './lib/supabase'
import './style.css'

const ideas = [
  'Turn a messy thought into a clear next step.',
  'Make something that gives people their time back.',
  'Help someone learn something they thought was too hard.',
  'Find the useful pattern hiding in everyday noise.',
  'Build the tool you wished you had yesterday.',
]

const statusLabels: Record<ConnectionStatus, string> = {
  checking: 'Checking Supabase…',
  connected: 'Supabase API connected',
  unavailable: 'Supabase is unreachable. Try again.',
  unconfigured: 'Supabase setup pending',
}

function App() {
  const [idea, setIdea] = useState(0)
  const [status, setStatus] = useState<ConnectionStatus>('checking')

  useEffect(() => {
    let active = true
    void checkSupabaseConnection().then(result => { if (active) setStatus(result) })
    return () => { active = false }
  }, [])

  async function recheck() {
    setStatus('checking')
    setStatus(await checkSupabaseConnection())
  }

  return (
    <div className="page">
      <header className="header">
        <a className="brand" href="/" aria-label="Hackathon Gen AI home">
          <span className="brand-mark" aria-hidden="true">h.</span>
          <span>Hackathon<br />Gen AI</span>
        </a>
        <span className="stage"><span aria-hidden="true" />Work in progress</span>
      </header>

      <main id="main">
        <div className="intro">
          <h1>Every big idea<br />starts somewhere.</h1>
          <p>This is our somewhere. A little space to experiment,<br className="wide-break" /> build, and see what happens next.</p>
        </div>

        <section className="idea-panel" aria-labelledby="idea-title">
          <div className="idea-copy">
            <h2 id="idea-title">A spark to get started</h2>
            <p className="idea" aria-live="polite" aria-atomic="true">{ideas[idea]}</p>
            <p className="demo-note">A tiny demo with a few handpicked ideas. More to come.</p>
          </div>
          <button className="shuffle" onClick={() => setIdea(current => (current + 1) % ideas.length)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 7h3c4 0 6 10 10 10h3M4 17h3c1.4 0 2.5-1.2 3.5-3M14 9c1-1.2 1.8-2 3-2h3M17 4l3 3-3 3M17 14l3 3-3 3" /></svg>
            Shuffle an idea
          </button>
        </section>
      </main>

      <footer className="footer">
        <span>The starting point. Version 0.1</span>
        <details className="connection">
          <summary>Connection status</summary>
          <div className="connection-content">
            <p role="status" className={`connection-result ${status}`}>
              <span aria-hidden="true" />{statusLabels[status]}
            </p>
            <button onClick={() => void recheck()} disabled={status === 'checking'}>Check again</button>
          </div>
        </details>
      </footer>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
