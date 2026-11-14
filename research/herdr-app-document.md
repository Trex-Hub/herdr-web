# The `herdr-app` core document and the `herdr.*` terminal labels

## Answer

The desktop app keeps **structure** (spaces, tabs, split tree, terminal addresses) in one herdr-core document per machine named `herdr-app`, and **per-screen state** (focus, zoom, settled, recent, seen attention) in its own `view.json`. Terminals are tied to panes twice: the document holds the terminal address in the pane node (`{"type":"block","content":{"terminal":"t7"}}`), and the terminal carries `herdr.space` / `herdr.tab` labels; the labels are what make an unknown/labeled terminal get adopted into a pane.

For herdr-web the safe rules are: (1) treat the document as **opaque, round-trippable JSON** — read it, keep every field you do not understand (node-level ones included), and write it back with `doc.set` using the version you read; a `conflict` means the desktop already won, take its document and redraw. (2) Do not invent node types or content variants: a `chat` **pane** must be `{"type":"block","content":{"mod":"chat","props":{…}}}` (a mod pane), because an unknown `type` or `content` fails to decode and the app then treats the whole machine's layout as unavailable. (3) Write labels with **machine-local** ids (`t7`, not `box/t7`), only ever raise `herdr.seen`, and use `herdr.pinned` / `herdr.seen` per `docs/labels.md`. (4) Never write a document for a machine whose layout is not loaded, and never write `null` to delete it. (5) The authors describe documents as opaque and "API-only"; they promise nothing about the *schema* of `herdr-app`, only forward-compat effort: space/tab fields from newer builds are preserved, node fields are not.

## Evidence

### 1. Wire level (herdr-core)

- `schema/README.md:179-193`: `doc.get {name, on?}` returns `{value, version}`; unwritten name ⇒ `{value: null, version: 0}`. `doc.set {name, value, version, on?}` is compare-and-set on `version`; a stale write fails with kind `conflict`; writing `null` deletes the value **but retains the version**; 1 MiB of serialized JSON per value; names follow "the terminal name rules"; "Core never interprets their contents"; persisted atomically in `docs.json` in core state, lost when state is wiped; broken file ⇒ renamed `docs.json.bad`, core starts empty; "These methods are API-only, with no CLI verb."
- Version is a per-document monotonic counter (`version = current + 1`), conflict message `document "x" is at version N, not M` with hint `read doc.get and retry with its version`: `crates/herdr-core/src/api/doc.rs:9-40`.
- Name rule: 1–32 chars of `a-z 0-9 - _ .`, must start with a letter/digit, must not look like a terminal id (`t7`): `crates/herdr-core/src/addr.rs:6-16`. So `herdr-app` is legal by luck of construction.
- Change notifications: `{"method":"event","params":{"seq":43,"type":"doc","data":{"name":"herdr-app","version":2}}}` — **no value**, so a reader must `doc.get` after it; remote changes arrive with `machine: "<name>"`; `doc` events are excluded by terminal/parent/label filters, and a subscription may narrow with `docs: ["name","prefix*"]` (`schema/README.md:195-215`, `crates/herdr-core/src/events.rs:170-184`).
- Ordering rule the app relies on: "Subscribe before reading. Read documents after subscribing or reconnecting, a `missed` notification, or a remote machine reconnect: snapshots contain terminals only, not documents, and changes while disconnected are not replayed" (`schema/README.md:210-215`).
- API status: "preview (protocol generation 1, version 0.x). The API only grows." (`schema/README.md:12-19`). That promise covers RPC methods/params/result fields — not the shape of this document.

### 2. Document shape as the app models it (`/tmp/happ/src/mirror.rs`)

Only two shared levels plus the node tree (`src/mirror.rs:9-42`):

```ts
type Document = { spaces: SharedSpace[] };            // no other top-level keys are kept
type SharedSpace = {
  id: string; name: string; folder: string; tabs: SharedTab[];
  [other: string]: unknown;   // #[serde(flatten)] rest — preserved on read/write
};
type SharedTab = {
  id: string; name: string; root: Node;
  [other: string]: unknown;   // #[serde(flatten)] rest — preserved on read/write
};
```

