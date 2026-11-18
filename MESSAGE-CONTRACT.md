# Development message contract (version 1)

The submitted build is frozen in docs/index.html and docs/Prototeer.zip. The editable root source builds the development version, published only at /Prototeer/dev/. The existing /Prototeer/ entry and ZIP must not be overwritten.

## Editable definitions

A director rule has a fields array. Each entry has a user-selected name, type, and value source. Supported types: number, text, boolean, zone, position, area. Names start with a letter and contain letters, numbers, underscores or hyphens; constructor/prototype/__proto__ are reserved. Maximum 20 unique fields. A new rule starts with no fields.

Sources: constants for number/text/boolean/zone/position; snapshots of any selected zone for area; observed stat or signal value for numbers; observed tag membership for booleans; observed or linked zone for zone references; observed or signal-origin position for position fields. Position fields are deliberate, explicit choices. There is no player, enemy, pursuit, sound, attack, or mission-specific field type.

A receiver reads a field by its name and required type. Conditions can test message/field existence or compare numbers, text or booleans. Utility scoring can use a named number field. Choose point can read a zone reference, an area snapshot or a position field into a named memory slot; the separate Move to stored point action uses that slot. Changing a field name requires updating its readers. Text never automatically executes a command.

## Delivered payload

    { id, name, created, expires, fields: {
        userFieldName: { type, value }
    }}

Only these envelope keys are accepted. There is no automatic source ID, source position, source-tool reference, director/rule reference, priority or stat attachment. A deliberately sent position belongs inside the user-defined fields. Captured input copies in stored destinations follow the same schema. Validation rejects extra hidden envelope properties.

The example sends only area (type area): a copied array of grid cell indices from the editable Inner surroundings zone. It contains no zone reference or anchor binding and stays fixed when the subject moves. The existing outer ring supplies normal roaming destinations directly through generic zone selection, without messages. General area is assigned as the example creatures’ allowed movement zone. There are no room zones or fixed room routes: the subject selects farther random points inside its larger Subject roaming range, while the pursuer uses Outer surroundings. All three ranges are ordinary attached zone definitions. The subject uses existing random Wait nodes before signaling; there is no demo-only timer. The message name investigate selects the receiving branch; there is no unused task text field. The receiving graph uses a constant branch score and chooses a point inside the area. Signal strength is not delivered. Chosen destination coordinates belong to the receiver and are distinct from the source position.

## Transport and diagnostics

World-level messageRoutes records hold lifecycle/deduplication references. World-level messageDebug records hold source coordinates for the debug overlay. Neither is attached to the delivered message or its captured copies. TTL, disabling a director/rule and recipient assignments are enforced by the transport. Acknowledgement removes the exact delivered input, leaving later inputs intact.

DebugSnapshot reads diagnostic records separately. Clearing diagnostic records must not change decisions. Debug data is part of a complete editor save for replay/inspection; it is not part of the receiver input contract. Retention limits are 16,000 route records and 2,000 diagnostic records, with expired records pruned.

This is a data/logic boundary for the supported node system, not a security sandbox for arbitrary third-party JavaScript. A game programmer has access to their own world state. A future engine adapter must pass the delivered payload to receiver logic and must not merge diagnostic data into it. No Unity or Unreal adapter is implemented here.

## Migration and portability

NormalizeWorld upgrades old fixed message definitions to explicit fields. It moves old x/y/source metadata out of inboxes, accepted legacy inputs and stored point message copies without mutating the original imported object. Compatibility readers use the conventional priority/value/zone field names for old graphs.

Area snapshot definitions use {name, type: "area", source: "zoneSnapshot", zoneId}; delivered values are unique integer cell indices in [0, WIDTH*HEIGHT). Geometry conveys spatial information and may allow inference about its origin; this is not cryptographic concealment. The supported receiver chooses cells without reading an anchor or computing its center.

Projects record messageSchema: 1. Definitions and payloads are ordinary versioned JSON; composition and field readers live in engine.js, independently of DOM, storage and rendering. Engine adapters must preserve types, missing-field behavior, lifetime/acknowledgement semantics, reference resolution and the explicit data boundary. A zone reader resolves the selected area geometry, not the hidden object bindings used to position that area. The present navigation adapter still uses the existing 2D grid; this does not claim arbitrary 3D navigation support.

## Test coverage

The tests cover independent field types/readers, explicit positions, mission-only absence of source data, UI editing, full reconstruction of the demo through editor controls, old-save migration, debug independence, persistence and replay. Convex collaboration and optional analytics live outside the engine: collaboration serializes the same validated project data, while analytics accepts only allowlisted UI metadata and never message payloads, project descriptions or artwork. Site-wide ingestion is consent-gated; a separate deployment admin key, never a project capability, gates raw analytics reads and deletion. No eye tracking has been added.

## Navigation boundary

Tool definitions may include allowedMovementZones: an array of zone IDs. Empty or absent means unrestricted. Selected enabled zone geometry is combined by union and applied to every supported navigation path, random step, target choice and automatic spawn. Zone references must exist and be unique. If all selected geometry is unavailable, movement stops. This field is edited through tool/creature checkboxes and saved as ordinary project JSON. Future navigation adapters must enforce the boundary along routes, including diagonal corner checks, rather than only filtering endpoints.
