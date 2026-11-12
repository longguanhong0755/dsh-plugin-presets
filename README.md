# dsh-plugin-presets

为 DSH（DeepSeek Harness）提供**命名插件预设方案**：把当前 profile 的插件顺序、启用状态与配置保存为快照，随时切换、导入导出，并在应用前自动备份、失败时回滚。

一个预设完整保存两样东西：

1. `package.json` 中 `dsh.profile.bundles` 的**有序 bundle 列表**；
2. profile 的**完整 `cordis.patch.yml` 原文**（保留注释和 `!!js` 表达式）。

此外还会记录生效后的插件条目与配置值，便于查看和编辑，但应用时以上面两个文件为准。

---

## 功能

- 新建、重命名、复制、查看、编辑、删除多套预设。
- 在预设之间切换，并把选中方案应用为当前生效配置。
- 把 DSH 当前配置保存为新预设。
- 应用前生成**精确备份**；写入失败自动恢复；进程中断后下次启动自动恢复。
- 预设和“当前生效方案”标记持久化，DSH 重启后仍保留。
- 导入/导出 JSON；导入处理重名、损坏数据、版本不兼容和缺失 bundle。
- 导出默认脱敏，敏感配置需显式选择才包含。
- 提供 `/plugin-presets` 命令和 `plugin_presets` 模型工具（含审批）。
- 不修改 `node_modules`、不自动安装缺失 bundle、不解释用户 patch 内容。

---

## 环境要求

- DSH `>= 0.2.0`，profile 中存在 `loader`、`profileContext`、`commands` 和 `tools` 服务。
- 插件自身依赖由 DSH 运行时提供：`@deepseek-ai/dsh-app-boot`、`@deepseek-ai/dsh-atomic-write`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`。这些模块由 DSH 的 profile 级模块解析提供，因此插件必须在 DSH 进程内加载，不能直接用独立 Node 进程 `import` 本包。

---

## 安装

本包是带 `cordis.patch.yml` 的 **bundle**：安装后只需把 `dsh-plugin-presets` 加入 profile 的 bundle 列表，不要手动再插一条同名记录（bundle 自己的 patch 会插入 `plugin-presets` 行）。

### 方式一：DSH 插件管理器（推荐）

在插件管理器中安装本地 bundle，或把包放到 profile 可解析的位置，然后将其加入当前 profile 的 bundles。重启 DSH。

### 方式二：在 profile 目录用 pnpm

```bash
cd ~/.dsh/profiles/desktop
pnpm add file:D:/workspace/dsh-plugin-plan
```

然后在 `package.json` 的 `dsh.profile.bundles` 末尾加入：

```json
"dsh-plugin-presets"
```

> 两种安装方式都会调用 pnpm，pnpm 会按 `package.json` 校准 `node_modules`，可能清理未在 `package.json` 中声明的“孤儿”包。安装前建议备份 profile 的 `package.json` 与 `pnpm-lock.yaml`；本插件不会改动已有的已声明依赖或 bundle。

重启 DSH。CLI 启动时通常能看到：

```text
plugin-presets 1.0.0 ready for profile desktop (data: ...)
```

桌面版的日志级别可能不显示这一行，因此以命令验证为准：在任意会话执行 `/plugin-presets doctor`，能返回当前 profile 和数据目录即加载成功。

### 验证

在 DSH 中执行：

```text
/plugin-presets doctor
```

---

## 数据位置

默认目录：

```text
$DSH_HOME/plugin-presets/<profile-key>/
  presets/       预设 JSON（ps_*.json）
  backups/       每次应用前的精确备份（bk_*）
  trash/         删除预设时的副本
  exports/       默认导出目录
  active.json    当前生效方案标记
  pending.json   进行中的事务标记（仅写入过程中存在）
  last-recovery.json
