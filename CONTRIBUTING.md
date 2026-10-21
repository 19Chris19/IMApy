# 参与 IMApy

欢迎贡献！安装说明、可复现问题、合成测试和协议证据，与新功能同样重要。

## 从哪里开始

- 文档：让首次安装、扫码、选库、恢复与 Agent 配置更易懂。
- 兼容性：反馈平台、Node 版本、浏览器版本与明确的复现步骤，不先宣称全平台支持。
- 可靠性：增加断线、迟到引用、重启恢复、未知派发和凭证提交的合成回归样本。
- 新能力：先开 Issue 讨论普通网页是否可用、请求与响应的证据、权限、完成条件和重试边界。

有想法可在[Issues](https://github.com/19Chris19/IMApy/issues)讨论；也欢迎直接提交范围清楚的 PR。

## 报告问题

提供版本、操作系统和架构、Node／浏览器版本、预期与实际行为，以及最小复现步骤。
错误只提供脱敏错误码及阶段；注明哪些步骤是真实验收，哪些是模拟。

**不要提交 Cookie、token、二维码、密钥、profile、原始 HAR／抓包、真实问题与历史。**
资料标题、摘要、URL、材料与会话 ID 也可能泄露私人内容，应替换成合成标识。
不要为复现而自动重试结果不明的任务、清除保护标记或改动生产环境。
若误提交敏感信息，应立即撤回公开内容并按相关服务要求撤销或更换凭证。

## 本地验证与 PR

使用 Node.js 22，开发命令见 [README](README.md)。测试必须使用隔离临时目录、合成身份
和本地模拟上游；完整离线测试会阻断真实 IMA 请求。

PR 请说明解决的问题、最终行为、测试结果、已知限制，以及任何兼容或恢复风险。
不要把工具发现当作真实问答验收，不按资料数组顺序猜引用，也不把候选协议写成已支持。
新增真实调用、扫码或读取必须由测试账号持有人明确决定范围；普通测试不应触发这些操作。

SDK 底层、个人状态与 Agent 入口分别在 `ima-core`、`ima-runtime`、`ima-agent` 中；
Provider 适配仍为实验路径。首版的 8 类能力范围见[验收说明](docs/ACCEPTANCE.md)。

## 修改 README 视觉素材

素材使用仓库自托管图片，不依赖截图服务、外部字体或跟踪像素。
SVG 排版、透明素材、提示词及动效参数在 `assets/readme/source/` 中，AI 插画仅作概念示意。
修改已审查图片时同步更新发布图片白名单和摘要，不绕过发布审计。
可选的素材重建需要 macOS `sips`、Python Pillow；GIF 另需 FFmpeg 和
`beautify-github-readme` Skill 的 `render_motion_gif.py`。它们不是用户安装或运行 IMApy 的依赖。

```sh
python3 scripts/build-readme.py
# 重建 GIF 时，显式传入本机已审查的 render_motion_gif.py 路径：
python3 scripts/build-readme.py --motion-renderer /path/to/render_motion_gif.py
```

## 许可

贡献按本仓库 MIT 许可提供；保留上游署名和来源证据。涉及第三方代码或素材时说明来源与许可。