- `Document::capture` writes only spaces of the requested machine, with ids made machine-local (`mirror::local`, `src/mirror.rs:67-73,96-120`); `Document::replace` rebuilds those spaces from the document and re-qualifies ids with `machine/` in memory (`src/mirror.rs:122-147`).
- Every field has a default: a space/tab may be `{}` and decodes to empty strings and an empty row root (`src/mirror.rs:329-337`, `fn empty_root` at `src/mirror.rs:40-42`).
- Space order is *not* in the document order alone: `Model::order_spaces` sorts by machine (local first, then machine name), so `space.move` "stays inside its machine's block" (`src/model.rs:184-196`, `defaults/AGENTS.md:96-102`).
- Real document, read-only via one `doc.get` (structure only): `version 149`, top keys `["spaces"]`, 3 spaces, space keys `["folder","id","name","tabs"]`, tab keys `["id","name","root"]`, node keys `["children","content","id","size","type"]`, node types `["block","column","row"]`, content keys `["terminal"]`, size form `{"weight": …}` only, and every tab's `root.id === tab.id`.
- Root of a tab is a `row`/`column` container whose id is the tab id, containing one block per pane (`Tab::with_pane`, `src/model.rs:114-125`); `fn pane(id, address) = Node::block(id, Content::Terminal{terminal: address})` (`src/model.rs:602-604`).
- The app stores no "which tab is active" in the document — that is per-screen (`View`), see §5.

### 3. The node tree, every Kind/Content variant (`/tmp/happ/src/layout.rs`)

The document's tab trees reuse the layout node type, so the full vocabulary is (`src/layout.rs:12-31,64-77,81-84,86-92,79-84,284-303,327-400`):

```ts
type Kind =
  | { type: "block";    content: Content }
  | { type: "row";      children: Node[] }
  | { type: "column";   children: Node[] }
  | { type: "stack";    children: Node[]; active?: string; header?: Header };

type Content =
  | { terminal: string }                        // the pane's terminal address, local to the machine
  | { mod: string; props?: unknown }            // a JS mod in ~/.config/herdr-app/mods/<mod>
  | { tab: string; pane?: PaneFrame }           // a tab's terminals ("tab": "active"); old alias "context"
  | { agent: string };                          // one agent's terminal ("agent": "focused")

type Node = {
  id: string;                                   // default ""
  cloned_from?: { name: string; version: string };
  size?: { px: number } | { weight: number };   // untagged
  min?: number; max?: number;                   // px
  hidden?: boolean; title?: string;
  background?: string | { gradient: [string, string]; angle?: number } | { image: string; fit?: "cover"|"contain" };
  border?: { width?: number; color?: string };
  radius?: number; shadow?: "sm"|"md"|"lg";
  padding?: number | [number, number];          // [vertical, horizontal]
  focus?: { border?: Line; background?: string };
  // Look (cascades down the tree):
  theme?: string | { light: string; dark: string };
  colors?: Record<string, string>; font?: string; font_size?: number; font_weight?: number;
  terminal_line_height?: number; terminal_cell_width?: number; terminal_scroll_speed?: number;
  ui_font?: string; terminal_padding?: [number, number]; terminal_opacity?: number;
  gap?: number; divider?: Line;                 // row/column
  movable?: boolean; closable?: boolean; resizable?: boolean;
  floating?: Float[];
  titlebar?: "system"|"none"; traffic_lights?: [number, number]; preview?: string;
  terminal_menu?: string; toast?: string; window_drag?: boolean; window_blur?: boolean;
} & Kind;

type Float = {            // a block floating over a node, snapped to an edge
  id: string; content: Content;
  edge?: "top"|"right"|"bottom"|"left"; align?: "start"|"center"|"end";
  peek?: number; hidden?: boolean;
};
```

Notes that matter for a second client:

- Only `block` (terminal or mod) counts as a **pane**: `Node::is_pane` matches `Content::Terminal | Content::Mod` (`src/layout.rs:487-490`); `Context`/`Agent` are layout-file (chrome) content, and a tab tree in the document in practice only contains `block/row/column/stack` (verified on the live document).
- `size` is `{"px":…}` or `{"weight":…}`; the app writes `weight` for split panes (live document).
- `active` on a stack is a child **node id**, and it is machine-qualified in memory / stripped in the document like pane ids (`map_node`, `src/mirror.rs:75-93`). It is a *layout* choice, but it lives in the tree, not in `view.json`.
- Visible panes = `panes()`/`visible_blocks()`: hidden nodes and inactive stack children are skipped (`src/layout.rs:561-579,672-675`).

### 4. Per-screen state (`View`, `/tmp/happ/src/mirror.rs:44-65`, `~/.config/herdr-app/view.json`)

```ts
type View = {
  active: string | null;                          // selected space (qualified id)
  spaces: Record<string, string | null>;          // space id -> selected tab id
  tabs: Record<string, { focused?: string; before: string[]; zoomed?: string; settled?: number }>;
  recent: { name: string; folder: string }[];
  attention: Record<string, { word?: string; seen: boolean }>;  // agent address -> attention
};
```

- Capture/apply: `View::capture` (window, `src/mirror.rs:151-159`) and `View::apply` (with validity filters — a focused/zoomed/before id that no longer exists in the tree is dropped, `src/mirror.rs:204-224`).
- **Shared** in the document: space id/name/folder, tab id/name, pane tree, pane ids, terminal addresses, mod name/props (props are stored as given, never machine-qualified: `src/mirror.rs:252-261` test + `defaults/AGENTS.md:96-102`).
- **Per screen only**: selected space, selected tab per space, focused pane, focus history (`before`, max 32, `src/model.rs:129-147`), zoom, settled (put-away tabs), recent spaces, and seen attention. Test `focus_zoom_and_settle_are_private` asserts capture is unchanged by zoom/settle (`src/mirror.rs:236-250`).
- On first arrival of a machine's document, `View::apply_machine` merges only that machine's saved choices so startup on another machine is not reset (`src/mirror.rs:161-195`); `preserve_unloaded` keeps view entries for machines whose document is not loaded (`src/mirror.rs:197-202`); `view.json` is only written once some document is loaded (`src/window.rs:1138-1147`).

### 5. How terminals are tied to panes (labels vs document)

- On spawn the app labels the terminal `herdr.space=<space id>`, `herdr.tab=<tab id>`, `herdr.seen=0` — ids machine-local, `crate::mirror::local(space, on)` (`src/window.rs:2469-2474`), and `terminal.run` is called with `"keep": true` (`src/hc.rs:466-478`).
- The pane↔terminal link itself is the node content (`{"terminal":"t7"}`). The labels are the *discovery* mechanism:
  - `reconcile` finds live terminals with no pane, reads `labels.herdr.space` / `labels.herdr.tab`, and adopts them (`src/window.rs:2223-2260`).
  - `adoptable` requires `state == "live"`, `herdr.space` equal to the space's local id, and `herdr.tab` equal to the tab's local id (empty tab label allowed) (`src/window.rs:5070-5078`); `adopt` creates the space/tab if unknown, unnamed ("an id Herdr doesn't know becomes a new space or tab", `src/window.rs:2283-2325`, `defaults/AGENTS.md:149`).
  - Panes whose terminal vanished are dropped: `check_closed` treats `reason` `exited`/`killed` (or `not_found`) as closed and calls `model.remove_pane` (`src/window.rs:2631-2660`); a live stream end with `exited`/`killed`/`finished` closes the pane immediately (`src/window.rs:2399-2420`).
- `terminal.keep`/`terminal.park` move a terminal in/out of the app's world *by rewriting labels* (`herdr.space`/`herdr.tab` set, or set to `""` for park) and toggling core keep; the reply may be `pending: true` (`src/window.rs:2700-2725`, `defaults/AGENTS.md:139-148`).
- Extra labels the app writes: `where` = `"<space> / <tab>"` for `hc ls` (written only when it changes, `src/window.rs:1872-1925`) and `herdr.right-click` (`src/window.rs:3218-3222`). Neither is structural.

### 6. Ids

