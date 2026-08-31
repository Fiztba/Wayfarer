/**
 * MapperTab — teach the mapper what a room looks like on this MUD.
 *
 * Laid out backwards from a normal settings form on purpose. Nobody opens this
 * page to admire regular expressions; they open it because their MUD is not
 * mapping. So the first thing is a box to paste a room into and a plain answer
 * about what the mapper made of it. The patterns come after, to be touched only
 * once the answer is wrong.
 */
import { useMemo, useState } from 'react'
import { RoomCapture } from '../map/capture'
import { DIR_FULL, type Direction, type RoomDetection } from '../map/types'
import type { CaptureRule, SettingsSet } from '../../../shared/types'

interface Props {
  set: SettingsSet
  save(next: SettingsSet): Promise<void> | void
}

/** Starting points, not a closed list: each is a built-in format written out,
 *  so a MUD that is nearly one of them can be adjusted rather than invented. */
const PRESETS: Array<{ label: string; rule: CaptureRule }> = [
  { label: 'Built-in formats only', rule: {} },
  {
    label: 'CircleMUD / tbaMUD — [ Exits: n e w ]',
    rule: { exitsLine: '^\\[\\s*(?:Obvious\\s+)?Exits?:\\s*([^\\]]*?)\\s*\\]' }
  },
  {
    label: 'SMAUG / ROM / Merc — Exits: north east.',
    rule: { exitsLine: '^\\s*(?:Obvious\\s+)?Exits?:\\s*(.+?)\\s*\\.?\\s*$' }
  },
  {
    label: 'AwakeMUD CE — a header, then one line per exit',
    rule: {
      exitsHeader: '^\\s*(?:Obvious\\s+)?Exits?:\\s*$',
      exitsItem: '^\\s*\\(?([A-Za-z]+)\\)?\\s+[-–:]\\s+(.*\\S)\\s*$'
    }
  }
]

const FIELDS: Array<{
  key: 'title' | 'exitsLine' | 'exitsHeader' | 'exitsItem'
  label: string
  hint: string
}> = [
  {
    key: 'exitsLine',
    label: 'Exits, all on one line',
    hint: 'The bracketed part must capture the list of directions.'
  },
  {
    key: 'exitsHeader',
    label: 'Exits header',
    hint: 'For MUDs that print a heading and then one exit per line. Captures nothing.'
  },
  {
    key: 'exitsItem',
    label: 'One exit line',
    hint: 'First bracket is the direction; a second one, if you add it, is the room it leads to.'
  },
  {
    key: 'title',
    label: 'Room name',
    hint: 'Leave empty to find it by looking back from the exits, which usually works.'
  }
]

/** Run a pasted room through the capture exactly as a live session would. */
function tryRule(text: string, rule: CaptureRule): { det: RoomDetection | null; bad: string[] } {
  const capture = new RoomCapture(rule)
  let det: RoomDetection | null = null
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const found = capture.feedLine(line)
    if (found) det = found
  }
  // A block of listed exits only completes when a line that is not an exit
  // arrives. Pasted text often stops at the last exit, so end it here.
  if (!det) det = capture.feedLine('')
  return { det, bad: capture.badPatterns }
}

