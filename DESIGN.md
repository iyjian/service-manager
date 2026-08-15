# UI Design Guidelines

本项目的 UI 风格参考 **Vercel / Railway / Linear / Kubernetes Dashboard**。

整体目标不是追求“炫”，而是让界面看起来：

* 专业
* 克制
* 清晰
* 紧凑
* 适合长时间使用
* 符合开发者工具和基础设施管理产品的气质

设计时始终优先考虑：

> **信息是否容易读懂，其次才是界面是否好看。**

---

# 1. 整体设计原则

## 1.1 风格关键词

界面统一采用：

* 中性灰阶
* 1px 边框
* 白色 Surface
* 极少阴影
* 紧凑的信息密度
* 小圆角
* 单一主强调色
* 清晰的文字层级

整体视觉接近：

**Vercel Dashboard + Railway + Kubernetes Dashboard**

避免明显的营销网站风格。

---

## 1.2 不要过度设计

后台工具最容易出现的问题不是“设计得不够”，而是“设计得太多”。

避免：

* 大面积渐变
* 玻璃拟态
* 大阴影
* 大圆角
* 每个区域都做成 Card
* 到处使用 Badge
* 到处放图标
* 不必要的彩色背景
* 大面积品牌色
* 过大的页面标题
* 过宽的留白
* 为了装饰而增加视觉元素

页面需要有设计感，但这种设计感应该来自：

* 对齐
* 间距
* 字体层级
* 信息组织
* 状态反馈
* 一致的交互

而不是装饰。

---

# 2. Design Token

所有页面尽量使用统一 Token，不直接在业务样式中随意写颜色和尺寸。

## Surface

```css
--color-bg-page: #fafafa;
--color-bg-surface: #ffffff;
--color-bg-subtle: #f4f4f5;
--color-bg-hover: #f4f4f5;
```

用途：

* `page`：页面背景
* `surface`：主要内容区域
* `subtle`：次级区域
* `hover`：列表和表格 hover

---

## Border

```css
--color-border: #e4e4e7;
--color-border-strong: #d4d4d8;
--color-border-subtle: #f4f4f5;
```

边框只负责建立层级，不应该成为页面视觉主体。

原则：

> 能用一条浅边框解决的问题，不增加阴影。

---

## Foreground

```css
--color-fg-primary: #09090b;
--color-fg-secondary: #3f3f46;
--color-fg-tertiary: #71717a;
--color-fg-quaternary: #a1a1aa;
```

使用层级：

```text
Primary
页面标题 / 核心值 / 重要名称

Secondary
正文 / 表格主要数据

Tertiary
辅助信息 / Label / Table Header

Quaternary
Placeholder / Disabled / 很弱的信息
```

不要让所有文字都使用相同深度。

---

## Accent

```css
--color-accent: #0a0a0a;
--color-accent-hover: #262626;

--color-focus: #0070f3;
```

主操作使用黑色。

蓝色只用于：

* Focus
* Link hover
* 少量需要明确表达“可交互”的位置

不要把蓝色当成页面主要装饰色。

---

# 3. Typography

基础字号：

```text
13px
```

建议层级：

```text
20px   页面核心标题
16px   区域标题
14px   强调文字 / Group Title
13px   正文 / 表格数据
12px   Label / 辅助信息
11px   Table Header / Metadata
```

原则：

> 一个页面通常不需要超过 4～5 个明显的字号层级。

---

## 技术数据

以下内容优先使用 Mono 字体：

* IP
* Port
* Host
* Path
* Command
* Identifier
* URL
* Namespace
* Resource Name

例如：

```text
127.0.0.1:3080
192.168.122.91:3389
/api/v1/hosts
```

---

## 数字

统计数据和表格数字统一使用：

```css
font-variant-numeric: tabular-nums;
```

保证数字纵向排列整齐。

---

# 4. Spacing

统一使用：

```text
4 / 8 / 12 / 16 / 24 / 32
```

页面整体采用中高信息密度。

不要通过大量留白制造所谓“高级感”。

后台工具更适合：

> 紧凑，但不拥挤。

需要特别注意：

* 行与行之间必须有明确边界
* 字段之间不能粘在一起
* Toolbar 与正文之间要有层级
* Dialog 内部需要适当增加呼吸空间

