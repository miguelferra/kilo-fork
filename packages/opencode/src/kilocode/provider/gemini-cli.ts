import {
  type LanguageModelV2,
  type LanguageModelV2CallWarning,
  type LanguageModelV2Content,
  type LanguageModelV2FinishReason,
  type LanguageModelV2Prompt,
  type LanguageModelV2StreamPart,
  type SharedV2ProviderMetadata,
} from "@ai-sdk/provider"

// Stateless LanguageModelV2 wrapper around the `gemini` CLI.
//
// v1 design: spawn fresh per request, surface text + thought summaries,
// map finish reasons and usage. Auth is whatever the local `gemini` binary uses.

export interface GeminiCliProviderSettings {
  name?: string
  command?: string
  extraArgs?: string[]
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

type GeminiMessage = {
  role?: "user" | "assistant" | "system"
  content?: string
  delta?: boolean
  thought?: GeminiThought | string
}

type GeminiEvent =
  | { type: "init"; session_id?: string; model?: string; timestamp?: string }
  | ({ type: "message" } & GeminiMessage & { timestamp?: string })
  | { type: "result"; status?: string; stats?: GeminiStats; timestamp?: string; error?: unknown }
  | { type: "error"; error?: unknown; message?: string }
  | { type: "thought"; value?: GeminiThought }
  | { type: string; [key: string]: unknown }

function stringifyUnknown(input: unknown): string {
  if (typeof input === "string") return input
  if (input instanceof Error) return input.message
  if (input && typeof input === "object" && "message" in input && typeof input.message === "string") {
    return input.message
  }
  try {
    return JSON.stringify(input)
  } catch {
    return String(input)
  }
}

function formatThought(value: GeminiThought | undefined) {
  if (!value) return ""
  const subject = value.subject?.trim()
  const description = value.description?.trim()
  if (subject && description) return `**${subject}** ${description}`
  if (subject) return `**${subject}**`
  return description ?? ""
}

function formatToolOutput(output: {
  type: "text" | "error-text" | "json" | "error-json" | "content"
  value: unknown
}) {
  switch (output.type) {
    case "text":
    case "error-text":
      return String(output.value)
    case "json":
    case "error-json":
    case "content":
      return stringifyUnknown(output.value)
  }
}

function formatAssistantContent(parts: Array<{ type: string; [key: string]: unknown }>) {
  const lines: string[] = []
  for (const part of parts) {
    switch (part.type) {
      case "text":
        if (typeof part.text === "string" && part.text.trim()) lines.push(part.text)
        break
      case "reasoning":
        if (typeof part.text === "string" && part.text.trim()) lines.push(`[Reasoning]\n${part.text}`)
        break
      case "tool-call":
        lines.push(`[Tool ${String(part.toolName ?? "unknown")}] ${stringifyUnknown(part.input)}`)
        break
    }
  }
  return lines.join("\n\n").trim()
}

function serializePrompt(prompt: LanguageModelV2Prompt) {
  const blocks: string[] = []

  for (const message of prompt) {
    switch (message.role) {
      case "system":
        if (message.content.trim()) blocks.push(`System:\n${message.content}`)
        break

      case "user": {
        const content = message.content
          .map((part) => {
            switch (part.type) {
              case "text":
                return part.text
              case "file":
                return `[Attachment omitted: ${part.filename ?? part.mediaType}]`
            }
          })
          .filter((item) => item.trim())
          .join("\n")

        if (content) blocks.push(`User:\n${content}`)
        break
      }

      case "assistant": {
        const content = formatAssistantContent(
          message.content as unknown as Array<{ type: string; [key: string]: unknown }>,
        )
        if (content) blocks.push(`Assistant:\n${content}`)
        break
      }

      case "tool": {
        const content = message.content
          .map((part) => {
            const body = formatToolOutput(part.output)
            return `Tool ${part.toolName} (${part.toolCallId}):\n${body}`
          })
          .join("\n\n")

        if (content) blocks.push(content)
        break
      }
    }
  }

  return blocks.join("\n\n")
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

class GeminiCliLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = "v2"
  readonly supportsStructuredOutputs = false

  constructor(
    readonly modelId: string,
    private readonly providerName: string,
    private readonly command: string,
    private readonly extraArgs: string[],
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
    const warnings: LanguageModelV2CallWarning[] = []
    const meta: SharedV2ProviderMetadata = { [this.metaKey]: {} }

    const prompt = serializePrompt(options.prompt)
    const args = ["-p", prompt, "--output-format", "stream-json", "-m", this.modelId, ...this.extraArgs]
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

    let textIdx = 0
    let currentTextId: string | undefined
    let currentReasoningId: string | undefined
    let finish: LanguageModelV2FinishReason = "unknown"
    let usage = mapUsage(undefined)
    let sawError = false

    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      start: (controller) => {
        controller.enqueue({ type: "stream-start", warnings })

        const closeText = () => {
          if (!currentTextId) return
          controller.enqueue({ type: "text-end", id: currentTextId })
          currentTextId = undefined
        }

        const closeReasoning = () => {
          if (!currentReasoningId) return
          controller.enqueue({ type: "reasoning-end", id: currentReasoningId })
          currentReasoningId = undefined
        }

        const pushText = (delta: string) => {
          if (!delta) return
          closeReasoning()
          if (!currentTextId) {
            currentTextId = `txt-${textIdx++}`
            controller.enqueue({ type: "text-start", id: currentTextId })
          }
          controller.enqueue({ type: "text-delta", id: currentTextId, delta })
        }

        const pushReasoning = (delta: string) => {
          if (!delta) return
          closeText()
          if (!currentReasoningId) {
            currentReasoningId = `rsn-${textIdx++}`
            controller.enqueue({ type: "reasoning-start", id: currentReasoningId })
          }
          controller.enqueue({ type: "reasoning-delta", id: currentReasoningId, delta })
        }

        const handleMessage = (msg: GeminiMessage) => {
          if (msg.role && msg.role !== "assistant") return
          if (msg.delta === false) return
          if (isRecord(msg.thought) || typeof msg.thought === "string") {
            const thought = typeof msg.thought === "string" ? msg.thought : formatThought(msg.thought)
            if (thought) pushReasoning(thought)
          }
          if (typeof msg.content === "string") pushText(msg.content)
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
              if (thought) pushReasoning(thought)
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

        ;(async () => {
          const reader = proc.stdout.getReader()
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

                try {
                  handleEvent(JSON.parse(trimmed) as GeminiEvent, trimmed)
                } catch (err) {
                  sawError = true
                  controller.enqueue({
                    type: "error",
                    error: new Error(`Invalid gemini stream event: ${stringifyUnknown(err)}`),
                  })
                  break
                }
              }
            }

            if (!sawError && buffer.trim()) {
              try {
                handleEvent(JSON.parse(buffer.trim()) as GeminiEvent, buffer.trim())
              } catch (err) {
                sawError = true
                controller.enqueue({
                  type: "error",
                  error: new Error(`Invalid gemini stream event: ${stringifyUnknown(err)}`),
                })
              }
            }
          } catch (err) {
            if (!aborted) {
              sawError = true
              controller.enqueue({
                type: "error",
                error: err instanceof Error ? err : new Error(stringifyUnknown(err)),
              })
            }
          }

          const code = await proc.exited
          const stderr = await new Response(proc.stderr).text()
          options.abortSignal?.removeEventListener("abort", onAbort)

          closeText()
          closeReasoning()

          if (aborted) {
            controller.close()
            return
          }

          if (!sawError && code !== 0) {
            const detail = stderr.trim() || `${this.command} exited with code ${code}`
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

export function createGeminiCli(options: GeminiCliProviderSettings = {}): GeminiCliProvider {
  const name = options.name ?? "gemini-cli"
  const command = options.command ?? "gemini"
  const extra = options.extraArgs ?? []

  const create = (modelId: string) => new GeminiCliLanguageModel(modelId, name, command, extra)

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
