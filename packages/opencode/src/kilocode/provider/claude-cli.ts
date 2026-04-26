import {
  type LanguageModelV2,
  type LanguageModelV2CallWarning,
  type LanguageModelV2Content,
  type LanguageModelV2FinishReason,
  type LanguageModelV2Prompt,
  type LanguageModelV2StreamPart,
  type SharedV2ProviderMetadata,
} from "@ai-sdk/provider"
import {
  createTurnPush,
  drainStderr,
  isRecord,
  readNdjson,
  serializeMessage,
  serializePrompt,
  stringifyUnknown,
  stripFlags,
  type TurnPush,
} from "./_cli-shared"

// LanguageModelV2 wrapper around the local `claude` CLI.
//
// Two modes:
//   1) Persistent session (v2) — when the call carries an x-kilo-session
//      header, one long-lived `claude --input-format stream-json` process
//      is kept per (sessionID, modelID). First turn sends the full
//      flattened context. Subsequent turns send ONLY the new user (and
//      tool) messages so Claude's own prompt cache does the heavy lifting.
//   2) Stateless fallback (v1) — when no sessionID header is present,
//      spawn a fresh `claude -p <prompt>` per call.
//
// In both modes we surface text + thinking, fold CLI-internal tool_use
// and tool_result into reasoning, and never execute them as Kilo tools.

export interface ClaudeCliProviderSettings {
  name?: string
  command?: string
  permissionMode?: string
  extraArgs?: string[]
  persistent?: boolean
}

export interface ClaudeCliProvider {
  (modelId: string): LanguageModelV2
  languageModel(modelId: string): LanguageModelV2
  textEmbeddingModel(modelId: string): never
  imageModel(modelId: string): never
}

type ClaudeUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

type ClaudeBlock =
  | { type: "text"; text?: string }
  | { type: "thinking"; thinking?: string; text?: string }
  | { type: "tool_use"; id?: string; name?: string; input?: unknown }
  | { type: "tool_result"; tool_use_id?: string; content?: unknown; is_error?: boolean }
  | { type: string; [key: string]: unknown }

type ClaudeEvent =
  | { type: "system"; subtype?: string; [key: string]: unknown }
  | { type: "assistant"; message?: { id?: string; content?: ClaudeBlock[]; usage?: ClaudeUsage } }
  | { type: "user"; message?: { content?: ClaudeBlock[] | string } }
  | { type: "result"; subtype?: string; usage?: ClaudeUsage; result?: string; is_error?: boolean }
  | { type: string; [key: string]: unknown }

type TurnResult = {
  finish: LanguageModelV2FinishReason
  usage: ReturnType<typeof mapUsage>
}

function serializeDelta(prompt: LanguageModelV2Prompt, sentCount: number): string {
  const slice = prompt.slice(sentCount)
  const blocks: string[] = []
  for (const message of slice) {
    // skip system (stable across turns) and assistant (Claude remembers its own output)
    if (message.role === "system" || message.role === "assistant") continue
    const chunk = serializeMessage(message)
    if (chunk) blocks.push(chunk)
  }
  return blocks.join("\n\n")
}

function mapFinish(subtype: string | undefined, isError: boolean | undefined): LanguageModelV2FinishReason {
  if (isError) return "error"
  switch (subtype) {
    case undefined:
    case "success":
      return "stop"
    case "error_max_turns":
      return "length"
    case "error_during_execution":
      return "error"
    default:
      return "unknown"
  }
}

function mapUsage(usage: ClaudeUsage | undefined) {
  const input = usage?.input_tokens
  const output = usage?.output_tokens
  const cache = usage?.cache_read_input_tokens
  const total = input !== undefined && output !== undefined ? input + output : undefined
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    reasoningTokens: undefined as number | undefined,
    cachedInputTokens: cache,
  }
}

function formatToolUse(block: ClaudeBlock): string {
  if (block.type !== "tool_use") return ""
  const name = typeof block.name === "string" ? block.name : "unknown"
  const input = block.input !== undefined ? stringifyUnknown(block.input) : ""
  const suffix = input ? ` ${input}` : ""
  return `[Tool ${name}]${suffix}`
}

