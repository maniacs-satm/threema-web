/**
 * This file is part of Threema Web.
 *
 * Threema Web is free software: you can redistribute it and/or modify it
 * under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at
 * your option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero
 * General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with Threema Web. If not, see <http://www.gnu.org/licenses/>.
 */

import * as msgpack from 'msgpack-lite';
import {hexToU8a} from '../helpers';
import {TrustedKeyStoreService} from './keystore';
import {PeerConnectionHelper} from './peerconnection';

class WebClientDefault implements threema.WebClientDefault {
    private avatar: threema.AvatarRegistry = {
        group: {
            low: 'img/ic_group_t.png',
            high: 'img/ic_group_picture_big.png',
        },
        contact: {
            low: 'img/ic_contact_picture_t.png',
            high: 'img/ic_contact_picture_big.png',
        },
        distributionList: {
            low: 'img/ic_distribution_list_t.png',
            high: 'img/ic_distribution_list_t.png',
        },
    };

    /**
     * Return path to avatar.
     *
     * If the avatar type is invalid, return null.
     */
    public getAvatar(type: string, highResolution: boolean): string {
        let field: string = highResolution ? 'high' : 'low';
        if (typeof this.avatar[type] === 'undefined') {
            return null;
        }
        return this.avatar[type][field];
    }
}

/**
 * This service handles everything related to the communication with the peer.
 */
export class WebClientService implements threema.WebClientService {
    private static AVATAR_LOW_MAX_SIZE = 48;

    private static TYPE_REQUEST = 'request';
    private static TYPE_RESPONSE = 'response';
    private static TYPE_UPDATE = 'update';
    private static TYPE_CREATE = 'create';
    private static TYPE_DELETE = 'delete';
    private static SUB_TYPE_RECEIVER = 'receiver';
    private static SUB_TYPE_CONVERSATIONS = 'conversations';
    private static SUB_TYPE_CONVERSATION = 'conversation';
    private static SUB_TYPE_MESSAGE = 'message';
    private static SUB_TYPE_TEXT_MESSAGE = 'textMessage';
    private static SUB_TYPE_FILE_MESSAGE = 'fileMessage';
    private static SUB_TYPE_AVATAR = 'avatar';
    private static SUB_TYPE_THUMBNAIL = 'thumbnail';
    private static SUB_TYPE_BLOB = 'blob';
    private static SUB_TYPE_TYPING = 'typing';
    private static SUB_TYPE_READ = 'read';
    private static SUB_TYPE_CLIENT_INFO = 'clientInfo';
    private static SUB_TYPE_KEY_PERSISTED = 'keyPersisted';
    private static SUB_TYPE_ACK = 'ack';
    private static SUB_TYPE_CONTACT_DETAIL = 'contactDetail';
    private static SUB_TYPE_CONTACT = 'contact';
    private static SUB_TYPE_GROUP = 'group';
    private static SUB_TYPE_DISTRIBUTION_LIST = 'distributionList';
    private static SUB_TYPE_ALERT = 'alert';
    private static SUB_TYPE_GROUP_SYNC = 'groupSync';
    private static ARGUMENT_MODE = 'mode';
    private static ARGUMENT_MODE_REFRESH = 'refresh';
    private static ARGUMENT_MODE_NEW = 'new';
    private static ARGUMENT_MODE_MODIFIED = 'modified';
    private static ARGUMENT_MODE_REMOVED = 'removed';
    private static ARGUMENT_RECEIVER_TYPE = 'type';
    private static ARGUMENT_RECEIVER_ID = 'id';
    private static ARGUMENT_TEMPORARY_ID = 'temporaryId';
    private static ARGUMENT_REFERENCE_MSG_ID = 'refMsgId';
    private static ARGUMENT_AVATAR_HIGH_RESOLUTION = 'highResolution';
    private static ARGUMENT_CONTACT_IS_TYPING = 'isTyping';
    private static ARGUMENT_MESSAGE_ID = 'messageId';
    private static ARGUMENT_HAS_MORE = 'more';
    private static ARGUMENT_MESSAGE_ACKNOWLEDGED = 'acknowledged';
    private static ARGUMENT_IDENTITY = 'identity';
    private static ARGUMENT_SUCCESS = 'success';
    private static ARGUMENT_MESSAGE = 'message';
    private static ARGUMENT_SYSTEM_CONTACT = 'systemContact';
    private static ARGUMENT_NAME = 'name';
    private static ARGUMENT_MEMBERS = 'members';
    private static ARGUMENT_FIRST_NAME = 'firstName';
    private static ARGUMENT_LAST_NAME = 'lastName';
    private static ARGUMENT_DELETE_TYPE = 'deleteType';
    private static ARGUMENT_ERROR = 'error';
    private static ARGUMENT_MAX_SIZE = 'maxSize';
    private static DATA_FIELD_BLOB_BLOB = 'blob';
    private static DC_LABEL = 'THREEMA';

    private logTag: string = '[WebClientService]';

    // Angular services
    private $state: ng.ui.IStateService;
    private $log: ng.ILogService;
    private $rootScope: any;
    private $q: ng.IQService;
    private $window: ng.IWindowService;
    private $translate: ng.translate.ITranslateService;
    private $filter: any;
    private $timeout: ng.ITimeoutService;

    // Custom services
    private notificationService: threema.NotificationService;
    private messageService: threema.MessageService;
    private pushService: threema.PushService;
    private browserService: threema.BrowserService;
    private titleService: threema.TitleService;
    private fingerPrintService: threema.FingerPrintService;
    private qrCodeService: threema.QrCodeService;
    private mimeService: threema.MimeService;
    private receiverService: threema.ReceiverService;

    // State handling
    private startupPromise: ng.IDeferred<{}>; // TODO: deferred type
    private startupDone: boolean = false;
    private initialized = 0;
    private initializedThreshold = 3;
    private state: threema.StateService;

    // SaltyRTC
    private saltyRtcHost: string = null;
    public salty: saltyrtc.SaltyRTC = null;
    private webrtcTask: saltyrtc.tasks.webrtc.WebRTCTask = null;
    private secureDataChannel: saltyrtc.tasks.webrtc.SecureDataChannel = null;

    // Messenger data
    public messages: threema.Container.Messages;
    public conversations: threema.Container.Conversations;
    public receivers: threema.Container.Receivers;
    public alerts: threema.Alert[] = [];
    public defaults: threema.WebClientDefault;
    private myIdentity: threema.Identity;
    private pushToken: string = null;

    // Other
    private config: threema.Config;
    private container: threema.Container.Factory;
    private typingInstance: threema.Container.Typing;
    private drafts: threema.Container.Drafts;
    private pcHelper: PeerConnectionHelper = null;
    private deviceInfo: string = null;
    private trustedKeyStore: TrustedKeyStoreService;

    private blobCache = new Map<String, ArrayBuffer>();
    private loadingMessages = new Map<String, boolean>();

    public receiverListener: threema.ReceiverListener[] = [];

    // Msgpack
    private msgpackOptions: msgpack.BufferOptions = {
        codec: msgpack.createCodec({binarraybuffer: true}),
    };

    // pending rtc promises
    private requestPromises: Map<string, threema.PromiseCallbacks> = new Map();

    public static $inject = [
        '$log', '$rootScope', '$q', '$state', '$window', '$translate', '$filter', '$timeout',
        'Container', 'TrustedKeyStore',
        'StateService', 'NotificationService', 'MessageService', 'PushService', 'BrowserService',
        'TitleService', 'FingerPrintService', 'QrCodeService', 'MimeService', 'ReceiverService',
        'CONFIG',
    ];
    constructor($log: ng.ILogService,
                $rootScope: any,
                $q: ng.IQService,
                $state: ng.ui.IStateService,
                $window: ng.IWindowService,
                $translate: ng.translate.ITranslateService,
                $filter: ng.IFilterService,
                $timeout: ng.ITimeoutService,
                container: threema.Container.Factory,
                trustedKeyStore: TrustedKeyStoreService,
                stateService: threema.StateService,
                notificationService: threema.NotificationService,
                messageService: threema.MessageService,
                pushService: threema.PushService,
                browserService: threema.BrowserService,
                titleService: threema.TitleService,
                fingerPrintService: threema.FingerPrintService,
                qrCodeService: threema.QrCodeService,
                mimeService: threema.MimeService,
                receiverService: threema.ReceiverService,
                CONFIG: threema.Config) {

        // Angular services
        this.$log = $log;
        this.$rootScope = $rootScope;
        this.$q = $q;
        this.$state = $state;
        this.$window = $window;
        this.$translate = $translate;
        this.$filter = $filter;
        this.$timeout = $timeout;

        // Own services
        this.notificationService = notificationService;
        this.messageService = messageService;
        this.pushService = pushService;
        this.browserService = browserService;
        this.titleService = titleService;
        this.fingerPrintService = fingerPrintService;
        this.qrCodeService = qrCodeService;
        this.mimeService = mimeService;
        this.receiverService = receiverService;

        // Configuration object
        this.config = CONFIG;

        // State
        this.state = stateService;

        // Other properties
        this.container = container;
        this.trustedKeyStore = trustedKeyStore;

        // Get default class
        this.defaults = new WebClientDefault();

        this.drafts = this.container.createDrafts();

        // Setup fields
        this._resetFields();
    }

