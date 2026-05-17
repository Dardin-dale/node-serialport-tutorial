If you followed along with [Part 1](Part1.md), we should now have a working device interface. In this part we're going to connect to multiple devices, build a Device Manager to track them, and find out why that promise queue from Part 1 is doing more work than you might think.

But first, the topic I deferred from Part 1: non-volatile memory and the set/save workflow.

## Wrapping up myDevice

### Non-Volatile Memory: Set vs Save

Most embedded devices store their configuration in non-volatile memory (flash, EEPROM, or similar). These storage technologies have limited write cycles, often tens of thousands. To protect the hardware, firmware typically separates *changing* a value from *saving* it:

- **SET** writes the new value to volatile (RAM) memory. It takes effect immediately but is lost on power cycle.
- **SAVE** commits all pending changes from RAM to non-volatile storage, consuming a write cycle.

This lets you SET several parameters in quick succession without burning a write cycle for each one, then SAVE once to commit the batch. For our device, the commands look like:

- `!SET,PARAM_NAME,VALUE\r`: set a parameter in RAM
- `!CAL,1,1\r`: save all pending changes to non-volatile memory

Let's add these to our `myDevice` class. We'll also import the `Params` module so we can validate values before sending them to the device:

`index.js`

```javascript
import Params from './parameters.js';

// ... existing code ...

export class myDevice {
    // ... constructor, ledOn, ledOff, getParam ...

    setParam(param, value) {
        if (!Params.isValid(param, value)) {
            return Promise.reject('Invalid value for parameter: ' + param);
        }
        const cmd = Buffer.from('!SET,' + param + ',' + value + '\r', 'ascii');
        return this.queue.add(() => new Promise((resolve, reject) => {
            ack_call(this, resolve, reject, cmd);
        }));
    }

    saveParams() {
        const cmd = Buffer.from('!CAL,1,1\r', 'ascii');
        return this.queue.add(() => new Promise((resolve, reject) => {
            ack_call(this, resolve, reject, cmd);
        }));
    }
}
```

`setParam` validates the value *before* sending anything to the device. If the value is out of range, we reject the promise immediately. No command hits the wire, no write cycle is consumed. The `parameters.js` file we set up in Part 1 is doing the validation here.

To update a parameter and persist it, we call both in sequence:

```javascript
await device.setParam('LED_DRIVE', '50');
await device.saveParams();
```

Two `await`s in a row sequentially is fine when you're the only one holding a reference to this device. In a real application, you aren't.

### The concurrency problem

A real application has many pieces of code calling the same device:

```javascript
// Calibration module, called when the user adjusts a setting
async function updateCalibration(device) {
    await device.setParam('LED_DRIVE', '200');
    await device.saveParams();
}

// Data display module, called when the user opens a device info panel
async function fetchDeviceInfo(device) {
    const sn = await device.getParam('SERIAL_NUMBER');
    const led = await device.getParam('LED_DRIVE');
    return { sn, led };
}
```

Both modules hold a reference to the same device. The user opens the info panel right as a calibration is running. What happens?

The two sequential `await`s in `updateCalibration` are fine on their own. The second doesn't fire until the first resolves. But while `setParam` is awaiting the device response, the JavaScript event loop is free to run other work. If `fetchDeviceInfo` fires during that window, its `getParam` call writes to the serial port immediately.

Now there are two commands on the wire. The device has one UART[^1] and one processing loop, and it didn't expect that. And when responses come back, there's no request ID in the protocol to tell them apart. The response `!ACK,GET,DEMO_SN_00001;A3F2\r` looks the same whether it was in reply to your `getParam` or someone else's. The *only* correlation is temporal: the next response is for the last command sent.

With two commands in flight, `setParam`'s `.once('data')` listener catches the first response, which might be for the GET. `getParam`'s listener catches the second, which might be for the SET. Both callers get wrong data. `saveParams` fires next and might commit the wrong state. Nobody got an error.

This is the kind of bug that works in testing (one caller at a time) and breaks silently in production.

### The fix: one command at a time

What the protocol requires is **strict request → response → request → response ordering**. One command on the wire at a time. In other languages this concept is called mutual exclusion[^2]: a lock that only one caller can hold.

