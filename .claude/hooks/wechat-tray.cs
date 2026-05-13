// wechat-tray.cs — System tray icon for WeChat Skill Launcher
// Compile (from project root):
//   "C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe" /nologo /target:winexe /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /out:.claude\hooks\wechat-tray.exe .claude\hooks\wechat-tray.cs

using System;
using System.Diagnostics;
using System.Drawing;
using System.Net;
using System.Windows.Forms;
using System.IO;

public class WeChatTrayApp
{
    private static NotifyIcon trayIcon;
    private static Process launcherProc;
    private static Timer statusTimer;
    private static string guiUrl = "http://localhost:3456";
    private static string launcherExe;
    private static string projectRoot;

    [STAThread]
    public static void Main(string[] args)
    {
        projectRoot = ".";
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == "--project-root" || args[i] == "-ProjectRoot")
            {
                projectRoot = args[i + 1];
                break;
            }
        }

        launcherExe = Path.Combine(projectRoot, "wechat-launcher.exe");

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        trayIcon = new NotifyIcon();
        trayIcon.Text = "WeChat Skill Launcher";

        // Load custom icon from file
        string iconPath = Path.Combine(projectRoot, ".claude", "hooks", "wechat-tray.ico");
        if (File.Exists(iconPath))
        {
            try { trayIcon.Icon = new Icon(iconPath); }
            catch { trayIcon.Icon = SystemIcons.Application; }
        }
        else
        {
            trayIcon.Icon = SystemIcons.Application;
        }
        trayIcon.Visible = true;

        trayIcon.Click += OnTrayClick;

        ContextMenuStrip menu = new ContextMenuStrip();
        menu.Font = new Font("Microsoft YaHei UI", 9);

        ToolStripMenuItem openItem = new ToolStripMenuItem("Open GUI  http://localhost:3456");
        openItem.Click += OnOpenClick;
        menu.Items.Add(openItem);

        ToolStripMenuItem restartItem = new ToolStripMenuItem("Restart Watcher");
        restartItem.Click += OnRestartClick;
        menu.Items.Add(restartItem);

        menu.Items.Add(new ToolStripSeparator());

        ToolStripMenuItem exitItem = new ToolStripMenuItem("Exit");
        exitItem.ForeColor = Color.FromArgb(220, 50, 50);
        exitItem.Click += OnExitClick;
        menu.Items.Add(exitItem);

        trayIcon.ContextMenuStrip = menu;

        StartLauncher();

        statusTimer = new Timer();
        statusTimer.Interval = 3000;
        statusTimer.Tick += OnTimerTick;
        statusTimer.Start();

        Application.Run();

        statusTimer.Stop();
        trayIcon.Visible = false;
        trayIcon.Dispose();
    }

    private static void OnTrayClick(object sender, EventArgs e)
    {
        MouseEventArgs me = e as MouseEventArgs;
        if (me != null && me.Button == MouseButtons.Left)
        {
            OpenBrowser(guiUrl);
        }
    }

    private static void OnOpenClick(object sender, EventArgs e)
    {
        OpenBrowser(guiUrl);
    }

    private static void OnRestartClick(object sender, EventArgs e)
    {
        try
        {
            using (WebClient wc = new WebClient())
            {
                wc.UploadString(guiUrl + "/api/watcher/restart", "POST", "");
            }
        }
        catch { }
    }

    private static void OnExitClick(object sender, EventArgs e)
    {
        ExitApp();
    }

    private static void OnTimerTick(object sender, EventArgs e)
    {
        if (launcherProc == null || launcherProc.HasExited)
        {
            trayIcon.Text = "WeChat Skill Launcher -- Stopped";
            StartLauncher();
        }
        else
        {
            trayIcon.Text = "WeChat Skill Launcher -- Running";
        }
    }

    private static void StartLauncher()
    {
        if (launcherProc != null && !launcherProc.HasExited)
            return;

        if (!File.Exists(launcherExe))
        {
            trayIcon.Text = "WeChat Skill Launcher -- exe not found";
            return;
        }

        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(launcherExe, "--hidden");
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            psi.CreateNoWindow = true;
            psi.UseShellExecute = false;
            launcherProc = Process.Start(psi);
            trayIcon.Text = "WeChat Skill Launcher -- Starting...";
        }
        catch
        {
            trayIcon.Text = "WeChat Skill Launcher -- Start failed";
        }
    }

    private static void OpenBrowser(string url)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(url);
            psi.UseShellExecute = true;
            Process.Start(psi);
        }
        catch { }
    }

    private static void ExitApp()
    {
        if (statusTimer != null)
        {
            statusTimer.Stop();
        }
        trayIcon.Visible = false;

        if (launcherProc != null && !launcherProc.HasExited)
        {
            try { launcherProc.Kill(); } catch { }
        }

        try
        {
            Process[] procs = Process.GetProcessesByName("wechat-launcher");
            foreach (Process p in procs)
            {
                int launcherId = (launcherProc != null) ? launcherProc.Id : -1;
                if (p.Id != launcherId)
                {
                    try { p.Kill(); } catch { }
                }
            }
        }
        catch { }

        trayIcon.Dispose();
        Application.Exit();
    }
}
