(function () {
    'use strict';

    angular.module('ariaNg').factory('aria2RpcService', ['$location', '$q', 'aria2RpcConstants', 'aria2RpcErrors', 'aria2AllOptions', 'ariaNgCommonService', 'ariaNgLogService', 'ariaNgSettingService', 'aria2HttpRpcService', 'aria2WebSocketRpcService', function ($location, $q, aria2RpcConstants, aria2RpcErrors, aria2AllOptions, ariaNgCommonService, ariaNgLogService, ariaNgSettingService, aria2HttpRpcService, aria2WebSocketRpcService) {
        var rpcImplementService = ariaNgSettingService.isCurrentRpcUseWebSocket() ? aria2WebSocketRpcService : aria2HttpRpcService;
        var isConnected = false;

        var onFirstSuccessCallbacks = [];
        var onOperationSuccessCallbacks = [];
        var onOperationErrorCallbacks = [];
        var onConnectionSuccessCallbacks = [];
        var onConnectionFailedCallbacks = [];
        var onConnectionReconnectingCallbacks = [];
        var onConnectionWaitingToReconnectCallbacks = [];
        var onDownloadStartCallbacks = [];
        var onDownloadPauseCallbacks = [];
        var onDownloadStopCallbacks = [];
        var onDownloadCompleteCallbacks = [];
        var onDownloadErrorCallbacks = [];
        var onBtDownloadCompleteCallbacks = [];

        var checkIsSystemMethod = function (methodName) {
            return methodName.indexOf(aria2RpcConstants.rpcSystemServiceName + '.') === 0;
        };

        var getAria2MethodFullName = function (methodName) {
            return aria2RpcConstants.rpcServiceName + '.' + methodName;
        };

        var getAria2EventFullName = function (eventName) {
            return getAria2MethodFullName(eventName);
        };

        var registerEvent = function (eventName, callbacks) {
            var fullEventName = getAria2EventFullName(eventName);

            rpcImplementService.on(fullEventName, function (context) {
                if (!angular.isArray(callbacks) || callbacks.length < 1) {
                    return;
                }

                for (var i = 0; i < callbacks.length; i++) {
                    var callback = callbacks[i];
                    callback(context);
                }
            });
        };

        var fireCustomEvent = function (callbacks, context) {
            if (!angular.isArray(callbacks) || callbacks.length < 1) {
                return;
            }

            for (var i = 0; i < callbacks.length; i++) {
                var callback = callbacks[i];
                callback(context);
            }
        };

        var processError = function (error) {
            if (!error || !error.message) {
                return false;
            }

            ariaNgLogService.error('[aria2RpcService.processError] ' + error.message, error);

            if (aria2RpcErrors[error.message] && aria2RpcErrors[error.message].tipTextKey) {
                ariaNgCommonService.showError(aria2RpcErrors[error.message].tipTextKey);
                return true;
            } else {
                ariaNgCommonService.showError(error.message);
                return true;
            }
        };

        var buildRequestOptions = function (originalOptions, context) {
            var options = angular.copy(originalOptions);

            for (var optionName in options) {
                if (!options.hasOwnProperty(optionName)) {
                    continue;
                }

                if (isOptionSubmitArray(options, optionName)) {
                    options[optionName] = buildArrayOption(options[optionName], aria2AllOptions[optionName]);
                }
            }

            if (context && context.pauseOnAdded) {
                options.pause = 'true';
            }

            return options;
        };

        var isOptionSubmitArray = function (options, optionName) {
            if (!options[optionName] || !angular.isString(options[optionName])) {
                return false;
            }

            if (!aria2AllOptions[optionName] || aria2AllOptions[optionName].submitFormat !== 'array') {
                return false;
            }

            return true;
        };

        var buildArrayOption = function (option, optionSetting) {
            var items = option.split(optionSetting.separator);
            var result = [];

            for (var i = 0; i < items.length; i++) {
                var item = items[i];

                if (!item) {
                    continue;
                }

                item = item.replace('\r', '');

                result.push(item);
            }

            return result;
        };

        /**
         * 构建 RPC 请求上下文
         * 负责组装方法名、回调函数、参数等，但不包含 RPC secret
         * （secret 由 injectSecret 在发送前动态注入，确保拿到最新值）
         */
        var buildRequestContext = function () {
            var methodName = arguments[0];
            var requestInPage = $location.path();
            var isSystemMethod = checkIsSystemMethod(methodName);
            var finalParams = [];

            var context = {
                methodName: (!isSystemMethod ? getAria2MethodFullName(methodName) : methodName),
                // 标记是否为系统方法（系统方法不需要携带 secret）
                isSystemMethod: isSystemMethod
            };

            context.connectionSuccessCallback = function () {
                fireCustomEvent(onConnectionSuccessCallbacks);
            };

            context.connectionFailedCallback = function () {
                fireCustomEvent(onConnectionFailedCallbacks);
            };

            context.connectionReconnectingCallback = function () {
                fireCustomEvent(onConnectionReconnectingCallbacks);
            };

            context.connectionWaitingToReconnectCallback = function () {
                fireCustomEvent(onConnectionWaitingToReconnectCallbacks);
            };

            if (arguments.length > 1) {
                var innerContext = arguments[1];

                context.successCallback = function (id, result) {
                    if (innerContext.callback) {
                        innerContext.callback({
                            id: id,
                            success: true,
                            data: result,
                            context: innerContext
                        });
                    }

                    fireCustomEvent(onOperationSuccessCallbacks);

                    if (!isConnected) {
                        isConnected = true;
                        var firstSuccessContext = {
                            rpcName: ariaNgSettingService.getCurrentRpcDisplayName()
                        };
                        fireCustomEvent(onFirstSuccessCallbacks, firstSuccessContext);
                    }
                };

                context.errorCallback = function (id, error) {
                    var errorProcessed = false;
                    var currentPage = $location.path();

                    if (!innerContext.silent && currentPage === requestInPage) {
                        errorProcessed = processError(error);
                    }

                    if (innerContext.callback) {
                        innerContext.callback({
                            id: id,
                            success: false,
                            data: error,
                            errorProcessed: errorProcessed,
                            context: innerContext
                        });
                    }

                    fireCustomEvent(onOperationErrorCallbacks);
                };
            }

            if (arguments.length > 2) {
                for (var i = 2; i < arguments.length; i++) {
                    if (arguments[i] !== null && angular.isDefined(arguments[i])) {
                        finalParams.push(arguments[i]);
                    }
                }
            }

            if (finalParams.length > 0) {
                context.params = finalParams;
            }

            return context;
        };

        /**
         * 动态注入 RPC secret 到请求参数中
         * 
         * 为什么不在 buildRequestContext 中直接添加 secret？
         * 因为 WebView2 获取 secret 是异步的，buildRequestContext 被调用时
         * secret 可能还没返回。延迟到发送前注入，确保能拿到最新值。
         * 
         * @param {Object} context - buildRequestContext 构建的请求上下文
         */
        var injectSecret = function (context) {
            // 系统方法（如 system.listMethods）不需要携带 secret
            if (context.isSystemMethod) {
                return;
            }

            // 从 storage 动态读取最新 secret（此时可能已被 WebView2 更新）
            var currentSecret = ariaNgSettingService.getCurrentRpcSecret();

            if (!currentSecret) {
                return;
            }

            // 确保 params 数组存在
            if (!context.params) {
                context.params = [];
            }

            // 将 secret 插入到 params 最前面（aria2 RPC 协议要求 token 在第一个参数）
            context.params.unshift(aria2RpcConstants.rpcTokenPrefix + currentSecret);
        };

        /**
         * 发送 RPC 请求
         * 将 requestContext 转换为 WebSocket/HTTP 可执行的请求格式
         */
        var sendRequest = function (requestContext) {
            var uniqueId = ariaNgCommonService.generateUniqueId();

            var requestBody = {
                jsonrpc: aria2RpcConstants.rpcServiceVersion,
                method: requestContext.methodName,
                id: uniqueId,
                params: requestContext.params
            };

            var invokeContext = {
                uniqueId: uniqueId,
                requestBody: requestBody,
                connectionSuccessCallback: requestContext.connectionSuccessCallback,
                connectionFailedCallback: requestContext.connectionFailedCallback,
                connectionReconnectingCallback: requestContext.connectionReconnectingCallback,
                connectionWaitingToReconnectCallback: requestContext.connectionWaitingToReconnectCallback,
                successCallback: requestContext.successCallback,
                errorCallback: requestContext.errorCallback
            };

            return rpcImplementService.request(invokeContext);
        };

        /**
         * 发起 RPC 请求的核心入口方法
         * 
         * 工作流程：
         * 1. 检查是否需要等待 WebView2 secret（通过 whenWebView2SecretReady）
         * 2. 非 WebView2 环境：直接注入 secret 并发送
         * 3. WebView2 环境：等待 secret 就绪 → 注入最新 secret → 发送请求
         * 
         * 关键点：通过等待 secretReadyPromise，确保首次连接时不会因
         * secret 未就绪而导致"认证失败"错误
         * 
         * @param {Object} requestContext - 由 buildRequestContext 构建的请求上下文
         * @param {boolean} returnContextOnly - 是否仅返回上下文（不实际发送）
         * @returns {Promise}
         */
        var invoke = function (requestContext, returnContextOnly) {
            if (returnContextOnly) {
                return requestContext;
            }

            // 获取 secret 就绪 promise
            // null 表示非 WebView2 环境，无需等待
            var secretReadyPromise = ariaNgSettingService.whenWebView2SecretReady();

            if (!secretReadyPromise) {
                // 非 WebView2 环境，直接注入 secret 并发送
                injectSecret(requestContext);
                return sendRequest(requestContext);
            }

            // WebView2 环境：等待 secret 就绪后再发送
            var deferred = $q.defer();

            secretReadyPromise.then(function () {
                // secret 已就绪，从 storage 读取最新值注入
                injectSecret(requestContext);
                sendRequest(requestContext).then(
                    function (result) { deferred.resolve(result); },
                    function (error) { deferred.reject(error); }
                );
            });

            return deferred.promise;
        };

        var invokeMulti = function (methodFunc, contexts, callback) {
            var promises = [];

            var hasSuccess = false;
            var hasError = false;
            var results = [];

            for (var i = 0; i < contexts.length; i++) {
                contexts[i].callback = function (response) {
                    results.push(response);

                    hasSuccess = hasSuccess || response.success;
                    hasError = hasError || !response.success;
                };

                promises.push(methodFunc(contexts[i]));
            }

            return $q.all(promises).finally(function () {
                if (callback) {
                    callback({
                        hasSuccess: !!hasSuccess,
                        hasError: !!hasError,
                        results: results
                    });
                }
            });
        };

        (function () {
            registerEvent('onDownloadStart', onDownloadStartCallbacks);
            registerEvent('onDownloadPause', onDownloadPauseCallbacks);
            registerEvent('onDownloadStop', onDownloadStopCallbacks);
            registerEvent('onDownloadComplete', onDownloadCompleteCallbacks);
            registerEvent('onDownloadError', onDownloadErrorCallbacks);
            registerEvent('onBtDownloadComplete', onBtDownloadCompleteCallbacks);
        })();

        return {
            getBasicTaskParams: function () {
                return [
                    'gid',
                    'totalLength',
                    'completedLength',
                    'uploadSpeed',
                    'downloadSpeed',
                    'connections',
                    'numSeeders',
                    'seeder',
                    'status',
                    'errorCode',
                    'verifiedLength',
                    'verifyIntegrityPending'
                ];
            },
            getFullTaskParams: function () {
                var requestParams = this.getBasicTaskParams();

                requestParams.push('files');
                requestParams.push('bittorrent');
                requestParams.push('infoHash');

                return requestParams;
            },
            canReconnect: function () {
                return ariaNgSettingService.isCurrentRpcUseWebSocket();
            },
            reconnect: function (context) {
                ariaNgLogService.info("[aria2RpcService.reconnect] reconnect now");
                sendRequest(buildRequestContext('', context));
            },
            addUri: function (context, returnContextOnly) {
                var urls = context.task ? context.task.urls : null;
                var options = buildRequestOptions(context.task ? context.task.options : {}, context);

                return invoke(buildRequestContext('addUri', context, urls, options), !!returnContextOnly);
            },
            addUriMulti: function (context) {
                var contexts = [];

                for (var i = 0; i < context.tasks.length; i++) {
                    var task = context.tasks[i];

                    contexts.push({
                        silent: !!context.silent,
                        task: task,
                        pauseOnAdded: context.pauseOnAdded
                    });
                }

                return invokeMulti(this.addUri, contexts, context.callback);
            },
            addTorrent: function (context, returnContextOnly) {
                var content = context.task ? context.task.content : null;
                var options = buildRequestOptions(context.task ? context.task.options : {}, context);

                return invoke(buildRequestContext('addTorrent', context, content, [], options), !!returnContextOnly);
            },
            addMetalink: function (context, returnContextOnly) {
                var content = context.task ? context.task.content : null;
                var options = buildRequestOptions(context.task ? context.task.options : {}, context);

                return invoke(buildRequestContext('addMetalink', context, content, options), !!returnContextOnly);
            },
            remove: function (context, returnContextOnly) {
                return invoke(buildRequestContext('remove', context, context.gid), !!returnContextOnly);
            },
            forceRemove: function (context, returnContextOnly) {
                return invoke(buildRequestContext('forceRemove', context, context.gid), !!returnContextOnly);
            },
            forceRemoveMulti: function (context) {
                var contexts = [];

                for (var i = 0; i < context.gids.length; i++) {
                    contexts.push({
                        silent: !!context.silent,
                        gid: context.gids[i]
                    });
                }

                return invokeMulti(this.forceRemove, contexts, context.callback);
            },
            pause: function (context, returnContextOnly) {
                return invoke(buildRequestContext('pause', context, context.gid), !!returnContextOnly);
            },
            pauseAll: function (context, returnContextOnly) {
                return invoke(buildRequestContext('pauseAll', context), !!returnContextOnly);
            },
            forcePause: function (context, returnContextOnly) {
                return invoke(buildRequestContext('forcePause', context, context.gid), !!returnContextOnly);
            },
            forcePauseMulti: function (context) {
                var contexts = [];

                for (var i = 0; i < context.gids.length; i++) {
                    contexts.push({
                        silent: !!context.silent,
                        gid: context.gids[i]
                    });
                }

                return invokeMulti(this.forcePause, contexts, context.callback);
            },
            forcePauseAll: function (context, returnContextOnly) {
                return invoke(buildRequestContext('forcePauseAll', context), !!returnContextOnly);
            },
            unpause: function (context, returnContextOnly) {
                return invoke(buildRequestContext('unpause', context, context.gid), !!returnContextOnly);
            },
            unpauseMulti: function (context) {
                var contexts = [];

                for (var i = 0; i < context.gids.length; i++) {
                    contexts.push({
                        silent: !!context.silent,
                        gid: context.gids[i]
                    });
                }

                return invokeMulti(this.unpause, contexts, context.callback);
            },
            unpauseAll: function (context, returnContextOnly) {
                return invoke(buildRequestContext('unpauseAll', context), !!returnContextOnly);
            },
            tellStatus: function (context, returnContextOnly) {
                return invoke(buildRequestContext('tellStatus', context, context.gid), !!returnContextOnly);
            },
            getUris: function (context, returnContextOnly) {
                return invoke(buildRequestContext('getUris', context, context.gid), !!returnContextOnly);
            },
            getFiles: function (context, returnContextOnly) {
                return invoke(buildRequestContext('getFiles', context, context.gid), !!returnContextOnly);
            },
            getPeers: function (context, returnContextOnly) {
                return invoke(buildRequestContext('getPeers', context, context.gid), !!returnContextOnly);
            },
            getServers: function (context, returnContextOnly) {
                return invoke(buildRequestContext('getServers', context, context.gid), !!returnContextOnly);
            },
            tellActive: function (context, returnContextOnly) {
                return invoke(buildRequestContext('tellActive', context,
                    angular.isDefined(context.requestParams) ? context.requestParams: null
                ), !!returnContextOnly);
            },
            tellWaiting: function (context, returnContextOnly) {
                return invoke(buildRequestContext('tellWaiting', context,
                    angular.isDefined(context.offset) ? context.offset : 0,
                    angular.isDefined(context.num) ? context.num : 1000,
                    angular.isDefined(context.requestParams) ? context.requestParams : null
                ), !!returnContextOnly);
            },
            tellStopped: function (context, returnContextOnly) {
                return invoke(buildRequestContext('tellStopped', context,
                    angular.isDefined(context.offset) ? context.offset : -1,
                    angular.isDefined(context.num) ? context.num : 1000,
                    angular.isDefined(context.requestParams) ? context.requestParams: null
                ), !!returnContextOnly);
            },
            changePosition: function (context, returnContextOnly) {
                return invoke(buildRequestContext('changePosition', context, context.gid, context.pos, context.how), !!returnContextOnly);
            },
            changeUri: function (context, returnContextOnly) {
                return invoke(buildRequestContext('changeUri', context, context.gid, context.fileIndex, context.delUris, context.addUris), !!returnContextOnly);
            },
            getOption: function (context, returnContextOnly) {
                return invoke(buildRequestContext('getOption', context, context.gid), !!returnContextOnly);
            },
            changeOption: function (context, returnContextOnly) {
                var options = buildRequestOptions(context.options, context);
                return invoke(buildRequestContext('changeOption', context, context.gid, options), !!returnContextOnly);
            },
            getGlobalOption: function (context, returnContextOnly) {
                return invoke(buildRequestContext('getGlobalOption', context), !!returnContextOnly);
            },
            changeGlobalOption: function (context, returnContextOnly) {
                var options = buildRequestOptions(context.options, context);
                return invoke(buildRequestContext('changeGlobalOption', context, options), !!returnContextOnly);
            },
            getGlobalStat: function (context, returnContextOnly) {
                return invoke(buildRequestContext('getGlobalStat', context), !!returnContextOnly);
            },
            purgeDownloadResult: function (context, returnContextOnly) {
                return invoke(buildRequestContext('purgeDownloadResult', context), !!returnContextOnly);
            },
            removeDownloadResult: function (context, returnContextOnly) {
                return invoke(buildRequestContext('removeDownloadResult', context, context.gid), !!returnContextOnly);
            },
            removeDownloadResultMulti: function (context) {
                var contexts = [];

                for (var i = 0; i < context.gids.length; i++) {
                    contexts.push({
                        silent: !!context.silent,
                        gid: context.gids[i]
                    });
                }

                return invokeMulti(this.removeDownloadResult, contexts, context.callback);
            },
            getVersion: function (context, returnContextOnly) {
                return invoke(buildRequestContext('getVersion', context), !!returnContextOnly);
            },
            getSessionInfo: function (context, returnContextOnly) {
                return invoke(buildRequestContext('getSessionInfo', context), !!returnContextOnly);
            },
            shutdown: function (context, returnContextOnly) {
                return invoke(buildRequestContext('shutdown', context), !!returnContextOnly);
            },
            forceShutdown: function (context, returnContextOnly) {
                return invoke(buildRequestContext('forceShutdown', context), !!returnContextOnly);
            },
            saveSession: function (context, returnContextOnly) {
                return invoke(buildRequestContext('saveSession', context), !!returnContextOnly);
            },
            multicall: function (context, returnContextOnly) {
                return invoke(buildRequestContext('system.multicall', context, context.methods), !!returnContextOnly);
            },
            listMethods: function (context, returnContextOnly) {
                return invoke(buildRequestContext('system.listMethods', context), !!returnContextOnly);
            },
            listNotifications: function (context, returnContextOnly) {
                return invoke(buildRequestContext('system.listNotifications', context), !!returnContextOnly);
            },
            onFirstSuccess: function (context) {
                onFirstSuccessCallbacks.push(context.callback);
            },
            onOperationSuccess: function (context) {
                onOperationSuccessCallbacks.push(context.callback);
            },
            onOperationError: function (context) {
                onOperationErrorCallbacks.push(context.callback);
            },
            onConnectionSuccess: function (context) {
                onConnectionSuccessCallbacks.push(context.callback);
            },
            onConnectionFailed: function (context) {
                onConnectionFailedCallbacks.push(context.callback);
            },
            onConnectionReconnecting: function (context) {
                onConnectionReconnectingCallbacks.push(context.callback);
            },
            onConnectionWaitingToReconnect: function (context) {
                onConnectionWaitingToReconnectCallbacks.push(context.callback);
            },
            onDownloadStart: function (context) {
                onDownloadStartCallbacks.push(context.callback);
            },
            onDownloadPause: function (context) {
                onDownloadPauseCallbacks.push(context.callback);
            },
            onDownloadStop: function (context) {
                onDownloadStopCallbacks.push(context.callback);
            },
            onDownloadComplete: function (context) {
                onDownloadCompleteCallbacks.push(context.callback);
            },
            onDownloadError: function (context) {
                onDownloadErrorCallbacks.push(context.callback);
            },
            onBtDownloadComplete: function (context) {
                onBtDownloadCompleteCallbacks.push(context.callback);
            }
        };
    }]);
}());
