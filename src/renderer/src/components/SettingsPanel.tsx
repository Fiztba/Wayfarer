import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { MapperTab } from './MapperTab'
import { settingsManager } from '../SettingsManager'
import { forCharacter } from '../automation/scope.ts'
import { sessionStores, type SessionStore } from '../SessionStore'
import { keyEventSignature } from '../automation/AutomationEngine'
import {
  buildPattern,
  captureNumber,
  previewMatches,
  tokenizeLine,
  type LineToken
} from '../automation/triggerBuilder'
import { lineText } from './OutputLine'
import type {
  ActionLanguage,
  AliasDef,
  GaugeDef,
  MacroDef,
  ScriptDef,
  SettingsSet,
  TimerDef,
  TriggerDef
} from '../../../shared/types'

type Tab =
  | 'triggers'
  | 'aliases'
  | 'macros'
  | 'timers'
  | 'scripts'
  | 'gauges'
  | 'variables'
  | 'mapper'
  | 'logging'
  | 'general'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'triggers', label: 'Triggers' },
  { id: 'aliases', label: 'Aliases' },
  { id: 'macros', label: 'Macros' },
  { id: 'timers', label: 'Timers' },
  { id: 'scripts', label: 'Scripts' },
  { id: 'gauges', label: 'Gauges' },
  { id: 'variables', label: 'Variables' },
  { id: 'mapper', label: 'Mapper' },
  { id: 'logging', label: 'Logging' },
  { id: 'general', label: 'General' }
]

const COUNTED_TABS = new Set<Tab>(['triggers', 'aliases', 'macros', 'timers', 'scripts', 'gauges'])

function LanguageSelect({
  value,
  onChange
}: {
  value: ActionLanguage
  onChange(v: ActionLanguage): void
}) {
  return (
    <label>
      Action{' '}
      <select value={value} onChange={(e) => onChange(e.target.value as ActionLanguage)}>
        <option value="commands">Send commands</option>
        <option value="js">JavaScript</option>
        <option value="lua">Lua</option>
      </select>
    </label>
  )
}

function langBadge(language: ActionLanguage | undefined): string {
  if (language === 'js') return ' · JS'
  if (language === 'lua') return ' · Lua'
  return ''
}

/**
 * Limit an item to one or more characters on this world. Blank means every
 * character; the session's current name is offered as the placeholder so the
 * spelling matches what the login guesser or GMCP produced.
 */
function CharacterField({
  value,
  current,
  onChange
}: {
  value: string
  current: string | null | undefined
  onChange(v: string): void
}) {
  const active = value.trim() === '' || forCharacter(value, current)
  return (
    <>
      <label className="field-label">
        Only for character{' '}
        <span className="field-hint">(blank = any; several with commas)</span>
      </label>
      <input
        value={value}
        placeholder={current ? `e.g. ${current}` : 'e.g. Mystra'}
        onChange={(e) => onChange(e.target.value)}
      />
      {value.trim() !== '' && (
        <p className="field-hint" style={{ marginTop: 4 }}>
          {current
            ? active
              ? `Active now: this session is logged in as ${current}.`
              : `Not active now: this session is logged in as ${current}.`
            : 'Not active until the session knows who is logged in (GMCP, the login prompt, or #char <name>).'}
        </p>
      )}
    </>
  )
}

/** Row marker for a character-scoped item. */
function charTag(character: string | undefined): React.ReactNode {
  const names = (character ?? '').trim()
  if (!names) return null
  return (
    <span className="row-char" title={`Only while logged in as ${names}`}>
      👤 {names}
    </span>
  )
}

interface Props {
  store: SessionStore
  onClose(): void
  /** A line of output to seed a new trigger from (opens on the Triggers tab). */
  seedLine?: string | null
}

/** How much recent output a trigger is previewed against. */
const PREVIEW_LINES = 500