```

`$DSH_HOME` 通常是 `~/.dsh`。每个 profile 使用独立子目录，互不影响。

可选配置（profile patch 中该插件的 `config`）：

```yaml
- id: plugin-presets
  name: dsh-plugin-presets
  config:
    dataDir: ''          # 空 = $DSH_HOME/plugin-presets；相对路径相对 profile 目录
    maxPresets: 100      # 1-500
    maxBackups: 20       # 1-200
    lockWaitMs: 15000    # 等待其他写入者的毫秒数
```

---

## 基本用法

### 1. 保存当前配置

```text
/plugin-presets save baseline
/plugin-presets save baseline --description "稳定配置" --activate
```

`save`/`capture` 会读取当前 profile 文件并抓取当前 loader 树。`--activate` 只记录“当前方案”标记，不改文件。

### 2. 查看

```text
/plugin-presets list
/plugin-presets list --json
/plugin-presets show baseline
/plugin-presets show baseline --patch      # 完整 patch 预览
/plugin-presets show baseline --secrets    # 不脱敏（仅本机查看）
/plugin-presets current
```

`show` 默认脱敏并限制 patch 预览长度；`current` 显示当前生效方案以及与实时配置的差异。

### 3. 切换/应用

```text
/plugin-presets apply baseline
/plugin-presets apply baseline --force
/plugin-presets validate baseline          # 只做预检，不写文件
```

应用流程：

1. 预检：解析目标 patch、解析 bundle、用 app-boot 重新组合条目、检查自保护与覆盖层；
2. 创建精确备份；
3. 写入 `pending.json`；
4. 原子写入 `package.json` 的 bundle 列表和 `cordis.patch.yml`；
5. 调用 HMR `reconcileProfile` 使配置尽量热生效；
6. 成功则更新 `active.json`、清理 `pending.json`；
7. 失败则自动恢复备份文件、恢复原 active 标记并记录回滚。

若结果显示 `restart required`，重启 DSH 才会完全生效。

### 4. 编辑预设

```text
/plugin-presets edit baseline --description "新说明"
/plugin-presets edit baseline --set demo-plugin '{"mode":"strict"}'
/plugin-presets edit baseline --unset demo-plugin
/plugin-presets edit baseline --disable demo-plugin
/plugin-presets edit baseline --enable demo-plugin
/plugin-presets edit baseline --add-bundle some-bundle
/plugin-presets edit baseline --remove-bundle some-bundle
/plugin-presets edit baseline --move-bundle some-bundle 1
```

`--set` 替换该条目的完整 config；`--unset` 删除结构化编辑；`--move-bundle` 的索引从 1 开始。结构化编辑会以“生成块”形式追加到 patch 末尾（最后应用），因此优先于前面的同名行。

> 编辑只修改预设内容，不会安装 bundle。目标 profile 缺少的 bundle 会在 `validate`/`apply` 时报告。

### 5. 重命名、复制、删除

```text
/plugin-presets rename baseline stable
/plugin-presets duplicate baseline experiment
/plugin-presets delete experiment --yes
```

删除会先写一份副本到 `trash/`。如果删除的是当前生效方案，实时配置不受影响，`active.json` 标记为 `presetDeleted`。

### 6. 备份与回滚

```text
/plugin-presets backups
/plugin-presets rollback                 # 回滚最近一次应用
/plugin-presets rollback bk_20260101-000000_ab12cd34
/plugin-presets rollback bk_... --force  # 实时文件已被外部修改时仍强制恢复
```

回滚前会再创建一份 `pre-rollback` 安全备份；回滚本身也走同样的 pending/HMR/恢复流程。`--force` 用于实时文件与备份的 after 状态不一致时。

---

## 导入与导出

### 导出

```text
/plugin-presets export
/plugin-presets export baseline experiment --out D:\backup\presets.json
/plugin-presets export --include-secrets --out D:\backup\presets-full.json
/plugin-presets export --overwrite
```

- 默认导出到数据目录 `exports/plugin-presets-<时间戳>.json`。
- **默认脱敏**：`apiKey`、`token`、`password`、`Authorization`、URL 中的 userinfo 等会替换为 `"<redacted>"`；注释和 `!!js process.env.X` 这类非字面量表达式保留。
- 只有显式 `--include-secrets` 才包含明文。该文件属于敏感数据，请自行妥善保管。
- 已存在的目标文件默认拒绝覆盖，需 `--overwrite`。
- 文件格式：

```json
{
  "format": "dsh-plugin-presets",
  "formatVersion": 1,
  "exportedAt": "...",
  "generator": { "name": "dsh-plugin-presets", "version": "1.0.0" },
  "source": { "profileName": "desktop", "dshVersion": "...", "platform": "win32", "arch": "x64" },
  "includeSecrets": false,
  "count": 2,
  "presets": [ ... ]
}
```

### 导入

```text
/plugin-presets import D:\backup\presets.json
/plugin-presets import presets.json --conflict rename|skip|overwrite|error
```

处理规则：

- **重名**：默认 `rename`，生成 `name (imported)` 等不冲突名称；`skip` 跳过；`overwrite` 替换同名的现有预设（保留现有预设 id）；`error` 整批失败。
- **重复名称**（文件内部）：整批拒绝。
- **格式不合法**：不是 JSON、不是对象、缺少 `format`/`presets`、单个预设字段非法时，整批拒绝，**不会写入任何预设**。
- **版本不兼容**：`formatVersion` 高于当前支持版本时拒绝并提示升级；预设 `schemaVersion` 过高时同样拒绝。
- 支持直接导入单个“裸预设”对象（会给出提示）。
- 缺失 bundle、DSH 版本差异写入 `metadata.compatibility` 并告警；导入不会自动安装 bundle。
- 脱敏文件中的 `"<redacted>"` 会保留为占位符，导入后需手动重新填写密钥。

导入的预设总会被分配新的本地 `id`，并记录 `metadata.imported`（原 id、原名称、来源文件、格式版本）。

---

## 安全模型

- **预检不写文件**：`validate` 与 `apply` 的前半段只读。
- **自保护**：目标配置必须保留本插件的启用行；默认拒绝删除 `@deepseek-ai/dsh-base` bundle，以及 `plugin-manager`、`hmr`、`config-editor`、`commands`、`tools` 等核心模块，除非显式使用危险开关。
- **高优先级覆盖层**：若 home patch 或 `--patch` 覆盖会改变目标组合结果，默认拒绝应用，除非 `--allow-overrides`。应用后这些更高优先层仍然优先。
- **精确备份**：备份保存应用前的 `package.json` 与 `cordis.patch.yml` 原文，可手工恢复。
- **事务标记**：写文件前落盘 `pending.json`，记录前后哈希、签名、备份 id。
- **启动恢复**：DSH 启动时：
  - 文件已是 after 状态 → 完成事务并恢复 active 标记；
  - 文件仍是 before 状态 → 取消事务；
  - 前后混合且备份存在 → 恢复备份，要求重启；
  - 无法判断 → 不改文件，写 `last-recovery.json` 要求人工检查。
- **文件锁 + HMR 串行**：写操作在 HMR `runExclusive` 内并持有 profile 文件锁；锁超时会失败并释放，不会无限等待。
- **脱敏默认开启**：命令输出、工具输出、导出默认不暴露敏感值。

危险开关（仅在你明确知道后果时使用）：

```text
--allow-missing-bundles   目标 profile 缺少 bundle 时仍写入 bundle 列表
--allow-overrides         存在更高优先级覆盖层时仍应用
--allow-redacted          允许应用含 "<redacted>" 占位符的预设
--allow-protected         允许移除受保护的 bundle/模块
--allow-self-disable      允许应用后禁用本插件自身
```

---

## 崩溃或异常后的处理

1. 重启 DSH，让启动恢复运行。
2. 执行：

```text
/plugin-presets doctor
/plugin-presets backups
```

3. 若仍显示 `pending` 或 `needs-attention`，不要继续 apply/rollback。按 `doctor` 输出找到备份目录：

```text
~/.dsh/plugin-presets/<profile>/backups/<bk_id>/
  package.json       应用前的 manifest
  cordis.patch.yml   应用前的 patch（若当时存在）
  meta.json          前后哈希、状态、时间、警告
