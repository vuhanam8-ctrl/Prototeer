# Current development handoff

This source synchronizes local development commit 77b39df. The full suite passed 87 tests before upload.

## Current example

There are no West/East room zones, room route tags or fixed room-to-room behavior. Wall layout is preserved. General area covers walkable floor and is assigned as both example creatures' allowed movement zone. Subject roaming range is an attached ring with inner radius 10 and outer radius 20; the subject chooses random destinations, prefers at least 12 cells of travel, moves, remembers the point, waits a random 8–24 ticks, emits activity, and repeats. All values are ordinary editable settings.

The pursuer chooses destinations in Outer surroundings (radius 5–10) without messages. Activity signals cause the director to send investigate with only an area snapshot from Inner surroundings (radius 0–4). The tree chooses a point from that snapshot, moves, acknowledges the handled message, searches locally, and returns to outer roaming. No unused task text field is included.

Allowed movement zones are optional, selected per tool/creature, and support multiple zones by union. Empty means unrestricted by zones. Paths, destination choices, wandering and automatic spawn respect selected boundaries. Disabled or unavailable selected geometry stops movement rather than silently removing restrictions.

The complete example is rebuilt from New canvas using actual editor controls in tests. The standalone ZIP includes editable source/ files as well as the runnable HTML. Browser-stored user projects must be exported as JSON separately.

## Discussed but not implemented

The user wants clearer editor language and visible data connections. Research suggested consistent Message name instead of alternating message/input; Message data for fields; selectable typed connections rather than retyping field names; and contextual controls showing relevant settings. These are proposals, not implemented or blanket authorization to redesign the UI. Preserve standard game-development terms where useful.

Convex, realtime collaboration, interaction analytics, heatmaps, eye tracking, engine export adapters and a community marketplace remain future ideas. Keep portability in mind without claiming those features exist.
