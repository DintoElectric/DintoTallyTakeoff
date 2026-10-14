# Tally: electrical fixture and device counting

Upload a PDF drawing set, split it into sheets, count fixtures and devices by hand on each sheet, and export the counts to Excel or Word. "Tally" is a placeholder name (one `APP_NAME` constant in `shared/limits.ts`).

Stack: React 18 + TypeScript + Vite, pdf.js, Netlify Functions, Netlify Identity (invite-only), Netlify Database (Postgres) and Netlify Blobs. Built from the `design_handoff_tally_takeoff` spec.

## What works in this version (spec stages 0 to 3)
Login with roles, projects, chunked PDF upload, sheet index (title-block reading, floor and kind suggestions, thumbnails), manual counting workspace (zoom, pan, pinch, markers, undo/redo, autosave), item library, Excel and Word export.

Not built yet (stages 4 to 6): Count similar, review queue, legend import, auto-detect, revisions and compare. Also not built: OCR for scanned sheets, "Set title block area", TIFF, drawn floor areas. Those buttons are visible but disabled.

## One-time setup
1. **Push to GitHub.** Create an empty repo, then:
   `git init && git add . && git commit -m "Initial Tally scaffold" && git branch -M main && git remote add origin <your-repo-url> && git push -u origin main`
2. **Create the Netlify site** from that repo (Add new project, Import from Git). Build command `npm run build`, publish directory `dist` (both are already in `netlify.toml`).
3. **Check the plan.** Netlify Database needs a **credit-based** plan (Billing in the Netlify dashboard).
4. **Identity.** Project configuration, Identity, Enable. Set registration to **Invite only**. Do this before sharing the URL.
5. **Database.** Nothing to click: the `@netlify/database` dependency makes Netlify provision it on the first deploy and apply `netlify/database/migrations/` automatically. Never edit an applied migration; add a new timestamped one.
6. **Environment variables** (Site configuration, Environment variables):
   - `ADMIN_EMAILS` = your email (comma-separated for more). These accounts are always admins.
   - `MAX_FILE_MB` (optional, default 200).
7. **Invite yourself** in the Identity tab, accept the email, and sign in.

Roles: set `viewer`, `estimator` or `admin` on a user in the Identity dashboard. No role means estimator.

## Local development
- `npm install`, then `npm run typecheck` and `npm test` (unit tests plus a Postgres check of the migration).
- `npm run dev` runs `netlify dev` (needs Netlify CLI 26 or newer, Node 22.12 or newer). **Identity does not work under `netlify dev`**, so test login on a Deploy Preview or the live site.
- Deploy Preview links are public and their database branch is a copy of production data. Do not paste them into public places.

## Layout
- `shared/` limits and types used by both sides (`limits.ts` is the one place for every limit)
- `netlify/functions/` API (`/api/*` is rewritten to the function of the same name); `_lib/` holds auth, db, blobs, validation
- `netlify/database/migrations/` schema
- `src/` the app: `auth/`, `app/`, `screens/`, `viewer/`, `upload/`, `export/`, `detect/`, `styles/`

## Known deviations from the handoff
Migrations path follows current Netlify docs. A few extra endpoints (project counts, file list, finish, cancel, export data). Markers always use one canvas overlay. Exports group by floor only (no areas yet); Word per-floor tables are by sheet.
