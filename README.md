# Prototeer

A monochrome simulation editor with custom brushes, creatures, artwork, explicit stats and tags, interaction rules, behavior trees, utility scoring, optional directors, painted and object-relative zones, and a runnable example.

## Open the portable version

Open docs/dev/index.html directly in a modern browser, or extract Prototeer.zip and open index.html. The HTML includes its CSS and JavaScript. No installation, server, account, internet connection, module loader or external fonts are needed.

Save project uses IndexedDB in the current browser. Export downloads the full project and artwork as JSON. Projects → Import JSON loads a project file. Browser storage can be blocked, cleared, or scoped differently for file URLs; keep JSON exports. If a browser save fails, Save downloads a project file instead. Existing project files from the previous hosted version remain compatible. Previously saved server projects need to be exported from that site and imported here.

## Develop and package

Use the already installed Node.js and pnpm workspace.

- pnpm test: simulation, editor reconstruction, collaboration operations, analytics privacy and portable integration tests.
- pnpm run test:portable: standalone build and browser-storage integration tests.
- pnpm run build: regenerate the self-contained docs/dev/index.html.
- pnpm run package: build the ZIP, extracted portable folder and clean GitHub upload folder.
- pnpm run dev: optional local server with disk project saves in data/ at http://localhost:3000.
- pnpm convex:dev: configure and develop the Convex backend.
- pnpm convex:deploy: deploy the Convex functions after the developer has selected a Convex project.

The portable build keeps the full editor and simulation. With no Convex deployment URL it remains browser-local and makes no network requests. JSON import/export remains the portable recovery path.

## Anonymous online projects

The development source includes an optional Convex backend for desktop collaboration. Testers do not create accounts. An owner creates a shared project and receives an owner recovery download plus separate editor and viewer links. Access secrets stay in the URL fragment and only their SHA-256 digests are stored by Convex.

Shared projects synchronize incremental board, definition, zone and graph edits; presence and remote board pointers are awareness only, so another person cannot move your camera, selection or open panels. Resource versions reject same-item stale edits instead of silently overwriting them. Full project checkpoints provide revisions. Uploaded artwork is preserved in snapshots and mirrored through Convex File Storage for live artwork changes.

One leased browser controls a shared simulation timeline. Other browsers receive its frames; the editable project remains separate and becomes the starting point of the next run. Shared editing is intentionally desktop-only in this version.

Interaction research is optional and consent-gated. It records allowlisted editor actions and aggregated click, pointer and scroll heatmap bins in separate tables. It rejects project descriptions, artwork, project JSON and access keys. Owners can export sanitized JSON or three CSV files and delete collected data. There is no AI analytics feature and mouse movement is not presented as eye tracking.

To publish online mode, deploy `convex/`, then build with `PROTOTEER_CONVEX_URL` set to that deployment's `https://...convex.cloud` URL. Without that developer deployment step, the same build continues to work locally/offline.

## Website versions

Development: https://vuhanam8-ctrl.github.io/Prototeer/dev/

Submitted version: https://vuhanam8-ctrl.github.io/Prototeer/

The root source files build the development app under docs/dev/. Preserve docs/index.html and docs/Prototeer.zip as the frozen submitted version. GitHub Pages serves main /docs. npm run package creates the development archive and an upload folder containing only docs/dev/.

## Saved example and rollback

The example has no room zones, east/west state tags or fixed room route. General area covers the walkable floor and is assigned as both creatures’ optional movement boundary. Subject roaming range (10–20 cells), Outer surroundings (5–10 cells) and Inner surroundings (0–4 cells) are editable zones attached to the moving subject. The subject chooses farther random points in its larger range; walls remain unchanged. Normal roaming chooses points in the outer ring without a message. The subject uses existing random Wait nodes (8–24 ticks) before emitting activity at random destination stops. Activity signals send fixed inner-area snapshots through the generic area message field. Investigation and local search then give way to outer roaming. All definitions can be rebuilt through editor controls; tests exercise that reconstruction. Stored destinations remain fixed until the tree chooses again. Existing user saves are never silently replaced.

Previous versions remain available through Git history. This repository uses GitHub Pages; development builds target docs/dev/.

For development publication, upload only the generated outputs/github-upload/docs/dev folder into the repository docs folder. Do not replace docs/index.html, docs/Prototeer.zip, or other submitted files. The source is included in the development ZIP.

## Optional movement limits

Edit a creature or moving object and select Allowed movement zones. Empty or absent allowedMovementZones means unrestricted movement within the board and collision boundaries. Multiple selected zones form a union; destinations, full paths, wandering and automatic spawn placement honor it. Disabled selected zones contribute no cells; an empty union prevents movement. Cells between disconnected allowed zones remain forbidden. If an edit or moving boundary leaves a creature outside its allowed union, it stops rather than teleporting or crossing forbidden cells. Manual placement is still an editor operation.
