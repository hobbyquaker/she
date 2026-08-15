<script lang="ts">
    import { onMount, onDestroy, tick } from 'svelte';
    import jsQR from 'jsqr';
    import { subscribeWs } from '../lib/ws.js';
    import { listMatterDevices, getMatterDevice, commissionMatter, unpairMatter, sendMatterCommand, type MatterDevice, type MatterNodeDetail } from '../lib/api.js';
    import ConfirmDialog from '../lib/ConfirmDialog.svelte';

    interface AttrAction { label: string; command: string; args?: Record<string, unknown>; }
    const ATTR_ACTIONS: Record<string, Record<string, AttrAction[]>> = {
        onOff: {
            onOff: [
                { label: 'On',     command: 'on' },
                { label: 'Off',    command: 'off' },
                { label: 'Toggle', command: 'toggle' },
            ],
        },
        levelControl: {
            currentLevel: [
                { label: 'Step ▲', command: 'stepWithOnOff',  args: { stepMode: 0, stepSize: 25, transitionTime: 5 } },
                { label: 'Step ▼', command: 'stepWithOnOff',  args: { stepMode: 1, stepSize: 25, transitionTime: 5 } },
            ],
        },
        windowCovering: {
            currentPositionLiftPercent100ths: [
                { label: 'Open',  command: 'upOrOpen' },
                { label: 'Close', command: 'downOrClose' },
                { label: 'Stop',  command: 'stopMotion' },
            ],
            currentPositionTiltPercent100ths: [
                { label: 'Open',  command: 'upOrOpen' },
                { label: 'Close', command: 'downOrClose' },
                { label: 'Stop',  command: 'stopMotion' },
            ],
        },
    };

    let cmdError: string | null = $state(null);

    async function sendCmd(
        nodeId: string,
        endpointId: number,
        clusterName: string,
        command: string,
        args?: Record<string, unknown>,
    ) {
        cmdError = null;
        try {
            await sendMatterCommand(nodeId, endpointId, clusterName, command, args);
        } catch (e) {
            // Surface the failure — silently swallowed errors made broken
            // attribute-action buttons look like dead buttons.
            cmdError = `${clusterName}.${command} failed: ${e instanceof Error ? e.message : String(e)}`;
        }
    }

    // Map cluster name → command id → command name (Matter spec)
    const CLUSTER_COMMANDS: Record<string, Record<number, string>> = {
        identify:     { 0: 'identify', 1: 'triggerEffect' },
        groups:       { 0: 'addGroup', 1: 'viewGroup', 2: 'getGroupMembership', 3: 'removeGroup', 4: 'removeAllGroups', 5: 'addGroupIfIdentifying' },
        scenes:       { 0: 'addScene', 1: 'viewScene', 2: 'removeScene', 3: 'removeAllScenes', 4: 'storeScene', 5: 'recallScene', 6: 'getSceneMembership', 64: 'enhancedAddScene', 65: 'enhancedViewScene', 66: 'copyScene' },
        onOff:        { 0: 'off', 1: 'on', 2: 'toggle', 64: 'offWithEffect', 65: 'onWithRecallGlobalScene', 66: 'onWithTimedOff' },
        levelControl: { 0: 'moveToLevel', 1: 'move', 2: 'step', 3: 'stop', 4: 'moveToLevelWithOnOff', 5: 'moveWithOnOff', 6: 'stepWithOnOff', 7: 'stopWithOnOff', 8: 'moveToClosestFrequency' },
        colorControl: { 0: 'moveToHue', 1: 'moveHue', 2: 'stepHue', 3: 'moveToSaturation', 4: 'moveSaturation', 5: 'stepSaturation', 6: 'moveToHueAndSaturation', 7: 'moveToColor', 8: 'moveColor', 9: 'stepColor', 10: 'moveToColorTemperature', 64: 'enhancedMoveToHue', 65: 'enhancedMoveHue', 66: 'enhancedStepHue', 67: 'enhancedMoveToHueAndSaturation', 68: 'colorLoopSet', 71: 'stopMoveStep', 75: 'moveColorTemperature', 76: 'stepColorTemperature' },
        thermostat:   { 0: 'setpointRaiseLower', 1: 'setWeeklySchedule', 2: 'getWeeklySchedule', 3: 'clearWeeklySchedule' },
        doorLock:     { 0: 'lockDoor', 1: 'unlockDoor', 3: 'unlockWithTimeout', 11: 'setWeekDaySchedule', 12: 'getWeekDaySchedule', 13: 'clearWeekDaySchedule', 14: 'setYearDaySchedule', 15: 'getYearDaySchedule', 16: 'clearYearDaySchedule', 17: 'setHolidaySchedule', 18: 'getHolidaySchedule', 19: 'clearHolidaySchedule', 26: 'setUser', 27: 'getUser', 28: 'clearUser', 34: 'setCredential', 36: 'getCredential', 38: 'clearCredential' },
        windowCovering: { 0: 'upOrOpen', 1: 'downOrClose', 2: 'stopMotion', 4: 'goToLiftValue', 5: 'goToLiftPercentage', 7: 'goToTiltValue', 8: 'goToTiltPercentage' },
        fanControl:   { 0: 'step' },
    };

    function fmtCmdList(clusterName: string, ids: unknown[]): Array<{ name: string | null; id: number }> {
        const map = CLUSTER_COMMANDS[clusterName];
        return ids.map((raw) => {
            const id = typeof raw === 'number' ? raw : Number(raw);
            return { id, name: map?.[id] ?? null };
        });
    }

    // Matter device type ID → friendly name (Matter 1.x Device Library spec)
    const DEVICE_TYPES: Record<number, string> = {
        0x000A: 'Door Lock', 0x000B: 'Door Lock Controller',
        0x000E: 'Aggregator', 0x000F: 'Generic Switch',
        0x0011: 'On/Off Plug-In Unit', 0x0012: 'Dimmable Plug-In Unit',
        0x0013: 'Pump', 0x0014: 'On/Off Light Switch',
        0x0015: 'Dimmer Switch', 0x0016: 'Color Dimmer Switch',
        0x0017: 'Control Bridge', 0x0018: 'Pump Controller',
        0x0100: 'On/Off Light', 0x0101: 'Dimmable Light',
        0x010C: 'Extended Color Light', 0x010D: 'Color Temperature Light',
        0x0106: 'Light Sensor', 0x0107: 'Occupancy Sensor',
        0x0202: 'Window Covering', 0x0203: 'Window Covering Controller',
        0x0300: 'Heating/Cooling Unit', 0x0301: 'Thermostat',
        0x0302: 'Temperature Sensor', 0x0303: 'Pressure Sensor',
        0x0304: 'Flow Sensor', 0x0305: 'Humidity Sensor', 0x0306: 'On/Off Sensor',
        0x0840: 'Air Quality Sensor',
    };

    // Global attributes present on every cluster
    const GLOBAL_ATTRS: Record<string, number> = {
        generatedCommandList: 0xFFF8, acceptedCommandList: 0xFFF9,
        eventList: 0xFFFA, attributeList: 0xFFFB,
        featureMap: 0xFFFC, clusterRevision: 0xFFFD,
    };

    // Cluster-specific attribute IDs (Matter 1.x Core/Cluster spec)
    const CLUSTER_ATTRS: Record<string, Record<string, number>> = {
        descriptor: {
            deviceTypeList: 0x0000, serverList: 0x0001, clientList: 0x0002, partsList: 0x0003, tagList: 0x0004,
        },
        basicInformation: {
            dataModelRevision: 0x0000, vendorName: 0x0001, vendorID: 0x0002, vendorId: 0x0002,
            productName: 0x0003, productID: 0x0004, productId: 0x0004,
            nodeLabel: 0x0005, location: 0x0006, hardwareVersion: 0x0007, hardwareVersionString: 0x0008,
            softwareVersion: 0x0009, softwareVersionString: 0x000A, manufacturingDate: 0x000B, partNumber: 0x000C,
            productURL: 0x000D, productUrl: 0x000D, productLabel: 0x000E, serialNumber: 0x000F,
            localConfigDisabled: 0x0010, reachable: 0x0011, uniqueID: 0x0012, uniqueId: 0x0012,
            capabilityMinima: 0x0013, productAppearance: 0x0014,
            specificationVersion: 0x0015, maxPathsPerInvoke: 0x0016,
        },
        bridgedDeviceBasicInformation: {
            vendorName: 0x0001, vendorID: 0x0002, vendorId: 0x0002, productName: 0x0003, productId: 0x0004, nodeLabel: 0x0005,
            hardwareVersion: 0x0007, hardwareVersionString: 0x0008, softwareVersion: 0x0009,
            softwareVersionString: 0x000A, manufacturingDate: 0x000B, partNumber: 0x000C,
            productURL: 0x000D, productUrl: 0x000D, productLabel: 0x000E, serialNumber: 0x000F,
            reachable: 0x0011, uniqueID: 0x0012, uniqueId: 0x0012, productAppearance: 0x0014,
        },
        identify: { identifyTime: 0x0000, identifyType: 0x0001 },
        groups:   { nameSupport: 0x0000 },
        onOff: {
            onOff: 0x0000, globalSceneControl: 0x4000, onTime: 0x4001,
            offWaitTime: 0x4002, startUpOnOff: 0x4003,
        },
        levelControl: {
            currentLevel: 0x0000, remainingTime: 0x0001, minLevel: 0x0002, maxLevel: 0x0003,
            currentFrequency: 0x0004, minFrequency: 0x0005, maxFrequency: 0x0006, options: 0x000F,
            onOffTransitionTime: 0x0010, onLevel: 0x0011, onTransitionTime: 0x0012,
            offTransitionTime: 0x0013, defaultMoveRate: 0x0014, startUpCurrentLevel: 0x4000,
        },
        colorControl: {
            currentHue: 0x0000, currentSaturation: 0x0001, remainingTime: 0x0002,
            currentX: 0x0003, currentY: 0x0004, colorTemperatureMireds: 0x0007, colorMode: 0x0008, options: 0x000F,
            enhancedCurrentHue: 0x4000, enhancedColorMode: 0x4001, colorLoopActive: 0x4002,
            colorLoopDirection: 0x4003, colorLoopTime: 0x4004, colorCapabilities: 0x400A,
            colorTempPhysicalMinMireds: 0x400B, colorTempPhysicalMaxMireds: 0x400C,
            coupleColorTempToLevelMinMireds: 0x400D, startUpColorTemperatureMireds: 0x4010,
        },
        thermostat: {
            localTemperature: 0x0000, outdoorTemperature: 0x0001, occupancy: 0x0002,
            absMinHeatSetpointLimit: 0x0003, absMaxHeatSetpointLimit: 0x0004,
            absMinCoolSetpointLimit: 0x0005, absMaxCoolSetpointLimit: 0x0006,
            piCoolingDemand: 0x0007, piHeatingDemand: 0x0008,
            localTemperatureCalibration: 0x0010, occupiedCoolingSetpoint: 0x0011, occupiedHeatingSetpoint: 0x0012,
            unoccupiedCoolingSetpoint: 0x0013, unoccupiedHeatingSetpoint: 0x0014,
            minHeatSetpointLimit: 0x0015, maxHeatSetpointLimit: 0x0016,
            minCoolSetpointLimit: 0x0017, maxCoolSetpointLimit: 0x0018,
            minSetpointDeadBand: 0x0019, remoteSensing: 0x001A,
            controlSequenceOfOperation: 0x001B, systemMode: 0x001C, thermostatRunningMode: 0x001E,
            startOfWeek: 0x0020, numberOfWeeklyTransitions: 0x0021, numberOfDailyTransitions: 0x0022,
            temperatureSetpointHold: 0x0023, temperatureSetpointHoldDuration: 0x0024,
            thermostatProgrammingOperationMode: 0x0025, thermostatRunningState: 0x0029,
            setpointChangeSource: 0x0030, setpointChangeAmount: 0x0031, setpointChangeSourceTimestamp: 0x0032,
            occupiedSetback: 0x0034, unoccupiedSetback: 0x0037, emergencyHeatDelta: 0x003A,
        },
        windowCovering: {
            type: 0x0000, physicalClosedLimitLift: 0x0001, physicalClosedLimitTilt: 0x0002,
            currentPositionLift: 0x0003, currentPositionTilt: 0x0004,
            numberOfActuationsLift: 0x0005, numberOfActuationsTilt: 0x0006,
            configStatus: 0x0007, currentPositionLiftPercentage: 0x0008, currentPositionTiltPercentage: 0x0009,
            operationalStatus: 0x000A, targetPositionLiftPercent100ths: 0x000B, targetPositionTiltPercent100ths: 0x000C,
            endProductType: 0x000D, currentPositionLiftPercent100ths: 0x000E, currentPositionTiltPercent100ths: 0x000F,
            installedOpenLimitLift: 0x0010, installedClosedLimitLift: 0x0011,
            installedOpenLimitTilt: 0x0012, installedClosedLimitTilt: 0x0013,
            mode: 0x0017, safetyStatus: 0x001A,
        },
        doorLock: {
            lockState: 0x0000, lockType: 0x0001, actuatorEnabled: 0x0002, doorState: 0x0003,
            numberOfTotalUsersSupported: 0x0011, numberOfPINUsersSupported: 0x0012,
            maxPINCodeLength: 0x0017, minPINCodeLength: 0x0018,
            language: 0x0021, autoRelockTime: 0x0023, soundVolume: 0x0024,
            operatingMode: 0x0025, supportedOperatingModes: 0x0026, wrongCodeEntryLimit: 0x0030,
        },
        fanControl: {
            fanMode: 0x0000, fanModeSequence: 0x0001, percentSetting: 0x0002, percentCurrent: 0x0003,
            speedMax: 0x0004, speedSetting: 0x0005, speedCurrent: 0x0006,
            rockSupport: 0x0007, rockSetting: 0x0008, windSupport: 0x0009, windSetting: 0x000A,
            airflowDirectionSupport: 0x000B, airflowDirection: 0x000C,
        },
        occupancySensing: {
            occupancy: 0x0000, occupancySensorType: 0x0001, occupancySensorTypeBitmap: 0x0002,
            holdTime: 0x0003, pirOccupiedToUnoccupiedDelay: 0x0010, pirUnoccupiedToOccupiedDelay: 0x0011,
        },
        illuminanceMeasurement: {
            measuredValue: 0x0000, minMeasuredValue: 0x0001, maxMeasuredValue: 0x0002,
            tolerance: 0x0003, lightSensorType: 0x0004,
        },
        temperatureMeasurement: {
            measuredValue: 0x0000, minMeasuredValue: 0x0001, maxMeasuredValue: 0x0002, tolerance: 0x0003,
        },
        pressureMeasurement: {
            measuredValue: 0x0000, minMeasuredValue: 0x0001, maxMeasuredValue: 0x0002, tolerance: 0x0003,
            scaledValue: 0x0010, minScaledValue: 0x0011, maxScaledValue: 0x0012, scale: 0x0014,
        },
        flowMeasurement: {
            measuredValue: 0x0000, minMeasuredValue: 0x0001, maxMeasuredValue: 0x0002, tolerance: 0x0003,
        },
        relativeHumidityMeasurement: {
            measuredValue: 0x0000, minMeasuredValue: 0x0001, maxMeasuredValue: 0x0002, tolerance: 0x0003,
        },
        powerSource: {
            status: 0x0000, order: 0x0001, description: 0x0002,
            batVoltage: 0x000B, batPercentRemaining: 0x000C, batTimeRemaining: 0x000D,
            batChargeLevel: 0x000E, batReplacementNeeded: 0x000F, batReplaceability: 0x0010,
            batPresent: 0x0011, activeBatFaults: 0x0012, batChargeState: 0x001A,
        },
    };

    function fmtHex(id: number): string {
        return '0x' + id.toString(16).toUpperCase().padStart(4, '0');
    }

    let devices: MatterDevice[] = $state([]);
    // Cache of node details keyed by nodeId — used for friendly name resolution in the event feed.
    let nodeDetails = $state(new Map<string, MatterNodeDetail>());

    function deviceName(nodeId: string): string {
        const n = nodeDetails.get(nodeId)?.name ?? devices.find((d) => d.nodeId === nodeId)?.name;
        return n ? `${n}` : `#${nodeId}`;
    }

    function endpointName(nodeId: string, endpointId: number): string {
        const ep = nodeDetails.get(nodeId)?.endpoints.find((e) => e.endpointId === endpointId);
        return ep?.name ?? `ep${endpointId}`;
    }

    function fmtVal(v: unknown): string {
        if (v === null || v === undefined) return '—';
        if (typeof v === 'boolean') return String(v);
        if (typeof v === 'number') return String(v);
        if (typeof v === 'string') return v.length > 50 ? v.slice(0, 47) + '…' : v;
        const s = JSON.stringify(v);
        return s.length > 60 ? s.slice(0, 57) + '…' : s;
    }

    function fmtScalar(v: unknown): string {
        if (v === null || v === undefined) return '—';
        if (typeof v === 'boolean') return String(v);
        if (typeof v === 'number') return String(v);
        if (typeof v === 'string') return v;
        return JSON.stringify(v);
    }

    function isPlainObj(v: unknown): v is Record<string, unknown> {
        return v !== null && typeof v === 'object' && !Array.isArray(v);
    }

    function isArrOfObj(v: unknown): v is Record<string, unknown>[] {
        return Array.isArray(v) && v.length > 0 && v.every(isPlainObj);
    }

    function isHidden(v: unknown, k?: string): boolean {
        if (k === 'attributeList') return true;
        if (Array.isArray(v) && v.length === 0) return true;
        if (isPlainObj(v) && Object.keys(v).length === 0) return true;
        return false;
    }

    function fmtTime(ts: number): string {
        return new Date(ts).toLocaleTimeString(undefined, {
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        });
    }

    // ── Event feed ──────────────────────────────────────────────────────────
    const FEED_MAX   = 500;
    const FEED_ROW_H = 20;
    const FEED_HDR_H = 32;

    interface EventRow {
        id: number;
        kind: 'attr' | 'status';
        nodeId: string;
        endpointId?: number;
        clusterName?: string;
        attrName?: string;
        value?: unknown;
        online?: boolean;
        ts: number;
    }

    let _evtSeq = 0;
    let feed = $state<EventRow[]>([]);
    let feedOpen = $state(true);
    let feedHeight = $state(180);

    let feedSlice = $derived.by(() => {
        const max = Math.max(1, Math.floor((feedHeight - FEED_HDR_H) / FEED_ROW_H) + 1);
        return feed.slice(0, max);
    });

    function startResize(e: MouseEvent) {
        e.preventDefault();
        const startY = e.clientY;
        const startH = feedHeight;
        function onMove(ev: MouseEvent) { feedHeight = Math.max(60, Math.min(600, startH + startY - ev.clientY)); }
        function onUp() { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }
    let selected: MatterNodeDetail | null = $state(null);
    let loading = $state(false);
    let error: string | null = $state(null);

    // Commission wizard state
    let showWizard = $state(false);
    let wizardMode: 'passcode' | 'pairingCode' = $state('passcode');
    let wizardPasscode = $state('');
    let wizardDiscriminator = $state('');
    let wizardPairingCode = $state('');
    let wizardBusy = $state(false);
    let wizardError: string | null = $state(null);
    let wizardDiscoveryAddress = $state('');

    // QR scan state
    let scanOpen   = $state(false);
    let scanError  = $state('');
    let videoEl    = $state<HTMLVideoElement | undefined>(undefined);
    let canvasEl   = $state<HTMLCanvasElement | undefined>(undefined);
    let _stream: MediaStream | null = null;
    let _scanRaf: number | null = null;

    function stopScan() {
        if (_scanRaf !== null) { cancelAnimationFrame(_scanRaf); _scanRaf = null; }
        if (_stream) { _stream.getTracks().forEach((t) => t.stop()); _stream = null; }
        scanOpen = false;
        scanError = '';
    }

    function onQrFound(code: string) {
        stopScan();
        wizardMode = 'pairingCode';
        wizardPairingCode = code;
    }

    function tryDecodeCanvas() {
        if (!canvasEl) return null;
        const ctx = canvasEl.getContext('2d', { willReadFrequently: true })!;
        const { width, height } = canvasEl;
        if (!width || !height) return null;
        const img = ctx.getImageData(0, 0, width, height);
        return jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    }

    async function startCamera() {
        scanOpen = true;
        scanError = '';
        await tick();
        if (!videoEl || !canvasEl) return;
        try {
            _stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
            videoEl.srcObject = _stream;
            await videoEl.play();
        } catch (e: unknown) {
            scanError = 'Camera unavailable: ' + (e instanceof Error ? e.message : String(e));
            return;
        }
        const scanFrame = () => {
            if (!videoEl || !canvasEl || !_stream) return;
            if (videoEl.readyState === videoEl.HAVE_ENOUGH_DATA) {
                canvasEl.width  = videoEl.videoWidth;
                canvasEl.height = videoEl.videoHeight;
                const ctx = canvasEl.getContext('2d', { willReadFrequently: true })!;
                ctx.drawImage(videoEl, 0, 0);
                const result = tryDecodeCanvas();
                if (result?.data?.startsWith('MT:')) { onQrFound(result.data); return; }
            }
            _scanRaf = requestAnimationFrame(scanFrame);
        };
        _scanRaf = requestAnimationFrame(scanFrame);
    }

    function handleQrFile(e: Event) {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            const img = new Image();
            img.onload = () => {
                if (!canvasEl) return;
                canvasEl.width  = img.width;
                canvasEl.height = img.height;
                const ctx = canvasEl.getContext('2d', { willReadFrequently: true })!;
                ctx.drawImage(img, 0, 0);
                const result = tryDecodeCanvas();
                if (result?.data?.startsWith('MT:')) { onQrFound(result.data); }
                else { scanError = 'No Matter QR code found in image.'; }
            };
            img.src = ev.target!.result as string;
        };
        reader.readAsDataURL(file);
    }

    const LS_MATTER_NODE = 'she:matter:selectedNodeId';

    async function loadDevices() {
        try {
            devices = await listMatterDevices();
            // Pre-fetch details for all paired nodes so the event feed can show friendly names.
            for (const d of devices) {
                getMatterDevice(d.nodeId)
                    .then((detail) => { nodeDetails.set(d.nodeId, detail); })
                    .catch(() => { /* offline or controller not running — skip */ });
            }
            // Restore persisted selection, or default to first device.
            if (devices.length > 0 && !selected) {
                const saved = localStorage.getItem(LS_MATTER_NODE);
                const target = (saved && devices.find((d) => d.nodeId === saved)) ? saved : devices[0].nodeId;
                selectDevice(target);
            }
        } catch {
            /* matter controller may not be running */
            devices = [];
        }
    }

    async function selectDevice(nodeId: string) {
        loading = true;
        error = null;
        try {
            selected = await getMatterDevice(nodeId);
            nodeDetails.set(nodeId, selected); // keep cache up-to-date
            localStorage.setItem(LS_MATTER_NODE, nodeId);
        } catch (e: unknown) {
            error = e instanceof Error ? e.message : String(e);
        } finally {
            loading = false;
        }
    }

    let dialog: { show(msg: string, opts?: { confirm?: string; danger?: boolean; alert?: boolean }): Promise<boolean> };

    async function unpair(nodeId: string) {
        if (!(await dialog.show(`Unpair device ${nodeId}?`, { confirm: 'Unpair', danger: true }))) return;
        try {
            await unpairMatter(nodeId);
            if (selected?.nodeId === nodeId) selected = null;
            await loadDevices();
        } catch (e: unknown) {
            error = e instanceof Error ? e.message : String(e);
        }
    }

    async function commission() {
        wizardBusy = true;
        wizardError = null;
        try {
            let opts: ({ passcode: number; discriminator?: number } | { pairingCode: string }) & { discoveryAddress?: string };
            if (wizardMode === 'passcode') {
                opts = { passcode: Number(wizardPasscode) };
                if (wizardDiscriminator) opts = { ...opts, discriminator: Number(wizardDiscriminator) };
            } else {
                opts = { pairingCode: wizardPairingCode.trim() };
            }
            if (wizardDiscoveryAddress.trim()) opts = { ...opts, discoveryAddress: wizardDiscoveryAddress.trim() };
            await commissionMatter(opts);
            showWizard = false;
            wizardPasscode = '';
            wizardDiscriminator = '';
            wizardPairingCode = '';
            wizardDiscoveryAddress = '';
            await loadDevices();
        } catch (e: unknown) {
            wizardError = e instanceof Error ? e.message : String(e);
        } finally {
            wizardBusy = false;
        }
    }

    onMount(() => {
        loadDevices();
    });

    // Subscribe to WS events — split by type so each handler only fires for its message.
    // The previous single-callback form passed a function as the `type` arg (a bug) and
    // never received any messages; these per-type subscriptions fix that.
    const unsubList   = subscribeWs('matter:deviceList', (msg) => {
        if (!Array.isArray(msg.devices)) return;
        const updated = msg.devices as MatterDevice[];
        // Fetch details for any newly appeared nodes
        for (const d of updated) {
            if (!nodeDetails.has(d.nodeId)) {
                getMatterDevice(d.nodeId)
                    .then((detail) => { nodeDetails.set(d.nodeId, detail); })
                    .catch(() => {});
            }
        }
        devices = updated;
    });
    const unsubStatus = subscribeWs('matter:deviceStatus', (msg) => {
        if (msg.nodeId === undefined) return;
        const nodeId = String(msg.nodeId);
        const online = Boolean(msg.online);
        devices = devices.map((d) => (d.nodeId === nodeId ? { ...d, online } : d));
        feed = [{ id: _evtSeq++, kind: 'status', nodeId, online, ts: Date.now() }, ...feed.slice(0, FEED_MAX - 1)];
    });
    const unsubAttr   = subscribeWs('matter:attr', (msg) => {
        const nodeId     = String(msg.nodeId);
        const endpointId = msg.endpointId as number;
        const clusterName = String(msg.clusterName);
        const attrName   = String(msg.attrName);
        const value      = msg.value;

        // Update the live table for the currently selected node.
        if (selected && selected.nodeId === nodeId) {
            const ep = selected.endpoints.find((e) => e.endpointId === endpointId);
            const cl = ep?.clusters.find((c) => c.name === clusterName);
            if (cl) cl.attrs[attrName] = value;
        }
        // Also keep the nodeDetails cache in sync (used for the event feed name lookups).
        const cached = nodeDetails.get(nodeId);
        if (cached) {
            const ep = cached.endpoints.find((e) => e.endpointId === endpointId);
            const cl = ep?.clusters.find((c) => c.name === clusterName);
            if (cl) cl.attrs[attrName] = value;
        }

        feed = [{
            id: _evtSeq++,
            kind: 'attr',
            nodeId,
            endpointId,
            clusterName,
            attrName,
            value,
            ts: (msg.ts as number) ?? Date.now(),
        }, ...feed.slice(0, FEED_MAX - 1)];
    });

    onDestroy(() => { unsubList(); unsubStatus(); unsubAttr(); stopScan(); });
