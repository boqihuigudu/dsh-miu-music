#!/usr/bin/env node
// Miu 的耳朵：知道主人在 QQ 音乐 听什么、拿到歌词、切歌。
//
// 用法:
//   node music.mjs now                      当前播放（歌名/歌手/进度/状态）
//   node music.mjs line                     当前播放 + 正在唱的那句歌词
//   node music.mjs lyric --title 晴天 [--artist 周杰伦] [--full]
//                                           按歌名搜 QQ 音乐，取歌词正文
//   node music.mjs next | prev | pause      切歌/暂停（模拟媒体键）
//
// 歌词和搜索走 QQ 音乐的 musicu.fcg 接口（POST，不需要登录）。
// 「当前播放」走 Windows SMTC（系统媒体控制），任何支持它的播放器都能读到。

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW_SCRIPT = join(HERE, 'music-now.ps1');
const KEY_SCRIPT = join(HERE, 'music-key.ps1');
const PLAY_SCRIPT = join(HERE, 'qqmusic-play.ps1');
const QQ_API = 'https://u.y.qq.com/cgi-bin/musicu.fcg';

function die(message) {
  console.error('错误: ' + message);
  process.exit(1);
}

// ── 当前播放 ────────────────────────────────────────────────
function readNowPlaying() {
  const outFile = join(tmpdir(), 'miu-music-now-' + process.pid + '.json');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', NOW_SCRIPT, outFile,
  ], { stdio: 'ignore', timeout: 15000 });

  if (!existsSync(outFile)) {
    // 脚本可能因为编码/权限问题没写出文件，退回同步探测一次
    const second = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', NOW_SCRIPT, outFile,
    ], { stdio: 'ignore', timeout: 15000 });
    if (!existsSync(outFile)) {
      return { ok: false, reason: 'probe-failed', message: '读不到当前播放（SMTC 探针没有输出，退出码 ' + (second.status ?? result.status) + '）' };
    }
  }
  try {
    return JSON.parse(readFileSync(outFile, 'utf8'));
  } catch (error) {
    return { ok: false, reason: 'bad-json', message: String(error.message || error) };
  }
}

function describeNow(info) {
  if (!info.ok) return '现在不知道主人在听什么（' + (info.message || info.reason) + '）';
  const state = { playing: '正在播', paused: '暂停中', stopped: '已停止' }[info.status] ?? info.status;
  // 窗口标题兜底时拿不到进度（position = -1），这时候别印 0:00，那是假的
  const hasTimeline = Number(info.position) >= 0 && Number(info.duration) > 0;
  const time = hasTimeline ? ` ${formatTime(info.position)}/${formatTime(info.duration)}` : '';
  return `${info.title} — ${info.artist}（${state}${time}）`;
}

function formatTime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
}

// ── QQ 音乐接口 ─────────────────────────────────────────────
// 为什么不用 fetch：node 的内置 fetch 请求这个接口会被判 2001（空结果），
// 同样的 JSON 用 curl 就是 200 + 正常数据，属于请求指纹差异，不是参数问题。
// 所以统一走 curl.exe，请求体写文件、响应也写文件，避免子进程管道在某些沙箱下被拒。
async function qqCall(req) {
  const stamp = Date.now() + '-' + Math.random().toString(16).slice(2, 8);
  const reqFile = join(tmpdir(), 'miu-music-req-' + stamp + '.json');
  const resFile = join(tmpdir(), 'miu-music-res-' + stamp + '.json');
  writeFileSync(reqFile, JSON.stringify(req), 'utf8');
  try {
    const result = spawnSync('curl.exe', [
      '-s', '-m', '20', '-X', 'POST', QQ_API,
      '-H', 'Content-Type: application/json',
      '-H', 'Referer: https://y.qq.com/',
      '-H', 'User-Agent: Mozilla/5.0',
      '--data-binary', '@' + reqFile,
      '-o', resFile,
    ], { stdio: 'ignore', timeout: 25000 });

    if (result.error) throw new Error('调 curl 失败：' + result.error.message);
    if (!existsSync(resFile)) throw new Error('QQ 音乐接口没有返回内容（curl 退出码 ' + (result.status ?? '?') + '）');

    const text = readFileSync(resFile, 'utf8');
    if (!text.trim()) throw new Error('QQ 音乐接口返回空内容');
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('QQ 音乐接口返回的不是 JSON');
    }
  } finally {
    try { rmSync(reqFile, { force: true }); } catch { /* ignore */ }
    try { rmSync(resFile, { force: true }); } catch { /* ignore */ }
  }
}

