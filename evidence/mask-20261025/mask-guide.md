# Endoscopic Discectomy — Mask 标注

本任务使用像素级实例 Mask。14 个类别已设为 Mask；类别名称、颜色和 ID 不变。

## 点选分割（推荐）

1. AI assistance → **Prompting**。
2. 模型选择 **SAM 2.1 - Point & Box**，再选择要保存的类别。
3. **Convert masks to polygons 保持关闭**。
4. 只用点提示时，关闭 **Start with a bounding box**。
5. 点击 **Add visual prompts**。左键增加目标内部的正点，右键增加背景或错误区域的负点。
6. 核对边缘后完成对象并保存。需要时用 Mask 画笔/橡皮修正。

类别用于命名保存的对象，不是发送给 SAM 2.1 的文字提示。

## 自动预标注

模型：**Grounding DINO + SAM 2.1 - Masks (Experimental)**。

- 标注页面的 **Auto-labeling** 仅处理当前帧。
- 任务的 **Automatic annotation** 会提交后台批量任务。
- 同名类别一一映射，**Convert masks to polygons 保持关闭**。
- 不要启用清除已有标注，除非确实准备替换它们。
- 这是通用 Grounding DINO 检测后交给 SAM 分割，并非经验证的脊柱内镜识别模型。神经根、硬膜囊等可能漏检或误分类，必须人工复核。
- 当前 CPU 推理较慢，未启动整个 13,632 帧视频的自动预标注。

## 已有标注及限制

- 原有 3 个 Polygon 已按其现有轮廓填充为 Mask，保留对象 ID、类别、帧号和其他属性。
- 这只是表示转换，无法恢复 Polygon 简化时已丢失的边缘细节，也不表示原分类正确。
- 原始标注和标签已备份到服务器 `/home/xinrun/cvat/.diagnostics/mask-20261025/`。
- Mask 是逐帧区域标注。现有 **SAM 2.1 Tracker** 仅支持矩形框传播，不能作为本任务的 Mask 跟踪器；本次修改未部署视频记忆或跨帧 Mask 传播。
