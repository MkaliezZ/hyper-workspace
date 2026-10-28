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

This comparison verifies the implemented first-stage UI surface. DSH/Hermes model execution and Nextcloud integration remain unverified and are not inferred from screenshots.
