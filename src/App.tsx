import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ScreenOrientation } from '@capacitor/screen-orientation';
import { ArrowRight } from 'lucide-react';
import type { ComparisonMode, VideoGeometryConfig, TriLineModelType } from './types/geometry.ts';
import type {
  BpmAlignStrategy,
  SlowMotionRate,
  SoundSource,
  TimeInterval,
  VideoAudioInfo,
} from './types/timeline.ts';
import {
  DEFAULT_APP_PREFERENCES,
  type AppPreferences,
  type StepPreset,
} from './types/preferences.ts';
import { DEFAULT_BPM } from './types/timeline.ts';
import type { WizardStep } from './types/wizard.ts';
import type { LoadedVideoItem } from './types/media.ts';
import { loadAppPreferences, saveAppPreferences } from './core/preferences.ts';
import { ImportStep } from './components/ImportStep.tsx';
import { CalibrationStep } from './components/CalibrationStep.tsx';
import { Workbench, HorizontalFlipIcon } from './components/Workbench.tsx';
import { SettingsAboutPage } from './components/SettingsAboutPage.tsx';

/** 全局顶部步骤分段导航配置 */
const WIZARD_STEPS: { id: WizardStep; label: string }[] = [
  { id: 'import', label: '导入' },
  { id: 'calibrate-video1', label: '视频1' },
  { id: 'calibrate-video2', label: '视频2' },
  { id: 'workbench', label: '对比台' },
  { id: 'export', label: '导出片段' },
];

/** 可在任意位置点击手动修改 BPM 的顶栏徽章组件 */
interface BpmBadgeProps {
  channel: 1 | 2;
  bpm: number;
  onChange: (newBpm: number) => void;
}

const BpmBadge: React.FC<BpmBadgeProps> = ({ channel, bpm, onChange }) => {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(bpm.toString());

  useEffect(() => {
    setVal(bpm.toString());
  }, [bpm]);

  const commit = () => {
    setEditing(false);
    const num = parseInt(val, 10);
    if (!isNaN(num) && num > 0) {
      onChange(num);
    } else {
      setVal(bpm.toString());
    }
  };

  if (editing) {
    return (
      <div className={`tag-badge ch${channel}`} style={{ padding: '0 4px', display: 'flex', alignItems: 'center' }}>
        <span style={{ fontSize: '11px' }}>视频{channel}</span>
        <input
          type="number"
          value={val}
          autoFocus
          onChange={(e) => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
          }}
          style={{
            width: '44px',
            height: '18px',
            fontSize: '11px',
            fontFamily: 'var(--font-mono)',
            backgroundColor: '#000',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
            borderRadius: '2px',
            textAlign: 'center',
            marginLeft: '4px',
            padding: 0,
          }}
        />
      </div>
    );
  }

  return (
    <span
      className={`tag-badge ch${channel}`}
      style={{ cursor: 'pointer', userSelect: 'none' }}
      title="点击直接修改 BPM"
      onClick={() => setEditing(true)}
    >
      视频{channel} {bpm} BPM
    </span>
  );
};

/**
 * 应用主状态机与顶部全局步骤直达导航外壳
 */
