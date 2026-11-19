package com.wotagei.compare;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.media.AudioFormat;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.view.Surface;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Android 原生全机型 GPU 零拷贝离线 MP4 合成导出引擎
 * 1. 双路 MediaExtractor + MediaCodec 顺序流式解码至 SurfaceTexture，慢放帧直接复用 GPU 纹理
 * 2. OpenGL ES 合成后通过 EGLExt.eglPresentationTimeANDROID 注入确定性时间戳喂入 H.264 硬编码器
 * 3. 音频流式离线合成（节拍器锁相数学合成 / 源视频流式重采样）编码 AAC 后与视频轨写入 MediaMuxer
 * 4. 直接持久化写入系统公开 Movies/WotageiCompare 目录并入库系统相册
 */
public class NativeOfflineExporter {
    public interface ProgressCallback {
        void onProgress(int currentFrame, int totalFrames, int percent, String statusText);
    }

    public static class ExportParams {
        public String mode; // "split-screen" | "overlay"
        public int width;
        public int height;
        public int fps;
        public double exportStartTau;
        public double exportEndTau;
        public double slowMotionRate;
        public double effectiveBpm;
        public String soundSource; // "metronome" | "video1" | "video2" | "mute"

        public Uri uri1;
        public double anchor1;
        public double rate1;
        public double span1Start;
        public double span1End;
        public NativeGlRenderer.VideoLayerSpec spec1;

        public Uri uri2;
        public double anchor2;
        public double rate2;
        public double span2Start;
        public double span2End;
        public NativeGlRenderer.VideoLayerSpec spec2;
    }

    public static class ExportResult {
        public final String savedPath;
        public final int width;
        public final int height;
        public final double durationSec;

        public ExportResult(String savedPath, int width, int height, double durationSec) {
            this.savedPath = savedPath;
            this.width = width;
            this.height = height;
            this.durationSec = durationSec;
        }
    }

    private static class PendingMuxPacket {
        final boolean isVideo;
        final ByteBuffer data;
        final MediaCodec.BufferInfo info;

        PendingMuxPacket(boolean isVideo, ByteBuffer src, MediaCodec.BufferInfo srcInfo) {
            this.isVideo = isVideo;
            this.data = ByteBuffer.allocateDirect(srcInfo.size);
            ByteBuffer dup = src.duplicate();
            dup.position(srcInfo.offset);
            dup.limit(srcInfo.offset + srcInfo.size);
            this.data.put(dup);
            this.data.flip();

            this.info = new MediaCodec.BufferInfo();
            this.info.set(0, srcInfo.size, srcInfo.presentationTimeUs, srcInfo.flags);
        }
    }

    /**
     * 顺序流式硬件视频解码器：每推进目标时间仅在跨越源帧时更新纹理，慢放复用当前 GPU 纹理
     */
    private static class SequentialVideoDecoder {
        private final MediaExtractor extractor = new MediaExtractor();
        private MediaCodec decoder;
        private final NativeGlRenderer.VideoTextureSlot slot;
        private boolean inputEos = false;
        private boolean outputEos = false;

        private int pendingOutIdx = -1;
        private long pendingPtsUs = -1L;
        private long currentRenderedPtsUs = -1L;

        SequentialVideoDecoder(Context context, Uri uri, NativeGlRenderer.VideoTextureSlot slot) throws IOException {
            this.slot = slot;
            extractor.setDataSource(context, uri, null);

            int videoTrack = -1;
            MediaFormat format = null;
            for (int i = 0; i < extractor.getTrackCount(); i++) {
                MediaFormat f = extractor.getTrackFormat(i);
                String mime = f.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("video/")) {
                    videoTrack = i;
                    format = f;
                    break;
                }
            }
            if (videoTrack < 0 || format == null) {
                throw new IOException("视频文件缺少有效视频轨道: " + uri);
            }
            extractor.selectTrack(videoTrack);
            String mime = format.getString(MediaFormat.KEY_MIME);
            decoder = MediaCodec.createDecoderByType(mime);
            decoder.configure(format, slot.surface, null, 0);
            decoder.start();
        }

