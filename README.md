# IMApy

<p align="center">
  <img src="assets/readme/hero.png" width="100%" alt="IMApy：把 IMA 接进你的工作流。人工扫码登录，后续通过 HTTP/SSE 调用；提供 SDK、CLI、MCP 与 Skill。">
</p>

<p align="center">
  <a href="https://github.com/19Chris19/IMApy/releases/tag/v0.1.0-alpha.2">下载预览版</a> ·
  <a href="docs/USAGE.md">使用指南</a> ·
  <a href="docs/ACCEPTANCE.md">验收范围</a> ·
  <a href="CONTRIBUTING.md">参与贡献</a>
</p>

**把个人 IMA 网页账号接入代码和 Agent 工作流。** 本人完成官方扫码后，使用指定
知识库流式问答、切换模型与快速／深度模式、连续追问、核对联网引用、恢复任务和导出。
独立运行，无需 Provider A、Docker 或常驻浏览器。

> **`v0.1.0-alpha.2` · 开发预览版**
>
> 本版仅支持下方 8 类已打通、具有验收依据的核心能力，供个人试用与开发评审。
> 不是稳定生产版，也不是腾讯官方 SDK。上游协议、账号资格和登录过期可能影响可用性。

## 一次登录，接入你的工作流

<picture>
  <source media="(prefers-reduced-motion: reduce)" srcset="assets/readme/workflow.png">
  <img src="assets/readme/workflow.gif" width="100%" alt="流程示意：本人在官方网页扫码，IMApy 独立 SDK 通过 HTTP/SSE 调用，再由 CLI、MCP 和 Skill 接入工作流。">
</picture>

*概念插画与流程示意，非真实问答录像。可查看[静态流程图](assets/readme/workflow.png)。*

- **登录由本人完成。** 程序打开独立官方扫码窗口，扫码和手机确认后私有保存必要上下文。
- **日常调用不占着浏览器。** 问答与显式凭证续期使用 HTTP/SSE；到期或上游变化仍可能需要重扫。
- **保留证据和任务边界。** 联网意图与实际网页证据分开；断线后读取原任务，结果不确定时停止，避免盲目重问。

SDK、CLI、11 个 STDIO MCP 工具和 Skill 是同一套能力的入口。已完成工具发现、Skill
可见性和模拟流程验证；**当前候选的真实 Agent／Skill 取材闭环仍待验收**。

## 先在本地跑起来

需要 **Node.js 22**。首次扫码已验证范围为 **macOS arm64 + 已安装的 Chromium 系浏览器**。

