# Windows 安装与登录适配（实验）

Windows 10/11、Node 22、已安装的 Chrome 或 Edge 是本次适配目标。本机回归在 macOS 执行；Windows CI 只核对本地文件、合成凭据和自有进程，不代表真实扫码、问答或长期维护已经验收。用户反馈的临时补丁成功不等于本 PR 已获真实验收。

## 本次修复

| 问题 | 修复 |
| --- | --- |
| 初始化直接拒绝 Windows | 使用 Windows ACL 验证，不提供跳过权限的环境开关 |
| 对目录调用 POSIX fsync 导致初始化失败 | Windows 继续逐文件 flush、替换、代际检查与未知提交保护；不调用不适用的目录打开/flush |
| 登录驱动只接受 macOS | 增加 Windows Chrome/Edge 默认路径及显式 `.exe` 路径 |
| `.exe` 没有 POSIX 执行位而被拒绝 | Windows 检查本地绝对路径、普通文件及 `.exe`，保留符号链接/不合法路径拒绝 |
| Chrome 临时 lockfile 占用导致登录态丢失 | 证明自有浏览器退出、校验身份并提交后，再有限重试删除临时目录；失败返回 `saved=true`、`cleanup.state=deferred` |
| 清理异常覆盖原始失败 | 保留原始登录失败原因；无法证明浏览器退出时仍保留私有目录且不发布登录态 |
| Windows Git 默认换行转换导致构建时证据注册表不一致 | 用 `.gitattributes` 固定文本为 LF、图片为二进制，保留原有字节摘要和严格构建校验 |

不使用 `IMA_UNSAFE_ALLOW_WIN32`，不自动提权，不更改已有目录或其他用户文件的 ACL。只为本次新建的空状态目录、空私有文件建立 ACL 和当前用户所有权，在写入凭据前完成检查；已有路径必须通过检查。当前要求本地固定 NTFS/ReFS 卷、当前用户所有者；允许当前用户及 Windows SYSTEM/Administrators 的授权，拒绝其他 Allow 项、UNC、网络卷和重解析点。需要系统自带的 Windows PowerShell，检查失败时停止，不降级为无权限校验。

Windows 的目录刷盘限制意味着**不能声称与 POSIX 路径具有相同的断电持久性**。状态会报告 `storageDurability=file_flush_atomic_replace_no_directory_flush`；保留文件 flush、提交意图、加密、互斥和恢复检查。系统断电/文件系统故障的整套恢复仍待单独验收。

## 本机准备

在项目目录内运行：

```powershell
node --version # 使用 Node 22
npm ci --ignore-scripts --no-audit --no-fund
npm run build
node bin/ima.mjs doctor --local --json
node bin/ima.mjs init --profile personal --json
```

本人准备好后再扫码；没有检测到默认浏览器时显式选择已安装的浏览器：

```powershell
node bin/ima.mjs login --profile personal --browser-path "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
node bin/ima.mjs status --profile personal --json
```

`stored_unverified` 表示已私有保存，尚未证明当前上游权限。状态检查不会自动提问、续期或扫码。输入 JSON 和导出目录也需满足私有 ACL，建议放在已通过检查的状态目录下。无需关闭杀毒软件或使用管理员终端。

如果返回 `saved=true` 但 `cleanup.state=deferred`，登录态已保存；不要因此重复扫码。临时目录留在对应 profile 的 `.login-*` 下，不会在下一次状态检查时自动清除或复用。先正常关闭本次临时浏览器，确认没有相关进程后，再由本人整理保留目录。程序只按自己启动的 PID 清理进程树，不关闭日常 Chrome/Edge。

## 依据与验收范围

- 原始 Windows 反馈只保留本机；本说明不包含用户登录态、真实材料、问题或历史。
- [Node 22 文件系统说明](https://nodejs.org/docs/latest-v22.x/api/fs.html)：Windows 权限语义与 `fs.rm` 的有限重试。
- [Windows ACL](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/get-acl?view=powershell-5.1)：按安全标识符校验访问授权。
- [Windows 目录句柄](https://learn.microsoft.com/en-us/windows/win32/fileio/obtaining-a-handle-to-a-directory)：目录句柄不等同于普通文件句柄。
- 新增 Windows CI：原生 ACL、初始化/状态/doctor、合成登录与重启恢复、拒绝 Everyone 访问、自有进程树退出。真实扫码和问答须另行授权，不计入离线 CI。
