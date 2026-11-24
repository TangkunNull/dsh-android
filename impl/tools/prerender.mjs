// 构建期把「会自己动的 canvas」采样成多帧，供原生侧循环播放。
//
// 实现已挪到 `src/export-slots.mjs`：`slots` 命令（host/bridge-server.mjs）要在
// 设备上跑**同一条**导出路径，而 runtime.zip 只装 src/ 不装 tools/。这里只留
// re-export，构建期脚本（export.mjs / scan-plugins.mjs / regress.mjs）与测试
// 的 import 路径不变 —— 实现只此一份，两边量出的数字才可比。
export {
  exportSlots,
  DEFAULT_FRAMES,
  FRAME_INTERVAL_MS,
  MAX_TOTAL_OPS,
  __test,
} from '../src/export-slots.mjs';
