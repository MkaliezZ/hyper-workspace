# Blue / white / black application design

User requirement: primary blue, white and black. Selected generated concept: [concept.png](concept.png), built-in Image Gen, 2026-10-29. This is a design reference, not a product screenshot or proof of working AI.

True white content; navy #161e2c rail; near-black #121826 text; royal blue #2563eb actions; #eff6ff selection; #e5e7eb dividers. System sans typography with Chinese fallbacks. Native concept extraction: 90px app rail, 264px navigation, flexible discussion area, 344px context pane at 1504 × 1045. 8px control radius; 20–28px primary gutters. Outline icons use a consistent stroke.

Native UI: Hyper Workspace / 演示工作区 / 发起任务 / 消息 / 项目 / 知识库 / 设置; project 产品共创; tabs 讨论 / 任务 / 成果; context 当前目标 / 待办 / 最新成果; document actions 查看成果 / 创建待办; composer 和团队讨论，或让 AI 帮你推进工作… / 发送. Seed examples are labelled demonstration data. Additional forms and states are necessary for the fixed C00–C07 workflows and use the same design system.

Desktop keeps three content regions. At narrow widths the context becomes a toggled drawer and navigation can collapse; primary conversation and composer remain usable. No marketing hero, metrics dashboard, fake AI-success indicators or screenshot-as-UI.

Before final UI handoff: compare concept and rendered screenshot with view_image; verify content hierarchy, panel geometry, typography, palette and controls; test desktop/mobile and real UI state transitions. Provider-backed capabilities keep explicit connection and evidence states.

## Browser and fidelity checks

Browser plugin/skill was not available in this session, so project Playwright Chromium was used. Actual screenshots: [desktop](../images/workspace-desktop.png), [mobile](../images/workspace-mobile.png). Native concept viewport 1504×1045 and mobile 390×844 were checked. Screenshots and concept were inspected with view_image.

| Comparison point | Repair or result                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| Layout           | Changed initial 64/232/300 rails to observed 90/264/344 desktop geometry                                  |
| Typography       | Increased desktop headings, navigation, avatars and message text to match concept hierarchy               |
| Palette          | True white, near-black/navy and blue retained; no external font request required                          |
| Artifact anatomy | Preserved document preview/footer; added plain-text excerpt fallback after user edits                     |
| Interaction      | Messages/tasks/revisions persist; failed delivery retains draft; fixture run returns actual saved objects |
| Responsive       | Context pane collapses, navigation toggles; 390px viewport has no horizontal overflow                     |

Above-the-fold copy follows the selected concept, with authorized Hyper Workspace naming. Intentional differences: actual message timestamps and artifact versions reflect database state; a real task-add control and current-user initial support required workflow. Seed/test data are labelled demonstration data. No decorative marketing copy or invented business metrics added.

Model settings and the knowledge panel were subsequently inspected in the running browser at 1504×1045 and 390×844. Forms retain the same palette and spacing; the knowledge controls wrap on narrow screens. Browser page errors: none; mobile horizontal overflow: false. Local review images remain in ignored .runtime; the README's main discussion screenshot remains the clean baseline capture.

The engine/model selector and a real missing-model response were also inspected in the native task dialog at both widths. The error is visible inside the modal, its heading provides the accessible dialog name, the draft remains, and controls fit the mobile viewport. Page errors: none; horizontal overflow: false. Review captures are .runtime/engine-desktop-review.png and .runtime/engine-mobile-review.png.

This initial comparison verifies only the first-stage UI surface. Native engine and Nextcloud evidence is recorded separately in IMPLEMENTATION.md; screenshots do not verify runtime execution.

### 企业身份登录增量

沿用现有蓝白黑和 H 品牌，新增独立来源授权页面入口、弹窗受阻时的链接、等待/重试/取消状态；产品不出现账号密码输入框。已查看 1504×1045 与 390×844 的实际页面截图（UI 协议 fixture，非公司来源），页面无横向溢出，主入口与取消可访问，提示文字颜色调整为 #59677b。真实 Nextcloud 授权已在独立 CI job 验证，见 NEXTCLOUD-IDENTITY.md。

### 企业通信增量

已检查 1504×1045 与 390×844 的企业会话页面：桌面会话列表/消息并排，手机以横向会话选择和消息区展示，发送框与回执恢复动作可访问，无横向溢出。资料来自 UI 协议 fixture，真实 Talk 已在独立 CI 验证，见 NEXTCLOUD-TALK.md。修正发送框标签的视觉隐藏，避免桌面出现多余横排文字。后续增加显式关联项目入口和用户发起的 AI 只读上下文；原聊天仍留在来源。

### 来源项目增量

保持既有蓝白黑；关联项目用浅蓝提示当前来源范围，工作记录与企业会话分设入口，发起任务前显示最多 60 条消息/所选模型/成果保存位置。协议 fixture 浏览器用例验证创建、来源范围提示、失权后关闭编辑器和清理草稿；截图仅代表 UI，真实来源/双引擎以独立 CI 为准。

已查看 [1504×1045 桌面](../images/source-project-desktop.png) 和 [390×844 手机](../images/source-project-mobile.png) 截图；手机无横向溢出，通过“展开导航”可进入发起任务。来源提示、工作记录及返回企业会话入口在两种宽度可见。测试首轮直接在已折叠导航中定位“发起任务”超时，修正为真实移动操作路径后复测。

### AI 个人回复草稿增量

沿用蓝白黑；会话标题区增加“AI 起草回复”，复用现有工作类型/引擎/模型选择。个人草稿位于消息滚动区，明确“仅你可见/尚未发送”，预览不覆盖人工内容；检查后可放入发送框，有人工内容时按钮明确为替换。历史默认折叠，避免持续打断聊天。已发送或待核对的草稿禁止再次放入发送框。

已查看 [桌面](../images/reply-draft-desktop.png) 和 [390×844 手机](../images/reply-draft-mobile.png) 的实际截图；无横向溢出，消息区与草稿可滚动，预览与发送框均可访问。截图使用明确 UI 协议测试资料；真实来源/两个原生引擎的验证单独记录，不从截图推断执行结果。浏览器插件在本环境不可用，继续使用项目 Playwright Chromium。

### Files 个人资料增量

知识库增加“知识检索/企业文件”标签，沿用蓝白黑与既有组件。文件选择显示支持范围和个人可见性，导入与向量索引分开；当前版本/来源不可用状态有明确提示。已检查 [1504×1045 桌面](../images/files-desktop.png) 与 [390×844 手机](../images/files-mobile.png)，文件名和按钮可换行，无横向溢出，手机滚动后可访问预览及索引动作。资料为 UI 协议 fixture，截图不证明真实公司来源或模型质量。权限与源版本变化会清理文本预览及文件检索片段，旧异步响应受范围/版本约束。
