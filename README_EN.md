# Wotagei-Compare

[简体中文](./README.md) | English

![Platform](https://img.shields.io/badge/Platform-Android%206.0%2B%20%7C%20Web-222222)
![License](https://img.shields.io/badge/License-MIT-blue.svg)

An offline, landscape-first dual-video alignment, beat-synced slow-motion, and side-by-side comparison tool built for Wotagei practitioners.

![Comparison Workbench (Split-Screen Mode)](./docs/assets/workbench-split.png)

| Tri-Line Spatial Alignment | Waveform Trim & Beat Anchor |
| :---: | :---: |
| ![Tri-Line Spatial Alignment](./docs/assets/geometry-align.png) | ![Waveform Trim & Beat Anchor](./docs/assets/audio-sync.png) |
| **Overlay Light-Arc Comparison** | **A-B Range Offline MP4 Export** |
| ![Overlay Comparison Mode](./docs/assets/workbench-overlay.png) | ![A-B Clip Export](./docs/assets/export-clip.png) |

## Why Wotagei-Compare

When practicing Wotagei, you often want to put a freshly recorded take right next to a reference clip to check arm trajectories, posture, and beat timing. Full mobile video editors are too slow for quick iteration between takes, while generic dual-video players cannot align two videos shot from different distances or performed at different tempos (BPM).

Wotagei-Compare turns that workflow into a focused offline tool: load two local clips, align body proportions with three orthogonal guide lines, drop a single beat anchor on each waveform, and compare them in synchronized slow motion down to `0.1x`—or export a specific A-B move straight to your phone gallery as an MP4. Everything runs locally on your device; no videos are ever uploaded.

## Key Features

- **Tri-Line Orthogonal Spatial Alignment**
  - Aligns body scale and position using either **Two Horizontal + One Vertical** lines (head top, feet ground, body centerline) or **Two Vertical + One Horizontal** lines (left foot, right foot, ground line), applying uniform scaling and translation without rotating either video.
  - **Split-Screen Mode**: Automatically normalizes performer height and ground level on each half of the screen while preserving generous overhead and lateral headroom so wide light-arc swings are never cropped.
  - **Overlay Mode**: Stacks both performers on shared anchor coordinates with one-finger pan, two-finger pinch-to-zoom for inspecting wrist and footwork details, and an equal-brightness linear opacity slider (`-1` to `1`) that keeps mid-point blends from looking dim.
  - **Independent Horizontal Flip**: Mirror CH1 or CH2 independently to handle front-camera recordings or mirrored choreography learning.

- **Waveform Trimming & Beat Synchronization**
  - Automatically extracts audio waveforms and estimates BPM upon import, tuned for typical Wotagei tempos (150–190 BPM) with harmonic checks against dotted/syncopated rhythms.
  - Drag `[` and `]` trim handles on the waveform to isolate a specific combo and re-estimate local BPM, or set BPM via Tap Tempo and manual numeric input.
  - Place a single beat anchor per channel and choose between **Original Speed**, **Match CH1 BPM**, **Match CH2 BPM**, or **Custom Target BPM**. Playback automatically scopes to the valid overlapping intersection of both trimmed clips.

- **Ultra-Slow Motion & High-Clarity Metronome**
  - Seven playback speeds (`0.1x / 0.15x / 0.2x / 0.3x / 0.5x / 0.75x / 1.0x`) plus a one-tap jump to **1 second before anchor** (`tau = -1.0s`).
  - Phase-locked WebAudio synthesized metronome with dynamic compression so downbeats (`4/4` bar accent at the anchor) cut cleanly through loud backing tracks, alongside single-channel original audio playback (pitch-preserved across slow-motion speeds) or mute.

- **WYSIWYG A-B Offline MP4 Export**
  - Drag A and B handles on the unified timeline to export a sub-clip using the exact layout mode, zoom/pan viewport, slow-motion rate, and audio source shown in the workbench.
  - On Android, a native hardware decoding and OpenGL ES zero-copy encoding pipeline renders standard `.mp4` files faster than real-time playback and saves them directly to the system `Movies` gallery.

## Getting Started

### Supported Platforms

- **Android App (Recommended)**: Download the latest APK from [GitHub Releases](https://github.com/jollyxenon/Wotagei-Compare/releases). Supports Android 6.0 (API 23) and above.
- **Web Browser**: Runs in modern desktop and mobile browsers for previewing or local development.

> **Platform Notes**: The native Android build uses streaming audio extraction and hardware GPU encoding to handle large high-bitrate videos (>80 MB) and older system WebViews (such as Android 10 / Chrome 70+ WebViews) without memory issues. In pure Web browsers, files larger than 80 MB skip full PCM decoding to prevent tab out-of-memory crashes (the UI clearly marks the BPM as a placeholder value that you can adjust via Tap or manual input), and fast offline MP4 encoding requires WebCodecs support — browsers without WebCodecs will report an explicit error instead of exporting; use a recent Chrome or the Android native client instead.

### Workflow

The interface locks to landscape orientation and follows the top navigation bar from left to right:

1. **Import**: Load two local video files into `CH1` and `CH2`. Both channels are treated equally.
2. **CH1 / CH2 Space**: Pick a tri-line calibration model (`2H1V` or `2V1H`), drag the three lines onto the performer's landmarks, and toggle horizontal mirror if needed.
3. **CH1 / CH2 Time**: Drag `[` and `]` on the waveform to trim the target section, locate the starting beat frame to set the anchor, and verify or adjust the BPM.
4. **Workbench**: Toggle between **Split** and **Overlay** views, choose slow-motion speed, audio source, and bottom-right `SYNC` tempo mode (tap the center trapezoid tab under the top bar to collapse or expand the toolbar).
5. **Export Clip**: Set the A-B range on the timeline and tap **Export** to render an MP4 clip.

Once both videos are loaded, you can jump directly to any step from the top bar to tweak calibration without losing state.

## Local Development & Build

### Prerequisites

- **Frontend**: Node.js 20+ and npm
- **Android Build** (optional, required only for APK packaging): JDK 17+, Android Studio, and Android SDK (`minSdkVersion 23`, `compileSdkVersion 35`)

### Run in Web Browser

```bash
git clone https://github.com/jollyxenon/Wotagei-Compare.git
cd Wotagei-Compare
npm install

# Start Vite dev server (default: http://localhost:5173)
npm run dev

# Run TypeScript check and build production assets into dist/
npm run build
```

### Build Android APK

```bash
# 1. Build frontend assets and sync them to the Capacitor Android project
npm run build
npx cap sync android

# 2. Assemble a debug APK via Gradle (or open android/ in Android Studio)
cd android
./gradlew assembleDebug
```

The generated APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`.

### Verification & Unit Tests

Core math and state-machine modules include standalone verification scripts, alongside JUnit tests for the native Android layer:

```bash
# Static type checking (enforces ES2018 runtime API boundary)
npx tsc --noEmit

# Run frontend core verification scripts
npx tsx src/core/geometry.verify.ts
npx tsx src/core/timeline.verify.ts
npx tsx src/core/audio.verify.ts
npx tsx src/core/sync-engine.verify.ts
npx tsx src/core/metronome.verify.ts
npx tsx src/core/renderer.verify.ts
npx tsx src/core/exporter.verify.ts

# Run Android native unit tests
cd android && ./gradlew testDebugUnitTest
```

## Architecture & Project Structure

Wotagei-Compare combines a pure TypeScript algorithmic frontend with a custom Capacitor native media layer on Android:

- **Frontend Core (`src/core/`)**: UI-agnostic modules handling tri-line orthogonal geometry (`geometry.ts`), autocorrelation BPM detection and audio resampling (`audio.ts`), intersection timeline mapping (`timeline.ts`), a PLL-inspired dual-video clock (`sync-engine.ts`), WebAudio metronome synthesis (`metronome.ts`), and Canvas/WebCodecs composition (`renderer.ts`, `exporter.ts`).
- **Android Native Media Layer (`android/app/src/main/java/com/wotagei/compare/`)**: Built around `NativeMediaPlugin`. `LocalRangeProxyServer` streams persistent `content://` video URIs with HTTP Range support for WebView random seeking; `NativeAudioExtractor` decodes mono PCM in streaming chunks for waveform analysis; `NativeGlRenderer` and `NativeOfflineExporter` (`MediaCodec + OpenGL ES + MediaMuxer`) composite dual video textures directly on the GPU for offline MP4 export. Only lightweight JSON layout and timeline parameters cross the JS-to-native bridge.

```text
Wotagei-Compare/
├── src/
│   ├── types/                  # Type contracts for geometry, timeline, wizard, and export
│   ├── core/                   # Pure algorithms, sync engine, metronome, renderer, and exporter
│   ├── components/             # 7-step landscape wizard views and comparison workbench
│   └── App.tsx                 # Top-level state container and direct step navigation
├── android/                    # Capacitor Android project and native GPU export pipeline
├── openspec/specs/             # Current system behavior specifications
├── docs/
│   ├── requirements/           # Original product requirements baseline
│   └── decisions/              # Architecture Decision Records (AgDR-0001 to AgDR-0033)
├── scripts/                    # Safe-area simulation and legacy WebView inspection scripts
└── capacitor.config.ts         # Capacitor configuration
```

For detailed design rationale—such as why bounding-box calibration was replaced by tri-line anchoring, how the sync engine prevents ghost playback after pausing, or why standard library APIs are capped at ES2018—see the Architecture Decision Records in [`docs/decisions/`](./docs/decisions/) and behavior contracts in [`openspec/specs/`](./openspec/specs/) (written in Chinese).

## Contributing

Bug reports, device compatibility feedback, and pull requests are welcome. Please keep the following constraints in mind when modifying code:

1. **ES2018 Compatibility**: Both `tsconfig.json` and `vite.config.ts` target `ES2018` so the app runs cleanly on older Android System WebViews (Chrome 70+). Avoid newer built-ins such as `Promise.allSettled` or `Array.prototype.flat` in `src/`, and run `npm run build` before submitting changes.
2. **Landscape & Safe-Area Layout**: Every view is designed for short-height mobile landscape viewports. Ensure UI changes respect display cutouts, status bars, and 3-button navigation bar insets via CSS safe-area variables without clipping primary controls.
3. **Algorithm Verification**: When changing math or state machines in `src/core/` or the native exporter, run the corresponding `.verify.ts` scripts and Gradle unit tests.

## Acknowledgements

- Thanks to **夜瞑 (Yeming)** for authorizing the demonstration footage used in the screenshots, as well as pointing out the project's shortcomings and providing detailed suggestions that helped drive its further improvement.
- Thanks to members of **ShanghaiTech Prism Anime Club · Lucifer Wotagei Team** for device testing and feedback.

## License

Released under the [MIT License](./LICENSE).