JavaScript doesn't have a built-in lock, but a promise queue with `concurrency: 1` gives us the same guarantee. We use `p-queue` because it gives us a drain signal we'll need for graceful shutdown later. `async-mutex` is another viable option.

This is why Part 1 wrapped every method in `this.queue.add(...)`:

```javascript
getParam(param) {
    const cmd = Buffer.from('!GET,' + param + '\r', 'ascii');
    return this.queue.add(() => new Promise((resolve, reject) => {
        ack_call(this, resolve, reject, cmd);
    }));
}
```

The `queue.add()` is what prevents silent data corruption across your entire application. When `fetchDeviceInfo` calls `getParam` while `updateCalibration`'s `setParam` is in flight, the `getParam` call enters the queue and *waits*. It doesn't write to the port, doesn't register a listener, doesn't touch the wire. It sits in the queue until `setParam` resolves. Then it runs. One at a time. No cross-talk.

And `updateParam` chaining set + save? Both go through the queue individually:

```javascript
async updateParam(param, value) {
    await this.setParam(param, value);
    return this.saveParams();
}
```

Because the queue has `concurrency: 1`, set and save execute in sequence with no possibility of another command slipping in between. From the caller's perspective, this is a single atomic operation.

The queue protects a single device. A real application usually has more than one. Devices get plugged in, unplugged, swapped. Before we can manage that lifecycle, we need to find the devices in the first place.

## Device Enumeration

When you plug a USB serial device into your machine, the operating system assigns it a path:

- **Windows:** `COM3`, `COM4`, `COM15`, ... (note COM1 & COM2 are typically reserved)
- **Linux:** `/dev/ttyUSB0`, `/dev/ttyACM0`, ...
- **macOS:** `/dev/tty.usbmodem*`, `/dev/tty.usbserial*`, ...

We could hardcode a path, but that breaks as soon as the user plugs the device into a different USB port, or plugs in a second device. We need to enumerate all available serial ports and identify which ones are ours.

The `serialport` library gives us `SerialPort.list()`, which returns metadata for every serial port the OS knows about:

```javascript
import { SerialPort } from 'serialport';

const ports = await SerialPort.list();
console.log(ports);
// [
//   { path: 'COM3', manufacturer: 'FTDI', vendorId: '0403', productId: '6001', ... },
//   { path: 'COM15', manufacturer: 'STMicroelectronics', vendorId: '0483', productId: '5740', ... },
//   ...
// ]
```

Every USB device has a **Vendor ID** (VID) and **Product ID** (PID) burned into its firmware. These are the platform-neutral way to identify your device type. They're the same on Windows, Linux, and macOS. For our example device, we'll use `VID: 0x0483` and `PID: 0x5740` (STMicroelectronics Virtual COM Port, common in STM32-based devices).

The VID/PID belong to the device so we can put them into the device class:

```javascript
export class myDevice {
    static VID = '0483';
    static PID = '5740';
    // ... constructor, methods ...
}
```

Filtering is straightforward:

```javascript
async function enumerateDevices() {
    const allPorts = await SerialPort.list();
    return allPorts.filter(port =>
        port.vendorId === myDevice.VID && port.productId === myDevice.PID
    );
}
```

Now we know *which* ports have our devices. Next: managing the lifecycle of connecting to them, keeping track of which ones are still plugged in, and cleaning up when they disappear.

## The DeviceManager

### Why you need one

With one device, you can get away with opening a port in your main script and calling methods directly. With multiple devices (the normal case in test stations, lab equipment, manufacturing lines), you need a central registry that:

1. Keeps a single source of truth for which devices are currently connected
2. Creates a `myDevice` instance when a new device appears
3. Removes devices that have been disconnected
4. Lets application code look up a device by path
5. Shuts down cleanly when the application exits

### First pass: a Map and an update method

The DeviceManager is generic. It manages the lifecycle and routing, but doesn't know anything about the specific device protocol. You hand it a device class (`myDevice`) and it reads the VID/PID off that class to decide which serial ports belong to it. Think of it as `DeviceManager<MyDevice>` without the TypeScript.

It maintains a `Map` keyed on port path, one entry per connected device:

`DeviceManager.js`

