// SPDX-FileCopyrightText: 2025 The BAR Lobby Authors
//
// SPDX-License-Identifier: MIT

import { reactive } from "vue";
import {
    MatchmakingCancelledEventData,
    MatchmakingFoundEventData,
    MatchmakingFoundUpdateEventData,
    MatchmakingListOkResponseData,
    MatchmakingQueuesJoinedEventData,
    MatchmakingQueueUpdateEventData,
    UserSelfEventData,
    PrivateBattle,
} from "tachyon-protocol/types";
import { tachyonStore } from "@renderer/store/tachyon.store";
import { db } from "@renderer/store/db";
import { notificationsApi } from "@renderer/api/notifications";
import { gameStore } from "@renderer/store/game.store";
import { enginesStore } from "@renderer/store/engine.store";
import { downloadMap } from "@renderer/store/maps.store";
import { downloadEngine } from "@renderer/store/engine.store";
import { downloadGame } from "@renderer/store/game.store";
import { DownloadInfo } from "@main/content/downloads";

// DEV/TEST FLAG: Set to true to simulate asset downloads instead of real downloads
const testAssetDownload = true;

export enum MatchmakingStatus {
    Idle = "Idle",
    JoinRequested = "JoinRequested",
    Searching = "Searching",
    MatchFound = "MatchFound",
    MatchAccepted = "MatchAccepted",
}

export const matchmakingStore: {
    isInitialized: boolean;
    isDrawerOpen: boolean;
    status: MatchmakingStatus;
    errorMessage: string | null;
    selectedQueue: string;
    playlists: MatchmakingListOkResponseData["playlists"];
    isLoadingQueues: boolean;
    queueError?: string;
    playersReady?: number;
    playersQueued?: number;
    // Each playlist will have it's own boolean, as the 'needed' property of an object keyed to the playlist's names
    downloadsRequired: {
        [k: string]: {
            mapsNeeded: boolean;
            engineNeeded: boolean;
            gameNeeded: boolean;
            engineVersion: string;
            gameVersion: string;
        };
    };
    // Battle download state
    currentBattle?: PrivateBattle;
    isDownloadingContent: boolean;
    downloadProgress: {
        map: number;
        engine: number;
        game: number;
    };
} = reactive({
    isInitialized: false,
    isDrawerOpen: false,
    status: MatchmakingStatus.Idle,
    errorMessage: null,
    selectedQueue: "1v1",
    playlists: [],
    isLoadingQueues: false,
    queueError: undefined,
    playersReady: 0,
    playersQueued: 0,
    downloadsRequired: {},
    currentBattle: undefined,
    isDownloadingContent: false,
    downloadProgress: {
        map: 0,
        engine: 0,
        game: 0,
    },
});

function onQueueUpdateEvent(data: MatchmakingQueueUpdateEventData) {
    console.log("Tachyon event: matchmaking/queueUpdate:", data);
    matchmakingStore.playersQueued = data.playersQueued;
}

function onLostEvent() {
    console.log("Tachyon event: matchmaking/lost: no data");
    matchmakingStore.status = MatchmakingStatus.Searching;
}

function onFoundUpdateEvent(data: MatchmakingFoundUpdateEventData) {
    console.log("Tachyon event: matchmaking/foundUpdate", data);
    matchmakingStore.playersReady = data.readyCount;
}

function onCancelledEvent(data: MatchmakingCancelledEventData) {
    console.log("Tachyon event: matchmaking/cancelled:", data);
    matchmakingStore.status = MatchmakingStatus.Idle;
}

function onFoundEvent(data: MatchmakingFoundEventData) {
    console.log("Tachyon event: matchmaking/found:", data);
    matchmakingStore.status = MatchmakingStatus.MatchFound;
    // Per spec, we have 10 seconds to send the ``matchmaking/ready`` request or we get cancelled from queue.
    // Probably better to track this timer on the UI side because the user will either need to 'ready' or 'cancel'
    // and they need to know this. Plus the UI has to "pop up" because they need to respond to it.
    // But we don't want to be "triggering" the UI from the store. Instead, we should add a watcher,
    // and when this value updates to MatchFound we can start our timer. Probably want a progress bar "counting down" too.
}

function onQueuesJoinedEvent(data: MatchmakingQueuesJoinedEventData) {
    console.log("Tachyon event: matchmaking/queuesJoined:", data);
    matchmakingStore.status = MatchmakingStatus.Searching;
}

function onUserSelfEvent(data: UserSelfEventData) {
    console.log("Tachyon event: user/self:", data);

    // Check if we just got assigned to a battle after accepting match
    if (data.user.currentBattle && matchmakingStore.status === MatchmakingStatus.MatchAccepted) {
        const battle = data.user.currentBattle;
        console.log("Battle assigned! Downloading content:", battle.map.springName, battle.game.springName, battle.engine.version);

        // Start downloading battle content
        downloadBattleContent(battle);
    }
}

