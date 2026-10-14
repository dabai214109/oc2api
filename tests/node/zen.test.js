import assert from "node:assert/strict"
import test from "node:test"

import { areToolsDisabled, buildUpstreamRequest, gateTool, isAllowedModelId, getSession } from "../../server/zen.js"

test("免费层必要条件：UA、session、门禁工具、强制流式", () => {
  const request = buildUpstreamRequest({ model: "big-pickle", messages: [{ role: "user", content: "hi" }] }, "ses_test")
  const body = JSON.parse(request.body)

  assert.equal(body.stream, true, "stream:false 会被上游 403，必须强制 true")
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.equal(request.headers["User-Agent"], "opencode/latest/2.0.29/cli")
  assert.equal(request.headers.Authorization, "Bearer public")
  assert.equal(request.headers["x-opencode-client"], "cli")
  assert.equal(request.headers["x-opencode-project"], "global")
  assert.equal(request.headers["x-opencode-request"], undefined, "V2 不发送旧版非标准 request ID，会导致 403")
  for (const header of ["x-opencode-session", "x-opencode-session-id", "x-session-affinity", "X-Session-Id"]) {
    assert.equal(request.headers[header], "ses_test", `${header} 必须复用同一会话`)
  }

  const names = body.tools.map((tool) => tool.function.name)
  assert.deepEqual(names, ["shell", "read"], "V2 使用 shell/read 而不是 bash/read")
  assert.equal(body.tool_choice, undefined, "V2 不接受显式 none，禁用语义由响应层强制执行")
})

test("业务字段原样透传，只有门禁相关字段被补齐", () => {
  const payload = {
    model: "mimo-v2.6-flash-free",
    messages: [
      { role: "system", content: "be nice" },
      { role: "user", content: "hi" },
    ],
    temperature: 0.3,
    top_p: 0.9,
    stop: ["\n"],
    max_tokens: 128,
    response_format: { type: "json_object" },
  }
  const body = JSON.parse(buildUpstreamRequest(payload, "ses_x").body)

  assert.deepEqual(body.messages, payload.messages)
  assert.equal(body.temperature, 0.3)
  assert.equal(body.top_p, 0.9)
  assert.deepEqual(body.stop, ["\n"])
  assert.equal(body.max_tokens, 128)
  assert.deepEqual(body.response_format, { type: "json_object" })
  assert.equal(body.model, "mimo-v2.6-flash-free")
})

test("危险键名不转发给上游，同时不影响正常字段", () => {
  // JSON.parse 会把 "__proto__"/"constructor" 当普通自有属性，展开后会原样进 body。
  // 实测不会污染本地原型，但这类字段没有任何透传价值，一律剥掉。
  const payload = JSON.parse(
    '{"model":"big-pickle","messages":[],"temperature":0.5,' +
      '"__proto__":{"polluted":"yes"},"constructor":{"x":1},"prototype":{"y":2}}',
  )
  const raw = buildUpstreamRequest(payload, "ses_x").body
  for (const key of ["__proto__", "constructor", "prototype"]) {
    assert.ok(!raw.includes(`"${key}"`), `${key} 不应出现在上游 body 里`)
  }
  const body = JSON.parse(raw)
  assert.equal(body.temperature, 0.5, "正常字段必须保留")
  assert.equal(body.model, "big-pickle")
  assert.equal(Object.prototype.polluted, undefined, "本地原型不能被污染")
})

test("用户自带工具时保留用户定义，并沿用用户的 tool_choice", () => {
  const weather = { type: "function", function: { name: "get_weather", parameters: { type: "object" } } }
  const body = JSON.parse(
    buildUpstreamRequest(
      { model: "big-pickle", messages: [{ role: "user", content: "hi" }], tools: [weather], tool_choice: "auto" },
      "ses_x",
    ).body,
  )
  const names = body.tools.map((tool) => tool.function.name)
  assert.ok(names.includes("get_weather") && names.includes("shell") && names.includes("read"))
  assert.equal(body.tool_choice, "auto")

  // 用户自带 shell 时不能被门禁版本覆盖
  const custom = { type: "function", function: { name: "shell", description: "mine", parameters: { type: "object" } } }
  const replaced = JSON.parse(
    buildUpstreamRequest({ model: "big-pickle", messages: [{ role: "user", content: "hi" }], tools: [custom] }, "ses_x")
      .body,
  )
  assert.equal(replaced.tools.find((tool) => tool.function.name === "shell").function.description, "mine")
  assert.equal(replaced.tools.filter((tool) => tool.function.name === "shell").length, 1)
})

test("max_tokens 缺省时才补默认值，用户显式传 0 之外的值不覆盖", () => {
  const explicit = JSON.parse(buildUpstreamRequest({ model: "big-pickle", messages: [], max_tokens: 7 }, "ses_x").body)
  assert.equal(explicit.max_tokens, 7)

  const fallback = JSON.parse(buildUpstreamRequest({ model: "big-pickle", messages: [] }, "ses_x").body)
  assert.equal(fallback.max_tokens, 32000)

  const completion = JSON.parse(
    buildUpstreamRequest({ model: "big-pickle", messages: [], max_completion_tokens: 9 }, "ses_x").body,
  )
  assert.equal(completion.max_completion_tokens, 9)
  assert.equal(completion.max_tokens, undefined, "已有 max_completion_tokens 时不应再补 max_tokens")
})

