/**
 * Agent control (#agent on): a program on this computer drives one session
 * over a local pipe, typing commands as the player would and reading the
 * session's text back. These are the shapes that cross the renderer, the
 * main process and the pipe.
 */

/** One line of session text, as the bridge hands it to the agent. */
export interface AgentLine {
  /**
   * output: server text (gagged lines included, since gags only hide);
   * input: the echoed command line, prompt included; trigger: a command a
   * trigger sent; script: script echo; system/error: Wayfarer's notices.
   */
  kind: 'output' | 'input' | 'trigger' | 'script' | 'system' | 'error'
  text: string
}

/** How an agent can name a session: its world, and who is logged in. */
export interface AgentSessionInfo {
  name: string
  character: string | null
}

/** The renderer's answer to a command the bridge asked it to run. */
export interface AgentSendResult {
  ok: boolean
  error?: string
}
