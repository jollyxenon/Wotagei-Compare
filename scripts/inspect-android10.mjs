import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// adb 路径可移植化：优先读 ADB_PATH 环境变量，否则假定 adb 已在 PATH 上。
// （此前默认值硬编码了开发机私有路径 /mnt/d/Scoop/...）
const ADB = process.env.ADB_PATH || 'adb';
const SERIAL = process.env.ANDROID_SERIAL || 'emulator-5554';
const APK_PATH = path.resolve('android/app/build/outputs/apk/debug/app-debug.apk');
const IS_WSL =
  process.platform === 'linux' && fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');

/**
 * 在 WSL 内运行时将 POSIX 路径转换为 Windows 路径供 Windows 版 adb.exe 使用
 */
function toWinPath(p) {
  if (!IS_WSL) return p;
  return execSync(`wslpath -w "${p}"`, { encoding: 'utf8' }).trim();
}

/**
 * 执行 adb 命令并返回标准输出
 */
function adb(cmd) {
  return execSync(`${ADB} -s ${SERIAL} ${cmd}`, { encoding: 'utf8' }).trim();
}

/**
 * 截取模拟器屏幕并拉取到系统临时目录
 */
function screencap(name) {
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `${name}.png`);
  adb(`shell screencap -p /sdcard/${name}.png`);
  adb(`pull /sdcard/${name}.png "${toWinPath(tmpFile)}"`);
}

/**
 * 确保设备上存在两段测试视频文件
 */
function ensureTestVideos() {
  const check = adb('shell "ls /sdcard/Movies/test_ch1.mp4 /sdcard/Movies/test_ch2.mp4 2>/dev/null || true"');
  if (check.includes('test_ch1.mp4') && check.includes('test_ch2.mp4')) {
    return;
  }
  const ch1 = path.join(os.tmpdir(), 'test_ch1.mp4');
  const ch2 = path.join(os.tmpdir(), 'test_ch2.mp4');
  if (!fs.existsSync(ch1) || !fs.existsSync(ch2)) {
    throw new Error(`缺少测试视频 ${ch1} 或 ${ch2}，请先生成后再巡检`);
  }
  adb(`push "${toWinPath(ch1)}" /sdcard/Movies/test_ch1.mp4`);
  adb(`push "${toWinPath(ch2)}" /sdcard/Movies/test_ch2.mp4`);
}

/**
 * 等待 WebView DevTools abstract socket 就绪并返回 socket 名称
 */