```javascript
import { SerialPort } from 'serialport';

export class DeviceManager {
    constructor(DeviceClass) {
        this.DeviceClass = DeviceClass;
        this.devices = new Map();
    }

    async update() {
        const allPorts = await SerialPort.list();
        const matchingPaths = new Set(
            allPorts
                .filter(p => p.vendorId === this.DeviceClass.VID && p.productId === this.DeviceClass.PID)
                .map(p => p.path)
        );

        // Add newly connected devices
        for (const path of matchingPaths) {
            if (!this.devices.has(path)) {
                this.devices.set(path, new this.DeviceClass(path));
            }
        }

        // Remove disconnected devices
        for (const path of this.devices.keys()) {
            if (!matchingPaths.has(path)) {
                await this.devices.get(path).close();
                this.devices.delete(path);
            }
        }
    }

    getDevices() {
        return [...this.devices.keys()];
    }

    getDevice(path) {
        return this.devices.get(path);
    }
}
```

The manager calls `device.close()` instead of reaching through to `device.port.close()`. The device owns its port; the manager only deals with the device. We also `await` the close before deleting from the map. Serialport's close is asynchronous, and if a stale handle hangs around, the OS may not let the next `update()` re-open the same path.

Call `manager.update()` periodically and it discovers new devices, cleans up old ones. The `Map` is our single source of truth: one key per port path, one value per device instance. If you need to look up a device by serial number or some other property, iterate the map. It's small and always consistent.

Usage:

```javascript
import { myDevice } from './myDevice/index.js';
import { DeviceManager } from './DeviceManager.js';

const manager = new DeviceManager(myDevice);
await manager.update();
```

One thing that might be on your mind: should the DeviceManager be a singleton? In JavaScript you mostly get that for free. ES modules cache on first import, so `export const manager = new DeviceManager(myDevice)` in a shared module hands the same instance to every importer. No `getInstance()` hand-off that you might see in a Java implementation. The per-device queue is what keeps the commands safe, and the ES module cache prevents duplicate instantiation.

### Accessing devices through the manager

With the queue living on each `myDevice` instance, the manager doesn't need to forward commands. It just hands out the device:

```javascript
const device = manager.getDevice('/dev/ttyUSB0');
const sn = await device.getParam('SERIAL_NUMBER');
await device.updateParam('LED_DRIVE', '50');
```

That's the whole API for talking to a specific device. `getDevice(path)` is a map lookup; the caller drives the device from there.

The first version of this code (years ago, in a production app) had the manager wrapping every device method: `manager.getParam(path, ...)`, `manager.setParam(path, ...)`, and so on. Every time the device grew a new method, the manager grew a parallel one. All it did was look up the device and call through. Dead weight.

Why split it this way:

- **myDevice** owns the protocol and its own lock. One lock per device, because the lock protects one UART.
- **DeviceManager** owns the registry: who's plugged in, who just disappeared, who to hand out on request.

Keeping the lock on the device (not the manager) is what makes parallelism across devices free. Two devices, two queues, two UARTs. Commands on `/dev/mock-a` and `/dev/mock-b` run concurrently. Commands on the same device stay serialized.

One caveat: callers now hold a reference to a `myDevice` instance. If the device is unplugged and removed from the map, that reference is stale. Writes will fail once the port closes. In a larger app, re-fetch from the manager before each operation, or subscribe to a disconnect event. For the tutorial demo, we just don't hold references across `update()` cycles.

### Recovering from errors

In Part 1, we added timeouts and error listeners so a single failed command doesn't hang the queue. But there's a failure mode those don't catch: a *stuck port*.

On Windows especially, an RS-232 emulated[^3] serial port can end up in a state where the OS still reports it as connected, but writes timeout indefinitely. This tends to happen when a device is unplugged mid-transmission and the OS doesn't clean up the port registration properly. (`SerialPort.list()` is reporting accurately; it's the OS holding the ghost.) The only reliable fix is to close the port and let it be rediscovered:

```javascript
async resetPort(path) {
    const device = this.devices.get(path);
    if (!device) return;
    await device.close();
    this.devices.delete(path);
    // The next update() cycle will re-enumerate and create a fresh instance.
}
```

This is intentionally simple: close the port, remove the device, let the next `update()` cycle rediscover it. More aggressive approaches (retry immediately, re-create in-place) are possible, but they add complexity and hide the failure.

