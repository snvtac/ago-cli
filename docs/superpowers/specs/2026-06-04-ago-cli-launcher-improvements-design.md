# ago-cli 启动器增强 设计文档

- 日期:2026-06-04
- 范围:#1 修复 Claude 数据源、#2 frecency 排序、#3 `ago -` 快速重开、#5 恢复上次会话
- 方向约束:**保持轻量极速**,不引入新的运行时依赖,维持现有文件边界(`project-index.ts` 管数据,`index.ts` 管交互)。

---

## 1. 背景与动机

`ago` 当前从 Codex 与 Claude 的本地历史聚合项目并启动对应 CLI。但 Claude 数据源已与现行 Claude Code 版本脱节。

### 1.1 实测证据(本机,Claude Code v2.1.162 / codex-cli 0.135.0)

用项目自带的 `buildProjectIndex` 跑真实数据:

| 指标 | 实际值 |
|---|---|
| `~/.claude` 下 `sessions-index.json` 文件数 | **0** |
| codex 观测数 | 6 |
| claude 观测数(仅读 `sessions-index.json`) | **0** |
| 默认 `ago` 显示的项目数 | **3,全部为 codex** |
| 实际存在的 Claude 项目目录数 | **19**(共 1417 个 transcript) |

结论:`collectClaudeObservations` 在现行版本下返回空,`ago` 几乎丢失了整个 Claude 一侧的历史。

### 1.2 现行真实数据布局

- **Claude 全局历史** `~/.claude/history.jsonl`(本机 1675 行):每行 `{ display, pastedContents, timestamp, project, sessionId }`。
  - `project` = 项目绝对路径;`timestamp` = epoch 毫秒(字符串);`sessionId` = 会话 UUID;`display` = 当次输入的 prompt 原文。
- **Claude 会话 transcript** `~/.claude/projects/<编码路径>/<session-uuid>.jsonl`:`user`/`assistant` 行带 `cwd`、`gitBranch`、`timestamp`、`sessionId`、`version`。
  - 目录名是把路径里的 `/`、`.` 等替换为 `-` 后的编码,**不可逆**,因此真实路径只能取自行内 `cwd`。
  - 文件前几行可能是 `permission-mode` / `file-history-snapshot`,不含 `cwd`,需向后扫描若干行。
- **遗留** `sessions-index.json`:现行版本不再生成,但老版本可能有,保留为兜底。

### 1.3 CLI 能力(实测)

- claude:`-c/--continue`(继续最近)、`--resume <id|name>`、`-n/--name`、`--model`、`--add-dir`。
- codex:`codex resume --last`、`codex resume <SESSION_ID>`、`codex fork`、`-C/--cd <dir>`、`-m`。
  - 注意:`codex resume --last` 取的是**全局**最近会话,可能不属于目标项目;因此恢复会话一律用**精确 sessionId**。

---

## 2. 数据模型演进

```
ProjectObservation {
  path: string
  tool: "codex" | "claude"
  lastSeenAt: number
  sessionId?: string        // 新增
}

ProjectIndexItem {
  path, name, sources, sourceLabel,
  lastSeenAtByTool: { codex, claude },
  lastSeenAt, exists,
  frecencyScore: number,                       // 新增:排序用
  lastSessionIdByTool: { codex?: string; claude?: string }  // 新增:可恢复的最近会话
}
```

**观测粒度统一为"每会话一条"**,使两侧的频次可比:

- Codex:每个 rollout 文件 = 一条观测(`sessionId` 取 `payload.id`)。
- Claude:按 `sessionId` 去重后 = 一条观测(`lastSeenAt` 取该会话的最大时间戳)。

合并 (`mergeProjectObservations`) 时,对每条观测:
1. 更新 `lastSeenAtByTool[tool]`;
2. `frecencyScore += frecencyWeight(now - lastSeenAt)`;
3. 若该观测的 `lastSeenAt` 是该工具迄今最大值,则记录其 `sessionId` 到 `lastSessionIdByTool[tool]`。

### 2.1 frecency 权重

zoxide 风格年龄分桶(可调常量):

| 距今 | 权重 |
|---|---|
| ≤ 1 小时 | 4 |
| ≤ 1 天 | 2 |
| ≤ 1 周 | 0.5 |
| 更早 | 0.25 |

`now` 作为可注入参数(默认 `Date.now()`),便于单测。

### 2.2 时间戳解析

`history.jsonl` 的 `timestamp` 是纯数字字符串(epoch)。扩展 `toEpochMs`:
- 数字 / 全数字字符串:解析为整数;若 `< 1e12` 视为秒并 ×1000,否则视为毫秒。
- 其余字符串:仍走 `Date.parse`(兼容 `modified` 这类 ISO 串)。

---

## 3. 功能设计

### 3.1 #1 修复 Claude 数据源

`collectClaudeObservations(homeDir)` 改为"三级数据源 + 按 sessionId 去重补全":

