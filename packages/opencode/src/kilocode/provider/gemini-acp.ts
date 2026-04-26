import {
  type LanguageModelV2,
  type LanguageModelV2CallWarning,
  type LanguageModelV2FinishReason,
  type LanguageModelV2Prompt,
  type LanguageModelV2StreamPart,
  type SharedV2ProviderMetadata,
} from "@ai-sdk/provider"
import {
  createTurnPush,
  drainStderr,
  isRecord,
  serializeMessage,
  serializePrompt,
  stringifyUnknown,
  type TurnPush,
} from "./_cli-shared"

// Persistent ACP (Agent Client Protocol) wrapper around `gemini --acp`.
// Same binary, same OAuth login as the stream-json path — only the transport
// differs. ACP gives us three things stream-json cannot:
//   - real-time agent thoughts (agent_thought_chunk session updates)
//   - server-side persistent sessions (cheap subsequent turns)
//   - structured permission requests (session/request_permission) which we
//     auto-resolve based on the configured approvalMode.

export type GeminiApprovalMode = "default" | "auto_edit" | "yolo" | "plan"

type AcpSessionConfig = {
  command: string
  cwd: string
  modelId: string
  approvalMode: GeminiApprovalMode
  extraArgs: string[]
}

type JsonRpcRequest = {
  jsonrpc: "2.0"
  id: number
  method: string
  params?: unknown
}

type JsonRpcResponse = {
  jsonrpc: "2.0"
  id: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

type JsonRpcNotification = {
  jsonrpc: "2.0"
  method: string
  params?: unknown
}

type JsonRpcInbound = {
  jsonrpc: "2.0"
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message: string; data?: unknown }
}

type AcpUsage = {
  inputTokens: number | undefined
  outputTokens: number | undefined
  totalTokens: number | undefined
  reasoningTokens: number | undefined
  cachedInputTokens: number | undefined
}

type TurnResult = {
  finish: LanguageModelV2FinishReason
  usage: AcpUsage
}

type PendingRequest = {
  resolve: (msg: JsonRpcResponse) => void
  reject: (err: unknown) => void
}

type ActiveTurn = {
  push: TurnPush
  resolve: (result: TurnResult) => void
  reject: (err: unknown) => void
  abort: AbortSignal | undefined
  onAbort: (() => void) | undefined
  lastUsage: AcpUsage
  ended: boolean
}

const IDLE_MS = 30 * 60 * 1000
const SESSIONS = new Map<string, GeminiAcpSession>()
let cleanupTimer: ReturnType<typeof setInterval> | null = null
let exitHooked = false

function ensureCleanup() {
  if (!cleanupTimer) {
    cleanupTimer = setInterval(() => {
      const now = Date.now()
      for (const [key, session] of SESSIONS) {
        if (session.dead || now - session.activity > IDLE_MS) {
          session.close()
          SESSIONS.delete(key)
        }
      }
    }, 60 * 1000)
    cleanupTimer.unref?.()
  }
  if (!exitHooked) {
    exitHooked = true
    process.on("beforeExit", () => {
      for (const session of SESSIONS.values()) session.close()
      SESSIONS.clear()
    })
  }
}

function sessionKey(kiloSessionId: string, modelId: string) {
  return `${kiloSessionId}::${modelId}`
}

function emptyUsage(): AcpUsage {
  return {
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: undefined,
    reasoningTokens: undefined,
    cachedInputTokens: undefined,
  }
}

function mapStop(stopReason: string | undefined): LanguageModelV2FinishReason {
  switch (stopReason) {
    case "end_turn":
    case "stop":
      return "stop"
    case "max_tokens":
    case "max_turn_requests":
      return "length"
    case "refusal":
      return "content-filter"
    case "cancelled":
      return "stop"
    default:
      return stopReason ? "unknown" : "stop"
  }
}

function extractUsage(meta: unknown): AcpUsage {
  if (!isRecord(meta)) return emptyUsage()
  const quota = isRecord(meta.quota) ? meta.quota : undefined
  const tokens = isRecord(quota?.token_count) ? (quota!.token_count as Record<string, unknown>) : undefined
  const input = typeof tokens?.input_tokens === "number" ? tokens.input_tokens : undefined
  const output = typeof tokens?.output_tokens === "number" ? tokens.output_tokens : undefined
  const cached = typeof tokens?.cached_content_tokens === "number" ? tokens.cached_content_tokens : undefined
  const total = input !== undefined && output !== undefined ? input + output : undefined
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    reasoningTokens: undefined,
    cachedInputTokens: cached,
  }
}

