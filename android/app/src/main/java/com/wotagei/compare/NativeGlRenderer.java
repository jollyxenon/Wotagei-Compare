package com.wotagei.compare;

import android.graphics.SurfaceTexture;
import android.opengl.EGL14;
import android.opengl.EGLConfig;
import android.opengl.EGLContext;
import android.opengl.EGLDisplay;
import android.opengl.EGLExt;
import android.opengl.EGLSurface;
import android.opengl.GLES11Ext;
import android.opengl.GLES20;
import android.opengl.Matrix;
import android.os.Handler;
import android.os.HandlerThread;
import android.view.Surface;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;

/**
 * 基于 EGL14 + OpenGL ES 2.0 的双路 SurfaceTexture 离线合成渲染器
 * 直接将硬件解码的 GPU OES 纹理按前端计算好的归一化布局矩形合成绘制到编码器 InputSurface。
 */
public class NativeGlRenderer {
    private static final int EGL_RECORDABLE_ANDROID = 0x3142;

    private static final String VERTEX_SHADER =
        "attribute vec4 aPosition;\n" +
        "attribute vec4 aTexCoord;\n" +
        "uniform mat4 uTexMatrix;\n" +
        "varying vec2 vTexCoord;\n" +
        "void main() {\n" +
        "  gl_Position = aPosition;\n" +
        "  vTexCoord = (uTexMatrix * aTexCoord).xy;\n" +
        "}\n";

    private static final String FRAGMENT_SHADER_OES =
        "#extension GL_OES_EGL_image_external : require\n" +
        "precision mediump float;\n" +
        "varying vec2 vTexCoord;\n" +
        "uniform samplerExternalOES sTexture;\n" +
        "uniform float uAlpha;\n" +
        "void main() {\n" +
        "  vec4 c = texture2D(sTexture, vTexCoord);\n" +
        "  gl_FragColor = vec4(c.rgb, uAlpha);\n" +
        "}\n";

    private static final String SOLID_VERTEX_SHADER =
        "attribute vec4 aPosition;\n" +
        "void main() {\n" +
        "  gl_Position = aPosition;\n" +
        "}\n";

    private static final String SOLID_FRAGMENT_SHADER =
        "precision mediump float;\n" +
        "uniform vec4 uColor;\n" +
        "void main() {\n" +
        "  gl_FragColor = uColor;\n" +
        "}\n";

    public static class NormRect {
        public float x, y, w, h;
        public NormRect(float x, float y, float w, float h) {
            this.x = x; this.y = y; this.w = w; this.h = h;
        }
    }

    public static class VideoLayerSpec {
        public boolean mirror;
        public float alpha;
        public NormRect clipRect;
        public NormRect mainRect;
        public NormRect bgRect;
        public float bgAlpha;
    }

    /**
     * 单路解码输出表面（独立 HandlerThread 接收帧可用事件，彻底避免同线程 wait 死锁）
     */
    public static class VideoTextureSlot {
        public int textureId;
        public SurfaceTexture surfaceTexture;
        public Surface surface;
        public final float[] texMatrix = new float[16];
        private final Object frameSync = new Object();
        private boolean frameAvailable = false;
        public boolean hasFrame = false;

        public void resetLatch() {
            synchronized (frameSync) {
                frameAvailable = false;
            }
        }

        public boolean awaitNewImage(long timeoutMs) {
            synchronized (frameSync) {
                long deadline = System.currentTimeMillis() + timeoutMs;
                while (!frameAvailable) {
                    long left = deadline - System.currentTimeMillis();
                    if (left <= 0) {
                        return false;
                    }
                    try {
                        frameSync.wait(left);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        return false;
                    }
                }
                frameAvailable = false;
            }
            surfaceTexture.updateTexImage();
            surfaceTexture.getTransformMatrix(texMatrix);
            hasFrame = true;
            return true;
        }

        void notifyFrameAvailable() {
            synchronized (frameSync) {
                frameAvailable = true;
                frameSync.notifyAll();
            }
        }
    }

    private final int width;
    private final int height;
    private EGLDisplay eglDisplay = EGL14.EGL_NO_DISPLAY;
    private EGLContext eglContext = EGL14.EGL_NO_CONTEXT;
    private EGLSurface eglSurface = EGL14.EGL_NO_SURFACE;

