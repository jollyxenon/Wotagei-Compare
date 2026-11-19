# Wotagei-Compare Windows 桌面工作台一键启动器
# 职责：启动本地静态 HTTP 服务，在系统默认浏览器新标签页打开工作台，并在页面全部关闭后自动清理退出

$ErrorActionPreference = 'Stop'

# 弹出图形化错误提示框（由于启动器隐藏控制台运行，异常时需可见提示）
function Show-ErrorBox([string]$Message) {
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
    [System.Windows.Forms.MessageBox]::Show(
      $Message,
      'Wotagei-Compare 启动失败',
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
  } catch {
    Write-Error $Message
  }
}

# 根据文件扩展名返回对应的 HTTP Content-Type
function Get-MimeType([string]$FilePath) {
  $ext = [System.IO.Path]::GetExtension($FilePath).ToLowerInvariant()
  switch ($ext) {
    '.html' { return 'text/html; charset=utf-8' }
    '.js'   { return 'application/javascript; charset=utf-8' }
    '.mjs'  { return 'application/javascript; charset=utf-8' }
    '.css'  { return 'text/css; charset=utf-8' }
    '.svg'  { return 'image/svg+xml' }
    '.png'  { return 'image/png' }
    '.jpg'  { return 'image/jpeg' }
    '.jpeg' { return 'image/jpeg' }
    '.webp' { return 'image/webp' }
    '.json' { return 'application/json; charset=utf-8' }
    '.ico'  { return 'image/x-icon' }
    '.woff2'{ return 'font/woff2' }
    default { return 'application/octet-stream' }
  }
}

# 在指定端口区间内选取可用端口并启动 HttpListener
function Start-StaticHttpListener([int]$StartPort, [int]$EndPort) {
  for ($p = $StartPort; $p -le $EndPort; $p++) {
    $l = New-Object System.Net.HttpListener
    $l.Prefixes.Add("http://127.0.0.1:$p/")
    try {
      $l.Start()
      return @{ Listener = $l; Port = $p }
    } catch {
      try { $l.Close() } catch {}
    }
  }

  # 若固定区间均被占用，向系统申请临时空闲端口
  $tcp = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
  $tcp.Start()
  $freePort = ([System.Net.IPEndPoint]$tcp.LocalEndpoint).Port
  $tcp.Stop()

  $fallbackListener = New-Object System.Net.HttpListener
  $fallbackListener.Prefixes.Add("http://127.0.0.1:$freePort/")
  $fallbackListener.Start()
  return @{ Listener = $fallbackListener; Port = $freePort }
}

# 检测已有本地服务是否仍在运行且指向当前工作台目录
function Test-ExistingServer([string]$PortFile, [string]$DistDir) {
  if (-not (Test-Path -LiteralPath $PortFile)) {
    return $null
  }
  try {
    $rawPort = (Get-Content -LiteralPath $PortFile -Raw -ErrorAction Stop).Trim()
    $existingPort = [int]$rawPort
    if ($existingPort -le 0) { return $null }
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$existingPort/__wotagei_ping" -UseBasicParsing -TimeoutSec 1
    if ($resp.StatusCode -eq 200 -and $resp.Content.Trim() -eq $DistDir) {
      return $existingPort
    }
  } catch {
    # 端口文件已过期，忽略并重新起服务
  }
  return $null
}

# 向客户端写入字节响应并安全关闭输出流
function Send-BytesResponse($Response, [int]$StatusCode, [string]$ContentType, [byte[]]$Bytes) {
  try {
    $Response.StatusCode = $StatusCode
    $Response.ContentType = $ContentType
    $Response.Headers.Add('Cache-Control', 'no-cache')
    $Response.ContentLength64 = $Bytes.Length
    if ($Bytes.Length -gt 0) {
      $Response.OutputStream.Write($Bytes, 0, $Bytes.Length)
    }
  } catch {
    # 浏览器提前取消请求时忽略传输异常
  } finally {
    try { $Response.OutputStream.Close() } catch {}
  }
}

