# Prototeer for Unity

This release targets **Unity 6000.6.10f1** and **Unity Behavior 1.0.17**.

1. Open **Export to Unity** in Prototeer. Select the object or creature definitions to export, then download the `.prototeer.json` file and the Unity tools ZIP.
2. Close Unity and extract the ZIP at the root of your Unity project. Unity will find `Packages/com.prototeer.unity/` when you reopen the project and install its dependencies through Unity Package Manager.
3. Open the project in Unity. Use **Assets > Prototeer > Import Unity Export**, and choose the `.prototeer.json` file. The importer creates reusable definitions and native Behavior graphs under `Assets/Prototeer Imports/`. Double-click a graph to edit it in Unity Behavior.
4. Select an imported **Definition** asset. In its Inspector, pick the GameObject that owns your model or controller and click **Apply Definition**. The definition supplies tags, starting stats, and rules. If it has a graph, this assigns it to a Unity Behavior Graph Agent.

The exported file contains selected mechanics and their references. To keep a full editable backup, use the website's regular JSON export.

For movement, give the actor a `NavMeshAgent` and a baked NavMesh. Copy the zone IDs from the Definition Inspector. Add **Prototeer Zone** components to your scene, enter their IDs and NavMesh area names, and assign destination markers for zones that supply destinations. Add those components to the actor’s **Scene Zones** list. Their area masks must cover the permitted walkable zones, including routes between markers. Keep links crossing outside those zones in excluded areas. Prototeer selects a destination and Unity finds and follows the route. The move node fails if Unity cannot reach the spot within the configured areas.

Use `PrototeerBinding` from your own C# scripts to check tags and stats or report an interaction. For example, `actorBinding.Invoke("interact", workstation)` runs the matching rules on the actor. Your game can also report `contact` or `tick` triggers. The binding’s tick rate controls waits and tree commitment. It does not create a contact detector or call game events for you.

The export dialog lists unsupported settings before download. It supports stat and tag rules, selectors, memory sequences, stat-based utility, stat and tag conditions, wait, idle, run rule, and choosing and moving to a point in named scene zones. Use a mechanics-only export to reuse compatible rules without importing a tree that needs additional porting. Move or rename an existing import folder before importing a new version so its Unity edits stay available.
