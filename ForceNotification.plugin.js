/**
 * @name ForceNotification
 * @author pui
 * @description Discordのメッセージ通知を強制的にWindowsデスクトップ通知として表示します。音しか鳴らない問題を解決します。DiscordOverlayと連携して最上面通知も可能。
 * @version 2.0.0
 * @source https://github.com/pui/ForceNotification
 */

module.exports = class ForceNotification {
    constructor() {
        this.name = "ForceNotification";
        this.settings = {
            notificationDuration: 5000,
            showAvatar: true,
            showChannelName: true,
            showServerName: true,
            maxContentLength: 200,
            useCustomNotification: true,
            useOverlayNotification: true,
            respectDiscordSettings: true,
            mutedServersNotify: false,
            mutedChannelsNotify: false,
            dmOnly: false,
            mentionsOnly: false,
            alwaysNotifyBots: true,
            ignoreNotificationLevel: true,
            debugMode: false
        };

        this.pipeConnected = false;
        this.pipeReconnectTimer = null;
        this.pipeClient = null;

        this.messageHandler = null;
        this.FluxDispatcher = null;
        this.UserStore = null;
        this.ChannelStore = null;
        this.GuildStore = null;
        this.SelectedChannelStore = null;
        this.MutedStore = null;
        this.GuildMemberStore = null;
        this.UserGuildSettingsStore = null;

        this.avatarCache = new Map();
        this.notificationContainer = null;
    }

    showToast(message, options = {}) {
        if (BdApi.UI?.showToast) {
            BdApi.UI.showToast(message, options);
        } else if (BdApi.showToast) {
            BdApi.showToast(message, options);
        } else {
            console.log("[ForceNotification] Toast:", message);
        }
    }

    log(...args) {
        console.log("[ForceNotification]", ...args);
    }

    debug(...args) {
        if (this.settings.debugMode) {
            console.log("[ForceNotification:DEBUG]", ...args);
        }
    }

    start() {
        this.loadSettings();
        this.injectStyles();
        this.createNotificationContainer();
        this.cacheModules();
        this.patchDispatcher();

        // DiscordOverlayへのパイプ接続を試行
        if (this.settings.useOverlayNotification) {
            this.connectToPipe();
        }

        this.log("Plugin started");

        if (Notification.permission !== "granted") {
            Notification.requestPermission();
        }
    }

    stop() {
        this.unpatchAll();
        this.removeStyles();
        this.removeNotificationContainer();
        this.avatarCache.clear();
        this.disconnectPipe();
        this.log("Plugin stopped");
    }

    // WebSocket connection to DiscordOverlay
    connectToOverlay() {
        try {
            // 既存の接続があれば切断
            if (this.wsClient) {
                try {
                    this.wsClient.close();
                } catch (e) {}
                this.wsClient = null;
            }

            const wsUrl = 'ws://127.0.0.1:47523';
            this.log("Attempting to connect to WebSocket:", wsUrl);

            this.wsClient = new WebSocket(wsUrl);

            this.wsClient.onopen = () => {
                // 初回接続時のみトーストを表示
                if (!this.pipeConnected) {
                    this.showToast("DiscordOverlayに接続しました", { type: "success" });
                }
                this.pipeConnected = true;
                this.log("Connected to DiscordOverlay via WebSocket");
            };

            this.wsClient.onerror = (err) => {
                this.debug("WebSocket error:", err);
            };

            this.wsClient.onclose = () => {
                this.pipeConnected = false;
                this.debug("WebSocket closed");
                // 5秒後に再接続を試行
                if (this.settings.useOverlayNotification && !this.pipeReconnectTimer) {
                    this.pipeReconnectTimer = setTimeout(() => {
                        this.pipeReconnectTimer = null;
                        this.connectToOverlay();
                    }, 5000);
                }
            };

            this.wsClient.onmessage = (event) => {
                this.debug("WebSocket message:", event.data);
            };
        } catch (e) {
            this.log("Failed to connect to WebSocket:", e);
            this.pipeConnected = false;
            // 5秒後に再接続を試行
            if (this.settings.useOverlayNotification && !this.pipeReconnectTimer) {
                this.pipeReconnectTimer = setTimeout(() => {
                    this.pipeReconnectTimer = null;
                    this.connectToOverlay();
                }, 5000);
            }
        }
    }

    disconnectOverlay() {
        if (this.pipeReconnectTimer) {
            clearTimeout(this.pipeReconnectTimer);
            this.pipeReconnectTimer = null;
        }
        if (this.wsClient) {
            try {
                this.wsClient.close();
            } catch (e) {}
            this.wsClient = null;
        }
        this.pipeConnected = false;
    }

    sendToOverlay(data) {
        if (!this.pipeConnected || !this.wsClient || this.wsClient.readyState !== WebSocket.OPEN) {
            this.debug("Cannot send - WebSocket not connected");
            return false;
        }

        try {
            const json = JSON.stringify(data);
            this.wsClient.send(json);
            this.debug("Sent to WebSocket:", json.substring(0, 200));
            return true;
        } catch (e) {
            this.log("Failed to send to WebSocket:", e);
            this.pipeConnected = false;
            return false;
        }
    }

    // 後方互換性のためのエイリアス
    connectToPipe() { return this.connectToOverlay(); }
    disconnectPipe() { return this.disconnectOverlay(); }
    sendToPipe(data) { return this.sendToOverlay(data); }

    loadSettings() {
        const saved = BdApi.Data.load(this.name, "settings");
        if (saved) {
            this.settings = { ...this.settings, ...saved };
        }
    }

    saveSettings() {
        BdApi.Data.save(this.name, "settings", this.settings);
    }

    injectStyles() {
        const css = `
            .fn-notification-container {
                position: fixed;
                top: 20px;
                right: 20px;
                z-index: 999999;
                display: flex;
                flex-direction: column;
                gap: 10px;
                pointer-events: none;
            }

            .fn-notification {
                background: #2b2d31;
                border-radius: 8px;
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
                padding: 12px 16px;
                min-width: 300px;
                max-width: 400px;
                display: flex;
                align-items: flex-start;
                gap: 12px;
                animation: fn-slide-in 0.3s ease-out;
                pointer-events: auto;
                cursor: pointer;
                border-left: 4px solid #5865f2;
                transition: transform 0.2s, box-shadow 0.2s;
            }

            .fn-notification:hover {
                transform: translateX(-4px);
                box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
            }

            .fn-notification.fn-fade-out {
                animation: fn-slide-out 0.3s ease-in forwards;
            }

            @keyframes fn-slide-in {
                from {
                    transform: translateX(100%);
                    opacity: 0;
                }
                to {
                    transform: translateX(0);
                    opacity: 1;
                }
            }

            @keyframes fn-slide-out {
                from {
                    transform: translateX(0);
                    opacity: 1;
                }
                to {
                    transform: translateX(100%);
                    opacity: 0;
                }
            }

            .fn-notification-avatar {
                width: 48px;
                height: 48px;
                border-radius: 50%;
                flex-shrink: 0;
                background: #36393f;
                object-fit: cover;
            }

            .fn-notification-content {
                flex: 1;
                min-width: 0;
                overflow: hidden;
            }

            .fn-notification-header {
                display: flex;
                align-items: baseline;
                gap: 8px;
                margin-bottom: 4px;
            }

            .fn-notification-username {
                font-size: 16px;
                font-weight: 700;
                color: #ffffff;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .fn-notification-channel {
                font-size: 12px;
                color: #b5bac1;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .fn-notification-message {
                font-size: 14px;
                font-weight: 500;
                color: #dbdee1;
                line-height: 1.4;
                word-wrap: break-word;
                word-break: break-word;
                overflow-wrap: break-word;
                overflow: hidden;
                display: -webkit-box;
                -webkit-line-clamp: 3;
                -webkit-box-orient: vertical;
            }

            .fn-notification-close {
                position: absolute;
                top: 8px;
                right: 8px;
                width: 20px;
                height: 20px;
                border: none;
                background: transparent;
                color: #b5bac1;
                cursor: pointer;
                font-size: 16px;
                line-height: 1;
                opacity: 0;
                transition: opacity 0.2s;
            }

            .fn-notification:hover .fn-notification-close {
                opacity: 1;
            }

            .fn-notification-close:hover {
                color: #ffffff;
            }
        `;

        BdApi.DOM.addStyle(this.name, css);
    }

    removeStyles() {
        BdApi.DOM.removeStyle(this.name);
    }

    createNotificationContainer() {
        this.notificationContainer = document.createElement("div");
        this.notificationContainer.className = "fn-notification-container";
        document.body.appendChild(this.notificationContainer);
    }

    removeNotificationContainer() {
        if (this.notificationContainer) {
            this.notificationContainer.remove();
            this.notificationContainer = null;
        }
    }

    cacheModules() {
        this.log("=== Searching for modules ===");

        if (BdApi.Webpack.getStore) {
            this.UserStore = BdApi.Webpack.getStore("UserStore");
            this.ChannelStore = BdApi.Webpack.getStore("ChannelStore");
            this.GuildStore = BdApi.Webpack.getStore("GuildStore");
            this.SelectedChannelStore = BdApi.Webpack.getStore("SelectedChannelStore");
            this.MutedStore = BdApi.Webpack.getStore("UserGuildSettingsStore");
            this.GuildMemberStore = BdApi.Webpack.getStore("GuildMemberStore");
            this.UserGuildSettingsStore = BdApi.Webpack.getStore("UserGuildSettingsStore");
        }

        let dispatcher = null;

        if (this.UserStore?._dispatcher) {
            dispatcher = this.UserStore._dispatcher;
        }

        if (!dispatcher?.subscribe && this.ChannelStore?._dispatcher) {
            dispatcher = this.ChannelStore._dispatcher;
        }

        if (!dispatcher?.subscribe) {
            dispatcher = BdApi.Webpack.getModule(m => {
                if (!m || typeof m !== 'object') return false;
                return typeof m.subscribe === 'function' &&
                       typeof m.unsubscribe === 'function';
            });
        }

        this.FluxDispatcher = dispatcher;
        this.log("FluxDispatcher:", this.FluxDispatcher ? "Found" : "Not found");
    }

    patchDispatcher() {
        if (!this.FluxDispatcher || typeof this.FluxDispatcher.subscribe !== 'function') {
            this.log("ERROR: FluxDispatcher.subscribe is not available!");
            this.showToast("FluxDispatcherが見つかりません", { type: "error" });
            return;
        }

        this.messageHandler = (event) => {
            this.debug("MESSAGE_CREATE event:", event);
            try {
                this.handleMessage(event.message, event.guildId);
            } catch (e) {
                this.log("Error handling message:", e);
            }
        };

        try {
            this.FluxDispatcher.subscribe("MESSAGE_CREATE", this.messageHandler);
            this.log("Successfully subscribed to MESSAGE_CREATE");
            this.showToast("通知プラグインが有効になりました", { type: "success" });
        } catch (e) {
            this.log("Failed to subscribe:", e);
        }
    }

    unpatchAll() {
        if (this.FluxDispatcher && this.messageHandler) {
            try {
                this.FluxDispatcher.unsubscribe("MESSAGE_CREATE", this.messageHandler);
                this.log("Unsubscribed from MESSAGE_CREATE");
            } catch (e) {
                this.log("Error unsubscribing:", e);
            }
        }
    }

    getDisplayName(author, guildId) {
        if (!author) return "Unknown";

        if (guildId && this.GuildMemberStore) {
            const member = this.GuildMemberStore.getMember(guildId, author.id);
            if (member?.nick) {
                return member.nick;
            }
        }

        if (author.globalName) {
            return author.globalName;
        }

        return author.username || "Unknown";
    }

    getAvatarUrl(author, guildId) {
        if (!author) return null;

        if (guildId && this.GuildMemberStore) {
            const member = this.GuildMemberStore.getMember(guildId, author.id);
            if (member?.avatar) {
                return `https://cdn.discordapp.com/guilds/${guildId}/users/${author.id}/avatars/${member.avatar}.webp?size=128`;
            }
        }

        if (author.avatar) {
            const ext = author.avatar.startsWith("a_") ? "gif" : "webp";
            return `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.${ext}?size=128`;
        }

        const defaultIndex = author.discriminator === "0"
            ? Number((BigInt(author.id) >> 22n) % 6n)
            : parseInt(author.discriminator) % 5;
        return `https://cdn.discordapp.com/embed/avatars/${defaultIndex}.png`;
    }

    async fetchAvatarAsBase64(url) {
        if (!url) return null;

        if (this.avatarCache.has(url)) {
            return this.avatarCache.get(url);
        }

        try {
            const response = await fetch(url);
            const blob = await response.blob();

            return new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => {
                    const base64 = reader.result;
                    if (this.avatarCache.size > 100) {
                        const firstKey = this.avatarCache.keys().next().value;
                        this.avatarCache.delete(firstKey);
                    }
                    this.avatarCache.set(url, base64);
                    resolve(base64);
                };
                reader.onerror = () => resolve(null);
                reader.readAsDataURL(blob);
            });
        } catch (e) {
            this.debug("Failed to fetch avatar:", e);
            return null;
        }
    }

    shouldNotifyByDiscordSettings(message, channel) {
        if (!this.settings.respectDiscordSettings) {
            return true;
        }

        // Botからのメッセージは常に通知（設定が有効な場合）
        if (this.settings.alwaysNotifyBots && message.author?.bot) {
            this.debug("Bot message - always notify");
            return true;
        }

        const guildId = channel.guild_id;
        const channelId = channel.id;
        const currentUser = this.UserStore?.getCurrentUser?.();

        if (!guildId) {
            return true;
        }

        if (this.UserGuildSettingsStore) {
            const isGuildMuted = this.UserGuildSettingsStore.isGuildMuted?.(guildId);
            if (isGuildMuted) {
                this.debug("Guild is muted");
                return false;
            }

            const isChannelMuted = this.UserGuildSettingsStore.isChannelMuted?.(guildId, channelId);
            if (isChannelMuted) {
                this.debug("Channel is muted");
                return false;
            }

            const channelOverride = this.UserGuildSettingsStore.getChannelMessageNotifications?.(guildId, channelId);
            const guildDefault = this.UserGuildSettingsStore.getMessageNotifications?.(guildId);

            this.debug("Channel override:", channelOverride, "Guild default:", guildDefault);

            // channelOverrideがnull/undefinedまたは0（サーバーデフォルトに従う）の場合はguildDefaultを使用
            const notificationLevel = (channelOverride != null && channelOverride !== 0) ? channelOverride : guildDefault;

            this.debug("Final notification level:", notificationLevel);

            // ミュート以外は常に通知（設定が有効な場合）
            if (this.settings.ignoreNotificationLevel) {
                this.debug("Ignoring notification level (not muted)");
                return true;
            }

            if (notificationLevel === 3) {
                this.debug("Notifications disabled");
                return false;
            }

            if (notificationLevel === 2) {
                const isMentioned = message.mentions?.some(m => m.id === currentUser?.id) ||
                                   message.mention_everyone ||
                                   this.isRoleMentioned(message, guildId, currentUser?.id);
                if (!isMentioned) {
                    this.debug("Mentions only - not mentioned");
                    return false;
                }
            }
        }

        return true;
    }

    isRoleMentioned(message, guildId, userId) {
        if (!message.mention_roles?.length) return false;

        if (this.GuildMemberStore) {
            const member = this.GuildMemberStore.getMember(guildId, userId);
            if (member?.roles) {
                return message.mention_roles.some(roleId => member.roles.includes(roleId));
            }
        }

        return false;
    }

    handleMessage(message, guildId) {
        if (!message) return;

        this.debug("Processing message:", message.id, "from:", message.author?.username, "bot:", message.author?.bot);

        const currentUser = this.UserStore?.getCurrentUser?.();
        if (!currentUser) return;

        if (message.author?.id === currentUser.id) return;

        const selectedChannel = this.SelectedChannelStore?.getChannelId?.();
        const hasFocus = document.hasFocus();
        this.debug("Channel check - selected:", selectedChannel, "message:", message.channel_id, "hasFocus:", hasFocus);
        if (selectedChannel === message.channel_id && hasFocus) {
            this.debug("Blocked - viewing same channel with focus");
            return;
        }

        const channel = this.ChannelStore?.getChannel?.(message.channel_id);
        if (!channel) return;

        if (!this.shouldNotifyByDiscordSettings(message, channel)) {
            this.debug("Blocked by Discord settings");
            return;
        }

        if (!this.shouldNotify(message, channel)) {
            this.debug("Blocked by plugin settings");
            return;
        }

        this.debug("Showing notification");
        this.showNotification(message, channel, guildId || channel.guild_id);
    }

    shouldNotify(message, channel) {
        if (this.settings.dmOnly && channel.type !== 1 && channel.type !== 3) {
            return false;
        }

        if (this.settings.mentionsOnly) {
            const currentUser = this.UserStore?.getCurrentUser?.();
            const isMentioned = message.mentions?.some(m => m.id === currentUser?.id) ||
                               message.mention_everyone ||
                               message.mention_roles?.length > 0;
            if (!isMentioned) return false;
        }

        return true;
    }

    async showNotification(message, channel, guildId) {
        const author = message.author;
        const content = this.formatContent(message);
        const displayName = this.getDisplayName(author, guildId);

        let channelName = "";
        let serverName = "";
        let channelInfo = "";

        if (this.settings.showChannelName && channel.name) {
            channelName = channel.name;
            channelInfo += `#${channel.name}`;
        }
        if (this.settings.showServerName && guildId) {
            const guild = this.GuildStore?.getGuild?.(guildId);
            if (guild) {
                serverName = guild.name;
                channelInfo += channelInfo ? ` • ${guild.name}` : guild.name;
            }
        }

        const avatarUrl = this.getAvatarUrl(author, guildId);

        // DiscordOverlayに通知を送信（最上面表示）
        if (this.settings.useOverlayNotification && this.pipeConnected) {
            const notificationData = {
                username: author?.username || "Unknown",
                displayName: displayName,
                content: content,
                avatarUrl: avatarUrl || "",
                avatarHash: author?.avatar || "",
                userId: author?.id || "",
                channelName: channelName,
                serverName: serverName
            };
            this.sendToPipe(notificationData);
            this.debug("Sent notification to DiscordOverlay");
        }

        // カスタム通知（Discord内表示）
        if (this.settings.useCustomNotification) {
            this.showCustomNotification(displayName, channelInfo, content, avatarUrl, channel, message.id);
        } else if (!this.settings.useOverlayNotification || !this.pipeConnected) {
            // Windows通知（フォールバック）
            try {
                const icon = await this.fetchAvatarAsBase64(avatarUrl);
                const notification = new Notification(displayName, {
                    body: content,
                    icon: icon || undefined,
                    silent: true,
                    tag: `discord-${message.id}`
                });

                notification.onclick = () => {
                    this.transitionToChannel(channel.guild_id, channel.id, message.id);
                    window.focus();
                    notification.close();
                };

                setTimeout(() => notification.close(), this.settings.notificationDuration);
            } catch (e) {
                this.log("Failed to show notification:", e);
            }
        }
    }

    showCustomNotification(username, channelInfo, content, avatarUrl, channel, messageId) {
        if (!this.notificationContainer) return;

        const notification = document.createElement("div");
        notification.className = "fn-notification";
        notification.innerHTML = `
            <img class="fn-notification-avatar" src="${avatarUrl || 'https://cdn.discordapp.com/embed/avatars/0.png'}" alt="">
            <div class="fn-notification-content">
                <div class="fn-notification-header">
                    <span class="fn-notification-username">${this.escapeHtml(username)}</span>
                    ${channelInfo ? `<span class="fn-notification-channel">${this.escapeHtml(channelInfo)}</span>` : ''}
                </div>
                <div class="fn-notification-message">${this.escapeHtml(content)}</div>
            </div>
            <button class="fn-notification-close">×</button>
        `;

        notification.addEventListener("click", (e) => {
            if (!e.target.classList.contains("fn-notification-close")) {
                this.transitionToChannel(channel.guild_id, channel.id, messageId);
                window.focus();
                this.closeNotification(notification);
            }
        });

        notification.querySelector(".fn-notification-close").addEventListener("click", (e) => {
            e.stopPropagation();
            this.closeNotification(notification);
        });

        this.notificationContainer.appendChild(notification);

        setTimeout(() => {
            this.closeNotification(notification);
        }, this.settings.notificationDuration);

        while (this.notificationContainer.children.length > 5) {
            this.closeNotification(this.notificationContainer.firstChild);
        }
    }

    closeNotification(notification) {
        if (!notification || notification.classList.contains("fn-fade-out")) return;

        notification.classList.add("fn-fade-out");
        setTimeout(() => {
            notification.remove();
        }, 300);
    }

    escapeHtml(text) {
        const div = document.createElement("div");
        div.textContent = text;
        return div.innerHTML;
    }

    formatContent(message) {
        let content = message.content || "";

        if (!content && message.embeds?.length > 0) {
            content = "[埋め込み] " + (message.embeds[0].title || message.embeds[0].description || "");
        }

        if (!content && message.attachments?.length > 0) {
            content = `[添付ファイル: ${message.attachments.length}件]`;
        }

        if (!content && message.sticker_items?.length > 0) {
            content = `[スタンプ: ${message.sticker_items[0].name}]`;
        }

        if (content.length > this.settings.maxContentLength) {
            content = content.substring(0, this.settings.maxContentLength) + "...";
        }

        return content || "[メッセージ]";
    }

    transitionToChannel(guildId, channelId, messageId) {
        const NavigationUtils = BdApi.Webpack.getByKeys("transitionTo", "transitionToGuild");
        if (NavigationUtils) {
            const path = guildId
                ? `/channels/${guildId}/${channelId}/${messageId}`
                : `/channels/@me/${channelId}/${messageId}`;
            NavigationUtils.transitionTo(path);
        }
    }

    getSettingsPanel() {
        const panel = document.createElement("div");
        panel.style.padding = "16px";
        panel.style.color = "var(--text-normal)";

        const dispatcherStatus = this.FluxDispatcher && typeof this.FluxDispatcher.subscribe === 'function';

        panel.innerHTML = `
            <style>
                .fn-settings-group { margin-bottom: 20px; }
                .fn-settings-group h3 {
                    color: var(--header-primary);
                    font-size: 16px;
                    font-weight: 600;
                    margin-bottom: 12px;
                    text-transform: uppercase;
                }
                .fn-setting-item {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 12px;
                    padding: 8px 0;
                }
                .fn-setting-label { display: flex; flex-direction: column; }
                .fn-setting-label span:first-child { font-weight: 500; }
                .fn-setting-label span:last-child { font-size: 12px; color: var(--text-muted); }
                .fn-switch { position: relative; width: 44px; height: 24px; }
                .fn-switch input { opacity: 0; width: 0; height: 0; }
                .fn-switch-slider {
                    position: absolute; cursor: pointer;
                    top: 0; left: 0; right: 0; bottom: 0;
                    background-color: var(--background-tertiary);
                    transition: 0.2s; border-radius: 12px;
                }
                .fn-switch-slider:before {
                    position: absolute; content: "";
                    height: 18px; width: 18px; left: 3px; bottom: 3px;
                    background-color: white; transition: 0.2s; border-radius: 50%;
                }
                .fn-switch input:checked + .fn-switch-slider { background-color: #43b581; }
                .fn-switch input:checked + .fn-switch-slider:before { transform: translateX(20px); }
                .fn-number-input {
                    width: 80px; padding: 8px;
                    border: 1px solid var(--background-tertiary);
                    border-radius: 4px;
                    background: var(--background-secondary);
                    color: var(--text-normal);
                }
                .fn-divider { height: 1px; background: var(--background-modifier-accent); margin: 16px 0; }
                .fn-status { padding: 10px; border-radius: 4px; margin-bottom: 16px; font-size: 13px; }
                .fn-status.ok { background: rgba(67, 181, 129, 0.2); color: #43b581; }
                .fn-status.error { background: rgba(237, 66, 69, 0.2); color: #ed4245; }
                .fn-btn {
                    border: none; padding: 10px 20px; border-radius: 4px;
                    cursor: pointer; font-weight: 500; margin-right: 10px;
                }
                .fn-btn-primary { background: #5865f2; color: white; }
                .fn-btn-secondary { background: #4f545c; color: white; }
                .fn-info {
                    background: rgba(88, 101, 242, 0.1);
                    border-left: 3px solid #5865f2;
                    padding: 10px;
                    margin-bottom: 16px;
                    font-size: 13px;
                }
            </style>

            <div class="fn-status ${dispatcherStatus ? 'ok' : 'error'}">
                ${dispatcherStatus ? '✓ FluxDispatcher: 接続済み' : '✗ FluxDispatcher: 未接続'}
            </div>
            <div class="fn-status ${this.pipeConnected ? 'ok' : 'error'}">
                ${this.pipeConnected ? '✓ DiscordOverlay: 接続済み' : '✗ DiscordOverlay: 未接続（アプリを起動してください）'}
            </div>

            <div class="fn-settings-group">
                <h3>通知設定</h3>
                <div class="fn-info">
                    DiscordOverlay連携を有効にすると、Discordを最小化していても最上面に通知が表示されます。
                </div>
                <div class="fn-setting-item">
                    <div class="fn-setting-label">
                        <span>DiscordOverlay連携（最上面通知）</span>
                        <span>DiscordOverlayに通知を送信（Discordを最小化しても表示）</span>
                    </div>
                    <label class="fn-switch">
                        <input type="checkbox" id="fn-useOverlayNotification" ${this.settings.useOverlayNotification ? "checked" : ""}>
                        <span class="fn-switch-slider"></span>
                    </label>
                </div>
                <div class="fn-setting-item">
                    <div class="fn-setting-label">
                        <span>カスタム通知を使用</span>
                        <span>Discord内にカスタム通知を表示（アイコン表示対応）</span>
                    </div>
                    <label class="fn-switch">
                        <input type="checkbox" id="fn-useCustomNotification" ${this.settings.useCustomNotification ? "checked" : ""}>
                        <span class="fn-switch-slider"></span>
                    </label>
                </div>
                <div class="fn-setting-item">
                    <div class="fn-setting-label">
                        <span>通知表示時間 (ミリ秒)</span>
                        <span>通知が自動で消えるまでの時間</span>
                    </div>
                    <input type="number" class="fn-number-input" id="fn-notificationDuration"
                           value="${this.settings.notificationDuration}" min="1000" max="30000" step="1000">
                </div>
                <div class="fn-setting-item">
                    <div class="fn-setting-label"><span>アバター表示</span><span>通知にユーザーアバターを表示</span></div>
                    <label class="fn-switch">
                        <input type="checkbox" id="fn-showAvatar" ${this.settings.showAvatar ? "checked" : ""}>
                        <span class="fn-switch-slider"></span>
                    </label>
                </div>
                <div class="fn-setting-item">
                    <div class="fn-setting-label"><span>チャンネル名表示</span><span>通知にチャンネル名を表示</span></div>
                    <label class="fn-switch">
                        <input type="checkbox" id="fn-showChannelName" ${this.settings.showChannelName ? "checked" : ""}>
                        <span class="fn-switch-slider"></span>
                    </label>
                </div>
                <div class="fn-setting-item">
                    <div class="fn-setting-label"><span>サーバー名表示</span><span>通知にサーバー名を表示</span></div>
                    <label class="fn-switch">
                        <input type="checkbox" id="fn-showServerName" ${this.settings.showServerName ? "checked" : ""}>
                        <span class="fn-switch-slider"></span>
                    </label>
                </div>
            </div>

            <div class="fn-divider"></div>

            <div class="fn-settings-group">
                <h3>フィルター設定</h3>
                <div class="fn-info">
                    「Discordの通知設定に従う」をONにすると、チャンネルごとの通知設定が反映されます。
                </div>
                <div class="fn-setting-item">
                    <div class="fn-setting-label">
                        <span>Discordの通知設定に従う</span>
                        <span>チャンネル/サーバーの通知設定を反映</span>
                    </div>
                    <label class="fn-switch">
                        <input type="checkbox" id="fn-respectDiscordSettings" ${this.settings.respectDiscordSettings ? "checked" : ""}>
                        <span class="fn-switch-slider"></span>
                    </label>
                </div>
                <div class="fn-setting-item">
                    <div class="fn-setting-label"><span>DMのみ</span><span>ダイレクトメッセージのみ通知する</span></div>
                    <label class="fn-switch">
                        <input type="checkbox" id="fn-dmOnly" ${this.settings.dmOnly ? "checked" : ""}>
                        <span class="fn-switch-slider"></span>
                    </label>
                </div>
                <div class="fn-setting-item">
                    <div class="fn-setting-label"><span>メンションのみ</span><span>自分へのメンションのみ通知する</span></div>
                    <label class="fn-switch">
                        <input type="checkbox" id="fn-mentionsOnly" ${this.settings.mentionsOnly ? "checked" : ""}>
                        <span class="fn-switch-slider"></span>
                    </label>
                </div>
                <div class="fn-setting-item">
                    <div class="fn-setting-label"><span>Botの通知を常に表示</span><span>Botからのメッセージは通知設定を無視して通知</span></div>
                    <label class="fn-switch">
                        <input type="checkbox" id="fn-alwaysNotifyBots" ${this.settings.alwaysNotifyBots ? "checked" : ""}>
                        <span class="fn-switch-slider"></span>
                    </label>
                </div>
                <div class="fn-setting-item">
                    <div class="fn-setting-label"><span>ミュート以外は常に通知</span><span>チャンネル/サーバーがミュートでなければ通知レベルを無視</span></div>
                    <label class="fn-switch">
                        <input type="checkbox" id="fn-ignoreNotificationLevel" ${this.settings.ignoreNotificationLevel ? "checked" : ""}>
                        <span class="fn-switch-slider"></span>
                    </label>
                </div>
            </div>

            <div class="fn-divider"></div>

            <div class="fn-settings-group">
                <h3>デバッグ</h3>
                <div class="fn-setting-item">
                    <div class="fn-setting-label"><span>デバッグモード</span><span>コンソールに詳細ログを出力</span></div>
                    <label class="fn-switch">
                        <input type="checkbox" id="fn-debugMode" ${this.settings.debugMode ? "checked" : ""}>
                        <span class="fn-switch-slider"></span>
                    </label>
                </div>
                <div style="margin-top: 12px;">
                    <button id="fn-test-button" class="fn-btn fn-btn-primary">テスト通知</button>
                    <button id="fn-reload-button" class="fn-btn fn-btn-secondary">モジュール再読込</button>
                </div>
            </div>
        `;

        const self = this;
        setTimeout(() => {
            ["useOverlayNotification", "useCustomNotification", "showAvatar", "showChannelName", "showServerName",
             "respectDiscordSettings", "dmOnly", "mentionsOnly", "alwaysNotifyBots", "ignoreNotificationLevel", "debugMode"].forEach(key => {
                const el = document.getElementById(`fn-${key}`);
                if (el) el.addEventListener("change", (e) => {
                    self.settings[key] = e.target.checked;
                    self.saveSettings();
                    if (key === "useOverlayNotification") {
                        if (e.target.checked) {
                            self.connectToPipe();
                        } else {
                            self.disconnectPipe();
                        }
                    }
                });
            });

            ["notificationDuration"].forEach(key => {
                const el = document.getElementById(`fn-${key}`);
                if (el) el.addEventListener("change", (e) => {
                    self.settings[key] = parseInt(e.target.value) || self.settings[key];
                    self.saveSettings();
                });
            });

            document.getElementById("fn-test-button")?.addEventListener("click", () => {
                if (self.settings.useOverlayNotification) {
                    if (self.pipeConnected) {
                        self.sendToPipe({
                            username: "TestUser",
                            displayName: "テストユーザー",
                            content: "これはテスト通知です。正常に動作しています！",
                            avatarUrl: "https://cdn.discordapp.com/embed/avatars/0.png",
                            avatarHash: "",
                            userId: "0",
                            channelName: "general",
                            serverName: "Test Server"
                        });
                        self.showToast("DiscordOverlayにテスト通知を送信しました", { type: "success" });
                    } else {
                        self.showToast("DiscordOverlayに未接続です", { type: "error" });
                    }
                }

                if (self.settings.useCustomNotification) {
                    self.showCustomNotification(
                        "テストユーザー",
                        "#general • Test Server",
                        "これはテスト通知です。正常に動作しています！",
                        "https://cdn.discordapp.com/embed/avatars/0.png",
                        { guild_id: null, id: null },
                        "test"
                    );
                    self.showToast("カスタム通知を送信しました", { type: "success" });
                }

                if (!self.settings.useOverlayNotification && !self.settings.useCustomNotification) {
                    const n = new Notification("ForceNotification テスト", {
                        body: "これはテスト通知です",
                        silent: true
                    });
                    setTimeout(() => n.close(), self.settings.notificationDuration);
                    self.showToast("Windows通知を送信しました", { type: "success" });
                }
            });

            document.getElementById("fn-reload-button")?.addEventListener("click", () => {
                self.unpatchAll();
                self.disconnectPipe();
                self.cacheModules();
                self.patchDispatcher();
                if (self.settings.useOverlayNotification) {
                    self.connectToPipe();
                }
                self.showToast("モジュールを再読込しました", { type: "success" });
            });
        }, 0);

        return panel;
    }
};
