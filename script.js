// --- Global Configuration & State ---
let routers = [];
let globalLinks = {}; // Nuevo: para manejar el estado de los enlaces
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
    routerDisplays: { // Para indicadores de actualización
        R1: document.getElementById('R1-update-indicator'),
        R2: document.getElementById('R2-update-indicator'),
        R3: document.getElementById('R3-update-indicator'),
        R4: document.getElementById('R4-update-indicator'),
    },
    routerTables: {
        R1: document.getElementById('R1-table').getElementsByTagName('tbody')[0],
        R2: document.getElementById('R2-table').getElementsByTagName('tbody')[0],
        R3: document.getElementById('R3-table').getElementsByTagName('tbody')[0],
        R4: document.getElementById('R4-table').getElementsByTagName('tbody')[0],
    },
    linkToggleButtons: document.querySelectorAll('.link-toggle-button')
};

// --- Classes ---
class RouteEntry {
    constructor(prefix, nextHop, metric, interfaceName, isDirectlyConnected = false, sourceRouterId = null) {
        this.prefix = prefix;
        this.nextHop = nextHop;
        this.metric = metric;
        this.interfaceName = interfaceName;
        this.isDirectlyConnected = isDirectlyConnected;
        this.sourceRouterId = sourceRouterId;

        this.invalidTimerCountdown = globalSettings.invalidTimer;
        this.flushTimerCountdown = globalSettings.flushTimer;
        this.markedForDeletion = false;

        if (isDirectlyConnected) {
            this.invalidTimerCountdown = Infinity;
            this.flushTimerCountdown = Infinity;
        }
    }

    resetTimers(newMetric) {
        if (this.isDirectlyConnected) return;
        this.metric = newMetric;
        this.invalidTimerCountdown = globalSettings.invalidTimer;
        this.markedForDeletion = false;
        this.flushTimerCountdown = globalSettings.flushTimer;
    }

