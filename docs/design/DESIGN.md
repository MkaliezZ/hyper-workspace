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

个人文件 AI 阅读的目标流程：企业文件 → 查看所选文本 → 选择执行器/模型并提问 → 保存个人解读 → 人工修订和版本记录；另验证慢来源撤权与迟到内容不重现。Browser plugin not available，沿用仓库 Playwright；检查标题、非空页面、Vite overlay、控制台、桌面 1504×1045 和手机 390×844 无横向溢出。首轮可见性核对发现主按钮文字与背景同色，已增加局部文字颜色规则并复核。截图为合成 UI 协议数据：[桌面个人阅读](../images/file-reading-desktop.png)、[手机个人阅读](../images/file-reading-mobile.png)。

## Page transitions — 2026-10-30

Main navigation, project selection, discussion tabs and knowledge tabs use a 180ms opacity/6px upward entrance, with subtle navigation color transitions. Animation reuses surface nodes and follows the existing navigation/editor lifecycle; a stable navigation key prevents animation during typing or background polling. No outgoing-page snapshots retain old project content. `prefers-reduced-motion` disables the entrance and navigation transitions, and changing that preference cancels an in-progress entrance. No animation dependency was added.

Browser plugin not available; local Playwright Chromium at http://127.0.0.1:5173 verified desktop 1504×1045 and mobile 390×844. Fourteen checks passed: identity, nonblank content, no overlay, draft preservation, project/knowledge-tab transitions, rapid navigation, animation timing, quiet polling, mobile overflow, reduced motion for pages/tabs/navigation colors and console health. Screenshots were inspected locally and an interaction recording was captured, all outside the repo; [CI for a359a8f](https://github.com/MkaliezZ/hyper-workspace/actions/runs/41016502773) passed all three jobs and 178 checks on the first attempt, including 37 UI scenarios. Safari/Firefox were not exercised.

## 价格与预算 — 2026-10-30

验证路径：设置 → 价格与预算 → 确认并保存单价/预算 → 实际合成 HTTP 请求 → 未知费用阻止后续请求 → 员工核对 → AI 保存确认方案。人工/AI 使用同一费用账户；页面区分估算、声明和未知，手机设置标签排为两列。

Browser plugin not available，使用项目 Playwright Chromium；本机 http://127.0.0.1:5173，桌面 1504×1045/手机 390×844。完整 40 项界面回归通过，增加控制台监听后的费用场景再次通过；未测 Safari/Firefox、真实供应商价格或公司账单。

| 检查               | 结果                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------- |
| 页面身份、有效内容 | URL/标题及产品、费用配置区域通过                                                              |
| 框架错误/控制台    | 无 Vite overlay、pageerror 或相关 error/warning；登录前 401 与用例刻意拒绝读取的 403 单独识别 |
| 交互与实际结果     | 未知消耗拒绝后 HTTP 计数不增加，核对和 AI 保存读取实际账户版本；403 后旧明细清除              |
| 视觉与响应布局     | 两种宽度截图已查看，无横向溢出，金额/表单和操作可访问                                         |

[桌面截图](../images/model-spending-desktop.png) · [手机截图](../images/model-spending-mobile.png)。截图全部为合成资料；范围、费用精度和回退见 [模块契约](../MODEL-SPENDING.md)。

## 任务说明与澄清 — 2026-10-30

路径：项目 → 任务说明草稿 → 员工回答 → 确认当前版本 → 绑定 Worker 成果 → AI 修改且保留人工草稿 → 明确读取新版本 → 失权清理。新页沿用蓝白黑，移动端四个项目标签可见；说明明确提示项目成员可见，确认与实际工作完成分开。

Browser plugin not available，沿用 Playwright Chromium；本地 http://127.0.0.1:5173，桌面 1504×1045/手机 390×844。URL/标题、非空内容、无 Vite overlay、控制台健康和实际对象回读均通过；完整 41 UI 本地及 CI 首轮通过。桌面/手机截图已逐一查看，无横向溢出，表单与操作可滚动访问。首轮通用标签匹配超时，按可访问 combobox 名称定位后通过；原 trace 保留在受限忽略目录。

[桌面](../images/work-brief-desktop.png) · [手机](../images/work-brief-mobile.png)。截图为合成资料；未测 Safari/Firefox、正式员工量规及公司环境。业务/原生/来源/容器与实际模型小样例的证据见 [说明契约](../WORK-BRIEFS.md)。

## 项目成员与员工分配 — 2026-10-30

验证路径：任务 → 项目成员（按姓名/UID/产品 ID 筛选） → 修改待办 → 选择确切员工 → 确认并保存 → AI 清除 → 回读版本/历史 → 手机布局 → 拒绝目录读取与迟到响应清理。人工和 AI 共用身份范围；文字标记与员工 ID 绑定明确分开。

Browser plugin not available，使用仓库 Playwright Chromium；http://127.0.0.1:5173，桌面 1504×1045/手机 390×844，完整 42 项界面回归本机首轮通过。

| 检查           | 结果                                                              |
| -------------- | ----------------------------------------------------------------- |
| 页面身份与内容 | URL、Hyper Workspace 标题、项目成员/任务字段及实际 ID 可见        |
| 框架 overlay   | 无 Vite overlay 或页面运行异常                                    |
| 控制台         | 无相关 error/warning；登录前 401 和用例主动拒绝的 403 已分别识别  |
| 交互回读       | 绑定 ID、规范姓名、v2 历史和 AI 清除后的 v3 均来自实际 API/Worker |
| 响应布局       | 两种宽度截图逐一查看；对话框/页面无横向溢出，操作和历史可滚动访问 |
| 缓存与迟到响应 | 拒绝后同时清理同项目目录视图、搜索及模型选项，旧请求不能恢复名单  |

[桌面截图](../images/task-assignment-desktop.png) · [手机截图](../images/task-assignment-mobile.png)。全为合成资料；Safari/Firefox、正式员工量规和公司环境未测。源码/原生/来源/容器证据见 [成员与分配契约](../PROJECT-DIRECTORY-ASSIGNMENTS.md)。

## 接收消息附件 — 2026-10-30

验证路径：企业消息 → 受限附件卡片 → 二进制下载 → 查看来源链接 → 手机布局 → 切换房间清除卡片。仅展示来源引用，明确 AI 未读取正文；大文件/来源限制不显示产品下载入口。

Browser plugin not available，使用项目 Playwright Chromium；http://127.0.0.1:5173，桌面 1504×1045/手机 390×844。新增场景和原企业消息两个场景均通过；URL/标题、有效内容、无框架 overlay、无相关控制台错误、实际下载事件与房间切换结果已检查。两种截图逐一查看，无横向溢出；手机第二张卡片需在消息区滚动，编辑框固定可用。完整界面回归待记录；Safari/Firefox、真实公司资料未测。

[桌面](../images/message-attachments-desktop.png) · [手机](../images/message-attachments-mobile.png)。均为合成界面资料。真实来源权限与二进制响应头另由来源 CI 核验，不能从 UI fixture 推断已通过。

完整界面首轮 42 通过、1 失败：定时跟进迟到响应场景在创建项目时收到空 500，JSON 解码失败，原 trace 已保留在受限忽略目录。与开发模式代码重载窗口重合，尚不能仅凭此认定产品逻辑缺陷；停止源码写入后重跑完整界面，并以 CI 独立启动结果复核，不弱化断言。

停止源码写入后的完整 43 项 UI 重跑全部通过（3.7 分钟）；原失败场景也通过。保留首轮失败，不把重跑记成首轮通过；独立 CI 结果待回填。
