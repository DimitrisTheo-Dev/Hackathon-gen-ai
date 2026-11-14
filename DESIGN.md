# Castroom design contract

The 14 November user refinement supersedes the prior lavender direction: warm editorial surfaces, Inter Variable, charcoal actions, neutral borders. Moonjar landing/features and supplied screenshots are the reference; original Castroom identity and honest product state remain mandatory.

Shared tokens live in apps/web/public/design.css, loaded by app and static docs. Primary controls use --ink on --surface; green only for confirmed positive state, amber for review/pending. No purple/violet/lilac/magenta or decorative gradients. Icons use Lucide 16–18px at 1.75 stroke. Font is self-hosted Inter Variable with English/Greek coverage, font-display swap.

Desktop: 260px Projects sidebar / flexible warm canvas / 360px selected-item inspector. Below 1200px sidebar condenses; below 1000px inspector opens as a sheet; phones use one card per row and full-width editor. Touch controls >=44px. Keep script edits, versions, scopes, server receipts and fixture boundaries intact.

Landing: centered 500-weight headline with -0.03em tracking and 1.02 leading; exact user clamp; restrained amber inline highlight, two pill CTAs, an honestly labeled interactive storyboard preview. Do not borrow Moonjar branding/copy or claim screenshot automation/unsupported clients work. Castroom is still a content campaign studio; product engine integration is pending.

Shared ownership: root owns tokens, global styles, app state/client/contracts, root configuration, tests/integration. Landing worker owns apps/web/src/landing/** only. Readiness worker owns packages/public-api/**, packages/cli/**, public documentation HTML/Markdown/trust pages and its dedicated tests, not proxy/config/styles/backend. No worker edits apps/api or supabase.
