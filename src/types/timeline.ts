/**
 * 时间轴映射、BPM 与音频控制契约
 */

/** 七档超慢放倍速 */
export type SlowMotionRate = 0.1 | 0.15 | 0.2 | 0.3 | 0.5 | 0.75 | 1.0;

/** 可选声音源 */
export type SoundSource = 'metronome' | 'video1' | 'video2' | 'mute';

/** BPM 对齐策略 */
export type BpmAlignStrategy = 'none' | 'left' | 'right' | 'custom';

/**
 * 全局兜底 BPM 常量：音频缺失或解析失败时的占位速度。
 * 集中定义以取代散落在 audio/组件/导出器各处的魔法数 160。
 */
export const DEFAULT_BPM = 160;

/** 单路视频的音频元数据与对拍锚点 */
export interface VideoAudioInfo {
  duration: number; // 视频总时长 (秒)
  sampleRate: number; // 音频采样率
  hasAudioTrack: boolean; // 源视频是否真实存在可解析的音频轨
  audioDegraded?: boolean; // true = 解析失败/超限降级，detectedBpm 与 waveform 均为占位数据
  audioTruncated?: boolean; // true = 原生提取达 10 分钟安全上限被截断：数据真实但仅覆盖前段
  detectedBpm: number; // 算法自动测算的 BPM（audioDegraded 时为 DEFAULT_BPM 占位）
  userBpm: number; // 用户确认或修改的 BPM
  anchorTime: number; // 对拍锚点时间戳 (秒)
  waveform: Float32Array; // 用于可视化展示的归一化波形峰值数据（audioDegraded 时为平直占位）
  trimRange?: TimeInterval; // 有效截取起止时间戳 (秒)
}

/** 统一时间轴映射配置 */
export interface TimelineConfig {
  strategy: BpmAlignStrategy;
  targetBpm: number;
  slowMotionRate: SlowMotionRate;
  soundSource: SoundSource;
}

/** 时间轴区间定义 */
export interface TimeInterval {
  start: number;
  end: number;
}