export default function App(): React.ReactNode {
  // 启动时锁定横屏方向
  useEffect(() => {
    try {
      ScreenOrientation.lock({ orientation: 'landscape' }).catch(() => {});
    } catch {
      // 浏览器端无原生插件时静默跳过
    }
  }, []);

  const [preferences, setPreferences] = useState<AppPreferences>(() => loadAppPreferences());
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);

  const [step, setStep] = useState<WizardStep>('import');
  const [mode, setMode] = useState<ComparisonMode>(preferences.comparisonMode);
  const [isWorkbenchToolbarExpanded, setIsWorkbenchToolbarExpanded] = useState<boolean>(false);
  const [workbenchLoopRange, setWorkbenchLoopRange] = useState<TimeInterval | null>(null);

  // 持久保存双通道视频数据与标定状态
  const [video1, setVideo1] = useState<LoadedVideoItem | null>(null);
  const [video2, setVideo2] = useState<LoadedVideoItem | null>(null);

  // BPM 对齐策略与自定义目标 BPM
  const [bpmStrategy, setBpmStrategy] = useState<BpmAlignStrategy>(preferences.bpmStrategy);
  const [customBpm, setCustomBpm] = useState<number>(preferences.customBpm);

  // 对比台音频源、慢放倍率与步进偏好（冷启动读取默认偏好）
  const [soundSource, setSoundSource] = useState<SoundSource>(preferences.soundSource);
  const [slowMotionRate, setSlowMotionRate] = useState<SlowMotionRate>(preferences.slowMotionRate);
  const [stepPreset, setStepPreset] = useState<StepPreset>(preferences.stepPreset);
  const [customStepSec, setCustomStepSec] = useState<number>(preferences.customStepSec);

  // 全局共享的三线正交标定模型（视频1 与 视频2 保持严格同步）
  const [triLineModel, setTriLineModel] = useState<TriLineModelType>(preferences.triLineModel);

  // 追踪当前会话中用户已手动偏离默认偏好的字段，避免设置页同步覆盖已有主动选择
  const sessionEditedRef = useRef<{
    triLineModel: boolean;
    comparisonMode: boolean;
    soundSource: boolean;
    bpmStrategy: boolean;
    customBpm: boolean;
    slowMotionRate: boolean;
    stepPreset: boolean;
    customStepSec: boolean;
  }>({
    triLineModel: false,
    comparisonMode: false,
    soundSource: false,
    bpmStrategy: false,
    customBpm: false,
    slowMotionRate: false,
    stepPreset: false,
    customStepSec: false,
  });

  const navigateToStep = (nextStep: WizardStep) => {
    setIsSettingsOpen(false);
    setStep(nextStep);
  };

  const isBothLoaded = Boolean(video1 && video2);

  /**
   * 应用三线正交模型到全局会话与双通道视频对象
   */
  const applyTriLineModelToVideos = (model: TriLineModelType) => {
    setTriLineModel(model);
    setVideo1((prev) =>
      prev
        ? {
            ...prev,
            geometry: {
              ...prev.geometry,
              triLine: { ...prev.geometry.triLine, model },
            },
          }
        : null
    );
    setVideo2((prev) =>
      prev
        ? {
            ...prev,
            geometry: {
              ...prev.geometry,
              triLine: { ...prev.geometry.triLine, model },
            },
          }
        : null
    );
  };

  /**
   * 同步更新双通道的三线正交标定模型（工作流内主动切换）
   */
  const handleTriLineModelChange = (model: TriLineModelType) => {
    sessionEditedRef.current.triLineModel = true;
    applyTriLineModelToVideos(model);
  };

  /**
   * 持久化默认偏好并实时同步所有当前会话尚未手动改动的字段
   */
  const handlePreferencesChange = (nextPrefs: AppPreferences) => {
    const saved = saveAppPreferences(nextPrefs);
    setPreferences(saved);
    const edited = sessionEditedRef.current;

    if (!edited.triLineModel) {
      applyTriLineModelToVideos(saved.triLineModel);
    }
    if (!edited.comparisonMode) {
      setMode(saved.comparisonMode);
    }
    if (!edited.soundSource) {
      setSoundSource(saved.soundSource);
    }
    if (!edited.bpmStrategy) {
      setBpmStrategy(saved.bpmStrategy);
    }
    if (!edited.customBpm) {
      setCustomBpm(saved.customBpm);
    }
    if (!edited.slowMotionRate) {
      setSlowMotionRate(saved.slowMotionRate);
    }
    if (!edited.stepPreset) {
      setStepPreset(saved.stepPreset);
    }
    if (!edited.customStepSec) {
      setCustomStepSec(saved.customStepSec);
    }
  };

  const handleResetPreferences = () => {
    handlePreferencesChange({ ...DEFAULT_APP_PREFERENCES });
  };

  /**
   * 实时更新视频 1 空间几何标定参数
   */
  const handleGeometry1Change = (geo: VideoGeometryConfig) => {
    setVideo1((prev) => (prev ? { ...prev, geometry: { ...geo, triLine: { ...geo.triLine, model: triLineModel } } } : null));
  };

  /**
   * 实时更新视频 2 空间几何标定参数
   */
  const handleGeometry2Change = (geo: VideoGeometryConfig) => {
    setVideo2((prev) => (prev ? { ...prev, geometry: { ...geo, triLine: { ...geo.triLine, model: triLineModel } } } : null));
  };

  /**
   * 实时更新视频 1 音频对拍参数
   */
  const handleAudio1Change = (audio: VideoAudioInfo) => {
    setVideo1((prev) => (prev ? { ...prev, audioInfo: audio } : null));
  };

  /**
   * 实时更新视频 2 音频对拍与 BPM 对齐策略
   */
  const handleAudio2Change = (
    audio: VideoAudioInfo,
    strategy?: BpmAlignStrategy,
    targetCustomBpm?: number
  ) => {
    setVideo2((prev) => (prev ? { ...prev, audioInfo: audio } : null));
    if (strategy) setBpmStrategy(strategy);
    if (typeof targetCustomBpm === 'number') setCustomBpm(targetCustomBpm);
  };

  /**
   * 接收导入步骤在卸载后仍可能完成的异步元信息/音轨解码结果，按 url 安全合并字段
   */
  const handlePatchVideo = useCallback(
    (index: 1 | 2, url: string, patch: Partial<LoadedVideoItem>) => {
      const setter = index === 1 ? setVideo1 : setVideo2;
      setter((prev) => {
        if (!prev || prev.url !== url) return prev;
        return { ...prev, ...patch };
      });
    },
    []
  );



  return (
    <div className="app-shell">
      {/* 顶部全局步骤直达导航栏 */}
      <header className="top-nav">
        <div className="control-group" style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
          <button
            type="button"
            className={`nav-brand-btn ${isSettingsOpen ? 'active' : ''}`}
            aria-pressed={isSettingsOpen}
            aria-label="软件设置与关于"
            title="默认偏好设置与关于软件"
            onClick={() => setIsSettingsOpen((prev) => !prev)}
          >
            <svg viewBox="0 0 64 64" width="20" height="20" aria-hidden="true">
              <defs>
                <linearGradient id="navCh1Glow" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#38bdf8" />
                  <stop offset="100%" stopColor="#0284c7" />
                </linearGradient>
                <linearGradient id="navCh2Glow" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#fbbf24" />
                  <stop offset="100%" stopColor="#f59e0b" />
                </linearGradient>
              </defs>
              <rect width="64" height="64" rx="14" fill="#0a0b0f" stroke="#27272a" strokeWidth="2" />
              <g fill="none" strokeLinecap="round" strokeLinejoin="round">
                <path d="M 14 20 L 23 44 L 30 24" stroke="url(#navCh1Glow)" strokeWidth="5.2" />
                <path d="M 34 24 L 41 44 L 50 20" stroke="url(#navCh2Glow)" strokeWidth="5.2" />
              </g>
              <line x1="32" y1="14" x2="32" y2="50" stroke="#71717a" strokeWidth="1.6" strokeDasharray="3 3" />
            </svg>
          </button>

          <span className="nav-brand-divider" aria-hidden="true" />

          <nav className="step-track" aria-label="工作流步骤导航" style={{ overflow: 'hidden' }}>
            {WIZARD_STEPS.map((item) => {
              const disabled = item.id !== 'import' && !isBothLoaded;
              const active = !isSettingsOpen && step === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    if (isSettingsOpen) {
                      navigateToStep(item.id);
                    } else if (item.id === 'workbench' && step === 'workbench') {
                      setIsWorkbenchToolbarExpanded((prev) => !prev);
                    } else {
                      navigateToStep(item.id);
                    }
                  }}
                  className={`step-tab ${active ? 'active' : ''}`}
                >
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        <div className="control-group" style={{ flexShrink: 0 }}>
          {!isSettingsOpen && step === 'workbench' && (
            <>
              {video1 && (
                <BpmBadge
                  channel={1}
                  bpm={video1.audioInfo?.userBpm ?? DEFAULT_BPM}
                  onChange={(newBpm) => {
                    const currentAudio: VideoAudioInfo = video1.audioInfo || {
                      duration: video1.duration || 1,
                      sampleRate: 16000,
                      hasAudioTrack: false,
                      audioDegraded: true,
                      detectedBpm: newBpm,
                      userBpm: newBpm,
                      anchorTime: Math.min(1.0, Math.max(0.25, (video1.duration || 1) / 4)),
                      waveform: new Float32Array(0),
                    };
                    handleAudio1Change({ ...currentAudio, userBpm: newBpm });
                  }}
                />
              )}
              {video2 && (
                <BpmBadge
                  channel={2}
                  bpm={video2.audioInfo?.userBpm ?? DEFAULT_BPM}
                  onChange={(newBpm) => {
                    const currentAudio: VideoAudioInfo = video2.audioInfo || {
                      duration: video2.duration || 1,
                      sampleRate: 16000,
                      hasAudioTrack: false,
                      audioDegraded: true,
                      detectedBpm: newBpm,
                      userBpm: newBpm,
                      anchorTime: Math.min(1.0, Math.max(0.25, (video2.duration || 1) / 4)),
                      waveform: new Float32Array(0),
                    };
                    handleAudio2Change({ ...currentAudio, userBpm: newBpm }, bpmStrategy, customBpm);
                  }}
                />
              )}
            </>
          )}

          {!isSettingsOpen && (step === 'calibrate-video1' || step === 'calibrate-video2') && (video1 || video2) && (() => {
            const isCalib1 = step === 'calibrate-video1';
            const activeItem = isCalib1 ? video1 : video2;
            const isMirrorOn = Boolean(activeItem?.geometry.mirror);
            const isSpatialTouched = Boolean(activeItem?.spatialTouched);
            const isAudioTouched = Boolean(activeItem?.audioAnchorTouched);
            return (
              <div className="control-group fx-row-4">
                <div
                  className="calib-status-group"
                  role="status"
                  aria-label="当前视频标定完成状态"
                  title="标定状态指示（拖动三线后点亮空间，点击设为锚点后点亮时间）"
                >
                  <span className="calib-status-item">
                    <span>空间</span>
                    <span className={`calib-dot ${isSpatialTouched ? 'lit' : ''}`} aria-hidden="true" />
                  </span>
                  <span className="calib-status-divider" aria-hidden="true" />
                  <span className="calib-status-item">
                    <span>时间</span>
                    <span className={`calib-dot ${isAudioTouched ? 'lit' : ''}`} aria-hidden="true" />
                  </span>
                </div>

                <select
                  value={triLineModel}
                  onChange={(e) => handleTriLineModelChange(e.target.value as TriLineModelType)}
                  className="select-input"
                  style={{
                    height: '26px',
                    backgroundColor: 'var(--bg-surface)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border)',
                    borderRadius: '4px',
                    fontSize: '11.5px',
                    padding: '0 6px',
                    cursor: 'pointer',
                  }}
                >
                  <option value="two-horizontal-one-vertical">两横一竖</option>
                  <option value="two-vertical-one-horizontal">两竖一横</option>
                </select>

                <button
                  type="button"
                  onClick={() => {
                    if (isCalib1 && video1) {
                      handleGeometry1Change({
                        ...video1.geometry,
                        mirror: !video1.geometry.mirror,
                      });
                    } else if (!isCalib1 && video2) {
                      handleGeometry2Change({
                        ...video2.geometry,
                        mirror: !video2.geometry.mirror,
                      });
                    }
                  }}
                  aria-pressed={isMirrorOn}
                  className={`btn ${isMirrorOn ? 'btn-active' : ''}`}
                  style={{ height: '26px', padding: '0 7px', fontSize: '11.5px' }}
                  title={`${isCalib1 ? '视频1' : '视频2'} 镜像切换`}
                >
                  <HorizontalFlipIcon size={12} />
                  <span>镜像</span>
                </button>

                <button
                  type="button"
                  onClick={() => navigateToStep(isCalib1 ? 'calibrate-video2' : 'workbench')}
                  className="btn btn-accent"
                  style={{ height: '26px', padding: '0 8px', fontSize: '11.5px' }}
                >
                  <span>下一步</span>
                  <ArrowRight size={12} />
                </button>
              </div>
            );
          })()}
        </div>
      </header>

      {/* 主视图容器 */}
      <main className="view-body">
        {isSettingsOpen ? (
          <SettingsAboutPage
            preferences={preferences}
            onPreferencesChange={handlePreferencesChange}
            onResetPreferences={handleResetPreferences}
            onClose={() => setIsSettingsOpen(false)}
          />
        ) : (
          <>
            {step === 'import' && (
          <ImportStep
            initialVideo1={video1}
            initialVideo2={video2}
            onUpdateVideo1={(item) => {
              setWorkbenchLoopRange(null);
              setVideo1({
                ...item,
                geometry: {
                  ...item.geometry,
                  triLine: { ...item.geometry.triLine, model: triLineModel },
                },
              });
            }}
            onUpdateVideo2={(item) => {
              setWorkbenchLoopRange(null);
              setVideo2({
                ...item,
                geometry: {
                  ...item.geometry,
                  triLine: { ...item.geometry.triLine, model: triLineModel },
                },
              });
            }}
            onPatchVideo={handlePatchVideo}
            onComplete={(data) => {
              const mergeIntoPrev = (
                prev: LoadedVideoItem | null,
                incoming: LoadedVideoItem
              ): LoadedVideoItem => ({
                ...(prev && prev.url === incoming.url ? prev : incoming),
                ...incoming,
                // 时长合并规则：优先采用已知的真实值（> 0），0 表示尚未探测完成（未知哨兵）；
                // 双方均已知时以较新的 incoming 为准。此前与 Java 默认值耦合的
                // `prev.duration !== 10` 魔法数判断已随 0 哨兵机制废除。
                duration:
                  incoming.duration > 0
                    ? incoming.duration
                    : prev && prev.url === incoming.url && prev.duration > 0
                    ? prev.duration
                    : incoming.duration,
                audioInfo:
                  incoming.audioInfo ??
                  (prev && prev.url === incoming.url ? prev.audioInfo : undefined),
                geometry: {
                  ...incoming.geometry,
                  triLine: { ...incoming.geometry.triLine, model: triLineModel },
                },
              });
              setVideo1((prev) => mergeIntoPrev(prev, data.video1));
              setVideo2((prev) => mergeIntoPrev(prev, data.video2));
              navigateToStep('calibrate-video1');
            }}
          />
        )}

        {step === 'calibrate-video1' && video1 && (
          <CalibrationStep
            key="calib-1"
            videoItem={video1}
            videoIndex={1}
            model={triLineModel}
            onSpatialChange={handleGeometry1Change}
            onSpatialTouched={() =>
              setVideo1((prev) => (prev && !prev.spatialTouched ? { ...prev, spatialTouched: true } : prev))
            }
            onAudioChange={handleAudio1Change}
            onAudioAnchorTouched={() =>
              setVideo1((prev) => (prev && !prev.audioAnchorTouched ? { ...prev, audioAnchorTouched: true } : prev))
            }
          />
        )}

        {step === 'calibrate-video2' && video2 && (
          <CalibrationStep
            key="calib-2"
            videoItem={video2}
            videoIndex={2}
            model={triLineModel}
            onSpatialChange={handleGeometry2Change}
            onSpatialTouched={() =>
              setVideo2((prev) => (prev && !prev.spatialTouched ? { ...prev, spatialTouched: true } : prev))
            }
            onAudioChange={handleAudio2Change}
            onAudioAnchorTouched={() =>
              setVideo2((prev) => (prev && !prev.audioAnchorTouched ? { ...prev, audioAnchorTouched: true } : prev))
            }
          />
        )}

        {(step === 'workbench' || step === 'export') && video1 && video2 && (
          <Workbench
            video1={video1}
            video2={video2}
            initialMode={mode}
            bpmStrategy={bpmStrategy}
            customBpm={customBpm}
            soundSource={soundSource}
            slowMotionRate={slowMotionRate}
            stepPreset={stepPreset}
            customStepSec={customStepSec}
            isExport={step === 'export'}
            isToolbarExpanded={isWorkbenchToolbarExpanded}
            loopRange={workbenchLoopRange}
            onLoopRangeChange={setWorkbenchLoopRange}
            onToggleToolbar={() => setIsWorkbenchToolbarExpanded((prev) => !prev)}
            onNavigate={(nextStep) => navigateToStep(nextStep)}
            onBpmStrategyChange={(strat, custom) => {
              sessionEditedRef.current.bpmStrategy = true;
              setBpmStrategy(strat);
              if (typeof custom === 'number') {
                sessionEditedRef.current.customBpm = true;
                setCustomBpm(custom);
              }
            }}
            onModeChange={(nextMode) => {
              sessionEditedRef.current.comparisonMode = true;
              setMode(nextMode);
            }}
            onSoundSourceChange={(nextSource) => {
              sessionEditedRef.current.soundSource = true;
              setSoundSource(nextSource);
            }}
            onSlowMotionRateChange={(nextRate) => {
              sessionEditedRef.current.slowMotionRate = true;
              setSlowMotionRate(nextRate);
            }}
            onStepPresetChange={(nextPreset) => {
              sessionEditedRef.current.stepPreset = true;
              setStepPreset(nextPreset);
            }}
            onCustomStepSecChange={(nextSec) => {
              sessionEditedRef.current.customStepSec = true;
              setCustomStepSec(nextSec);
            }}
            onMirrorChange={(idx, m) => {
              if (idx === 1) {
                setVideo1((prev) =>
                  prev ? { ...prev, geometry: { ...prev.geometry, mirror: m } } : null
                );
              } else {
                setVideo2((prev) =>
                  prev ? { ...prev, geometry: { ...prev.geometry, mirror: m } } : null
                );
              }
            }}
          />
        )}
          </>
        )}
      </main>
    </div>
  );
}
