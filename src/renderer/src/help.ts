/**
 * In-app help content. Kept as plain data so topics are searchable and the
 * viewer stays dumb. Every user-facing feature should have a topic here —
 * a feature nobody can discover may as well not exist.
 */

export interface HelpBlock {
  h?: string
  p?: string
  code?: string
  list?: string[]
}

export interface HelpTopic {
  id: string
  title: string
  blocks: HelpBlock[]
}

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: 'getting-started',
    title: 'Getting Started',
    blocks: [
      {
        p: 'Wayfarer connects to MUDs — text-based multiplayer worlds — over telnet. Each connection lives in its own tab, and you can play several worlds at once.'
      },
      { h: 'Connecting' },
      {
        list: [
          'Saved Worlds: your profiles. Click one to connect, ✎ to edit it, ✕ to delete it (a backup is kept).',
          'Quick Connect: enter a host and port directly. "Save as profile" keeps it for next time.',
          'Browse the Realms: a searchable directory of live MUDs, courtesy of The Mud Connector. Clicking an entry fills the connect form — nothing connects until you say so.'
        ]
      },
      { h: 'Tabs' },
      {
        p: 'Each session tab shows a status dot: green = connected, yellow = connecting, grey = closed. The + tab opens the connect screen. Closing a tab disconnects that session.'
      },
      {
        p: 'Tip: type #help in any session to reopen this help window.'
      }
    ]
  },
  {
    id: 'command-line',
    title: 'The Command Line',
    blocks: [
      {
        p: 'The input bar at the bottom sends whatever you type when you press Enter.'
      },
      {
        list: [
          'Command history: ↑ and ↓ cycle through previous commands; Esc clears the line. In a multi-line block the arrows move the caret first and only reach for history at the top and bottom of the text.',
          'After sending, your command stays selected so typing replaces it — or enable "Clear the input line after sending" in ⚙ Settings → General.',
          'Multiple commands: separate with semicolons — get sword;wield sword;kill troll.',
          'Multi-line: Shift+Enter (or Ctrl+Enter) adds a line break instead of sending; Enter always sends the whole block. Paste works too — see Pasting Scripts & Blocks.',
          'Literal semicolon: escape it with a backslash — say goodnight\; see you tomorrow arrives as one line. Any other backslash is ordinary text, so ASCII art and C:\paths are untouched.',
          'Braces group commands so a group can be repeated or fired as a unit: #5 {sneak;hide}. Braces do NOT protect a semicolon from splitting — use \; for that.',
          'Password masking: when a server asks for a password, the input masks itself automatically and skips history/echo.',
          'An empty Enter sends a blank line — many MUDs use this to repeat the prompt.',
          'Scrollback: each session keeps 100,000 lines of history by default (configurable up to 1,000,000 in ⚙ Settings → General). Scroll up to read; older history loads as you approach the top; the ▼ button jumps back to live output.',
          'Search: Ctrl+F searches the entire scrollback (case-insensitive), starting from the most recent match. Enter steps to older matches, Shift+Enter to newer, Esc closes. Select text first and Ctrl+F searches for it.',
          'Tabs: drag a session tab left or right to reorder it (a bar shows where it will land), or press Ctrl+Shift+PgUp / PgDn to move the active tab.'
        ]
      },
      { h: 'Special prefixes' },
      {
        list: [
          '.3n2e — speedwalk (see Speedwalking)',
          '#5 kill rat — repeat a command (see Repeats)',
          '#stop — cancel paced repeats and auto-walks',
          '#var hp 224 — set a variable (see Gauges & Vitals)',
          '#map, #go, #wp, #zone, #lost — mapper commands (see The Mapper)',
          '#reconnect — re-dial a dropped or quit session in the same tab (pressing Enter on an empty line while disconnected does the same); scrollback, map position, and settings all carry over',
          '#help — open this help'
        ]
      }
    ]
  },
  {
    id: 'pasting',
    title: 'Pasting Scripts & Blocks',
    blocks: [
      {
        p: 'The input line is a real multi-line editor. Paste a whole trigedit script (or any block of text) straight from Sublime, VS Code or a wiki page and it arrives with its newlines, indentation and punctuation intact — write the script in the editor you like, paste it into the MUD once.'
      },
      {
        list: [
          'Paste, read it over, then press Enter to send the lot. Nothing goes out until you do.',
          'Shift+Enter (or Ctrl+Enter) inserts a line break, so you can compose or patch a block in place.',
          'The box grows to fit what you pasted and scrolls once it gets tall; it shrinks back to one line after sending.',
          '↑ recalls the entire block as one history entry, so a rejected script is one keystroke away from a second try.'
        ]
      },
      { h: 'Verbatim sending' },
      {
        p: 'Anything with more than one line is treated as pasted text, not as commands: every line goes out exactly as written. Aliases, semicolon stacking, @variables, .speedwalks, #repeats and the mapper all stand aside, and leading whitespace is kept rather than trimmed — which is what lets script indentation and lines like "if %actor.vnum% == 3001" survive the trip.'
      },
      {
        code: '* trigedit script, pasted as-is\nif %actor.is_pc%\n  wait 1 s\n  say Greetings, %actor.name%!\nend'
      },
      {
        p: 'Single-line input is unaffected — it still runs through aliases, variables and the rest as always.'
      },
      {
        p: 'If instead you want a pasted list of commands to run as commands, turn off "Send pasted multi-line text verbatim" in ⚙ Settings → General.'
      },
      { h: 'Big pastes' },
      {
        list: [
          'Over 200 lines, Wayfarer asks for confirmation first — a mis-paste of a whole file is easy to do and hard to undo.',
          'If a MUD drops lines or trips its flood protection on a large paste, set a "Delay between pasted lines" in ⚙ Settings → General (try 100 ms). #stop cancels a paced paste mid-flight.',
          'Sending a block while disconnected sends nothing and says so.'
        ]
      }
    ]
  },
  {
    id: 'speedwalk',
    title: 'Speedwalking',
    blocks: [
      {
        p: 'Start a command with a period to walk a route in one go. Each letter is a direction; a number repeats the direction that follows it.'
      },
      { code: '.3n2e     →  n n n e e\n.2ne      →  ne ne\n.4wud     →  w w w w u d' },
      {
        p: 'Directions: n s e w u d and the diagonals ne nw se sw. Counts above 100 per step are capped. Anything that is not purely directions (like ".chat hi") is sent as a normal command.'
      },
      {
        p: 'When the mapper knows where you are, speedwalks run as confirmed walks: each step waits for arrival, hidden doors along the way are opened automatically and the step retried, and a genuine blockage halts the walk with the reason instead of desyncing the rest of the route. #stop cancels. With the mapper off or lost, speedwalks fall back to sending every step instantly.'
      }
    ]
  },
  {
    id: 'repeats',
    title: 'Repeats (#N)',
    blocks: [
      { p: 'Repeat a command or group without retyping it.' },
      {
        code: '#5 kill rat            5× kill rat, sent instantly\n#100 {sneak;hide}      alternates sneak and hide 100×\n#3 {#2 {w};d}          nesting works: w w d, three times'
      },
      { h: 'Paced repeats' },
      {
        p: 'Add @delay to space iterations out. The first fires immediately, the rest on the interval. Units: ms (default), s, m.'
      },
      {
        code: '#100@500ms {sneak;hide}   one pair every half second\n#20@2s look               every 2 seconds\n#10@1.5s {get all;bury corpse}'
      },
      {
        list: [
          '#stop cancels all running paced repeats at any time.',
          'Paced repeats cancel automatically if the session disconnects.',
          'Repeats compose with aliases, @variables, and speedwalks.',
          'Safety: a repeat caps at 10,000 iterations and a single burst at 20,000 commands — a runaway loop stops with an error instead of freezing or flooding.'
        ]
      }
    ]
  },
  {
    id: 'triggers',
    title: 'Triggers',
    blocks: [
      {
        p: 'A trigger watches every line the MUD sends and reacts when its pattern matches. Manage them in ⚙ Settings → Triggers.'
      },
      {
        list: [
          'Contains text: fires when the line contains your text anywhere.',
          'Regular expression: full JS regex. Capture groups become %1–%9 in commands (%0 = whole match). The editor validates your pattern as you type.',
          'Ignore case: match regardless of capitalization.'
        ]
      },
      { h: 'What a trigger can do' },
      {
        list: [
          'Send commands — e.g. pattern "^(\\w+) tells you" with commands "reply %1 I am busy".',
          'Gag — hide the matching line from the screen entirely (great for spam).',
          'Highlight — recolor the matching line so it jumps out.',
          'Copy to a capture window — collect tells/channels in a separate tabbed pane (see Chat Capture).',
          'Set variables — commands like "#var hp %1" feed gauges from your prompt (see Gauges & Vitals).',
          'Run a script — switch the Action selector to JavaScript or Lua for logic (see Scripting).'
        ]
      },
      {
        p: 'Commands fired by triggers appear as faint » lines so you can always see what your automation is doing.'
      },
      { h: 'Example: auto-loot' },
      { code: 'Pattern (text):  is DEAD!\nCommands:        get all corpse;bury corpse' }
    ]
  },
  {
    id: 'aliases',
    title: 'Aliases',
    blocks: [
      {
        p: 'An alias is a shorthand: type a short word, send something longer. The first word of your input is checked against your aliases. Manage them in ⚙ Settings → Aliases.'
      },
      {
        code: 'Alias:      gh\nExpands to: get all corpse;bury corpse\n\nAlias:      k\nExpands to: kill %1        (then "k troll" sends "kill troll")'
      },
      {
        list: [
          '%1–%9 are the words you typed after the alias; %0 is all of them together.',
          'Expansions can contain semicolons, braces, #repeats, speedwalks, @variables — the full pipeline.',
          'Aliases can call other aliases (depth-capped so loops cannot hang).',
          'An alias can run JavaScript or Lua instead — set its Action selector.'
        ]
      }
    ]
  },
  {
    id: 'macros',
    title: 'Keyboard Macros',
    blocks: [
      {
        p: 'A macro binds a key to commands. Manage them in ⚙ Settings → Macros: click the key field, then press the actual combination — it records itself.'
      },
      {
        list: [
          'Usable keys: F1–F12, the numpad, and Ctrl/Alt combinations (Ctrl+G, Alt+1, Ctrl+Shift+F5...).',
          'Plain letters without a modifier are refused on purpose — macros must never eat normal typing.',
          'Macros fire while the session tab is active, regardless of where focus is.',
          'The numpad makes a classic movement pad: bind Numpad8 to n, Numpad2 to s, Numpad4 to w, Numpad6 to e, Numpad5 to look.'
        ]
      }
    ]
  },
  {
    id: 'timers',
    title: 'Timers',
    blocks: [
      {
        p: 'A timer sends commands on a schedule while the session is connected. Manage them in ⚙ Settings → Timers.'
      },
      {
        list: [
          'Interval is in seconds (0.1s minimum).',
          '"Run once, then stop" makes a one-shot delay instead of a repeating tick.',
          'Timers start when the session connects and stop on disconnect.',
          'A timer can run a script instead of commands — set its Action selector.'
        ]
      },
      { code: 'Example: Label "keepalive", every 300s, commands: save' }
    ]
  },
  {
    id: 'variables',
    title: 'Variables',
    blocks: [
      {
        p: 'Variables are named values you can reference in any command as @name. Manage them in ⚙ Settings → Variables.'
      },
      {
        code: 'Variable:  target = dragon\nYou type:  cast fireball @target\nSent:      cast fireball dragon'
      },
      {
        list: [
          'Type @@ for a literal @ (e.g. email addresses).',
          'Unknown @names pass through unchanged.',
          'Scripts can read and write variables with getVar/setVar — changes persist.',
          'Combine with aliases: alias kt = "kill @target" and just retarget by editing one variable.'
        ]
      }
    ]
  },
  {
    id: 'scripting',
    title: 'Scripting (JavaScript & Lua)',
    blocks: [
      {
        p: 'For logic that plain commands cannot express, Wayfarer embeds both JavaScript and real Lua 5.4. Two ways to use them:'
      },
      {
        list: [
          'Any trigger, alias, macro, or timer can run code — switch its Action selector to JavaScript or Lua.',
          'Standalone Scripts (⚙ Settings → Scripts) run when a session connects — the place for shared helper functions. ▶ runs one on demand.'
        ]
      },
      { h: 'The API (both languages)' },
      {
        code: 'send(text)      send through the full pipeline (aliases etc.)\nsendRaw(text)   transmit exactly as written\necho(text)      print a local line to this session\ngetVar(name)    read a variable\nsetVar(n, v)    write a variable (persists)\nbeep(times)     audible attention chime (no sound files needed)\nsession()       { name, host, port, connected }'
      },
      {
        p: 'In JavaScript everything hangs off the client object (client.send(...)); in Lua they are globals (send(...)).'
      },
      { h: 'Trigger context' },
      {
        code: 'JS:   matches[1] = first capture, matches[0] = whole match\nLua:  matches[2] = first capture, matches[1] = whole match (Mudlet-style)\nBoth: line = the full matched line; gag(); highlight(color)'
      },
      { h: 'JavaScript extras' },
      {
        code: "client.globals            object shared by all your JS\nclient.after(ms, fn)      run fn after a delay\n\n// startup script:\nglobals.greet = (name) => client.send('wave ' + name)\n// trigger (regex '^(\\\\w+) arrives'):\nglobals.greet(matches[1])"
      },
      {
        p: 'Lua globals persist across runs within a session the same way. Script errors print as red lines — they never crash the client.'
      }
    ]
  },
  {
    id: 'gauges',
    title: 'Gauges & Vitals',
    blocks: [
      {
        p: 'Gauges are HP/mana/movement style bars above the output, configured in ⚙ Settings → Gauges. Each gauge reads two variables: a current value (e.g. @hp) and a max (e.g. @maxhp). Leave the max empty to display a plain number instead of a bar.'
      },
      { h: 'Where the numbers come from' },
      {
        list: [
          'GMCP servers: Char.Vitals arrives automatically as variables (hp, maxhp, mp, ...).',
          'MSDP servers (e.g. The Builder Academy): health, health_max, mana, mana_max, movement, movement_max, level, experience are reported automatically as they change.',
          'Everywhere else: capture your prompt with a trigger. That works on every MUD with a numeric prompt.'
        ]
      },
      { h: 'Example: prompt-fed gauges (works on any MUD)' },
      {
        code: 'Your prompt:      <224hp 340mv [day]>\nTrigger pattern:  ^<(\\d+)hp (\\d+)mv     (regular expression)\nCommands:         #var hp %1;#var mv %2\n\nGauge 1: label HP, value hp, max maxhp   (set maxhp once: #var maxhp 250)\nGauge 2: label MV, value mv, max maxmv'
      },
      {
        p: '#var also works from the command line or scripts (setVar). Fast-changing values update instantly on screen; they are saved to disk in gentle batches, so a busy prompt costs nothing.'
      }
    ]
  },
  {
    id: 'captures',
    title: 'Chat Capture',
    blocks: [
      {
        p: 'A capture window collects specific lines — tells, group chat, channels — into a tabbed pane below the output, so conversation never drowns in combat spam.'
      },
      {
        list: [
          'Create one from any trigger: fill in "Copy to capture window" with a name like Tells. Lines matching that trigger are copied there.',
          'Combine with Gag to move lines entirely: gagged from the main output, kept in the capture window.',
          'Multiple triggers can feed the same window, and different windows get their own tabs.',
          'The pane appears when a window first receives a line; toggle it with 💬 Captures in the status bar; 🗑 clears the current tab.'
        ]
      },
      { h: 'Example: a Tells window' },
      {
        code: "Pattern (regex):   ^(\\w+) tells you '\nCopy to window:    Tells\nGag:               off (or on, to keep tells out of the main scroll)"
      }
    ]
  },
  {
    id: 'mapper',
    title: 'The Mapper',
    blocks: [
      {
        p: 'Wayfarer draws a map of the world as you explore. Open it with the 🗺 Map button or #map; the ⧉ button pops it into its own window — the pop-out is the full editor, so you can keep the map on a second monitor and do everything there: edit rooms and exits, manage zones and waypoints, merge duplicates, walk.'
      },
      { h: 'How it tracks you' },
      {
        p: 'The mapper watches the commands you send and the room descriptions that come back. On MUDs that publish structured room data (GMCP or MSDP, like The Builder Academy), tracking is exact. Everywhere else it uses dead reckoning — and when something contradicts the map, it deliberately STOPS and shows "position unknown" rather than guessing junk rooms into your map. Fix it by right-clicking the room you are actually in → "I am here" (or type #lost to reset and re-sync). Your position is remembered between sessions: on reconnect you resume where you left off, re-verified against your first room description.'
      },
      {
        list: [
          'Modes (toolbar): Map = track and create rooms while exploring; Follow = track only, never create; Off.',
          'The map is a graph, not a grid: rooms connected u-then-n and n-then-u stay separate rooms even if they would overlap on screen. Drag rooms to tidy the layout — position is cosmetic.',
          'All 10 directions are drawn (diagonals included); ▲▼ marks up/down exits, ◈ marks special exits, dashed lines are unexplored stubs.'
        ]
      },
      { h: 'Doors' },
      {
        p: 'Doors show as a yellow tick across an exit. The mapper marks them automatically when you bump into "the door seems to be closed" or send an open command with a direction — but a door that happened to be open on your first visit will be missed, so every exit has a manual door toggle in right-click → Exits & doors, along with the name to open (e.g. "gate"). Auto-walks open doors on the way through.'
      },
      { h: 'Walking' },
      {
        list: [
          'Double-click any room to walk there. Default is a confirmed walk: one step at a time, verifying each room, halting visibly if anything is off. Right-click offers "Walk here (fast)" to blast all steps at once.',
          'Hidden doors self-heal: if a step bounces off a closed door the map never knew about, the walk opens it, retries, records the door for next time, and carries on. A door that stays shut (locked) or a hard "no way there" halts the walk with the reason.',
          '#stop cancels a walk in progress.'
        ]
      },
      { h: 'Waypoints' },
      {
        code: '#wp add temple     name the room you are standing in\n#go temple         confirmed walk there from anywhere\n#go! temple        fast walk\n#wp list           show all waypoints\n#wp del temple     remove one'
      },
      {
        p: 'Waypoints also live behind the ★ toolbar button — click one to walk there.'
      },
      { h: 'Zones' },
      {
        p: 'Zones keep areas manageable, and allocation is mostly automatic: a new room joins the zone of the room you walked out of. You only act at boundaries — type #zone <name> (or pick from the dropdown) as you enter a new area: the NEXT room you map starts that zone, and everything you explore from there inherits it. Walk back into an old area and new rooms rejoin that area\'s zone with no further action. On MSDP/GMCP MUDs, the server\'s own area names assign zones automatically.'
      },
      {
        list: [
          'Name zones anything: "＋ New zone…" in the dropdown asks for a name, and ✎ renames the current zone. #zone <name> also creates by name.',
          'Reassign anytime: right-click a room → "Move to zone…", or Shift-drag a box around a whole region → right-click → "Move N rooms to zone…" (you can type a brand-new zone name right there). Links and layout are untouched.',
          'Shift-click adds or removes single rooms from a box selection; the multi-menu can also delete the selection.',
          'The 🗑 toolbar button deletes an entire zone and all its rooms (with confirmation).'
        ]
      },
      { h: 'Fixing mistakes' },
      {
        list: [
          'Right-click a room: rename, recolor, add notes, delete, or "Merge into selected room" (select the keeper first, then right-click the duplicate).',
          'The 🧹 toolbar button finds rooms with identical name + exits — locate each copy, and one click merges them all into the best-connected one (all links redirect). Leave genuine maze rooms unmerged.',
          'Exits & doors: delete bogus exits, link an unexplored stub to a selected room, add special exits ("enter portal") that pathfinding will use.',
          'Right-click empty space: add a room by hand.',
          'Maps save automatically (atomic writes + hourly backups) per world profile.'
        ]
      }
    ]
  },
  {
    id: 'mxp-msp',
    title: 'Clickable Links & Sound (MXP/MSP)',
    blocks: [
      {
        p: 'On servers that support them (status bar shows MXP / MSP badges), Wayfarer negotiates two extra protocols automatically.'
      },
      { h: 'MXP — clickable text' },
      {
        list: [
          'Underlined dotted text is clickable: exits, items, menu entries. Clicking sends the associated command, exactly as if you typed it.',
          'Hover shows what will be sent. Links marked "prompt" put the command into your input line for editing instead of sending.',
          'Web links open in your system browser — never inside the client.',
          'Bold/italic/color markup from the server renders inline. For safety, tags are only honored on server-secured lines; anything a player says renders as plain text.'
        ]
      },
      { h: 'MSP — sound triggers' },
      {
        list: [
          'Servers trigger sounds with !!SOUND(file.wav) and looping music with !!MUSIC(file.mid) — these lines are consumed, not displayed.',
          'Sound files play from your local sounds folder: %APPDATA%\\wayfarer\\sounds. Drop the sound pack for your MUD in there (Wayfarer never downloads files itself).',
          'Missing files are silently skipped. Volume/loop parameters (V=, L=) are honored; !!SOUND(Off) and !!MUSIC(Off) stop playback.',
          'Master switch: ⚙ Settings → General → "Play MUD sounds (MSP)".'
        ]
      }
    ]
  },
  {
    id: 'logging',
    title: 'Logging',
    blocks: [
      {
        p: 'Wayfarer can record a session to a plain-text file, one line per line of output, each stamped [HH:MM:SS].'
      },
      {
        list: [
          'Toggle with the 📝 button in the status bar.',
          'Auto-log every session: ⚙ Settings → Logging → "Start logging automatically".',
          '"Open Logs Folder" shows the files; each is named after the world and start time.',
          'Gagged lines are not logged; your commands and system notices are.'
        ]
      }
    ]
  },
  {
    id: 'settings-data',
    title: 'Settings, Scopes & Your Data',
    blocks: [
      { h: 'Scopes' },
      {
        p: 'Triggers, aliases, macros, timers, scripts, and variables live in a scope, chosen at the top of the ⚙ panel:'
      },
      {
        list: [
          'This world — applies only to sessions using that profile.',
          'All worlds (global) — applies to every session.',
          'Both are active at once; when they clash, the world-specific setting wins.'
        ]
      },
      { h: 'Where your data lives' },
      {
        p: 'Everything is human-readable JSON on your disk — profiles, settings, and logs — under the app data folder (%APPDATA%\\wayfarer). You can read, diff, back up, or sync these files freely.'
      },
      { h: 'Corruption protection' },
      {
        list: [
          'Every save is atomic: written to a temporary file, flushed, then swapped in. A crash mid-save cannot corrupt anything.',
          'Before every overwrite (and every delete) a timestamped backup is kept — the last 25 per item, in the backups folder.',
          'A file that fails to load is quarantined (renamed .corrupt), never silently discarded.',
          'To restore a backup: close Wayfarer, copy the backup over the original file, reopen.'
        ]
      }
    ]
  },
  {
    id: 'version-updates',
    title: 'Version & Updates',
    blocks: [
      {
        p: 'The version you are running is shown in three places: on the connect screen under the title, at the right-hand end of every session status bar, and in ⚙ Settings → General.'
      },
      { h: 'Automatic updates' },
      {
        list: [
          'Installed builds check for a new release on launch and every 4 hours after.',
          'A new version downloads in the background — nothing interrupts a live session.',
          'When it is ready, an ⬆ Update button appears in the status bar. Click it to restart into the new version immediately, or just ignore it: it installs on its own the next time you quit.',
          'Settings → General → Open updater log shows exactly what the updater checked, downloaded, or failed on.'
        ]
      },
      { h: 'What servers are told' },
      {
        p: 'Wayfarer reports this same version to MUDs that ask — over GMCP as Core.Hello, and over MXP as the <VERSION> reply. Servers that print a client banner on login will show it.'
      }
    ]
  },
  {
    id: 'protocols',
    title: 'Protocols & Status Bar',
    blocks: [
      {
        p: 'Wayfarer negotiates modern MUD protocols automatically. Badges in the status bar show what the current server supports:'
      },
      {
        list: [
          'MCCP2 — the server compresses its output (saves bandwidth; decompressed transparently).',
          'GMCP — a structured data channel (character stats, room info...). Phase 4 will surface this as gauges and panels.',
          '🔒 masked — the server turned off echo; your input is hidden (passwords).',
          '📝 logging — this session is being recorded.'
        ]
      },
      {
        p: 'Behind the scenes Wayfarer also answers TTYPE/MTTS (identifies itself and advertises 256-color/truecolor/UTF-8), NAWS (reports your window size so the server wraps text correctly), CHARSET, MSSP (server info), and basic MSDP. ANSI colors render in 16, 256, and 24-bit color, with the classic bold-is-bright behavior MUDs expect.'
      }
    ]
  }
]