// Pick the option to send back for a permission request based on the
// configured approval mode. Server's option list comes with `kind` so we
// match by kind rather than fragile optionId strings.
function pickPermissionOption(options: unknown, mode: GeminiApprovalMode): string | undefined {
  if (!Array.isArray(options) || options.length === 0) return undefined
  type Opt = { optionId?: string; kind?: string }
  const opts = options as Opt[]
  const find = (kind: string) => opts.find((o) => o.kind === kind)?.optionId
  switch (mode) {
    case "yolo":
    case "auto_edit":
      return find("allow_always") ?? find("allow_once") ?? opts[0].optionId
    case "default":
      return find("allow_once") ?? find("allow_always") ?? opts[0].optionId
    case "plan":
      return find("reject_once") ?? find("reject_always") ?? opts[0].optionId
    default:
      return opts[0].optionId
  }
}

function serializeDelta(prompt: LanguageModelV2Prompt, sentCount: number): string {
  const slice = prompt.slice(sentCount)
  const blocks: string[] = []
  for (const message of slice) {
    if (message.role === "system" || message.role === "assistant") continue
    const chunk = serializeMessage(message)
    if (chunk) blocks.push(chunk)
  }
  return blocks.join("\n\n")
}

class GeminiAcpSession {
  private proc: ReturnType<typeof Bun.spawn> | null = null
  private encoder = new TextEncoder()
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private active: ActiveTurn | null = null
  private acpSessionId: string | undefined
  private readonly key: string
  private readonly cfg: AcpSessionConfig

  sentCount = 0
  activity = Date.now()
  dead = false
  ready = false
  startupError: string | undefined

  constructor(key: string, cfg: AcpSessionConfig) {
    this.key = key
    this.cfg = cfg
  }

