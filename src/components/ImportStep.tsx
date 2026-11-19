import React, { useRef, useState, useEffect } from 'react';
import { Film, Upload, ArrowRight, CheckCircle2, Loader2, AlertTriangle } from 'lucide-react';
import type { VideoGeometryConfig } from '../types/geometry.ts';
import type { VideoAudioInfo } from '../types/timeline.ts';
import { DEFAULT_BPM } from '../types/timeline.ts';
import type { LoadedVideoItem } from '../types/media.ts';
import { decodeAudioFromFile, decodeAudioFromNativePcmUrl } from '../core/audio-dom.ts';
import { dropPcm, putPcm } from '../core/pcmStore.ts';
import { NativeMedia, isNativeAndroid } from '../core/nativeMedia.ts';

interface ImportStepProps {
  initialVideo1?: LoadedVideoItem | null;
  initialVideo2?: LoadedVideoItem | null;
  onUpdateVideo1?: (item: LoadedVideoItem) => void;
  onUpdateVideo2?: (item: LoadedVideoItem) => void;
  onPatchVideo?: (index: 1 | 2, url: string, patch: Partial<LoadedVideoItem>) => void;
  onComplete: (data: {
    video1: LoadedVideoItem;
    video2: LoadedVideoItem;
  }) => void;
}

/**
 * 安全探测视频的真实分辨率与时长
 * 具备 DOM 挂载注入、playsinline 与 2.5 秒硬超时保底能力。
 * 探测失败/超时时返回 0（未知哨兵），绝不伪造 1920×1080 / 10s 等假数据。
 */
function probeVideoMetadata(
  url: string,
  hostElement: HTMLElement | null
): Promise<{ width: number; height: number; duration: number }> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.preload = 'metadata';

    let settled = false;
    const finish = (result: { width: number; height: number; duration: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.onloadedmetadata = null;
      video.oncanplay = null;
      video.onerror = null;
      try {
        if (hostElement && hostElement.contains(video)) {
          hostElement.removeChild(video);
        }
      } catch {}
      resolve(result);
    };

    // 2.5 秒超时硬兜底：若老旧内核或特殊编码迟迟未触发事件，保留已知的部分字段，
    // 其余返回 0（未知），绝不阻断用户流程
    const timer = setTimeout(() => {
      finish({
        width: video.videoWidth > 0 ? video.videoWidth : 0,
        height: video.videoHeight > 0 ? video.videoHeight : 0,
        duration: !isNaN(video.duration) && video.duration > 0 ? video.duration : 0,
      });
    }, 2500);

    const onReady = () => {
      finish({
        width: video.videoWidth > 0 ? video.videoWidth : 0,
        height: video.videoHeight > 0 ? video.videoHeight : 0,
        duration: !isNaN(video.duration) && video.duration > 0 ? video.duration : 0,
      });
    };

    video.onloadedmetadata = onReady;
    video.oncanplay = onReady;
    video.onerror = () => {
      finish({ width: 0, height: 0, duration: 0 });
    };

    video.src = url;

    // 挂载至隐藏 DOM 节点唤醒老旧 Chromium 移动端媒体管道
    if (hostElement) {
      try {
        hostElement.appendChild(video);
      } catch {}
    }

    try {
      video.load();
    } catch {}
  });
}

/**
 * 构造显式标记为降级的音频占位信息（解析失败 / 无音轨 / 超限）
 * duration 允许为 0（未知），由调用方保证最终落到真实元数据时长
 */
function buildDegradedAudioInfo(duration: number): VideoAudioInfo {
  return {
    duration,
    sampleRate: 16000,
    hasAudioTrack: false,
    audioDegraded: true,
    detectedBpm: DEFAULT_BPM,
    userBpm: DEFAULT_BPM,
    anchorTime: Math.min(1.0, Math.max(0.25, duration / 4)),
    waveform: new Float32Array(1000).fill(0.1),
    trimRange: { start: 0, end: duration > 0 ? duration : 1 },
    // rawChannelData 已移出 React 状态：降级时无需注册 PCM
  };
}

/**
 * 步骤 01：双通道本地视频导入面板
 */