    private HandlerThread callbackThread;
    private Handler callbackHandler;

    private int oesProgram;
    private int aPosLoc;
    private int aTexLoc;
    private int uTexMatrixLoc;
    private int uAlphaLoc;

    private int solidProgram;
    private int solidPosLoc;
    private int solidColorLoc;

    private final FloatBuffer quadBuffer;
    public final VideoTextureSlot slot1 = new VideoTextureSlot();
    public final VideoTextureSlot slot2 = new VideoTextureSlot();

    public NativeGlRenderer(Surface encoderInputSurface, int width, int height) {
        this.width = width;
        this.height = height;
        this.quadBuffer = ByteBuffer.allocateDirect(4 * 4 * 4)
            .order(ByteOrder.nativeOrder())
            .asFloatBuffer();

        initEgl(encoderInputSurface);
        initGl();
    }

    private void initEgl(Surface surface) {
        eglDisplay = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);
        if (eglDisplay == EGL14.EGL_NO_DISPLAY) {
            throw new RuntimeException("无法获取 EGLDisplay");
        }
        int[] version = new int[2];
        if (!EGL14.eglInitialize(eglDisplay, version, 0, version, 1)) {
            throw new RuntimeException("EGL 初始化失败");
        }

        int[] attribList = {
            EGL14.EGL_RED_SIZE, 8,
            EGL14.EGL_GREEN_SIZE, 8,
            EGL14.EGL_BLUE_SIZE, 8,
            EGL14.EGL_ALPHA_SIZE, 8,
            EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
            EGL_RECORDABLE_ANDROID, 1,
            EGL14.EGL_NONE
        };
        EGLConfig[] configs = new EGLConfig[1];
        int[] numConfigs = new int[1];
        if (!EGL14.eglChooseConfig(eglDisplay, attribList, 0, configs, 0, 1, numConfigs, 0)
            || numConfigs[0] <= 0) {
            throw new RuntimeException("无法找到可用的 EGLConfig");
        }

        int[] ctxAttribs = {EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE};
        eglContext = EGL14.eglCreateContext(eglDisplay, configs[0], EGL14.EGL_NO_CONTEXT, ctxAttribs, 0);
        if (eglContext == EGL14.EGL_NO_CONTEXT) {
            throw new RuntimeException("EGLContext 创建失败");
        }

        int[] surfAttribs = {EGL14.EGL_NONE};
        eglSurface = EGL14.eglCreateWindowSurface(eglDisplay, configs[0], surface, surfAttribs, 0);
        if (eglSurface == EGL14.EGL_NO_SURFACE) {
            throw new RuntimeException("EGLWindowSurface 创建失败");
        }