export function SettingsPanel({ store, onClose, seedLine }: Props) {
  const [scope, setScope] = useState<string | null>(store.profileId)
  const [tab, setTab] = useState<Tab>('triggers')
  // The seed is used exactly once. The Triggers tab unmounts whenever another
  // tab is shown, so it cannot own this: it would re-seed a phantom trigger
  // every time the tab came back. The panel unmounts on close, so the
  // initializer runs fresh for each open.
  const [pendingSeed, setPendingSeed] = useState<string | null>(seedLine ?? null)
  // What the MUD said lately, as a trigger would see it, for the editor's
  // "would fire on N of the last M lines" preview. Read once per open: the
  // count is a sanity check on the pattern, not a live monitor.
  const recentLines = useMemo(
    () =>
      store.lines
        .filter((l) => l.kind === 'output')
        .slice(-PREVIEW_LINES)
        .map(lineText),
    [store]
  )
  const [, force] = useState(0)

  useEffect(() => settingsManager.subscribe(() => force((n) => n + 1)), [])

  // Escape closes the modal from anywhere inside it.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const set = settingsManager.getScope(scope)

  const save = useCallback(
    async (next: SettingsSet) => {
      await settingsManager.save(scope, next)
      for (const s of sessionStores.values()) s.engine.refreshTimers()
    },
    [scope]
  )

  return (
    <div className="panel-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="panel" role="dialog" aria-modal="true" aria-label="Automation & Settings">
        <div className="panel-header">
          <span className="panel-title">Automation &amp; Settings</span>
          <select
            className="scope-select"
            value={scope ?? '__global__'}
            onChange={(e) => setScope(e.target.value === '__global__' ? null : e.target.value)}
          >
            {store.profileId && <option value={store.profileId}>This world ({store.name})</option>}
            <option value="__global__">All worlds (global)</option>
          </select>
          <button className="panel-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="panel-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`panel-tab ${tab === t.id ? 'panel-tab-active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {COUNTED_TABS.has(t.id) && (
                <span className="tab-count">
                  {(
                    set[t.id as 'triggers' | 'aliases' | 'macros' | 'timers' | 'scripts' | 'gauges'] ??
                    []
                  ).length || ''}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="panel-body">
          {tab === 'triggers' && (
            <TriggersTab
              set={set}
              save={save}
              seedLine={pendingSeed}
              onSeedConsumed={() => setPendingSeed(null)}
              recentLines={recentLines}
              charName={store.charName}
            />
          )}
          {tab === 'aliases' && <AliasesTab set={set} save={save} charName={store.charName} />}
          {tab === 'macros' && <MacrosTab set={set} save={save} charName={store.charName} />}
          {tab === 'timers' && <TimersTab set={set} save={save} charName={store.charName} />}
          {tab === 'scripts' && <ScriptsTab set={set} save={save} store={store} charName={store.charName} />}
          {tab === 'gauges' && <GaugesTab set={set} save={save} charName={store.charName} />}
          {tab === 'variables' && <VariablesTab set={set} save={save} />}
          {tab === 'mapper' && <MapperTab set={set} save={save} />}
          {tab === 'logging' && <LoggingTab set={set} save={save} store={store} />}
          {tab === 'general' && <GeneralTab />}
        </div>
      </div>
    </div>
  )
}

interface TabProps {
  set: SettingsSet
  save(next: SettingsSet): Promise<void>
  /** Who this session is logged in as, for the character field's hint. */
  charName?: string | null
}

// ---- Triggers ---------------------------------------------------------------

function emptyTrigger(): TriggerDef {
  return {
    id: crypto.randomUUID(),
    label: '',
    pattern: '',
    matchType: 'substring',
    caseInsensitive: true,
    commands: '',
    gag: false,
    highlight: '',
    enabled: true
  }
}

/** The line a draft trigger was built from, and which of its tokens are captured. */
interface BuilderState {
  line: string
  tokens: LineToken[]
  captured: Set<number>
  anchorStart: boolean
  anchorEnd: boolean
}

function seededTrigger(line: string): { draft: TriggerDef; builder: BuilderState } {
  const tokens = tokenizeLine(line)
  const builder: BuilderState = { line, tokens, captured: new Set(), anchorStart: true, anchorEnd: true }
  const draft: TriggerDef = {
    ...emptyTrigger(),
    matchType: 'regex',
    caseInsensitive: false,
    pattern: buildPattern(tokens, builder.captured, builder)
  }
  return { draft, builder }
}

function TriggersTab({
  set,
  save,
  charName,
  seedLine,
  onSeedConsumed,
  recentLines
}: TabProps & { seedLine: string | null; onSeedConsumed(): void; recentLines: string[] }) {
  const [draft, setDraft] = useState<TriggerDef | null>(null)
  // Present while the pattern is being composed from a line. Editing the
  // pattern by hand takes over from it -- the chips then no longer describe
  // what the pattern says, so they go away rather than lie.
  const [builder, setBuilder] = useState<BuilderState | null>(null)
  const isNew = draft !== null && !set.triggers.some((t) => t.id === draft.id)

  useEffect(() => {
    if (!seedLine) return
    const seeded = seededTrigger(seedLine)
    setDraft(seeded.draft)
    setBuilder(seeded.builder)
    onSeedConsumed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedLine])

  const updateBuilder = (next: Partial<BuilderState>): void => {
    if (!builder || !draft) return
    const merged = { ...builder, ...next }
    setBuilder(merged)
    setDraft({ ...draft, pattern: buildPattern(merged.tokens, merged.captured, merged) })
  }
  const toggleCapture = (i: number): void => {
    if (!builder) return
    const captured = new Set(builder.captured)
    if (captured.has(i)) captured.delete(i)
    else captured.add(i)
    updateBuilder({ captured })
  }

  const preview = useMemo(() => (draft ? previewMatches(draft, recentLines) : null), [draft, recentLines])

  const patternError = useMemo(() => {
    if (!draft || draft.matchType !== 'regex' || !draft.pattern) return null
    try {
      new RegExp(draft.pattern)
      return null
    } catch (e) {
      return String(e instanceof Error ? e.message : e)
    }
  }, [draft])

  const commit = async () => {
    if (!draft || !draft.pattern || patternError) return
    const rest = set.triggers.filter((t) => t.id !== draft.id)
    await save({ ...set, triggers: [...rest, draft] })
    setDraft(null)
    setBuilder(null)
  }

  return (
    <div className="editor">
      <div className="editor-list">
        <p className="field-hint" style={{ marginBottom: 8 }}>
          Triggers react to lines from the MUD: send commands, gag, or highlight. Details in Help.
        </p>
        {set.triggers.length === 0 && <p className="empty-hint">No triggers yet.</p>}
        {set.triggers.map((t) => (
          <div key={t.id} className={`editor-row ${draft?.id === t.id ? 'editor-row-active' : ''}`}>
            <input
              type="checkbox"
              checked={t.enabled}
              title="Enabled"
              onChange={(e) =>
                save({
                  ...set,
                  triggers: set.triggers.map((x) =>
                    x.id === t.id ? { ...x, enabled: e.target.checked } : x
                  )
                })
              }
            />
            <span
              className="row-main"
              onClick={() => {
                setBuilder(null)
                setDraft({ ...t })
              }}
            >
              <span className="row-label">{t.label || t.pattern}</span>
              {charTag(t.character)}
              <span className="row-detail">
                {t.matchType === 'regex' ? 'regex' : 'text'}
                {t.gag ? ' · gag' : ''}
                {t.highlight ? ' · highlight' : ''}
                {t.captureWindow?.trim() ? ` · →${t.captureWindow.trim()}` : ''}
                {t.commands.trim() ? ' · fires' : ''}
                {langBadge(t.language)}
              </span>
            </span>
            <button
              className="row-delete"
              onClick={() => save({ ...set, triggers: set.triggers.filter((x) => x.id !== t.id) })}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          className="add-btn"
          onClick={() => {
            setBuilder(null)
            setDraft(emptyTrigger())
          }}
        >
          + New Trigger
        </button>
      </div>
      {draft && (
        <div className="editor-form">
          <label className="field-label">Label (optional)</label>
          <input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
          <label className="field-label">Pattern</label>
          <input
            value={draft.pattern}
            placeholder={draft.matchType === 'regex' ? '^(\\w+) tells you' : 'tells you'}
            onChange={(e) => {
              setBuilder(null)
              setDraft({ ...draft, pattern: e.target.value })
            }}
          />
          {patternError && <p className="form-error">{patternError}</p>}
          {builder && (
            <div className="trigger-builder">
              <p className="field-hint">
                Built from a line of output. Click a word to capture it instead of matching it
                literally; captures become %1, %2… in order.
              </p>
              <div className="tb-line">
                {builder.tokens.map((tok, i) => {
                  if (tok.kind === 'other') {
                    return (
                      <span key={i} className="tb-lit">
                        {tok.text}
                      </span>
                    )
                  }
                  const n = captureNumber(builder.captured, i)
                  return (
                    <button
                      key={i}
                      type="button"
                      className={`tb-chip${n ? ' tb-chip-on' : ''}${tok.suggested && !n ? ' tb-chip-suggested' : ''}`}
                      title={n ? `Captured as %${n}` : 'Click to capture'}
                      onClick={() => toggleCapture(i)}
                    >
                      {tok.text}
                      {n ? <span className="tb-num">%{n}</span> : null}
                    </button>
                  )
                })}
              </div>
              <div className="form-row">
                <label>
                  <input
                    type="checkbox"
                    checked={builder.anchorStart}
                    onChange={(e) => updateBuilder({ anchorStart: e.target.checked })}
                  />{' '}
                  Line must start here
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={builder.anchorEnd}
                    onChange={(e) => updateBuilder({ anchorEnd: e.target.checked })}
                  />{' '}
                  Line must end here
                </label>
              </div>
            </div>
          )}
          {preview && draft.pattern && !patternError && (
            <p className={`tb-preview${preview.count === 0 ? ' tb-preview-none' : ''}`}>
              Would have fired on {preview.count} of the last {preview.total} lines
              {preview.sample ? (
                <>
                  , most recently: <span className="tb-sample">{preview.sample}</span>
                </>
              ) : (
                '.'
              )}
            </p>
          )}
          <div className="form-row">
            <label>
              <select
                value={draft.matchType}
                onChange={(e) => {
                  // The composed pattern is a regex; as plain text it could
                  // never match, and the chips would be describing nothing.
                  setBuilder(null)
                  setDraft({ ...draft, matchType: e.target.value as TriggerDef['matchType'] })
                }}
              >
                <option value="substring">Contains text</option>
                <option value="regex">Regular expression</option>
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={draft.caseInsensitive}
                onChange={(e) => setDraft({ ...draft, caseInsensitive: e.target.checked })}
              />{' '}
              Ignore case
            </label>
            <LanguageSelect
              value={draft.language ?? 'commands'}
              onChange={(language) => setDraft({ ...draft, language })}
            />
          </div>
          <label className="field-label">
            {(draft.language ?? 'commands') === 'commands' ? (
              <>
                Commands to send{' '}
                <span className="field-hint">(%1–%9 = captures, %0 = match; blank for none)</span>
              </>
            ) : (
              <>
                Script code{' '}
                <span className="field-hint">
                  (captures: JS matches[1]…, Lua matches[2]… Mudlet-style; line, gag(),
                  highlight(color))
                </span>
              </>
            )}
          </label>
          <textarea
            rows={3}
            value={draft.commands}
            onChange={(e) => setDraft({ ...draft, commands: e.target.value })}
          />
          <label className="field-label">
            Copy to capture window{' '}
            <span className="field-hint">(optional — e.g. "Tells"; shows as a tabbed pane)</span>
          </label>
          <input
            value={draft.captureWindow ?? ''}
            placeholder="leave empty for none"
            onChange={(e) => setDraft({ ...draft, captureWindow: e.target.value })}
          />
          <div className="form-row">
            <label>
              <input
                type="checkbox"
                checked={draft.gag}
                onChange={(e) => setDraft({ ...draft, gag: e.target.checked })}
              />{' '}
              Gag line
            </label>
            <label>
              <input
                type="checkbox"
                checked={draft.highlight !== ''}
                onChange={(e) => setDraft({ ...draft, highlight: e.target.checked ? '#ffd68a' : '' })}
              />{' '}
              Highlight
            </label>
            {draft.highlight !== '' && (
              <input
                type="color"
                value={draft.highlight}
                onChange={(e) => setDraft({ ...draft, highlight: e.target.value })}
              />
            )}
          </div>
          <CharacterField
            value={draft.character ?? ''}
            current={charName}
            onChange={(character) => setDraft({ ...draft, character })}
          />
          <div className="form-buttons">
            <button className="connect-btn" disabled={!draft.pattern || !!patternError} onClick={commit}>
              {isNew ? 'Add Trigger' : 'Save Trigger'}
            </button>
            <button
              className="save-btn"
              onClick={() => {
                setDraft(null)
                setBuilder(null)
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---- Aliases ----------------------------------------------------------------

function AliasesTab({ set, save, charName }: TabProps) {
  const [draft, setDraft] = useState<AliasDef | null>(null)
  const isNew = draft !== null && !set.aliases.some((a) => a.id === draft.id)

  const commit = async () => {
    if (!draft || !draft.name.trim() || !draft.commands.trim()) return
    const clean = { ...draft, name: draft.name.trim().split(/\s+/)[0] }
    const rest = set.aliases.filter((a) => a.id !== clean.id)
    await save({ ...set, aliases: [...rest, clean] })
    setDraft(null)
  }

  return (
    <div className="editor">
      <div className="editor-list">
        <p className="field-hint" style={{ marginBottom: 8 }}>
          Type the alias word and it expands — e.g. <code>gh</code> →{' '}
          <code>get all corpse;bury corpse</code>.
        </p>
        {set.aliases.length === 0 && <p className="empty-hint">No aliases yet.</p>}
        {set.aliases.map((a) => (
          <div key={a.id} className={`editor-row ${draft?.id === a.id ? 'editor-row-active' : ''}`}>
            <input
              type="checkbox"
              checked={a.enabled}
              title="Enabled"
              onChange={(e) =>
                save({
                  ...set,
                  aliases: set.aliases.map((x) =>
                    x.id === a.id ? { ...x, enabled: e.target.checked } : x
                  )
                })
              }
            />
            <span className="row-main" onClick={() => setDraft({ ...a })}>
              <span className="row-label">{a.name}</span>
              {charTag(a.character)}
              <span className="row-detail">
                {a.commands.split('\n')[0].slice(0, 60)}
                {langBadge(a.language)}
              </span>
            </span>
            <button
              className="row-delete"
              onClick={() => save({ ...set, aliases: set.aliases.filter((x) => x.id !== a.id) })}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          className="add-btn"
          onClick={() =>
            setDraft({ id: crypto.randomUUID(), name: '', commands: '', enabled: true })
          }
        >
          + New Alias
        </button>
      </div>
      {draft && (
        <div className="editor-form">
          <label className="field-label">
            Alias <span className="field-hint">(the word you type)</span>
          </label>
          <input
            value={draft.name}
            placeholder="e.g. gh"
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <div className="form-row">
            <LanguageSelect
              value={draft.language ?? 'commands'}
              onChange={(language) => setDraft({ ...draft, language })}
            />
          </div>
          <label className="field-label">
            {(draft.language ?? 'commands') === 'commands' ? (
              <>
                Expands to{' '}
                <span className="field-hint">(%1–%9 = arguments, %0 = all; use ; to chain)</span>
              </>
            ) : (
              <>
                Script code{' '}
                <span className="field-hint">(matches[1]… = arguments, matches[0] = all)</span>
              </>
            )}
          </label>
          <textarea
            rows={3}
            value={draft.commands}
            placeholder="e.g. get all corpse;bury corpse"
            onChange={(e) => setDraft({ ...draft, commands: e.target.value })}
          />
          <CharacterField
            value={draft.character ?? ''}
            current={charName}
            onChange={(character) => setDraft({ ...draft, character })}
          />
          <div className="form-buttons">
            <button
              className="connect-btn"
              disabled={!draft.name.trim() || !draft.commands.trim()}
              onClick={commit}
            >
              {isNew ? 'Add Alias' : 'Save Alias'}
            </button>
            <button className="save-btn" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---- Macros -----------------------------------------------------------------

function MacrosTab({ set, save, charName }: TabProps) {
  const [draft, setDraft] = useState<MacroDef | null>(null)
  const isNew = draft !== null && !set.macros.some((m) => m.id === draft.id)

  const commit = async () => {
    if (!draft || !draft.key || !draft.commands.trim()) return
    const rest = set.macros.filter((m) => m.id !== draft.id)
    await save({ ...set, macros: [...rest, draft] })
    setDraft(null)
  }

  return (
    <div className="editor">
      <div className="editor-list">
        <p className="field-hint" style={{ marginBottom: 8 }}>
          Bind F-keys, numpad, or Ctrl/Alt combos to commands. They fire even while typing.
        </p>
        {set.macros.length === 0 && <p className="empty-hint">No macros yet.</p>}
        {set.macros.map((m) => (
          <div key={m.id} className={`editor-row ${draft?.id === m.id ? 'editor-row-active' : ''}`}>
            <input
              type="checkbox"
              checked={m.enabled}
              title="Enabled"
              onChange={(e) =>
                save({
                  ...set,
                  macros: set.macros.map((x) =>
                    x.id === m.id ? { ...x, enabled: e.target.checked } : x
                  )
                })
              }
            />
            <span className="row-main" onClick={() => setDraft({ ...m })}>
              <span className="row-label">{m.key}</span>
              {charTag(m.character)}
              <span className="row-detail">
                {m.commands.split('\n')[0].slice(0, 60)}
                {langBadge(m.language)}
              </span>
            </span>
            <button
              className="row-delete"
              onClick={() => save({ ...set, macros: set.macros.filter((x) => x.id !== m.id) })}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          className="add-btn"
          onClick={() => setDraft({ id: crypto.randomUUID(), key: '', commands: '', enabled: true })}
        >
          + New Macro
        </button>
      </div>
      {draft && (
        <div className="editor-form">
          <label className="field-label">
            Key <span className="field-hint">(click below, then press the key combination)</span>
          </label>
          <input
            readOnly
            value={draft.key}
            placeholder="Press a key… (F1–F12, Numpad, or Ctrl/Alt + key)"
            onKeyDown={(e) => {
              // A bare Tab isn't a bindable key (see keyEventSignature), so
              // let it move focus as usual instead of trapping the keyboard
              // in this field. Ctrl/Alt+Tab are still captured.
              if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) return
              e.preventDefault()
              // Ctrl/Alt+Escape are bindable; don't let them reach the
              // panel's Escape-to-close and throw the draft away.
              e.stopPropagation()
              const sig = keyEventSignature(e)
              if (sig) setDraft({ ...draft, key: sig })
            }}
          />
          <div className="form-row">
            <LanguageSelect
              value={draft.language ?? 'commands'}
              onChange={(language) => setDraft({ ...draft, language })}
            />
          </div>
          <label className="field-label">
            {(draft.language ?? 'commands') === 'commands' ? 'Commands' : 'Script code'}
          </label>
          <textarea
            rows={3}
            value={draft.commands}
            placeholder="e.g. cast 'cure light' ; look"
            onChange={(e) => setDraft({ ...draft, commands: e.target.value })}
          />
          <CharacterField
            value={draft.character ?? ''}
            current={charName}
            onChange={(character) => setDraft({ ...draft, character })}
          />
          <div className="form-buttons">
            <button
              className="connect-btn"
              disabled={!draft.key || !draft.commands.trim()}
              onClick={commit}
            >
              {isNew ? 'Add Macro' : 'Save Macro'}
            </button>
            <button className="save-btn" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---- Timers -----------------------------------------------------------------

/** Seconds as the user would type them: no trailing ".0", no float noise. */
function formatSeconds(ms: number): string {
  return String(Math.round(ms) / 1000)
}

function TimersTab({ set, save, charName }: TabProps) {
  const [draft, setDraftState] = useState<TimerDef | null>(null)
  // Text draft of the interval field; see the input's onChange for why it
  // is not derived from draft.intervalMs on every render.
  const [intervalText, setIntervalText] = useState('')
  // Edits within the draft (language, commands…) go through setDraft and
  // leave whatever is being typed alone; opening a row or a new timer goes
  // through openDraft, which reseeds the text.
  const setDraft = setDraftState
  const openDraft = (next: TimerDef): void => {
    setDraftState(next)
    setIntervalText(formatSeconds(next.intervalMs))
  }
  const isNew = draft !== null && !set.timers.some((t) => t.id === draft.id)

  const commit = async () => {
    if (!draft || draft.intervalMs < 100 || !draft.commands.trim()) return
    const rest = set.timers.filter((t) => t.id !== draft.id)
    await save({ ...set, timers: [...rest, draft] })
    setDraft(null)
  }

  return (
    <div className="editor">
      <div className="editor-list">
        <p className="field-hint" style={{ marginBottom: 8 }}>
          Timers run their commands on a schedule while the session is connected.
        </p>
        {set.timers.length === 0 && <p className="empty-hint">No timers yet.</p>}
        {set.timers.map((t) => (
          <div key={t.id} className={`editor-row ${draft?.id === t.id ? 'editor-row-active' : ''}`}>
            <input
              type="checkbox"
              checked={t.enabled}
              title="Enabled"
              onChange={(e) =>
                save({
                  ...set,
                  timers: set.timers.map((x) =>
                    x.id === t.id ? { ...x, enabled: e.target.checked } : x
                  )
                })
              }
            />
            <span className="row-main" onClick={() => openDraft({ ...t })}>
              <span className="row-label">{t.label || t.commands.slice(0, 30)}</span>
              {charTag(t.character)}
              <span className="row-detail">
                every {(t.intervalMs / 1000).toFixed(t.intervalMs % 1000 ? 1 : 0)}s
                {t.oneShot ? ' · once' : ''}
                {langBadge(t.language)}
              </span>
            </span>
            <button
              className="row-delete"
              onClick={() => save({ ...set, timers: set.timers.filter((x) => x.id !== t.id) })}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          className="add-btn"
          onClick={() =>
            openDraft({
              id: crypto.randomUUID(),
              label: '',
              intervalMs: 60000,
              commands: '',
              oneShot: false,
              enabled: true
            })
          }
        >
          + New Timer
        </button>
      </div>
      {draft && (
        <div className="editor-form">
          <label className="field-label">Label (optional)</label>
          <input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
          <label className="field-label">Interval (seconds)</label>
          <input
            value={intervalText}
            onChange={(e) => {
              // Keep the raw text so "1." survives on the way to "1.5"; the
              // parsed value only feeds the draft (and the Add button's
              // enabled state), never the field.
              setIntervalText(e.target.value)
              const s = parseFloat(e.target.value)
              setDraft({ ...draft, intervalMs: Number.isFinite(s) ? Math.round(s * 1000) : 0 })
            }}
            onBlur={() => setIntervalText(formatSeconds(draft.intervalMs))}
          />
          <div className="form-row">
            <LanguageSelect
              value={draft.language ?? 'commands'}
              onChange={(language) => setDraft({ ...draft, language })}
            />
          </div>
          <label className="field-label">
            {(draft.language ?? 'commands') === 'commands' ? 'Commands' : 'Script code'}
          </label>
          <textarea
            rows={3}
            value={draft.commands}
            placeholder="e.g. save"
            onChange={(e) => setDraft({ ...draft, commands: e.target.value })}
          />
          <div className="form-row">
            <label>
              <input
                type="checkbox"
                checked={draft.oneShot}
                onChange={(e) => setDraft({ ...draft, oneShot: e.target.checked })}
              />{' '}
              Run once, then stop
            </label>
          </div>
          <CharacterField
            value={draft.character ?? ''}
            current={charName}
            onChange={(character) => setDraft({ ...draft, character })}
          />
          <div className="form-buttons">
            <button
              className="connect-btn"
              disabled={draft.intervalMs < 100 || !draft.commands.trim()}
              onClick={commit}
            >
              {isNew ? 'Add Timer' : 'Save Timer'}
            </button>
            <button className="save-btn" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
          <p className="field-hint">Timers run while the session is connected.</p>
        </div>
      )}
    </div>
  )
}

// ---- Scripts ----------------------------------------------------------------

function ScriptsTab({ set, save, store, charName }: TabProps & { store: SessionStore }) {
  const [draft, setDraft] = useState<ScriptDef | null>(null)
  const isNew = draft !== null && !set.scripts.some((s) => s.id === draft.id)

  const commit = async () => {
    if (!draft || !draft.name.trim() || !draft.code.trim()) return
    const rest = set.scripts.filter((s) => s.id !== draft.id)
    await save({ ...set, scripts: [...rest, draft] })
    setDraft(null)
  }

  return (
    <div className="editor">
      <div className="editor-list">
        <p className="field-hint" style={{ marginBottom: 8 }}>
          Enabled scripts run when a session connects. API: <code>send()</code>,{' '}
          <code>echo()</code>, <code>getVar()</code>, <code>setVar()</code> — in JS via the{' '}
          <code>client</code> object, in Lua as globals.
        </p>
        {set.scripts.length === 0 && <p className="empty-hint">No scripts yet.</p>}
        {set.scripts.map((s) => (
          <div key={s.id} className={`editor-row ${draft?.id === s.id ? 'editor-row-active' : ''}`}>
            <input
              type="checkbox"
              checked={s.enabled}
              title="Run on connect"
              onChange={(e) =>
                save({
                  ...set,
                  scripts: set.scripts.map((x) =>
                    x.id === s.id ? { ...x, enabled: e.target.checked } : x
                  )
                })
              }
            />
            <span className="row-main" onClick={() => setDraft({ ...s })}>
              <span className="row-label">{s.name}</span>
              {charTag(s.character)}
              <span className="row-detail">
                {s.language === 'js' ? 'JavaScript' : 'Lua'} · {s.code.split('\n').length} lines
              </span>
            </span>
            <button className="row-delete" title="Run now" onClick={() => store.runScriptNow(s)}>
              ▶
            </button>
            <button
              className="row-delete"
              onClick={() => save({ ...set, scripts: set.scripts.filter((x) => x.id !== s.id) })}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          className="add-btn"
          onClick={() =>
            setDraft({
              id: crypto.randomUUID(),
              name: '',
              language: 'js',
              code: '',
              enabled: true
            })
          }
        >
          + New Script
        </button>
      </div>
      {draft && (
        <div className="editor-form">
          <label className="field-label">Name</label>
          <input
            value={draft.name}
            placeholder="e.g. Auto-loot helpers"
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <div className="form-row">
            <label>
              Language{' '}
              <select
                value={draft.language}
                onChange={(e) =>
                  setDraft({ ...draft, language: e.target.value as ScriptDef['language'] })
                }
              >
                <option value="js">JavaScript</option>
                <option value="lua">Lua</option>
              </select>
            </label>
          </div>
          <label className="field-label">Code</label>
          <textarea
            rows={12}
            className="code-editor"
            value={draft.code}
            placeholder={
              draft.language === 'js'
                ? "// e.g.\nglobals.greet = (name) => client.send('wave ' + name)\nclient.echo('helpers loaded')"
                : "-- e.g.\nfunction greet(name)\n  send('wave ' .. name)\nend\necho('helpers loaded')"
            }
            onChange={(e) => setDraft({ ...draft, code: e.target.value })}
            spellCheck={false}
          />
          <CharacterField
            value={draft.character ?? ''}
            current={charName}
            onChange={(character) => setDraft({ ...draft, character })}
          />
          <div className="form-buttons">
            <button
              className="connect-btn"
              disabled={!draft.name.trim() || !draft.code.trim()}
              onClick={commit}
            >
              {isNew ? 'Add Script' : 'Save Script'}
            </button>
            <button className="save-btn" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---- General ----------------------------------------------------------------

/**
 * Integer option field that commits on blur or Enter, not per keystroke.
 * Saving as you type meant "50000" landed as 5, 50, 500… on the way — and
 * the field couldn't be emptied to retype, since NaN was never written back.
 */
function IntInput({
  value,
  min,
  max,
  fallback,
  onCommit
}: {
  value: number
  min: number
  max: number
  /** Used when the field is left blank or unparsable. */
  fallback: number
  onCommit(n: number): void
}) {
  const [text, setText] = useState(String(value))
  // Track changes made elsewhere (another window, a reset) while not typing.
  useEffect(() => setText(String(value)), [value])
  const commit = (): void => {
    const n = parseInt(text.replace(/\D/g, ''), 10)
    const clamped = Math.min(max, Math.max(min, Number.isFinite(n) ? n : fallback))
    setText(String(clamped))
    if (clamped !== value) onCommit(clamped)
  }
  return (
    <input
      className="scrollback-input"
      value={text}
      onChange={(e) => setText(e.target.value.replace(/\D/g, ''))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
      }}
    />
  )
}

function GeneralTab() {
  const [, force] = useState(0)
  useEffect(() => settingsManager.subscribe(() => force((n) => n + 1)), [])
  const global = settingsManager.getScope(null)

  const setOption = (patch: Partial<typeof global.options>) =>
    settingsManager.save(null, { ...global, options: { ...global.options, ...patch } })

  return (
    <div className="editor">
      <div className="editor-list" style={{ flex: 1 }}>
        <p className="field-hint" style={{ marginBottom: 8 }}>
          These apply to the whole app, regardless of the scope selected above.
        </p>
        <div className="logging-option">
          Wayfarer <b>v{window.mud.version}</b>
          <button
            className="status-btn"
            style={{ marginLeft: 10 }}
            title="Open updater.log — what the auto-updater found, downloaded, or failed on"
            onClick={() => void window.mud.openUpdaterLog()}
          >
            Open updater log
          </button>
          <div className="field-hint">
            An update found at startup installs before the window opens, so what you get is
            already the new version. One found later downloads in the background and installs
            when you quit. The log is only written by installed builds.
          </div>
        </div>
        <label className="logging-option">
          <input
            type="checkbox"
            checked={global.options.autoUpdate !== false}
            onChange={(e) => setOption({ autoUpdate: e.target.checked })}
          />{' '}
          Keep Wayfarer up to date
          <span className="field-hint">
            {' '}
            (off = stay on this version; nothing is checked or downloaded)
          </span>
        </label>
        <label className="logging-option">
          <input
            type="checkbox"
            checked={global.options.clearInputOnSend}
            onChange={(e) => setOption({ clearInputOnSend: e.target.checked })}
          />{' '}
          Clear the input line after sending
          <span className="field-hint"> (off = keep the command selected so typing replaces it)</span>
        </label>
        <label className="logging-option">
          <input
            type="checkbox"
            checked={global.options.showTimestamps}
            onChange={(e) => setOption({ showTimestamps: e.target.checked })}
          />{' '}
          Show timestamps on output lines
        </label>
        <label className="logging-option">
          <input
            type="checkbox"
            checked={global.options.pasteVerbatim}
            onChange={(e) => setOption({ pasteVerbatim: e.target.checked })}
          />{' '}
          Send pasted multi-line text verbatim
          <span className="field-hint">
            {' '}
            (keeps indentation and punctuation exactly as written — no aliases, semicolon
            stacking, @variables or speedwalks. Turn off to run every pasted line through the
            normal command pipeline.)
          </span>
        </label>
        <div className="logging-option">
          Delay between pasted lines:{' '}
          <IntInput
            value={global.options.pasteLineDelayMs}
            min={0}
            max={5000}
            fallback={0}
            onCommit={(n) => setOption({ pasteLineDelayMs: n })}
          />{' '}
          ms
          <div className="field-hint">
            0 sends the whole block at once (0 – 5000). Raise it if a MUD drops lines or trips
            its flood protection on a big paste; #stop cancels one mid-flight.
          </div>
        </div>
        <label className="logging-option">
          <input
            type="checkbox"
            checked={global.options.soundEnabled}
            onChange={(e) => setOption({ soundEnabled: e.target.checked })}
          />{' '}
          Play MUD sounds (MSP)
          <span className="field-hint">
            {' '}
            (plays files from the sounds folder when a server triggers them)
          </span>
        </label>
        <div className="logging-option">
          Scrollback buffer:{' '}
          <IntInput
            value={global.options.scrollbackLines}
            min={1000}
            max={1_000_000}
            fallback={100000}
            onCommit={(n) => setOption({ scrollbackLines: n })}
          />{' '}
          lines
          <div className="field-hint">
            How much history each session keeps (1,000 – 1,000,000; default 100,000). Older lines
            load as you scroll up, so huge buffers stay fast. For a permanent record, use logging.
          </div>
        </div>
      </div>
    </div>
  )
}

// ---- Gauges -----------------------------------------------------------------

function GaugesTab({ set, save, charName }: TabProps) {
  const [draft, setDraft] = useState<GaugeDef | null>(null)
  const isNew = draft !== null && !set.gauges.some((g) => g.id === draft.id)

  const commit = async () => {
    if (!draft || !draft.label.trim() || !draft.valueVar.trim()) return
    const clean = {
      ...draft,
      valueVar: draft.valueVar.trim().replace(/^@/, ''),
      maxVar: draft.maxVar.trim().replace(/^@/, '')
    }
    const rest = set.gauges.filter((g) => g.id !== clean.id)
    await save({ ...set, gauges: [...rest, clean] })
    setDraft(null)
  }

  return (
    <div className="editor">
      <div className="editor-list">
        <p className="field-hint" style={{ marginBottom: 8 }}>
          Bars above the output, driven by variables. On GMCP/MSDP servers vitals arrive
          automatically (e.g. <code>health</code>/<code>health_max</code> on TBA); anywhere else,
          fill variables from your prompt with a trigger: pattern{' '}
          <code>{'^<(\\d+)hp (\\d+)mv'}</code>, commands <code>#var hp %1;#var mv %2</code>.
        </p>
        {set.gauges.length === 0 && <p className="empty-hint">No gauges yet.</p>}
        {set.gauges.map((g) => (
          <div key={g.id} className={`editor-row ${draft?.id === g.id ? 'editor-row-active' : ''}`}>
            <input
              type="checkbox"
              checked={g.enabled}
              title="Enabled"
              onChange={(e) =>
                save({
                  ...set,
                  gauges: set.gauges.map((x) =>
                    x.id === g.id ? { ...x, enabled: e.target.checked } : x
                  )
                })
              }
            />
            <span className="row-main" onClick={() => setDraft({ ...g })}>
              <span className="row-label">{g.label}</span>
              {charTag(g.character)}
              <span className="row-detail">
                @{g.valueVar}
                {g.maxVar ? ` / @${g.maxVar}` : ''}
              </span>
            </span>
            <span className="map-color-swatch" style={{ background: g.color || '#61afef' }} />
            <button
              className="row-delete"
              onClick={() => save({ ...set, gauges: set.gauges.filter((x) => x.id !== g.id) })}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          className="add-btn"
          onClick={() =>
            setDraft({
              id: crypto.randomUUID(),
              label: '',
              valueVar: '',
              maxVar: '',
              color: '#61afef',
              enabled: true
            })
          }
        >
          + New Gauge
        </button>
      </div>
      {draft && (
        <div className="editor-form">
          <label className="field-label">Label</label>
          <input
            value={draft.label}
            placeholder="e.g. HP"
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          />
          <label className="field-label">
            Value variable <span className="field-hint">(current value, e.g. hp)</span>
          </label>
          <input
            value={draft.valueVar}
            placeholder="e.g. hp"
            onChange={(e) => setDraft({ ...draft, valueVar: e.target.value })}
          />
          <label className="field-label">
            Max variable <span className="field-hint">(empty = show the number without a bar)</span>
          </label>
          <input
            value={draft.maxVar}
            placeholder="e.g. maxhp"
            onChange={(e) => setDraft({ ...draft, maxVar: e.target.value })}
          />
          <div className="form-row">
            <label>
              Color{' '}
              <input
                type="color"
                value={draft.color || '#61afef'}
                onChange={(e) => setDraft({ ...draft, color: e.target.value })}
              />
            </label>
          </div>
          <CharacterField
            value={draft.character ?? ''}
            current={charName}
            onChange={(character) => setDraft({ ...draft, character })}
          />
          <div className="form-buttons">
            <button
              className="connect-btn"
              disabled={!draft.label.trim() || !draft.valueVar.trim()}
              onClick={commit}
            >
              {isNew ? 'Add Gauge' : 'Save Gauge'}
            </button>
            <button className="save-btn" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---- Variables --------------------------------------------------------------

function VariablesTab({ set, save }: TabProps) {
  const [newName, setNewName] = useState('')
  const [newValue, setNewValue] = useState('')
  const names = Object.keys(set.variables).sort()

  const add = async () => {
    const name = newName.trim().replace(/\W/g, '')
    if (!name) return
    await save({ ...set, variables: { ...set.variables, [name]: newValue } })
    setNewName('')
    setNewValue('')
  }

  return (
    <div className="editor">
      <div className="editor-list" style={{ flex: 1 }}>
        <p className="field-hint" style={{ marginBottom: 8 }}>
          Use variables in commands as <code>@name</code> (type <code>@@</code> for a literal @).
        </p>
        {names.length === 0 && <p className="empty-hint">No variables yet.</p>}
        {names.map((n) => (
          <div key={n} className="editor-row">
            <span className="row-main">
              <span className="row-label">@{n}</span>
            </span>
            <input
              className="var-value"
              value={set.variables[n]}
              onChange={(e) =>
                save({ ...set, variables: { ...set.variables, [n]: e.target.value } })
              }
            />
            <button
              className="row-delete"
              onClick={() => {
                const next = { ...set.variables }
                delete next[n]
                save({ ...set, variables: next })
              }}
            >
              ✕
            </button>
          </div>
        ))}
        <div className="editor-row">
          <input
            placeholder="name"
            value={newName}
            style={{ width: 130 }}
            onChange={(e) => setNewName(e.target.value)}
          />
          <input
            className="var-value"
            placeholder="value"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <button className="add-btn" style={{ margin: 0 }} onClick={add}>
            Add
          </button>
        </div>
      </div>
    </div>
  )
}

// ---- Logging ----------------------------------------------------------------

function LoggingTab({ set, save, store }: TabProps & { store: SessionStore }) {
  const [, force] = useState(0)
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store])

  return (
    <div className="editor">
      <div className="editor-list" style={{ flex: 1 }}>
        <label className="logging-option">
          <input
            type="checkbox"
            checked={set.options.autoLog}
            onChange={(e) =>
              save({ ...set, options: { ...set.options, autoLog: e.target.checked } })
            }
          />{' '}
          Start logging automatically when a session connects
        </label>
        <div className="logging-now">
          <p className="field-hint">
            This session:{' '}
            {store.logging ? (
              <>
                logging to <code>{store.logPath}</code>
              </>
            ) : (
              'not logging'
            )}
          </p>
          <div className="form-buttons">
            <button className="save-btn" onClick={() => store.toggleLogging()}>
              {store.logging ? 'Stop Logging' : 'Start Logging Now'}
            </button>
            <button className="save-btn" onClick={() => window.mud.log.openFolder()}>
              Open Logs Folder
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
