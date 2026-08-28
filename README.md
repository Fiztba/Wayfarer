# Wayfarer

## Status: Phase 5 complete

Working today:

- **Multi-source MUD directory** — one list unioned from The Mud Connector,
  Scandum's MSSP crawler, Grapevine and Vineyard (plus MUDVerse where a key is
  configured), de-duplicated across sources and probed for liveness. Filter by
  codebase *with lineage* (picking CircleMUD finds the tbaMUDs, because sources
  label the same game at different levels), by theme, by whether anyone is
  online, by whether the MUD is hiring, and by protocol support — including
  "mapper works here", which no other directory can answer because it depends on
  the client. Built weekly by CI and shipped as a single JSON file, so browsing
  costs the listed MUDs nothing and the list improves without an app update

- **MXP** — clickable links (send tags with hover hints, prompt-mode links,
  text-content commands), inline bold/italic/color markup, entities, secure
  line-mode gating (player text can never inject tags), VERSION/SUPPORT
  handshake; verified live against tbaMUD
- **MSP sound** — !!SOUND/!!MUSIC triggers with volume/looping, played from a
  local sounds folder through a sandboxed custom protocol (no downloads),
  master toggle in Settings → General

From Phase 4a:

- **Gauges** — HP/mana/move bars above the output, driven by variables:
  auto-fed by GMCP Char.Vitals or MSDP vitals reports where servers offer
  them, or from any numeric prompt via a trigger (`#var hp %1`); runtime
  variable overlay keeps fast updates off the disk (batched persistence)
- **Chat capture windows** — any trigger can copy its matching lines into a
  named tabbed pane (optionally gagging them from the main scroll): tells,
  channels, group chat each get their own tab
- **`#var name value`** — set variables from plain commands, triggers, or
  the command line
- **Ctrl+F scrollback search** — case-insensitive across the entire buffer,
  newest-first navigation, match highlighting, works with windowed rendering

From the Mapper stage:

- **Auto-mapper** — graph-based (rooms/links are truth; coordinates are only
  layout, so non-Euclidean zones survive), dead reckoning from your movement +
  Diku-family text capture, upgraded to exact tracking via MSDP/GMCP room ids
  where servers offer them; pause-and-flag when unsure (never guesses junk
  rooms), with "I am here" re-sync
- **All 10 directions** drawn distinctly, plus named special exits
  ("enter portal") as first-class pathfinding edges
- **Doors** — auto-detected from closed-door bumps and open commands, manual
  toggle per exit with custom open-name; auto-walks open them en route
- **Walking** — double-click-to-walk with confirmed stepping (verify each
  room, halt visibly) or fast mode; `#go <waypoint>` / `#go!` from the
  command line; `#stop` cancels
- **Waypoints & zones** — `#wp add/del/list`, `#zone <name>` active-zone
  mapping with auto-zones from server area names, whole-zone delete
- **Full editing** — drag rooms, rename/color/notes, delete, merge duplicates,
  link stubs, add rooms/exits by hand
- **Docked pane + pop-out window** — resizable in-session pane, plus a
  separate map window mirrored live over IPC
- Maps stored per profile with atomic writes and hourly backups

From Phase 3:

- **JavaScript + Lua scripting** — every trigger, alias, macro, and timer can
  run script code instead of sending commands (action selector in its editor);
  standalone **Scripts** run on session connect or on demand
- **Shared client API** in both languages: `send`, `sendRaw`, `echo`,
  `getVar`/`setVar` (persisted), `session()`, and in trigger context `line`,
  `matches`, `gag()`, `highlight(color)`. JS additionally gets `client.globals`
  (shared state across runs) and `client.after(ms, fn)`; Lua globals persist
  naturally in its VM (Lua 5.4 via WebAssembly, fully in-process)
- **General options** — clear-input-on-send toggle, output timestamps toggle,
  scrollback buffer size (default 100,000 lines, up to 1,000,000; windowed
  rendering keeps huge buffers fast)
- **In-app help** — searchable feature guide (? Help button, help link on the
  connect screen, or type `#help`), plus inline hints throughout the settings UI

