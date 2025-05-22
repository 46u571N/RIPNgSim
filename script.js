// --- Global Configuration & State ---
let routers = [];
let globalSettings = {
    updateTimer: 30,
    invalidTimer: 180,
    flushTimer: 120, // Time after invalid
    splitHorizon: true,
    poisonReverse: false,
    triggeredUpdates: true,
};
let simulationTime = 0;
let simulationIntervalId = null;
let eventLog = [];
const MAX_METRIC = 16;

// --- DOM Elements ---
const el = {
    updateTimer: document.getElementById('updateTimer'),
    invalidTimer: document.getElementById('invalidTimer'),
    flushTimer: document.getElementById('flushTimer'),
    splitHorizon: document.getElementById('splitHorizon'),
    poisonReverse: document.getElementById('poisonReverse'),
    triggeredUpdates: document.getElementById('triggeredUpdates'),
    startButton: document.getElementById('startButton'),
    pauseButton: document.getElementById('pauseButton'),
    stepButton: document.getElementById('stepButton'),
    resetButton: document.getElementById('resetButton'),
    simulationTimeDisplay: document.getElementById('simulationTimeDisplay'),
    eventLog: document.getElementById('eventLog'),
    routerTables: {
        R1: document.getElementById('R1-table').getElementsByTagName('tbody')[0],
        R2: document.getElementById('R2-table').getElementsByTagName('tbody')[0],
        R3: document.getElementById('R3-table').getElementsByTagName('tbody')[0],
        R4: document.getElementById('R4-table').getElementsByTagName('tbody')[0],
    }
};

// --- Classes ---
class RouteEntry {
    constructor(prefix, nextHop, metric, interfaceName, isDirectlyConnected = false, sourceRouterId = null) {
        this.prefix = prefix;
        this.nextHop = nextHop; // LLA of the advertising router
        this.metric = metric;
        this.interfaceName = interfaceName; // Interface on THIS router
        this.isDirectlyConnected = isDirectlyConnected;
        this.sourceRouterId = sourceRouterId; // ID of the router that advertised this route

        this.invalidTimerCountdown = globalSettings.invalidTimer;
        this.flushTimerCountdown = globalSettings.flushTimer;
        this.markedForDeletion = false; // True when metric becomes 16

        if (isDirectlyConnected) {
            this.invalidTimerCountdown = Infinity; // Direct routes don't time out this way
            this.flushTimerCountdown = Infinity;
        }
    }

    resetTimers(newMetric) {
        if (this.isDirectlyConnected) return;
        this.metric = newMetric;
        this.invalidTimerCountdown = globalSettings.invalidTimer;
        this.markedForDeletion = false;
        // When a route is updated (not from poison), its flush timer should also be reset/stopped
        this.flushTimerCountdown = globalSettings.flushTimer; 
    }

    tickSecond(routerId) {
        if (this.isDirectlyConnected) return null;

        if (!this.markedForDeletion) {
            this.invalidTimerCountdown--;
            if (this.invalidTimerCountdown <= 0) {
                this.metric = MAX_METRIC;
                this.markedForDeletion = true;
                this.invalidTimerCountdown = 0; // Stop it
                this.flushTimerCountdown = globalSettings.flushTimer;
                logEvent(`${routerId}: Ruta ${this.prefix} vía ${this.nextHop} marcada inválida (timeout), métrica ${MAX_METRIC}.`);
                return { type: 'route_invalidated', routerId, prefix: this.prefix };
            }
        } else {
            this.flushTimerCountdown--;
            if (this.flushTimerCountdown <= 0) {
                logEvent(`${routerId}: Ruta ${this.prefix} vía ${this.nextHop} eliminada (flush timeout).`);
                return { type: 'route_flushed', routerId, prefix: this.prefix };
            }
        }
        return null;
    }
}

class Router {
    constructor(id, name, interfacesConfig) {
        this.id = id;
        this.name = name;
        // interfacesConfig = [{ name: "eth0", ip: "2000:1::1/64", networkPrefix: "2000:1::/64", connectedToRouterId: "R2", connectedToInterfaceName: "eth1", status: "up"}]
        this.interfaces = interfacesConfig.map(iface => ({
            ...iface,
            linkLocalAddress: `fe80::${this.id}:${iface.name}`, // Simplified LLA
            ripEnabled: true, // Assuming all interfaces participate in RIP initially
        }));
        this.routingTable = []; // Array of RouteEntry
        this.updateTimerCountdown = Math.floor(Math.random() * globalSettings.updateTimer) + 1; // Random initial offset
        this.pendingTriggeredUpdate = false;
    }

    getInterfaceByName(name) {
        return this.interfaces.find(iface => iface.name === name);
    }
    
