import { SerialPort } from 'serialport';

export class DeviceManager {
    /**
     * @param {Function} DeviceClass - Device class to manage. Must expose static `VID` and
     *   `PID` strings (used to filter `SerialPort.list()`) and accept
     *   `(path, SerialPortClass, { onDisconnect })` in its constructor. See `myDevice` for
     *   the expected shape.
     * @param {object} [options]
     * @param {typeof SerialPort} [options.SerialPortClass=SerialPort] - SerialPort class used
     *   for enumeration and device instantiation. Pass a mock-binding subclass in tests/demos.
     */
    constructor(DeviceClass, { SerialPortClass = SerialPort } = {}) {
        this.DeviceClass = DeviceClass;
        this.SerialPortClass = SerialPortClass;
        this.devices = new Map();
    }

    /**
     * Reconcile the device map with the OS port list.
     *
     * @param {(port: object) => boolean} [filter] - Optional predicate. After
     *   the VID/PID match, the caller can drop ports they want to ignore
     *   (e.g. paths in a temporary "lost" cooldown). Returning false from the
     *   filter means "act as if this port is unplugged" for this tick.
     */
    async update(filter) {
        const allPorts = await this.SerialPortClass.list();
        const matching = allPorts.filter(
            p => p.vendorId === this.DeviceClass.VID && p.productId === this.DeviceClass.PID
        );
        const candidates = filter ? matching.filter(filter) : matching;
        const matchingPaths = new Set(candidates.map(p => p.path));

        for (const path of matchingPaths) {
            if (!this.devices.has(path)) {
                // The disconnect callback lets the device tell us "the OS just
                // dropped me" without the manager reaching through to its port.
                const device = new this.DeviceClass(path, this.SerialPortClass, {
                    onDisconnect: () => this._handleDisconnect(path),
                });
                this.devices.set(path, device);
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

    _handleDisconnect(path) {
        // The OS already closed the handle, so we don't call close() again.
        // Just drop the entry; next enumeration tick will broadcast the change.
        this.devices.delete(path);
    }
}
