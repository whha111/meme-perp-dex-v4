/**
 * TradingErrorBoundary 组件测试
 *
 * 验证:
 * - 正常情况下直接渲染 children
 * - 子组件抛错时显示内联 fallback UI
 * - 重试按钮可重新渲染 children
 * - 自定义 fallback 被使用
 * - onError 回调被调用
 */
import { describe, test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { TradingErrorBoundary } from "../TradingErrorBoundary";

// 用于触发错误的炸弹组件
function ThrowOnRender({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error("Test render error");
  }
  return <div data-testid="child-content">正常内容</div>;
}

// 抑制 React 的 console.error 输出 (Error Boundary 会触发)
const originalConsoleError = console.error;
afterEach(() => {
  console.error = originalConsoleError;
});

describe("TradingErrorBoundary", () => {
  test("正常情况下直接渲染 children", () => {
    render(
      <TradingErrorBoundary module="Test">
        <div data-testid="child">Hello</div>
      </TradingErrorBoundary>
    );
    expect(screen.getByTestId("child")).toBeTruthy();
    expect(screen.getByText("Hello")).toBeTruthy();
  });

  test("子组件抛错时显示 fallback UI", () => {
    // 抑制 React error boundary 的 console.error
    console.error = vi.fn();

    render(
      <TradingErrorBoundary module="TestModule">
        <ThrowOnRender shouldThrow={true} />
      </TradingErrorBoundary>
    );

    // 应该显示 fallback UI 而不是 children
    expect(screen.queryByTestId("child-content")).toBeNull();
    // 应该显示重试按钮 (默认英文)
    expect(screen.getByText("Retry")).toBeTruthy();
    // 应该显示错误标题
    expect(screen.getByText("Module Error")).toBeTruthy();
  });

  test("点击重试按钮重新渲染 children", () => {
    console.error = vi.fn();

    let shouldThrow = true;

    function ConditionalThrow() {
      if (shouldThrow) throw new Error("boom");
      return <div data-testid="recovered">恢复成功</div>;
    }

    render(
      <TradingErrorBoundary module="RetryTest">
        <ConditionalThrow />
      </TradingErrorBoundary>
    );

    // 应该在 fallback 状态
    expect(screen.getByText("Retry")).toBeTruthy();

    // 修复错误条件
    shouldThrow = false;

    // 点击重试
    fireEvent.click(screen.getByText("Retry"));

    // 应该恢复显示正常内容
    expect(screen.getByTestId("recovered")).toBeTruthy();
  });

  test("使用自定义 fallback", () => {
    console.error = vi.fn();

    render(
      <TradingErrorBoundary
        module="CustomFallback"
        fallback={<div data-testid="custom-fallback">自定义错误界面</div>}
      >
        <ThrowOnRender shouldThrow={true} />
      </TradingErrorBoundary>
    );

    expect(screen.getByTestId("custom-fallback")).toBeTruthy();
    expect(screen.getByText("自定义错误界面")).toBeTruthy();
    // 不应显示默认 fallback
    expect(screen.queryByText("Retry")).toBeNull();
  });

  test("onError 回调被调用", () => {
    console.error = vi.fn();
    const onError = vi.fn();

    render(
      <TradingErrorBoundary module="CallbackTest" onError={onError}>
        <ThrowOnRender shouldThrow={true} />
      </TradingErrorBoundary>
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[0][0].message).toBe("Test render error");
    // 第二个参数是 ErrorInfo (包含 componentStack)
    expect(onError.mock.calls[0][1]).toHaveProperty("componentStack");
  });

  test("错误详情可展开", () => {
    console.error = vi.fn();

    render(
      <TradingErrorBoundary module="DetailTest">
        <ThrowOnRender shouldThrow={true} />
      </TradingErrorBoundary>
    );

    // 初始状态不显示错误消息
    expect(screen.queryByText("Test render error")).toBeNull();

    // 点击展开详情
    const detailBtn = screen.getByText(/Error details/i);
    fireEvent.click(detailBtn);

    // 现在应该显示错误消息
    expect(screen.getByText("Test render error")).toBeTruthy();
  });
});
