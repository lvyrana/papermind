# Title Typography Decision v1

## 结论

论文详情页标题不再用一套字体同时承载中英文，而是拆成两套样式：

- 英文标题：柔和的 serif 风格，保留论文题目的学术感，但避免过黑过硬
- 中文标题：宋体优先，走更稳重的中文标题方向

## 为什么这样做

同一套 serif 字体在中英文混排时，容易因为字体 fallback 和字重差异出现：

- 英文看起来偏细或偏粗
- 中文看起来发软、发飘，或像“AI 默认模板”
- 不同浏览器、不同系统上显示结果不稳定

拆成两套后，字体职责更清楚：

- 英文负责“论文感”
- 中文负责“稳重、可读、不过于花哨”

## 当前实现

- 标题颜色统一使用同一蓝色系
- 通过 `showTitleZh && titleZh` 判断当前显示中文还是英文
- 收藏详情页和阅读详情页共用同一套规则
- 翻译失败时给出明确提示，不再静默无反馈

## 当前定稿值

### 英文标题

- `font-family`: `"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif`
- `font-weight`: `600`
- `font-size`: `23px`
- `line-height`: `1.5`
- `letter-spacing`: `-0.018em`
- `color`: `#274A73`

### 中文标题

- `font-family`: `"Songti SC", "STSong", "Noto Serif SC", "Source Han Serif SC", "SimSun", serif`
- `font-weight`: `600`
- `font-size`: `23px`
- `line-height`: `1.6`
- `letter-spacing`: `-0.02em`
- `color`: `#274A73`

## 后续约定

- 如果后面还要调，只分别调英文和中文，不再把它们重新混成一套 class
- 其他正文、摘要、解读样式先不动，避免影响已经正常的页面