- `Model::fresh_id(prefix)` = `prefix + 16 hex + 16 hex` from two `RandomState` hashes — i.e. 32 hex chars, deliberately **not** a per-screen counter (`src/model.rs:173-177`; test `fresh_ids_are_not_a_per_screen_counter`, `src/mirror.rs:355-358`).
- Prefixes in use: `sp` space, `tb` tab, `p` pane, `s` split container (`src/model.rs:328`), `n` new node when filling missing ids (`src/window.rs:5013`), `b`/`r` for layout blocks/rows in chrome (`src/window.rs:4217-4219`). Remote ids are `machine/id` in memory (`mirror::qualify`), and are written back stripped (`mirror::local`).
- A tab's root container id equals the tab id (`src/model.rs:114-125`), confirmed in the live document.
- Ordering constraints: spaces are sorted by `machine` then kept in list order; tabs keep list order (index = display number when unnamed, `src/model.rs:271-277`), panes keep tree order (depth-first).

### 7. What the app does with kinds/fields it does not know

Three distinct behaviours — this is the sharpest constraint on herdr-web:

1. **Unknown space/tab fields are preserved.** `SharedSpace`/`SharedTab` carry `#[serde(flatten)] rest: Map<String, Value>` and are written back verbatim; test `unknown_space_and_tab_fields_survive_a_read_and_write` proves a newer build's `"color"` and tab-level `"floating"` survive a read-modify-write on both local and remote paths, and that nothing extra is emitted (`src/mirror.rs:22-24,35-37,305-327`). CHANGELOG 0.1.15: "Herdr keeps space and tab details that a newer Herdr saved on the same machine" (`CHANGELOG.md:38`).
2. **Unknown node fields are dropped.** `Node` (`src/layout.rs:327-400`) has no `flatten` catch-all; a field nobody modelled is lost the next time that tab is written. (Verified by compiling the same `Node`/`Kind`/`Content` shape with serde: an unknown node field disappears on re-serialize; a top-level document key disappears too, since `Document` has only `spaces`.)
3. **Unknown `type` or `content` fails to decode the whole machine.** `Kind` is `#[serde(tag="type", rename_all="lowercase")]` with exactly `block/row/column/stack`; `Content` is `#[serde(untagged)]` with exactly `terminal/mod/tab/agent` (`src/layout.rs:10-31,284-303`). Decode failure in `mirror_sync::read` becomes `Outcome::Undecodable("Cannot read this machine's layout: {e}")` (`src/mirror_sync.rs:74-84`), which marks the slot unavailable with a toast "Layout unavailable", and `require_document` then refuses every structural command for that machine (`src/window.rs:1926-2060,2451-2461`). Nothing is overwritten — but the machine's layout is dead to that build until the document is fixed.

⇒ A **`chat` pane must be a mod pane** (`{"type":"block","content":{"mod":"chat","props":{…}}}`), optionally with tab-level extras in the space/tab `rest` area. A literal `{"type":"chat"}` or `{"content":{"chat":…}}` breaks the desktop app's whole view of that machine.

### 8. Write protocol (exact)

Per machine one `Slot` (`src/mirror_sync.rs:9-49`): `document`, `version`, `available`, `dirty`, `blocked`, `pending`, `read_attempted`, `connected`.

