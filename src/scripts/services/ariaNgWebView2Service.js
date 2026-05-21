/**
 * WebView2 RPC Secret 服务
 * 
 * 用途：在 WebView2 环境中，从宿主 C# 应用获取 aria2 RPC secret
 * 
 * 工作流程：
 * 1. 检测当前是否运行在 WebView2 环境中
 * 2. 向 C# 宿主发送 "RequestRpcSecret" 消息
 * 3. 监听宿主返回的消息，获取 RPC secret
 * 4. 超时或获取失败时返回 null（静默忽略，不影响正常流程）
 * 
 * 适用场景：
 * 当 AriaNg 被嵌入到 WebView2 + C# .NET 应用中时，每次启动 aria2 的 rpc-secret
 * 都会随机生成。此服务用于在页面初始化时自动获取 secret，无需用户手动输入。
 * 
 * C# 端配合示例：
 * webView.CoreWebView2.WebMessageReceived += (sender, args) => {
 *     if (args.WebMessageAsString == "RequestRpcSecret") {
 *         webView.CoreWebView2.PostWebMessageAsString(yourRandomSecret);
 *     }
 * };
 */
(function () {
    'use strict';

    angular.module('ariaNg').factory('ariaNgWebView2Service', ['$window', '$q', function ($window, $q) {
        // WebView2 环境检测结果缓存
        var isWebView2Available = false;
        // 是否已执行过检测（避免重复检测）
        var hasChecked = false;

        /**
         * 惰性检测 WebView2 环境
         * 只在首次调用时执行实际检测，后续直接返回缓存结果
         */
        var checkWebView2Availability = function () {
            if (hasChecked) {
                return isWebView2Available;
            }

            hasChecked = true;

            try {
                if ($window.chrome && $window.chrome.webview &&
                    typeof $window.chrome.webview.postMessage === 'function' &&
                    typeof $window.chrome.webview.addEventListener === 'function') {
                    isWebView2Available = true;
                    return true;
                }
            } catch (e) {
                // 忽略异常，视为非 WebView2 环境
            }

            return false;
        };

        /**
         * 向 WebView2 宿主请求 RPC secret
         * 
         * @returns {Promise<string|null>} 返回 secret 字符串，失败或超时时返回 null
         * 
         * 超时时间：3 秒
         */
        var requestRpcSecret = function () {
            if (!checkWebView2Availability()) {
                return $q.resolve(null);
            }

            return $q(function (resolve) {
                var resolved = false;
                var timeoutMs = 3000;

                // 监听宿主返回的消息
                var messageHandler = function (event) {
                    if (resolved) {
                        return;
                    }

                    var secret = event.data;

                    if (secret && typeof secret === 'string' && secret.length > 0) {
                        resolved = true;
                        $window.chrome.webview.removeEventListener('message', messageHandler);
                        resolve(secret);
                    } else {
                        // 收到空值或无效数据，视为获取失败
                        resolved = true;
                        $window.chrome.webview.removeEventListener('message', messageHandler);
                        resolve(null);
                    }
                };

                $window.chrome.webview.addEventListener('message', messageHandler);

                // 发送请求
                try {
                    $window.chrome.webview.postMessage('RequestRpcSecret');
                } catch (e) {
                    resolved = true;
                    $window.chrome.webview.removeEventListener('message', messageHandler);
                    resolve(null);
                }

                // 超时处理
                setTimeout(function () {
                    if (!resolved) {
                        resolved = true;
                        $window.chrome.webview.removeEventListener('message', messageHandler);
                        resolve(null);
                    }
                }, timeoutMs);
            });
        };

        return {
            /**
             * 检查当前是否在 WebView2 环境中
             * @returns {boolean}
             */
            isAvailable: function () {
                return checkWebView2Availability();
            },
            /**
             * 请求 RPC secret
             * @returns {Promise<string|null>}
             */
            requestRpcSecret: requestRpcSecret
        };
    }]);
}());