        if (!EGL14.eglMakeCurrent(eglDisplay, eglSurface, eglSurface, eglContext)) {
            throw new RuntimeException("eglMakeCurrent 失败");
        }
    }

    private void initGl() {
        oesProgram = buildProgram(VERTEX_SHADER, FRAGMENT_SHADER_OES);
        aPosLoc = GLES20.glGetAttribLocation(oesProgram, "aPosition");
        aTexLoc = GLES20.glGetAttribLocation(oesProgram, "aTexCoord");
        uTexMatrixLoc = GLES20.glGetUniformLocation(oesProgram, "uTexMatrix");
        uAlphaLoc = GLES20.glGetUniformLocation(oesProgram, "uAlpha");

        solidProgram = buildProgram(SOLID_VERTEX_SHADER, SOLID_FRAGMENT_SHADER);
        solidPosLoc = GLES20.glGetAttribLocation(solidProgram, "aPosition");
        solidColorLoc = GLES20.glGetUniformLocation(solidProgram, "uColor");

        callbackThread = new HandlerThread("SurfaceTexCallbacks");
        callbackThread.start();
        callbackHandler = new Handler(callbackThread.getLooper());

        int[] textures = new int[2];
        GLES20.glGenTextures(2, textures, 0);
        setupSlot(slot1, textures[0]);
        setupSlot(slot2, textures[1]);

        GLES20.glViewport(0, 0, width, height);
        GLES20.glEnable(GLES20.GL_BLEND);
        GLES20.glBlendFunc(GLES20.GL_SRC_ALPHA, GLES20.GL_ONE_MINUS_SRC_ALPHA);
    }

    private void setupSlot(VideoTextureSlot slot, int texId) {
        slot.textureId = texId;
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, texId);
        GLES20.glTexParameterf(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameterf(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);

        Matrix.setIdentityM(slot.texMatrix, 0);
        slot.surfaceTexture = new SurfaceTexture(texId);
        slot.surfaceTexture.setOnFrameAvailableListener(st -> slot.notifyFrameAvailable(), callbackHandler);
        slot.surface = new Surface(slot.surfaceTexture);
    }

    /**
     * 渲染一帧同台对比画面并附带确定性 PTS 提交至编码器表面
     */
    public void renderAndSwap(
        String mode,
        boolean v1Active,
        VideoLayerSpec spec1,
        boolean v2Active,
        VideoLayerSpec spec2,
        long ptsNs
    ) {
        GLES20.glDisable(GLES20.GL_SCISSOR_TEST);
        GLES20.glClearColor(0f, 0f, 0f, 1f);
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT);

        if ("split-screen".equals(mode)) {
            if (v1Active && slot1.hasFrame) {
                drawLayerWithClip(slot1, spec1);
            }
            if (v2Active && slot2.hasFrame) {
                drawLayerWithClip(slot2, spec2);
            }
            // 中轴 1px 分界线 (rgba 255,255,255,0.2)
            GLES20.glDisable(GLES20.GL_SCISSOR_TEST);
            float halfPxNorm = 0.5f / Math.max(1, width);
            drawSolidRect(0.5f - halfPxNorm, 0f, halfPxNorm * 2f, 1f, 1f, 1f, 1f, 0.2f);
        } else {
            if (v1Active && slot1.hasFrame && spec1.alpha > 0f) {
                drawLayerWithClip(slot1, spec1);
            }
            if (v2Active && slot2.hasFrame && spec2.alpha > 0f) {
                drawLayerWithClip(slot2, spec2);
            }
        }

        EGLExt.eglPresentationTimeANDROID(eglDisplay, eglSurface, ptsNs);
        EGL14.eglSwapBuffers(eglDisplay, eglSurface);
    }

    private void drawLayerWithClip(VideoTextureSlot slot, VideoLayerSpec spec) {
        NormRect clip = spec.clipRect;
        if (clip != null && (clip.w < 0.999f || clip.h < 0.999f)) {
            GLES20.glEnable(GLES20.GL_SCISSOR_TEST);
            int sx = Math.max(0, Math.round(clip.x * width));
            int sw = Math.max(0, Math.round(clip.w * width));
            int sy = Math.max(0, Math.round((1f - clip.y - clip.h) * height));
            int sh = Math.max(0, Math.round(clip.h * height));
            GLES20.glScissor(sx, sy, sw, sh);
        } else {
            GLES20.glDisable(GLES20.GL_SCISSOR_TEST);
        }

        if (spec.bgRect != null && spec.bgAlpha > 0f) {
            drawTexturedRect(slot, spec.bgRect, spec.mirror, spec.bgAlpha);
        }
        if (spec.mainRect != null && spec.alpha > 0f) {
            drawTexturedRect(slot, spec.mainRect, spec.mirror, spec.alpha);
        }
    }

    private void drawTexturedRect(VideoTextureSlot slot, NormRect rect, boolean mirror, float alpha) {
        float xL = rect.x * 2f - 1f;
        float xR = (rect.x + rect.w) * 2f - 1f;
        float yT = 1f - rect.y * 2f;
        float yB = 1f - (rect.y + rect.h) * 2f;

        float uL = mirror ? 1f : 0f;
        float uR = mirror ? 0f : 1f;

        // OpenGL SurfaceTexture.getTransformMatrix 期望输入 bottom-up 纹理坐标:
        // 顶部顶点对应 v=1, 底部顶点对应 v=0
        float[] data = {
            xL, yB, uL, 0f,
            xR, yB, uR, 0f,
            xL, yT, uL, 1f,
            xR, yT, uR, 1f,
        };
        quadBuffer.clear();
        quadBuffer.put(data).position(0);

        GLES20.glUseProgram(oesProgram);
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, slot.textureId);

        quadBuffer.position(0);
        GLES20.glVertexAttribPointer(aPosLoc, 2, GLES20.GL_FLOAT, false, 16, quadBuffer);
        GLES20.glEnableVertexAttribArray(aPosLoc);

        quadBuffer.position(2);
        GLES20.glVertexAttribPointer(aTexLoc, 2, GLES20.GL_FLOAT, false, 16, quadBuffer);
        GLES20.glEnableVertexAttribArray(aTexLoc);

        GLES20.glUniformMatrix4fv(uTexMatrixLoc, 1, false, slot.texMatrix, 0);
        GLES20.glUniform1f(uAlphaLoc, alpha);

        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
    }

    private void drawSolidRect(float nx, float ny, float nw, float nh, float r, float g, float b, float a) {
        float xL = nx * 2f - 1f;
        float xR = (nx + nw) * 2f - 1f;
        float yT = 1f - ny * 2f;
        float yB = 1f - (ny + nh) * 2f;

        float[] data = {
            xL, yB, 0f, 0f,
            xR, yB, 0f, 0f,
            xL, yT, 0f, 0f,
            xR, yT, 0f, 0f,
        };
        quadBuffer.clear();
        quadBuffer.put(data).position(0);

        GLES20.glUseProgram(solidProgram);
        quadBuffer.position(0);
        GLES20.glVertexAttribPointer(solidPosLoc, 2, GLES20.GL_FLOAT, false, 16, quadBuffer);
        GLES20.glEnableVertexAttribArray(solidPosLoc);
        GLES20.glUniform4f(solidColorLoc, r, g, b, a);
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
    }

    private int buildProgram(String vsSrc, String fsSrc) {
        int vs = compileShader(GLES20.GL_VERTEX_SHADER, vsSrc);
        int fs = compileShader(GLES20.GL_FRAGMENT_SHADER, fsSrc);
        int prog = GLES20.glCreateProgram();
        GLES20.glAttachShader(prog, vs);
        GLES20.glAttachShader(prog, fs);
        GLES20.glLinkProgram(prog);
        // 链接状态检查：失败时立即抛错，避免携带失效 program 继续运行导致黑帧难排查
        int[] linkStatus = new int[1];
        GLES20.glGetProgramiv(prog, GLES20.GL_LINK_STATUS, linkStatus, 0);
        if (linkStatus[0] == 0) {
            String log = GLES20.glGetProgramInfoLog(prog);
            GLES20.glDeleteProgram(prog);
            GLES20.glDeleteShader(vs);
            GLES20.glDeleteShader(fs);
            throw new RuntimeException("OpenGL 着色器程序链接失败: " + log);
        }
        GLES20.glDeleteShader(vs);
        GLES20.glDeleteShader(fs);
        return prog;
    }

    private int compileShader(int type, String src) {
        int shader = GLES20.glCreateShader(type);
        GLES20.glShaderSource(shader, src);
        GLES20.glCompileShader(shader);
        // 编译状态检查：驱动不支持/上下文异常时抛出含日志的错误而非静默失败
        int[] compiled = new int[1];
        GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, compiled, 0);
        if (compiled[0] == 0) {
            String log = GLES20.glGetShaderInfoLog(shader);
            GLES20.glDeleteShader(shader);
            throw new RuntimeException("着色器编译失败 (type=" + type + "): " + log);
        }
        return shader;
    }

    public void release() {
        if (slot1.surface != null) { slot1.surface.release(); slot1.surface = null; }
        if (slot1.surfaceTexture != null) { slot1.surfaceTexture.release(); slot1.surfaceTexture = null; }
        if (slot2.surface != null) { slot2.surface.release(); slot2.surface = null; }
        if (slot2.surfaceTexture != null) { slot2.surfaceTexture.release(); slot2.surfaceTexture = null; }

        if (callbackThread != null) {
            callbackThread.quitSafely();
            try {
                callbackThread.join(500);
            } catch (InterruptedException ignored) {}
            callbackThread = null;
        }

        if (eglDisplay != EGL14.EGL_NO_DISPLAY) {
            EGL14.eglMakeCurrent(eglDisplay, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT);
            if (eglSurface != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(eglDisplay, eglSurface);
            if (eglContext != EGL14.EGL_NO_CONTEXT) EGL14.eglDestroyContext(eglDisplay, eglContext);
            EGL14.eglTerminate(eglDisplay);
        }
        eglSurface = EGL14.EGL_NO_SURFACE;
        eglContext = EGL14.EGL_NO_CONTEXT;
        eglDisplay = EGL14.EGL_NO_DISPLAY;
    }
}