async function downloadBattleContent(battle: PrivateBattle): Promise<void> {
    matchmakingStore.currentBattle = battle;
    matchmakingStore.isDownloadingContent = true;
    matchmakingStore.downloadProgress = { map: 0, engine: 0, game: 0 };

    // Check if we should use simulated downloads for testing
    if (testAssetDownload) {
        console.log("Using SIMULATED downloads for battle content:", {
            map: battle.map.springName,
            engine: battle.engine.version,
            game: battle.game.springName,
        });

        // Simulate progressive downloads with different speeds for each content type
        const simulateProgress = () => {
            return new Promise<void>((resolve) => {
                let mapProgress = 0;
                let engineProgress = 0;
                let gameProgress = 0;

                const interval = setInterval(() => {
                    // Different download speeds for realism
                    mapProgress = Math.min(mapProgress + 0.08, 1);
                    engineProgress = Math.min(engineProgress + 0.12, 1);
                    gameProgress = Math.min(gameProgress + 0.06, 1);

                    matchmakingStore.downloadProgress = {
                        map: mapProgress,
                        engine: engineProgress,
                        game: gameProgress,
                    };

                    // All downloads complete
                    if (mapProgress === 1 && engineProgress === 1 && gameProgress === 1) {
                        clearInterval(interval);
                        resolve();
                    }
                }, 200);
            });
        };

        try {
            await simulateProgress();
            console.log("All battle content downloaded successfully (simulated)");
            notificationsApi.alert({ text: "Battle content downloaded. Ready to launch!", severity: "info" });
        } catch (error) {
            console.error("Failed to download battle content:", error);
            notificationsApi.alert({ text: "Failed to download required content for battle", severity: "error" });
        } finally {
            matchmakingStore.isDownloadingContent = false;
        }
        return;
    }

    // Real download logic below
    // Set up event listeners for progress updates
    const cleanupEventListeners: (() => void)[] = [];

    // Helper to create progress event listener
    const createProgressListener = (type: "map" | "engine" | "game") => {
        return (downloadInfo: DownloadInfo) => {
            if (downloadInfo.name === (type === "map" ? battle.map.springName : type === "engine" ? battle.engine.version : battle.game.springName)) {
                matchmakingStore.downloadProgress[type] = downloadInfo.progress;
            }
        };
    };

    // Set up progress listeners
    const mapProgressListener = createProgressListener("map");
    const engineProgressListener = createProgressListener("engine");
    const gameProgressListener = createProgressListener("game");

    window.downloads.onDownloadMapProgress(mapProgressListener);
    window.downloads.onDownloadEngineProgress(engineProgressListener);
    window.downloads.onDownloadGameProgress(gameProgressListener);

    cleanupEventListeners.push(
        () => window.downloads.onDownloadMapProgress(() => {}),
        () => window.downloads.onDownloadEngineProgress(() => {}),
        () => window.downloads.onDownloadGameProgress(() => {})
    );

    try {
        // Start downloads (no callback parameters - they use events)
        await downloadMap(battle.map.springName);
        matchmakingStore.downloadProgress.map = 1;

        await downloadEngine(battle.engine.version);
        matchmakingStore.downloadProgress.engine = 1;

        await downloadGame(battle.game.springName);
        matchmakingStore.downloadProgress.game = 1;

        console.log("All battle content downloaded successfully");
        notificationsApi.alert({ text: "Battle content downloaded. Ready to launch!", severity: "info" });
    } catch (error) {
        console.error("Failed to download battle content:", error);
        notificationsApi.alert({ text: "Failed to download required content for battle", severity: "error" });
    } finally {
        // Clean up event listeners
        cleanupEventListeners.forEach((cleanup) => cleanup());
        matchmakingStore.isDownloadingContent = false;
    }
}

async function sendListRequest() {
    matchmakingStore.isLoadingQueues = true;
    matchmakingStore.queueError = undefined;
    try {
        const response = await window.tachyon.request("matchmaking/list");
        console.log("Tachyon: matchmaking/list:", response.data);
        matchmakingStore.playlists = response.data.playlists;
        // Set default selected queue if current selection is not available
        const hasSelectedQueue = matchmakingStore.playlists.some((playlist) => playlist.id === matchmakingStore.selectedQueue);
        if (matchmakingStore.playlists.length > 0 && !hasSelectedQueue) {
            matchmakingStore.selectedQueue = matchmakingStore.playlists[0].id;
        }
        // Clear the "downloadsRequired" list because we have all-new playlist response
        matchmakingStore.downloadsRequired = {};
        await Promise.all(
            matchmakingStore.playlists.map(async (queue) => {
                const mapsNeeded = await checkIfAnyMapsAreNeeded(queue.maps);
                const engineNeeded = await checkIfEngineIsNeeded(queue.engines);
                const gameNeeded = await checkIfGameIsNeeded(queue.games);
                console.log(`Matchmaking queue ${queue.id} needs downloads - maps: ${mapsNeeded}, engine: ${engineNeeded}, game: ${gameNeeded}`);
                matchmakingStore.downloadsRequired[queue.id] = {
                    mapsNeeded: mapsNeeded,
                    engineNeeded,
                    gameNeeded,
                    engineVersion: queue.engines?.[0]?.version ?? "",
                    gameVersion: queue.games?.[0]?.springName ?? "",
                };
            })
        );
        //log.info(`Matchmaking downloads required:`, matchmakingStore.downloadsRequired);
    } catch (error) {
        console.error("Tachyon error: matchmaking/list:", error);
        notificationsApi.alert({ text: "Tachyon error: matchmaking/list", severity: "error" });
        matchmakingStore.queueError = "Failed to retrieve available queues";
    } finally {
        matchmakingStore.isLoadingQueues = false;
    }
}