export function MapperTab({ set, save }: Props) {
  const rule = set.capture ?? {}
  const [sample, setSample] = useState('')
  const [shareError, setShareError] = useState('')

  const result = useMemo(() => tryRule(sample, rule), [sample, rule])
  const update = (patch: Partial<CaptureRule>): void => {
    const next: CaptureRule = { ...rule, ...patch }
    for (const k of Object.keys(next) as Array<keyof CaptureRule>) {
      if (next[k] === '' || next[k] === undefined) delete next[k]
    }
    void save({ ...set, capture: Object.keys(next).length > 0 ? next : undefined })
  }

  const copyRule = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(rule, null, 2))
      setShareError('Copied. Paste it anywhere this MUD is discussed.')
    } catch {
      setShareError('Could not reach the clipboard.')
    }
  }
  const pasteRule = async (): Promise<void> => {
    try {
      const parsed = JSON.parse(await navigator.clipboard.readText())
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not a rule')
      void save({ ...set, capture: parsed as CaptureRule })
      setShareError('')
    } catch {
      setShareError('That does not look like a mapper rule.')
    }
  }

  const det = result.det
  return (
    <div className="editor">
      <div className="editor-list" style={{ flex: 1, overflowY: 'auto' }}>
        <p className="field-hint" style={{ marginBottom: 8 }}>
          The mapper already knows several common formats. If your MUD is not one of them, paste a
          room below and describe its shape — then share what you worked out with others who play
          it.
        </p>

        <div className="field">
          <label className="field-label" htmlFor="mapper-sample">
            Paste a room, exactly as your MUD prints it
          </label>
          <textarea
            id="mapper-sample"
            rows={8}
            spellCheck={false}
            placeholder={'Temple Square\nA wide plaza of worn flagstones.\nExits: north east'}
            value={sample}
            onChange={(e) => setSample(e.target.value)}
          />
        </div>

        <div className="field">
          <span className="field-label">What the mapper sees</span>
          {sample.trim().length === 0 ? (
            <p className="empty-hint">Nothing pasted yet.</p>
          ) : !det ? (
            <p className="empty-hint">
              No room found. The exits are what it looks for first — start with a preset below, or
              describe the exits line.
            </p>
          ) : (
            <div className="editor-row" style={{ display: 'block' }}>
              <div>
                <span className="row-label">Name</span> {det.name}
              </div>
              <div>
                <span className="row-label">Exits</span>{' '}
                {det.exits.length === 0
                  ? 'none'
                  : det.exits
                      .map(
                        (e) =>
                          DIR_FULL[e.dir as Direction] + (e.destName ? ` → ${e.destName}` : '')
                      )
                      .join(', ')}
              </div>
              <div>
                <span className="row-label">Description</span>{' '}
                {det.descHash
                  ? 'captured — used to tell identical-looking rooms apart'
                  : 'none found'}
              </div>
            </div>
          )}
        </div>

        <div className="field">
          <label className="field-label" htmlFor="mapper-preset">
            Start from a known format
          </label>
          <select
            id="mapper-preset"
            defaultValue=""
            onChange={(e) => {
              const preset = PRESETS[Number(e.target.value)]
              if (preset) update({ ...preset.rule })
              e.target.value = ''
            }}
          >
            <option value="">Choose…</option>
            {PRESETS.map((p, i) => (
              <option key={p.label} value={i}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        {FIELDS.map((f) => (
          <div className="field" key={f.key}>
            <label className="field-label" htmlFor={`mapper-${f.key}`}>
              {f.label}
              {result.bad.includes(f.key) && (
                <span style={{ color: '#e06c75' }}> — not a valid pattern</span>
              )}
            </label>
            <input
              id={`mapper-${f.key}`}
              spellCheck={false}
              value={rule[f.key] ?? ''}
              onChange={(e) => update({ [f.key]: e.target.value } as Partial<CaptureRule>)}
            />
            <span className="field-hint">{f.hint}</span>
          </div>
        ))}

        <div className="field">
          <label className="field-label" htmlFor="mapper-ignore">
            Lines to ignore, one pattern per line
          </label>
          <textarea
            id="mapper-ignore"
            rows={3}
            spellCheck={false}
            placeholder={'^\\[chat\\]\n^\\(OOC\\)'}
            value={(rule.ignore ?? []).join('\n')}
            onChange={(e) =>
              update({ ignore: e.target.value.split('\n').filter((l) => l.trim().length > 0) })
            }
          />
          <span className="field-hint">
            Channel chatter and status bars, so they are never mistaken for part of a room.
          </span>
        </div>

        <label className="field-label" style={{ display: 'block', marginTop: 8 }}>
          <input
            type="checkbox"
            checked={rule.builtins === false}
            onChange={(e) => update({ builtins: e.target.checked ? false : undefined })}
          />{' '}
          Use only what I have described
        </label>
        <span className="field-hint">
          Normally your patterns are tried first and the built-in formats still apply after, so
          adding one cannot break a MUD that already worked. Tick this only if a built-in is
          misreading your MUD.
        </span>

        <div className="field" style={{ marginTop: 12 }}>
          <span className="field-label">Share</span>
          <div>
            <button className="map-btn" onClick={() => void copyRule()}>
              Copy rule
            </button>{' '}
            <button className="map-btn" onClick={() => void pasteRule()}>
              Paste rule
            </button>
          </div>
          {shareError && <span className="field-hint">{shareError}</span>}
        </div>
      </div>
    </div>
  )
}