    get me(): threema.MeReceiver {
        return this.receivers.me;
    }

    get contacts(): Map<string, threema.ContactReceiver> {
        return this.receivers.contacts;
    }

    get groups(): Map<string, threema.GroupReceiver> {
        return this.receivers.groups;
    }

    get distributionLists(): Map<string, threema.DistributionListReceiver>  {
        return this.receivers.distributionLists;
    }

    get typing(): threema.Container.Typing {
        return this.typingInstance;
    }
    /**
     * Return QR code payload.
     */
    public buildQrCodePayload(persistent: boolean): string {
        return this.qrCodeService.buildQrCodePayload(
            this.salty.permanentKeyBytes,
            this.salty.authTokenBytes,
            hexToU8a(this.config.SALTYRTC_SERVER_KEY),
            this.saltyRtcHost, this.config.SALTYRTC_PORT,
            persistent);
    }

    /**
     * Initialize the webclient service.
     */
    public init(keyStore?: saltyrtc.KeyStore, peerTrustedKey?: Uint8Array, resetFields = true): void {
        // Reset state
        this.state.reset();

        // Create WebRTC task instance
        const maxPacketSize = this.browserService.getBrowser().firefox ? 16384 : 65536;
        this.webrtcTask = new saltyrtcTaskWebrtc.WebRTCTask(true, maxPacketSize);

        // Create new keystore if necessary
        if (!keyStore) {
            keyStore = new saltyrtcClient.KeyStore();
        }

        // Determine SaltyRTC host
        if (this.config.SALTYRTC_HOST !== null) {
            // Static URL
            this.saltyRtcHost = this.config.SALTYRTC_HOST;
        } else {
            // Construct URL using prefix and suffix
            this.saltyRtcHost = this.config.SALTYRTC_HOST_PREFIX
                + keyStore.publicKeyHex.substr(0, 2)
                + this.config.SALTYRTC_HOST_SUFFIX;
        }

        // Create SaltyRTC client
        let builder = new saltyrtcClient.SaltyRTCBuilder()
            .connectTo(this.saltyRtcHost, this.config.SALTYRTC_PORT)
            .withServerKey(this.config.SALTYRTC_SERVER_KEY)
            .withKeyStore(keyStore)
            .usingTasks([this.webrtcTask])
            .withPingInterval(30);
        if (keyStore !== undefined && peerTrustedKey !== undefined) {
            builder = builder.withTrustedPeerKey(peerTrustedKey);
        }
        this.salty = builder.asInitiator();

        // We want to know about new responders.
        this.salty.on('new-responder', () => {
            if (!this.startupDone) {
                // Peer handshake
                this.state.updateConnectionBuildupState('peer_handshake');
            }
        });

        // We want to know about state changes
        this.salty.on('state-change', (ev: saltyrtc.SaltyRTCEvent) => {
            // Wrap this in a $timeout to execute at the end of the event loop.
            this.$timeout(() => {
                let state: saltyrtc.SignalingState = ev.data;
                if (!this.startupDone) {
                    switch (state) {
                        case 'new':
                        case 'ws-connecting':
                        case 'server-handshake':
                            if (this.state.connectionBuildupState !== 'push'
                                && this.state.connectionBuildupState !== 'manual_start') {
                                this.state.updateConnectionBuildupState('connecting');
                            }
                            break;
                        case 'peer-handshake':
                            // Waiting for peer
                            if (this.state.connectionBuildupState !== 'push'
                                && this.state.connectionBuildupState !== 'manual_start') {
                                this.state.updateConnectionBuildupState('waiting');
                            }
                            break;
                        case 'task':
                            // Do nothing, state will be updated once SecureDataChannel is open
                            break;
                        case 'closing':
                        case 'closed':
                            this.state.updateConnectionBuildupState('closed');
                            break;
                        default:
                            this.$log.warn('Unknown signaling state:', state);
                    }
                }
                this.state.updateSignalingConnectionState(state);
            }, 0);
        });

        // Once the connection is established, initiate the peer connection
        // and start the handover.
        this.salty.once('state-change:task', () => {
            this.pcHelper = new PeerConnectionHelper(this.$log, this.$q, this.$timeout,
                                                     this.$rootScope, this.webrtcTask,
                                                     this.config.SALTYRTC_STUN, this.config.SALTYRTC_TURN);

            // On state changes in the PeerConnectionHelper class, let state service know about it
            this.pcHelper.onConnectionStateChange = (state: threema.RTCConnectionState) => {
                if (state === 'connected' && this.state.wasConnected) {
                    // this happens if a lost connection could be restored
                    // without reset the peer connection
                    this._requestInitialData();
                }
                this.state.updateRtcConnectionState(state);
            };

            // Initiate handover
            this.webrtcTask.handover(this.pcHelper.peerConnection);
        });

        // Handle a disconnect request
        this.salty.on('application', (applicationData: any) => {
            if (applicationData.data.type === 'disconnect') {
                this.$log.debug('Disconnecting requested');
                const deleteStoredData = applicationData.data.forget === true;
                const resetPush = true;
                const redirect = true;
                this.stop(false, deleteStoredData, resetPush, redirect);
            }
        });

        // Wait for handover to be finished
        this.salty.on('handover', () => {
            this.$log.debug('Handover done');

            // Ask user for notification permission
            this.$log.debug('Check notification permission...');
            this.notificationService.requestNotificationPermission();

            // Create secure data channel
            this.$log.debug('Create SecureDataChannel "' + WebClientService.DC_LABEL + '"...');
            this.secureDataChannel = this.pcHelper.createSecureDataChannel(
                WebClientService.DC_LABEL,
                (event: Event) => {
                    this.$log.debug('SecureDataChannel open');

                    // Initialize fields
                    if (resetFields) {
                        this._resetFields();
                    }

                    // Request initial data
                    this._requestInitialData();

                    // Notify state service about data loading
                    this.state.updateConnectionBuildupState('loading');
                },
            );

            // Handle incoming messages
            type RTCMessageEvent = (event: MessageEvent) => void;
            this.secureDataChannel.onmessage = (event: MessageEvent) => {
                this.$log.debug('New incoming message (' + event.data.byteLength + ' bytes)');

                // Decode bytes
                const bytes = new Uint8Array(event.data);
                const message: threema.WireMessage = this.msgpackDecode(bytes);

                // Validate message to keep contract defined by `threema.WireMessage` type
                if (message.type === undefined) {
                    this.$log.warn('Ignoring invalid message (no type attribute)');
                    return;
                } else if (message.subType === undefined) {
                    this.$log.warn('Ignoring invalid message (no subType attribute)');
                    return;
                }

                // Process data
                this.$rootScope.$apply(() => {
                    this.receive(message);
                });
            };
            this.secureDataChannel.onbufferedamountlow = (e: Event) => {
                this.$log.debug('Secure data channel: Buffered amount low');
            };
            this.secureDataChannel.onerror = (e: ErrorEvent) => {
                this.$log.warn('Secure data channel: Error:', e.message);
                this.$log.debug(e);
            };
            this.secureDataChannel.onclose = (e: Event) => {
                this.$log.warn('Secure data channel: Closed');
            };
        });

        // Handle SaltyRTC errors
        this.salty.on('connection-error', (ev) => {
            this.$log.error('Connection error:', ev);
        });
        this.salty.on('connection-closed', (ev) => {
            this.$log.warn('Connection closed:', ev);
        });
    }

    /**
     * Start the webclient service.
     * Return a promise that resolves once connected.
     */
    public start(): ng.IPromise<any> {
        this.$log.debug('Starting WebClientService...');

        // Promise to track startup state
        this.startupPromise = this.$q.defer();
        this.startupDone = false;

        // Connect
        this.salty.connect();

        // If push service is available, notify app
        if (this.pushService.isAvailable()) {
            this.pushService.sendPush(this.salty.permanentKeyBytes)
                .catch(() => this.$log.warn('Could not notify app!'))
                .then(() => {
                    this.$log.debug('Requested app wakeup');
                    this.state.updateConnectionBuildupState('push');
                });
        } else if (this.trustedKeyStore.hasTrustedKey()) {
            this.$log.debug('Push service not available');
            this.state.updateConnectionBuildupState('manual_start');
        }

        return this.startupPromise.promise;
    }