function formatToolResult(block: ClaudeBlock): string {
  if (block.type !== "tool_result") return ""
  const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "?"
  const body = block.content !== undefined ? stringifyUnknown(block.content) : ""
  const prefix = block.is_error ? "Tool error" : "Tool result"
  return body ? `[${prefix} ${id}]\n${body}` : `[${prefix} ${id}]`
}

function handleAssistantBlocks(blocks: ClaudeBlock[] | undefined, push: TurnPush) {
  if (!blocks) return
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        if (typeof block.text === "string") push.pushText(block.text)
        break
      case "thinking": {
        const thought = typeof block.thinking === "string" ? block.thinking : block.text
        if (typeof thought === "string") push.pushReasoning(thought)
        break
      }
      case "tool_use": {
        const formatted = formatToolUse(block)
        if (formatted) push.pushReasoning(formatted)
        break
      }
      case "tool_result": {
        const formatted = formatToolResult(block)
        if (formatted) push.pushReasoning(formatted)
        break
      }
    }
  }
}

function handleUserBlocks(content: ClaudeBlock[] | string | undefined, push: TurnPush) {
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (block.type !== "tool_result") continue
    const formatted = formatToolResult(block)
    if (formatted) push.pushReasoning(formatted)
  }
}

// ---------------------------------------------------------------------------
// Persistent session manager
// ---------------------------------------------------------------------------

type SessionConfig = {
  command: string
  modelId: string
  permissionMode: string
  extraArgs: string[]
}

const IDLE_MS = 30 * 60 * 1000
const SESSIONS = new Map<string, ClaudeSession>()
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

function sessionKey(sessionId: string, modelId: string) {
  return `${sessionId}::${modelId}`
}

class ClaudeSession {
  private proc: ReturnType<typeof Bun.spawn> | null = null
  private encoder = new TextEncoder()
  private pending: ((event: ClaudeEvent) => void) | null = null
  private readonly key: string
  private readonly cfg: SessionConfig
  sentCount = 0
  activity = Date.now()
  dead = false
  ready = false
  startupError: string | undefined

  constructor(key: string, cfg: SessionConfig) {
    this.key = key
    this.cfg = cfg
  }

  async start() {
    const args = [
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      this.cfg.modelId,
      "--permission-mode",
      this.cfg.permissionMode,
      ...this.cfg.extraArgs,
    ]
    this.proc = Bun.spawn([this.cfg.command, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
      env: { ...process.env, CLAUDE_CODE_DISABLE_IDE: "1" },
    })

    this.proc.exited.then((code) => {
      this.dead = true
      if (!this.ready) {
        this.startupError = this.startupError ?? `claude CLI exited before ready (code ${code})`
      }
      if (this.pending) {
        this.pending({ type: "result", subtype: "error_during_execution", is_error: true })
        this.pending = null
      }
    })

    drainStderr(this.proc.stderr as ReadableStream<Uint8Array>, (text) => {
      if (!this.ready) this.startupError = text
    })
    this.readLoop()
    await this.waitReady()
  }

  private async readLoop() {
    if (!this.proc) return
    try {
      await readNdjson<ClaudeEvent>(
        this.proc.stdout as ReadableStream<Uint8Array>,
        (event) => this.dispatch(event),
        { onParseError: () => "skip" },
      )
    } catch {
      // process died mid-read
    } finally {
      this.dead = true
      if (this.pending) {
        this.pending({ type: "result", subtype: "error_during_execution", is_error: true })
        this.pending = null
      }
    }
  }

  private dispatch(event: ClaudeEvent) {
    if (event.type === "system" && "subtype" in event && event.subtype === "init") {
      this.ready = true
      return
    }
    if (this.pending) this.pending(event)
  }

  private async waitReady(timeoutMs = 30_000) {
    const start = Date.now()
    while (!this.ready && !this.dead && Date.now() - start < timeoutMs) {
      await Bun.sleep(25)
    }
    if (this.ready) return
    if (this.startupError) throw new Error(`claude CLI failed to start: ${this.startupError}`)
    if (this.dead) throw new Error("claude CLI exited before emitting init event")
    throw new Error("claude CLI did not become ready in time")
  }

