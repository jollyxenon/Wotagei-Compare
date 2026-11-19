import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.wotagei.compare',
  appName: 'Wotagei-Compare',
  webDir: 'dist',
  server: {
    // 页面源使用 http://localhost（而非默认 https）：
    // 本应用的唯一远程子资源是本地 http://127.0.0.1 流式视频/PCM 代理，
    // 同为 http 源即可避免任何混合内容，从而无需在 WebView 全局放行
    // MIXED_CONTENT_ALWAYS_ALLOW。应用完全离线、不加载任何公网页面，
    // 降为 http 不会引入实际风险。副作用：WebView 存储源改变，
    // 升级安装后用户需重新设置默认偏好（仅影响 localStorage 偏好项）。
    androidScheme: 'http',
  },
  plugins: {
    ScreenOrientation: {
      // 默认屏幕方向偏好
    },
  },
};

export default config;
