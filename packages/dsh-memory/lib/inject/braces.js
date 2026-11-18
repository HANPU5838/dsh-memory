/**
 * 0.110.0：提示词模板转义。
 *
 * 宿主把系统提示 / 上下文文本按 `{{变量}}` 模板扫描（PromptContext 没有
 * `interpolate: false` 退出开关）。记忆正文是用户/模型写的任意文本 —— 一条
 * 含 `{{` 的记录会让每次提示词组装抛错，整个进程的请求全挂。所以所有会进入
 * 提示词的记忆文本在渲染出口统一把 `{{` 拆开。
 *
 * 只改这一处、只在输出边界改：存储里的原文保持不动，工具返回/面板展示不受影响。
 */
export function escapeTemplateBraces(text        )         {
  return text.includes('{{') ? text.replaceAll('{{', '{ {') : text
}


//# sourceURL=source/memory-inject/src/braces.ts