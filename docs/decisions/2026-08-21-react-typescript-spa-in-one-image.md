# React + TypeScript SPA, built into the same image

**Date:** 2026-08-21
**Status:** accepted

## Context

The UI was Jinja2 templates plus one 681-line `app/static/app.js` and a
151-line stylesheet. It worked, and for a long time it was the right amount of
machinery. What it could no longer carry:

- **Every screen re-implemented the same five states by hand.** Loading, empty,
  error, in-flight, and disabled were each a `textContent = "…중"` somewhere.
  Several surfaces had only some of them, so a button would sit there doing
  nothing visible while a request was out.
- **Three hand-written polling loops**, each with its own `setInterval`, its own
  stop condition, and its own guard against redrawing over what an operator was
  typing (`document.activeElement !== $("#m-held")`).
- **The dialog was a real bug.** `.modal { display: flex }` is an author rule and
  outranks the browser's `[hidden] { display: none }`, so the `hidden` attribute
  the script toggled did nothing: the scope dialog was on screen from page load
  and neither ✕ nor 선택 완료 could close it. It needed a CSS line, a test to pin
  that line, and a comment explaining why the test exists. There was no focus
  trap and no `aria-modal` at all.
- **Every value reaching the DOM went through a hand-written `escapeHtml`** and a
  template literal. One missed call is an XSS.
- **The user came from Jinja context**, so the header could not be rendered
  without a server round trip that knew who was asking.
- Server-derived state lived in module-level `let` variables (`sid`, `scope`,
  `picked`) with no single place that said what the server currently holds.

None of that is fatal on four screens. All of it gets worse on five, and the
product is growing surfaces (Meeting Intelligence arrived this week).

## Decision

Replace the whole UI with a React + TypeScript single-page app under
`frontend/`, built by Vite, and **keep everything else exactly as it was**: one
repository, one Docker image, one container, one port, one origin, one FastAPI
process.

- **React + TypeScript.** The component model is what removes the
  loading/error/empty duplication; `strict` TypeScript is what makes the API
  boundary checkable — `api/types.ts` is now the only description of what the
  server returns, and a renamed field fails the build instead of rendering
  `undefined`.
- **Vite, not Next.js or Remix.** FastAPI is already the application server.
  There is no SSR requirement, no SEO surface (the whole app is behind a login),
  and no server action that FastAPI does not already own. A meta-framework would
  add a second server to run and a second place where routing decisions live.
- **Node at build time only.** The Dockerfile gained a first stage that runs
  `npm ci && npm run build`; the runtime image receives `frontend/dist` and
  nothing else. No node, no npm, no `node_modules`, no frontend source in the
  shipped image.
- **FastAPI serves the build.** `app/main.py:spa` is registered last, so every
  API route wins; it returns a real file from `frontend/dist` when the path is
  one, and `index.html` otherwise. An unmatched `/api/...` is a `404`, never the
  shell — an API caller must not have to parse HTML to learn its request was
  wrong.
- **The auth boundary moved from pages to the API.** `require_login` now closes
  every `/api/*` except `POST /api/auth/login`. The shell is public and is the
  same bytes for everyone; the browser asks `GET /api/auth/me` (new, and the only
  endpoint this migration added) and React Router sends a `401` to `/login`. The
  session stays an `HttpOnly` cookie — no token in `localStorage`, no
  `Authorization` header, no CORS anywhere, because the origin never changes.

### Packages, and what each one is for