</script>

<ConfirmDialog bind:this={dialog} />
<div class="matter-page">
    <div class="matter-main">
    <div class="sidebar">
        <div class="sidebar-header">
            <span class="sidebar-title">Matter Devices</span>
            <button class="add-btn" onclick={() => {
                showWizard = !showWizard;
                // Reset state left over from a previous (possibly hung) attempt
                if (showWizard) { wizardBusy = false; wizardError = null; }
            }} title="Commission new device">＋</button>
        </div>

        {#if showWizard}
            <div class="wizard">
                <div class="wizard-tabs">
                    <button class:active={wizardMode === 'passcode'} onclick={() => (wizardMode = 'passcode')}>Passcode</button>
                    <button class:active={wizardMode === 'pairingCode'} onclick={() => (wizardMode = 'pairingCode')}>QR / Code</button>
                </div>
                {#if wizardMode === 'passcode'}
                    <label>
                        Passcode
                        <input type="number" placeholder="20202021" bind:value={wizardPasscode} />
                    </label>
                    <label>
                        Discriminator (optional)
                        <input type="number" placeholder="3840" bind:value={wizardDiscriminator} />
                    </label>
                {:else}
                    <label>
                        Pairing Code / QR
                        <input type="text" placeholder="MT:… or 11-digit code e.g. 2477-500-3245" bind:value={wizardPairingCode} />
                    </label>
                    <div class="scan-row">
                        <button class="scan-btn" onclick={startCamera} title="Scan QR code with camera">
                            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M1 1h5v5H1V1zm1 1v3h3V2H2zm7-1h5v5h-5V1zm1 1v3h3V2h-3zM1 9h5v5H1V9zm1 1v3h3v-3H2zm7 0h2v2H9v-2zm2 0h2v2h-2v-2zm0 2h2v2h-2v-2zm-2 2h2v2H9v-2zm2 0h2v2h-2v-2z"/></svg>
                            Camera
                        </button>
                        <label class="scan-btn scan-file-btn" title="Decode QR from image file">
                            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M13 4H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1zM3 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H3zm5 2.5a.5.5 0 0 1 .5.5v1h1a.5.5 0 0 1 0 1h-1v1a.5.5 0 0 1-1 0v-1h-1a.5.5 0 0 1 0-1h1V6a.5.5 0 0 1 .5-.5z"/></svg>
                            Image…
                            <input type="file" accept="image/*" style="display:none" onchange={handleQrFile} />
                        </label>
                    </div>
                {/if}
                <label>
                    IP Address (optional, bypasses mDNS)
                    <input type="text" placeholder="192.168.1.100 or 192.168.1.100:5540" bind:value={wizardDiscoveryAddress} />
                </label>
                {#if wizardError}
                    <p class="err">{wizardError}</p>
                {/if}
                <button class="commission-btn" disabled={wizardBusy} onclick={commission}>
                    {wizardBusy ? 'Commissioning…' : 'Commission'}
                </button>
            </div>
        {/if}

        <ul class="device-list">
            {#each devices as device (device.nodeId)}
                <li class:selected={selected?.nodeId === device.nodeId}>
                    <button
                        class="device-select-btn"
                        onclick={() => selectDevice(device.nodeId)}
                    >
                        <span class="status-dot" class:online={device.online}></span>
                        <span class="device-label">
                            {#if device.name}
                                <span class="device-name">{device.name}</span>
                                <span class="device-nodeid">#{device.nodeId}</span>
                            {:else}
                                <span class="device-name">Node {device.nodeId}</span>
                            {/if}
                        </span>
                    </button>
                    <button
                        class="unpair-btn"
                        title="Unpair"
                        onclick={() => unpair(device.nodeId)}
                    >✕</button>
                </li>
            {/each}
            {#if devices.length === 0}
                <li class="empty">No paired devices</li>
            {/if}
        </ul>
    </div>

    <div class="detail">
        {#if loading}
            <p class="info">Loading…</p>
        {:else if error}
            <p class="err">{error}</p>
        {:else if selected}
            {#if cmdError}
                <p class="err cmd-err">
                    {cmdError}
                    <button class="err-dismiss" onclick={() => (cmdError = null)} title="Dismiss">✕</button>
                </p>
            {/if}
            <div class="detail-hdr">
                <h2>{selected.name ?? `Node ${selected.nodeId}`}</h2>
                {#if selected.subtitle}
                    <p class="device-subtitle">{selected.subtitle}</p>
                {/if}
                <p class="detail-nodeid">Node ID: {selected.nodeId}</p>
            </div>
            {#each selected.endpoints as ep (ep.endpointId)}
                <details>
                    <summary>
                        {ep.name ?? `Endpoint ${ep.endpointId}`}
                        <span class="ep-id">ep{ep.endpointId}</span>
                        <span class="ep-chips">
                            {#each ep.clusters as cluster}
                                <span class="ep-chip">{cluster.name}</span>
                            {/each}
                        </span>
                    </summary>
                    {#if ep.clusters.length > 0}
                        <table class="cluster-table">
                            <colgroup>
                                <col class="col-attr-name">
                                <col class="col-attr-actions">
                                <col class="col-attr-val">
                            </colgroup>
                            <tbody>
                                {#each ep.clusters as cluster}
                                    <tr class="cluster-hdr-row">
                                        <td colspan="3" class="cluster-hdr-cell">{cluster.name}</td>
                                    </tr>
                                    {#each Object.entries(cluster.attrs) as [k, v]}
                                        {#if !isHidden(v, k)}
                                            {@const actions = ATTR_ACTIONS[cluster.name]?.[k]}
                                            {@const isCmdList = (k === 'acceptedCommandList' || k === 'generatedCommandList') && Array.isArray(v)}
                                            {@const attrId = CLUSTER_ATTRS[cluster.name]?.[k] ?? GLOBAL_ATTRS[k]}
                                            <tr>
                                                <td class="attr-name-cell" title={k}>
                                                    <span class="attr-key">{k}</span>{#if attrId !== undefined}<span class="attr-id"> ({fmtHex(attrId)})</span>{/if}
                                                </td>
                                                <td class="attr-actions-cell">
                                                    {#if actions}
                                                        <div class="attr-actions">
                                                            {#each actions as act}
                                                                <button class="attr-action-btn" onclick={() => sendCmd(selected!.nodeId, ep.endpointId, cluster.name, act.command, act.args)}>{act.label}</button>
                                                            {/each}
                                                        </div>
                                                    {/if}
                                                </td>
                                                <td class="attr-val-cell">
                                                    {#if isCmdList}
                                                        <span class="cmd-list">
                                                            {#each fmtCmdList(cluster.name, v as unknown[]) as cmd, i}
                                                                {#if i > 0}<span class="cmd-sep">, </span>{/if}
                                                                {#if cmd.name}<span class="cmd-name">{cmd.name}</span><span class="cmd-id"> ({cmd.id})</span>{:else}<span class="cmd-id">{cmd.id}</span>{/if}
                                                            {/each}
                                                        </span>
                                                    {:else if k === 'deviceTypeList' && Array.isArray(v)}
                                                        <table class="attr-arr-table">
                                                            <thead><tr><th>deviceType</th><th>revision</th></tr></thead>
                                                            <tbody>
                                                                {#each v as dtRow}
                                                                    {@const dtItem = dtRow as Record<string, unknown>}
                                                                    {@const dtId = dtItem.deviceType as number}
                                                                    {@const dtName = DEVICE_TYPES[dtId]}
                                                                    <tr>
                                                                        <td>{#if dtName}{dtName} <span class="cmd-id">({fmtHex(dtId)})</span>{:else}{fmtHex(dtId)}{/if}</td>
                                                                        <td>{fmtScalar(dtItem.revision)}</td>
                                                                    </tr>
                                                                {/each}
                                                            </tbody>
                                                        </table>
                                                    {:else if isArrOfObj(v)}
                                                        {@const cols = [...new Set((v as Record<string, unknown>[]).flatMap((item) => Object.keys(item)))]}
                                                        <table class="attr-arr-table">
                                                            <thead><tr>{#each cols as col}<th>{col}</th>{/each}</tr></thead>
                                                            <tbody>
                                                                {#each v as item}
                                                                    <tr>{#each cols as col}<td>{fmtScalar((item as Record<string, unknown>)[col])}</td>{/each}</tr>
                                                                {/each}
                                                            </tbody>
                                                        </table>
                                                    {:else if isPlainObj(v)}
                                                        <table class="attr-obj-table">
                                                            <tbody>
                                                            {#each Object.entries(v) as [ok, ov]}
                                                                <tr>
                                                                    <td class="attr-obj-key">{ok}</td>
                                                                    <td class="attr-obj-val">{fmtScalar(ov)}</td>
                                                                </tr>
                                                            {/each}
                                                            </tbody>
                                                        </table>
                                                    {:else if (k === 'productUrl' || k === 'productURL') && typeof v === 'string'}
                                                        <a class="attr-link" href={v} target="_blank" rel="noopener noreferrer">{v}</a>
                                                    {:else}
                                                        <span class="attr-val">{fmtScalar(v)}</span>
                                                    {/if}
                                                </td>
                                            </tr>
                                        {/if}
                                    {/each}
                                {/each}
                            </tbody>
                        </table>
                    {:else}
                        <p class="no-clusters">No clusters</p>
                    {/if}
                </details>
            {/each}
        {:else}
            <p class="info">Select a device to view its endpoints.</p>
        {/if}
    </div>
    </div><!-- /.matter-main -->

    <!-- Matter Events feed -->
    <div class="stream-panel" style={feedOpen ? `height: ${feedHeight}px;` : ''}>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="stream-resize" onmousedown={startResize}></div>
        <div class="stream-hdr-row">
            <span class="stream-title">Matter Events</span>
            {#if !feedOpen && feed.length > 0}
                <span class="stream-badge">{feed.length}</span>
            {/if}
            <button class="stream-toggle" onclick={() => { feedOpen = !feedOpen; }} title="Toggle event feed">
                {feedOpen ? '▾' : '▸'}
            </button>
        </div>
        {#if feedOpen}
            <div class="stream-body">
                {#if feedSlice.length === 0}
                    <span class="stream-empty">Waiting for events…</span>
                {:else}
                    {#each feedSlice as row (row.id)}
                        {@const dname = nodeDetails.get(row.nodeId)?.name ?? devices.find((d) => d.nodeId === row.nodeId)?.name ?? null}
                        {@const epname = row.endpointId !== undefined ? (nodeDetails.get(row.nodeId)?.endpoints.find((e) => e.endpointId === row.endpointId)?.name ?? null) : null}
                        {@const attrLabel = row.attrName ?? row.clusterName}
                        <div class="er">
                            <span class="e-ts">{fmtTime(row.ts)}</span>
                            {#if row.kind === 'status'}
                                <span class="e-badge e-badge-status">status</span>
                                <span class="e-node">{dname ?? `#${row.nodeId}`}{#if dname}&nbsp;<span class="e-sub">(#{row.nodeId})</span>{/if}</span>
                                <span class="e-val" class:e-online={row.online} class:e-offline={!row.online}>{row.online ? 'online' : 'offline'}</span>
                            {:else}
                                <span class="e-badge e-badge-attr">attr</span>
                                <span class="e-node">{dname ?? `#${row.nodeId}`}{#if dname}&nbsp;<span class="e-sub">(#{row.nodeId})</span>{/if}</span>
                                <span class="e-ep">{epname ?? `ep${row.endpointId}`}{#if epname}&nbsp;<span class="e-sub">(ep {row.endpointId})</span>{/if}</span>
                                <span class="e-cluster">{row.clusterName}</span>
                                <span class="e-attr">{attrLabel}</span>
                                <span class="e-val">{fmtVal(row.value)}</span>
                            {/if}
                        </div>
                    {/each}
                {/if}
            </div>
        {/if}
    </div>
</div>

{#if scanOpen}
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="scan-backdrop" onclick={stopScan}></div>
    <div class="scan-modal">
        <div class="scan-modal-hdr">
            <span>Scan Matter QR Code</span>
            <button class="scan-close" onclick={stopScan}>✕</button>
        </div>
        {#if scanError}
            <p class="scan-err">{scanError}</p>
        {:else}
            <div class="scan-preview">
                <!-- svelte-ignore a11y_media_has_caption -->
                <video bind:this={videoEl} playsinline class="scan-video"></video>
                <div class="scan-reticle"></div>
            </div>
            <p class="scan-hint">Point camera at the QR code on the device</p>
        {/if}
        <canvas bind:this={canvasEl} style="display:none"></canvas>
    </div>
{/if}

<style>
    .matter-page {
        display: flex;
        flex-direction: column;
        height: 100%;
        color: var(--fg);
        font-size: 13px;
    }
    .matter-main {
        flex: 1;
        display: flex;
        overflow: hidden;
    }

    /* Sidebar */
    .sidebar {
        width: 220px;
        min-width: 160px;
        border-right: 1px solid var(--border-sub);
        display: flex;
        flex-direction: column;
        background: var(--bg-panel);
        overflow-y: auto;
    }
    .sidebar-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 10px;
        border-bottom: 1px solid var(--border-sub);
    }
    .sidebar-title {
        font-weight: 600;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--fg-muted);
    }
    .add-btn {
        background: none;
        border: none;
        color: var(--fg-brand);
        cursor: pointer;
        font-size: 16px;
        padding: 0 4px;
        line-height: 1;
    }
    .add-btn:hover {
        color: var(--fg-value);
    }

    /* Wizard */
    .wizard {
        padding: 8px 10px;
        border-bottom: 1px solid var(--border);
        display: flex;
        flex-direction: column;
        gap: 6px;
    }
    .wizard-tabs {
        display: flex;
        gap: 4px;
    }
    .wizard-tabs button {
        flex: 1;
        background: var(--bg-widget);
        border: 1px solid var(--border);
        color: var(--fg);
        cursor: pointer;
        padding: 3px 6px;
        border-radius: 3px;
        font-size: 11px;
    }
    .wizard-tabs button.active {
        background: var(--bg-active);
        color: var(--fg-text);
        border-color: var(--fg-brand);
    }
    label {
        display: flex;
        flex-direction: column;
        gap: 2px;
        font-size: 11px;
        color: var(--fg-muted);
    }
    input {
        background: var(--bg-app);
        border: 1px solid var(--border);
        color: var(--fg-text);
        padding: 3px 6px;
        border-radius: 3px;
        font-size: 12px;
        width: 100%;
        box-sizing: border-box;
    }
    input:focus {
        outline: none;
        border-color: var(--fg-brand);
    }
    .commission-btn {
        background: var(--accent);
        border: none;
        color: #fff;
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 3px;
        font-size: 12px;
    }
    .commission-btn:hover:not(:disabled) {
        background: var(--accent-hov);
    }
    .commission-btn:disabled {
        opacity: 0.5;
        cursor: default;
    }

    /* Device list */
    .device-list {
        list-style: none;
        margin: 0;
        padding: 4px 0;
        flex: 1;
    }
    .device-list li {
        display: flex;
        align-items: center;
        padding: 5px 10px;
        cursor: pointer;
        border-radius: 3px;
        margin: 1px 4px;
    }
    .device-select-btn {
        background: none;
        border: none;
        color: inherit;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 6px;
        flex: 1;
        min-width: 0;
        padding: 0;
        font: inherit;
        text-align: left;
    }
    .device-list li:hover {
        background: var(--bg-hover);
    }
    .device-list li.selected {
        background: var(--bg-active);
    }
    .device-list li.empty {
        cursor: default;
        color: var(--fg-dim);
        font-style: italic;
    }
    .device-list li.empty:hover {
        background: none;
    }
    .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--fg-dim);
        flex-shrink: 0;
    }
    .status-dot.online {
        background: var(--fg-ok);
    }
    .device-label {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 1px;
    }
    .device-name {
        font-size: 12px;
        color: var(--fg);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 100%;
    }
    .device-nodeid {
        font-family: monospace;
        font-size: 10px;
        color: var(--fg-dim);
    }
    .unpair-btn {
        background: none;
        border: none;
        color: var(--fg-dim);
        cursor: pointer;
        font-size: 11px;
        padding: 0 2px;
        opacity: 0;
    }
    .device-list li:hover .unpair-btn {
        opacity: 1;
        color: var(--fg-err);
    }

    /* Detail pane */
    .detail {
        flex: 1;
        padding: 16px 20px;
        overflow-y: auto;
    }
    .detail-hdr {
        margin-bottom: 14px;
    }
    .detail h2 {
        font-size: 15px;
        font-weight: 600;
        margin: 0 0 2px;
        color: var(--fg-text);
    }
    .device-subtitle {
        margin: 0 0 2px;
        font-size: 11px;
        color: var(--fg-muted);
    }
    .detail-nodeid {
        margin: 0;
        font-family: monospace;
        font-size: 10px;
        color: var(--fg-dim);
    }
    details {
        margin-bottom: 8px;
        background: var(--bg-panel);
        border: 1px solid var(--border-sub);
        border-radius: 4px;
    }
    summary {
        padding: 6px 10px;
        cursor: pointer;
        font-weight: 500;
        color: var(--fg-value);
        font-size: 12px;
        display: flex;
        align-items: center;
        gap: 6px;
    }
    .ep-id {
        font-family: monospace;
        font-size: 10px;
        color: var(--fg-dim);
        font-weight: normal;
    }
    .ep-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 3px;
        margin-left: 4px;
        flex: 1;
        overflow: hidden;
    }
    details[open] .ep-chips { display: none; }
    .ep-chip {
        background: var(--bg-widget);
        border: 1px solid var(--border);
        border-radius: 3px;
        padding: 0 5px;
        font-family: monospace;
        font-size: 10px;
        font-weight: normal;
        color: #ce9178;
        white-space: nowrap;
        line-height: 16px;
    }
    .cluster-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 11px;
        margin: 0;
        table-layout: fixed;
    }
    .col-attr-name    { width: 200px; }
    .col-attr-actions { width: 110px; }
    .cluster-table tbody tr {
        border-bottom: 1px solid var(--border-sub);
    }
    .cluster-table tbody tr:last-child {
        border-bottom: none;
    }
    .cluster-hdr-row {
        background: var(--bg-hover);
    }
    .cluster-hdr-cell {
        padding: 3px 10px;
        font-family: monospace;
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.3px;
        color: #ce9178;
        text-transform: none;
        border-bottom: 1px solid var(--border-sub);
    }
    .attr-name-cell {
        padding: 3px 6px 3px 18px;
        white-space: nowrap;
        vertical-align: middle;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .attr-actions-cell {
        padding: 2px 6px;
        white-space: nowrap;
        vertical-align: middle;
    }
    .attr-val-cell {
        padding: 3px 10px 3px 6px;
        vertical-align: middle;
    }
    .attr-key {
        color: var(--fg-muted);
        font-family: monospace;
    }
    .attr-id {
        color: var(--fg-dim);
        font-family: monospace;
        font-size: 10px;
    }
    .attr-actions {
        display: flex;
        flex-wrap: nowrap;
        gap: 3px;
    }
    .attr-action-btn {
        padding: 1px 6px;
        font-size: 10px;
        border: 1px solid var(--border);
        border-radius: 3px;
        background: var(--bg-input, #2a2a2a);
        color: var(--fg);
        cursor: pointer;
        line-height: 1.4;
    }
    .attr-action-btn:hover {
        background: var(--bg-active);
    }
    .attr-action-btn:active {
        opacity: 0.7;
    }
    .attr-val {
        color: var(--fg-value);
        font-family: monospace;
        word-break: break-all;
    }
    .attr-link {
        color: var(--fg-link, #4ec9b0);
        font-family: monospace;
        word-break: break-all;
        text-decoration: none;
    }
    .attr-link:hover {
        text-decoration: underline;
    }
    .attr-obj-table {
        border-collapse: collapse;
        font-size: 11px;
        font-family: monospace;
    }
    .attr-arr-table {
        border-collapse: collapse;
        font-size: 11px;
        font-family: monospace;
    }
    .attr-arr-table thead th {
        color: var(--fg-muted);
        font-weight: 600;
        font-size: 10px;
        padding: 0 10px 2px 0;
        text-align: left;
        white-space: nowrap;
        border-bottom: 1px solid var(--border-sub);
    }
    .attr-arr-table tbody td {
        color: var(--fg-value);
        padding: 1px 10px 1px 0;
        vertical-align: baseline;
        white-space: nowrap;
    }
    .attr-obj-key {
        color: var(--fg-muted);
        padding: 0 8px 0 0;
        white-space: nowrap;
        vertical-align: baseline;
    }
    .attr-obj-val {
        color: var(--fg-value);
        word-break: break-all;
        vertical-align: baseline;
    }
    .cmd-list {
        font-family: monospace;
        font-size: 11px;
    }
    .cmd-name {
        color: var(--fg-value);
    }
    .cmd-id {
        color: var(--fg-dim);
        font-size: 10px;
    }
    .cmd-sep {
        color: var(--fg-dim);
    }
    .no-clusters {
        margin: 0;
        padding: 6px 10px;
        font-style: italic;
        color: var(--fg-dim);
        font-size: 11px;
    }
    .info {
        color: var(--fg-dim);
        font-style: italic;
    }
    .err {
        color: var(--fg-err);
    }
    .cmd-err {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
        border: 1px solid var(--fg-err);
        border-radius: 3px;
        padding: 6px 10px;
        margin: 0 0 10px;
        word-break: break-word;
    }
    .err-dismiss {
        margin-left: auto;
        background: none;
        border: none;
        color: var(--fg-err);
        cursor: pointer;
        font-size: 12px;
        flex-shrink: 0;
        padding: 0 2px;
    }

    /* ── Matter Events stream pane ── */
    .stream-panel {
        flex-shrink: 0;
        border-top: 1px solid var(--border);
        background: var(--bg-panel);
        display: flex;
        flex-direction: column;
        min-height: 28px;
    }
    .stream-resize {
        height: 5px;
        margin-top: -3px;
        cursor: ns-resize;
        flex-shrink: 0;
        background: transparent;
        transition: background 0.15s;
    }
    .stream-resize:hover { background: var(--accent); opacity: 0.4; }
    .stream-hdr-row {
        display: flex;
        align-items: center;
        flex-shrink: 0;
        padding: 4px 8px 4px 12px;
        gap: 6px;
        border-bottom: 1px solid var(--border-sub);
        min-height: 28px;
    }
    .stream-title {
        flex: 1;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--fg-muted);
    }
    .stream-badge {
        font-size: 10px;
        background: var(--accent);
        color: #fff;
        border-radius: 8px;
        padding: 0 5px;
        line-height: 16px;
    }
    .stream-toggle {
        background: none;
        border: none;
        color: var(--fg-dim);
        cursor: pointer;
        padding: 2px 6px;
        font-size: 11px;
        border-radius: 3px;
        flex-shrink: 0;
    }
    .stream-toggle:hover { background: var(--bg-hover); color: var(--fg); }
    .stream-body {
        overflow: hidden;
        flex: 1;
        font-size: 12px;
        font-family: monospace;
    }
    .stream-empty { padding: 4px 12px; color: var(--fg-dim); font-style: italic; }
    .er {
        display: flex;
        align-items: center;
        gap: 8px;
        height: 20px;
        padding: 0 12px;
    }
    .er:hover { background: var(--bg-hover); }
    .e-ts { color: var(--fg-dim); font-size: 11px; flex-shrink: 0; width: 64px; }
    .e-badge {
        font-size: 10px;
        border-radius: 3px;
        padding: 0 4px;
        flex-shrink: 0;
        line-height: 16px;
    }
    .e-badge-attr   { background: #1e3a5f; color: #79b8ff; }
    .e-badge-status { background: #2d3b1e; color: #98c379; }
    .e-node  { color: var(--fg-muted); flex-shrink: 0; }
    .e-ep    { color: var(--fg-dim); flex-shrink: 0; }
    .e-cluster { color: #ce9178; flex-shrink: 0; }
    .e-attr  { color: var(--fg-value); flex-shrink: 0; }
    .e-sub   { color: var(--fg-dim); font-size: 10px; }
    .e-val {
        color: var(--fg);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1;
    }
    .e-online  { color: var(--fg-ok); }
    .e-offline { color: var(--fg-err); }

    /* QR scan */
    .scan-row { display: flex; gap: 5px; }
    .scan-btn {
        flex: 1; display: flex; align-items: center; justify-content: center; gap: 4px;
        background: var(--bg-widget); border: 1px solid var(--border); color: var(--fg);
        border-radius: 3px; cursor: pointer; font-size: 11px; padding: 4px 6px;
    }
    .scan-btn:hover { background: var(--bg-hover); }
    .scan-file-btn { cursor: pointer; }

    .scan-backdrop {
        position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 1000;
    }
    .scan-modal {
        position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
        background: var(--bg-panel); border: 1px solid var(--border); border-radius: 8px;
        z-index: 1001; width: 360px; max-width: 95vw; overflow: hidden;
        display: flex; flex-direction: column; gap: 0;
    }
    .scan-modal-hdr {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 14px; border-bottom: 1px solid var(--border); font-size: 13px; font-weight: 600;
    }
    .scan-close {
        background: none; border: none; color: var(--fg-muted); cursor: pointer; font-size: 14px;
        padding: 0 2px; line-height: 1;
    }
    .scan-close:hover { color: var(--fg); }
    .scan-preview { position: relative; width: 100%; aspect-ratio: 1; background: #000; overflow: hidden; }
    .scan-video { width: 100%; height: 100%; object-fit: cover; display: block; }
    .scan-reticle {
        position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
        width: 60%; aspect-ratio: 1;
        border: 2px solid rgba(86,156,214,.8); border-radius: 6px;
        box-shadow: 0 0 0 1000px rgba(0,0,0,.35);
    }
    .scan-hint { margin: 0; padding: 8px 14px 10px; font-size: 11px; color: var(--fg-muted); text-align: center; }
    .scan-err { margin: 0; padding: 10px 14px; font-size: 12px; color: var(--fg-err); }
</style>
