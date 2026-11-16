# Prototeer

A monochrome simulation editor with custom brushes, creatures, artwork, explicit stats and tags, interaction rules, behavior trees, utility scoring, optional directors, painted and object-relative zones, and a runnable example.

## Open the portable version

Open docs/dev/index.html directly in a modern browser, or extract Prototeer.zip and open index.html. The HTML includes its CSS and JavaScript. No installation, server, account, internet connection, module loader or external fonts are needed.

Save project uses IndexedDB in the current browser. Export downloads the full project and artwork as JSON. Projects → Import JSON loads a project file. Browser storage can be blocked, cleared, or scoped differently for file URLs; keep JSON exports. If a browser save fails, Save downloads a project file instead. Existing project files from the previous hosted version remain compatible. Previously saved server projects need to be exported from that site and imported here.

## Develop and package

Use the already installed Node.js; there are no dependencies to install.

- npm test: simulation, editor reconstruction and HTTP backend tests.
- npm run test:portable: standalone build and browser-storage integration tests.
- npm run build: regenerate the self-contained docs/dev/index.html.
- npm run package: build the ZIP, extracted portable folder and clean GitHub upload folder.
- npm run dev: optional local server with disk project saves in data/ at http://localhost:3000.

The portable build keeps the full editor and simulation. Cloud project storage is replaced with browser-local saves plus JSON files. The optional server retains disk-based storage. There is no cross-device sync or collaboration feature.

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
