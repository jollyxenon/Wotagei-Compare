/**
 * 启动期崩溃诊断覆盖层（在 React bundle 之前以普通 script 标签同步加载）
 * 独立文件而非 index.html 内联脚本，使 CSP 可对 script-src 收紧为 'self'
 * 而无需 unsafe-inline。保持 ES5 兼容以服务老旧 Android WebView。
 */
(function () {
  function showError(title, detail) {
    var box = document.getElementById('wotagei-crash-overlay');
    if (!box) {
      box = document.createElement('div');
      box.id = 'wotagei-crash-overlay';
      box.style.cssText =
        'position:fixed;top:0;left:0;width:100vw;height:100vh;background:#09090b;color:#f87171;padding:24px;font-family:monospace;font-size:12px;z-index:999999;overflow:auto;box-sizing:border-box;white-space:pre-wrap;line-height:1.5;';
      var h = document.createElement('div');
      h.style.cssText =
        'font-size:16px;font-weight:bold;color:#ef4444;margin-bottom:8px;border-bottom:1px solid #27272a;padding-bottom:8px;';
      h.textContent = '⚠️ Wotagei-Compare 运行时启动诊断';
      box.appendChild(h);
      var tip = document.createElement('div');
      tip.style.cssText = 'color:#a1a1aa;margin-bottom:12px;font-size:11px;';
      tip.textContent = '捕获到未处理的致命异常，请截屏此界面以便定位排查：';
      box.appendChild(tip);
      if (document.body) {
        document.body.appendChild(box);
      } else {
        document.addEventListener('DOMContentLoaded', function () {
          document.body.appendChild(box);
        });
      }
    }
    var item = document.createElement('pre');
    item.style.cssText =
      'background:#18181b;color:#f4f4f5;padding:12px;border-radius:4px;border:1px solid #3f3f46;overflow-x:auto;margin-bottom:12px;font-family:inherit;';
    item.textContent = '[' + title + ']\n' + detail;
    box.appendChild(item);
  }

  window.addEventListener('error', function (e) {
    var detail = e.error && e.error.stack ? e.error.stack : e.message || String(e);
    var src = e.filename ? '\n来源: ' + e.filename + ':' + e.lineno + ':' + e.colno : '';
    showError('Uncaught Error', detail + src);
  });

  window.addEventListener('unhandledrejection', function (e) {
    var reason = e.reason;
    var detail = reason && reason.stack ? reason.stack : String(reason);
    showError('Unhandled Promise Rejection', detail);
  });
})();
