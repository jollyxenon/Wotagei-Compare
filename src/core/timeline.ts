/**
 * 统一时间轴映射、速率比换算与交集重叠区间计算核心算法
 */

import type {
  BpmAlignStrategy,
  SlowMotionRate,
  TimeInterval,
} from '../types/timeline.ts';
import { DEFAULT_BPM } from '../types/timeline.ts';

export interface VideoTimelineParams {
  duration: number; // 视频时长 (秒)
  bpm: number; // 视频当前 BPM
  anchorTime: number; // 对拍锚点 (秒)
  trimRange?: TimeInterval; // 可选的有效截取区间 (秒)，未指定时默认 [0, duration]
}

export interface UnifiedTimelineResult {
  rate1: number; // 视频 1 相对速率比
  rate2: number; // 视频 2 相对速率比
  effectiveBpm: number; // 对齐后的有效基准 BPM
  hasOverlap: boolean; // 两视频有效区间是否存在真实重叠（false 时 intersectInterval 为零宽，禁止播放/导出）
  intersectInterval: TimeInterval; // 统一时间轴有效重叠交集区间 (秒)；无重叠时 start === end
  span1: TimeInterval; // 视频 1 在统一时间轴上的区间
  span2: TimeInterval; // 视频 2 在统一时间轴上的区间
}

/**
 * 根据双方 BPM 与对齐策略计算各自的速率比及统一时间轴交集区间
 */
export function calculateUnifiedTimeline(
  params1: VideoTimelineParams,
  params2: VideoTimelineParams,
  strategy: BpmAlignStrategy,
  customTargetBpm?: number
): UnifiedTimelineResult {
  const bpm1 = Math.max(1, params1.bpm || DEFAULT_BPM);
  const bpm2 = Math.max(1, params2.bpm || DEFAULT_BPM);

  let rate1 = 1;
  let rate2 = 1;
  let effectiveBpm = bpm1;

  if (strategy === 'left') {
    rate1 = 1;
    rate2 = bpm1 / bpm2;
    effectiveBpm = bpm1;
  } else if (strategy === 'right') {
    rate1 = bpm2 / bpm1;
    rate2 = 1;
    effectiveBpm = bpm2;
  } else if (strategy === 'custom') {
    const target = customTargetBpm && customTargetBpm > 0 ? customTargetBpm : bpm1;
    rate1 = target / bpm1;
    rate2 = target / bpm2;
    effectiveBpm = target;
  } else {
    // 'none' 不对齐 BPM，各自速率比为 1
    rate1 = 1;
    rate2 = 1;
    effectiveBpm = bpm1;
  }

  // 获取两视频的有效截取区间（未设定时默认全片 0 ~ duration）
  const trim1 = params1.trimRange || { start: 0, end: params1.duration };
  const trim2 = params2.trimRange || { start: 0, end: params2.duration };

  // 映射到以各自锚点为 0 的统一时间轴区间 [start, end]
  const start1 = (trim1.start - params1.anchorTime) / rate1;
  const end1 = (trim1.end - params1.anchorTime) / rate1;

  const start2 = (trim2.start - params2.anchorTime) / rate2;
  const end2 = (trim2.end - params2.anchorTime) / rate2;

  // 真实重叠交集：无重叠时输出零宽区间并显式标记 hasOverlap = false，
  // 由调用方（对比台/导出页）阻断播放与导出，绝不虚构最小区间。
  const intersectStart = Math.max(start1, start2);
  const rawIntersectEnd = Math.min(end1, end2);
  const hasOverlap = rawIntersectEnd > intersectStart;
  const intersectEnd = hasOverlap ? rawIntersectEnd : intersectStart;

  return {
    rate1,
    rate2,
    effectiveBpm,
    hasOverlap,
    intersectInterval: { start: intersectStart, end: intersectEnd },
    span1: { start: start1, end: end1 },
    span2: { start: start2, end: end2 },
  };
}

/**
 * 根据统一时间轴偏移 tau (秒) 获取源视频实际时间戳 (秒)
 * @param tau 统一时间轴偏移时间 (以锚点为 0)
 * @param anchorTime 源视频锚点时间戳
 * @param rate 相对速率比
 */
export function mapTauToSourceTime(
  tau: number,
  anchorTime: number,
  rate: number
): number {
  return anchorTime + tau * rate;
}

/**
 * 根据源视频时间戳获取统一时间轴偏移 tau (秒)
 */
export function mapSourceTimeToTau(
  sourceTime: number,
  anchorTime: number,
  rate: number
): number {
  return rate !== 0 ? (sourceTime - anchorTime) / rate : 0;
}

/**
 * 判断当前统一时间 tau 是否处于视频的有效区间内
 */
export function isTauInVideoRange(
  tau: number,
  span: TimeInterval
): boolean {
  return tau >= span.start && tau <= span.end;
}

/**
 * 计算实际播放时的各视频倍速
 * @param slowMotionRate 用户选择的慢放倍速 (如 0.1, 0.5)
 * @param videoRate 视频的相对速率比 (rate1 或 rate2)
 */
export function getPlaybackRate(
  slowMotionRate: SlowMotionRate,
  videoRate: number
): number {
  return slowMotionRate * videoRate;
}
