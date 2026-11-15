using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace TiemvioPOS;

internal static class Program {
    [STAThread]
    static void Main(string[] args) {
        if (args.Contains("--self-test-updater")) { UpdateTrust.SelfTest(); return; }
        ApplicationConfiguration.Initialize();
        if (args.Contains("--stop-updater")) { try { EventWaitHandle.OpenExisting(@"Local\TiemvioPOS.StopUpdates").Set(); } catch (WaitHandleCannotBeOpenedException) { } return; }
        if (!args.Contains("--background")) OpenApp();
        using var mutex = new Mutex(true, @"Local\TiemvioPOS.Updates", out bool first);
        if (!first) return;
        Application.Run(new UpdaterContext());
    }
    internal static void OpenApp() {
        string[] browsers = {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Microsoft\Edge\Application\msedge.exe")
        };
        var edge = browsers.FirstOrDefault(File.Exists);
        try {
            if (edge != null) {
                var p = new ProcessStartInfo(edge) { UseShellExecute = true };
                p.ArgumentList.Add("--app=https://APP_HOST.invalid/");
                Process.Start(p);
            } else Process.Start(new ProcessStartInfo("https://APP_HOST.invalid/") { UseShellExecute = true });
        } catch { MessageBox.Show("Hãy cài Microsoft Edge hoặc mở https://APP_HOST.invalid bằng trình duyệt.", "Tiemvio POS"); }
    }
}

internal sealed class UpdaterContext : ApplicationContext {
    const string Feed = "https://github.com/YOUR_GITHUB_OWNER/RELEASES_REPO/releases/latest/download/";
    readonly NotifyIcon tray;
    readonly System.Windows.Forms.Timer timer = new() { Interval = 60 * 60 * 1000 };
    readonly HttpClient http = new() { Timeout = TimeSpan.FromMinutes(5) };
    bool checking;
    readonly EventWaitHandle stop = new(false, EventResetMode.AutoReset, @"Local\TiemvioPOS.StopUpdates");
    readonly System.Windows.Forms.Timer stopTimer = new() { Interval = 500 };
    public UpdaterContext() {
        tray = new NotifyIcon { Icon = Icon.ExtractAssociatedIcon(Environment.ProcessPath!) ?? SystemIcons.Application, Text = "Tiemvio POS · Tự động cập nhật", Visible = true };
        var menu = new ContextMenuStrip();
        menu.Items.Add("Mở Tiemvio POS", null, (_, _) => Program.OpenApp());
        menu.Items.Add("Kiểm tra cập nhật", null, async (_, _) => await Check());
        menu.Items.Add("Thoát trình cập nhật", null, (_, _) => ExitThread());
        tray.ContextMenuStrip = menu; tray.DoubleClick += (_, _) => Program.OpenApp();
        timer.Tick += async (_, _) => await Check(); timer.Start();
        stopTimer.Tick += (_, _) => { if (stop.WaitOne(0)) ExitThread(); }; stopTimer.Start();
        // Begin after the WinForms message loop is running.
        var first = new System.Windows.Forms.Timer { Interval = 3000 };
        first.Tick += async (_, _) => { first.Stop(); first.Dispose(); await Check(); }; first.Start();
    }
    async Task Check() {
        if (checking) return; checking = true;
        string? temp = null;
        try {
            byte[] data = await Fetch(Feed + "native-update.json", 65536);
            byte[] signature = await Fetch(Feed + "native-update.sig", 2048);
            using var key = RSA.Create();
            using var resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("update-public.pem")!;
            using var reader = new StreamReader(resource);
            key.ImportFromPem(await reader.ReadToEndAsync());
            using var json = UpdateTrust.Verify(data, Convert.FromBase64String(Encoding.UTF8.GetString(signature)), key);
            var root = json.RootElement;
            if (root.GetProperty("schema").GetInt32() != 1) throw new InvalidDataException("Unknown feed");
            var remote = Version.Parse(root.GetProperty("version").GetString()!);
            var local = Assembly.GetExecutingAssembly().GetName().Version!;
            if (remote <= local) return;
            var update = root.GetProperty("windows");
            var url = new Uri(update.GetProperty("url").GetString()!);
            if (url.Scheme != "https" || url.Host != "github.com" || !url.AbsolutePath.StartsWith("/YOUR_GITHUB_OWNER/RELEASES_REPO/releases/download/", StringComparison.Ordinal)) throw new InvalidDataException("Invalid download source");
            var hash = update.GetProperty("sha256").GetString()!;
            if (hash.Length != 64) throw new InvalidDataException("Invalid hash");
            Notify("Có bản Tiemvio POS mới", "Đang tải bản " + remote + ". Bạn có thể tiếp tục bán hàng.");
            var bytes = await Fetch(url.ToString(), 150 * 1024 * 1024);
            if (!Convert.ToHexString(SHA256.HashData(bytes)).Equals(hash, StringComparison.OrdinalIgnoreCase)) throw new CryptographicException("Installer hash mismatch");
            // A new random directory prevents another unprivileged process from precreating a shared installer path.
            temp = Path.Combine(Path.GetTempPath(), "TiemvioPOS-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(temp);
            var installer = Path.Combine(temp, "Tiemvio-POS-Windows.exe");
            await File.WriteAllBytesAsync(installer, bytes);
            Notify("Đã tải bản cập nhật", "Tiemvio POS đang cập nhật bộ cài. Cửa sổ bán hàng vẫn tiếp tục hoạt động.");
            Process.Start(new ProcessStartInfo(installer, "/S") { UseShellExecute = false, WorkingDirectory = temp });
            temp = null; // Do not remove the installer while it is executing.
            ExitThread();
        } catch (Exception e) {
            try {
                var logs = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TiemvioPOS");
                Directory.CreateDirectory(logs);
                File.WriteAllText(Path.Combine(logs, "update.log"), DateTimeOffset.UtcNow + " " + e.GetType().Name + ": " + e.Message);
            } catch { }
        } finally { checking = false; if (temp != null) try { Directory.Delete(temp, true); } catch { } }
    }
    async Task<byte[]> Fetch(string url, int max) {
        using var response = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
        response.EnsureSuccessStatusCode();
        if (response.Content.Headers.ContentLength > max) throw new InvalidDataException("Update too large");
        using var stream = await response.Content.ReadAsStreamAsync();
        using var output = new MemoryStream(); byte[] buffer = new byte[65536]; int n;
        while ((n = await stream.ReadAsync(buffer)) > 0) { if (output.Length + n > max) throw new InvalidDataException("Update too large"); output.Write(buffer, 0, n); }
        return output.ToArray();
    }
    void Notify(string title, string message) { tray.ShowBalloonTip(5000, title, message, ToolTipIcon.Info); }
    protected override void ExitThreadCore() { timer.Stop(); timer.Dispose(); stopTimer.Stop(); stopTimer.Dispose(); stop.Dispose(); tray.Visible = false; tray.Dispose(); http.Dispose(); base.ExitThreadCore(); }
}
