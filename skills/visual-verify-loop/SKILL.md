---
name: visual-verify-loop
description: The build → serve → look → measure → fix loop for any UI change in this repo. Load whenever you change something a browser renders. It replaces "I believe it looks right" with a screenshot, a DOM read, a performance trace, and the guard suites — and it names which tool does which job so agents stop reaching for the wrong one.
---

# visual verify loop

"It compiles" and "the tests pass" are not evidence that a page looks or moves as intended. Every
UI change closes with this loop, and the report includes the artifacts, not a description of them.

## Tools, and which job each one owns

| job | tool | notes |
|---|---|---|
| serve the dev build | `preview_start` (Browser pane) with `.claude/launch.json` | never `npm run dev` via Bash |
| look at it | `computer {action: screenshot}` | one per viewport per state; `scale: 0.6` for triage, `1` for sign-off |
| read what rendered | `read_page` / `get_page_text` / `find` | text and structure — prefer over squinting at pixels |
| interact | `computer` click/type/scroll, `form_input` | then `read_page` again to confirm |
| responsive + theme | `resize_window` mobile / tablet / desktop, `colorScheme` | reset to desktop when done |
| computed CSS | `javascript_tool` | debugging only, never for implementing |
| console / network | `read_console_messages`, `read_network_requests` | **zero** external hosts is a hard requirement — any non-`self` request is a failure |
| performance | Chrome DevTools MCP (`chrome-devtools`, user scope) | trace the scroll path; 60fps or it is not done |
| library docs | Context7 MCP | `motion`, `gsap`, `@react-three/fiber` current APIs — do not guess from training data |
| wording | `rwally-claims-contract` skill + the guard suites | run on `dist/`, not `src/` |

The built-in Browser pane already covers what Playwright MCP would add; do not install a second
browser automation layer.

## The loop

1. **Build** the static output (`npm run build` in `apps/site-next`). If it does not build, stop.
2. **Serve** `dist/` (not the dev server) for sign-off — CSP and asset paths differ.
3. **Screenshot** the change at 375 / 768 / 1440 wide, light and dark where the design has both,
   `prefers-reduced-motion` on and off for anything animated.
4. **Read** the page: `read_page` for structure, `get_page_text` for copy. Confirm the pinned
   strings are present and the banned shapes are absent *in the rendered DOM*.
5. **Network**: `read_network_requests` — every request must be same-origin. One `fonts.gstatic`
   hit is a rejection.
6. **Console**: no errors, no CSP violations.
7. **Measure** motion: DevTools trace over the scroll path. Report frame time, not "smooth".
8. **Guards**: `node --test apps/site/test/site.test.mjs` pointed at `dist/`, plus
   `claims-lede-truth` and `config-doc-truth`.
9. **Report** with the screenshots attached (`SendUserFile`), the network summary, the trace
   numbers, and the guard counts. A report without artifacts is a claim.

## Adversarial pass before calling it done

Spawn a reviewer with the base-rate failure pattern, not a checklist: *a correction applied to the
instance in view rather than every instance of the shape.* For UI that means: the component you
fixed is right, and the three siblings that share its shape are not. Have the reviewer sweep
siblings and screenshot every viewport you did not.