    getInterfaceByNetwork(networkPrefix) {
        return this.interfaces.find(iface => iface.networkPrefix === networkPrefix);
    }

    initializeDirectlyConnectedRoutes() {
        this.routingTable = [];
        this.interfaces.forEach(iface => {
            if (iface.status === "up" && iface.ripEnabled) {
                // Add route to the network segment itself
                const entry = new RouteEntry(iface.networkPrefix, "::", 1, iface.name, true, this.id);
                this.routingTable.push(entry);
            }
        });
    }

    tickSecond() {
        let events = [];
        // Route timers
        for (let i = this.routingTable.length - 1; i >= 0; i--) {
            const route = this.routingTable[i];
            const event = route.tickSecond(this.id);
            if (event) {
                if (event.type === 'route_flushed') {
                    this.routingTable.splice(i, 1);
                    this.pendingTriggeredUpdate = true; // A route was removed
                } else if (event.type === 'route_invalidated') {
                    this.pendingTriggeredUpdate = true; // Metric changed to 16
                }
            }
        }

        // RIPng Update Timer
        this.updateTimerCountdown--;
        if (this.updateTimerCountdown <= 0 || (this.pendingTriggeredUpdate && globalSettings.triggeredUpdates)) {
            this.updateTimerCountdown = globalSettings.updateTimer; // Reset regular timer
            events.push({ type: 'send_update', routerId: this.id, isTriggered: this.pendingTriggeredUpdate });
            this.pendingTriggeredUpdate = false;
        }
        return events;
    }

    prepareUpdatePacketForInterface(sendingInterfaceName) {
        const updatePacket = [];
        const sendingInterface = this.getInterfaceByName(sendingInterfaceName);
        if (!sendingInterface || sendingInterface.status !== "up" || !sendingInterface.ripEnabled) return [];

        this.routingTable.forEach(route => {
            let metricToSend = route.metric;
            // Split Horizon
            if (globalSettings.splitHorizon && route.interfaceName === sendingInterfaceName && !route.isDirectlyConnected) {
                if (globalSettings.poisonReverse) {
                    metricToSend = MAX_METRIC;
                } else {
                    return; // Simple Split Horizon: Don't advertise
                }
            }
            updatePacket.push({ prefix: route.prefix, metric: metricToSend, sourceRouterId: this.id });
        });
        return updatePacket;
    }

    receiveUpdate(packet, fromRouterLLA, onInterfaceName) {
        const receivingInterface = this.getInterfaceByName(onInterfaceName);
        if (!receivingInterface || receivingInterface.status !== "up" || !receivingInterface.ripEnabled) return;

        logEvent(`${this.id}: Recibida actualización de ${fromRouterLLA} en ${onInterfaceName} con ${packet.length} entradas.`);
        let tableChanged = false;

        packet.forEach(receivedRoute => {
            // Do not learn about own interface/network from others on that same segment.
            if (receivedRoute.prefix === receivingInterface.networkPrefix && receivedRoute.metric < MAX_METRIC) {
                 // This can happen if another router advertises the shared link.
                 // Generally, a router knows its directly connected networks best.
                return;
            }

            let newMetric = receivedRoute.metric + 1; // Cost of link to neighbor is 1
            if (newMetric > MAX_METRIC) newMetric = MAX_METRIC;

            let existingRoute = this.routingTable.find(r => r.prefix === receivedRoute.prefix);

            if (existingRoute) {
                if (existingRoute.isDirectlyConnected) return; // Never overwrite directly connected with learned

                // Update from the same source (next-hop)
                if (existingRoute.nextHop === fromRouterLLA) {
                    if (newMetric < existingRoute.metric) { // Better path from same neighbor
                        existingRoute.resetTimers(newMetric);
                        tableChanged = true;
                        logEvent(`${this.id}: Ruta ${receivedRoute.prefix} actualizada vía ${fromRouterLLA}, nueva métrica ${newMetric}.`);
                    } else if (newMetric === MAX_METRIC && existingRoute.metric < MAX_METRIC) { // Route poisoned by neighbor
                        existingRoute.metric = MAX_METRIC;
                        existingRoute.markedForDeletion = true;
                        existingRoute.invalidTimerCountdown = 0; // Trigger invalid state handling
                        existingRoute.flushTimerCountdown = globalSettings.flushTimer;
                        tableChanged = true;
                        logEvent(`${this.id}: Ruta ${receivedRoute.prefix} envenenada por ${fromRouterLLA}.`);
                    } else if (newMetric === existingRoute.metric && newMetric < MAX_METRIC) { // Same route, refresh timer
                        existingRoute.resetTimers(newMetric); // Keep existing metric, just refresh
                    } else if (newMetric > existingRoute.metric && newMetric < MAX_METRIC) {
                        // Worse metric from same neighbor, ignore unless it's a poison.
                    }
                } else { // Update from a different source
                    if (newMetric < existingRoute.metric) {
                        existingRoute.nextHop = fromRouterLLA;
                        existingRoute.metric = newMetric;
                        existingRoute.interfaceName = onInterfaceName;
                        existingRoute.sourceRouterId = receivedRoute.sourceRouterId;
                        existingRoute.resetTimers(newMetric);
                        tableChanged = true;
                        logEvent(`${this.id}: Ruta ${receivedRoute.prefix} cambiada a ${fromRouterLLA} (int ${onInterfaceName}), nueva métrica ${newMetric}.`);
                    }
                }
            } else { // New route
                if (newMetric < MAX_METRIC) {
                    const newEntry = new RouteEntry(receivedRoute.prefix, fromRouterLLA, newMetric, onInterfaceName, false, receivedRoute.sourceRouterId);
                    this.routingTable.push(newEntry);
                    tableChanged = true;
                    logEvent(`${this.id}: Nueva ruta ${receivedRoute.prefix} aprendida de ${fromRouterLLA} (int ${onInterfaceName}), métrica ${newMetric}.`);
                }
            }
        });

        if (tableChanged && globalSettings.triggeredUpdates) {
            this.pendingTriggeredUpdate = true;
        }
    }
}

