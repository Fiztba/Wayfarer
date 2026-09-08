/** Two actual Electron lifetimes, one uninterrupted compressed MUD connection. */
const { app } = require('electron')
const { spawn } = require('node:child_process')
const net = require('node:net'), zlib = require('node:zlib')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'wayfarer-copyover-'))
fs.writeFileSync(path.join(data, 'mud-directory-cache.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), snapshot: { muds: [], counts: {}, builtAt: new Date().toISOString() } }))
let connections = 0, closes = 0, received = '', mud, compressed
const server = net.createServer(socket => {
  connections++; mud = socket
  socket.on('data', chunk => { received += chunk.toString('latin1') })
  socket.on('close', () => closes++)
})
let child
const timer = setTimeout(() => { child?.kill(); mud?.destroy(); app.exit(1) }, 40000)
const wait = async (test) => { const end = Date.now() + 10000; while (!await test()) { assert.ok(Date.now() < end, 'Timed out'); await new Promise(r => setTimeout(r, 20)) } }
async function launch(version) {
  const proc = spawn(process.execPath, [path.join(__dirname, 'fixtures/copyover-client.cjs'), data, version], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  child = proc
  let ready = false, failure = null, next = 1
  const pending = new Map()
  proc.stdout.on('data', () => {})
  proc.stderr.on('data', chunk => { if (process.env.COPYOVER_DEBUG) process.stderr.write(chunk) })
  proc.on('message', msg => {
    if (msg.ready) ready = true
    if (msg.failure) { failure = msg.failure; pending.get(msg.id)?.reject(new Error(msg.failure)) }
    else if (msg.id) pending.get(msg.id)?.resolve(msg.result)
    pending.delete(msg.id)
  })
  await wait(() => { if (failure) throw new Error(failure); return ready })
  return {
    js(code) { const id = next++; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); proc.send({ id, code }) }) },
    async update() { const done = new Promise(resolve => proc.once('exit', resolve)); proc.send({ op: 'update' }); await done; if (failure) throw new Error(failure) },
    async quit() { const done = new Promise(resolve => proc.once('exit', resolve)); proc.send({ op: 'quit' }); await done }
  }
}
const text = value => new Promise((resolve, reject) => { compressed.write(value); compressed.flush(zlib.constants.Z_SYNC_FLUSH, err => err ? reject(err) : resolve()) })
;(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  let client = await launch('0.4.35-test')
  await client.js(`(async () => { const s = await window.mud.settings.get(null); s.triggers = [{id:'ping',label:'Ping',pattern:'^ping[0-9]+$',matchType:'regex',commands:'ack',gag:false,highlight:'',enabled:true}]; await window.mud.settings.save(null,s) })()`)
  const value = (selector, value) => client.js(`{ const e=document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),'value').set.call(e,${JSON.stringify(value)}); e.dispatchEvent(new Event('input',{bubbles:true})); }`)
  await value('#qc-host', '127.0.0.1'); await value('#qc-port', String(server.address().port))
  await value('#qc-name', 'Copyover Test')
  await client.js(`document.querySelector('.connect-btn').click()`)
  await wait(() => connections === 1)
  await wait(() => client.js(`document.querySelector('.status-text')?.textContent.includes('Connected')`))
  // Negotiate and start one continuous MCCP stream before either update.
  mud.write(Buffer.from([255,251,86,255,250,86,255,240]))
  compressed = zlib.createDeflate(); compressed.on('data', chunk => mud.write(chunk))
  await text('Western Gate\r\nA broad gate faces east.\r\nExits: east\r\nping1\r\n')
  await wait(() => (received.match(/ack\r?\n/g) || []).length === 1)
  await value('.command-input', 'e')
  await client.js(`document.querySelector('.command-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`)
  await wait(() => received.includes('e\r\n'))
  // Stop mid-room AND mid-ANSI escape. The resumed half must complete once.
  await text('Eastern Walkway\r\nThe walkway follows a stone wall.\r\n\x1b[3')
  await value('.command-input', 'unsent draft')
  await client.update()
  assert.equal(closes, 0)
  await text('6mExits: west east\x1b[0m\r\nping2\r\nBuffered café ✓\r\n')
  assert.equal((received.match(/ack\r?\n/g) || []).length, 1, 'no triggers run while the client is absent')
  client = await launch('0.4.36-test')
  await wait(() => client.js(`document.querySelector('.command-input')?.value === 'unsent draft'`))
  await wait(() => (received.match(/ack\r?\n/g) || []).length === 2)
  assert.equal(connections, 1)
  assert.equal(closes, 0)
  const page = await client.js('document.body.textContent')
  assert.ok(page.includes('Buffered café ✓'))
  assert.equal((page.match(/ping1/g) || []).length, 1)
  assert.equal((page.match(/ping2/g) || []).length, 1)
  const readMap = () => client.js(`(async () => { const p=(await window.mud.profiles.list()).find(p=>p.name==='Copyover Test'); return window.mud.map.load(p.id) })()`)
  await wait(async () => Object.keys((await readMap()).rooms).length === 2)
  const map = await readMap()
  const rooms = Object.values(map.rooms)
  assert.equal(rooms.length, 2)
  const gate = rooms.find(r => r.name === 'Western Gate')
  const walk = rooms.find(r => r.name === 'Eastern Walkway')
  assert.equal(gate.exits.find(e=>e.dir==='e').to, walk.id)
  console.log('ok new Electron process resumes one MCCP connection, draft, scrollback, split ANSI and pending mapper arrival; triggers fire exactly once')
  await client.update()
  await text('ping3\r\n')
  client = await launch('0.4.37-test')
  await wait(() => (received.match(/ack\r?\n/g) || []).length === 3)
  assert.equal(connections, 1)
  await client.quit()
  await wait(() => closes === 1)
  console.log('ok a second copyover works and ordinary Quit closes the preserved connection')
  server.close(); clearTimeout(timer); app.exit(0)
})().catch(error => { console.error(error); child?.kill(); mud?.destroy(); server.close(); clearTimeout(timer); app.exit(1) })
