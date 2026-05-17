/**
 * Part 3 demo: polling loop + Server-Sent Events feed of device state.
 *
 * Run with `npm run server` and open http://localhost:3050. The page
 * subscribes to /events and renders a live table of every device the
 * DeviceManager currently knows about, updated every poll tick.
 *
 * What this exercises:
 *
 *   1. setAsyncInterval: two recurring loops (enumeration + polling) that
 *      can never overlap themselves, even if a tick takes longer than the
 *      interval.
 *
 *   2. Liveness check: every poll tick we ping each known device. If the
 *      device fails to answer within the ping timeout we treat the port as
 *      dead and let the next enumeration tick decide whether to bring it
 *      back. This is what the Part 2 forward-reference promised.
 *
 *   3. Server-Sent Events: one-way push from server to browser. We don't
 *      need a WebSocket for this; the device is the source of truth and the
 *      page only reads.
 *
 * The fake firmware exposes `setFakeDeviceUnresponsive` so the demo can
 * toggle a device into a stuck state and watch the liveness check kick in.
 */

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SerialPortMock } from 'serialport';
import { myDevice } from '../device/myDevice/index.js';
import { DeviceManager } from '../device/DeviceManager.js';
import { setAsyncInterval } from '../device/AsyncInterval.js';
import { FakeFirmwarePort, setFakeDeviceState, setFakeDeviceUnresponsive } from './fakeFirmware.js';

const PORT = 3050;
const __dirname = dirname(fileURLToPath(import.meta.url));

// --- mock hardware setup ----------------------------------------------------
SerialPortMock.binding.createPort('/dev/mock-a', { vendorId: myDevice.VID, productId: myDevice.PID });
SerialPortMock.binding.createPort('/dev/mock-b', { vendorId: myDevice.VID, productId: myDevice.PID });
setFakeDeviceState('/dev/mock-a', { params: { SERIAL_NUMBER: 'DEMO_A_0001', LED_DRIVE: '64' } });
setFakeDeviceState('/dev/mock-b', { params: { SERIAL_NUMBER: 'DEMO_B_0002', LED_DRIVE: '192' } });

// --- domain layer -----------------------------------------------------------
const manager = new DeviceManager(myDevice, { SerialPortClass: FakeFirmwarePort });

// Paths we recently dropped because they failed a liveness check, mapped to
// the timestamp at which they're allowed to come back. A device that's stuck
// but still listed by the OS (the classic Windows RS-232 "ghost port") will
// keep failing its ping; without this cooldown, enumeration would re-add it
// every couple of seconds and we'd churn forever. Closing the handle via
// resetPort is what eventually convinces Windows to drop the port too.
const FAIL_COOLDOWN_MS = 5000;
const lostUntil = new Map();

// --- HTTP / SSE -------------------------------------------------------------
const app = express();
app.use(express.static(join(__dirname, 'public')));

// One Set of open response objects; broadcast() writes the same SSE frame
// to every subscriber. Closed connections drop themselves on `req.close`.
const subscribers = new Set();

app.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    // Send the current device list immediately so a fresh page isn't blank
    // until the next enumeration tick.
    res.write(formatEvent('devices', manager.getDevices()));
    subscribers.add(res);
    req.on('close', () => subscribers.delete(res));
});

function formatEvent(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function broadcast(event, data) {
    const frame = formatEvent(event, data);
    for (const res of subscribers) res.write(frame);
}

// --- enumeration tick: discover/forget devices ------------------------------
const enumeration = setAsyncInterval(async () => {
    const before = manager.getDevices();
    // Drop expired cooldown entries before passing the filter to update().
    // Anything still in the map is a path we want manager.update() to treat
    // as unplugged for this tick. That's how we suppress the ghost-port
    // re-add loop without DeviceManager having to know about liveness.
    const now = Date.now();
    for (const [path, until] of lostUntil) {
        if (now >= until) lostUntil.delete(path);
    }
    await manager.update(p => !lostUntil.has(p.path));
    const after = manager.getDevices();
    if (before.length !== after.length || before.some((p, i) => p !== after[i])) {
        broadcast('devices', after);
    }
}, 2000);

// --- poll tick: snapshot every device, drop the dead ones -------------------
const polling = setAsyncInterval(async () => {
    const now = Date.now();
    for (const path of manager.getDevices()) {
        if ((lostUntil.get(path) ?? 0) > now) continue;
        const device = manager.getDevice(path);
        const alive = await device.ping();
        if (!alive) {
            console.warn(`device ${path} failed liveness check, resetting port`);
            lostUntil.set(path, now + FAIL_COOLDOWN_MS);
            await manager.resetPort(path);
            broadcast('device-lost', { path });
            continue;
        }
        try {
            const snapshot = await device.poll();
            broadcast('device-updated', { path, ...snapshot });
        } catch (err) {
            console.error(`poll failed for ${path}:`, err);
        }
    }
}, 1000);

// --- demo flair: flip mock-a unresponsive at 8s, restore at 18s -------------
setTimeout(() => {
    console.log('flipping /dev/mock-a unresponsive. liveness check should drop it');
    setFakeDeviceUnresponsive('/dev/mock-a', true);
}, 8000);
setTimeout(() => {
    console.log('restoring /dev/mock-a. next enumeration tick should re-add it');
    setFakeDeviceUnresponsive('/dev/mock-a', false);
}, 18000);

// --- lifecycle --------------------------------------------------------------
const server = app.listen(PORT, () => {
    console.log(`server listening on http://localhost:${PORT}`);
});

async function shutdown() {
    console.log('\nshutting down...');
    await Promise.all([enumeration.cancel(), polling.cancel()]);
    await manager.shutdown();
    server.close();
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