export const ImportStep: React.FC<ImportStepProps> = ({
  initialVideo1 = null,
  initialVideo2 = null,
  onUpdateVideo1,
  onUpdateVideo2,
  onPatchVideo,
  onComplete,
}) => {
  const [video1, setVideo1] = useState<LoadedVideoItem | null>(initialVideo1);
  const [video2, setVideo2] = useState<LoadedVideoItem | null>(initialVideo2);
  const [loadingAudio1, setLoadingAudio1] = useState(false);
  const [loadingAudio2, setLoadingAudio2] = useState(false);
  const [loadingMeta1, setLoadingMeta1] = useState(false);
  const [loadingMeta2, setLoadingMeta2] = useState(false);

  const fileInputRef1 = useRef<HTMLInputElement>(null);
  const fileInputRef2 = useRef<HTMLInputElement>(null);
  const probeHostRef = useRef<HTMLDivElement>(null);
  const pickingRef = useRef<boolean>(false);
  const isMountedRef = useRef<boolean>(true);
  const activeBlobUrlsRef = useRef<{ 1?: string; 2?: string }>({
    1: initialVideo1?.url,
    2: initialVideo2?.url,
  });

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  /**
   * 安全合并通道异步字段：即使组件已卸载推进至下一步，仍通过 onPatchVideo 将元信息与音轨注入 App 状态
   */
  const applyChannelPatch = (
    index: 1 | 2,
    url: string,
    patch: Partial<LoadedVideoItem>
  ) => {
    onPatchVideo?.(index, url, patch);
    if (!isMountedRef.current) return;
    const setLocal = index === 1 ? setVideo1 : setVideo2;
    setLocal((prev) => (prev && prev.url === url ? { ...prev, ...patch } : prev));
  };

  const setChannelLoading = (
    index: 1 | 2,
    kind: 'meta' | 'audio',
    loading: boolean
  ) => {
    if (!isMountedRef.current) return;
    if (kind === 'meta') {
      if (index === 1) setLoadingMeta1(loading);
      else setLoadingMeta2(loading);
    } else {
      if (index === 1) setLoadingAudio1(loading);
      else setLoadingAudio2(loading);
    }
  };

  /**
   * 构造通道默认几何参数
   */
  const createDefaultGeometry = (): VideoGeometryConfig => ({
    mirror: false,
    triLine: {
      model: 'two-horizontal-one-vertical',
      twoHOneV: { yA: 0.22, yB: 0.78, x0: 0.5 },
      twoVOneH: { xA: 0.38, xB: 0.62, y0: 0.85 },
    },
  });

  /**
   * 通道换片时释放旧 URL 占用的资源：blob 对象 URL 撤销 + PCM 注册表条目清除。
   * （原生代理 URL 无需 revoke，但其 PCM 注册表条目最高数十 MB，必须显式释放）
   */
  const releasePreviousChannelUrl = (index: 1 | 2, nextUrl: string) => {
    const prevUrl = activeBlobUrlsRef.current[index];
    if (prevUrl && prevUrl !== nextUrl) {
      if (prevUrl.startsWith('blob:')) {
        URL.revokeObjectURL(prevUrl);
      }
      dropPcm(prevUrl);
    }
    activeBlobUrlsRef.current[index] = nextUrl;
  };

  /**
   * Android 原生通道选片：获取持久化 content:// URI、本地流式代理地址与流式音轨分析。
   * 原生 MediaMetadataRetriever 解析失败时字段为 0（未知），此处复用 Web 探测器
   * 经本地流式代理二次探测，杜绝假 1920×1080 默认值污染几何标定数学。
   */
  const handleNativePick = async (index: 1 | 2) => {
    if (pickingRef.current) return;
    pickingRef.current = true;
    try {
      const picked = await NativeMedia.pickVideo({ channel: index });
      if (!picked || picked.canceled || !picked.uri || !picked.streamUrl) {
        return;
      }

      const url = picked.streamUrl;
      releasePreviousChannelUrl(index, url);
      const baseItem: LoadedVideoItem = {
        nativeUri: picked.uri,
        url,
        name: picked.name || `视频${index}.mp4`,
        duration: picked.duration && picked.duration > 0 ? picked.duration : 0,
        spatialTouched: false,
        audioAnchorTouched: false,
        width: picked.width && picked.width > 0 ? picked.width : 0,
        height: picked.height && picked.height > 0 ? picked.height : 0,
        geometry: createDefaultGeometry(),
      };

      if (index === 1) {
        setVideo1(baseItem);
        onUpdateVideo1?.(baseItem);
      } else {
        setVideo2(baseItem);
        onUpdateVideo2?.(baseItem);
      }

      // 元数据缺字段（原生解析失败回退 0）时经代理流二次探测补齐
      if (baseItem.duration <= 0 || baseItem.width <= 0 || baseItem.height <= 0) {
        setChannelLoading(index, 'meta', true);
        const meta = await probeVideoMetadata(url, probeHostRef.current);
        applyChannelPatch(index, url, {
          width: meta.width > 0 ? meta.width : baseItem.width,
          height: meta.height > 0 ? meta.height : baseItem.height,
          duration: meta.duration > 0 ? meta.duration : baseItem.duration,
        });
        setChannelLoading(index, 'meta', false);
      }

      setChannelLoading(index, 'audio', true);
      let resolvedDuration = baseItem.duration;

      try {
        const audioRes = await NativeMedia.extractAudioAnalysis({ uri: picked.uri });

        if (audioRes.hasAudio && audioRes.pcmUrl) {
          const decoded = await decodeAudioFromNativePcmUrl(
            audioRes.pcmUrl,
            audioRes.sampleRate,
            audioRes.duration || resolvedDuration
          );
          const finalDur = decoded.duration || resolvedDuration;
          resolvedDuration = finalDur;
          // PCM 移入模块级注册表，避免数十 MB 数据常驻 React 状态
          putPcm(url, decoded.rawChannelData);
          const updatedAudio: VideoAudioInfo = {
            duration: finalDur,
            sampleRate: decoded.sampleRate,
            hasAudioTrack: true,
            audioDegraded: false,
            // 超过原生 10 分钟提取上限：BPM/波形来自真实片段（非占位），但显式
            // 标记截断，UI 据此提示“测速仅覆盖前 10 分钟”
            audioTruncated: Boolean(audioRes.truncated),
            detectedBpm: decoded.detectedBpm,
            userBpm: decoded.detectedBpm,
            anchorTime: Math.min(1.0, Math.max(0.25, finalDur / 4)),
            waveform: decoded.waveform,
            trimRange: { start: 0, end: finalDur },
          };
          applyChannelPatch(index, url, { audioInfo: updatedAudio, duration: finalDur });
        } else {
          // 原生侧确认无音轨（或提取被截断降级），显式标记占位 BPM
          const fallback = buildDegradedAudioInfo(resolvedDuration);
          applyChannelPatch(index, url, { audioInfo: fallback });
        }
        setChannelLoading(index, 'audio', false);
      } catch {
        const fallback = buildDegradedAudioInfo(resolvedDuration);
        applyChannelPatch(index, url, { audioInfo: fallback });
        setChannelLoading(index, 'audio', false);
      }
    } finally {
      pickingRef.current = false;
    }
  };

  /**
   * Web 端读取用户选择的本地视频文件
   * 采用「乐观即时挂载 + 异步元数据/音轨并行探测」策略，消除老旧内核卡死与因果倒置
   */
  const handleFileChange = async (
    e: React.ChangeEvent<HTMLInputElement>,
    index: 1 | 2
  ) => {
    const file = e.target.files?.[0];
    // 清空 input 避免重选同一文件不触发 change 事件
    e.target.value = '';
    if (!file) return;

    const url = URL.createObjectURL(file);
    releasePreviousChannelUrl(index, url);

    // 1. 乐观即时挂载：一旦拿到 File 对象立即更新卡片 UI，消除界面假死与「未载入」停滞
    //    未知字段一律用 0 哨兵（不再使用 10/1920 魔法占位）
    const baseItem: LoadedVideoItem = {
      file,
      url,
      name: file.name,
      duration: 0,
      spatialTouched: false,
      audioAnchorTouched: false,
      width: 0,
      height: 0,
      geometry: createDefaultGeometry(),
    };

    if (index === 1) {
      setVideo1(baseItem);
      onUpdateVideo1?.(baseItem);
    } else {
      setVideo2(baseItem);
      onUpdateVideo2?.(baseItem);
    }
    setChannelLoading(index, 'meta', true);
    setChannelLoading(index, 'audio', true);

    // 2. 异步探测真实视频分辨率与时长（带超时与 DOM 挂载保底）
    const metaPromise = probeVideoMetadata(url, probeHostRef.current).then((meta) => {
      applyChannelPatch(index, url, {
        width: meta.width,
        height: meta.height,
        duration: meta.duration,
      });
      setChannelLoading(index, 'meta', false);
      return meta;
    });

    // 3. 异步解码音轨 PCM 并测算初始 BPM（超限/失败时显式降级，不静默伪造）
    const audioPromise = (async () => {
      const audioData = await decodeAudioFromFile(file);
      const meta = await metaPromise.catch(() => ({ duration: 0 }));
      const mergedDuration = audioData.duration || meta.duration || 0;

      if (audioData.hasAudioTrack && !audioData.audioDegraded) {
        putPcm(url, audioData.rawChannelData);
        const updatedAudio: VideoAudioInfo = {
          duration: mergedDuration,
          sampleRate: audioData.sampleRate,
          hasAudioTrack: true,
          audioDegraded: false,
          detectedBpm: audioData.detectedBpm,
          userBpm: audioData.detectedBpm,
          anchorTime: Math.min(1.0, Math.max(0.25, mergedDuration / 4)),
          waveform: audioData.waveform,
          trimRange: { start: 0, end: mergedDuration },
        };
        applyChannelPatch(index, url, {
          audioInfo: updatedAudio,
          duration: mergedDuration,
        });
      } else {
        const fallback = buildDegradedAudioInfo(mergedDuration);
        applyChannelPatch(index, url, { audioInfo: fallback, duration: mergedDuration });
      }
      setChannelLoading(index, 'audio', false);
    })();

    // 两条异步探测均已在内部自消化异常，此处使用 ES2015 Promise.all 即可兼容全系 WebView
    await Promise.all([metaPromise, audioPromise]);
  };

  /**
   * 渲染单个视频输入通道卡片
   */
  const renderChannelSlot = (
    index: 1 | 2,
    item: LoadedVideoItem | null,
    isLoadingAudio: boolean,
    isLoadingMeta: boolean,
    inputRef: React.RefObject<HTMLInputElement | null>
  ) => {
    const chCode = `视频${index}`;
    const badgeClass = index === 1 ? 'ch1' : 'ch2';
    const loadedClass = item ? (index === 1 ? 'loaded-ch1' : 'loaded-ch2') : '';
    const audio = item?.audioInfo;
    const degraded = Boolean(audio?.audioDegraded);
    const truncated = !degraded && Boolean(audio?.audioTruncated);

    return (
      <div
        onClick={() => {
          if (isNativeAndroid()) {
            void handleNativePick(index);
          } else {
            inputRef.current?.click();
          }
        }}
        className={`slot-card ${loadedClass}`}
      >
        {/* 通道卡片顶栏 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="control-group">
            <span className={`tag-badge ${badgeClass}`}>{chCode}</span>
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
              {item ? item.name : '选择本地视频'}
            </span>
          </div>
          <span className="mono-muted">
            {item ? '点击更换文件' : '未载入'}
          </span>
        </div>

        {/* 通道主体信息 */}
        {item ? (
          <div className="fx-col-12" style={{ display: 'flex', flexDirection: 'column', margin: 'auto 0' }}>
            <div className="fx-row-8" style={{ display: 'flex', alignItems: 'center' }}>
              <CheckCircle2
                size={16}
                color={index === 1 ? 'var(--ch1)' : 'var(--ch2)'}
                 style={{ flexShrink: 0 }}
              />
              <span
                style={{
                  fontSize: '14px',
                  fontWeight: 600,
                  color: 'var(--text-primary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {item.name}
              </span>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: '8px',
                backgroundColor: 'var(--bg-surface)',
                border: '1px solid var(--border)',
                borderRadius: '4px',
                padding: '10px 12px',
              }}
            >
              <div>
                <div className="mono-muted">分辨率</div>
                <div className="mono-num" style={{ marginTop: '2px', fontWeight: 600 }}>
                  {isLoadingMeta ? (
                    <span className="control-group fx-row-4" style={{ color: 'var(--text-muted)' }}>
                      <Loader2 size={12} className="spin" />
                      <span>探测中</span>
                    </span>
                  ) : item.width > 0 ? (
                    `${item.width}×${item.height}`
                  ) : (
                    <span className="mono-muted">未知</span>
                  )}
                </div>
              </div>
              <div>
                <div className="mono-muted">时长</div>
                <div className="mono-num" style={{ marginTop: '2px', fontWeight: 600 }}>
                  {isLoadingMeta ? (
                    <span className="control-group fx-row-4" style={{ color: 'var(--text-muted)' }}>
                      <Loader2 size={12} className="spin" />
                      <span>计算中</span>
                    </span>
                  ) : item.duration > 0 ? (
                    `${item.duration.toFixed(2)}s`
                  ) : (
                    <span className="mono-muted">未知</span>
                  )}
                </div>
              </div>
              <div>
                <div className="mono-muted">测算 BPM</div>
                <div className="mono-num" style={{ marginTop: '2px', fontWeight: 600 }}>
                  {isLoadingAudio ? (
                    <span className="control-group fx-row-4" style={{ color: 'var(--accent)' }}>
                      <Loader2 size={12} className="spin" />
                      <span>解析中</span>
                    </span>
                  ) : degraded ? (
                    <span
                      className="control-group fx-row-4"
                      style={{ color: 'var(--text-muted)' }}
                      title="音频解析失败或超限，BPM 为占位值：请在标定步骤手动输入或 TAP 测速"
                    >
                      <AlertTriangle size={12} />
                      <span>{audio?.detectedBpm ?? '--'} 占位</span>
                    </span>
                  ) : truncated ? (
                    <span
                      className="control-group fx-row-4"
                      style={{ color: 'var(--text-muted)' }}
                      title="音频超过原生提取安全上限，测速与波形仅基于前 10 分钟真实数据"
                    >
                      <AlertTriangle size={12} />
                      <span>{audio?.detectedBpm ?? '--'} 截断</span>
                    </span>
                  ) : (
                    `${item.audioInfo?.detectedBpm ?? '--'} BPM`
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div
            className="fx-col-8"
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              margin: 'auto 0',
              color: 'var(--text-secondary)',
            }}
          >
            <Upload size={24} strokeWidth={1.6} />
            <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-primary)' }}>
              点击载入本地视频
            </div>
            <div className="mono-muted">MP4 / MOV / WEBM</div>
          </div>
        )}

        {/* 通道底栏 */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            borderTop: '1px solid var(--border)',
            paddingTop: '10px',
          }}
        >
          <span className="mono-muted">
            <Film size={12} style={{ verticalAlign: '-2px', marginRight: '4px' }} />
            {item ? '信号已就绪' : '等待视频源'}
          </span>
          <span className="mono-muted">
            {item ? (item.geometry.mirror ? '镜像: 开' : '镜像: 关') : '--'}
          </span>
        </div>
      </div>
    );
  };

  const isReady = Boolean(video1 && video2);

  return (
    <div className="import-stage">
      {/* 隐藏文件输入挂载于网格之外，避免破坏子元素邻接间距；单类型 video/* 兼容老旧国产 ROM 文件选择器 */}
      <input
        ref={fileInputRef1}
        type="file"
        accept="video/*"
        style={{ display: 'none' }}
        onChange={(e) => handleFileChange(e, 1)}
      />
      <input
        ref={fileInputRef2}
        type="file"
        accept="video/*"
        style={{ display: 'none' }}
        onChange={(e) => handleFileChange(e, 2)}
      />

      {/* 隐藏的 DOM 挂载容器，用于唤醒移动端老旧内核的媒体加载流水线 */}
      <div
        ref={probeHostRef}
        aria-hidden="true"
        style={{
          position: 'absolute',
          width: 0,
          height: 0,
          overflow: 'hidden',
          opacity: 0,
          pointerEvents: 'none',
        }}
      />

      <div className="slot-grid">
        {renderChannelSlot(1, video1, loadingAudio1, loadingMeta1, fileInputRef1)}
        {renderChannelSlot(2, video2, loadingAudio2, loadingMeta2, fileInputRef2)}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center' }}>
        <button
          type="button"
          className="btn btn-accent"
          disabled={!isReady}
          onClick={() => {
            if (video1 && video2) {
              onComplete({ video1, video2 });
            }
          }}
          style={{ height: '34px', padding: '0 16px', fontSize: '13px' }}
        >
          <span>开始标定</span>
          <ArrowRight size={15} />
        </button>
      </div>
    </div>
  );
};
