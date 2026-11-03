# 读取「当前正在播放」的媒体信息，结果写入指定的 JSON 文件。
# 用法: powershell -File music-now.ps1 [输出文件路径]
#
# 两条路：
#   1) Windows SMTC（系统媒体控制）—— 标准做法，但 QQ音乐 19.43 实测不上报
#   2) 窗口标题兜底 —— QQ音乐 的标题就是「歌名 - 歌手」
#
# 不用 stdout 传结果，是因为沙箱环境下 Node 捕获子进程管道可能被拒（EPERM），写文件最稳。
$ErrorActionPreference = 'Stop'

$outPath = if ($args.Count -ge 1 -and $args[0]) { $args[0] } else { Join-Path $env:TEMP 'miu-music-now.json' }

function Write-Result($obj) {
    $dir = Split-Path -Parent $outPath
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [System.IO.File]::WriteAllText($outPath, ($obj | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
}

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class MiuWin {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EP cb, IntPtr l);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    public delegate bool EP(IntPtr h, IntPtr l);
}
"@

# ── 兜底：从播放器窗口标题读「歌名 - 歌手」──
function Get-FromWindowTitle {
    $playerNames = @('QQMusic')
    $script:found = @()
    $callback = {
        param($h, $l)
        if (-not [MiuWin]::IsWindowVisible($h)) { return $true }
        $sb = New-Object System.Text.StringBuilder 512
        [MiuWin]::GetWindowText($h, $sb, 512) | Out-Null
        $title = $sb.ToString().Trim()
        if ($title -eq '') { return $true }
        $procId = 0
        [MiuWin]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
        $procName = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
        if ($playerNames -notcontains $procName) { return $true }
        $script:found += [pscustomobject]@{ proc = $procName; title = $title }
        return $true
    }
    [MiuWin]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
    return $script:found | Select-Object -First 1
}

function Split-TrackTitle($raw) {
    # QQ音乐 的标题是「歌名 - 歌手」；歌名里也可能有 " - "，所以从右往左切最后一次
    $index = $raw.LastIndexOf(' - ')
    if ($index -lt 1) { return [pscustomobject]@{ title = $raw; artist = '' } }
    return [pscustomobject]@{
        title  = $raw.Substring(0, $index).Trim()
        artist = $raw.Substring($index + 3).Trim()
    }
}

# ── 先试 SMTC ──
$smtcResult = $null
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
    $await = {
        param($op, $resultType)
        $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
        $task = $asTask.Invoke($null, @($op))
        $task.Wait(-1) | Out-Null
        $task.Result
    }
    $mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
    $mgr = & $await ($mgrType::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    # 2026-11-03 修：原来用 GetCurrentSession()，谁最后播过/谁有焦点就是谁——
    #   浏览器里放个视频就会把我们钉在浏览器上，明明 QQ音乐 正在放歌也读不到。
    #   现在枚举所有会话：优先「正在播放」，其中优先常见音乐播放器；都没有才退回当前会话。
    $sessions = @($mgr.GetSessions())
    $preferredApps = @('QQMusic', 'Spotify', 'cloudmusic', 'kugou', 'KuGou', 'foobar2000')
    $playing = @()
    foreach ($s in $sessions) {
        try {
            $pi = $s.GetPlaybackInfo()
            $st = [string]$pi.PlaybackStatus
            if ($st -eq 'Playing') {
                $playing += [pscustomobject]@{ session = $s; app = [string]$s.SourceAppUserModelId }
            }
        } catch { }
    }
    $session = $null
    if ($playing.Count -gt 0) {
        $musicHit = $null
        foreach ($candidate in $playing) {
            foreach ($appName in $preferredApps) {
                if ($candidate.app -like "*$appName*") { $musicHit = $candidate; break }
            }
            if ($musicHit) { break }
        }
        if ($musicHit) { $session = $musicHit.session } else { $session = $playing[0].session }
    } else {
        $session = $mgr.GetCurrentSession()
    }
    if ($session) {
        $info = $session.GetPlaybackInfo()
        $timeline = $session.GetTimelineProperties()
        $props = & $await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
        $smtcResult = [pscustomobject]@{
            ok        = $true
            source    = 'smtc'
            sourceApp = $session.SourceAppUserModelId
            title     = $props.Title
            artist    = $props.Artist
            album     = $props.AlbumTitle
            status    = [string]$info.PlaybackStatus
            position  = [math]::Round(($timeline.Position.TotalSeconds), 1)
            duration  = [math]::Round(($timeline.EndTime.TotalSeconds), 1)
        }
    }
}
catch { }

# 2026-11-03 修：原来「SMTC 有结果就直接返回」，于是浏览器里放个视频就把
#   QQ音乐 正在放的歌盖掉了（QQ音乐 有些版本根本不往 SMTC 上报）。
#   现在两条路都拿，再按可信度挑：音乐播放器的 SMTC > 播放器窗口标题 > 任何 SMTC。
$windowResult = $null
try {
    $hit = Get-FromWindowTitle
    if ($hit) {
        $raw = $hit.title
        if ($raw -notmatch '^(QQ音乐|QQMusic)$' -and $raw -ne '') {
            $parts = Split-TrackTitle $raw
            $windowResult = [pscustomobject]@{
                ok        = $true
                source    = 'window'
                sourceApp = $hit.proc
                title     = $parts.title
                artist    = $parts.artist
                album     = ''
                status    = 'playing'
                position  = -1
                duration  = -1
                note      = '来自窗口标题，拿不到播放进度'
            }
        } elseif (-not $smtcResult) {
            $windowResult = [pscustomobject]@{ ok = $false; reason = 'idle'; source = 'window'; message = 'QQ音乐 开着，但当前没有在放歌' }
        }
    }
} catch { }

$SMTC_MUSIC_APPS = @('QQMusic', 'Spotify', 'cloudmusic', 'kugou', 'foobar2000', 'Tencent')
$smtcIsMusic = $false
if ($smtcResult) {
    foreach ($appName in $SMTC_MUSIC_APPS) {
        if ([string]$smtcResult.sourceApp -like "*$appName*") { $smtcIsMusic = $true; break }
    }
}

if ($smtcResult -and ($smtcIsMusic -or -not $windowResult)) {
    Write-Result $smtcResult
    exit 0
}
if ($windowResult) {
    Write-Result $windowResult
    exit 0
}
if ($smtcResult) {
    Write-Result $smtcResult
    exit 0
}

Write-Result ([pscustomobject]@{ ok = $false; reason = 'no-player'; source = 'window'; message = '没有找到正在播放的播放器（QQ音乐 没开，或者没在放歌）' })
exit 0
