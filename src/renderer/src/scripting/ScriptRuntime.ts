/**
 * ScriptRuntime — per-session JavaScript and Lua execution with a shared
 * client API. JS runs natively (compiled once per unique body); Lua runs in
 * an embedded Lua 5.4 VM (wasmoon/WebAssembly), created lazily on first use.
 *
 * Both languages see the same surface:
 *   send(text)            — send through the alias/speedwalk pipeline
 *   sendRaw(text)         — transmit exactly as written
 *   echo(text) / print()  — write a local line to the session output
 *   getVar(n) / setVar(n, v) — persistent @variables
 *   session()             — { name, host, port, connected }
 *   In trigger context:   line, matches (0 = whole match), gag(), highlight(c)
 *   JS also gets:         client.globals (shared object), client.after(ms, fn)
 *
 * DOM-free so it can be exercised headlessly in Node.
 */
import { LuaFactory, type LuaEngine } from 'wasmoon'

export interface ScriptApiHost {
  send(text: string): void
  sendRaw(text: string): void
  echo(text: string): void
  echoError(text: string): void
  getVar(name: string): string | undefined
  setVar(name: string, value: string): void
  session(): { name: string; host: string; port: number; connected: boolean }
}

export interface ScriptContext {
  matches?: string[]
  line?: string
  gag?: () => void
  highlight?: (color: string) => void
}

type CompiledScript = (
  client: Record<string, unknown>,
  matches: string[],
  line: string,
  globals: Record<string, unknown>
) => void

export class ScriptRuntime {
  private host: ScriptApiHost
  private luaWasmUrl?: string

  private jsCache = new Map<string, CompiledScript | null>()
  private globalsObj: Record<string, unknown> = {}
  private timerHandles = new Set<ReturnType<typeof setTimeout>>()

  private lua: LuaEngine | null = null
  private luaInit: Promise<LuaEngine | null> | null = null
  private luaQueue: Array<{ code: string; ctx: ScriptContext }> = []
  private disposed = false

  constructor(host: ScriptApiHost, luaWasmUrl?: string) {
    this.host = host
    this.luaWasmUrl = luaWasmUrl
  }

  run(language: 'js' | 'lua', code: string, ctx: ScriptContext = {}): void {
    if (language === 'js') this.runJs(code, ctx)
    else this.runLua(code, ctx)
  }

  // ---- JavaScript ---------------------------------------------------------

  private runJs(code: string, ctx: ScriptContext): void {
    let fn = this.jsCache.get(code)
    if (fn === undefined) {
      try {
        fn = new Function('client', 'matches', 'line', 'globals', code) as CompiledScript
      } catch (e) {
        fn = null
        this.host.echoError(`JS compile error: ${e instanceof Error ? e.message : e}`)
      }
      this.jsCache.set(code, fn)
    }
    if (!fn) {
      this.host.echoError('JS script has a compile error and was skipped.')
      return
    }
    try {
      fn(this.buildClient(ctx), ctx.matches ?? [], ctx.line ?? '', this.globalsObj)
    } catch (e) {
      this.host.echoError(`JS error: ${e instanceof Error ? e.message : e}`)
    }
  }

  private buildClient(ctx: ScriptContext): Record<string, unknown> {
    const noop = () => {}
    return {
      send: (t: unknown) => this.host.send(String(t)),
      sendRaw: (t: unknown) => this.host.sendRaw(String(t)),
      echo: (t: unknown) => this.host.echo(String(t)),
      print: (t: unknown) => this.host.echo(String(t)),
      getVar: (n: unknown) => this.host.getVar(String(n)),
      setVar: (n: unknown, v: unknown) => this.host.setVar(String(n), String(v)),
      session: this.host.session(),
      globals: this.globalsObj,
      gag: ctx.gag ?? noop,
      highlight: ctx.highlight ?? noop,
      after: (ms: number, fn: () => void) => {
        const handle = setTimeout(() => {
          this.timerHandles.delete(handle)
          try {
            fn()
          } catch (e) {
            this.host.echoError(`JS error (after): ${e instanceof Error ? e.message : e}`)
          }
        }, ms)
        this.timerHandles.add(handle)
      }
    }
  }

  // ---- Lua ----------------------------------------------------------------

  private runLua(code: string, ctx: ScriptContext): void {
    this.luaQueue.push({ code, ctx })
    void this.flushLua()
  }

  private async ensureLua(): Promise<LuaEngine | null> {
    this.luaInit ??= (async () => {
      try {
        const factory = new LuaFactory(this.luaWasmUrl)
        const engine = await factory.createEngine()
        engine.global.set('send', (t: unknown) => this.host.send(String(t)))
        engine.global.set('sendRaw', (t: unknown) => this.host.sendRaw(String(t)))
        engine.global.set('echo', (t: unknown) => this.host.echo(String(t)))
        engine.global.set('print', (t: unknown) => this.host.echo(String(t)))
        engine.global.set('getVar', (n: unknown) => this.host.getVar(String(n)))
        engine.global.set('setVar', (n: unknown, v: unknown) =>
          this.host.setVar(String(n), String(v))
        )
        engine.global.set('session', () => this.host.session())
        this.lua = engine
        return engine
      } catch (e) {
        this.host.echoError(`Lua engine failed to start: ${e instanceof Error ? e.message : e}`)
        return null
      }
    })()
    return this.luaInit
  }

  private flushing = false
  private async flushLua(): Promise<void> {
    if (this.flushing) return
    this.flushing = true
    try {
      const engine = await this.ensureLua()
      while (this.luaQueue.length > 0) {
        const { code, ctx } = this.luaQueue.shift()!
        if (!engine || this.disposed) continue
        const noop = () => {}
        // Context is exposed as globals per invocation. Arrays become 1-based
        // Lua tables, so matches[1] = whole match, matches[2] = first capture —
        // the same convention Mudlet uses.
        engine.global.set('matches', ctx.matches ?? [])
        engine.global.set('line', ctx.line ?? '')
        engine.global.set('gag', ctx.gag ?? noop)
        engine.global.set('highlight', ctx.highlight ?? noop)
        try {
          await engine.doString(code)
        } catch (e) {
          this.host.echoError(`Lua error: ${e instanceof Error ? e.message : e}`)
        }
      }
    } finally {
      this.flushing = false
    }
  }

  dispose(): void {
    this.disposed = true
    for (const h of this.timerHandles) clearTimeout(h)
    this.timerHandles.clear()
    this.luaQueue = []
    try {
      this.lua?.global.close()
    } catch {
      // already closed
    }
    this.lua = null
  }
}