// 通用：用 curl 取一个 URL，结果落到文件再读（原因同上，避免管道被拒）
function qqGetJson(url) {
  const stamp = Date.now() + '-' + Math.random().toString(16).slice(2, 8);
  const resFile = join(tmpdir(), 'miu-music-get-' + stamp + '.json');
  try {
    const result = spawnSync('curl.exe', [
      '-s', '-m', '20', url,
      '-H', 'Referer: https://y.qq.com/',
      '-H', 'User-Agent: Mozilla/5.0',
      '-o', resFile,
    ], { stdio: 'ignore', timeout: 25000 });
    if (result.error) throw new Error('调 curl 失败：' + result.error.message);
    if (!existsSync(resFile)) throw new Error('接口没有返回内容');
    const text = readFileSync(resFile, 'utf8');
    if (!text.trim()) throw new Error('接口返回空内容');
    return JSON.parse(text);
  } finally {
    try { rmSync(resFile, { force: true }); } catch { /* ignore */ }
  }
}

// 搜索两条腿，各有毛病，所以都留着：
//   1) musicu 的 DoSearchForQQMusicDesktop —— 能给 10 条、带时长，但间歇性返回
//      内部 code 2001 + 空歌单（短时间连调就会触发，所以失败要等一下再试一次）
//   2) smartbox 联想接口 —— 稳定，但固定只给 4 条
// 先走 1，抽风了就重试一次，还不行退到 2。
async function searchViaMusicu(query) {
  const data = await qqCall({
    req_1: {
      module: 'music.search.SearchCgiService',
      method: 'DoSearchForQQMusicDesktop',
      param: { query, num_per_page: 10, page_num: 1, search_type: 0 },
    },
  });
  return (data?.req_1?.data?.body?.song?.list ?? []).map((song) => ({
    mid: song.mid || song.songmid,
    title: song.title || song.name || '',
    artist: (song.singer ?? []).map((person) => person.name).filter(Boolean).join('/'),
    album: song.album?.name || '',
    interval: Number(song.interval) || 0,
  })).filter((song) => song.mid);
}

async function searchViaSmartbox(query) {
  const url = 'https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?format=json&key=' + encodeURIComponent(query);
  const data = qqGetJson(url);
  return (data?.data?.song?.itemlist ?? []).map((song) => ({
    mid: song.mid,
    title: song.name || '',
    artist: song.singer || '',
    album: '',
    interval: 0,
  })).filter((song) => song.mid);
}

async function searchSong(title, artist) {
  const query = artist ? `${title} ${artist}` : title;
  try {
    const first = await searchViaMusicu(query);
    if (first.length) return first;
  } catch { /* 落下去重试 */ }
  // 2001 通常是短时间调太频，隔一下再试
  await new Promise((resolve) => setTimeout(resolve, 900));
  try {
    const second = await searchViaMusicu(query);
    if (second.length) return second;
  } catch { /* 退到 smartbox */ }
  return searchViaSmartbox(query);
}