    /**
     * Stop the webclient service.
     *
     * This is a forced stop, meaning that all channels are closed.
     *
     * Parameters:
     *
     * - `requestedByUs`: Set this to `false` if the app requested to close the session.
     * - `deleteStoredData`: Whether to clear any trusted key or push token from the keystore.
     * - `resetPush`: Whether to reset the push service.
     * - `redirect`: Whether to redirect to the welcome page.
     */
    public stop(requestedByUs: boolean,
                deleteStoredData: boolean = false,
                resetPush: boolean = true,
                redirect: boolean = false): void {
        this.$log.info('Disconnecting...');

        if (requestedByUs && this.state.rtcConnectionState === 'connected') {
            // Ask peer to disconnect too
            this.salty.sendApplicationMessage({type: 'disconnect', forget: deleteStoredData});
        }

        this.state.reset();

        // Clear stored data (trusted key, push token, etc)
        if (deleteStoredData === true) {
            this.trustedKeyStore.clearTrustedKey();
        }

        // Clear push token
        if (resetPush === true) {
            this.pushService.reset();
        }

        // Close data channel
        if (this.secureDataChannel !== null) {
            this.$log.debug('Closing secure datachannel');
            this.secureDataChannel.close();
        }

        // Close SaltyRTC connection
        if (this.salty !== null) {
            this.$log.debug('Closing signaling');
            this.salty.disconnect();
        }

        // Function to redirect to welcome screen
        const redirectToWelcome = () => {
            if (redirect === true) {
                this.$timeout(() => {
                    this.$state.go('welcome');
                }, 0);
            }
        };

        // Close peer connection
        if (this.pcHelper !== null) {
            this.$log.debug(this.logTag, 'Closing peer connection');
            this.pcHelper.close()
                .then(
                    () => this.$log.debug(this.logTag, 'Peer connection was closed'),
                    (reason: string) => this.$log.warn(this.logTag, 'Peer connection could not be closed:', reason),
                )
                .finally(() => redirectToWelcome());
        } else {
            this.$log.debug(this.logTag, 'Peer connection was null');
            redirectToWelcome();
        }
    }

    // Mark a component as initialized
    public registerInitializationStep(name: string) {
        this.initialized += 1;
        if (this.initialized >= this.initializedThreshold) {
            this.state.updateConnectionBuildupState('done');
            this.startupPromise.resolve();
            this.startupDone = true;
        }
    }

    public setReceiverListener(listener: threema.ReceiverListener): void {
        this.receiverListener.push(listener);
    }

    /**
     * Send all client info request.
     */
    public requestClientInfo(): void {
        this.$log.debug('Sending client info request');
        this._sendRequest(WebClientService.SUB_TYPE_CLIENT_INFO, {
            browser: navigator.userAgent,
        });
    }

    /**
     * Send a receiver request.
     */
    public requestReceivers(): void {
        this.$log.debug('Sending receiver request');
        this._sendRequest(WebClientService.SUB_TYPE_RECEIVER);
    }

    /**
     * Send a conversation request.
     */
    public requestConversations(): void {
        this.$log.debug('Sending conversation request');
        this._sendRequest(WebClientService.SUB_TYPE_CONVERSATIONS, {
            [WebClientService.ARGUMENT_MAX_SIZE]: WebClientService.AVATAR_LOW_MAX_SIZE,
        });
    }

    /**
     * Send a message request for the specified receiver.
     *
     * This method will only be called when initializing a conversation in the
     * webclient. It is used to download all existing messages.
     *
     * New messages are not requested this way, instead they are sent as a
     * message update.
     */
    public requestMessages(receiver: threema.Receiver): number {
        // If there are no more messages available, stop here.
        if (!this.messages.hasMore(receiver)) {
            this.messages.notify(receiver, this.$rootScope);
            return null;
        }

        this.loadingMessages.set(receiver.type + receiver.id, true);

        // Check if messages have already been requested
        if (this.messages.isRequested(receiver)) {
            return null;
        }

        // Get the reference msg id
        const refMsgId = this.messages.getReferenceMsgId(receiver);

        // Set requested
        // TODO: Add timeout to reset flag
        this.messages.setRequested(receiver);

        // Create arguments
        const args = {
            [WebClientService.ARGUMENT_RECEIVER_TYPE]: receiver.type,
            [WebClientService.ARGUMENT_RECEIVER_ID]: receiver.id,
        } as any;

        // If a reference msg id has been set, send it along
        const msgId = this.messages.getReferenceMsgId(receiver);
        if (msgId !== null) {
            args[WebClientService.ARGUMENT_REFERENCE_MSG_ID] = msgId;
        }

        // Send request
        this.$log.debug('Sending message request for', receiver.type, receiver.id,
            'with message id', msgId);

        this._sendRequest(WebClientService.SUB_TYPE_MESSAGE, args);

        return refMsgId;
    }

    /**
     * Send an avatar request for the specified receiver.
     */
    public requestAvatar(receiver: threema.Receiver, highResolution: boolean): Promise<any> {
        // Check if the receiver has an avatar or the avatar already exists
        let resolution = highResolution ? 'high' : 'low';
        let receiverInfo = this.receivers.getData(receiver);
        if (receiverInfo && receiverInfo.avatar && receiverInfo.avatar[resolution]) {
            // Avatar already exists
            // TODO: Do we get avatar changes via update?
            return new Promise<any>((e) => {
                e(receiverInfo.avatar[resolution]);
            });
        }

        // Create arguments and send request
        let args = {
            [WebClientService.ARGUMENT_RECEIVER_TYPE]: receiver.type,
            [WebClientService.ARGUMENT_RECEIVER_ID]: receiver.id,
            [WebClientService.ARGUMENT_AVATAR_HIGH_RESOLUTION]: highResolution,
        } as any;

        if (!highResolution) {
           args[WebClientService.ARGUMENT_MAX_SIZE] = WebClientService.AVATAR_LOW_MAX_SIZE;
        }

        this.$log.debug('Sending', resolution, 'res avatar request for', receiver.type, receiver.id);
        return this._sendRequestPromise(WebClientService.SUB_TYPE_AVATAR, args, 10000);
    }

    /**
     * Send an thumbnail request for the specified receiver.
     */
    public requestThumbnail(receiver: threema.Receiver, message: threema.Message): Promise<any> {
        // Check if the receiver has an avatar or the avatar already exists
        if (message.thumbnail !== undefined && message.thumbnail.img !== undefined) {
            return new Promise<any>((e) => {
                e(message.thumbnail.img);
            });
        }

        // Create arguments and send request
        const args = {
            [WebClientService.ARGUMENT_MESSAGE_ID]: message.id,
            [WebClientService.ARGUMENT_RECEIVER_TYPE]: receiver.type,
            [WebClientService.ARGUMENT_RECEIVER_ID]: receiver.id,
        };

        this.$log.debug('Sending', 'thumbnail request for', receiver.type, message.id);
        return this._sendRequestPromise(WebClientService.SUB_TYPE_THUMBNAIL, args, 10000);
    }

    /**
     * Request a blob.
     */
    public requestBlob(msgId: number, receiver: threema.Receiver): Promise<ArrayBuffer> {
        let cached = this.blobCache.get(msgId + receiver.type);

        if (cached !== undefined) {

            this.$log.debug('Use cached blob');
            return new Promise((resolve) => {
                resolve(cached);
            });
        }
        const args = {
            [WebClientService.ARGUMENT_RECEIVER_TYPE]: receiver.type,
            [WebClientService.ARGUMENT_RECEIVER_ID]: receiver.id,
            [WebClientService.ARGUMENT_MESSAGE_ID]: msgId,
        };
        this.$log.debug('Sending blob request for message', msgId);
        return this._sendRequestPromise(WebClientService.SUB_TYPE_BLOB, args);
    }

    /**
     */
    public requestRead(receiver, newestMessageId: number): void {
        // Check if the receiver has an avatar or the avatar already exists
        // let field: string = highResolution ? 'high' : 'low';
        // let data = this.receivers.getData(receiver);
        // if (data && data['avatar'] && data['avatar'][field]) {
        //     return;
        // }
        // if (data && data.hasAvatar === false) {
        //     return;
        // }

        // Create arguments and send request
        let args = {
            [WebClientService.ARGUMENT_RECEIVER_TYPE]: receiver.type,
            [WebClientService.ARGUMENT_RECEIVER_ID]: receiver.id,
            [WebClientService.ARGUMENT_MESSAGE_ID]: newestMessageId,
        };
        this.$log.debug('Sending read request for', receiver.type, receiver.id, '(msg ' + newestMessageId + ')');
        this._sendRequest(WebClientService.SUB_TYPE_READ, args);
    }

    public requestContactDetail(contactReceiver: threema.ContactReceiver): Promise<any> {
        return this._sendRequestPromise(WebClientService.SUB_TYPE_CONTACT_DETAIL, {
            [WebClientService.ARGUMENT_IDENTITY]: contactReceiver.id,
        });
    }

