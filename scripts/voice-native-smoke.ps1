param([Parameter(Mandatory = $true)][string] $ResultFile)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class VoiceFixtureFocus {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
}
'@
$voiceFixture = New-Object System.Windows.Forms.Form
$voiceFixture.Text = 'Orchestra native voice test'
$voiceFixture.Width = 540
$voiceFixture.Height = 160
$voiceInput = New-Object System.Windows.Forms.TextBox
$voiceInput.Dock = [System.Windows.Forms.DockStyle]::Fill
$voiceInput.Multiline = $true
$voiceInput.Text = 'Черновик '
$voiceFixture.Controls.Add($voiceInput)
$voiceFixture.Add_Shown({
    [VoiceFixtureFocus]::SetForegroundWindow($voiceFixture.Handle) | Out-Null
    $voiceInput.Focus() | Out-Null
    $voiceInput.SelectionStart = $voiceInput.Text.Length
    @{ window = $voiceFixture.Handle.ToInt64(); focus = $voiceInput.Handle.ToInt64() } |
        ConvertTo-Json | Set-Content -LiteralPath $ResultFile -Encoding UTF8
})
# The fixture closes itself; it never leaves a test GUI running indefinitely.
$voiceFixtureTimer = New-Object System.Windows.Forms.Timer
$voiceFixtureTimer.Interval = 20000
$voiceFixtureTimer.Add_Tick({ $voiceFixtureTimer.Stop(); $voiceFixture.Close() })
$voiceFixtureTimer.Start()
[System.Windows.Forms.Application]::Run($voiceFixture)
$voiceFixtureTimer.Dispose()
$voiceFixture.Dispose()
