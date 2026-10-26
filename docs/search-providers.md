# 通用 Search Provider 与 Tencent Memory（只读）

Maestro 提供版本化只读检索接口，可将本地知识/代码结果与 TencentDB-Agent-Memory 的已有记忆联合检索。**不迁移权威记录、不写腾讯数据、不自动提炼或晋升知识。**

## 默认行为与权限

- 不指定 providers 时，现有 CLI、`maestro_wiki_search` 和 `GET /api/wiki` 行为/JSON 不变，不加载或调用腾讯后端。
- 新通用入口默认仅 local。外部后端必须同时满足：配置存在、`enabled: true`、本次显式选择该 ID、绑定匹配当前仓库、凭据环境变量可用。
- 没有“自动启用全部配置”的选项。当前外部绑定仅支持当前物理仓库；不通过 `--repo <linked>` 借用其他仓库授权。仅 local 选择可复用已有本地 repository selector。
- 外部配置每次请求重读。禁用、删除配置或修改 endpoint/租户/asset 会在后续请求生效；旧命名空间的原文引用失效。
- `--read-only-probe`/`readOnlyProbe` 拒绝任何远程选择，且在读取外部配置或凭据前拒绝。不会把 probe 悄悄变成普通请求。
- **只读并不等于不出网或无遥测。** 查询会被发送到所选服务，对方可能记录 query/results/usage。配置资源和租户范围应经人审查；本功能不会自动创建配置、上传历史记录或部署服务。
- 不会自动推断 Tencent Team/User/Agent ACL 与 Dashboard 用户的对应关系。配置者授权的是绑定仓库使用指定远程租户/资产；远程服务仍必须正确部署鉴权与网络隔离。

## 配置

在人审查后创建 `<项目>/.workflow/search-providers.json`。不要把真实密钥放进 JSON，只写环境变量名。下面的配置默认禁用；示例仓库 ID 需要替换成当前 `.workflow/repository.json` 的 `repo_id`。没有持久仓库身份时，远程调用拒绝执行。

```json
{
  "version": 1,
  "providers": [
    {
      "id": "team-memory",
      "kind": "tencent-atomic",
      "enabled": false,
      "baseUrl": "https://memory.example.test",
      "apiKeyEnv": "TENCENT_MEMORY_API_KEY",
      "serviceId": "your-service",
      "repoId": "11111111-1111-4111-8111-111111111111",
      "teamId": "your-team",
      "userId": "your-user",
      "agentId": "your-agent",
      "timeoutMs": 3000
    },
    {
      "id": "team-wiki",
      "kind": "tencent-wiki",
      "enabled": false,
      "baseUrl": "https://knowledge.example.test",
      "apiKeyEnv": "TENCENT_MEMORY_API_KEY",
      "serviceId": "your-service",
      "repoId": "11111111-1111-4111-8111-111111111111",
      "knowledgeId": "wiki-your-asset",
      "timeoutMs": 3000
    }
  ]
}
```

- `baseUrl` 指服务根地址，不包含 `/v3/atomic/search` 或 `/v3/tools/call`。可包含部署的路径前缀。
- 仅允许 HTTPS 或字面 `localhost`、`127.0.0.1`、`[::1]` 的 HTTP。禁止 URL userinfo、query、fragment，禁止跟随重定向；不要依赖重定向完成鉴权或切换主机。
- Atomic 要求 `teamId/userId/agentId`，可加 `taskId`。每个返回条目必须携带并匹配绑定租户，缺失/不一致时整组结果拒绝，不展示越权片段。
- Wiki 以 `serviceId + knowledgeId` 固定资产寻址；调用者不能通过 API 请求覆盖 URL、密钥或租户。
- 最多 8 个 Provider，ID 必须唯一且不能为 `local`；配置上限 64KiB，未知/非法字段失败关闭。`enabled` 缺省 false，`timeoutMs` 缺省 3000。
- 请求还有网关总截止时间，默认 10 秒、最多 30 秒；实际 HTTP 使用配置超时和请求剩余时间的较短者。服务端业务错误、HTTP 错误和解析错误只返回固定 code，不输出密钥、上游错误正文或请求体。

只有在确认服务地址、资源与隐私边界后，由用户自行提供环境变量并将相应项设为 `enabled: true`。开发和测试仅使用 mock，不代表已经连接任何真实 Tencent 实例。

## CLI

```bash
# 原入口不变：默认混合检索，不读取远程 Provider 配置
maestro search "cache invalidation" --json

# 显式使用通用接口，本地仍由现有引擎提供
maestro search "cache invalidation" --providers local --json

# 仅查已启用的远程原子记忆
maestro search "cache invalidation" --providers team-memory --json

# 本地与远程联合；各源使用有界候选预算，按排名融合
maestro search "cache invalidation" --providers local,team-memory --json

# 本地 Wiki 与远程 Wiki（不是自动导入）
maestro search "cache invalidation" --providers local,team-wiki --wiki-only --json
```

显式 providers 路径返回新版本化 envelope，不伪装成旧 Wiki JSON。`--exact/--kg/--code/--include-linked-code/--full` 不与该路径组合；省略 providers 仍可使用所有原选项。

## MCP

已有 `maestro_wiki_search` 增加可选 `providers: string[]`。省略时保持原返回结构；显式选择时，`result` 是通用 envelope。