test("模型白名单只放行 big-pickle 与 -free 结尾", () => {
  assert.equal(isAllowedModelId("big-pickle"), true)
  assert.equal(isAllowedModelId("mimo-v2.6-flash-free"), true)
  assert.equal(isAllowedModelId("gpt-6-astra"), false)
  assert.equal(isAllowedModelId("-free"), true)
  assert.equal(isAllowedModelId(""), false)
  assert.equal(isAllowedModelId(null), false)
})

test("session 符合上游格式且同一使用者复用直到过期", () => {
  const user = "user-a"
  const first = getSession(user)
  // 上游只认这种形状：ses_ + 12 位十六进制 + 14 位 base62，共 30 字符
  assert.match(first, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  assert.equal(first.length, 30)
  assert.equal(getSession(user), first, "同一使用者应复用 session")
  assert.notEqual(getSession("user-b"), first)
})

test("V2 门禁工具保留官方描述前缀、参数 schema 和禁止调用提示", () => {
  for (const [name, required, prefix] of [
    ["shell", "command", "Execute a shell command and return its output."],
    ["read", "path", "Read the contents of a file or directory."],
  ]) {
    const tool = gateTool(name)
    assert.equal(tool.type, "function")
    assert.equal(tool.function.name, name)
    assert.ok(tool.function.description.startsWith(prefix))
    assert.match(tool.function.description, /do not call/i)
    assert.equal(tool.function.parameters.properties[required].type, "string")
    assert.deepEqual(tool.function.parameters.required, [required])
    assert.equal(tool.function.parameters.additionalProperties, false)
    assert.equal(tool.function.strict, false)
  }
  assert.equal(gateTool("shell").function.parameters.properties.background.type, "boolean")
  assert.equal(gateTool("read").function.parameters.properties.offset.minimum, 0)
})

test("禁用工具时不透传 none 或用户工具，也不修改用户消息", () => {
  const tools = [{ type: "function", function: { name: "weather", parameters: { type: "object" } } }]
  for (const input of [{}, { tools: [] }, { tools, tool_choice: "none" }]) {
    const payload = { model: "big-pickle", messages: [{ role: "user", content: "hi" }], ...input }
    const body = JSON.parse(buildUpstreamRequest(payload, "ses_x").body)
    assert.equal(areToolsDisabled(payload), true)
    assert.equal(body.tool_choice, undefined)
    assert.deepEqual(
      body.tools.map((tool) => tool.function.name),
      ["shell", "read"],
    )
    assert.deepEqual(body.messages, payload.messages)
  }
  for (const choice of [undefined, "auto", "required", { type: "function", function: { name: "weather" } }]) {
    const payload = { model: "big-pickle", messages: [], tools, tool_choice: choice }
    assert.equal(areToolsDisabled(payload), false)
    const body = JSON.parse(buildUpstreamRequest(payload, "ses_x").body)
    assert.deepEqual(body.tools[0], tools[0])
    assert.deepEqual(body.tool_choice, choice)
  }
})

test("reasoningEffort 别名恢复上游 snake_case，snake_case 优先", () => {
  for (const [input, expected] of [
    [{ reasoningEffort: "none" }, "none"],
    [{ reasoningEffort: "high" }, "high"],
    [{ reasoning_effort: "low", reasoningEffort: "high" }, "low"],
    [{ reasoning_effort: null, reasoningEffort: "medium" }, "medium"],
    [{ reasoning_effort: "" }, undefined],
    [{}, undefined],
  ]) {
    const body = JSON.parse(buildUpstreamRequest({ model: "big-pickle", messages: [], ...input }, "ses_x").body)
    assert.equal(body.reasoning_effort, expected)
    assert.equal(body.reasoningEffort, undefined)
  }
})

test("session 滑动过期：活跃时复用，空闲满 30 分钟换新", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1 })
  const first = getSession("expiry-test")
  t.mock.timers.tick(29 * 60 * 1000)
  assert.equal(getSession("expiry-test"), first)
  t.mock.timers.tick(29 * 60 * 1000)
  assert.equal(getSession("expiry-test"), first, "按空闲时间而不是创建时间过期")
  t.mock.timers.tick(30 * 60 * 1000)
  assert.notEqual(getSession("expiry-test"), first)
})

test("buildUpstreamRequest 不修改用户工具、消息或参数原对象", () => {
  const weather = Object.freeze({
    type: "function",
    function: Object.freeze({ name: "weather", parameters: { type: "object" } }),
  })
  const payload = Object.freeze({
    model: "big-pickle",
    tools: Object.freeze([weather]),
    messages: Object.freeze([{ role: "user", content: "hi" }]),
    max_tokens: 0,
  })
  const body = JSON.parse(buildUpstreamRequest(payload, "ses_x").body)
  assert.equal(payload.tools.length, 1)
  assert.equal(body.tools.length, 3)
  assert.equal(body.max_tokens, 0)
  assert.deepEqual(body.messages, payload.messages)
})
