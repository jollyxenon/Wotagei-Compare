package com.wotagei.compare;

import android.content.Context;
import android.media.AudioFormat;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.net.Uri;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * 原生流式音频解码与降采样提取器
 * 通过 MediaExtractor + MediaCodec 逐帧解码并实时混单声道降采样至 16kHz Int16，
 * 避免在 WebView 内存中加载整部高清视频，突破 80MB 大视频音频解析限制。
 *
 * 错误语义：解码失败时向上抛出异常（由插件层 reject 回前端），
 * 不再吞掉异常伪装成“无音轨”；达到时长安全上限时通过 truncated 显式标记，
 * 前端可据此提示用户 BPM/波形仅基于截取片段。
 */
public class NativeAudioExtractor {
    public static final int TARGET_SAMPLE_RATE = 16000;
    private static final int MAX_OUT_SAMPLES = TARGET_SAMPLE_RATE * 600; // 安全上限 10 分钟

    public static class ExtractionResult {
        public final boolean hasAudio;
        public final boolean truncated; // true = 达到安全上限，仅完成前 10 分钟提取
        public final int sampleRate;
        public final double durationSec;
        public final byte[] pcmInt16Le;

        public ExtractionResult(
            boolean hasAudio,
            boolean truncated,
            int sampleRate,
            double durationSec,
            byte[] pcmInt16Le
        ) {
            this.hasAudio = hasAudio;
            this.truncated = truncated;
            this.sampleRate = sampleRate;
            this.durationSec = durationSec;
            this.pcmInt16Le = pcmInt16Le;
        }
    }

