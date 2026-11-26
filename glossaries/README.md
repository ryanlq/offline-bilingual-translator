# 预置专业术语表（EN→ZH）

可在生词本页「导入 CSV」直接使用，每行 `源词,译词`。

| 文件 | 条目数 | 领域 | 来源 |
|---|---|---|---|
| ai-agents-global.csv | 55 | AI/Agent（无歧义词+品牌名大小写敏感保护，可全局导入） | 社区主流译法整理 + 实测校准 |
| ai-agents-site.csv | 10 | AI 歧义单义词（agent/prompt/embedding 等，建议按站点导入） | 社区主流译法整理 |
| cncf-cloud.csv | 68 | 云计算 | cncf/glossary 官方中文化 |
| kubernetes.csv | 163 | Kubernetes | kubernetes/website zh-cn |
| professional-en-zh.csv | 231 | 以上全量 | 合并 |

已用 Bergamot enzh 模型验证：占位符强制成功率 100%（40+65 抽样），
术语增益率 67.5%（专业词）/ 31%（AI 词，品牌名保护为主）。

## 使用建议

- 「全局包」可在生词本页直接导入（对所有站点生效）；品牌名条目带大小写敏感标记
  （如 Cursor 只命中大写开头，不影响小写 cursor/光标、master/硕士、gemini/双子座）
- 「站点包」为有歧义的单义词（agent、prompt 等在非 AI 语境含义不同），
  导入时在「站点」框填入目标网站域名，仅在该站点生效
