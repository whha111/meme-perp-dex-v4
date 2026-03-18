"use client";

import React, { useEffect, useRef, useState } from "react";

interface AnimatedNumberProps {
  value: number;
  format?: (val: number) => string;
  className?: string;
  showArrow?: boolean; // 是否显示变化箭头
  highlightChange?: boolean; // 是否高亮变化
}

export function AnimatedNumber({
  value,
  format,
  className,
  showArrow = false,
  highlightChange = true,
}: AnimatedNumberProps) {
  const [displayValue, setDisplayValue] = useState(value);
  const [changeDirection, setChangeDirection] = useState<"up" | "down" | null>(null);
  const [isAnimating, setIsAnimating] = useState(false);
  const prevValueRef = useRef(value);
  const animationRef = useRef<number | null>(null);

  useEffect(() => {
    // 跳过首次渲染
    if (prevValueRef.current === value) return;

    // 确定变化方向
    const direction = value > prevValueRef.current ? "up" : value < prevValueRef.current ? "down" : null;
    setChangeDirection(direction);
    setIsAnimating(true);

    // 清除之前的动画
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
    }

    // 重置动画状态
    const resetTimer = setTimeout(() => {
      setChangeDirection(null);
      setIsAnimating(false);
    }, 800);

    // 丝滑的数字滚动动画
    let startTimestamp: number | null = null;
    const duration = 400; // ms
    const startValue = displayValue;
    const endValue = value;

    const step = (timestamp: number) => {
      if (!startTimestamp) startTimestamp = timestamp;
      const progress = Math.min((timestamp - startTimestamp) / duration, 1);

      // 更丝滑的 ease-out 曲线
      const ease = 1 - Math.pow(1 - progress, 4);

      const current = startValue + (endValue - startValue) * ease;
      setDisplayValue(current);

      if (progress < 1) {
        animationRef.current = requestAnimationFrame(step);
      }
    };

    animationRef.current = requestAnimationFrame(step);

    prevValueRef.current = value;

    return () => {
      clearTimeout(resetTimer);
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // displayValue 故意不加入依赖，因为动画需要从当前显示值开始
  }, [value]);

  const formatted = format ? format(displayValue) : displayValue.toString();

  // 颜色样式
  const colorClass = highlightChange && changeDirection
    ? changeDirection === "up"
      ? "text-okx-up"
      : "text-okx-down"
    : "";

  // 动画样式
  const animationClass = isAnimating
    ? changeDirection === "up"
      ? "number-change-up"
      : changeDirection === "down"
      ? "number-change-down"
      : ""
    : "";

  return (
    <span
      className={`inline-flex items-center gap-0.5 transition-colors duration-200 ${colorClass} ${animationClass} ${className}`}
    >
      {showArrow && changeDirection && (
        <span
          className={`text-xs ${
            changeDirection === "up" ? "text-okx-up" : "text-okx-down"
          }`}
        >
          {changeDirection === "up" ? "▲" : "▼"}
        </span>
      )}
      <span className="tabular-nums">{formatted}</span>
    </span>
  );
}
