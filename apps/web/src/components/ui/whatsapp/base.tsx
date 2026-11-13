"use client";

import * as React from "react";

/*
 * Stand-ins for the two @base-ui/react pieces the wa-ui bubbles use, so Relay doesn't need a second
 * headless UI library next to Radix. Same props as the bubbles pass.
 */

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Render as this element instead (e.g. an <a>), keeping the button's class and children. */
  render?: React.ReactElement<Record<string, unknown>>;
  /** base-ui option; accepted and ignored. */
  nativeButton?: boolean;
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ render, nativeButton: _native, className, children, type = "button", ...props }, ref) => {
    if (render) {
      const own = render.props as { className?: string };
      return React.cloneElement(render, {
        ...props,
        className: [className, own.className].filter(Boolean).join(" "),
        children,
      });
    }
    return (
      <button ref={ref} type={type} className={className} {...props}>
        {children}
      </button>
    );
  },
);
Button.displayName = "Button";

const ProgressValue = React.createContext(0);

function Root({ value, className, children }: { value: number; className?: string; children: React.ReactNode }) {
  const v = Math.max(0, Math.min(100, value ?? 0));
  return (
    <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={v} className={className}>
      <ProgressValue.Provider value={v}>{children}</ProgressValue.Provider>
    </div>
  );
}

function Track({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={className}>{children}</div>;
}

function Indicator({ className }: { className?: string }) {
  const v = React.useContext(ProgressValue);
  return <div className={className} style={{ width: `${v}%` }} />;
}

export const Progress = { Root, Track, Indicator };
