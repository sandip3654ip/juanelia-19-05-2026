import { useEffect, useState, useRef, memo } from "react";
import { motion } from "framer-motion";

const FLASH_DURATION_MS = 500;
const ANIM_DURATION = 0.3;

const ANIMATE_IDLE = { scale: 1 };
const ANIM_UP   = { color: "#10B981", scale: [1, 1.05, 1] };
const ANIM_DOWN = { color: "#EF4444", scale: [1, 0.95, 1] };
const TRANSITION = { duration: ANIM_DURATION };

export const AnimatedNumber = memo(function AnimatedNumber({
  value,
  format,
  className = "",
  style,
  isPositiveGreen = false,
}) {
  const prevRef = useRef(value);
  const [flash, setFlash] = useState(null);

  useEffect(() => {
    if (value === prevRef.current) return;
    setFlash(value > prevRef.current ? "up" : "down");
    prevRef.current = value;
    const id = setTimeout(() => setFlash(null), FLASH_DURATION_MS);
    return () => clearTimeout(id);
  }, [value]);

  const displayValue = value != null && format ? format(value) : (value ?? "—");

  let extraClass = "";
  if (isPositiveGreen) {
    if (value > 0) extraClass = "text-emerald-500 dark:text-emerald-400";
    else if (value < 0) extraClass = "text-red-500 dark:text-red-400";
  }

  const animateTarget =
    flash === "up" ? ANIM_UP : flash === "down" ? ANIM_DOWN : ANIMATE_IDLE;

  return (
    <motion.span
      className={`tabular-nums ${className} ${extraClass}`}
      style={style}
      animate={animateTarget}
      transition={TRANSITION}
    >
      {displayValue}
    </motion.span>
  );
});
