"use client";

import { Icon } from "@relay/ui/components/icon";
import { cn } from "@relay/ui/lib/utils";
import { InputGroup, InputGroupAddon, InputGroupButton } from "@relay/ui/ui/input-group";
import { type ComponentProps, type KeyboardEvent, useState } from "react";
import { TypingInput } from "./typing-input";

type Props = Omit<ComponentProps<"input">, "type" | "size"> & { invalid?: boolean };

/**
 * Password input with a show/hide button and a Caps Lock warning,
 * the two things that cause most "wrong password" errors.
 */
export function PasswordField({ invalid, className, onKeyUp, onKeyDown, ...props }: Props) {
  const [visible, setVisible] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const readCaps = (event: KeyboardEvent<HTMLInputElement>) =>
    setCapsLock(event.getModifierState("CapsLock"));

  return (
    <div className="flex flex-col">
      <InputGroup className="h-10" data-disabled={props.disabled ? true : undefined}>
        <TypingInput
          inGroup
          mask={!visible}
          {...props}
          type={visible ? "text" : "password"}
          aria-invalid={invalid || undefined}
          className={cn("text-[16px] sm:text-[14px] md:text-[14px]", className)}
          onKeyUp={(event) => {
            readCaps(event);
            onKeyUp?.(event);
          }}
          onKeyDown={(event) => {
            readCaps(event);
            onKeyDown?.(event);
          }}
          onBlur={(event) => {
            setCapsLock(false);
            props.onBlur?.(event);
          }}
        />
        <InputGroupAddon align="inline-end">
          {capsLock ? (
            <span className="inline-flex animate-pop-in items-center gap-1 rounded-[4px] bg-warning-soft px-1.5 py-0.5 text-[11px] font-medium text-warning motion-reduce:animate-none">
              <Icon name="arrowUp" size="xs" />
              Caps Lock
            </span>
          ) : null}
          <InputGroupButton
            size="icon-xs"
            aria-label={visible ? "Hide password" : "Show password"}
            aria-pressed={visible}
            onClick={() => setVisible((v) => !v)}
          >
            <Icon name={visible ? "eyeOff" : "eye"} size="sm" />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

export type Strength = { score: 0 | 1 | 2 | 3 | 4; label: string };

/**
 * A rough strength score. Length counts most; mixing kinds of characters helps;
 * containing your own name or email hurts. Only advice: the server enforces the minimum length.
 */
export function passwordStrength(password: string, minLength: number, personal: string[] = []): Strength {
  if (!password) return { score: 0, label: "" };
  if (password.length < minLength) return { score: 1, label: "Too short" };
  const lower = password.toLowerCase();
  const personalHit = personal.some((p) => p.length >= 3 && lower.includes(p.toLowerCase()));
  let points = 1;
  if (password.length >= minLength + 4) points++;
  if (/[0-9]/.test(password) && /[^A-Za-z0-9]/.test(password)) points++;
  else if (/[0-9]/.test(password) || /[^A-Za-z0-9]/.test(password)) points += 0.5;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) points += 0.5;
  if (/^(.)\1+$/.test(password) || /^(?:0123|1234|abcd|qwer|pass)/i.test(password)) points = 1;
  if (personalHit) points = Math.min(points, 1.5);
  if (points >= 3) return { score: 4, label: "Strong" };
  if (points >= 2) return { score: 3, label: "Good" };
  return {
    score: 2,
    label: personalHit ? "Weak, avoid your email" : "Weak",
  };
}

/**
 * One row under a new password: four bars and a one-word verdict, or the field's error.
 * Always the same height, so typing never moves the form.
 */
export function StrengthMeter({ strength, error }: { strength: Strength; error?: string }) {
  const tone =
    strength.score <= 1
      ? "bg-destructive"
      : strength.score === 2
        ? "bg-warning"
        : strength.score === 3
          ? "bg-primary"
          : "bg-good";
  const text = error || strength.label || "At least 10 characters";
  return (
    <div className="-mt-1 flex h-[18px] items-center gap-3">
      <div className="grid flex-1 grid-cols-4 gap-1" aria-hidden>
        {[1, 2, 3, 4].map((n) => (
          <span
            key={n}
            className={cn(
              "h-1 rounded-full transition-colors duration-200 ease-out",
              n <= strength.score ? tone : "bg-muted",
            )}
          />
        ))}
      </div>
      <p
        role={error ? "alert" : undefined}
        aria-live={error ? undefined : "polite"}
        className={cn(
          "shrink-0 text-[12.5px] leading-[18px]",
          error ? "text-destructive" : "text-muted-foreground",
        )}
      >
        <span key={text} className="block animate-drop-in motion-reduce:animate-none">
          {text}
        </span>
      </p>
    </div>
  );
}
