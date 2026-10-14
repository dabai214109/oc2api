// OpenCode V2 上游客户端。对照 2.0.29 源码与真实 CLI 抓包：
//   - 使用 inference/v1、V2 User-Agent 和会话关联 headers，不发送旧的非标准 request ID；
//   - 免费层要求 shell/read 的描述与参数 schema，旧版空工具定义会被 403；
//   - 显式 tool_choice:none 也会被 403，改用保留工具描述并在响应层禁止工具调用。
// 不注入 OpenCode 的系统提示词；业务消息和其余参数原样透传。
import { debugLog } from "./log.js"

// A local relay can recover rejected requests before the adapter sees them.
const ZEN_API_BASE_URL = (process.env.ZEN_API_BASE_URL || "https://opencode.ai/inference/v1").replace(/\/+$/, "")
const ZEN_CHAT_URL = `${ZEN_API_BASE_URL}/chat/completions`
const ZEN_MODELS_URL = `${ZEN_API_BASE_URL}/models`

// 对齐 App.useragent：opencode/<channel>/<version>/<client>。
const ZEN_USER_AGENT = "opencode/latest/2.0.29/cli"

// 建立连接与模型列表的超时。注意：响应头之后的读取由 openai.js 的看门狗负责。
const CONNECT_TIMEOUT_MS = Number(process.env.ZEN_CONNECT_TIMEOUT_MS || 60 * 1000)
if (!Number.isFinite(CONNECT_TIMEOUT_MS) || CONNECT_TIMEOUT_MS < 1 || CONNECT_TIMEOUT_MS > 600000) {
  throw new Error("ZEN_CONNECT_TIMEOUT_MS must be between 1 and 600000 milliseconds")
}

// V2 使用 shell 而不是 bash；只补真实上游已验证的最小集合。
const GATE_TOOL_NAMES = ["shell", "read"]

// 这些键名在 JS 里有特殊含义，用户塞进请求体没有任何意义，一律不转发给上游。
const DANGEROUS_KEYS = ["__proto__", "constructor", "prototype"]

const GATE_TOOL_DESCRIPTION =
  "Reserved for the host runtime; do not call or select this function. Use tools explicitly supplied by the user instead."

export function gateTool(name) {
  // 描述前缀与 schema 对齐 V2 的 tool/plugin/{shell,read}.ts；空 schema 不再放行。
  const shell = name === "shell"
  return {
    type: "function",
    function: {
      name,
      description: `${shell ? "Execute a shell command and return its output." : "Read the contents of a file or directory."} ${GATE_TOOL_DESCRIPTION}`,
      parameters: {
        type: "object",
        properties: shell
          ? {
              command: { type: "string", description: "Shell command string to execute" },
              workdir: { type: "string", description: "Working directory to execute the command in" },
              timeout: { type: "integer", minimum: 0, description: "Timeout in milliseconds" },
              background: { type: "boolean", description: "Run the command in the background" },
            }
          : {
              path: { type: "string", description: "File or directory to read" },
              offset: { type: "integer", minimum: 0, description: "Starting line or directory entry (1-based)" },
              limit: { type: "integer", minimum: 0, description: "Maximum lines or directory entries to read" },
            },
        required: [shell ? "command" : "path"],
        additionalProperties: false,
      },
      strict: false,
    },
  }
}

export function areToolsDisabled(payload) {
  return payload.tool_choice === "none" || !Array.isArray(payload.tools) || payload.tools.length === 0
}

// 用户已经自带同名工具时保留用户定义，只补缺失的门禁工具。
function withGateTools(tools) {
  const result = Array.isArray(tools) ? tools.filter((tool) => tool && typeof tool === "object") : []
  const present = new Set(result.map((tool) => tool?.function?.name).filter((name) => typeof name === "string"))
  for (const name of GATE_TOOL_NAMES) {
    if (present.has(name)) continue
    result.push(gateTool(name))
    present.add(name)
  }
  return result
}

export function isAllowedModelId(id) {
  return typeof id === "string" && (id === "big-pickle" || id.endsWith("-free"))
}

