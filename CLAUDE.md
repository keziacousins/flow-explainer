# CLAUDE.md

Animated, explorable architecture diagrams in three.js: slide-like scenes, glowing packets flowing between services, and a 3D view that shows what each logical service really runs as. The aim is explainer diagrams for an OTA (online travel agency) estate, getting across the gap between the *logical* architecture and its *runtime* complexity.

## Where this is heading

- **Real data comes from a graph database** in another project: about 300 logical nodes and about 3,000 at the infrastructure level. That project also has an xyflow frontend with some layout information, which may or may not suit this one. The next big step is an importer from that export into `Model`, plus automatic layout (probably elkjs) with manual overrides.
- **Diagrams are written in TypeScript for now** (`src/engine/builder.ts`), deliberately not in a text DSL until the API settles. `Model` (`src/engine/model.ts`) is plain data with no functions, so a text DSL can later compile to it. Keep it that way.
- `src/estate.ts` is **made-up** OTA data used to exercise the engine: ingestion, projections, read stores, a GraphQL search API.

## Commands

```sh
npm install
npm run dev        # Vite dev server
npm run build      # tsc --noEmit, then vite build (the >500 kB chunk warning is just three.js)
npx tsc --noEmit   # type-check only
```

There are no tests. Check changes visually: run the dev server, open `http://localhost:<port>/#<scene>`, and screenshot with the Playwright MCP tools. Hash changes switch scenes without reloading; add a throwaway query string (`?r=1#9`) to force a fresh load. Viewer controls: ← → / Space / click empty space to step, click a shape or tower slab for its info box (Escape closes it), pinch or ctrl+scroll to zoom, scroll or drag to pan, option+drag to orbit, two-finger rotate to turn (Safari only), `0` to reset the view. The user tests in **Safari**. Trackpad pinch and rotate arrive there as `gesture*` events, not ctrl+wheel; both paths are handled in `controls.ts`. Chrome on macOS has no rotate gesture.

## Architecture

`src/main.ts` wires everything together. Data flows one way: **builder → Model → Graph → views, driven by Director and Traffic.**

| File | Role |
|---|---|
| `engine/model.ts` | Plain-data types: nodes, edges, groups, node sets, flows, scenes. The future DSL target. |
| `engine/builder.ts` | TS builder: `diagram()`, `node`, `set` (with `column`/`row`/`grid`/`arc` layouts), `connect`, `group`, `flow`, `scene`, and `build()`, which validates every reference. |
| `engine/graph.ts` | Selector resolution (node, set or group ids, `'*'`, and `a->b` edge patterns matching either direction) and adjacency. |
| `engine/stage.ts` | Renderer, bloom (postprocessing), perspective camera driven by `stage.view` {x, y, zoom, tilt, turn, fov}, framing, pan/zoom/orbit maths, frame loop. |
| `engine/director.ts` | Scenes as **target states**. `go(i)` builds one GSAP timeline tweening from wherever things are *now*, so jumping and reversing mid-animation work. Also chooses callouts and the view per scene. |
| `engine/node.ts` | A node: an extruded solid from its footprint, an outline that traces in, a halo spilling onto the sheet, SDF text on the top face. |
| `engine/shapes.ts` | Footprints (box, db = elliptical puck, queue = pill, actor = disc), the shared solid shader, and extrusion. |
| `engine/edge.ts` | Edge line (draws in by `instanceCount`), an arc-length lookup table for packets, optional label. |
| `engine/routing.ts` | Edge curves. Picks facing sides and spreads multiple edges along a side, ordered by where the far end is. |
| `engine/group.ts` | Group region: dashed outline when flat, tinted sheet patch in 3D. |
| `engine/runtime.ts` | The runtime layer: a tower of instanced slabs per node, hanging *downward* beneath it, plus the frosted sheet (the fog). Routing semantics per cluster. |
| `engine/traffic.ts` | All packets. Two instanced `PacketLayer`s (logical, and runtime underneath). `StreamRunner` for background traffic; `FlowRun` for cause-and-effect flows. |
| `engine/callouts.ts` | HTML labels with SVG elbowed leader lines, placed each frame in empty screen space. `diagramObstacles` projects shapes, towers and UI (including an open info box) to screen rectangles. |
| `engine/inspector.ts` | Click-to-inspect. Raycasts node solids and tower slabs (`userData.nodeId`, plus `instanceId` for slabs), fills the HTML `#info` box from `NodeModel.info` and the graph, and keeps it beside the shape each frame. Its capture-phase click listener is registered after the controls' one, so drags never count as picks. |
| `engine/text.ts`, `troika.d.ts` | troika-three-text helper with IBM Plex fonts from `@fontsource` (woff via `?url`), and minimal types. |
| `engine/ui.ts`, `controls.ts` | Caption, scene dots, keyboard; trackpad and mouse navigation. |

### Flows (traffic.ts)

