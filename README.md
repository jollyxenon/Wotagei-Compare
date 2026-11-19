# Wotagei-Compare

简体中文 | [English](./README_EN.md)

![Platform](https://img.shields.io/badge/Platform-Android%206.0%2B%20%7C%20Web-222222)
![License](https://img.shields.io/badge/License-MIT-blue.svg)

面向 WOTA 艺（御宅艺）练习者的本地双视频空间对齐、卡拍慢放与同台对比导出工具。

![同台对比工作台（左右分区模式）](./docs/assets/workbench-split.png)

| 三线正交空间标定 | 波形截取与起拍锚点 |
| :---: | :---: |
| ![三线空间标定](./docs/assets/geometry-align.png) | ![波形截取与起拍锚点](./docs/assets/audio-sync.png) |
| **半透明叠加光弧对比** | **A-B 区间离线导出 MP4** |
| ![半透明叠加模式](./docs/assets/workbench-overlay.png) | ![A-B 区间导出](./docs/assets/export-clip.png) |

## 为什么做这个工具

练技现场录完一段视频，想马上和参考原片放一起比对发力、光弧轨迹和卡拍细节时，常见工具都不太顺手：剪辑软件操作重、导出慢；普通双开播放器又没法把拍摄距离不同、甚至曲速（BPM）不同的两段视频对齐到同一画面和同一节拍上。

Wotagei-Compare 把这件事收拢成一套纯本地的横屏工作流：选好两段视频，拉三条线对齐身形比例，在波形上打一个起拍锚点，就能直接以最高 0.1x 超慢放同台对比，或把关键招式合成为 MP4 保存到手机相册。全程离线运行，视频不上传任何服务器。

## 核心功能

- **三线正交空间对齐**
  - 提供「两横一竖」（头顶、脚底、身体中轴）与「两竖一横」（左脚、右脚、地面线）两种标定模型，只做等比缩放与平移，不引入画面旋转。
  - **左右分区模式**：自动统一两侧人物身高与地面高度，并在头顶及身体外侧留出充足空间，避免大幅度挥棒光弧被裁切。
  - **半透明叠加模式**：将两路人物按锚点重合叠加，支持单指平移、双指捏合放大观察局部动作，以及 `-1 ~ 1` 等亮线性透明度调节（50% 混合时画面不发暗）。
  - **独立水平镜像**：CH1 与 CH2 均可独立左右翻转，适配前置摄像头自拍或镜面扒技。

- **波形截取与卡拍同步**
  - 导入后自动提取音频波形并测算 BPM，针对 WOTA 艺常见的 150–190 BPM 速度带与附点切分音做了抗倍频/半频误判优化。
  - 支持在波形轴上拖动 `[` 与 `]` 截取有效技连片段重新测算局部 BPM，也支持 Tap 点按测速与手动输入。
  - 每个通道只需标记一个起拍锚点，对比时可选择「原速」「随 CH1」「随 CH2」或「手动指定目标 BPM」自动变速锁拍，播放范围自动取两段视频的有效重叠交集。

- **七档慢放与高穿透节拍器**
  - 支持 `0.1x / 0.15x / 0.2x / 0.3x / 0.5x / 0.75x / 1.0x` 七档慢放，支持一键跳回「锚点前 1 秒」起播。
  - 内置与对拍锚点严格锁相的合成节拍器（锚点对应小节第一拍重拍），针对高响度伴奏做过动态压缩增强；也可随时切换为 CH1 / CH2 单侧原声（慢放下保持变速不变调）或静音。

- **A-B 区间所见即所得导出**
  - 在交集时间轴上拖动 A-B 双端点框选片段，完全复用当前对比模式、视口缩放位置、慢放倍速与声音设置导出标准 `.mp4` 视频。
  - Android 端采用原生硬件解码与 OpenGL ES 零拷贝离线编码管线，无需按慢放时长实时等待录制，导出完成后直接写入系统相册（`Movies` 目录）。

## 快速上手

### 安装与运行平台

- **Android 客户端（推荐）**：前往 [GitHub Releases](https://github.com/jollyxenon/Wotagei-Compare/releases) 下载最新 APK 安装，支持 Android 6.0（API 23）及以上设备。
- **Web 浏览器端**：支持在桌面或移动端现代浏览器中直接运行（见下方本地开发说明）。

> **平台能力说明**：Android 原生端通过流式解码与硬件管线支持 >80 MB 大体积高清视频的完整波形解析与高速 MP4 导出，并兼容至 Android 10（Chrome 70+ 级别系统 WebView）。纯 Web 浏览器端为防止标签页内存溢出，对超过 80 MB 的本地视频会跳过全量波形解码（界面会明示 BPM 为占位值，可手动输入或 Tap 测速），且浏览器离线导出 MP4 依赖 WebCodecs 支持——不支持的浏览器将直接提示无法离线导出，建议改用最新版 Chrome 或 Android 原生客户端。

### 使用流程

应用全程锁定横屏，按顶部导航栏从左到右推进即可：

1. **导入**：分别选入 `CH1` 与 `CH2` 本地视频。双通道地位对等，不分主次。
2. **CH1 / CH2 空间**：选择「两横一竖」或「两竖一横」，拖动标尺贴合人物特征位置；需要翻转画面时点击右上角镜像按钮。
3. **CH1 / CH2 时间**：拖动波形两端的 `[` 与 `]` 框出要对比的片段，找到起拍动作帧设为锚点，确认或微调右侧 BPM。
4. **对比台**：切换「分区 / 叠加」视图、慢放倍率、声音源以及右下角 `SYNC` 变速对齐策略（点击顶部正中的梯形拉手可收起/展开上方工具栏）。
5. **导出片段**：在单轨上拖动 A、B 端点选定区间，点击「开始渲染导出」生成对比视频。

双路视频载入后，随时可以点击顶部导航栏跳回任意步骤微调参数，已有标定数据不会丢失。

## 本地开发与构建

### 环境要求

- **前端环境**：Node.js 20+、npm
- **Android 构建环境**（仅打包 APK 时需要）：JDK 17+、Android Studio 与 Android SDK（`minSdkVersion 23`，`compileSdkVersion 35`）

### 启动 Web 端开发服务

```bash
git clone https://github.com/jollyxenon/Wotagei-Compare.git
cd Wotagei-Compare
npm install

# 启动本地热更新服务（默认 http://localhost:5173）
npm run dev

# 执行 TypeScript 类型检查并构建生产静态包至 dist/
npm run build
```

### 构建 Android 安装包

```bash
# 1. 构建前端资源并同步到 Android 工程
npm run build
npx cap sync android

# 2. 命令行编译 Debug APK（也可用 Android Studio 直接打开 android/ 目录运行）
cd android
./gradlew assembleDebug
```

编译生成的安装包位于 `android/app/build/outputs/apk/debug/app-debug.apk`。

### 运行核心算法验证

前端核心算法与控制状态机均配有独立的离线验证脚本，Android 原生层包含 JUnit 单元测试：

```bash
# 静态类型与 ES2018 标准库边界检查
npx tsc --noEmit

# 一键运行全部前端核心模块验证脚本（几何投影、时间轴交集、BPM 检测、同步状态机、节拍器、渲染、导出、偏好与更新器）
npm test

# 运行 Android 原生层单元测试
cd android && ./gradlew testDebugUnitTest
```

## 架构与目录结构

项目采用「纯前端算法工作台 + Android 原生流式媒体管线」的双层结构：

- **前端核心层（`src/core/`）**：与 React UI 解耦的纯函数与控制引擎，负责三线正交几何映射（`geometry.ts`）、自相关 BPM 测算与重采样（`audio.ts`）、交集时间轴换算（`timeline.ts`）、双视频锁相环同步时钟（`sync-engine.ts`）、WebAudio 合成节拍器（`metronome.ts`）以及 Canvas 合成与 WebCodecs 导出（`renderer.ts`、`exporter.ts`）。
- **Android 原生桥接层（`android/app/src/main/java/com/wotagei/compare/`）**：基于 Capacitor 自定义 `NativeMediaPlugin`。通过本地 HTTP Range 代理（`LocalRangeProxyServer`）为 WebView 提供零内存拷贝的视频随机寻道流，使用 `NativeAudioExtractor` 流式提取单声道 PCM 供前端计算波形，并通过 `NativeGlRenderer` 与 `NativeOfflineExporter`（`MediaCodec + OpenGL ES + MediaMuxer`）在 GPU 纹理层直接完成双视频帧合成与离线 MP4 编码。前后端之间仅传递 JSON 布局与时间轴参数，不跨桥搬运像素或大块音频数组。

```text
Wotagei-Compare/
├── src/
│   ├── types/                  # 几何标定、时间轴、向导与导出参数类型契约
│   ├── core/                   # 几何、音频、时间轴、同步时钟、节拍器、渲染与导出核心实现
│   ├── components/             # 7 步横屏向导视图与同台对比播放工作台组件
│   └── App.tsx                 # 顶层状态驻留与全局步骤直达导航
├── android/                    # Capacitor Android 原生壳与 GPU 离线导出管线
├── openspec/specs/             # 当前系统各模块的行为规格说明
├── docs/
│   ├── requirements/           # 原始产品需求基线
│   └── decisions/              # 架构决策记录（AgDR-0001 ~ AgDR-0033）
├── scripts/                    # 移动端安全区与老旧内核兼容性巡检脚本
└── capacitor.config.ts         # Capacitor 跨平台配置
```

如果你想了解某个机制背后的取舍（例如为什么废除早期矩形框标定、双视频同步状态机如何防止暂停后单侧幽灵起播、为什么限制标准库版本），可以查阅 [`docs/decisions/`](./docs/decisions/) 下的架构决策记录（AgDR）与 [`openspec/specs/`](./openspec/specs/) 中的规格文档。

## 参与贡献

欢迎提交 Issue 反馈真机兼容问题，或直接发起 Pull Request 改进功能与算法。修改代码时请留意以下工程约束：

1. **保持 ES2018 运行时兼容**：为兼容老旧 Android System WebView（Chrome 70+），`tsconfig.json` 与 `vite.config.ts` 均锁定在 `ES2018`。请勿在 `src/` 中直接调用 `Promise.allSettled`、`Array.prototype.flat` 等高版本标准库 API，提交前请运行 `npm run build` 确认编译通过。
2. **横屏与安全区适配**：所有界面均面向手机横屏窄高度视口设计，改动布局时需兼顾刘海打孔屏、常驻状态栏与侧边虚拟导航栏（CSS 安全区变量）的避让，确保关键按钮首屏无截断。
3. **验证回归**：修改 `src/core/` 或原生导出逻辑后，请运行对应的 `.verify.ts` 脚本或 Gradle 单元测试验证数学映射关系一致。

## 致谢

- 感谢 **夜瞑** 授权提供演示视频素材（《\[A\]ddiction 楽園 艺龄五年纪念》《金刚 真龙》），同时感谢其指出本项目的不足并提供细致的建议，推动项目的进一步完善。
- 感谢 **上海科技大学 Prism 漫研社 Lucifer WOTA 艺团** 成员参与实机测试与反馈。

## 开源协议

本项目基于 [MIT License](./LICENSE) 开源。
