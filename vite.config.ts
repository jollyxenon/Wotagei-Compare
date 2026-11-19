import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8')
) as { version?: string };

/**
 * 生产构建专用 CSP 注入插件。
 * 只在 build 时向 <head> 注入 Content-Security-Policy：
 * - script-src 'self'：全库无内联脚本与 eval（启动诊断脚本已外置为 /boot-diagnostics.js）
 * - style-src 保留 unsafe-inline：组件大量使用内联样式属性
 * - media/connect 放行本机流式代理（127.0.0.1/localhost 任意端口）与 blob 源，
 *   connect 另放行 GitHub Releases 更新检查
 * 不在 dev 注入的原因：@vitejs/plugin-react 的 dev 模式依赖内联 preamble 脚本，
 * 静态 CSP 会将其拦截导致热更新不可用。
 */
function cspInjectPlugin(): Plugin {
  const cspContent =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; " +
    "media-src 'self' blob: http://127.0.0.1:* http://localhost:*; " +
    "connect-src 'self' blob: data: http://127.0.0.1:* http://localhost:* https://api.github.com; " +
    "font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'";

  return {
    name: 'wotagei-csp-inject',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<meta name="viewport"',
        `<meta http-equiv="Content-Security-Policy" content="${cspContent}" />\n    <meta name="viewport"`
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), cspInjectPlugin()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version || '1.0.0'),
  },
  server: {
    host: true,
    port: 5173,
    watch: {
      usePolling: true,
      interval: 100,
    },
  },
  build: {
    target: 'es2018',
  },
});