        void prepareAtSourceTime(double startSourceSec) {
            long startUs = Math.max(0L, Math.round(startSourceSec * 1_000_000.0));
            extractor.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC);
            advanceAndRenderForTargetUs(startUs, true);
        }

        void advanceToSourceTime(double targetSourceSec) {
            long targetUs = Math.max(0L, Math.round(targetSourceSec * 1_000_000.0));
            // 容差约 12ms，未越过待显示下一帧时直接复用当前 GPU 纹理
            if (slot.hasFrame && (outputEos || (pendingOutIdx >= 0 && pendingPtsUs > targetUs + 12000L))) {
                return;
            }
            advanceAndRenderForTargetUs(targetUs, false);
        }

        private void advanceAndRenderForTargetUs(long targetUs, boolean forceFirstFrame) {
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            int bestIdx = -1;
            long bestPts = -1L;

            if (pendingOutIdx >= 0) {
                if (pendingPtsUs <= targetUs + 12000L || (forceFirstFrame && !slot.hasFrame)) {
                    bestIdx = pendingOutIdx;
                    bestPts = pendingPtsUs;
                    pendingOutIdx = -1;
                    pendingPtsUs = -1L;
                } else {
                    return;
                }
            }

            int idleLoops = 0;
            while (!outputEos && idleLoops < 400) {
                if (!inputEos) {
                    int inIdx = decoder.dequeueInputBuffer(5000);
                    if (inIdx >= 0) {
                        ByteBuffer inBuf = decoder.getInputBuffer(inIdx);
                        if (inBuf != null) {
                            int sz = extractor.readSampleData(inBuf, 0);
                            if (sz < 0) {
                                decoder.queueInputBuffer(inIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                                inputEos = true;
                            } else {
                                long pts = extractor.getSampleTime();
                                decoder.queueInputBuffer(inIdx, 0, sz, pts, 0);
                                extractor.advance();
                            }
                        }
                    }
                }

                int outIdx = decoder.dequeueOutputBuffer(info, 5000);
                if (outIdx >= 0) {
                    idleLoops = 0;
                    boolean eos = (info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
                    if (eos) {
                        outputEos = true;
                    }

                    if (info.size > 0) {
                        long pts = info.presentationTimeUs;
                        if (pts <= targetUs + 12000L || (bestIdx < 0 && !slot.hasFrame && forceFirstFrame)) {
                            if (bestIdx >= 0) {
                                decoder.releaseOutputBuffer(bestIdx, false);
                            }
                            bestIdx = outIdx;
                            bestPts = pts;
                        } else {
                            // 这帧已经领先于目标时间，留给后面输出帧复用
                            pendingOutIdx = outIdx;
                            pendingPtsUs = pts;
                            break;
                        }
                    } else {
                        decoder.releaseOutputBuffer(outIdx, false);
                    }

                    if (eos) {
                        break;
                    }
                } else if (outIdx == MediaCodec.INFO_TRY_AGAIN_LATER) {
                    idleLoops++;
                }
            }

            if (bestIdx >= 0) {
                slot.resetLatch();
                decoder.releaseOutputBuffer(bestIdx, true);
                slot.awaitNewImage(1000);
                currentRenderedPtsUs = bestPts;
            }
        }

        void release() {
            if (decoder != null) {
                if (pendingOutIdx >= 0) {
                    try { decoder.releaseOutputBuffer(pendingOutIdx, false); } catch (Exception ignored) {}
                    pendingOutIdx = -1;
                }
                try { decoder.stop(); } catch (Exception ignored) {}
                try { decoder.release(); } catch (Exception ignored) {}
                decoder = null;
            }
            try { extractor.release(); } catch (Exception ignored) {}
        }
    }

    /**
     * 顺序流式音频源采样读取器（用于 CH1 / CH2 原声导出，按单调递增源时间重采样输出）
     */
    private static class SequentialAudioSourceReader {
        private final MediaExtractor extractor = new MediaExtractor();
        private MediaCodec decoder;
        private final boolean hasTrack;
        private int srcSampleRate = 44100;
        private int srcChannels = 1;
        private boolean isFloatPcm = false;
        private boolean inputEos = false;
        private boolean outputEos = false;

        // 环形小窗口缓冲（保存当前与未来约数秒单声道 float 采样）
        private float[] chunkBuf = new float[0];
        private int chunkLen = 0;
        private int chunkHeadIdx = 0;
        private long chunkStartSampleIndex = 0;
        private boolean firstAudioPtsCaptured = false;
        private double baseAudioOffsetSec = 0.0;

        SequentialAudioSourceReader(Context context, Uri uri) {
            boolean ok = false;
            try {
                extractor.setDataSource(context, uri, null);
                for (int i = 0; i < extractor.getTrackCount(); i++) {
                    MediaFormat f = extractor.getTrackFormat(i);
                    String mime = f.getString(MediaFormat.KEY_MIME);
                    if (mime != null && mime.startsWith("audio/")) {
                        extractor.selectTrack(i);
                        if (f.containsKey(MediaFormat.KEY_SAMPLE_RATE)) {
                            srcSampleRate = f.getInteger(MediaFormat.KEY_SAMPLE_RATE);
                        }
                        if (f.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) {
                            srcChannels = f.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
                        }
                        if (f.containsKey("pcm-encoding")) {
                            isFloatPcm = f.getInteger("pcm-encoding") == AudioFormat.ENCODING_PCM_FLOAT;
                        }
                        decoder = MediaCodec.createDecoderByType(mime);
                        decoder.configure(f, null, null, 0);
                        decoder.start();
                        ok = true;
                        break;
                    }
                }
            } catch (Exception ignored) {
                ok = false;
            }
            this.hasTrack = ok;
        }

        boolean isValid() {
            return hasTrack && decoder != null;
        }

        void seekToSourceTime(double startSourceSec) {
            if (!isValid()) return;
            long us = Math.max(0L, Math.round(startSourceSec * 1_000_000.0));
            extractor.seekTo(us, MediaExtractor.SEEK_TO_PREVIOUS_SYNC);
            chunkLen = 0;
            chunkHeadIdx = 0;
            firstAudioPtsCaptured = false;
        }

        float sampleAt(double sourceTimeSec) {
            if (!isValid() || sourceTimeSec < 0) return 0f;
            if (!firstAudioPtsCaptured) {
                fillBuffer();
                if (!firstAudioPtsCaptured) return 0f;
            }

            double relSec = sourceTimeSec - baseAudioOffsetSec;
            if (relSec < 0) return 0f;

            double exactIdx = relSec * srcSampleRate;
            long idx0 = (long) Math.floor(exactIdx);
            double frac = exactIdx - idx0;

            while ((idx0 + 1) >= (chunkStartSampleIndex + chunkLen) && !outputEos) {
                if (!fillBuffer()) break;
            }

            long availableStart = chunkStartSampleIndex + chunkHeadIdx;
            if (idx0 < availableStart) {
                return 0f;
            }
            int rel0 = (int) (idx0 - chunkStartSampleIndex);
            if (rel0 >= chunkLen) {
                return 0f;
            }
            float s0 = chunkBuf[rel0];
            float s1 = (rel0 + 1 < chunkLen) ? chunkBuf[rel0 + 1] : s0;

            // 安全推进可读头指针，释放已经消费过的历史采样点
            if (rel0 > 4096) {
                int drop = rel0 - 1024;
                int remain = chunkLen - drop;
                System.arraycopy(chunkBuf, drop, chunkBuf, 0, remain);
                chunkLen = remain;
                chunkHeadIdx = 0;
                chunkStartSampleIndex += drop;
            }

            return (float) (s0 * (1.0 - frac) + s1 * frac);
        }

        private boolean fillBuffer() {
            if (outputEos || decoder == null) return false;
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            for (int iter = 0; iter < 60; iter++) {
                if (!inputEos) {
                    int inIdx = decoder.dequeueInputBuffer(5000);
                    if (inIdx >= 0) {
                        ByteBuffer inBuf = decoder.getInputBuffer(inIdx);
                        if (inBuf != null) {
                            int sz = extractor.readSampleData(inBuf, 0);
                            if (sz < 0) {
                                decoder.queueInputBuffer(inIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                                inputEos = true;
                            } else {
                                decoder.queueInputBuffer(inIdx, 0, sz, extractor.getSampleTime(), 0);
                                extractor.advance();
                            }
                        }
                    }
                }

                int outIdx = decoder.dequeueOutputBuffer(info, 5000);
                if (outIdx >= 0) {
                    if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                        outputEos = true;
                    }
                    ByteBuffer outBuf = decoder.getOutputBuffer(outIdx);
                    if (outBuf != null && info.size > 0) {
                        if (!firstAudioPtsCaptured) {
                            baseAudioOffsetSec = info.presentationTimeUs / 1_000_000.0;
                            chunkStartSampleIndex = 0;
                            firstAudioPtsCaptured = true;
                        }
                        outBuf.position(info.offset);
                        outBuf.limit(info.offset + info.size);
                        ByteBuffer le = outBuf.slice().order(ByteOrder.LITTLE_ENDIAN);
                        int bytesPerSample = isFloatPcm ? 4 : 2;
                        int frameBytes = bytesPerSample * Math.max(1, srcChannels);
                        int frames = info.size / frameBytes;
                        ensureCapacity(chunkLen + frames);
                        for (int f = 0; f < frames; f++) {
                            float sum = 0f;
                            for (int c = 0; c < srcChannels; c++) {
                                if (isFloatPcm) {
                                    sum += le.getFloat();
                                } else {
                                    sum += le.getShort() / 32768f;
                                }
                            }
                            chunkBuf[chunkLen++] = sum / Math.max(1, srcChannels);
                        }
                        decoder.releaseOutputBuffer(outIdx, false);
                        return true;
                    }
                    decoder.releaseOutputBuffer(outIdx, false);
                    if (outputEos) return false;
                } else if (outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat fmt = decoder.getOutputFormat();
                    if (fmt.containsKey(MediaFormat.KEY_SAMPLE_RATE)) {
                        srcSampleRate = fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE);
                    }
                    if (fmt.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) {
                        srcChannels = fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
                    }
                    if (fmt.containsKey("pcm-encoding")) {
                        isFloatPcm = fmt.getInteger("pcm-encoding") == AudioFormat.ENCODING_PCM_FLOAT;
                    }
                }
            }
            return false;
        }

        private void ensureCapacity(int needed) {
            if (chunkBuf.length < needed) {
                int newCap = Math.max(needed, chunkBuf.length * 2 + 8192);
                float[] next = new float[newCap];
                System.arraycopy(chunkBuf, 0, next, 0, chunkLen);
                chunkBuf = next;
            }
        }

        void release() {
            if (decoder != null) {
                try { decoder.stop(); } catch (Exception ignored) {}
                try { decoder.release(); } catch (Exception ignored) {}
                decoder = null;
            }
            try { extractor.release(); } catch (Exception ignored) {}
        }
    }

    /**
     * 离线执行 GPU 合成、音频混流与相册落盘
     */
    public static ExportResult export(
        Context context,
        ExportParams params,
        AtomicBoolean cancelFlag,
        ProgressCallback callback
    ) throws Exception {
        double exportDur = Math.max(0.1, params.exportEndTau - params.exportStartTau);
        double outputDurationSec = exportDur / params.slowMotionRate;
        int fps = params.fps > 0 ? params.fps : 30;
        int totalFrames = Math.max(1, (int) Math.round(outputDurationSec * fps));

        File tempMp4 = new File(context.getCacheDir(), "wotagei_export_" + System.currentTimeMillis() + ".mp4");
        MediaMuxer muxer = null;
        MediaCodec videoEncoder = null;
        MediaCodec audioEncoder = null;
        NativeGlRenderer glRenderer = null;
        SequentialVideoDecoder dec1 = null;
        SequentialVideoDecoder dec2 = null;
        SequentialAudioSourceReader srcAudioReader = null;

        int encWidth = params.width;
        int encHeight = params.height;

        try {
            // 1. 初始化 H.264 硬件编码器（失败时自动降档至 16 对齐安全分辨率 960x544）
            try {
                videoEncoder = configureVideoEncoder(encWidth, encHeight, fps, 5_000_000);
            } catch (Exception primaryEx) {
                if (videoEncoder != null) {
                    try { videoEncoder.release(); } catch (Exception ignored) {}
                }
                encWidth = 960;
                encHeight = 544;
                videoEncoder = configureVideoEncoder(encWidth, encHeight, fps, 3_500_000);
            }

            Surface inputSurface = videoEncoder.createInputSurface();
            videoEncoder.start();

            // 2. 初始化 EGL / OpenGL ES 双纹理合成器与双路流式硬解器
            glRenderer = new NativeGlRenderer(inputSurface, encWidth, encHeight);
            dec1 = new SequentialVideoDecoder(context, params.uri1, glRenderer.slot1);
            dec2 = new SequentialVideoDecoder(context, params.uri2, glRenderer.slot2);

            double startT1 = mapTauToSourceTime(params.exportStartTau, params.anchor1, params.rate1);
            double startT2 = mapTauToSourceTime(params.exportStartTau, params.anchor2, params.rate2);
            dec1.prepareAtSourceTime(Math.max(0.0, startT1));
            dec2.prepareAtSourceTime(Math.max(0.0, startT2));

            // 3. 初始化音频流水线（节拍器 / 单侧原声 / 静音）
            final int audioSampleRate = 44100;
            boolean hasAudioTrack = !"mute".equals(params.soundSource);
            double srcAudioAnchor = 0.0;
            double srcAudioRate = 1.0;

            if ("video1".equals(params.soundSource) || "video2".equals(params.soundSource)) {
                Uri audioUri = "video1".equals(params.soundSource) ? params.uri1 : params.uri2;
                srcAudioAnchor = "video1".equals(params.soundSource) ? params.anchor1 : params.anchor2;
                srcAudioRate = "video1".equals(params.soundSource) ? params.rate1 : params.rate2;
                srcAudioReader = new SequentialAudioSourceReader(context, audioUri);
                if (!srcAudioReader.isValid()) {
                    hasAudioTrack = false;
                } else {
                    double audioStartSrc = mapTauToSourceTime(params.exportStartTau, srcAudioAnchor, srcAudioRate);
                    srcAudioReader.seekToSourceTime(Math.max(0.0, audioStartSrc));
                }
            }

            if (hasAudioTrack) {
                try {
                    MediaFormat audioFmt = MediaFormat.createAudioFormat(
                        MediaFormat.MIMETYPE_AUDIO_AAC, audioSampleRate, 1
                    );
                    audioFmt.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC);
                    audioFmt.setInteger(MediaFormat.KEY_BIT_RATE, 128_000);
                    audioFmt.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384);
                    audioEncoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC);
                    audioEncoder.configure(audioFmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
                    audioEncoder.start();
                } catch (Exception aEx) {
                    hasAudioTrack = false;
                    if (audioEncoder != null) {
                        try { audioEncoder.release(); } catch (Exception ignored) {}
                        audioEncoder = null;
                    }
                }
            }

            // 预计算节拍器节拍序列。
            // 注意：此处脉冲包络/频率与前端 metronome.ts 保持同构设计，但限幅实现不同——
            // Java 侧用 tanh 软限幅（synthesizeAudioChunkBytes 尾部），Web 侧用
            // DynamicsCompressor 节点。两者听感相近，并非逐样本一致，跨端导出音色存在轻微差异。
            double beatIntervalTau = params.effectiveBpm > 0 ? (60.0 / params.effectiveBpm) : 0.5;
            int kStart = (int) Math.ceil(params.exportStartTau / beatIntervalTau - 1e-5);
            int kEnd = (int) Math.floor(params.exportEndTau / beatIntervalTau + 1e-5);

            // 4. 创建 Muxer 与 Pending 队列确保音视频轨都 Format Ready 后再启动写盘
            muxer = new MediaMuxer(tempMp4.getAbsolutePath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
            final int[] videoTrackIdx = {-1};
            final int[] audioTrackIdx = {-1};
            final boolean[] muxerStarted = {false};
            final List<PendingMuxPacket> pendingPackets = new ArrayList<>();

            long totalAudioSamples = hasAudioTrack ? Math.max(1L, Math.round(outputDurationSec * audioSampleRate)) : 0L;
            long audioSamplesFed = 0L;
            boolean audioInputDone = !hasAudioTrack;
            boolean audioOutputDone = !hasAudioTrack;
            boolean videoOutputDone = false;

            MediaCodec.BufferInfo vInfo = new MediaCodec.BufferInfo();
            MediaCodec.BufferInfo aInfo = new MediaCodec.BufferInfo();

            // 5. 主循环：逐帧 GPU 纹理渲染 + 流式喂入音频采样 + 交错写入 Muxer
            for (int frame = 0; frame < totalFrames; frame++) {
                if (cancelFlag.get()) {
                    throw new RuntimeException("用户已取消导出");
                }

                double currentTau = params.exportStartTau + ((double) frame / fps) * params.slowMotionRate;
                boolean v1Active = currentTau >= params.span1Start - 1e-4 && currentTau <= params.span1End + 1e-4;
                boolean v2Active = currentTau >= params.span2Start - 1e-4 && currentTau <= params.span2End + 1e-4;

                if (v1Active) {
                    double t1 = mapTauToSourceTime(currentTau, params.anchor1, params.rate1);
                    dec1.advanceToSourceTime(Math.max(0.0, t1));
                }
                if (v2Active) {
                    double t2 = mapTauToSourceTime(currentTau, params.anchor2, params.rate2);
                    dec2.advanceToSourceTime(Math.max(0.0, t2));
                }

                long ptsNs = Math.round(((double) frame / fps) * 1_000_000_000.0);
                glRenderer.renderAndSwap(params.mode, v1Active, params.spec1, v2Active, params.spec2, ptsNs);

                // 排空视频编码器输出
                drainEncoder(
                    videoEncoder, vInfo, true, muxer, videoTrackIdx, audioTrackIdx,
                    hasAudioTrack, muxerStarted, pendingPackets, false
                );

                // 推进同步时间窗的音频样本编码
                if (hasAudioTrack && !audioInputDone) {
                    long targetAudioByFrame = Math.min(
                        totalAudioSamples,
                        Math.round(((double) (frame + 1) / fps) * audioSampleRate)
                    );
                    while (audioSamplesFed < targetAudioByFrame) {
                        int inIdx = audioEncoder.dequeueInputBuffer(5000);
                        if (inIdx < 0) break;
                        ByteBuffer inBuf = audioEncoder.getInputBuffer(inIdx);
                        if (inBuf == null) break;
                        inBuf.clear();
                        int maxFramesInBuf = inBuf.remaining() / 2;
                        int chunk = (int) Math.min(1024, Math.min(maxFramesInBuf, totalAudioSamples - audioSamplesFed));
                        if (chunk <= 0) break;

                        byte[] pcmBytes = synthesizeAudioChunkBytes(
                            params, srcAudioReader, srcAudioAnchor, srcAudioRate,
                            beatIntervalTau, kStart, kEnd, audioSamplesFed, chunk, audioSampleRate
                        );
                        inBuf.put(pcmBytes);
                        long aPtsUs = Math.round(((double) audioSamplesFed / audioSampleRate) * 1_000_000.0);
                        audioSamplesFed += chunk;
                        int flags = (audioSamplesFed >= totalAudioSamples) ? MediaCodec.BUFFER_FLAG_END_OF_STREAM : 0;
                        if (flags != 0) audioInputDone = true;
                        audioEncoder.queueInputBuffer(inIdx, 0, pcmBytes.length, aPtsUs, flags);
                    }
                    audioOutputDone = drainEncoder(
                        audioEncoder, aInfo, false, muxer, videoTrackIdx, audioTrackIdx,
                        hasAudioTrack, muxerStarted, pendingPackets, false
                    );
                }

                if (frame % 5 == 0 || frame == totalFrames - 1) {
                    int pct = (int) Math.round(((double) (frame + 1) / totalFrames) * 95.0);
                    callback.onProgress(
                        frame + 1, totalFrames, pct,
                        "GPU 硬件离线合成中 (" + (frame + 1) + "/" + totalFrames + " 帧)..."
                    );
                }
            }

            // 6. 发送视频 EOS 并排空尾帧及剩余音频
            videoEncoder.signalEndOfInputStream();
            while (hasAudioTrack && !audioInputDone) {
                int inIdx = audioEncoder.dequeueInputBuffer(5000);
                if (inIdx >= 0) {
                    ByteBuffer inBuf = audioEncoder.getInputBuffer(inIdx);
                    int chunk = (int) Math.min(1024, totalAudioSamples - audioSamplesFed);
                    if (chunk <= 0 || inBuf == null) {
                        long aPtsUs = Math.round(((double) audioSamplesFed / audioSampleRate) * 1_000_000.0);
                        audioEncoder.queueInputBuffer(inIdx, 0, 0, aPtsUs, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                        audioInputDone = true;
                    } else {
                        inBuf.clear();
                        byte[] pcmBytes = synthesizeAudioChunkBytes(
                            params, srcAudioReader, srcAudioAnchor, srcAudioRate,
                            beatIntervalTau, kStart, kEnd, audioSamplesFed, chunk, audioSampleRate
                        );
                        inBuf.put(pcmBytes);
                        long aPtsUs = Math.round(((double) audioSamplesFed / audioSampleRate) * 1_000_000.0);
                        audioSamplesFed += chunk;
                        int flags = (audioSamplesFed >= totalAudioSamples) ? MediaCodec.BUFFER_FLAG_END_OF_STREAM : 0;
                        if (flags != 0) audioInputDone = true;
                        audioEncoder.queueInputBuffer(inIdx, 0, pcmBytes.length, aPtsUs, flags);
                    }
                }
                audioOutputDone = drainEncoder(
                    audioEncoder, aInfo, false, muxer, videoTrackIdx, audioTrackIdx,
                    hasAudioTrack, muxerStarted, pendingPackets, false
                );
            }

            int eosGuard = 0;
            while ((!videoOutputDone || !audioOutputDone) && eosGuard < 600) {
                if (cancelFlag.get()) {
                    throw new RuntimeException("用户已取消导出");
                }
                if (!videoOutputDone) {
                    videoOutputDone = drainEncoder(
                        videoEncoder, vInfo, true, muxer, videoTrackIdx, audioTrackIdx,
                        hasAudioTrack, muxerStarted, pendingPackets, true
                    );
                }
                if (hasAudioTrack && !audioOutputDone) {
                    audioOutputDone = drainEncoder(
                        audioEncoder, aInfo, false, muxer, videoTrackIdx, audioTrackIdx,
                        hasAudioTrack, muxerStarted, pendingPackets, true
                    );
                }
                eosGuard++;
            }

            // EOS 排空超时（编码器停滞约 3 秒仍未送出结束标志）必须显式失败：
            // 若继续 muxer.stop() 落盘，用户会拿到无声/断尾的“成功”导出残片。
            if (!videoOutputDone || (hasAudioTrack && !audioOutputDone)) {
                throw new IOException(
                    "硬件编码器排空超时，导出已中止（视频轨完成: " + videoOutputDone
                    + ", 音频轨完成: " + (!hasAudioTrack || audioOutputDone) + "）"
                );
            }

            if (muxerStarted[0]) {
                muxer.stop();
            }
            muxer.release();
            muxer = null;

            callback.onProgress(totalFrames, totalFrames, 98, "正在保存至系统相册...");
            String savedPath = saveToPublicMovies(context, tempMp4);
            callback.onProgress(totalFrames, totalFrames, 100, "导出完成！");

            return new ExportResult(savedPath, encWidth, encHeight, outputDurationSec);
        } finally {
            if (dec1 != null) dec1.release();
            if (dec2 != null) dec2.release();
            if (srcAudioReader != null) srcAudioReader.release();
            if (glRenderer != null) glRenderer.release();
            if (videoEncoder != null) {
                try { videoEncoder.stop(); } catch (Exception ignored) {}
                try { videoEncoder.release(); } catch (Exception ignored) {}
            }
            if (audioEncoder != null) {
                try { audioEncoder.stop(); } catch (Exception ignored) {}
                try { audioEncoder.release(); } catch (Exception ignored) {}
            }
            if (muxer != null) {
                try { muxer.release(); } catch (Exception ignored) {}
            }
            if (tempMp4.exists()) {
                //noinspection ResultOfMethodCallIgnored
                tempMp4.delete();
            }
        }
    }

    /**
     * 按给定参数配置（但不 start）H.264 硬件编码器。
     * start 必须推迟到 createInputSurface() 之后，故方法名不再谎称 "AndStart"。
     */
    private static MediaCodec configureVideoEncoder(int width, int height, int fps, int bitrate) throws IOException {
        MediaFormat fmt = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height);
        fmt.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
        fmt.setInteger(MediaFormat.KEY_BIT_RATE, bitrate);
        fmt.setInteger(MediaFormat.KEY_FRAME_RATE, fps);
        fmt.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2);
        MediaCodec enc = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
        enc.configure(fmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        return enc;
    }

    private static boolean drainEncoder(
        MediaCodec encoder,
        MediaCodec.BufferInfo info,
        boolean isVideo,
        MediaMuxer muxer,
        int[] videoTrackIdx,
        int[] audioTrackIdx,
        boolean hasAudioTrack,
        boolean[] muxerStarted,
        List<PendingMuxPacket> pendingPackets,
        boolean waitLonger
    ) {
        int timeoutUs = waitLonger ? 5000 : 0;
        while (true) {
            int outIdx = encoder.dequeueOutputBuffer(info, timeoutUs);
            if (outIdx == MediaCodec.INFO_TRY_AGAIN_LATER) {
                return false;
            } else if (outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                MediaFormat fmt = encoder.getOutputFormat();
                if (isVideo) {
                    if (videoTrackIdx[0] < 0) {
                        videoTrackIdx[0] = muxer.addTrack(fmt);
                    }
                } else {
                    if (audioTrackIdx[0] < 0) {
                        audioTrackIdx[0] = muxer.addTrack(fmt);
                    }
                }
                if (!muxerStarted[0] && videoTrackIdx[0] >= 0 && (!hasAudioTrack || audioTrackIdx[0] >= 0)) {
                    muxer.start();
                    muxerStarted[0] = true;
                    for (PendingMuxPacket p : pendingPackets) {
                        int tid = p.isVideo ? videoTrackIdx[0] : audioTrackIdx[0];
                        muxer.writeSampleData(tid, p.data, p.info);
                    }
                    pendingPackets.clear();
                }
            } else if (outIdx >= 0) {
                ByteBuffer outBuf = encoder.getOutputBuffer(outIdx);
                if (outBuf != null && (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0 && info.size > 0) {
                    outBuf.position(info.offset);
                    outBuf.limit(info.offset + info.size);
                    if (muxerStarted[0]) {
                        int tid = isVideo ? videoTrackIdx[0] : audioTrackIdx[0];
                        muxer.writeSampleData(tid, outBuf, info);
                    } else {
                        pendingPackets.add(new PendingMuxPacket(isVideo, outBuf, info));
                    }
                }
                boolean eos = (info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
                encoder.releaseOutputBuffer(outIdx, false);
                if (eos) {
                    return true;
                }
            }
        }
    }

    private static byte[] synthesizeAudioChunkBytes(
        ExportParams params,
        SequentialAudioSourceReader srcAudioReader,
        double srcAudioAnchor,
        double srcAudioRate,
        double beatIntervalTau,
        int kStart,
        int kEnd,
        long startSampleIdx,
        int sampleCount,
        int sampleRate
    ) {
        ByteBuffer buf = ByteBuffer.allocate(sampleCount * 2).order(ByteOrder.LITTLE_ENDIAN);
        boolean isMetronome = "metronome".equals(params.soundSource);

        for (int i = 0; i < sampleCount; i++) {
            long globalSample = startSampleIdx + i;
            double outTimeSec = (double) globalSample / sampleRate;
            float val = 0f;

            if (isMetronome) {
                // 扫描当前采样时间窗内的活跃拍点 (脉冲最长 65ms)
                double currentTau = params.exportStartTau + outTimeSec * params.slowMotionRate;
                int centerK = (int) Math.round(currentTau / beatIntervalTau);
                for (int k = Math.max(kStart, centerK - 2); k <= Math.min(kEnd, centerK + 1); k++) {
                    double tauBeat = k * beatIntervalTau;
                    double beatOutTime = (tauBeat - params.exportStartTau) / params.slowMotionRate;
                    double dt = outTimeSec - beatOutTime;
                    boolean isDownbeat = ((k % 4) + 4) % 4 == 0;
                    double maxDur = isDownbeat ? 0.065 : 0.050;
                    if (dt >= 0.0 && dt < maxDur) {
                        if (isDownbeat) {
                            double env = dt <= 0.010
                                ? 1.1
                                : 1.1 * Math.pow(0.001 / 1.1, (dt - 0.010) / 0.055);
                            double tri = triangleWave(1600.0 * dt);
                            double sin = Math.sin(2.0 * Math.PI * 800.0 * dt);
                            val += (float) ((tri + sin) * 0.55 * env);
                        } else {
                            double env = dt <= 0.006
                                ? 0.9
                                : 0.9 * Math.pow(0.001 / 0.9, (dt - 0.006) / 0.044);
                            double tri = triangleWave(1000.0 * dt);
                            val += (float) (tri * env);
                        }
                    }
                }
                // 软砖墙限幅压缩防止破音
                val = (float) Math.tanh(val * 1.15);
            } else if (srcAudioReader != null) {
                double currentTau = params.exportStartTau + outTimeSec * params.slowMotionRate;
                double srcTime = mapTauToSourceTime(currentTau, srcAudioAnchor, srcAudioRate);
                val = srcAudioReader.sampleAt(srcTime);
            }

            short s = (short) Math.round(Math.max(-1f, Math.min(1f, val)) * 32767f);
            buf.putShort(s);
        }
        return buf.array();
    }

    private static double triangleWave(double cycles) {
        double phase = cycles - Math.floor(cycles);
        return 4.0 * Math.abs(phase - 0.5) - 1.0;
    }

    /**
     * 将统一时间轴偏移 tau 换算为源视频绝对时间戳 (与 src/core/timeline.ts 严格同构)
     */
    static double mapTauToSourceTime(double tau, double anchorTime, double rate) {
        return anchorTime + tau * rate;
    }

    private static String saveToPublicMovies(Context context, File tempMp4) throws IOException {
        String fileName = "wotagei_compare_" + System.currentTimeMillis() + ".mp4";

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentResolver resolver = context.getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.Video.Media.DISPLAY_NAME, fileName);
            values.put(MediaStore.Video.Media.MIME_TYPE, "video/mp4");
            values.put(MediaStore.Video.Media.RELATIVE_PATH, Environment.DIRECTORY_MOVIES + "/WotageiCompare");
            values.put(MediaStore.Video.Media.IS_PENDING, 1);

            Uri itemUri = resolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values);
            if (itemUri == null) {
                throw new IOException("无法在系统相册创建视频记录");
            }
            try {
                try (InputStream in = new FileInputStream(tempMp4);
                     OutputStream out = resolver.openOutputStream(itemUri)) {
                    if (out == null) {
                        throw new IOException("无法打开相册输出流");
                    }
                    byte[] buf = new byte[65536];
                    int read;
                    while ((read = in.read(buf)) != -1) {
                        out.write(buf, 0, read);
                    }
                }
                ContentValues doneValues = new ContentValues();
                doneValues.put(MediaStore.Video.Media.IS_PENDING, 0);
                resolver.update(itemUri, doneValues, null, null);
                return Environment.DIRECTORY_MOVIES + "/WotageiCompare/" + fileName;
            } catch (Exception e) {
                // 写入中断时立即回滚删除 IS_PENDING 占位记录，防止相册留存损坏条目
                try {
                    resolver.delete(itemUri, null, null);
                } catch (Exception ignored) {}
                if (e instanceof IOException) {
                    throw (IOException) e;
                }
                throw new IOException("写入系统相册失败: " + e.getMessage(), e);
            }
        }

        // Android 6 ~ 9：写入公共 Movies/WotageiCompare 目录并通知媒体扫描
        File pubMovies = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES);
        File targetDir = new File(pubMovies, "WotageiCompare");
        if (!targetDir.exists()) {
            //noinspection ResultOfMethodCallIgnored
            targetDir.mkdirs();
        }
        File targetFile = new File(targetDir, fileName);
        try (InputStream in = new FileInputStream(tempMp4);
             OutputStream out = new FileOutputStream(targetFile)) {
            byte[] buf = new byte[65536];
            int read;
            while ((read = in.read(buf)) != -1) {
                out.write(buf, 0, read);
            }
        } catch (IOException pubEx) {
            // 若用户拒绝存储权限则安全回退至应用外部专属目录
            File appMovies = context.getExternalFilesDir(Environment.DIRECTORY_MOVIES);
            if (appMovies == null) appMovies = context.getFilesDir();
            targetFile = new File(appMovies, fileName);
            try (InputStream in = new FileInputStream(tempMp4);
                 OutputStream out = new FileOutputStream(targetFile)) {
                byte[] buf = new byte[65536];
                int read;
                while ((read = in.read(buf)) != -1) {
                    out.write(buf, 0, read);
                }
            }
        }

        MediaScannerConnection.scanFile(
            context,
            new String[] {targetFile.getAbsolutePath()},
            new String[] {"video/mp4"},
            null
        );
        return targetFile.getAbsolutePath();
    }
}
