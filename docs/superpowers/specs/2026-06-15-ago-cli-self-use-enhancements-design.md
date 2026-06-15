# ago-cli 自用增强(项目置顶 + 历史会话选择器)设计文档

- 日期:2026-06-15
- 范围:#A 项目置顶/收藏(`ago pin` / `ago unpin`)、#B 恢复指定历史会话(项目 → 工具 → "选择历史会话…")
- 方向约束:**保持轻量极速、不新增运行时依赖、维持现有文件边界**(`project-index.ts` 管数据与文件读取,`index.ts` 管 CLI 命令与交互,`doctor.ts` 管诊断);`config.json` 仍为"手改、工具只读",**所有工具写入只落 `state.json`**。
- 本文档已经过 5 个子 agent 的深度评审(数据模型 / 会话数据源 / state 持久化 / 交互流 / 架构与测试),关键事实与修正已并入正文。

---

## 1. 背景与动机

`ago` 已能从 Codex/Claude 本地历史聚合项目、按 frecency 排序、启动或恢复 CLI。两个高频自用痛点尚未解决:

1. **置顶常用项目**:frecency 之外缺一个"我就是天天用这几个"的手动置顶能力。
2. **恢复指定历史会话**:当前只能"继续上次会话"(`lastSessionIdByTool[tool]`,每工具仅保留最近一个),无法在一个项目下列出多个历史会话挑一个恢复。

### 1.1 评审实测证据(本机真实数据)

| 指标 | 实际值 | 来源 |
|---|---|---|
| `~/.claude/history.jsonl` 行数 / distinct sessionId / 覆盖项目数 | 1992 / **297** / 21 | 评审实测 |
| `~/.claude/projects/*/` 下 transcript 文件数(文件名即 sessionId) | **752** | 评审实测 |
| transcript sessionId **不在** history 中的数量 | **667** | 评审实测 |
| history sessionId **没有**对应 transcript 文件的数量 | 212 | 评审实测 |
| `collectClaudeFromTranscripts` 每目录只取最新文件,被丢弃的 transcript 会话 | ~731 | 代码 `project-index.ts:499-520` |
| history 中"最早一行是斜杠命令(`/status` 等)"的会话数 | **186 / 297** | 评审实测 |
| Codex session 文件数 / 首行均为 `session_meta` 且含 `payload.id` | 69 / 100% | 评审实测 |

