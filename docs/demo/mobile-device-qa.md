# Mobile device QA — Castroom

The automated checks ran on Playwright 1.65.1, Chromium 159.0.8154.6 and desktop WebKit 27.2. WebKit is not a physical iPhone. Chromium touch was synthesized through CDP, including handle tracking, reversal, dismissal and native content scrolling. No physical iOS or Android device was available in this session.

Use the authenticated preview or run `corepack pnpm dev --host 0.0.0.0` and open the printed LAN address at `/dev/studio/`. The development studio is explicitly a fixture; no rendering or publishing occurs. Test the production sign-in separately at `/studio/` without weakening authentication. Record device, OS/browser version, date and pass/fail for each item below.

| Check | iOS Safari | Android Chrome |
| --- | --- | --- |
| Landing hero, sample selection, expanded inspector and menu work in portrait and landscape. | Pending | Pending |
| Project switcher and bottom navigation remain above the home indicator/notch; browser chrome expands/collapses without clipping. | Pending | Pending |
| Open an item: preview appears first and keyboard stays closed. Back returns to its card with the draft intact. | Pending | Pending |
| Drag the visible handle down, reverse direction, release, and grab it while settling. It tracks the finger without a jump. A short drag snaps back; a deliberate swipe dismisses. | Pending | Pending |
| Scroll a long script/caption and the editor body: text can be selected, inner scrolling does not dismiss the editor, background stays still. | Pending | Pending |
| Focus title, script, caption and date fields. No input auto-zoom; Save stays reachable above the software keyboard. Rotate with keyboard open. | Pending | Pending |
| Pinch zoom and larger text remain available. At 200% text size, controls remain reachable and content reflows. | Pending | Pending |
| Taps respond immediately, without sticky hover. Test rapid taps, interrupted drags and switcher → create → close. | Pending | Pending |
| Cancel dialogs using close button, outside tap where available, Escape with hardware keyboard, and browser/Android Back. Focus returns and scrolling unlocks. | Pending | Pending |
| Edit → switch item → return → save → refresh retains the right values. Offline shows a clear state and preserves unsaved edits. | Pending | Pending |
| Toggle Reduce Motion while open: no spring/rotating-headline motion; control feedback remains. Test VoiceOver/TalkBack reading order, names and focus containment. | Pending | Pending |
| Review distinguishes draft, unavailable rendering and blocked approval. No success is shown without server confirmation. | Pending | Pending |

When Minas connects the engine: additionally test a real authorized video with audio, expired media recovery, actual render job transitions, UI/agent revision parity, and per-platform publishing receipts. Those integrations remain unavailable and were not simulated as successful in this pass.
