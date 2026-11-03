# QQ音乐 点播：搜歌 → 双击第一条结果 → 验证
# 用法: powershell -File qqmusic-play.ps1 "<歌名>" [结果json路径]
#
# 做成这套是因为 QQ音乐 没有任何可用的调起接口（/play 只认本地文件、
# QQMusicExternal 不认链接、COM 会挂起），只能模拟操作。
# 这里每一步都验证，失败会明确返回 ok=false，不假装成功。

$ErrorActionPreference = 'Stop'
$song = if ($args.Count -ge 1 -and $args[0]) { [string]$args[0] } else { throw '缺少歌名' }
$outJson = if ($args.Count -ge 2 -and $args[1]) { [string]$args[1] } else { Join-Path $env:TEMP 'qqmusic-play-result.json' }

function Write-Result($obj) {
    [System.IO.File]::WriteAllText($outJson, ($obj | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
}

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class QMP {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EP cb, IntPtr l);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    // x64 上 INPUT 必须是 40 字节，否则 SendInput 静默失败
    [StructLayout(LayoutKind.Explicit)] public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public MOUSEINPUT mi; [FieldOffset(8)] public KEYBDINPUT ki; }
    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);

    public struct RECT { public int L, T, R, B; }
    public delegate bool EP(IntPtr h, IntPtr l);
    public const uint KEYUP = 0x0002, LEFTDOWN = 0x0002, LEFTUP = 0x0004, UNICODE = 0x0004;

    public static void Tap(byte vk) { keybd_event(vk, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(45); keybd_event(vk, 0, KEYUP, UIntPtr.Zero); }
    public static void CtrlA() {
        keybd_event(0x11, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(40);
        keybd_event(0x41, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(40);
        keybd_event(0x41, 0, KEYUP, UIntPtr.Zero); System.Threading.Thread.Sleep(40);
        keybd_event(0x11, 0, KEYUP, UIntPtr.Zero);
    }
    public static void Click(int x, int y) {
        SetCursorPos(x, y); System.Threading.Thread.Sleep(120);
        mouse_event(LEFTDOWN, 0, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(80);
        mouse_event(LEFTUP, 0, 0, 0, UIntPtr.Zero);
    }
    public static void DoubleClick(int x, int y) {
        SetCursorPos(x, y); System.Threading.Thread.Sleep(180);
        for (int i = 0; i < 2; i++) {
            mouse_event(LEFTDOWN, 0, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(45);
            mouse_event(LEFTUP, 0, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(95);
        }
    }
    public static void TypeText(string text) {
        foreach (char ch in text) {
            INPUT d = new INPUT(); d.type = 1; d.ki.wScan = (ushort)ch; d.ki.dwFlags = UNICODE;
            INPUT u = new INPUT(); u.type = 1; u.ki.wScan = (ushort)ch; u.ki.dwFlags = UNICODE | KEYUP;
            if (SendInput(1, new INPUT[] { d }, Marshal.SizeOf(typeof(INPUT))) == 0) throw new Exception("SendInput 失败");
            if (SendInput(1, new INPUT[] { u }, Marshal.SizeOf(typeof(INPUT))) == 0) throw new Exception("SendInput 失败");
            System.Threading.Thread.Sleep(30);
        }
    }
    public static IntPtr Largest(int pid) {
        IntPtr best = IntPtr.Zero; long area = 0;
        EnumWindows((h, l) => {
            if (!IsWindowVisible(h)) return true;
            uint p; GetWindowThreadProcessId(h, out p);
            if (p != (uint)pid) return true;
            RECT r; GetWindowRect(h, out r);
            long w = r.R - r.L, hh = r.B - r.T;
            if (w < 300 || hh < 200) return true;
            if (w * hh > area) { area = w * hh; best = h; }
            return true;
        }, IntPtr.Zero);
        return best;
    }
    public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString().Trim(); }
    // 当前在放什么：找标题里带「 - 」的窗口（主窗标题常常是空的，歌名在托盘那个小窗上）
    public static string SongTitle(int pid) {
        string found = "";
        EnumWindows((h, l) => {
            uint p; GetWindowThreadProcessId(h, out p);
            if (p != (uint)pid) return true;
            string t = Title(h);
            if (t.Contains(" - ")) { found = t; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
"@
[void][QMP]::SetProcessDPIAware()

Add-Type -AssemblyName System.Drawing
function Shot($path, [IntPtr]$h) {
    $r = New-Object QMP+RECT; [void][QMP]::GetWindowRect($h, [ref]$r)
    $w = $r.R - $r.L; $hh = $r.B - $r.T
    if ($w -le 0 -or $hh -le 0) { return }
    $bmp = New-Object System.Drawing.Bitmap $w, $hh
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size $w, $hh))
    $g.Dispose(); $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
}

try {
    $proc = Get-Process QQMusic -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $proc) {
        # 2026-11-03：原来写死一个安装路径（C:\Program Files (x86)\...），别人装到
        # Program Files 或自定义目录就直接失败。现在两处都试，还可以用环境变量覆盖。
        $candidates = @()
        if ($env:QQMUSIC_EXE) { $candidates += $env:QQMUSIC_EXE }
        $candidates += 'C:\Program Files (x86)\Tencent\QQMusic\QQMusic.exe'
        $candidates += 'C:\Program Files\Tencent\QQMusic\QQMusic.exe'
        $candidates += (Join-Path $env:LOCALAPPDATA 'Tencent\QQMusic\QQMusic.exe')
        $exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
        if (-not $exe) {
            [pscustomobject]@{ ok = $false; error = '没找到 QQ 音乐（QQMusic.exe）。装好后重试，或用环境变量 QQMUSIC_EXE 指定路径。' } |
                ConvertTo-Json -Compress | Set-Content -Path $outJson -Encoding UTF8
            Write-Output '没找到 QQ 音乐'
            exit 3
        }
        Start-Process -FilePath $exe
        Start-Sleep -Seconds 6
        $proc = Get-Process QQMusic -ErrorAction Stop | Select-Object -First 1
    }

    # 找主窗。QQ音乐 缩到托盘时窗口会变成 0×0（不是普通最小化），ShowWindow 救不回来，
    # 只能重开一次客户端把它唤出来。重开后不一定马上有窗口，所以多试几轮、越等越久。
    $h = [IntPtr]::Zero
    foreach ($wait in @(0, 6, 9, 12)) {
        if ($wait -gt 0) {
            Start-Process -FilePath 'C:\Program Files (x86)\Tencent\QQMusic\QQMusic.exe'
            Start-Sleep -Seconds $wait
        }
        $proc = Get-Process QQMusic -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $proc) { continue }
        $h = [QMP]::Largest($proc.Id)
        if ($h -ne [IntPtr]::Zero) { break }
    }
    if ($h -eq [IntPtr]::Zero) {
        Write-Result @{ ok = $false; reason = 'no-window'; message = 'QQ音乐 窗口不可用（可能缩在托盘里），重开了一次也没出来' }
        exit 0
    }

    if ([QMP]::IsIconic($h)) { [void][QMP]::ShowWindow($h, 9); Start-Sleep -Milliseconds 800 }
    [void][QMP]::ShowWindow($h, 5)
    [void][QMP]::SetForegroundWindow($h)
    Start-Sleep -Milliseconds 800

    $before = [QMP]::SongTitle($proc.Id)
    $r = New-Object QMP+RECT; [void][QMP]::GetWindowRect($h, [ref]$r)
    $w = $r.R - $r.L; $hh = $r.B - $r.T

    # ① 点搜索框并清空（不清空会变成「晴天晴天」，结果列表整体错位）
    [QMP]::Click(($r.L + [int](0.37 * $w)), ($r.T + [int](0.099 * $hh)))
    Start-Sleep -Milliseconds 600
    [QMP]::CtrlA()
    Start-Sleep -Milliseconds 200
    [QMP]::Tap(0x2E)
    Start-Sleep -Milliseconds 250

    # ② 输入 + 搜索
    [QMP]::TypeText($song)
    Start-Sleep -Milliseconds 500
    Shot ($outJson + "-typed.png") $h
    [QMP]::Tap(0x0D)
    Start-Sleep -Milliseconds 2800

    # ③ 双击第一条结果。行的纵向位置随「是否出现歌手卡片」而变，
    #    所以按候选比例逐个试，标题一变就说明播上了。
    $candidates = @(0.508, 0.461, 0.538)
    $played = $false
    $after = $before
    foreach ($ratio in $candidates) {
        $h2 = [QMP]::Largest($proc.Id)
        $r2 = New-Object QMP+RECT; [void][QMP]::GetWindowRect($h2, [ref]$r2)
        $w2 = $r2.R - $r2.L; $hh2 = $r2.B - $r2.T
        [QMP]::DoubleClick(($r2.L + [int](0.282 * $w2)), ($r2.T + [int]($ratio * $hh2)))
        Start-Sleep -Milliseconds 2600
        $after = [QMP]::SongTitle($proc.Id)
        if ($after -ne '' -and $after -ne $before) { $played = $true; break }
    }

    Write-Result @{
        ok      = $played
        query   = $song
        before  = $before
        after   = $after
        message = if ($played) { '已在 QQ音乐 里播放' } else { '没播上（搜索结果位置可能变了，或这首歌需要 VIP）' }
    }
    exit 0
}
catch {
    Write-Result @{ ok = $false; reason = 'error'; message = $_.Exception.Message }
    exit 1
}