    /**
     * Send a message to the specified receiver.
     */
    public sendMessage(receiver,
                       type: threema.MessageContentType,
                       message: threema.MessageData): Promise<Promise<any>> {
        return new Promise<any> (
            (resolve, reject) => {
                // Decide on subtype
                let subType;
                switch (type) {
                    case 'text':
                        subType = WebClientService.SUB_TYPE_TEXT_MESSAGE;
                        // Ignore empty text messages
                        if ((message as threema.TextMessageData).text.length === 0) {
                            return reject();
                        }
                        break;
                    case 'file':
                        // validate max file size of 20mb
                        if ((message as threema.FileMessageData).size > 15 * 1024 * 1024) {
                            return reject(this.$translate.instant('error.FILE_TOO_LARGE'));
                        }
                        // determine feature required feature level
                        let requiredFeatureLevel = 3;
                        let invalidFeatureLevelMessage = 'error.FILE_MESSAGES_NOT_SUPPORTED';
                        if ((message as threema.FileMessageData).sendAsFile !== true) {
                            // check mime type
                            let mime = (message as threema.FileMessageData).fileType;

                            if (this.mimeService.isAudio(mime)) {
                                requiredFeatureLevel = 1;
                                invalidFeatureLevelMessage = 'error.AUDIO_MESSAGES_NOT_SUPPORTED';
                            } else if (this.mimeService.isImage(mime)
                                || this.mimeService.isVideo(mime)) {
                                requiredFeatureLevel = 0;
                                invalidFeatureLevelMessage = 'error.MESSAGE_NOT_SUPPORTED';
                            }
                        }

                        subType = WebClientService.SUB_TYPE_FILE_MESSAGE;

                        // check receiver
                        switch (receiver.type) {
                            case 'distributionList':
                                return reject(this.$translate.instant(invalidFeatureLevelMessage, {
                                    receiverName: receiver.displayName}));
                            case 'group':
                                let unsupportedMembers = [];
                                let group = this.groups.get(receiver.id);

                                if (group === undefined) {
                                    return reject();
                                }
                                group.members.forEach((identity: string) => {
                                    if (identity !== this.me.id) {
                                        // ignore "me"
                                        let contact = this.contacts.get(identity);
                                        if (contact !== undefined && contact.featureLevel < requiredFeatureLevel) {
                                            unsupportedMembers.push(contact.displayName);
                                        }
                                    }
                                });

                                if (unsupportedMembers.length > 0) {
                                    return reject(this.$translate.instant(invalidFeatureLevelMessage, {
                                        receiverName: unsupportedMembers.join(',')}));
                                }
                                break;
                            case 'contact':
                                let contact = this.contacts.get(receiver.id);
                                if (contact === undefined || contact.featureLevel < requiredFeatureLevel) {
                                    return reject(this.$translate.instant(invalidFeatureLevelMessage, {
                                        receiverName: contact.displayName}));
                                }
                                break;
                            default:
                                return reject();
                        }
                        break;
                    default:
                        this.$log.warn('Invalid message type:', type);
                        return reject();
                }

                let temporaryMessage = this.messageService.createTemporary(receiver, type, message);
                this.messages.addNewer(receiver, [temporaryMessage]);

                let args = {
                    [WebClientService.ARGUMENT_RECEIVER_TYPE]: receiver.type,
                    [WebClientService.ARGUMENT_RECEIVER_ID]: receiver.id,
                    [WebClientService.ARGUMENT_TEMPORARY_ID]: temporaryMessage.temporaryId,
                };

                // send message and handling error promise
                this._sendCreatePromise(subType, args, message)
                    .catch((error) => {
                        this.$log.error('error sending file', error);
                        // remove temporary message
                        this.messages.removeTemporary(receiver, temporaryMessage.temporaryId);

                        let errorMessage;
                        switch (error) {
                            case 'file_too_large':
                                errorMessage = this.$translate.instant('error.FILE_TOO_LARGE');
                                break;
                            default:
                                errorMessage = this.$translate.instant('error.ERROR_OCCURRED');
                        }
                        this.alerts.push({
                            source: 'sendMessage',
                            type: 'alert',
                            message: errorMessage,
                        } as threema.Alert);
                    });
                resolve();
            });
    }

    /**
     * Send a message a ack/decline message
     */
    public ackMessage(receiver, message: threema.Message, acknowledged: boolean = true): void {
        // Ignore empty text messages
        // TODO check into a util class
        if (message === undefined
            || message.isOutbox) {
            return;
        }

        let args = {
            [WebClientService.ARGUMENT_RECEIVER_TYPE]: receiver.type,
            [WebClientService.ARGUMENT_RECEIVER_ID]: receiver.id,
            [WebClientService.ARGUMENT_MESSAGE_ID]: message.id,
            [WebClientService.ARGUMENT_MESSAGE_ACKNOWLEDGED]: acknowledged,
        };
        this._sendRequest(WebClientService.SUB_TYPE_ACK, args);
    }

    /**
     * Send a message a ack/decline message
     */
    public deleteMessage(receiver, message: threema.Message): void {
        // Ignore empty text messages
        if (message === undefined) {
            return;
        }

        let args = {
            [WebClientService.ARGUMENT_RECEIVER_TYPE]: receiver.type,
            [WebClientService.ARGUMENT_RECEIVER_ID]: receiver.id,
            [WebClientService.ARGUMENT_MESSAGE_ID]: message.id,
        };
        this._sendDelete(WebClientService.SUB_TYPE_MESSAGE, args);
    }

    public sendMeIsTyping(receiver, isTyping: boolean): void {
        // Create arguments and send create
        let args = {
            [WebClientService.ARGUMENT_RECEIVER_TYPE]: receiver.type,
            [WebClientService.ARGUMENT_RECEIVER_ID]: receiver.id,
            [WebClientService.ARGUMENT_CONTACT_IS_TYPING]: isTyping,
        };
        this._sendRequest(WebClientService.SUB_TYPE_TYPING, args);
    }

    public sendKeyPersisted(): void {
        this._sendRequest(WebClientService.SUB_TYPE_KEY_PERSISTED);
    }

    /**
     * Send a add Contact request
     */
    public addContact(threemaId: String): Promise<threema.ContactReceiver> {
        return this._sendCreatePromise(WebClientService.SUB_TYPE_CONTACT, {
            [WebClientService.ARGUMENT_IDENTITY]: threemaId,
        });
    }

    /**
     * Modify a contact name or a avatar
     */
    public modifyContact(threemaId: String,
                         firstName: String,
                         lastName: String,
                         avatar?: ArrayBuffer): Promise<threema.ContactReceiver> {
        let promise = this._sendUpdatePromise(WebClientService.SUB_TYPE_CONTACT, {
            [WebClientService.ARGUMENT_IDENTITY]: threemaId,
        }, {
            [WebClientService.ARGUMENT_FIRST_NAME]: firstName,
            [WebClientService.ARGUMENT_LAST_NAME]: lastName,
            [WebClientService.ARGUMENT_AVATAR_HIGH_RESOLUTION]: avatar,
        });

        if (avatar !== undefined) {
            // reset avatar to force a avatar reload
            this.receivers.getData({
                type: 'contact',
                id: threemaId,
            } as threema.Receiver).avatar = {};
        }
        return promise;
    }

    /**
     * Create a group receiver
     */
    public createGroup(members: String[],
                       name: String = null,
                       avatar?: ArrayBuffer): Promise<threema.GroupReceiver> {
        let data = {
            [WebClientService.ARGUMENT_MEMBERS]: members,
            [WebClientService.ARGUMENT_NAME]: name,
        } as any;

        if (avatar !== undefined) {
            data[WebClientService.ARGUMENT_AVATAR_HIGH_RESOLUTION] = avatar;
        }

        return this._sendCreatePromise(WebClientService.SUB_TYPE_GROUP, data);
    }

    public modifyGroup(id: string,
                       members: String[],
                       name: String = null,
                       avatar?: ArrayBuffer): Promise<threema.GroupReceiver> {
        let data = {
            [WebClientService.ARGUMENT_MEMBERS]: members,
            [WebClientService.ARGUMENT_NAME]: name,
        } as any;

        if (avatar !== undefined) {
            data[WebClientService.ARGUMENT_AVATAR_HIGH_RESOLUTION] = avatar;
        }
        let promise = this._sendUpdatePromise(WebClientService.SUB_TYPE_GROUP, {
            [WebClientService.ARGUMENT_RECEIVER_ID]: id,
        }, data);

        if (avatar !== undefined) {
            // reset avatar to force a avatar reload
            this.receivers.getData({
                type: 'group',
                id: id,
            } as threema.GroupReceiver).avatar = {};
        }
        return promise;
    }

    public leaveGroup(group: threema.GroupReceiver): Promise<any> {
        if (group === undefined || !group.access.canLeave) {
            return new Promise((resolve, reject) => reject('not allowed'));
        }

        let args = {
            [WebClientService.ARGUMENT_RECEIVER_ID]: group.id,
            // TODO: delete type into const
            [WebClientService.ARGUMENT_DELETE_TYPE]: 'leave',
        };

        return this._sendDeletePromise(WebClientService.SUB_TYPE_GROUP, args);
    }

    public deleteGroup(group: threema.GroupReceiver): Promise<any> {
        if (group === undefined || !group.access.canDelete) {
            return new Promise<any> (
                (resolve, reject) => {
                    reject('not allowed');
                });
        }

        let args = {
            [WebClientService.ARGUMENT_RECEIVER_ID]: group.id,
            // TODO: delete type into const
            [WebClientService.ARGUMENT_DELETE_TYPE]: 'delete',
        };

        return this._sendDeletePromise(WebClientService.SUB_TYPE_GROUP, args);
    }

