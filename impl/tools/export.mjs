// 导出 Flutter 侧消费的 styled IR（每个 slot 一个文件）。
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { loadPlugin } from '../src/plugin.mjs';
import { exportSlots } from './prerender.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginId = process.argv[2] || 'dsh-windows-mcp';
const outDir = join(here, '..', 'app', 'test', 'fixtures');
mkdirSync(outDir, { recursive: true });

// 多帧采样：会自己动的 canvas 会被录成 N 帧（见 prerender.mjs）。
// `--frames=0` 可以关掉，只在排查「帧数据是不是把 IR 撑大了」时用。
const framesArg = process.argv.slice(3).find((a) => a.startsWith('--frames='));
const frameCount = framesArg ? Number(framesArg.split('=')[1]) : undefined;
// 插件既可能在 fixtures/<id>（早期布局），也可能在 fixtures/plugins/<id>。
const fixtureRoot = join(here, '..', 'fixtures');
const pluginDir = existsSync(join(fixtureRoot, pluginId))
  ? join(fixtureRoot, pluginId)
  : join(fixtureRoot, 'plugins', pluginId);
const plugin = loadPlugin(pluginDir);
const bundle = await exportSlots(plugin, frameCount === undefined ? {} : { frames: frameCount });

const file = join(outDir, `${pluginId}.json`);
writeFileSync(file, JSON.stringify(bundle, null, 2));
const count = (n) => 1 + (n.children || []).reduce((a, c) => a + count(c), 0);
console.log(`导出 ${bundle.plugin} ${Object.keys(bundle.slots).length} 个 slot -> ${file}`);
for (const [k, v] of Object.entries(bundle.slots)) console.log(`  ${k}: ${count(v)} 节点`);
