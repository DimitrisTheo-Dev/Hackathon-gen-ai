# Hackathon Gen AI

A placeholder website built with React, TypeScript, and Vite. It includes a local idea shuffle demo and a real, read-only Supabase API connection check.

## Development

Use Node.js 24 and npm.

```sh
npm ci
cp .env.example .env.local
# Set VITE_SUPABASE_PUBLISHABLE_KEY in .env.local.
npm run dev
```

`npm run build` type-checks the app and creates `dist/`. `npm run preview` serves the production build locally.

## Supabase

Project: `hgsgvdujzatfhsjoojll`

Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in Vercel for production, preview, and development. Vite embeds these public values at build time, so redeploy after changing them.

The shared client is in `src/lib/supabase.ts`. The connection indicator checks `/auth/v1/settings`; it verifies the project API and publishable key, not database permissions. No tables, users, policies, or data are changed. The idea demo runs locally and does not call an AI model or save data.

Never put a Supabase secret or service-role key in a `VITE_` variable or frontend code. Use row-level security and explicit policies when adding database tables.

## Deployment

Vercel builds `main` for production and other branches for previews through its GitHub connection. The repository stays private.

- [GitHub repository](https://github.com/DimitrisTheo-Dev/Hackathon-gen-ai)
- [Supabase project](https://supabase.com/dashboard/project/hgsgvdujzatfhsjoojll)