async function checkIfAnyMapsAreNeeded(maps: { mapName: string }[]): Promise<boolean> {
    if (!maps || maps.length === 0) return false;
    console.log("Checking maps needed for:", maps);
    const queueMaps = maps.map((m) => m.mapName);
    const dbMaps = await db.maps.bulkGet(queueMaps);
    for (const map of dbMaps) {
        if (map == undefined || !map.isInstalled) return true;
    }
    return false;
}

async function checkIfEngineIsNeeded(engines: { version: string }[]): Promise<boolean> {
    if (!engines || engines.length === 0) return false;
    const requiredVersions = engines.map((e) => e.version);
    const installedVersions = enginesStore.availableEngineVersions.map((v) => v.id);
    return !requiredVersions.some((required) => installedVersions.includes(required));
}

async function checkIfGameIsNeeded(games: { springName: string }[]): Promise<boolean> {
    if (!games || games.length === 0) return false;
    const requiredGames = games.map((g) => g.springName);
    return !requiredGames.some((required) => gameStore.availableGameVersions.has(required));
}

export function getPlaylistName(id: string): string {
    const playlist = matchmakingStore.playlists.find((playlist) => playlist.id === id);
    return playlist?.name || id;
}

async function sendQueueRequest() {
    if (matchmakingStore.downloadsRequired[matchmakingStore.selectedQueue] == undefined) {
        notificationsApi.alert({ text: "Bad queue data; refreshing list.", severity: "error" });
        await sendListRequest();
        return;
    }
    // testing download of battle content before actually joining queue
    downloadBattleContent({
        username: "string",
        password: "string",
        ip: "string",
        port: 0,
        engine: {
            version: "",
        },
        game: {
            springName: "",
        },
        map: {
            springName: "",
        },
    } as PrivateBattle);
    matchmakingStore.status = MatchmakingStatus.JoinRequested; // Initial state, likely short-lived.
    try {
        matchmakingStore.errorMessage = null;
        const response = await window.tachyon.request("matchmaking/queue", { queues: [matchmakingStore.selectedQueue] });
        console.log("Tachyon: matchmaking/queue:", response.status);
        matchmakingStore.status = MatchmakingStatus.Searching;
    } catch (error) {
        console.error("Tachyon error: matchmaking/queue:", error);
        notificationsApi.alert({ text: "Tachyon error: matchmaking/queue", severity: "error" });
        matchmakingStore.errorMessage = "Error with matchmaking/queue";
        matchmakingStore.status = MatchmakingStatus.Idle;
    }
}

async function sendCancelRequest() {
    matchmakingStore.status = MatchmakingStatus.Idle;
    try {
        const response = await window.tachyon.request("matchmaking/cancel");
        console.log("Tachyon: matchmaking/cancel:", response.status);
    } catch (error) {
        console.error("Tachyon: matchmaking/cancel:", error);
        notificationsApi.alert({ text: "Tachyon error: matchmaking/cancel", severity: "error" });
        matchmakingStore.errorMessage = "Error with matchmaking/cancel";
    }
}

async function sendReadyRequest() {
    matchmakingStore.status = MatchmakingStatus.MatchAccepted;
    try {
        const response = await window.tachyon.request("matchmaking/ready");
        console.log("Tachyon: matchmaking/ready:", response.status);
    } catch (error) {
        matchmakingStore.status = MatchmakingStatus.Idle;
        console.error("Tachyon error: matchmaking/ready:", error);
        notificationsApi.alert({ text: "Tachyon error: matchmaking/ready", severity: "error" });
        matchmakingStore.errorMessage = "Error with matchmaking/ready";
    }
}

export async function initializeMatchmakingStore() {
    if (matchmakingStore.isInitialized) return;

    window.tachyon.onEvent("matchmaking/queueUpdate", onQueueUpdateEvent);

    window.tachyon.onEvent("matchmaking/lost", onLostEvent);

    window.tachyon.onEvent("matchmaking/foundUpdate", onFoundUpdateEvent);

    window.tachyon.onEvent("matchmaking/cancelled", onCancelledEvent);

    window.tachyon.onEvent("matchmaking/found", onFoundEvent);

    window.tachyon.onEvent("matchmaking/queuesJoined", onQueuesJoinedEvent);

    window.tachyon.onEvent("user/self", onUserSelfEvent);

    if (tachyonStore.isConnected) {
        await sendListRequest();
    }

    matchmakingStore.isInitialized = true;
}

export const matchmaking = {
    sendCancelRequest,
    sendQueueRequest,
    sendReadyRequest,
    sendListRequest,
};
