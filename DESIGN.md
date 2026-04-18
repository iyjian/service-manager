# UI 整理方案（已实施）

目标：消除页面"凌乱感"，不增删任何页面元素，仅做视觉/布局/样式调整。

实施范围：`src/renderer/styles.css`（本轮未改 `index.html`）。

每条按 **设计要求 / 现状** 两段记录；"现状"描述实施后的结果。

---

## 1. 表格视觉降噪

### 设计要求
tunnel / service 区分**只保留 section label 这一个色彩信号**。行色系归一，不使用底色 + 彩色边框 + 标签的三重编码。`.group-row` 的蓝色渐变降级为纯色，不再拼图感。

### 现状
- `.data-row-tunnel / .data-row-service / .section-empty-row-*` 统一白底（`--color-bg-surface`），删除原 `#fbfeff / #fffdfa` 色底。
- `.host-section-row-tunnel / -service` 和 `.host-rules-head-tunnel / -service` 的彩色背景、左右蓝色描边全部移除，背景 transparent。
- `.group-row td` 从 `linear-gradient(135deg, #f8fbff, #eef6ff)` + `#d7e5f6` 边框改为 `--color-bg-subtle` + 底边 `--color-border-default`，不再有"渐变卡片头"的独立语言。
- `.host-section-label-tunnel / -service` 的 badge 配色**保留**，作为分区的唯一色彩信号。

---

## 2. 卡片嵌套层级差异化

### 设计要求
Dialog 内 `.card → .subcard → .forward-row` 三层视觉上要能一眼区分，形成"凹—凸—凹"的层级节奏。

### 现状
- `.card` 白底（保持）
- `.subcard` 改为 `--color-bg-subtle`（`#f1f5f9`），边框保留
- `.forward-row` 白底 + 1px 边（保持）

嵌套层级从"三层同色盒子"变成"白底 → 浅灰底 → 白底行卡"。

---

## 3. Overview 三张卡高度对齐

### 设计要求
Hosts / Tunnels / Services 三张统计卡底部对齐。

### 现状
`.overview-card` 改为 flex 垂直布局；`.overview-sub-stats` 加 `margin-top: auto`，让没有 sub-stats 的 Hosts 卡自动把 `.overview-value` 撑到可用空间，三张卡高度一致。

---

## 4. 设计 token 统一

### 设计要求
定义好的 `--space-*` / `--font-size-*` 应覆盖全部常规场景；散落的硬编码像素值（10/11/13/17px 等）全部回收进 token。允许极少数语义特殊值以专用变量形式集中声明。

### 现状
新增 token：
```
--font-size-2xs: 11px;
--font-size-3xl: 28px;
--font-size-stat: 20px;
```
已替换为 token 的位置：
- `.overview-label / .overview-sub-stats / .group-metric / .host-section-label / .status-retry`：`11px → var(--font-size-2xs)`
- `.overview-value`：`17px → var(--font-size-stat)`（视觉上由 17 提升到 20，与 2xl/3xl 标题形成稳定梯度）
- `.overview-grid` gap：`10px → var(--space-2)`
- `.message-banner` padding：`10px 12px → var(--space-2) var(--space-3)`
- `.terminal-log` padding：`12px → var(--space-3)`；`font-size: 12px → var(--font-size-xs)`
- `.service-command-input` padding / font-size：`10px 12px / 13px → var(--space-2) var(--space-3) / var(--font-size-xs)`
- `th / td / .host-rules-head th`：`10px 12px → var(--space-2) var(--space-3)`
- `.host-section-row th`：`12px 14px 8px → var(--space-3) var(--space-3) var(--space-2)`
- `.group-cell`：`14px 16px → var(--space-3) var(--space-4)`
- `.host-spacer-row td` height：`14px → var(--space-4)`
- `.host-toggle-icon`：`13px → var(--font-size-xs)`
- `.input` padding / height：`0 10px / 36px → 0 var(--space-2) / 32px`

