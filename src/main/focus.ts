import { execFile } from 'node:child_process';
import { compileHelper } from './helper';
import type { Session } from '../shared/types';

export type JumpResult = 'focused' | 'flashed' | 'not-found';

/**
 * Finds the agent's window by title, focuses it, and flashes its taskbar button when
 * Windows refuses the foreground change.
 *
 * ponytail: title matching only — no process-tree walk from `shimPid`, and no
 * AttachThreadInput escalation (both deliberately out of scope). So this is a
 * heuristic and can pick the wrong window when two projects share a folder name.
 * Upgrade path is walking the parent chain from `shimPid` to the owning host process.
 *
 * The work runs in a helper exe rather than a powershell script because powershell
 * startup alone costs ~2s on a real machine — far too slow for a button. The helper is
 * compiled once by the in-box C# compiler, so there is no npm native module, no build
 * toolchain requirement, and nothing extra to ship in the installer.
 */
const HELPER_SRC = String.raw`
using System;
using System.Diagnostics;
using System.Text;
using System.Runtime.InteropServices;

public class PinglyFocus {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  // CharSet.Unicode is required: without it .NET marshals the UTF-16 title as ANSI
  // and every window name truncates to its first character.
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

  [StructLayout(LayoutKind.Sequential)]
  struct FLASHWINFO { public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; }
  [DllImport("user32.dll")] static extern bool FlashWindowEx(ref FLASHWINFO pwfi);

  const int SW_RESTORE = 9;
  const uint FLASHW_ALL = 3, FLASHW_TIMERNOFG = 12;

  // Window hosts we can jump back to, matched on the exact process name. Antigravity
  // stays listed even though its own agent is not supported: the Claude Code and Codex
  // extensions run inside it, and "Antigravity IDE" ships under its own process name.
  static readonly string[] Hosts = {
    "cursor", "windowsterminal", "code", "antigravity", "antigravity ide",
    "powershell", "pwsh", "cmd", "alacritty", "wezterm", "conhost"
  };

  static string Env(string n) { return (Environment.GetEnvironmentVariable(n) ?? "").ToLowerInvariant(); }

  public static int Main(string[] args) {
    string project = Env("PINGLY_PROJECT");
    string cwd = Env("PINGLY_CWD");
    string agent = Env("PINGLY_AGENT");
    int self = 0; int.TryParse(Environment.GetEnvironmentVariable("PINGLY_SELF_PID"), out self);
    if (project.Length == 0) { Console.Write("not-found"); return 0; }

    IntPtr best = IntPtr.Zero;
    int bestRank = int.MaxValue, bestLen = int.MaxValue;

    EnumProc scan = delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      StringBuilder sb = new StringBuilder(512);
      if (GetWindowTextW(h, sb, 512) == 0) return true;
      string title = sb.ToString();
      string lower = title.ToLowerInvariant();

      uint pid; GetWindowThreadProcessId(h, out pid);
      if ((int)pid == self) return true;
      string name;
      try { name = Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant(); } catch { return true; }

      bool titleMatch = lower.IndexOf(project) >= 0 || (cwd.Length > 0 && lower.IndexOf(cwd) >= 0);
      bool cursorFallback = agent == "cursor" && name == "cursor";
      if (!titleMatch && !cursorFallback) return true;

      int rank = titleMatch ? (Array.IndexOf(Hosts, name) >= 0 ? 0 : 1) : 2;
      // known agent hosts win; among equals the shortest title is the most specific match
      if (rank < bestRank || (rank == bestRank && title.Length < bestLen)) {
        best = h; bestRank = rank; bestLen = title.Length;
      }
      return true;
    };
    EnumWindows(scan, IntPtr.Zero);
    GC.KeepAlive(scan);

    if (best == IntPtr.Zero) { Console.Write("not-found"); return 0; }

    if (IsIconic(best)) { ShowWindow(best, SW_RESTORE); System.Threading.Thread.Sleep(150); }
    SetForegroundWindow(best);
    System.Threading.Thread.Sleep(150);
    if (GetForegroundWindow() == best) { Console.Write("focused"); return 0; }

    // Windows blocks SetForegroundWindow from background processes. Flash instead of
    // failing silently; FLASHW_TIMERNOFG keeps it flashing until the user looks at it.
    FLASHWINFO f = new FLASHWINFO();
    f.cbSize = (uint)Marshal.SizeOf(f);
    f.hwnd = best;
    f.dwFlags = FLASHW_ALL | FLASHW_TIMERNOFG;
    f.uCount = 5;
    f.dwTimeout = 0;
    FlashWindowEx(ref f);
    Console.Write("flashed");
    return 0;
  }
}
`;

/** Compiles the helper once. Called at startup so the first click is not the slow one. */
export const ensureHelper = (): Promise<string | null> =>
  compileHelper('pingly-focus', HELPER_SRC, 'ConsoleApplication');

export async function jumpTo(session: Session): Promise<JumpResult> {
  const exe = await ensureHelper();
  if (!exe) return 'not-found';
  return new Promise((resolve) => {
    execFile(
      exe,
      [],
      {
        windowsHide: true,
        timeout: 8000,
        // passed as env, not on the command line — project names come from user paths
        env: {
          ...process.env,
          PINGLY_PROJECT: session.project,
          PINGLY_CWD: session.cwd,
          PINGLY_AGENT: session.agent,
          PINGLY_SELF_PID: String(process.pid)
        }
      },
      (err, stdout) => {
        const out = stdout.trim();
        resolve(!err && (out === 'focused' || out === 'flashed') ? out : 'not-found');
      }
    );
  });
}