# 构造注入到 index.html 中的极简标签页心跳脚本（用于感知浏览器标签页何时全部关闭）
$script:LifecycleSnippet = @'
<script>
(function () {
  var tabId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  function beat() {
    fetch('/__wotagei_hb?tab=' + encodeURIComponent(tabId), { cache: 'no-store' }).catch(function () {});
  }
  function bye() {
    var url = '/__wotagei_bye?tab=' + encodeURIComponent(tabId);
    if (navigator.sendBeacon) {
      navigator.sendBeacon(url, '');
    } else {
      fetch(url, { method: 'POST', keepalive: true }).catch(function () {});
    }
  }
  beat();
  setInterval(beat, 15000);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') beat();
  });
  window.addEventListener('pagehide', bye);
})();
</script>
'@

# 向 index.html 末尾注入标签页生命周期脚本，保持源码 dist/ 洁净不变
function Inject-LifecycleHtml([byte[]]$RawHtmlBytes) {
  $html = [System.Text.Encoding]::UTF8.GetString($RawHtmlBytes)
  if ($html.Contains('</body>')) {
    $html = $html.Replace('</body>', $script:LifecycleSnippet + "`n</body>")
  } else {
    $html = $html + $script:LifecycleSnippet
  }
  return [System.Text.Encoding]::UTF8.GetBytes($html)
}

# 解析查询参数中的 tab 值
function Get-TabParam($Request) {
  $tab = $Request.QueryString['tab']
  if ([string]::IsNullOrWhiteSpace($tab)) { return 'default' }
  return $tab
}

# 判断请求是否来自跨站页面：现代浏览器对所有 fetch/sendBeacon 均携带
# Sec-Fetch-Site 头（same-origin / same-site / cross-site）。
# 该头缺失（如本启动器自身的 Invoke-WebRequest、老浏览器）时放行；
# 显式标记为 cross-site 的控制端点请求一律拒绝，防止任意网页伪造
# 心跳/下线信号杀掉本地服务。
function Test-CrossSiteRequest($Request) {
  $secFetchSite = $Request.Headers['Sec-Fetch-Site']
  if ($null -ne $secFetchSite -and $secFetchSite -eq 'cross-site') {
    return $true
  }
  return $false
}

