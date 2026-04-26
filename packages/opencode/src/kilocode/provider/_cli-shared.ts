import {
  type LanguageModelV2Prompt,
  type LanguageModelV2StreamPart,
} from "@ai-sdk/provider"

// Shared primitives for the local-CLI provider wrappers (claude-cli, gemini-cli).
// These wrappers spawn an upstream coding-CLI as a subprocess and translate its
// newline-delimited JSON stream into AI-SDK LanguageModelV2 stream parts.

export function stringifyUnknown(input: unknown): string {
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function formatToolOutput(output: {
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

function formatAssistantParts(parts: Array<{ type: string; [key: string]: unknown }>) {
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

export function serializeMessage(message: LanguageModelV2Prompt[number]): string {
  switch (message.role) {
    case "system":
      return message.content.trim() ? `System:\n${message.content}` : ""
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
      return content ? `User:\n${content}` : ""
    }
    case "assistant": {
      const content = formatAssistantParts(
        message.content as unknown as Array<{ type: string; [key: string]: unknown }>,
      )
      return content ? `Assistant:\n${content}` : ""
    }
    case "tool": {
      const content = message.content
        .map((part) => {
          const body = formatToolOutput(part.output)
          return `Tool ${part.toolName} (${part.toolCallId}):\n${body}`
        })
        .join("\n\n")
      return content
    }
  }
}

export function serializePrompt(prompt: LanguageModelV2Prompt) {
  const blocks: string[] = []
  for (const message of prompt) {
    const chunk = serializeMessage(message)
    if (chunk) blocks.push(chunk)
  }
  return blocks.join("\n\n")
}

export type TurnPush = {
  pushText: (delta: string) => void
  pushReasoning: (delta: string) => void
  closeText: () => void
  closeReasoning: () => void
}

// Wraps a stream controller with text/reasoning ID accounting. Switching modes
// auto-closes the previous block so AI SDK never sees a dangling start.
export function createTurnPush(
  controller: ReadableStreamDefaultController<LanguageModelV2StreamPart>,
): TurnPush {
  let idx = 0
  let textId: string | undefined
  let reasoningId: string | undefined

  const closeText = () => {
    if (!textId) return
    controller.enqueue({ type: "text-end", id: textId })
    textId = undefined
  }
  const closeReasoning = () => {
    if (!reasoningId) return
    controller.enqueue({ type: "reasoning-end", id: reasoningId })
    reasoningId = undefined
  }
  const pushText = (delta: string) => {
    if (!delta) return
    closeReasoning()
    if (!textId) {
      textId = `txt-${idx++}`
      controller.enqueue({ type: "text-start", id: textId })
    }
    controller.enqueue({ type: "text-delta", id: textId, delta })
  }
  const pushReasoning = (delta: string) => {
    if (!delta) return
    closeText()
    if (!reasoningId) {
      reasoningId = `rsn-${idx++}`
      controller.enqueue({ type: "reasoning-start", id: reasoningId })
    }
    controller.enqueue({ type: "reasoning-delta", id: reasoningId, delta })
  }
  return { pushText, pushReasoning, closeText, closeReasoning }
}

// Reads NDJSON from a process stdout until EOF.
//   onParseError defaults to "throw" — set to "skip" for long-lived sessions
//   that should tolerate the occasional malformed line.
//   flushTail defaults to false — set to true for one-shot CLIs that may not
//   emit a trailing newline.
export async function readNdjson<T>(
  stdout: ReadableStream<Uint8Array>,
  onLine: (event: T, raw: string) => void,
  options?: {
    onParseError?: (err: unknown, raw: string) => "skip" | "throw"
    flushTail?: boolean
  },
): Promise<void> {
  const reader = stdout.getReader()
  const decoder = new TextDecoder()
  const onParseError = options?.onParseError
  const flushTail = options?.flushTail ?? false
  let buffer = ""

  const handle = (raw: string) => {
    let parsed: T
    try {
      parsed = JSON.parse(raw) as T
    } catch (err) {
      const decision = onParseError?.(err, raw) ?? "throw"
      if (decision === "skip") return
      throw err
    }
    onLine(parsed, raw)
  }

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
        handle(trimmed)
      }
    }
    if (flushTail) {
      const tail = buffer.trim()
      if (tail) handle(tail)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // already released
    }
  }
}

// Drain stderr in the background so the subprocess pipe never fills up.
// Errors are swallowed because stderr drain is best-effort cleanup.
export function drainStderr(
  stderr: ReadableStream<Uint8Array>,
  onText: (text: string) => void,
): void {
  ;(async () => {
    const decoder = new TextDecoder()
    try {
      for await (const chunk of stderr) {
        const text = decoder.decode(chunk, { stream: true }).trim()
        if (text) onText(text)
      }
    } catch {
      // process ended
    }
  })()
}

// Strip flags from user-supplied extraArgs so they can't override flags the
// wrapper sets itself. Skips both "--flag value" and "--flag=value" forms.
export function stripFlags(args: string[], blocked: string[]): string[] {
  const result: string[] = []
  let i = 0
  while (i < args.length) {
    const arg = args[i]
    const exact = blocked.find((flag) => arg === flag)
    const prefixed = blocked.find((flag) => arg.startsWith(`${flag}=`))
    if (exact) {
      // skip flag, plus value if it doesn't look like another flag
      if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        i += 2
      } else {
        i += 1
      }
      continue
    }
    if (prefixed) {
      i += 1
      continue
    }
    result.push(arg)
    i += 1
  }
  return result
}