Windows 已加入实验性权限、浏览器与登录清理适配，参见 [Windows 安装与限制](docs/WINDOWS.md)。离线 CI 与真实扫码验收分别记录，不将用户的临时补丁结果当作本版已通过。
本版没有公开 npm 发布；从[预发布页面](https://github.com/19Chris19/IMApy/releases/tag/v0.1.0-alpha.2)
下载该页的安装包、源码包、验收文件和 `SHA256SUMS`，放在同一目录核对后安装：

```sh
shasum -a 256 -c SHA256SUMS
npm install --offline --ignore-scripts --omit=dev --no-audit --no-fund \
  --update-notifier=false --prefix "$HOME/.local/opt/imapy-alpha" \
  ./ima-local-standalone-0.1.0-alpha.2.tgz
export PATH="$HOME/.local/opt/imapy-alpha/node_modules/.bin:$PATH"

ima-local --version
ima-local doctor --local --json
ima-local status --profile personal --json
```

这些本地检查不登录、不续期、不提问。安装不自动注册 Agent、下载浏览器或启动服务。
本人准备好后再创建独立 profile 并扫码：

```sh
ima-local init --profile personal --json
ima-local login --profile personal
```

随后按[使用指南](docs/USAGE.md)选择知识库、模型并提问；SDK、CLI、MCP 和 Skill 示例
均在其中。不要将 Cookie、token、二维码或 profile 文件发给 Agent 或贴进 Issue。

## 本版明确提供的 8 类能力

| 能力 | 已提供的功能与边界 |
| --- | --- |
| 独立扫码登录 | 人工扫码、设备上下文捕获、私有保存 |
| 无浏览器 HTTP 续期 | 显式刷新并保存凭证；不含跨天自动维护承诺 |
| 指定知识库流式问答 | 查询可见知识库，准确选库并接收回答 |
| 快速／深度模式 | 从实际模型目录选择模式 |
| 模型切换 | 已测四模型；以当前目录和账号资格为准 |
| 连续追问与重启延续 | 保留同一会话和账号绑定 |
| 联网与精确网页引用 | 区分意图和实际证据，按明确引用键对应网页 |
| 任务恢复与结果导出 | 保留请求键、未知结果保护和结构化引用 |

“已打通”限记录中已验证的平台和路径，不代表所有账号、模型组合、跨平台或长期
生产运行均已通过。实现、合成测试与限定真实验收分开记录，见[能力与验收范围](docs/ACCEPTANCE.md)。

## 接下来做什么

材料目录与全文读取、报告／PPT／播客、长期记忆、资料增删改等，仍在开发、调研或等待
验收，**不属于本版支持范围**。跨天自动维护、其他平台及完整 Provider 生产迁移同样待验收。

Provider 适配代码仅供实验评审。未来能力按普通网页可行性逐项验证，再在版本说明中
开放；路线图不代表当前可用，也不承诺尚未确认可行的功能或交付时间。

[已知限制](docs/KNOWN_LIMITATIONS.md) · [实验适配](docs/PROVIDER_ADAPTER.md) · [更新记录](CHANGELOG.md)

## 欢迎一起把它打磨好

**欢迎提交 Issue 和 Pull Request。** 不必先理解整套协议：补一段更清楚的安装说明、
报告一次可复现的问题、增加一个合成回归样本，都是有价值的贡献。

我们尤其欢迎安装与兼容性反馈、引用和恢复测试、网页协议变化的脱敏证据，以及
SDK／CLI／MCP／Skill 使用文档。新能力请先讨论网页可行性、证据与验证范围。

[报告问题或讨论想法](https://github.com/19Chris19/IMApy/issues) ·
[阅读贡献指南](CONTRIBUTING.md) ·
[查看 Pull Requests](https://github.com/19Chris19/IMApy/pulls)

## 安全恢复与本地开发

问题放私有 0600 JSON 文件，不放命令行参数或日志。保存原请求键；断线后读取同一
任务，不换键自动重问。遇到 `outcome_unknown` 停止新请求，不删除保护强行继续。
密钥与密文同目录，需完整私有备份，不放 Git 或云同步目录。

克隆仓库或解压干净源码包，使用 Node 22 和锁定依赖：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check:acceptance
npm run build
npm run pack:local
npm test
npm run check:release
```

依赖安装允许访问 npm 注册表；测试和包验证阻断真实 IMA，不需要登录、Provider 或
个人 Agent 配置。安装包没有运行时 npm 依赖。`npm run export:source` 导出干净源码；
原始研发记录和真实私有数据不在其中。视觉素材源文件与说明见 [README 素材](assets/readme/source/ART_DIRECTION.md)。

## 来源与许可

MIT。协议代码源于 [IMA QA Web Agent](https://github.com/19Chris19/ima-qa-web-agent)，
原始提交与文件摘要保留在 `docs/source-provenance.json`，本地修改另列记录。
上游版权与许可保留；依赖许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

### 文件上传开发进度

上传与批量入库正在本地开发，尚未列入已支持能力。格式研究覆盖 11 类、22 个后缀，真实网页与 SDK 上传均待逐类验收；候选中的本地规划、加密队列及六个工具不代表已经接通 IMA 上传。[查看进度、使用入口与安全恢复](docs/UPLOADS.md)。

2026-10-22 的真实入口核对发现：独立测试账号个人库的导入按钮要求前往客户端。已按网页范围停止，实际上传与续期均为 0；未将这次检查记作上传通过。各格式继续待验收，详见上述进度说明。