From Phase 2:

- **Triggers** — substring or regex patterns with %1–%9 capture substitution,
  fired commands, line gagging, and line highlighting; per-world or global scope
- **Aliases** — argument substitution (%1–%9, %0), `;` chaining, recursive
  expansion (depth-capped)
- **Keyboard macros** — F-keys, numpad, Ctrl/Alt combos, captured via a
  press-to-record editor
- **Timers** — repeating or one-shot, run while connected
- **Variables** — `@name` substitution in any command, editable per scope
- **Speedwalking** — `.3n2eu` → n n n e e u
- **#N repeats & {groups}** — `#100 {sneak;hide}` alternates the group 100
  times; braces group commands anywhere; nests with aliases and speedwalks;
  runaway expansions are capped safely
- **Paced repeats** — `#100@500ms {sneak;hide}` (also `@2s`, `@1.5s`, `@1m`,
  or bare `@500`) spaces iterations out; `#stop` cancels mid-run, and paced
  repeats auto-cancel on disconnect
- **Session logging** — timestamped plain-text logs, manual toggle or
  auto-start on connect, stored in `<userData>/logs`
- **Settings UI** — tabbed editor (⚙ in the status bar), settings saved per
  world profile plus a global "all worlds" scope, same atomic-write +
  timestamped-backup storage as profiles

From Phase 1:

- **Full telnet engine** — option negotiation with loop protection, TTYPE/MTTS
  cycling (reports 256-color + truecolor + UTF-8), NAWS window sizing, CHARSET,
  EOR/GA prompt marking, ECHO-driven password masking
- **MCCP2** compression (zlib), verified against Aardwolf
- **GMCP** negotiation with Core.Hello/Core.Supports.Set, plus **MSSP** and
  basic **MSDP** parsing
- **ANSI rendering** — 16-color (classic bold=bright), 256-color, 24-bit
  truecolor, bold/italic/underline/inverse/strikethrough
- **Multi-session tabs**, scrollback with auto-scroll pinning, input history,
  `;` command stacking, select-on-send
- **Corruption-proof profiles** — one JSON file each, atomic writes
  (temp + fsync + rename), 25 timestamped backups per profile, quarantine
  instead of silent deletion for unreadable files

## Roadmap

- Packaging: electron-builder installer, app icon, auto-updates

## Development

```
npm install
npm run dev        # launch in dev mode
npm run dist       # build the Windows installer (release/)
npm run icon       # regenerate build/icon.{png,ico} from build/icon.svg
npm run typecheck  # TypeScript check
node --experimental-strip-types test/smoke.mts <host> <port>   # headless telnet test
node --experimental-strip-types test/automation-smoke.mts      # automation engine tests
node --experimental-strip-types test/scripting-smoke.mts       # JS + Lua runtime tests
node --experimental-strip-types test/map-smoke.mts             # mapper core tests
node --experimental-strip-types test/directory-smoke.mts       # codebase + dedup tests
```

### The MUD directory

The world list is built offline, not by the app. Each source has its own script;
`directory:build` unions them, probes every address, and writes the snapshot the
app downloads.

```
npm run directory:tmc        # The Mud Connector (biglist + codebase/theme facets)
npm run directory:mssp       # Scandum's MSSP crawler
npm run directory:vineyard   # Vineyard hosted MUDs
npm run directory:grapevine  # Grapevine games
npm run directory:tms        # Top Mud Sites (optional; slow, and the site is often down)
npm run directory:mudverse   # MUDVerse (optional; needs MUDVERSE_API_KEY)
npm run directory:build      # union + probe + dedupe -> public-data/directory.json
```

`.github/workflows/directory.yml` runs this weekly and commits the result. Keys
are never committed: MUDVerse reads `MUDVERSE_API_KEY` from the environment, set
as a repository secret in CI. The build refuses to write a snapshot whose
failure rate jumps more than 15 points above the previous one, so a run with
broken DNS fails loudly instead of quietly marking every MUD dead.

Built with Electron + electron-vite + React + TypeScript.
Profiles are stored in `%APPDATA%/wayfarer/profiles/` with backups alongside.