---

# 5. Radius

统一使用：

```css
--radius-sm: 4px;
--radius: 6px;
--radius-lg: 8px;
```

推荐：

```text
Button       4px
Input        4px
Table Area   6px
Card         6px
Dialog       8px
```

不要出现：

```text
12px
16px
20px
24px
```

这种明显偏消费产品或 AI SaaS Landing Page 的大圆角。

---

# 6. Shadow

默认：

```css
--shadow-sm: none;
```

普通：

* Card
* Table
* Input
* Button
* Toolbar

都不使用阴影。

仅浮层使用 Shadow：

```text
Dialog
Popover
Dropdown
Tooltip
```

Dialog 可以使用：

```css
--shadow-pop
```

Shadow 的作用是表达：

> 当前元素悬浮在页面之上。

而不是单纯为了“更立体”。

---

# 7. Button

按钮分成四类。

## Primary

```text
黑底
白字
```

用于：

* Save
* Confirm
* Create
* Connect

一个区域通常只保留一个最重要的 Primary Action。

---

## Secondary

```text
白底
灰色 1px Border
黑字
```

用于普通操作：

* Paste Config
* Reset
* Retry
* Test

---

## Ghost

```text
透明背景
无 Border
灰色文字 / 图标
```

用于：

* Close
* More
* Expand
* Copy
* Edit

Hover 后出现浅灰背景。

---

## Danger

默认：

```text
透明背景
红字
低视觉权重
```

只有 Hover 时强化危险状态。

危险操作永远不要成为页面最醒目的元素。

---

## Button Size

```text
Regular     32px
Small       28px
Icon        24px
Inline Icon 20px
```

所有按钮避免过高。

这是开发者工具，不是移动端消费应用。

---

# 8. Input

Input 是“编辑状态”，不是“数据显示组件”。

这是整个项目非常重要的一条原则。

不要因为某个值未来可以编辑，就让它永远显示成 Input。

例如：

```text
127.0.0.1
3389
192.168.122.91
```

在用户只是查看数据时，应当优先显示为普通文本。

只有进入编辑状态以后：

```text
Text
  ↓
Input
```

---

## Input Style

默认：

```text
白底
1px Border
4px Radius
13px
```

Hover：

```text
Border 稍微加深
```

Focus：

```text
#0070f3 Border
+
2px Focus Ring
```

Focus Ring 只用于状态反馈，不作为装饰。

---

# 9. Card

Card 只负责表达真正独立的信息区块。

样式：

```text
白色背景
1px Border
6px Radius
无 Shadow
```

不要：

> 一个标题 + 两行内容也套一个 Card。

如果只是页面内部区域，优先考虑：

* Divider
* Section
* Background
* Spacing

而不是继续套 Card。

---

# 10. Table / Resource List

列表和表格是整个产品最重要的 UI 类型之一。

设计方向参考：

* Vercel Resource List
* Linear
* Kubernetes Dashboard

---

## Table Header

统一使用：

```text
11～12px
Uppercase
Letter Spacing 0.06em
Tertiary Color
Medium Weight
```

例如：

```text
NAME          LOCAL             REMOTE             AUTO
```

Table Header 不需要很深。

真正重要的是下面的数据。

---

## Table Row

默认：

```text
白色背景
非常浅的 Row Divider
```

Hover：

```text
#f4f4f5
```

不要给不同类型的普通行增加：

* 蓝底
* 黄底
* 绿底

数据类型通过文字、结构和 Label 表达。

---

# 11. Forwarding Rules

Forwarding Rules 本质是：

> **规则列表**

而不是：

> **大型表单**

所以页面需要优先保证“快速阅读”。

---

## 11.1 默认使用阅读态

规则默认应该表现为数据：

```text
rabbitmq          127.0.0.1:15672  →  127.0.0.1:15672
minio             127.0.0.1:9001   →  127.0.0.1:9001
windows-wuchong   127.0.0.1:3389   →  192.168.122.91:3389
```

而不是几十个 Input 同时铺在页面中。

原因很简单：

> 用户绝大多数时间是在查看规则，而不是同时修改所有规则。

---