    tickSecond(routerId) {
        if (this.isDirectlyConnected) return null;

        if (!this.markedForDeletion) {
            this.invalidTimerCountdown--;
            if (this.invalidTimerCountdown <= 0) {
                this.metric = MAX_METRIC;
                this.markedForDeletion = true;
                this.invalidTimerCountdown = 0;
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
        // interfacesConfig = [{ name: "eth0", ip: "2000:1::1/64", networkPrefix: "2000:1::/64", linkId: "L1", mapsToRouter: "R2", mapsToInterface: "eth1" }]
        this.interfaces = interfacesConfig.map(iface => ({
            ...iface,
            linkLocalAddress: `fe80::${this.id}:${iface.name}`,
            ripEnabled: true,
        }));
        this.routingTable = [];
        this.updateTimerCountdown = Math.floor(Math.random() * globalSettings.updateTimer) + 1;
        this.pendingTriggeredUpdate = false;
    }

    getInterfaceByName(name) {
        return this.interfaces.find(iface => iface.name === name);
    }

    getInterfaceByLinkId(linkId) {
        return this.interfaces.find(iface => iface.linkId === linkId);
    }

    isInterfaceUp(interfaceName) {
        const iface = this.getInterfaceByName(interfaceName);
        if (!iface || !iface.linkId) return false; // No link ID means it's not part of a manageable link
        return globalLinks[iface.linkId]?.status === "up";
    }
    
    initializeDirectlyConnectedRoutes() {
        this.routingTable = [];
        this.interfaces.forEach(iface => {
            if (this.isInterfaceUp(iface.name) && iface.ripEnabled) {
                const entry = new RouteEntry(iface.networkPrefix, "::", 1, iface.name, true, this.id);
                this.routingTable.push(entry);
            }
        });
    }

    handleLinkChange(linkId, newStatus) {
        const affectedInterface = this.getInterfaceByLinkId(linkId);
        if (!affectedInterface) return;

        logEvent(`${this.id}: Enlace ${linkId} (interfaz ${affectedInterface.name}) cambió a ${newStatus}.`);

        if (newStatus === "down") {
            // Remove directly connected route for this interface's network
            this.routingTable = this.routingTable.filter(route => {
                if (route.isDirectlyConnected && route.interfaceName === affectedInterface.name) {
                    logEvent(`${this.id}: Eliminada ruta directa ${route.prefix} por interfaz ${affectedInterface.name} caída.`);
                    return false;
                }
                return true;
            });

            // Invalidate routes learned via this interface
            this.routingTable.forEach(route => {
                if (!route.isDirectlyConnected && route.interfaceName === affectedInterface.name) {
                    if (route.metric < MAX_METRIC) {
                        route.metric = MAX_METRIC;
                        route.markedForDeletion = true;
                        route.invalidTimerCountdown = 0; // Mark for immediate flush start
                        route.flushTimerCountdown = globalSettings.flushTimer;
                        this.pendingTriggeredUpdate = true;
                        logEvent(`${this.id}: Ruta ${route.prefix} vía ${route.nextHop} (int ${affectedInterface.name}) invalidada por enlace caído.`);
                    }
                }
            });
        } else { // Link is up
            // Re-add directly connected route if it doesn't exist
            this.initializeDirectlyConnectedRoutes(); // Simplest way to re-add direct, will also re-check other interfaces
            this.pendingTriggeredUpdate = true; // Announce newly available direct network
        }
    }


    tickSecond() {
        let events = [];
        for (let i = this.routingTable.length - 1; i >= 0; i--) {
            const route = this.routingTable[i];
            const event = route.tickSecond(this.id);
            if (event) {
                if (event.type === 'route_flushed') {
                    this.routingTable.splice(i, 1);
                    this.pendingTriggeredUpdate = true;
                } else if (event.type === 'route_invalidated') {
                    this.pendingTriggeredUpdate = true;
                }
            }
        }

        this.updateTimerCountdown--;
        if (this.updateTimerCountdown <= 0 || (this.pendingTriggeredUpdate && globalSettings.triggeredUpdates)) {
            this.updateTimerCountdown = globalSettings.updateTimer;
            events.push({ type: 'send_update', routerId: this.id, isTriggered: this.pendingTriggeredUpdate });
            this.pendingTriggeredUpdate = false;
        }
        return events;
    }

    prepareUpdatePacketForInterface(sendingInterfaceName) {
        const updatePacket = [];
        if (!this.isInterfaceUp(sendingInterfaceName)) return [];

        this.routingTable.forEach(route => {
            let metricToSend = route.metric;
            if (globalSettings.splitHorizon && route.interfaceName === sendingInterfaceName && !route.isDirectlyConnected) {
                if (globalSettings.poisonReverse) {
                    metricToSend = MAX_METRIC;
                } else {
                    return; 
                }
            }
             // Ensure we don't send metric 0 for anything other than a specific RIPng "unreachable" context (not used here)
            if (metricToSend === 0 && !route.isDirectlyConnected) metricToSend = 1; // Should not happen with current logic
            updatePacket.push({ prefix: route.prefix, metric: metricToSend, sourceRouterId: this.id });
        });
        return updatePacket;
    }

    receiveUpdate(packet, fromRouterLLA, onInterfaceName) {
        if (!this.isInterfaceUp(onInterfaceName)) return;
        
        const receivingInterface = this.getInterfaceByName(onInterfaceName);
        logEvent(`${this.id}: Recibida actualización de ${fromRouterLLA} en ${onInterfaceName} con ${packet.length} entradas.`);
        let tableChanged = false;

        packet.forEach(receivedRoute => {
            if (receivedRoute.prefix === receivingInterface.networkPrefix && receivedRoute.metric < MAX_METRIC) {
                return;
            }

            let newMetric = receivedRoute.metric + 1;
            if (newMetric > MAX_METRIC) newMetric = MAX_METRIC;

            let existingRoute = this.routingTable.find(r => r.prefix === receivedRoute.prefix);

            if (existingRoute) {
                if (existingRoute.isDirectlyConnected) return;

                if (existingRoute.nextHop === fromRouterLLA && existingRoute.interfaceName === onInterfaceName) { // Same path
                    if (newMetric < MAX_METRIC) { // Regular update or better path
                         if (newMetric < existingRoute.metric || newMetric === existingRoute.metric ) { // update if better or same (to reset timer)
                            if(newMetric < existingRoute.metric) tableChanged = true; // only set changed if metric is better
                            existingRoute.resetTimers(newMetric);
                            logEvent(`${this.id}: Ruta ${receivedRoute.prefix} vía ${fromRouterLLA} refrescada/actualizada, nueva métrica ${newMetric}.`);
                         }
                    } else if (newMetric === MAX_METRIC && existingRoute.metric < MAX_METRIC) { // Route poisoned by neighbor
                        existingRoute.metric = MAX_METRIC;
                        existingRoute.markedForDeletion = true;
                        existingRoute.invalidTimerCountdown = 0;
                        existingRoute.flushTimerCountdown = globalSettings.flushTimer;
                        tableChanged = true;
                        logEvent(`${this.id}: Ruta ${receivedRoute.prefix} envenenada por ${fromRouterLLA}.`);
                    }
                } else { // Different path or different neighbor
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
function initializeLinks() {
    globalLinks = {
        "L1": { id: "L1", name: "R1-S1-R2", status: "up", peers: [{routerId: "R1", iface: "eth0"}, {routerId: "R2", iface: "eth1"}] },
        "L2": { id: "L2", name: "R2-S2-R4", status: "up", peers: [{routerId: "R2", iface: "eth0"}, {routerId: "R4", iface: "eth1"}] },
        "L3": { id: "L3", name: "R3-S3-R4", status: "up", peers: [{routerId: "R3", iface: "eth1"}, {routerId: "R4", iface: "eth0"}] }
    };
    updateLinkVisuals();
}


function initializeSimulationState() {
    simulationTime = 0;
    eventLog = [];
    routers = [];
    initializeLinks(); // Initialize links first

    const r1 = new Router("R1", "Router 1", [
        { name: "eth0", ip: "2000:1::1/64", networkPrefix: "2000:1::/64", linkId: "L1" }
    ]);
    const r2 = new Router("R2", "Router 2", [
        { name: "eth1", ip: "2000:1::2/64", networkPrefix: "2000:1::/64", linkId: "L1" },
        { name: "eth0", ip: "2000:2::2/64", networkPrefix: "2000:2::/64", linkId: "L2" }
    ]);
    const r3 = new Router("R3", "Router 3", [
        { name: "eth1", ip: "2000:3::1/64", networkPrefix: "2000:3::/64", linkId: "L3" }
    ]);
    const r4 = new Router("R4", "Router 4", [
        { name: "eth0", ip: "2000:3::2/64", networkPrefix: "2000:3::/64", linkId: "L3" },
        { name: "eth1", ip: "2000:2::1/64", networkPrefix: "2000:2::/64", linkId: "L2" }
    ]);

    routers = [r1, r2, r3, r4];
    routers.forEach(r => r.initializeDirectlyConnectedRoutes());

    updateAllDisplays();
    logEvent("Simulación inicializada.");
}

function simulationTick() {
    simulationTime++;
    let scheduledUpdates = [];

    routers.forEach(router => {
        const events = router.tickSecond();
        events.forEach(event => {
            if (event.type === 'send_update') {
                scheduledUpdates.push({ routerId: router.id, isTriggered: event.isTriggered });
            }
        });
    });

    scheduledUpdates.forEach(updateOrder => {
        const sendingRouter = routers.find(r => r.id === updateOrder.routerId);
        if (!sendingRouter) return;

        logEvent(`${sendingRouter.id} enviando ${updateOrder.isTriggered ? 'TRIGGERED' : 'REGULAR'} update.`);
        showUpdateIndicator(sendingRouter.id, true);


        sendingRouter.interfaces.forEach(sendingInterface => {
            if (!sendingRouter.isInterfaceUp(sendingInterface.name) || !sendingInterface.ripEnabled) return;

            const packet = sendingRouter.prepareUpdatePacketForInterface(sendingInterface.name);
            if (packet.length === 0) return;

            // Find neighbor on this link
            const link = globalLinks[sendingInterface.linkId];
            if (!link || link.status !== "up") return;

            link.peers.forEach(peer => {
                if (peer.routerId !== sendingRouter.id) { // This is the neighbor
                    const neighborRouter = routers.find(r => r.id === peer.routerId);
                    if (neighborRouter) {
                         // Ensure neighbor's side of the link is also considered "up" for reception
                        if(neighborRouter.isInterfaceUp(peer.iface)){
                            neighborRouter.receiveUpdate(packet, sendingInterface.linkLocalAddress, peer.iface);
                        }
                    }
                }
            });
        });
        // Turn off indicator after a short delay
        setTimeout(() => showUpdateIndicator(sendingRouter.id, false), 500);
    });

    updateAllDisplays();
}

// --- UI Update Functions ---
function updateAllDisplays() {
    el.simulationTimeDisplay.textContent = simulationTime;
    routers.forEach(router => updateRoutingTableDisplay(router));
    updateLinkVisuals(); // Update visual state of links/interfaces
    updateEventLogDisplay();
}

function updateRoutingTableDisplay(router) {
    const tableBody = el.routerTables[router.id];
    if (!tableBody) return;
    tableBody.innerHTML = ''; 

    router.routingTable.sort((a, b) => a.prefix.localeCompare(b.prefix)).forEach(route => {
        const row = tableBody.insertRow();
        row.insertCell().textContent = route.prefix;
        row.insertCell().textContent = route.nextHop;
        const metricCell = row.insertCell();
        metricCell.textContent = route.metric;
        if (route.metric === MAX_METRIC) metricCell.classList.add('metric-invalid');
        
        row.insertCell().textContent = route.interfaceName;
        let timeoutDisplay = route.isDirectlyConnected ? 'N/A' :
            route.markedForDeletion ? `FLUSH ${route.flushTimerCountdown}s` : `${route.invalidTimerCountdown}s`;
        if (route.metric === MAX_METRIC && !route.isDirectlyConnected && !route.markedForDeletion) timeoutDisplay += ` (INV)`;
        row.insertCell().textContent = timeoutDisplay;
    });
}

function logEvent(message) {
    const fullMessage = `[T=${simulationTime}s] ${message}`;
    eventLog.unshift(fullMessage); 
    if (eventLog.length > 200) eventLog.pop(); 
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

    if (!globalSettings.splitHorizon) {
        el.poisonReverse.checked = false;
        globalSettings.poisonReverse = false;
        el.poisonReverse.disabled = true;
    } else {
        el.poisonReverse.disabled = false;
    }
}

function showUpdateIndicator(routerId, isSending) {
    const indicator = el.routerDisplays[routerId];
    if (indicator) {
        if (isSending) {
            indicator.classList.add('sending');
        } else {
            indicator.classList.remove('sending');
        }
    }
}

function updateLinkVisuals() {
    el.linkToggleButtons.forEach(button => {
        const linkId = button.dataset.linkid;
        const link = globalLinks[linkId];
        if (link) {
            button.textContent = link.status === "up" ? "Activo" : "Inactivo";
            button.classList.toggle('active', link.status === "up");
            button.classList.toggle('inactive', link.status === "down");
        }
    });

    // Update interface paragraph visuals
    routers.forEach(router => {
        router.interfaces.forEach(iface => {
            const ifaceElement = document.querySelector(`.interfaces p[data-linkid="${iface.linkId}"][data-interface="${router.id}-${iface.name}"]`);
            // Need to fix the data-interface attribute in HTML to be unique, e.g. "R1-eth0"
            // For now, let's assume the HTML is updated.
            const uniqueIfaceSelector = document.querySelector(`.interfaces p[data-interface="${router.id}-${iface.name}"]`);
             if (uniqueIfaceSelector) {
                if (globalLinks[iface.linkId]?.status === "down") {
                    uniqueIfaceSelector.classList.add('link-down');
                } else {
                    uniqueIfaceSelector.classList.remove('link-down');
                }
            }
        });
    });
}
// --- Event Handlers ---
el.startButton.addEventListener('click', () => { /* ... (igual que antes) ... */ 
    if (simulationIntervalId) return;
    readGlobalSettingsFromUI();
    if (simulationTime === 0) { 
        initializeSimulationState();
    }
    simulationIntervalId = setInterval(simulationTick, 1000); 
    el.startButton.disabled = true;
    el.pauseButton.disabled = false;
    el.stepButton.disabled = true;
    logEvent("Simulación iniciada.");
});
el.pauseButton.addEventListener('click', () => { /* ... (igual que antes) ... */ 
    clearInterval(simulationIntervalId);
    simulationIntervalId = null;
    el.startButton.disabled = false;
    el.pauseButton.disabled = true;
    el.stepButton.disabled = false;
    logEvent("Simulación pausada.");
});
el.stepButton.addEventListener('click', () => { /* ... (igual que antes) ... */ 
    if (simulationIntervalId) return; 
    readGlobalSettingsFromUI();
    if (simulationTime === 0) { 
        initializeSimulationState();
    }
    simulationTick();
    logEvent("Simulación avanzada un paso.");
});
el.resetButton.addEventListener('click', () => { /* ... (igual que antes) ... */ 
    clearInterval(simulationIntervalId);
    simulationIntervalId = null;
    initializeSimulationState(); 
    el.startButton.disabled = false;
    el.pauseButton.disabled = true;
    el.stepButton.disabled = false;
    logEvent("Simulación reiniciada.");
    updateAllDisplays(); 
});

el.splitHorizon.addEventListener('change', readGlobalSettingsFromUI); // Actualizar al cambiar

el.linkToggleButtons.forEach(button => {
    button.addEventListener('click', () => {
        if (simulationIntervalId && simulationTime > 0) { // Only allow changes if paused or before start
            logEvent("ERROR: Detenga la simulación para cambiar el estado del enlace.");
            // alert("Por favor, pause o reinicie la simulación para cambiar el estado del enlace.");
            // return;
        }
        const linkId = button.dataset.linkid;
        const link = globalLinks[linkId];
        if (link) {
            link.status = (link.status === "up") ? "down" : "up";
            logEvent(`Usuario cambió enlace ${linkId} a ${link.status}.`);
            updateLinkVisuals();

            // Notify routers about the link change
            link.peers.forEach(peerInfo => {
                const router = routers.find(r => r.id === peerInfo.routerId);
                router?.handleLinkChange(linkId, link.status);
            });
            // If simulation is running, a triggered update might be good here,
            // otherwise changes will propagate on next tick or manual step.
            // For simplicity, relying on existing pendingTriggeredUpdate logic in routers.
             updateAllDisplays(); // Update UI immediately after link change
        }
    });
});

// Initial call
readGlobalSettingsFromUI();
initializeSimulationState();
updateAllDisplays();