    public syncGroup(group: threema.GroupReceiver): Promise<any> {
        if (group === undefined || !group.access.canSync) {
            return new Promise<any> (
                (resolve, reject) => {
                    reject('not allowed');
                });
        }

        let args = {
            [WebClientService.ARGUMENT_RECEIVER_ID]: group.id,
        };

        return this._sendRequestPromise(WebClientService.SUB_TYPE_GROUP_SYNC, args);
    }

    public createDistributionList(members: String[], name: String = null): Promise<threema.DistributionListReceiver> {
        let data = {
            [WebClientService.ARGUMENT_MEMBERS]: members,
            [WebClientService.ARGUMENT_NAME]: name,
        } as any;

        return this._sendCreatePromise(WebClientService.SUB_TYPE_DISTRIBUTION_LIST, data);
    }

    public modifyDistributionList(id: string,
                                  members: String[],
                                  name: String = null): Promise<threema.DistributionListReceiver> {
        let data = {
            [WebClientService.ARGUMENT_MEMBERS]: members,
            [WebClientService.ARGUMENT_NAME]: name,
        } as any;

        return this._sendUpdatePromise(WebClientService.SUB_TYPE_DISTRIBUTION_LIST, {
            [WebClientService.ARGUMENT_RECEIVER_ID]: id,
        }, data);
    }

    public deleteDistributionList(distributionList: threema.DistributionListReceiver): Promise<any> {
        if (distributionList === undefined || !distributionList.access.canDelete) {
            return new Promise((resolve, reject) => reject('not allowed'));
        }

        let args = {
            [WebClientService.ARGUMENT_RECEIVER_ID]: distributionList.id,
        };

        return this._sendDeletePromise(WebClientService.SUB_TYPE_DISTRIBUTION_LIST, args);
    }

    /**
     * Return whether the specified contact is currently typing.
     *
     * This always returns false for groups and distribution lists.
     */
    public isTyping(receiver: threema.ContactReceiver): boolean {
        return this.typing.isTyping(receiver);
    }

    /**
     * Return own identity.
     */
    public getMyIdentity(): threema.Identity {
        return this.myIdentity;
    }

    /**
     * Return the curring quoted message model
     */
    public getQuote(receiver: threema.Receiver): threema.Quote {
        return this.drafts.getQuote(receiver);
    }

    /**
     * Set or remove (if message is null) a quoted message model.
     */
    public setQuote(receiver: threema.Receiver, message: threema.Message = null): void {
        if (message === null) {
            this.drafts.removeQuote(receiver);
        } else {
            let quoteText;
            switch (message.type) {
                case 'text':
                    quoteText = message.body;
                    break;
                case 'location':
                    quoteText = message.location.poi;
                    break;
                case 'file':
                case 'image':
                    quoteText = message.caption;
                    break;
                default:
                    // Ignore (handled below)
            }

            if (quoteText !== undefined) {
                this.drafts.setQuote(receiver, {
                    identity: message.isOutbox ? this.me.id : message.partnerId,
                    text: quoteText,
                });
            }
        }
    }

    /**
     * Set or remove (if string is null) a draft message
     */
    public setDraft(receiver: threema.Receiver, message: string = null): void {
        if (message === null || message.trim().length === 0) {
            this.drafts.removeText(receiver);
        } else {
            this.drafts.setText(receiver, message.trim());
        }

    }

    /**
     * return draft text
     */
    public getDraft(receiver: threema.Receiver): string {
        return this.drafts.getText(receiver);
    }

    /**
     * Reset data fields.
     */
    private _resetFields(): void {
        // Set initialization count back to 0
        this.initialized = 0;

        // Create container instances
        this.receivers = this.container.createReceivers();
        this.conversations = this.container.createConversations();
        this.messages = this.container.createMessages();
        this.typingInstance = this.container.createTyping();

        // Add converters (pre-processors)
        this.messages.converter = this.container.Converter.unicodeToEmoji;
        this.conversations.setConverter(this.container.Converter.addReceiverToConversation(this.receivers));

        // Add filters
        this.conversations.setFilter(this.container.Filters.hasData(this.receivers));
    }

    private _resetUI(): void {
        this.$log.debug('UI Reset');
        // Only reset if currently in the messenger state
        if (this.$state.includes('messenger')) {
            this.$state.go(this.$state.current, this.$state.params, {reload: true});
        }
    }

    private _requestInitialData(): void {
        // if all conversations are reloaded, clear the message cache
        // to get in sync (we dont know if a message was removed, updated etc..)
        this.messages.clear(this.$rootScope);

        // Request initial data
        this.requestClientInfo();
        this.requestReceivers();
        this.requestConversations();
    }

    private _receiveResponseReceivers(message: threema.WireMessage) {
        this.$log.debug('Received receiver response');

        // Unpack and validate data
        const data = message.data;
        if (data === undefined) {
            this.$log.warn('Invalid receiver response, data missing');
            return;
        }

        // Store receivers
        this.receivers.set(data);
        this.registerInitializationStep('receivers');
    }

    private _receiveResponseContactDetail(message: threema.WireMessage): any {
        this.$log.debug('Received contact detail');

        // Unpack and validate data
        const data = message.data;
        if (data === undefined) {
            this.$log.warn('Invalid contact response, data missing');
            return;
        }

        if (data[WebClientService.ARGUMENT_SUCCESS]) {
            let contactReceiver = this.receivers.contacts
                .get(message.args[WebClientService.ARGUMENT_IDENTITY]) as threema.ContactReceiver;

            // get system contact
            if (data[WebClientService.SUB_TYPE_RECEIVER]) {
                contactReceiver.systemContact =
                    data[WebClientService.SUB_TYPE_RECEIVER][WebClientService.ARGUMENT_SYSTEM_CONTACT];
            }

            return {
                success: true,
                contactReceiver: contactReceiver,
            };
        }

        return data;
    }

    private _receiveAlert(message: threema.WireMessage): any {
        this.$log.debug('Received alert from device');
        this.alerts.push({
            source: message.args.source,
            type: message.data.type,
            message: message.data.message,
        } as threema.Alert);

    }

    private _receiveGroupSync(message: threema.WireMessage): any {
        this.$log.debug('Received group sync');
        // to finish the promise
        return {
            success: true,
            data: null,
        };
    }
    /**
     * handling new or modified contact
     */
    // tslint:disable-next-line: max-line-length
    private _receiveResponseContact(message: threema.WireMessage): threema.PromiseRequestResult<threema.ContactReceiver> {
        this.$log.debug('Received contact response');
        // Unpack and validate data
        const data = message.data;

        if (data === undefined) {
            this.$log.warn('Invalid add contact response, data missing');
            return;
        }

        if (data[WebClientService.ARGUMENT_SUCCESS]
            && data[WebClientService.SUB_TYPE_RECEIVER] !== undefined) {
            let receiver = data[WebClientService.SUB_TYPE_RECEIVER] as threema.ContactReceiver;
            // Add or update a certain receiver
            if (receiver.type === undefined) {
                receiver.type = 'contact';
            }

            this.receivers.extendContact(receiver);

            return {
                success: true,
                data: receiver,
            };
        }

        let msg = null;
        if (data[WebClientService.ARGUMENT_ERROR] !== undefined) {
            msg = data[WebClientService.ARGUMENT_ERROR];
        }

        return {
            success: false,
            message: msg,
        };
    }

    /**
     * handling new or modified group
     */
    private _receiveResponseGroup(message: threema.WireMessage): threema.PromiseRequestResult<threema.GroupReceiver> {
        this.$log.debug('Received group response');
        // Unpack and validate data
        const data = message.data;
        if (data === undefined) {
            this.$log.warn('Invalid create group response, data missing');
            return;
        }

        if (data[WebClientService.ARGUMENT_SUCCESS]
            && data[WebClientService.SUB_TYPE_RECEIVER] !== undefined) {
            let receiver = data[WebClientService.SUB_TYPE_RECEIVER] as threema.GroupReceiver;
            // Add or update a certain receiver
            if (receiver.type === undefined) {
                receiver.type = 'group';
            }

            this.receivers.extendGroup(receiver);

            return {
                success: true,
                data: receiver,
            };
        }

        let msg = null;
        if (data[WebClientService.ARGUMENT_ERROR] !== undefined) {
            msg = data[WebClientService.ARGUMENT_ERROR];
        }

        return {
            success: false,
            message: msg,
        };
    }

    /**
     * Handling new or modified group
     */
    // tslint:disable-next-line: max-line-length
    private _receiveResponseDistributionList(message: threema.WireMessage): threema.PromiseRequestResult<threema.DistributionListReceiver> {
        this.$log.debug('Received distribution list response');
        // Unpack and validate data
        const data = message.data;
        if (data === undefined) {
            this.$log.warn('Invalid distribution list response, data missing');
            return;
        }

        if (data[WebClientService.ARGUMENT_SUCCESS]
            && data[WebClientService.SUB_TYPE_RECEIVER] !== undefined) {
            let receiver = data[WebClientService.SUB_TYPE_RECEIVER] as threema.DistributionListReceiver;
            // Add or update a certain receiver
            if (receiver.type === undefined) {
                receiver.type = 'distributionList';
            }

            this.receivers.extendDistributionList(receiver);

            return {
                success: true,
                data: receiver,
            };
        }

        let msg = null;
        if (data[WebClientService.ARGUMENT_MESSAGE] !== undefined) {
            msg = data[WebClientService.ARGUMENT_MESSAGE];
        }

        return {
            success: false,
            message: msg,
        };
    }

