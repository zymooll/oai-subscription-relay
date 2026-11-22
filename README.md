# OAI Subscription Relay

**OAI 订阅中转**在 Windows 本机提供 OpenAI Responses API 中继。你在管理台通过官方 **Sign in with ChatGPT** 授权后，支持 Responses 协议的客户端可以用本机中继密钥发起请求，符合条件的调用计入所选 ChatGPT 套餐。

```text
Responses 客户端 → 127.0.0.1:41875/v1 → OpenAI Responses API
```

## 功能

| 功能 | 说明 |
| --- | --- |
| ChatGPT 授权 | 管理台支持登录、重新授权、切换账号和退出。令牌由中继维护，并使用 Windows DPAPI 加密保存。 |
| Responses 中继 | 支持普通 JSON 响应和 SSE 流式响应。 |
| 多 API Key | 创建、编辑、复制、换发和撤销本机密钥。逐把设置模型白名单、到期时间和用量上限。 |
| 用量控制 | 支持累计请求数、token 数、估算 USD 上限，以及按滚动 60 秒计算的 RPM。 |
| 模型与价格 | 套餐模型列表缓存 5 分钟。按模型 ID 匹配 models.dev 的 OpenAI 参考价，价格缓存 6 小时。两者均可手动刷新。 |
| 用量查询 | 管理台按日展示本机中继用量，客户端可查询所属密钥的用量与上限。 |

## 快速开始

需要 Windows、Node.js 22 或更新版本，以及符合套餐授权条件的 ChatGPT 账号。项目使用 Node.js 内置模块，无需安装 npm 依赖。

1. 下载仓库后双击 **start-relay.cmd**。中继会在默认浏览器打开本机管理台。
2. 点 **使用 ChatGPT 登录**，在 OpenAI 页面选择账号与工作区并授权套餐使用。
3. 在 **中继 API Keys** 中创建并复制密钥，把下表配置填入客户端。给不同客户端分配密钥后，可以分别设定模型和用量。
4. 点管理台的 **关闭服务** 可停止中继。

| 客户端设置 | 填写内容 |
| --- | --- |
| 协议 | OpenAI Responses |
| Base URL | `http://127.0.0.1:41875/v1` |
| API Key | 管理台中为该客户端创建的中继密钥 |
| Model | 从 `GET /v1/models` 返回的 `data[].id` 选择 |

### PowerShell 调用示例

在项目目录中运行。示例读取第一把有效密钥，并通过模型列表选择可用模型。

```powershell
$baseUrl = 'http://127.0.0.1:41875/v1'
$relayKey = node .\server.mjs --relay-key
$headers = @{ Authorization = "Bearer $relayKey" }
$models = Invoke-RestMethod "$baseUrl/models" -Headers $headers
$model = $models.data | Select-Object -First 1 -ExpandProperty id
if (-not $model) { throw '当前密钥没有可用模型。' }

$body = @{ model = $model; input = 'Reply with OK.' } | ConvertTo-Json
Invoke-RestMethod "$baseUrl/responses" -Method Post -Headers $headers -ContentType 'application/json' -Body $body
```

## 接口与限额

以下接口使用中继密钥进行 Bearer 认证。

| 接口 | 返回内容 |
| --- | --- |
| `GET /v1/models` | 当前套餐目录与密钥白名单的交集。响应头 `X-Relay-Cache` 表示缓存命中情况。 |
| `POST /v1/responses` | 转发 Responses 请求。`input` 接受字符串或 Responses 输入数组。`stream: true` 返回 SSE，默认返回 JSON。 |
| `GET /v1/usage?days=7` | 当前密钥的日用量及累计计数和上限。`days` 支持 1 到 30。此接口由中继提供。 |

- **请求次数与 RPM**在转发前计算。RPM 达到上限时，返回 `429`、`relay_key_rpm_exceeded` 和以秒为单位的 `Retry-After`。
- **Token 与估算费用**使用上游响应报告的数据结算。设有这两类限额的密钥同一时间放行一个推理请求，单次响应可能使累计用量越过上限，结算后会拦截后续请求。
- **估算费用**按 models.dev 公布的每百万 tokens 参考价计算，包含适用的缓存和长上下文档位。套餐余额与跨设备用量可在官方页面查看。 [ChatGPT 用量设置](https://chatgpt.com/settings/usage) · [参考价格目录](https://models.dev/api.json)

套餐路径使用 `store: false`。多轮请求需要在 `input` 中携带上下文。中继会移除 `max_output_tokens`，以兼容默认发送该字段的客户端。`previous_response_id`、`temperature` 等套餐路径不支持的参数会返回错误。 [套餐接口限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

## 本机数据

服务仅监听 `127.0.0.1:41875`。授权、密钥策略、加密后的密钥和用量统计保存在 `%LOCALAPPDATA%\ChatGPT-Chat-MVP`。中继的用量汇总保存计数与时间，聊天内容随请求转发给 OpenAI。升级旧版时，已有中继密钥会导入为「默认密钥」。

套餐授权使用 OpenAI 的开放源码接入流程。 [注册与登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) · [模型与推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
