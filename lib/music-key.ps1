# 发送媒体键：next / prev / pause
# 走系统媒体键，QQ音乐 和任何支持媒体键的播放器都认，比模拟点击稳得多。
$action = if ($args.Count -ge 1) { [string]$args[0] } else { '' }

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MediaKeys {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public static void Tap(byte vk) {
        keybd_event(vk, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(40);
        keybd_event(vk, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }
}
"@

switch ($action) {
    'next'  { [MediaKeys]::Tap(0xB0) }
    'prev'  { [MediaKeys]::Tap(0xB1) }
    'pause' { [MediaKeys]::Tap(0xB3) }
    default {
        Write-Error "用法: music-key.ps1 next|prev|pause"
        exit 2
    }
}
exit 0
