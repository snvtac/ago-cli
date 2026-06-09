# ago-cli doctor/config 诊断与配置查看 设计文档

- 日期:2026-06-07
- 范围:`ago doctor`、`ago config show`
- 方向约束:**只读诊断优先**,不写配置/状态,不新增运行时依赖,保持现有文件边界(`project-index.ts` 管数据与文件读取,`index.ts` 管 CLI 命令与输出)。

---

## 1. 背景与目标

`ago` 已经可以从 Codex/Claude 本地历史聚合项目,按 frecency 排序,并启动或恢复对应 CLI。但当用户遇到"项目不出现"、"推荐 CLI 不对"、"`ago -` 回退"、"Claude 命令不存在"这类问题时,当前只能在交互流程中看到零散错误。

本轮目标是补上两个只读入口:

- `ago doctor`:输出机器可读 JSON 诊断报告,覆盖运行时、配置、状态、命令、历史数据源、项目索引。
- `ago config show`:输出当前 normalized config,并标明每个配置值来自文件还是默认值。

第一版不提供修复、不写配置、不做交互向导。

---

## 2. 外部 CLI 借鉴

### 2.1 `doctor` 类命令

- Homebrew `brew doctor`
  - 借鉴点:doctor 是环境健康检查入口;支持列出/单独运行检查项;发现潜在问题时可返回非零。
  - 对 `ago` 的落地:每个检查项都给稳定 `id`,第一版只输出,未来可支持 `ago doctor <check-id>`。
  - 参考:https://docs.brew.sh/Manpage
- npm `npm doctor`
  - 借鉴点:按固定类别组织检查,例如连接、registry、版本、环境、权限、cache。
  - 对 `ago` 的落地:固定分类为 `runtime`、`config`、`state`、`commands`、`sources`、`projects`。
  - 参考:https://docs.npmjs.com/cli/v11/commands/npm-doctor/
- mise `mise doctor`
  - 借鉴点:支持 JSON 输出,展示版本、目录、环境变量、配置文件和问题摘要;errors 才触发失败语义。
  - 对 `ago` 的落地:`ago doctor` 只输出 JSON;warning 不影响退出码,error 才非零。
  - 参考:https://mise.jdx.dev/cli/doctor.html
- Flutter `flutter doctor --machine`
  - 借鉴点:同一健康检查能力可被机器消费。
  - 对 `ago` 的落地:第一版直接 JSON-only,避免再维护文本布局。
  - 参考:https://docs.flutter.dev/reference/flutter-cli

### 2.2 机器可读输出

- Terraform `terraform validate -json`
  - 借鉴点:顶层带 `format_version`、`valid`、`error_count`、`warning_count`,便于脚本判断和未来兼容。
  - 对 `ago` 的落地:顶层固定 `formatVersion`、`status`、`errorCount`、`warningCount`、`checks`。
  - 参考:https://developer.hashicorp.com/terraform/cli/commands/validate
- kubectl `kubectl config view -o json|yaml`
  - 借鉴点:配置查看命令可以明确支持机器可读输出,并避免默认暴露敏感 raw 内容。
  - 对 `ago` 的落地:doctor/config show 不输出 prompt 正文、session transcript 内容或 shell 环境全量 dump。
  - 参考:https://kubernetes.io/docs/reference/kubectl/generated/kubectl_config/kubectl_config_view/

### 2.3 配置查看

- GitHub CLI `gh config get/list/set`
  - 借鉴点:配置子命令应该枚举当前支持的 key,并区分查看与修改。
  - 对 `ago` 的落地:第一版只做 `ago config show`,后续再考虑 `get/set/roots`。
  - 参考:https://cli.github.com/manual/gh_config
- AWS CLI `aws configure list`
  - 借鉴点:输出配置值时同时展示来源/位置。
  - 对 `ago` 的落地:`ago config show` 返回 normalized value 以及每个 key 的 `source: "file" | "default"`。
  - 参考:https://docs.aws.amazon.com/cli/latest/reference/configure/list.html

---

## 3. 用户接口

### 3.1 `ago doctor`

```
ago doctor
```

行为:

- 输出 JSON 到 stdout。
- 不进入项目选择交互。
- 不读取 transcript 正文超过现有 collector 所需内容。
- 不修改 `~/.ago/config.json`、`~/.ago/state.json`、Codex/Claude 历史文件或任何 cache。
- 只有 `errorCount > 0` 时设置非零退出码;只有 warning 时退出码仍为 0。

