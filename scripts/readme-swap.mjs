// 发布时把 npm 专用 README 临时换上（prepack），打包后还原 GitHub 版（postpack）。
// 目的：GitHub 显示完整 README（含二维码/Star History/家族互推），npm 页显示精简版（装/用/接 MCP）。
// 工作区平时保持 GitHub 版不变；只有 npm pack/publish 期间临时替换。
import { copyFileSync, existsSync, rmSync } from "node:fs";

const mode = process.argv[2];
const MAIN = "README.md";
const NPM = "README.npm.md";
const BAK = ".README.github.bak";

if (mode === "pack") {
  if (existsSync(NPM)) {
    // 不覆盖已存在的备份（防上次中断遗留时把 npm 版误存成"github 版"）
    if (!existsSync(BAK)) copyFileSync(MAIN, BAK);
    copyFileSync(NPM, MAIN);
    console.log("[readme-swap] 已切到 npm 专用 README");
  }
} else if (mode === "restore") {
  if (existsSync(BAK)) {
    copyFileSync(BAK, MAIN);
    rmSync(BAK);
    console.log("[readme-swap] 已还原 GitHub README");
  }
}