仍保留的硬编码（合理特例）：
- `.overview-sub-dot / .status-dot`：5px 圆点
- `.checkbox`：14×14
- `.forward-name / .forward-local-* / .forward-remote-*`：flex 成员的 `190/180/160/156px` 宽度（`forward-row` 是独立 flex 布局，未纳入 12 列 grid，下一轮若需要再改）

---

## 5. 表单字段宽度网格化

### 设计要求
`.form-row` 内所有字段共享同一套 12 列线；去掉各自写死的 `320/280/120/170/280/420/220px`，对齐节奏统一。

### 现状
`.form-row` 改为 `display: grid; grid-template-columns: repeat(12, 1fr); gap: var(--space-3); align-items: end`。

各字段 span 分布：
| 行 | 字段 | span | 合计 |
|---|---|---|---|
| Name row | `field-name` | 6 | 6（单字段占半行） |
| SSH row | `field-host` / `field-port` / `field-user` | 5 / 2 / 5 | 12 |
| Auth row (password 模式) | `field-auth` / `field-password` | 3 / 9 | 12 |
| Auth row (privateKey 模式) | `field-auth` / `private-key-wrap` / `field-passphrase` | 3 / 6 / 3 | 12 |

两种 auth 配置都严格收敛到 12 列。

小屏（`max-width: 900px`）覆盖：`.field-* / .private-key-wrap` 一律 `grid-column: span 12`，各自占满一行。

---

## 6. 按钮尺寸收敛

### 设计要求
按钮高度从 4 种（36 / 32 / 32 / 30）收敛到 2–3 档语义清晰的尺寸。

### 现状
统一为三档：
- **常规按钮** `.btn`：高度 `32px`（原 36），padding `0 var(--space-3)`
- **紧凑按钮** `.btn-sm`：高度 `28px`（原 32），padding `0 var(--space-2)`，字号 xs
- **图标/辅助按钮**：统一到 `28×28` 和 `24×24`
  - `.icon-btn`（dialog 关闭）28×28（原 32）
  - `.host-toggle-btn`（表格折叠）28×28（原 30，且去掉自定义蓝边，改用系统边框色）
  - `.message-close`（banner 关闭）24×24（保持）

效果：主区域按钮全 28–32 节奏，图标按钮不再比文字按钮"矮一截"。

---

## 7. 页面层级节奏

### 设计要求
H1 与 section 标题字号要拉开差距；Dialog 宽度与主区对齐；`page-head` 与首卡间距合理。

### 现状
- `.page-title`：从 `var(--font-size-2xl)`（24px）升级到 `var(--font-size-3xl)`（28px），加 `letter-spacing: -0.01em` 收紧。
- `.page-head`：padding 改为 `var(--space-2) 0 var(--space-1)`，配合 `.app-shell` 的 gap 形成呼吸。
- `.host-dialog`：`max-width` 从 `1180px` 改为 `1120px`，与 `.app-shell` 的 1120 对齐。

---

## 8. Overview 卡内"看/做"内容分隔

### 设计要求
统计区（数据）与 quick-actions（操作）共用一张 Overview 卡时，要有明确的视觉分界，不能只靠 12px 间距。

### 现状
`.quick-actions`：
```
margin-top: var(--space-4);
padding-top: var(--space-4);
border-top: 1px dashed var(--color-divider);
```
一条虚线把"看数据"和"做动作"切开。

---

## 尚未处理（下一轮可考虑）

- `.forward-row`（forwarding / service 行内编辑器）仍是 flex + 写死宽度，没纳入 12 列 grid。当前在 subcard 内显示不成问题，若后续字段增删可考虑改造。
- `.forward-name / .forward-local-* / .forward-remote-*` 的 `156/180/190px` 宽度暂保留。
- `.overview-sub-dot / .status-dot` 的 5px 圆点、`.checkbox` 14×14、`auto-start` 图标尺寸未纳入 token，属于语义特化值，可保留。