- **Read**: `doc.get {name:"herdr-app", on?}`; `null` value ⇒ `Document::default()` (empty spaces); missing `version` ⇒ undecodable (`src/mirror_sync.rs:74-84`). Read after connecting/subscribing, on `missed`, and on any `doc` event (`src/window.rs:700-750`, `src/hc.rs:105-145`).
- **Write trigger**: `flush_documents(refresh)` (`src/window.rs:1926-1962`) runs from the 400 ms `poll()` tick (`src/window.rs:3988-3990`) and immediately after a command (`run_as` → `flush_documents`, `src/window.rs:2950-2954`), after a pane-drag mouse-up (`src/window.rs:5245-5252`), after adoption/terminal changes, and at quit. It writes only when `slot.available && last_document != Document::capture(model)` and no drag is in progress; `dirty` is set by doc events and connect. There is **no timer debounce** — coalescing comes from (a) the 400 ms tick, (b) "one request per machine, no operation queue" (`src/mirror_sync.rs:1`), (c) `slot.ready()` refusing a second round while one is pending.
- **Write**: `doc.set {name:"herdr-app", on, version: slot.version, value: document}`; reply version becomes the new `slot.version` (`src/mirror_sync.rs:90-111`).
- **Conflict**: error kind `conflict` ⇒ immediately `doc.get` again and return `Outcome::Conflict(document, version)`; the app then **replaces its model with the remote document** (`document.replace(&mut model, on)`) and shows the toast "Layout changed elsewhere" / "The other screen's layout is shown." (`src/window.rs:2003-2058`). There is **no merge**: `defaults/AGENTS.md:96-102` — "On simultaneous edits the newest accepted document wins (no merging); structural commands fail while that machine's layout is unavailable."
- **Errors**: `needs_update`/`needs_login` ⇒ `Blocked` (no timed retry); everything else ⇒ `Unavailable`; both mark the slot unavailable, disable structural commands for the machine, and toast once (`src/mirror_sync.rs:66-72,57-64`, `src/window.rs:2028-2042`).
- **Quit**: `drain_documents` finishes the in-flight round and writes a final document with a bounded timeout — 10 s for the local core, 2 s per remote (`src/window.rs:1964-2001`).
- Timeouts per round: 10 s (`src/mirror_sync.rs:86-92`).

### 9. Remote machines (`on`)

- One slot and one document per machine; the local core is the empty key `""`, remote names come from `machine.list` polled every 5 × 500 ms of the event loop (`src/window.rs:440-460,700-760`). Machines with `"temporary": true` are ignored (`src/window.rs:2060-2072`).
- Every `doc.get`/`doc.set` for a machine passes `"on": "<machine>"`; ids are qualified on read and stripped on write (`src/mirror.rs:67-93,96-147`).
- A space belongs to exactly one machine (`Space.machine`); structural commands check `require_document(machine)`, and a pane can never move across machines ("A terminal's pane must stay on its own machine", `src/window.rs:2451-2461,2678-2685`).
- If a machine's document is not loaded, `View` entries for it are preserved (`preserve_unloaded`) and re-applied when it first loads (`apply_machine`) (`src/mirror.rs:161-202`, `src/window.rs:2060-2080`).
- Space blocks are ordered local-machines-first-then-name, and `space.move` is clamped inside the machine's block (`src/model.rs:184-208`; test `machine_blocks_are_deterministic_and_moves_stay_inside_them`, `src/mirror.rs:338-354`).

### 10. Labels: exact semantics (`/tmp/happ/docs/labels.md`)

- Purpose: shared seen/pinned state between clients ("the desktop app, the phone app, a terminal UI"); carried in `events.subscribe` snapshots (`labels`, `turn`) and in `labels` events; remote terminals (`mac/t7`) work the same; "everything here is optional, and a missing label falls back to what the client did before" (`docs/labels.md:1-14`).
- `herdr.seen=<turn>`: `turn` is core's counter, bumped each time a terminal stops working. Display: `blocked`/`error` ⇒ needs you; `working` ⇒ working; otherwise **done when `turn > herdr.seen`**, else idle. "With no `herdr.seen` label, use your own seen rules… A missing label is not `0`" (`docs/labels.md:16-28`).
- Writing: when a person is really looking at the agent (foreground window, drawn on screen; peek/floating counts, covered pane does not), write `herdr.seen=<turn>`; **only raise**, and also write when missing; **once per turn** while it stays on screen; decide on the `turn` event (a turn ends with `status` then `turn`); mark-unread is the single lower write `herdr.seen=<turn - 1>` (nothing to do at turn 0); a terminal a client starts gets `herdr.seen=0`; "Last writer wins" (`docs/labels.md:30-52`).
- App implementation: `share_seen` writes only when `seen_turn < turn`, once per turn (`self.looked` map), optimistically updates the model, and drops the pending marker if the write fails; label events are tracked by highest value seen (`src/window.rs:1584-1621`, `src/hc.rs:40-46,60-75`).
- `herdr.pinned=1`: present and non-empty = pinned; unpin by writing empty (`herdr.pinned=`), "which removes it"; pinned agents sort first. Mods use `terminal.pin {terminal, pinned}` and never write the label themselves (`docs/labels.md:54-61`; app writes `{"herdr.pinned":"1"}` or `""` at `src/window.rs:3229-3243`; command doc at `src/commands.rs:48`; read in `agents()` at `src/window.rs:1838`).
- Adding more: "Labels suit small values that change at human speed. Use the `herdr.` prefix. Bigger or app-wide state belongs in documents (`doc.get`, `doc.set`), and state for one device stays on that device" (`docs/labels.md:63-67`).