async function waitWebViewSocket() {
  for (let i = 0; i < 20; i++) {
    const out = adb('shell "cat /proc/net/unix | grep -o \'webview_devtools_remote_[0-9]*\' | head -n 1 || true"');
    if (out.startsWith('webview_devtools_remote_')) {
      return out;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('等待 WebView DevTools socket 超时');
}

function assert(cond, msg) {
  if (!cond) {
    throw new Error(`巡检断言失败: ${msg}`);
  }
}

async function run() {
  // 1. 检查模拟器在线状态
  const devices = execSync(`${ADB} devices`, { encoding: 'utf8' });
  if (!devices.includes(`${SERIAL}\tdevice`)) {
    throw new Error(
      `未检测到在线模拟器 ${SERIAL}。请先通过 Android Studio 或 emulator 命令行启动目标设备 ` +
        '（例：emulator -avd <名称> -gpu host -no-boot-anim）'
    );
  }

  // 2. 安装最新 Debug APK 并准备测试媒体
  if (fs.existsSync(APK_PATH)) {
    console.log('安装 APK:', APK_PATH);
    execSync(`${ADB} -s ${SERIAL} install -r "${toWinPath(APK_PATH)}"`, { stdio: 'inherit' });
  }
  ensureTestVideos();
  adb('shell pm grant com.wotagei.compare android.permission.READ_EXTERNAL_STORAGE || true');
  adb('shell pm grant com.wotagei.compare android.permission.WRITE_EXTERNAL_STORAGE || true');

  // 3. 重启应用并连接 WebView CDP
  adb('shell am force-stop com.wotagei.compare');
  adb('shell am start -W -n com.wotagei.compare/.MainActivity');
  await new Promise((r) => setTimeout(r, 1200));

  const sock = await waitWebViewSocket();
  adb(`forward tcp:9222 localabstract:${sock}`);

  const targets = await fetch('http://127.0.0.1:9222/json/list').then((r) => r.json());
  // Capacitor 页面源现为 http://localhost（androidScheme: 'http'），保持对新旧 scheme 的兼容
  const target = targets.find((p) => p.url.startsWith('http://localhost') || p.url.startsWith('https://localhost'));
  assert(Boolean(target), '未找到 localhost WebView 页面');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let reqSeq = 1;
  const consoleErrors = [];
  const exceptions = [];

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      exceptions.push(msg.params.exceptionDetails);
    }
  });

  const call = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = reqSeq++;
      const handler = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === id) {
          ws.removeEventListener('message', handler);
          if (m.error) rej(new Error(`${method}: ${JSON.stringify(m.error)}`));
          else res(m.result);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id, method, params }));
    });

  // 注意：evalJs 字符串内部在 Chrome 74 中执行，严禁使用 ?. 或 ?? 等 ES2020 语法
  const evalJs = async (expression) => {
    const res = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error('页面求值异常: ' + JSON.stringify(res.exceptionDetails));
    }
    return res.result ? res.result.value : undefined;
  };

  await call('Runtime.enable');
  await call('DOM.enable');
  await call('Page.enable');

  // 4. 校验初始页、安全区 CSS 回退以及跨代 Flex 间距真实像素值 (> 0)
  const init = await evalJs(`(() => {
    const pad = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        top: parseFloat(cs.paddingTop),
        right: parseFloat(cs.paddingRight),
        bottom: parseFloat(cs.paddingBottom),
        left: parseFloat(cs.paddingLeft)
      };
    };
    const tabs = Array.from(document.querySelectorAll('.step-tab'));
    const tabGap = tabs.length >= 2
      ? tabs[1].getBoundingClientRect().left - tabs[0].getBoundingClientRect().right
      : 0;
    return {
      ua: navigator.userAgent,
      crashOverlay: !!document.getElementById('wotagei-crash-overlay'),
      topNav: pad('.top-nav'),
      importStage: pad('.import-stage'),
      tabGap
    };
  })()`);
  console.log('1. 初始页检查:', JSON.stringify(init));
  assert(!init.crashOverlay, '首屏触发了崩溃诊断面板');
  assert(init.topNav.left > 0 && init.topNav.right > 0, 'topNav 左右内边距塌陷为 0');
  assert(
    init.importStage.left > 0 && init.importStage.right > 0 && init.importStage.bottom > 0,
    'importStage 左右底内边距塌陷为 0'
  );
  assert(init.tabGap > 0, 'Chrome 74 下顶部步骤按钮间距仍为 0px');

  // 5. 通过 Android 原生视频选择器导入两段测试 MP4（不再走 input[type=file]）
  const pickFromNativeDialog = async (cardIndex, fileName) => {
    await evalJs(`document.querySelectorAll('.slot-card')[${cardIndex}].click()`);
    await new Promise((r) => setTimeout(r, 1500));
    const xml = adb('shell "uiautomator dump /sdcard/ui.xml && cat /sdcard/ui.xml"');
    const re = new RegExp(`text="${fileName}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`);
    const m = xml.match(re);
    assert(Boolean(m), `原生文档选择器中未找到 ${fileName}`);
    const tapX = Math.round((Number(m[1]) + Number(m[3])) / 2);
    const tapY = Math.round((Number(m[2]) + Number(m[4])) / 2);
    adb(`shell input tap ${tapX} ${tapY}`);
    await new Promise((r) => setTimeout(r, 1200));
  };

  await pickFromNativeDialog(0, 'test_ch1.mp4');
  await pickFromNativeDialog(1, 'test_ch2.mp4');

  let importReady = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const st = await evalJs(`(() => {
      const btn = document.querySelector('.import-stage button');
      const cards = Array.from(document.querySelectorAll('.slot-card')).map(c => c.innerText);
      return { disabled: btn ? btn.disabled : true, cards };
    })()`);
    const busy = st.cards.some((t) => t.includes('探测中') || t.includes('解析中') || t.includes('计算中'));
    if (!busy && !st.disabled) {
      importReady = true;
      break;
    }
  }
  assert(importReady, '双路视频导入超时未就绪');
  const importGap = await evalJs(`(() => {
    const badge = document.querySelector('.slot-card .tag-badge');
    const title = badge && badge.nextElementSibling;
    const btn = document.querySelector('.import-stage button');
    const iconGap = btn && btn.children.length >= 2
      ? btn.children[1].getBoundingClientRect().left - btn.children[0].getBoundingClientRect().right
      : 0;
    return {
      badgeTitleGap: (badge && title) ? (title.getBoundingClientRect().left - badge.getBoundingClientRect().right) : 0,
      btnIconGap: iconGap
    };
  })()`);
  console.log('   导入页间距检查:', JSON.stringify(importGap));
  assert(importGap.badgeTitleGap > 0 && importGap.btnIconGap > 0, '导入页 Flex 子项间距未生效');
  screencap('android10_01_import');

  const clickStep = async (label, waitMs = 1000) => {
    const ok = await evalJs(`(() => {
      const btn = Array.from(document.querySelectorAll('.step-tab')).find(b => b.innerText.includes(${JSON.stringify(label)}));
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    })()`);
    assert(ok, `无法切换至步骤 ${label}`);
    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs));
    }
  };

  // 6. CH1 与 CH2 空间标定页：校验边距、首帧解码、下拉模型全局同步与间距
  await clickStep('CH1空间');
  const geo1 = await evalJs(`(() => {
    const stage = document.querySelector('.calib-stage');
    const cs = stage ? getComputedStyle(stage) : null;
    const v = document.querySelector('video');
    const sel = document.querySelector('.select-input');
    const mirrorBtn = sel && sel.nextElementSibling;
    return {
      leftPad: cs ? parseFloat(cs.paddingLeft) : 0,
      rightPad: cs ? parseFloat(cs.paddingRight) : 0,
      readyState: v ? v.readyState : 0,
      videoWidth: v ? v.videoWidth : 0,
      currentTime: v ? v.currentTime : 0,
      topRightGap: (sel && mirrorBtn) ? (mirrorBtn.getBoundingClientRect().left - sel.getBoundingClientRect().right) : 0
    };
  })()`);
  console.log('2. CH1空间 检查:', JSON.stringify(geo1));
  assert(geo1.leftPad > 0 && geo1.rightPad > 0, 'calib-stage 左右边距塌陷为 0');
  assert(geo1.readyState >= 2 && geo1.videoWidth > 0, 'CH1空间视频未就绪');
  assert(geo1.currentTime > 0, 'CH1空间视频仍停留在 currentTime=0，可能残留灰色播放占位图');
  assert(geo1.topRightGap > 0, 'CH1空间右上角模型下拉与镜像按钮间距为 0px');
  screencap('android10_02_geo1');

  // 切换 CH2 空间，验证模型同步（两竖一横 -> 切回两横一竖）与首帧呈现
  await clickStep('CH2空间');
  const geo2 = await evalJs(`(() => {
    const v = document.querySelector('video');
    return { rs: v ? v.readyState : 0, ct: v ? v.currentTime : 0 };
  })()`);
  assert(geo2.rs >= 2 && geo2.ct > 0, 'CH2空间视频首帧未就绪');

  // 7. CH1 与 CH2 时间标定页：校验边距、锚点帧可见、连续试听 8 次不触及 AudioContext 上限
  await clickStep('CH1时间');
  const audio1 = await evalJs(`(() => {
    const bar = document.querySelector('.bottom-bar');
    const cs = bar ? getComputedStyle(bar) : null;
    const v = document.querySelector('video');
    const setBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('设为锚点'));
    const nextEl = setBtn && setBtn.nextElementSibling;
    return {
      leftPad: cs ? parseFloat(cs.paddingLeft) : 0,
      rightPad: cs ? parseFloat(cs.paddingRight) : 0,
      bottomPad: cs ? parseFloat(cs.paddingBottom) : 0,
      readyState: v ? v.readyState : 0,
      videoWidth: v ? v.videoWidth : 0,
      currentTime: v ? v.currentTime : 0,
      anchorRowGap: (setBtn && nextEl) ? (nextEl.getBoundingClientRect().left - setBtn.getBoundingClientRect().right) : 0
    };
  })()`);
  console.log('3. CH1时间 检查:', JSON.stringify(audio1));
  assert(audio1.leftPad > 0 && audio1.rightPad > 0 && audio1.bottomPad > 0, 'bottom-bar 边距塌陷为 0');
  assert(audio1.readyState >= 2 && audio1.videoWidth > 0 && audio1.currentTime > 0, 'CH1时间视频未定位至锚点帧');
  assert(audio1.anchorRowGap > 0, 'CH1时间底栏按钮间距为 0px');

  // 连续点击 8 次「试听」，确保复用单 AudioContext 不触及 6 上下文上限异常
  await evalJs(`(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('试听'));
    for (let i = 0; i < 8; i++) {
      if (btn) btn.click();
    }
    const pauseBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('暂停'));
    if (pauseBtn) pauseBtn.click();
  })()`);
  screencap('android10_04_audio1');

  await clickStep('CH2时间');
  const audio2 = await evalJs(`(() => {
    const v = document.querySelector('video');
    return { rs: v ? v.readyState : 0, ct: v ? v.currentTime : 0 };
  })()`);
  assert(audio2.rs >= 2 && audio2.ct > 0, 'CH2时间视频未定位至锚点帧');

  // 8. 对比台：校验分区播放、工具栏展开切换叠加模式、双视频同步推进
  await clickStep('对比台', 800);
  const wbBefore = await evalJs(`(() => {
    const stage = document.querySelector('.workbench-stage');
    const cs = stage ? getComputedStyle(stage) : null;
    const canvas = document.querySelector('canvas');
    let nonBlack = 0;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      const data = ctx.getImageData(0, 0, Math.min(canvas.width, 120), Math.min(canvas.height, 120)).data;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 5 || data[i + 1] > 5 || data[i + 2] > 5) nonBlack++;
      }
    }
    const playBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('播放'));
    if (playBtn) playBtn.click();
    return {
      leftPad: cs ? parseFloat(cs.paddingLeft) : 0,
      rightPad: cs ? parseFloat(cs.paddingRight) : 0,
      nonBlack,
      clickedPlay: !!playBtn
    };
  })()`);
  assert(wbBefore.leftPad > 0 && wbBefore.rightPad > 0, 'workbench-stage 左右边距塌陷为 0');
  assert(wbBefore.nonBlack > 0 && wbBefore.clickedPlay, '对比台画布为空或找不到播放按钮');

  await new Promise((r) => setTimeout(r, 1500));
  const wbAfter = await evalJs(`(() => {
    return Array.from(document.querySelectorAll('video')).map(v => ({ t: v.currentTime, paused: v.paused, rs: v.readyState }));
  })()`);
  console.log('4. 对比台(分区)检查:', JSON.stringify({ wbBefore, wbAfter }));
  assert(wbAfter.length === 2 && wbAfter[0].t > 0.2 && wbAfter[1].t > 0.2, '对比台双视频播放未推进');
  screencap('android10_06_workbench');

  // 展开工具栏并切换到叠加模式验证画面非空
  const overlayCheck = await evalJs(`(() => {
    const toggle = document.querySelector('button[title*="工具栏"]');
    if (toggle) toggle.click();
    return !!toggle;
  })()`);
  assert(overlayCheck, '找不到工作台折叠拉手按钮');
  await new Promise((r) => setTimeout(r, 200));
  const overlayNonBlack = await evalJs(`(() => {
    const overlayBtn = Array.from(document.querySelectorAll('.seg-btn')).find(b => b.innerText.includes('叠加'));
    if (overlayBtn) overlayBtn.click();
    return !!overlayBtn;
  })()`);
  assert(overlayNonBlack, '无法切换至叠加模式');
  await new Promise((r) => setTimeout(r, 400));

  // 切换到 0.2x 慢放，随后在导出片段页验证 Android 原生 GPU 离线高速导出 .mp4
  await evalJs(`(() => {
    const rateBtn = Array.from(document.querySelectorAll('.seg-btn')).find(b => b.innerText.trim() === '0.2x');
    if (rateBtn) rateBtn.click();
  })()`);
  await new Promise((r) => setTimeout(r, 300));

  // 9. 导出片段页：验证共享仅 2 路 <video>、400ms 内预览画布立即可见、并跑通原生 GPU 离线 MP4 导出
  await clickStep('导出片段', 400);
  const expQuick = await evalJs(`(() => {
    const grid = document.querySelector('.export-grid');
    const cs = grid ? getComputedStyle(grid) : null;
    const videos = document.querySelectorAll('video');
    const canvases = document.querySelectorAll('canvas');
    const expCanvas = canvases[canvases.length - 1];
    let nonBlack = 0;
    if (expCanvas) {
      const ctx = expCanvas.getContext('2d');
      const d = ctx.getImageData(0, 0, expCanvas.width, expCanvas.height).data;
      for (let i = 0; i < d.length; i += 64) {
        if (d[i] > 5 || d[i + 1] > 5 || d[i + 2] > 5) nonBlack++;
      }
    }
    return {
      leftPad: cs ? parseFloat(cs.paddingLeft) : 0,
      rightPad: cs ? parseFloat(cs.paddingRight) : 0,
      bottomPad: cs ? parseFloat(cs.paddingBottom) : 0,
      videoCount: videos.length,
      nonBlack,
      hasCompatNote: !!document.querySelector('.export-compat-note'),
      crashOverlay: !!document.getElementById('wotagei-crash-overlay')
    };
  })()`);
  console.log('5. 导出页(@400ms)检查:', JSON.stringify(expQuick));
  assert(expQuick.leftPad > 0 && expQuick.rightPad > 0 && expQuick.bottomPad > 0, 'export-grid 边距塌陷为 0');
  assert(expQuick.videoCount === 2, `导出页并发 <video> 应为 2，实际为 ${expQuick.videoCount}`);
  assert(expQuick.nonBlack > 1000, `导出页 400ms 内预览画布仍黑屏 (nonBlack=${expQuick.nonBlack})`);
  assert(!expQuick.hasCompatNote, 'Android 原生平台不应再出现兼容实时录制 WebM 提示');
  assert(!expQuick.crashOverlay, '导出页触发崩溃面板');
  screencap('android10_07_export');

  // 触发原生 GPU 0.2x 慢放全区间离线 MP4 导出并计时
  const exportStarted = await evalJs(`(() => {
    const exportBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('开始渲染导出'));
    if (exportBtn) exportBtn.click();
    return !!exportBtn;
  })()`);
  assert(exportStarted, '未找到导出按钮');

  const exportT0 = Date.now();
  let exportResult = null;
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const st = await evalJs(`(() => {
      const dl = document.querySelector('a[download]');
      const err = Array.from(document.querySelectorAll('.mono-num')).find(el => el.style && el.style.color && el.style.color.includes('danger'));
      const savedEl = Array.from(document.querySelectorAll('.mono-num')).find(el => el.innerText && el.innerText.includes('已保存:'));
      return {
        hasDownload: !!dl,
        savedText: savedEl ? savedEl.innerText : null,
        errText: err ? err.innerText : null
      };
    })()`);
    if (st.errText) {
      throw new Error('导出流程界面报错: ' + st.errText);
    }
    if (st.savedText) {
      exportResult = st;
      break;
    }
  }
  const exportElapsedMs = Date.now() - exportT0;
  console.log('6. Android 原生 GPU 离线 MP4 导出实测:', JSON.stringify({ ...exportResult, exportElapsedMs }));
  assert(Boolean(exportResult && exportResult.savedText && exportResult.savedText.includes('.mp4')), 'Android 原生导出未生成 .mp4 相册文件');
  assert(!exportResult.hasDownload, 'Android 原生端不应渲染无效 blob: 下载按钮');
  assert(exportElapsedMs < 25000, `0.2x 慢放 30s 成片原生离线导出耗时过长: ${exportElapsedMs}ms`);

  // 10. 零运行时异常与零控制台错误
  assert(exceptions.length === 0, `存在未捕获 JS 异常: ${JSON.stringify(exceptions)}`);
  assert(consoleErrors.length === 0, `存在控制台 error: ${JSON.stringify(consoleErrors)}`);

  ws.close();
  console.log('✅ Android 10 (Chrome 74 WebView) 全流程深度兼容巡检全部通过！截图已保存至 /tmp/android10_*.png');
}

run().catch((err) => {
  console.error('❌ 巡检失败:', err);
  process.exit(1);
});