  async start() {
    const args = ["--acp", ...this.cfg.extraArgs]
    this.proc = Bun.spawn([this.cfg.command, ...args], {
      cwd: this.cfg.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    })

    this.proc.exited.then((code) => {
      this.dead = true
      if (!this.ready) {
        this.startupError = this.startupError ?? `gemini --acp exited before ready (code ${code})`
      }
      this.failActiveTurn(new Error(this.startupError ?? `gemini --acp exited (code ${code})`))
      this.failPending(new Error(`gemini --acp process exited (code ${code})`))
    })

    drainStderr(this.proc.stderr as ReadableStream<Uint8Array>, (text) => {
      // gemini emits a lot of harmless workspace EACCES warnings; only treat
      // pre-ready output as a startup hint.
      if (!this.ready) this.startupError = text
    })

    this.readLoop()

    const init = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
    })
    if (init.error) throw new Error(`ACP initialize failed: ${init.error.message}`)

    const newSession = await this.request("session/new", {
      cwd: this.cfg.cwd,
      mcpServers: [],
      models: { currentModelId: this.cfg.modelId },
    })
    if (newSession.error) throw new Error(`ACP session/new failed: ${newSession.error.message}`)
    const result = isRecord(newSession.result) ? newSession.result : {}
    const sid = typeof result.sessionId === "string" ? result.sessionId : undefined
    if (!sid) throw new Error("ACP session/new returned no sessionId")
    this.acpSessionId = sid

    // Best-effort model select for servers that don't honor models in session/new.
    await this.request("session/set_model", { sessionId: sid, modelId: this.cfg.modelId }).catch(() => undefined)

    this.ready = true
  }

  private async readLoop() {
    if (!this.proc) return
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          let parsed: JsonRpcInbound
          try {
            parsed = JSON.parse(trimmed) as JsonRpcInbound
          } catch {
            continue
          }
          this.handleInbound(parsed)
        }
      }
    } catch {
      // process died mid-read
    } finally {
      this.dead = true
      this.failActiveTurn(new Error("gemini --acp connection closed"))
      this.failPending(new Error("gemini --acp connection closed"))
      try {
        reader.releaseLock()
      } catch {
        // already released
      }
    }
  }

  private handleInbound(message: JsonRpcInbound) {
    // response to a request we sent
    if (typeof message.id === "number" && (message.result !== undefined || message.error !== undefined) && !message.method) {
      const pending = this.pending.get(message.id)
      if (pending) {
        this.pending.delete(message.id)
        pending.resolve(message as JsonRpcResponse)
      }
      return
    }

    // server-initiated request (needs response)
    if (typeof message.id === "number" && typeof message.method === "string") {
      this.handleServerRequest(message.id, message.method, message.params).catch(() => undefined)
      return
    }

    // server-initiated notification
    if (typeof message.method === "string") {
      this.handleNotification(message.method, message.params)
    }
  }

  private async handleServerRequest(id: number, method: string, params: unknown) {
    let result: unknown = {}
    try {
      switch (method) {
        case "session/request_permission": {
          const p = isRecord(params) ? params : {}
          const optionId = pickPermissionOption(p.options, this.cfg.approvalMode)
          result = optionId
            ? { outcome: { outcome: "selected", optionId } }
            : { outcome: { outcome: "cancelled" } }
          break
        }
        case "fs/read_text_file": {
          const p = isRecord(params) ? params : {}
          const path = typeof p.path === "string" ? p.path : undefined
          if (!path) {
            result = { content: "" }
            break
          }
          const fs = await import("node:fs/promises")
          const content = await fs.readFile(path, "utf8")
          result = { content }
          break
        }
        case "fs/write_text_file": {
          const p = isRecord(params) ? params : {}
          const path = typeof p.path === "string" ? p.path : undefined
          const content = typeof p.content === "string" ? p.content : ""
          if (path) {
            const fs = await import("node:fs/promises")
            await fs.writeFile(path, content, "utf8")
          }
          result = null
          break
        }
        default:
          result = {}
      }
    } catch (err) {
      this.send({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: stringifyUnknown(err) },
      } as unknown as JsonRpcRequest)
      return
    }
    this.send({ jsonrpc: "2.0", id, result } as unknown as JsonRpcRequest)
  }

  private handleNotification(method: string, params: unknown) {
    if (method !== "session/update") return
    const turn = this.active
    if (!turn) return
    const p = isRecord(params) ? params : {}
    const update = isRecord(p.update) ? p.update : undefined
    if (!update) return
    const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : ""
    switch (kind) {
      case "agent_message_chunk": {
        const text = pickContentText(update.content)
        if (text) turn.push.pushText(text)
        break
      }
      case "agent_thought_chunk": {
        const text = pickContentText(update.content)
        if (text) turn.push.pushReasoning(text)
        break
      }
      case "tool_call": {
        const title = typeof update.title === "string" ? update.title : "tool"
        const id = typeof update.toolCallId === "string" ? update.toolCallId : "?"
        turn.push.pushReasoning(`[Tool ${title}] (${id})`)
        break
      }
      case "tool_call_update": {
        const status = typeof update.status === "string" ? update.status : "?"
        const title = typeof update.title === "string" ? update.title : ""
        const id = typeof update.toolCallId === "string" ? update.toolCallId : "?"
        const body = title ? ` ${title}` : ""
        turn.push.pushReasoning(`[Tool ${status}${body}] (${id})`)
        const content = Array.isArray(update.content) ? update.content : []
        for (const part of content) {
          if (!isRecord(part)) continue
          const text = pickContentText(part.content) ?? pickContentText(part)
          if (text) turn.push.pushReasoning(text)
        }
        break
      }
      case "plan": {
        // gemini sometimes emits a plan summary; surface as reasoning
        const text = stringifyUnknown(update.plan ?? update)
        if (text) turn.push.pushReasoning(text)
        break
      }
      // available_commands_update, current_mode_update, etc. — ignore
    }
  }

  private send(message: JsonRpcRequest) {
    if (!this.proc) throw new Error("gemini --acp has no process")
    const line = JSON.stringify(message) + "\n"
    const stdin = this.proc.stdin as import("bun").FileSink
    stdin.write(this.encoder.encode(line))
    stdin.flush()
  }

  private request(method: string, params: unknown, timeoutMs = 60_000): Promise<JsonRpcResponse> {
    const id = this.nextId++
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`ACP request ${method} (id=${id}) timed out`))
        }
      }, timeoutMs)
      try {
        this.send({ jsonrpc: "2.0", id, method, params })
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err)
      }
    })
  }

  private failPending(err: Error) {
    for (const [, p] of this.pending) p.reject(err)
    this.pending.clear()
  }

  private failActiveTurn(err: Error) {
    const turn = this.active
    if (!turn || turn.ended) return
    turn.ended = true
    turn.abort?.removeEventListener("abort", turn.onAbort!)
    this.active = null
    turn.reject(err)
  }

  async prompt(content: string, push: TurnPush, abort: AbortSignal | undefined): Promise<TurnResult> {
    if (!this.acpSessionId) throw new Error("ACP session not initialized")
    if (this.active) throw new Error("ACP session busy with another turn")

    this.activity = Date.now()
    const sid = this.acpSessionId

    return new Promise<TurnResult>((resolve, reject) => {
      const turn: ActiveTurn = {
        push,
        resolve,
        reject,
        abort,
        onAbort: undefined,
        lastUsage: emptyUsage(),
        ended: false,
      }
      const onAbort = () => {
        if (turn.ended) return
        // best-effort cancel; the session/prompt promise will resolve with stop_reason=cancelled
        try {
          this.send({
            jsonrpc: "2.0",
            id: this.nextId++,
            method: "session/cancel",
            params: { sessionId: sid },
          })
        } catch {
          // session may already be torn down
        }
      }
      turn.onAbort = onAbort
      if (abort) abort.addEventListener("abort", onAbort, { once: true })
      this.active = turn

      const settle = (result: TurnResult) => {
        if (turn.ended) return
        turn.ended = true
        abort?.removeEventListener("abort", onAbort)
        if (this.active === turn) this.active = null
        this.activity = Date.now()
        resolve(result)
      }
      const fail = (err: unknown) => {
        if (turn.ended) return
        turn.ended = true
        abort?.removeEventListener("abort", onAbort)
        if (this.active === turn) this.active = null
        reject(err)
      }

      this.request(
        "session/prompt",
        {
          sessionId: sid,
          prompt: [{ type: "text", text: content }],
        },
        10 * 60_000,
      )
        .then((response) => {
          if (response.error) {
            fail(new Error(`ACP session/prompt error: ${response.error.message}`))
            return
          }
          const result = isRecord(response.result) ? response.result : {}
          const stop = typeof result.stopReason === "string" ? result.stopReason : undefined
          const usage = extractUsage(result._meta)
          settle({ finish: mapStop(stop), usage })
        })
        .catch(fail)
    })
  }

  close() {
    if (!this.proc) return
    try {
      ;(this.proc.stdin as import("bun").FileSink).end()
    } catch {
      // already closed
    }
    try {
      this.proc.kill()
    } catch {
      // already dead
    }
    this.proc = null
    this.dead = true
    this.ready = false
  }
}