// 选最像的那首：标题完全相等优先，其次歌手能对上
function pickBest(candidates, title, artist) {
  if (!candidates.length) return null;
  const norm = (value) => String(value ?? '').toLowerCase().replace(/\s+/g, '');
  const targetTitle = norm(title);
  const targetArtist = norm(artist);
  const scored = candidates.map((song) => {
    let score = 0;
    if (norm(song.title) === targetTitle) score += 10;
    else if (norm(song.title).includes(targetTitle) || targetTitle.includes(norm(song.title))) score += 4;
    if (targetArtist && norm(song.artist).includes(targetArtist)) score += 6;
    return { song, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].song;
}

async function fetchLyric(mid) {
  const data = await qqCall({
    req_1: {
      module: 'music.musichallSong.PlayLyricInfo',
      method: 'GetPlayLyricInfo',
      param: { songMID: mid, songID: 0 },
    },
  });
  const payload = data?.req_1?.data ?? {};
  const decode = (value) => {
    if (!value) return '';
    try {
      const decoded = Buffer.from(String(value), 'base64').toString('utf8');
      // base64 解出来不像歌词就说明原文本来就是明文
      return /[\u4e00-\u9fa5]|\[\d{2}:\d{2}/.test(decoded) ? decoded : String(value);
    } catch {
      return String(value);
    }
  };
  return {
    lyric: decode(payload.lyric),
    trans: decode(payload.trans),
    name: payload.songName || '',
    singer: payload.singerName || '',
  };
}

// 把 LRC 转成「[秒数] 文本」的行，方便按播放进度找当前句
function parseLrc(text) {
  const lines = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const content = raw.replace(/\[[^\]]*\]/g, '').trim();
    if (!content) continue;
    for (const stamp of stamps) {
      const minutes = Number(stamp[1]);
      const seconds = Number(stamp[2]);
      const fraction = stamp[3] ? Number('0.' + stamp[3]) : 0;
      lines.push({ at: minutes * 60 + seconds + fraction, text: content });
    }
  }
  lines.sort((a, b) => a.at - b.at);
  return lines;
}

function currentLine(lines, position) {
  if (!lines.length) return null;
  let found = null;
  for (const line of lines) {
    if (line.at <= position + 0.3) found = line; else break;
  }
  return found;
}

// LRC 里前几行通常是制作信息（词：/曲：/编曲：…），不是歌词本身。
// 不过滤的话「取歌词」会把一屏人名当正文返回（实际踩过）。
const CREDIT_RE = /^(作词|作曲|编曲|词|曲|制作人|监制|出品|发行|统筹|企划|母带|录音|混音|合声|和声|吉他|贝斯|鼓|键盘|弦乐|OP|SP|原唱|翻唱|填词|谱曲)[^：:\n]{0,6}[：:]/i;

function plainLyric(lines) {
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const text = line.text.trim();
    if (text === '') continue;
    if (CREDIT_RE.test(text)) continue;
    // 形如「晴天 - 周杰伦 (Jay Chou)」这种标题行也跳过
    if (text.includes(' - ') && /[（(]/.test(text) && text.length < 40) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

// ── 媒体键 ─────────────────────────────────────────────────
function pressKey(action) {
  if (!existsSync(KEY_SCRIPT)) die('缺少 music-key.ps1');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', KEY_SCRIPT, action,
  ], { stdio: 'inherit', timeout: 15000 });
  if (result.status !== 0) die('媒体键发送失败（退出码 ' + result.status + '）');
  const label = { next: '下一首', prev: '上一首', pause: '暂停/继续' }[action] ?? action;
  console.log('已发送：' + label);
}

// ── 点播（模拟界面，自验成功）────────────────────────────
// QQ音乐 没有可用的调起接口，只能模拟操作：点搜索框 → 打字 → 回车 → 双击第一条。
// 脚本每步都会自检，最后比对窗口标题有没有变，所以 ok=false 是真的没播上，不是猜的。
function runPlay(title) {
  const outFile = join(tmpdir(), 'miu-music-play-' + Date.now() + '.json');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PLAY_SCRIPT, title, outFile,
  ], { stdio: 'ignore', timeout: 90000 });
  if (result.error) return { ok: false, message: '调点播脚本失败：' + result.error.message };
  try {
    return JSON.parse(readFileSync(outFile, 'utf8'));
  } catch {
    return { ok: false, message: '点播脚本没有返回结果' };
  }
}

// ── 主流程 ─────────────────────────────────────────────────
function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item.startsWith('--')) {
      const key = item.slice(2);
      const value = argv[index + 1];
      if (value !== undefined && !value.startsWith('--')) { options[key] = value; index += 1; }
      else options[key] = true;
    }
  }
  return options;
}

