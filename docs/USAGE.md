# 使用 IMApy

需要 Node.js 22。首次扫码已验证 macOS 图形桌面及已安装的 Chrome、Edge 或 Chromium；Windows 实验适配与单独验收边界见 [Windows 说明](WINDOWS.md)。
本预览版没有公开 npm 包；请使用同一交付清单内的安装包，并核对 SHA-256。

## 安装与本地检查

在解压后的交付目录执行校验，再安装到自己选择的目录：

```sh
shasum -a 256 -c SHA256SUMS
npm install --offline --ignore-scripts --omit=dev --no-audit --no-fund \
  --update-notifier=false --prefix "$HOME/.local/opt/imapy-alpha" \
  ./ima-local-standalone-0.1.0-alpha.2.tgz
```

以下 `ima-local` 指安装目录中的 `node_modules/.bin/ima-local`，请将该目录加入 PATH，
或直接使用完整路径。安装不自动注册 Agent、不下载浏览器、不登录、不发问。

```sh
ima-local --version
ima-local doctor --local --json
ima-local status --profile personal --json
ima-local capabilities --json
```

这些命令不向 IMA 发请求，不创建 profile。`ready=false` 是保守候选字段；结合
`readiness` 与历史 `acceptanceEvidence` 理解状态，不为消除提示自动提问。

## 人工登录与维护

以下操作仅在本人同意时执行。`init` 创建独立私有状态；`login` 打开单独的临时
浏览器窗口，自动进入官方 IMA 登录页。本人扫码并在手机确认，程序捕获必要上下文、
关闭自有窗口后再加密保存。不要提供 Cookie、token、二维码或 profile 文件给聊天。

```sh
ima-local init --profile personal --json
ima-local login --profile personal
ima-local auth status --profile personal --json
```

默认状态目录为 `~/.local/share/ima-standalone-local`；可用 `--state-dir` 指定独立目录。
目录 0700、文件 0600，不放 Git、共享或云同步目录。密钥与密文同目录，不是系统
钥匙串保护；应完整私有备份。不能靠重建密钥恢复旧数据。

登录后日常问答及续期使用 HTTP/SSE，无需浏览器常驻。到期或上游变化仍可能重扫。
访问凭证到期时显式续期；默认没有定时后台维护：

```sh
ima-local auth refresh --profile personal --json
```

若出现 `auth_recovery_required`、`outcome_unknown`，停止新请求，先检查本地状态。
`auth recover` 是可能写入的本地恢复；`auth recover-lock` 会清理已证明过期的锁，
都不能当作普通状态检查自动执行。HTTP 200 不代表凭证已可靠保存，不盲目续期重试。

## 选库、提问和追问

下面两项会访问 IMA。读取当前目录并使用准确 ID，不按名字或数组位置猜选：

```sh
ima-local models --profile personal --json
ima-local libraries --profile personal --json
```

在私有目录准备权限为 0600 的请求 JSON，替换示例中的模型 ref、知识库 ID 和问题：

```json
{
  "requestKey": "one-stable-key-for-this-question",
  "question": "用户明确提出的问题",
  "modelRef": "目录返回的模型ref",
  "mode": "quick",
  "knowledgeBaseId": "目录返回的知识库ID",
  "kind": "scoped_agent",
  "webSearch": false
}
```

```sh
ima-local ask --profile personal --input /absolute/private/request.json --stream
ima-local task --profile personal --request-key one-stable-key-for-this-question --view result --json
ima-local export --profile personal --request-key one-stable-key-for-this-question \
  --format json --output /absolute/private/new-answer.json --json
```

输出为 NDJSON。先保存原请求键和任务编号；断线后读取同一任务，不换键重发。
新追问使用新请求键，添加原 `conversationId`，保持同一 profile；`scoped_agent`
支持逐轮 `quick`/`deep` 与实际目录中的模型选择。要求联网时设 `webSearch=true`，
但参数只表示意图；应检查 `webEvidenceStatus` 和准确的 `citationMap`。

JSON 导出保留结构化引用，Markdown 文件只保存正文。缺失或 unknown 的来源不猜补。
`cancel-task` 仅取消本进程接收，不保证上游取消；结果不确定时不得换键绕过保护。

## SDK

在安装了本包的 Node 项目中，以下示例只读取本地状态，不登录或发问：

```js
import { openPersonalProfile } from '@ima-local/standalone';
const profile = openPersonalProfile({ profile: 'personal' });
try {
  console.log(await profile.inspectReadiness());
  // 本人明确授权后：profile.sdk.getModels() / listKnowledgeBases()
  // await profile.sdk.ask(request, { onEvent: event => consume(event) });
  // request 使用与 CLI 相同的稳定 requestKey 和准确目录 ID。
} finally {
  await profile.close();
}
```

完整 SDK 接口可从 `dist/sdk.mjs` 的导出及合成测试查看。不要把对话内容放进进程参数
或日志。异步流消费者提前结束也要关闭 profile，保留未知派发保护。

## MCP 与 Skill

```sh
ima-local mcp --profile personal
ima-local setup plan --host codex --profile personal --json
ima-local skill path --json
```

MCP 使用 STDIO，未登录也能发现 11 个工具，启动不发请求。`setup plan` 只给出配置
或宿主命令计划；安装 Skill、执行注册或修改已有配置前，先检查同名项并私有备份，
由本人确认。宿主应使用安装后的绝对可执行文件路径，不能依赖本机研发目录。

Skill 位于随包 `skills/ima-standalone`；按宿主支持的方法手动安装，不会自动替换
已有 Skill。它规定选库、模型、稳定任务键、未知结果停止和引用核验流程。
工具发现与 Skill 可见性不代表真实 Agent 完成取材，见[验收范围](ACCEPTANCE.md)。
