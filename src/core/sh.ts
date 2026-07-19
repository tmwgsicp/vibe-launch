// POSIX 单引号 shell 转义：把任意字符串安全地作为「单个字面量参数」塞进 shell 命令。
//
// ⚠️ 绝不能用 JSON.stringify 来做这件事：它产出的是**双引号**字符串，而 POSIX 双引号里
// `$(...)`、反引号、`$VAR` 仍会被 shell 展开 —— 等于命令注入（`q("/x/$(rm -rf ~)")` 会执行）。
// 单引号里除了 `'` 本身之外一切都是字面量，故把内部的 `'` 收成 `'\''` 后整体单引号包裹即安全。
export function shQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