Note that `update()` here trusts whatever `SerialPort.list()` reports. In Part 3 we'll cover how we can ensure that our devices are still live for our application.

### Graceful shutdown

When your application exits (the user closed the window, the system is going to sleep, a signal arrived), you need to finish any in-flight commands before closing ports. If you close a port while a command is in flight, the promise never resolves, your queue hangs, and the process won't exit cleanly.

`PQueue` exposes an `onIdle()` method that resolves when all queued work is done[^4]:

```javascript
async shutdown() {
    await Promise.allSettled(
        [...this.devices.values()].map(async (device) => {
            await device.queue.onIdle();
            await device.close();
        })
    );
    this.devices.clear();
}
```

We use `Promise.allSettled` instead of `Promise.all` because we want to attempt to shut down every device even if one throws. A single stuck device shouldn't prevent the others from closing cleanly.

## Putting it together

Here's the complete `DeviceManager.js`. Full version in [`device/DeviceManager.js`](device/DeviceManager.js):

`DeviceManager.js`

```javascript
import { SerialPort } from 'serialport';

export class DeviceManager {
    constructor(DeviceClass) {
        this.DeviceClass = DeviceClass;
        this.devices = new Map();
    }

    async update() {
        const allPorts = await SerialPort.list();
        const matchingPaths = new Set(
            allPorts
                .filter(p => p.vendorId === this.DeviceClass.VID && p.productId === this.DeviceClass.PID)
                .map(p => p.path)
        );

        for (const path of matchingPaths) {
            if (!this.devices.has(path)) {
                this.devices.set(path, new this.DeviceClass(path));
            }
        }

        for (const path of this.devices.keys()) {
            if (!matchingPaths.has(path)) {
                await this.devices.get(path).close();
                this.devices.delete(path);
            }
        }
    }

    getDevices() {
        return [...this.devices.keys()];
    }

    getDevice(path) {
        return this.devices.get(path);
    }

    async resetPort(path) {
        const device = this.devices.get(path);
        if (!device) return;
        await device.close();
        this.devices.delete(path);
    }

    async shutdown() {
        await Promise.allSettled(
            [...this.devices.values()].map(async (device) => {
                await device.queue.onIdle();
                await device.close();
            })
        );
        this.devices.clear();
    }
}
```

In [Part 3](Part3.md), we'll wire this up to a recurring async interval that calls `update()` automatically, and build a simple Express/SSE endpoint so a browser can watch devices come and go in real time.

## Beyond Part 2

A few topics that build on what we've covered here but are beyond our current scope:

- **Device hiding / persistence.** In a production app, users may want to hide disconnected devices from the UI without losing their historical data. This requires integration with your persistence layer (database, local storage) to remember which devices are hidden across sessions. The callbacks between the manager, the database, and the UI event system get surprisingly involved.
- **Bulk parameter updates.** `updateParam` chains set + save for a single parameter. For updating many at once, you'd want an `updateParams(path, paramMap)` that sets each value sequentially, then calls `saveParams` once to minimize write cycles.
- **Multi-line responses.** Some commands return multiple data lines terminated by an idle sentinel (`!STATUS,IDLE`). The `multi_receive` function in `device/myDevice/index.js` demonstrates this pattern. It uses `.on('data')` instead of `.once('data')` and accumulates lines until the sentinel. Integrating this with the DeviceManager requires a different forwarding strategy since the response is a collection.

That's it for Part 2.

[^1]: Universal Asynchronous Receiver/Transmitter. The hardware peripheral on the MCU that handles the bit-level framing for the serial line. Most embedded devices have one or two.
[^2]: In Rust the same guarantee comes from `Mutex<MyDevice>`. The caller locks, sends a command, and the lock drops when the scope ends. Python uses `threading.Lock` identically. See `rust-example/my_device/src/my_device.rs` and `python-example/pod_manager.py`.
[^3]: USB-CDC class devices get cleaner hot-unplug handling from Windows, but moving off VCP is firmware-side work. If you don't own the firmware, `resetPort` is the lever you have.
[^4]: Blocking languages like Rust and Python get this almost for free. Their mutexes block the thread until work completes, so shutdown is just "drop the lock and let pending callers finish." In JavaScript we can't block the event loop, so we need an explicit `onIdle()` signal.
