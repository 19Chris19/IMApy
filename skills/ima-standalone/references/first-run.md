# 首次使用与 CLI 路径

返回 [Skill 主流程](../SKILL.md)。仅在准备安装、登录或需要 CLI 替代时读取。

## 安装与登录

需要 Node.js 22 和来自本次交付清单的固定本地 tgz。不要猜 npm 公开包名或
下载浮动源码；当前候选未正式发布。安装到用户选定的独立目录：

```sh
npm install --offline --ignore-scripts --omit=dev --no-audit --no-fund \
  --update-notifier=false --prefix /absolute/install-prefix /absolute/candidate.tgz
```

下文 `ima-local` 指该安装目录的可执行文件。先做本地检查：

```sh
ima-local doctor --local --json
ima-local status --profile personal --json
```

初始化创建独立私有 profile，不覆盖已有密钥。人工扫码需用户授权：

```sh
ima-local init --profile personal --json
ima-local login --profile personal
```

程序使用临时 Chromium profile，捕获同账号认证与设备上下文后关闭窗口，
再加密保存。无需手动读取 Cookie、私钥或 storage 文件。
默认扫码最多 5 分钟；设备捕获最多 25 秒，失败保留旧状态。
已有登录要显式 `login --replace`；另一个账号使用另一个 profile。

状态 `stored_unverified` 和全局 `qaReady=false` 不证明真实权限。用户可在
明确授权的真实验收范围内尝试取材；禁止为消除该状态偷偷提一轮问题。
新版 `status.readiness` 对当前 profile 做只读、本地、时点性的预检：

| 状态或下一步 | 应如何处理 |
| --- | --- |
| `attemptable` | 本地凭证与设备条件齐全；在现有授权内选库/模型，不保证实际权限 |
| `refresh_required` / `explicit_refresh` | 仅访问凭证过期；需要显式续期，不默认重新扫码 |
| `login_required` / `explicit_login` | 未登录、续期凭证过期或上游已要求重新认证；人工扫码 |
| `device_context_missing` | 可尝试目录读取，但不能据此发送问答；人工登录补上下文 |
| `auth_recovery_required` | 上次认证结果未定；只读检查，禁止清保护重试 |
| `busy` / `auth_busy` | 等待已有操作，必要时读取已知任务；不绕过互斥 |
| `lock_recovery_required` / `unavailable` | 先只读检查锁/本地文件；不能视为可派发 |

只有上游实际响应才能证明当前调用权限。`canAttemptQA=true` 不验证指定会话
的保护状态；执行时仍重新取得租约并检查凭证、账号和原会话，不能绕过未知任务。
缺少有效期时 `expiryKnown` 明确为 false，不暗中请求上游补测。

仅在用户已授权对应操作时执行：

```sh
ima-local auth refresh --profile personal --json
```

然后重新读取本地 `status`。`auth_access_expired` 不意味着登录已永久失效。
HTTP 200 不等于续期保存成功；`outcome_unknown` 时保持原记录并停止。
检查使用 `auth status`、`auth lock-status`；`auth recover` 可能恢复本地提交，
不是只读命令；`recover-lock` 会清理锁。两者都不作为普通状态检查自动执行。

本地加密密钥与密文位于同一私有 profile，并非系统钥匙串保护。
目录需 0700，文件 0600，避免 Git、共享与云同步目录。

## 不使用 MCP 的取材

```sh
ima-local models --profile personal --json
ima-local libraries --profile personal --json
```

从上述响应取得真实模型 ref 与知识库 ID。私有请求 JSON 的必要字段是：

```json
{"requestKey":"unique_stable_key","question":"用户的问题","modelRef":"目录返回的ref","mode":"quick","knowledgeBaseId":"用户选定的ID"}
```

新问题使用新请求键，并先保存请求。续问增加原 `conversationId`；模式可为
`quick` 或 `deep`。私有 JSON 文件需 0600，不把问题放进 Shell 参数列表：

要求联网补充时显式增加 `"webSearch":true`；不要求时为 false。指定知识库
Agent 的固定 S4.16/GLM 快速 SDK→CLI 组合有真实记录；不代表本次权限或所有组合。没有网页证据时保留这次结果并说明限制，
不自动重问、换库或改模型。切换开关属于下一次新问题，使用新的请求键；
找回原任务时必须复用原始完整请求，不能改开关后仍用旧键。

```sh
ima-local ask --profile personal --input /absolute/private/request.json --stream
ima-local task --profile personal --request-key unique_stable_key --view result --json
ima-local recover-task --profile personal --request-key unique_stable_key --json
ima-local export --profile personal --request-key unique_stable_key --format json \
  --output /absolute/private/new-answer.json --json
```

流式输出为 NDJSON，先给任务编号，再给事件和最终结果。失败返回非零退出码。
正文可按 `--answer-offset` / `--answer-limit` 分页；事件按 `--after-event-id` 读取。
重复原请求不会新发一轮；结果不确定时不要生成新键绕过保护。

## 可选接入

`ima-local setup plan --profile personal --json` 返回通用 `mcpServers` JSON
配置片段，不修改宿主。只有用户批准后才合并到目标宿主的配置。
Codex 使用 `ima-local setup plan --host codex --profile personal --json`：只生成
官方 CLI 的参数数组，不执行它、不读取或改写宿主配置。先核对同名服务与
私有备份，再取得用户注册授权；不要把通用 JSON 写入 Codex 的 TOML。
此计划不证明本机已安装 Codex CLI 或原生 Agent 已加载成功。按数组逐个
参数执行，不拼接成未经转义的 Shell 字符串。不要自动执行计划中的 remove。
`setup inspect/apply/rollback` 只支持通用 JSON；不支持 TOML 或猜测宿主路径。
现有文件需私有权限；apply 需原摘要和 `--confirm`，冲突拒绝覆盖。
rollback 需私有 receipt 和 `--confirm`，目标被其他程序修改时停止。

用 `ima-local skill path --json` 定位随包 Skill，再按用户宿主支持的方式
单独安装。没有注册 MCP 也能使用 CLI；无需 Provider URL 或服务 token。
Windows/Linux 与原生宿主加载尚未验收；已有 macOS 指定版本的 SDK/CLI
联网记录不替代原生 Agent、其他适配器或本次账号权限的独立验收。