    /**
     * 从任意大小视频 URI 流式提取 16kHz 单声道 Int16 小端 PCM
     * 解码失败时抛出异常，交由调用方显式处理。
     */
    public static ExtractionResult extractMonoPcm(Context context, Uri uri) throws IOException {
        MediaExtractor extractor = new MediaExtractor();
        MediaCodec decoder = null;
        try {
            extractor.setDataSource(context, uri, null);

            int audioTrackIdx = -1;
            MediaFormat audioFormat = null;
            int trackCount = extractor.getTrackCount();
            for (int i = 0; i < trackCount; i++) {
                MediaFormat fmt = extractor.getTrackFormat(i);
                String mime = fmt.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("audio/")) {
                    audioTrackIdx = i;
                    audioFormat = fmt;
                    break;
                }
            }

            if (audioTrackIdx < 0 || audioFormat == null) {
                // 确无音频轨是合法结果，返回空数据（hasAudio = false）
                return new ExtractionResult(false, false, TARGET_SAMPLE_RATE, 0.0, new byte[0]);
            }

            extractor.selectTrack(audioTrackIdx);
            String mime = audioFormat.getString(MediaFormat.KEY_MIME);
            if (mime == null) {
                return new ExtractionResult(false, false, TARGET_SAMPLE_RATE, 0.0, new byte[0]);
            }

            double durationSec = 0.0;
            if (audioFormat.containsKey(MediaFormat.KEY_DURATION)) {
                durationSec = audioFormat.getLong(MediaFormat.KEY_DURATION) / 1_000_000.0;
            }

            int srcSampleRate = audioFormat.containsKey(MediaFormat.KEY_SAMPLE_RATE)
                ? audioFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                : 44100;
            int srcChannels = audioFormat.containsKey(MediaFormat.KEY_CHANNEL_COUNT)
                ? audioFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
                : 1;
            boolean isFloatPcm = false;
            if (audioFormat.containsKey("pcm-encoding")) {
                isFloatPcm = audioFormat.getInteger("pcm-encoding") == AudioFormat.ENCODING_PCM_FLOAT;
            }

            decoder = MediaCodec.createDecoderByType(mime);
            decoder.configure(audioFormat, null, null, 0);
            decoder.start();

            ByteArrayOutputStream outBytes = new ByteArrayOutputStream(262144);
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();

            boolean inputDone = false;
            boolean outputDone = false;
            boolean truncated = false;
            int outSamplesCount = 0;

            // 降采样窗口状态：以输出采样点为中心的盒式滤波（box filter），
            // 窗宽 = 源/目标采样率之比。相比逐点线性插值，先做窗口平均可衰减
            // 高频能量，避免 44.1k/48k → 16k 折叠混叠污染节奏起音检测。
            final double step = (double) srcSampleRate / (double) TARGET_SAMPLE_RATE;
            final int halfWindow = Math.max(1, (int) Math.round(step / 2.0));

            // 逐块解码 PCM 并降采样写出（原始 float 数组，避免逐采样装箱的 GC 压力）
            float[] monoBlock = new float[0];

            while (!outputDone && outSamplesCount < MAX_OUT_SAMPLES) {
                // 1. 喂入压缩音频包
                if (!inputDone) {
                    int inIdx = decoder.dequeueInputBuffer(10000);
                    if (inIdx >= 0) {
                        ByteBuffer inBuf = decoder.getInputBuffer(inIdx);
                        if (inBuf != null) {
                            int sampleSize = extractor.readSampleData(inBuf, 0);
                            if (sampleSize < 0) {
                                decoder.queueInputBuffer(
                                    inIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM
                                );
                                inputDone = true;
                            } else {
                                long pts = extractor.getSampleTime();
                                decoder.queueInputBuffer(inIdx, 0, sampleSize, pts, 0);
                                extractor.advance();
                            }
                        }
                    }
                }

                // 2. 取出解码后 PCM：混单声道后做窗口平均降采样至 16kHz Int16
                int outIdx = decoder.dequeueOutputBuffer(info, 10000);
                if (outIdx >= 0) {
                    if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                        outputDone = true;
                    }

                    ByteBuffer outBuf = decoder.getOutputBuffer(outIdx);
                    if (outBuf != null && info.size > 0) {
                        outBuf.position(info.offset);
                        outBuf.limit(info.offset + info.size);
                        ByteBuffer leBuf = outBuf.slice().order(ByteOrder.LITTLE_ENDIAN);

                        int bytesPerSample = isFloatPcm ? 4 : 2;
                        int frameBytes = bytesPerSample * Math.max(1, srcChannels);
                        int frameCount = info.size / frameBytes;

                        if (monoBlock.length < frameCount) {
                            monoBlock = new float[Math.max(frameCount, 8192)];
                        }
                        for (int f = 0; f < frameCount; f++) {
                            double monoSum = 0.0;
                            for (int c = 0; c < srcChannels; c++) {
                                if (isFloatPcm) {
                                    monoSum += leBuf.getFloat();
                                } else {
                                    monoSum += leBuf.getShort() / 32768.0;
                                }
                            }
                            monoBlock[f] = (float) (monoSum / Math.max(1, srcChannels));
                        }

                        int base = outSamplesCount;
                        int blockFrames = frameCount;
                        // 输出采样 o 的中心在块内源坐标 = o*step - base*step（连续累积），
                        // 直接以块起点为基准计算窗口
                        int o = 0;
                        while (outSamplesCount < MAX_OUT_SAMPLES) {
                            double centerD = (base + o) * step;
                            int center = (int) Math.round(centerD);
                            int winStart = Math.max(0, center - halfWindow);
                            int winEnd = Math.min(blockFrames - 1, center + halfWindow);
                            if (winStart > center) winStart = center;
                            if (winEnd < center) winEnd = center;
                            double sum = 0.0;
                            int n = winEnd - winStart + 1;
                            for (int w = winStart; w <= winEnd; w++) {
                                sum += monoBlock[w];
                            }
                            double interp = n > 0 ? sum / n : 0.0;
                            int sVal = (int) Math.round(
                                Math.max(-1.0, Math.min(1.0, interp)) * 32767.0
                            );
                            outBytes.write(sVal & 0xff);
                            outBytes.write((sVal >> 8) & 0xff);
                            outSamplesCount++;
                            o++;
                            if (center + halfWindow >= blockFrames) {
                                break; // 窗口已越过块尾，交由下一块继续
                            }
                        }
                    }
                    decoder.releaseOutputBuffer(outIdx, false);
                } else if (outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat outFmt = decoder.getOutputFormat();
                    if (outFmt.containsKey(MediaFormat.KEY_SAMPLE_RATE)) {
                        srcSampleRate = outFmt.getInteger(MediaFormat.KEY_SAMPLE_RATE);
                    }
                    if (outFmt.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) {
                        srcChannels = outFmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
                    }
                    if (outFmt.containsKey("pcm-encoding")) {
                        isFloatPcm =
                            outFmt.getInteger("pcm-encoding") == AudioFormat.ENCODING_PCM_FLOAT;
                    }
                }
            }

            if (!outputDone && outSamplesCount >= MAX_OUT_SAMPLES) {
                truncated = true;
            }
            if (durationSec <= 0.0 && outSamplesCount > 0) {
                durationSec = (double) outSamplesCount / (double) TARGET_SAMPLE_RATE;
            }
            byte[] resultBytes = outBytes.toByteArray();
            return new ExtractionResult(
                resultBytes.length > 0, truncated, TARGET_SAMPLE_RATE, durationSec, resultBytes
            );
        } finally {
            if (decoder != null) {
                try {
                    decoder.stop();
                } catch (Exception ignored) {}
                try {
                    decoder.release();
                } catch (Exception ignored) {}
            }
            try {
                extractor.release();
            } catch (Exception ignored) {}
        }
    }
}