// --- Simulation Logic ---
function initializeSimulationState() {
    simulationTime = 0;
    eventLog = [];
    routers = [];

    // Define Routers and their interfaces based on the diagram
    // R1 <-> R2 (via S1) on 2000:1::/64
    // R2 <-> R4 (via S2) on 2000:2::/64
    // R3 <-> R4 (via S3) on 2000:3::/64

    const r1 = new Router("R1", "Router 1", [
        { name: "eth0", ip: "2000:1::1/64", networkPrefix: "2000:1::/64", connectedToRouterId: "R2", connectedToInterfaceName: "eth1", status: "up" }
    ]);
    const r2 = new Router("R2", "Router 2", [
        { name: "eth1", ip: "2000:1::2/64", networkPrefix: "2000:1::/64", connectedToRouterId: "R1", connectedToInterfaceName: "eth0", status: "up" },
        { name: "eth0", ip: "2000:2::2/64", networkPrefix: "2000:2::/64", connectedToRouterId: "R4", connectedToInterfaceName: "eth1", status: "up" }
    ]);
    const r3 = new Router("R3", "Router 3", [
        { name: "eth1", ip: "2000:3::1/64", networkPrefix: "2000:3::/64", connectedToRouterId: "R4", connectedToInterfaceName: "eth0", status: "up" }
    ]);
    const r4 = new Router("R4", "Router 4", [
        { name: "eth0", ip: "2000:3::2/64", networkPrefix: "2000:3::/64", connectedToRouterId: "R3", connectedToInterfaceName: "eth1", status: "up" },
        { name: "eth1", ip: "2000:2::1/64", networkPrefix: "2000:2::/64", connectedToRouterId: "R2", connectedToInterfaceName: "eth0", status: "up" }
    ]);

    routers = [r1, r2, r3, r4];
    routers.forEach(r => r.initializeDirectlyConnectedRoutes());

    updateAllDisplays();
    logEvent("Simulación inicializada.");
}

function simulationTick() {
    simulationTime++;
    let scheduledUpdates = [];

    // 1. Process router timers and collect events (like need to send update)
    routers.forEach(router => {
        const events = router.tickSecond();
        events.forEach(event => {
            if (event.type === 'send_update') {
                scheduledUpdates.push({ routerId: router.id, isTriggered: event.isTriggered });
            }
        });
    });

    // 2. Process scheduled updates (send and receive)
    scheduledUpdates.forEach(updateOrder => {
        const sendingRouter = routers.find(r => r.id === updateOrder.routerId);
        if (!sendingRouter) return;

        logEvent(`${sendingRouter.id} enviando ${updateOrder.isTriggered ? 'TRIGGERED' : 'REGULAR'} update. (T=${simulationTime}s)`);

        sendingRouter.interfaces.forEach(sendingInterface => {
            if (sendingInterface.status !== "up" || !sendingInterface.ripEnabled) return;

            const packet = sendingRouter.prepareUpdatePacketForInterface(sendingInterface.name);
            if (packet.length === 0) return;

            // Find neighbor router(s) on this interface's network segment
            // Simplified: direct connection based on config
            const neighborRouterId = sendingInterface.connectedToRouterId;
            const neighborInterfaceName = sendingInterface.connectedToInterfaceName;

            if (neighborRouterId && neighborInterfaceName) {
                const neighborRouter = routers.find(r => r.id === neighborRouterId);
                if (neighborRouter) {
                    const neighborReceivingInterface = neighborRouter.getInterfaceByName(neighborInterfaceName);
                    if (neighborReceivingInterface && neighborReceivingInterface.status === "up" && neighborReceivingInterface.ripEnabled) {
                         // Simulate packet delivery
                        neighborRouter.receiveUpdate(packet, sendingInterface.linkLocalAddress, neighborInterfaceName);
                    }
                }
            }
        });
    });

    updateAllDisplays();
}