  private writeLine(payload: object) {
    if (!this.proc) throw new Error("claude session has no process")
    const line = JSON.stringify(payload) + "\n"
    const stdin = this.proc.stdin as import("bun").FileSink
    stdin.write(this.encoder.encode(line))
    stdin.flush()
  }

  async turn(
    content: string,
    push: TurnPush,
    abort: AbortSignal | undefined,
  ): Promise<TurnResult> {
    this.activity = Date.now()
    if (!this.ready) await this.waitReady()

    return new Promise<TurnResult>((resolve) => {
      let lastUsage: ClaudeUsage | undefined
      let interrupted = false

      const finalize = (result: TurnResult) => {
        this.pending = null
        abort?.removeEventListener("abort", onAbort)
        this.activity = Date.now()
        resolve(result)
      }

      const onAbort = () => {
        interrupted = true
        try {
          this.proc?.kill("SIGINT")
        } catch {
          // best-effort; next turn will rebuild if process dies
        }
      }

      this.pending = (event) => {
        switch (event.type) {
          case "assistant": {
            const message = isRecord(event.message) ? event.message : undefined
            handleAssistantBlocks(message?.content as ClaudeBlock[] | undefined, push)
            const usage = (message?.usage ?? undefined) as ClaudeUsage | undefined
            if (usage) lastUsage = usage
            return
          }
          case "user": {
            const message = isRecord(event.message) ? event.message : undefined
            handleUserBlocks(message?.content as ClaudeBlock[] | string | undefined, push)
            return
          }
          case "result": {
            const result = event as Extract<ClaudeEvent, { type: "result" }>
            const finish = interrupted
              ? "stop"
              : mapFinish(result.subtype, result.is_error)
            const usage = mapUsage(result.usage ?? lastUsage)
            finalize({ finish, usage })
            return
          }
        }
      }

      if (abort) abort.addEventListener("abort", onAbort, { once: true })

      try {
        this.writeLine({ type: "user", message: { role: "user", content } })
      } catch (err) {
        this.dead = true
        finalize({
          finish: "error",
          usage: mapUsage(undefined),
        })
      }
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

async function getSession(sessionId: string, cfg: SessionConfig): Promise<ClaudeSession> {
  ensureCleanup()
  const key = sessionKey(sessionId, cfg.modelId)
  const existing = SESSIONS.get(key)
  if (existing && !existing.dead) return existing

  // model switch within same Kilo session: close any stale session for this sessionId
  for (const [k, s] of SESSIONS) {
    if (k.startsWith(`${sessionId}::`)) {
      s.close()
      SESSIONS.delete(k)
    }
  }

  const session = new ClaudeSession(key, cfg)
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

// ---------------------------------------------------------------------------
// LanguageModelV2
// ---------------------------------------------------------------------------

class ClaudeCliLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = "v2"
  readonly supportsStructuredOutputs = false

  constructor(
    readonly modelId: string,
    private readonly providerName: string,
    private readonly command: string,
    private readonly permissionMode: string,
    private readonly extraArgs: string[],
    private readonly persistent: boolean,
  ) {}

  get provider(): string {
    return `${this.providerName}.chat`
  }

  get supportedUrls() {
    return {}
  }

  private get metaKey() {
    return this.providerName.split(".")[0].trim()
  }

  async doGenerate(
    options: Parameters<LanguageModelV2["doGenerate"]>[0],
  ): Promise<Awaited<ReturnType<LanguageModelV2["doGenerate"]>>> {
    const streamed = await this.doStream(options)
    const reader = streamed.stream.getReader()

    const content: LanguageModelV2Content[] = []
    let text = ""
    let reasoning = ""
    let finish: LanguageModelV2FinishReason = "unknown"
    let meta: SharedV2ProviderMetadata = { [this.metaKey]: {} }
    let usage: Awaited<ReturnType<LanguageModelV2["doGenerate"]>>["usage"] = {
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
      reasoningTokens: undefined,
      cachedInputTokens: undefined,
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      switch (value.type) {
        case "text-delta":
          text += value.delta
          break
        case "text-end":
          if (text) {
            content.push({ type: "text", text })
            text = ""
          }
          break
        case "reasoning-delta":
          reasoning += value.delta
          break
        case "reasoning-end":
          if (reasoning) {
            content.push({ type: "reasoning", text: reasoning })
            reasoning = ""
          }
          break
        case "finish":
          finish = value.finishReason
          usage = value.usage
          meta = value.providerMetadata ?? meta
          break
        case "error":
          throw value.error
      }
    }

    if (text) content.push({ type: "text", text })
    if (reasoning) content.push({ type: "reasoning", text: reasoning })

    return {
      content,
      finishReason: finish,
      usage,
      providerMetadata: meta,
      request: streamed.request,
      response: streamed.response,
      warnings: [],
    }
  }

  async doStream(
    options: Parameters<LanguageModelV2["doStream"]>[0],
  ): Promise<Awaited<ReturnType<LanguageModelV2["doStream"]>>> {
    const sessionId = readSessionId(options.headers)
    if (this.persistent && sessionId) {
      return this.doStreamPersistent(options, sessionId)
    }
    return this.doStreamStateless(options)
  }

  private async doStreamPersistent(
    options: Parameters<LanguageModelV2["doStream"]>[0],
    sessionId: string,
  ): Promise<Awaited<ReturnType<LanguageModelV2["doStream"]>>> {
    const warnings: LanguageModelV2CallWarning[] = []
    const meta: SharedV2ProviderMetadata = { [this.metaKey]: {} }

    const cfg: SessionConfig = {
      command: this.command,
      modelId: this.modelId,
      permissionMode: this.permissionMode,
      extraArgs: this.extraArgs,
    }

    const session = await getSession(sessionId, cfg).catch((err: unknown) => {
      throw err instanceof Error ? err : new Error(stringifyUnknown(err))
    })

    // if Kilo truncated history (retry, edit), reset session view
    if (options.prompt.length < session.sentCount) {
      session.sentCount = 0
    }

    const isFirst = session.sentCount === 0
    const content = isFirst
      ? serializePrompt(options.prompt)
      : serializeDelta(options.prompt, session.sentCount)
    const sendable = content.trim().length > 0 ? content : "(continue)"

    const body = { sessionId, sentCount: session.sentCount, bytes: sendable.length }

    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      start: (controller) => {
        controller.enqueue({ type: "stream-start", warnings })

        const push = createTurnPush(controller)

        session
          .turn(sendable, push, options.abortSignal)
          .then((result) => {
            push.closeText()
            push.closeReasoning()
            session.sentCount = options.prompt.length
            controller.enqueue({
              type: "finish",
              finishReason: result.finish,
              usage: result.usage,
              providerMetadata: meta,
            })
            controller.close()
          })
          .catch((err: unknown) => {
            controller.enqueue({
              type: "error",
              error: err instanceof Error ? err : new Error(stringifyUnknown(err)),
            })
            controller.close()
          })
      },
      cancel: () => {
        // Kilo cancelled the stream — let the session's abort path handle the subprocess
      },
    })

    return {
      stream,
      request: { body },
      response: { headers: {} },
    }
  }

  private async doStreamStateless(
    options: Parameters<LanguageModelV2["doStream"]>[0],
  ): Promise<Awaited<ReturnType<LanguageModelV2["doStream"]>>> {
    const warnings: LanguageModelV2CallWarning[] = []
    const meta: SharedV2ProviderMetadata = { [this.metaKey]: {} }

    const prompt = serializePrompt(options.prompt)
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      this.modelId,
      "--permission-mode",
      this.permissionMode,
      ...stripFlags(this.extraArgs, [
        "-p",
        "--print",
        "--model",
        "--permission-mode",
        "--output-format",
        "--input-format",
        "--verbose",
      ]),
    ]
    const body = { command: this.command, args }

    const proc = Bun.spawn([this.command, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env, CLAUDE_CODE_DISABLE_IDE: "1" },
    })

    let aborted = false
    const onAbort = () => {
      aborted = true
      proc.kill()
    }
    options.abortSignal?.addEventListener("abort", onAbort, { once: true })

    let finish: LanguageModelV2FinishReason = "unknown"
    let usage = mapUsage(undefined)
    let sawError = false
    let lastUsage: ClaudeUsage | undefined

    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      start: (controller) => {
        controller.enqueue({ type: "stream-start", warnings })

        const push = createTurnPush(controller)

        const handleEvent = (event: ClaudeEvent, raw: string) => {
          if (options.includeRawChunks) {
            controller.enqueue({ type: "raw", rawValue: raw })
          }
          switch (event.type) {
            case "system":
              return
            case "assistant": {
              const message = isRecord(event.message) ? event.message : undefined
              handleAssistantBlocks(message?.content as ClaudeBlock[] | undefined, push)
              const u = (message?.usage ?? undefined) as ClaudeUsage | undefined
              if (u) lastUsage = u
              return
            }
            case "user": {
              const message = isRecord(event.message) ? event.message : undefined
              handleUserBlocks(message?.content as ClaudeBlock[] | string | undefined, push)
              return
            }
            case "result": {
              const r = event as Extract<ClaudeEvent, { type: "result" }>
              finish = mapFinish(r.subtype, r.is_error)
              usage = mapUsage(r.usage ?? lastUsage)
              return
            }
          }
        }

        let stderrText = ""
        drainStderr(proc.stderr as ReadableStream<Uint8Array>, (text) => {
          stderrText = stderrText ? `${stderrText}\n${text}` : text
        })

        ;(async () => {
          try {
            await readNdjson<ClaudeEvent>(
              proc.stdout as ReadableStream<Uint8Array>,
              (event, raw) => handleEvent(event, raw),
              { flushTail: true },
            )
          } catch (err) {
            if (!aborted) {
              sawError = true
              controller.enqueue({
                type: "error",
                error: new Error(`Invalid claude stream event: ${stringifyUnknown(err)}`),
              })
            }
          }

          const code = await proc.exited
          options.abortSignal?.removeEventListener("abort", onAbort)

          push.closeText()
          push.closeReasoning()

          if (aborted) {
            controller.close()
            return
          }
          if (!sawError && code !== 0) {
            const detail = stderrText.trim() || `${this.command} exited with code ${code}`
            controller.enqueue({ type: "error", error: new Error(detail) })
            controller.close()
            return
          }
          if (!sawError) {
            controller.enqueue({
              type: "finish",
              finishReason: finish,
              usage,
              providerMetadata: meta,
            })
          }
          controller.close()
        })().catch((err) => {
          controller.enqueue({
            type: "error",
            error: err instanceof Error ? err : new Error(stringifyUnknown(err)),
          })
          controller.close()
        })
      },
      cancel: () => {
        aborted = true
        proc.kill()
      },
    })

    return {
      stream,
      request: { body },
      response: { headers: {} },
    }
  }
}

function readSessionId(headers: Record<string, string | undefined> | undefined): string | undefined {
  if (!headers) return undefined
  const value = headers["x-kilo-session"] ?? headers["X-Kilo-Session"]
  if (typeof value !== "string" || !value) return undefined
  return value
}

export function createClaudeCli(options: ClaudeCliProviderSettings = {}): ClaudeCliProvider {
  const name = options.name ?? "claude-cli"
  const command = options.command ?? "claude"
  const mode = options.permissionMode ?? "bypassPermissions"
  const extra = options.extraArgs ?? []
  const persistent = options.persistent ?? true

  const create = (modelId: string) => new ClaudeCliLanguageModel(modelId, name, command, mode, extra, persistent)

  const provider = function (modelId: string) {
    return create(modelId)
  }

  provider.languageModel = create
  provider.textEmbeddingModel = (modelId: string) => {
    throw new Error(`Claude CLI provider does not support embedding models: ${modelId}`)
  }
  provider.imageModel = (modelId: string) => {
    throw new Error(`Claude CLI provider does not support image models: ${modelId}`)
  }

  return provider as ClaudeCliProvider
}
