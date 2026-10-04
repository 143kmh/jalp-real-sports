using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Text.RegularExpressions;
using System.Windows.Forms;

// Compiled as a Windows GUI executable: no terminal and no administrator rights.
internal static class Launcher
{
    private static readonly string Root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
    private static int Port = 5127;
    private static string Url { get { return "http://127.0.0.1:" + Port + "/"; } }

    [STAThread]
    private static int Main(string[] args)
    {
        bool noUi = Array.IndexOf(args, "--no-ui") >= 0;
        try
        {
            string portSetting = Environment.GetEnvironmentVariable("REAL_MANAGER_PORT");
            if (!String.IsNullOrEmpty(portSetting) && (!Int32.TryParse(portSetting, out Port) || Port < 1024 || Port > 65535))
                throw new Exception("REAL_MANAGER_PORT должен быть числом от 1024 до 65535.");
            if (!File.Exists(Path.Combine(Root, "server.mjs")))
                throw new Exception("Рядом с Real Manager.exe нет файлов приложения. Распакуйте весь ZIP в отдельную папку, а не только .exe.");
            string chrome = noUi ? null : FindChrome();
            if (!noUi && chrome == null)
                throw new Exception("Не найден Google Chrome. Установите его для панели и служебного браузера Real.");
            using (var mutex = new Mutex(false, "Local\\RealManagerLauncher-" + Port))
            {
                bool acquired = false;
                try
                {
                    try { acquired = mutex.WaitOne(30000); }
                    catch (AbandonedMutexException) { acquired = true; }
                    if (!acquired) throw new Exception("Другой запуск ещё выполняется. Подождите и повторите.");
                    EnsureServer();
                    if (!noUi)
                    {
                        var panel = new ProcessStartInfo(chrome,
                            "--user-data-dir=" + Quote(Path.Combine(Root, "data", "panel-profile")) +
                            " --app=" + Url + " --no-first-run --no-default-browser-check");
                        panel.UseShellExecute = false;
                        Process.Start(panel);
                    }
                }
                finally { if (acquired) mutex.ReleaseMutex(); }
            }
            return 0;
        }
        catch (Exception error)
        {
            try
            {
                Directory.CreateDirectory(Path.Combine(Root, "data"));
                File.AppendAllText(Path.Combine(Root, "data", "launcher-error.log"),
                    DateTime.Now.ToString("s") + " " + error.Message + Environment.NewLine, Encoding.UTF8);
            }
            catch { }
            if (!noUi) MessageBox.Show(error.Message, "Real Manager · ошибка запуска", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static void EnsureServer()
    {
        if (Ready()) return;
        string node = FindNode();
        if (node == null) throw new Exception("Не найден Node.js. Используйте полную portable-сборку с папкой runtime либо установите Node.js 22.12+.");
        var starter = new ProcessStartInfo(node, Quote(Path.Combine(Root, "launcher-server.mjs")));
        starter.WorkingDirectory = Root;
        starter.UseShellExecute = false;
        starter.CreateNoWindow = true;
        starter.WindowStyle = ProcessWindowStyle.Hidden;
        using (var process = Process.Start(starter))
        {
            if (!process.WaitForExit(10000)) throw new Exception("Запуск сервера задержался. Проверьте data\\startup-error.log.");
            if (process.ExitCode != 0) throw new Exception("Не удалось запустить сервер. Проверьте data\\startup-error.log.");
        }
        var clock = Stopwatch.StartNew();
        while (clock.ElapsedMilliseconds < 30000)
        {
            if (Ready()) return;
            Thread.Sleep(150);
        }
        throw new Exception("Панель не запустилась за 30 секунд. Проверьте data\\startup-error.log; возможно, порт занят другой программой.");
    }

    private static bool Ready()
    {
        string body;
        try
        {
            var request = (HttpWebRequest)WebRequest.Create(Url + "health");
            request.Timeout = 800;
            request.ReadWriteTimeout = 800;
            request.Proxy = null;
            request.AllowAutoRedirect = false;
            using (var response = (HttpWebResponse)request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream())) body = reader.ReadToEnd();
        }
        catch (WebException error)
        {
            var response = error.Response as HttpWebResponse;
            if (response != null) { response.Close(); throw new Exception("Порт " + Port + " занят другой программой или старой версией Real Manager. Завершите её перед запуском."); }
            return false;
        }
        if (body.IndexOf("\"app\":\"real-manager\"", StringComparison.Ordinal) < 0 ||
            body.IndexOf("\"root\":\"" + RootHash() + "\"", StringComparison.Ordinal) < 0)
            throw new Exception("На порту " + Port + " запущена другая копия приложения. Завершите её в разделе «Приложение» или используйте прежнюю папку.");
        string expected = ExpectedVersion();
        var runningMatch = Regex.Match(body, "\\\"version\\\":\\\"([^\\\"]+)\\\"");
        string running = runningMatch.Success ? runningMatch.Groups[1].Value : null;
        if (!String.IsNullOrEmpty(expected) && !String.Equals(expected, running, StringComparison.Ordinal))
            throw new Exception("Файлы обновлены до v" + expected + ", но backend всё ещё работает как v" + (running ?? "?") + ". Полностью завершите старый Real Manager и запустите снова.");
        return true;
    }

    private static string ExpectedVersion()
    {
        try
        {
            string json = File.ReadAllText(Path.Combine(Root, "package.json"), Encoding.UTF8);
            var match = Regex.Match(json, "\\\"version\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"");
            return match.Success ? match.Groups[1].Value : null;
        }
        catch { return null; }
    }

    private static string RootHash()
    {
        using (var sha = SHA256.Create())
            return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(Root.ToLowerInvariant()))).Replace("-", "").ToLowerInvariant();
    }
    private static string Quote(string value) { return "\"" + value + "\""; }
    private static string FindNode()
    {
        string bundled = Path.Combine(Root, "runtime", "node.exe");
        if (File.Exists(bundled)) return bundled;
        foreach (var baseDir in new[] { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86) })
        {
            string candidate = Path.Combine(baseDir, "nodejs", "node.exe");
            if (File.Exists(candidate)) return candidate;
        }
        foreach (string directory in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
        {
            try { string candidate = Path.Combine(directory.Trim('"'), "node.exe"); if (File.Exists(candidate)) return candidate; }
            catch (ArgumentException) { }
        }
        return null;
    }
    private static string FindChrome()
    {
        foreach (var baseDir in new[] { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) })
        {
            string candidate = Path.Combine(baseDir, "Google", "Chrome", "Application", "chrome.exe");
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }
}
