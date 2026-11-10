# Prototeer

A monochrome simulation editor with custom brushes, creatures, artwork, explicit stats and tags, interaction rules, behavior trees, utility scoring, optional directors, painted and object-relative zones, and a runnable example.

## Open the portable version

Open docs/index.html directly in a modern browser, or extract Prototeer.zip and open index.html. The HTML includes its CSS and JavaScript. No installation, server, account, internet connection, module loader or external fonts are needed.

Save project uses IndexedDB in the current browser. Export downloads the full project and artwork as JSON. Projects → Import JSON loads a project file. Browser storage can be blocked, cleared, or scoped differently for file URLs; keep JSON exports. If a browser save fails, Save downloads a project file instead. Existing project files from the previous hosted version remain compatible. Previously saved server projects need to be exported from that site and imported here.

## Develop and package

Use the already installed Node.js; there are no dependencies to install.

- npm test: simulation, editor reconstruction and HTTP backend tests.
- npm run test:portable: standalone build and browser-storage integration tests.
- npm run build: regenerate the self-contained docs/index.html.
- npm run package: build the ZIP, extracted portable folder and clean GitHub upload folder.
- npm run dev: optional local server with disk project saves in data/ at http://localhost:3000.

The portable build keeps the full editor and simulation. Cloud project storage is replaced with browser-local saves plus JSON files. The optional server retains disk-based storage. There is no cross-device sync or collaboration feature.

## GitHub Pages

Upload the contents of outputs/github-upload/ to a new repository named Prototeer. In repository Settings → Pages select Deploy from a branch, main, /docs, then Save. The deployment serves docs/index.html; its Download ZIP link serves docs/Prototeer.zip. No GPT Sites account or backend is used. The repository must be accessible to GitHub Pages under your account's plan.

## Saved example and rollback

The example uses six disjoint zones. West room and East room are sent directly by the existing observed-current-zone director option. All definitions can be rebuilt through editor controls; tests exercise that reconstruction. Stored destinations remain fixed until the tree chooses again. Existing user saves are never silently replaced.

The original Sites build files remain in the development checkout for rollback; they are excluded from the portable ZIP and clean GitHub upload folder. Git history and existing rollback tags are retained locally.