A flow is a list of steps: `send`, `fanout`, `respond`, `gather`, `drop`, `hold`. Each packet is a **token** that works through the steps independently, so fanned-out branches proceed on their own. `gather` is the join. Things that aren't obvious from the code:
- `send`/`fanout` targets are **neighbours** of the current node that match the selector. `send(providers)` from a fetcher goes to *its* provider.
- `respond()` walks back along the token's `path`, so repeated `respond()` unwinds a chain.
- On the runtime layer every hop is mirrored between instances. The target cluster's route decides which ones: `any` (one, load-balanced), `all` (scatter to every shard), `key` (one, by the token's key). Defaults come from the kind (replicas, shards, partitions). Hops and streams can override it with `route`: e.g. writes go to one shard, reads scatter to all.
- Tokens remember which instances they used at each node (`seen`), so responses and gathers return to the instance that asked.
- `Traffic` has its own clock and timer queue. `setScene` cancels runs, clears timers and starts the new scene's streams and flows after a delay.

## Design decisions (settled with the user; don't undo without asking)

- **Look:** dark (`#070B14`), clean lines, bloom only on colours pushed above 1.0 (highlights, packets). Colour encodes role (`palette.ts`). IBM Plex Sans; Plex Mono only for real identifiers and callouts. Sentence-case copy, no all-caps labels.
- **Every shape is a footprint.** The flat view shows it from above, 3D shows it extruded, and runtime instances are thinner copies of the same footprint **stacked downward** from the shape: more instances, deeper tower. Databases are elliptical pucks, not side-on cylinder icons, so shards read as a stack of discs. No connecting lines or gap between a node and its tower.
- **Flat by default, 3D for runtime moments.** Scenes with `runtime` default to tilt 62 and turn −38. The logical diagram sits on a frosted sheet; `fog` sets how much it hides the towers beneath.
- **Node labels are 3D text printed on the top face**, transforming with the shape. Billboarded and "standing sign" labels were tried and rejected: they overlap neighbours and spill out of bounds. The builder widens shapes to fit their labels (`labelWidth`).
- **No count badges on shapes.** Text badges (`×12`) read as noise and clashed with the ellipse outlines. In flat view, multiplicity is graded stacked cards (1 card for 2–3 instances, 2 for 4–9, 3 for 10 or more; see `cardCount`). Exact counts appear in towers, callouts and the info box.
- **Info boxes are HTML**, beside the clicked shape, with a connector line. Content comes from `NodeModel.info` (`about`, `facts`), plus runtime and routing, and connections derived from the graph.
- **Scrims** behind the caption and nav are background-coloured gradients (CSS `::before`), so they only show when the diagram runs underneath. They need `isolation: isolate` on the parent so `z-index: -1` doesn't drop them behind the canvas.
- **Callouts are for what a scene is about,** never every node. Automatic tower callouts cover highlighted and focused nodes, or else the three biggest towers. Placement avoids the projected diagram and the UI.
- **Projection:** perspective with a 30° field of view by default. `projection: 'parallel'` tweens the field of view to 3° (near-axonometric) rather than swapping cameras, so it animates.

## Gotchas

- **Drive the camera through `stage.view`,** never `camera.position`/`zoom`. `applyView()` runs at the start of every frame, before tickers, so labels and callouts project with this frame's camera (getting that order wrong caused lag and misplacement during zoom). To take over from a scene tween, `gsap.killTweensOf(stage.view)`.
- **Draw order:** flat decals (sheet, group patches, edges, halos) use `depthWrite: false` and low `renderOrder`. Solids use depth. Runtime things use negative `renderOrder` so they draw before the sheet (−5) and are fogged by it. Runtime packets depth-test so towers hide them; logical packets don't.
- **Set troika text through its base material** (`t.material = new MeshBasicMaterial(...)`), not by mutating the derived material. Use `fillOpacity` for fading.
- **Perspective framing** (`Stage.framing`) is iterative and starts from a distance based on the bounding sphere. Starting close to a big scene put points behind the camera and sent the fit off-screen.
- **Hot reload** during multi-file edits can leave a stale module mid-frame and spam the console (e.g. `obstacles is not iterable`). Reload before judging errors.
- `@types/three` and the `three/addons/...` imports are used throughout. TypeScript is v7 (the native compiler).

## Known limits and likely next steps

1. Graph DB importer and automatic layout. Real layouts will need more front-to-back spacing for corner views.
2. Level of detail for ~300 nodes: hide unfocused labels when zoomed out; a scale rule for very tall towers (linear now, compressed past 40 slabs).
3. Anchor tower callouts on the visible side so leaders stop crossing shapes; obstacles are bounding boxes, so placement is conservative.
4. Captions per flow step (narrating a flow step by step).
5. Nested or branching flows (e.g. one subgraph reading two stores, then gathering).
6. Touch pinch zoom (only one-finger pan works on touch).
