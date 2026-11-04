/**
 * dsh-miu-music —— 给 agent 一对耳朵，听得见主人在放什么歌。
 *
 * 五个工具：
 *   miu_music_now      现在在听什么（歌名 / 歌手 / 进度 / 播放状态）
 *   miu_music_lyric    按歌名取歌词（走 QQ 音乐接口，不需要登录）
 *   miu_music_search   搜歌（返回歌名、歌手、专辑、时长）
 *   miu_music_play     点播：在 QQ 音乐里搜出来并播放
 *   miu_music_control  切歌 / 暂停（模拟媒体键）
 *
 * 为什么是 QQ 音乐：这是唯一一个「能读到播放状态 + 能按名字点播」的常用客户端。
 *   - 播放状态走 Windows SMTC（系统媒体控制），任何支持 SMTC 的播放器都能读；
 *     实际上 Spotify、网易云也支持，只是本插件默认按 QQ 音乐测的。
 *   - 歌词和搜索走 QQ 音乐的公开接口 musicu.fcg（POST，不需要登录）。
 *   - 点播是**模拟 UI 操作**：搜出来点第一首。QQ 音乐改版就可能失效，
 *     所以失败时工具会明确返回失败原因，调用方不要假装播上了。
 *
 * 平台：Windows。非 Windows 会直接抛错（SMTC 和 UI 自动化都是 Win 的东西）。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-miu-music';
export const inject = ['tools'];

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'lib', 'music.mjs');

/**
 * 拿 defineTool。
 *
 * 2026-11-04：@deepseek-ai/dsh-tools 不在用户的 node_modules 里——DSH 给**本地路径/链接**
 * 安装的插件注入它，但从 npm / GitHub 装成真实包时解析不到，插件就整个激活失败。
 * 所以这里做成可选：拿不到就退回"原样返回规格对象"，现代 DSH 的 ctx.tools.register
 * 接受的本来就是这个形状。这样无论怎么装都能起来。
 */
async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools');
    if (mod?.defineTool) return mod.defineTool;
  } catch { /* 继续试环境变量 */ }
  const override = process.env.DSH_TOOLS_PATH;
  if (override) {
    try {
      const { pathToFileURL } = await import('node:url');
      const mod = await import(pathToFileURL(override).href);
      if (mod?.defineTool) return mod.defineTool;
    } catch { /* 落到兜底 */ }
  }
  // 兜底：不依赖 dsh-tools。但要注意 —— defineTool 原本会把 `required: true` 这种
  // 简写转成标准 JSON Schema；自己退回时不做这步，register 会报
  // "schema.properties.x.required is not supported on type string"。
  // 所以这里递归把 properties 里的 required:true 提到父级的 required 数组。
  return (spec) => normalizeRequired(spec);
}

function normalizeRequired(value) {
  if (Array.isArray(value)) return value.map(normalizeRequired);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'required') { out.required = item; continue; }
    out[key] = normalizeRequired(item);
  }
  if (out.properties && typeof out.properties === 'object') {
    const required = new Set(Array.isArray(out.required) ? out.required : []);
    const properties = {};
    for (const [name, prop] of Object.entries(out.properties)) {
      if (prop && typeof prop === 'object' && prop.required === true) {
        const { required: _drop, ...rest } = prop;
        properties[name] = normalizeRequired(rest);
        required.add(name);
      } else {
        properties[name] = normalizeRequired(prop);
      }
    }
    out.properties = properties;
    if (required.size) out.required = [...required];
  }
  return out;
}

