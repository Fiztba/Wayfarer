/**
 * Dawn of Demise character autoroller — two JS triggers.
 * Run directly (`node scripts/autoroll.mjs`) to install them into the
 * Dawn of Demise profile's settings (with a backup). Close Wayfarer first.
 */
import crypto from 'node:crypto'

const CAPTURE_JS = `const stat = matches[1].toLowerCase()
const v = Number(matches[2])
client.setVar('roll_' + stat, matches[2])
// Observed range per stat — reveals the server's real roller and racial caps.
const lo = client.getVar('roll_lo_' + stat)
const hi = client.getVar('roll_hi_' + stat)
if (!lo || v < Number(lo)) client.setVar('roll_lo_' + stat, String(v))
if (!hi || v > Number(hi)) client.setVar('roll_hi_' + stat, String(v))`

const DECIDE_JS = `if ((client.getVar('autoroll') || '0') !== '1') return
const stats = ['strength','intelligence','wisdom','dexterity','constitution','charisma','luck']
const val = (s) => Number(client.getVar('roll_' + s) || 0)
const min = (s) => Number(client.getVar('rollmin_' + s) || 0)
const minTotal = Number(client.getVar('rollmin_total') || 0)
if (minTotal <= 0 && !stats.some((s) => min(s) > 0)) {
  client.echo('Autoroll: no thresholds set. Example: #var rollmin_strength 15   #var rollmin_total 78')
  return
}
const total = stats.reduce((a, s) => a + val(s), 0)
const summary = stats.map((s) => s.slice(0, 3) + ' ' + val(s)).join('  ') + '  | total ' + total
globals.rolls = (globals.rolls || 0) + 1
// Running stats across ALL rolls ever (reset: #var roll_n 0 + #var roll_sum 0).
const n = Number(client.getVar('roll_n') || 0) + 1
const sum = Number(client.getVar('roll_sum') || 0) + total
client.setVar('roll_n', String(n))
client.setVar('roll_sum', String(sum))
const avg = (sum / n).toFixed(1)
const ranges = stats
  .map((s) => s.slice(0, 3) + ' ' + (client.getVar('roll_lo_' + s) || '?') + '-' + (client.getVar('roll_hi_' + s) || '?'))
  .join('  ')
const ceiling = stats.reduce((a, s) => a + Number(client.getVar('roll_hi_' + s) || 0), 0)
// Best roll to date (persists as variables; reset with #var roll_best_total 0).
if (total > Number(client.getVar('roll_best_total') || 0)) {
  client.setVar('roll_best_total', String(total))
  client.setVar('roll_best', summary)
}
const best = client.getVar('roll_best_total') || '0'
const ok = total >= minTotal && stats.every((s) => val(s) >= min(s))
if (ok) {
  client.echo('*** AUTOROLL KEEPER (roll #' + globals.rolls + '): ' + summary + ' ***')
  globals.rolls = 0
  client.setVar('roll_best_total', '0')
  client.setVar('roll_best', '')
  if ((client.getVar('rollkeep') || '0') === '1') {
    client.send('Y')
  } else {
    client.setVar('autoroll', '0')
    client.echo('Autoroll stopped — press Y to keep this roll.')
  }
} else {
  const cap = Number(client.getVar('rollmax') || 1000)
  if (globals.rolls >= cap) {
    client.echo('Autoroll: stopping after ' + globals.rolls + ' rolls without a keeper.')
    client.echo('Best seen: total ' + best + ' — ' + (client.getVar('roll_best') || '(none)'))
    client.echo('Observed ranges (' + n + ' rolls): ' + ranges)
    client.echo('Average total ' + avg + ' — ceiling if every stat maxed at once: ' + ceiling)
    client.echo('Raise the cap with #var rollmax 5000, adjust thresholds, then #var autoroll 1.')
    globals.rolls = 0
    client.setVar('autoroll', '0')
    return
  }
  if (globals.rolls % 25 === 0) {
    client.echo('Autoroll: roll #' + globals.rolls + ' — best: ' + (client.getVar('roll_best') || '(none)'))
    client.echo('  avg total ' + avg + ' over ' + n + ' rolls · ranges: ' + ranges + ' · ceiling ' + ceiling)
  } else {
    client.echo('Autoroll: reroll #' + globals.rolls + ' — best total ' + best + ' · avg ' + avg)
  }
  client.after(250, () => client.send(''))
}`

export function makeAutorollTriggers() {
  return [
    {
      id: crypto.randomUUID(),
      label: 'Autoroll: capture stats',
      pattern: '^\\s*(Strength|Intelligence|Wisdom|Dexterity|Constitution|Charisma|Luck)\\s*:\\s*(\\d+)\\s*$',
      matchType: 'regex',
      caseInsensitive: true,
      commands: CAPTURE_JS,
      language: 'js',
      gag: false,
      highlight: '',
      enabled: true
    },
    {
      id: crypto.randomUUID(),
      label: 'Autoroll: decide',
      pattern: 'Hit <Enter> to reroll',
      matchType: 'substring',
      caseInsensitive: true,
      commands: DECIDE_JS,
      language: 'js',
      gag: false,
      highlight: '',
      enabled: true
    }
  ]
}

// ---- installer (run directly) ----------------------------------------------
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const base = path.join(process.env.APPDATA, 'wayfarer')
  const profiles = fs
    .readdirSync(path.join(base, 'profiles'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(base, 'profiles', f), 'utf8')))
  const dod = profiles.find((p) => /dawn of demise/i.test(p.name))
  if (!dod) {
    console.error('No Dawn of Demise profile found.')
    process.exit(1)
  }
  const settingsFile = path.join(base, 'settings', dod.id + '.json')
  const settings = fs.existsSync(settingsFile)
    ? JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    : { triggers: [], aliases: [], macros: [], timers: [], scripts: [], gauges: [], variables: {}, options: { autoLog: false } }
  if (fs.existsSync(settingsFile)) {
    fs.copyFileSync(settingsFile, settingsFile + '.pre-autoroll-bak')
  }
  const had = settings.triggers.length
  settings.triggers = settings.triggers.filter((t) => !/^Autoroll:/.test(t.label ?? ''))
  const replaced = had !== settings.triggers.length
  settings.triggers.push(...makeAutorollTriggers())
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2))
  console.log(
    `${replaced ? 'Updated' : 'Installed'} 2 autoroll triggers in "${dod.name}" (${settingsFile})`
  )
}
