In Part 2 we ended with a `DeviceManager` that knew which devices were plugged in and let us call methods on them. That's enough to drive a CLI demo, but most real applications want continuously-updated state on a screen: a dashboard that shows what each device is doing right now, and notices when one stops answering.

This part wires up that pipeline:

1. A polling loop that fetches device state on a schedule.
2. A liveness check that notices when a device has gone silent.
3. A small Express server that pushes the polled state into the browser via Server-Sent Events.

Run it with `npm run server` and open <http://localhost:3050>.

## What this part assumes

This part inherits the series-wide assumptions in the [README](README.md#what-this-tutorial-assumes): query-response devices, port held open across commands. Two more are specific to Part 3:

- **Sub-second to a few-second polling cadence.** A dashboard wants fresh state every second or so, which is what justifies the loop machinery below. If you're polling every few minutes, open-per-call (described in the README) sidesteps almost everything this part is solving.
- **Windows is where the pain lives.** The polling and SSE plumbing is platform-agnostic, but the ghost-port discussion later is Windows-flavored. On Linux and macOS the OS will usually drop a yanked device from the port list immediately; it's Windows with RS-232-emulating devices that needs the liveness check most.

## Polling: why you can't just listen

Devices will typically sit there until you ask them something, and then they answer. There's no `device.on('telemetry-changed')`. If you want to know what the LED drive setting is right now, you write `!GET,LED_DRIVE\r` and read the response.

So the application has to ask, on a schedule. That's what polling is.

## Where update() falls short

Part 2's `manager.update()` answers the question "what does the OS say is plugged in?" by filtering `SerialPort.list()` against our VID/PID. That's the right starting point, but it can lie to us.

On Linux, when a USB device is yanked the kernel drops it from the port list immediately. `update()` notices on the next call. But Part 2 already mentioned the failure mode on Windows: with an RS-232-emulating device, if the firmware locks up while the host has the port open, Windows will keep the port in the list until the host closes its handle. Run `update()` and the manager dutifully reports a "connected" device that isn't going to answer anything.

So we can't trust enumeration as the only signal. We need two more: one for the case the OS *can* see, and one for the case it can't.

## The free half: close events

When a USB device is physically yanked, node-serialport emits a `'close'` event on the port with `err.disconnected = true`. We get this for free, sub-100 ms after the OS notices. We just have to listen for it and clean up our state. Filter for the `disconnected` flag, though, because `'close'` also fires when *we* call `close()` ourselves (during eviction, shutdown, etc.) and we don't want to double-handle those.

We could attach the listener directly from `DeviceManager` to `device.port`, but that means the manager reaching through the device to grab a reference to the port. That's exactly the leak we cleaned up by giving `myDevice` its own `close()` method. Better to extend the `myDevice` constructor with an `onDisconnect` callback and let the device own the listener:

```js
constructor(id, SerialPortClass = SerialPort, { onDisconnect } = {}) {
    // ... existing port setup ...
    this.port.on('close', (err) => {
        if (err?.disconnected && onDisconnect) onDisconnect();
    });
}
```

The manager passes the callback when it constructs the device:

```js
const device = new this.DeviceClass(path, this.SerialPortClass, {
    onDisconnect: () => this._handleDisconnect(path),
});
this.devices.set(path, device);
```

`_handleDisconnect` is just `this.devices.delete(path)`. The OS already closed the handle, so we don't call `device.close()` again. That would emit a redundant `'close'` (without `disconnected`) for no reason. The next enumeration tick will see the shorter list and broadcast.

This catches one of the two failure modes: the cable was unplugged, or the driver decided the device is gone. It does *not* catch the case where the cable is fine and the firmware is wedged. For that, we have to talk to the device.

## The other half: a liveness ping

For the wedged case we poke each known device with a command we already know it supports and watch for an answer. `myDevice.ping()`:

```js
ping() {
    const cmd = Buffer.from('!GET,FW_VERSION\r', 'ascii');
    return this.queue.add(() => new Promise((resolve, reject) => {
        ack_call(this, resolve, reject, cmd, 1000);
    })).then(() => true, () => false);
}
```

A few things worth pointing out:

- **It uses the queue.** A ping has to fight for its turn with whatever other commands are in flight. If we bypassed the queue, the ping's response could get attributed to a previous in-flight `getParam` and corrupt that result.
- **It uses a shorter timeout.** `ack_call` defaults to 5 seconds, fine for a `getParam` you're waiting on synchronously, way too long for a liveness probe. We added a `timeoutMs` parameter to `ack_call` and pass 1000 here.
- **It returns a boolean, not a value.** The ping doesn't care what the firmware version is, only whether the device answered.

## The ghost-port loop (and how to break it)

Naive liveness would be: ping fails, call `manager.resetPort(path)`, forget about it. Then trust the next call to `update()` to re-add the device if it's still really there.

Try that on Windows and you get a feedback loop. The OS still lists the stuck path. Enumeration adds it back. We ping it, it fails, we evict, enumeration adds it back, ping fails, evict, forever. The screen flickers and you waste a port reset every cycle. (Note that the close-event handler from the previous section is no help here. The OS hasn't fired `'close'` because from its perspective nothing has gone wrong. The handle is still valid; the firmware on the other end just isn't answering.)

The fix is a brief cooldown. After a failed ping, mark the path as recently-lost for a window (we use 5 seconds; tune for your hardware) and have enumeration treat it as if it weren't there until the cooldown expires.

`DeviceManager.update()` grew a small filter parameter for this:

```js
async update(filter) {
    const allPorts = await this.SerialPortClass.list();
    const matching = allPorts.filter(
        p => p.vendorId === this.DeviceClass.VID && p.productId === this.DeviceClass.PID
    );
    const candidates = filter ? matching.filter(filter) : matching;
    // ...
}
```

The filter is optional and the manager has no opinion about *why* you'd want to suppress a path. The application passes a predicate that returns false for anything currently in its `lostUntil` map.

> **Aside on responsibility.** Liveness is the application's policy, not the manager's. The manager's job is "the OS says these ports are connected; here are device objects for them." Different apps want different policies: fail-fast for an industrial control pipeline, long cooldown for a kiosk that wants to ride out flaky USB. Baking one into the manager would force every consumer to argue with it. The filter parameter pushes that decision out to the caller.

## Driving it on a schedule

`update()` and `ping()` give us two things to do periodically: re-enumerate, and probe each known device. A first attempt:

```js
setInterval(async () => {
    await manager.update(filter);
}, 2000);

setInterval(async () => {
    for (const path of manager.getDevices()) {
        const alive = await manager.getDevice(path).ping();
        // ...
    }
}, 1000);
```

This works until the device gets slow. `setInterval` doesn't care whether the previous tick finished, it fires every 1000 ms regardless. If a poll tick is briefly taking 1500 ms:

- t=1000: tick fires, queues a `ping`. Still in flight at t=2000.
- t=2000: another tick fires, queues another `ping`. The first one finishes at t=2500. Second is still in flight.
- t=3000: another tick, another queued probe. The queue keeps growing.

You've now got an unbounded backlog of pending reads. Memory grows, latency grows, and on a real device you eventually time out a command that was queued thirty seconds ago and call it dead, even though the device was fine.

The fix is to wait for each tick to finish before scheduling the next one. There's no built-in for this in Node, so we write one:

```js
// device/AsyncInterval.js
export function setAsyncInterval(fn, intervalMs) {
    let cancelled = false;
    let timer = null;
    let currentTick = null;

    const tick = async () => {
        if (cancelled) return;
        currentTick = (async () => {
            try {
                await fn();
            } catch (err) {
                console.error('setAsyncInterval tick failed:', err);
            }
        })();
        await currentTick;
        currentTick = null;
        if (cancelled) return;
        timer = setTimeout(tick, intervalMs);
    };

    timer = setTimeout(tick, intervalMs);
    return {
        async cancel() {
            cancelled = true;
            if (timer) clearTimeout(timer);
            if (currentTick) await currentTick;
        },
    };
}
```

It's a recursive `setTimeout`. The next tick is scheduled only after `await fn()` settles, so a slow tick stretches the gap between calls instead of letting them stack. The `intervalMs` is the gap between ticks, not the period, close enough for telemetry.

Worth flagging:

- **Errors don't break the loop.** A tick that throws gets logged and the loop continues. If you don't catch, an uncaught rejection inside the `setTimeout` callback will tear down the process.
- **Cancellation is awaitable.** `cancel()` returns a Promise that resolves once any in-flight tick has finished. Awaiting it before closing ports keeps `manager.shutdown()` from racing a mid-flight write. If you skip the await, the port can close while a `device.poll()` is still mid-getParam and the write rejects with "Write canceled".

## Where the loop lives

You'll notice `setAsyncInterval` lives in `device/AsyncInterval.js` as a free function, and the actual enumeration and poll loops live in `demo/server.js`. Neither one is a method on `DeviceManager`. That's deliberate.

The manager's contract is "given a class with `VID`/`PID`, keep a map of currently-connected device instances." It exposes `update()`, `getDevice()`, and `shutdown()` and that's it. As soon as you bake a polling cadence into it, you've made every consumer agree on:

- How often to re-enumerate.
- How often to probe liveness.
- What to do when liveness fails.
- Whether the application is even running a long-lived loop, versus a one-shot CLI tool that calls `update()` manually.

A CLI tool that prints a snapshot doesn't want a background timer keeping the process alive. A dashboard wants two timers on different cadences. The same manager class supports both because it doesn't run the loop itself. The application decides whether to wrap it in `setAsyncInterval`, a `setInterval`, a single call on a button click, or whatever fits.

This is the same reasoning as the cooldown filter from earlier: lifecycle versus policy. The manager owns lifecycle, the application owns policy.

## Streaming to a browser with SSE

The polling loop produces a stream of events: "device discovered", "device updated", "device lost". The browser wants to render those. We have a few choices for getting them across:

- **WebSockets**: full duplex, but we don't need the browser to send anything back. Overkill.
- **HTTP polling**: `setInterval` in the browser fetching `/state.json`. Works, but layers a second polling problem on top of the first one we just solved.
- **Server-Sent Events**: one-way push from server to browser over a single long-lived HTTP request. The browser has built-in `EventSource` support that handles reconnects.

SSE is the right shape here: server is the source of truth, browser only reads.

The server-side wire format is plain text:

```
event: device-updated
data: {"path":"/dev/mock-a","serialNumber":"DEMO_A_0001","ledDrive":"64"}

```

(Two newlines terminate a frame.) Express makes this trivial: set the right `Content-Type`, hold the response open, and call `res.write(frame)` for every event.

```js
app.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(formatEvent('devices', manager.getDevices()));
    subscribers.add(res);
    req.on('close', () => subscribers.delete(res));
});
```

The first thing we send is a snapshot of the current device list, so a freshly-connected page isn't blank waiting for the next enumeration tick. After that, the polling loops broadcast to every open `res` whenever anything changes.

On the browser side it's just `EventSource`:

```js
const evt = new EventSource('/events');
evt.addEventListener('device-updated', (e) => {
    const { path, serialNumber, ledDrive } = JSON.parse(e.data);
    // … render row
});
```

`EventSource` reconnects automatically if the server restarts, so we don't write any reconnect logic ourselves.

## Putting it together

`demo/server.js` glues the pieces:

- A `DeviceManager` over `FakeFirmwarePort` so the demo runs without hardware.
- An enumeration loop on a 2-second cadence: drop expired cooldown entries, then `manager.update(filter)` that suppresses any path still in cooldown.
- A polling loop on a 1-second cadence: for each known device, ping, then either `device.poll()` and broadcast or mark it lost and broadcast.
- An Express app with a static `public/` directory and an `/events` SSE endpoint.

To actually exercise the liveness path, the demo flips `/dev/mock-a` unresponsive at the 8-second mark and restores it at 18 seconds. Open the page before then and you'll see the device drop from "live" to "lost" and back, with the cooldown holding it in the lost state for a few seconds even though the OS still lists it.

To point this at real hardware, swap `FakeFirmwarePort` for `SerialPort` in the manager constructor and remove the mock-port setup at the top of `server.js`. Set `myDevice.VID` and `myDevice.PID` to your device's values. Nothing else changes.

## Beyond Part 3

This is enough to power a small operations dashboard. A few directions you might extend it:

- **Push commands from the browser**: add a `POST /devices/:path/leds/on` route that calls `manager.getDevice(path).ledOn()`. SSE handles the read side; HTTP POSTs handle writes. (At that point you might decide you want WebSockets after all.)
- **Persist polled state**: write each `device-updated` event to a time-series store. Now you have a history view, not just a live one.
- **Recovery escalation**: track consecutive ping failures per device and run progressively heavier recovery actions: cooldown, then `resetPort`, then surface a UI banner asking the user to power-cycle.

As a bonus I've added a chapter on pushing Device Firmware Updates, DFU (`Bonus-DFU.md`). This is one place where polling-and-pushing isn't enough: firmware updates need a different control flow, because the device drops off the bus halfway through and reappears with a different identity. My experience is specifically with STMicroelectronics chips but some of the same patterns should apply for other chipsets as well.