/** 跑一次 CLI，拿它的 stdout。失败时把 stderr 一起带出去，别吞掉原因。 */
function runMusic(args, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error('dsh-miu-music 目前只支持 Windows（依赖 SMTC 和 UI 自动化）'));
      return;
    }
    if (!existsSync(CLI)) {
      reject(new Error('找不到 lib/music.mjs，插件文件不完整'));
      return;
    }
    const child = spawn(process.execPath, [CLI, ...args], { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`music.mjs 超时（${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { err += String(chunk); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = (out || '').trim();
      if (code === 0 && text) { resolve(text); return; }
      reject(new Error(((err || text).trim() || `music.mjs 退出码 ${code}`).slice(0, 500)));
    });
  });
}

const textOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', required: true, description: '结果文本。' } },
  },
  render(_args, value) {
    return [{ type: 'text', text: value.text }];
  },
};

export async function apply(ctx) {
  const defineTool = await loadDefineTool();

  const nowTool = defineTool({
    name: 'miu_music_now',
    description:
      '知道主人此刻在听什么歌：返回歌名、歌手、播放进度和状态。'
      + '只在主人提到音乐、问「我在听什么」、或系统提示刚换歌时调用；'
      + '主人没提音乐就别主动去翻。数据来自 Windows SMTC，播放器必须是支持的（QQ 音乐、Spotify、网易云等）。',
    parameters: {},
    output: textOutput,
    async execute() {
      return { text: await runMusic(['now']) };
    },
  });

  const lyricTool = defineTool({
    name: 'miu_music_lyric',
    description:
      '按歌名取歌词正文（QQ 音乐接口，不需要登录）。'
      + '用来聊这首歌在讲什么，不要大段复述歌词原文，也不要把它当事实转述。',
    parameters: {
      title: { type: 'string', required: true, description: '歌名。' },
      artist: { type: 'string', description: '歌手，可省略；给了能提高命中率。' },
      full: { type: 'boolean', description: 'true = 返回完整歌词；默认只回开头一段。' },
    },
    output: textOutput,
    async execute(args) {
      const argv = ['lyric', '--title', String(args?.title ?? '')];
      if (args?.artist) argv.push('--artist', String(args.artist));
      if (args?.full === true) argv.push('--full');
      return { text: await runMusic(argv, 20_000) };
    },
  });

  const searchTool = defineTool({
    name: 'miu_music_search',
    description:
      '在 QQ 音乐里搜歌，返回歌名、歌手、专辑和时长。'
      + '主人说「想听某某」「帮我找…」时用它，然后从结果里挑，不要一次列十几首。',
    parameters: {
      query: { type: 'string', required: true, description: '搜索词：歌名、歌手，或「下雨天听的慢歌」这种描述。' },
    },
    output: textOutput,
    async execute(args) {
      return { text: await runMusic(['search', '--query', String(args?.query ?? '')], 20_000) };
    },
  });

  const playTool = defineTool({
    name: 'miu_music_play',
    description:
      '点播：在 QQ 音乐里搜出这首歌并播放。**这是模拟 UI 操作，可能失败**——'
      + '失败时照实说「没播上」，不要假装成功。会把 QQ 音乐窗口调到前台，主人正在忙时先问一句。',
    parameters: {
      title: { type: 'string', required: true, description: '要放的歌，建议写成「歌名 歌手」。' },
    },
    output: textOutput,
    async execute(args) {
      return { text: await runMusic(['play', '--title', String(args?.title ?? '')], 90_000) };
    },
  });

  const controlTool = defineTool({
    name: 'miu_music_control',
    description:
      '控制播放：next 下一首 / prev 上一首 / pause 暂停或继续（模拟媒体键）。'
      + '**只在主人明确让你动的时候用**，别自己切他的歌。',
    parameters: {
      action: { type: 'string', required: true, description: 'next / prev / pause' },
    },
    output: textOutput,
    async execute(args) {
      const action = String(args?.action ?? '').trim();
      if (!['next', 'prev', 'pause'].includes(action)) throw new Error('action 只能是 next / prev / pause');
      return { text: await runMusic([action], 15_000) };
    },
  });

  const disposers = [nowTool, lyricTool, searchTool, playTool, controlTool]
    .map((tool) => ctx.tools.register(tool));
  return () => { for (const dispose of disposers) dispose?.(); };
}