    private _receiveResponseCreateMessage(message: threema.WireMessage):
    threema.PromiseRequestResult<String> {
        this.$log.debug('Received create message response');
        // Unpack data and arguments
        const args = message.args;
        const data = message.data;

        if (args === undefined
            || data === undefined) {
            this.$log.warn('Invalid create received, arguments or data missing');
            return;
        }

        const receiverType = args[WebClientService.ARGUMENT_RECEIVER_TYPE];
        const receiverId = args[WebClientService.ARGUMENT_RECEIVER_ID];
        const temporaryId = args[WebClientService.ARGUMENT_TEMPORARY_ID];

        if (data[WebClientService.ARGUMENT_SUCCESS]) {
            const messageId = data[WebClientService.ARGUMENT_MESSAGE_ID];
            if (receiverType === undefined || receiverId === undefined ||
                temporaryId === undefined || messageId === undefined) {
                this.$log.warn('Invalid create received [type, id or temporaryId arg ' +
                    'or messageId in data missing]');
                return;
            }

            this.messages.bindTemporaryToMessageId({
                type: receiverType,
                id: receiverId,
            } as threema.Receiver, temporaryId, messageId);

            return {
                success: true,
                data: messageId,
            };
        }

        return {
            success: false,
            message: data[WebClientService.ARGUMENT_ERROR],
        };
    }

    private _receiveResponseConversations(message: threema.WireMessage) {
        this.$log.debug('Received conversations response');
        let data = message.data;
        if (data === undefined) {
            this.$log.warn('Invalid conversation response, data missing');
        } else {
            // if a avatar was set on a conversation
            // convert and copy to the receiver
            for (let conversation of data) {
                if (conversation.avatar !== undefined) {
                    let receiver = this.receivers.getData({
                        id: conversation.id,
                        type: conversation.type,
                    } as threema.Receiver);
                    if (receiver.avatar === undefined) {
                        receiver.avatar = {
                            low: this.$filter('bufferToUrl')(conversation.avatar, 'image/png'),
                        };
                    }
                    // reset avatar from object
                    delete conversation.avatar;
                }

                this.conversations.updateOrAdd(conversation);
            }
        }
        this.registerInitializationStep('conversations');
    }

    private _receiveResponseConversation(message: threema.WireMessage) {
        this.$log.debug('Received conversation response');
        let args = message.args;
        let data = message.data;
        if (args === undefined || data === undefined) {
            this.$log.warn('Invalid conversation response, data or arguments missing');
            return;
        }

        // Unpack required argument fields
        let type: string = args[WebClientService.ARGUMENT_MODE];
        switch (type) {
            case WebClientService.ARGUMENT_MODE_NEW:
                this.conversations.add(data);
                break;
            case WebClientService.ARGUMENT_MODE_MODIFIED:
                // A conversation update *can* mean that a new message arrived.
                // To find out, we'll look at the unread count. If it has been
                // incremented, it must be a new message.
                if (data.unreadCount > 0) {

                    // Find the correct conversation in the conversation list
                    for (let conversation of this.conversations.get()) {
                        if (this.receiverService.compare(conversation, data)) {

                            // This is our conversation! If the unreadcount has increased,
                            // we received a new message.
                            if (data.unreadCount > conversation.unreadCount) {
                                this.onNewMessage(data.latestMessage, conversation);

                            // Otherwise, if it has decreased, clear the notification cache.
                            } else if (data.unreadCount < conversation.unreadCount) {
                                this.notificationService.clearCache(data.type + '-' + data.id);
                            }

                            break;
                        }
                    }
                } else {
                    this.notificationService.clearCache(data.type + '-' + data.id);
                }
                // we have to call update or add, we are not sure if this
                // conversation is already fetched
                this.conversations.updateOrAdd(data);
                break;
            case WebClientService.ARGUMENT_MODE_REMOVED:
                this.conversations.remove(data);

                this.receiverListener.forEach((listener: threema.ReceiverListener) => {
                    this.$log.debug('call on removed listener');
                    listener.onRemoved(data);
                });
                break;
            default:
                this.$log.warn('Received conversation without a mode');
                return;
        }

        // Update unread count
        const totalUnreadCount = this.conversations
            .get()
            .reduce((a: number, b: threema.Conversation) => a + b.unreadCount, 0);
        this.titleService.updateUnreadCount(totalUnreadCount);
    }

    private _receiveResponseMessages(message: threema.WireMessage): void {
        this.$log.debug('Received message response');

        // Unpack data and arguments
        const args = message.args;
        const data = message.data as threema.Message[];
        if (args === undefined || data === undefined) {
            this.$log.warn('Invalid message response, data or arguments missing');
            return;
        }

        // Unpack required argument fields
        const type: string = args[WebClientService.ARGUMENT_RECEIVER_TYPE];
        const id: string = args[WebClientService.ARGUMENT_RECEIVER_ID];
        let more: boolean = args[WebClientService.ARGUMENT_HAS_MORE];
        if (type === undefined || id === undefined || more === undefined) {
            this.$log.warn('Invalid message response, argument field missing');
            return;
        }

        // If there's no data returned, override `more` field.
        if (data.length === 0) {
            more = false;
        }

        // Check if the page was requested
        let receiver = {type: type, id: id} as threema.Receiver;

        // Set as loaded
        this.loadingMessages.delete(receiver.type + receiver.id);

        if (this.messages.isRequested(receiver)) {
            // Add messages
            this.messages.addOlder(receiver, data);

            // Clear pending request
            this.messages.clearRequested(receiver);

            // Set "more" flag to indicate that more (older) messages are available.
            this.messages.setMore(receiver, more);

            this.messages.notify(receiver, this.$rootScope);
        } else {
            this.$log.warn("Ignoring message response that hasn't been requested");
            return;
        }
    }

    private _receiveResponseAvatar(message: threema.WireMessage): any {
        this.$log.debug('Received avatar response');

        // Unpack data and arguments
        const args = message.args;
        if (args === undefined) {
            this.$log.warn('Invalid message response: arguments missing');
            return {
                success: false,
                data: 'invalid_response',
            };
        }

        const data = message.data;
        if ( data === undefined) {
            // It's ok, a receiver without a avatar
            return {
                success: true,
                data: null,
            };
        }

        // Unpack required argument fields
        const type = args[WebClientService.ARGUMENT_RECEIVER_TYPE];
        const id = args[WebClientService.ARGUMENT_RECEIVER_ID];
        const highResolution = args[WebClientService.ARGUMENT_AVATAR_HIGH_RESOLUTION];
        if (type === undefined || id === undefined || highResolution === undefined) {
            this.$log.warn('Invalid avatar response, argument field missing');
            return {
                success: false,
                data: 'invalid_response',
            };
        }

        // Set avatar for receiver according to resolution
        let field: string = highResolution ? 'high' : 'low';
        let receiverData = this.receivers.getData(args);
        if (receiverData.avatar === null || receiverData.avatar === undefined) {
            receiverData.avatar = {};
        }

        let avatar = this.$filter('bufferToUrl')(data, 'image/png');
        receiverData.avatar[field] = avatar;

        return {
            success: true,
            data: avatar,
        };
    }

    private _receiveResponseThumbnail(message: threema.WireMessage): any {
        this.$log.debug('Received thumbnail response');

        // Unpack data and arguments
        const args = message.args;
        if (args === undefined) {
            this.$log.warn('Invalid message response: arguments missing');
            return {
                success: false,
                data: 'invalid_response',
            };
        }

        const data = message.data;
        if ( data === undefined) {
            // It's ok, a message without a thumbnail
            return {
                success: true,
                data: null,
            };
        }

        // Unpack required argument fields
        const type = args[WebClientService.ARGUMENT_RECEIVER_TYPE];
        const id = args[WebClientService.ARGUMENT_RECEIVER_ID];
        const messageId = args[WebClientService.ARGUMENT_MESSAGE_ID];

        if (type === undefined || id === undefined || messageId === undefined ) {
            this.$log.warn('Invalid thumbnail response, argument field missing');
            return {
                success: false,
                data: 'invalid_response',
            };
        }

        this.messages.setThumbnail( this.receivers.getData(args), messageId, data);

        return {
            success: true,
            data: data};
    }

