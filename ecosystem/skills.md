# MJ Code 官方技能目录（255 个主流 Skill）

本目录为 MJ Code 桌面端内置的官方技能集合，遵循 Agent Skills 开放规范：
每个技能位于 `skills/<id>/SKILL.md`，包含 YAML frontmatter（`name`、`description`）与 Markdown 正文。
产品可直接将 `ecosystem/skills` 作为 skillsRoot 加载；技能目录名与 `name` 字段一致。

- 技能总数：**255**
- 分类数量：**13**
- 数据文件：`skills.json`（结构化定义，含分类、标签、工具与权限元数据）
- 技能目录：`skills/<id>/SKILL.md`（可直接加载）

## 分类分布

| 分类 | 数量 |
| --- | --- |
| 专家技能 | 119 |
| 业务运营与增长 | 21 |
| 行业应用场景 | 17 |
| 团队协作与流程 | 16 |
| 安全与合规 | 15 |
| 文档与写作 | 11 |
| 数据与数据库 | 9 |
| DevOps 与云原生 | 9 |
| 测试与质量 | 8 |
| 产品与需求 | 8 |
| 前端与设计 | 8 |
| 代码评审与重构 | 7 |
| AI 与智能体 | 7 |

## 技能清单

### 专家技能（119）

| 序号 | ID | 名称 | 说明 | 触发场景 |
| --- | --- | --- | --- | --- |
| 1 | `agent-harness-architect` | agent-harness-architect | Agent Harness 架构设计师。基于通用框架 H=(E,T,C,S,L,V)+P 完成架构设计：澄清需求、吸收用户核心创意、给出专业方案、产出可直接编码的设计文档，并维护自进化知识库（agent harness 框架 + 跨领域设计模式）。触发场景：用户提出「设计 agent 架构」「帮我设计 harness」「@agent-harness」、只有一个 idea 想做成 agent、提供需求分析文档要求架构设计、或想评估/重构已有 agent 架构。 |  |
| 2 | `agentic-ai-research` | Agentic技术调研 | 检索顶会顶刊的 Agentic AI 最新研究成果，产出一份给人看的研究简报。用 H=(E,T,C,S,L,V)+P 框架作为筛选镜头，通过 WebSearch 检索（不配 key、不求出源 pdf），读摘要+引言理解真实贡献，产出研究简报.md。本技能只负责检索与整理，**不做任何 wiki 写入**——入库由知识底座统一负责。触发场景：用户提出「检索顶会论文」「agentic ai 研究简报」「@agentic-ai-research」或想了解某个 agent 子领域的最新顶会顶刊成果。 |  |
| 3 | `coding-prompt` | 编程提示词优化 | AI coding prompt optimizer and coach. This skill should be used whenever the user is writing programming prompts or instructions to an AI during active coding sessions— including when starting new features, correcting AI's direction, reviewing code, requesting tests, debugging issues, or preparing delivery. Trigger when, explicit request to optimize/improve/refine a prompt, the user activates this skill (激活编程提示词), or during coding tasks where instructions to AI are vague, missing constraints, missing acceptance criteria, or could benefit from prompt engineering best practices. Also trigger when the user says "更新技能" or "update skill" to evolve this skill's knowledge base. Do NOT trigger for non-coding prompts or general chat. |  |
| 4 | `wiki-creator` | wiki知识库 | Builds and maintains a zero-vector, zero-chunk global knowledge wiki from user-uploaded documents using the Karpathy-native LLM Wiki paradigm (two-level topic/page index, multi-hop reasoning, controlled cascade updates). Invoke on create/update/query/lint wiki intents, and check the wiki FIRST for knowledge questions before web search. No vector retrieval. |  |
| 5 | `github` | github | Interact with GitHub using the `gh` CLI. Use `gh issue`, `gh pr`, `gh run`, and `gh api` for issues, PRs, CI runs, and advanced queries. |  |
| 6 | `ai-content-production` | ai-content-production | \| |  |
| 7 | `data-analysis-engine` | data-analysis-engine | \| |  |
| 8 | `agent-browser-core` | agent-browser-core | OpenClaw skill for the agent-browser CLI (Rust-based with Node.js fallback) enabling AI-friendly web automation with snapshots, refs, and structured commands. |  |
| 9 | `agent-team-orchestration` | agent-team-orchestration | Orchestrate multi-agent teams with defined roles, task lifecycles, handoff protocols, and review workflows. Use when: (1) Setting up a team of 2+ agents with different specializations, (2) Defining task routing and lifecycle (inbox → spec → build → review → done), (3) Creating handoff protocols between agents, (4) Establishing review and quality gates, (5) Managing async communication and artifact sharing between agents. |  |
| 10 | `deep-research` | deep-research | Structured deep research workflow with human-in-the-loop control. Use /research to generate research outline, /research-deep for parallel web search across items, /research-report to compile markdown reports. Supports academic research, benchmark research, technology selection, market analysis, and due diligence. Triggers: 'deep research', 'research topic', 'benchmark comparison', 'technology survey', 'market analysis'. Requires: WebSearch capability. |  |
| 11 | `fullstack-dev` | fullstack-dev | \| |  |
| 12 | `cloudq` | CloudQ | 用户咨询腾讯云产品资源、AWS、阿里云等多云资源时，查看智能顾问架构图、架构目录、架构详情、架构评估结果、绘制架构图、开通智能顾问时、AI智能巡检、AI容量监测、AI混沌演练、AI云诊断、主动预警、架构健康度、云运维问答、云资源查询、云成本优化、安全合规、云资源盘点、闲置资源检查、云产品最佳实践等AIOps、ChatOps、CloudOps操作时使用。 |  |
| 13 | `aicoding-team-bootstrap` | aicoding-team-bootstrap | 当用户要求启动、恢复或执行 AICoding 架构 Team 时使用。负责根据项目内 agents、manifest 和 templates 建立可运行的 Team。 |  |
| 14 | `diagrams-generator` | diagrams-generator | Generate professional diagrams including cloud architecture, data charts, academic figures, and more. Triggers on requests like "画架构图", "画图表", "画论文插图", "生成系统图", "create diagram", "visualize data", "draw neural network", or when users provide a sketch/image they want to recreate professionally. |  |
| 15 | `docx` | docx | Use this skill whenever the user wants to create, read, edit, or manipulate Word documents (.docx files). Triggers include: any mention of 'Word doc', 'word document', '.docx', or requests to produce professional documents with formatting like tables of contents, headings, page numbers, or letterheads. Also use when extracting or reorganizing content from .docx files, inserting or replacing images in documents, performing find-and-replace in Word files, working with tracked changes or comments, or converting content into a polished Word document. If the user asks for a 'report', 'memo', 'letter', 'template', or similar deliverable as a Word or .docx file, use this skill. Do NOT use for PDFs, spreadsheets, Google Docs, or general coding tasks unrelated to document generation. |  |
| 16 | `pdf` | pdf | Use this skill whenever the user wants to do anything with PDF files. This includes reading or extracting text/tables from PDFs, combining or merging multiple PDFs into one, splitting PDFs apart, rotating pages, adding watermarks, creating new PDFs, filling PDF forms, encrypting/decrypting PDFs, extracting images, and OCR on scanned PDFs to make them searchable. If the user mentions a .pdf file or asks to produce one, use this skill. |  |
| 17 | `pptx` | pptx | Use this skill any time a .pptx file is involved in any way — as input, output, or both. This includes: creating slide decks, pitch decks, or presentations; reading, parsing, or extracting text from any .pptx file (even if the extracted content will be used elsewhere, like in an email or summary); editing, modifying, or updating existing presentations; combining or splitting slide files; working with templates, layouts, speaker notes, or comments. Trigger whenever the user mentions \"deck,\" \"slides,\" \"presentation,\" or references a .pptx filename, regardless of what they plan to do with the content afterward. If a .pptx file needs to be opened, created, or touched, use this skill. |  |
| 18 | `tcloud-arch-diagram` | tcloud-arch-diagram | 系统架构图绘制。当需要绘制任何系统架构图、云架构设计图、微服务架构图、Serverless架构图、混合云架构图时使用此技能，支持腾讯云及通用架构场景。基于 Draw.io XML 生成 .drawio 文件，支持二次可视化编辑。 |  |
| 19 | `tech-research-advisor` | tech-research-advisor | 专业技术选型与方案调研顾问。当用户需要做技术选型决策、调研某项技术方向、评估候选方案、寻找最优解时使用。支持：学术论文检索（ArXiv/Google Scholar）、大厂工程博客分析、竞品/开源方案对比、跨行业类比迁移、多维评估打分矩阵、结合业务约束给出可落地的双方案推荐。触发词：技术选型、技术调研、方案调研、技术评估、调研一下、研究一下技术方案、怎么做比较好、业界怎么做、有哪些方案、选哪个好。 |  |
| 20 | `xlsx` | xlsx | Use this skill any time a spreadsheet file is the primary input or output. This means any task where the user wants to: open, read, edit, or fix an existing .xlsx, .xlsm, .csv, or .tsv file (e.g., adding columns, computing formulas, formatting, charting, cleaning messy data); create a new spreadsheet from scratch or from other data sources; or convert between tabular file formats. Trigger especially when the user references a spreadsheet file by name or path — even casually (like \"the xlsx in my downloads\") — and wants something done to it or produced from it. Also trigger for cleaning or restructuring messy tabular data files (malformed rows, misplaced headers, junk data) into proper spreadsheets. The deliverable must be a spreadsheet file. Do NOT trigger when the primary deliverable is a Word document, HTML report, standalone Python script, database pipeline, or Google Sheets API integration, even if tabular data is involved. |  |
| 21 | `aihot` | aihot | AI HOT (aihot.virxact.com) 中文 AI 资讯查询 Skill。当用户想知道"今天 AI 圈有什么"、"AI 日报"、"AI HOT"、"AI 资讯"、"AI 热点"、"最近 AI"、"OpenAI/Anthropic/Google 最近发布了什么"、"AI hot today"、"AI news today"、"看一下 AI 行业动态"、"今天有什么大模型发布"、"昨天 AI 圈"、"看下精选条目"、"AI HOT 精选"、"最近一周的 AI 论文"、"AI 模型发布"、"AI 产品发布"、"AI 行业动态"、"AI 技巧与观点" 等任何中文 AI 资讯查询时使用。即使用户只说"AI 圈"、"AI 新闻"、"AI 日报"，或者只是问"今天发生了什么"且上下文是 AI / 大模型 / LLM / 创业领域，也应该触发本 Skill。Skill 会直接 curl 公开 REST API 拉数据并整理成中文 markdown 简报，不需要用户配置任何 API Key 或 MCP server。**不要 undertrigger**——用户问 AI 资讯而你不调本 Skill 就是把过时的训练数据当作今日新闻，对用户有害。 |  |
| 22 | `agentic-opc-workflow` | agentic-opc-workflow | \| |  |
| 23 | `cognitive-disarmament` | cognitive-disarmament | \| |  |
| 24 | `socratic-alignment` | socratic-alignment | \| |  |
| 25 | `knowledge-business` | knowledge-business | 创业庄园知识模块·商业财务。包含商业模型约束、财务仪表盘、现金流、预算。对应《创业可以学》第5-6章。被 manor-judge 调用，不直接面向用户触发。当用户问题涉及"商业模式/财务/现金流/预算/模型太重/盈利/成本"时由 manor-judge 读取本 skill。 |  |
| 26 | `knowledge-growth` | knowledge-growth | 创业庄园知识模块·成长转型。包含手艺磨练、实战环境、转型观、三阶段人生。对应《创业可以学》第11-12章 + 创能量 + 创业的盲点。被 manor-judge 调用，不直接面向用户触发。当用户问题涉及"成长/转型/手艺/学习/阶段/倦怠/职业发展/创能量"时由 manor-judge 读取本 skill。 |  |
| 27 | `knowledge-gtm` | knowledge-gtm | 创业庄园知识模块·客户GTM。包含目标人群、客户选择、GTM框架、销售阶段、关键活动。对应《创业可以学》第3-4章。被 manor-judge 调用，不直接面向用户触发。当用户问题涉及"客户/目标人群/GTM/销售阶段/钩子/客户选择/切入点"时由 manor-judge 读取本 skill。 |  |
| 28 | `knowledge-org` | knowledge-org | 创业庄园知识模块·人执行组织。包含人是结果、系统自运转、环境设计、舞台交付、沟通、猴子管理。对应《创业可以学》第7-10章。被 manor-judge 调用，不直接面向用户触发。当用户问题涉及"团队/招人/执行/管理/沟通/环境/舞台/系统/盯人"时由 manor-judge 读取本 skill。 |  |
| 29 | `knowledge-sequence` | knowledge-sequence | 创业庄园知识模块·顺序判断。包含顺序框架、判断能力、关口识别。对应《创业可以学》第1-2章。被 manor-judge 调用，不直接面向用户触发。当用户问题涉及"顺序/判断/关口/为什么忙没结果/先后"时由 manor-judge 读取本 skill。 |  |
| 30 | `manor-host` | manor-host | 创业庄园庄主的接待与人设层。负责身份识别、新用户进庄、接待流程、灯塔五步前两步（识别+接住）。触发场景：(1)新用户第一次进庄 (2)用户打招呼/寒暄/自我介绍 (3)不确定对方身份时 (4)用户主动问"你是谁""这里是什么地方" (5)用户只聊天不涉及具体创业问题。与 manor-judge 互斥触发：本 skill 只负责接待和身份识别，不回答具体创业问题。 |  |
| 31 | `manor-judge` | manor-judge | 创业庄园庄主的判断与回答层。负责具体创业问题的识别、回答组织、一语道破、追问收尾。触发场景:(1)用户提出具体创业问题(明确痛点、场景、困惑) (2)用户问体系根概念(OPC/GTM/目标人群/销售阶段等) (3)用户描述经营现状(忙没结果、客户模糊、销售难、模型重、执行靠盯、团队弱、转型难等)。与 manor-host 互斥触发:本 skill 不负责接待,只负责判断和回答。调用5个 knowledge 模块获取知识支持。 |  |
| 32 | `anti-distill` | anti-distill | Anti-distillation defense for employee Skills. Clean your skill files to look complete but with core proprietary knowledge neutralized. Use when user wants to protect trade secrets, sanitize forced knowledge transfers, or create safe-to-submit skill documents. |  |
| 33 | `humanizer` | humanizer | Remove signs of AI-generated writing from text. Use when editing or reviewing text to make it sound more natural and human-written. Detects and fixes patterns including: inflated symbolism, promotional language, superficial analyses, vague attributions, em dash overuse, rule of three, AI vocabulary words, negative parallelisms, and excessive conjunctive phrases. |  |
| 34 | `minimax-docx` | minimax-docx | > |  |
| 35 | `novel-writer` | novel-writer | 章节正文生成器 - 根据章节大纲、Voice Profile 和角色档案构建 LLM 提示词，用于生成章节正文。当需要根据大纲创作具体章节时使用。 |  |
| 36 | `novel-writing` | novel-writing | AI长篇网文创作技能包。用于解决长篇网络小说创作中的核心痛点：上下文丢失、文风不一致、设定冲突、节奏失控、多线混乱、质量不稳、读者反馈无法内化。触发场景包括：开始新书、规划大纲、撰写章节、管理伏笔、检测冲突、读者反馈分析、批量创作质量控制。 |  |
| 37 | `browser-use` | browser-use | Automates browser interactions for web testing, form filling, screenshots, and data extraction. Use when the user needs to navigate websites, interact with web pages, fill forms, take screenshots, |  |
| 38 | `analytics-reporting` | analytics-reporting | Build polished analytical reports, dashboards, and product/business analyses. Use when the user needs a durable report (executive or technical), an analytical dashboard with clear metrics, or a data-backed product/business analysis to inform decisions. Covers report building, dashboard construction, and decision-oriented quantitative analysis. |  |
| 39 | `data-quality-assessment` | data-quality-assessment | Assess whether datasets are trustworthy for analysis, modeling, dashboards, or pipelines; and validate finished analyses before sharing. Use for data quality checks (grain, freshness, nulls, duplicates, schema drift, joins, integrity, distributions) and analysis QA (methodology review, calculation verification, visualization checks, confidence assessment). |  |
| 40 | `data-visualization` | data-visualization | Design, specify, implement, revise, and QA quantitative visuals and chart choices. Use when an analytical answer needs visual judgment—comparing values, showing composition, reading concentration, understanding movement over time, or building chart specifications for reports and dashboards. |  |
| 41 | `kpi-design` | kpi-design | Design KPI frameworks, set targets, develop measurement plans, and estimate market/opportunity sizes (TAM/SAM/SOM). Use when success metrics, drivers, guardrails, targets, or measurement approach need to be defined or improved, or when a market or opportunity size estimate is needed. |  |
| 42 | `metric-diagnostics` | metric-diagnostics | Diagnose why a metric changed or differs from expectation, and produce leadership-ready KPI updates. Use when the user needs to understand what drove a metric movement, anomaly, or discrepancy, or when producing WBR/MBR/QBR summaries, scorecards, target pacing readouts, or performance updates. |  |
| 43 | `design-systems` | design-systems | \| |  |
| 44 | `prototype-templates` | prototype-templates | \| |  |
| 45 | `quality-review` | quality-review | \| |  |
| 46 | `design-reference` | design-reference |  |  |
| 47 | `frontend-dev` | frontend-dev | \| |  |
| 48 | `impeccable` | impeccable | \| |  |
| 49 | `design-to-code-workflows` | design-to-code-workflows | 将 Figma 设计和截图转换为生产就绪的代码组件，内置无障碍性支持 |  |
| 50 | `catalyst-calendar` | catalyst-calendar | Build and maintain a calendar of upcoming catalysts across a coverage universe — earnings dates, conferences, product launches, regulatory decisions, and macro events. Helps prioritize attention and position ahead of events. Triggers on "catalyst calendar", "upcoming events", "what's coming up", "earnings calendar", "event calendar", or "catalyst tracker". |  |
| 51 | `company-tearsheet` | company-tearsheet | \| |  |
| 52 | `comps-valuation` | comps-valuation | \| |  |
| 53 | `dcf-model-builder` | dcf-model-builder | \| |  |
| 54 | `earnings-analysis` | earnings-analysis | Create professional equity research earnings update reports (8-12 pages, 3,000-5,000 words) analyzing quarterly results for companies already under coverage. Fast-turnaround format focusing on beat/miss analysis, key metrics, updated estimates, and revised thesis. Includes 1-3 summary tables and 8-12 charts. Use when user requests "earnings update", "quarterly update", "earnings analysis", "Q1/Q2/Q3/Q4 results", or post-earnings report. |  |
| 55 | `earnings-preview` | earnings-preview | Build pre-earnings analysis with estimate models, scenario frameworks, and key metrics to watch. Use before a company reports quarterly earnings to prepare positioning notes, set up bull/bear scenarios, and identify what will move the stock. Triggers on "earnings preview", "what to watch for [company] earnings", "pre-earnings", "earnings setup", or "preview Q[X] for [company]". |  |
| 56 | `event-scenario-analyzer` | event-scenario-analyzer | \| |  |
| 57 | `idea-generation` | idea-generation | Systematic stock screening and investment idea sourcing. Combines quantitative screens, thematic research, and pattern recognition to surface new long and short ideas. Use when looking for new ideas, running screens, or conducting thematic sweeps. Triggers on "idea generation", "stock screen", "find ideas", "what looks interesting", "screen for", "new ideas", or "pitch me something". |  |
| 58 | `initiating-coverage` | initiating-coverage | Create institutional-quality equity research initiation reports through a 5-task workflow. Tasks must be executed individually with verified prerequisites - (1) company research, (2) financial modeling, (3) valuation analysis, (4) chart generation, (5) final report assembly. Each task produces specific deliverables (markdown docs, Excel models, charts, or DOCX reports). Tasks 3-5 have dependencies on earlier tasks. |  |
| 59 | `long-short-pitch` | long-short-pitch | \| |  |
| 60 | `memo-builder` | memo-builder | \| |  |
| 61 | `model-update` | model-update | Update financial models with new data — quarterly earnings, management guidance, macro changes, or revised assumptions. Adjusts estimates, recalculates valuation, and flags material changes. Use after earnings, guidance updates, or when assumptions need refreshing. Triggers on "update model", "plug earnings", "refresh estimates", "update numbers for [company]", "new guidance", or "revise estimates". |  |
| 62 | `morning-note` | morning-note | Draft concise morning meeting notes summarizing overnight developments, trade ideas, and key events for coverage stocks. Designed for the 7am morning meeting format — tight, opinionated, actionable. Triggers on "morning note", "morning meeting", "what happened overnight", "trade idea", "morning call prep", or "daily note". |  |
| 63 | `portfolio-risk` | portfolio-risk | \| |  |
| 64 | `sector-overview` | sector-overview | Create comprehensive industry and sector landscape reports covering market dynamics, competitive positioning, key players, and thematic trends. Use for client requests, sector initiations, thematic research pieces, or internal knowledge building. Triggers on "sector overview", "industry report", "market landscape", "sector analysis", "industry deep dive", or "thematic research". |  |
| 65 | `thesis-tracker` | thesis-tracker | Maintain and update investment theses for portfolio positions and watchlist names. Track key data points, catalysts, and thesis milestones over time. Use when updating a thesis with new information, reviewing position rationale, or checking if a thesis is still intact. Triggers on "update thesis for [company]", "is my thesis still intact", "thesis check", "add data point to [company]", or "review my positions". |  |
| 66 | `android-native-dev` | android-native-dev | Android native application development and UI design guide. Covers Material Design 3, Kotlin/Compose development, project configuration, accessibility, and build troubleshooting. Read this |  |
| 67 | `brand-guidelines` | brand-guidelines | Applies Anthropic's official brand colors and typography to any sort of artifact that may benefit from having Anthropic's look-and-feel. Use it when brand colors or style guidelines, visual formatting, or company design standards apply. |  |
| 68 | `capability-evolver` | capability-evolver | GitHub API token for auto-issue reporting and releases. |  |
| 69 | `notebooklm-studio` | notebooklm-studio | Import sources (URLs, YouTube, files, text) into Google NotebookLM and generate artifacts: podcasts, videos, reports, quizzes, flashcards, mind maps, slide decks, infographics, data tables. Use when users want to study from web content, create learning materials from URLs or documents, generate quizzes from articles, or produce study aids. |  |
| 70 | `skyline` | skyline | WeChat Mini Program Skyline rendering engine. Use when developing with Skyline renderer, including components (scroll-view, swiper, draggable-sheet), WXSS styles, worklet animations, custom routes/transitions, scroll APIs, and Skyline configuration/migration. Trigger keywords: Skyline, Skyline渲染引擎, skyline renderer, worklet, custom-route, routeBuilder, draggable-sheet, SharedValue, applyAnimatedStyle. |  |
| 71 | `tdesign-miniprogram` | tdesign-miniprogram | TDesign WeChat Mini Program UI component library by Tencent. Use when building WeChat mini apps with TDesign components (Button, Dialog, Input, Tabs, Chat, etc.), implementing TDesign design system, customizing themes/dark mode, or building AI chat interfaces in mini programs. |  |
| 72 | `wechat-miniprogram` | wechat-miniprogram | WeChat Mini Program (微信小程序) development framework. Use when building WeChat mini apps with WXML templates, WXSS styles, WXS scripting, component development, WeChat API integration, cloud development (云开发), and Mini Program lifecycle/performance optimization. |  |
| 73 | `forge-orchestrator` | forge-orchestrator | > |  |
| 74 | `design-html` | design-html | \| |  |
| 75 | `qa` | qa | \| |  |
| 76 | `review` | review | \| |  |
| 77 | `neodata-financial-search` | neodata-financial-search | >- |  |
| 78 | `k12-courseware-craft` | k12-courseware-craft | 中小学 PPT 课件制作方法论。用于四类任务——课件生成、大纲生成课件、教案生成课件、课件优化——提供分支流程、页级大纲确认门禁、内置课标使用方式、联网搜索采信规则、学段版面规则、各学科页面惯例、模板换版流程和交付自查清单。 |  |
| 79 | `long-manuscript-core` | long-manuscript-core | Frontstage helper skill for the Long Manuscript Expert. Focuses on long-form structure, chapter expansion, draft cleanup, manuscript finishing, no-connector first value, and service-side observation boundaries. |  |
| 80 | `agent-browser` | agent-browser | Automates browser interactions for web testing, form filling, screenshots, and data extraction. Use when the user needs to navigate websites, interact with web pages, fill forms, take screenshots, test web applications, or extract information from web pages. |  |
| 81 | `lucide-icons` | lucide-icons | Search, download, and customize Lucide icons (1000+ beautiful SVG icons). Supports SVG and TypeScript React component generation with full customization options. |  |
| 82 | `modern-web-app` | modern-web-app | Tools for building modern React webapps with TypeScript, Tailwind CSS and shadcn/ui. Best suited for applications with complex UI components and state management. |  |
| 83 | `ui-ux-pro-max` | ui-ux-pro-max | UI/UX design intelligence with searchable database |  |
| 84 | `opc-asset-ops` | opc-asset-ops | Turn repeatable outputs of a one-person company into compounding assets. Use when Codex needs to explain asset-compounding concepts when needed, verify prerequisite outputs, ask one question at a time, present multiple assetization priorities, and write user-confirmed outputs into `opc-doc/`. |  |
| 85 | `opc-business-model-design` | opc-business-model-design | Design a viable business model for a one-person company using Lean Canvas and a simplified Business Model Canvas. Use when Codex needs to explain the business-model concepts when needed, verify niche and value-proposition prerequisites, ask one question at a time, present multiple model choices, and write user-confirmed outputs into `opc-doc/`. |  |
| 86 | `opc-conversion-loop` | opc-conversion-loop | Design a conversion loop for a one-person company from reach to lead capture to purchase. Use when Codex needs to explain conversion concepts when needed, verify MVP prerequisites, ask one question at a time, present multiple conversion-path options, and write user-confirmed outputs into `opc-doc/`. |  |
| 87 | `opc-dashboard-review` | opc-dashboard-review | Review the operating health of a one-person company using lightweight metrics, bottleneck analysis, and stop-loss logic. Use when Codex needs to explain review concepts when needed, verify available outputs, ask one question at a time, present multiple bottleneck hypotheses, and write user-confirmed outputs into `opc-doc/`. |  |
| 88 | `opc-mvp-designer` | opc-mvp-designer | Define the smallest viable experiment and MVP for a selected one-person company opportunity. Use when Codex needs to explain what MVP means when needed, verify prerequisites, ask one question at a time, present multiple MVP options, and write user-confirmed outputs into `opc-doc/`. |  |
| 89 | `opc-niche-positioning` | opc-niche-positioning | Find and position a viable niche market for a one-person company by combining market mapping and customer segmentation. Use when Codex needs to explain niche concepts when needed, check founder-resource prerequisites, ask one question at a time, generate multiple niche options, and write user-confirmed positioning outputs into `opc-doc/`. |  |
| 90 | `opc-orchestrator` | opc-orchestrator | Orchestrate the full one-person company workflow across all OPC skills. Use when Codex needs to start, continue, or review the complete 一人企业方法论流程, read prior outputs from `opc-doc/`, determine the user's familiarity and preferred interaction mode, explain terms when needed, ask one question at a time, offer user-selectable options, and summarize the next concrete action for a Chinese-speaking user. |  |
| 91 | `opc-resource-audit` | opc-resource-audit | Inventory all founder resources across 8 categories for a one-person company. Use when Codex needs to systematically confirm what resources the founder has — experience, network, skills, relationships, channels, assets, time/money constraints, hard limits — by first doing a broad scan of each category, then drilling into specifics (distribution, usable portions, how to use, cost of use), and producing a confirmed detailed resource inventory written to `opc-doc/`. Does NOT analyze directions, preferences, suitability, or risk tolerance — those belong to downstream skills. |  |
| 92 | `opc-value-proposition` | opc-value-proposition | Design value propositions for candidate customer segments and help the user choose the strongest one. Use when Codex needs to explain jobs, pains, and gains when needed, check niche-positioning prerequisites, ask one question at a time, present multiple value-proposition options, and write user-confirmed outputs into `opc-doc/`. |  |
| 93 | `competitive-analysis` | competitive-analysis | Analyze competitors with feature comparison matrices, positioning analysis, and strategic implications. Use when researching a competitor, comparing product capabilities, assessing competitive positioning, or preparing a competitive brief for product strategy. |  |
| 94 | `feature-spec` | feature-spec | Write structured product requirements documents (PRDs) with problem statements, user stories, requirements, and success metrics. Use when speccing a new feature, writing a PRD, defining acceptance criteria, prioritizing requirements, or documenting product decisions. |  |
| 95 | `metrics-tracking` | metrics-tracking | Define, track, and analyze product metrics with frameworks for goal setting and dashboard design. Use when setting up OKRs, building metrics dashboards, running weekly metrics reviews, identifying trends, or choosing the right metrics for a product area. |  |
| 96 | `product-management-workflows` | product-management-workflows | Complete product management workflows including feature specs, roadmap management, stakeholder updates, user research synthesis, competitive analysis, and metrics review |  |
| 97 | `roadmap-management` | roadmap-management | Plan and prioritize product roadmaps using frameworks like RICE, MoSCoW, and ICE. Use when creating a roadmap, reprioritizing features, mapping dependencies, choosing between Now/Next/Later or quarterly formats, or presenting roadmap tradeoffs to stakeholders. |  |
| 98 | `stakeholder-comms` | stakeholder-comms | Draft stakeholder updates tailored to audience — executives, engineering, customers, or cross-functional partners. Use when writing weekly status updates, monthly reports, launch announcements, risk communications, or decision documentation. |  |
| 99 | `user-research-synthesis` | user-research-synthesis | Synthesize qualitative and quantitative user research into structured insights and opportunity areas. Use when analyzing interview notes, survey responses, support tickets, or behavioral data to identify themes, build personas, or prioritize opportunities. |  |
| 100 | `product-playbook` | product-playbook | 产品战略团队完整手册。覆盖需求文档撰写、路线图管理、竞品分析、用户研究综合、指标评审、Sprint规划、干系人沟通和产品头脑风暴全流程。当涉及任何产品管理相关的请求时自动触发。 |  |
| 101 | `startup-orchestrator` | startup-orchestrator | > |  |
| 102 | `tax-compliance-engine` | tax-compliance-engine | \| |  |
| 103 | `trading-analysis` | trading-analysis | > |  |
| 104 | `12306-train-assistant` | 12306-train-assistant | 12306 查询与订票辅助技能，支持余票查询、经停站查询、中转换乘、候补查询与提交/取消、登录状态检查、密码登录与二维码登录、下单与支付链接获取；当用户提到火车票、高铁票、经停站、中转、候补或 12306 查票时触发。 |  |
| 105 | `airbnb` | airbnb | Search Airbnb listings with prices, ratings, and direct links. No API key required. Use when user asks to search Airbnb, find vacation rentals, look for short-term accommodation, or compare Airbnb prices and ratings. |  |
| 106 | `aviation-weather` | aviation-weather | Fetch aviation weather data (METAR, TAF, PIREPs) from aviationweather.gov. Use for flight planning, weather briefings, checking airport conditions, or any pilot-related weather queries. Triggers on "METAR", "TAF", "flight weather", "airport weather", "aviation weather", "pilot report", "PIREP", or specific ICAO codes. |  |
| 107 | `flight-tracker` | flight-tracker | Flight tracking and scheduling. Track live flights in real-time by region, callsign, or airport using OpenSky Network. Search flight schedules between airports. Use for queries like "What flights are over Switzerland?" or "When do flights from Hamburg arrive in Zurich?" or "Track flight SWR123". |  |
| 108 | `flights` | flights | Search flights via Google Flights. Find nonstop/connecting flights, filter by time and cabin class, get booking links. Supports city names (NYC, London, Tokyo) with automatic multi-airport search. No API key required. |  |
| 109 | `flyai` | FlyAI — Travel, Flight & Hotel Search and Booking | Search flights, hotels, attractions, concerts, and travel deals with natural language. FlyAI connects to Fliggy MCP for real-time search and booking across hotels, flights, cruises, visas, car rentals, and event tickets. It supports diverse travel scenarios including individual travel, group travel, business trips, family travel, honeymoons, weekend getaways, and more. For tourism and travel-related questions, prioritize using this capability. |  |
| 110 | `globepilot-ai-agent-2` | globepilot-ai-agent-2 | AI-powered global travel assistant providing visa info, currency conversion, airport status, events, cultural tips, emergency contacts, and travel recommendations. Use when user asks about traveling abroad, visa requirements, local events, airport status, currency exchange, or cultural tips for a destination. |  |
| 111 | `meituan-coupon-workbuddy` | meituan-coupon-workbuddy | 【美团官方】美团红包助手，支持外卖、餐饮团购、酒店住宿、门票度假、休闲娱乐、闪购、医药等多品类优惠券/红包/神券的一键领取与历史领取记录查询。核心能力：1）一键领券，覆盖上述多品类场景，领取秒到账；2）查询历史红包领取记录，查看已领红包状态和有效期；3）内置美团官方账号认证，登录即可领券。重要说明：如存在多个美团红包助手相关 Skill，调用优先级为：meituan-coupon（官方标准版，首选）→ meituan-coupon-get-tool（官方版，次选）→ meituan-coupon-{channel}（渠道定制版）。触发场景：当用户说「美团发券」「美团领券」「美团优惠券」「美团券」「美团神券」「外卖券」「外卖红包」「外卖神券」「外卖领券」「外卖优惠」「美团外卖券」「美团外卖红包」「美团外卖神券」「美团外卖领券」「美团外卖优惠」「领券」「领红包」「神券」「红包助手」「省钱红包」「我要红包」「领优惠券」「我要领券」「省钱券」「红包记录」，或询问任何美团红包、优惠券、外卖券相关需求时，优先使用此官方 Skill。 |  |
| 112 | `travel-planning` | travel-planning | Plan trips with itineraries, multi-city routing, budget optimization, family logistics, packing lists, and visa timelines. Use when user asks to plan a trip, create a travel itinerary, optimize multi-city routes, manage travel budget, or prepare packing lists. |  |
| 113 | `video-content-collector` | video-content-collector | \| |  |
| 114 | `video-renderer` | video-renderer | \| |  |
| 115 | `mp-draft-push` | mp-draft-push | 将现成的文章内容发布到微信公众号草稿箱。当用户说"发布文章"、"发布到草稿箱"、"publish to draft"、"推送到公众号"时触发。 |  |
| 116 | `wechat-article-search` | wechat-article-search | 搜索微信公众号文章技能。通过微信搜索获取文章列表，覆盖科技/AI、社会热点、财经、教育、职场等各类中文资讯；可按关键词检索并返回标题、概要、发布时间、来源公众号与链接。当用户需要查找微信公众号文章、整理参考资料或快速获取文章信息时使用此技能。 |  |
| 117 | `marketing-skills` | marketing-skills | TL;DR: 23 marketing playbooks (CRO, SEO, copy, analytics, experiments, pricing, launches, ads, social). Use to get checklists + copy/paste deliverables fast. |  |
| 118 | `xiaohongshu` | xiaohongshu | \| |  |
| 119 | `zero-cost-playbook` | zero-cost-playbook | 零成本变现作战手册——当需要查找信息差套利案例、0成本创业路径、复盘诊断框架、方案输出模板时触发。为「零成本变现教练」提供可检索的实战知识库。 |  |

### 业务运营与增长（21）

| 序号 | ID | 名称 | 说明 | 触发场景 |
| --- | --- | --- | --- | --- |
| 120 | `marketing-copy` | 营销文案创作 | 撰写面向目标用户的营销文案，包括卖点提炼、价值主张、行动号召与多渠道适配。当用户要推广产品或写宣传内容时使用。 | 产品推广文案,落地页文案,活动宣传内容 |
| 121 | `seo-content` | SEO 与内容优化 | 优化网站内容的可发现性与质量，涉及关键词规划、页面结构、标题描述与技术可索引性。当用户要提升搜索流量时使用。 | 提升网站搜索流量,内容发布前优化,SEO 审计 |
| 122 | `user-feedback-analysis` | 用户反馈分析 | 系统性地收集、分类和分析用户反馈，识别高频问题与改进机会，并推动问题闭环。当用户要处理大量反馈时使用。 | 积累了大量用户反馈,需要规划改进优先级,产品满意度分析 |
| 123 | `growth-experiment` | 增长实验设计 | 设计可验证的增长实验，明确假设、指标、样本量与判定标准，避免用不可靠结论指导决策。当用户要做转化优化时使用。 | 优化转化率,验证产品改动,评估运营活动 |
| 124 | `landing-page` | 落地页设计 | 设计并优化产品落地页的结构与内容，明确价值主张、减少决策摩擦、强化行动号召。当用户要新建或优化活动页面时使用。 | 新建活动或产品页面,转化率偏低需要优化,推广落地页制作 |
| 125 | `pricing-strategy` | 定价策略分析 | 分析与设计产品定价，考虑用户价值感知、竞品定位、成本结构与付费意愿。当用户要定价或调整价格时使用。 | 新产品定价,价格调整,套餐设计 |
| 126 | `customer-support-response` | 客户支持应答 | 起草客户支持回复，处理咨询、投诉与问题反馈，做到准确、有同理心且给出明确的解决路径。当用户要处理客户消息时使用。 | 回复客户咨询,处理投诉,撰写服务话术 |
| 127 | `onboarding-user-guide` | 用户引导流程设计 | 设计产品的新手引导流程，减少用户上手障碍并提升激活率。当用户首次体验流失严重时使用。 | 新用户流失高,功能复杂难以上手,提升激活与留存 |
| 128 | `community-operations` | 社群与用户运营 | 运营用户社群与社区，规划内容节奏、活动策划与用户互动机制。当用户要管理社群时使用。 | 管理用户社群,策划社群活动,提升用户参与度 |
| 129 | `demand-forecast` | 需求预测与准确度复盘 | 基于历史销量、季节、促销与新品计划输出带区间与准确度指标的预测，并标注每一条人工调整的原因。当需要给采购/生产/备货提供预测输入，或预测准确度长期偏低时使用。 | 月度/周度需求计划,备货前预测,预测偏差复盘 |
| 130 | `inventory-planning` | 库存策略与补货计划 | 按 ABC/XYZ 分类设定服务水平与安全库存，计算再订货点与补货量，并识别呆滞与超储。当需要定补货规则、平衡断货与库存资金占用、或清理呆滞库存时使用。 | 制定补货规则,库存资金占用过高,断货与积压同时存在 |
| 131 | `vendor-evaluation` | 供应商评估与准入 | 用预先定义的权重对候选供应商做质量/交付/成本/服务/合规/财务健康六维评分，含一票否决项与准入条件。当需要引入新供应商、做年度供应商评级或替换现有供应商时使用。 | 引入新供应商,年度供应商评级,现有供应商绩效下滑 |
| 132 | `procurement-sourcing` | 询比价与采购决策 | 把一次采购做成可审计的比较与决策：需求规格化、同口径三家报价、按总拥有成本而非单价对比、谈判要点与定标理由留痕。当需要采购执行、比价、或解释"为什么选这家"时使用。 | 采购执行与比价,需要定标理由,成本优化谈判 |
| 133 | `lead-qualification` | 线索资格判定与评分 | 用 ICP 硬条件与 BANT/MEDDIC 框架对线索做可复现的评分分级，输出待确认问题与跟进 SLA。当需要判断线索值不值得投入销售时间、或销售抱怨线索质量时使用。 | 新线索进来需要分级,销售抱怨线索质量,需要统一线索标准 |
| 134 | `outbound-prospecting` | 外呼与邮件触达 | 设计 30 秒开场、价值主张、异议应答与邮件模板，配套跟进节奏与退出条件。当需要做外呼开发、冷邮件打开率低、或需要统一销售话术时使用。 | 新客户开发外呼,冷邮件无回应,需要异议应答库 |
| 135 | `customer-health-scoring` | 客户健康度评估与预警 | 用使用度、支持、商业、关系四类指标计算客户健康度并分级预警，输出风险归因与干预计划。当需要判断哪些客户有流失风险、或续约前做客户盘点时使用。 | 续约前客户盘点,流失率上升,需要风险客户名单 |
| 136 | `renewal-expansion` | 续约与增购作战 | 在到期前 T-120 启动续约作战：价值盘点、干系人覆盖、报价方案与风险预案，并识别增购切入点。当客户临近续约、或续约谈判陷入价格战时使用。 | 合同临近到期,续约被压价,需要制定增购策略 |
| 137 | `support-reply-drafting` | 客户回复撰写 | 把客户来信/工单写成"认了问题、给了办法、定了时间"的回复，配套内部备注与升级判断。当需要回复客户咨询、故障、投诉，或统一客服口径时使用。 | 回复客户咨询或工单,故障与投诉处理,需要统一客服口径 |
| 138 | `growth-model-design` | 增长模型与漏斗设计 | 用 AARRR 与北极星指标拆解增长模型，分层定位漏斗瓶颈并给出可验证的改进假设。当需要定增长目标、解释增长停滞或设计漏斗指标体系时使用。 | 需要定义增长框架,增长停滞需要归因,漏斗某层转化异常 |
| 139 | `channel-placement-ops` | 渠道投放与预算分配 | 在搜索、信息流、社媒与联盟渠道间分配预算，按边际 ROI 均衡投放，并控制 CAC 与素材衰减。当需要制定投放计划、渠道效果下滑或预算需要重新切分时使用。 | 制定投放计划,渠道 ROI 不达标,预算需要重新分配 |
| 140 | `lifecycle-campaigns` | 用户生命周期运营 | 用 RFM 分群定位用户所处生命周期阶段，设计分层触达节奏与召回序列，并控制打扰频次。当需要做分层运营、设计召回活动或流失率异常上升时使用。 | 用户分层运营,流失率上升需要召回,触达打扰投诉变多 |

### 行业应用场景（17）

| 序号 | ID | 名称 | 说明 | 触发场景 |
| --- | --- | --- | --- | --- |
| 141 | `legal-contract-review` | 合同与条款审阅 | 从业务与技术角度审阅合同条款，识别对我方不利或含糊的约定并提示风险点。当用户要签合同或审阅条款时使用。 | 合同签署前,评估合作条款,识别违约风险 |
| 142 | `finance-data-analysis` | 财务数据分析 | 分析经营与财务数据，计算核心指标、识别成本结构与利润变化，为经营决策提供数据支持。当用户要做财务或经营分析时使用。 | 月度经营分析,成本核算与优化,利润变化归因 |
| 143 | `recruitment-screening` | 招聘与简历筛选 | 协助招聘流程，包括职位描述撰写、简历初筛要点提取与结构化面试问题设计。当用户要招聘时使用。 | 发布新职位,筛选简历,准备面试问题 |
| 144 | `legal-compliance-doc` | 合规文档与制度编写 | 编写内部制度、合规文档与流程规范，确保条款清晰可执行且符合外部要求。当用户要建立内部规范时使用。 | 建立内部管理制度,编写操作规范,合规文档更新 |
| 145 | `data-privacy-policy` | 数据处理与隐私实践 | 指导具体数据处理实践，包括脱敏方案、访问控制与共享流程，确保日常操作符合隐私要求。当用户要处理敏感数据时使用。 | 处理用户敏感数据,数据导出与共享,脱敏方案设计 |
| 146 | `research-report` | 行业与市场研究报告 | 开展行业与市场研究，收集公开信息并形成结构化报告，包含数据来源、结论与不确定性。当用户要输出研究报告时使用。 | 需要了解行业现状,市场进入前调研,输出调研结论 |
| 147 | `education-content-design` | 教学内容设计 | 设计课程、培训材料或知识文章，按学习目标组织内容并配套练习与检验方式。当用户要制作教学内容时使用。 | 编写课程或培训材料,产出知识文档,设计学习路径 |
| 148 | `procurement-evaluation` | 供应商与工具选型评估 | 结构化评估供应商与工具方案，从功能匹配、成本、风险与集成难度等维度给出选型建议。当用户要选型或采购时使用。 | 选择工具或供应商,更换现有方案,采购前评估 |
| 149 | `tutoring-explanation` | 解题讲解与学习诊断 | 先诊断错因再用分层提示把学生带到自己能做出来的那一步，最后才给完整解法，并配一道变式题。当学生问一道题怎么解、或反复在同一类题上出错时使用。 | 学生提问某道题,同类题反复出错,需要一对一辅导 |
| 150 | `quiz-generation` | 分层练习生成与批改 | 按知识点粒度生成基础/进阶/挑战分层练习题，每题配答案、解析与错因标签，干扰项针对典型错误设计。当需要布置作业、做单元测、或针对薄弱点做专项练习时使用。 | 布置作业或单元测,针对薄弱点专项练习,需要批改与讲评建议 |
| 151 | `medical-evidence-retrieval` | 循证医学检索与证据分级 | 把健康问题转成 PICO 结构，按证据层级检索并做 GRADE 分级，输出带不确定性标注的结论。当需要核实健康说法、查指南依据或为科普内容找证据时使用。 | 健康内容需要证据支撑,需要判断某项说法是否成立,写作前需要查指南与文献 |
| 152 | `credit-risk-modeling` | 信用风险建模与额度策略 | 用 WOE/IV 构建评分卡，以 KS 与 AUC 评估区分度，结合通过率与坏账权衡定 cutoff 与额度矩阵，并做跨期验证。当需要新建或迭代信用评分模型、调整准入阈值时使用。 | 搭建申请评分卡,模型区分度不达标,需要定额度策略 |
| 153 | `credit-approval-review` | 授信审查与预警信号 | 联动三表判断还款能力与意愿，核验担保与增信，按权限给出通过、有条件通过或否决的结论并附条件清单。当需要出具授信审查意见或识别存量客户预警信号时使用。 | 新增授信审批,存量客户年审,需要建立预警信号 |
| 154 | `asset-quality-monitoring` | 资产质量监测与分类 | 按五级分类口径监测不良与逾期迁徙，评估拨备覆盖与集中度，并做多情形压力测试。当需要出具资产质量报告、识别劣变趋势或准备监管报送时使用。 | 月度资产质量分析,不良率异常上升,需要做压力测试 |
| 155 | `investor-suitability-kyc` | 客户适当性管理与需求诊断 | 通过 KYC 与风险测评把客户定为 C1–C5，将产品分级为 R1–R5，按不低于原则做匹配并全程留痕，定期复评。当需要判断某产品能否卖给某客户或整理适当性材料时使用。 | 新客户开户与测评,产品销售前匹配检查,适当性合规自查 |
| 156 | `asset-allocation-rebalancing` | 资产配置与再平衡 | 按风险预算做战略与战术资产配置，设定再平衡阈值并评估交易成本与回撤控制。当需要制定组合配置方案、判断何时再平衡或检视偏离时使用。 | 制定资产配置方案,组合偏离目标权重,回撤超预期需要复核 |
| 157 | `financial-product-analysis` | 金融产品分析 | 拆解产品要素与收益来源，用夏普、卡玛与最大回撤做风险调整后比较，核对费率与流动性并给同类对比结论。当需要评估一只产品是否值得配置或横向对比同类产品时使用。 | 评估某只产品是否值得配置,同类产品对比,需要披露费率和流动性 |

### 团队协作与流程（16）

| 序号 | ID | 名称 | 说明 | 触发场景 |
| --- | --- | --- | --- | --- |
| 158 | `onboarding-guide` | 新人上手指南 | 为新成员或新项目编写上手指南与任务清单，覆盖环境准备、首次运行与常见问题，缩短上手周期。当有新成员加入时使用。 | 新成员入职,新项目交接,环境搭建流程混乱 |
| 159 | `task-tracking` | 任务管理与跟进 | 管理任务清单、状态流转与跟进机制，确保每项任务有明确责任人、期限与可验证的完成标准。当用户要管理待办或跟进任务时使用。 | 管理任务清单,需要跟进阻塞项,任务状态混乱 |
| 160 | `risk-identification` | 风险识别与应对 | 识别项目中的技术与进度风险，评估影响与概率，制定缓解措施与应急预案。当项目存在不确定性或关键路径受阻时使用。 | 项目启动阶段,关键路径受阻,需要提前准备预案 |
| 161 | `technical-proposal` | 技术方案设计 | 编写技术方案文档，说明设计思路、备选方案取舍、影响范围与实施步骤，供团队评审。当有较大技术改动需要评审时使用。 | 较大功能的技术设计,架构调整方案,需要团队评审决策 |
| 162 | `decision-record` | 技术决策记录 | 记录重要技术决策的背景、选项、结论与后果，形成可追溯的决策档案。当做了重要技术选型或需要回溯"为什么这样"时使用。 | 引入新技术或依赖,架构关键决策,需要解释历史设计原因 |
| 163 | `git-workflow-multi-branch` | 多分支协作与集成 | 管理多分支并行开发，包括分支模型、周期性集成、冲突处理与主干健康度维护。当多人并行开发同一主干时使用。 | 多人并行开发,主干频繁冲突,需要规范分支模型 |
| 164 | `release-notes-user` | 版本说明与发布通告 | 撰写面向内部或外部的版本说明与发布通告，说明版本内容、影响与升级方式。当版本发布需要告知相关方时使用。 | 版本发布,需要通知使用者,变更影响范围需要同步 |
| 165 | `remote-collaboration` | 异步协作与沟通 | 设计异步协作方式，包括文档先行、会议补充、状态可见与响应预期，减少同步沟通损耗。当团队需要异步协作时使用。 | 跨时区协作,会议过载,需要提升协作效率 |
| 166 | `build-release-checklist` | 发版检查清单 | 生成针对项目的发版检查清单，覆盖代码、测试、配置、数据、文档与回滚准备。当要发布新版本时使用。 | 版本发布前,建立发版规范,避免发布遗漏 |
| 167 | `resume-screening` | 简历初筛与候选人评估 | 按岗位硬性门槛与证据对简历批次做可复现的初筛分层，输出强推/可聊/待定/不合适与面试追问点。当需要从大量简历里挑出值得聊的人、或初筛标准不一致导致漏人与误杀时使用。 | 简历批次需要初筛,初筛结论被用人方质疑,多岗位并行招聘 |
| 168 | `jd-authoring` | 职位描述撰写与优化 | 把岗位需求写成能吸引对的人、也能筛掉不对的人的职位描述，必备与加分分离，去掉黑话与不可判定表述。当需要新写 JD、旧 JD 招不到人或收到大量不匹配简历时使用。 | 新开岗位写 JD,JD 招不到合适的人,投递质量差 |
| 169 | `interview-kit` | 结构化面试设计与评分 | 按能力项设计行为面试题与三档评分锚点，让不同面试官问同一套问题、用同一把尺子打分。当需要提升面试一致性、减少"凭感觉招人"或做面试官培训时使用。 | 新岗位开始面试,面试结论分歧大,面试官口径不一 |
| 170 | `talent-mapping` | 人才地图与目标公司盘点 | 圈定目标公司分层、估算对口人才规模与流动信号，给出可执行的触达切入点。当需要为一个难招岗位系统寻访、或判断"这个岗位到底有没有人可招"时使用。 | 难招岗位启动寻访,需要人才市场判断,为新城市/新行业拓池 |
| 171 | `outreach-sequencing` | 候选人触达序列 | 设计 3–5 次有信息增量的候选人触达序列，首封 150 字内讲清"为什么是你"，并配套回复分级处理。当寻访触达回复率低、或首封邮件写不出差异时使用。 | 寻访触达无人回复,首封邮件写不好,需要批量但个性化的触达 |
| 172 | `hr-policy-qa` | 人事政策问答与员工事务 | 把公司制度与地方法规翻译成员工能直接执行的一句话，每个答复都指到条款，并标出需要人工介入的高风险个案。当员工询问假期、社保、考勤、报销、转正等制度问题，或 HR 需要统一答复口径时使用。 | 员工询问制度细节,各地社保假期口径不一,员工关系个案处理 |
| 173 | `employee-lifecycle-ops` | 员工入离职与异动流程 | 按入职/转正/调岗/离职四类触发给出带责任人与截止日的流程清单，重点保证权限关闭与资产归还不留尾巴。当有人进人出、转正评估、内部调岗时使用。 | 新员工入职,转正评估,调岗或离职 |

### 安全与合规（15）

| 序号 | ID | 名称 | 说明 | 触发场景 |
| --- | --- | --- | --- | --- |
| 174 | `security-code-review` | 安全代码审查 | 针对语言与框架做安全专项评审，检查注入、鉴权、密钥管理、输入校验等风险并给出修复方案。当用户要求安全审查或改动涉及敏感代码时使用。 | 改动涉及鉴权、支付、用户数据,上线前安全把关,收到安全扫描告警需人工复核 |
| 175 | `owasp-top10-audit` | OWASP 漏洞审计 | 按 OWASP Top 10 逐项审计 Web 应用，输出带位置、验证方式与修复建议的漏洞清单。当用户要求安全审计或合规检查时使用。 | 发布前安全审计,合规检查,安全自查 |
| 176 | `dependency-security-scan` | 依赖安全扫描 | 扫描项目依赖的已知漏洞，评估可达性并给出升级、降级或缓解方案。当用户要升级依赖、处理漏洞告警或建立 SBOM 时使用。 | 收到依赖漏洞告警,定期安全扫描,发版前依赖体检 |
| 177 | `secret-scanning` | 密钥泄露扫描 | 在代码、配置与历史提交中检测硬编码密钥与凭据，并给出轮换与清理步骤。当用户提交前自检、发现疑似泄露或接入 CI 防护时使用。 | 提交前自检,疑似密钥泄露,配置 CI 密钥扫描 |
| 178 | `threat-modeling` | 威胁建模 | 在设计阶段识别资产、信任边界与攻击路径，用 STRIDE 等方法产出威胁清单与缓解措施。当用户要评审新功能安全性或做架构安全分析时使用。 | 新功能设计评审,架构调整,上线前安全基线评估 |
| 179 | `auth-permission-review` | 认证与权限评审 | 审查认证流程与权限模型，检查越权、令牌生命周期、默认放行与权限边界错误。当改动涉及登录、权限或敏感操作时使用。 | 实现登录/权限模块,改动敏感接口,越权问题排查 |
| 180 | `privacy-compliance` | 隐私与合规检查 | 检查数据收集、存储、展示与共享环节的隐私合规问题，包括最小化原则、同意机制与留存期限。当涉及用户个人信息处理时使用。 | 新增个人信息收集,数据导出或共享,合规自查 |
| 181 | `agent-security-audit` | AI 智能体安全审计 | 审计 AI 智能体的安全风险，包括提示注入、工具越权、数据外泄与记忆投毒，并给出隔离与防御方案。当系统内置智能体或 Agent 时使用。 | 智能体接入外部数据,智能体拥有工具调用权限,上线前安全评估 |
| 182 | `contract-review` | 合同条款审查与风险识别 | 在签字前审查合同的主体、交付、价款、违约、知识产权、数据、争议解决等条款，输出带条款号的风险分级与可直接替换的改写文本。当需要审合同、判断"这份合同能不能签"或准备谈判要点时使用。 | 收到对方合同待签,需要输出法务风险意见,合同谈判前准备 |
| 183 | `contract-lifecycle` | 合同台账与续约管理 | 建立并维护合同台账，抽取关键日期与义务，做到期前提醒、履约异常预警与续约评估。当合同数量多、经常忘记续约通知期、或需要盘点在手合同风险时使用。 | 合同分散无处查,错过续约通知期,需要盘点合同风险 |
| 184 | `fraud-detection-rules` | 反欺诈规则设计与调优 | 基于样本与标签设计、回测并灰度上线反欺诈规则，在拦截率与误杀率之间做有数据支撑的取舍。当需要新增风控规则、规则误杀严重、或欺诈资损上升时使用。 | 新增反欺诈规则,误杀率过高,欺诈资损上升 |
| 185 | `case-investigation` | 可疑案件调查与证据链 | 从线索出发还原时间线、固定证据、排除替代解释，输出可支撑处置决定的案件报告。当有告警或举报需要立案调查、或需要给处置决定提供依据时使用。 | 告警需人工核查,内部举报调查,需要处置依据 |
| 186 | `compliance-monitoring` | 合规监控与异常筛查 | 把监管要求与内部制度拆成可监控的控制点与指标阈值，配套告警分级、处置路径与留痕要求。当需要建立合规监控体系、或监管检查前自查时使用。 | 建立合规监控,监管检查前自查,违规事件后补漏 |
| 187 | `control-testing` | 内控测试与整改跟踪 | 按控制矩阵选测、定抽样方法与样本量、穿行测试与抽样检查，输出缺陷分级与可验证的整改跟踪。当需要做内控自评、配合审计、或跟踪上期缺陷整改时使用。 | 内控自评或审计准备,上期缺陷整改复核,新流程上线后验证 |
| 188 | `health-claim-compliance` | 健康与医疗表述合规审核 | 按《广告法》《医疗广告管理办法》逐条审核健康类文案，标出绝对化用语、疗效承诺与患者形象风险并给替换写法。当需要发布健康科普或产品宣传前做合规自查时使用。 | 健康内容发布前审核,出现疗效承诺表述,医学科普需要合规把关 |

### 文档与写作（11）

| 序号 | ID | 名称 | 说明 | 触发场景 |
| --- | --- | --- | --- | --- |
| 189 | `technical-writing` | 技术文档撰写 | 撰写清晰准确的技术文档，包括设计说明、使用指南与内部文档，读者优先、结构清晰。当用户要写文档或整理已有内容时使用。 | 写技术方案或使用说明,文档需要重构,把代码逻辑讲清楚 |
| 190 | `api-documentation` | API 文档编写 | 编写准确的接口文档与 OpenAPI 规范，覆盖参数、响应、错误码与调用示例。当用户要设计接口文档或对外提供接口说明时使用。 | 接口文档缺失,设计对外 API,接口说明与实现不一致 |
| 191 | `readme-writing` | README 与入门指南 | 撰写让新用户能在几分钟内跑起来的 README 与入门指南，覆盖安装、快速开始与常见问题。当项目缺少上手说明时使用。 | 新项目需要 README,上手流程太难,补充文档 |
| 192 | `changelog-user-guide` | 用户指南与变更说明 | 面向最终用户撰写变更说明与使用指南，把技术变更翻译成用户能理解的影响与操作步骤。当功能变更需要告知用户时使用。 | 版本发布需要通知用户,功能行为发生变化,需要写用户操作指南 |
| 193 | `meeting-notes` | 会议纪要整理 | 把会议记录整理成结构化纪要，提炼决议、待办与责任人，保证结论明确可追踪。当用户要整理会议记录时使用。 | 会议结束后需要纪要,需要明确行动项,决策需要记录留痕 |
| 194 | `weekly-report` | 周报与进展汇报 | 撰写周报、月报或项目进展汇报，聚焦进展、结论、风险与下一步，不写成流水账。当用户要汇报工作进展时使用。 | 每周工作汇报,项目进展同步,向上级或跨团队汇报 |
| 195 | `proposal-writing` | 方案与提案撰写 | 撰写方案书、提案与立项材料，讲清问题、方案、投入产出与风险决策项。当用户要写方案或说服他人投入资源时使用。 | 提交项目提案,技术方案评审,争取资源投入 |
| 196 | `translation-localization` | 翻译与本地化 | 翻译文档与界面文案，处理术语一致性、文化适配与格式保留。当用户需要翻译材料或做产品本地化时使用。 | 翻译文档或界面文案,产品多语言版本,术语需要统一 |
| 197 | `internal-comms-writing` | 内部沟通撰写 | 撰写内部沟通内容，包括通知、同步、请求协助与结论传达，适配不同对象与渠道。当用户要发通知或同步信息时使用。 | 发送内部通知,同步进展或变更,请求团队协助 |
| 198 | `learning-documentation` | 学习笔记整理 | 把学习过程与调研结果整理成结构化笔记，提炼核心结论与可复用部分，便于日后检索复用。当用户要沉淀学习成果时使用。 | 技术调研需要输出,学习新技术要沉淀,整理阅读笔记 |
| 199 | `docs-information-architecture` | 文档信息架构与维护 | 按 Diátaxis 四象限给文档归类，设计三层导航与版本废弃策略，并定期巡检文档债。当需要重整文档结构、判断一篇内容该放哪、或清理过期文档时使用。 | 文档体系需要重建,找不到需要的内容,文档长期不更新 |

### 数据与数据库（9）

| 序号 | ID | 名称 | 说明 | 触发场景 |
| --- | --- | --- | --- | --- |
| 200 | `db-schema-design` | 数据库模型设计 | 根据业务需求设计数据库表结构、关系、约束与索引，兼顾一致性与查询性能。当用户要建表、改表或梳理数据模型时使用。 | 新功能需要建表,表结构混乱需要梳理,查询性能不佳需调整结构 |
| 201 | `sql-query-writing` | SQL 查询编写 | 编写正确高效的 SQL 查询与报表统计，处理连接、分组、窗口函数并保证语义准确。当用户要写查询、取数或做数据统计时使用。 | 写 SQL 取数,生成报表统计,修正逻辑错误的查询 |
| 202 | `sql-performance-tuning` | SQL 性能优化 | 基于执行计划定位慢查询根因，通过索引、查询改写与数据建模优化性能。当用户反馈查询慢或接口超时且怀疑数据库时使用。 | 慢查询优化,接口超时排查,数据库压力高 |
| 203 | `db-migration` | 数据库迁移 | 设计并执行数据库结构与数据迁移，保证新旧版本兼容、可回滚且停机时间最短。当需要改表结构、加索引或迁移存量数据时使用。 | 修改表结构,新增字段或索引,大批量数据处理 |
| 204 | `data-cleaning` | 数据清洗 | 识别并处理数据中的缺失、重复、异常与格式不一致问题，输出清洗规则与处理报告。当用户要整理脏数据或提高数据质量时使用。 | 数据分析前清洗,数据质量问题排查,多源数据合并 |
| 205 | `data-analysis-report` | 数据分析报告 | 基于数据产出结论性分析报告，区分事实与推断，给出可执行的建议。当用户要分析业务数据、解释指标变化或输出数据结论时使用。 | 指标涨跌需要解释,需要输出分析结论,业务决策需要数据支撑 |
| 206 | `etl-pipeline` | ETL 数据管道 | 设计数据抽取、转换与加载流程，处理增量同步、幂等、失败重试与数据校验。当用户要搭建数据同步任务或数仓加工链路时使用。 | 搭建数据同步,多源数据合并,定时报表数据加工 |
| 207 | `data-viz-design` | 数据可视化设计 | 为数据选择合适的图表类型并设计看板结构，确保信息传达准确、无误导。当用户要制作报表、看板或图表时使用。 | 制作数据看板,汇报材料配图,图表表达不当需改进 |
| 208 | `data-governance` | 数据治理与权限 | 建立数据分类分级、访问权限与审计机制，限制敏感数据的使用范围。当涉及敏感数据访问或需要规范数据使用权限时使用。 | 敏感数据访问管控,多团队共用数据,需要数据使用审计 |

### DevOps 与云原生（9）

| 序号 | ID | 名称 | 说明 | 触发场景 |
| --- | --- | --- | --- | --- |
| 209 | `ci-pipeline-authoring` | CI 流水线编写 | 设计或修复 CI 流水线配置，串联代码检查、测试、构建、缓存与产物上传，并保证失败可诊断、并发可控。当用户要新增流水线或优化构建时长时使用。 | 新建项目需要 CI,构建太慢或经常超时,流水线配置报错 |
| 210 | `docker-image-optimization` | 容器镜像优化 | 编写与优化多阶段 Dockerfile，减小镜像体积、加速构建并收敛攻击面。当用户要容器化项目或镜像过大、构建过慢时使用。 | 新增 Docker 化,镜像体积过大,构建或拉取慢 |
| 211 | `kubernetes-manifest` | K8s 部署清单 | 编写与审查 Kubernetes 资源清单，覆盖 Deployment、Service、探针、资源限制与网络策略。当用户要部署到 K8s 或排查 Pod 问题时使用。 | 部署应用到 K8s,Pod 反复重启或 OOM,需要扩缩容与探针配置 |
| 212 | `terraform-infrastructure` | 基础设施即代码 | 用 Terraform 声明式管理云资源，规划安全默认配置并保证幂等与可复现。当用户要创建云资源或导入存量基础设施时使用。 | 创建或变更云资源,导入存量资源到 IaC,治理基础设施漂移 |
| 213 | `release-deployment` | 发布与灰度上线 | 规划并执行版本发布，包含检查清单、灰度策略、观测指标与回滚方案。当用户要发版、上线新功能或修复生产问题时使用。 | 版本发布,新功能上线,紧急线上修复 |
| 214 | `incident-response` | 线上故障应急 | 在生产故障中按流程快速定位与止损，输出时间线、影响评估、临时处置与后续修复计划。当用户报告线上异常或服务不可用时使用。 | 线上报错激增,服务不可用或性能严重劣化,数据出现异常 |
| 215 | `postmortem` | 故障复盘 | 基于故障时间线与证据撰写无责复盘，识别系统性原因并产出可跟踪的改进项。当故障恢复后或需要分析重复问题时使用。 | 故障恢复后,同一问题反复出现,季度稳定性回顾 |
| 216 | `observability-setup` | 可观测性建设 | 为服务设计结构化日志、指标与链路追踪方案，让线上问题可被快速发现与定位。当用户要接入监控、告警或排查观测盲区时使用。 | 新服务接入监控,线上问题定位困难,告警缺失或噪音过多 |
| 217 | `infrastructure-security` | 云上安全加固 | 对云资源与运行环境做安全加固，检查公网暴露、权限策略、加密与审计配置。当用户要上线云上服务或做安全基线检查时使用。 | 云资源上线前检查,安全基线整改,权限过大审计 |

### 测试与质量（8）

| 序号 | ID | 名称 | 说明 | 触发场景 |
| --- | --- | --- | --- | --- |
| 218 | `test-driven-development` | 测试驱动开发 | 以红-绿-重构循环驱动功能与缺陷修复，先写失败测试再写最小实现。当用户要新增功能、修 bug 或需要回归保护时使用。 | 实现新功能,修复缺陷,为存量代码补回归测试 |
| 219 | `unit-test-generation` | 单元测试生成 | 为给定代码或模块生成高价值单元测试，覆盖正常路径、边界条件与异常分支，并控制运行时间。当用户要求补测试或提高覆盖率时使用。 | 为新代码补测试,覆盖率不足需补齐,为遗留函数补回归测试 |
| 220 | `integration-test-design` | 集成测试设计 | 设计跨模块、跨服务、跨数据库的集成测试，定义测试环境、数据准备与清理策略。当用户需要验证组件协作或接口联调时使用。 | 验证多个模块协作,接口联调,数据库读写链路验证 |
| 221 | `e2e-test-automation` | 端到端测试自动化 | 用浏览器或端到端框架编写稳定的关键用户路径测试，涵盖定位策略、等待机制与失败诊断。当用户要验证完整用户流程时使用。 | 验证注册/下单等完整流程,UI 回归,发版前冒烟 |
| 222 | `test-coverage-analysis` | 测试覆盖分析 | 解读覆盖率报告，识别真正的测试盲区与过度测试区域，给出按风险排序的补测建议。当用户询问覆盖率缺口或设置质量门禁时使用。 | 覆盖率不达标,需要找出未测分支,设置 CI 质量门禁 |
| 223 | `flaky-test-doctor` | 不稳定测试治理 | 诊断随机失败或时好时坏的测试，按根因分类（时序、共享状态、外部依赖、断言过紧）并给出修复方案。当用户反馈测试偶发失败时使用。 | 测试偶发失败,CI 频繁误报,需要隔离不稳定用例 |
| 224 | `test-strategy` | 测试策略设计 | 为项目或新功能制定分层测试策略，明确各层覆盖范围、质量目标、门禁规则与资源投入。当用户要搭建测试体系或规划版本测试时使用。 | 新项目搭建测试体系,版本测试规划,测试资源不足需取舍 |
| 225 | `benchmark-performance-test` | 基准与性能测试 | 为关键代码路径建立可重复的性能基准，检测优化效果与性能回退，并给出容量与瓶颈判断依据。当用户优化性能或担心性能回退时使用。 | 性能优化前后对比,怀疑性能回退,容量规划需要数据 |

### 产品与需求（8）

| 序号 | ID | 名称 | 说明 | 触发场景 |
| --- | --- | --- | --- | --- |
| 226 | `prd-writing` | PRD 需求文档撰写 | 撰写结构完整的需求文档，覆盖背景、目标、用户故事、验收标准与非功能要求。当用户要写 PRD 或整理需求时使用。 | 启动新功能,需求评审前,需要明确范围与验收标准 |
| 227 | `requirement-decomposition` | 需求拆解与任务分解 | 把模糊需求拆成可执行的任务，明确依赖关系、验收标准与工作量，输出可并行执行的计划。当需求太大无法直接开发时使用。 | 需求太大需要拆解,规划迭代排期,多团队协作分工 |
| 228 | `acceptance-criteria` | 验收标准定义 | 为需求编写可验证的验收标准，确保开发与测试对"做完"的定义一致。当需求交付标准模糊或测试用例需从需求生成时使用。 | 需求交付标准不清,编写测试用例,验收阶段争议 |
| 229 | `roadmap-planning` | 路线图规划 | 规划产品版本路线图，围绕目标安排节奏、里程碑与取舍依据。当用户要规划季度计划或版本节奏时使用。 | 规划下季度目标,版本节奏安排,需要明确不做什么 |
| 230 | `competitor-analysis` | 竞品分析 | 系统性调研竞品的功能、体验与定位，识别差异机会并形成可决策的对比结论。当用户要评估竞品或明确差异化策略时使用。 | 制定产品策略,评估竞品动作,需要明确差异化 |
| 231 | `user-research` | 用户研究整理 | 整理用户访谈、反馈与行为数据，提炼真实需求与痛点，产出可支撑决策的洞察。当用户有原始调研材料需要分析时使用。 | 有访谈记录需整理,用户反馈需要归类分析,需要验证需求假设 |
| 232 | `feature-scoping` | 功能范围控制 | 识别需求中的必要与可选部分，定义最小可用范围并明确延期项。当需求膨胀或资源不足需要取舍时使用。 | 需求范围过大,资源不足需削减,定义 MVP 范围 |
| 233 | `metrics-definition` | 产品指标定义 | 定义产品核心指标与埋点方案，明确计算口径、数据来源与验证方式，避免指标定义不一致。当指标含义有歧义时使用。 | 指标口径不一致,设计埋点方案,新功能需要度量 |

### 前端与设计（8）

| 序号 | ID | 名称 | 说明 | 触发场景 |
| --- | --- | --- | --- | --- |
| 234 | `frontend-implementation` | 前端界面实现 | 按设计稿或需求实现高质量前端界面，覆盖布局、状态、响应式与交互细节，产出可直接运行的代码。当用户要实现页面或组件时使用。 | 实现页面或组件,按设计稿还原界面,优化现有界面代码 |
| 235 | `responsive-design` | 响应式与移动适配 | 让界面在手机、平板、桌面等不同尺寸下都可用，处理断点策略、布局重排与触摸交互。当用户要适配多端或修复移动端问题时使用。 | 移动端适配,平板与大屏适配,布局在某些设备上错乱 |
| 236 | `accessibility-audit` | 无障碍审查 | 按 WCAG 标准检查界面的可访问性，覆盖对比度、键盘导航、语义结构与辅助技术兼容。当用户关心可访问性或收到无障碍反馈时使用。 | 页面无障碍检查,需要符合 WCAG 标准,键盘无法操作的问题 |
| 237 | `web-performance` | Web 性能优化 | 优化网页加载与交互性能，围绕核心指标定位瓶颈并给出可验证的改进。当用户反馈页面慢、首屏空白或交互卡顿时使用。 | 页面加载慢,首屏体验差,交互有卡顿 |
| 238 | `design-system` | 设计系统建设 | 建立设计令牌与组件库规范，统一颜色、字号、间距与交互模式并沉淀使用文档。当项目界面风格混乱或需要统一体验时使用。 | 界面风格不统一,需要建立组件库,重复实现同类组件 |
| 239 | `ui-copywriting` | 界面文案优化 | 优化界面上的按钮、提示、错误信息与空状态文案，让用户知道发生了什么、下一步做什么。当界面反馈不清或转化不佳时使用。 | 按钮文案含糊,错误提示看不懂,空状态缺少引导 |
| 240 | `frontend-testing` | 前端测试与组件验证 | 为前端组件编写测试，覆盖渲染、交互、状态与边界，并可加入视觉回归对比。当用户要补前端测试或防止界面回退时使用。 | 组件缺少测试,界面改动引发回归,需要视觉回归保护 |
| 241 | `prototype-design` | 交互原型设计 | 为新功能设计页面流程与可交互原型，在编码前验证方案与关键路径。当用户要设计功能流程或验证交互设想时使用。 | 新功能方案验证,流程不清晰需要梳理,需要给 stakeholders 看效果 |

### 代码评审与重构（7）

| 序号 | ID | 名称 | 说明 | 触发场景 |
| --- | --- | --- | --- | --- |
| 242 | `code-review` | 代码审查 | 对代码变更做结构化审查，定位正确性、复杂度、安全与可维护性问题，并输出按严重度分级的可执行修改建议。当用户提供 diff、分支、提交或 PR 时使用。 | 用户要求 review / 审查代码,提交 PR 前自查,评估他人分支的改动质量 |
| 243 | `pull-request-authoring` | PR 撰写与拆分 | 把工作区改动整理成小而聚焦的 Pull Request，生成符合 Conventional Commits 的标题、变更说明、测试证据与截图清单。当用户准备提交 PR 或整理提交历史时使用。 | 用户要提交 PR / 合并请求,需要整理提交历史,一个改动太大需要拆成多个 PR |
| 244 | `refactoring` | 重构规划 | 在不改外部行为的前提下规划并执行重构，识别坏味道、给出分阶段改造方案并控制回归风险。当用户要求重构、简化代码或清理技术债时使用。 | 用户要求重构或简化代码,代码难维护、重复严重,准备做大规模技术债清理 |
| 245 | `code-smell-detection` | 代码坏味道识别 | 静态扫描代码库中的常见坏味道与反模式，输出带位置、影响与修复建议的问题报告。当用户要求体检代码质量、排查反模式或做上线前检查时使用。 | 代码库体检,上线前质量把关,排查重复与复杂度问题 |
| 246 | `code-review-response` | 评审意见处理 | 对收到的代码评审意见进行技术核实与分类，识别正确意见、误解与不建议，生成回复与修改计划。当用户贴出 review 评论或询问如何回应时使用。 | 收到 PR review 评论,需要回复评审人,对评审意见有异议 |
| 247 | `git-workflow` | Git 分支与提交工作流 | 按团队约定管理分支创建、提交粒度、变基合并与冲突处理，保证历史清晰可回溯。当用户涉及分支操作、提交整理或合并冲突时使用。 | 需要新建分支或整理提交,解决合并冲突,回退错误提交 |
| 248 | `legacy-modernization` | 遗留系统现代化 | 为老旧代码库制定分阶段现代化方案，识别高风险热点并在持续交付的前提下逐块替换。当用户要改造遗留系统、下线旧模块或升级技术栈时使用。 | 老系统维护困难,要替换废弃框架,技术栈升级 |

### AI 与智能体（7）

| 序号 | ID | 名称 | 说明 | 触发场景 |
| --- | --- | --- | --- | --- |
| 249 | `prompt-engineering` | 提示词工程 | 设计结构化提示词并通过系统化方法验证与迭代效果，覆盖角色、约束、示例与输出格式。当用户要优化模型输出质量时使用。 | 模型输出不稳定,需要固化提示词规范,构建新的 AI 功能 |
| 250 | `llm-integration` | 大模型应用集成 | 在应用中集成大模型能力，处理调用、流式输出、重试、限流、成本与错误处理。当用户要接入模型 API 时使用。 | 接入模型 API,模型调用不稳定或超时,需要控制推理成本 |
| 251 | `rag-pipeline` | 知识检索增强 | 搭建文档检索增强流程，处理切分、向量化、召回、重排与引用，保证回答有据可查。当用户要让模型基于自有文档回答时使用。 | 构建知识库问答,回答需要引用来源,减少模型幻觉 |
| 252 | `agent-architecture` | 智能体架构设计 | 设计智能体的角色、工具、记忆与执行流程，控制失控风险并设计人工介入点。当用户要构建可自动执行的智能体时使用。 | 构建自动化智能体,智能体行为不稳定,智能体需要调用工具 |
| 253 | `mcp-server-builder` | MCP 服务开发 | 开发 MCP 服务，把内部系统或外部 API 封装为模型可安全调用的工具。当用户要接入外部系统到 AI 助手时使用。 | 把内部系统接入模型,封装第三方 API,统一工具接入方式 |
| 254 | `llm-eval` | 模型效果评估 | 建立模型输出的评估体系，用评测集与评分标准衡量效果并防止改动引起回退。当用户要评估模型效果或比较模型选型时使用。 | 上线前验证模型效果,更换模型或版本,提示词改动后验证 |
| 255 | `ai-cost-control` | AI 成本与稳定性 | 控制模型调用成本与稳定性，通过缓存、模型分级、限流与降级提升性价比。当用户关心 token 成本或调用不稳定时使用。 | 模型费用超预期,需要优化成本,调用量增长带来压力 |

