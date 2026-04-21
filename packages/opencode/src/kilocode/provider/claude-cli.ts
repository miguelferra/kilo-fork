import {
  type LanguageModelV2,
  type LanguageModelV2CallWarning,
  type LanguageModelV2Content,
  type LanguageModelV2FinishReason,
  type LanguageModelV2Prompt,
  type LanguageModelV2StreamPart,
  type SharedV2ProviderMetadata,
} from "@ai-sdk/provider"

// Stateless LanguageModelV2 wrapper around the `claude` CLI.
//
// v1 design: spawn fresh per request, drop CLI-internal tool_use/tool_result
// as executable tool calls (fold into reasoning for visibility), surface only
// text + reasoning to Kilo. Auth is whatever the local `claude` binary uses.

export interface ClaudeCliProviderSettings {
  name?: string
  command?: string
  permissionMode?: string
  extraArgs?: string[]
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

type ClaudeContentBlock =
  | { type: "text"; text?: string }
  | { type: "thinking"; thinking?: string; text?: string }
  | { type: "tool_use"; id?: string; name?: string; input?: unknown }
  | { type: "tool_result"; tool_use_id?: string; content?: unknown; is_error?: boolean }
  | { type: string; [key: string]: unknown }

type ClaudeEvent =
  | { type: "system"; subtype?: string; [key: string]: unknown }
  | {
      type: "assistant"
      message?: { id?: string; content?: ClaudeContentBlock[]; usage?: ClaudeUsage }
    }
  | {
      type: "user"
      message?: { content?: ClaudeContentBlock[] | string }
    }
  | {
      type: "result"
      subtype?: string
      usage?: ClaudeUsage
      result?: string
      is_error?: boolean
      [key: string]: unknown
    }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function formatToolUse(block: ClaudeContentBlock): string {
  if (block.type !== "tool_use") return ""
  const name = typeof block.name === "string" ? block.name : "unknown"
  const input = block.input !== undefined ? stringifyUnknown(block.input) : ""
  const suffix = input ? ` ${input}` : ""
  return `[Tool ${name}]${suffix}`
}

function formatToolResult(block: ClaudeContentBlock): string {
  if (block.type !== "tool_result") return ""
  const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "?"
  const body = block.content !== undefined ? stringifyUnknown(block.content) : ""
  const prefix = block.is_error ? "Tool error" : "Tool result"
  return body ? `[${prefix} ${id}]\n${body}` : `[${prefix} ${id}]`
}

class ClaudeCliLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = "v2"
  readonly supportsStructuredOutputs = false

  constructor(
    readonly modelId: string,
    private readonly providerName: string,
    private readonly command: string,
    private readonly permissionMode: string,
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
      ...this.extraArgs,
    ]
    const body = { command: this.command, args }

    const env = {
      ...process.env,
      CLAUDE_CODE_DISABLE_IDE: "1",
    }

    const proc = Bun.spawn([this.command, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env,
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
    let lastAssistantUsage: ClaudeUsage | undefined

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

        const handleAssistant = (blocks: ClaudeContentBlock[] | undefined) => {
          if (!blocks) return
          for (const block of blocks) {
            switch (block.type) {
              case "text":
                if (typeof block.text === "string") pushText(block.text)
                break
              case "thinking": {
                const thought = typeof block.thinking === "string" ? block.thinking : block.text
                if (typeof thought === "string") pushReasoning(thought)
                break
              }
              case "tool_use": {
                const formatted = formatToolUse(block)
                if (formatted) pushReasoning(formatted)
                break
              }
              case "tool_result": {
                const formatted = formatToolResult(block)
                if (formatted) pushReasoning(formatted)
                break
              }
            }
          }
        }

        const handleUser = (content: ClaudeContentBlock[] | string | undefined) => {
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "tool_result") {
                const formatted = formatToolResult(block)
                if (formatted) pushReasoning(formatted)
              }
            }
          }
        }

        const handleEvent = (event: ClaudeEvent, raw: string) => {
          if (options.includeRawChunks) {
            controller.enqueue({ type: "raw", rawValue: raw })
          }

          switch (event.type) {
            case "system":
              return
            case "assistant": {
              const message = isRecord(event.message) ? event.message : undefined
              handleAssistant(message?.content as ClaudeContentBlock[] | undefined)
              const blockUsage = (message?.usage ?? undefined) as ClaudeUsage | undefined
              if (blockUsage) lastAssistantUsage = blockUsage
              return
            }
            case "user": {
              const message = isRecord(event.message) ? event.message : undefined
              handleUser(message?.content as ClaudeContentBlock[] | string | undefined)
              return
            }
            case "result": {
              const resultEvent = event as Extract<ClaudeEvent, { type: "result" }>
              finish = mapFinish(resultEvent.subtype, resultEvent.is_error)
              usage = mapUsage(resultEvent.usage ?? lastAssistantUsage)
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
                  handleEvent(JSON.parse(trimmed) as ClaudeEvent, trimmed)
                } catch (err) {
                  sawError = true
                  controller.enqueue({
                    type: "error",
                    error: new Error(`Invalid claude stream event: ${stringifyUnknown(err)}`),
                  })
                  break
                }
              }
            }

            if (!sawError && buffer.trim()) {
              try {
                handleEvent(JSON.parse(buffer.trim()) as ClaudeEvent, buffer.trim())
              } catch (err) {
                sawError = true
                controller.enqueue({
                  type: "error",
                  error: new Error(`Invalid claude stream event: ${stringifyUnknown(err)}`),
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

export function createClaudeCli(options: ClaudeCliProviderSettings = {}): ClaudeCliProvider {
  const name = options.name ?? "claude-cli"
  const command = options.command ?? "claude"
  const mode = options.permissionMode ?? "bypassPermissions"
  const extra = options.extraArgs ?? []

  const create = (modelId: string) => new ClaudeCliLanguageModel(modelId, name, command, mode, extra)

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