```

手工恢复步骤：

1. 退出 DSH；
2. 将备份中的 `package.json` 和 `cordis.patch.yml` 覆盖回 profile 目录；
3. 若 `meta.json` 中 `before.patchExists` 为 `false`，删除 profile 里当前多余的 `cordis.patch.yml`；
4. 重新启动 DSH；
5. 运行 `/plugin-presets doctor` 确认。

删除 `pending.json` **不能**代替恢复文件；它只应用于确认文件已经手工修好的情况。

---

## 模型工具 `plugin_presets`

工具动作：`list`、`show`、`current`、`save`、`rename`、`duplicate`、`delete`、`edit`、`apply`、`validate`、`import`、`export`、`backups`、`rollback`、`doctor`。

- 只读动作（`list/show/current/validate/backups/doctor`）可并发。
- `apply`、`rollback`、含敏感信息的 `export` 会走 DSH 审批流程。
- `delete` 必须显式传 `yes: true`。
- 工具输出为 JSON 字符串；`show`/`current` 默认脱敏。
- 应用后结果中的 `application` 为 `restart-required` 时，需要提示用户重启 DSH。

---

## 已知限制

- 只管理当前 profile；不同 profile 的预设目录彼此隔离。
- 不安装/卸载 npm 包，不运行 `pnpm install`。缺失 bundle 只报告。
- 不修改 `settings.yaml`、会话数据、缓存或 `node_modules`。
- 应用写入完整 patch 文件，因此预设中保存的手工修改也会一起恢复。
- 若保存预设时 profile 中**没有** `cordis.patch.yml`，应用该预设会删除这个文件（除非结构化编辑新增了内容），而不是留下一个空的 `[]` 文件。
- home patch 与 argv `--patch` 的优先级高于 profile 文件，预设无法覆盖它们。
- `!!js` 表达式按原文保存；应用时不求值，只由 DSH 加载时处理。
- 脱敏导出的预设不能直接恢复密钥，导入后需补填或改用 `--include-secrets`。
- 应用是 profile 级别的，会影响该 profile 下的所有会话。

---

## 开发与测试

```bash
node --check lib/*.js
node --test test/*.test.js
```

测试覆盖预设 schema/完整性、脱敏、命令解析、存储 CRUD、active 标记持久化、导入冲突策略、格式/版本错误与批量原子性。

`test/integration/` 另有一套可选的真实 DSH 集成测试：把测试 harness 安装到一个一次性 profile，分 `main`、`recovery`、`restore` 三次启动，验证保存/应用/回滚、自动回滚、导入导出、工具审批路径和启动恢复。它需要显式设置 `DSH_PRESET_IT_PHASE` 才会运行，不会影响正式 profile。

---

## 常见问题

**Q：应用后提示 restart required？**
A：HMR 无法热应用部分 bundle 变更。重启 DSH；`active.json` 会在重启后标记为 `applied-after-restart`。

**Q：当前方案与实时配置不一致？**
A：说明有人通过插件管理器或手工编辑修改了配置。重新 `save` 覆盖预设，或 `apply` 恢复；`doctor` 会报告签名不一致。

**Q：导入后密钥变成 `<redacted>`？**
A：导出时未包含敏感信息。编辑预设补填，或让来源机器用 `--include-secrets` 重新导出。

**Q：会覆盖我的备份或用户配置吗？**
A：应用前总是先备份，且备份目录按 id 分开；导出的默认目录也不会覆盖已有文件（除非 `--overwrite`）。删除预设会保留 trash 副本。

**Q：如何完全卸载？**
A：从 profile 的 `dsh.profile.bundles` 移除 `dsh-plugin-presets` 并卸载包，然后按需删除 `$DSH_HOME/plugin-presets/`。卸载不会自动删除预设数据。