1. **主源 `history.jsonl`** — 新增 `parseClaudeHistoryFile(filePath)`:逐行解析,产出 `{ path: project, tool: claude, lastSeenAt, sessionId }`(同一 `sessionId` 取最大 `lastSeenAt`,合成一条)。
2. **补全:transcript 扫描** — 新增 `collectClaudeFromTranscripts(homeDir)`:遍历 `~/.claude/projects/<dir>/`,对每个目录只取 **mtime 最新的 `.jsonl`**,读其前若干行直到拿到含 `cwd` 的行,产出 `{ path: cwd, tool: claude, lastSeenAt, sessionId }`。
3. **遗留兜底** — 保留 `parseClaudeSessionsIndexFile`(若文件仍存在)。

**去重规则:** 维护已见 `sessionId` 集合,按 **1(history)→ 2(transcript)→ 3(遗留 index)** 顺序加入;后来的源只补充集合中尚未出现的 `sessionId`,避免频次被重复计数(`lastSeenAt` 始终取最大值,故源的先后不影响 recency)。遗留 index 记录通常无 `sessionId`,按 `path` 去重:仅当该 `path` 尚未被任何带 `sessionId` 的观测覆盖时才作为一条补充观测加入。

**硬规则:** 绝不反解目录名得到路径;路径只取自 `cwd` / `project`。

### 3.2 #2 frecency 排序

合并结果按 `frecencyScore` 倒序;并列时按 `lastSeenAt` 倒序,再按 `path` 升序。**frecency 为默认排序**(已与用户确认),不加开关、不加 config 字段。

### 3.3 #3 `ago -`(快速重开上次)

- `AgoState` 新增 `lastLaunch?: { path, tool, ts }`,每次成功启动后写入。
- argv 处理:`normalizeArgv` 在 `-` 作为**首个 CLI token**(`argv[2]`)时映射为 `--last`;新增 commander 选项 `-l, --last`。(避免与 `-c -` 这类把 `-` 当作内容的情况冲突。)
- `reopenLastLaunch(state, config)`:校验 `lastLaunch` 存在、`path` 仍存在、CLI 在 PATH;通过则跳过所有菜单,在该目录直接以 `tool` 启动(语义为"新会话",非恢复);可与 `-c` 组合传入初始内容。
- 兜底:任一校验不过(无记录 / 路径丢失 / CLI 缺失),打印清晰原因后**回落到普通交互流程**,绝不做成死路。

### 3.4 #5 恢复上次会话

- 新增 `buildResumeArgs(tool, sessionId)`:
  - codex → `["resume", sessionId]`
  - claude → `["--resume", sessionId]`
- `chooseToolForProject` 菜单:对 `lastSessionIdByTool[tool]` 存在的工具增加"继续上次会话"项。推荐工具排第一,只对有历史会话的工具显示"继续":
  ```
  ❯ claude — 继续上次会话  (recommended)
    claude — 新会话
    codex  — 新会话
    ← 返回项目列表
  ```
- 恢复会话时**忽略 `-c`**(交互式 resume 不稳妥地接初始 prompt),并打一行 dim 提示。
- 恢复成功后照常更新 `lastLaunchedByPath` 与 `lastLaunch`(它仍是一次该工具在该项目的启动)。

---

## 4. 边界情况

- `history.jsonl` 缺失 → 仅 transcript 扫描 + 遗留兜底。
- transcript 仅含无 `cwd` 的行(纯 snapshot/permission)→ 该文件跳过。
- 观测无 `sessionId` → 仍计入 frecency/recency,但不提供"继续会话"。
- 项目路径已不存在 → 与现状一致:`-al` 标记 `missing`;启动前报错并继续。
- 旧 `state.json` 无 `lastLaunch` → `normalizeState` 安全忽略,`ago -` 走兜底。
- codex epoch 秒 / claude epoch 毫秒,由 `toEpochMs` 统一。

---

## 5. 测试策略(沿用 `node:test` + 临时目录)

纯函数单测:
- `frecencyWeight` 分桶、合并后的排序顺序。
- `parseClaudeHistoryFile`:字段提取、同 `sessionId` 取最大时间、数字字符串时间解析。
- `collectClaudeFromTranscripts`:取最新文件、向后扫描拿 `cwd`、`sessionId` 提取。
- 三级数据源 + 去重:构造同时存在 history / transcript / 遗留 index 的临时 `~/.claude`,断言不重复计数且覆盖齐全。
- `buildResumeArgs`(codex/claude 两路)。
- `normalizeArgv`:`-` → `--last` 仅在首 token;`normalizeState`/`saveState` 往返保留 `lastLaunch`。
- `getRecommendedTool` 在新增字段下回归不变。

---

## 6. 不在本轮范围

- #4 更丰富的列表列(git 分支 / prompt 摘要 / 会话数)。
- #6 `ago --doctor` 体检命令。
- 支持更多 CLI(gemini / aider 等)、git 状态集成、Nerd Font 图标。

---

## 7. 已定决策

- frecency 作为默认排序(不加开关)。
- 恢复会话用精确 `sessionId`,不用 `--last`/`--continue`。
- `ago -` 语义为"重开上次项目+CLI 的新会话";恢复历史会话是独立的菜单项(#5)。
- 不新增运行时依赖;`history.jsonl` 为 Claude 主数据源,transcript 扫描为补全。