const [command, ...rest] = process.argv.slice(2);
const options = parseArgs(rest);

if (!command) {
  console.log('用法: node music.mjs now | line | lyric --title <歌名> [--artist <歌手>] | next | prev | pause');
  process.exit(0);
}

try {
  if (command === 'now') {
    console.log(describeNow(readNowPlaying()));
  } else if (command === 'line') {
    // 「正在唱的那句」只在拿得到播放进度时才有意义（SMTC 能给，窗口标题给不了）。
    // 拿不到进度就退化成「这首歌的歌词节选」，而不是猜一句。
    const info = readNowPlaying();
    console.log(describeNow(info));
    if (info.ok && info.title) {
      const best = pickBest(await searchSong(info.title, info.artist), info.title, info.artist);
      if (!best) {
        console.log('（QQ 音乐里没搜到这首歌的歌词）');
      } else {
        const { lyric } = await fetchLyric(best.mid);
        const lines = parseLrc(lyric);
        if (!lines.length) {
          console.log('（这首歌没有歌词）');
        } else if (Number(info.position) >= 0) {
          const line = currentLine(lines, info.position);
          if (line) console.log('正在唱：' + line.text);
          else console.log('（还没唱到歌词部分）');
        } else {
          console.log('（拿不到播放进度，下面给歌词节选而不是「正在唱的那句」）');
          console.log('---');
          console.log(plainLyric(lines).slice(0, 12).join('\n'));
        }
      }
    }
  } else if (command === 'play') {
    // 点播：搜歌 → 双击第一条 → 脚本自己验证标题变了才算成功；失败重试一次。
    const title = options.title || options.query || options.q;
    if (!title) die('要用 --title 指定歌名，例如 --title "夜曲 周杰伦"');
    let result = runPlay(String(title));
    // 2026-11-03：点到别的歌（matchedTitle=false）是确定性错误，重试只会再放错一次，直接报错。
    if (!result.ok && result.matchedTitle !== false) {
      console.log('第一次没播上，重试一次……');
      result = runPlay(String(title));
    }
    if (!result.ok) die(result.message || '没播上');
    console.log(`已在 QQ音乐 播放：${result.after || title}`);
  } else if (command === 'search') {
    // 帮她「找歌」：给一个说法，返回候选歌单（歌名 / 歌手 / 时长）
    const query = options.query || options.title || options.q;
    if (!query) die('要用 --query 指定想找什么，例如 --query "下雨天听的 city pop"');
    const candidates = await searchSong(String(query), '');
    if (!candidates.length) die('QQ 音乐没搜到「' + query + '」');
    const limit = Number(options.n) > 0 ? Number(options.n) : 8;
    console.log(`「${query}」找到 ${candidates.length} 首（列前 ${Math.min(limit, candidates.length)}）：`);
    candidates.slice(0, limit).forEach((song, index) => {
      const length = song.interval ? ` ${formatTime(song.interval)}` : '';
      console.log(`${index + 1}. ${song.title} — ${song.artist}${length}`);
    });
  } else if (command === 'lyric') {
    if (!options.title) die('要用 --title 指定歌名');
    const candidates = await searchSong(String(options.title), options.artist ? String(options.artist) : '');
    if (!candidates.length) die('QQ 音乐没搜到「' + options.title + '」');
    const best = pickBest(candidates, String(options.title), options.artist ? String(options.artist) : '');
    const { lyric, name, singer } = await fetchLyric(best.mid);
    const lines = parseLrc(lyric);
    if (!lines.length) die('这首歌没取到歌词');
    console.log(`《${name || best.title}》 ${singer || best.artist}`);
    console.log('---');
    const body = plainLyric(lines);
    console.log(options.full ? body.join('\n') : body.slice(0, 30).join('\n'));
  } else if (['next', 'prev', 'pause'].includes(command)) {
    pressKey(command);
  } else {
    die('不认识的命令：' + command);
  }
} catch (error) {
  die(String(error?.message || error));
}