## 11.2 Local / Remote 是完整语义

Host 和 Port 在业务上组成一个 Endpoint。

因此视觉上优先表达：

```text
127.0.0.1:3389
```

而不是让用户分别阅读：

```text
127.0.0.1       3389
```

推荐：

```text
LOCAL                      REMOTE

127.0.0.1:3389       →     192.168.122.91:3389
```

这样用户一眼就能理解：

> 谁转发到谁。

---

## 11.3 推荐表格结构

```text
NAME              LOCAL                 REMOTE                    AUTO
──────────────────────────────────────────────────────────────────────

rabbitmq          127.0.0.1:15672   →   127.0.0.1:15672           —
minio             127.0.0.1:9001    →   127.0.0.1:9001            —
windows-wuchong   127.0.0.1:3389    →   192.168.122.91:3389       ✓
windows-xsy       127.0.0.1:3390    →   192.168.122.50:3389       —
xsy-k8s           127.0.0.1:6445    →   192.168.122.87:6443       —
```

IP + Port 使用 Mono。

---

## 11.4 编辑状态

点击某一行 Edit 后，再进入输入状态。

例如：

```text
┌ windows-wuchong ┐

┌ 127.0.0.1 ┐ : ┌ 3389 ┐
        ↓
┌ 192.168.122.91 ┐ : ┌ 3389 ┐
```

编辑行为应该是局部的。

避免：

> 打开页面以后 50～60 个 Input 同时处于编辑状态。

---

## 11.5 Hover Action

普通状态下保持页面干净。

Hover 某一行后显示：

```text
Edit
More ···
```

例如：

```text
windows-wuchong  127.0.0.1:3389 → 192.168.122.91:3389   Auto ✓   ···
```

---

## 11.6 Delete 降权

Delete 是低频且危险的操作。

不要每行常驻一个红色垃圾桶。

推荐放入：

```text
···
  ├─ Edit
  ├─ Duplicate
  └─ Delete
```

Delete 只有菜单展开后才使用红色。

原则：

> 页面最醒目的东西应该是重要数据和主要操作，而不是删除。

---

# 12. Group / Section

Host Group 使用简单的结构划分。

推荐：

```text
──────────────────────────────────
SERVER NAME

host description
6 forwarding rules · 2 services
──────────────────────────────────
```

不使用彩色背景。

Group Title：

```text
14px
Semibold
Primary
```

技术描述：

```text
12px
Mono
Tertiary
```

Metrics：

```text
纯文本
Tertiary
```

不要做成一堆 Chip。

---

# 13. Status

状态首先通过小型 Indicator 表达。

推荐：

```text
● Running
● Offline
● Error
```

其中：

```text
Dot = 状态色
Text = 普通文字颜色
```

不要把：

```text
Running
```

整个单词全部涂成绿色。

状态色应该克制使用。

---

# 14. Overview

Overview 用于快速回答：

> 当前系统是什么状态？

推荐结构：

```text
ACTIVE HOSTS
12

FORWARDING RULES
38

SERVICES
16
```

Label：

```text
Uppercase
11～12px
Tracking 0.06em
Tertiary
```

Value：

```text
20px
Semibold
Tabular Numbers
```

颜色主要来自状态 Dot，而不是整段文字。

---

# 15. Dialog

Dialog 是页面中少数允许明显层级提升的组件。

推荐：

```text
白底
8px Radius
1px Border
轻微 Pop Shadow
```

Backdrop：

```text
rgba(9, 9, 11, 0.45)
```

Dialog Header 保持简洁：

```text
Title                       ×
```

Close 使用 24×24 Ghost Button。

---

# 16. Subcard

Dialog 内部如果存在多个独立配置区域，可以使用 Subcard。

Subcard：

```text
Subtle Background
1px Border
4～6px Radius
```

Title：

```text
Uppercase
11～12px
Letter Spacing 0.06em
Semibold
Tertiary
```

不要通过多个 Shadow 建立嵌套关系。

层级主要通过：

```text
Background
Border
Spacing
Typography
```

完成。

---

# 17. Link

普通 Link：

```text
Primary Foreground
淡灰色 underline
```

Hover：

```text
#0070f3
```

技术链接：