function pickContentText(content: unknown): string | undefined {
  if (typeof content === "string") return content
  if (!isRecord(content)) return undefined
  if (typeof content.text === "string") return content.text
  if (Array.isArray(content.content)) {
    const parts = content.content
      .map((c) => pickContentText(c))
      .filter((s): s is string => typeof s === "string" && s.length > 0)
    if (parts.length) return parts.join("")
  }
  return undefined
}

async function getSession(kiloSessionId: string, cfg: AcpSessionConfig): Promise<GeminiAcpSession> {
  ensureCleanup()
  const key = sessionKey(kiloSessionId, cfg.modelId)
  const existing = SESSIONS.get(key)
  if (existing && !existing.dead) return existing

  // model switch within same Kilo session: close any stale session for this kiloSessionId
  for (const [k, s] of SESSIONS) {
    if (k.startsWith(`${kiloSessionId}::`)) {
      s.close()
      SESSIONS.delete(k)
    }
  }

  const session = new GeminiAcpSession(key, cfg)
  SESSIONS.set(key, session)
  try {
    await session.start()
  } catch (err) {
    SESSIONS.delete(key)
    session.close()
    throw err
  }
  return session
}

export type RunAcpStreamArgs = {
  options: Parameters<LanguageModelV2["doStream"]>[0]
  kiloSessionId: string
  command: string
  modelId: string
  approvalMode: GeminiApprovalMode
  extraArgs: string[]
  metaKey: string
}

export async function runAcpStream(
  args: RunAcpStreamArgs,
): Promise<Awaited<ReturnType<LanguageModelV2["doStream"]>>> {
  const warnings: LanguageModelV2CallWarning[] = []
  const meta: SharedV2ProviderMetadata = { [args.metaKey]: {} }

  const cfg: AcpSessionConfig = {
    command: args.command,
    cwd: process.cwd(),
    modelId: args.modelId,
    approvalMode: args.approvalMode,
    extraArgs: args.extraArgs,
  }

  const session = await getSession(args.kiloSessionId, cfg).catch((err: unknown) => {
    throw err instanceof Error ? err : new Error(stringifyUnknown(err))
  })

  // history truncation (retry/edit) — reset session view so next turn resends full context
  if (args.options.prompt.length < session.sentCount) {
    session.sentCount = 0
  }

  const isFirst = session.sentCount === 0
  const content = isFirst
    ? serializePrompt(args.options.prompt)
    : serializeDelta(args.options.prompt, session.sentCount)
  const sendable = content.trim().length > 0 ? content : "(continue)"

  const body = {
    transport: "acp",
    sessionId: args.kiloSessionId,
    sentCount: session.sentCount,
    bytes: sendable.length,
  }

  const stream = new ReadableStream<LanguageModelV2StreamPart>({
    start: (controller) => {
      controller.enqueue({ type: "stream-start", warnings })

      const push = createTurnPush(controller)

      session
        .prompt(sendable, push, args.options.abortSignal)
        .then((result) => {
          push.closeText()
          push.closeReasoning()
          session.sentCount = args.options.prompt.length
          controller.enqueue({
            type: "finish",
            finishReason: result.finish,
            usage: result.usage,
            providerMetadata: meta,
          })
          controller.close()
        })
        .catch((err: unknown) => {
          push.closeText()
          push.closeReasoning()
          controller.enqueue({
            type: "error",
            error: err instanceof Error ? err : new Error(stringifyUnknown(err)),
          })
          controller.close()
        })
    },
    cancel: () => {
      // Kilo cancelled the stream — abort signal will fire and trigger session/cancel
    },
  })

  return {
    stream,
    request: { body },
    response: { headers: {} },
  }
}
