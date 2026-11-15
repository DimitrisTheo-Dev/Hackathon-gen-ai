# Faceful design contract

This file was regenerated from the shipped CSS on 15 November 2026. The tokens live in `apps/web/public/design.css`, which the app and the static docs load first; that file is the source of truth for every value here. The reusable process and craft rules behind this design are in the `design-playbook` skill (`~/.agents/skills/design-playbook`).

## Identity

- **Look:** warm editorial surfaces, charcoal actions, Inter Variable, quiet borders, and calm "native app built by Apple" motion. Moonjar was the layout and quality reference; Faceful keeps its own identity, words and honest product state.
- **Colour:** no purple, violet, lilac or magenta.
- **Status colour:** green only for a confirmed positive state, amber for review or pending, red for failure. It always appears as ink on a pale fill or as a 6px dot.
- **Art:** one sunlit family (gold `#F6C404`, amber `#EEA902`, cream `#DDCB9F`, sky `#88B4C5`, from Grainient Astral-01). It appears on posters, thumbnails, empty states, avatars and the landing atmosphere, and never in operational chrome, buttons, borders or text.
- **Honesty:** never show a state the server did not confirm (rendered, scheduled, published, paid). An illustration is labelled as one. A guard (a disabled control plus its reason) stays; only its wording may move.

## Tokens in brief

- **Ink and text:** ink `#2A2A27`, which is also the primary and focus colour; secondary text `#6E6C66`; muted `#75736C` (4.54:1 on the page; use the secondary on the sidebar).
- **Surfaces:** page `#FAFAF7`, surface `#FFF`, sidebar `#F1F0EB`, border `#E4E2DA`.
- **Type:** Inter Variable, self-hosted, `font-display: swap`.
  - Weights: 400 body, 500 controls and display, 550 emphasis, 600 headings, 650 wordmark. Nothing at 700.
  - Tracking tightens with size: 0 at 12–14px, down to -.035em at 28px and above.
  - Inputs are 16px on coarse pointers.
- **Radius by class:**
  - pills (999px) for landing and onboarding buttons, chips and status pills;
  - 10px for in-app buttons; 8px for icon buttons and sidebar rows;
  - cards step 14 → 16 → 18 → 22 (composer) → 24 (sign-in);
  - a nested radius equals the outer radius minus the inset.
- **Elevation:** a raised surface gets a `1px solid transparent` border plus `--elev-1`, with `--elev-2` on hover and selection. Hover deepens the shadow and never moves the element.
- **Motion:**
  - curves `--ease-out` (.23,1,.32,1), `--ease-in-out` (.77,0,.175,1) and `--ease-drawer` (.32,.72,0,1);
  - press 120ms at `scale(.97)`; state changes 160–220ms; surfaces 320–440ms;
  - keyboard-opened surfaces appear at once;
  - hover effects only under `(hover: hover) and (pointer: fine)`;
  - reduced motion keeps fades and drops movement.
- **Icons:** Lucide, 13–16px in the app at the default stroke of 2 (2.25 for emphasis) and stroke 1.75 on the landing. Agent marks are real logos on app-icon tiles.

## Focus

- **Controls:** a 2px ink ring, 2px outside the edge.
- **Fields:** a 1px inset line, with no halo.
- **Composite controls** (composers, search, OTP): the wrapper draws the one indicator.
- **Create's preference pills** (Format, Length, Language, Presenter): the pill lights up instead of being ringed. Its edge turns golden `--highlight-edge` (dashed while unset, solid once set), with a warm fill and a 3px amber glow. Focus appears at once and fades out; forced-colors mode gets a system outline.
- **Rows inside a clipped list:** an inset ring that follows the list's corners.
- **A dialog that takes focus itself:** an inset ring.
- **Cascade:** these rules are unlayered, so a refinement of them must be unlayered too.
- **Scrolling containers:**
  - a scrolling row or list carries padding equal to the ring's reach (4px) with a matching negative margin;
  - the canvas scroller keeps 12px of scroll padding;
  - `ring-audit.mjs` in the design-playbook skill checks all of this.
- **Whole-row targets** (Details rows) get no press transform: a transform shrinks their row-wide hit area to the label.

## Layout

| Width | Layout |
|---|---|
| 1001px and up | Projects sidebar 248px, flexible canvas, AI Director or inspector 392px (264 and 420 from 1600px). The frame is inset 10px with radius 16. |
| 761–1220px | The sidebar becomes a 60px icon rail. |
| 1000px and below | The inspector becomes a native full-screen dialog with a 44px grip row; swipe dismissal belongs only to the grip. |
| 760px and below | Phone: project switcher in the top bar, a 4-tab bottom dock, modals as bottom sheets, one portrait card per row. Touch targets are at least 44px, with safe-area padding on every edge. |

## Surfaces

- **Create** (the home view): a centred "What will we create today?", one composer with Format, Length and Language pills, suggestion chips, "Create with my own script", and "Pick up where you left off". It never shows past turns. Sending docks the conversation beside the canvas, and that is where the history lives.
- **Canvas:** 9:16 cards in `auto-fill minmax(204px, 1fr)`. Each card is one button; its status pill sits on the art. Selection is a 2px ink shadow.
- **Details:** iOS-settings rows (Guidance, Presenter & style, Channels, Posting times, Versions) that open in place, with a glass footer.
- **Landing:**
  - a 500-weight headline at 1.02 leading and -0.03em tracking, using the owner's `clamp()`;
  - "What if ⟨agent⟩ made your next video campaign?" with zero layout shift (its own line, a clip-path chip, metric-matched fallback fonts);
  - two pill CTAs and an amber inline highlight;
  - a coded demo of the real studio.

  Moonjar branding and copy are never borrowed, and unsupported clients are never claimed.
- **Channels:** YouTube is the one real destination. Instagram and TikTok are shown as unavailable until each platform's app review is passed.

## Ownership

- **Root** owns the tokens, global styles, app state, client and contracts, root configuration and the integration tests.
- **Workers** each own the files their brief names and request shared changes in their report.
- **No worker** edits `apps/api` or `supabase`.
