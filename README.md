# node-serialport-tutorial

A hands-on tutorial for the [node serialport](https://serialport.io/) library, walking through how to build a reliable, plug-and-play interface to an embedded device from Node.js. Written from experience shipping serial-device software in production.

## About this tutorial

This is really a tutorial about **serialport device patterns** — how to queue commands to avoid cross-talk, time out stuck devices, recover from unexpected disconnects, and manage a set of devices that come and go at runtime. JavaScript is the worked example, but the patterns apply in any language.

If you came here for node-serialport specifically, start with [Part 1](Part1.md) and read forward. If you're polyglot-curious, see [`rust-example/`](rust-example/) and [`python-example/`](python-example/) — they implement the same patterns using their respective primitives (Rust's `Arc<Mutex<T>>` + polling thread, Python's `threading.Lock`).

## The tutorial

- **Part 1 — Defining a device interface** ([`Part1.md`](Part1.md))
- **Part 2 — Managing multiple devices with a DeviceManager** ([`Part2.md`](Part2.md))
- **Part 3 — Polling loop and UI integration** ([`Part3.md`](Part3.md))

## What's in the repo

- `Part1.md`, `Part2.md`, `Part3.md` — the articles
- `device/` — the Node.js reference implementation built up across the three parts
- `demo/` — a runnable end-to-end demo that uses `SerialPortMock` so you can see the code work without real hardware (see [Running the demo](#running-the-demo))
- `python-example/` — the same pattern in Python (threads + `Lock`)
- `rust-example/` — the same pattern in Rust (workspace with `my_device` and `device_manager` crates; see [`rust-example/README.md`](rust-example/README.md) for build notes)

## Running the demo

Requires Node 22 or newer.

```
npm install
npm run demo
```

The demo instantiates the Part 1 `myDevice` class against a fake `SerialPortMock` port, sends the commands Part 1 introduces (LED toggle, parameter fetch, rapid-fire through the promise queue), and prints every step. The fake device runs the same IBM CRC-16 as the real client, so the demo exercises the actual checksum-validation path — not a shortcut.

## Snapshots

`main` is the latest state of the tutorial. If you want to see the repo at a specific point in the narrative, git tags exist:

- `part-1` — state at the end of Part 1 (device interface only)

Additional tags will be added as Part 2 and Part 3 are written. To check out a snapshot locally:

```
git checkout part-1
```

## Companion Electron template

If you want to go further than the Express/SSE demo in Part 3, there's a companion template repo that wires this tutorial's `DeviceManager` into an Electron app: [Dardin-dale/electron-react-serialport](https://github.com/Dardin-dale/electron-react-serialport).

## A note on tooling

Most of this tutorial predates widespread AI tooling; parts were later added and refined with the help of Claude Opus 4.6.

## License

MIT