| package | what it does | why it earns its place | rejected instead |
|---|---|---|---|
| `react`, `react-dom` | UI | the decision above | — |
| `typescript` | types | catches API-shape drift at build time | plain JS + JSDoc |
| `vite`, `@vitejs/plugin-react` | build, dev server | dev proxy reproduces the single origin; `npm run build` is the only artefact step | Next.js, Remix, webpack |
| `tailwindcss` + `@tailwindcss/vite` | styling, design tokens | `@theme` in one file is the single source of colour/spacing/radius; no separate config file, no CSS-in-JS runtime | CSS modules (tokens end up copied), styled-components (runtime cost) |
| `@tanstack/react-query` | server state | replaces three hand-rolled polling loops, and makes "the server is the truth" the default rather than a discipline | SWR (equivalent; Query's `refetchInterval` predicate expresses "stop when settled" directly), hand-written hooks |
| `react-router` | routing | deep links and refresh must work; nothing smaller does history + params | hash routing, hand-written `popstate` |
| `@radix-ui/react-dialog` | dialog primitive | focus trap, ESC, backdrop, `aria-modal`, focus restore — the exact bug class that bit this repo, solved once | the previous hand-written modal, `<dialog>` (focus trap and backdrop behaviour still hand-rolled) |
| `lucide-react` | icons | one icon set, tree-shaken | inline SVG per component, an icon font |
| `sonner` | toasts | portal + stacking + timers + live region; ~3 KB | a hand-written toast (that is the portal/stacking problem again) |
| `clsx` | conditional classes | 200 bytes, used everywhere | string concatenation |
| `vitest`, `@testing-library/*`, `jsdom` | tests | same transform pipeline as the build | Jest (a second transform config) |
| `@playwright/test` | browser smoke | proves the shipped bundle works in a real engine | none — the browsers were already cached, so the cost was config, not download |
| `eslint`, `typescript-eslint`, `eslint-plugin-react-hooks` | lint | the React Compiler rules caught four real "sync props into state in an effect" mistakes during this migration | none |

**Deliberately not added:** Redux, MobX, Zustand (the database is the truth;
adding a store means keeping a second copy of it), Zod (the API is same-origin,
first-party, and typed on both ends — runtime validation of our own server buys
nothing), React Hook Form (two forms, four fields), `date-fns` (`Intl` and
`<input type="datetime-local">` already do it), `tailwind-merge` (`clsx` is
enough at this component count), an OpenAPI generator (twenty endpoints; the
hand-written `types.ts` is shorter than the generator's config), Framer Motion,
a component kit beyond the one primitive that was actually hard, MSW (the fetch
stub in `src/test/harness.tsx` is thirty lines), and Prettier (ESLint is
configured for correctness only, so there is nothing to conflict with).

## Rejected

- **Keep Jinja and add React only where it hurts.** A hybrid means two routers,
  two escaping models, and two places to look for any given screen — permanently,
  because there is never a moment when finishing the migration is urgent.
- **Split into `minutes-frontend` and `minutes-backend`.** Two repositories, two
  images, two deploy steps, a CORS configuration, and a versioning contract
  between them — for one team and one deployable.
- **Serve the SPA from nginx beside the app.** A second container and a second
  place routing is decided, to avoid a `FileResponse`.
- **A `/spa/{path}` prefix instead of a catch-all.** Uglier URLs to avoid one
  `startswith("api/")` check.
- **Server-rendered user context (`/api/auth/me` avoided).** It would mean the
  shell differs per user, which loses caching and puts identity back into HTML.
- **Bake the CA bundle into the image, or `NODE_TLS_REJECT_UNAUTHORIZED=0`.** The
  corporate TLS proxy breaks `npm ci` with `SELF_SIGNED_CERT_IN_CHAIN`, the same
  way it once broke model downloads. Disabling verification to fix a certificate
  error is not a fix. It is a build secret (`--mount=type=secret`) pointing at
  the host bundle compose already mounts at runtime — absent and unused where no
  proxy intercepts, and never written into a layer.
- **Dark mode.** The tokens make it cheap to add later, but it doubles what has
  to be looked at on every screen, and light-mode quality came first.

## Consequences

- **Node is now required to build.** `docker compose build` handles it; a
  developer running uvicorn directly needs `npm run build` once, or `npm run dev`
  with the proxy. Without a build, pages return `503` with that instruction
  rather than a blank screen.
- **The image gained a build stage but no runtime weight.** `frontend/dist` is
  about 430 KB uncompressed.
- **`jinja2` left `requirements.txt`.** Nothing else imported it.
- **Two test suites now.** `pytest tests` for the backend, `npm test` in
  `frontend/`. `tests/test_frontend.py` no longer inspects CSS and JS strings; it
  pins the routing contract and checks the built bundle for secrets.
- **No database change.** This wave added no migration and altered no column.
- **What this makes harder:** a one-line UI tweak is no longer a one-file edit
  with no build. That is the trade — the previous arrangement bought that
  immediacy with a hand-maintained modal, three polling loops, and manual
  escaping.
- **When to revisit the single-image shape:** if the frontend ever needs to
  deploy on a different cadence than the pipeline, if a second client
  (mobile, another service) starts consuming the same API, or if the SPA needs a
  CDN in front of it. None of those exist today.