// --- UI Update Functions ---
function updateAllDisplays() {
    el.simulationTimeDisplay.textContent = simulationTime;
    routers.forEach(router => updateRoutingTableDisplay(router));
    updateEventLogDisplay(); // Call this last to show latest events
}

function updateRoutingTableDisplay(router) {
    const tableBody = el.routerTables[router.id];
    if (!tableBody) return;
    tableBody.innerHTML = ''; // Clear existing rows

    router.routingTable.sort((a,b) => a.prefix.localeCompare(b.prefix)).forEach(route => {
        const row = tableBody.insertRow();
        row.insertCell().textContent = route.prefix;
        row.insertCell().textContent = route.nextHop;
        row.insertCell().textContent = route.metric;
        row.insertCell().textContent = route.interfaceName;
        let timeoutDisplay = route.isDirectlyConnected ? 'N/A' : 
                             route.markedForDeletion ? `FLUSH ${route.flushTimerCountdown}s` : `${route.invalidTimerCountdown}s`;
        if (route.metric === MAX_METRIC && !route.isDirectlyConnected) timeoutDisplay += ` (INV)`;                         
        row.insertCell().textContent = timeoutDisplay;
    });
}

function logEvent(message) {
    const fullMessage = `[T=${simulationTime}s] ${message}`;
    eventLog.unshift(fullMessage); // Add to beginning for chronological order in display
    if (eventLog.length > 200) eventLog.pop(); // Keep log size manageable
    // Don't update display here directly, updateEventLogDisplay will be called by simulationTick or controls
}

function updateEventLogDisplay() {
    el.eventLog.innerHTML = eventLog.join('\n');
}

function readGlobalSettingsFromUI() {
    globalSettings.updateTimer = parseInt(el.updateTimer.value) || 30;
    globalSettings.invalidTimer = parseInt(el.invalidTimer.value) || 180;
    globalSettings.flushTimer = parseInt(el.flushTimer.value) || 120;
    globalSettings.splitHorizon = el.splitHorizon.checked;
    globalSettings.poisonReverse = el.poisonReverse.checked;
    globalSettings.triggeredUpdates = el.triggeredUpdates.checked;

    // If split horizon is off, poison reverse should also be off (UI logic)
    if (!globalSettings.splitHorizon) {
        el.poisonReverse.checked = false;
        globalSettings.poisonReverse = false;
    }
}

// --- Event Handlers ---
el.startButton.addEventListener('click', () => {
    if (simulationIntervalId) return; // Already running
    readGlobalSettingsFromUI();
    if (simulationTime === 0) { // Fresh start or after reset
        initializeSimulationState(); // Re-initialize if starting from 0 after a reset
    }
    simulationIntervalId = setInterval(simulationTick, 1000); // Run tick every 1 real second
    el.startButton.disabled = true;
    el.pauseButton.disabled = false;
    el.stepButton.disabled = true;
    logEvent("Simulación iniciada.");
});

el.pauseButton.addEventListener('click', () => {
    clearInterval(simulationIntervalId);
    simulationIntervalId = null;
    el.startButton.disabled = false;
    el.pauseButton.disabled = true;
    el.stepButton.disabled = false;
    logEvent("Simulación pausada.");
});

el.stepButton.addEventListener('click', () => {
    if (simulationIntervalId) return; // Can't step if running continuously
    readGlobalSettingsFromUI();
    if (simulationTime === 0) { // Ensure initialization if stepping from the very beginning
        initializeSimulationState();
    }
    simulationTick();
    logEvent("Simulación avanzada un paso.");
});

el.resetButton.addEventListener('click', () => {
    clearInterval(simulationIntervalId);
    simulationIntervalId = null;
    initializeSimulationState(); // This also resets simulationTime to 0 and clears logs
    el.startButton.disabled = false;
    el.pauseButton.disabled = true;
    el.stepButton.disabled = false; // Can step from reset state
    logEvent("Simulación reiniciada.");
    updateAllDisplays(); // Ensure UI reflects reset state immediately
});


// Initial call to set up the page
initializeSimulationState();
readGlobalSettingsFromUI(); // Read initial values from HTML
updateAllDisplays(); // Display initial state