### 11. Lifecycle rules

- Closing a **terminal pane** ends its terminal: `pane.close` removes the pane then `kill(&addr)`; closing the last pane closes the tab; closing the last tab closes the space (`src/window.rs:3115-3128,3052-3063`, `src/model.rs:392-411,414-443`).
- `kill` is recursive **down the sub-agent tree**: children of the doomed terminal that carry no non-empty `herdr.space` label are killed too ("Core keeps a sub-agent running when its parent dies; closing one here means done with its whole tree. Kept sub-agents … are the person's: spared") (`src/window.rs:2773-2805`).
- A program that exits on its own closes its pane, even if the app was closed meanwhile (`reconcile`/`check_closed`; `defaults/AGENTS.md:132-137`).
- A terminal **in no pane**: if it carries `herdr.space` (started by an agent/script, or before a restart) it is adopted into the pane tree (`src/window.rs:2223-2260`); without the labels it is left alone ("another app's" terminals stay out of Herdr's screens, `defaults/AGENTS.md:149-152`). Labeled terminals are `keep: true` and a lost program is replaced by a shell at the same address with the same command never re-run (`defaults/AGENTS.md:132-137`; core: `schema/README.md:148,162`).
- No terminal is killed merely for being absent from a document on another machine: kills only come from pane/tab/space close, from `terminal.kill`, or from the program exiting.

### 12. Author statements on stability/publicness

- Documents are **opaque** to core and "API-only" with "no CLI verb" (`schema/README.md:179-193`); security doc: "Spaces, tabs and splits are stored in each machine's core document, not in the app home" (`docs/security.md:22`).
- Multi-screen design intent: "Connected screens share that layout and live terminals, not their focus, zoom or attention… On simultaneous edits the newest accepted document wins (no merging)" (`defaults/AGENTS.md:96-102`).
- Multi-client label intent is explicit and additive-only ("Clients that don't know these labels keep working") (`docs/labels.md:1-14`), and CHANGELOG 0.1.15: "Seen and pinned agents are shared between Herdr windows and the phone app" (`CHANGELOG.md:125`).
- Forward-compat is a deliberate, but *partial*, effort: space/tab extras preserved as of 0.1.15 (`src/mirror.rs:305-327`, `CHANGELOG.md:38`); node-level extras are not.
- There is **no** published schema, version field, or stability promise for the `herdr-app` document itself. The only versioning is the RPC protocol generation (`src/hc.rs:206-262`; core `GENERATION` in `crates/herdr-core/src/api.rs`), which says nothing about document contents.

## Open questions

- Whether `stack` nodes ever appear in a *document* tab tree: the code and `map_node` support `Kind::Stack` with `active`, but the live document contained only `block/row/column`, and the app's commands create splits only. Unverified.
- Whether a future core/app adds a document `version`/schema marker inside the value. Nothing today.
- Exact behaviour if a second client writes a tab whose `root.id != tab.id`: the app builds roots with the tab id (`src/model.rs:114-125`) and `View`/focus lookups rely on node ids, but I saw no validation that rejects a mismatch. Unverified.
- Whether the app's `Document::replace` re-adds a terminal-less pane or repairs a document with a terminal address that no longer exists: `reconcile`/`check_closed` drop such panes, so the next write removes them — but only after a listing has confirmed `exited`/`killed`/`not_found`. I did not trace every ordering.
- Timing guarantees for `doc` events under load (whether coalescing could skip an intermediate document version): core increments `version` per accepted `doc.set` and emits one event each (`crates/herdr-core/src/api/doc.rs:24-39`), but I did not verify subscriber back-pressure behaviour.
