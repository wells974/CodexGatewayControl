import * as React from "react";
import { XIcon } from "lucide-react";
import { Toast as ToastPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * 提供 Toast 的无障碍上下文与默认显示时长。
 * @param props Radix Toast Provider 属性。
 * @returns Toast Provider 元素。
 */
function ToastProvider({ duration = 4_000, ...props }: React.ComponentProps<typeof ToastPrimitive.Provider>) {
  return <ToastPrimitive.Provider data-slot="toast-provider" duration={duration} {...props} />;
}

/**
 * 渲染固定在屏幕中上方的 Toast 容器。
 * @param props Radix Toast Viewport 属性。
 * @returns Toast Viewport 元素。
 */
function ToastViewport({
  className,
  label = "通知（{hotkey}）",
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Viewport>) {
  return <ToastPrimitive.Viewport
    className={cn("fixed top-5 left-1/2 z-60 flex w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 flex-col gap-2 outline-none sm:top-6", className)}
    data-slot="toast-viewport"
    label={label}
    {...props}
  />;
}

/**
 * 渲染单条短暂反馈，并支持成功与错误两种视觉状态。
 * @param props Toast 内容和状态属性。
 * @returns Toast 根元素。
 */
function Toast({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Root> & { variant?: "default" | "destructive" }) {
  return <ToastPrimitive.Root
    className={cn(
      "group pointer-events-auto relative grid w-full grid-cols-[auto_1fr_auto] gap-x-3 overflow-hidden rounded-xl border border-border bg-card p-4 text-foreground shadow-[0_12px_30px_rgb(25_34_68/14%)] transition-all data-[state=closed]:animate-out data-[state=closed]:fade-out-80 data-[state=closed]:slide-out-to-top-full data-[state=open]:animate-in data-[state=open]:slide-in-from-top-full",
      variant === "destructive" && "border-destructive/45",
      className
    )}
    data-slot="toast"
    {...props}
  />;
}

/**
 * 渲染 Toast 标题。
 * @param props 标题元素属性。
 * @returns Toast 标题元素。
 */
function ToastTitle({ className, ...props }: React.ComponentProps<typeof ToastPrimitive.Title>) {
  return <ToastPrimitive.Title className={cn("text-sm font-semibold", className)} data-slot="toast-title" {...props} />;
}

/**
 * 渲染 Toast 的具体反馈文字。
 * @param props 描述元素属性。
 * @returns Toast 描述元素。
 */
function ToastDescription({ className, ...props }: React.ComponentProps<typeof ToastPrimitive.Description>) {
  return <ToastPrimitive.Description className={cn("mt-0.5 text-sm text-muted-foreground", className)} data-slot="toast-description" {...props} />;
}

/**
 * 渲染可手动关闭 Toast 的图标按钮。
 * @param props 关闭元素属性。
 * @returns Toast 关闭按钮。
 */
function ToastClose({ className, ...props }: React.ComponentProps<typeof ToastPrimitive.Close>) {
  return <ToastPrimitive.Close
    aria-label="关闭提示"
    className={cn("rounded-sm text-muted-foreground opacity-70 outline-none transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring", className)}
    data-slot="toast-close"
    {...props}
  >
    <XIcon className="size-4" />
  </ToastPrimitive.Close>;
}

export { Toast, ToastClose, ToastDescription, ToastProvider, ToastTitle, ToastViewport };