    private _receiveResponseBlob(message: threema.WireMessage): threema.PromiseRequestResult<ArrayBuffer> {
        this.$log.debug('Received blob response');

        // Unpack data and arguments
        const args = message.args;
        const data = message.data;
        if (args === undefined || data === undefined) {
            this.$log.warn('Invalid message response, data or arguments missing');
            return {
                success: false,
            };
        }

        // Unpack required argument fields
        const receiverType = args[WebClientService.ARGUMENT_RECEIVER_TYPE];
        const receiverId = args[WebClientService.ARGUMENT_RECEIVER_ID];
        const msgId = args[WebClientService.ARGUMENT_MESSAGE_ID];
        if (receiverType === undefined || receiverId === undefined || msgId === undefined) {
            this.$log.warn('Invalid blob response, argument field missing');
            return {
                success: false,
            };
        }

        // Unpack data
        const buffer: ArrayBuffer = data[WebClientService.DATA_FIELD_BLOB_BLOB];
        if (buffer === undefined) {
            this.$log.warn('Invalid blob response, data field missing');
            return {
                success: false,
            };
        }

        this.blobCache.set(msgId + receiverType, buffer);

        // Download to browser
        return {
            success: true,
            data: buffer,
        };

    }

    private _receiveUpdateMessage(message: threema.WireMessage): void {
        this.$log.debug('Received message update');

        // Unpack data and arguments
        const args = message.args;
        const data: threema.Message = message.data;
        if (args === undefined || data === undefined) {
            this.$log.warn('Invalid message update, data or arguments missing');
            return;
        }

        // Unpack required argument fields
        const type: string = args[WebClientService.ARGUMENT_RECEIVER_TYPE];
        const id: string = args[WebClientService.ARGUMENT_RECEIVER_ID];
        const mode: string = args[WebClientService.ARGUMENT_MODE];
        if (type === undefined || id === undefined || mode === undefined) {
            this.$log.warn('Invalid message update, argument field missing');
            return;
        }
        let receiver = {type: type, id: id} as threema.Receiver;

        // React depending on mode
        switch (mode) {
            case WebClientService.ARGUMENT_MODE_NEW:
                this.$log.debug('New message', data.id);

                // It's possible that this message already exists (placeholder message on send).
                // Try to update it first. If not, add it as a new msg.
                if (!this.messages.update(receiver, data)) {
                    this.messages.addNewer(receiver, [data]);
                }
                break;
            case WebClientService.ARGUMENT_MODE_MODIFIED:
                this.$log.debug('Modified message', data.id);
                this.messages.update(receiver, data);
                break;
            case WebClientService.ARGUMENT_MODE_REMOVED:
                this.messages.remove(receiver, data.id);
                break;
            default:
                this.$log.warn('Invalid message response, unknown mode:', mode);
        }
    }

    private _receiveUpdateReceiver(message: threema.WireMessage): void {
        this.$log.debug('Received receiver update');

        // Unpack data and arguments
        const args = message.args;
        const data = message.data;
        if (args === undefined || data === undefined) {
            this.$log.warn('Invalid receiver update, data or arguments missing');
            return;
        }

        // Unpack required argument fields
        const type = args[WebClientService.ARGUMENT_RECEIVER_TYPE] as threema.ReceiverType;
        const id = args[WebClientService.ARGUMENT_RECEIVER_ID];
        const mode = args[WebClientService.ARGUMENT_MODE];
        if (type === undefined || mode === undefined ||
                (mode !== WebClientService.ARGUMENT_MODE_REFRESH && id === undefined)) {
            this.$log.warn('Invalid receiver update, argument field missing');
            return;
        }

        // React depending on mode
        switch (mode) {
            case WebClientService.ARGUMENT_MODE_NEW:
            case WebClientService.ARGUMENT_MODE_MODIFIED:
                // Add or update a certain receiver
                let updatedReceiver = this.receivers.extend(type, data);

                // remove all cached messages if the receiver was moved to "locked" state
                if (updatedReceiver !== undefined && updatedReceiver.locked) {
                    this.messages.clearReceiverMessages(updatedReceiver);
                }
                break;
            case WebClientService.ARGUMENT_MODE_REMOVED:
                // Remove a certain receiver
                (this.receivers.get(type) as Map<string, threema.Receiver>).delete(id);
                break;
            case WebClientService.ARGUMENT_MODE_REFRESH:
                // Refresh lists of receivers
                if (type === 'me') {
                    this.receivers.setMe(data);
                } else if (type === 'contact') {
                    this.receivers.setContacts(data);
                } else if (type === 'group') {
                    this.receivers.setGroups(data);
                } else if (type === 'distributionList') {
                    this.receivers.setDistributionLists(data);
                } else {
                    this.$log.warn('Unknown receiver type:', type);
                }
                break;
            default:
                this.$log.warn('Invalid receiver response, unknown mode:', mode);
        }
    }

    private _receiveUpdateTyping(message: threema.WireMessage): void {
        this.$log.debug('Received typing update');

        // Unpack data and arguments
        const args = message.args;
        const data = message.data;
        if (args === undefined || data === undefined) {
            this.$log.warn('Invalid typing update, data or arguments missing');
            return;
        }

        // Unpack required argument fields
        const id: string = args[WebClientService.ARGUMENT_RECEIVER_ID];
        const isTyping: boolean = args[WebClientService.ARGUMENT_CONTACT_IS_TYPING];
        if (id === undefined || isTyping === undefined) {
            this.$log.warn('Invalid typing update, argument field missing');
            return;
        }

        // Store or remove typing notification.
        // Note that we know that the receiver must be a contact, because
        // groups and distribution lists can't type.
        const receiver = {id: id, type: 'contact'}  as threema.ContactReceiver;
        if (isTyping === true) {
            this.typing.setTyping(receiver);
        } else {
            this.typing.unsetTyping(receiver);
        }
    }

    /**
     * The peer sends the device information string. This can be used to
     * identify the active session.
     */
    private _receiveResponseClientInfo(message: threema.WireMessage): void {
        this.$log.debug('Received client info');
        const args = message.args;
        if (args === undefined) {
            this.$log.warn('Invalid client info, argument field missing');
            return;
        }
        this.deviceInfo = args.device;
        this.$log.debug('Client device:', this.deviceInfo);

        // Store push token
        if (args.myPushToken) {
            this.pushToken = args.myPushToken;
            this.pushService.init(args.myPushToken);
        }

        // Set own identity
        let myAccount = args.myAccount;

        this.myIdentity = {
            identity: myAccount.identity,
            publicKey: myAccount.publicKey,
            publicNickname: myAccount.publicNickname,
            fingerprint: this.fingerPrintService.generate(myAccount.publicKey),
        };

        this.registerInitializationStep('client info');
    }

    public setPassword(password: string) {
        // If a password has been set, store trusted key and push token
        if (this._maybeTrustKeys(password)) {
            // Saved trusted key, send information to client
            this.sendKeyPersisted();
        }
    }

    /**
     * Reset all Fields and clear the blob cache
     */
    public clearCache(): void {
        this._resetFields();
        this.blobCache.clear();
    }

    /**
     * Called when a new message arrives.
     */
    private onNewMessage(message: threema.Message, conversation: threema.Conversation): void {
        // ignore message from active receivers (and if the browser tab is visible
        if (this.browserService.isVisible()
            && this.receiverService.compare(conversation, this.receiverService.getActive())) {
            this.$log.debug('do not show a notification of a active chat');
            return;
        }
        const sender: threema.Receiver = conversation.receiver;

        if (sender === undefined  || sender.locked) {
            // do not show any notifications on private chats
            return;
        }
        // Determine sender and partner name (used for notification)
        let senderName = sender.id;
        if (sender.displayName) {
            senderName = sender.displayName;
        } else if (sender.type === 'contact') {
            senderName = '~' + (sender as threema.ContactReceiver).publicNickname;
        }
        const partner = this.receivers.getData({
            id: message.partnerId,
            type: 'contact',
        } as threema.Receiver) as threema.ContactReceiver;
        let partnerName = partner.displayName || ('~' + partner.publicNickname);

        // Show notification
        this.$translate('messenger.MESSAGE_NOTIFICATION_SUBJECT', {messageCount: 1 + conversation.unreadCount})
            .then((titlePrefix) =>  {
                const title = `${titlePrefix} ${senderName}`;
                let body = '';
                switch (message.type) {
                    case 'text':
                        body = message.body;
                        break;
                    default:
                        body = `[${message.type}]`;
                }
                if (conversation.type === 'group') {
                    body = partnerName + ': ' + body;
                }
                const tag = conversation.type + '-' + conversation.id;
                const avatar = (sender.avatar && sender.avatar.low) ? sender.avatar.low : null;
                this.notificationService.showNotification(tag, title, body, avatar, () => {
                    this.$state.go('messenger.home.conversation', conversation);
                });
            });
    }

    /**
     * If a password has been set, store own private permanent key and public
     * key of the peer in the trusted key store.
     */
    private _maybeTrustKeys(password: string): boolean {
        if (password !== undefined && password !== null && password.length > 0) {
            this.trustedKeyStore.storeTrustedKey(
                this.salty.keyStore.publicKeyBytes,
                this.salty.keyStore.secretKeyBytes,
                this.salty.peerPermanentKeyBytes,
                this.pushToken,
                password,
            );
            this.$log.info('Stored trusted key');
            return true;
        }
        return false;
    }

