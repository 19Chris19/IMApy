# 回答依据核验

返回 [Skill 主流程](../SKILL.md)。在导出、写教程或给出带来源结论前读取。

1. 核对任务 `status` 与 `complete`。`succeeded` 且 `complete=true` 才是完整
   成功回答。`failed`、`cancelled`、`indeterminate` 和缺完成事件均标注为部分结果。
2. 通过 `ima_task(view=result)` 或导出取得最终 `citationMap`。流式期间的
   来源可能迟到；不能把早期列表当作完整映射，也不能漏掉终态补充的编号。
3. 用正文原引用键查映射，再读取其 `displayNumbers`、`type` 与明确来源。
   显示编号不等于引用键；来源顺序、标题相似度、URL 样式不能用于猜配。
   新版 `citationReferences` 按正文真实目标逐项列出：`web_linked` 可对应网页；
   `knowledge_typed` 仅确认知识库来源类型，不代表读过原文；`unknown`、
   `conflicted`、`missing_source`、`missing_metadata` 均保留为具体缺口。
   `citationReferencesTruncated=true` 表示诊断达到数量上限，不能宣称覆盖全文。
   原答案和已保存引用仍保留，不覆盖旧导出。
4. `unknown`、缺编号、冲突或缺材料 ID 时说明不能回溯。不从 sources 的
   第 N 项补角标 N，也不修改旧导出来掩盖缺口。
5. 知识库角标先查 `knowledgeCitations.citations[原引用键]`。只有
   `status=identified` 才能使用 `materialCandidates` 中的明确材料 ID；候选
   可能有多个，不擅自挑一个。`scope_unproved`、`identity_missing`、
   `conflicted`、`type_unproved`、`missing` 都保留为未定位；`not_knowledge`
   表示应按网页引用检查。没有该字段的旧结果仍只报告类型，不猜补 ID。
   `readAuthorization=not_evaluated`、`originalReadAuthorized=false` 和
   `contentVerified=false` 明确表示没有原文权限证明，也没有核对全文。
   网页来源可使用明确提供的标题、网址和摘要；摘要不代表已完整读网页。
6. 只有 `webEvidenceStatus=verified` 才报告已取得可核验网页依据。
   `not_observed` 表示终态未观察到可靠网页来源；`unverified` 表示证据不足
   或矛盾。联网开关、处理文案、能力声明和回答自称联网均不能替代证据。
   正的来源计数也不能代替引用键到可用网页的明确关系。即使整体网页证据
   为 verified，仍逐项检查当前引用；其他角标可能缺元数据或类型不明。
7. 把用户结论、上游回答和原始来源证据分开。要求精确原文却只有摘要时，
   说明范围限制；本阶段不调用材料正文接口，也不绕过网页转客户端限制。
   引用准确对应不代表优先选到了官方来源；正文里的官方地址也不证明
   对应网页已被检索或读取。官方原文未核验时明确说明，不自动追加搜索。
8. 保留准确引用图谱、任务与会话编号，再整理内容。推荐追问只作为候选
   文本，未经用户请求不发送。失败或缺证据不自动调用另一个模型凑结果。

MCP 默认返回摘要，正文分页不能丢尾页。超大元数据会明确拒绝工具响应，
改用 CLI 导出保存到私有新文件；不通过静默截断来源来缩小结果。
导出含当前读取时间 `observedAt`；新导出的读取时间可以变化，既有文件不覆盖。
CLI Markdown 文件只含正文；要在其他工作中复用精确关系，另存 JSON 导出。
MCP 的结构化 Markdown 导出同时含引用元数据，不能在复制正文时假称这些
元数据也已随正文保存。未知任务的上游历史检查目前仅有 SDK 方法，不尝试
调用未注册的 MCP 工具，也不将只读结果冒充原任务成功或继续派发授权。
