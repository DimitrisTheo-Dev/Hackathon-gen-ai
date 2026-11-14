import { lazy, Suspense, useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import type { Session } from "@supabase/supabase-js";
import {
  ArrowUpRight,
  ArrowLeft,
  LockKeyhole,
  LoaderCircle,
} from "lucide-react";
import { supabase } from "./lib/supabase";
import type { StudioClient } from "./data/client";
import { createLiveClient } from "./data/live";
const Studio = lazy(() =>
  import("./views/Studio").then((m) => ({ default: m.Studio })),
);
import { Mark, Notice } from "./components/ui";
import "./style.css";

declare const __FIXTURE_ENABLED__: boolean;
function App() {
  const isFixture =
    location.pathname.startsWith("/dev/studio") && __FIXTURE_ENABLED__;
  const [client, setClient] = useState<StudioClient | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const isStudio = location.pathname.startsWith("/studio") || isFixture;
  useEffect(() => {
    if (!isStudio) {
      setLoading(false);
      return;
    }
    if (isFixture && __FIXTURE_ENABLED__) {
      import("./data/fixture")
        .then((m) => {
          setClient(m.createFixtureClient());
          setLoading(false);
        })
        .catch(() => {
          setError(
            "The development preview could not load. Reload to try again.",
          );
          setLoading(false);
        });
      return;
    }
    if (!supabase) {
      setError("Authentication is not configured for this deployment.");
      setLoading(false);
      return;
    }
    void supabase.auth.getSession().then(({ data, error }) => {
      setSession(data.session);
      if (error) setError(error.message);
      setLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (!next) setClient(null);
    });
    return () => data.subscription.unsubscribe();
  }, [isStudio, isFixture]);
  useEffect(() => {
    if (!session || isFixture) return;
    const origin = import.meta.env.VITE_CASTROOM_API_URL;
    if (origin)
      try {
        setClient(
          createLiveClient(origin, async () => {
            const result = await supabase!.auth.getSession();
            return result.data.session?.access_token ?? null;
          }),
        );
      } catch (e) {
        setError(
          e instanceof Error
            ? e.message
            : "The studio API is not configured correctly.",
        );
      }
  }, [session, isFixture]);
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    setSending(true);
    setError("");
    const email = String(new FormData(event.currentTarget).get("email"));
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: false,
          emailRedirectTo: `${location.origin}/studio/`,
        },
      });
      if (error) throw error;
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed. Try again.");
    } finally {
      setSending(false);
    }
  }
  if (!isStudio)
    return (
      <div className="public-home">
        <header>
          <a className="wordmark" href="/">
            <Mark />
            Castroom
          </a>
          <nav>
            <a href="/docs/">Documentation</a>
            <a className="button primary" href="/studio/">
              Open studio <ArrowUpRight size={16} />
            </a>
          </nav>
        </header>
        <main>
          <span className="eyebrow">The studio your agent can work in</span>
          <h1>
            Good content.
            <br />A shared place to make it.
          </h1>
          <p>
            Bring a brief. Shape a campaign with your agent. Review the details
            together before anything goes out.
          </p>
          <div className="home-actions">
            <a className="button primary" href="/studio/">
              Connect your workspace <ArrowUpRight size={16} />
            </a>
            <a className="button secondary" href="/docs/setup/">
              Agent setup
            </a>
          </div>
          <div className="home-note">
            In development. Live rendering, publishing and agent authentication
            are awaiting the engine integration.
          </div>
        </main>
        <footer>
          Castroom · Hackathon build{" "}
          <a href="/docs/capabilities/">What works today</a>
          {__FIXTURE_ENABLED__ && (
            <a href="/dev/studio/">Explore development studio</a>
          )}
        </footer>
      </div>
    );
  if (client)
    return (
      <Suspense
        fallback={
          <div className="loading-page">
            <Mark />
            <p>Opening your studio…</p>
          </div>
        }
      >
        <Studio
          client={client}
          onSignOut={
            isFixture ? undefined : () => void supabase?.auth.signOut()
          }
        />
      </Suspense>
    );
  return (
    <div className="auth-page">
      <a className="wordmark" href="/">
        <Mark />
        Castroom
      </a>
      <main className="auth-card">
        <span className="auth-symbol">
          <LockKeyhole size={24} />
        </span>
        <h1>
          {loading
            ? "Opening your workspace…"
            : session
              ? "Your studio is waiting"
              : "Your next campaign starts here."}
        </h1>
        {loading ? (
          <LoaderCircle className="spin" />
        ) : session ? (
          <>
            <p>
              You’re signed in. The shared engine has not been connected to this
              deployment yet. Your private campaigns will appear when it’s
              available.
            </p>
            <a className="button secondary" href="/docs/">
              View integration status
            </a>
            <button
              className="text-button"
              onClick={() => void supabase?.auth.signOut()}
            >
              Sign out
            </button>
          </>
        ) : (
          <>
            <p>
              Sign in with your workspace email. We’ll send you a secure sign-in
              link.
            </p>
            {sent ? (
              <Notice>
                If this email has a Castroom account, a sign-in link is on its
                way. Check your inbox, then return here.
              </Notice>
            ) : (
              <form onSubmit={login}>
                <label htmlFor="email">Work email</label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@company.com"
                  required
                />
                <button
                  className="button primary"
                  disabled={sending || !supabase}
                >
                  {sending ? "Sending link…" : "Email me a sign-in link"}
                </button>
              </form>
            )}
            <small>
              Invited workspace members only. Agent tokens are created
              separately inside the studio.
            </small>
          </>
        )}
        {error && <Notice error>{error}</Notice>}
        <a className="quiet-link" href="/docs/setup/">
          <ArrowLeft size={14} /> Setup instructions
        </a>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
