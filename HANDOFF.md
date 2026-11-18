# Current development handoff

This source synchronizes local development commit 77b39df. The full suite passed 87 tests before upload.

## Current example

There are no West/East room zones, room route tags or fixed room-to-room behavior. Wall layout is preserved. General area covers walkable floor and is assigned as both example creatures' allowed movement zone. Subject roaming range is an attached ring with inner radius 10 and outer radius 20; the subject chooses random destinations, prefers at least 12 cells of travel, moves, remembers the point, waits a random 8–24 ticks, emits activity, and repeats. All values are ordinary editable settings.

The pursuer chooses destinations in Outer surroundings (radius 5–10) without messages. Activity signals cause the director to send investigate with only an area snapshot from Inner surroundings (radius 0–4). The tree chooses a point from that snapshot, moves, acknowledges the handled message, searches locally, and returns to outer roaming. No unused task text field is included.

Allowed movement zones are optional, selected per tool/creature, and support multiple zones by union. Empty means unrestricted by zones. Paths, destination choices, wandering and automatic spawn respect selected boundaries. Disabled or unavailable selected geometry stops movement rather than silently removing restrictions.

The complete example is rebuilt from New canvas using actual editor controls in tests. The standalone ZIP includes editable source/ files as well as the runnable HTML. Browser-stored user projects must be exported as JSON separately.

## Online development implementation

Convex-backed anonymous online projects are implemented in `convex/` and the browser-global collaboration modules. They require a developer-owned Convex deployment and a `PROTOTEER_CONVEX_URL` at build time before the public GitHub Pages build can connect. Testers do not sign up. Owner/editor/viewer access uses high-entropy fragment links; only token digests are stored. Collaboration is desktop-only.

Online data uses chunked project checkpoints, resource-versioned incremental operations, live presence, mergeable zone painting, saved revisions, Convex File Storage, and a leased authoritative browser for shared simulation frames. Camera, zoom, selection and panels stay local. The engine does not import Convex.

Consent-gated interaction analytics and aggregated UI/board heatmap bins are implemented site-wide and separately from projects and simulation. Customers see only the consent choice and their normal project export; shared-project roles cannot read, export or delete analytics. The unlinked `analytics-admin.html` desk pages through raw records and gates reads, JSON/CSV export and deletion with the separate deployment admin key configured by `PROTOTEER_ANALYTICS_ADMIN_SHA256`. No AI analytics or eye tracking is implemented.

The user also wants clearer editor language and visible data connections. Existing changes use Message data instead of vague field wording in the behavior editor. Broader terminology changes are not blanket authorization to redesign the UI; preserve standard game-development terms where useful. Engine export adapters and a community marketplace remain future work.