    private _sendRequest(type, args = null): void {
        let message: threema.WireMessage = {
            type: WebClientService.TYPE_REQUEST,
            subType: type,
        };
        if (args) {
            message.args = args;
        }

        this.send(message);
    }

    private _sendPromiseMessage(message: threema.WireMessage, timeout: number = null): Promise<any> {
        // create arguments on wired message
        if (message.args === undefined) {
            message.args = {};
        }
        let promiseId = message.args[WebClientService.ARGUMENT_TEMPORARY_ID];
        if (promiseId === undefined) {
            // create a random id to identity the promise
            promiseId = 'p' + Math.random().toString(36).substring(7);
            message.args[WebClientService.ARGUMENT_TEMPORARY_ID] = promiseId;
        }

        return new Promise(
            (resolve, reject) => {
                let p = {
                    resolve: resolve,
                    reject: reject,
                } as threema.PromiseCallbacks;
                this.requestPromises.set(promiseId, p);

                if (timeout !== null && timeout > 0) {
                    this.$timeout(() => {
                        p.reject('timeout');
                        this.requestPromises.delete(promiseId);
                    }, timeout);
                }

                this.send(message);
            },
        );
    }

    private _sendRequestPromise(type, args = null, timeout: number = null): Promise<any> {
        let message: threema.WireMessage = {
            type: WebClientService.TYPE_REQUEST,
            subType: type,
            args: args,
        };

        return this._sendPromiseMessage(message, timeout);
    }

    private _sendCreatePromise(type, args = null, data: any = null, timeout: number = null): Promise<any> {
        let message: threema.WireMessage = {
            type: WebClientService.TYPE_CREATE,
            subType: type,
            args: args,
            data: data,
        };
        return this._sendPromiseMessage(message, timeout);
    }

    private _sendUpdatePromise(type, args = null, data: any = null, timeout: number = null): Promise<any> {
        let message: threema.WireMessage = {
            type: WebClientService.TYPE_UPDATE,
            subType: type,
            data: data,
            args: args,
        };

        return this._sendPromiseMessage(message, timeout);
    }

    private _sendCreate(type, data, args = null): void {
        let message: threema.WireMessage = {
            type: WebClientService.TYPE_CREATE,
            subType: type,
            data: data,
        };
        if (args) {
            message.args = args;
        }
        this.send(message);
    }

    private _sendDelete(type, args, data = null): void {
        let message: threema.WireMessage = {
            type: WebClientService.TYPE_DELETE,
            subType: type,
            data: data,
            args: args,
        };
        this.send(message);
    }

    private _sendDeletePromise(type, args, data: any = null, timeout: number = null): Promise<any> {
        let message: threema.WireMessage = {
            type: WebClientService.TYPE_DELETE,
            subType: type,
            data: data,
            args: args,
        };
        return this._sendPromiseMessage(message, timeout);
    }

    private _receiveRequest(type, message): void {
        this.$log.warn('Ignored request with type:', type);
    }

    private _receivePromise(message: any, receiveResult: any) {
        if (
            message !== undefined
            && message.args !== undefined
            && message.args[WebClientService.ARGUMENT_TEMPORARY_ID] !== undefined) {
            // find pending promise
            let promiseId = message.args[WebClientService.ARGUMENT_TEMPORARY_ID];

            if (this.requestPromises.has(promiseId)) {
                if (receiveResult.success) {
                    this.requestPromises.get(promiseId).resolve(receiveResult.data);
                } else {
                    this.requestPromises.get(promiseId).reject(receiveResult.message);
                }
                // remove from map
                this.requestPromises.delete(promiseId);
            }
        }
    }

    private _receiveResponse(type, message): void {
        // Dispatch response
        let receiveResult;
        switch (type) {
            case WebClientService.SUB_TYPE_RECEIVER:
                this._receiveResponseReceivers(message);
                break;
            case WebClientService.SUB_TYPE_CONVERSATIONS:
                this._receiveResponseConversations(message);
                break;
            case WebClientService.SUB_TYPE_CONVERSATION:
                this._receiveResponseConversation(message);
                break;
            case WebClientService.SUB_TYPE_MESSAGE:
                this._receiveResponseMessages(message);
                break;
            case WebClientService.SUB_TYPE_AVATAR:
                receiveResult = this._receiveResponseAvatar(message);
                break;
            case WebClientService.SUB_TYPE_THUMBNAIL:
                receiveResult = this._receiveResponseThumbnail(message);
                break;
            case WebClientService.SUB_TYPE_BLOB:
                receiveResult = this._receiveResponseBlob(message);
                break;
            case WebClientService.SUB_TYPE_CLIENT_INFO:
                this._receiveResponseClientInfo(message);
                break;
            case WebClientService.SUB_TYPE_CONTACT_DETAIL:
                receiveResult = this._receiveResponseContactDetail(message);
                break;
            case WebClientService.SUB_TYPE_ALERT:
                receiveResult = this._receiveAlert(message);
                break;
            case WebClientService.SUB_TYPE_GROUP_SYNC:
                receiveResult = this._receiveGroupSync(message);
                break;
            default:
                this.$log.warn('Ignored response with type:', type);
                return;
        }
        this._receivePromise(message, receiveResult);

    }

    private _receiveUpdate(type, message): void {
        // Dispatch update
        let receiveResult;
        switch (type) {
            case WebClientService.SUB_TYPE_RECEIVER:
                this._receiveUpdateReceiver(message);
                break;
            case WebClientService.SUB_TYPE_MESSAGE:
                this._receiveUpdateMessage(message);
                break;
            case WebClientService.SUB_TYPE_TYPING:
                this._receiveUpdateTyping(message);
                break;
            case WebClientService.SUB_TYPE_CONTACT:
                receiveResult = this._receiveResponseContact(message);
                break;
            case WebClientService.SUB_TYPE_GROUP:
                receiveResult = this._receiveResponseGroup(message);
                break;
            case WebClientService.SUB_TYPE_DISTRIBUTION_LIST:
                receiveResult = this._receiveResponseDistributionList(message);
                break;
            default:
                this.$log.warn('Ignored update with type:', type);
                return;
        }

        this._receivePromise(message, receiveResult);

    }

    private _receiveCreate(type, message): void {
        // Dispatch response
        let receiveResult: threema.PromiseRequestResult<any>;
        switch (type) {
            case WebClientService.SUB_TYPE_CONTACT:
                receiveResult = this._receiveResponseContact(message);
                break;
            case WebClientService.SUB_TYPE_GROUP:
                receiveResult = this._receiveResponseGroup(message);
                break;
            case WebClientService.SUB_TYPE_DISTRIBUTION_LIST:
                receiveResult = this._receiveResponseDistributionList(message);
                break;
            case WebClientService.SUB_TYPE_TEXT_MESSAGE:
            case WebClientService.SUB_TYPE_FILE_MESSAGE:
                receiveResult = this._receiveResponseCreateMessage(message);
                break;
            default:
                this.$log.warn('Ignored response with type:', type);
                return;
        }

        this._receivePromise(message, receiveResult);
    }

    private _receiveDelete(type, message): void {
        // Dispatch update
        let receiveResult;
        switch (type) {
            case WebClientService.SUB_TYPE_CONTACT_DETAIL:
                receiveResult = this._receiveUpdateReceiver(message);
                break;
            default:
                this.$log.warn('Ignored delete with type:', type);
                return;
        }

        this._receivePromise(message, receiveResult);

    }

    /**
     * Encode an object using the msgpack format.
     */
    private msgpackEncode(data: any): Uint8Array {
        return msgpack.encode(data, this.msgpackOptions);
    }

    /**
     * Decode an object using the msgpack format.
     */
    private msgpackDecode(bytes: Uint8Array): any {
        return msgpack.decode(bytes, this.msgpackOptions);
    }

    /**
     * Send a message through the secure data channel.
     */
    private send(message: threema.WireMessage): void {
        this.$log.debug('Sending', message.type + '/' + message.subType, 'message');
        const bytes: Uint8Array = this.msgpackEncode(message);
        this.secureDataChannel.send(bytes);
    }

    /**
     * Receive a new incoming decrypted message.
     */
    private receive(message: threema.WireMessage): void {
        // Dispatch message
        switch (message.type) {
            case WebClientService.TYPE_REQUEST:
                this._receiveRequest(message.subType, message);
                break;
            case WebClientService.TYPE_RESPONSE:
                this._receiveResponse(message.subType, message);
                break;
            case WebClientService.TYPE_CREATE:
                this._receiveCreate(message.subType, message);
                break;
            case WebClientService.TYPE_UPDATE:
                this._receiveUpdate(message.subType, message);
                break;
            case WebClientService.TYPE_DELETE:
                this._receiveDelete(message.subType, message);
                break;
            default:
                this.$log.warn('Ignored message with type:', message.type);
        }
    }

    private currentController: string;
    public setControllerName(name: string): void {
        this.currentController = name;
    }

    public getControllerName(): string {
        return this.currentController;
    }
}
