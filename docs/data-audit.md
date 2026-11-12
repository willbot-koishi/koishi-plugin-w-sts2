# 数据审计（2026-11-06）

## 结论

旧游民快照不足以支持完整的卡牌、遗物查询，更不能可靠区分正式版和 beta。查询现改用 [Spire Codex 公开 API](https://spire-codex.com/developers)，保留旧名称作为搜索别名，不混入旧胜率统计。

核验依据是实际 API 响应、公开文档及官方更新公告，而非仅凭文件修改时间判断版本。卡牌计数包含状态、诅咒、衍生、事件与多人专用牌，不等同于某个角色可选牌数。

## 时效性

- 旧快照：`src/data/1.json` 至 `8.json` 的本机修改时间为 2026-03-26，但数据没有版本字段，因此不能把这个时间当作版本证明。
- [游民页面](https://app.gamersky.com/db/STS2Wiki/?gsGameId=1731202&gsAppChannel=tuJian)仍标注 `v103.2`，实际“战鼓”等数据却包含更晚的改动。统计与详情 API 均没有明确的分支选择，不能据此构造双版本数据集。
- 当前正式版为 [v0.107.1（2026-06-19）](https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/1835871199305790)。当前 beta 为 [v0.111.0（2026-08-14）](https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/1840944183778277)。[10 月官方通讯](https://megacrit.com/news/2026-10-29-neowsletter-issue-27/)预告的 11 月 12 日更新尚未发生。
- Spire Codex `/api/beta/version` 返回 `beta_version=v0.111.0`。正式版实体接口没有同等的版本元数据；插件展示“正式版 / beta”，不把站点自身 `1.0.x` 更新号冒充游戏版本，也不把今天的版本号永久硬编码进查询结果。

## 完整性

| 数据集 | 卡牌 | 遗物 | 说明 |
| --- | ---: | ---: | --- |
| 旧游民本地快照 | 551 | 0 | 没有效果、费用、升级效果或图片 |
| 当前游民 API | 580 | 296 | 卡牌统计含 `T` 空名称记录，无法区分分支 |
| Spire Codex 正式版中文 API | 577 | 296 | ID 唯一，名称完整 |
| Spire Codex beta 中文 API | 595 | 298 | ID 唯一，名称完整 |

Spire Codex 两个分支中：

- 卡牌和遗物的中文名称、头像图片字段齐全；效果中没有残留 `{...}` 模板。
- 各有 13 张牌描述为空，但都有关键词（如“不能被打出”“虚无”），并非完全缺失效果。查询保留关键词。
- `MAD_SCIENCE` 缺少完整卡图，回退头像。本次没有逐一下载全部图片；已实测普通、升级和 beta 中文渲染 URL 可访问。
- 升级信息可能只改变费用或关键词，此时 `upgrade_description=null`。查询复用原效果并应用费用、关键词变化，不会判为“不可升级”。
- `beta_image_url` 是测试版美术，不是游戏 beta 数据；分支只通过 `channel=beta` 选择。中文完整卡图需要 `/zhs/` 子目录，不能照搬 API 默认的英文完整卡图地址。

实测“独门技术”“至亮之焰”“创世之柱”等在两分支效果不同；beta 另含 `TUTOR` 等卡牌及 `DOWSING_ROD`、`NEOWS_SACRIFICE` 遗物。不能只给同一份数据加两种标签。

## 旧数据处理

`src/data/proc.js` 已修复原来的未定义 `id` 和编号范围错误，按内部 ID 提取名称，去掉胜率等过时统计，生成 `legacy-names.json`（551 个 ID）。原始快照保留供复核，不参与实时查询，也不打包成游戏效果数据。

有 8 个名称与正式版当前名称不同，如 `EXPERTISE` 的“专长”→“独门技术”、`PROTECTOR` 的“护具”→“守护者”。旧名称仍可搜索。

旧 `FOLLOW_THROUGH`（跟进）和 `GRAPPLE`（擒拿）在两个现行分支均没有同 ID 或同中文名称条目；不猜测新 ID、不把未经确认的旧效果当作现行数据。同名“打击”“防御”仍以角色独立 ID 区分。

## 可复核流程

```sh
yarn workspace koishi-plugin-w-sts2 audit:data
node external/w-sts2/src/data/proc.js
```

审计脚本实时读取两分支的中文卡牌、遗物，检查 ID、名称、模板、关键词和图片字段，列出旧名变化、缺失 ID、beta 新增条目及 beta 版本。输出到标准输出，不覆盖原始数据，不修改生产环境。

## 来源与权利

本插件自行实现 API 客户端，不复制 Spire Codex 实现代码。其仓库使用 [PolyForm Noncommercial 1.0.0](https://github.com/ptrlrd/spire-codex/blob/main/LICENSE.md)，游戏数据、美术仍受原权利人条款约束；本插件的 MIT 声明不扩展到第三方内容。若用于商业机器人服务，应另行确认数据与图片的使用许可。
