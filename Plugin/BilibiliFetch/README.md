# BilibiliFetch 插件说明

该插件用于从Bilibili视频链接中提取字幕内容。

## 功能

- 根据Bilibili视频URL或BVID提取字幕。
- 支持通过环境变量配置用户Cookie以访问需要登录的内容。
- 支持选择特定的字幕语言。

## 配置

在项目根目录的 `config.env` 文件中添加以下变量：

1.  **`BILIBILI_COOKIE`** (必需)
    - **作用**: 你的Bilibili网站登录Cookie。对于某些需要登录才能观看或获取完整内容的视频是必需的。
    - **示例**: `BILIBILI_COOKIE="SESSDATA=xxxx;..."`

2.  **`BILIBILI_SUB_LANG`** (可选)
    - **作用**: 指定优先获取的字幕语言。
    - **格式**: Bilibili API提供的语言代码。这些代码会在服务器运行日志中显示。
    - **常见值**:
        - `ai-zh`: 中文 (简体)
        - `ai-en`: 英文
        - 其他语言 (如 `ai-ja` for 日语)
    - **默认行为**:
        1.  如果设置了此变量，插件会优先尝试获取指定语言的字幕。
        2.  如果未设置，插件会**默认尝试获取中文 (`ai-zh`)**。
        3.  如果中文也不存在，插件会选择API返回的第一个可用字幕。

### 如何查找可用的语言代码？

当你使用此插件处理一个视频时，服务器的后台日志会打印出类似下面的一行信息，其中包含了该视频所有可用的语言代码：

```
INFO - Available subtitle languages: ['ai-en', 'ai-zh']
```

你可以从这个列表中选择一个代码填入你的 `config.env` 文件。

### `config.env` 示例

```env
# Bilibili用户Cookie
BILIBILI_COOKIE="SESSDATA=xxxx;bili_jct=xxxx;"

# 指定优先获取中文字幕
BILIBILI_SUB_LANG=ai-zh