```json
{
  "query": "cache invalidation",
  "providers": ["local", "team-memory"],
  "limit": 10
}
```

Host 解析项目根和仓库；调用参数不能提供远程 tenant、endpoint 或授权上下文。当前 MCP 本地 Provider 使用现有 Wiki 检索，不增加代码搜索语义。新增 type/category/tag/keyword/workspace/includeDeprecated facets 在 schema 中可见，但必须显式提供 providers；不能让旧路径悄悄忽略过滤。`readOnlyProbe: true` 可单独请求通用 local probe；仍返回版本化 envelope。

显式联合检索的本地候选阶段不写 Wiki impression 计数，避免把融合前的过量候选记为最终曝光；更不会记录为 consumed/validated。原默认路径的既有用量行为不变。

## Dashboard API

旧 `GET /api/wiki?q=...` 与现有页面模型不变。新增 API（本阶段未增加页面 Provider 配置/选择 UI）：

```http
POST /api/wiki/search
Content-Type: application/json

{"query":"cache invalidation","providers":["local","team-wiki"],"limit":10}
```

可选 `repo`、`mode`、`filters`、`timeoutMs`、`readOnlyProbe`。`mode` 为 `auto/lexical/semantic/hybrid`，但必须符合所选 Provider 的能力；本地语义入口支持 hybrid，不宣称纯 semantic-only。

按搜索返回的完整 `ref` 回读远程 Wiki：

```http
POST /api/wiki/search/read
Content-Type: application/json

{"ref":{"providerId":"team-wiki","namespace":"<搜索返回值>","recordId":"wiki/page.md"}}
```

只接受当前配置的命名空间与安全相对 page ref；不会把路径作为本地文件读取。Wiki 原文返回 SHA256 内容版本，后续携带版本可检测内容变化。请求跨 Dashboard workspace switch 后会丢弃旧 workspace 的响应。

Atomic 当前没有可信的按 ID 精确读接口，能力声明 `read: false`；**不会扫描整个租户去模拟读取**。本地原文仍使用现有 load 机制，此 API 暂不替代它。

## 结果与能力限制

通用 envelope 的 schema 为 `maestro-search/1.0`：

```json
{
  "schemaVersion": "maestro-search/1.0",
  "query": "cache invalidation",
  "results": [],
  "providers": [],
  "complete": true,
  "mutationAuthorized": false
}
```

每个结果包含：
- `ref: {providerId, namespace, recordId, version?}`；身份不只由标题或裸 ID 决定。
- `kind: knowledge/code/memory/document`，以及 title、snippet、rank、fusionScore。
- `rawScore: {value, metric}` 可选，保留后端原分数；融合使用排名，不直接相加不同后端的分数。
- `trust: local/external`；外部结果与内置模板带 `referenceOnly: true`，不是当前项目的权威规范。
- 可选的本地 source/path/sourceRef 是来源信息，不赋予写入、fork、resume 或 promotion 权限。远程结果不能通过 metadata 自报 canonical ID。

Provider 状态为 `ok/degraded/error`，含有界耗时和固定错误码。显式选择 local + remote 时，远程失败可保留本地结果；不会额外调用未选择的 local 作为隐式回退。所有 Provider 失败时，CLI/MCP/API 明确失败。`complete: false` 不等同于“搜索无命中”，也不是候选集合穷尽保证。

| Provider | 支持模式 | Maestro facets | 精确原文读取 |
|---|---|---|---|
| local | auto、lexical、hybrid | 由既有入口支持的 type/category/tag/keyword/workspace/includeDeprecated | 现有 load；本阶段不重写 |
| tencent-atomic | auto（算法由服务端选择） | 暂不支持 | 不支持 |
| tencent-wiki | auto、lexical | 暂不支持 | read_page |

不要给远程原子记忆附带 `--semantic` 或 `--no-emb` 来假设控制其服务端模型；相应模式不支持时在 HTTP 前报错。Maestro facets 也不能在召回后随意过滤来冒充完整前过滤。上游 Atomic 部分 backend 存在全局候选截断后隔离过滤，本 Provider 明确返回 degraded / `upstream-filtered-candidates`，不承诺与本地相同召回率。

远程每组候选最多 100；网关每组/最终结果最多 500。HTTP 响应最多 2MiB，原文读取最多 262,144 字符，解析还有条目和字符串限制；不做无限分页、无限重试或整库下载。Wiki 缺少 count 或占满候选窗口时保守标记为 incomplete，不以少量命中冒充完整覆盖。

## 开发接口

- `shared/search-provider.ts`：纯契约，`SearchProvider`、`SourceResolver`、`SearchReference`、可信 Host scope、预算与版本化响应。
- `src/search/providers/gateway.ts`：能力检查、隔离错误、超时/取消、排名融合和 public 字段白名单。
- `src/search/providers/local.ts`：callback adapter，不静态加载模型/索引器。
- `src/search/providers/runtime.ts`：Host 范围、配置与显式选择的统一入口。
- `src/search/providers/config.ts` / `tencent.ts`：配置及腾讯固定只读 HTTP adapter。

新增后端应实现相同契约与能力声明，不接管权威记录和晋升流程。后续若要腾讯承担 Maestro 的派生索引，必须另行实现受治理的 ProjectionSink、幂等版本/删除/tombstone/同步回执和 canonical 回读；本阶段没有提供写接口。
