import {
  type LanguageModelV2,
  type LanguageModelV2CallWarning,
  type LanguageModelV2Content,
  type LanguageModelV2FinishReason,
  type LanguageModelV2StreamPart,
  type SharedV2ProviderMetadata,
} from "@ai-sdk/provider"
import {
  createTurnPush,
  drainStderr,
  isRecord,
  readNdjson,
  serializePrompt,
  stringifyUnknown,
  stripFlags,
} from "./_cli-shared"
import { runAcpStream, type GeminiApprovalMode } from "./gemini-acp"

// LanguageModelV2 wrapper around the local `gemini` CLI.
//
// Two transports:
//   1) ACP (Agent Client Protocol over stdio, default) — when the call
//      carries an x-kilo-session header, one long-lived `gemini --acp`
//      process is kept per (sessionID, modelID). Surfaces real-time
//      thoughts (agent_thought_chunk), benefits from server-side session
//      memory, and exposes structured permission requests.
//   2) stream-json fallback — when no sessionID header is present (or
//      when transport is explicitly set to "stream-json"), spawn a fresh
//      `gemini -p ... --output-format stream-json` per call.
//
// Auth is whatever the local `gemini` binary uses; the spawned process
// inherits the parent env so any OAuth credentials configured for the
// user's gemini CLI work transparently.

export type { GeminiApprovalMode } from "./gemini-acp"

export type GeminiTransport = "acp" | "stream-json"

export interface GeminiCliProviderSettings {
  name?: string
  command?: string
  extraArgs?: string[]
  approvalMode?: GeminiApprovalMode
  transport?: GeminiTransport
}

export interface GeminiCliProvider {
  (modelId: string): LanguageModelV2
  languageModel(modelId: string): LanguageModelV2
  textEmbeddingModel(modelId: string): never
  imageModel(modelId: string): never
}

type GeminiStats = {
  total_tokens?: number
  input_tokens?: number
  output_tokens?: number
  cached?: number
  duration_ms?: number
  tool_calls?: number
}

type GeminiThought = {
  subject?: string
  description?: string
}

type GeminiToolCall = {
  name?: string
  arguments?: unknown
  args?: unknown
  input?: unknown
}

type GeminiToolResult = {
  name?: string
  output?: unknown
  result?: unknown
  is_error?: boolean
}

type GeminiMessage = {
  role?: "user" | "assistant" | "system"
  content?: string
  delta?: boolean
  thought?: GeminiThought | string
  tool_call?: GeminiToolCall
  tool_calls?: GeminiToolCall[]
  function_call?: GeminiToolCall
  tool_result?: GeminiToolResult
  function_response?: GeminiToolResult
}

type GeminiEvent =
  | { type: "init"; session_id?: string; model?: string; timestamp?: string }
  | ({ type: "message" } & GeminiMessage & { timestamp?: string })
  | { type: "result"; status?: string; stats?: GeminiStats; timestamp?: string; error?: unknown }
  | { type: "error"; error?: unknown; message?: string }
  | { type: "thought"; value?: GeminiThought }
  | { type: "tool_call"; value?: GeminiToolCall }
  | { type: "tool_result"; value?: GeminiToolResult }
  | { type: string; [key: string]: unknown }

function formatThought(value: GeminiThought | undefined) {
  if (!value) return ""
  const subject = value.subject?.trim()
  const description = value.description?.trim()
  if (subject && description) return `**${subject}** ${description}`
  if (subject) return `**${subject}**`
  return description ?? ""
}

function formatToolCall(call: GeminiToolCall | undefined) {
  if (!call) return ""
  const name = typeof call.name === "string" ? call.name : "unknown"
  const args = call.arguments ?? call.args ?? call.input
  const argText = args !== undefined ? stringifyUnknown(args) : ""
  return argText ? `[Tool ${name}] ${argText}` : `[Tool ${name}]`
}

function formatToolResult(result: GeminiToolResult | undefined) {
  if (!result) return ""
  const name = typeof result.name === "string" ? result.name : "?"
  const body = result.output ?? result.result
  const text = body !== undefined ? stringifyUnknown(body) : ""
  const prefix = result.is_error ? "Tool error" : "Tool result"
  return text ? `[${prefix} ${name}]\n${text}` : `[${prefix} ${name}]`
}

function mapFinish(status: string | undefined): LanguageModelV2FinishReason {
  switch (status?.toLowerCase()) {
    case undefined:
    case "success":
    case "ok":
    case "stop":
      return "stop"
    case "max_tokens":
    case "length":
      return "length"
    case "safety":
    case "content_filter":
    case "blocked":
      return "content-filter"
    case "error":
    case "failure":
      return "error"
    default:
      return "unknown"
  }
}

function mapUsage(stats: GeminiStats | undefined) {
  return {
    inputTokens: stats?.input_tokens,
    outputTokens: stats?.output_tokens,
    totalTokens: stats?.total_tokens,
    reasoningTokens: undefined as number | undefined,
    cachedInputTokens: stats?.cached,
  }
}

class GeminiCliLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = "v2"
  readonly supportsStructuredOutputs = false

  constructor(
    readonly modelId: string,
    private readonly providerName: string,
    private readonly command: string,
    private readonly extraArgs: string[],
    private readonly approvalMode: GeminiApprovalMode,
    private readonly transport: GeminiTransport,
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
    let finish: LanguageModelV2FinishReason = "stop"
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
    if (this.transport === "acp" && sessionId) {
      return runAcpStream({
        options,
        kiloSessionId: sessionId,
        command: this.command,
        modelId: this.modelId,
        approvalMode: this.approvalMode,
        extraArgs: this.extraArgs,
        metaKey: this.metaKey,
      })
    }

    const warnings: LanguageModelV2CallWarning[] = []
    const meta: SharedV2ProviderMetadata = { [this.metaKey]: {} }

    const prompt = serializePrompt(options.prompt)
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "-m",
      this.modelId,
      "--approval-mode",
      this.approvalMode,
      ...stripFlags(this.extraArgs, [
        "-p",
        "--prompt",
        "-m",
        "--model",
        "--output-format",
        "--approval-mode",
        "-y",
        "--yolo",
      ]),
    ]
    const body = { command: this.command, args }

    const proc = Bun.spawn([this.command, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    })

    let aborted = false
    const onAbort = () => {
      aborted = true
      proc.kill()
    }
    options.abortSignal?.addEventListener("abort", onAbort, { once: true })

    // Default to "stop" so a clean exit without an explicit `result` event
    // doesn't leave us reporting `unknown`. Real result events overwrite this.
    let finish: LanguageModelV2FinishReason = "stop"
    let usage = mapUsage(undefined)
    let sawError = false

    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      start: (controller) => {
        controller.enqueue({ type: "stream-start", warnings })

        const push = createTurnPush(controller)

        const handleMessage = (msg: GeminiMessage) => {
          if (msg.role && msg.role !== "assistant") return
          if (msg.delta === false) return

          if (isRecord(msg.thought) || typeof msg.thought === "string") {
            const thought = typeof msg.thought === "string" ? msg.thought : formatThought(msg.thought)
            if (thought) push.pushReasoning(thought)
          }

          // Fold any tool activity into the reasoning channel so the user
          // can see what the gemini CLI is doing internally — Kilo never
          // executes these tools itself.
          const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
          if (msg.tool_call) toolCalls.push(msg.tool_call)
          if (msg.function_call) toolCalls.push(msg.function_call)
          for (const call of toolCalls) {
            const text = formatToolCall(call)
            if (text) push.pushReasoning(text)
          }

          const toolResult = msg.tool_result ?? msg.function_response
          if (toolResult) {
            const text = formatToolResult(toolResult)
            if (text) push.pushReasoning(text)
          }

          if (typeof msg.content === "string") push.pushText(msg.content)
        }

        const handleEvent = (event: GeminiEvent, raw: string) => {
          if (options.includeRawChunks) {
            controller.enqueue({ type: "raw", rawValue: raw })
          }

          switch (event.type) {
            case "init":
              return
            case "message":
              handleMessage(event as GeminiMessage)
              return
            case "thought": {
              const thought = formatThought(isRecord(event.value) ? (event.value as GeminiThought) : undefined)
              if (thought) push.pushReasoning(thought)
              return
            }
            case "tool_call": {
              const text = formatToolCall(isRecord(event.value) ? (event.value as GeminiToolCall) : undefined)
              if (text) push.pushReasoning(text)
              return
            }
            case "tool_result": {
              const text = formatToolResult(isRecord(event.value) ? (event.value as GeminiToolResult) : undefined)
              if (text) push.pushReasoning(text)
              return
            }
            case "result": {
              const result = event as Extract<GeminiEvent, { type: "result" }>
              finish = mapFinish(result.status)
              usage = mapUsage(result.stats)
              if (result.error) {
                sawError = true
                controller.enqueue({
                  type: "error",
                  error: new Error(stringifyUnknown(result.error)),
                })
              }
              return
            }
            case "error": {
              sawError = true
              const err = event as { error?: unknown; message?: unknown }
              controller.enqueue({
                type: "error",
                error: new Error(stringifyUnknown(err.error ?? err.message)),
              })
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
            await readNdjson<GeminiEvent>(
              proc.stdout as ReadableStream<Uint8Array>,
              (event, raw) => handleEvent(event, raw),
              { flushTail: true },
            )
          } catch (err) {
            if (!aborted) {
              sawError = true
              controller.enqueue({
                type: "error",
                error: new Error(`Invalid gemini stream event: ${stringifyUnknown(err)}`),
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
            controller.enqueue({
              type: "error",
              error: new Error(detail),
            })
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

export function createGeminiCli(options: GeminiCliProviderSettings = {}): GeminiCliProvider {
  const name = options.name ?? "gemini-cli"
  const command = options.command ?? "gemini"
  const extra = options.extraArgs ?? []
  // Default to `yolo` so the spawned subprocess never blocks waiting on stdin
  // for an approval prompt — Kilo handles user-facing permissions upstream.
  const approval = options.approvalMode ?? "yolo"
  const transport: GeminiTransport = options.transport ?? "acp"

  const create = (modelId: string) =>
    new GeminiCliLanguageModel(modelId, name, command, extra, approval, transport)

  const provider = function (modelId: string) {
    return create(modelId)
  }

  provider.languageModel = create
  provider.textEmbeddingModel = (modelId: string) => {
    throw new Error(`Gemini CLI provider does not support embedding models: ${modelId}`)
  }
  provider.imageModel = (modelId: string) => {
    throw new Error(`Gemini CLI provider does not support image models: ${modelId}`)
  }

  return provider as GeminiCliProvider
}