第一版不支持:

- `--json`(因为默认就是 JSON)
- `--fix`
- `--verbose`
- `ago doctor <check-id>`
- 文本人类模式

### 3.2 `ago config show`

```
ago config show
```

行为:

- 输出 JSON 到 stdout。
- 展示 `~/.ago/config.json` 的存在性、JSON 有效性、normalized config、每个 key 的来源。
- 配置文件不存在时返回默认配置,退出码 0。
- 配置文件存在但 JSON 无法解析时输出 error payload,退出码非零。

第一版不支持:

- `ago config get`
- `ago config set`
- `ago config roots add/remove/list`
- `ago config edit`
- 交互式配置向导

---

## 4. JSON 结构

### 4.1 Doctor 顶层结构

```json
{
  "formatVersion": "1.0",
  "status": "warning",
  "checkedAt": "2026-06-07T00:00:00.000Z",
  "version": "0.1.0",
  "node": "v22.22.1",
  "platform": "darwin",
  "errorCount": 0,
  "warningCount": 2,
  "paths": {
    "config": "~/.ago/config.json",
    "state": "~/.ago/state.json",
    "codexSessions": "~/.codex/sessions",
    "claudeHistory": "~/.claude/history.jsonl",
    "claudeProjects": "~/.claude/projects"
  },
  "config": {
    "exists": true,
    "validJson": true,
    "value": {
      "roots": [],
      "claudeCommand": "claude",
      "preferredTool": "auto"
    },
    "sources": {
      "roots": "default",
      "claudeCommand": "default",
      "preferredTool": "default"
    }
  },
  "state": {
    "exists": true,
    "validJson": true,
    "lastLaunchPathExists": true
  },
  "commands": {
    "codex": {
      "available": true,
      "command": "codex"
    },
    "claude": {
      "available": true,
      "command": "claude"
    }
  },
  "sources": {
    "codex": {
      "sessionsDirExists": true,
      "observations": 12
    },
    "claude": {
      "historyExists": true,
      "projectsDirExists": true,
      "observations": 20
    }
  },
  "projects": {
    "total": 18,
    "existing": 16,
    "missing": 2
  },
  "checks": [
    {
      "id": "config.valid_json",
      "category": "config",
      "status": "ok",
      "severity": "info",
      "message": "Config file is valid JSON"
    }
  ]
}
```

### 4.2 Status 与 severity

顶层 `status` 由检查项聚合得到:

- 任一 check `status === "error"` → 顶层 `status = "error"`。
- 否则任一 check `status === "warning"` → 顶层 `status = "warning"`。
- 否则顶层 `status = "ok"`。

每个 check:

```ts
interface DoctorCheck {
  id: string;
  category: "runtime" | "config" | "state" | "commands" | "sources" | "projects";
  status: "ok" | "warning" | "error";
  severity: "info" | "warning" | "error";
  message: string;
  details?: Record<string, unknown>;
}
```

`severity` 与 `status` 第一版保持一致语义:

- `ok` → `info`
- `warning` → `warning`
- `error` → `error`

保留两个字段是为了后续能表达"检查通过,但附带 info"或"状态失败,但只是 soft warning"这类扩展。

### 4.3 Config show 结构

配置文件缺失:

```json
{
  "path": "~/.ago/config.json",
  "exists": false,
  "validJson": true,
  "value": {
    "roots": [],
    "claudeCommand": "claude",
    "preferredTool": "auto"
  },
  "sources": {
    "roots": "default",
    "claudeCommand": "default",
    "preferredTool": "default"
  }
}
```

配置文件存在且部分字段缺失:

```json
{
  "path": "~/.ago/config.json",
  "exists": true,
  "validJson": true,
  "value": {
    "roots": ["/Users/example/git"],
    "claudeCommand": "claude",
    "preferredTool": "auto"
  },
  "sources": {
    "roots": "file",
    "claudeCommand": "default",
    "preferredTool": "default"
  }
}
```

配置文件 JSON 损坏:

```json
{
  "path": "~/.ago/config.json",
  "exists": true,
  "validJson": false,
  "error": "Unexpected token ...",
  "value": {
    "roots": [],
    "claudeCommand": "claude",
    "preferredTool": "auto"
  },
  "sources": {
    "roots": "default",
    "claudeCommand": "default",
    "preferredTool": "default"
  }
}
```

---

## 5. 检查项

### 5.1 Runtime

| id | error/warning | 说明 |
|---|---|---|
| `runtime.node_version` | error | Node 版本低于 `package.json#engines.node`。 |
| `runtime.platform` | ok | 输出 `process.platform`、`process.arch`。 |
| `runtime.package_version` | ok | 输出 `package.json#version`。 |

### 5.2 Config

| id | error/warning | 说明 |
|---|---|---|
| `config.exists` | warning | `~/.ago/config.json` 不存在。因为默认配置可用,不是 error。 |
| `config.valid_json` | error | 文件存在但 JSON 无法解析。 |
| `config.normalized` | warning | 存在无效字段类型并被 fallback 到默认值。 |
| `config.roots_exist` | warning | `roots` 中某个路径不存在。 |
| `config.roots_filter_nonempty` | warning | 配置了 roots,但过滤后没有项目。 |
| `config.preferred_tool` | error | `preferredTool` 不是 `auto/codex/claude` 且无法 normalize。实现上如果 normalize 可兜底,该 check 可记录 warning。 |

### 5.3 State

| id | error/warning | 说明 |
|---|---|---|
| `state.exists` | warning | `~/.ago/state.json` 不存在。新用户会出现,不是 error。 |
| `state.valid_json` | warning | state 损坏不应阻断 `ago`;doctor 报 warning。 |
| `state.last_launch_path` | warning | `lastLaunch.path` 不存在。 |
| `state.last_launch_tool` | warning | `lastLaunch.tool` 不再是支持的工具。 |

### 5.4 Commands

| id | error/warning | 说明 |
|---|---|---|
| `commands.codex_available` | warning | `codex` 不在 PATH。若没有 Codex observations,只 warning。 |
| `commands.claude_available` | warning/error | `claudeCommand` 不可执行。若存在 Claude observations,为 error;否则 warning。 |

`codex` 当前不可配置,仍用 `codex` 作为 command 名。

### 5.5 Sources

| id | error/warning | 说明 |
|---|---|---|
| `sources.codex_sessions_dir` | warning | `~/.codex/sessions` 不存在。 |
| `sources.claude_history` | warning | `~/.claude/history.jsonl` 不存在。 |
| `sources.claude_projects_dir` | warning | `~/.claude/projects` 不存在。 |
| `sources.observations_nonempty` | warning | Codex 和 Claude observations 都为 0。 |

数据源缺失不应是 error,因为用户可能只装了其中一个 CLI,或刚开始使用。

### 5.6 Projects

| id | error/warning | 说明 |
|---|---|---|
| `projects.any_indexed` | warning | 合并后项目数为 0。 |
| `projects.any_existing` | warning | 默认模式下无可打开项目。 |
| `projects.missing_paths` | warning | 有历史项目路径已不存在。 |

---

## 6. 实现设计

### 6.1 文件边界

- `src/project-index.ts`
  - 新增 detailed JSON 读取 helper,区分 missing / invalid / valid。
  - 新增 config inspection helper,返回 normalized config 与 per-key source。
  - 新增 state inspection helper,返回 normalized state 与 JSON 文件健康状态。
  - 新增 source/project summary helper,复用现有 collectors 和 `buildProjectIndex`。
- `src/index.ts`
  - 新增 commander 子命令 `doctor`。
  - 新增 commander 子命令 `config show`。
  - 负责把诊断对象 `JSON.stringify(..., null, 2)` 输出到 stdout。
  - 负责根据 `errorCount` 设置 `process.exitCode = 1`。

不新增文件也可以完成第一版。但如果 `src/index.ts` 继续膨胀,允许新增 `src/doctor.ts` 专门承载纯诊断逻辑;该文件不能引入新运行时依赖。

### 6.2 JSON 读取 helper

需要保留现有 `loadConfig/loadState` 的容错行为,避免破坏启动流程。新增 helper 不替换现有函数:

```ts
interface JsonFileInspection {
  path: string;
  exists: boolean;
  validJson: boolean;
  raw?: Record<string, unknown>;
  error?: string;
}
```

语义:

- 文件不存在:`exists=false`, `validJson=true`。
- 文件存在且解析成功:`exists=true`, `validJson=true`, `raw=...`。
- 文件存在但解析失败:`exists=true`, `validJson=false`, `error=...`。

### 6.3 Config source 判定

只针对已支持 key:

- `roots`
- `claudeCommand`
- `preferredTool`

若 raw config 中该 key 类型有效且被采用,source 为 `file`;否则为 `default`。

无效字段类型第一版不需要在 `config show` 里单独列 issue;但 `doctor` 应通过 `config.normalized` check 给 warning。

### 6.4 命令可用性

复用 `isCommandAvailable(commandName)`:

- Codex command 固定为 `codex`。
- Claude command 通过 normalized config 的 `claudeCommand` 解析。
- 如果命令名包含路径分隔符,沿用现有可执行文件检查逻辑。

### 6.5 诊断聚合

构建流程:

1. 读取 package version、Node/platform。
2. inspect config,得到 normalized config。
3. inspect state。
4. 检查 commands。
5. 收集 Codex/Claude observations。
6. 使用 normalized config build project index。
7. 生成 checks。
8. 由 checks 聚合 `status/errorCount/warningCount`。

若某一步出现未预期异常,doctor 不应抛出裸异常;应返回 `status=error` 和一个 `doctor.unexpected_error` check,并设置 exit 1。

---

## 7. 边界情况

- Config 缺失:doctor warning,config show 输出默认配置并 exit 0。
- Config JSON 损坏:doctor error,config show 输出 error payload 并 exit 1。
- State JSON 损坏:doctor warning;启动流程仍沿用现有 `loadState` fallback。
- 同时没有 Codex/Claude 历史:doctor warning,不是 error。
- Claude observations 存在但 `claudeCommand` 不可用:doctor error,因为用户会在选择 Claude 时必然失败。
- Codex observations 存在但 `codex` 不可用:doctor error;若不存在 Codex observations,warning。
- `roots` 全部不存在或过滤后为空:warning。
- 存在 missing 项目:warning;这是 `-al` 的正常可见状态。
- `doctor` 输出不得包含 prompt 正文、session transcript 内容或 access token。

---

## 8. 测试策略

沿用 `node:test` + 临时 home 目录。

### 8.1 纯函数单测

- detailed JSON read:
  - missing file。
  - valid JSON。
  - invalid JSON。
- config inspection:
  - missing config → normalized defaults + sources 全 default。
  - partial config → file/default source 混合。
  - invalid field type → normalized fallback + doctor warning。
- state inspection:
  - missing state。
  - invalid JSON。
  - `lastLaunch.path` missing。
- check aggregation:
  - only ok → `status=ok`, exit semantic 0。
  - warning only → `status=warning`, exit semantic 0。
  - at least one error → `status=error`, exit semantic 1。

### 8.2 集成/CLI 测试

- `ago config show` 在临时 home 无 config 时输出可 parse JSON。
- `ago config show` 在有效 partial config 时输出 normalized config。
- `ago config show` 在 invalid config 时 exit 1 且输出 `validJson=false`。
- `ago doctor` 在空临时 home 输出 parseable JSON,包含 `formatVersion/status/checks`。
- `ago doctor` 在构造 Claude observation 但 `claudeCommand` 指向不存在命令时返回 error。
- 现有 `ago --help`、`ago -`、`-al`、`-n`、`-c` 行为不变。

### 8.3 验证命令

```bash
npm test
node --import tsx src/cli.ts doctor | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>JSON.parse(s))'
node --import tsx src/cli.ts config show | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>JSON.parse(s))'
```

---

## 9. 不在本轮范围

- `ago config set/get/roots add/remove/list`。
- `ago doctor --fix`。
- `ago doctor --verbose` 或文本输出。
- 单独运行某个 doctor check。
- 缓存索引。
- 支持更多工具(gemini/aider 等)。
- 输出 prompt 摘要、git branch、session count 列。

---

## 10. 已定决策

- `ago doctor` 第一版 JSON-only。
- `ago config show` 第一版只读。
- warning 不导致非零退出码;error 才非零。
- 配置缺失不是错误;配置 JSON 损坏是错误。
- State 损坏不是错误,因为可 fallback,但必须 warning。
- doctor 不写任何文件。
- 不新增运行时依赖。
