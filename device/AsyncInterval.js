/**
 * Like `setInterval`, but waits for the previous tick to settle before
 * scheduling the next one. The interval is the gap *between* ticks, not the
 * fixed wall-clock period — if a tick takes longer than `intervalMs`, the
 * next tick fires as soon as the previous resolves rather than piling up.
 *
 * Why not setInterval?
 *   setInterval(fn, 1000) schedules every 1000 ms regardless of how long fn
 *   takes. If your fn issues a serial command that the device takes 2s to
 *   answer, you stack a fresh fn every second on top of the queue. Memory
 *   grows, latency grows, eventually it crashes. setAsyncInterval fixes this
 *   by tying the next schedule to completion of the current tick.
 *
 * @param {() => Promise<void>} fn - Async function to run each tick.
 * @param {number} intervalMs - Gap between ticks in milliseconds.
 * @returns {{ cancel: () => void }} Handle whose `cancel()` stops further ticks.
 */
export function setAsyncInterval(fn, intervalMs) {
    let cancelled = false;
    let timer = null;

    const tick = async () => {
        if (cancelled) return;
        try {
            await fn();
        } catch (err) {
            console.error('setAsyncInterval tick failed:', err);
        }
        if (cancelled) return;
        timer = setTimeout(tick, intervalMs);
    };

    timer = setTimeout(tick, intervalMs);

    return {
        cancel() {
            cancelled = true;
            if (timer) clearTimeout(timer);
        },
    };
}
