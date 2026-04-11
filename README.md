# node-serialport-tutorial

A hands-on tutorial for the [node serialport](https://serialport.io/) library, walking through how to build a reliable, plug-and-play interface to an embedded device from Node.js. Written from experience shipping serial-device software in production.

## The tutorial

- **Part 1 — Defining a device interface** ([`Part1.md`](Part1.md))
- **Part 2 — Managing multiple devices with a DeviceManager** ([`Part2.md`](Part2.md))
- **Part 3 — Polling loop and UI integration** ([`Part3.md`](Part3.md))

## What's in the repo

- `Part1.md`, `Part2.md`, `Part3.md` — the articles
- `device/` — the Node.js reference implementation built up across the three parts
- `python-example/` — the same pattern in Python (threads + `Lock`)
- `rust-example/` — the same pattern in Rust (workspace with `my_device` and `device_manager` crates; uses `Mutex<Device>` and a polling thread)

The Python and Rust examples exist to contrast how the same problem gets solved in languages with different concurrency primitives. JavaScript leans on promise queues and singletons where the others use locks and threadpools.

## Branches

Each part of the tutorial has its own branch, so you can check out the repo at any point in the narrative:

- `part-1` — state at the end of Part 1 (device interface only)
- `part-2` — adds the `DeviceManager`
- `part-3` — adds the polling loop and the UI integration
- `main` — the full tutorial plus extras (notably, a mock-bindings demo you can run without real hardware)

## Companion Electron template

If you want to go further than the Express/SSE demo in Part 3, there's a companion template repo that wires this tutorial's `DeviceManager` into an Electron app: [Dardin-dale/electron-react-serialport](https://github.com/Dardin-dale/electron-react-serialport).

## A note on tooling

Most of this tutorial predates widespread AI tooling; parts were later added and refined with the help of Claude Opus 4.6.

## License

MIT