# 处理单次 HTTP 请求并维护活跃标签页状态表
function Handle-Request($Context, [string]$DistDir, [string]$IndexPath, [hashtable]$Tabs, [ref]$HasEverHadTab, [ref]$EmptySinceUtc) {
  $req = $Context.Request
  $resp = $Context.Response
  $rawPath = $req.Url.AbsolutePath

  if ($rawPath -eq '/__wotagei_ping') {
    $pingBytes = [System.Text.Encoding]::UTF8.GetBytes($DistDir)
    Send-BytesResponse $resp 200 'text/plain; charset=utf-8' $pingBytes
    return
  }

  if ($rawPath -eq '/__wotagei_hb') {
    if (Test-CrossSiteRequest $req) {
      Send-BytesResponse $resp 403 'text/plain; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes('Forbidden'))
      return
    }
    $tabId = Get-TabParam $req
    $Tabs[$tabId] = [DateTime]::UtcNow
    $HasEverHadTab.Value = $true
    $EmptySinceUtc.Value = $null
    Send-BytesResponse $resp 204 'text/plain; charset=utf-8' ([byte[]]@())
    return
  }

  if ($rawPath -eq '/__wotagei_bye') {
    if (Test-CrossSiteRequest $req) {
      Send-BytesResponse $resp 403 'text/plain; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes('Forbidden'))
      return
    }
    $tabId = Get-TabParam $req
    $Tabs.Remove($tabId) | Out-Null
    if ($HasEverHadTab.Value -and $Tabs.Count -eq 0 -and $null -eq $EmptySinceUtc.Value) {
      $EmptySinceUtc.Value = [DateTime]::UtcNow
    }
    Send-BytesResponse $resp 204 'text/plain; charset=utf-8' ([byte[]]@())
    return
  }

  $decodedPath = [System.Uri]::UnescapeDataString($rawPath).TrimStart('/')
  if ([string]::IsNullOrWhiteSpace($decodedPath)) {
    $decodedPath = 'index.html'
  }

  # 防止路径穿越离开 dist 根目录
  # 前缀比较必须以目录分隔符结尾：否则 "C:\x\dist-backup\..." 这类同前缀
  # 兄弟目录会绕过 StartsWith 检查
  $relativePath = $decodedPath.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
  $fullDistRoot = [System.IO.Path]::GetFullPath($DistDir).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  $targetPath = [System.IO.Path]::GetFullPath((Join-Path $fullDistRoot $relativePath))

  if (-not $targetPath.StartsWith($fullDistRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    $forbidden = [System.Text.Encoding]::UTF8.GetBytes('Forbidden')
    Send-BytesResponse $resp 403 'text/plain; charset=utf-8' $forbidden
    return
  }

  if (-not (Test-Path -LiteralPath $targetPath -PathType Leaf)) {
    if ([string]::IsNullOrEmpty([System.IO.Path]::GetExtension($targetPath))) {
      $targetPath = $IndexPath
    } else {
      $notFound = [System.Text.Encoding]::UTF8.GetBytes('Not Found')
      Send-BytesResponse $resp 404 'text/plain; charset=utf-8' $notFound
      return
    }
  }

  $fileBytes = [System.IO.File]::ReadAllBytes($targetPath)
  $fullIndexPath = [System.IO.Path]::GetFullPath($IndexPath)
  if ([string]::Equals($targetPath, $fullIndexPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    $fileBytes = Inject-LifecycleHtml $fileBytes
  }
  $mime = Get-MimeType $targetPath
  Send-BytesResponse $resp 200 $mime $fileBytes
}

try {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  $distDir = Join-Path $scriptDir 'dist'
  $indexPath = Join-Path $distDir 'index.html'

  if (-not (Test-Path -LiteralPath $indexPath -PathType Leaf)) {
    Show-ErrorBox "未找到前端构建产物：`n$indexPath`n`n请确认压缩包已完整解压后再双击启动。"
    exit 1
  }

  $stateDir = Join-Path $env:LOCALAPPDATA 'Wotagei-Compare-Desktop'
  if (-not (Test-Path -LiteralPath $stateDir)) {
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
  }
  $portFile = Join-Path $stateDir 'server.port'

  # 若当前工作台服务已经在运行，直接用默认浏览器新开标签页并退出
  $existingPort = Test-ExistingServer $portFile $distDir
  if ($null -ne $existingPort) {
    Start-Process "http://127.0.0.1:$existingPort/"
    exit 0
  }

  $server = Start-StaticHttpListener 41730 41749
  $listener = $server.Listener
  $port = $server.Port
  $url = "http://127.0.0.1:$port/"

  [System.IO.File]::WriteAllText($portFile, "$port", [System.Text.Encoding]::ASCII)

  $tabs = @{}
  $hasEverHadTab = $false
  $emptySinceUtc = $null
  $startedUtc = [DateTime]::UtcNow

  try {
    # 使用系统默认浏览器打开常规网页标签页
    Start-Process $url

    $contextTask = $null
    while ($listener.IsListening) {
      if ($null -eq $contextTask) {
        $contextTask = $listener.GetContextAsync()
      }

      if ($contextTask.Wait(400)) {
        $ctx = $contextTask.Result
        $contextTask = $null
        Handle-Request $ctx $distDir $indexPath $tabs ([ref]$hasEverHadTab) ([ref]$emptySinceUtc)
      }

      $now = [DateTime]::UtcNow

      # 清理超过 180 秒无心跳的失效标签页（应对浏览器意外崩溃且后台节流不超过 60 秒）
      $staleIds = @()
      foreach ($entry in $tabs.GetEnumerator()) {
        if (($now - $entry.Value).TotalSeconds -gt 180) {
          $staleIds += $entry.Key
        }
      }
      foreach ($sid in $staleIds) {
        $tabs.Remove($sid) | Out-Null
      }
      if ($hasEverHadTab -and $tabs.Count -eq 0 -and $null -eq $emptySinceUtc) {
        $emptySinceUtc = $now
      }

      # 全部标签页关闭且超过 3 秒宽限期（避开 F5 刷新误关）后自动停止本地服务
      if ($hasEverHadTab -and $tabs.Count -eq 0 -and $null -ne $emptySinceUtc) {
        if (($now - $emptySinceUtc).TotalSeconds -ge 3) {
          break
        }
      }

      # 若启动后 30 秒仍未有浏览器标签页连入，自动清理退出
      if (-not $hasEverHadTab -and ($now - $startedUtc).TotalSeconds -ge 30) {
        break
      }
    }
  } finally {
    try { $listener.Stop() } catch {}
    try { $listener.Close() } catch {}
    Remove-Item -LiteralPath $portFile -ErrorAction SilentlyContinue
  }
} catch {
  Show-ErrorBox ("启动本地工作台时发生错误：`n" + $_.Exception.Message)
  exit 1
}
