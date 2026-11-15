# Creative Director on Gemini, production

Date: 15 Nov 2026. Deployment: production at https://faceful.vercel.app, built from `946b7a1` (PR #32). Model: `gemini-4-hydrogen` through Google's `generateContent` API, thinking level `low`. `GEMINI_API_KEY` is a Secret in Vercel's Production environment. It was never printed or committed.

## Configuration

- `GET /v1/health` → `"director":"ai"`.
- `GET /api/public/status` → `engine.director: "ai"`.

## Real turns on production

The smoke account signed in with a password session and called `POST /v1/studio/director/turn` like the studio does.

| Turn | Result | Time |
| --- | --- | --- |
| "Make two 20-second videos for BeWell, a festival app in Athens: you can now build your own lineup and get a reminder before each set. Friendly, for students." | HTTP 200, `mode: "ai"`. Project created with 2 English drafts; the reply says nothing was rendered or scheduled. | 7.1 s |
| On the first draft, item scope: "Make this one shorter and punchier, and translate it to Greek." | HTTP 200, `mode: "ai"`. One `revise` proposal with a Greek script. Nothing is saved until a person applies it. | 7.0 s |

## Before the deploy (local engine, real Google API, same key)

- The English prompt above: 2 drafts in 5.6 s.
  - Usage: 2,343 prompt tokens, 439 output tokens, 491 thinking tokens.
  - At Vercel AI Gateway list prices for this model ($1.50 in / $7.50 out per million), that is about one US cent per turn.
- A Greek prompt: a natural Greek 15-second script in 7.6 s.
- `gemini-3.8-flash` comparison: 2 drafts in 5.7 s.

## Tests

On a clean checkout of `b931cb2` with its own install:
- typecheck clean, 302/302 unit tests (including `tests/gemini.test.ts`), and the production build;
- browser suites: fresh 74, landing 20, live 17, onboarding 13, pitch 10, all passed.
