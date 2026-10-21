# IMApy

**独立使用 IMA 普通网页能力的 SDK、CLI、MCP 与 Skill。** 人工扫码后，通过
HTTP/SSE 使用指定知识库问答、模型与快速/深度模式、联网引用、同会话追问、
任务恢复、导出及凭证维护。无需 Provider A、Docker 或常驻浏览器。

当前为 **`v0.1.0-alpha.1` 开发预览版**，供个人试用与开发评审；不是稳定生产版。
安装包与校验文件见 [GitHub 预发布](https://github.com/19Chris19/IMApy/releases/tag/v0.1.0-alpha.1)。
这是非官方项目，使用已有网页协议；上游变化、账号资格和过期可能影响可用性。

**本版仅将下列 8 类已打通、具有验收依据的核心能力列为对外支持范围。其余能力
仍在开发、调研或等待验收，不属于当前可用功能承诺。** “已打通”限已验证的平台和
路径，不代表所有账号、组合、跨平台或长期生产运行均已通过。

## 快速开始

需要 Node.js 22；首次扫码已验证范围为 macOS arm64 与已有 Chromium 系浏览器。
本版没有公开 npm 发布，请从 GitHub 预发布下载 `.tgz` 和 `SHA256SUMS`，先核验摘要。

```sh
npm install --offline --ignore-scripts --omit=dev --no-audit --no-fund \
  --update-notifier=false --prefix "$HOME/.local/opt/imapy-alpha" \
  ./ima-local-standalone-0.1.0-alpha.1.tgz
```

通过安装目录的 `node_modules/.bin/ima-local` 执行：

```sh
ima-local --version
ima-local doctor --local --json
ima-local status --profile personal --json
```

本地检查不登录、不续期、不提问。本人同意后再初始化和扫码：

```sh
ima-local init --profile personal --json
ima-local login --profile personal
```

程序自动打开独立官方登录窗口，扫码和手机确认由本人完成。不要提供凭证给 Agent。
后续安装、选库、问答、SDK、MCP 和 Skill 示例见[使用指南](docs/USAGE.md)。

## 本版提供：8 类核心能力

| 功能 | 当前说明 |
| --- | --- |
| 1. 独立扫码登录 | 人工扫码、设备上下文捕获和私有保存 |
| 2. 无浏览器 HTTP 续期 | 显式刷新并保存凭证；不含跨天自动维护承诺 |
| 3. 指定知识库流式问答 | 查询可见知识库，准确选库并接收回答 |
| 4. 快速／深度模式 | 从实际模型目录选择模式 |
| 5. 模型切换 | 已测四模型；不承诺上游目录永久不变 |
| 6. 连续追问与重启延续 | 保留同一会话和账号绑定 |
| 7. 联网与精确网页引用 | 区分意图和实际证据，按明确引用键对应网页 |
| 8. 任务恢复与结果导出 | 找回已有结果；保留请求键、未知结果保护和结构化引用 |

上述能力通过 SDK、CLI 和 11 个 STDIO MCP 工具使用，Skill 提供操作与核验指引。
工具发现、Skill 可见性和模拟流程已经验证；**当前候选的真实 Agent/Skill 取材闭环
仍待验收**，不能把入口存在当成全部真实使用通过。

## 开发、调研与待验收

材料目录与全文读取、报告/PPT/播客、长期记忆、资料增删改等不在本版支持范围。
跨天自动维护、其他平台和完整 Provider 生产迁移仍待验收。Provider 适配仅作为实验
接口供开发评审，不是已交付的生产服务；代码或工具中存在实验接口不代表正式支持。

后续按普通网页可行性与逐项验收结果陆续开放，并在版本说明中明确新增能力。
路线图不是当前功能清单；尚未确认可行的能力不承诺实现或交付时间。

查看[能力与验收范围](docs/ACCEPTANCE.md)、[已知限制](docs/KNOWN_LIMITATIONS.md)、
[实验适配](docs/PROVIDER_ADAPTER.md)和[更新记录](CHANGELOG.md)。历史限定真实记录
不代表本候选所有入口、平台、账号或长期运行均通过。工具可见不等于 Agent 已完成取材。

## 安全恢复

问题放私有 0600 JSON 文件，不放命令行参数或日志。先保存请求键；断线后读取同一
任务，不换键自动重问。遇到 `outcome_unknown` 停止新请求，不删除保护强行继续。
本地密钥与密文同目录，需完整私有备份，不放 Git 或云同步目录。

## 源码开发

克隆本仓库或解压干净源码包，使用 Node 22 和锁定依赖。依赖安装允许访问 npm 注册表；以下
测试和包验证阻断真实 IMA，不需要登录、Provider 或个人 Agent 配置：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check:acceptance
npm run build
npm run pack:local
npm test
npm run check:release
```

`npm run export:source` 生成不含 `.git`、私有状态和旧研发记录的源码归档。
安装包没有运行时 npm 依赖、安装脚本、自动浏览器下载或服务启动。
源码中的 Provider 合成测试仅验证适配接口；真实宿主联合演练记录不冒充本包安装结果。

## 来源与许可

MIT。协议代码源于 [IMA QA Web Agent](https://github.com/19Chris19/ima-qa-web-agent)，
原始提交与文件摘要保留在 `docs/source-provenance.json`，本地修改另列记录。
上游版权和许可保留，打包依赖的完整许可位于 `THIRD_PARTY_NOTICES.md`。
