package com.wotagei.compare;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeMediaPlugin.class);
        super.onCreate(savedInstanceState);
        // 说明：WebView 页面源已配置为 http://localhost（capacitor.config.ts 的
        // androidScheme: 'http'），与本地 http://127.0.0.1 流式代理同为 http 源，
        // 不构成混合内容。因此无需（也不应）再全局开启
        // WebSettings.MIXED_CONTENT_ALWAYS_ALLOW——该全局开关会放行 WebView 内
        // 任意 http 子资源，属于不必要的攻击面。
    }
}
