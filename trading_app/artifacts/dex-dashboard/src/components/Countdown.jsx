import { useEffect, useState } from "react";

export function Countdown({ targetEpochMs }) {
  const [timeLeft, setTimeLeft] = useState("");

  useEffect(() => {
    if (!targetEpochMs) { setTimeLeft("—"); return; }
    const update = () => {
      const now = Date.now();
      const diff = targetEpochMs - now;
      if (diff <= 0) {
        setTimeLeft("0h 0m 0s");
        return;
      }

      const h = Math.floor(diff / (1000 * 60 * 60));
      const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const s = Math.floor((diff % (1000 * 60)) / 1000);

      setTimeLeft(`${h}h ${m}m ${s}s`);
    };

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [targetEpochMs]);

  return <span className="font-mono text-xs tabular-nums">{timeLeft}</span>;
}
