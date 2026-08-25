import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { settingsManager } from '../SettingsManager'
import { sessionStores, type SessionStore } from '../SessionStore'
import { keyEventSignature } from '../automation/AutomationEngine'
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

interface Props {
  store: SessionStore
  onClose(): void
}

export function SettingsPanel({ store, onClose }: Props) {
  const [scope, setScope] = useState<string | null>(store.profileId)
  const [tab, setTab] = useState<Tab>('triggers')
  const [, force] = useState(0)

  useEffect(() => settingsManager.subscribe(() => force((n) => n + 1)), [])

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
      <div className="panel">
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
          {tab === 'triggers' && <TriggersTab set={set} save={save} />}
          {tab === 'aliases' && <AliasesTab set={set} save={save} />}
          {tab === 'macros' && <MacrosTab set={set} save={save} />}
          {tab === 'timers' && <TimersTab set={set} save={save} />}
          {tab === 'scripts' && <ScriptsTab set={set} save={save} store={store} />}
          {tab === 'gauges' && <GaugesTab set={set} save={save} />}
          {tab === 'variables' && <VariablesTab set={set} save={save} />}
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

function TriggersTab({ set, save }: TabProps) {
  const [draft, setDraft] = useState<TriggerDef | null>(null)
  const isNew = draft !== null && !set.triggers.some((t) => t.id === draft.id)

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
            <span className="row-main" onClick={() => setDraft({ ...t })}>
              <span className="row-label">{t.label || t.pattern}</span>
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
        <button className="add-btn" onClick={() => setDraft(emptyTrigger())}>
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
            onChange={(e) => setDraft({ ...draft, pattern: e.target.value })}
          />
          {patternError && <p className="form-error">{patternError}</p>}
          <div className="form-row">
            <label>
              <select
                value={draft.matchType}
                onChange={(e) =>
                  setDraft({ ...draft, matchType: e.target.value as TriggerDef['matchType'] })
                }
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
          <div className="form-buttons">
            <button className="connect-btn" disabled={!draft.pattern || !!patternError} onClick={commit}>
              {isNew ? 'Add Trigger' : 'Save Trigger'}
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

// ---- Aliases ----------------------------------------------------------------

function AliasesTab({ set, save }: TabProps) {
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

function MacrosTab({ set, save }: TabProps) {
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
              e.preventDefault()
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

function TimersTab({ set, save }: TabProps) {
  const [draft, setDraft] = useState<TimerDef | null>(null)
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
            <span className="row-main" onClick={() => setDraft({ ...t })}>
              <span className="row-label">{t.label || t.commands.slice(0, 30)}</span>
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
            setDraft({
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
            value={String(draft.intervalMs / 1000)}
            onChange={(e) => {
              const s = parseFloat(e.target.value)
              setDraft({ ...draft, intervalMs: Number.isFinite(s) ? Math.round(s * 1000) : 0 })
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

function ScriptsTab({ set, save, store }: TabProps & { store: SessionStore }) {
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
          <input
            className="scrollback-input"
            value={String(global.options.pasteLineDelayMs)}
            onChange={(e) => {
              const n = parseInt(e.target.value.replace(/\D/g, ''), 10)
              if (Number.isFinite(n)) setOption({ pasteLineDelayMs: n })
            }}
            onBlur={(e) => {
              const n = parseInt(e.target.value.replace(/\D/g, ''), 10) || 0
              setOption({ pasteLineDelayMs: Math.min(5000, Math.max(0, n)) })
            }}
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
          <input
            className="scrollback-input"
            value={String(global.options.scrollbackLines)}
            onChange={(e) => {
              const n = parseInt(e.target.value.replace(/\D/g, ''), 10)
              if (Number.isFinite(n)) setOption({ scrollbackLines: n })
            }}
            onBlur={(e) => {
              const n = parseInt(e.target.value.replace(/\D/g, ''), 10) || 100000
              setOption({ scrollbackLines: Math.min(1_000_000, Math.max(1000, n)) })
            }}
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

function GaugesTab({ set, save }: TabProps) {
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