// 上游只接受流式；下游是否流式由响应层决定，与这里无关。
export function buildUpstreamRequest(payload, sessionId) {
  const body = {
    ...payload,
    tools: withGateTools(areToolsDisabled(payload) ? [] : payload.tools),
    stream: true,
    stream_options: { include_usage: true },
  }

  // 危险键名不转发：JSON.parse 会把 "__proto__"/"constructor" 当普通自有属性，
  // 展开后原样带到上游 body 里（实测不污染本地原型，但没有任何透传价值）。
  for (const key of DANGEROUS_KEYS) delete body[key]

  // V2 拒绝 none。禁用时不提供用户工具、只留下带禁止调用提示的保留工具，
  // 响应层再拒绝任何工具调用，不能仅靠提示词保证下游的禁用语义。
  if (areToolsDisabled(payload) || payload.tool_choice == null) delete body.tool_choice
  else body.tool_choice = payload.tool_choice

  // 兼容既有 camelCase 别名；上游和官方 SDK 使用 snake_case，不能只影响本地过滤。
  const reasoningEffort = payload.reasoning_effort ?? payload.reasoningEffort
  delete body.reasoningEffort
  if (reasoningEffort != null && reasoningEffort !== "") body.reasoning_effort = reasoningEffort
  else delete body.reasoning_effort

  if (body.max_tokens == null && body.max_completion_tokens == null) body.max_tokens = 32000

  return {
    body: JSON.stringify(body),
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      Authorization: "Bearer public",
      "User-Agent": ZEN_USER_AGENT,
      "x-opencode-client": "cli",
      "x-opencode-project": "global",
      "x-opencode-session": sessionId,
      "x-opencode-session-id": sessionId,
      "x-session-affinity": sessionId,
      "X-Session-Id": sessionId,
    },
  }
}

// 只在建立连接阶段计时；响应头一到就交给调用方，避免把长回答误杀。
export async function fetchUpstream(request, ctx) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort("timeout"), CONNECT_TIMEOUT_MS)
  const started = Date.now()

  try {
    const response = await fetch(ZEN_CHAT_URL, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    })
    debugLog("[ZEN RES]", {
      requestId: ctx.requestId,
      model: ctx.model,
      status: response.status,
      ms: Date.now() - started,
    })
    return response
  } catch (error) {
    if (error?.name === "AbortError" || error === "timeout") throw new Error("timeout", { cause: error })
    throw error
  } finally {
    clearTimeout(timer)
  }
}

let cachedModels = null

export async function listModels() {
  if (cachedModels) return cachedModels
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort("timeout"), CONNECT_TIMEOUT_MS)

  try {
    const response = await fetch(ZEN_MODELS_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer public",
        "User-Agent": ZEN_USER_AGENT,
      },
      signal: controller.signal,
    })
    const parsed = await response.json().catch((error) => {
      if (error instanceof SyntaxError) return null
      throw error
    })
    if (!response.ok) throw new Error(`Model list returned HTTP ${response.status}`)
    if (!Array.isArray(parsed?.data)) throw new Error("Invalid model list response")

    const models = parsed.data.filter((item) => isAllowedModelId(item?.id))
    if (!models.length) throw new Error("No allowed models returned from upstream")

    cachedModels = models
    return models
  } catch (error) {
    if (error?.name === "AbortError" || error === "timeout") throw new Error("timeout", { cause: error })
    throw error
  } finally {
    clearTimeout(timer)
  }
}

// 上游按 x-opencode-session 归并会话；同一使用者复用同一个 session 直到过期。
const SESSION_TTL_MS = 30 * 60 * 1000
const userSessions = new Map()

// session 头必须符合 OpenCode 的 ID 格式，否则上游一律 403 FreeTier：
// `ses_` + 12 位十六进制 + 14 位 base62（共 30 字符）。首 12 位不是任意十六进制，
// 必须是 descending() 的 `~(timestamp * 0x1000 + counter)` 高 48 位，上游会据此校验。
const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

export function sessionId(timestamp = Date.now()) {
  // 与上游 descending() 一致：value = ~(timestamp * 0x1000 + counter) 取低 48 位十六进制。
  const value = ~(BigInt(timestamp) * 0x1000n + 1n)
  let time = ""
  for (let index = 0; index < 6; index += 1) {
    time += Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0")
  }
  const bytes = new Uint8Array(14)
  crypto.getRandomValues(bytes)
  return "ses_" + time + [...bytes].map((byte) => ID_CHARS[byte % 62]).join("")
}

export function getSession(user) {
  const now = Date.now()
  const existing = userSessions.get(user)
  if (existing && now - existing.at < SESSION_TTL_MS) {
    existing.at = now
    return existing.id
  }
  const id = sessionId(now)
  userSessions.set(user, { id, at: now })
  return id
}
