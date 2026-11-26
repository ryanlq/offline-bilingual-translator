# 预置专业术语表（EN→ZH）

可在生词本页「导入 CSV」直接使用，每行 `源词,译词`。

| 文件 | 条目数 | 领域 | 来源 |
|---|---|---|---|
| ai-agents.csv | 65 | AI/Agent/编程工具（含品牌名保护） | 社区主流译法整理 + 实测校准 |
| cncf-cloud.csv | 68 | 云计算 | cncf/glossary 官方中文化 |
| kubernetes.csv | 163 | Kubernetes | kubernetes/website zh-cn |
| professional-en-zh.csv | 231 | 以上全量 | 合并 |

已用 Bergamot enzh 模型验证：占位符强制成功率 100%（40+65 抽样），
术语增益率 67.5%（专业词）/ 31%（AI 词，品牌名保护为主）。