```text
127.0.0.1:3080
```

使用 Mono。

链接不需要长期使用高饱和蓝色吸引注意力。

---

# 18. Tooltip

Tooltip 使用反转色：

```text
黑底
白字
小圆角
```

例如：

```text
┌─────────────────────┐
│ Connection healthy  │
└─────────────────────┘
```

Tooltip 内容保持简短。

---

# 19. Checkbox / Switch

Checkbox：

```text
Accent = Black
```

对于类似：

```text
Auto
Enabled
Active
```

这种二元配置，如果它代表明确的开关语义，可以使用紧凑 Switch。

如果它只是表格中的布尔字段，则优先使用轻量 Checkbox。

不要让布尔控件比主要数据更醒目。

---

# 20. Terminal

Terminal 保持独立的深色语义：

```text
Background  #09090b
Foreground  terminal palette
Mono Font
```

Terminal 是功能区域，不需要为了与主界面统一而强行做成白色。

ANSI Color 保持终端兼容。

---

# 21. Empty State

空状态保持简单。

例如：

```text
No forwarding rules
```

或者：

```text
No services
```

使用：

```text
Tertiary
12～13px
```

必要时可以使用 Italic。

不要为普通空状态增加：

* 大插画
* 巨大 Icon
* 大面积空白
* Marketing 文案

---

# 22. Interaction States

所有交互组件至少需要考虑：

```text
Default
Hover
Focus
Active
Disabled
Loading
Error
```

尤其不要只设计静态截图。

一个成熟的 UI 必须回答：

> 用户操作以后会发生什么？

---

# 23. 页面视觉优先级

任何页面都应该存在明确的优先级。

通常：

```text
1. 当前页面 / 当前资源

2. 核心数据

3. Primary Action

4. Secondary Action

5. Metadata

6. Dangerous Action
```

Dangerous Action 应该处于最低视觉层级之一。

---

# 24. AI 生成 UI 时的约束

任何 AI 在修改本项目 UI 时，都必须遵守本文件。

禁止自行引入：

* 新的主色
* 大圆角
* 渐变
* Glassmorphism
* 重阴影
* 不必要的 Card
* 不必要的 Badge
* 不必要的 Icon
* 超大字号
* 大面积低信息密度布局
* 与现有组件重复的新 Button / Input / Dialog

优先：

* 使用现有组件
* 使用现有 Token
* 延续已有信息架构
* 保持较高信息密度
* 保持开发者工具风格

---

# 25. 修改已有页面时

如果页面业务逻辑已经正确，不要因为“重新设计”而重新发明页面。

默认只允许优化：

```text
Spacing
Typography
Color
Border
Alignment
Component Size
Information Hierarchy
Interaction State
```

除非任务明确要求，不要擅自：

* 删除字段
* 修改业务流程
* 改变按钮功能
* 增加新的业务功能
* 改变已有数据含义

---

# 26. UI 自检

每次完成 UI 修改后，至少检查下面这些问题：

1. 页面第一视觉焦点是否正确？
2. 有没有太多 Input 同时出现在页面？
3. 有没有可以直接显示为文字的数据，却被做成 Input？
4. 有没有不必要的 Card？
5. 有没有不必要的大圆角？
6. 有没有不必要的阴影？
7. 删除等危险操作是否过于醒目？
8. 主操作和次操作是否容易区分？
9. 相同类型的信息是否使用了相同样式？
10. Host、Port、IP 等技术数据是否方便快速扫描？
11. 长名称和长地址是否会破坏布局？
12. Hover / Focus / Disabled / Loading 是否完整？
13. 页面是否出现过多颜色？
14. 页面在连续使用 1～2 小时后是否仍然容易阅读？
15. 整体是否仍然像一个专业的开发者工具，而不是营销页面？

---

# 27. 最终判断标准

如果一个设计改动不能明显改善下面至少一项：

* 可读性
* 信息层级
* 操作效率
* 状态表达
* 一致性
* 可访问性

那么这个设计改动通常没有必要。

最终目标不是：

> **让页面看起来“设计得很多”。**

而是：

> **让用户几乎感觉不到设计的存在，但能非常快地找到信息、理解状态并完成操作。**