**结论(直接决定 #B 的数据策略):**

- **只读 `history.jsonl` 会漏掉约 60% 的可恢复 Claude 会话**,且 `history.jsonl` 的 `display` 字段最早一行常是斜杠命令,不能当作"首句 prompt"。
- 因此 **Claude 会话列表与预览必须来自 transcript 文件**(文件名 = sessionId,首条 user 消息 = 可靠首句)。为不拖慢启动,采用**懒扫描**:仅在用户打开"选择历史会话…"时、且只扫该项目对应的 transcript 目录。
- **Codex 完全免费且完整**:`collectCodexObservations` 本就读取每个 session 文件首行,`payload.id` 即 `codex resume <id>` 所需 id;无 prompt 文本,故无预览。Codex 会话列表在既有扫描中即可得到,无需额外 I/O。

---

## 2. 数据模型变化(`project-index.ts`)

```
SessionRef {                       // 新增
  sessionId: string
  lastSeenAt: number
  preview?: string                 // Claude 懒扫描时填入;Codex 恒空
}

ProjectIndexItem {
  ...现有字段,
  pinned: boolean                                  // 新增:由 index 层注入(见 §2.3),非纯函数产物
  sessionsByTool: { codex: SessionRef[] }          // 新增:Codex 会话列表(merge 时免费构建,newest-first)
  sessionCountByTool: { codex: number; claude: number }  // 新增:仅供"≥2 才显示 picker"判定
  claudeTranscriptDir?: string                     // 新增:该项目的 Claude transcript 目录绝对路径,懒扫描入口
}

AgoState {
  lastLaunchedByPath, lastLaunch?,
  pinnedPaths: string[]            // 新增:绝对路径数组
}
```

- **`ProjectObservation` 不变**:Codex 的 `sessionsByTool.codex` 直接由现有观测(已含 `sessionId`)构建;Claude 预览走懒扫描读 transcript,不经观测层。无需给观测加 `preview`。
- **`lastSessionIdByTool` 保持现状**:仍是"继续上次会话"与推荐工具的来源,逻辑不动。

### 2.1 `mergeProjectObservations`(保持纯函数,签名不变)

- 新增:按 `sessionId` 去重累积 `sessionsByTool.codex`(只处理 `tool === codex` 的观测),并在 `.map()` 投影里**显式按 `lastSeenAt` 降序排序**,并列时按 `sessionId` 升序兜底(因为 merge map 的迭代是插入序,不是时间序——评审指出的隐患)。`sessionsByTool.codex[0]` 因此就是最近一条。
- **不引入 `pinnedPaths` 参数,不做 pinned 排序**(评审决定):该函数被 `doctor.ts:292` 复用,必须保持中立、不读 state。`now` 仍是唯一可注入参数。
- 不构建 `sessionsByTool.claude`(懒扫描产出)。
- frecency 计数完全不变:`sessionsByTool` 在同一循环里累积,不重复推入观测,`frecencyScore += frecencyWeight(...)` 一行不动。

### 2.2 `buildProjectIndex`(返回类型不变 = `ProjectIndexItem[]`)

新增一步"Claude 目录元信息"采集并 annotate 到 items:

1. 收集 `claudeDirInfo: Map<path, { dir, sessionCount }>`:复用/重构 `collectClaudeFromTranscripts` 的目录遍历——它本就对每个目录读"最新文件的 `cwd`"得到项目 path;顺手记录该目录的绝对路径与 `.jsonl` 文件计数(`readdir` 长度,**不读文件内容**)。最新文件首 50 行无 `cwd` 的目录无法映射 path,跳过(该项目无 `claudeTranscriptDir`,picker 不列 Claude 会话)。
2. `mergeProjectObservations` 得到 items 后,对每个 item:
   - `sessionsByTool.codex` 来自 merge 结果;`sessionCountByTool.codex = sessionsByTool.codex.length`。
   - 若 `claudeDirInfo.has(path)`:写入 `claudeTranscriptDir` 与 `sessionCountByTool.claude = sessionCount`,否则 claude 计数为 0、`claudeTranscriptDir` 为 undefined。
3. `filterProjectsByRoots` 收尾(不变)。

> `pinned` 不在此设置(见 §2.3)。`doctor.ts` 不调用 `buildProjectIndex`(它自行 `collect* + merge + filter`),故以上改动不影响 doctor。

### 2.3 pinned 标记与排序(放 index 层,纯函数)

- `pinnedPaths` 仅在交互流 `runInteractive` 中通过 `loadState` 拿到(`index.ts:564`)。
- 新增纯函数 `sortWithPins(items: ProjectIndexItem[], pinnedPaths: string[]): ProjectIndexItem[]`(放 `project-index.ts`,可单测):标记每个 item 的 `pinned`,并以 **pinned 优先**重排;两组内部各自保持传入顺序(已是 frecency → lastSeenAt → path)。pinnedPaths 为空时退化为原序(回归保证)。
- `runInteractive` 在构建 choices 前调用 `sortWithPins`。`★` 字符串拼接属交互层(见 §3.4)。

### 2.4 state 往返安全(评审确认的"必丢 pins"陷阱)

`normalizeState` 不是 in-place,而是**新建对象只拷贝白名单字段**(`project-index.ts:758-792`);`saveState` 写盘前必先 `normalizeState`(`:943-948`)。因此**任何未被 `normalizeState` 显式携带的字段会在下一次 `saveState`(如一次普通 `ago` 启动调用 `performLaunch`)时被静默擦除**。

修复为**强制三联改动,缺一不可**:

1. `AgoState` 接口加 `pinnedPaths: string[]`;
2. `DEFAULT_STATE`(`:61-63`)加 `pinnedPaths: []`;
3. `normalizeState` 显式从 `rawState.pinnedPaths` 校验:是数组 → 逐项 `typeof === "string"` 且非空 → `normalizeProjectPath` → 去重去空 → 写入 `out.pinnedPaths`;否则 `[]`。

旧 state 文件无该键时经此自然降级为 `[]`,无需迁移代码。

---

## 3. 功能 A:项目置顶 `ago pin` / `ago unpin`

### 3.1 命令与参数解析

新增 commander 子命令(与 `doctor`/`config` 同构,各自 `.allowExcessArguments(false)`、`.argument("[name]")`):

```
ago pin [name]
ago unpin [name]
```

`[name]` 解析(**优先级钉死:本地存在目录 > 模糊匹配索引**):

1. **省略** → 用 `process.cwd()`。
2. **是本地存在的目录**(`.` / `./x` / `~/git/x` / 绝对路径)→ `normalizeProjectPath(expandHome(name))` 得到绝对路径。
3. **否则模糊匹配项目索引**(`filterProjectsByNameQuery`):唯一命中 → 用该 `project.path`;多命中 → 打印候选并 `exit 1`;无命中 → 报错 `exit 1`。

> `.` / `~` / 相对路径与"省略"最终都规范成同一绝对路径,行为一致。

### 3.2 读改写(对称地避免反向丢字段)

`pin`/`unpin` 一律 `loadState → 修改 pinnedPaths → saveState`(与 `performLaunch` 同模式),保证不丢 `lastLaunchedByPath`/`lastLaunch`。

- `pin`:把规范化绝对路径加入 `pinnedPaths`(幂等,重复 pin 不产生重复项);打印 `Pinned <path> (N pinned)`。
- `unpin`:**匹配域是 `pinnedPaths` 自身**(精确绝对路径;带 name 时对 pinned 列表做解析/模糊),**不是项目索引**——确保已删除/已不在索引的 pinned 路径仍可移除(评审指出的死状态)。未命中 → 友好提示、`exit 0`。

### 3.3 路径规范化一致性

pin、unpin、与索引命中项三者统一用 `normalizeProjectPath`(承认其 `path.resolve` 语义:去尾斜杠但**不**解析 symlink)。保证写入 `pinnedPaths` 的字符串与后续 unpin 比较、与 `sortWithPins` 比较时一致。

### 3.4 列表渲染与排序

- `sortWithPins` 使 pinned 项置顶(组内仍 frecency)。
- `★` 标记:为**每一行**预留固定宽度的 marker 前缀列(pinned 显示 `★`、其余显示等宽空格),并把该宽度计入 `getColumnWidths`/`fitText` 的对齐计算(评审指出 `fitText`/`padEnd` 基于 `.length`,只给 pinned 行加前缀会破坏 Name/Date/Platform[/Status] 对齐)。`★` 用 `chalk.yellow`,颜色码不计入显示宽度。
- 同时作用于 `search` 与 `select` 两条 prompt 代码路径(`chooseProject`)。

### 3.5 pinned + missing 的可见性(钉死)

- 默认模式:**保留现有 `exists` 过滤**(`index.ts:567`),pinned **不**绕过 missing 过滤——pinned 但路径已不存在的项目在默认模式不出现。
- `-al` 模式:照常显示,带 `★` 且状态列标 `missing`。
- 失效 pinned 由 `doctor` 给 warning(§5)、由 `unpin` 可清理。

### 3.6 argv 边界

- `normalizeArgv` 的 `argv[2] === "-" → --last` 只看第三个 token,`ago pin -` 的 `argv[2]` 是 `"pin"`,不触发,`-` 可作为 name 原样传入。
- 但 `-al → --all` 是**全量 `map`**(`index.ts:418`),`ago pin -al` 会把 `-al` 改写成 `--all`,pin 子命令未声明该选项 → commander 报错。故**文档声明:不支持以 `-`/`-al` 开头的 name**;此类目录请用绝对路径或 `--` 分隔。

---

## 4. 功能 B:历史会话选择器

### 4.1 菜单入口

`buildToolMenuChoices`:当 `project.sessionCountByTool[tool] >= 2` 时,在该工具下追加一项 `选择历史会话…`(value `pick:<tool>`)。仅 1 个会话时"继续上次会话"已覆盖,不重复显示。

`ToolSelection` 改为 `{ tool, action: "resume" | "new" | "pick" }`;`parseToolSelection` 新增 `pick:` 分支,`__back__` 与未知值**仍返回 `null`**(沿用现有"取消/返回项目列表"语义)。

**必须同步改动的调用点**(评审清单):`index.ts` 的 `ToolSelection` 定义(`:44-47`)、`parseToolSelection` 三处返回(`:467/474` + 新增 pick)、`runInteractive` 解构 `:614` 与核心分支 `:634` 的 `if (resume)`。

### 4.2 会话列表来源

`chooseSessionForTool(project, tool, prompts, chalk, homeDir)`:

- **Codex**:用内存中的 `project.sessionsByTool.codex`(免费,无 I/O)。行格式:`日期 + 短 sessionId(前 8 位)`,无预览。
- **Claude**:**懒扫描** `project.claudeTranscriptDir`——`readdir` 取全部 `.jsonl`(文件名即 sessionId),对每个文件用现有 `readLeadingLines` 读前若干行,取**首条 user 消息**作 `preview`,时间取首行 `timestamp` 或文件 mtime。行格式:`日期 + 首句预览`。只列**真实存在的 transcript 文件**,天然可被 `claude --resume <id>` 恢复。
- 两侧均 newest-first;并列按 sessionId 兜底。
- **上限 30 条**;超出在末尾追加一条 `disabled` 的 dim 行 `+K 更早会话已隐藏`(复用现有 `disabled` 项模式,`select` 会跳过;不静默截断)。
- 末尾含 `← 返回`。

### 4.3 导航层级(评审阻断项)

"← 返回"必须回到**工具菜单**,而非项目列表。现状 `chooseToolForProject` 取消返回 `null`,`runInteractive` 把 `null` 当作"回项目列表/单匹配则退出程序"(`index.ts:606-612`),二者语义冲突。

方案:在 `chooseToolForProject` 内为 `pick` 起一个**内层 `while` 循环**——选择 `pick:<tool>` → 进 `chooseSessionForTool`;若用户在 picker 选"← 返回",重绘工具菜单(留在内层循环),不向 `runInteractive` 返回 `null`。只有在工具菜单本身取消时才返回 `null`(回项目列表/退出)。这样:
- 单匹配流(`singleMatchFlow`)下 picker"返回"也只回工具菜单,不会误退出程序。
- `runInteractive` 外层 `null → 项目列表` 语义保持不变。

### 4.4 恢复执行

- picker 选中某 sessionId → 复用 `buildResumeArgs(tool, sessionId)`(已支持 `codex resume <id>` / `claude --resume <id>`,`index.ts:450-461`)。
- `action === "resume" || action === "pick"` 共用 resume 分支:取 sessionId(`resume` 取 `lastSessionIdByTool[tool]`,`pick` 取选中项),并都打印现有 `Ignoring -c content when resuming` 提示(`:637-639`)。
- 照常 `performLaunch` 更新 `lastLaunchedByPath`/`lastLaunch`(`:540-542`)。

### 4.5 与"继续上次会话"的冗余

picker 列表的最新一条 == "继续上次会话"的 sessionId(都来自最近会话)。v1 接受这一轻度冗余,不特殊标注(后续可在该行加"= 上次"标签)。

---

## 5. Doctor 表面(最小增量)

- `DoctorReport.state` 子对象新增 `pinnedCount: number`(与 `lastLaunchPathExists` 并列,归 `state` 类别,保持结构一致)。
- 新增**一条** check:`state.pinned_paths_exist`,**warning-only**,语义与既有 `state.last_launch_path`(`doctor.ts:224-228`)同构;多个失效路径**聚合成单条**,`details.missingPinned: string[]`(对齐 `config.roots_exist` 的 `missingRoots`,`doctor.ts:200-205`)。
- **退出码不受影响**:warning 不升 error,`index.ts:748-750` 仍只在 `errorCount > 0` 时 `exit 1`。已定决策:此 check 永不升级为 error。
- `FORMAT_VERSION` **保持 `"1.0"`**:新增字段是向后兼容的 additive 变更(参照 doctor 设计 §2.2 的 Terraform 语义),不破坏既有机器消费者。
- `config show` **不变**(pins 在 state,不在 config);pins 的可发现性由列表 `★` + `doctor.state.pinnedCount` 提供。

---

## 6. 边界情况

- 旧 `state.json` 无 `pinnedPaths` → `normalizeState` 默认 `[]`。
- 重复 `pin` → 幂等;`unpin` 未 pin 项 → no-op、`exit 0`。
- pin 一个不在索引中的本地目录 → 允许(意图就是置顶常用目录);默认模式仍受 `exists` 过滤约束。
- Claude 项目目录最新文件无 `cwd` → 无 `claudeTranscriptDir`,该项目 picker 不列 Claude 会话(Codex 仍可列)。
- transcript 文件读不到首条 user 消息 → 预览留空,仅显示日期 + 短 id,不影响恢复。
- 会话无 `sessionId`(实测 Claude/Codex 均极罕见)→ 不进列表(无法恢复)。
- `claudeTranscriptDir` 下文件数巨大 → 受 30 条上限保护;懒扫描只发生在打开 picker 时、只扫该一个目录。
- 恢复时忽略 `-c`(沿用现状)。

---

## 7. 文件边界

- **`project-index.ts`**:`SessionRef` 类型;`ProjectIndexItem` 新增字段;`mergeProjectObservations` 构建 `sessionsByTool.codex`(显式排序);`buildProjectIndex` 采集 `claudeDirInfo` 并 annotate;`sortWithPins` 纯函数;`AgoState.pinnedPaths` + `DEFAULT_STATE` + `normalizeState` 三联;Claude 懒扫描 helper(如 `collectClaudeSessionsForDir(dir)` 返回 `SessionRef[]`)。
- **`index.ts`**:`pin`/`unpin` 子命令与 `[name]` 解析;`sortWithPins` 调用 + `★` 渲染与列宽;`buildToolMenuChoices` 入口;`parseToolSelection`/`ToolSelection` 三态;`chooseToolForProject` 内层循环;`chooseSessionForTool`;resume/pick 共用分支。
- **`doctor.ts`**:`state.pinnedCount` + `state.pinned_paths_exist` 一条 check(经 `inspectState` 取 `pinnedPaths` 并逐个 `fs.existsSync`)。
- **无新增运行时依赖**(picker 复用 inquirer `select`;命令式 pin 无需 checkbox)。

---

## 8. 测试策略(沿用 `node:test` + 临时 home)

### 8.1 纯函数 / 数据层

- `normalizeState`:无 `pinnedPaths` → `[]`;非数组/含非字符串/未规范化路径 → 安全降级 + `normalizeProjectPath`;`saveState`↔`loadState` 往返保留 `pinnedPaths` **且**不丢 `lastLaunch*`(回归"必丢 pins"陷阱)。
- `mergeProjectObservations`:`sessionsByTool.codex` 按 sessionId 去重、newest-first(含同 `lastSeenAt` 的 sessionId 兜底序);frecency 计数不变(回归);无 pins 时排序与现状一致;`sessionsByTool` 不含 claude。
- `sortWithPins`:pinned 置顶、组内 frecency 稳定;`pinnedPaths` 为空时退化为原序;pinned 集合含不在 items 中的路径时不报错。
- `buildProjectIndex`:annotate `claudeTranscriptDir` 与 `sessionCountByTool`(临时构造 `~/.claude/projects/<dir>/*.jsonl` 多文件 + Codex 多 session 文件)。
- Claude 懒扫描 helper:列全部 `.jsonl`、文件名→sessionId、首条 user 消息→preview、newest-first、空目录/坏文件兜底。
- `buildToolMenuChoices`:仅 `sessionCountByTool[tool] >= 2` 出"选择历史会话…"。
- `parseToolSelection`:`resume:`/`new:`/`pick:` 三态 + `__back__`/未知 → `null`。

### 8.2 集成 / CLI

- `ago pin [name]` 四分支各一例:省略(cwd)、本地目录、模糊唯一命中、模糊多命中(打印候选 + `exit 1`)。
- double-pin 幂等;`ago unpin` 未 pin 项 no-op、`exit 0`;`unpin` 一个已 missing 的 pinned 路径成功移除。
- pinned 在默认模式置顶且带 `★`;pinned **+** missing 在默认模式**不**出现、在 `-al` 出现并标 `missing`;`★` 列宽对齐不破坏(pinned 与非 pinned 混排)。
- picker:`pick` → 选中会话 → 走 resume args;**"← 返回"回到工具菜单**(非项目列表、单匹配流下不退出程序);会话超 30 条出截断 note。
- `ago doctor`:构造一个失效 pinned 路径 → `status="warning"`、`errorCount=0`、进程 `exit 0`、`state.pinnedCount` 正确、`details.missingPinned` 列出该路径。
- 现有 `ago --help` / `ago -` / `-al` / `-n` / `-c` / `config show` 行为不变。

### 8.3 验证命令

```bash
npm test
node --import tsx src/cli.ts doctor | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>JSON.parse(s))'
```

---

## 9. 不在本轮范围

- Codex 会话 prompt 预览(需多读 rollout 文件)。
- 跨项目 prompt 全文搜索。
- `ago prune` 清理失效/陈旧记录。
- 列表内热键切换 pin。
- `ago config set/get`、`ago config roots`。
- 支持更多 CLI(gemini/aider 等)。
- 索引缓存 / 全量预扫描 transcript。
- picker 行内"= 上次会话"标注、会话存在性二次校验(恢复失败回退)。

---

## 10. 已定决策

- 两个功能合入一份"自用增强"spec。
- pins 存 `state.json#pinnedPaths`(绝对路径);`config.json` 保持工具只读。代码库无任何"从 config 读 pins"的现存逻辑,pins 与 config 零耦合。
- **state 往返必须三联改动**(`AgoState` + `DEFAULT_STATE` + `normalizeState`),否则 pins 会被 `saveState` 静默擦除。
- pin/unpin 走 `loadState→mutate→saveState`;`unpin` 匹配 `pinnedPaths` 自身;路径统一 `normalizeProjectPath`;`existing-dir > fuzzy` 优先级;不支持 `-`/`-al` 开头的 name。
- pinned-first 排序为 **`index` 层独立纯函数 `sortWithPins`**,不污染 `mergeProjectObservations`(保护 `doctor.ts` 复用);`★` 渲染需为所有行预留等宽前缀并计入列宽。
- pinned **不**绕过默认模式的 `exists` 过滤。
- **#B 数据策略:Codex 会话免费完整(既有扫描);Claude 会话懒扫描 transcript 目录,完整覆盖 + 可靠首句预览**(只读 history 会漏约 60%,且 `display` 最早行常为斜杠命令,故不采用)。
- `mergeProjectObservations` 仅构建 `sessionsByTool.codex` 且显式 newest-first 排序(merge map 为插入序);`lastSessionIdByTool` 维持现状,作为"继续上次会话"来源。
- picker "← 返回"回**工具菜单**(`chooseToolForProject` 内层循环),不复用 `null`;`__back__`/未知值仍 `null`。
- `ToolSelection` 由 `{tool,resume}` 改为 `{tool,action}`;`resume`/`pick` 共用 resume 分支与"忽略 -c"提示。
- doctor:`state.pinnedCount` + 单条聚合 warning `state.pinned_paths_exist`(`details.missingPinned`),不影响退出码;`FORMAT_VERSION` 沿用 `"1.0"`(additive);`config show` 不变。
- 不新增运行时依赖。
